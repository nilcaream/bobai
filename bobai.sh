#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR

exec bun run "${SCRIPT_DIR}/packages/server/src/index.ts" "${@}"
