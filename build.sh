#!/bin/bash
set -euo pipefail

# Bob AI development build script
# Runs lint, tests, bundles server, builds UI, and deploys to local installation.
# Requires: ./install.sh to have been run first (provides the dedicated Bun runtime).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR

DATA_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}"
readonly BOBAI_HOME="${DATA_HOME}/bobai"
readonly BUN="${BOBAI_HOME}/bun"

readonly SERVER_DIR="${SCRIPT_DIR}/packages/server"
readonly UI_DIR="${SCRIPT_DIR}/packages/ui"

log_info()  { echo "[INFO]  ${*}"; }
log_error() { echo "[ERROR] ${*}" >&2; }
die()       { log_error "${*}"; exit 1; }

if [[ ! -x "${BUN}" ]]; then
	die "Dedicated Bun not found at ${BUN}. Run ./install.sh first."
fi

# --- Lint ---
log_info "Running Biome check..."
(cd "${SERVER_DIR}" && "${BUN}" run check -- --error-on-warnings)

# --- Tests ---
log_info "Running tests..."
(cd "${SERVER_DIR}" && "${BUN}" test)

# --- Bundle server ---
log_info "Bundling server..."
mkdir -p "${SCRIPT_DIR}/dist"
"${BUN}" build --target=bun --minify \
	--outfile="${SCRIPT_DIR}/dist/server.js" \
	"${SERVER_DIR}/src/index.ts"

# --- Build UI ---
log_info "Building UI..."
(cd "${UI_DIR}" && "${BUN}" x vite build)

# --- Deploy to local installation ---
log_info "Updating local installation..."
readonly DIST_DIR="${BOBAI_HOME}/dist"
rm -rf "${DIST_DIR}"
mkdir -p "${DIST_DIR}/ui"

cp "${SCRIPT_DIR}/dist/server.js" "${DIST_DIR}/server.js"
cp -r "${UI_DIR}/dist/"* "${DIST_DIR}/ui/"

log_info "Done. Run 'bobai' to test."
