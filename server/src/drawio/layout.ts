/**
 * Graph layout for generated diagrams.
 *
 * The model is allowed (and encouraged) to omit coordinates — hand-placed boxes
 * from an LLM are usually overlapping and ugly. When coordinates are missing we
 * run a compact Sugiyama-style layered layout, which is what flowcharts and
 * architecture diagrams need to look professionally drawn.
 *
 * Implemented here from scratch (no dependency) because we only need:
 *   cycle removal -> layer assignment -> barycentre crossing reduction -> packing
 * plus two specialised modes (radial mind map, tidy tree).
 */
import { defaultSize, resolveShape } from './styles.js';
import type { DiagramEdge, DiagramNode, LayoutDirection, LayoutName } from './types.js';

export interface LayoutOptions {
  direction: LayoutDirection;
  /** Horizontal space between two nodes in the same layer. */
  nodeGap: number;
  /** Vertical space between layers. */
  layerGap: number;
  /** Number of barycentre sweeps. */
  sweeps?: number;
  /** Treat first node of each layer as a spine (used by tree/mindmap). */
  rootId?: string;
}

const DEFAULTS: LayoutOptions = { direction: 'TB', nodeGap: 60, layerGap: 90, sweeps: 8 };

interface Box {
  width: number;
  height: number;
}

function boxOf(node: DiagramNode): Box {
  const fallback = defaultSize(resolveShape(node));
  return {
    width: node.width && node.width > 0 ? node.width : fallback.width,
    height: node.height && node.height > 0 ? node.height : fallback.height,
  };
}

/** Nodes that already carry coordinates keep them; everything else gets laid out. */
export function runLayout(
  nodes: DiagramNode[],
  edges: DiagramEdge[],
  layout: LayoutName | 'none',
  options: Partial<LayoutOptions> = {},
): DiagramNode[] {
  if (layout === 'none' || nodes.length === 0) return fillMissing(nodes, edges);
  const opts: LayoutOptions = { ...DEFAULTS, ...options };

  const boxes = new Map(nodes.map((n) => [n.id, boxOf(n)]));
  const ids = nodes.map((n) => n.id);
  const index = new Map(ids.map((id, i) => [id, i]));

  // Keep only edges whose endpoints exist.
  const validEdges = edges.filter((e) => index.has(e.source) && index.has(e.target) && e.source !== e.target);
  const adjacency = buildAdjacency(ids, validEdges);

  let positions: Map<string, { x: number; y: number }>;

  switch (layout) {
    case 'radial':
      positions = radialLayout(ids, validEdges, boxes, adjacency);
      break;
    case 'mindmap':
      positions = mindmapLayout(ids, validEdges, boxes, adjacency, opts.rootId);
      break;
    case 'tree':
      positions = treeLayout(ids, validEdges, boxes, adjacency, opts);
      break;
    case 'grid':
      positions = gridLayout(ids, boxes, opts);
      break;
    case 'force':
      positions = forceLayout(ids, validEdges, boxes, opts);
      break;
    case 'layered':
    default:
      positions = layeredLayout(ids, validEdges, boxes, adjacency, opts);
      break;
  }

  const laid = nodes.map((n) => {
    const p = positions.get(n.id);
    const box = boxes.get(n.id)!;
    return {
      ...n,
      x: Math.round(p ? p.x : (n.x ?? 0)),
      y: Math.round(p ? p.y : (n.y ?? 0)),
      width: Math.round(n.width && n.width > 0 ? n.width : box.width),
      height: Math.round(n.height && n.height > 0 ? n.height : box.height),
    };
  });
  return normalizeOrigin(laid);
}

/** Nodes without coordinates and no edges at all still need to land somewhere sane. */
function fillMissing(nodes: DiagramNode[], edges: DiagramEdge[]): DiagramNode[] {
  const missing = nodes.filter((n) => n.x === undefined || n.y === undefined);
  if (missing.length === 0) {
    return normalizeOrigin(
      nodes.map((n) => {
        const b = boxOf(n);
        return { ...n, x: n.x ?? 0, y: n.y ?? 0, width: n.width ?? b.width, height: n.height ?? b.height };
      }),
    );
  }
  return runLayout(nodes, edges, 'grid', {});
}

