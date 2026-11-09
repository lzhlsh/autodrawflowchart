/**
 * draw.io style vocabulary.
 *
 * Everything here is plain draw.io style syntax, so the output opens in any
 * draw.io / diagrams.net instance (online, desktop or self-hosted) with no
 * plugins. Palettes are tuned for the "nebula" dark theme used by the app.
 */
import type { DiagramEdge, DiagramNode, DiagramTheme, NodeAccent, NodeRole, NodeShape } from './types.js';

export interface Palette {
  fill: string;
  stroke: string;
  text: string;
}

const NEBULA: Record<NodeAccent, Palette> = {
  blue: { fill: '#0e1e3a', stroke: '#3b82f6', text: '#cfe2ff' },
  cyan: { fill: '#0b2630', stroke: '#22d3ee', text: '#ccf6ff' },
  violet: { fill: '#1c1638', stroke: '#8b5cf6', text: '#e6dcff' },
  green: { fill: '#0c271c', stroke: '#34d399', text: '#d0fbe8' },
  amber: { fill: '#2c2109', stroke: '#f5b429', text: '#fdeec4' },
  rose: { fill: '#2c1220', stroke: '#fb7185', text: '#ffd9e0' },
  slate: { fill: '#151c27', stroke: '#64748b', text: '#dbe3ee' },
  none: { fill: 'none', stroke: 'none', text: '#e2e8f0' },
};

const BLUEPRINT: Record<NodeAccent, Palette> = {
  blue: { fill: '#dbeafe', stroke: '#2563eb', text: '#0f2a5c' },
  cyan: { fill: '#cffafe', stroke: '#0891b2', text: '#083344' },
  violet: { fill: '#ede9fe', stroke: '#7c3aed', text: '#2e1065' },
  green: { fill: '#dcfce7', stroke: '#16a34a', text: '#052e16' },
  amber: { fill: '#fef3c7', stroke: '#d97706', text: '#451a03' },
  rose: { fill: '#ffe4e6', stroke: '#e11d48', text: '#4c0519' },
  slate: { fill: '#f1f5f9', stroke: '#64748b', text: '#1e293b' },
  none: { fill: 'none', stroke: 'none', text: '#0f172a' },
};

const LIGHT = BLUEPRINT;

const PALETTES: Record<DiagramTheme, Record<NodeAccent, Palette>> = {
  nebula: NEBULA,
  blueprint: BLUEPRINT,
  light: LIGHT,
};

export function paletteFor(theme: DiagramTheme, accent: NodeAccent): Palette {
  return PALETTES[theme][accent];
}

/** Which accent a semantic role defaults to. Keeps generated diagrams coherent. */
const ROLE_ACCENT: Record<NodeRole, NodeAccent> = {
  start: 'green',
  end: 'rose',
  process: 'blue',
  decision: 'amber',
  data: 'cyan',
  database: 'violet',
  service: 'cyan',
  client: 'slate',
  queue: 'amber',
  external: 'slate',
  note: 'amber',
  group: 'slate',
  default: 'blue',
};

const ROLE_SHAPE: Record<NodeRole, NodeShape> = {
  start: 'terminator',
  end: 'terminator',
  process: 'rounded',
  decision: 'diamond',
  data: 'parallelogram',
  database: 'cylinder',
  service: 'rounded',
  client: 'rounded',
  queue: 'hexagon',
  external: 'cloud',
  note: 'note',
  group: 'rounded',
  default: 'rounded',
};

export function resolveAccent(node: DiagramNode): NodeAccent {
  if (node.accent) return node.accent;
  return ROLE_ACCENT[node.role ?? 'default'] ?? 'blue';
}

export function resolveShape(node: DiagramNode): NodeShape {
  if (node.shape) return node.shape;
  return ROLE_SHAPE[node.role ?? 'default'] ?? 'rounded';
}

