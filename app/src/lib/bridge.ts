/** Typed bridge to the Tauri shell + sidecar RPC client. */

export interface SidecarAuthStatus {
  paired: boolean;
  stale?: boolean;
  email?: string;
  name?: string;
  plan?: string;
  creditsCents?: number;
  avatar?: string | null;
}

export interface SidecarModel {
  id: string;
  name: string;
  context_window: number;
  max_output_tokens: number;
  pricing?: { input?: number; output?: number } | null;
}

export interface AgentEvent {
  type: string;
  turnId?: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  approvalId?: string;
  message?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  finishReason?: string;
}

type EventListener = (event: string, data: unknown) => void;

interface DesktopBridge {
  apiBaseUrl: string;
  getVersion(): Promise<string>;
  openExternal(url: string): Promise<void>;
  pickDirectory(): Promise<string | null>;
  rpc(method: string, params?: Record<string, unknown>): Promise<void>;
  onEvent(cb: (line: string) => void): Promise<UnlistenFn>;
}

type UnlistenFn = () => void;

declare global {
  interface Window {
    desktop?: DesktopBridge;
    __TAURI__?: unknown;
  }
}

const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const listeners = new Set<EventListener>();
let started = false;
let unlisten: UnlistenFn | null = null;

function handleLine(line: string) {
  let msg: { id?: string; result?: unknown; error?: string; event?: string; data?: unknown };
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id)!;
    pending.delete(msg.id);
    if (msg.error !== undefined) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
    return;
  }
  if (msg.event) listeners.forEach((fn) => fn(msg.event!, msg.data));
}

function randomId(): string {
  return crypto.randomUUID();
}

export const bridge = {
  get apiBaseUrl(): string {
    return window.desktop?.apiBaseUrl ?? "https://entry-agents.dev";
  },
  async start(): Promise<void> {
    if (started || !window.desktop) return;
    started = true;
    unlisten = await window.desktop.onEvent(handleLine);
  },
  stop() {
    unlisten?.();
    unlisten = null;
    started = false;
  },
  onEvent(fn: EventListener): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  /** Fire-and-forget notify (no response expected). */
  notify(method: string, params?: Record<string, unknown>): void {
    void window.desktop?.rpc(method, params);
  },
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!window.desktop) return Promise.reject(new Error("Bridge unavailable (run inside Tauri)"));
    const id = randomId();
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      window.desktop!.rpc(method, params).catch(reject);
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`${method}: timed out`));
        }
      }, 120_000);
    });
  },
  openExternal(url: string): void {
    void window.desktop?.openExternal(url);
  },
  async pickDirectory(): Promise<string | null> {
    return window.desktop ? window.desktop.pickDirectory() : null;
  },
  async version(): Promise<string> {
    try {
      return (await window.desktop?.getVersion()) ?? "1.0.0-beta.1";
    } catch {
      return "1.0.0-beta.1";
    }
  },
};
