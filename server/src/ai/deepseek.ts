/**
 * DeepSeek client.
 *
 * DeepSeek exposes an OpenAI-compatible endpoint, so we use the official OpenAI
 * SDK pointed at https://api.deepseek.com. The target model is
 * `deepseek-flash` — the serving name for DeepSeek V4.1 Flash.
 *
 * Notes that shaped this file:
 *  - JSON mode (`response_format: {type:'json_object'}`) requires the word
 *    "json" in the prompt, and DeepSeek documents that it occasionally returns
 *    empty content. We retry on empty rather than surfacing a confusing error.
 *  - `max_tokens` must be generous or the JSON gets truncated mid-object.
 */
import OpenAI from 'openai';
import { effectiveDeepSeek } from '../config.js';
import { logger } from '../util/logger.js';

const log = logger('deepseek');

export class DeepSeekError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
    /** Original error, kept for logging. Named `sourceError` to avoid clashing
     * with `Error.cause` (which is `unknown` and non-overridable as a param prop). */
    readonly sourceError?: unknown,
  ) {
    super(message);
    this.name = 'DeepSeekError';
  }
}

export interface CompletionRequest {
  system: string;
  user: string;
  /** Ask for strict JSON output. */
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  /** Disable the chain-of-thought pass for latency-sensitive calls. */
  thinking?: boolean;
}

export interface CompletionResult {
  content: string;
  /** Raw reasoning text when the provider returns one. */
  reasoning?: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  model: string;
  latencyMs: number;
}

