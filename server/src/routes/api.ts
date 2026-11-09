/**
 * REST API.
 *
 * Design notes:
 *  - The server is the single source of truth for the diagram spec. The client
 *    sends a natural-language request; it gets back validated draw.io XML.
 *  - `GET /api/health` is the connectivity probe the frontend uses on boot, so
 *    the UI can show an accurate backend/editor/provider status.
 *  - Errors always come back as `{ error: { code, message } }` so the client can
 *    render them without guessing.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { plan } from '../ai/agent.js';
import { testConnection } from '../ai/deepseek.js';
import { publicSettings, applyRuntimeSettings, providerMode, effectiveDeepSeek, config } from '../config.js';
import { compileToXml, parseDrawioXml, assertWellFormed } from '../drawio/mxgraph.js';
import { validateSpec, applyOperations, summarizeSpec, emptySpec } from '../drawio/validate.js';
import { logger } from '../util/logger.js';
import {
  addMessage,
  applyPlan,
  createSession,
  deleteSession,
  ensureSession,
  getSession,
  listSessions,
  publicSession,
  recentHistory,
} from '../store/sessions.js';

const log = logger('api');
export const api = Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Wraps an async handler so rejections reach the error middleware. */
const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

function parseBody<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new ApiError(400, 'invalid_request', `请求参数无效 — ${detail}`);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ChartRequest = z.object({
  message: z.string().min(1, 'message is required').max(8000),
  sessionId: z.string().optional(),
  /** Force a brand-new diagram instead of an incremental edit. */
  regenerate: z.boolean().optional(),
});

const SettingsRequest = z.object({
  apiKey: z.string().max(400).optional(),
  baseUrl: z.string().url().max(400).optional(),
  model: z.string().max(120).optional(),
  offline: z.boolean().optional(),
});

const XmlRequest = z.object({
  xml: z.string().min(1),
  sessionId: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Health & settings
// ---------------------------------------------------------------------------

api.get('/health', (_req, res) => {
  const { mode, reason } = providerMode();
  res.json({
    ok: true,
    service: 'autodrawflowchart',
    version: '1.0.0',
    time: new Date().toISOString(),
    provider: mode,
    providerReason: reason,
    model: mode === 'deepseek' ? effectiveDeepSeek().model : 'offline-rules',
    editor: 'self-hosted draw.io',
    uptimeSec: Math.round(process.uptime()),
  });
});

api.get('/settings', (_req, res) => {
  res.json(publicSettings());
});

api.post('/settings', (req, res) => {
  const body = parseBody(SettingsRequest, req.body);
  applyRuntimeSettings({
    apiKey: body.apiKey,
    baseUrl: body.baseUrl,
    model: body.model,
    offline: body.offline,
  });
  log.info('runtime settings updated', { model: body.model, offline: body.offline, keyChanged: Boolean(body.apiKey) });
  res.json(publicSettings());
});

api.post(
  '/settings/test',
  wrap(async (_req, res) => {
    const { mode } = providerMode();
    if (mode === 'offline') {
      res.json({
        ok: false,
        mode: 'offline',
        message: '当前为离线模式，未配置 DeepSeek API Key。填写 Key 并保存后可测试在线连接。',
      });
      return;
    }
    res.json({ mode: 'deepseek', ...(await testConnection()) });
  }),
);

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

api.get('/sessions', (_req, res) => {
  res.json({ sessions: listSessions().map(publicSession) });
});

api.post('/sessions', (_req, res) => {
  res.status(201).json(publicSession(createSession()));
});

api.get('/sessions/:id', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) throw new ApiError(404, 'session_not_found', '会话不存在或已过期');
  res.json(publicSession(session));
});

