import { useState } from "react";
import type { Artifact, ToolCall } from "../lib/types";
import { mdToHtml } from "../lib/markdown";
import type { SidecarAuthStatus } from "../lib/bridge";

interface Props {
  artifacts: Artifact[];
  activeId: string | null;
  setActive: (id: string | null) => void;
  onClose: () => void;
  usage: SidecarAuthStatus | null;
  sessionUsage: { inputTokens: number; cachedInputTokens: number; outputTokens: number } | null;
  onToggleSidebar: () => void;
}

function ToolArtifact({ toolCall }: { toolCall: ToolCall }) {
  return (
    <div className="tool-detail">
      <div className="tool-head">
        <svg className="ico"><use href="#i-terminal" /></svg>
        <span className="tool-name">{toolCall.toolName}</span>
      </div>
      <pre className="tool-input">{typeof toolCall.input === "string" ? toolCall.input : JSON.stringify(toolCall.input, null, 1)}</pre>
      {toolCall.output !== undefined && (
        <pre className="tool-output">{typeof toolCall.output === "string" ? toolCall.output.slice(0, 8000) : JSON.stringify(toolCall.output, null, 1).slice(0, 8000)}</pre>
      )}
      {toolCall.errorText && <pre className="tool-output is-error">{toolCall.errorText}</pre>}
    </div>
  );
}

function UsageView({ usage, sessionUsage }: { usage: SidecarAuthStatus | null; sessionUsage: { inputTokens: number; cachedInputTokens: number; outputTokens: number } | null }) {
  return (
    <div className="usage-view">
      <div className="usage-grid">
        <div className="usage-card">
          <span className="usage-label">Account</span>
          <span className="usage-value">{usage?.paired ? usage.email : "Not signed in"}</span>
        </div>
        <div className="usage-card">
          <span className="usage-label">Plan</span>
          <span className="usage-value">{usage?.paired ? `${usage.plan ?? "free"}` : "—"}</span>
        </div>
        <div className="usage-card">
          <span className="usage-label">Credit balance</span>
          <span className="usage-value">
            {usage?.paired ? `$${((usage.creditsCents ?? 0) / 100).toFixed(2)}` : "—"}
          </span>
        </div>
        <div className="usage-card">
          <span className="usage-label">This session</span>
          <span className="usage-value">
            {sessionUsage
              ? `${sessionUsage.inputTokens.toLocaleString()} in · ${sessionUsage.outputTokens.toLocaleString()} out`
              : "No usage yet"}
          </span>
        </div>
      </div>
    </div>
  );
}

export default function ArtifactPanel({ artifacts, activeId, setActive, onClose, usage, sessionUsage, onToggleSidebar }: Props) {
  const [expanded, setExpanded] = useState(false);
  const active = artifacts.find((a) => a.id === activeId) ?? null;

  return (
    <section className="artifact" id="artifact" aria-label="Artifacts" data-expanded={expanded ? "true" : "false"}>
      <div className="art-tabs">
        <button type="button" className="icon-btn btn-art-back" aria-label="Show sidebar" title="Show sidebar" onClick={onToggleSidebar}>
          <svg className="ico"><use href="#i-sidebar" /></svg>
        </button>
        <div className="tabs" role="tablist" aria-label="Open artifacts">
          {artifacts.map((a: Artifact) => (
            <button key={a.id} type="button" role="tab" className={`tab${a.id === activeId ? " is-active" : ""}`}
              aria-selected={a.id === activeId} onClick={() => setActive(a.id)}>
              {a.title}
            </button>
          ))}
        </div>
        <span className="sp" />
        <button type="button" className="icon-btn btn-expand" aria-label="Expand panel" title="Expand"
          aria-pressed={expanded} onClick={() => setExpanded(!expanded)}>
          <svg className="ico"><use href={expanded ? "#i-minimize" : "#i-maximize"} /></svg>
        </button>
        <button type="button" className="icon-btn" aria-label="Hide panel" title="Hide panel" onClick={onClose}>
          <svg className="ico"><use href="#i-panel-right" /></svg>
        </button>
      </div>
      <div className="art-sub">
        <span id="artSubTitle">{active?.title ?? "Artifact"}</span>
      </div>
      <div className="art-body" id="artBody">
        {!active && <div className="art-empty">Nothing open — tool results and views appear here.</div>}
        {active?.type === "markdown" && <div className="md" dangerouslySetInnerHTML={{ __html: mdToHtml(active.content ?? "") }} />}
        {active?.type === "tool" && active.toolCall && <ToolArtifact toolCall={active.toolCall} />}
        {active?.type === "usage" && <UsageView usage={usage} sessionUsage={sessionUsage} />}
        {active?.type === "integrations" && (
          <div className="md">
            <h3>Integrations</h3>
            <p>GitHub and Vercel connections arrive after beta.1.</p>
          </div>
        )}
      </div>
    </section>
  );
}
