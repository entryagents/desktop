import type { Source } from "../types.ts";

export interface NovitaState {
  /** Unique ID of the active Novita microVM sandbox instance. */
  sandboxId?: string;
  /** Novita container template or base image. */
  template?: string;
  /** Custom working directory inside the microVM. */
  workingDirectory?: string;
  /** Milliseconds epoch timestamp when the microVM expires. */
  expiresAt?: number;
  /** Source metadata (repository or template cloned into workspace). */
  source?: Source;
}
