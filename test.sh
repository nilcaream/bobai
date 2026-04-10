#!/bin/bash
set -euo pipefail

# Bob AI — full project verification
# Runs all tests, type checks, and linting. Fails fast on first error.
#
# Usage: ./test.sh

readonly SCRIPT_DIR="$(cd "$(dirname "${0}")" && pwd)"

# Colors (disabled if not a terminal)
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

cd "${SCRIPT_DIR}"

# --- Server ---

step "Server: lint"
(cd packages/server && bun run check -- --error-on-warnings) || fail "Server lint"
pass "Server lint"

step "Server: tests"
(cd packages/server && bun test) || fail "Server tests"
pass "Server tests"

# --- UI ---

step "UI: lint"
(cd packages/ui && bun run check -- --error-on-warnings) || fail "UI lint"
pass "UI lint"

step "UI: typecheck"
(cd packages/ui && bunx tsc --noEmit) || fail "UI typecheck"
pass "UI typecheck"

step "UI: tests"
(cd packages/ui && bun test) || fail "UI tests"
pass "UI tests"

# --- Done ---

echo ""
pass "All checks passed"