/** Default node box size per shape — diamonds/ellipses need more room for text. */
export function defaultSize(shape: NodeShape): { width: number; height: number } {
  switch (shape) {
    case 'diamond':
      return { width: 160, height: 96 };
    case 'ellipse':
    case 'circle':
      return { width: 130, height: 130 };
    case 'cylinder':
      return { width: 140, height: 100 };
    case 'cloud':
      return { width: 170, height: 110 };
    case 'hexagon':
    case 'parallelogram':
    case 'trapezoid':
      return { width: 170, height: 70 };
    case 'note':
      return { width: 170, height: 90 };
    case 'actor':
      return { width: 60, height: 90 };
    case 'document':
      return { width: 150, height: 100 };
    case 'card':
      return { width: 160, height: 90 };
    default:
      return { width: 170, height: 64 };
  }
}

/** draw.io `shape=` value per exotic shape (rect-based ones need no shape key). */
const SHAPE_KEY: Partial<Record<NodeShape, string>> = {
  cylinder: 'cylinder3',
  cloud: 'cloud',
  document: 'document',
  note: 'note',
  actor: 'actor',
  card: 'card',
  step: 'step',
  trapezoid: 'trapezoid',
  triangle: 'triangle',
  star: 'star',
  process: 'process',
  terminator: 'terminator',
};

export interface NodeStyleOptions {
  theme: DiagramTheme;
  /** Font size override. */
  fontSize?: number;
  /** Bold label (used for containers/titles). */
  bold?: boolean;
  /** Header-style fill for container nodes. */
  container?: boolean;
}

/**
 * Build a full draw.io style string for a node.
 * Base parts mirror mxGraph defaults (`whiteSpace=wrap;html=1;`) so text wraps
 * exactly the way draw.io itself produces.
 */
export function nodeStyle(node: DiagramNode, opts: NodeStyleOptions): string {
  const shape = resolveShape(node);
  const accent = resolveAccent(node);
  const palette = paletteFor(opts.theme, accent);
  const parts: string[] = [];

  // --- base ---
  parts.push('whiteSpace=wrap', 'html=1');

  // --- geometry / shape ---
  if (shape === 'ellipse' || shape === 'circle') {
    parts.push('ellipse');
  } else if (shape === 'diamond') {
    parts.push('rhombus');
  } else if (shape === 'parallelogram') {
    parts.push('shape=parallelogram', 'perimeter=parallelogramPerimeter');
  } else if (shape === 'hexagon') {
    parts.push('shape=hexagon', 'perimeter=hexagonPerimeter2');
  } else if (shape === 'terminator') {
    parts.push('rounded=1', 'arcSize=50');
  } else if (shape === 'rounded' || shape === 'rect') {
    parts.push('rounded=1', 'arcSize=14');
  } else if (shape === 'image') {
    parts.push('shape=image', 'imageAspect=0');
  } else {
    const key = SHAPE_KEY[shape];
    if (key) parts.push(`shape=${key}`);
    else parts.push('rounded=0');
  }

  // --- paint ---
  parts.push(`fillColor=${palette.fill}`, `strokeColor=${palette.stroke}`);
  parts.push('strokeWidth=2');
  if (opts.theme !== 'light') {
    // A soft outer glow reads as "tech" without hurting legibility.
    parts.push(`shadow=1`, 'shadowColor=#000000', 'shadowOpacity=45');
  }
  parts.push(`fontColor=${palette.text}`, `fontSize=${opts.fontSize ?? 13}`);
  parts.push('fontFamily=Inter, Helvetica, Arial, sans-serif');
  if (opts.bold) parts.push('fontStyle=1');
  parts.push('align=center', 'verticalAlign=middle');

  // Containers get a translucent body so children stay readable on top.
  if (opts.container) {
    parts.push('container=1', 'collapsible=0', `fillColor=${palette.fill}`, 'opacity=70');
    parts.push('verticalAlign=top', 'spacingTop=8');
  }

  if (node.style) parts.push(node.style);
  return dedupe(parts.join(';'));
}

