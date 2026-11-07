import { useState } from "react";
import type { Conversation } from "../lib/types";

interface Props {
  conversations: Conversation[];
  activeId: string | null;
  user: { email?: string; name?: string; plan?: string; paired: boolean } | null;
  openNew: () => void;
  openConversation: (id: string) => void;
  openSettings: (tab: string) => void;
  openBilling: () => void;
  onToggleSidebar: () => void;
}

export default function Sidebar({
  conversations,
  activeId,
  user,
  openNew,
  openConversation,
  openSettings,
  openBilling,
  onToggleSidebar,
}: Props) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const filtered = conversations.filter((c) =>
    c.title.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <aside className="sidebar" id="sidebar" aria-label="Sidebar">
      <div className="sb-top">
        <span className="logo" aria-hidden>
          <svg className="ico"><use href="#i-logo" /></svg>
        </span>
        <button type="button" className="icon-btn" id="btnSbToggle" aria-label="Hide sidebar" title="Hide sidebar" onClick={onToggleSidebar}>
          <svg className="ico"><use href="#i-sidebar" /></svg>
        </button>
        <button type="button" className="icon-btn" aria-label="Search conversations" title="Search" onClick={() => setSearchOpen(!searchOpen)}>
          <svg className="ico"><use href="#i-search" /></svg>
        </button>
      </div>
      <div className="sb-body">
        {searchOpen && (
          <div className="search">
            <svg className="ico"><use href="#i-search" /></svg>
            <input
              type="search"
              placeholder="Search conversations"
              autoComplete="off"
              aria-label="Search conversations"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
          </div>
        )}
        <button type="button" className="new-chat" onClick={openNew}>
          <svg className="ico"><use href="#i-plus" /></svg>
          <span>New Conversation</span>
        </button>
        <nav className="nav" aria-label="Workspace">
          <button type="button" className="nav-item" onClick={() => openSettings("usage")}>
            <svg className="ico"><use href="#i-activity" /></svg>
            <span>Usage &amp; Telemetry</span>
          </button>
        </nav>

        <div className="sec-head first"><span>Conversations</span>
          <span className="sec-actions">
            <button type="button" className="icon-btn sm" aria-label="New conversation" title="New conversation" onClick={openNew}>
              <svg className="ico"><use href="#i-plus" /></svg>
            </button>
          </span>
        </div>
        <div className="conv-list" id="convList">
          {filtered.map((c) => (
            <button
              type="button"
              key={c.id}
              className={`conv-item${c.id === activeId ? " is-active" : ""}`}
              onClick={() => openConversation(c.id)}
            >
              <span className="conv-title">{c.title}</span>
              <span className="conv-time">{c.time}</span>
            </button>
          ))}
          {!filtered.length && <div className="conv-empty">No conversations yet</div>}
        </div>
      </div>
      <div className="sb-foot">
        <button type="button" className="user-profile-btn" title="Account & Profile" onClick={() => openSettings("account")}>
          <span className="user-avatar">{(user?.name ?? user?.email ?? "E").slice(0, 1).toUpperCase()}</span>
          <span className="user-info">
            <span className="user-name">{user?.name || user?.email || "Not signed in"}</span>
            <span className="user-plan">{user?.paired ? `${user.plan ?? "Free"} Tier` : "Sign in"}</span>
          </span>
          <span className="user-status-dot" data-paired={user?.paired ? "true" : "false"} />
        </button>
        <div className="sb-foot-row">
          <button type="button" className="nav-item" onClick={() => openSettings("general")}>
            <svg className="ico"><use href="#i-settings" /></svg>
            <span>Settings</span>
          </button>
          <button type="button" className="nav-item nav-billing" title="Opens external billing and pricing in browser" onClick={openBilling}>
            <svg className="ico"><use href="#i-credit-card" /></svg>
            <span>Billing</span>
            <svg className="ico ico-ext"><use href="#i-external-link" /></svg>
          </button>
        </div>
      </div>
    </aside>
  );
}
