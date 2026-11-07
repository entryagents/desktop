import { tool } from "ai";
import { z } from "zod";
import { isAgentContext, getSandbox, shellEscape } from "./utils";
import type { SandboxControlToolResult } from "../types";

/**
 * The actions this tool exposes.
 *
 * Pruned from the original set: `migrate` and `extend`.
 *
 *   - migrate: the workspace lives on a persistent Modal Volume, so
 *     re-provisioning a sandbox remounts the same files and there is no
 *     workspace to migrate. `connect()` already re-provisions
 *     automatically when a recorded sandbox has expired, so an
 *     agent-callable migrate would be a no-op that only risks killing
 *     in-flight work for nothing.
 *   - extend: Modal accepts `timeout`/`idle_timeout` only at creation,
 *     both bounded by the 24h hard cap, so there is no way to stretch a
 *     running sandbox from outside. The action existed only to paper
 *     over providers that needed it.
 *
 * `status`, `provision` and `reconnect` remain because they are the ones
 * the agent genuinely needs: a lazily-provisioned workspace has to be
 * started, and "is it running / paused / missing" is what every other
 * decision is based on. `snapshot` and `delete` stay destructive-but-
 * genuine (the host implements both through the same code the UI uses).
 */
const sandboxActionSchema = z.enum([
  "status",
  "provision",
  "reconnect",
  "snapshot",
  "delete",
  "serve",
  "stop_serve",
  "ps",
  "kill_process",
  "env_get",
  "env_set",
]);

const sandboxControlInputSchema = z.object({
  action: sandboxActionSchema.describe(
    "Which workspace operation to run: 'status' (read-only), 'serve' (start/check persistent dev server), 'stop_serve' (stop dev server), 'ps' (list processes), 'kill_process' (kill by PID or port), 'env_get'/'env_set' (session environment variables), 'provision', 'reconnect', 'snapshot', 'delete'.",
  ),
  port: z
    .number()
    .int()
    .optional()
    .describe("Port number (for serve, stop_serve, kill_process)"),
  processNameOrPid: z
    .string()
    .optional()
    .describe("Process name or PID to kill (for kill_process)"),
  envKey: z
    .string()
    .optional()
    .describe("Environment variable key (for env_get, env_set)"),
  envValue: z
    .string()
    .optional()
    .describe("Environment variable value (for env_set)"),
});

export type SandboxControlToolInput = z.infer<typeof sandboxControlInputSchema>;

/**
 * Agent-facing control of this session's workspace (sandbox) lifecycle.
 *
 * WHY THIS EXISTS (owner request): agents had no way to act on the
 * workspace itself -- they could only react when a tool failed. Provisioning
 * a session that never got a workspace, migrating one that is about to hit
 * its hard duration cap, extending one that is about to expire mid-task, or
 * tearing one down when it is no longer needed were all things the *user*
 * had to do by hand from the UI.
 *
 * Everything destructive (provision, migrate, delete) is executed by the
 * host through the SAME code paths the UI and the scheduled lifecycle
 * workflow use -- this tool only chooses which one to run and reports the
 * outcome. There is no second implementation of provisioning or migration
 * here to drift out of sync.
 *
 * `status` never mutates anything and needs no special permission.
 */
/**
 * Host results are spread FIRST and the tool's own envelope fields LAST.
 * The precedence matters: performSandboxMigration (and the provisioning
 * kick) return their own `action` field, which would otherwise overwrite
 * the action this tool reports and make the result unreadable to the model.
 */
function hostResult(
  host: Record<string, unknown>,
  action: string,
): SandboxControlToolResult {
  return { ...host, success: true, action };
}

