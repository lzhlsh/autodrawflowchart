/**
 * Prompt construction for the DeepSeek diagram agent.
 *
 * The model never emits XML. It emits a validated JSON `DiagramSpec` (create
 * turns) or a list of edit operations (follow-up turns). `mxgraph.ts` compiles
 * that into draw.io XML, which removes the whole class of malformed-XML bugs.
 *
 * The word "json" must appear in the prompts: DeepSeek's JSON output mode
 * requires it (`response_format: {type:'json_object'}`).
 */
import type { DiagramSpec } from '../drawio/types.js';

export const SCHEMA_DOC = `DiagramSpec JSON schema:
{
  "kind": "flowchart" | "architecture" | "mindmap" | "sequence" | "er" | "orgchart" | "uml" | "network" | "generic",
  "title": string,                       // short diagram title
  "layout": "layered" | "tree" | "radial" | "mindmap" | "grid" | "force" | "none",
  "direction": "TB" | "BT" | "LR" | "RL",// flow direction (layered/tree layouts)
  "theme": "nebula" | "blueprint" | "light",
  "nodes": [
    {
      "id": string,                      // REQUIRED, unique, short, [A-Za-z0-9_-]
      "label": string,                   // REQUIRED, <= 48 chars where possible
      "sublabel": string,                // optional small second line
      "shape": "rect"|"rounded"|"ellipse"|"diamond"|"hexagon"|"parallelogram"|"cylinder"|"cloud"|"document"|"note"|"actor"|"circle"|"process"|"terminator"|"card"|"step"|"trapezoid"|"triangle"|"star",
      "role": "start"|"end"|"process"|"decision"|"data"|"database"|"service"|"client"|"queue"|"external"|"note"|"group"|"default",
      "accent": "blue"|"cyan"|"violet"|"green"|"amber"|"rose"|"slate"|"none",
      "x": number, "y": number,          // OPTIONAL - omit to let the layout engine place it
      "width": number, "height": number, // OPTIONAL - omit for sensible defaults
      "parent": string                   // OPTIONAL - id of a container node
    }
  ],
  "edges": [
    {
      "id": string,                      // optional but recommended
      "source": string,                  // REQUIRED - must match a node id
      "target": string,                  // REQUIRED - must match a node id
      "label": string,
      "style": "orthogonal" | "straight" | "curved" | "entity",
      "arrow": "classic" | "open" | "block" | "none" | "diamond",
      "line": "solid" | "dashed" | "dotted",
      "accent": "blue"|"cyan"|"violet"|"green"|"amber"|"rose"|"slate",
      "animated": boolean
    }
  ]
}`;

export const OPERATIONS_DOC = `Edit operations JSON schema — an array of operations:
[
  { "op": "add_node",    "node": { "id": string, "label": string, ... } },
  { "op": "add_edge",    "edge": { "id": string, "source": string, "target": string, "label": string, ... } },
  { "op": "update_node", "id": string, "patch": { "label"?: string, "shape"?: string, "accent"?: string, "role"?: string } },
  { "op": "update_edge", "id": string, "patch": { "label"?: string, "style"?: string, "accent"?: string } },
  { "op": "remove_node", "id": string },
  { "op": "remove_edge", "id": string },
  { "op": "set_title",   "title": string },
  { "op": "replace_all", "spec": DiagramSpec }
]`;

const DESIGN_RULES = `Design rules (follow strictly):
1. NEVER set x/y coordinates. Omit them so the layout engine produces clean geometry. Only set them if the user explicitly asks to move something.
2. Keep labels short and concrete. No trailing punctuation. Wrap in nothing, no markdown.
3. Choose "role" for every node — it drives the colour palette and shape so the diagram looks designed rather than random.
4. Use "diamond" (or role "decision") for conditions, "cylinder"/"database" for stores, "cloud"/"external" for third-party systems, "terminator" for start/end, "note" for annotations.
5. Give edge labels to every branch out of a decision ("yes"/"no", "success"/"failure"), and to any connection whose meaning is not obvious.
6. Node ids must be stable, lowercase, and descriptive (e.g. "user", "api_gateway", "db_users"). Reuse existing ids when editing.
7. Model at the right altitude: 5-25 nodes for a flowchart, 6-25 for an architecture diagram. Do not pad with filler nodes.
8. Language: write labels in the SAME language the user wrote their request in (Chinese request -> Chinese labels).
9. Set "direction": "TB" for flowcharts, "LR" for pipelines/architecture, and "layout": "mindmap" for mind maps, "tree" for org charts, "radial" for network topologies.
10. Use "theme": "nebula" by default (dark tech look). Use "blueprint" only if the user asks for a light/print diagram.`;

