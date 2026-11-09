/**
 * Runtime configuration.
 *
 * The API key can come from the environment (.env) or, at runtime, from the
 * in-app settings panel. The panel path exists so the app is fully usable
 * without ever writing a secret to disk.
 */
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** server/src -> server -> repo root */
export const REPO_ROOT = path.resolve(HERE, '..', '..');

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Resolve a setting from environment variables.
 *
 * Provider-neutral names (`AI_*`) win, and the original DeepSeek-specific names
 * are kept as aliases so existing `.env` files keep working. New users pointing
 * at Groq/OpenRouter/etc. should not have to write `DEEPSEEK_BASE_URL`.
 */
function env(neutral: string, legacy: string): string | undefined {
  return process.env[neutral] ?? process.env[legacy];
}

/**
 * Is this endpoint DeepSeek itself?
 *
 * Only DeepSeek understands the `thinking` / `reasoning_effort` request fields;
 * other OpenAI-compatible providers reject unknown parameters, so we must not
 * send them. Detection is by hostname so a self-hosted proxy in front of
 * DeepSeek still gets the feature.
 */
export function isDeepSeekEndpoint(baseUrl: string): boolean {
  try {
    return /(^|\.)deepseek\.com$/i.test(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

/** Whether the current endpoint should receive DeepSeek-only request fields. */
export function supportsThinkingFields(baseUrl: string): boolean {
  // Explicit override: AI_THINKING=1 forces them on, AI_THINKING=0 forces off.
  const explicit = env('AI_THINKING', 'DEEPSEEK_THINKING');
  if (explicit === '1') return true;
  if (explicit === '0') return false;
  return isDeepSeekEndpoint(baseUrl);
}

export interface AppConfig {
  port: number;
  host: string;
  /** Connection to any OpenAI-compatible chat-completions endpoint. */
  deepseek: {
    apiKey: string;
    baseUrl: string;
    model: string;
    /** Sent as `reasoning_effort` when thinking is enabled. */
    reasoningEffort: 'low' | 'medium' | 'high';
    thinking: boolean;
    maxTokens: number;
    temperature: number;
    timeoutMs: number;
  };
  /** Hard switch that forces the deterministic offline engine. */
  forceOffline: boolean;
  /** Serve the built web app from the server in production. */
  serveStatic: boolean;
  webDistDir: string;
  /** Where conversation/session state lives. */
  dataDir: string;
  corsOrigins: string[] | true;
}

export const config: AppConfig = {
  port: num(env('AI_PORT', 'PORT'), 5174),
  host: env('AI_HOST', 'HOST') ?? '127.0.0.1',
  deepseek: {
    apiKey: env('AI_API_KEY', 'DEEPSEEK_API_KEY') ?? '',
    baseUrl: env('AI_BASE_URL', 'DEEPSEEK_BASE_URL') ?? 'https://api.deepseek.com',
    // Default is DeepSeek V4.1 Flash, served under the `deepseek-flash` id.
    // Point AI_BASE_URL elsewhere and set AI_MODEL to the provider's model id.
    model: env('AI_MODEL', 'DEEPSEEK_MODEL') ?? 'deepseek-flash',
    reasoningEffort:
      (env('AI_REASONING_EFFORT', 'DEEPSEEK_REASONING_EFFORT') as 'low' | 'medium' | 'high') ?? 'medium',
    // Resolved per-request against the effective base URL (see supportsThinkingFields).
    thinking: true,
    maxTokens: num(env('AI_MAX_TOKENS', 'DEEPSEEK_MAX_TOKENS'), 8192),
    temperature: Number(env('AI_TEMPERATURE', 'DEEPSEEK_TEMPERATURE') ?? 0.3),
    timeoutMs: num(env('AI_TIMEOUT_MS', 'DEEPSEEK_TIMEOUT_MS'), 180_000),
  },
  forceOffline: process.env.AI_OFFLINE === '1',
  serveStatic: process.env.SERVE_STATIC !== '0',
  webDistDir: process.env.WEB_DIST_DIR ?? path.join(REPO_ROOT, 'web', 'dist'),
  dataDir: process.env.DATA_DIR ?? path.join(REPO_ROOT, 'server', '.data'),
  corsOrigins: process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
    : true,
};

/** Runtime-overridable settings (the in-app panel writes here, never to disk). */
export interface RuntimeSettings {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  offline?: boolean;
}

const runtime: RuntimeSettings = {};

export function applyRuntimeSettings(next: RuntimeSettings): void {
  if (next.apiKey !== undefined) runtime.apiKey = next.apiKey.trim();
  if (next.baseUrl !== undefined) runtime.baseUrl = next.baseUrl.trim();
  if (next.model !== undefined) runtime.model = next.model.trim();
  if (next.offline !== undefined) runtime.offline = next.offline;
}

/** Effective LLM connection, honouring runtime overrides. */
export function effectiveDeepSeek(): AppConfig['deepseek'] {
  const baseUrl = (runtime.baseUrl ?? config.deepseek.baseUrl).replace(/\/+$/, '');
  return {
    ...config.deepseek,
    apiKey: runtime.apiKey ?? config.deepseek.apiKey,
    baseUrl,
    model: runtime.model ?? config.deepseek.model,
    // Resolved against the *effective* URL, so switching the base URL in the
    // settings panel immediately stops sending DeepSeek-only request fields.
    thinking: supportsThinkingFields(baseUrl),
  };
}

/**
 * Which engine handles the next request.
 *
 * Named `deepseek` for backwards compatibility, but it really means "remote
 * OpenAI-compatible endpoint" — it is set whenever an API key exists.
 */
export type ProviderMode = 'deepseek' | 'offline';

/** Which engine will handle the next request, and why. */
export function providerMode(): { mode: ProviderMode; reason: string } {
  if (runtime.offline === true) return { mode: 'offline', reason: 'settings:offline' };
  if (runtime.offline === false) return { mode: 'deepseek', reason: 'settings:online' };
  if (config.forceOffline) return { mode: 'offline', reason: 'env:AI_OFFLINE=1' };
  if (!effectiveDeepSeek().apiKey) return { mode: 'offline', reason: 'no-api-key' };
  return { mode: 'deepseek', reason: 'api-key-present' };
}

/** Never leak the key itself, only whether one exists. */
export function publicSettings() {
  const ds = effectiveDeepSeek();
  const { mode, reason } = providerMode();
  return {
    provider: mode,
    providerReason: reason,
    model: ds.model,
    baseUrl: ds.baseUrl,
    hasApiKey: Boolean(ds.apiKey),
    apiKeySource: runtime.apiKey ? 'settings' : ds.apiKey ? 'env' : 'none',
    offlineForced: runtime.offline ?? null,
    envOffline: config.forceOffline,
    /** True when the endpoint is DeepSeek itself (thinking fields enabled). */
    isDeepSeek: isDeepSeekEndpoint(ds.baseUrl),
    thinkingEnabled: ds.thinking,
  };
}
