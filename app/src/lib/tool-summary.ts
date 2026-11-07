import type { ToolCall } from "./types";

/** Per-tool one-line summaries — mirrors apps/web tool-call renderers. */
export function toolTitle(tc: ToolCall): string {
  const input = (tc.input ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  switch (tc.toolName) {
    case "bash":
      return s("command") || s("script") || "shell";
    case "read":
      return relPath(s("filePath") || s("path"));
    case "write":
    case "edit":
      return relPath(s("filePath") || s("path"));
    case "grep":
      return s("pattern") || "search";
    case "glob":
      return s("pattern") || "glob";
    case "web_fetch":
      return s("url") || "fetch";
    case "web_search":
      return s("query") || s("search") || "search";
    case "todo_write":
      return "Task list updated";
    case "task":
      return s("description") || s("prompt")?.slice(0, 60) || "subagent";
    default:
      return tc.toolName;
  }
}

export function toolIconHref(tc: ToolCall): string {
  switch (tc.toolName) {
    case "bash":
      return "#i-terminal";
    case "read":
    case "write":
    case "edit":
      return "#i-file";
    case "web_fetch":
    case "web_search":
      return "#i-globe";
    case "task":
      return "#i-sparkles";
    case "todo_write":
      return "#i-notes";
    default:
      return "#i-cpu";
  }
}

/** Mirrors shared/lib/tool-state.toRelativePath. */
export function relPath(p: string, cwd?: string): string {
  if (!p) return "";
  if (cwd) {
    const norm = p.replaceAll("\\", "/");
    const c = cwd.replaceAll("\\", "/").replace(/\/$/, "");
    if (norm.toLowerCase().startsWith(c.toLowerCase() + "/")) return norm.slice(c.length + 1);
  }
  const parts = p.split(/[\\/]/);
  return parts.slice(-2).join("/");
}

/** Status dot classes — mirrors web ToolLayout semantics. */
export function statusOf(tc: ToolCall): { label: string; className: string } {
  if (tc.errorText) return { label: "error", className: "tool-dot is-error" };
  if (tc.output !== undefined) return { label: "done", className: "tool-dot is-done" };
  return { label: "running", className: "tool-dot is-running" };
}