api.delete('/sessions/:id', (req, res) => {
  const removed = deleteSession(req.params.id);
  if (!removed) throw new ApiError(404, 'session_not_found', '会话不存在');
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// The core endpoint: natural language -> diagram
// ---------------------------------------------------------------------------

api.post(
  '/chart',
  wrap(async (req, res) => {
    const body = parseBody(ChartRequest, req.body);
    const session = ensureSession(body.sessionId);
    const started = Date.now();

    log.info(`chart request (${body.message.length} chars)`, {
      session: session.id,
      editing: Boolean(session.spec),
      regenerate: body.regenerate,
    });

    const userMessage = addMessage(session, { role: 'user', content: body.message });

    const result = await plan({
      request: body.message,
      spec: session.spec,
      history: recentHistory(session, 6),
      forceCreate: body.regenerate === true,
    });

    applyPlan(session, result.plan, result.spec, result.compiled.xml);

    const assistant = addMessage(session, {
      role: 'assistant',
      content: result.plan.reply,
      provider: result.provider,
      model: result.model,
      latencyMs: result.latencyMs,
      suggestions: result.plan.suggestions,
      diagnostics: result.diagnostics.attempts > 1 || result.diagnostics.fallback ? result.diagnostics : undefined,
    });

    res.json({
      sessionId: session.id,
      revision: session.revision,
      xml: result.compiled.xml,
      spec: result.spec,
      summary: {
        title: result.spec.title,
        kind: result.spec.kind,
        nodes: result.compiled.nodeCount,
        edges: result.compiled.edgeCount,
        width: result.compiled.width,
        height: result.compiled.height,
      },
      reply: result.plan.reply,
      suggestions: result.plan.suggestions ?? [],
      provider: result.provider,
      providerReason: result.providerReason,
      model: result.model,
      latencyMs: Date.now() - started,
      warnings: [...new Set([...result.compiled.warnings, ...result.diagnostics.warnings])],
      diagnostics: result.diagnostics,
      messageId: assistant.id,
      userMessageId: userMessage.id,
    });
  }),
);

// ---------------------------------------------------------------------------
// Direct XML / spec access — used by the editor bridge and the tests
// ---------------------------------------------------------------------------

/** Compile an arbitrary spec (useful for programmatic use and E2E tests). */
api.post('/render', (req, res) => {
  const body = parseBody(z.object({ spec: z.unknown() }), req.body);
  const validation = validateSpec(body.spec);
  if (!validation.ok) {
    res.status(422).json({
      error: { code: 'invalid_spec', message: '图表数据校验失败' },
      issues: validation.issues,
    });
    return;
  }
  const compiled = compileToXml(body.spec as never);
  assertWellFormed(compiled.xml);
  res.json({ xml: compiled.xml, warnings: compiled.warnings, nodes: compiled.nodeCount, edges: compiled.edgeCount });
});

/** Round-trip draw.io XML back into a spec (the editor sent us user edits). */
api.post('/parse', (req, res) => {
  const body = parseBody(XmlRequest, req.body);
  assertWellFormed(body.xml);
  const parsed = parseDrawioXml(body.xml);
  res.json({
    spec: { ...emptySpec(), nodes: parsed.nodes, edges: parsed.edges, layout: 'none' },
    nodeCount: parsed.nodes.length,
    edgeCount: parsed.edges.length,
  });
});

/**
 * Accept the diagram as edited by the user in the draw.io canvas and make it the
 * session's source of truth, so the next AI turn edits what the user sees.
 */
api.put('/sessions/:id/diagram', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) throw new ApiError(404, 'session_not_found', '会话不存在或已过期');

  const body = parseBody(XmlRequest, req.body);
  assertWellFormed(body.xml);
  const parsed = parseDrawioXml(body.xml);

  session.spec = {
    kind: session.spec?.kind ?? 'flowchart',
    title: session.spec?.title ?? 'Untitled',
    theme: session.spec?.theme ?? 'nebula',
    layout: 'none',
    direction: session.spec?.direction ?? 'TB',
    nodes: parsed.nodes,
    edges: parsed.edges,
  };
  session.xml = body.xml;
  session.revision += 1;
  session.updatedAt = new Date().toISOString();

  log.info('diagram synced from editor', { session: session.id, nodes: parsed.nodes.length });

  res.json({
    ok: true,
    revision: session.revision,
    nodeCount: parsed.nodes.length,
    edgeCount: parsed.edges.length,
  });
});

