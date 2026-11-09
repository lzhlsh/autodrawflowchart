/**
 * The diagram agent.
 *
 * One place that decides: DeepSeek or offline engine, create or edit, and what
 * to do when the model returns something invalid. The contract is that `plan()`
 * always returns a usable result — a failure degrades to the offline engine with
 * an explanation rather than a 500.
 */
import { providerMode } from '../config.js';
import { logger } from '../util/logger.js';
import { compileToXml, type CompileResult } from '../drawio/mxgraph.js';
import { applyOperations, summarizeSpec, validateCompilation } from '../drawio/validate.js';import type { AgentPlan, DiagramSpec, EditOp } from '../drawio/types.js';
import { complete, DeepSeekError, parseJsonObject } from './deepseek.js';
import { buildCreatePrompt, buildEditPrompt, guessKind, SYSTEM_PROMPT } from './prompts.js';
import { offlinePlan } from './offline.js';

const log = logger('agent');

export interface PlanInput {
  request: string;
  /** Existing diagram, when this is a follow-up turn. */
  spec: DiagramSpec | null;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Force a full regeneration even when a diagram exists. */
  forceCreate?: boolean;
}

export interface PlanOutput {
  plan: AgentPlan;
  /** The spec after operations were applied. */
  spec: DiagramSpec;
  /** Compiled draw.io XML for the editor. */
  compiled: CompileResult;
  provider: 'deepseek' | 'offline';
  providerReason: string;
  model: string;
  latencyMs: number;
  /** Validation/repair trail, surfaced in the UI for transparency. */
  diagnostics: {
    attempts: number;
    repairs: string[];
    warnings: string[];
    droppedOperations: Array<{ reason: string }>;
    fallback?: string;
  };
}

const EMPTY_SPEC: DiagramSpec = {
  kind: 'flowchart',
  title: 'Untitled',
  nodes: [],
  edges: [],
  layout: 'layered',
  direction: 'TB',
  theme: 'nebula',
};

/** Coerce whatever the model returned into a spec we can compile. */
function coerceSpec(raw: unknown, fallbackKind: string): DiagramSpec {
  const obj = (raw ?? {}) as Partial<DiagramSpec>;
  const nodes = Array.isArray(obj.nodes)
    ? obj.nodes.filter((n) => n && typeof n === 'object' && (n as { id?: unknown }).id != null)
    : [];
  const edges = Array.isArray(obj.edges) ? obj.edges.filter((e) => e && typeof e === 'object') : [];
  return {
    kind: obj.kind ?? (fallbackKind as DiagramSpec['kind']),
    title: typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim() : 'Untitled',
    nodes,
    edges,
    layout: obj.layout ?? 'layered',
    direction: obj.direction ?? 'TB',
    theme: obj.theme ?? 'nebula',
  };
}

interface ModelPayload {
  reply?: string;
  spec?: unknown;
  operations?: unknown;
  suggestions?: unknown;
}

function stringList(value: unknown, max = 4): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).slice(0, max);
  return out.length ? out : undefined;
}

/**
 * Run one model turn and convert it into a validated spec + XML.
 * On validation failure it retries once with the concrete errors fed back.
 */
