#!/bin/bash
set -euo pipefail
mode=${1:?Pass pr or release}
output=${2:?Pass an output directory}
tarball=${3:-}
case "$mode" in pr|release) ;; *) exit 2 ;; esac
[[ ${GITHUB_REPOSITORY:-} =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]
mkdir -p "$output"
output=$(cd "$output" && pwd)
stage=$(mktemp -d "$output/build.XXXXXXXX")
trap 'rm -rf "$stage"' EXIT
app="$stage/image/Delegatus.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
bun scripts/mac-app/manifest.ts "$mode" "$app/Contents/Resources/runtime-manifest.json" "$tarball"
if [ "$mode" = pr ]; then cp "$tarball" "$app/Contents/Resources/delegatus.tgz"; fi
bun scripts/mac-app/icon.ts "$stage/AppIcon.iconset"
iconutil -c icns "$stage/AppIcon.iconset" -o "$app/Contents/Resources/AppIcon.icns"
version=$(bun -e 'console.log(require("./package.json").version)')
sed -e "s/@VERSION@/$version/g" -e "s|@REPOSITORY@|$GITHUB_REPOSITORY|g" macos/Info.plist.in > "$app/Contents/Info.plist"
cp -R macos/Resources/. "$app/Contents/Resources/"
cp LICENSE "$app/Contents/Resources/LICENSE"
printf APPL???? > "$app/Contents/PkgInfo"
for arch in arm64 x86_64; do
  if [ "$arch" = x86_64 ]; then
    # Keep Intel code at the generic x86_64 baseline; the array-free branch
    # also works with macOS's Bash 3.2 under `set -u`.
    swiftc -swift-version 5 -O -target "$arch-apple-macos13.0" -Xllvm -mcpu=x86-64 -framework AppKit -framework WebKit macos/Sources/*.swift -o "$stage/Delegatus-$arch"
  else
    swiftc -swift-version 5 -O -target "$arch-apple-macos13.0" -framework AppKit -framework WebKit macos/Sources/*.swift -o "$stage/Delegatus-$arch"
  fi
done
lipo -create "$stage/Delegatus-arm64" "$stage/Delegatus-x86_64" -output "$app/Contents/MacOS/Delegatus"
lipo "$app/Contents/MacOS/Delegatus" -verify_arch arm64 x86_64
swiftc -swift-version 5 macos/Sources/Install.swift macos/Sources/Server.swift macos/Sources/ListenerKeeper.swift macos/Sources/MenuWindow.swift macos/Tests/CoreChecks.swift -o "$stage/core-checks"
"$stage/core-checks"
node scripts/mac-app/installer-checks.mjs "$app/Contents/Resources"
plutil -lint "$app/Contents/Info.plist" "$app/Contents/Resources/"*.lproj/*.strings
codesign --force --sign "${SIGNING_IDENTITY:--}" "$app"
codesign --verify --strict --verbose=2 "$app"
ln -s /Applications "$stage/image/Applications"
name="Delegatus-$version-mac.dmg"
hdiutil create -volname Delegatus -srcfolder "$stage/image" -ov -format UDZO "$output/$name"
(cd "$output" && shasum -a 256 "$name" > "$name.sha256")
