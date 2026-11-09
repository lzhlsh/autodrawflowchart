/**
 * Validation + incremental edit operations.
 *
 * The validator is the safety net for LLM output: instead of trusting the model
 * to produce a coherent graph, we check it and feed problems back for one repair
 * round. The operations layer makes follow-up edits deterministic and diffable.
 */
import { compileToXml, parseDrawioXml, assertWellFormed } from './mxgraph.js';
import { findOverlaps } from './layout.js';
import type { DiagramEdge, DiagramNode, DiagramSpec, EditOp } from './types.js';

export interface ValidationIssue {
  level: 'error' | 'warn';
  code: string;
  message: string;
  /** Ids the message refers to, when applicable. */
  ids?: string[];
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  nodeCount: number;
  edgeCount: number;
}

const MAX_NODES = 220;
const MAX_EDGES = 400;

/** Structural validation of a spec, before we attempt to serialise it. */
export function validateSpec(spec: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (!spec || typeof spec !== 'object') {
    return {
      ok: false,
      issues: [{ level: 'error', code: 'not-an-object', message: 'spec must be a JSON object' }],
      nodeCount: 0,
      edgeCount: 0,
    };
  }

  const s = spec as DiagramSpec;
  const nodes = Array.isArray(s.nodes) ? s.nodes : null;
  const edges = Array.isArray(s.edges) ? s.edges : null;

  if (!nodes) {
    issues.push({ level: 'error', code: 'nodes-missing', message: 'spec.nodes must be an array' });
  }
  if (!edges) {
    issues.push({ level: 'error', code: 'edges-missing', message: 'spec.edges must be an array' });
  }
  if (!nodes) {
    return { ok: false, issues, nodeCount: 0, edgeCount: 0 };
  }

  const edgeList = edges ?? [];
  if (nodes.length === 0) {
    issues.push({ level: 'warn', code: 'no-nodes', message: 'diagram has no nodes' });
  }
  if (nodes.length > MAX_NODES) {
    issues.push({
      level: 'error',
      code: 'too-many-nodes',
      message: `too many nodes (${nodes.length} > ${MAX_NODES}); split into multiple diagrams`,
    });
  }
  if (edgeList.length > MAX_EDGES) {
    issues.push({
      level: 'error',
      code: 'too-many-edges',
      message: `too many edges (${edgeList.length} > ${MAX_EDGES})`,
    });
  }

  // --- ids ---
  const seen = new Set<string>();
  for (const node of nodes) {
    const id = String(node?.id ?? '').trim();
    if (!id) {
      issues.push({ level: 'error', code: 'node-id-missing', message: 'every node needs a non-empty id' });
      continue;
    }
    if (seen.has(id)) {
      issues.push({ level: 'error', code: 'node-id-duplicate', message: `duplicate node id "${id}"`, ids: [id] });
    }
    seen.add(id);
    if (typeof node.label !== 'string' || node.label.trim().length === 0) {
      issues.push({
        level: 'warn',
        code: 'node-label-empty',
        message: `node "${id}" has an empty label`,
        ids: [id],
      });
    }
    if (node.label && node.label.length > 220) {
      issues.push({
        level: 'warn',
        code: 'node-label-too-long',
        message: `node "${id}" label is ${node.label.length} chars; keep labels short`,
        ids: [id],
      });
    }
  }

  // --- edge references ---
  const seenEdges = new Set<string>();
  for (const edge of edgeList) {
    const source = String(edge?.source ?? '');
    const target = String(edge?.target ?? '');
    if (!seen.has(source)) {
      issues.push({
        level: 'error',
        code: 'edge-source-unknown',
        message: `edge source "${source}" is not a node id`,
        ids: [source],
      });
    }
    if (!seen.has(target)) {
      issues.push({
        level: 'error',
        code: 'edge-target-unknown',
        message: `edge target "${target}" is not a node id`,
        ids: [target],
      });
    }
    if (source && source === target) {
      issues.push({
        level: 'warn',
        code: 'edge-self-loop',
        message: `self-loop on "${source}" will be dropped`,
        ids: [source],
      });
    }
    if (edge?.id) {
      const key = String(edge.id);
      if (seenEdges.has(key)) {
        issues.push({ level: 'warn', code: 'edge-id-duplicate', message: `duplicate edge id "${key}"` });
      }
      seenEdges.add(key);
    }
  }

  // --- geometry (only meaningful once coordinates exist) ---
  const positioned = nodes.filter((n) => typeof n?.x === 'number' && typeof n?.y === 'number');
  if (positioned.length === nodes.length && nodes.length > 1) {
    const overlaps = findOverlaps(nodes as DiagramNode[]);
    if (overlaps.length > 0) {
      issues.push({
        level: 'warn',
        code: 'nodes-overlap',
        message: `${overlaps.length} node pair(s) overlap: ${overlaps
          .slice(0, 5)
          .map((o) => `${o.a}/${o.b}`)
          .join(', ')}`,
        ids: overlaps.slice(0, 5).flatMap((o) => [o.a, o.b]),
      });
    }
  } else if (positioned.length > 0 && positioned.length < nodes.length) {
    issues.push({
      level: 'warn',
      code: 'partial-coordinates',
      message: 'only some nodes have coordinates; the whole diagram will be re-laid out',
    });
  }

  const ok = !issues.some((i) => i.level === 'error');
  return {
    ok,
    issues,
    nodeCount: nodes.length,
    edgeCount: edgeList.length,
  };
}