async function deepseekTurn(input: PlanInput, isEdit: boolean): Promise<{
  plan: AgentPlan;
  spec: DiagramSpec;
  repairs: string[];
  warnings: string[];
  dropped: Array<{ reason: string }>;
  model: string;
  latencyMs: number;
}> {
  const repairs: string[] = [];
  const warnings: string[] = [];
  const dropped: Array<{ reason: string }> = [];
  let lastModel = '';
  let latency = 0;
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const repair = repairs.length ? repairs[repairs.length - 1] : undefined;

    const user = isEdit
      ? buildEditPrompt({
          request: input.request,
          spec: input.spec as DiagramSpec,
          summary: summarizeSpec(input.spec as DiagramSpec),
          history: input.history,
          repair,
        })
      : buildCreatePrompt({
          request: input.request,
          kindHint: guessKind(input.request),
          repair,
        });

    const res = await complete({ system: SYSTEM_PROMPT, user, json: true });
    lastModel = res.model;
    latency += res.latencyMs;

    let payload: ModelPayload;
    try {
      payload = parseJsonObject<ModelPayload>(res.content);
    } catch (err) {
      const message = `Your response was not parseable JSON (${(err as Error).message}). Return ONLY a single valid JSON object.`;
      repairs.push(message);
      log.warn(`attempt ${attempt}: unparseable JSON`);
      if (attempt < maxAttempts) continue;
      throw new DeepSeekError(message);
    }

    // ---- build the candidate spec -------------------------------------
    let candidate: DiagramSpec;
    let ops: EditOp[] | undefined;

    if (isEdit && Array.isArray(payload.operations) && payload.operations.length > 0) {
      ops = payload.operations as EditOp[];
      const result = applyOperations(input.spec as DiagramSpec, ops);
      candidate = result.spec;
      for (const s of result.skipped) dropped.push({ reason: s.reason });
      // Existing coordinates are stale once the graph shape changes.
      if (result.applied > 0) candidate = { ...candidate, nodes: candidate.nodes.map((n) => ({ ...n, x: undefined, y: undefined })) };
      if (result.skipped.length > 0) {
        warnings.push(`${result.skipped.length} operation(s) could not be applied`);
      }
    } else if (payload.spec) {
      candidate = coerceSpec(payload.spec, guessKind(input.request));
    } else if (isEdit) {
      // Model replied conversationally without any operations.
      throw new DeepSeekError(
        'The model did not return any "operations" or "spec". For an edit request you MUST return "operations".',
      );
    } else {
      throw new DeepSeekError('The model did not return a "spec" object.');
    }

    // ---- validate -----------------------------------------------------
    const check = validateCompilation(candidate);
    const errors = check.issues.filter((i) => i.level === 'error');
    warnings.push(...check.warnings, ...check.issues.filter((i) => i.level === 'warn').map((i) => i.message));

    if (errors.length === 0) {
      return {
        plan: {
          reply: typeof payload.reply === 'string' && payload.reply.trim() ? payload.reply.trim() : '已完成修改。',
          spec: ops ? undefined : candidate,
          operations: ops,
          suggestions: stringList(payload.suggestions),
        },
        spec: candidate,
        repairs,
        warnings,
        dropped,
        model: lastModel,
        latencyMs: latency,
      };
    }

    const message = errors.map((e) => `- ${e.code}: ${e.message}`).join('\n');
    repairs.push(`Fix these validation errors and return the corrected full json:\n${message}`);
    log.warn(`attempt ${attempt}: ${errors.length} validation error(s)`);
    if (attempt >= maxAttempts) {
      throw new DeepSeekError(`diagram failed validation after ${maxAttempts} attempts:\n${message}`);
    }
  }

  throw new DeepSeekError('unreachable: exhausted attempts');
}

/** Compile a spec, falling back to an empty diagram if it somehow throws. */
function safeCompile(spec: DiagramSpec): CompileResult {
  try {
    return compileToXml(spec);
  } catch (err) {
    log.error('compile failed, returning empty diagram', err);
    return compileToXml({ ...EMPTY_SPEC, title: spec.title ?? 'Untitled' });
  }
}

/**
 * Turn an AgentPlan into the spec that should actually be persisted.
 *
 * A plan can express itself three ways, and all three must converge here:
 *   - `spec`        : a whole new diagram (create turns)
 *   - `operations`  : incremental edits applied to the current diagram
 *   - neither       : conversational reply only — keep the current diagram
 *
 * The offline engine reports edits as `operations`, so anything that forgets to
 * apply them silently shows the user the unmodified diagram (this was a real
 * bug: the reply said "renamed", the canvas did not change).
 */
