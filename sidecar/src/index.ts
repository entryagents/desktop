/**
 * Sidecar entrypoint — line-based JSON-RPC over stdio.
 *
 * Requests:  {"id":"1","method":"pair.start","params":{...}}
 * Responses: {"id":"1","result":{...}} | {"id":"1","error":"..."}
 * Events:    {"event":"agent","data":{...}}  (no id)
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { EntryAgentHost, type DesktopIpcEvent } from "./host.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  return value ?? fallback;
}

const API_BASE = (arg("api-base", "https://entry-agents.dev")).replace(/\/$/, "");
const DATA_DIR = arg("data-dir", path.join(process.env.HOME || process.env.USERPROFILE || ".", ".entry-desktop"));
fs.mkdirSync(DATA_DIR, { recursive: true });
const AUTH_FILE = path.join(DATA_DIR, "auth.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const SESSIONS_DIR = path.join(DATA_DIR, "sessions");
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const readJson = <T,>(file: string, fallback: T): T => {
  try { return JSON.parse(fs.readFileSync(file, "utf-8")) as T; } catch { return fallback; }
};
const writeJson = (file: string, value: unknown) => {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
};

const emit = (event: string, data: unknown) => {
  process.stdout.write(JSON.stringify({ event, data }) + "\n");
};
const agentEmit = (e: DesktopIpcEvent) => emit("agent", e);

let host: EntryAgentHost | null = null;
let hostConfig: { projectRoot: string; modelId: string } | null = null;
let pairAbort: AbortController | null = null;

interface AuthFile { token: string; userId: string; email: string; name?: string }
interface Settings { workspaceRoot?: string; modelId?: string; permissionMode?: string }

const auth = (): AuthFile | null => readJson<AuthFile | null>(AUTH_FILE, null);
const settings = (): Settings => readJson<Settings>(SETTINGS_FILE, {});
const bearerFetch = async (p: string): Promise<unknown> => {
  const a = auth();
  if (!a) throw new Error("Not paired");
  const res = await fetch(`${API_BASE}${p}`, { headers: { authorization: `Bearer ${a.token}` } });
  if (!res.ok) throw new Error(`Entry API ${p} -> ${res.status}`);
  return res.json();
};

const methods: Record<string, (params: Record<string, unknown>) => Promise<unknown> | unknown> = {
  async "pair.start"(params) {
    const a = auth();
    if (a) return { alreadyPaired: true, email: a.email };
    const res = await fetch(`${API_BASE}/api/desktop/device/start`, { method: "POST" });
    if (!res.ok) throw new Error(`Device start failed: ${res.status}`);
    const start = (await res.json()) as {
      device_code: string; user_code: string;
      verification_uri_complete: string; interval: number;
    };
    emit("pair.started", { user_code: start.user_code, verification_uri: start.verification_uri_complete });
    pairAbort?.abort();
    pairAbort = new AbortController();
    const poll = async () => {
      const interval = (start.interval ?? 3) * 1000;
      for (;;) {
        if (pairAbort?.signal.aborted) return;
        await new Promise((r) => setTimeout(r, interval));
        try {
          const p = await fetch(`${API_BASE}/api/desktop/device/poll`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ device_code: start.device_code }),
            signal: pairAbort?.signal,
          });
          const body = (await p.json()) as {
            status: string; access_token?: string; user_id?: string; email?: string;
          };
          if (body.status === "approved" && body.access_token) {
            writeJson(AUTH_FILE, {
              token: body.access_token, userId: body.user_id ?? "",
              email: body.email ?? "", name: "",
            } satisfies AuthFile);
            emit("pair.complete", { email: body.email ?? "" });
            return;
          }
          if (body.status === "expired") { emit("pair.expired", {}); return; }
        } catch (e) {
          if ((e as Error).name === "AbortError") return;
        }
      }
    };
    void poll();
    return { user_code: start.user_code, verification_uri: start.verification_uri_complete };
  },
  "pair.cancel"() { pairAbort?.abort(); return { ok: true }; },
  async "auth.status"() {
    const a = auth();
    if (!a) return { paired: false };
    try {
      const usage = (await bearerFetch("/api/desktop/usage")) as Record<string, unknown>;
      return {
        paired: true, email: usage.email ?? a.email, name: usage.name ?? "",
        plan: usage.plan ?? "free", creditsCents: usage.creditBalanceCents ?? 0,
        avatar: usage.avatar ?? null,
      };
    } catch {
      return { paired: false, stale: true };
    }
  },
  "auth.signout"() { fs.rmSync(AUTH_FILE, { force: true }); return { ok: true }; },
  async "models.list"() {
    const data = (await bearerFetch("/api/desktop/models")) as { models?: unknown[] };
    return data;
  },
  async "usage.get"() { return bearerFetch("/api/desktop/usage"); },
  async "session.start"(params) {
    const a = auth();
    if (!a) throw new Error("Not paired — sign in first");
    const workspaceRoot = String(params.workspaceRoot ?? settings().workspaceRoot ?? "");
    const modelId = String(params.modelId ?? settings().modelId ?? "step-5-preview");
    if (!workspaceRoot) throw new Error("workspaceRoot is required");
    writeJson(SETTINGS_FILE, { ...settings(), workspaceRoot, modelId });
    await host?.stop();
    host = new EntryAgentHost({
      projectRoot: workspaceRoot,
      modelId,
      backend: { baseURL: `${API_BASE}/api/desktop`, sessionToken: a.token },
      allowedRoots: [workspaceRoot],
    });
    await host.start();
    hostConfig = { projectRoot: workspaceRoot, modelId };
    return { ok: true, workspaceRoot, modelId };
  },
  async "session.send"(params) {
    if (!host) throw new Error("No session — start one first");
    const history = Array.isArray(params.history) ? (params.history as unknown[]) : [];
    void host.send(String(params.text ?? ""), agentEmit, history).then(({ messages }) => {
      const id = `turn-${Date.now()}`;
      fs.writeFileSync(path.join(SESSIONS_DIR, `${id}.json`), JSON.stringify({ at: Date.now(), messages }, null, 2));
    });
    return { ok: true };
  },
  "session.approve"(params) {
    if (!host) throw new Error("No session");
    const ok = host.respondToApproval(String(params.approvalId), {
      approved: Boolean(params.approved), reason: params.reason ? String(params.reason) : undefined,
    });
    return { ok };
  },
  async "session.stop"() { await host?.stop(); host = null; hostConfig = null; return { ok: true }; },
  "settings.get"() { return settings(); },
  "settings.set"(params) {
    const next = { ...settings(), ...(params as Settings) };
    writeJson(SETTINGS_FILE, next);
    return next;
  },
  "sessions.list"() {
    return fs.readdirSync(SESSIONS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ id: f.replace(/\.json$/, ""), at: fs.statSync(path.join(SESSIONS_DIR, f)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
      .slice(0, 100);
  },
  "sessions.load"(params) {
    const file = path.join(SESSIONS_DIR, `${String(params.id)}.json`);
    if (!file.startsWith(SESSIONS_DIR)) throw new Error("Bad session id");
    return readJson<unknown>(file, null);
  },
};

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg: { id?: string; method?: string; params?: Record<string, unknown> };
  try { msg = JSON.parse(trimmed); } catch { return; }
  const { id, method, params = {} } = msg;
  if (!method) return;
  const handler = methods[method];
  if (!handler) {
    if (id) process.stdout.write(JSON.stringify({ id, error: `Unknown method: ${method}` }) + "\n");
    return;
  }
  Promise.resolve()
    .then(() => handler(params))
    .then((result) => { if (id) process.stdout.write(JSON.stringify({ id, result }) + "\n"); })
    .catch((e: Error) => { if (id) process.stdout.write(JSON.stringify({ id, error: e.message }) + "\n"); });
});

process.on("SIGTERM", () => { void host?.stop(); process.exit(0); });
emit("ready", { pid: process.pid, apiBase: API_BASE, dataDir: DATA_DIR, hostConfig });
