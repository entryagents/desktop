import { useEffect, useRef, useState } from "react";
import type { Conversation, Model } from "../lib/types";
import { MODES, SUGGESTIONS } from "../lib/types";
import { mdToHtml } from "../lib/markdown";
import ToolCard from "./ToolCard";
import ThinkingBlock from "./ThinkingBlock";

const STATUS_PAIRS: Array<[string, string]> = [
  ["Pondering", "Pondered"],
  ["Crafting", "Crafted"],
  ["Vibing", "Vibed"],
  ["Simmering", "Simmered"],
  ["Marinating", "Marinated"],
  ["Ruminating", "Ruminated"],
];

interface Props {
  conversation: Conversation | null;
  models: Model[];
  modelIdx: number;
  setModelIdx: (i: number) => void;
  modeIdx: number;
  setModeIdx: (i: number) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  streaming: boolean;
  onToggleSidebar: () => void;
  onToggleArtifact: () => void;
}

export default function Chat({
  conversation,
  models,
  modelIdx,
  setModelIdx,
  modeIdx,
  setModeIdx,
  onSend,
  onStop,
  streaming,
  onToggleSidebar,
  onToggleArtifact,
}: Props) {
  const [input, setInput] = useState("");
  const [picker, setPicker] = useState<null | "model" | "mode">(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [conversation?.turns]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    onSend(text);
  };

  const model = models[modelIdx];
  const mode = MODES[modeIdx];

  return (
    <main className="chat" id="chat">
      <header className="chat-head">
        <button type="button" className="icon-btn btn-sb-open" aria-label="Show sidebar" title="Show sidebar" onClick={onToggleSidebar}>
          <svg className="ico"><use href="#i-sidebar" /></svg>
        </button>
        <h1 className="chat-title">{conversation?.title ?? "Entry Desktop"}</h1>
        <button type="button" className="icon-btn" aria-label="Toggle artifact panel" title="Toggle artifact panel" onClick={onToggleArtifact}>
          <svg className="ico"><use href="#i-notes" /></svg>
        </button>
      </header>
      <div className="transcript-wrap">
        <div className="transcript" id="transcript" ref={transcriptRef} tabIndex={0} aria-label="Conversation">
          {!conversation?.turns.length && (
            <div className="empty-state">
              <h2>What should we build?</h2>
              <div className="suggestions">
                {SUGGESTIONS.map((s) => (
                  <button type="button" key={s} className="suggestion" onClick={() => setInput(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {conversation?.turns.map((turn, i) => (
            <div key={i} className={`turn turn-${turn.role}`}>
              {turn.role === "user" ? (
                <div className="msg-user">{turn.text}</div>
              ) : (
                <div className="msg-assistant">
                  {turn.reasoning && <ThinkingBlock text={turn.reasoning} streaming={Boolean(turn.streaming)} />}
                  {turn.text && (
                    <div className="md" dangerouslySetInnerHTML={{ __html: mdToHtml(turn.text) }} />
                  )}
                  {turn.toolCalls.map((tc) => (
                    <ToolCard key={tc.toolCallId} toolCall={tc} />
                  ))}
                  {turn.streaming && !turn.text && (
                    <span className="status-bar">
                      {STATUS_PAIRS[i % STATUS_PAIRS.length][0]}…
                    </span>
                  )}
                  {turn.streaming && turn.text && <span className="typing" aria-label="Thinking"><i /><i /><i /></span>}
                  {turn.usage && !turn.streaming && (
                    <div className="msg-usage">
                      {turn.usage.inputTokens.toLocaleString()} in · {turn.usage.outputTokens.toLocaleString()} out
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
        <button type="button" className="jump" aria-label="Scroll to latest" title="Scroll to latest"
          onClick={() => transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" })}>
          <svg className="ico"><use href="#i-arrow-down" /></svg>
        </button>
      </div>
      <div className="composer-wrap">
        <form className="composer" autoComplete="off" noValidate onSubmit={submit}>
          <textarea
            id="input"
            rows={1}
            aria-label="Message"
            placeholder="Ask anything, @ to mention, / for workflows"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit(e as unknown as React.FormEvent);
              }
            }}
          />
          <div className="c-row">
            <button type="button" className="chip" title="Choose model" onClick={() => setPicker(picker === "model" ? null : "model")}>
              <span className="lbl">{model?.name ?? "Model"}</span>
              <svg className="ico chev"><use href="#i-chev-up" /></svg>
            </button>
            <span className="c-sp" />
            <button type="button" className="chip" title="Agent autonomy" onClick={() => setPicker(picker === "mode" ? null : "mode")}>
              <svg className="ico"><use href="#i-shield" /></svg>
              <span className="lbl">{mode?.name}</span>
              <svg className="ico chev"><use href="#i-chev-up" /></svg>
            </button>
            {streaming ? (
              <button type="button" className="send is-stop" aria-label="Stop" title="Stop" onClick={onStop}>
                <svg className="ico"><use href="#i-stop" /></svg>
              </button>
            ) : (
              <button type="submit" className="send" aria-label="Send message" title="Send" disabled={!input.trim()}>
                <svg className="ico"><use href="#i-arrow-right" /></svg>
              </button>
            )}
          </div>
          {picker === "model" && (
            <div className="pop is-up" role="menu">
              {models.map((m, i) => (
                <button type="button" key={m.id} role="menuitem" className={i === modelIdx ? "is-checked" : ""}
                  onClick={() => { setModelIdx(i); setPicker(null); }}>
                  <span className="stack"><span className="lbl">{m.name}</span><span className="hint">{m.id} · {Math.round(m.context_window / 1000)}k</span></span>
                </button>
              ))}
              {!models.length && <div className="is-note">Sign in to load the model catalog</div>}
            </div>
          )}
          {picker === "mode" && (
            <div className="pop is-up" role="menu">
              {MODES.map((m, i) => (
                <button type="button" key={m.id} role="menuitem" className={i === modeIdx ? "is-checked" : ""}
                  onClick={() => { setModeIdx(i); setPicker(null); }}>
                  <span className="stack"><span className="lbl">{m.name}</span><span className="hint">{m.desc}</span></span>
                </button>
              ))}
            </div>
          )}
        </form>
      </div>
    </main>
  );
}
