import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Header } from './components/Header';
import { StatusBar } from './components/StatusBar';
import { EditorPane } from './components/EditorPane';
import { AgentPanel } from './components/AgentPanel';
import { SettingsModal } from './components/SettingsModal';
import { Toasts } from './components/Toasts';
import { api, ApiError, type ChatMessage, type ExamplePrompt, type PublicSettings } from './lib/api';
import type { DrawioBridge } from './lib/drawio';
import { useToasts } from './lib/hooks';

/** Simple, clearly-labelled workflow presets offered on first run. */
const FALLBACK_EXAMPLES: ExamplePrompt[] = [
  { icon: '🔐', title: '用户登录流程', prompt: '画一个用户登录流程图：输入账号密码，校验格式，查询用户是否存在，验证密码是否正确，校验通过后生成令牌并返回，失败则提示错误信息并记录日志' },
  { icon: '🏗️', title: '微服务架构图', prompt: '画一个电商系统的微服务架构图，包含客户端、CDN、API网关、认证服务、商品服务、订单服务、支付服务、Redis缓存、MySQL数据库和Kafka消息队列' },
  { icon: '🧠', title: '产品思维导图', prompt: '用思维导图梳理一个 SaaS 产品的规划：包含目标用户、核心功能、技术架构、商业模式、增长策略、关键指标' },
  { icon: '⚙️', title: 'CI/CD 流水线', prompt: '画一个 CI/CD 流水线流程图：代码提交，触发构建，运行单元测试，代码扫描，构建镜像，推送到镜像仓库，部署到测试环境，人工审批，部署到生产环境' },
];

const MIN_PANEL = 340;
const MAX_PANEL = 760;

