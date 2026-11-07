export interface Model {
  id: string;
  name: string;
  context_window: number;
  max_output_tokens: number;
  pricing?: { input?: number; output?: number } | null;
}

export interface Mode {
  id: string;
  name: string;
  desc: string;
}

export const MODES: Mode[] = [
  { id: "turbo", name: "Turbo (Auto)", desc: "Auto-approves safe and non-denied operations" },
  { id: "balanced", name: "Balanced (Default)", desc: "Auto-approves safe reads/writes; asks on shell & network" },
  { id: "review", name: "Review (Strict)", desc: "Prompts for confirmation before every single tool call" },
];

export const SUGGESTIONS = [
  "Review my repo and list the riskiest modules",
  "Add retry logic to the upload endpoint",
  "Explain how the auth middleware works",
];

export interface ToolCall {
  toolCallId: string;
  toolName: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

export interface Turn {
  role: "user" | "assistant";
  text: string;
  reasoning?: string;
  toolCalls: ToolCall[];
  streaming?: boolean;
  usage?: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
}

export interface Artifact {
  id: string;
  title: string;
  type: "markdown" | "tool" | "integrations" | "usage";
  content?: string;
  toolCall?: ToolCall;
}

export interface Conversation {
  id: string;
  title: string;
  time: string;
  turns: Turn[];
  artifacts: Artifact[];
  activeArtifact: string | null;
}

export function newConversation(title = "New Conversation"): Conversation {
  return {
    id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    title,
    time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    turns: [],
    artifacts: [],
    activeArtifact: null,
  };
}
