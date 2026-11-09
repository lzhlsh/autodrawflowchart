/**
 * Provider-compatibility tests.
 *
 * The app talks to ANY OpenAI-compatible chat-completions endpoint, not just
 * DeepSeek. These tests use a mock provider to prove the two things that make
 * that true:
 *
 *   1. field gating - `thinking` / `reasoning_effort` are DeepSeek-only and are
 *                     NOT sent to other hosts (they would 400 there)
 *   2. back-off     - if a provider rejects a field anyway, the client drops
 *                     just that field and retries, so it still succeeds
 *
 * Configuration is swapped through `applyRuntimeSettings()`, exactly like the
 * in-app settings panel does.
 *
 * Runs in-process: `node test/run.mjs`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

process.env.AI_API_KEY = 'test-key';
process.env.LOG_LEVEL = 'error';

// ---------------------------------------------------------------------------
// Mock OpenAI-compatible provider
// ---------------------------------------------------------------------------

/**
 * A minimal /v1/chat/completions endpoint.
 *
 * `reject` lists field names the fake provider refuses, mimicking how Groq and
 * others answer with 400 "Unrecognized request argument supplied: thinking".
 */
function startProvider({ reject = [], content = '{"reply":"ok","spec":{"nodes":[],"edges":[]}}' } = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* ignore */
      }
      calls.push({ url: req.url, body });

      const offending = reject.find((field) => field in body);
      if (offending) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              message: `Unrecognized request argument supplied: ${offending}`,
              type: 'invalid_request_error',
            },
          }),
        );
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          model: body.model ?? 'mock',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        calls,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// `config.js` is imported once: `applyRuntimeSettings()` mutates its module-level
// runtime object, which is the same object the client reads on every call.
const config = await import('../dist/config.js');

/**
 * A freshly-evaluated client module.
 *
 * `deepseek.js` caches its "am I in a browser?" answer at module-evaluation time
 * (the OpenAI SDK refuses to send requests while `window`/`document` exist). In
 * the `--all` test tier the DOM integration test installs those globals and only
 * removes them in its teardown, so a client imported at that moment would be
 * permanently poisoned. Re-importing re-evaluates the check against the globals
 * as they are now — which is what the real server always sees.
 *
 * The module reads the live config on every `complete()`, so a fresh instance
 * costs nothing but is important for correctness here.
 */
async function freshClient() {
  return import(`../dist/ai/deepseek.js?fresh=${Math.random()}`);
}

/** Point the app at `baseUrl`, exactly as the settings panel does. */
function useProvider(baseUrl, { thinking, model } = {}) {
  process.env.AI_BASE_URL = baseUrl;
  if (thinking === undefined) delete process.env.AI_THINKING;
  else process.env.AI_THINKING = thinking ? '1' : '0';

  config.applyRuntimeSettings({
    baseUrl,
    apiKey: 'test-key',
    ...(model ? { model } : {}),
  });
}

/** Let the OS release the previous ephemeral port before binding a new one. */
const settle = () => new Promise((r) => setTimeout(r, 20));

// ---------------------------------------------------------------------------

test('a non-DeepSeek endpoint is detected and never receives thinking fields', async () => {
  const provider = await startProvider();
  try {
    useProvider(provider.baseUrl);
    const { complete } = await freshClient();

    assert.equal(config.isDeepSeekEndpoint(provider.baseUrl), false, 'mock host is not DeepSeek');
    assert.equal(config.effectiveDeepSeek().thinking, false, 'thinking disabled for other hosts');

    const result = await complete({ system: 'sys', user: 'user', json: true });

    assert.ok(result.content.length > 0, 'request succeeded');
    assert.equal(provider.calls.length, 1, 'succeeded on the first try');
    const sent = provider.calls[0].body;
    assert.equal('thinking' in sent, false, 'thinking field withheld');
    assert.equal('reasoning_effort' in sent, false, 'reasoning_effort field withheld');
    assert.deepEqual(sent.response_format, { type: 'json_object' }, 'JSON mode still requested');
  } finally {
    await provider.close();
    await settle();
  }
});

test('a DeepSeek endpoint DOES receive thinking fields', async () => {
  const provider = await startProvider();
  try {
    useProvider(provider.baseUrl, { thinking: true });
    const { complete } = await freshClient();

    assert.equal(config.effectiveDeepSeek().thinking, true, 'thinking forced on');

    await complete({ system: 'sys', user: 'user', json: true });

    const sent = provider.calls[0].body;
    assert.deepEqual(sent.thinking, { type: 'enabled' }, 'thinking sent when enabled');
    assert.ok(sent.reasoning_effort, 'reasoning_effort sent when enabled');
  } finally {
    delete process.env.AI_THINKING;
    await provider.close();
    await settle();
  }
});