function client(): OpenAI {
  const { apiKey, baseUrl, timeoutMs } = effectiveDeepSeek();
  if (!apiKey) {
    throw new DeepSeekError('no API key configured for the configured endpoint', 401, false);
  }
  return new OpenAI({
    apiKey,
    baseURL: baseUrl,
    timeout: timeoutMs,
    // We implement our own retry/repair loop; the SDK should fail fast.
    maxRetries: 0,
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True for errors worth retrying (rate limit, upstream 5xx, network). */
function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status === 429 || (typeof status === 'number' && status >= 500)) return true;
  const code = (err as { code?: string })?.code;
  return code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ENOTFOUND';
}

/**
 * Optional request fields, dropped one at a time when a provider rejects them.
 *
 * Not every OpenAI-compatible endpoint accepts every field: DeepSeek-only
 * `thinking`/`reasoning_effort` are rejected outright by Groq and others, and a
 * few providers do not implement `response_format`. Rather than require the user
 * to know which provider wants what, we start with the richest request and back
 * off precisely on the field the server complained about.
 */
interface RequestTuning {
  thinking: boolean;
  jsonMode: boolean;
}

/** True when an error looks like "unknown/unsupported request field X". */
function isUnsupportedFieldError(err: unknown, field: RegExp): boolean {
  const status = (err as { status?: number })?.status;
  // Providers signal unknown fields with 400 (OpenAI/Groq) or 422.
  if (status !== 400 && status !== 422) return false;
  const message = String((err as { message?: string })?.message ?? '');
  return field.test(message);
}

const THINKING_FIELD = /thinking|reasoning_effort/i;
const JSON_FIELD = /response_format|json_object|json mode/i;

export async function complete(req: CompletionRequest): Promise<CompletionResult> {
  const cfg = effectiveDeepSeek();
  const started = Date.now();
  // Headroom for the compatibility back-off below: at most two of these attempts
  // are spent dropping an unsupported field, leaving retries for real failures.
  const maxAttempts = 5;
  let lastError: unknown;

  // Degrade from the ideal request shape as the provider tells us what it wants.
  const tuning: RequestTuning = {
    thinking: req.thinking ?? cfg.thinking,
    jsonMode: req.json !== false,
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const openai = client();
      const body: Record<string, unknown> = {
        model: cfg.model,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        temperature: req.temperature ?? cfg.temperature,
        max_tokens: req.maxTokens ?? cfg.maxTokens,
        stream: false,
      };
      if (tuning.jsonMode) {
        body.response_format = { type: 'json_object' };
      }
      if (tuning.thinking) {
        // DeepSeek-only fields. `effectiveDeepSeek()` only enables them for
        // DeepSeek hostnames, or when AI_THINKING=1 forces them on.
        body.thinking = { type: 'enabled' };
        body.reasoning_effort = cfg.reasoningEffort;
      }

      const res = (await openai.chat.completions.create(body as never)) as {
        choices?: Array<{
          message?: { content?: string | null; reasoning_content?: string | null };
          finish_reason?: string;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };

      const choice = res.choices?.[0];
      const content = (choice?.message?.content ?? '').trim();

      if (!content) {
        // Documented DeepSeek JSON-mode quirk. Retry with a nudge.
        log.warn(`empty completion (attempt ${attempt}/${maxAttempts}, finish=${choice?.finish_reason})`);
        lastError = new DeepSeekError('model returned empty content', 200, true);
        if (attempt < maxAttempts) {
          await sleep(400 * attempt);
          continue;
        }
        throw lastError;
      }

      if (choice?.finish_reason === 'length') {
        // Truncated JSON is unparseable; fail loudly so the caller can retry
        // with a higher token budget instead of reporting a syntax error.
        throw new DeepSeekError(
          `response truncated at max_tokens=${req.maxTokens ?? cfg.maxTokens}; increase DEEPSEEK_MAX_TOKENS`,
          200,
          false,
        );
      }

      return {
        content,
        reasoning: choice?.message?.reasoning_content ?? undefined,
        usage: res.usage
          ? {
              promptTokens: res.usage.prompt_tokens ?? 0,
              completionTokens: res.usage.completion_tokens ?? 0,
              totalTokens: res.usage.total_tokens ?? 0,
            }
          : undefined,
        model: cfg.model,
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      lastError = err;
      const status = (err as { status?: number }).status;
      const message = String((err as { message?: string })?.message ?? '');

      // --- provider-compatibility back-off -------------------------------
      // If the endpoint rejected a field we sent optimistically, drop just that
      // field and retry immediately. This is what makes pointing AI_BASE_URL at
      // a non-DeepSeek provider work without the user configuring anything.
      if (tuning.thinking && isUnsupportedFieldError(err, THINKING_FIELD)) {
        tuning.thinking = false;
        log.warn('endpoint rejected thinking/reasoning_effort; retrying without them');
        continue;
      }
      if (tuning.jsonMode && isUnsupportedFieldError(err, JSON_FIELD)) {
        tuning.jsonMode = false;
        log.warn('endpoint rejected response_format=json_object; retrying without JSON mode');
        continue;
      }

      const retryable = err instanceof DeepSeekError ? err.retryable : isRetryable(err);
      log.warn(`completion attempt ${attempt}/${maxAttempts} failed`, {
        status,
        retryable,
        message,
      });
      if (!retryable || attempt === maxAttempts) break;
      await sleep(500 * 2 ** (attempt - 1));
    }
  }

  const message = lastError instanceof Error ? lastError.message : 'unknown model failure';
  const status = (lastError as { status?: number })?.status;
  throw new DeepSeekError(`LLM request failed: ${message}`, status, false, lastError);
}

/** Strip markdown fences the model sometimes wraps JSON in. */
export function stripCodeFences(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced) return fenced[1].trim();
  return text.trim();
}

/**
 * Parse a JSON object out of a model response, tolerating pre-amble text and
 * code fences. Falls back to brace matching when the model disobeys.
 */
export function parseJsonObject<T = unknown>(text: string): T {
  const cleaned = stripCodeFences(text);

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // fall through to brace matching
  }

  const start = cleaned.indexOf('{');
  if (start === -1) throw new DeepSeekError('model response contains no JSON object');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const candidate = cleaned.slice(start, i + 1);
        try {
          return JSON.parse(candidate) as T;
        } catch (err) {
          throw new DeepSeekError(`model returned invalid JSON: ${(err as Error).message}`);
        }
      }
    }
  }
  throw new DeepSeekError('model response contains an unterminated JSON object');
}

/** Connectivity probe used by /api/settings/test. */
export async function testConnection(): Promise<{ ok: boolean; model: string; latencyMs: number; message: string }> {
  const cfg = effectiveDeepSeek();
  const started = Date.now();
  try {
    const res = await complete({
      system: 'Reply with json only.',
      user: 'Return the json object {"ok":true}.',
      json: true,
      maxTokens: 64,
      temperature: 0,
      thinking: false,
    });
    return {
      ok: true,
      model: res.model,
      latencyMs: Date.now() - started,
      message: 'DeepSeek reachable',
    };
  } catch (err) {
    return {
      ok: false,
      model: cfg.model,
      latencyMs: Date.now() - started,
      message: (err as Error).message,
    };
  }
}