/** Compile + verify that the produced XML is well-formed and re-parseable. */
export function validateCompilation(spec: DiagramSpec): ValidationResult & { xml?: string; warnings: string[] } {
  const base = validateSpec(spec);
  const warnings: string[] = [];
  if (!base.ok) return { ...base, warnings };

  try {
    const result = compileToXml(spec);
    warnings.push(...result.warnings);
    assertWellFormed(result.xml);
    const parsed = parseDrawioXml(result.xml);

    if (parsed.nodes.length !== result.nodeCount) {
      base.issues.push({
        level: 'error',
        code: 'roundtrip-node-count',
        message: `round-trip mismatch: compiled ${result.nodeCount} nodes but re-parsed ${parsed.nodes.length}`,
      });
    }
    if (parsed.edges.length !== result.edgeCount) {
      base.issues.push({
        level: 'error',
        code: 'roundtrip-edge-count',
        message: `round-trip mismatch: compiled ${result.edgeCount} edges but re-parsed ${parsed.edges.length}`,
      });
    }
    return { ...base, ok: !base.issues.some((i) => i.level === 'error'), warnings, xml: result.xml };
  } catch (err) {
    base.issues.push({
      level: 'error',
      code: 'compile-failed',
      message: `failed to compile diagram: ${(err as Error).message}`,
    });
    return { ...base, ok: false, warnings };
  }
}

// ---------------------------------------------------------------------------
// Incremental edit operations
// ---------------------------------------------------------------------------

export interface ApplyResult {
  spec: DiagramSpec;
  applied: number;
  skipped: Array<{ op: EditOp; reason: string }>;
}

/**
 * Apply model-produced edit operations to a spec.
 * Unknown ids are skipped with a reason instead of throwing, so a partially
 * wrong plan still produces a useful diagram.
 */
