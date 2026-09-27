#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if ! docker info >/dev/null 2>&1; then
  if command -v colima >/dev/null 2>&1; then
    echo "==> starting colima (Docker runtime for the QM sandbox)"
    colima start --cpu 4 --memory 6
  else
    echo "Docker is not running. Start Docker Desktop/OrbStack or: brew install colima docker && colima start" >&2
    exit 1
  fi
fi

echo "==> building the QM sandbox image with the current qm-edge (cached after the first run)"
npm run --silent edge:sandbox:build >/dev/null

mkdir -p data
if [[ -z "${CORE_SIGNING_SECRET:-}" ]]; then
  [[ -s data/edge-demo-secret ]] || (umask 077 && openssl rand -hex 32 > data/edge-demo-secret)
  CORE_SIGNING_SECRET="$(cat data/edge-demo-secret)"
fi

export CORE_SIGNING_SECRET
export EDGE_ENABLED=1
export EDGE_JOIN_TOKEN="${EDGE_JOIN_TOKEN:-$(openssl rand -hex 4)}"
export EDGE_PROJECT="${EDGE_PROJECT:-unity-demo}"
export EDGE_JOURNAL_DIR="${EDGE_JOURNAL_DIR:-data/edge-journal}"
export PORT="${PORT:-8080}"
export HARNESS="${HARNESS:-codex}"
export SANDBOX_BACKEND=local
export PUBLIC_API_URL="${PUBLIC_API_URL:-http://host.docker.internal:${PORT}}"

echo "==> QM core + QM Edge on :${PORT} (harness ${HARNESS}, sandbox local docker)"
echo "==> project ${EDGE_PROJECT}, join token ${EDGE_JOIN_TOKEN}, journal ${EDGE_JOURNAL_DIR} (delete it for a fresh scene)"
echo "==> dashboard http://localhost:${PORT}/edge#token=${EDGE_JOIN_TOKEN}"
exec node --env-file-if-exists=.env src/index.ts