export interface EdgeStyleOptions {
  theme: DiagramTheme;
  /** Diagram-level accent fallback. */
  defaultAccent?: NodeAccent;
  fontSize?: number;
}

export function edgeStyle(edge: DiagramEdge, opts: EdgeStyleOptions): string {
  const accent = edge.accent ?? opts.defaultAccent ?? 'slate';
  const palette = paletteFor(opts.theme, accent);
  const parts: string[] = ['html=1', 'whiteSpace=wrap'];

  switch (edge.style ?? 'orthogonal') {
    case 'straight':
      parts.push('edgeStyle=orthogonalEdgeStyle', 'rounded=0');
      break;
    case 'curved':
      parts.push('curved=1', 'rounded=1');
      break;
    case 'entity':
      parts.push('edgeStyle=entityRelationEdgeStyle', 'rounded=0');
      break;
    case 'orthogonal':
    default:
      parts.push('edgeStyle=orthogonalEdgeStyle', 'rounded=1', 'arcSize=12');
      break;
  }

  parts.push('jettySize=auto', 'orthogonalLoop=1', 'jumpStyle=arc', 'jumpSize=6');

  const arrow = edge.arrow ?? 'classic';
  if (arrow === 'none') parts.push('endArrow=none');
  else parts.push(`endArrow=${arrow}`, 'endFill=1');
  parts.push('startArrow=none', 'startFill=0');

  if (edge.line === 'dashed') parts.push('dashed=1', 'dashPattern=8 6');
  else if (edge.line === 'dotted') parts.push('dashed=1', 'dashPattern=2 4');
  else parts.push('dashed=0');

  if (edge.animated) parts.push('flowAnimation=1');

  parts.push(`strokeColor=${palette.stroke}`, 'strokeWidth=2');
  parts.push(`fontColor=${palette.text}`, `fontSize=${opts.fontSize ?? 11}`);
  parts.push('fontFamily=Inter, Helvetica, Arial, sans-serif');
  parts.push('labelBackgroundColor=none', 'verticalAlign=middle', 'align=center');

  if (edge.exitX !== undefined || edge.exitY !== undefined) {
    parts.push('exitX=' + (edge.exitX ?? 0.5), 'exitY=' + (edge.exitY ?? 0.5));
    parts.push('exitDx=0', 'exitDy=0', 'exitPerimeter=0');
  }
  if (edge.entryX !== undefined || edge.entryY !== undefined) {
    parts.push('entryX=' + (edge.entryX ?? 0.5), 'entryY=' + (edge.entryY ?? 0.5));
    parts.push('entryDx=0', 'entryDy=0', 'entryPerimeter=0');
  }

  return dedupe(parts.join(';'));
}

/** Style used for the invisible root of a mind map / tree. */
export function rootNodeStyle(theme: DiagramTheme): string {
  const p = paletteFor(theme, 'violet');
  return dedupe(
    [
      'whiteSpace=wrap',
      'html=1',
      'rounded=1',
      'arcSize=20',
      `fillColor=${p.fill}`,
      `strokeColor=${p.stroke}`,
      'strokeWidth=2',
      `fontColor=${p.text}`,
      'fontSize=16',
      'fontStyle=1',
      'fontFamily=Inter, Helvetica, Arial, sans-serif',
      'align=center',
      'verticalAlign=middle',
      'shadow=1',
      'shadowColor=#000000',
      'shadowOpacity=45',
    ].join(';'),
  );
}

/** Escapes a value for use inside a `key=value;` style segment. */
export function escapeStyleValue(value: string): string {
  return value.replace(/;/g, '').replace(/=/g, '');
}

function dedupe(style: string): string {
  const seen = new Map<string, string>();
  for (const raw of style.split(';')) {
    const part = raw.trim();
    if (!part) continue;
    const eq = part.indexOf('=');
    const key = eq === -1 ? part : part.slice(0, eq);
    seen.set(key, part);
  }
  return [...seen.values()].join(';') + ';';
}
