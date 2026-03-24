#!/usr/bin/env bash
#
# Auto-bump version based on conventional commit prefixes.
# Called as a Claude Code PostToolUse hook after Bash commands.
# Reads hook context from stdin to detect git commit commands.
#
# Conventional commit → semver mapping:
#   feat:            → minor
#   fix:             → patch
#   perf:            → patch
#   BREAKING CHANGE  → major
#   feat!: / fix!:   → major (! suffix = breaking)
#   chore/docs/etc   → no bump
#
set -euo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0

# --- Read hook context from stdin ---
# PostToolUse sends JSON: { "tool_name": "Bash", "tool_input": { "command": "..." }, ... }
HOOK_INPUT=""
if [ ! -t 0 ]; then
  HOOK_INPUT=$(cat)
fi

# Only act after a git commit command
if [ -n "$HOOK_INPUT" ]; then
  COMMAND=$(echo "$HOOK_INPUT" | grep -oP '"command"\s*:\s*"\K[^"]*' 2>/dev/null || true)
  if ! echo "$COMMAND" | grep -qE 'git commit'; then
    exit 0
  fi
fi

# --- Get the last commit message ---
MSG=$(git log -1 --pretty=%B 2>/dev/null) || exit 0

# Skip if last commit is already a version bump
if echo "$MSG" | grep -qE '^chore: bump version to '; then
  exit 0
fi

# --- Determine bump type ---
# Pre-1.0: all conventional commits bump patch only
BUMP=""

if echo "$MSG" | grep -qE '^(feat|fix|perf)(\(.+\))?\!?:'; then
  BUMP="patch"
elif echo "$MSG" | grep -qE 'BREAKING CHANGE'; then
  BUMP="patch"
fi

# No conventional commit prefix that warrants a bump
if [ -z "$BUMP" ]; then
  exit 0
fi

# --- Bump version ---
CURRENT=$(node -p "require('./package.json').version")

IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

case "$BUMP" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
esac

NEW_VERSION="${MAJOR}.${MINOR}.${PATCH}"

# Update package.json (npm version handles the JSON formatting)
npm version "$NEW_VERSION" --no-git-tag-version --allow-same-version >/dev/null 2>&1

# Commit the bump
git add package.json
git commit -m "chore: bump version to ${NEW_VERSION}"

echo "Bumped version: ${CURRENT} -> ${NEW_VERSION} (${BUMP})"