function buildAdjacency(ids: string[], edges: DiagramEdge[]) {
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  const inc = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of edges) {
    out.get(e.source)!.push(e.target);
    inc.get(e.target)!.push(e.source);
  }
  return { out, inc };
}

/**
 * DFS-based cycle removal. Edges pointing back to a node still on the stack are
 * marked reversed; the renderer ignores this (we only move boxes), but the layer
 * assignment needs an acyclic view.
 */
function acyclic(ids: string[], edges: DiagramEdge[]): DiagramEdge[] {
  const state = new Map<string, 0 | 1 | 2>(ids.map((id) => [id, 0]));
  const reversed = new Set<number>();
  const out = new Map<string, number[]>(ids.map((id) => [id, []]));
  edges.forEach((e, i) => out.get(e.source)!.push(i));

  // Iterative DFS to survive deep graphs.
  for (const start of ids) {
    if (state.get(start) !== 0) continue;
    const stack: Array<{ id: string; i: number }> = [{ id: start, i: 0 }];
    state.set(start, 1);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const list = out.get(frame.id)!;
      if (frame.i >= list.length) {
        state.set(frame.id, 2);
        stack.pop();
        continue;
      }
      const edgeIndex = list[frame.i++];
      const target = edges[edgeIndex].target;
      const ts = state.get(target);
      if (ts === 1) reversed.add(edgeIndex);
      else if (ts === 0) {
        state.set(target, 1);
        stack.push({ id: target, i: 0 });
      }
    }
  }

  return edges.map((e, i) => (reversed.has(i) ? { ...e, source: e.target, target: e.source } : e));
}

/**
 * Longest-path layering: every node sits one layer below its deepest predecessor.
 * Simple, deterministic and produces the "flow" look users expect.
 */
function assignLayers(ids: string[], edges: DiagramEdge[]): Map<string, number> {
  const dag = acyclic(ids, edges);
  const layer = new Map<string, number>(ids.map((id) => [id, 0]));
  const inc = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of dag) inc.get(e.target)!.push(e.source);

  // Kahn topological order, then relax.
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const e of dag) indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  const queue = ids.filter((id) => (indeg.get(id) ?? 0) === 0);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const e of dag) {
      if (e.source !== id) continue;
      if ((indeg.get(e.target) ?? 0) > 0) {
        indeg.set(e.target, indeg.get(e.target)! - 1);
        if (indeg.get(e.target) === 0) queue.push(e.target);
      }
    }
  }
  // Any leftovers are in residual cycles — append them so nothing is dropped.
  for (const id of ids) if (!order.includes(id)) order.push(id);

  for (const id of order) {
    const base = layer.get(id) ?? 0;
    for (const e of dag) {
      if (e.source !== id) continue;
      if ((layer.get(e.target) ?? 0) < base + 1) layer.set(e.target, base + 1);
    }
  }
  return layer;
}

function layeredLayout(
  ids: string[],
  edges: DiagramEdge[],
  boxes: Map<string, Box>,
  _adj: { out: Map<string, string[]>; inc: Map<string, string[]> },
  opts: LayoutOptions,
): Map<string, { x: number; y: number }> {
  const layers = assignLayers(ids, edges);
  const maxLayer = Math.max(0, ...layers.values());
  const groups: string[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const id of ids) groups[layers.get(id) ?? 0].push(id);

  orderWithinLayers(groups, edges, opts.sweeps ?? 8);

  const horizontal = opts.direction === 'LR' || opts.direction === 'RL';
  return packLayers(groups, boxes, opts, horizontal, opts.direction === 'RL' || opts.direction === 'BT');
}

/** Median/barycentre heuristic passes to reduce edge crossings. */
function orderWithinLayers(groups: string[][], edges: DiagramEdge[], sweeps: number): void {
  const posOf = () => {
    const m = new Map<string, number>();
    groups.forEach((g) => g.forEach((id, i) => m.set(id, i)));
    return m;
  };

  const sortBy = (group: string[], neighbours: Map<string, string[]>, pos: Map<string, number>) => {
    const keyed = group.map((id, i) => {
      const ns = (neighbours.get(id) ?? []).map((n) => pos.get(n)).filter((v): v is number => v !== undefined);
      const bary = ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : i;
      return { id, bary, i };
    });
    keyed.sort((a, b) => (a.bary === b.bary ? a.i - b.i : a.bary - b.bary));
    return keyed.map((k) => k.id);
  };

  const down = new Map<string, string[]>();
  const up = new Map<string, string[]>();
  for (const e of edges) {
    if (!down.has(e.target)) down.set(e.target, []);
    down.get(e.target)!.push(e.source);
    if (!up.has(e.source)) up.set(e.source, []);
    up.get(e.source)!.push(e.target);
  }

  for (let s = 0; s < sweeps; s += 1) {
    const pos = posOf();
    if (s % 2 === 0) {
      for (let i = 1; i < groups.length; i += 1) groups[i] = sortBy(groups[i], down, pos);
    } else {
      for (let i = groups.length - 2; i >= 0; i -= 1) groups[i] = sortBy(groups[i], up, pos);
    }
  }
}

