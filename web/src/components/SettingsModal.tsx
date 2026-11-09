import { useEffect, useState } from 'react';
import { api, ApiError, type PublicSettings, type TestConnectionResult } from '../lib/api';
import { IconAlert, IconCheck, IconClose, IconKey } from './Icons';

interface SettingsModalProps {
  open: boolean;
  settings: PublicSettings | null;
  onClose: () => void;
  onSaved: (settings: PublicSettings) => void;
}

type Mode = 'auto' | 'offline' | 'online';

export function SettingsModal({ open, settings, onClose, onSaved }: SettingsModalProps) {
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(settings?.baseUrl ?? 'https://api.deepseek.com');
  const [model, setModel] = useState(settings?.model ?? 'deepseek-flash');
  const [mode, setMode] = useState<Mode>('auto');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  // Reset the form each time the modal opens, so a cancelled edit is discarded.
  useEffect(() => {
    if (!open) return;
    setApiKey('');
    setBaseUrl(settings?.baseUrl ?? 'https://api.deepseek.com');
    setModel(settings?.model ?? 'deepseek-flash');
    setMode(settings?.offlineForced === true ? 'offline' : settings?.offlineForced === false ? 'online' : 'auto');
    setTestResult(null);
    setError(null);
    setSavedFlash(false);
  }, [open, settings]);

  // Escape closes the dialog.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const patch: { apiKey?: string; baseUrl?: string; model?: string; offline?: boolean } = {
        baseUrl: baseUrl.trim(),
        model: model.trim(),
      };
      // Only send the key when the user actually typed one, so we never clear a
      // key that came from the environment.
      if (apiKey.trim()) patch.apiKey = apiKey.trim();
      if (mode === 'offline') patch.offline = true;
      else if (mode === 'online') patch.offline = false;

      const next = await api.updateSettings(patch);
      onSaved(next);
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1800);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await api.testConnection());
    } catch (err) {
      setTestResult({
        mode: 'offline',
        ok: false,
        message: err instanceof ApiError ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="AI 设置">
        <div className="modal__header">
          <span style={{ color: 'var(--accent-primary)', display: 'grid', placeItems: 'center' }}>
            <IconKey />
          </span>
          <span className="modal__title">AI 模型设置</span>
          <button type="button" className="btn btn--ghost btn--icon" onClick={onClose} aria-label="关闭">
            <IconClose />
          </button>
        </div>

        <div className="modal__body">
          <div className="field">
            <span className="field__label">运行模式</span>
            <div className="segmented" role="group" aria-label="运行模式">
              {(
                [
                  { id: 'auto', label: '自动（有 Key 则在线）' },
                  { id: 'online', label: '强制在线' },
                  { id: 'offline', label: '强制离线' },
                ] as Array<{ id: Mode; label: string }>
              ).map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`segmented__item ${mode === option.id ? 'segmented__item--active' : ''}`}
                  onClick={() => setMode(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <span className="field__hint">
              离线模式下使用内置规则引擎，无需网络即可生成与编辑图表。
            </span>
          </div>

          <div className="field">
            <span className="field__label">
              DeepSeek API Key
              {settings?.apiKeySource === 'env' && (
                <span className="badge badge--online" style={{ fontSize: 10 }}>
                  已从环境变量读取
                </span>
              )}
            </span>
            <input
              className="field__input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              placeholder={settings?.hasApiKey ? '已配置 · 留空则不修改' : 'sk-...'}
              onChange={(e) => setApiKey(e.target.value)}
            />
            <span className="field__hint">
              仅保存在当前服务进程内存中，不会写入磁盘。也可通过环境变量 <code className="mono">DEEPSEEK_API_KEY</code> 配置。
            </span>
          </div>

          <div className="field">
            <span className="field__label">模型</span>
            <input
              className="field__input"
              value={model}
              spellCheck={false}
              onChange={(e) => setModel(e.target.value)}
            />
            <span className="field__hint">
              DeepSeek V4.1 Flash 的服务模型名为 <code className="mono">deepseek-flash</code>。
            </span>
          </div>

          <div className="field">
            <span className="field__label">API 地址</span>
            <input
              className="field__input"
              value={baseUrl}
              spellCheck={false}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
            <span className="field__hint">默认 https://api.deepseek.com（OpenAI 兼容协议）。</span>
          </div>

          {error && (
            <div className="alert alert--error">
              <span className="alert__icon">
                <IconAlert />
              </span>
              <div className="alert__body">{error}</div>
            </div>
          )}

          {testResult && (
            <div className={`alert alert--${testResult.ok ? 'info' : 'warning'}`}>
              <span className="alert__icon">{testResult.ok ? <IconCheck /> : <IconAlert />}</span>
              <div className="alert__body">
                {testResult.ok
                  ? `连接成功 · ${testResult.model} · ${testResult.latencyMs} ms`
                  : testResult.message}
              </div>
            </div>
          )}

          {savedFlash && (
            <div className="alert alert--info">
              <span className="alert__icon">
                <IconCheck />
              </span>
              <div className="alert__body">设置已保存</div>
            </div>
          )}
        </div>

        <div className="modal__footer">
          <button type="button" className="btn" onClick={runTest} disabled={testing || saving}>
            {testing ? '测试中…' : '测试连接'}
          </button>
          <button type="button" className="btn" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button type="button" className="btn btn--primary" onClick={save} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
