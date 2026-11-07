import type { LocalState } from "./local/state.ts";
import type { ModalState } from "./modal/state.ts";
import type { BoxdState } from "./boxd/state.ts";
import type { NovitaState } from "./novita/state.ts";

/**
 * Unified sandbox state type. Use the `type` discriminator to determine
 * which sandbox implementation to use. Persisted verbatim in
 * `sessions.sandbox_state` (jsonb), so the discriminator is the durable
 * record of which provider owns a session.
 *
 * "boxd" -- persistent hardware-isolated Linux workspace machine.
 *
 * "novita" -- remote Novita AI Firecracker microVM container.
 *
 * "modal" -- remote Modal sandbox (gVisor container) with the workspace
 * on a persistent Modal Volume.
 *
 * "local" -- plain local directory + child_process, no remote
 * provisioning. Only used by local dev/test tooling.
 */
export type SandboxState =
  | ({ type: "boxd" } & BoxdState)
  | ({ type: "novita" } & NovitaState)
  | ({ type: "modal" } & ModalState)
  | ({ type: "local" } & LocalState);
