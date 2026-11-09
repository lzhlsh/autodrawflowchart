import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../lib/api';
import { IconAlert, IconBolt, IconCheck, IconSparkles } from './Icons';

interface MessageListProps {
  messages: ChatMessage[];
  thinking: boolean;
  thinkingLabel: string;
  onSuggestion: (text: string) => void;
  busy: boolean;
}

/** Render a plain-text message, highlighting the offline-mode notice. */
function renderContent(content: string) {
  // Split on the warning marker the agent adds when it degrades to offline.
  const parts = content.split(/(⚠️[^\n]*)/g);
  if (parts.length === 1) return content;
  return parts.map((part, i) =>
    part.startsWith('⚠️') ? (
      <span key={i} style={{ color: 'var(--warning)' }}>
        {part}
      </span>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

function timeOf(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export function MessageList({ messages, thinking, thinkingLabel, onSuggestion, busy }: MessageListProps) {
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Guarded: not every environment implements scrollIntoView (older embedded
    // webviews, and non-browser DOM implementations used in tests).
    endRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' });
  }, [messages.length, thinking]);

  return (
    <>
      {messages.map((message) => {
        const isUser = message.role === 'user';
        const isFallback = Boolean(
          (message.diagnostics as { fallback?: string } | undefined)?.fallback,
        );
        const kindClass = isFallback ? ' msg__bubble--warning' : '';

        return (
          <div key={message.id} className={`msg ${isUser ? 'msg--user' : 'msg--assistant'}`}>
            <div className={`msg__avatar ${isUser ? 'msg__avatar--user' : 'msg__avatar--ai'}`}>
              {isUser ? '我' : <IconSparkles />}
            </div>

            <div className="msg__content">
              <div className={`msg__bubble${kindClass}`}>{renderContent(message.content)}</div>

              {!isUser && (message.provider || message.latencyMs) && (
                <div className="msg__meta">
                  {message.provider === 'deepseek' ? (
                    <span className="msg__meta-item" style={{ color: 'var(--success)' }}>
                      <IconCheck style={{ width: 11, height: 11 }} />
                      {message.model ?? 'DeepSeek'}
                    </span>
                  ) : (
                    <span className="msg__meta-item" style={{ color: 'var(--warning)' }}>
                      <IconBolt style={{ width: 11, height: 11 }} />
                      内置规则引擎
                    </span>
                  )}
                  {typeof message.latencyMs === 'number' && (
                    <span className="msg__meta-item">{message.latencyMs} ms</span>
                  )}
                  <span className="msg__meta-item">{timeOf(message.createdAt)}</span>
                </div>
              )}

              {!isUser && message.suggestions && message.suggestions.length > 0 && (
                <div className="msg__suggestions">
                  {message.suggestions.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      className="msg__suggestion"
                      disabled={busy}
                      onClick={() => onSuggestion(suggestion)}
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })}

      {thinking && (
        <div className="msg msg--assistant">
          <div className="msg__avatar msg__avatar--ai">
            <IconSparkles />
          </div>
          <div className="msg__content">
            <div className="thinking">
              <span className="thinking__dots">
                <i />
                <i />
                <i />
              </span>
              {thinkingLabel}
            </div>
          </div>
        </div>
      )}

      <div ref={endRef} />
    </>
  );
}

/** Inline error row with a retry affordance. */
export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="alert alert--error">
      <span className="alert__icon">
        <IconAlert />
      </span>
      <div className="alert__body">
        <div>{message}</div>
        {onRetry && (
          <div className="alert__actions">
            <button type="button" className="btn btn--sm" onClick={onRetry}>
              重试
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Collapsible panel showing the raw draw.io XML for power users. */
export function XmlPreview({ xml }: { xml: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!xml) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(xml);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button type="button" className="btn btn--sm" onClick={() => setOpen((v) => !v)}>
          {open ? '收起 XML' : `查看 draw.io XML (${(xml.length / 1024).toFixed(1)} KB)`}
        </button>
        <button type="button" className="btn btn--sm" onClick={copy}>
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      {open && (
        <pre
          className="mono"
          style={{
            margin: 0,
            maxHeight: 260,
            overflow: 'auto',
            padding: 12,
            borderRadius: 'var(--radius-sm)',
            background: 'var(--bg-void)',
            border: '1px solid var(--border-subtle)',
            fontSize: 10.5,
            lineHeight: 1.5,
            color: 'var(--text-secondary)',
            whiteSpace: 'pre',
          }}
        >
          {xml}
        </pre>
      )}
    </div>
  );
}