function packLayers(
  groups: string[][],
  boxes: Map<string, Box>,
  opts: LayoutOptions,
  horizontal: boolean,
  reverse: boolean,
): Map<string, { x: number; y: number }> {
  // Cross-axis extent of every layer, so layers are centred on a common spine.
  const extents = groups.map((g) => {
    if (!g.length) return 0;
    return (
      g.reduce((sum, id) => sum + (horizontal ? boxes.get(id)!.height : boxes.get(id)!.width), 0) +
      opts.nodeGap * (g.length - 1)
    );
  });
  const maxExtent = Math.max(0, ...extents);

  const result = new Map<string, { x: number; y: number }>();
  const ordered = reverse ? [...groups].reverse() : groups;

  let mainCursor = 0;
  ordered.forEach((group, layerIdx) => {
    const extent = extents[reverse ? groups.length - 1 - layerIdx : layerIdx];
    let crossCursor = (maxExtent - extent) / 2;
    // Depth of this layer = max size of nodes in the previous layers.
    const depth = group.reduce((m, id) => Math.max(m, horizontal ? boxes.get(id)!.width : boxes.get(id)!.height), 0);

    for (const id of group) {
      const box = boxes.get(id)!;
      const crossSize = horizontal ? box.height : box.width;
      if (horizontal) {
        result.set(id, { x: mainCursor, y: crossCursor });
      } else {
        result.set(id, { x: crossCursor, y: mainCursor });
      }
      crossCursor += crossSize + opts.nodeGap;
    }
    mainCursor += depth + opts.layerGap;
    void layerIdx;
  });

  return result;
}

/** Tidy top-down tree: each subtree gets a contiguous slice of the cross axis. */
function treeLayout(
  ids: string[],
  edges: DiagramEdge[],
  boxes: Map<string, Box>,
  adj: { out: Map<string, string[]>; inc: Map<string, string[]> },
  opts: LayoutOptions,
): Map<string, { x: number; y: number }> {
  const roots = ids.filter((id) => (adj.inc.get(id) ?? []).length === 0);
  const rootList = roots.length ? roots : [ids[0]];
  const seen = new Set<string>();
  const horizontal = opts.direction === 'LR' || opts.direction === 'RL';

  const result = new Map<string, { x: number; y: number }>();
  let crossCursor = 0;

  const visit = (id: string, depth: number): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const box = boxes.get(id)!;
    const children = (adj.out.get(id) ?? []).filter((c) => !seen.has(c));

    if (children.length === 0) {
      // Leaf: claim its own slot.
      const cross = crossCursor;
      crossCursor += (horizontal ? box.height : box.width) + opts.nodeGap;
      const main = depth * (horizontal ? 220 : 120);
      result.set(id, horizontal ? { x: main, y: cross } : { x: cross, y: main });
      return;
    }

    const childCross: number[] = [];
    for (const child of children) {
      visit(child, depth + 1);
      const p = result.get(child);
      if (p) childCross.push(horizontal ? p.y : p.x);
    }
    const first = childCross.length ? Math.min(...childCross) : crossCursor;
    const last = childCross.length ? Math.max(...childCross) : crossCursor;
    const center = (first + last) / 2;
    const main = depth * (horizontal ? 220 : 120);
    result.set(id, horizontal ? { x: main, y: center } : { x: center, y: main });
  };

  for (const root of rootList) visit(root, 0);
  for (const id of ids) if (!seen.has(id)) visit(id, 0);
  return result;
}

