#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
TAG="${1:-$(date -u +%Y.%m.%d)}"

if ! [[ "$TAG" =~ ^[0-9]{4}\.[0-9]{2}\.[0-9]{2}(\.[0-9]+)?$ ]]; then
  echo "Invalid CalVer tag: $TAG (expected YYYY.MM.DD or YYYY.MM.DD.N)" >&2
  exit 1
fi
python3 - "$TAG" <<'PY'
import sys
from scripts.release_notes import tag_date
try:
    tag_date(sys.argv[1])
except ValueError as error:
    print(error, file=sys.stderr)
    raise SystemExit(1)
PY

[[ -z "$(git status --porcelain)" ]] || { echo "Working tree is not clean" >&2; exit 1; }
[[ "$(git branch --show-current)" == main ]] || { echo "Release tags must be cut from main" >&2; exit 1; }
git fetch origin main --quiet
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] || { echo "Local main is not at origin/main" >&2; exit 1; }
! git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || { echo "Tag already exists locally: $TAG" >&2; exit 1; }
! git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1 || { echo "Tag already exists on origin: $TAG" >&2; exit 1; }
DATE="${TAG:0:4}-${TAG:5:2}-${TAG:8:2}"
grep -q "^## \\[${DATE}\\]$" CHANGELOG.md || { echo "CHANGELOG.md has no section for $DATE" >&2; exit 1; }

bash scripts/preview-release.sh "$TAG"
read -r -p "Cut and push $TAG? [y/N] " answer
[[ "$answer" == [yY] ]] || { echo "Cancelled"; exit 1; }
git tag -a "$TAG" -m "Release $TAG"
git push origin "$TAG"
echo "Pushed $TAG. Follow the Actions run, then verify ghcr.io image tags and the GitHub release."