export function App() {
  // --- data ---------------------------------------------------------------
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [backendOnline, setBackendOnline] = useState(false);
  const [examples, setExamples] = useState<ExamplePrompt[]>(FALLBACK_EXAMPLES);
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  // --- diagram ------------------------------------------------------------
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [xml, setXml] = useState('');
  const [title, setTitle] = useState('');
  const [nodeCount, setNodeCount] = useState(0);
  const [edgeCount, setEdgeCount] = useState(0);
  const [diagramSize, setDiagramSize] = useState<{ width: number; height: number } | null>(null);

  // --- ui -----------------------------------------------------------------
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [panelWidth, setPanelWidth] = useState(400);
  const [dragging, setDragging] = useState(false);
  const [lastLatency, setLastLatency] = useState<number | null>(null);

  const { toasts, push, dismiss } = useToasts();
  const bridgeRef = useRef<DrawioBridge | null>(null);
  /** The XML the canvas is currently showing — used to detect genuine user edits. */
  const expectedXml = useRef('');
  /** Guards against overlapping AI requests. */
  const inFlight = useRef(false);

  // -------------------------------------------------------------------------
  // Boot: check the backend and load settings + examples
  // -------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const [health, current, exampleList] = await Promise.all([
          api.health(),
          api.getSettings(),
          api.examples(),
        ]);
        if (cancelled) return;
        setBackendOnline(health.ok);
        setSettings(current);
        if (exampleList.examples.length > 0) setExamples(exampleList.examples);

        if (current.provider === 'offline') {
          push('info', '后端已连接。未配置 DeepSeek API Key，当前使用内置规则引擎。');
        } else {
          push('success', `后端已连接 · 模型 ${current.model}`);
        }
      } catch (err) {
        if (cancelled) return;
        setBackendOnline(false);
        setError(
          `无法连接后端服务（${err instanceof ApiError ? err.message : String(err)}）。请确认已运行 npm run dev:server。`,
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [push]);

  // -------------------------------------------------------------------------
  // Splitter drag
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const next = window.innerWidth - e.clientX;
      setPanelWidth(Math.min(MAX_PANEL, Math.max(MIN_PANEL, next)));
    };
    const onUp = () => setDragging(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    // Prevent the iframe from swallowing mousemove during the drag.
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [dragging]);

  // -------------------------------------------------------------------------
  // Core: ask the agent for a diagram
  // -------------------------------------------------------------------------
  const send = useCallback(
    async (rawMessage: string, options: { regenerate?: boolean } = {}) => {
      const message = rawMessage.trim();
      if (!message || inFlight.current) return;

      inFlight.current = true;
      setBusy(true);
      setThinking(true);
      setError(null);

      // Optimistic user bubble so the panel reacts instantly.
      const optimisticId = `local-${Date.now()}`;
      setMessages((prev) => [
        ...prev,
        { id: optimisticId, role: 'user', content: message, createdAt: new Date().toISOString() },
      ]);
      setInput('');

      try {
        const res = await api.chart({
          message,
          sessionId: sessionId ?? undefined,
          regenerate: options.regenerate,
        });

        setSessionId(res.sessionId);
        setLastLatency(res.latencyMs);

        // Load the new diagram into the canvas (this is what makes it "live").
        expectedXml.current = res.xml;
        setXml(res.xml);
        setTitle(res.summary.title);
        setNodeCount(res.summary.nodes);
        setEdgeCount(res.summary.edges);
        setDiagramSize({ width: res.summary.width, height: res.summary.height });

        setMessages((prev) => [
          ...prev,
          {
            id: res.messageId,
            role: 'assistant',
            content: res.reply,
            createdAt: new Date().toISOString(),
            provider: res.provider,
            model: res.model,
            latencyMs: res.latencyMs,
            suggestions: res.suggestions,
            diagnostics: res.diagnostics,
          },
        ]);

        if (res.diagnostics.fallback) {
          push('warning', 'DeepSeek 调用失败，已降级为内置规则引擎生成。');
        } else if (res.warnings.length > 0) {
          push('warning', `已生成，但有 ${res.warnings.length} 条提示：${res.warnings[0]}`);
        } else {
          push('success', `已生成图表 · ${res.summary.nodes} 节点 / ${res.summary.edges} 连线`);
        }
      } catch (err) {
        const text = err instanceof ApiError ? err.message : String(err);
        setError(text);
        push('error', `生成失败：${text}`);
      } finally {
        inFlight.current = false;
        setBusy(false);
        setThinking(false);
      }
    },
    [sessionId, push],
  );

  const handleSend = useCallback(() => {
    void send(input);
  }, [input, send]);

  const handleRegenerate = useCallback(() => {
    const firstUser = messages.find((m) => m.role === 'user');
    if (!firstUser) {
      push('warning', '还没有可用的描述，请先输入一句需求。');
      return;
    }
    void send(firstUser.content, { regenerate: true });
  }, [messages, send, push]);

  const handlePickExample = useCallback(
    (prompt: string) => {
      setInput(prompt);
      void send(prompt);
    },
    [send],
  );

  // -------------------------------------------------------------------------
  // Canvas -> server sync (so the next AI turn edits what the user sees)
  // -------------------------------------------------------------------------
  const handleUserEdit = useCallback(
    (nextXml: string) => {
      if (!sessionId) return;
      if (nextXml === expectedXml.current) return;
      expectedXml.current = nextXml;
      setXml(nextXml);
      setSyncing(true);

      api
        .syncDiagram(sessionId, nextXml)
        .then((res) => {
          setNodeCount(res.nodeCount);
          setEdgeCount(res.edgeCount);
        })
        .catch(() => {
          // A failed sync only means the next turn starts from the previous
          // state; it is not worth interrupting the user.
        })
        .finally(() => setSyncing(false));
    },
    [sessionId],
  );

  // -------------------------------------------------------------------------
  // Header actions
  // -------------------------------------------------------------------------
  const handleReset = useCallback(() => {
    setSessionId(null);
    setMessages([]);
    setXml('');
    setTitle('');
    setNodeCount(0);
    setEdgeCount(0);
    setDiagramSize(null);
    setError(null);
    setLastLatency(null);
    expectedXml.current = '';
    push('info', '已开始新图表');
  }, [push]);

  const handleTitleChange = useCallback((next: string) => {
    setTitle(next);
    // Title is cosmetic for now; the spec keeps its own title on next AI turn.
  }, []);

  const download = useCallback((dataUri: string, filename: string) => {
    const link = document.createElement('a');
    link.href = dataUri;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }, []);

  const safeName = useMemo(() => {
    const base = (title || 'diagram').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60);
    return base || 'diagram';
  }, [title]);

  const handleExportPng = useCallback(async () => {
    const bridge = bridgeRef.current;
    if (!bridge) return;
    try {
      const result = await bridge.exportAs('png', { scale: 2 });
      if (result.data) {
        download(result.data, `${safeName}.png`);
        push('success', 'PNG 已下载');
      } else {
        push('warning', '导出未返回图片数据');
      }
    } catch (err) {
      push('error', `导出 PNG 失败：${(err as Error).message}`);
    }
  }, [download, push, safeName]);

  const handleExportXml = useCallback(async () => {
    const bridge = bridgeRef.current;
    try {
      // Prefer the live canvas content so manual edits are included.
      const live = bridge ? await bridge.requestXml().catch(() => '') : '';
      const content = live || xml;
      if (!content) {
        push('warning', '当前没有可导出的图表');
        return;
      }
      download(`data:application/xml;charset=utf-8,${encodeURIComponent(content)}`, `${safeName}.drawio.xml`);
      push('success', 'draw.io XML 已下载');
    } catch (err) {
      push('error', `导出失败：${(err as Error).message}`);
    }
  }, [download, push, safeName, xml]);

  const handleBridgeReady = useCallback((bridge: DrawioBridge | null) => {
    bridgeRef.current = bridge;
  }, []);

  const handleEditorError = useCallback(
    (message: string) => {
      push('error', `编辑器：${message}`);
    },
    [push],
  );

  return (
    <div className="app">
      <div className="app__grid-overlay" aria-hidden="true" />

      {/*
        Machine-readable state for end-to-end tests. Kept out of the UI layer so
        tests never have to scrape visual text to know what happened.
      */}
      <div
        data-testid="app-state"
        data-backend-online={backendOnline ? '1' : '0'}
        data-editor-ready={editorReady ? '1' : '0'}
        data-provider={settings?.provider ?? 'unknown'}
        data-session-id={sessionId ?? ''}
        data-has-diagram={xml ? '1' : '0'}
        data-node-count={nodeCount}
        data-edge-count={edgeCount}
        data-busy={busy ? '1' : '0'}
        data-xml-length={xml.length}
        hidden
      />

      <Header
        title={title}
        onTitleChange={handleTitleChange}
        settings={settings}
        backendOnline={backendOnline}
        nodeCount={nodeCount}
        edgeCount={edgeCount}
        busy={busy}
        hasDiagram={Boolean(xml)}
        onOpenSettings={() => setSettingsOpen(true)}
        onExportPng={handleExportPng}
        onExportXml={handleExportXml}
        onReset={handleReset}
        onRegenerate={handleRegenerate}
      />

      <div className="app__body">
        <div className="workspace">
          <EditorPane
            xml={xml}
            onUserEdit={handleUserEdit}
            onReadyChange={setEditorReady}
            onError={handleEditorError}
            onBridgeReady={handleBridgeReady}
            busy={busy}
            busyLabel="正在生成图表…"
            examples={examples}
            onPickExample={handlePickExample}
            locale="zh"
          />

          <div
            className={`workspace__splitter ${dragging ? 'workspace__splitter--dragging' : ''}`}
            role="separator"
            aria-orientation="vertical"
            aria-label="调整面板宽度"
            onMouseDown={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDoubleClick={() => setPanelWidth(400)}
          />

          <div className="workspace__panel" style={{ width: panelWidth, flex: `0 0 ${panelWidth}px` }}>
            <AgentPanel
              messages={messages}
              thinking={thinking}
              busy={busy}
              input={input}
              onInputChange={setInput}
              onSend={handleSend}
              onSuggestion={(text) => void send(text)}
              onRegenerate={handleRegenerate}
              settings={settings}
              examples={examples}
              onPickExample={handlePickExample}
              xml={xml}
              error={error}
              onDismissError={() => setError(null)}
              hasDiagram={Boolean(xml)}
            />
          </div>
        </div>
      </div>

      <StatusBar
        backendOnline={backendOnline}
        editorReady={editorReady}
        settings={settings}
        nodeCount={nodeCount}
        edgeCount={edgeCount}
        diagramSize={diagramSize}
        lastLatencyMs={lastLatency}
        syncing={syncing}
      />

      <SettingsModal
        open={settingsOpen}
        settings={settings}
        onClose={() => setSettingsOpen(false)}
        onSaved={(next) => {
          setSettings(next);
          push(
            next.provider === 'deepseek' ? 'success' : 'info',
            next.provider === 'deepseek'
              ? `已切换到 DeepSeek · ${next.model}`
              : '已切换为内置规则引擎',
          );
        }}
      />

      <Toasts toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
