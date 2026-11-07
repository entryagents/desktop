import {
  getNovitaApiKey,
  getNovitaBaseUrl,
  NOVITA_DEFAULT_TEMPLATE,
} from "./config.ts";

export interface NovitaExecResponse {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
}

export class NovitaClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey?: string, baseUrl?: string) {
    this.apiKey = apiKey ?? getNovitaApiKey();
    this.baseUrl = baseUrl ?? getNovitaBaseUrl();
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;
    const headers = new Headers(options.headers);
    headers.set("Authorization", `Bearer ${this.apiKey}`);
    headers.set("Content-Type", "application/json");

    const res = await fetch(url, {
      ...options,
      headers,
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(
        `Novita Sandbox API error (${res.status} ${res.statusText}): ${errBody || res.statusText}`,
      );
    }

    // For 204 No Content
    if (res.status === 204) {
      return {} as T;
    }

    return (await res.json()) as T;
  }

  async createSandbox(params?: {
    template?: string;
    timeoutSeconds?: number;
    metadata?: Record<string, string>;
  }): Promise<{ sandboxId: string }> {
    const payload = {
      template: params?.template ?? NOVITA_DEFAULT_TEMPLATE,
      timeout: params?.timeoutSeconds ?? 3600,
      metadata: params?.metadata ?? {},
    };

    const data = await this.request<{
      id?: string;
      sandbox_id?: string;
      sandboxId?: string;
    }>("/v1/sandbox/create", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    const id = data.id ?? data.sandbox_id ?? data.sandboxId;
    if (!id) {
      throw new Error("Novita API did not return a valid sandbox id");
    }
    return { sandboxId: id };
  }

  async exec(
    sandboxId: string,
    params: {
      command: string;
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
    },
  ): Promise<NovitaExecResponse> {
    const payload = {
      cmd: params.command,
      cwd: params.cwd,
      env: params.env,
      timeout: params.timeoutMs ? Math.round(params.timeoutMs / 1000) : 30,
    };

    try {
      const data = await this.request<{
        stdout?: string;
        stderr?: string;
        exit_code?: number;
        exitCode?: number;
        success?: boolean;
      }>(`/v1/sandbox/${sandboxId}/exec`, {
        method: "POST",
        body: JSON.stringify(payload),
      });

      const exitCode = data.exit_code ?? data.exitCode ?? 0;
      const success =
        data.success !== undefined ? data.success : exitCode === 0;

      return {
        stdout: data.stdout ?? "",
        stderr: data.stderr ?? "",
        exitCode,
        success,
      };
    } catch (err) {
      return {
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        exitCode: 1,
        success: false,
      };
    }
  }

  async deleteSandbox(sandboxId: string): Promise<void> {
    await this.request(`/v1/sandbox/${sandboxId}`, {
      method: "DELETE",
    }).catch(() => {
      // Fallback kill endpoint
      return this.request(`/v1/sandbox/${sandboxId}/kill`, {
        method: "POST",
      });
    });
  }

  async pauseSandbox(sandboxId: string): Promise<void> {
    await this.request(`/v1/sandbox/${sandboxId}/pause`, {
      method: "POST",
    });
  }

  async resumeSandbox(sandboxId: string): Promise<void> {
    await this.request(`/v1/sandbox/${sandboxId}/resume`, {
      method: "POST",
    });
  }
}
