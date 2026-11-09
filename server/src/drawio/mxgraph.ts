/**
 * DiagramSpec -> draw.io compatible mxGraphModel XML.
 *
 * Output is byte-for-byte in the format draw.io itself writes, so it round-trips
 * through the editor, the desktop app, and any diagrams.net instance:
 *
 *   <mxfile host="app.diagrams.net" ...>
 *     <diagram id="..." name="Page-1">
 *       <mxGraphModel dx=".." dy=".." grid="1" ... >
 *         <root>
 *           <mxCell id="0"/>
 *           <mxCell id="1" parent="0"/>
 *           <mxCell id="n1" value="Start" style="..." vertex="1" parent="1">
 *             <mxGeometry x="40" y="40" width="170" height="64" as="geometry"/>
 *           </mxCell>
 *           ...
 *         </root>
 *       </mxGraphModel>
 *     </diagram>
 *   </mxfile>
 */
import { defaultSize, edgeStyle, nodeStyle, paletteFor, resolveShape } from './styles.js';
import { findOverlaps, runLayout } from './layout.js';
import type { DiagramEdge, DiagramNode, DiagramSpec, DiagramTheme, LayoutDirection, LayoutName } from './types.js';

export const DRAWIO_HOST = 'app.diagrams.net';

const PAGE_PRESETS: Record<DiagramTheme, { page: string; bg: string; grid: string }> = {
  nebula: { page: '#0b1220', bg: '#0b1220', grid: '1' },
  blueprint: { page: '#ffffff', bg: '#ffffff', grid: '1' },
  light: { page: '#ffffff', bg: '#ffffff', grid: '1' },
};

// ---------------------------------------------------------------------------
// XML escaping
// ---------------------------------------------------------------------------

export interface EscapeOptions {
  /**
   * Also escape `"` and `'`. Required whenever the value lands inside a quoted
   * XML attribute — including HTML fragments draw.io stores in `value=`, where a
   * stray quote would terminate the attribute early.
   */
  quotes?: boolean;
}