api.get('/sessions/:id/spec', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) throw new ApiError(404, 'session_not_found', '会话不存在或已过期');
  res.json({
    spec: session.spec,
    summary: session.spec ? summarizeSpec(session.spec) : null,
    revision: session.revision,
  });
});

/** Apply explicit edit operations (no model call) — powers UI buttons. */
api.post('/sessions/:id/operations', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) throw new ApiError(404, 'session_not_found', '会话不存在或已过期');
  if (!session.spec) throw new ApiError(409, 'no_diagram', '当前会话还没有图表');

  const body = parseBody(z.object({ operations: z.array(z.unknown()) }), req.body);
  const result = applyOperations(session.spec, body.operations as never);
  session.spec = result.spec;
  session.revision += 1;
  session.updatedAt = new Date().toISOString();

  const compiled = compileToXml(result.spec);
  session.xml = compiled.xml;

  res.json({
    ok: true,
    revision: session.revision,
    applied: result.applied,
    skipped: result.skipped,
    xml: compiled.xml,
  });
});

// ---------------------------------------------------------------------------
// Demo / example prompts
// ---------------------------------------------------------------------------

api.get('/examples', (_req, res) => {
  res.json({
    examples: [
      { icon: '🔐', title: '用户登录流程', prompt: '画一个用户登录流程图：输入账号密码，校验格式，查询用户是否存在，验证密码是否正确，校验通过后生成令牌并返回，失败则提示错误信息并记录日志' },
      { icon: '🏗️', title: '微服务架构图', prompt: '画一个电商系统的微服务架构图，包含客户端、CDN、API网关、认证服务、商品服务、订单服务、支付服务、Redis缓存、MySQL数据库和Kafka消息队列' },
      { icon: '🧠', title: '产品思维导图', prompt: '用思维导图梳理一个 SaaS 产品的规划：包含目标用户、核心功能、技术架构、商业模式、增长策略、关键指标' },
      { icon: '👥', title: '组织架构图', prompt: '画一个公司组织架构图，CEO 下面有研发部、产品部、市场部、运营部、财务部' },
      { icon: '🗄️', title: '数据库 ER 图', prompt: '画一个电商系统的 ER 图，包含用户、订单、订单明细、商品、支付记录几个实体及其关系' },
      { icon: '🌐', title: '网络拓扑图', prompt: '画一个企业网络拓扑图：互联网接入、防火墙、负载均衡、两台应用服务器和一台数据库服务器' },
      { icon: '⚙️', title: 'CI/CD 流水线', prompt: '画一个 CI/CD 流水线流程图：代码提交，触发构建，运行单元测试，代码扫描，构建镜像，推送到镜像仓库，部署到测试环境，人工审批，部署到生产环境' },
      { icon: '🎫', title: '客服工单流程', prompt: '画一个客服工单处理流程：客户提交工单，系统自动分类，判断是否紧急，紧急工单立即分配工程师，普通工单排队等待，工程师处理并回复，客户确认后关闭工单' },
    ],
  });
});

/** Exposed for the config banner in the UI. */
api.get('/runtime', (_req, res) => {
  res.json({
    provider: providerMode(),
    settings: publicSettings(),
    limits: { maxTokens: effectiveDeepSeek().maxTokens, timeoutMs: effectiveDeepSeek().timeoutMs },
    dataDir: config.dataDir,
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

api.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  const status = (err as { status?: number })?.status ?? 500;
  log.error('unhandled API error', err);
  res.status(status >= 400 && status < 600 ? status : 500).json({
    error: { code: 'internal_error', message },
  });
});