function resolvePlanSpec(
  plan: AgentPlan,
  current: DiagramSpec | null,
  isEdit: boolean,
): { spec: DiagramSpec; warnings: string[]; dropped: Array<{ reason: string }> } {
  const warnings: string[] = [];

  if (plan.spec) {
    return { spec: plan.spec, warnings, dropped: [] };
  }

  if (plan.operations && plan.operations.length > 0) {
    const base = current ?? EMPTY_SPEC;
    const result = applyOperations(base, plan.operations);
    for (const skipped of result.skipped) {
      warnings.push(`未应用的操作：${skipped.reason}`);
    }
    // Coordinates from the previous revision go stale as soon as the graph
    // shape changes, so let the layout engine re-place everything.
    const spec =
      result.applied > 0
        ? { ...result.spec, layout: base.layout ?? 'layered', nodes: result.spec.nodes.map((n) => ({ ...n, x: undefined, y: undefined })) }
        : result.spec;
    return { spec, warnings, dropped: result.skipped.map((s) => ({ reason: s.reason })) };
  }

  // Conversational turn with no graph change.
  if (current) return { spec: current, warnings, dropped: [] };
  if (isEdit) warnings.push('模型没有返回任何图表变更');
  return { spec: EMPTY_SPEC, warnings, dropped: [] };
}

export async function plan(input: PlanInput): Promise<PlanOutput> {
  const started = Date.now();
  const { mode, reason } = providerMode();
  const hasDiagram = !input.forceCreate && (input.spec?.nodes?.length ?? 0) > 0;
  const isEdit = hasDiagram;

  // ---- offline path ---------------------------------------------------
  if (mode === 'offline') {
    const offline = offlinePlan(input.request, isEdit ? input.spec : null);
    const resolved = resolvePlanSpec(offline, input.spec, isEdit);
    const compiled = safeCompile(resolved.spec);
    return {
      plan: offline,
      spec: resolved.spec,
      compiled,
      provider: 'offline',
      providerReason: reason,
      model: 'offline-rules',
      latencyMs: Date.now() - started,
      diagnostics: {
        attempts: 0,
        repairs: [],
        warnings: [...compiled.warnings, ...resolved.warnings],
        droppedOperations: resolved.dropped,
      },
    };
  }

  // ---- DeepSeek path, with graceful degradation ------------------------
  try {
    const turn = await deepseekTurn(input, isEdit);
    const compiled = safeCompile(turn.spec);
    return {
      plan: turn.plan,
      spec: turn.spec,
      compiled,
      provider: 'deepseek',
      providerReason: reason,
      model: turn.model,
      latencyMs: Date.now() - started,
      diagnostics: {
        attempts: turn.repairs.length + 1,
        repairs: turn.repairs,
        warnings: [...turn.warnings, ...compiled.warnings],
        droppedOperations: turn.dropped,
      },
    };
  } catch (err) {
    const message = err instanceof DeepSeekError ? err.message : (err as Error).message;
    log.error('DeepSeek turn failed; degrading to offline engine', message);

    // Degrade rather than fail: the user still gets an editable diagram.
    const offline = offlinePlan(input.request, isEdit ? input.spec : null);
    const resolved = resolvePlanSpec(offline, input.spec, isEdit);
    const compiled = safeCompile(resolved.spec);

    return {
      plan: {
        ...offline,
        reply:
          `⚠️ DeepSeek 调用失败，已改用内置规则引擎生成。\n原因：${message}\n\n` +
          offline.reply.replace(/（离线模式[^）]*）/, ''),
      },
      spec: resolved.spec,
      compiled,
      provider: 'offline',
      providerReason: `deepseek-error: ${message}`,
      model: 'offline-rules',
      latencyMs: Date.now() - started,
      diagnostics: {
        attempts: 1,
        repairs: [],
        warnings: [...compiled.warnings, ...resolved.warnings],
        droppedOperations: resolved.dropped,
        fallback: message,
      },
    };
  }
}
