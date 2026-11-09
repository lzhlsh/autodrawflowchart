/**
 * Small shared React hooks.
 *
 * Every ambient browser API here is accessed defensively. The app is a normal
 * SPA in production, but these hooks also run under test harnesses and embedded
 * webviews where `window` can be absent or torn down while a timer is still
 * pending — an unguarded `window.setTimeout` callback then throws
 * `ReferenceError: window is not defined` after the environment is gone.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * `window` when it exists.
 *
 * Read through `globalThis` on every call so a temporarily-installed DOM shim is
 * picked up rather than captured at module-evaluation time.
 */
function win(): (Window & typeof globalThis) | undefined {
  const g = globalThis as { window?: Window & typeof globalThis };
  return g.window;
}

/**
 * Schedule a timer.
 *
 * Uses `globalThis` rather than `window`: this module may be evaluated while a
 * test harness has a temporary `window` installed, and a bare `window` reference
 * would then resolve against that snapshot and throw once it is removed.
 * `globalThis.setTimeout` always exists.
 */
function setTimer(fn: () => void, ms: number): number {
  return globalThis.setTimeout(fn, ms) as unknown as number;
}

/** Cancel a timer. */
function clearTimer(id: number): void {
  globalThis.clearTimeout(id);
}

/** Debounce a fast-changing value. */
export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimer(() => setDebounced(value), delayMs);
    return () => clearTimer(timer);
  }, [value, delayMs]);
  return debounced;
}

export interface Toast {
  id: number;
  kind: 'success' | 'error' | 'warning' | 'info';
  message: string;
}

let toastSeq = 0;

/** Minimal toast queue with auto-dismiss. */
export function useToasts(ttlMs = 4200) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<number[]>([]);
  /**
   * Guards against state updates after unmount.
   *
   * A dismiss timer can fire in the window between unmount and the cleanup
   * effect running — and in tests after the whole DOM has been torn down. Setting
   * state on an unmounted root is a leak at best and throws at worst, so the
   * callbacks check this flag before touching state.
   */
  const alive = useRef(true);

  const dismiss = useCallback((id: number) => {
    if (!alive.current) return;
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: Toast['kind'], message: string) => {
      const id = ++toastSeq;
      if (!alive.current) return id;
      setToasts((prev) => [...prev.slice(-3), { id, kind, message }]);
      const timer = setTimer(() => dismiss(id), ttlMs);
      timers.current.push(timer);
      return id;
    },
    [dismiss, ttlMs],
  );

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const t of timers.current) clearTimer(t);
      timers.current = [];
    };
  }, []);

  return { toasts, push, dismiss };
}

/**
 * Auto-grow a textarea up to a max height.
 * Returns the ref to attach and a resize function.
 */
export function useAutoGrow(maxHeight = 180) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  const resize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [maxHeight]);

  return { ref, resize };
}

/** Fire a callback when a click lands outside the referenced element. */
export function useClickOutside<T extends HTMLElement>(onOutside: () => void) {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const target = typeof document === 'undefined' ? undefined : document;
    if (!target) return;

    const handler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onOutside();
    };
    target.addEventListener('mousedown', handler);
    return () => target.removeEventListener('mousedown', handler);
  }, [onOutside]);

  return ref;
}

/** Read a value from localStorage, tolerating environments without it. */
function readStored<T>(key: string): T | undefined {
  try {
    const raw = win()?.localStorage?.getItem(key);
    return raw === null || raw === undefined ? undefined : (JSON.parse(raw) as T);
  } catch {
    // Private mode, disabled storage, or non-JSON content.
    return undefined;
  }
}

/**
 * Track a persisted preference.
 * Falls back gracefully when storage is unavailable (private mode, sandbox).
 */
export function useLocalStorage<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    const stored = readStored<T>(key);
    return stored === undefined ? initial : stored;
  });

  useEffect(() => {
    try {
      win()?.localStorage?.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable — the preference simply does not persist */
    }
  }, [key, value]);

  return [value, setValue] as const;
}
