/**
 * Novita AI Agent Sandbox configuration.
 *
 * Novita AI provides fast-booting, hardware-isolated Firecracker MicroVMs
 * designed for agent code execution and terminal sessions.
 */
export const NOVITA_DEFAULT_BASE_URL = "https://api.novita.ai";
export const NOVITA_DEFAULT_TEMPLATE = "novita/ubuntu-base";
export const NOVITA_WORKING_DIRECTORY = "/tmp/entry-workspace";
export const NOVITA_BASE_DOMAIN = "sandbox.novita.ai";

export function isNovitaConfigured(): boolean {
  return Boolean(process.env.NOVITA_API_KEY);
}

export function getNovitaApiKey(): string {
  const key = process.env.NOVITA_API_KEY;
  if (!key) {
    throw new Error("NOVITA_API_KEY is not configured in this environment.");
  }
  return key;
}

export function getNovitaBaseUrl(): string {
  return process.env.NOVITA_BASE_URL ?? NOVITA_DEFAULT_BASE_URL;
}