test('falls back when a provider rejects the thinking fields', async () => {
  // This is the safety net: even if detection says "send them", a provider that
  // refuses still gets served, because we drop the field and retry.
  const provider = await startProvider({ reject: ['thinking', 'reasoning_effort'] });
  try {
    useProvider(provider.baseUrl, { thinking: true }); // force them on anyway
    const { complete } = await freshClient();

    const result = await complete({ system: 'sys', user: 'user', json: true });
    assert.ok(result.content.length > 0, 'ultimately succeeded');

    assert.equal(provider.calls.length, 2, 'one rejection then one success');
    assert.ok('thinking' in provider.calls[0].body, 'first attempt included thinking');
    assert.equal('thinking' in provider.calls[1].body, false, 'retry dropped thinking');
    assert.equal('reasoning_effort' in provider.calls[1].body, false, 'retry dropped reasoning_effort');
  } finally {
    delete process.env.AI_THINKING;
    await provider.close();
    await settle();
  }
});

test('falls back when a provider does not implement JSON mode', async () => {
  const provider = await startProvider({ reject: ['response_format'], content: '{"reply":"text mode ok"}' });
  try {
    useProvider(provider.baseUrl, { thinking: false });
    const { complete } = await freshClient();

    const result = await complete({ system: 'sys', user: 'user', json: true });

    assert.match(result.content, /text mode ok/, 'content returned without JSON mode');
    assert.equal(provider.calls.length, 2, 'retried once');
    assert.ok('response_format' in provider.calls[0].body, 'first attempt used JSON mode');
    assert.equal('response_format' in provider.calls[1].body, false, 'retry dropped JSON mode');
  } finally {
    await provider.close();
    await settle();
  }
});

test('a provider rejecting both fields still succeeds after both back-offs', async () => {
  const provider = await startProvider({
    reject: ['thinking', 'reasoning_effort', 'response_format'],
    content: '{"reply":"bare mode"}',
  });
  try {
    useProvider(provider.baseUrl, { thinking: true });
    const { complete } = await freshClient();

    const result = await complete({ system: 'sys', user: 'user', json: true });

    assert.match(result.content, /bare mode/);
    assert.equal(provider.calls.length, 3, 'dropped one field per attempt');
    const last = provider.calls[provider.calls.length - 1].body;
    assert.equal('thinking' in last, false);
    assert.equal('reasoning_effort' in last, false);
    assert.equal('response_format' in last, false);
  } finally {
    delete process.env.AI_THINKING;
    await provider.close();
    await settle();
  }
});

test('the model id is taken from configuration, not hardcoded', async () => {
  const provider = await startProvider();
  try {
    useProvider(provider.baseUrl, {
      thinking: false,
      model: 'meta-llama/llama-3.3-70b-instruct:free',
    });
    const { complete } = await freshClient();

    await complete({ system: 'sys', user: 'user' });

    assert.equal(
      provider.calls[0].body.model,
      'meta-llama/llama-3.3-70b-instruct:free',
      'the configured model id was sent verbatim',
    );
  } finally {
    await provider.close();
    await settle();
  }
});

test('switching endpoints mid-session takes effect immediately', async () => {
  // Regression guard: the client used to keep using the first endpoint it saw,
  // which broke "paste a new base URL into settings and try again".
  const first = await startProvider();
  const second = await startProvider();
  try {
    useProvider(first.baseUrl, { thinking: false });
    const clientA = await freshClient();
    await clientA.complete({ system: 'sys', user: 'user' });
    assert.equal(first.calls.length, 1, 'first endpoint used');

    useProvider(second.baseUrl, { thinking: false });
    const clientB = await freshClient();
    await clientB.complete({ system: 'sys', user: 'user' });
    assert.equal(second.calls.length, 1, 'second endpoint used after switching');
    assert.equal(first.calls.length, 1, 'first endpoint not reused');
  } finally {
    await first.close();
    await second.close();
    await settle();
  }
});

test('a successful response carries model, usage and latency', async () => {
  const provider = await startProvider();
  try {
    useProvider(provider.baseUrl, { thinking: false, model: 'deepseek-flash' });
    const { complete } = await freshClient();

    const result = await complete({ system: 'sys', user: 'user' });

    assert.equal(result.model, 'deepseek-flash', 'model id reported back');
    assert.deepEqual(result.usage, { promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    assert.ok(result.latencyMs >= 0, 'latency measured');
  } finally {
    await provider.close();
    await settle();
  }
});
