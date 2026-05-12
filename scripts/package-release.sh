#!/bin/bash
set -euo pipefail

# Package Bob AI release archives for all platforms.
# Must be run from the repo root after dist/ and packages/ui/dist/ exist.
#
# Usage: ./scripts/package-release.sh <version>
# Output: release/ directory with one archive per platform.

readonly VERSION="${1:?Version argument required (e.g. 0.1.0)}"
readonly OUTDIR="release"

log_info()  { echo "[INFO]  ${*}"; }
log_error() { echo "[ERROR] ${*}" >&2; }
die()       { log_error "${*}"; exit 1; }

[[ -f "dist/server.js" ]]       || die "dist/server.js not found — run the server build first"
[[ -d "packages/ui/dist" ]]     || die "packages/ui/dist not found — run the UI build first"

rm -rf "${OUTDIR}"
mkdir -p "${OUTDIR}"

# ── Unix platforms (tar.gz) ──────────────────────────────────────────

package_unix() {
    local platform="${1}"
    local install_script="install/${platform}.sh"

    if [[ ! -f "${install_script}" ]]; then
        log_error "Install script not found: ${install_script} — skipping ${platform}"
        return
    fi

    local staging
    staging=$(mktemp -d)

    mkdir -p "${staging}/dist/ui"
    cp "${install_script}" "${staging}/install.sh"
    chmod +x "${staging}/install.sh"
    echo "${VERSION}" > "${staging}/VERSION"
    cp dist/server.js "${staging}/dist/server.js"
    cp -r packages/ui/dist/. "${staging}/dist/ui/"

    local archive="${OUTDIR}/bobai-${VERSION}-${platform}.tar.gz"
    tar -czf "${archive}" -C "${staging}" .
    rm -rf "${staging}"
    log_info "Packaged ${archive}"
}

readonly UNIX_PLATFORMS=(linux-x64 linux-arm64 darwin-x64 darwin-arm64 win32-x64-wsl)
for platform in "${UNIX_PLATFORMS[@]}"; do
    package_unix "${platform}"
done

# ── Windows native (zip) ─────────────────────────────────────────────

package_windows_native() {
    local staging
    staging=$(mktemp -d)

    mkdir -p "${staging}/dist/ui"
    cp install/win32-x64-native.ps1 "${staging}/install.ps1"
    cp install/win32-x64-native.cmd "${staging}/install.cmd"
    echo "${VERSION}" > "${staging}/VERSION"
    cp dist/server.js "${staging}/dist/server.js"
    cp -r packages/ui/dist/. "${staging}/dist/ui/"

    local archive="${OUTDIR}/bobai-${VERSION}-win32-x64-native.zip"
    (cd "${staging}" && zip -r - .) > "${archive}"
    rm -rf "${staging}"
    log_info "Packaged ${archive}"
}

package_windows_native

log_info "All archives written to ${OUTDIR}/"