/** Mind map: root in the middle, first level fanning out around it. */
function mindmapLayout(
  ids: string[],
  edges: DiagramEdge[],
  boxes: Map<string, Box>,
  adj: { out: Map<string, string[]>; inc: Map<string, string[]> },
  rootId?: string,
): Map<string, { x: number; y: number }> {
  const roots = rootId && ids.includes(rootId) ? [rootId] : ids.filter((id) => (adj.inc.get(id) ?? []).length === 0);
  const root = roots[0] ?? ids[0];
  if (!root) return new Map<string, { x: number; y: number }>();

  const result = new Map<string, { x: number; y: number }>();
  const seen = new Set<string>([root]);
  result.set(root, { x: 0, y: 0 });

  const branches = (adj.out.get(root) ?? []).filter((id) => id !== root);
  const angleStep = (Math.PI * 2) / Math.max(1, branches.length);
  // Ellipse radii scale with how much room the branches need.
  const avgW = branches.reduce((s, id) => s + boxes.get(id)!.width, 0) / Math.max(1, branches.length);
  const radiusX = Math.max(280, avgW * Math.max(1.6, branches.length * 0.42));
  const radiusY = Math.max(220, radiusX * 0.62);

  branches.forEach((branch, i) => {
    if (seen.has(branch)) return;
    seen.add(branch);
    const angle = -Math.PI / 2 + angleStep * i;
    result.set(branch, { x: Math.cos(angle) * radiusX, y: Math.sin(angle) * radiusY });

    // Depth-2 children hug their parent, pushed further outward.
    const children = (adj.out.get(branch) ?? []).filter((c) => !seen.has(c));
    const spread = 0.30;
    children.forEach((child, j) => {
      seen.add(child);
      const offset = (j - (children.length - 1) / 2) * spread;
      const a = angle + offset;
      result.set(child, {
        x: Math.cos(a) * (radiusX + 240),
        y: Math.sin(a) * (radiusY + 190),
      });
    });
  });

  // Anything unreachable (disconnected islands).
  let orphanIdx = 0;
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      const angle = -Math.PI / 2 + angleStep * (branches.length + orphanIdx);
      result.set(id, { x: Math.cos(angle) * (radiusX + 240), y: Math.sin(angle) * (radiusY + 190) });
      orphanIdx += 1;
    }
  }
  return result;
}

function radialLayout(
  ids: string[],
  edges: DiagramEdge[],
  boxes: Map<string, Box>,
  adj: { out: Map<string, string[]>; inc: Map<string, string[]> },
): Map<string, { x: number; y: number }> {
  // BFS from the most-connected node, one ring per hop.
  const degree = (id: string) => (adj.out.get(id) ?? []).length + (adj.inc.get(id) ?? []).length;
  const center = [...ids].sort((a, b) => degree(b) - degree(a))[0];
  const result = new Map<string, { x: number; y: number }>();
  if (!center) return result;

  const ring = new Map<string, number>([[center, 0]]);
  const queue = [center];
  while (queue.length) {
    const id = queue.shift()!;
    const d = ring.get(id)!;
    for (const next of [...(adj.out.get(id) ?? []), ...(adj.inc.get(id) ?? [])]) {
      if (!ring.has(next)) {
        ring.set(next, d + 1);
        queue.push(next);
      }
    }
  }
  for (const id of ids) if (!ring.has(id)) ring.set(id, Math.max(...ring.values(), 0) + 1);

  const byRing = new Map<number, string[]>();
  for (const [id, r] of ring) {
    if (!byRing.has(r)) byRing.set(r, []);
    byRing.get(r)!.push(id);
  }
  const base = Math.max(200, boxes.get(center)!.width);
  for (const [r, group] of [...byRing.entries()].sort((a, b) => a[0] - b[0])) {
    if (r === 0) {
      result.set(group[0], { x: 0, y: 0 });
      continue;
    }
    const radius = base + r * 210;
    group.forEach((id, i) => {
      const a = (Math.PI * 2 * i) / group.length - Math.PI / 2;
      result.set(id, { x: Math.cos(a) * radius, y: Math.sin(a) * radius });
    });
  }
  return result;
}

function gridLayout(ids: string[], boxes: Map<string, Box>, opts: LayoutOptions): Map<string, { x: number; y: number }> {
  const cols = Math.max(1, Math.ceil(Math.sqrt(ids.length)));
  const cellW = Math.max(...ids.map((id) => boxes.get(id)!.width)) + opts.nodeGap;
  const cellH = Math.max(...ids.map((id) => boxes.get(id)!.height)) + opts.nodeGap;
  const result = new Map<string, { x: number; y: number }>();
  ids.forEach((id, i) => {
    result.set(id, { x: (i % cols) * cellW, y: Math.floor(i / cols) * cellH });
  });
  return result;
}

