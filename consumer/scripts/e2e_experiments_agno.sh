#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export ACCEPTANCE_AGENT_KEY="${ACCEPTANCE_AGENT_KEY:-agno-otel-cli}"
export ACCEPTANCE_AGENT_VERSION="${ACCEPTANCE_AGENT_VERSION:-2026.3.1-otel-v1}"

exec ./scripts/e2e_experiments.sh
