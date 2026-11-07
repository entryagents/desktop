import type { ConnectOptions } from "../factory.ts";
import { NovitaClient } from "./client.ts";
import { NovitaSandbox } from "./sandbox.ts";
import type { NovitaState } from "./state.ts";
import {
  NOVITA_DEFAULT_TEMPLATE,
  NOVITA_WORKING_DIRECTORY,
  isNovitaConfigured,
} from "./config.ts";

function shellEscape(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

async function prepareWorkspace(
  sandbox: NovitaSandbox,
  state: { type: "novita" } & NovitaState,
  options?: ConnectOptions,
): Promise<void> {
  if (options?.skipGitWorkspaceBootstrap) {
    return;
  }

  const source = state.source;
  const git =
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraheader GIT_CONFIG_VALUE_0="Authorization: Bearer ${GITHUB_TOKEN:-}" git';

  if (source?.repo) {
    const hasRepository = await sandbox.exec(
      `test -d ${shellEscape(`${NOVITA_WORKING_DIRECTORY}/.git`)}`,
      NOVITA_WORKING_DIRECTORY,
      30_000,
    );
    const branch = source.branch
      ? ` --branch ${shellEscape(source.branch)}`
      : "";
    if (hasRepository.success) {
      if (options?.githubToken) {
        const fetchCmd =
          `${git} -C ${shellEscape(NOVITA_WORKING_DIRECTORY)} fetch --all --prune` +
          (source.branch
            ? ` && ${git} -C ${shellEscape(NOVITA_WORKING_DIRECTORY)} checkout ${shellEscape(source.branch)}`
            : "");
        const fetchRes = await sandbox.exec(
          fetchCmd,
          NOVITA_WORKING_DIRECTORY,
          60_000,
        );
        if (!fetchRes.success) {
          console.warn(
            "[novita] Workspace git fetch warning:",
            fetchRes.stderr,
          );
        }
      }
    } else {
      const command = `${git} clone${branch} ${shellEscape(source.repo)} ${shellEscape(NOVITA_WORKING_DIRECTORY)}`;
      const result = await sandbox.exec(
        command,
        NOVITA_WORKING_DIRECTORY,
        180_000,
      );
      if (!result.success) {
        throw new Error(`Failed to prepare workspace: ${result.stderr.trim()}`);
      }
    }

    if (source.newBranch) {
      const checkout = await sandbox.exec(
        `git checkout -B ${shellEscape(source.newBranch)}`,
        NOVITA_WORKING_DIRECTORY,
        30_000,
      );
      if (!checkout.success) {
        throw new Error(`Failed to create branch: ${checkout.stderr.trim()}`);
      }
    }
  }
}

export async function connectNovita(
  state: { type: "novita" } & NovitaState,
  options?: ConnectOptions,
): Promise<NovitaSandbox> {
  if (!isNovitaConfigured()) {
    throw new Error(
      "Novita AI sandbox is not configured: NOVITA_API_KEY environment variable is missing.",
    );
  }

  const client = new NovitaClient();
  let sandboxId = state.sandboxId;

  if (!sandboxId) {
    const created = await client.createSandbox({
      template: state.template ?? NOVITA_DEFAULT_TEMPLATE,
      timeoutSeconds: 3600,
    });
    sandboxId = created.sandboxId;
    state.sandboxId = sandboxId;
  } else {
    await client.resumeSandbox(sandboxId).catch(() => {});
  }

  const sandbox = new NovitaSandbox(client, sandboxId, options);

  await sandbox.mkdir(NOVITA_WORKING_DIRECTORY, { recursive: true });
  await prepareWorkspace(sandbox, state, options);

  await options?.hooks?.afterStart?.(sandbox);

  return sandbox;
}
