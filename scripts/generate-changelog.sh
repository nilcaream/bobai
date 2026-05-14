#!/bin/bash
set -euo pipefail

# Generate a changelog section from conventional commits between two refs.
# Usage: ./scripts/generate-changelog.sh <from-ref> <to-ref>
# Output: Markdown suitable for CHANGELOG.md or a GitHub release body.
#
# Environment variables:
#   GITHUB_SERVER_URL   — defaults to https://github.com
#   GITHUB_REPOSITORY   — e.g. nilcaream/bobai (required for commit links)

readonly FROM="${1:?Usage: generate-changelog.sh <from-ref> <to-ref>}"
readonly TO="${2:?Usage: generate-changelog.sh <from-ref> <to-ref>}"

readonly GITHUB_URL="${GITHUB_SERVER_URL:-https://github.com}"
readonly REPO="${GITHUB_REPOSITORY:-nilcaream/bobai}"

# Temporary directory for section accumulation.
# Using files avoids subshell scoping issues with piped while loops.
tmpdir=$(mktemp -d)
trap 'rm -rf "${tmpdir}"' EXIT

touch "${tmpdir}/feat" "${tmpdir}/fix" "${tmpdir}/perf" "${tmpdir}/refactor" \
      "${tmpdir}/docs" "${tmpdir}/chore" "${tmpdir}/other"

# Process each non-merge commit between the two refs.
# Pipe instead of process substitution — more reliable in CI environments.
git log --no-merges --format='%H	%s' "${FROM}..${TO}" | \
while IFS='	' read -r hash subject; do
  [[ -z "${hash}" ]] && continue

  # Skip non-conventional commits (e.g. "Initial commit")
  if [[ ! "${subject}" =~ ^[a-z]+ ]]; then
    continue
  fi

  # Parse conventional commit: type(scope): description  OR  type: description
  type="${subject%%:*}"
  desc="${subject#*:}"
  # Trim leading whitespace from description
  desc="${desc#"${desc%%[![:space:]]*}"}"

  scope=""
  if [[ "${type}" == *"("* ]]; then
    scope="${type#*(}"
    scope="${scope%)}"
    type="${type%%(*}"
  fi

  # Skip release commits (e.g. "chore: release bobai 0.2.3")
  if [[ "${type}" == "chore" && "${desc}" == release* ]]; then
    continue
  fi

  if [[ -n "${scope}" ]]; then
    entry="- ${scope}: ${desc} ([${hash:0:7}](${GITHUB_URL}/${REPO}/commit/${hash}))"
  else
    entry="- ${desc} ([${hash:0:7}](${GITHUB_URL}/${REPO}/commit/${hash}))"
  fi

  case "${type}" in
    feat)     echo "${entry}" >> "${tmpdir}/feat" ;;
    fix)      echo "${entry}" >> "${tmpdir}/fix" ;;
    perf)     echo "${entry}" >> "${tmpdir}/perf" ;;
    refactor) echo "${entry}" >> "${tmpdir}/refactor" ;;
    docs)     echo "${entry}" >> "${tmpdir}/docs" ;;
    chore)    echo "${entry}" >> "${tmpdir}/chore" ;;
    *)        echo "${entry}" >> "${tmpdir}/other" ;;
  esac
done

output=""

section() {
  local label="${1}"
  local file="${2}"
  if [[ -s "${file}" ]]; then
    output="${output}"$'\n'"### ${label}"$'\n'$'\n'"$(cat "${file}")"
  fi
}

section "Features"      "${tmpdir}/feat"
section "Bug Fixes"     "${tmpdir}/fix"
section "Performance"   "${tmpdir}/perf"
section "Documentation" "${tmpdir}/docs"
section "Refactoring"   "${tmpdir}/refactor"
section "Miscellaneous"  "${tmpdir}/chore"
section "Other Changes"  "${tmpdir}/other"

# Trim leading blank lines, preserve content as-is
echo "${output}" | awk '/./ {p=1} p'