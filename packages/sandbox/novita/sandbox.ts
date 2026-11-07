import type { Dirent } from "node:fs";
import type {
  ExecResult,
  Sandbox,
  SandboxHooks,
  SandboxStats,
} from "../interface.ts";
import type { ConnectOptions } from "../factory.ts";
import { NOVITA_BASE_DOMAIN, NOVITA_WORKING_DIRECTORY } from "./config.ts";
import { NovitaClient } from "./client.ts";

const MAX_NOVITA_OUTPUT_CHARS = 200_000;

function truncateOutput(text: string): { text: string; truncated: boolean } {
  if (!text || text.length <= MAX_NOVITA_OUTPUT_CHARS) {
    return { text: text ?? "", truncated: false };
  }
  return {
    text: text.slice(0, MAX_NOVITA_OUTPUT_CHARS),
    truncated: true,
  };
}

export class NovitaSandbox implements Sandbox {
  readonly type = "cloud" as const;
  readonly workingDirectory = NOVITA_WORKING_DIRECTORY;
  readonly hooks?: SandboxHooks;
  readonly env?: Record<string, string>;
  readonly host?: string;
  readonly expiresAt?: number;
  private githubToken?: string;
  private vercelToken?: string;
  private stopped = false;

  constructor(
    private readonly client: NovitaClient,
    private readonly sandboxId: string,
    options?: ConnectOptions,
    private readonly baseDomain = NOVITA_BASE_DOMAIN,
  ) {
    this.hooks = options?.hooks;
    this.env = options?.env;
  }

  private assertRunning() {
    if (this.stopped) throw new Error("Novita AI sandbox is stopped");
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
    const result = await this.client.exec(this.sandboxId, {
      command: `cat ${JSON.stringify(path)}`,
      cwd: this.workingDirectory,
      env: this.commandEnv(),
      timeoutMs: 15_000,
    });
    if (!result.success) {
      throw new Error(result.stderr || `Failed to read file: ${path}`);
    }
    return result.stdout;
  }

  async readFileBuffer(path: string): Promise<Buffer> {
    this.assertRunning();
    const result = await this.client.exec(this.sandboxId, {
      command: `base64 -w 0 ${JSON.stringify(path)}`,
      cwd: this.workingDirectory,
      env: this.commandEnv(),
      timeoutMs: 30_000,
    });
    if (!result.success) {
      throw new Error(result.stderr || `Failed to read file buffer: ${path}`);
    }
    return Buffer.from(result.stdout.trim(), "base64");
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
    const b64 = content.toString("base64");
    // Ensure parent dir exists and write via base64 decode
    const script = `mkdir -p "$(dirname ${JSON.stringify(path)})" && echo ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify(path)}`;
    const result = await this.client.exec(this.sandboxId, {
      command: script,
      cwd: this.workingDirectory,
      env: this.commandEnv(),
      timeoutMs: 30_000,
    });
    if (!result.success) {
      throw new Error(result.stderr || `Failed to write file: ${path}`);
    }
  }

  async stat(path: string): Promise<SandboxStats> {
    this.assertRunning();
    const result = await this.client.exec(this.sandboxId, {
      command: `stat -c "%F|%s|%Y" ${JSON.stringify(path)}`,
      cwd: this.workingDirectory,
      env: this.commandEnv(),
      timeoutMs: 10_000,
    });
    if (!result.success) {
      throw new Error(result.stderr || `stat failed for ${path}`);
    }
    const [kind, size, mtime] = result.stdout.trim().split("|");
    return {
      isDirectory: () => kind === "directory",
      isFile: () => kind === "regular file",
      size: Number(size),
      mtimeMs: Number(mtime) * 1000,
    };
  }

