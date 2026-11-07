import { Boxd } from "@boxd-sh/sdk";
import type { ConnectOptions } from "../factory.ts";
import type { Sandbox } from "../interface.ts";
import {
  BOXD_DISK,
  BOXD_MEMORY,
  BOXD_VCPU,
  BOXD_WORKING_DIRECTORY,
  isBoxdConfigured,
} from "./config.ts";
import type { BoxdState } from "./state.ts";
import { BoxdSandbox } from "./sandbox.ts";

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function bootstrapWorkspace(
  sandbox: BoxdSandbox,
  state: BoxdState,
  options?: ConnectOptions,
): Promise<void> {
  if (options?.skipGitWorkspaceBootstrap) {
    return;
  }

  const source = state.source;
  // Keep the repository credential in the machine environment rather than
  // embedding it in the remote URL or shell command. Git reads this config
  // from the environment for the duration of each clone/fetch only.
  // Shell parameter expansion inside the command string is intentional.
  // Shell parameter expansion inside the command string is intentional.
  /* oxlint-disable eslint/no-template-curly-in-string -- git http.extraheader
     value expands in the shell, not JS */
  const git =
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraheader GIT_CONFIG_VALUE_0="Authorization: Bearer ${GITHUB_TOKEN:-}" git';
  /* oxlint-enable eslint/no-template-curly-in-string */

  if (source?.repo) {
    // Do not send a compound if/then/else shell program to the provider. The
    // boxd command runner has historically parsed that form inconsistently,
    // producing `/bin/sh: then: unexpected` and wedging reconnects. Probe the
    // directory first, then issue one simple command per branch.
    const hasRepository = await sandbox.exec(
      `test -d ${shellEscape(`${BOXD_WORKING_DIRECTORY}/.git`)}`,
      BOXD_WORKING_DIRECTORY,
      30_000,
    );
    const branch = source.branch
      ? ` --branch ${shellEscape(source.branch)}`
      : "";
    if (hasRepository.success) {
      if (options?.githubToken) {
        const fetchCmd =
          `${git} -C ${shellEscape(BOXD_WORKING_DIRECTORY)} fetch --all --prune` +
          (source.branch
            ? ` && ${git} -C ${shellEscape(BOXD_WORKING_DIRECTORY)} checkout ${shellEscape(source.branch)}`
            : "");
        const fetchRes = await sandbox.exec(
          fetchCmd,
          BOXD_WORKING_DIRECTORY,
          60_000,
        );
        if (!fetchRes.success) {
          console.warn("[boxd] Workspace git fetch warning:", fetchRes.stderr);
        }
      }
    } else {
      const command = `${git} clone${branch} ${shellEscape(source.repo)} ${shellEscape(BOXD_WORKING_DIRECTORY)}`;
      const result = await sandbox.exec(
        command,
        BOXD_WORKING_DIRECTORY,
        180_000,
      );
      if (!result.success) {
        throw new Error(`Failed to prepare workspace: ${result.stderr.trim()}`);
      }
    }

    if (source.newBranch) {
      const checkout = await sandbox.exec(
        `git checkout -B ${shellEscape(source.newBranch)}`,
        BOXD_WORKING_DIRECTORY,
        30_000,
      );
      if (!checkout.success) {
        throw new Error(`Failed to create branch: ${checkout.stderr.trim()}`);
      }
    }
  } else {
    const result = await sandbox.exec(
      `test -d ${shellEscape(`${BOXD_WORKING_DIRECTORY}/.git`)} || git init ${shellEscape(BOXD_WORKING_DIRECTORY)}`,
      BOXD_WORKING_DIRECTORY,
      30_000,
    );
    if (!result.success) {
      throw new Error(
        `Failed to initialize workspace: ${result.stderr.trim()}`,
      );
    }
  }

  if (options?.gitUser) {
    const result = await sandbox.exec(
      `git config user.name ${shellEscape(options.gitUser.name)} && ` +
        `git config user.email ${shellEscape(options.gitUser.email)}`,
      BOXD_WORKING_DIRECTORY,
      30_000,
    );
    if (!result.success) {
      throw new Error(
        `Failed to configure git identity: ${result.stderr.trim()}`,
      );
    }
  }
}

