#!/bin/bash
# Publishes a LogoGrid release that installed copies will offer as an update.
#
#   1. Bump the number in VERSION (e.g. 1.0.0 → 1.1.0) and commit your changes.
#   2. ./release.sh "What changed in this version"
#
# Builds the universal app, zips it, pushes your branch, and creates a GitHub
# Release with the zip attached. Without notes, the commit messages since the
# previous release are used.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
VERSION="$(tr -d '[:space:]' < VERSION)"
TAG="v$VERSION"
GH="$(command -v gh || echo "$HOME/.local/bin/gh")"

fail() { echo "✗ $1" >&2; exit 1; }

[[ -x "$GH" ]] || fail "GitHub CLI not found. Install it and run: gh auth login"
"$GH" auth status > /dev/null 2>&1 || fail "Not signed in to GitHub. Run: $GH auth login"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "VERSION must look like 1.2.3 (found \"$VERSION\")."
git diff --quiet && git diff --cached --quiet || fail "Commit your changes before releasing."
if git rev-parse -q --verify "refs/tags/$TAG" > /dev/null || "$GH" release view "$TAG" > /dev/null 2>&1; then
  fail "$TAG is already released. Bump the number in VERSION first."
fi

NOTES="${1:-}"
if [[ -z "$NOTES" ]]; then
  PREVIOUS="$(git describe --tags --abbrev=0 2>/dev/null || true)"
  if [[ -n "$PREVIOUS" ]]; then
    NOTES="$(git log --no-merges --pretty='- %s' "$PREVIOUS..HEAD")"
  else
    NOTES="First release."
  fi
fi

./build.sh

ZIP="$ROOT/build/LogoGrid-$VERSION.zip"
rm -f "$ZIP"
ditto -c -k --sequesterRsrc --keepParent "$ROOT/build/LogoGrid.app" "$ZIP"

# The app shows the notes above the marker; people downloading from the
# release page also see how to install.
BODY="$NOTES

<!-- install -->
---
**Installing LogoGrid** (Mac, macOS 13 or later)

1. Download **LogoGrid-$VERSION.zip** below and double-click it.
2. Drag **LogoGrid** into your **Applications** folder.
3. Open it. The first time, macOS says it can't verify the app: click **Done**, then open **System Settings › Privacy & Security**, scroll down and click **Open Anyway**.

After that, LogoGrid tells you when a new version is available and installs it for you."

echo "→ Pushing $(git branch --show-current)"
git push origin HEAD

echo "→ Publishing $TAG"
"$GH" release create "$TAG" "$ZIP" --target "$(git rev-parse HEAD)" --title "LogoGrid $VERSION" --notes "$BODY"
git fetch --tags --quiet origin

echo "✓ Released LogoGrid $VERSION"
"$GH" release view "$TAG" --json url --jq .url
