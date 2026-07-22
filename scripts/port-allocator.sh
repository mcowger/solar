#!/usr/bin/env bash
#
# Worktree port allocator for Paseo and local solar dev server.
#
# When invoked by Paseo as portScript:
#   Paseo passes ($1=scriptName, $2=workspaceId, $3=branchName, $4=worktreePath)
#   and sets PASEO_SCRIPTNAME, PASEO_WORKSPACE_ID, PASEO_BRANCH_NAME, PASEO_WORKTREE_PATH.
#
# Output: A single port number in the range 3000-3999 printed to stdout.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEFAULT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

TARGET_DIR="${PASEO_WORKTREE_PATH:-${4:-$DEFAULT_ROOT}}"

if command -v sha256sum >/dev/null 2>&1; then
  digest="$(printf '%s' "$TARGET_DIR" | sha256sum | cut -c1-6)"
elif command -v shasum >/dev/null 2>&1; then
  digest="$(printf '%s' "$TARGET_DIR" | shasum -a 256 | cut -c1-6)"
elif command -v bun >/dev/null 2>&1; then
  digest="$(bun -e 'process.stdout.write(require("crypto").createHash("sha256").update(process.argv[1]).digest("hex").slice(0, 6))' "$TARGET_DIR")"
else
  digest="$(printf '%s' "$TARGET_DIR" | cksum | cut -d' ' -f1 | xargs printf '%x' | cut -c1-6)"
fi

port=$((16#$digest % 1000 + 3000))
printf '%d\n' "$port"
