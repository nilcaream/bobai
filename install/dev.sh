#!/bin/bash
set -euo pipefail

# Bob AI — local dev build and install
#
# Runs autofix lint, all tests, builds server + UI, then installs to the
# standard per-platform location so `bobai` on PATH points to this build.
#
# Requirements: bun must be on PATH.
# Usage: ./install/dev.sh

readonly SCRIPT_DIR="$(cd "$(dirname "${0}")/.." && pwd)"

# ── Colors ───────────────────────────────────────────────────────────

if [[ -t 1 ]]; then
	readonly GREEN='\033[0;32m'
	readonly RED='\033[0;31m'
	readonly BOLD='\033[1m'
	readonly RESET='\033[0m'
else
	readonly GREEN=''
	readonly RED=''
	readonly BOLD=''
	readonly RESET=''
fi

pass() { echo -e "${GREEN}✓${RESET} ${*}"; }
fail() { echo -e "${RED}✗${RESET} ${*}" >&2; exit 1; }
step() { echo -e "${BOLD}▸${RESET} ${*}"; }

# ── Platform detection ────────────────────────────────────────────────

detect_platform() {
	local kernel arch
	kernel="$(uname -s)"
	arch="$(uname -m)"

	case "${kernel}" in
		Linux)
			if grep -qi microsoft /proc/version 2>/dev/null; then
				echo "win32-x64-wsl"
				return
			fi
			case "${arch}" in
				x86_64)  echo "linux-x64" ;;
				aarch64) echo "linux-arm64" ;;
				*) fail "Unsupported Linux architecture: ${arch}" ;;
			esac
			;;
		Darwin)
			case "${arch}" in
				x86_64)  echo "darwin-x64" ;;
				arm64)   echo "darwin-arm64" ;;
				*) fail "Unsupported macOS architecture: ${arch}" ;;
			esac
			;;
		*) fail "Unsupported OS: ${kernel}" ;;
	esac
}

# ── Install paths (mirrors platform/resolver.ts logic) ───────────────

resolve_paths() {
	local platform="${1}"
	local home="${HOME}"

	case "${platform}" in
		linux-*|win32-x64-wsl)
			local data_home="${XDG_DATA_HOME:-${home}/.local/share}"
			BOBAI_HOME="${data_home}/bobai"
			BIN_DIR="${home}/.local/bin"
			;;
		darwin-*)
			BOBAI_HOME="${home}/Library/Application Support/bobai"
			BIN_DIR="${home}/.local/bin"
			;;
		*) fail "Cannot resolve paths for platform: ${platform}" ;;
	esac

	DIST_DIR="${BOBAI_HOME}/dist"
}

# ── Version string ────────────────────────────────────────────────────

build_version() {
	local hash dirty=""
	hash="$(git -C "${SCRIPT_DIR}" rev-parse --short HEAD 2>/dev/null || echo "unknown")"
	if ! git -C "${SCRIPT_DIR}" diff --quiet 2>/dev/null || \
	   ! git -C "${SCRIPT_DIR}" diff --cached --quiet 2>/dev/null; then
		dirty="-dirty"
	fi
	echo "dev+${hash}${dirty}"
}

# ── Main ─────────────────────────────────────────────────────────────

main() {
	cd "${SCRIPT_DIR}"

	local platform
	platform="$(detect_platform)"
	resolve_paths "${platform}"

	local version
	version="$(build_version)"

	echo ""
	echo -e "${BOLD}Bob AI dev build — ${version} (${platform})${RESET}"
	echo ""

	export BOBAI_PLATFORM="${platform}"

	# ── Lint autofix ─────────────────────────────────────────────────

	step "Server: lint autofix"
	(cd packages/server && bun run check -- --write) || fail "Server lint autofix"
	pass "Server lint autofix"

	step "Server: lint check"
	(cd packages/server && bun run check -- --error-on-warnings) || fail "Server lint"
	pass "Server lint"

	step "UI: lint autofix"
	(cd packages/ui && bun run check -- --write) || fail "UI lint autofix"
	pass "UI lint autofix"

	step "UI: lint check"
	(cd packages/ui && bun run check -- --error-on-warnings) || fail "UI lint"
	pass "UI lint"

	# ── Tests ─────────────────────────────────────────────────────────

	step "Server: tests"
	(cd packages/server && bun test) || fail "Server tests"
	pass "Server tests"

	step "UI: typecheck"
	(cd packages/ui && bunx tsc --noEmit) || fail "UI typecheck"
	pass "UI typecheck"

	step "UI: tests"
	(cd packages/ui && bun test) || fail "UI tests"
	pass "UI tests"

	# ── Build ─────────────────────────────────────────────────────────

	step "Server: build"
	bun build --target=bun --minify \
		--outfile=dist/server.js \
		packages/server/src/index.ts || fail "Server build"
	pass "Server build"

	step "UI: build"
	(cd packages/ui && bunx vite build) || fail "UI build"
	pass "UI build"

	# ── Deploy ────────────────────────────────────────────────────────

	step "Deploy"
	rm -rf "${DIST_DIR}"
	mkdir -p "${DIST_DIR}/ui"
	cp dist/server.js "${DIST_DIR}/server.js"
	cp -r packages/ui/dist/. "${DIST_DIR}/ui/"
	pass "Deploy → ${DIST_DIR}"

	# ── Runner ────────────────────────────────────────────────────────

	step "Runner"
	mkdir -p "${BIN_DIR}"
	local bun_bin
	bun_bin="$(command -v bun)"

	cat > "${BIN_DIR}/bobai" << RUNNER
#!/bin/bash
set -euo pipefail
echo "Bob AI ${version}"
export BUN_CONFIG_INSTALL_AUTO=disable
export BOBAI_VERSION="${version}"
export BOBAI_PLATFORM="${platform}"
exec "${bun_bin}" "${DIST_DIR}/server.js" "\$@"
RUNNER

	chmod +x "${BIN_DIR}/bobai"
	pass "Runner → ${BIN_DIR}/bobai"

	# ── Done ──────────────────────────────────────────────────────────

	echo ""
	pass "Installed Bob AI ${version}"
	echo ""

	if ! echo "${PATH}" | tr ':' '\n' | grep -qx "${BIN_DIR}"; then
		echo "Note: ${BIN_DIR} is not on your PATH."
		echo "Add to your shell profile:"
		echo ""
		echo "  export PATH=\"\${HOME}/.local/bin:\${PATH}\""
		echo ""
	fi
}

main "$@"
