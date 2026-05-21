#!/bin/bash
set -euo pipefail

# Bob AI installer — Windows x86_64 via WSL
# Usage:
#   One-liner:  curl -fsSL https://raw.githubusercontent.com/nilcaream/bobai/main/install/win32-x64-wsl.sh | bash
#   From clone: ./install/win32-x64-wsl.sh

readonly BUN_VERSION="1.3.3"
readonly BUN_SHA256="f5c546736f955141459de231167b6fdf7b01418e8be3609f2cde9dfe46a93a3d"
readonly BUN_ARCHIVE="bun-linux-x64.zip"
readonly BOBAI_PLATFORM="win32-x64-wsl"
readonly RELEASE_ARCHIVE="bobai-${BOBAI_PLATFORM}.tar.gz"
readonly RELEASE_URL="https://github.com/nilcaream/bobai/releases/latest/download/${RELEASE_ARCHIVE}"

DATA_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}"
readonly BOBAI_HOME="${DATA_HOME}/bobai"
readonly BUN="${BOBAI_HOME}/bun"
readonly BIN_DIR="${HOME}/.local/bin"

log_info()  { echo "[INFO]  ${*}"; }
log_error() { echo "[ERROR] ${*}" >&2; }
die()       { log_error "${*}"; exit 1; }

cleanup() {
	if [[ -n "${TMP_DIR:-}" && -d "${TMP_DIR}" ]]; then
		rm -rf "${TMP_DIR}"
	fi
}
trap cleanup EXIT

install_bun() {
	mkdir -p "${BOBAI_HOME}"

	if [[ -x "${BUN}" ]]; then
		local current_version
		current_version="$("${BUN}" --version 2>/dev/null || echo "")"
		if [[ "${current_version}" == "${BUN_VERSION}" ]]; then
			log_info "Bun ${BUN_VERSION} already installed."
			return
		fi
		log_info "Bun version mismatch (have ${current_version}, need ${BUN_VERSION}). Updating..."
	fi

	log_info "Downloading Bun ${BUN_VERSION}..."
	local tmp_zip="${BOBAI_HOME}/bun-download.zip"
	curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${BUN_ARCHIVE}" -o "${tmp_zip}"

	log_info "Verifying checksum..."
	local actual_sha256
	actual_sha256="$(sha256sum "${tmp_zip}" | cut -d' ' -f1)"
	if [[ "${actual_sha256}" != "${BUN_SHA256}" ]]; then
		rm -f "${tmp_zip}"
		die "Checksum mismatch! Expected ${BUN_SHA256}, got ${actual_sha256}"
	fi

	local tmp_extract="${BOBAI_HOME}/bun-extract"
	rm -rf "${tmp_extract}"
	unzip -q "${tmp_zip}" -d "${tmp_extract}"
	mv "${tmp_extract}/${BUN_ARCHIVE%.zip}/bun" "${BUN}"
	chmod +x "${BUN}"

	rm -rf "${tmp_extract}" "${tmp_zip}"
	log_info "Bun ${BUN_VERSION} installed."
}

fetch_release() {
	TMP_DIR=$(mktemp -d)
	log_info "Downloading Bob AI release..."
	curl -fsSL "${RELEASE_URL}" -o "${TMP_DIR}/bobai.tar.gz"
	log_info "Unpacking..."
	tar -xzf "${TMP_DIR}/bobai.tar.gz" -C "${TMP_DIR}"
	rm "${TMP_DIR}/bobai.tar.gz"
}

deploy_dist() {
	local source_dir="${1}"
	local dist_dir="${BOBAI_HOME}/dist"

	rm -rf "${dist_dir}"
	mkdir -p "${dist_dir}/ui"

	cp "${source_dir}/dist/server.js" "${dist_dir}/server.js"
	cp -r "${source_dir}/dist/ui/"* "${dist_dir}/ui/"
	log_info "Dist deployed to ${dist_dir}"
}

install_runner() {
	local source_dir="${1}"
	local build_version
	build_version="$(cat "${source_dir}/VERSION" 2>/dev/null || echo "unknown")"

	mkdir -p "${BIN_DIR}"

	cat > "${BIN_DIR}/bobai" << RUNNER
#!/bin/bash
set -euo pipefail
if [[ "\${1:-}" == "update" ]]; then
	echo "Updating Bob AI..."
	curl -fsSL https://raw.githubusercontent.com/nilcaream/bobai/main/install/win32-x64-wsl.sh | bash
	exit 0
fi
DATA_HOME="\${XDG_DATA_HOME:-\${HOME}/.local/share}"
BOBAI_HOME="\${DATA_HOME}/bobai"
echo "Bob AI ${build_version}"
export BUN_CONFIG_INSTALL_AUTO=disable
export BOBAI_VERSION="${build_version}"
export BOBAI_PLATFORM="win32-x64-wsl"
exec "\${BOBAI_HOME}/bun" "\${BOBAI_HOME}/dist/server.js" "\$@"
RUNNER

	chmod +x "${BIN_DIR}/bobai"
	log_info "Runner installed at ${BIN_DIR}/bobai"
}

main() {
	log_info "Installing Bob AI..."

	install_bun
	fetch_release
	deploy_dist "${TMP_DIR}"
	install_runner "${TMP_DIR}"

	log_info "Refreshing model catalog..."
	if "${BIN_DIR}/bobai" refresh; then
		log_info "Model catalog refreshed."
	else
		log_error "Model catalog refresh failed. Run 'bobai refresh' to retry."
	fi

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
