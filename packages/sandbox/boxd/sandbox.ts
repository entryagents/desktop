import type {
  Boxd,
  DirEntry,
  ExecResult as BoxdExecResult,
} from "@boxd-sh/sdk";
import type { Dirent } from "node:fs";
import type {
  ExecResult,
  Sandbox,
  SandboxHooks,
  SandboxStats,
} from "../interface.ts";
import type { ConnectOptions } from "../factory.ts";
import { BOXD_WORKING_DIRECTORY } from "./config.ts";

function asDirent(entry: DirEntry): Dirent {
  return {
    name: entry.name,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isDirectory: () => entry.isDir,
    isFIFO: () => false,
    isFile: () => !entry.isDir,
    isSocket: () => false,
    isSymbolicLink: () => false,
  } as Dirent;
}

const MAX_BOXD_OUTPUT_CHARS = 200_000;

function truncateBoxdOutput(text: string): {
  text: string;
  truncated: boolean;
} {
  if (!text || text.length <= MAX_BOXD_OUTPUT_CHARS) {
    return { text: text ?? "", truncated: false };
  }
  return {
    text: text.slice(0, MAX_BOXD_OUTPUT_CHARS),
    truncated: true,
  };
}

function mapExec(result: BoxdExecResult): ExecResult {
  const stdoutRes = truncateBoxdOutput(result.stdout);
  const stderrRes = truncateBoxdOutput(result.stderr);
  return {
    success: result.success,
    exitCode: result.exitCode ?? null,
    stdout: stdoutRes.text,
    stderr: stderrRes.text,
    truncated: stdoutRes.truncated || stderrRes.truncated,
  };
}

export class BoxdSandbox implements Sandbox {
  readonly type = "cloud" as const;
  readonly workingDirectory = BOXD_WORKING_DIRECTORY;
  readonly hooks?: SandboxHooks;
  readonly env?: Record<string, string>;
  readonly host?: string;
  readonly expiresAt?: number;
  private githubToken?: string;
  private vercelToken?: string;
  private stopped = false;

  constructor(
    private readonly client: Boxd,
    private readonly machineId: string,
    private readonly machineName: string,
    options?: ConnectOptions,
    private readonly baseDomain = "boxd.sh",
    private readonly proxyPorts: ReadonlySet<number> = new Set(),
  ) {
    this.hooks = options?.hooks;
    this.env = options?.env;
  }

  private assertRunning() {
    if (this.stopped) throw new Error("boxd sandbox is stopped");
  }

  private commandEnv(): Record<string, string> | undefined {
    let env = this.env;
    if (this.githubToken) {
      env = { ...env, GITHUB_TOKEN: this.githubToken };
    }
    if (this.vercelToken) {
      env = { ...env, VERCEL_TOKEN: this.vercelToken };
    }
    return env;
  }

  async readFile(path: string, _encoding: "utf-8"): Promise<string> {
    this.assertRunning();
    const bytes = await this.client.machines.files.download(
      this.machineId,
      path,
    );
    return new TextDecoder().decode(bytes);
  }

  async readFileBuffer(path: string): Promise<Buffer> {
    this.assertRunning();
    return Buffer.from(
      await this.client.machines.files.download(this.machineId, path),
    );
  }

  async writeFile(
    path: string,
    content: string,
    _encoding: "utf-8",
  ): Promise<void> {
    await this.writeFileBuffer(path, Buffer.from(content, "utf8"));
  }

  async writeFileBuffer(path: string, content: Buffer): Promise<void> {
    this.assertRunning();
    await this.client.machines.files.upload(this.machineId, path, content);
  }

  async stat(path: string): Promise<SandboxStats> {
    const result = await this.client.machines.exec(this.machineId, {
      command: ["stat", "-c", "%F|%s|%Y", path],
      cwd: BOXD_WORKING_DIRECTORY,
      env: this.commandEnv(),
    });
    if (!result.success) throw new Error(result.stderr || "boxd stat failed");
    const [kind, size, mtime] = result.stdout.trim().split("|");
    return {
      isDirectory: () => kind === "directory",
      isFile: () => kind === "regular file",
      size: Number(size),
      mtimeMs: Number(mtime) * 1000,
    };
  }

