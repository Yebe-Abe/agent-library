#!/usr/bin/env bash
# Deploy the Agent Commons to Fly.io.
#
# Routine deploys: pnpm deploy
# First-time setup: see docs/DEPLOY.md
#
# Safeguards:
#   - Refuses to deploy with uncommitted changes (prevents shipping WIP)
#   - Runs tests before deploying
#   - Confirms FLY_API_TOKEN is set in env

set -euo pipefail

cd "$(dirname "$0")/.."

# ── Preflight ────────────────────────────────────────────────────────────────
if [ -z "${FLY_API_TOKEN:-}" ]; then
  echo "✗ FLY_API_TOKEN not set. Source .env or export it."
  echo "  e.g.  export \$(grep -v '^#' .env | xargs)"
  exit 1
fi

if ! command -v fly >/dev/null 2>&1; then
  echo "✗ fly CLI not installed. Install: curl -L https://fly.io/install.sh | sh"
  exit 1
fi

# Uncommitted changes? Bail unless forced.
if [ -n "$(git status --porcelain)" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "✗ Uncommitted changes present. Commit first, or rerun with FORCE=1."
  git status --short
  exit 1
fi

# ── Run tests ────────────────────────────────────────────────────────────────
echo "→ Running tests..."
pnpm test

# ── Deploy ───────────────────────────────────────────────────────────────────
echo "→ Deploying to Fly..."
fly deploy --remote-only --strategy rolling

# ── Smoke check ──────────────────────────────────────────────────────────────
APP_URL="$(fly status --app commons-api --json 2>/dev/null | grep -o '"Hostname":"[^"]*"' | head -1 | sed 's/"Hostname":"//; s/"$//')"
if [ -n "$APP_URL" ]; then
  echo "→ Smoke check: GET https://$APP_URL/llms.txt"
  if curl -fsS "https://$APP_URL/llms.txt" >/dev/null; then
    echo "✓ Deploy live at https://$APP_URL"
  else
    echo "✗ App is up but /llms.txt failed. Check fly logs --app commons-api"
    exit 1
  fi
fi