export async function connectBoxd(
  state: BoxdState,
  options?: ConnectOptions,
): Promise<Sandbox> {
  if (!isBoxdConfigured())
    throw new Error("boxd is not configured: set BOXD_API_KEY or BOXD_TOKEN");
  const client = new Boxd();
  // Older sessions may have a durable machineId but no machineName because
  // they were created before deterministic naming was persisted. Resolve the
  // machine by id first and recover its provider name instead of forcing the
  // user into a manual reprovision flow.
  let name = state.machineName;
  let machine = state.machineId
    ? await client.machines.get(state.machineId).catch(() => null)
    : name
      ? await client.machines.get(name).catch(() => null)
      : null;

  if (!name && machine?.name) {
    name = machine.name;
  }
  if (!name || /^entry-undefined(?:-|$)/.test(name)) {
    throw new Error(
      "boxd workspace is missing a stable machine name; reprovision the session",
    );
  }

  if (!machine) {
    try {
      machine = await client.machines.create({
        name,
        image: options?.image ?? "ubuntu:24.04",
        isolated: false,
        restartPolicy: "never",
        config: {
          vcpu: BOXD_VCPU,
          memory: BOXD_MEMORY,
          disk: BOXD_DISK,
          autoSuspendTimeout: 300,
          autoDestroyTimeout: 0,
          ssh: true,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.toLowerCase().includes("limit reached") ||
        message.toLowerCase().includes("destroy an org vm")
      ) {
        // Evict oldest inactive VMs to recover org capacity
        try {
          const allMachines = await client.machines.list().catch(() => []);
          const inactive = allMachines
            .filter((m) => m.name !== name && m.status !== "running")
            .sort(
              (a, b) =>
                new Date(a.createdAt || 0).getTime() -
                new Date(b.createdAt || 0).getTime(),
            );
          for (const victim of inactive.slice(0, 10)) {
            await client.machines.delete(victim.id).catch(() => {});
          }
          // Retry create after cleanup
          machine = await client.machines.create({
            name,
            image: options?.image ?? "ubuntu:24.04",
            isolated: false,
            restartPolicy: "never",
            config: {
              vcpu: BOXD_VCPU,
              memory: BOXD_MEMORY,
              disk: BOXD_DISK,
              autoSuspendTimeout: 300,
              autoDestroyTimeout: 0,
              ssh: true,
            },
          });
        } catch (retryErr) {
          console.error("[boxd] Capacity eviction/recreate failed:", retryErr);
        }
      }

      if (!machine) {
        if (!message.toLowerCase().includes("already taken")) throw error;
        machine = await client.machines.get(name).catch(() => null);
        if (!machine) {
          const machines = await client.machines.list();
          machine =
            machines.find((candidate) => candidate.name === name) ?? null;
        }
        if (!machine) throw error;
      }
    }
  } else if (machine.status === "stopped") {
    await client.machines.start(machine.id);
  } else if (machine.status === "hibernated") {
    await client.machines.wake(machine.id);
  } else if (machine.status === "suspended") {
    await client.machines.resume(machine.id);
  }

  // Ensure every Boxd machine automatically pauses (suspends to RAM) after 5 minutes (300s)
  // and hibernates (suspends to disk) after 20 minutes (1200s) of inactivity.
  await Promise.allSettled([
    client.machines.setAutoSuspendTimeout(machine.id, 300),
    client.machines.setAutoHibernateTimeout(machine.id, 1200),
  ]);

  try {
    await client.machines.waitUntilReady(machine.id);
  } catch (readyError) {
    const errorMsg =
      readyError instanceof Error ? readyError.message : String(readyError);
    if (
      errorMsg.includes("exec did not succeed") ||
      errorMsg.includes("terminal state") ||
      errorMsg.includes("did not reach 'running'")
    ) {
      console.warn(
        `[boxd] Machine ${machine.id} (${machine.name}) is hung/unhealthy: ${errorMsg}. Evicting and provisioning fresh VM.`,
      );
      await client.machines.delete(machine.id).catch(() => {});
      machine = await client.machines.create({
        name,
        image: options?.image ?? "ubuntu:24.04",
        isolated: false,
        restartPolicy: "never",
        config: {
          vcpu: BOXD_VCPU,
          memory: BOXD_MEMORY,
          disk: BOXD_DISK,
          autoSuspendTimeout: 300,
          autoDestroyTimeout: 0,
          ssh: true,
        },
      });
      await Promise.allSettled([
        client.machines.setAutoSuspendTimeout(machine.id, 300),
        client.machines.setAutoHibernateTimeout(machine.id, 1200),
      ]);
      await client.machines.waitUntilReady(machine.id);
    } else {
      throw readyError;
    }
  }
  await client.machines
    .setBotProtection(machine.id, false)
    .catch(() => undefined);

  const targetPorts = Array.from(
    new Set(
      options?.ports && options.ports.length > 0
        ? options.ports
        : [3000, 5173, 4321, 8000, 8888],
    ),
  );
  const proxyPorts = new Set<number>();
  try {
    const existingProxies = await client.machines.proxies.list(machine.id);
    const byName = new Map(
      existingProxies
        .filter(
          (proxy): proxy is typeof proxy & { name: string } =>
            typeof proxy.name === "string" && proxy.name.length > 0,
        )
        .map((proxy) => [proxy.name, proxy]),
    );
    await Promise.all(
      targetPorts.map(async (port) => {
        const routeName = `p${port}`;
        const existing = byName.get(routeName);
        if (!existing) {
          await client.machines.proxies.create(machine.id, routeName, port);
        } else if (existing.port !== port) {
          await client.machines.proxies.setPort(machine.id, port, {
            name: routeName,
          });
        }
        proxyPorts.add(port);
      }),
    );
  } catch {
    // Named proxies are best-effort; BoxdSandbox.domain falls back to the machine's default HTTPS route.
  }

  await client.machines.exec(machine.id, {
    command: ["mkdir", "-p", BOXD_WORKING_DIRECTORY],
  });
  const baseDomain = machine.access?.domain || "boxd.sh";
  const sandbox = new BoxdSandbox(
    client,
    machine.id,
    machine.name,
    options,
    baseDomain,
    proxyPorts,
  );
  await sandbox.setGitHubAuthToken(options?.githubToken);
  try {
    await bootstrapWorkspace(sandbox, state, options);
  } finally {
    await sandbox.setGitHubAuthToken(undefined);
  }
  return sandbox;
}

export async function listAllBoxdMachines(): Promise<
  Array<{
    id: string;
    name: string;
    status: string;
    createdAt?: string;
  }>
> {
  const client = new Boxd();
  const machines = await client.machines.list();
  return machines.map((m) => ({
    id: m.id,
    name: m.name,
    status: m.status,
    createdAt: m.createdAt ? String(m.createdAt) : undefined,
  }));
}

export async function deleteAllBoxdMachines(): Promise<{
  deletedCount: number;
  remainingCount: number;
}> {
  const client = new Boxd();
  const machines = await client.machines.list();
  let deletedCount = 0;
  for (const m of machines) {
    try {
      await client.machines.delete(m.id);
      deletedCount++;
    } catch (err) {
      console.warn(`[boxd] Failed to delete machine ${m.id}:`, err);
    }
  }
  const remaining = await client.machines.list().catch(() => []);
  return {
    deletedCount,
    remainingCount: remaining.length,
  };
}
