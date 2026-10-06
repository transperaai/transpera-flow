#!/usr/bin/env bash
# Runs the visual suite in the same Playwright image CI uses, for anyone with Docker. Baselines made here match CI's.
#   pnpm --filter @transpera-flow/web visual:docker                         compare
#   pnpm --filter @transpera-flow/web visual:docker --update-snapshots=all  rewrite the baselines
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
V="$(node -p "require('$here/../node_modules/@playwright/test/package.json').version")"
docker run --rm --ipc=host -v "$repo":/work -w /work/apps/web \
  -e VISUAL_BASELINES=1 -e PLAYWRIGHT_IMAGE="v$V-noble" -e STORYBOOK_DISABLE_TELEMETRY=1 \
  "mcr.microsoft.com/playwright:v$V-noble" \
  bash -lc "corepack enable && pnpm install --frozen-lockfile && pnpm build-storybook && pnpm visual $*"