/** Tiny force-directed fallback for graphs where layering reads badly. */
function forceLayout(
  ids: string[],
  edges: DiagramEdge[],
  boxes: Map<string, Box>,
  opts: LayoutOptions,
): Map<string, { x: number; y: number }> {
  const n = ids.length;
  const index = new Map(ids.map((id, i) => [id, i]));
  const pos = ids.map((id, i) => ({
    x: Math.cos((i / n) * Math.PI * 2) * 260,
    y: Math.sin((i / n) * Math.PI * 2) * 260,
  }));
  const ideal = 260;
  const iterations = 320;

  for (let step = 0; step < iterations; step += 1) {
    const alpha = 1 - step / iterations;
    const disp = pos.map(() => ({ x: 0, y: 0 }));

    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        let dx = pos[i].x - pos[j].x;
        let dy = pos[i].y - pos[j].y;
        let dist = Math.hypot(dx, dy) || 0.01;
        const minDist = (boxes.get(ids[i])!.width + boxes.get(ids[j])!.width) / 2 + opts.nodeGap;
        const rep = ((ideal * ideal) / dist) * 0.9 + (dist < minDist ? (minDist - dist) * 2.2 : 0);
        dx /= dist;
        dy /= dist;
        disp[i].x += dx * rep;
        disp[i].y += dy * rep;
        disp[j].x -= dx * rep;
        disp[j].y -= dy * rep;
      }
    }
    for (const e of edges) {
      const a = index.get(e.source);
      const b = index.get(e.target);
      if (a === undefined || b === undefined) continue;
      let dx = pos[a].x - pos[b].x;
      let dy = pos[a].y - pos[b].y;
      const dist = Math.hypot(dx, dy) || 0.01;
      const force = ((dist - ideal) / dist) * 0.12;
      dx *= force;
      dy *= force;
      disp[a].x -= dx;
      disp[a].y -= dy;
      disp[b].x += dx;
      disp[b].y += dy;
    }
    for (let i = 0; i < n; i += 1) {
      const mag = Math.hypot(disp[i].x, disp[i].y) || 1;
      const limit = Math.min(mag, 60 * alpha);
      pos[i].x += (disp[i].x / mag) * limit;
      pos[i].y += (disp[i].y / mag) * limit;
    }
  }

  const result = new Map<string, { x: number; y: number }>();
  ids.forEach((id, i) => result.set(id, pos[i]));
  return result;
}

/** Shift the whole diagram so it starts at a small positive margin. */
export function normalizeOrigin(nodes: DiagramNode[], margin = 40): DiagramNode[] {
  if (!nodes.length) return nodes;
  const minX = Math.min(...nodes.map((n) => n.x ?? 0));
  const minY = Math.min(...nodes.map((n) => n.y ?? 0));
  const dx = margin - minX;
  const dy = margin - minY;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return nodes;
  return nodes.map((n) => ({ ...n, x: Math.round((n.x ?? 0) + dx), y: Math.round((n.y ?? 0) + dy) }));
}

/** Axis-aligned overlap detection — used by the validator to warn the model. */
export function findOverlaps(
  nodes: DiagramNode[],
  padding = 8,
): Array<{ a: string; b: string }> {
  const box = new Map(
    nodes.map((n) => {
      const b = boxOf(n);
      return [
        n.id,
        {
          x1: n.x ?? 0,
          y1: n.y ?? 0,
          x2: (n.x ?? 0) + (n.width ?? b.width),
          y2: (n.y ?? 0) + (n.height ?? b.height),
        },
      ];
    }),
  );
  const collisions: Array<{ a: string; b: string }> = [];
  const list = nodes.map((n) => n.id);
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const A = box.get(list[i])!;
      const B = box.get(list[j])!;
      const overlap =
        A.x1 < B.x2 + padding && B.x1 < A.x2 + padding && A.y1 < B.y2 + padding && B.y1 < A.y2 + padding;
      if (overlap) collisions.push({ a: list[i], b: list[j] });
    }
  }
  return collisions;
}
