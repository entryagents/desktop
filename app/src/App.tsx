import { useEffect, useRef, useState } from "react";
import { bridge, type AgentEvent, type SidecarAuthStatus } from "./lib/bridge";
import type { Artifact, Conversation, Model, ToolCall, Turn } from "./lib/types";
import { MODES, newConversation } from "./lib/types";
import Sprite from "./components/Sprite";
import Sidebar from "./components/Sidebar";
import Chat from "./components/Chat";
import ArtifactPanel from "./components/ArtifactPanel";
import SettingsModal from "./components/SettingsModal";
import AuthDialog from "./components/AuthDialog";
import Onboarding from "./components/Onboarding";

interface Approval {
  approvalId: string;
  toolName: string;
  input: unknown;
}

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [artifactOpen, setArtifactOpen] = useState(true);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [modelIdx, setModelIdx] = useState(0);
  const [modeIdx, setModeIdx] = useState(1);
  const [auth, setAuth] = useState<SidecarAuthStatus | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState("general");
  const [version, setVersion] = useState("1.0.0-beta.1");
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [toast, setToast] = useState("");
  const [approval, setApproval] = useState<Approval | null>(null);
  const [artifactsOverride, setArtifactsOverride] = useState<Artifact[] | null>(null);
  const sessionUsage = useRef<{ inputTokens: number; cachedInputTokens: number; outputTokens: number } | null>(null);
  const [, forceRender] = useState(0);

  const conversation = conversations.find((c) => c.id === activeId) ?? null;
  const streaming = Boolean(conversation?.turns.some((t) => t.streaming));

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2600);
  };

  const reloadAuth = async () => {
    try {
      const status = await bridge.call<SidecarAuthStatus>("auth.status");
      setAuth(status);
      if (!status?.paired) setAuthOpen(true);
    } catch {
      setAuth(null);
    }
  };

  const reloadModels = async () => {
    try {
      const data = await bridge.call<{ models: Model[] }>("models.list");
      setModels(data?.models ?? []);
    } catch {
      setModels([]);
    }
  };

  const startSession = async (root: string) => {
    if (!root || !auth?.paired) return;
    try {
      await bridge.call("session.start", { workspaceRoot: root, modelId: models[modelIdx]?.id ?? "step-5-preview" });
      showToast(`Workspace: ${root.split(/[\\/]/).pop()}`);
    } catch (e) {
      showToast((e as Error).message);
    }
  };

  // ── boot ─────────────────────────────────────────────────────
  const [authChecked, setAuthChecked] = useState(false);
  useEffect(() => {
    document.title = "Entry Desktop";
    void bridge.start();
    void bridge.version().then(setVersion);
    void reloadAuth().finally(() => setAuthChecked(true));
    void reloadModels();
    bridge.call<{ workspaceRoot?: string }>("settings.get")
      .then((s) => { if (s?.workspaceRoot) setWorkspaceRoot(s.workspaceRoot); })
      .catch(() => {});
    bridge.call<{ verification_uri?: string }>("pair.start").catch(() => {});

    // Pairing / agent events
    const off = bridge.onEvent((event: string, data: unknown) => {
      if (event === "pair.complete") {
        void reloadAuth().then(() => {
          setAuthOpen(false);
          showToast("Signed in");
        });
        return;
      }
      if (event !== "agent") return;
      const ev = data as AgentEvent;
      if (ev.type === "approval-request") {
        setApproval({ approvalId: ev.approvalId!, toolName: ev.toolName ?? "", input: ev.input });
        return;
      }
      setConversations((prev) => {
        const conv = prev.find((c) => c.id === activeId);
        if (!conv) return prev;
        const turns = [...conv.turns];
        let last: Turn | undefined = turns[turns.length - 1];
        const ensureAssistant = () => {
          if (!last || last.role !== "assistant") {
            last = { role: "assistant", text: "", toolCalls: [], streaming: true };
            turns.push(last);
          }
          return last;
        };
        switch (ev.type) {
          case "turn-started":
            break;
          case "text-delta":
            ensureAssistant().text += ev.text ?? "";
            break;
          case "reasoning-delta":
            ensureAssistant().reasoning = (last!.reasoning ?? "") + (ev.text ?? "");
            break;
          case "tool-call": {
            const t = ensureAssistant();
            if (!t.toolCalls.some((x) => x.toolCallId === ev.toolCallId)) {
              t.toolCalls.push({ toolCallId: ev.toolCallId!, toolName: ev.toolName ?? "", input: ev.input });
            }
            break;
          }
          case "tool-result": {
            const t = ensureAssistant();
            const tc = t.toolCalls.find((x) => x.toolCallId === ev.toolCallId);
            if (tc) {
              tc.output = ev.output;
              if (typeof ev.output === "string" && ev.output.length > 60) {
                const art: Artifact = { id: `t-${ev.toolCallId}`, title: tc.toolName, type: "tool", toolCall: tc };
                if (!conv.artifacts.some((a) => a.id === art.id)) conv.artifacts = [...conv.artifacts, art];
              }
            }
            break;
          }
          case "tool-error": {
            const tc = ensureAssistant().toolCalls.find((x) => x.toolCallId === ev.toolCallId);
            if (tc) tc.errorText = ev.errorText;
            break;
          }
          case "usage":
            sessionUsage.current = {
              inputTokens: (sessionUsage.current?.inputTokens ?? 0) + (ev.inputTokens ?? 0),
              cachedInputTokens: (sessionUsage.current?.cachedInputTokens ?? 0) + (ev.cachedInputTokens ?? 0),
              outputTokens: (sessionUsage.current?.outputTokens ?? 0) + (ev.outputTokens ?? 0),
            };
            if (last && last.role === "assistant") {
              last.usage = { inputTokens: ev.inputTokens ?? 0, cachedInputTokens: ev.cachedInputTokens ?? 0, outputTokens: ev.outputTokens ?? 0 };
            }
            break;
          case "turn-finished":
          case "stopped":
            turns.forEach((t) => { if (t.role === "assistant") t.streaming = false; });
            break;
          case "error":
            showToast(ev.message ?? "Agent error");
            break;
        }
        return prev.map((c) => (c.id === conv.id ? { ...conv, turns } : c));
      });
      forceRender((n) => n + 1);
    });
    return () => { off(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // Start the session whenever workspace/auth/model become ready
  useEffect(() => {
    if (auth?.paired && workspaceRoot) void startSession(workspaceRoot);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth?.paired, workspaceRoot, modelIdx]);

  // ── actions ──────────────────────────────────────────────────
  const openNew = () => {
    const conv = newConversation();
    setConversations((prev) => [conv, ...prev]);
    setActiveId(conv.id);
    setArtifactsOverride(null);
  };

  const send = async (text: string) => {
    if (!auth?.paired) { setAuthOpen(true); return; }
    if (!workspaceRoot) {
      const dir = await bridge.pickDirectory();
      if (dir) setWorkspaceRoot(dir);
      else { showToast("Choose a workspace folder first"); return; }
    }
    let conv = conversation;
    if (!conv) {
      conv = newConversation(text.slice(0, 42));
      setConversations((prev) => [conv!, ...prev]);
      setActiveId(conv.id);
    } else if (conv.turns.length === 0) {
      const title = text.slice(0, 42);
      setConversations((prev) => prev.map((c) => (c.id === conv!.id ? { ...c, title } : c)));
    }
    const userTurn: Turn = { role: "user", text, toolCalls: [] };
    setConversations((prev) =>
      prev.map((c) => (c.id === conv!.id ? { ...c, turns: [...c.turns, userTurn, { role: "assistant", text: "", toolCalls: [], streaming: true }] } : c)),
    );
    try {
      await bridge.call("session.send", { text, history: [] });
    } catch (e) {
      showToast((e as Error).message);
    }
  };

  const stop = () => { void bridge.call("session.stop"); };

  const decide = (approved: boolean) => {
    if (!approval) return;
    void bridge.call("session.approve", { approvalId: approval.approvalId, approved });
    setApproval(null);
  };

  const artifacts: Artifact[] = artifactsOverride ?? [
    ...(conversation?.artifacts ?? []),
    ...(auth ? [{ id: "usage", title: "Usage & Telemetry", type: "usage" as const }] : []),
  ];

  const needsOnboarding = authChecked && !auth?.paired;

  return (
    <>
      <Sprite />
      {needsOnboarding && (
        <Onboarding
          onPaired={() => {
            void reloadAuth();
            setAuthOpen(false);
            showToast("Signed in");
          }}
        />
      )}
      <div
        className="app"
        id="app"
        data-titlebar="custom"
        data-sidebar={sidebarOpen ? "open" : "closed"}
        data-artifact={artifactOpen ? "open" : "closed"}
        data-expanded="false"
        hidden={needsOnboarding}
      >
        <header className="titlebar" data-tauri-drag-region>
          <nav className="menubar" aria-label="Application menu">
            <span className="titlebar-logo"><svg className="ico"><use href="#i-logo" /></svg></span>
            <span className="brand">Entry Agents</span>
            <span className="titlebar-beta">beta</span>
            <button type="button" onClick={() => { setSettingsOpen(true); setSettingsTab("general"); }}>File</button>
            <button type="button" onClick={() => { setSettingsOpen(true); setSettingsTab("permissions"); }}>View</button>
            <button type="button" onClick={() => { setSettingsOpen(true); setSettingsTab("about"); }}>Window</button>
          </nav>
          <div className="winctl">
            <button type="button" aria-label="Minimize" title="Minimize" onClick={() => bridge.notify("win.minimize")}>
              <svg className="wc" viewBox="0 0 10 10"><path d="M1 5h8" /></svg>
            </button>
            <button type="button" className="close" aria-label="Close" title="Close" onClick={() => bridge.notify("win.close")}>
              <svg className="wc" viewBox="0 0 10 10"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" /></svg>
            </button>
          </div>
        </header>

        <div className="workbench" id="workbench">
          <Sidebar
            conversations={conversations}
            activeId={activeId}
            user={auth}
            openNew={openNew}
            openConversation={(id) => { setActiveId(id); setArtifactsOverride(null); }}
            openSettings={(tab) => { setSettingsOpen(true); setSettingsTab(tab); }}
            openBilling={() => bridge.openExternal("https://entry-agents.dev/pricing")}
            onToggleSidebar={() => setSidebarOpen(false)}
          />
          <div className="resizer rz-sb" role="separator" aria-orientation="vertical" aria-label="Resize sidebar" tabIndex={0} />

          <Chat
            conversation={conversation}
            models={models}
            modelIdx={modelIdx}
            setModelIdx={setModelIdx}
            modeIdx={modeIdx}
            setModeIdx={setModeIdx}
            onSend={send}
            onStop={stop}
            streaming={streaming}
            onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
            onToggleArtifact={() => setArtifactOpen(!artifactOpen)}
          />
          <div className="resizer rz-ar" role="separator" aria-orientation="vertical" aria-label="Resize artifact panel" tabIndex={0} />

          <ArtifactPanel
            artifacts={artifacts}
            activeId={conversation?.activeArtifact ?? artifacts[0]?.id ?? null}
            setActive={(id) => {
              if (conversation) {
                setConversations((prev) => prev.map((c) => (c.id === conversation.id ? { ...c, activeArtifact: id } : c)));
              }
            }}
            onClose={() => setArtifactOpen(false)}
            usage={auth}
            sessionUsage={sessionUsage.current}
            onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
          />
          <div className="scrim" id="scrim" />
        </div>

        <div className="toast" id="toast" role="status" aria-live="polite">{toast}</div>

        {settingsOpen && (
          <SettingsModal
            tab={settingsTab}
            setTab={setSettingsTab}
            onClose={() => setSettingsOpen(false)}
            version={version}
            auth={auth}
            models={models}
            workspaceRoot={workspaceRoot}
            setWorkspaceRoot={(dir) => { setWorkspaceRoot(dir); void startSession(dir); }}
            reloadModels={reloadModels}
            reloadAuth={reloadAuth}
          />
        )}

        {authOpen && <AuthDialog onClose={() => setAuthOpen(false)} onPaired={() => { setAuthOpen(false); void reloadAuth(); }} />}

        {approval && (
          <div className="modal-overlay">
            <div className="auth-dialog" role="dialog" aria-modal="true">
              <header className="auth-dialog-header">
                <div className="auth-dialog-brand">
                  <svg className="ico"><use href="#i-shield" /></svg>
                  <span className="auth-dialog-title">Approve {approval.toolName}?</span>
                </div>
              </header>
              <div className="auth-dialog-body">
                <pre className="tool-input">{typeof approval.input === "string" ? approval.input : JSON.stringify(approval.input, null, 1)}</pre>
                <div className="auth-actions">
                  <button type="button" className="btn-primary" onClick={() => decide(true)}>Approve</button>
                  <button type="button" className="btn-secondary" onClick={() => decide(false)}>Deny</button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