export interface CreatePromptInput {
  request: string;
  kindHint?: string;
  /** Extra context, e.g. an attached document or previous feedback. */
  context?: string;
  /** Repair instruction after a failed validation round. */
  repair?: string;
}

export function buildCreatePrompt(input: CreatePromptInput): string {
  return [
    'You are a senior diagram architect. Turn the user request into a DiagramSpec JSON object.',
    '',
    SCHEMA_DOC,
    '',
    DESIGN_RULES,
    '',
    input.kindHint ? `The user indicated the diagram type: ${input.kindHint}` : '',
    input.context ? `Additional context:\n${input.context}` : '',
    input.repair ? `\nIMPORTANT — your previous attempt was rejected. Fix exactly this and return the full corrected json:\n${input.repair}` : '',
    '',
    'User request:',
    '"""',
    input.request.trim(),
    '"""',
    '',
    'Respond with a single JSON object of the form:',
    '{ "reply": "<one or two sentences to the user, in their language, describing what you drew>",',
    '  "spec": <DiagramSpec>,',
    '  "suggestions": ["<short follow-up the user might want>", "..."] }',
    'The response must be valid json. Do not include any text outside the JSON object.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export interface EditPromptInput {
  request: string;
  spec: DiagramSpec;
  summary: string;
  /** Recent conversation, oldest first. */
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  repair?: string;
}

export function buildEditPrompt(input: EditPromptInput): string {
  const history = input.history
    .slice(-6)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n');

  return [
    'You are a senior diagram architect editing an EXISTING diagram.',
    'Prefer the smallest possible change. Do NOT rebuild the diagram unless the user asks for a redesign.',
    '',
    SCHEMA_DOC,
    '',
    OPERATIONS_DOC,
    '',
    DESIGN_RULES,
    '',
    'Current diagram:',
    input.summary,
    '',
    history ? `Recent conversation:\n${history}` : '',
    input.repair ? `\nIMPORTANT — your previous attempt was rejected. Fix exactly this and return the full corrected json:\n${input.repair}` : '',
    '',
    'User request:',
    '"""',
    input.request.trim(),
    '"""',
    '',
    'Respond with a single JSON object:',
    '{ "reply": "<one or two sentences to the user, in their language, describing the change>",',
    '  "operations": [ ...edit operations... ],',
    '  "suggestions": ["<short follow-up>", "..."] }',
    'Use "replace_all" ONLY if the user explicitly asks to start over or change the diagram type completely.',
    'The response must be valid json. Do not include any text outside the JSON object.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export const SYSTEM_PROMPT = `You are AutoDrawFlowchart's diagram agent.
You design clear, professional flowcharts, architecture diagrams and mind maps.
You always answer with strict json matching the schema you are given.
You never invent node ids that are not in the schema, and never reference a node id that does not exist.`;

/** Cheap keyword classifier used to pick a layout when the model omits one. */
export function guessKind(request: string): string {
  const r = request.toLowerCase();
  const rules: Array<[RegExp, string]> = [
    [/思维导图|脑图|mind\s*map|思维图/, 'mindmap'],
    [/组织架构|组织架构图|org\s*chart|组织图|汇报关系/, 'orgchart'],
    [/架构图|系统架构|微服务|部署|architecture|topology|拓扑|infra/, 'architecture'],
    [/时序|顺序图|sequence/, 'sequence'],
    [/er\s*图|实体关系|数据库设计|表结构|er\s*diagram/, 'er'],
    [/网络|network|交换机|路由/, 'network'],
    [/uml|类图|class\s*diagram/, 'uml'],
    [/流程|步骤|flowchart|process|工作流|审批/, 'flowchart'],
  ];
  for (const [re, kind] of rules) if (re.test(r)) return kind;
  return 'flowchart';
}
