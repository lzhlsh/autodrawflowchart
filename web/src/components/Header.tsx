import { useEffect, useRef, useState } from 'react';
import type { PublicSettings } from '../lib/api';
import {
  IconDownload,
  IconImage,
  IconKey,
  IconLogo,
  IconRefresh,
  IconSettings,
  IconTrash,
} from './Icons';

interface HeaderProps {
  title: string;
  onTitleChange: (title: string) => void;
  settings: PublicSettings | null;
  backendOnline: boolean;
  nodeCount: number;
  edgeCount: number;
  busy: boolean;
  hasDiagram: boolean;
  onOpenSettings: () => void;
  onExportPng: () => void;
  onExportXml: () => void;
  onReset: () => void;
  onRegenerate: () => void;
}

export function Header({
  title,
  onTitleChange,
  settings,
  backendOnline,
  nodeCount,
  edgeCount,
  busy,
  hasDiagram,
  onOpenSettings,
  onExportPng,
  onExportXml,
  onReset,
  onRegenerate,
}: HeaderProps) {
  // Local draft so typing stays responsive; commit on blur / Enter.
  const [draft, setDraft] = useState(title);
  const dirty = useRef(false);

  useEffect(() => {
    if (!dirty.current) setDraft(title);
  }, [title]);

  const commit = () => {
    dirty.current = false;
    const next = draft.trim();
    if (next && next !== title) onTitleChange(next);
    else setDraft(title);
  };

  const provider = settings?.provider ?? (backendOnline ? 'offline' : null);
  const providerBadge = !backendOnline ? (
    <span className="badge badge--error" title="无法连接后端服务">
      <span className="badge__dot" />
      后端离线
    </span>
  ) : provider === 'deepseek' ? (
    <span className="badge badge--online" title={`DeepSeek · ${settings?.model ?? ''}`}>
      <span className="badge__dot badge__dot--pulse" />
      {settings?.model ?? 'deepseek'}
    </span>
  ) : (
    <span className="badge badge--offline" title="未配置 API Key，使用内置规则引擎">
      <span className="badge__dot" />
      离线引擎
    </span>
  );

  return (
    <header className="header">
      <div className="header__brand">
        <div className="header__logo">
          <IconLogo />
        </div>
        <div className="header__titles">
          <span className="header__title">AutoDrawFlowchart</span>
          <span className="header__subtitle">AI 智能绘图 · draw.io 引擎</span>
        </div>
      </div>

      <div className="header__divider" />

      <input
        className="header__title-input"
        value={draft}
        placeholder="图表名称"
        aria-label="图表名称"
        onChange={(e) => {
          dirty.current = true;
          setDraft(e.target.value);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            dirty.current = false;
            setDraft(title);
            e.currentTarget.blur();
          }
        }}
      />

      <div className="header__spacer" />

      <div className="header__stats">
        {providerBadge}
        {hasDiagram && (
          <span className="badge" title="节点 / 连线数量">
            {nodeCount} 节点 · {edgeCount} 连线
          </span>
        )}
      </div>

      <div className="header__divider" />

      <div className="header__actions">
        <button
          type="button"
          className="btn btn--ghost btn--icon"
          onClick={onRegenerate}
          disabled={busy || !hasDiagram}
          title="按当前描述重新生成"
          aria-label="重新生成"
        >
          <IconRefresh />
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--icon"
          onClick={onExportPng}
          disabled={!hasDiagram}
          title="导出 PNG 图片"
          aria-label="导出 PNG"
        >
          <IconImage />
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--icon"
          onClick={onExportXml}
          disabled={!hasDiagram}
          title="下载 draw.io XML 源文件"
          aria-label="导出 XML"
        >
          <IconDownload />
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--icon"
          onClick={onReset}
          disabled={!hasDiagram}
          title="清空并开始新图表"
          aria-label="新建图表"
        >
          <IconTrash />
        </button>
        <button
          type="button"
          className={`btn btn--icon ${settings?.hasApiKey ? 'btn--ghost' : 'btn--primary'}`}
          onClick={onOpenSettings}
          title={settings?.hasApiKey ? 'API 设置' : '配置 DeepSeek API Key 以启用完整 AI 能力'}
          aria-label="设置"
        >
          {settings?.hasApiKey ? <IconSettings /> : <IconKey />}
        </button>
      </div>
    </header>
  );
}