export function applyOperations(spec: DiagramSpec, ops: EditOp[]): ApplyResult {
  let current: DiagramSpec = {
    ...spec,
    nodes: [...(spec.nodes ?? [])],
    edges: [...(spec.edges ?? [])],
  };
  const skipped: ApplyResult['skipped'] = [];
  let applied = 0;

  const nodeIndex = (id: string) => current.nodes.findIndex((n) => n.id === id);
  const edgeIndex = (id: string) => current.edges.findIndex((e) => e.id === id || `${e.source}->${e.target}` === id);
  let synthetic = 0;
  const nextEdgeId = () => `e_${++synthetic}_${Math.random().toString(36).slice(2, 7)}`;

  for (const op of ops ?? []) {
    if (!op || typeof op !== 'object' || !('op' in op)) {
      skipped.push({ op, reason: 'malformed operation' });
      continue;
    }

    switch (op.op) {
      case 'add_node': {
        const node = op.node;
        if (!node?.id) {
          skipped.push({ op, reason: 'add_node requires node.id' });
          break;
        }
        const existing = nodeIndex(node.id);
        if (existing >= 0) {
          // Treat a re-add as an update — models do this when refining a node.
          current.nodes[existing] = { ...current.nodes[existing], ...node };
        } else {
          current.nodes.push({ ...node });
        }
        applied += 1;
        break;
      }

      case 'add_edge': {
        const edge = op.edge;
        if (!edge?.source || !edge?.target) {
          skipped.push({ op, reason: 'add_edge requires source and target' });
          break;
        }
        if (nodeIndex(edge.source) < 0 || nodeIndex(edge.target) < 0) {
          skipped.push({
            op,
            reason: `add_edge endpoints not found (${edge.source} -> ${edge.target})`,
          });
          break;
        }
        current.edges.push({ ...edge, id: edge.id ?? nextEdgeId() });
        applied += 1;
        break;
      }

      case 'update_node': {
        const at = nodeIndex(op.id);
        if (at < 0) {
          skipped.push({ op, reason: `update_node: no node "${op.id}"` });
          break;
        }
        current.nodes[at] = { ...current.nodes[at], ...op.patch, id: op.id };
        applied += 1;
        break;
      }

      case 'update_edge': {
        const at = edgeIndex(op.id);
        if (at < 0) {
          skipped.push({ op, reason: `update_edge: no edge "${op.id}"` });
          break;
        }
        current.edges[at] = { ...current.edges[at], ...op.patch, id: current.edges[at].id };
        applied += 1;
        break;
      }

      case 'remove_node': {
        const at = nodeIndex(op.id);
        if (at < 0) {
          skipped.push({ op, reason: `remove_node: no node "${op.id}"` });
          break;
        }
        current.nodes.splice(at, 1);
        // Cascade: drop edges that referenced the removed node.
        const before = current.edges.length;
        current.edges = current.edges.filter((e) => e.source !== op.id && e.target !== op.id);
        applied += 1;
        if (before !== current.edges.length) {
          applied += before - current.edges.length;
        }
        break;
      }

      case 'remove_edge': {
        const at = edgeIndex(op.id);
        if (at < 0) {
          skipped.push({ op, reason: `remove_edge: no edge "${op.id}"` });
          break;
        }
        current.edges.splice(at, 1);
        applied += 1;
        break;
      }

      case 'set_title': {
        current.title = op.title;
        applied += 1;
        break;
      }

      case 'replace_all': {
        if (!op.spec || !Array.isArray(op.spec.nodes)) {
          skipped.push({ op, reason: 'replace_all requires a spec with nodes' });
          break;
        }
        current = {
          ...op.spec,
          nodes: [...op.spec.nodes],
          edges: [...(op.spec.edges ?? [])],
        };
        applied += 1;
        break;
      }

      default:
        skipped.push({ op, reason: `unknown operation "${(op as { op: string }).op}"` });
        break;
    }
  }

  return { spec: current, applied, skipped };
}

/** Compact, token-efficient view of a diagram for follow-up prompts. */
export function summarizeSpec(spec: DiagramSpec): string {
  const nodes = (spec.nodes ?? [])
    .map((n) => {
      const bits = [`id=${n.id}`, `label=${JSON.stringify(n.label)}`];
      if (n.shape) bits.push(`shape=${n.shape}`);
      if (n.role) bits.push(`role=${n.role}`);
      if (n.accent) bits.push(`accent=${n.accent}`);
      if (typeof n.x === 'number') bits.push(`@${n.x},${n.y}`);
      return `  - ${bits.join(' ')}`;
    })
    .join('\n');
  const edges = (spec.edges ?? [])
    .map((e) => {
      const bits = [`${e.source} -> ${e.target}`];
      if (e.id) bits.push(`(id=${e.id})`);
      if (e.label) bits.push(`label=${JSON.stringify(e.label)}`);
      return `  - ${bits.join(' ')}`;
    })
    .join('\n');

  return [
    `kind: ${spec.kind ?? 'generic'}`,
    `title: ${spec.title ?? '(none)'}`,
    `layout: ${spec.layout ?? 'auto'} direction: ${spec.direction ?? 'TB'}`,
    `nodes (${(spec.nodes ?? []).length}):`,
    nodes || '  (none)',
    `edges (${(spec.edges ?? []).length}):`,
    edges || '  (none)',
  ].join('\n');
}

/** Convenience for tests/tools. */
export function emptySpec(kind: DiagramSpec['kind'] = 'flowchart'): DiagramSpec {
  return { kind, title: 'Untitled', nodes: [], edges: [], layout: 'layered', direction: 'TB', theme: 'nebula' };
}

export type { DiagramSpec, DiagramNode, DiagramEdge, EditOp };