export function sandboxControlTool() {
  return tool({
    description: `Control this session's workspace (sandbox) lifecycle: check its state, start/provision it, resume a paused one, snapshot it, or delete it.

ACTIONS:
- status: read-only. Returns whether the workspace is running, paused, or missing, its lifecycle state, and when it expires. ALWAYS call this first -- most lifecycle decisions are wrong without it.
- serve: start or get the persistent dev server for this session and returns its URL/port. Keeps running across steps so you can test/audit UI without needing rebuild cycles.
- stop_serve: stops the persistent dev server.
- ps: list running processes on the workspace to inspect resource usage or detect stuck servers.
- kill_process: kill a process by port (e.g. port: 3111) or processNameOrPid. Kills the entire process group cleanly so no zombie child processes remain.
- env_set: store a session-scoped environment variable or secret (key & value). Automatically loaded into all future bash tool calls.
- env_get: retrieve stored session-scoped environment variables.
- provision: start the workspace for this session. Use when status reports no workspace and the task needs file or shell access.
- reconnect: resume a paused/stopped workspace from its persisted state. Use when status reports paused and the task needs the files back.
- snapshot: capture a restorable snapshot of the workspace filesystem. Use before a risky change, or to preserve state you want to come back to.
- delete: stop and tear down the workspace. This DESTROYS uncommitted work -- only use it when the user explicitly asks, or when the workspace is confirmed empty/disposable.

The workspace is stored on a persistent volume, so it survives sandbox restarts and there is no migration or expiry extension to trigger -- a stopped sandbox is resumed with reconnect, and re-provisioning picks up the same files automatically.

IMPORTANT:
- These operations take effect for the whole session, not just your turn. Anything running in the workspace right now is interrupted.
- 'delete' is irreversible. Never delete on a guess -- confirm with the user first unless they asked for it.
- Provisioning is asynchronous: status may still report 'starting' immediately after you call it. Answer the user with what you know and let the workspace come up.`,
    inputSchema: sandboxControlInputSchema,
    execute: async (
      input,
      { experimental_context },
    ): Promise<SandboxControlToolResult> => {
      if (
        !isAgentContext(experimental_context) ||
        !experimental_context.sandboxControl
      ) {
        return {
          success: false,
          action: input.action,
          error:
            "Workspace lifecycle control isn't available in this environment.",
        };
      }

      const control = experimental_context.sandboxControl;

      try {
        switch (input.action) {
          case "status": {
            const status = await control.status();
            return hostResult(status, input.action);
          }
          case "provision": {
            const provisioned = await control.provision();
            return hostResult(provisioned, input.action);
          }
          case "reconnect": {
            const reconnected = await control.reconnect();
            return hostResult(reconnected, input.action);
          }
          case "snapshot": {
            const snapshotted = await control.snapshot();
            return hostResult(snapshotted, input.action);
          }
          case "delete": {
            const deleted = await control.delete();
            return hostResult(deleted, input.action);
          }
          case "serve": {
            if (control.serve) {
              const res = await control.serve({ port: input.port });
              return hostResult(res, input.action);
            }
            const sandbox = await getSandbox(experimental_context, "sandbox");
            const targetPort = input.port ?? 3000;
            const probe = await sandbox.exec(
              `lsof -i :${targetPort} -sTCP:LISTEN -t 2>/dev/null || true`,
              sandbox.workingDirectory,
              5000,
            );
            const pid = probe.stdout.trim();
            if (pid) {
              return hostResult(
                {
                  running: true,
                  port: targetPort,
                  pid,
                  url: `http://localhost:${targetPort}`,
                },
                input.action,
              );
            }
            if (sandbox.execDetached) {
              const { commandId } = await sandbox.execDetached(
                `npm run dev -- -p ${targetPort}`,
                sandbox.workingDirectory,
              );
              return hostResult(
                {
                  running: true,
                  port: targetPort,
                  commandId,
                  url: `http://localhost:${targetPort}`,
                },
                input.action,
              );
            }
            return hostResult(
              {
                running: false,
                error: "Detached background execution not supported",
              },
              input.action,
            );
          }
          case "stop_serve": {
            if (control.stop_serve) {
              const res = await control.stop_serve({ port: input.port });
              return hostResult(res, input.action);
            }
            const sandbox = await getSandbox(experimental_context, "sandbox");
            const targetPort = input.port ?? 3000;
            await sandbox.exec(
              `fuser -k -9 ${targetPort}/tcp 2>/dev/null || true`,
              sandbox.workingDirectory,
              5000,
            );
            return hostResult(
              { stopped: true, port: targetPort },
              input.action,
            );
          }
          case "ps": {
            if (control.ps) {
              const res = await control.ps();
              return hostResult(res, input.action);
            }
            const sandbox = await getSandbox(experimental_context, "sandbox");
            const res = await sandbox.exec(
              "ps aux --sort=-%cpu | head -n 30",
              sandbox.workingDirectory,
              10000,
            );
            return hostResult({ processes: res.stdout }, input.action);
          }
          case "kill_process": {
            if (control.kill_process) {
              const res = await control.kill_process({
                processNameOrPid: input.processNameOrPid,
                port: input.port,
              });
              return hostResult(res, input.action);
            }
            const sandbox = await getSandbox(experimental_context, "sandbox");
            if (input.port) {
              await sandbox.exec(
                `fuser -k -9 ${input.port}/tcp 2>/dev/null || (lsof -ti:${input.port} 2>/dev/null | xargs kill -9 2>/dev/null) || true`,
                sandbox.workingDirectory,
                5000,
              );
              return hostResult(
                { killed: true, port: input.port },
                input.action,
              );
            }
            if (input.processNameOrPid) {
              await sandbox.exec(
                `pkill -9 -f ${shellEscape(input.processNameOrPid)} || kill -9 ${input.processNameOrPid} 2>/dev/null || true`,
                sandbox.workingDirectory,
                5000,
              );
              return hostResult(
                { killed: true, target: input.processNameOrPid },
                input.action,
              );
            }
            return hostResult(
              {
                killed: false,
                error: "Provide port or processNameOrPid to kill",
              },
              input.action,
            );
          }
          case "env_set": {
            if (!input.envKey)
              throw new Error("envKey is required for env_set");
            if (control.env_set) {
              const res = await control.env_set({
                key: input.envKey,
                value: input.envValue ?? "",
              });
              return hostResult(res, input.action);
            }
            const sandbox = await getSandbox(experimental_context, "sandbox");
            const safeKey = input.envKey.replace(/[^a-zA-Z0-9_]/g, "");
            await sandbox.exec(
              `mkdir -p "$HOME" && echo "export ${safeKey}=${shellEscape(input.envValue ?? "")}" >> "$HOME/.entry_session_env"`,
              sandbox.workingDirectory,
              10000,
            );
            return hostResult({ key: safeKey, set: true }, input.action);
          }
          case "env_get": {
            if (control.env_get) {
              const res = await control.env_get({ key: input.envKey });
              return hostResult(res, input.action);
            }
            const sandbox = await getSandbox(experimental_context, "sandbox");
            const res = await sandbox.exec(
              `if [ -f "$HOME/.entry_session_env" ]; then cat "$HOME/.entry_session_env"; fi`,
              sandbox.workingDirectory,
              10000,
            );
            return hostResult({ env: res.stdout }, input.action);
          }
        }
      } catch (error) {
        return {
          success: false,
          action: input.action,
          error:
            error instanceof Error
              ? error.message
              : `Workspace ${input.action} failed`,
        };
      }
    },
  });
}
