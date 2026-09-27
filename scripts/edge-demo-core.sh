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

if ! docker image inspect qm-sandbox-local:latest >/dev/null 2>&1; then
  echo "==> building the QM sandbox image with qm-edge (one time)"
  npm run edge:sandbox:build
fi

mkdir -p data
if [[ -z "${CORE_SIGNING_SECRET:-}" ]]; then
  [[ -s data/edge-demo-secret ]] || openssl rand -hex 32 > data/edge-demo-secret
  CORE_SIGNING_SECRET="$(cat data/edge-demo-secret)"
fi

export CORE_SIGNING_SECRET
export EDGE_ENABLED=1
export EDGE_JOIN_TOKEN="${EDGE_JOIN_TOKEN:-edge-demo}"
export EDGE_PROJECT="${EDGE_PROJECT:-unity-demo}"
export PORT="${PORT:-8080}"
export HARNESS="${HARNESS:-codex}"
export SANDBOX_BACKEND=local
export PUBLIC_API_URL="${PUBLIC_API_URL:-http://host.docker.internal:${PORT}}"

echo "==> QM core + QM Edge on :${PORT} (harness ${HARNESS}, sandbox local docker)"
echo "==> project ${EDGE_PROJECT}, join token ${EDGE_JOIN_TOKEN}"
echo "==> dashboard http://localhost:${PORT}/edge#token=${EDGE_JOIN_TOKEN}"
exec node --env-file-if-exists=.env src/index.ts
