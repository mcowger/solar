#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
TAG="${1:-$(date -u +%Y.%m.%d)}"
IMAGE="ghcr.io/$(git remote get-url origin | sed -E 's#.*github.com[:/]([^.]+)(\.git)?#\1#' | tr '[:upper:]' '[:lower:]')"
PREV=""
mapfile -t TAGS < <(git tag --list | grep -E '^[0-9]{4}\.[0-9]{2}\.[0-9]{2}(\.[0-9]+)?$' || true)
if ((${#TAGS[@]})); then
  PREV="$(printf '%s\n' "${TAGS[@]}" "$TAG" | sort -V -u | awk -v tag="$TAG" '$0 == tag { print prev; exit } { prev = $0 }')"
fi
ARGS=(--tag "$TAG" --image "$IMAGE")
if [[ -n "$PREV" ]]; then ARGS+=(--prev-tag "$PREV"); fi
python3 scripts/release_notes.py "${ARGS[@]}"
