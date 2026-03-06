#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR

readonly SERVER_DIR="${SCRIPT_DIR}/packages/server"
readonly UI_DIR="${SCRIPT_DIR}/packages/ui"

log_info() { echo "[INFO] ${*}"; }

# --- Lint ---
log_info "Running Biome check..."
(cd "${SERVER_DIR}" && bun run check -- --error-on-warnings)

# --- Tests ---
log_info "Running tests..."
(cd "${SERVER_DIR}" && bun test)

# --- Build UI ---
log_info "Building UI..."
(cd "${UI_DIR}" && bunx vite build)

# --- Start server ---
log_info "Starting server..."
exec bun run "${SERVER_DIR}/src/index.ts" --port 20000 --debug
