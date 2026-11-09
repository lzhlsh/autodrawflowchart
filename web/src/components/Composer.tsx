import { useEffect, type KeyboardEvent } from 'react';
import { useAutoGrow } from '../lib/hooks';
import { IconSend } from './Icons';

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  busy: boolean;
  placeholder: string;
  hintLeft: string;
}

export function Composer({
  value,
  onChange,
  onSubmit,
  disabled,
  busy,
  placeholder,
  hintLeft,
}: ComposerProps) {
  const { ref, resize } = useAutoGrow(180);

  // Grow/shrink with content, including after programmatic value changes
  // (e.g. clicking an example chip).
  useEffect(() => {
    resize();
  }, [value, resize]);

  const canSend = value.trim().length > 0 && !disabled && !busy;

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter inserts a newline. Skip while composing with an
    // IME so Chinese/Japanese input is not submitted mid-composition.
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (canSend) onSubmit();
    }
  };

  return (
    <div className="composer">
      <div className="composer__box">
        <textarea
          ref={ref}
          className="composer__input"
          value={value}
          rows={1}
          placeholder={placeholder}
          aria-label="描述你想要的图表"
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button
          type="button"
          className="composer__send"
          onClick={onSubmit}
          disabled={!canSend}
          title="发送 (Enter)"
          aria-label="发送"
        >
          {busy ? <span className="spinner spinner--sm" /> : <IconSend />}
        </button>
      </div>
      <div className="composer__hint">
        <span>{hintLeft}</span>
        <span>
          <kbd>Enter</kbd> 发送 · <kbd>Shift</kbd>+<kbd>Enter</kbd> 换行
        </span>
      </div>
    </div>
  );
}
