/**
 * draw.io embed bridge.
 *
 * The editor is the upstream draw.io build, vendored under /drawio and loaded in
 * an iframe with `?embed=1&proto=json`. All communication is postMessage using
 * the documented JSON protocol:
 *
 *   editor -> host : {event:'init'} | {event:'autosave'|'save', xml} |
 *                    {event:'exit'} | {event:'export', data} | {event:'openLink'}
 *   host -> editor : {action:'load', xml, autosave} | {action:'export', format} |
 *                    {action:'spinner'|'status', ...} | {action:'merge', xml}
 *
 * This module owns that protocol so React components never touch postMessage.
 */

export interface DrawioSize {
  width: number;
  height: number;
}

export interface DrawioEvents {
  /** The editor finished booting and is waiting for a `load` action. */
  onReady?: () => void;
  /** Diagram content changed (debounced by the editor). */
  onAutosave?: (xml: string) => void;
  /** User pressed Save. */
  onSave?: (xml: string) => void;
  /** Response to an `export` action. */
  onExport?: (payload: { format: string; data?: string; xml?: string }) => void;
  /** User clicked Exit. */
  onExit?: (modified: boolean) => void;
  /** Editor reported an error. */
  onError?: (message: string) => void;
  /** Anything else, for logging/debugging. */
  onEvent?: (event: string, payload: Record<string, unknown>) => void;
}

type PendingResolver = (value: unknown) => void;

interface Pending {
  resolve: PendingResolver;
  reject: (err: Error) => void;
  timer: number;
}

export class DrawioBridge {
  private frame: HTMLIFrameElement | null = null;
  private events: DrawioEvents;
  private pending = new Map<string, Pending[]>();
  private ready = false;
  private disposed = false;
  /** XML we handed to the editor; used to ignore our own autosave echoes. */
  private loadedXml = '';
  private queue: Array<Record<string, unknown>> = [];

  constructor(events: DrawioEvents = {}) {
    this.events = events;
  }

  /** Begin listening. Idempotent. */
  attach(): void {
    if (typeof window === 'undefined') return;
    window.addEventListener('message', this.handleMessage);
  }

  dispose(): void {
    this.disposed = true;
    window.removeEventListener('message', this.handleMessage);
    for (const list of this.pending.values()) {
      for (const p of list) {
        window.clearTimeout(p.timer);
        p.reject(new Error('drawio bridge disposed'));
      }
    }
    this.pending.clear();
    this.frame = null;
  }

  setFrame(frame: HTMLIFrameElement | null): void {
    this.frame = frame;
    if (frame) this.attach();
  }

  get isReady(): boolean {
    return this.ready;
  }

  // -------------------------------------------------------------------------
  // Incoming
  // -------------------------------------------------------------------------

  private handleMessage = (event: MessageEvent): void => {
    if (this.disposed) return;
    // The editor is same-origin in this app, so verify the sender frame.
    if (this.frame && event.source && event.source !== this.frame.contentWindow) return;

    let payload: Record<string, unknown> | null = null;
    try {
      payload = typeof event.data === 'string' ? JSON.parse(event.data) : (event.data as Record<string, unknown>);
    } catch {
      return;
    }
    if (!payload || typeof payload !== 'object') return;

    const type = typeof payload.event === 'string' ? payload.event : undefined;
    if (type) this.events.onEvent?.(type, payload);

    switch (type) {
      case 'init':
        this.ready = true;
        this.flushQueue();
        this.events.onReady?.();
        return;

      case 'configure':
        // Only sent when configure=1; we do not use it, but do not hang.
        return;

      case 'load':
        this.settle('load', payload);
        return;

      case 'autosave': {
        const xml = typeof payload.xml === 'string' ? payload.xml : '';
        // Guard against reacting to our own programmatic load.
        if (xml && xml !== this.loadedXml) this.events.onAutosave?.(xml);
        return;
      }

      case 'save': {
        const xml = typeof payload.xml === 'string' ? payload.xml : '';
        this.events.onSave?.(xml);
        this.settle('save', payload);
        return;
      }

      case 'export':
        this.events.onExport?.({
          format: String(payload.format ?? ''),
          data: typeof payload.data === 'string' ? payload.data : undefined,
          xml: typeof payload.xml === 'string' ? payload.xml : undefined,
        });
        this.settle('export', payload);
        return;

      case 'exit':
        this.events.onExit?.(Boolean(payload.modified));
        return;

      case 'error': {
        const message =
          typeof payload.message === 'string' ? payload.message : typeof payload.error === 'string' ? payload.error : 'unknown draw.io error';
        this.events.onError?.(message);
        return;
      }

      default:
        // Resolve any waiting promise keyed by the event name (merge, status...).
        if (type) this.settle(type, payload);
        return;
    }
  };

  private settle(key: string, value: unknown): void {
    const list = this.pending.get(key);
    if (!list || list.length === 0) return;
    const next = list.shift()!;
    window.clearTimeout(next.timer);
    next.resolve(value);
  }

