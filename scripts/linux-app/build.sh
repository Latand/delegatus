#!/bin/bash
set -euo pipefail
mode=${1:?Pass pr or release}
output=${2:?Pass an output directory}
tarball=${3:-}
case "$mode" in pr|release) ;; *) exit 2 ;; esac
[[ ${GITHUB_REPOSITORY:-} =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]
export SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct)}
[[ $SOURCE_DATE_EPOCH =~ ^[0-9]+$ ]]
mkdir -p "$output"
output=$(cd "$output" && pwd)
stage=$(mktemp -d "$output/build.XXXXXXXX")
trap 'rm -rf "$stage"' EXIT
LAUNCHER_PLATFORM=linux bun scripts/mac-app/manifest.ts "$mode" "$stage/runtime-manifest.json" "$tarball"
if [ "$mode" = pr ]; then cp "$tarball" "$stage/delegatus.tgz"; fi
bun scripts/mac-app/icon.ts "$stage/icons"
python3 -I -m unittest discover -s linux/tests
python3 -I scripts/linux-app/build_package.py "$mode" "$output" "$stage/runtime-manifest.json" "$stage/icons"