export function escapeXml(value: unknown, options: EscapeOptions = {}): string {
  let out = String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  if (options.quotes !== false) {
    out = out.replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }
  // XML 1.0 forbids most control characters; strip rather than emit invalid XML.
  return out.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

/**
 * Build the cell `value` for a node/edge label.
 *
 * Returns unescaped HTML. The caller MUST run the result through
 * `escapeXml(..., {quotes:true})` when placing it into the `value="..."` XML
 * attribute — the markup we add here contains its own double quotes.
 *
 * draw.io renders `value` as HTML (html=1), so newlines become <br> and the
 * user's text is escaped so it can never inject markup of its own.
 */
export function toLabelHtml(label: string | undefined, sublabel?: string): string {
  const main = escapeXml(label ?? '').replace(/\r?\n/g, '<br>');
  if (!sublabel) return main;
  const sub = escapeXml(sublabel).replace(/\r?\n/g, '<br>');
  return `${main}<div style="font-size:10px;opacity:.72;margin-top:2px;">${sub}</div>`;
}

// ---------------------------------------------------------------------------
// Id generation
// ---------------------------------------------------------------------------

const ID_SAFE = /[^A-Za-z0-9_:-]/g;

/** Deterministic, XML-safe, unique cell ids. */
export class IdFactory {
  private used = new Set<string>();
  private counter = 0;

  constructor(private readonly prefix = 'c') {}

  /** Keeps a caller-supplied id when it is usable, otherwise mints a new one. */
  claim(preferred?: string): string {
    const base = (preferred ?? '').trim().replace(ID_SAFE, '_');
    const candidate = base.length > 0 ? base : `${this.prefix}${++this.counter}`;
    let id = candidate;
    let n = 1;
    while (this.used.has(id) || id === '0' || id === '1') {
      id = `${candidate}_${n++}`;
    }
    this.used.add(id);
    return id;
  }

  reserve(id: string): void {
    this.used.add(id);
  }
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

export interface ResolvedGraph {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  /** Cell id actually used for each logical node id. */
  idMap: Map<string, string>;
  /** Edge id for each logical edge index. */
  edgeIds: string[];
  warnings: string[];
  width: number;
  height: number;
}

export interface CompileOptions {
  /** Run a layout when nodes lack coordinates. */
  autoLayout?: boolean;
  layout?: LayoutName | 'none';
  direction?: LayoutDirection;
  theme?: DiagramTheme;
}

/**
 * Normalise a spec: validate references, drop dangling edges, de-duplicate ids,
 * assign geometry, and run layout. Pure — no I/O.
 */
export function resolveGraph(spec: DiagramSpec, options: CompileOptions = {}): ResolvedGraph {
  const warnings: string[] = [];
  const theme = options.theme ?? spec.theme ?? 'nebula';

  /**
   * ONE id space for nodes and edges.
   *
   * draw.io cell ids must be globally unique within a model, and a spec may
   * legitimately use the same string for a node and an edge (the ER template
   * uses e1..eN for both). Separate factories produced duplicate cells, and any
   * id-keyed reader then lost nodes to edges.
   */
  const ids = new IdFactory('c');
  const idMap = new Map<string, string>();

  // --- nodes -------------------------------------------------------------
  const seenRaw = new Set<string>();
  const nodes: DiagramNode[] = [];
  for (const raw of spec.nodes ?? []) {
    if (!raw || typeof raw !== 'object') continue;
    const rawId = (raw.id ?? '').toString().trim();
    let duplicate = false;
    if (rawId && seenRaw.has(rawId)) {
      warnings.push(`duplicate node id "${rawId}" — renamed to keep cell ids unique`);
      duplicate = true;
    }
    const cellId = ids.claim(rawId || (raw.label ?? '').toString().slice(0, 12));
    if (rawId) {
      // The first node claiming an id owns it, so edges keep pointing at the
      // original node. Never overwrite: a later duplicate must not steal the
      // mapping (its label may differ entirely).
      if (!idMap.has(rawId)) idMap.set(rawId, cellId);
      seenRaw.add(rawId);
    }
    // Also resolve edges that name the generated cell id directly. Guarded so a
    // node's own logical id mapping is never clobbered by a duplicate's cell id.
    if (!idMap.has(cellId)) idMap.set(cellId, cellId);
    nodes.push({ ...raw, id: duplicate || !rawId ? cellId : rawId });
  }
  if (nodes.length === 0) {
    warnings.push('diagram contains no nodes');
  }

  // --- layout ------------------------------------------------------------
  const rawEdges = (spec.edges ?? []).filter((e) => e && typeof e === 'object');
  const layoutName: LayoutName | 'none' =
    options.layout ?? spec.layout ?? (needsLayout(nodes) ? defaultLayout(spec) : 'none');
  const shouldLayout = (options.autoLayout ?? true) && layoutName !== 'none';

  const laidOut = shouldLayout
    ? runLayout(nodes, rawEdges, layoutName, {
        direction: options.direction ?? spec.direction ?? 'TB',
      })
    : nodes.map((n) => {
        const size = defaultSize(resolveShape(n));
        return {
          ...n,
          x: n.x ?? 0,
          y: n.y ?? 0,
          width: n.width && n.width > 0 ? n.width : size.width,
          height: n.height && n.height > 0 ? n.height : size.height,
        };
      });

  // --- edges -------------------------------------------------------------
  const resolved: DiagramEdge[] = [];
  const edgeIds: string[] = [];

  for (const edge of rawEdges) {
    const s = idMap.get(String(edge.source));
    const t = idMap.get(String(edge.target));
    if (!s || !t) {
      warnings.push(
        `dropped edge "${edge.source}" -> "${edge.target}": unknown endpoint(s)` +
          `${s ? '' : ` (source "${edge.source}")`}${t ? '' : ` (target "${edge.target}")`}`,
      );
      continue;
    }
    if (s === t) {
      warnings.push(`dropped self-loop on "${edge.source}"`);
      continue;
    }
    const cellId = ids.claim(edge.id);
    edgeIds.push(cellId);
    resolved.push({ ...edge, id: cellId, source: s, target: t });
  }

  const overlaps = findOverlaps(laidOut);
  if (overlaps.length > 0 && !shouldLayout) {
    warnings.push(
      `${overlaps.length} overlapping node pair(s) — consider layout:"layered" to auto-arrange`,
    );
  }

  const bounds = computeBounds(laidOut);

  return {
    nodes: laidOut,
    edges: resolved,
    idMap,
    edgeIds,
    warnings,
    width: bounds.width,
    height: bounds.height,
  };
}

function needsLayout(nodes: DiagramNode[]): boolean {
  return nodes.some((n) => n.x === undefined || n.y === undefined);
}

function defaultLayout(spec: DiagramSpec): LayoutName {
  switch (spec.kind) {
    case 'mindmap':
      return 'mindmap';
    case 'orgchart':
      return 'tree';
    case 'network':
      return 'radial';
    case 'architecture':
      return 'layered';
    default:
      return 'layered';
  }
}

function computeBounds(nodes: DiagramNode[]): { width: number; height: number } {
  if (!nodes.length) return { width: 850, height: 1100 };
  const maxX = Math.max(...nodes.map((n) => (n.x ?? 0) + (n.width ?? 170)));
  const maxY = Math.max(...nodes.map((n) => (n.y ?? 0) + (n.height ?? 64)));
  return { width: Math.ceil(maxX + 40), height: Math.ceil(maxY + 40) };
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

export interface SerializeOptions extends CompileOptions {
  /** Page (tab) name shown in draw.io. */
  pageName?: string;
  /** Stable diagram id — keep it constant across edits so the editor can diff. */
  diagramId?: string;
}

export interface CompileResult {
  xml: string;
  warnings: string[];
  nodeCount: number;
  edgeCount: number;
  width: number;
  height: number;
}

export function compileToXml(spec: DiagramSpec, options: SerializeOptions = {}): CompileResult {
  const theme = options.theme ?? spec.theme ?? 'nebula';
  const graph = resolveGraph(spec, options);

  const cells: string[] = [];
  // draw.io requires the two reserved root cells, in this order.
  cells.push('        <mxCell id="0"/>');
  cells.push('        <mxCell id="1" parent="0"/>');

  for (const node of graph.nodes) {
    const style = nodeStyle(node, {
      theme,
      bold: node.role === 'group' || node.role === 'start' || node.role === 'end',
      container: node.role === 'group',
      fontSize: node.role === 'group' ? 14 : undefined,
    });
    const value = escapeXml(toLabelHtml(node.label, node.sublabel));
    const parent = node.parent ? (graph.idMap.get(node.parent) ?? '1') : '1';
    cells.push(
      `        <mxCell id="${escapeXml(node.id)}" value="${value}" style="${escapeXml(style)}" ` +
        `vertex="1" parent="${escapeXml(parent)}" data-ai-node="1">`,
    );
    cells.push(
      `          <mxGeometry x="${Math.round(node.x ?? 0)}" y="${Math.round(node.y ?? 0)}" ` +
        `width="${Math.round(node.width ?? 170)}" height="${Math.round(node.height ?? 64)}" as="geometry"/>`,
    );
    cells.push('        </mxCell>');
  }

  for (const edge of graph.edges) {
    const style = edgeStyle(edge, { theme });
    const value = edge.label ? escapeXml(toLabelHtml(edge.label)) : '';
    cells.push(
      `        <mxCell id="${escapeXml(edge.id ?? '')}" value="${value}" style="${escapeXml(style)}" ` +
        `edge="1" parent="1" source="${escapeXml(edge.source)}" target="${escapeXml(edge.target)}">`,
    );
    cells.push('          <mxGeometry relative="1" as="geometry"/>');
    cells.push('        </mxCell>');
  }

  const preset = PAGE_PRESETS[theme];
  const pageWidth = Math.max(850, graph.width);
  const pageHeight = Math.max(1100, graph.height);

  const xml = [
    `<mxfile host="${DRAWIO_HOST}" modified="${new Date().toISOString()}" agent="AutoDrawFlowchart" version="24.7.17" type="device">`,
    `  <diagram id="${escapeXml(options.diagramId ?? 'autodraw-page-1')}" name="${escapeXml(
      options.pageName ?? spec.title ?? 'Page-1',
    )}">`,
    `    <mxGraphModel dx="1422" dy="844" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="${pageWidth}" pageHeight="${pageHeight}" math="0" shadow="0" background="${preset.bg}">`,
    '      <root>',
    ...cells,
    '      </root>',
    '    </mxGraphModel>',
    '  </diagram>',
    '</mxfile>',
  ].join('\n');

  return {
    xml,
    warnings: graph.warnings,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    width: graph.width,
    height: graph.height,
  };
}

// ---------------------------------------------------------------------------
// Parsing back (used for validation + spec round-trip)
// ---------------------------------------------------------------------------

export interface ParsedDiagram {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

const STYLE_RE = /(\w+)=([^;]*)/g;

function parseStyle(style: string): Record<string, string> {
  const out: Record<string, string> = {};
  let m: RegExpExecArray | null;
  STYLE_RE.lastIndex = 0;
  while ((m = STYLE_RE.exec(style)) !== null) out[m[1]] = m[2];
  return out;
}

/**
 * Recover a plain-text label from a draw.io cell value.
 *
 * Two ordering rules matter here:
 *  1. Decode entities before touching markup, because we escape user text into
 *     `&lt;tag&gt;` on the way out — stripping first would delete it.
 *  2. Only unwrap the markup draw.io itself generates. A blanket `<[^>]*>` strip
 *     would eat legitimate angle-bracket text the user typed.
 */
export function fromLabelHtml(value: string): string {
  const WRAPPER = 'div|p|span|font|b|i|u|h[1-6]|table|tr|td|tbody|ul|ol|li';
  return decodeEntities(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(new RegExp(`</(?:${WRAPPER})\\s*>`, 'gi'), '\n')
    .replace(new RegExp(`<(?:${WRAPPER})\\b[^>]*>`, 'gi'), '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Read one XML attribute out of a tag's attribute string.
 *
 * The leading `\b` is load-bearing: without it, asking for `x` also matches the
 * `x` inside `exitX="0.5"` (and `dx` inside `exitDx`), which silently corrupted
 * the recovered geometry for every cell whose style contained those keys.
 *
 * Safe against embedded quotes: `escapeXml` encodes `"` as `&quot;`, so a value
 * can never contain a raw quote and a non-greedy match to the next one is exact.
 */
export function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return m ? m[1] : undefined;
}

/**
 * Extract nodes/edges from draw.io XML. Deliberately tolerant: it only needs to
 * recover enough structure to feed back into the agent as context, and to let
 * the validator confirm the produced XML is parseable by a third party.
 */
export function parseDrawioXml(xml: string): ParsedDiagram {
  const cells = new Map<
    string,
    {
      value: string;
      style: string;
      vertex: boolean;
      edge: boolean;
      source?: string;
      target?: string;
      geometry?: Record<string, number>;
      parent?: string;
    }
  >();

  // Match each mxCell start tag; draw.io never nests mxCell, so a regex is safe
  // here (and avoids pulling in a full XML DOM in the hot path).
  const cellRe = /<mxCell\b([^>]*?)(\/>|>([\s\S]*?)<\/mxCell>)/g;
  let m: RegExpExecArray | null;
  while ((m = cellRe.exec(xml)) !== null) {
    const attrs = m[1];
    const body = m[3] ?? '';
    const id = attr(attrs, 'id');
    if (!id) continue;
    const geometry: Record<string, number> = {};
    const geo = /<mxGeometry\b([^>]*?)\/?>/.exec(body);
    if (geo) {
      for (const key of ['x', 'y', 'width', 'height']) {
        const v = attr(geo[1], key);
        if (v !== undefined) geometry[key] = Number(v);
      }
    }
    cells.set(id, {
      value: decodeEntities(attr(attrs, 'value') ?? ''),
      style: decodeEntities(attr(attrs, 'style') ?? ''),
      vertex: /\bvertex="1"/.test(attrs),
      edge: /\bedge="1"/.test(attrs),
      source: attr(attrs, 'source'),
      target: attr(attrs, 'target'),
      parent: attr(attrs, 'parent'),
      geometry,
    });
  }

  const nodes: DiagramNode[] = [];
  for (const [id, cell] of cells) {
    if (id === '0' || id === '1' || !cell.vertex) continue;
    const style = parseStyle(cell.style);
    const shape = style.shape;
    nodes.push({
      id,
      label: fromLabelHtml(cell.value),
      x: cell.geometry?.x,
      y: cell.geometry?.y,
      width: cell.geometry?.width,
      height: cell.geometry?.height,
      shape: shape === 'cylinder3' ? 'cylinder' : shape === 'cloud' ? 'cloud' : undefined,
      accent: guessAccent(style.strokeColor),
      style: undefined,
    });
  }

  const edges: DiagramEdge[] = [];
  for (const [id, cell] of cells) {
    if (!cell.edge || !cell.source || !cell.target) continue;
    edges.push({
      id,
      source: cell.source,
      target: cell.target,
      label: cell.value || undefined,
    });
  }

  return { nodes, edges };
}

function guessAccent(stroke: string | undefined): DiagramNode['accent'] {
  if (!stroke) return undefined;
  const table: Array<[string, DiagramNode['accent']]> = [
    ['#3b82f6', 'blue'],
    ['#2563eb', 'blue'],
    ['#22d3ee', 'cyan'],
    ['#0891b2', 'cyan'],
    ['#8b5cf6', 'violet'],
    ['#7c3aed', 'violet'],
    ['#34d399', 'green'],
    ['#16a34a', 'green'],
    ['#f5b429', 'amber'],
    ['#d97706', 'amber'],
    ['#fb7185', 'rose'],
    ['#e11d48', 'rose'],
    ['#64748b', 'slate'],
  ];
  for (const [hex, accent] of table) {
    if (stroke.toLowerCase() === hex) return accent;
  }
  return undefined;
}

/** Lightweight well-formedness check used by the validator and the tests. */
export function assertWellFormed(xml: string): void {
  const stack: string[] = [];
  const tagRe = /<(\/?)([A-Za-z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml)) !== null) {
    const [, closing, name, , selfClose] = m;
    if (name.startsWith('?') || name.startsWith('!')) continue;
    if (closing) {
      const open = stack.pop();
      if (open !== name) {
        throw new Error(`malformed XML: </${name}> closes <${open ?? 'nothing'}>`);
      }
    } else if (!selfClose) {
      stack.push(name);
    }
  }
  if (stack.length) throw new Error(`malformed XML: unclosed <${stack[stack.length - 1]}>`);
}

/** Palette access for the frontend preview / swatches. */
export function themePalette(theme: DiagramTheme, accent: Parameters<typeof paletteFor>[1]) {
  return paletteFor(theme, accent);
}