  private flushQueue(): void {
    const queued = this.queue.splice(0);
    for (const message of queued) this.post(message);
  }

  // -------------------------------------------------------------------------
  // Outgoing
  // -------------------------------------------------------------------------

  /**
   * Send a message to the editor.
   *
   * Nothing is delivered before the editor announces itself with `init`: the
   * embed protocol is explicit that the host waits for that event, and posting
   * earlier is racy (the frame's own message listener may not be installed yet).
   * Messages sent too early are queued and flushed on handshake.
   */
  post(message: Record<string, unknown>): void {
    const win = this.frame?.contentWindow;
    if (!win || !this.ready) {
      this.queue.push(message);
      return;
    }
    // Same-origin in this app; '*' keeps it working if the editor is ever
    // hosted on a separate origin.
    win.postMessage(JSON.stringify(message), '*');
  }

  /** Wait for a specific event, with timeout. */
  private waitFor(event: string, timeoutMs = 20000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        const list = this.pending.get(event);
        if (list) {
          const at = list.findIndex((p) => p.timer === timer);
          if (at >= 0) list.splice(at, 1);
        }
        reject(new Error(`timed out waiting for draw.io "${event}"`));
      }, timeoutMs);
      const list = this.pending.get(event) ?? [];
      list.push({ resolve, reject, timer });
      this.pending.set(event, list);
    });
  }

  /**
   * Load (or replace) the diagram content.
   *
   * `autosave` makes the editor report every user edit back to us, which is what
   * keeps the AI's view of the diagram in sync with the canvas. We also pass
   * `fit: 1` so a freshly generated diagram is framed nicely.
   */
  async load(xml: string, options: { autosave?: boolean; title?: string; dark?: boolean } = {}): Promise<void> {
    this.loadedXml = xml;
    const wait = this.waitFor('load').catch(() => undefined);
    this.post({
      action: 'load',
      xml,
      autosave: options.autosave === false ? 0 : 1,
      title: options.title,
      dark: options.dark ? 1 : undefined,
      // `noSaveBtn`/`noExitBtn` keep the embed chrome minimal in our layout.
      noSaveBtn: 0,
      noExitBtn: 1,
      saveAndExit: 0,
      fit: 1,
      border: 24,
      // Keep the file's own view settings rather than persisting runtime zoom.
      preserveViewState: true,
      // Our host page owns these shortcuts.
      passThroughKeys: [{ key: 'p', ctrl: true, command: 'host:print' }],
      exportProtocol: true,
    });
    await wait;
  }

  /** Merge extra cells into the current diagram (non-destructive). */
  async merge(xml: string): Promise<unknown> {
    const wait = this.waitFor('merge', 15000).catch(() => undefined);
    this.post({ action: 'merge', xml });
    return wait;
  }

  /** Ask the editor for the current XML. */
  async requestXml(): Promise<string> {
    const wait = this.waitFor('export', 20000);
    this.post({ action: 'export', format: 'xml' });
    const payload = (await wait) as { xml?: string } | undefined;
    return payload?.xml ?? '';
  }

  /** Export as png / svg / xmlsvg and get a data URI. */
  async exportAs(
    format: 'png' | 'svg' | 'xmlpng' | 'html2',
    options: Record<string, unknown> = {},
  ): Promise<{ data?: string; xml?: string }> {
    const wait = this.waitFor('export', 60000);
    this.post({
      action: 'export',
      format,
      scale: format === 'png' || format === 'xmlpng' ? 2 : undefined,
      border: 12,
      background: format === 'png' || format === 'xmlpng' ? '#0b1220' : undefined,
      ...options,
    });
    // Return only the fields the caller cares about — the raw message also
    // carries `event`/`format`, which would leak protocol details into the UI.
    const payload = (await wait) as { data?: string; xml?: string } | undefined;
    return { data: payload?.data, xml: payload?.xml };
  }

  /** Show/hide the editor's own spinner overlay. */
  spinner(show: boolean, message?: string): void {
    this.post({ action: 'spinner', show, message });
  }

  /** Write text into the editor status bar. */
  status(message: string, modified?: boolean): void {
    this.post({ action: 'status', message, modified });
  }

  /** Fit the current diagram into the viewport. */
  fit(): void {
    this.post({ action: 'fit' });
  }
}

/** URL for the vendored editor. */
export function editorUrl(options: { dark?: boolean; libraries?: boolean; language?: string } = {}): string {
  const params = new URLSearchParams({
    embed: '1',
    proto: 'json',
    spin: '1',
    libraries: options.libraries === false ? '0' : '1',
    noSaveBtn: '1',
    saveAndExit: '0',
    noExitBtn: '1',
    // `configure=1` avoids a class of races on slow first loads.
    configure: '0',
    ui: 'dark',
  });
  if (options.language) params.set('lang', options.language);
  return `/drawio/index.html?${params.toString()}`;
}
