import type { Toast } from '../lib/hooks';
import { IconAlert, IconCheck, IconClose, IconInfo } from './Icons';

interface ToastsProps {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}

const ICONS = {
  success: IconCheck,
  error: IconAlert,
  warning: IconAlert,
  info: IconInfo,
} as const;

export function Toasts({ toasts, onDismiss }: ToastsProps) {
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => {
        const Icon = ICONS[toast.kind];
        return (
          <div key={toast.id} className={`toast toast--${toast.kind}`}>
            <span className="toast__icon">
              <Icon />
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>{toast.message}</span>
            <button
              type="button"
              className="btn btn--ghost btn--icon"
              style={{ width: 24, height: 24, padding: 0 }}
              onClick={() => onDismiss(toast.id)}
              aria-label="关闭提示"
            >
              <IconClose style={{ width: 13, height: 13 }} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
