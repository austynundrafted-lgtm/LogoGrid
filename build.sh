#!/bin/bash
# Builds LogoGrid.app. Pass --install to copy it into ~/Applications.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
BUILD="$ROOT/build"
APP="$BUILD/LogoGrid.app"
VERSION="$(tr -d '[:space:]' < "$ROOT/VERSION")"
BUILD_NUMBER="$(git -C "$ROOT" rev-list --count HEAD 2>/dev/null || echo 1)"

echo "→ Running engine tests"
node "$ROOT/tests/geometry.test.js" > /dev/null
node "$ROOT/tests/accuracy.test.js" > /dev/null || { node "$ROOT/tests/accuracy.test.js" | grep FAIL; exit 1; }

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "→ Compiling LogoGrid $VERSION ($BUILD_NUMBER) for Apple Silicon and Intel"
SOURCES=("$ROOT/app/macos/main.swift" "$ROOT/app/macos/Updater.swift")
for arch in arm64 x86_64; do
  swiftc -O -swift-version 5 -target "$arch-apple-macos13.0" "${SOURCES[@]}" -o "$BUILD/LogoGrid-$arch"
done
lipo -create "$BUILD/LogoGrid-arm64" "$BUILD/LogoGrid-x86_64" -output "$APP/Contents/MacOS/LogoGrid"
rm -f "$BUILD/LogoGrid-arm64" "$BUILD/LogoGrid-x86_64"

cp "$ROOT/app/macos/Info.plist" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" -c "Set :CFBundleVersion $BUILD_NUMBER" "$APP/Contents/Info.plist"
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
