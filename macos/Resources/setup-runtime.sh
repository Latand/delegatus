#!/bin/bash
# Private, fixed-path installation. This script never sources a shell profile.
set -euo pipefail
# Each supervised background command owns a process group, including scripts
# started by the package manager. Cancellation addresses only that group.
set -m
umask 077
runtime=$1
manifest=$2
if [[ ${1:-} != --locked ]]; then
  mkdir -p "$runtime"
  if ! /usr/bin/lockf -k -t 0 "$runtime/.install-lock-v2" /bin/bash "$0" --locked "$runtime" "$manifest"; then
    echo 'An installation is already in progress or could not complete. Check Open Logs.' >&2
    exit 1
  fi
  exit 0
fi
shift
runtime=$1
manifest=$2
resources=$(cd "$(dirname "$manifest")" && pwd)
read_manifest() { /usr/bin/plutil -extract "$1" raw -o - "$manifest"; }
case $(uname -m) in arm64) architecture=arm64 ;; x86_64) architecture=x86_64 ;; *) echo 'Unsupported architecture' >&2; exit 1 ;; esac
mkdir -p "$runtime"
legacy_lock="$runtime/.install-lock"
if [[ -d "$legacy_lock" ]]; then
  legacy_owner=$(cat "$legacy_lock/pid" 2>/dev/null || true)
  if [[ "$legacy_owner" =~ ^[0-9]+$ ]] && kill -0 "$legacy_owner" 2>/dev/null; then
    echo 'An installation is already in progress. Check Open Logs.' >&2; exit 1
  fi
  legacy_modified=$(/usr/bin/stat -f %m "$legacy_lock" 2>/dev/null || echo 0)
  legacy_age=$(( $(/bin/date +%s) - legacy_modified ))
  if (( legacy_age < 120 )); then
    echo 'A recent installation lock is incomplete. Wait briefly, then try again.' >&2; exit 1
  fi
  rm -rf "$legacy_lock"
fi
stage=$(mktemp -d "$runtime/.stage.XXXXXXXX")
child=''
published_bun=0
published_packages=0
committed=0
cleanup() {
  status=$?
  trap - EXIT TERM INT
  if [ -n "$child" ]; then
    kill -TERM -- "-$child" 2>/dev/null || true
    for ((attempt=0; attempt<50; attempt++)); do
      kill -0 -- "-$child" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL -- "-$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
  if [ "$committed" = 0 ]; then
    if [ "$published_packages" = 1 ]; then rm -rf "$runtime/packages"; fi
    if [ "$published_bun" = 1 ]; then rm -rf "$runtime/bun"; fi
    if [ -d "$stage/previous-bun" ]; then mv "$stage/previous-bun" "$runtime/bun"; fi
  fi
  rm -rf "$stage"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
run_child() { "$@" & child=$!; wait "$child"; child=''; }
download() {
  case "$1" in
    https://*) run_child /usr/bin/curl --fail --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 300 --retry 2 --silent --show-error --output "$2" "$1" ;;
    bundle:delegatus.tgz)
      [ "$(read_manifest mode)" = pr ] || { echo 'Local package forbidden in a release' >&2; exit 1; }
      cp "$resources/delegatus.tgz" "$2" ;;
    *) echo 'Untrusted archive URL' >&2; exit 1 ;;
  esac
}
bun_version=$(read_manifest bun.version)
package_version=$(read_manifest delegatus.version)
echo 'SETUP 1/3 Downloading and checking Bun'
download "$(read_manifest "bun.$architecture.url")" "$stage/bun.zip"
expected=$(read_manifest "bun.$architecture.sha256")
actual=$(/usr/bin/shasum -a 256 "$stage/bun.zip"); actual=${actual%% *}
[ "$actual" = "$expected" ] || { echo 'Bun checksum mismatch' >&2; exit 1; }
/usr/bin/unzip -q "$stage/bun.zip" -d "$stage/unpacked"
mkdir "$stage/bun"
mkdir "$stage/bun/bin"
case "$architecture" in arm64) binary=bun-darwin-aarch64 ;; x86_64) binary=bun-darwin-x64-baseline ;; esac
mv "$stage/unpacked/$binary/bun" "$stage/bun/bin/bun"
chmod 700 "$stage/bun/bin/bun"
[ "$("$stage/bun/bin/bun" --version)" = "$bun_version" ] || { echo 'Bun version mismatch' >&2; exit 1; }
# A newer app upgrades its private Bun without replacing an existing package.
use_bun="$stage/bun/bin/bun"
if [ -x "$runtime/bun/bin/bun" ]; then
  current_version=$("$runtime/bun/bin/bun" --version)
  if [[ "$current_version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    IFS=. read -r current_major current_minor current_patch <<< "$current_version"
    IFS=. read -r pinned_major pinned_minor pinned_patch <<< "$bun_version"
    if (( 10#$current_major > 10#$pinned_major ||
          (10#$current_major == 10#$pinned_major && 10#$current_minor > 10#$pinned_minor) ||
          (10#$current_major == 10#$pinned_major && 10#$current_minor == 10#$pinned_minor && 10#$current_patch >= 10#$pinned_patch) )); then
      use_bun="$runtime/bun/bin/bun"
    fi
  fi
fi
if [ ! -f "$runtime/packages/node_modules/delegatus-cli/bin/cli.mjs" ]; then
  echo 'SETUP 2/3 Downloading and checking Delegatus'
  download "$(read_manifest delegatus.tarball)" "$stage/delegatus.tgz"
  expected=$(read_manifest delegatus.integrity)
  actual="sha512-$(/usr/bin/openssl dgst -sha512 -binary "$stage/delegatus.tgz" | /usr/bin/openssl base64 -A)"
  [ "$actual" = "$expected" ] || { echo 'Delegatus checksum mismatch' >&2; exit 1; }
  mkdir "$stage/packages"
  mkdir -p "$stage/home"
  printf '{"private":true}\n' > "$stage/packages/package.json"
  (cd "$stage/packages" && HOME="$stage/home" exec "$use_bun" add --exact "$stage/delegatus.tgz") & child=$!
  wait "$child"; child=''
  root="$stage/packages/node_modules/delegatus-cli"
  [ "$(/usr/bin/plutil -extract name raw -o - "$root/package.json")" = delegatus-cli ]
  [ "$(/usr/bin/plutil -extract version raw -o - "$root/package.json")" = "$package_version" ]
  [ -f "$root/bin/cli.mjs" ] && [ -f "$root/dist/standalone/server.js" ] && [ -f "$root/dist/runtime-host.mjs" ]
fi
echo 'SETUP 3/3 Publishing the private runtime'
if [ "$use_bun" != "$runtime/bun/bin/bun" ]; then
  if [ -e "$runtime/bun" ]; then mv "$runtime/bun" "$stage/previous-bun"; fi
  mv "$stage/bun" "$runtime/bun"; published_bun=1
fi
if [ -d "$stage/packages" ]; then
  # Never replace a package root: its absolute path is the install identity.
  [ ! -e "$runtime/packages" ] || { echo 'Incomplete private package. Open Logs before repairing it.' >&2; exit 1; }
  mv "$stage/packages" "$runtime/packages"; published_packages=1
fi
committed=1
echo 'SETUP 3/3 Ready'
