/**
 * In-memory session store.
 *
 * Each browser session owns a conversation plus the current diagram. This is
 * deliberately process-local (no database) — the product is a single-user
 * workspace — but the interface is async so a persistent backend can be dropped
 * in without touching the routes.
 */
import { randomUUID } from 'node:crypto';
import type { AgentPlan, DiagramSpec } from '../drawio/types.js';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  /** Which engine produced an assistant message. */
  provider?: 'deepseek' | 'offline';
  model?: string;
  latencyMs?: number;
  suggestions?: string[];
  /** Validation trail, when the turn needed repairs. */
  diagnostics?: unknown;
}

export interface Session {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Current diagram spec (source of truth for edits). */
  spec: DiagramSpec | null;
  /** Latest compiled draw.io XML. */
  xml: string;
  messages: ChatMessage[];
  /** Stable id so the editor treats reloads as the same page. */
  diagramId: string;
  revision: number;
}

const MAX_MESSAGES = 120;
const sessions = new Map<string, Session>();

export function createSession(): Session {
  const id = randomUUID();
  const now = new Date().toISOString();
  const session: Session = {
    id,
    title: '未命名图表',
    createdAt: now,
    updatedAt: now,
    spec: null,
    xml: '',
    messages: [],
    diagramId: `adf-${id.slice(0, 8)}`,
    revision: 0,
  };
  sessions.set(id, session);
  return session;
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function ensureSession(id: string | undefined): Session {
  if (id) {
    const found = sessions.get(id);
    if (found) return found;
  }
  return createSession();
}

export function listSessions(): Session[] {
  return [...sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function deleteSession(id: string): boolean {
  return sessions.delete(id);
}

export function addMessage(session: Session, message: Omit<ChatMessage, 'id' | 'createdAt'>): ChatMessage {
  const full: ChatMessage = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    ...message,
  };
  session.messages.push(full);
  if (session.messages.length > MAX_MESSAGES) {
    session.messages.splice(0, session.messages.length - MAX_MESSAGES);
  }
  session.updatedAt = full.createdAt;
  return full;
}

export function applyPlan(session: Session, plan: AgentPlan, spec: DiagramSpec, xml: string): void {
  session.spec = spec;
  session.xml = xml;
  session.revision += 1;
  session.updatedAt = new Date().toISOString();
  if (spec.title && (session.title === '未命名图表' || session.messages.length <= 2)) {
    session.title = spec.title;
  }
}

/** Recent turns, oldest first, for prompt context. */
export function recentHistory(session: Session, limit = 6): Array<{ role: 'user' | 'assistant'; content: string }> {
  return session.messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-limit)
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
}

/** Public shape sent to the client (drops nothing sensitive today, but keeps a seam). */
export function publicSession(session: Session) {
  return {
    id: session.id,
    title: session.title,
    diagramId: session.diagramId,
    revision: session.revision,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    hasDiagram: Boolean(session.spec && (session.spec.nodes?.length ?? 0) > 0),
    nodeCount: session.spec?.nodes?.length ?? 0,
    edgeCount: session.spec?.edges?.length ?? 0,
    kind: session.spec?.kind ?? null,
    xml: session.xml,
    messages: session.messages,
  };
}
