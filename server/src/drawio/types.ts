/**
 * DiagramSpec — the intermediate representation between the LLM and draw.io.
 *
 * Why an IR instead of asking the model for raw mxGraph XML:
 *  - LLMs routinely produce malformed XML / dangling edge references / duplicated
 *    ids. Serialising from a validated, typed spec makes invalid output impossible.
 *  - Diffs ("add a cache node between A and B") are cheap and safe on JSON.
 *  - The same spec can be re-laid-out, re-themed and re-exported without a model call.
 *
 * `mxgraph.ts` turns this into draw.io-compatible mxGraphModel XML.
 */

/** Node shapes we map onto real draw.io styles. */
export type NodeShape =
  | 'rect'
  | 'rounded'
  | 'ellipse'
  | 'diamond'
  | 'hexagon'
  | 'parallelogram'
  | 'cylinder'
  | 'cloud'
  | 'document'
  | 'note'
  | 'actor'
  | 'circle'
  | 'process'
  | 'terminator'
  | 'card'
  | 'step'
  | 'trapezoid'
  | 'triangle'
  | 'star'
  | 'image';

/** Semantic role — drives the default palette so diagrams look designed, not random. */
export type NodeRole =
  | 'start'
  | 'end'
  | 'process'
  | 'decision'
  | 'data'
  | 'database'
  | 'service'
  | 'client'
  | 'queue'
  | 'external'
  | 'note'
  | 'group'
  | 'default';

export type NodeAccent =
  | 'blue'
  | 'cyan'
  | 'violet'
  | 'green'
  | 'amber'
  | 'rose'
  | 'slate'
  | 'none';

export interface DiagramNode {
  /** Stable id used by edges and by AI edit operations. Must be unique. */
  id: string;
  label: string;
  /** Optional secondary line, rendered under the label. */
  sublabel?: string;
  shape?: NodeShape;
  role?: NodeRole;
  accent?: NodeAccent;
  /** Absolute model coordinates. The layout engine fills these when omitted. */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** Raw draw.io style overrides, merged last. Escape hatch for power users. */
  style?: string;
  /** Parent container id (draw.io group/container). */
  parent?: string;
}

export interface DiagramEdge {
  id?: string;
  source: string;
  target: string;
  label?: string;
  /** Line routing style. */
  style?: 'orthogonal' | 'straight' | 'curved' | 'entity';
  /** Arrow head style. */
  arrow?: 'classic' | 'open' | 'block' | 'none' | 'diamond';
  /** Solid, dashed or dotted. */
  line?: 'solid' | 'dashed' | 'dotted';
  accent?: NodeAccent;
  /** Animated flow (draw.io `flowAnimation=1`). */
  animated?: boolean;
  /** draw.io exit/entry perimeter points, e.g. "0.5 0" (top) / "0.5 1" (bottom). */
  exitX?: number;
  exitY?: number;
  entryX?: number;
  entryY?: number;
}

export interface DiagramSpec {
  /** Diagram kind — used for styling defaults and prompt guidance. */
  kind?: DiagramKind;
  title?: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  /** Layout algorithm to run before serialising. */
  layout?: LayoutName | 'none';
  direction?: LayoutDirection;
  /** Page/theme preset applied to the mxGraphModel. */
  theme?: DiagramTheme;
}

export type DiagramKind =
  | 'flowchart'
  | 'architecture'
  | 'mindmap'
  | 'sequence'
  | 'er'
  | 'orgchart'
  | 'uml'
  | 'network'
  | 'generic';

export type LayoutName =
  | 'layered'
  | 'tree'
  | 'radial'
  | 'mindmap'
  | 'grid'
  | 'force'
  | 'none';

export type LayoutDirection = 'TB' | 'BT' | 'LR' | 'RL';

export type DiagramTheme = 'nebula' | 'blueprint' | 'light';

/** Incremental edit operations emitted by the model for follow-up turns. */
export type EditOp =
  | { op: 'add_node'; node: DiagramNode }
  | { op: 'add_edge'; edge: DiagramEdge }
  | { op: 'update_node'; id: string; patch: Partial<Omit<DiagramNode, 'id'>> }
  | { op: 'update_edge'; id: string; patch: Partial<Omit<DiagramEdge, 'id'>> }
  | { op: 'remove_node'; id: string }
  | { op: 'remove_edge'; id: string }
  | { op: 'set_title'; title: string }
  | { op: 'replace_all'; spec: DiagramSpec };

/** What the model returns for a create-or-edit turn. */
export interface AgentPlan {
  /** Short natural-language reply shown in the chat panel. */
  reply: string;
  /** Full spec — present when the model (re)generates the whole diagram. */
  spec?: DiagramSpec;
  /** Incremental ops — preferred for follow-up edits. */
  operations?: EditOp[];
  /** Optional follow-up suggestions rendered as chips in the UI. */
  suggestions?: string[];
}
