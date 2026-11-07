import { useEffect, useState } from "react";
import type { ToolCall } from "../lib/types";
import { statusOf, toolIconHref, toolTitle } from "../lib/tool-summary";

interface Props {
  toolCall: ToolCall;
  onOpen?: (tc: ToolCall) => void;
}

/** ToolLayout equivalent — status dot + tool name + summary line, expandable. */
export default function ToolCard({ toolCall, onOpen }: Props) {
  const [open, setOpen] = useState(false);
  const status = statusOf(toolCall);
  const hasBody = toolCall.input != null || toolCall.output !== undefined || toolCall.errorText;

  return (
    <div className={`tool-card${toolCall.errorText ? " is-error" : ""}${toolCall.toolName === "task" ? " is-subagent" : ""}`}>
      <button
        type="button"
        className="tool-head"
        onClick={() => (onOpen && !open && toolCall.output !== undefined ? onOpen(toolCall) : setOpen(!open))}
      >
        <span className={status.className} />
        <svg className="ico">
          <use href={toolCall.toolName === "task" ? "#i-sparkles" : toolIconHref(toolCall)} />
        </svg>
        <span className="tool-name">{toolCall.toolName === "task" ? "subagent" : toolCall.toolName}</span>
        <span className="tool-summary">{toolTitle(toolCall)}</span>
        <span className="tool-status">{status.label}</span>
        {hasBody && <svg className="ico chev"><use href={open ? "#i-chev-up" : "#i-chev-down"} /></svg>}
      </button>
      {open && (
        <div className="tool-body">
          {toolCall.input != null && (
            <pre className="tool-input">{typeof toolCall.input === "string" ? toolCall.input : JSON.stringify(toolCall.input, null, 1)}</pre>
          )}
          {toolCall.output !== undefined && (
            <pre className="tool-output">{typeof toolCall.output === "string" ? toolCall.output.slice(0, 4000) : JSON.stringify(toolCall.output, null, 1).slice(0, 4000)}</pre>
          )}
          {toolCall.errorText && <pre className="tool-output is-error">{toolCall.errorText}</pre>}
        </div>
      )}
    </div>
  );
}