  async access(path: string): Promise<void> {
    this.assertRunning();
    const result = await this.client.exec(this.sandboxId, {
      command: `test -e ${JSON.stringify(path)}`,
      cwd: this.workingDirectory,
      env: this.commandEnv(),
      timeoutMs: 10_000,
    });
    if (!result.success) {
      throw new Error(result.stderr || `Path does not exist: ${path}`);
    }
  }

  async mkdir(path: string, _options?: { recursive?: boolean }): Promise<void> {
    this.assertRunning();
    await this.client.exec(this.sandboxId, {
      command: `mkdir -p ${JSON.stringify(path)}`,
      cwd: this.workingDirectory,
      env: this.commandEnv(),
      timeoutMs: 10_000,
    });
  }

  async readdir(
    path: string,
    _options: { withFileTypes: true },
  ): Promise<Dirent[]> {
    this.assertRunning();
    // Use python or find to inspect directory entries reliably
    const script = `python3 -c "import os, json; print(json.dumps([{'name': f, 'isDir': os.path.isdir(os.path.join('${path}', f))} for f in os.listdir('${path}')]))"`;
    const result = await this.client.exec(this.sandboxId, {
      command: script,
      cwd: this.workingDirectory,
      env: this.commandEnv(),
      timeoutMs: 15_000,
    });
    if (!result.success) {
      throw new Error(result.stderr || `Failed to readdir: ${path}`);
    }
    const parsed: Array<{ name: string; isDir: boolean }> = JSON.parse(
      result.stdout.trim(),
    );
    return parsed.map(
      (entry) =>
        ({
          name: entry.name,
          isBlockDevice: () => false,
          isCharacterDevice: () => false,
          isDirectory: () => entry.isDir,
          isFIFO: () => false,
          isFile: () => !entry.isDir,
          isSocket: () => false,
          isSymbolicLink: () => false,
        }) as Dirent,
    );
  }

  async exec(
    command: string,
    cwd: string,
    timeoutMs: number,
    options?: { signal?: AbortSignal },
  ): Promise<ExecResult> {
    this.assertRunning();
    if (options?.signal?.aborted) throw new Error("Command aborted");

    const res = await this.client.exec(this.sandboxId, {
      command,
      cwd,
      timeoutMs,
      env: this.commandEnv(),
    });

    const stdoutRes = truncateOutput(res.stdout);
    const stderrRes = truncateOutput(res.stderr);

    return {
      success: res.success,
      exitCode: res.exitCode,
      stdout: stdoutRes.text,
      stderr: stderrRes.text,
      truncated: stdoutRes.truncated || stderrRes.truncated,
    };
  }

  async execDetached(
    command: string,
    cwd: string,
  ): Promise<{ commandId: string }> {
    this.assertRunning();
    const commandId = `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const logPath = `/tmp/${commandId}.log`;
    const wrapped = `nohup bash -c ${JSON.stringify(command)} > ${logPath} 2>&1 & echo $!`;
    const res = await this.client.exec(this.sandboxId, {
      command: wrapped,
      cwd,
      timeoutMs: 10_000,
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
    await this.client.deleteSandbox(this.sandboxId);
    this.stopped = true;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    await this.hooks?.beforeStop?.(this);
    await this.client.pauseSandbox(this.sandboxId).catch(() => {});
    this.stopped = true;
  }

  async killCommand(cmdId: string): Promise<void> {
    if (this.stopped || !/^[1-9][0-9]*$/.test(cmdId.trim())) {
      return;
    }
    const pid = cmdId.trim();
    await this.client
      .exec(this.sandboxId, {
        command: `kill -TERM -${pid} ${pid} 2>/dev/null || true`,
        cwd: this.workingDirectory,
        timeoutMs: 5_000,
      })
      .catch(() => undefined);
  }

  domain(port: number): string {
    return `https://${port}-${this.sandboxId}.${this.baseDomain}`;
  }

  getState(): { type: "novita"; sandboxId: string } {
    return {
      type: "novita",
      sandboxId: this.sandboxId,
    };
  }
}
