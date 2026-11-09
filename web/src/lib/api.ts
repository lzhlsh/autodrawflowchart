/**
 * Typed API client.
 *
 * Every network call in the UI goes through here so error shapes and types stay
 * consistent. Requests are same-origin (`/api/...`) and proxied by Vite in dev.
 */

export type Provider = 'deepseek' | 'offline';

export interface HealthResponse {
  ok: boolean;
  service: string;
  version: string;
  time: string;
  provider: Provider;
  providerReason: string;
  model: string;
  editor: string;
  uptimeSec: number;
}

export interface PublicSettings {
  provider: Provider;
  providerReason: string;
  model: string;
  baseUrl: string;
  hasApiKey: boolean;
  apiKeySource: 'settings' | 'env' | 'none';
  offlineForced: boolean | null;
  envOffline: boolean;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  provider?: Provider;
  model?: string;
  latencyMs?: number;
  suggestions?: string[];
  diagnostics?: unknown;
}

export interface DiagramSummary {
  title: string;
  kind: string | null;
  nodes: number;
  edges: number;
  width: number;
  height: number;
}

export interface ChartResponse {
  sessionId: string;
  revision: number;
  xml: string;
  spec: unknown;
  summary: DiagramSummary;
  reply: string;
  suggestions: string[];
  provider: Provider;
  providerReason: string;
  model: string;
  latencyMs: number;
  warnings: string[];
  diagnostics: {
    attempts: number;
    repairs: string[];
    warnings: string[];
    droppedOperations: Array<{ reason: string }>;
    fallback?: string;
  };
  messageId: string;
  userMessageId: string;
}

export interface SessionResponse {
  id: string;
  title: string;
  diagramId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  hasDiagram: boolean;
  nodeCount: number;
  edgeCount: number;
  kind: string | null;
  xml: string;
  messages: ChatMessage[];
}

export interface ExamplePrompt {
  icon: string;
  title: string;
  prompt: string;
}

export interface TestConnectionResult {
  mode: Provider;
  ok?: boolean;
  model?: string;
  latencyMs?: number;
  message: string;
}

/** Thrown for any non-2xx response, carrying the server's error code. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (err) {
    // Network-level failure — most likely the API server is not running.
    throw new ApiError(0, 'network_error', `无法连接后端服务：${(err as Error).message}`);
  }

  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
  }

  if (!res.ok) {
    const envelope = (body ?? {}) as { error?: { code?: string; message?: string } };
    throw new ApiError(
      res.status,
      envelope.error?.code ?? `http_${res.status}`,
      envelope.error?.message ?? `请求失败 (HTTP ${res.status})`,
    );
  }
  return body as T;
}

// ---------------------------------------------------------------------------

export const api = {
  health: () => request<HealthResponse>('/api/health'),

  getSettings: () => request<PublicSettings>('/api/settings'),

  updateSettings: (patch: { apiKey?: string; baseUrl?: string; model?: string; offline?: boolean }) =>
    request<PublicSettings>('/api/settings', { method: 'POST', body: JSON.stringify(patch) }),

  testConnection: () => request<TestConnectionResult>('/api/settings/test', { method: 'POST', body: '{}' }),

  examples: () => request<{ examples: ExamplePrompt[] }>('/api/examples'),

  /** The core call: natural language in, draw.io XML out. */
  chart: (payload: { message: string; sessionId?: string; regenerate?: boolean }) =>
    request<ChartResponse>('/api/chart', { method: 'POST', body: JSON.stringify(payload) }),

  createSession: () => request<SessionResponse>('/api/sessions', { method: 'POST', body: '{}' }),

  getSession: (id: string) => request<SessionResponse>(`/api/sessions/${id}`),

  listSessions: () => request<{ sessions: SessionResponse[] }>('/api/sessions'),

  deleteSession: (id: string) => request<{ ok: boolean }>(`/api/sessions/${id}`, { method: 'DELETE' }),

  /** Push canvas edits back so the next AI turn edits what the user sees. */
  syncDiagram: (sessionId: string, xml: string) =>
    request<{ ok: boolean; revision: number; nodeCount: number; edgeCount: number }>(
      `/api/sessions/${sessionId}/diagram`,
      { method: 'PUT', body: JSON.stringify({ xml }) },
    ),

  getSpec: (sessionId: string) =>
    request<{ spec: unknown; summary: string | null; revision: number }>(`/api/sessions/${sessionId}/spec`),
};
