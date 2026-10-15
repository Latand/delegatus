import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { processIdentityStatus, type ProcessIdentity } from "@/lib/processIdentity";

/** Runs in the host mount, PID and cgroup namespaces as root. Namespace entry
 * alone leaves native CLI children in Docker's cgroup. Hold the Viewer, move
 * every other process (including detached descendants and this helper) to a
 * sibling, and prove Docker has only the held Viewer left before allowing its
 * init to exit. Keeping the same parent retains ancestor limits; copy the
 * container's explicit CPU/memory limits onto the retained cohort as well.
 * No registry row or delivery key changes during this kernel-only handoff. */
const PRESERVE_NATIVE = `
set -eu
owner=$1
expected=$2
identity() { line=$(cat "/proc/$1/stat") || return 1; fields=\${line##*) }; printf '%s:%s' "$1" "$(printf '%s' "$fields" | cut -d ' ' -f20)"; }
[ "$(identity "$owner")" = "$expected" ]
group=$(sed -n 's/^0:://p' "/proc/$owner/cgroup")
id=$(printf '%s' "$group" | sed -nE 's@.*/(docker-)?([a-f0-9]{64})(\\.scope)?$@\\2@p')
[ "\${#id}" = 64 ]
source=/sys/fs/cgroup$group
destination=\${source%/*}/delegatus-retained-$id
[ -f "$source/cgroup.procs" ]
kill -STOP "$owner"
complete=0
restore() { if [ "$complete" = 0 ] && [ "$(identity "$owner" 2>/dev/null)" = "$expected" ]; then kill -CONT "$owner"; fi; }
trap restore EXIT
attempt=0
while :; do
  [ "$(identity "$owner")" = "$expected" ]
  stopped=1
  for task in /proc/$owner/task/*/stat; do
    line=$(cat "$task")
    fields=\${line##*) }
    case "$fields" in T\\ *|t\\ *) ;; *) stopped=0 ;; esac
  done
  [ "$stopped" = 1 ] && break
  attempt=$((attempt+1)); [ "$attempt" -lt 100 ]; sleep 0.01
done
mkdir -p "$destination"
for control in cpu.max cpu.weight memory.max memory.high memory.swap.max pids.max; do
  if [ -f "$source/$control" ]; then cat "$source/$control" > "$destination/$control"; fi
done
attempt=0
while :; do
  # Enumerate the container subtree, including scopes created by its children.
  members=$(find "$source" -name cgroup.procs -exec cat {} \\; | sort -nu)
  moved=0
  for member in $members; do
    [ "$member" = "$owner" ] && continue
    member_group=$(sed -n 's/^0:://p' "/proc/$member/cgroup" 2>/dev/null) || continue
    case "$member_group" in "$group"|"$group"/*) ;; *) continue ;; esac
    if ! printf '%s\\n' "$member" > "$destination/cgroup.procs"; then
      # An exited child needs no relocation. Every extant child must move.
      [ ! -e "/proc/$member" ] || exit 1
    fi
    moved=1
  done
  [ "$moved" = 0 ] && break
  attempt=$((attempt+1)); [ "$attempt" -lt 100 ]
done
[ "$(identity "$owner")" = "$expected" ]
complete=1
printf 'native cohort preserved\\n'`;

export function managedNativePreservationArgs(owner: ProcessIdentity): string[] {
  if (processIdentityStatus(owner) !== "alive" || !/^\d+:\d+$/.test(owner.startIdentity ?? "")) {
    throw new Error("native preservation requires a verified Linux Viewer identity");
  }
  return ["nsenter", "-t", "1", "-m", "-p", "-C", "--", "/usr/bin/setpriv", "--reuid=0", "--regid=0", "--clear-groups", "--", "/bin/sh", "-c", PRESERVE_NATIVE,
    "managed-native-preservation", String(owner.pid), owner.startIdentity!];
}

/** The in-container guard uses the image's setuid nsenter. The external adapter
 * uses Docker exec as root, so it also works from an unprivileged host CLI. */
export async function preserveManagedNativeProcesses(owner: ProcessIdentity): Promise<void> {
  const [command, ...args] = managedNativePreservationArgs(owner);
  await promisify(execFile)(command, args, { timeout: 5_000, maxBuffer: 64 * 1024 });
}

export function resumeRetirementOwner(owner: ProcessIdentity): void {
  if (processIdentityStatus(owner) === "alive") process.kill(owner.pid, "SIGCONT");
}
