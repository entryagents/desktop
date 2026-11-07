import { useState } from "react";
import { bridge, type SidecarAuthStatus, type SidecarModel } from "../lib/bridge";
import { MODES } from "../lib/types";

interface Props {
  tab: string;
  setTab: (t: string) => void;
  onClose: () => void;
  version: string;
  auth: SidecarAuthStatus | null;
  models: SidecarModel[];
  workspaceRoot: string;
  setWorkspaceRoot: (dir: string) => void;
  reloadModels: () => void;
  reloadAuth: () => void;
}

export default function SettingsModal({
  tab,
  setTab,
  onClose,
  version,
  auth,
  models,
  workspaceRoot,
  setWorkspaceRoot,
  reloadModels,
  reloadAuth,
}: Props) {
  const [pairing, setPairing] = useState(false);

  const startPairing = async () => {
    setPairing(true);
    try {
      const res = (await bridge.call("pair.start")) as {
        alreadyPaired?: boolean;
        user_code?: string;
        verification_uri?: string;
      };
      if (res?.verification_uri) bridge.openExternal(res.verification_uri);
    } finally {
      setPairing(false);
    }
  };

  const tabs = ["general", "account", "models", "permissions", "usage", "about"];

  return (
    <div className="settings-overlay" hidden={false}>
      <div className="settings-modal" role="dialog" aria-modal="true">
        <header className="settings-header">
          <div className="settings-title-group">
            <svg className="ico"><use href="#i-logo" /></svg>
            <span className="settings-title">Settings</span>
            <span className="settings-badge">Entry Agents v{version}</span>
          </div>
          <div className="settings-header-actions">
            <span className="settings-kbd-hint"><kbd>Esc</kbd> to close</span>
            <button type="button" className="icon-btn" aria-label="Close Settings" title="Close Settings" onClick={onClose}>
              <svg className="ico"><use href="#i-x" /></svg>
            </button>
          </div>
        </header>
        <div className="settings-body">
          <nav className="settings-sidebar" aria-label="Settings Categories">
            {tabs.map((t) => (
              <button key={t} type="button" className={`settings-tab-btn${tab === t ? " is-active" : ""}`} onClick={() => setTab(t)}>
                <svg className="ico"><use href={t === "general" ? "#i-settings" : t === "account" ? "#i-logo" : t === "models" ? "#i-cpu" : t === "permissions" ? "#i-shield" : t === "usage" ? "#i-activity" : "#i-notes"} /></svg>
                <span>{t === "general" ? "General" : t === "account" ? "Account" : t === "models" ? "Models" : t === "permissions" ? "Permissions" : t === "usage" ? "Usage" : "About"}</span>
              </button>
            ))}
          </nav>
          <div className="settings-panel-container">
            {tab === "general" && (
              <section className="settings-panel">
                <h3>Workspace</h3>
                <div className="settings-row">
                  <div className="settings-row-text">
                    <span className="settings-row-title">Workspace root</span>
                    <span className="settings-row-desc">The agent works inside this folder on your machine.</span>
                  </div>
                  <div className="settings-row-action">
                    <input className="settings-input" value={workspaceRoot} readOnly placeholder="No folder chosen" />
                    <button type="button" className="btn-secondary" onClick={async () => {
                      const dir = await bridge.pickDirectory();
                      if (dir) setWorkspaceRoot(dir);
                    }}>Browse</button>
                  </div>
                </div>
                <h3>Behavior</h3>
                <div className="settings-row">
                  <div className="settings-row-text">
                    <span className="settings-row-title">Follow-up behavior</span>
                    <span className="settings-row-desc">Ask before each action or let the agent run autonomously.</span>
                  </div>
                  <div className="settings-row-action">
                    <span className="settings-pill-sm">{MODES[0].name.split(" ")[0]}</span>
                  </div>
                </div>
              </section>
            )}
            {tab === "account" && (
              <section className="settings-panel">
                <h3>Account</h3>
                {auth?.paired ? (
                  <>
                    <div className="settings-row">
                      <div className="settings-row-text">
                        <span className="settings-row-title">{auth.email}</span>
                        <span className="settings-row-desc">{auth.plan ?? "free"} plan · ${((auth.creditsCents ?? 0) / 100).toFixed(2)} credit</span>
                      </div>
                      <div className="settings-row-action">
                        <button type="button" className="btn-secondary" onClick={async () => { await bridge.call("auth.signout"); reloadAuth(); }}>
                          Sign out
                        </button>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="settings-row">
                    <div className="settings-row-text">
                      <span className="settings-row-title">Not signed in</span>
                      <span className="settings-row-desc">Pair this desktop with your Entry account.</span>
                    </div>
                    <div className="settings-row-action">
                      <button type="button" className="btn-primary" disabled={pairing} onClick={startPairing}>
                        {pairing ? "Pairing…" : "Sign in"}
                      </button>
                    </div>
                  </div>
                )}
              </section>
            )}
            {tab === "models" && (
              <section className="settings-panel">
                <h3>Models</h3>
                <div className="settings-row">
                  <div className="settings-row-text">
                    <span className="settings-row-title">Catalog</span>
                    <span className="settings-row-desc">{models.length} models from the Entry gateway</span>
                  </div>
                  <div className="settings-row-action">
                    <button type="button" className="btn-secondary" onClick={reloadModels}>Sync models</button>
                  </div>
                </div>
                {models.map((m) => (
                  <div key={m.id} className="settings-row">
                    <div className="settings-row-text">
                      <span className="settings-row-title">{m.name}</span>
                      <span className="settings-row-desc">{m.id} · {Math.round(m.context_window / 1000)}k context</span>
                    </div>
                  </div>
                ))}
              </section>
            )}
            {tab === "permissions" && (
              <section className="settings-panel">
                <h3>Permissions</h3>
                <p className="settings-note">
                  Ask — approve shell commands, file edits, and web requests before they run.
                  Rules you approve with &ldquo;always&rdquo; persist here. Full rule editor arrives in beta.2.
                </p>
              </section>
            )}
            {tab === "usage" && (
              <section className="settings-panel">
                <h3>Usage</h3>
                <div className="settings-row">
                  <div className="settings-row-text">
                    <span className="settings-row-title">Balance</span>
                    <span className="settings-row-desc">
                      {auth?.paired ? `$${((auth.creditsCents ?? 0) / 100).toFixed(2)} credit` : "Sign in to see usage"}
                    </span>
                  </div>
                </div>
              </section>
            )}
            {tab === "about" && (
              <section className="settings-panel">
                <h3>About</h3>
                <div className="settings-row">
                  <div className="settings-row-text">
                    <span className="settings-row-title">Entry Agents</span>
                    <span className="settings-row-desc">Version {version} · Local agent runtime · Paired via Entry API</span>
                  </div>
                </div>
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