  async access(path: string): Promise<void> {
    const result = await this.client.machines.exec(this.machineId, {
      command: ["test", "-e", path],
      cwd: BOXD_WORKING_DIRECTORY,
      env: this.commandEnv(),
    });
    if (!result.success)
      throw new Error(result.stderr || `Path does not exist: ${path}`);
  }

  async mkdir(path: string, _options?: { recursive?: boolean }): Promise<void> {
    await this.client.machines.exec(this.machineId, {
      command: ["mkdir", "-p", path],
      cwd: BOXD_WORKING_DIRECTORY,
      env: this.commandEnv(),
    });
  }

  async readdir(
    path: string,
    _options: { withFileTypes: true },
  ): Promise<Dirent[]> {
    const listing = await this.client.machines.files.listDir(
      this.machineId,
      path,
    );
    return listing.entries.map(asDirent);
  }

  async exec(
    command: string,
    cwd: string,
    timeoutMs: number,
    options?: { signal?: AbortSignal },
  ): Promise<ExecResult> {
    this.assertRunning();
    if (options?.signal?.aborted) {
      const err = new Error("Command aborted");
      err.name = "AbortError";
      throw err;
    }

    const execPromise = this.client.machines.exec(this.machineId, {
      command: ["bash", "-c", command],
      cwd,
      timeout: timeoutMs,
      env: this.commandEnv(),
    });

    if (!options?.signal) {
      const result = await execPromise;
      return mapExec(result);
    }

    let abortListener: (() => void) | undefined;
    const abortPromise = new Promise<never>((_resolve, reject) => {
      abortListener = () => {
        const err = new Error("Command aborted");
        err.name = "AbortError";
        reject(err);
      };
      if (options.signal!.aborted) {
        abortListener();
      } else {
        options.signal!.addEventListener("abort", abortListener, {
          once: true,
        });
      }
    });

    try {
      const result = await Promise.race([execPromise, abortPromise]);
      return mapExec(result);
    } finally {
      if (abortListener && options.signal) {
        options.signal.removeEventListener("abort", abortListener);
      }
    }
  }

  async pause(): Promise<void> {
    if (this.stopped) return;
    await this.hooks?.beforeStop?.(this);
    await this.client.machines.pause(this.machineId);
  }

  async execDetached(
    command: string,
    cwd: string,
  ): Promise<{ commandId: string }> {
    this.assertRunning();
    const commandId = `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const logPath = `/tmp/${commandId}.log`;
    const wrapped = `nohup bash -c ${JSON.stringify(command)} > ${logPath} 2>&1 & echo $!`;
    const res = await this.client.machines.exec(this.machineId, {
      command: ["bash", "-c", wrapped],
      cwd,
      timeout: 10000,
      env: this.commandEnv(),
    });
    const pid = res.stdout.trim();
    return { commandId: pid || commandId };
  }

  async setGitHubAuthToken(token?: string): Promise<void> {
    this.githubToken = token;
  }

  async setVercelAuthToken(token?: string): Promise<void> {
    this.vercelToken = token;
  }

  async destroy(): Promise<void> {
    if (this.stopped) return;
    await this.hooks?.beforeStop?.(this);
    await this.client.machines.delete(this.machineId);
    await this.client.close();
    this.stopped = true;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    await this.hooks?.beforeStop?.(this);
    await this.client.machines.hibernate(this.machineId);
    this.stopped = true;
  }

  async killCommand(cmdId: string): Promise<void> {
    if (this.stopped || !/^[1-9][0-9]*$/.test(cmdId.trim())) {
      return;
    }
    const pid = cmdId.trim();
    await this.client.machines
      .exec(this.machineId, {
        command: [
          "bash",
          "-c",
          `kill -TERM -${pid} ${pid} 2>/dev/null || true`,
        ],
        cwd: BOXD_WORKING_DIRECTORY,
        timeout: 5_000,
      })
      .catch(() => undefined);
  }

  domain(port: number): string {
    if (this.proxyPorts.has(port)) {
      return `https://p${port}.${this.machineName}.${this.baseDomain}`;
    }
    void this.client.machines.proxies
      .setPort(this.machineId, port)
      .catch(() => undefined);
    return `https://${this.machineName}.${this.baseDomain}`;
  }

  getState(): { type: "boxd"; machineId: string; machineName: string } {
    return {
      type: "boxd",
      machineId: this.machineId,
      machineName: this.machineName,
    };
  }
}
