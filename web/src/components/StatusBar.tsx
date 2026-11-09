import type { PublicSettings } from '../lib/api';

interface StatusBarProps {
  backendOnline: boolean;
  editorReady: boolean;
  settings: PublicSettings | null;
  nodeCount: number;
  edgeCount: number;
  diagramSize: { width: number; height: number } | null;
  lastLatencyMs: number | null;
  syncing: boolean;
}

/**
 * Bottom status strip. Monospaced and dense on purpose — it reads as
 * instrumentation and is the fastest way to confirm the whole stack is wired up.
 */
export function StatusBar({
  backendOnline,
  editorReady,
  settings,
  nodeCount,
  edgeCount,
  diagramSize,
  lastLatencyMs,
  syncing,
}: StatusBarProps) {
  const tone = !backendOnline ? 'err' : editorReady ? 'ok' : 'warn';

  return (
    <footer className="statusbar">
      <span className="statusbar__item">
        <span className={`statusbar__dot statusbar__dot--${tone}`} />
        {backendOnline ? 'API 已连接' : 'API 未连接'}
      </span>

      <span className="statusbar__item">
        <span className={`statusbar__dot statusbar__dot--${editorReady ? 'ok' : 'warn'}`} />
        {editorReady ? '编辑器就绪' : '编辑器加载中'}
      </span>

      <span className="statusbar__item">
        {settings?.provider === 'deepseek' ? `模型 ${settings.model}` : '内置规则引擎'}
      </span>

      <span className="statusbar__item">
        draw.io XML · {nodeCount} 节点 / {edgeCount} 连线
      </span>

      {diagramSize && (
        <span className="statusbar__item">
          {Math.round(diagramSize.width)}×{Math.round(diagramSize.height)}
        </span>
      )}

      <span className="statusbar__item statusbar__item--right">
        {syncing ? (
          <>
            <span className="statusbar__dot statusbar__dot--warn" />
            同步画布…
          </>
        ) : lastLatencyMs !== null ? (
          `最近生成 ${lastLatencyMs} ms`
        ) : (
          '就绪'
        )}
      </span>
    </footer>
  );
}
