#!/bin/bash
set -euo pipefail

# Bob AI installer
# Usage:
#   From cloned repo:  ./install.sh
#   One-liner:         curl -fsSL https://raw.githubusercontent.com/nilcaream/bobai/main/install.sh | bash

readonly BUN_VERSION="1.3.3"
readonly BUN_SHA256="f5c546736f955141459de231167b6fdf7b01418e8be3609f2cde9dfe46a93a3d"
readonly REPO_URL="https://github.com/nilcaream/bobai.git"

DATA_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}"
readonly BOBAI_HOME="${DATA_HOME}/bobai"
readonly BUN="${BOBAI_HOME}/bun"
readonly BIN_DIR="${HOME}/.local/bin"

log_info()  { echo "[INFO]  ${*}"; }
log_error() { echo "[ERROR] ${*}" >&2; }
die()       { log_error "${*}"; exit 1; }

cleanup() {
	if [[ -n "${CLONE_DIR:-}" && -d "${CLONE_DIR}" ]]; then
		rm -rf "${CLONE_DIR}"
	fi
}
trap cleanup EXIT

install_bun() {
	mkdir -p "${BOBAI_HOME}"

	if [[ -x "${BUN}" ]]; then
		local current_version
		current_version=$("${BUN}" --version 2>/dev/null || echo "")
		if [[ "${current_version}" == "${BUN_VERSION}" ]]; then
			log_info "Bun ${BUN_VERSION} already installed."
			return
		fi
		log_info "Bun version mismatch (have ${current_version}, need ${BUN_VERSION}). Updating..."
	fi

	log_info "Downloading Bun ${BUN_VERSION}..."
	local tmp_zip="${BOBAI_HOME}/bun-download.zip"
	curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" -o "${tmp_zip}"

	log_info "Verifying checksum..."
	local actual_sha256
	actual_sha256=$(sha256sum "${tmp_zip}" | cut -d' ' -f1)
	if [[ "${actual_sha256}" != "${BUN_SHA256}" ]]; then
		rm -f "${tmp_zip}"
		die "Checksum mismatch! Expected ${BUN_SHA256}, got ${actual_sha256}"
	fi

	local tmp_extract="${BOBAI_HOME}/bun-extract"
	rm -rf "${tmp_extract}"
	unzip -q "${tmp_zip}" -d "${tmp_extract}"
	mv "${tmp_extract}/bun-linux-x64/bun" "${BUN}"
	chmod +x "${BUN}"

	rm -rf "${tmp_extract}" "${tmp_zip}"
	log_info "Bun ${BUN_VERSION} installed."
}

is_repo_root() {
	[[ -f "package.json" ]] && grep -q '"bobai"' package.json 2>/dev/null
}

resolve_source() {
	if is_repo_root; then
		echo "."
		return
	fi

	# Not inside a repo clone -- fetch the source
	CLONE_DIR=$(mktemp -d)
	log_info "Cloning Bob AI repository..."
	git clone --depth 1 "${REPO_URL}" "${CLONE_DIR}"
	echo "${CLONE_DIR}"
}

build_dist() {
	local source_dir="${1}"

	log_info "Installing dependencies..."
	(cd "${source_dir}" && "${BUN}" install --frozen-lockfile)

	log_info "Bundling server..."
	"${BUN}" build --target=bun --minify \
		--outfile="${source_dir}/dist/server.js" \
		"${source_dir}/packages/server/src/index.ts"

	log_info "Building UI..."
	(cd "${source_dir}/packages/ui" && "${BUN}" x vite build)
}

deploy_dist() {
	local source_dir="${1}"
	local dist_dir="${BOBAI_HOME}/dist"

	rm -rf "${dist_dir}"
	mkdir -p "${dist_dir}/ui"

	cp "${source_dir}/dist/server.js" "${dist_dir}/server.js"
	cp -r "${source_dir}/packages/ui/dist/"* "${dist_dir}/ui/"
	log_info "Dist deployed to ${dist_dir}"
}

install_runner() {
	mkdir -p "${BIN_DIR}"

	cat > "${BIN_DIR}/bobai" << 'RUNNER'
#!/bin/bash
set -euo pipefail
DATA_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}"
BOBAI_HOME="${DATA_HOME}/bobai"
export BUN_CONFIG_INSTALL_AUTO=disable
exec "${BOBAI_HOME}/bun" "${BOBAI_HOME}/dist/server.js" "$@"
RUNNER

	chmod +x "${BIN_DIR}/bobai"
	log_info "Runner installed at ${BIN_DIR}/bobai"
}

main() {
	log_info "Installing Bob AI..."

	install_bun

	local source_dir
	source_dir=$(resolve_source)

	build_dist "${source_dir}"
	deploy_dist "${source_dir}"
	install_runner

	echo ""
	echo "Bob AI installed successfully!"
	echo ""
	echo "  Authenticate:  bobai auth"
	echo "  Start:         bobai"
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
