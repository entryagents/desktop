# Entry Desktop

Entry Agents desktop app — Tauri 2 shell + React/TypeScript/Tailwind UI + a local
agent sidecar running the same `openAgent` loop as the web, but on **your machine**
(system environment, no cloud sandbox).

## Layout

- `app/` — Tauri 2 (Rust) + Vite + React + TS + Tailwind frontend
- `sidecar/` — standalone agent binary (`openAgent` + `LocalSandbox`, stdio JSON-RPC)
- `packages/` — vendored from `entryagents/entry-agents` (`agent`, `sandbox`, `shared`, `tsconfig`)
- `reference-desktop/` — legacy static-UI reference (not built, not shipped)

Model calls go through the **Entry API** (`entry-agents.dev`) with the paired user
session token — same auth as the web's desktop routes. No keys ship in the binary.

## Releases

Tag `v*` → GitHub Actions builds macOS / Linux / Windows installers → prerelease.
