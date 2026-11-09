import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DrawioBridge, editorUrl } from '../lib/drawio';
import type { ExamplePrompt } from '../lib/api';
import { IconFit, IconGrid, IconRefresh, IconSparkles } from './Icons';

interface EditorPaneProps {
  /** Draw.io XML to display. Changing this reloads the editor. */
  xml: string;
  /** Called when the user edits the canvas (debounced by the editor). */
  onUserEdit: (xml: string) => void;
  onReadyChange: (ready: boolean) => void;
  onError: (message: string) => void;
  /** Expose the bridge so the App can drive export/zoom from the header. */
  onBridgeReady: (bridge: DrawioBridge | null) => void;
  busy: boolean;
  busyLabel: string;
  examples: ExamplePrompt[];
  onPickExample: (prompt: string) => void;
  locale: 'zh' | 'en';
}

export function EditorPane({
  xml,
  onUserEdit,
  onReadyChange,
  onError,
  onBridgeReady,
  busy,
  busyLabel,
  examples,
  onPickExample,
  locale,
}: EditorPaneProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [bridge, setBridge] = useState<DrawioBridge | null>(null);
  const [ready, setReady] = useState(false);
  /** The XML currently shown in the editor; used to avoid redundant reloads. */
  const shownXml = useRef<string>('');

  // Keep the latest callbacks in refs so the bridge is created only once.
  const onUserEditRef = useRef(onUserEdit);
  const onErrorRef = useRef(onError);
  onUserEditRef.current = onUserEdit;
  onErrorRef.current = onError;

  const url = useMemo(() => editorUrl({ language: locale }), [locale]);

  // --- create the bridge once -------------------------------------------
  useEffect(() => {
    const b = new DrawioBridge({
      onReady: () => {
        setReady(true);
        onReadyChange(true);
      },
      onAutosave: (next) => {
        // Ignore echoes of our own programmatic loads.
        if (next === shownXml.current) return;
        shownXml.current = next;
        onUserEditRef.current(next);
      },
      onError: (message) => onErrorRef.current(message),
    });
    b.attach();
    setBridge(b);
    onBridgeReady(b);
    return () => {
      b.dispose();
      onBridgeReady(null);
      setReady(false);
      onReadyChange(false);
    };
    // Intentionally run once; callbacks are proxied through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- hand the frame to the bridge -------------------------------------
  useEffect(() => {
    if (bridge && frameRef.current) bridge.setFrame(frameRef.current);
  }, [bridge]);

  // --- (re)load content when XML changes --------------------------------
  useEffect(() => {
    if (!bridge || !ready) return;
    if (!xml || xml === shownXml.current) return;
    shownXml.current = xml;
    let cancelled = false;
    bridge.load(xml, { title: 'AutoDrawFlowchart' }).catch((err: unknown) => {
      if (cancelled) return;
      onErrorRef.current(`编辑器载入图表失败：${(err as Error).message}`);
    });
    return () => {
      cancelled = true;
    };
  }, [bridge, ready, xml]);

  // --- canvas helpers ---------------------------------------------------
  // Note: the embed protocol has no "zoom" action, so the toolbar exposes
  // fit/reload rather than fake zoom buttons that would do nothing.
  const refit = useCallback(() => {
    bridge?.fit();
  }, [bridge]);

  const reload = useCallback(() => {
    if (!bridge || !shownXml.current) return;
    const current = shownXml.current;
    shownXml.current = '';
    bridge
      .load(current, { title: 'AutoDrawFlowchart' })
      .then(() => bridge.status('视图已重新布局', false))
      .catch((err: unknown) => onErrorRef.current(`重新载入失败：${(err as Error).message}`));
  }, [bridge, onErrorRef]);

  const hasDiagram = Boolean(xml);

  return (
    <section className="workspace__editor" aria-label="图表编辑器">
      <div className="editor">
        <iframe
          ref={frameRef}
          className="editor__frame"
          src={url}
          title="draw.io 图表编辑器"
          // The editor uses postMessage for cross-document navigation intent.
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-modals allow-downloads"
          allow="clipboard-read; clipboard-write"
        />

        {/* First-load blur while draw.io boots and receives the diagram. */}
        <div className={`editor__overlay ${ready && !busy ? 'editor__overlay--hidden' : ''}`}>
          <div className="loading">
            <div className="spinner" />
            <span>{ready ? busyLabel : '正在加载 draw.io 编辑器…'}</span>
            {!ready && (
              <span style={{ fontSize: 11, color: 'var(--text-disabled)', maxWidth: 300, textAlign: 'center' }}>
                首次加载需要解析约 140 MB 图形库资源
              </span>
            )}
          </div>
        </div>

        {/* Onboarding when there is nothing to show yet. */}
        {!hasDiagram && ready && !busy && (
          <div className="editor__empty">
            <div className="editor__empty-card">
              <div className="editor__empty-icon">
                <IconSparkles />
              </div>
              <h2 className="editor__empty-title">用一句话生成图表</h2>
              <p className="editor__empty-text">
                在右侧描述你想要的流程、系统或结构，AI 会生成可直接编辑的 draw.io 图表。
                <br />
                之后可以继续用对话不断调整它。
              </p>
              <div className="editor__examples">
                {examples.slice(0, 4).map((example) => (
                  <button
                    key={example.title}
                    type="button"
                    className="chip"
                    onClick={() => onPickExample(example.prompt)}
                    title={example.prompt}
                  >
                    <span className="chip__icon">{example.icon}</span>
                    <span className="truncate">{example.title}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Floating canvas toolbar. */}
        {hasDiagram && (
          <div className="editor__toolbar" role="toolbar" aria-label="画布工具">
            <button
              type="button"
              className="editor__toolbar-btn"
              onClick={refit}
              title="适应窗口"
              aria-label="适应窗口"
            >
              <IconFit />
            </button>
            <button
              type="button"
              className="editor__toolbar-btn"
              onClick={reload}
              title="重新载入当前图表"
              aria-label="重新载入当前图表"
            >
              <IconRefresh />
            </button>
            <span className="editor__toolbar-sep" />
            <button
              type="button"
              className="editor__toolbar-btn"
              onClick={() => bridge?.status('图表已与 AI 会话同步', false)}
              title="在编辑器状态栏显示同步状态"
              aria-label="显示同步状态"
            >
              <IconGrid />
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
