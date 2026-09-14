#!/bin/bash
# Builds LogoGrid.app. Pass --install to copy it into ~/Applications.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
BUILD="$ROOT/build"
APP="$BUILD/LogoGrid.app"

echo "→ Running engine tests"
node "$ROOT/tests/geometry.test.js" > /dev/null
node "$ROOT/tests/accuracy.test.js" > /dev/null || { node "$ROOT/tests/accuracy.test.js" | grep FAIL; exit 1; }

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "→ Compiling"
swiftc -O -swift-version 5 -target "$(uname -m)-apple-macos13.0" \
  "$ROOT/app/macos/main.swift" -o "$APP/Contents/MacOS/LogoGrid"

cp "$ROOT/app/macos/Info.plist" "$APP/Contents/Info.plist"
cp -R "$ROOT/app/web" "$APP/Contents/Resources/web"

ICNS="$BUILD/AppIcon.icns"
if [[ ! -f "$ICNS" || "$ROOT/app/macos/make_icon.swift" -nt "$ICNS" ]]; then
  echo "→ Rendering icon"
  ICONSET="$BUILD/AppIcon.iconset"
  rm -rf "$ICONSET" && mkdir -p "$ICONSET"
  swift "$ROOT/app/macos/make_icon.swift" "$BUILD/icon-1024.png"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$BUILD/icon-1024.png" --out "$ICONSET/icon_${s}x${s}.png" > /dev/null
    sips -z $((s * 2)) $((s * 2)) "$BUILD/icon-1024.png" --out "$ICONSET/icon_${s}x${s}@2x.png" > /dev/null
  done
  iconutil -c icns "$ICONSET" -o "$ICNS"
fi
cp "$ICNS" "$APP/Contents/Resources/AppIcon.icns"

echo "→ Signing (ad hoc)"
codesign --force --deep --sign - "$APP" > /dev/null 2>&1

if [[ "${1:-}" == "--install" ]]; then
  mkdir -p "$HOME/Applications"
  rm -rf "$HOME/Applications/LogoGrid.app"
  cp -R "$APP" "$HOME/Applications/LogoGrid.app"
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$HOME/Applications/LogoGrid.app" > /dev/null 2>&1 || true
  echo "✓ Installed to ~/Applications/LogoGrid.app"
else
  echo "✓ Built $APP"
fi
