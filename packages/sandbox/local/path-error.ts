/**
 * Thrown when a path handed to LocalSandbox escapes every allowed root.
 *
 * Echoes only the caller-provided string, never the resolved host path,
 * realpath, or symlink target: the caller (often a model) needs to know the
 * path is outside the workspace, and filesystem layout is not its business.
 */
export class LocalSandboxPathError extends Error {
  readonly code = "LOCAL_SANDBOX_PATH_OUTSIDE_ROOT";
  constructor(received: string) {
    super(
      `Path "${received}" is outside the allowed workspace roots for this sandbox.`,
    );
    this.name = "LocalSandboxPathError";
  }
}
