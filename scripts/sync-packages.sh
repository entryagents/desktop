#!/usr/bin/env bash
# Re-copy packages/{agent,sandbox,shared,tsconfig} from a monorepo checkout.
# Usage: scripts/sync-packages.sh /path/to/entry-agents-checkout
set -euo pipefail
SRC="${1:?usage: sync-packages.sh <entry-agents-checkout>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
for p in agent sandbox shared tsconfig; do
  rm -rf "$ROOT/packages/$p"
  cp -r "$SRC/packages/$p" "$ROOT/packages/$p"
  echo "synced packages/$p"
done
