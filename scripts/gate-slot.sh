#!/usr/bin/env bash
# Heavy commands wait for low CPU pressure and a free shared machine slot in
# the same pass, then run in their own scope in the CPU work slice
# (docs/design/cpu-placement.md). The slot lock files are the ones the installed
# /var/tmp/llv-gate uses, so both gates count against one set of slots.
set -euo pipefail
slots=${LLV_GATE_SLOTS:-6}
if [[ ! "$slots" =~ ^[1-9][0-9]*$ ]]; then
  echo "LLV_GATE_SLOTS must be a positive integer" >&2
  exit 2
fi
if [[ $# -eq 0 ]]; then echo "usage: gate-slot.sh command [args...]" >&2; exit 2; fi
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=6144}"
poll=${LLV_GATE_POLL_SECONDS:-2}

# CPU placement: the same defaults as src/lib/runtime/cpuPlacement.ts. Each
# setting is read as DELEGATUS_X, then as the LLV_X an entry point folds it into.
slice=${LLV_GATE_SLICE:-delegatus-agents-work.slice}
# The machine's online CPUs whatever this process's affinity, like onlineCpuCount.
cpus=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)
whole=$(( cpus * 3 / 4 )); (( whole >= 1 )) || whole=1
aggregate=${DELEGATUS_WORK_CPU_QUOTA:-${LLV_WORK_CPU_QUOTA:-$(( whole * 100 ))}}; aggregate=${aggregate%\%}
scope_quota=${DELEGATUS_WORK_SCOPE_CPU_QUOTA:-${LLV_WORK_SCOPE_CPU_QUOTA:-300}}; scope_quota=${scope_quota%\%}
for value in "$aggregate" "$scope_quota"; do
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then echo "gate-slot: CPU quotas must be positive percentages" >&2; exit 2; fi
done
refuse() {
  echo "gate-slot: CPU containment for gates is unavailable: $1. Set DELEGATUS_AGENT_CPU=off to run without CPU placement." >&2
  exit 69
}
cpu_applies() {
  [[ ${DELEGATUS_AGENT_CPU:-${LLV_AGENT_CPU:-auto}} != off && $(uname -s 2>/dev/null) == Linux && ! -f /.dockerenv && ${LLV_DOCKER_NSENTER_SHIMS:-} != 1 ]]
}
user_manager() {
  command -v systemd-run >/dev/null && command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1
}
own_cgroup() {
  local line
  { while IFS= read -r line; do [[ $line == 0::* ]] && { echo "${line#0::}"; return 0; }; done < "${LLV_GATE_CGROUP_FILE:-/proc/self/cgroup}"; } 2>/dev/null
  return 1
}
# The user manager accepts CPU properties even where an ancestor keeps the cpu
# controller off (DisableControllers=cpu, an undelegated slice), and the scope
# then runs with no controls; only the kernel files prove the quotas hold. This
# process's scope and the work slice above it must both carry a quota.
cpu_quota_effective() {
  local root=${LLV_GATE_CGROUP_ROOT:-/sys/fs/cgroup} group own="" above=""
  group=$(own_cgroup) && [[ $group == */"$slice"/* ]] || { echo "the gate's cgroup ${group:-(unreadable)} is outside $slice"; return 1; }
  { read -r own _ < "$root$group/cpu.max"; } 2>/dev/null
  { read -r above _ < "$root${group%%/"$slice"/*}/$slice/cpu.max"; } 2>/dev/null
  [[ $own =~ ^[0-9]+$ && $above =~ ^[0-9]+$ ]] && return 0
  echo "the kernel applied no CPU quota to $group (cpu.max ${own:-absent}, $slice cpu.max ${above:-absent}); the cpu controller is off on an ancestor"
  return 1
}
verified_exec() {
  local reason
  reason=$(cpu_quota_effective) || refuse "$reason"
  exec "$@"
}
# The command runs through this script once more inside its new scope, which
# checks the kernel's controls before it execs the command in place.
if [[ ${1:-} == --in-cpu-scope ]]; then shift; verified_exec "$@"; fi
run() {
  if cpu_applies; then
    user_manager || refuse "no reachable systemd user manager"
    systemctl --user set-property --runtime "$slice" CPUWeight=100 "CPUQuota=${aggregate}%" CPUQuotaPeriodSec=20ms >/dev/null 2>&1 \
      || refuse "the user manager refused the quota for $slice"
    export LLV_OWNED_RUN_CPU_SLICE="$slice" LLV_OWNED_RUN_CPU_QUOTA="$scope_quota"
    exec "${LLV_GATE_BUN:-bun}" "$(dirname "${BASH_SOURCE[0]}")/owned-runner.ts" /bin/bash "${BASH_SOURCE[0]}" --in-cpu-scope "$@"
  fi
  if user_manager; then
    exec "${LLV_GATE_BUN:-bun}" "$(dirname "${BASH_SOURCE[0]}")/owned-runner.ts" "$@"
  fi
  exec "${LLV_GATE_BUN:-bun}" "$(dirname "${BASH_SOURCE[0]}")/owned-runner.ts" --portable "$@"
}

# Keep the ticket until a slot is locked and its admission is committed.
# CPU waits precede the owned runner's execution deadline.
lock_dir=${LLV_GATE_LOCK_DIR:-/var/tmp}
mkdir -p "$lock_dir"
admission="$(dirname "${BASH_SOURCE[0]}")/cpu-admission.ts"
# A nested command continues an already admitted job. The helper validates
# the parent start identity and its kernel-held slot before reusing it.
if "${LLV_GATE_BUN:-bun}" "$admission" --reuse-slot; then run "$@"; fi
queue_key="command:$$:$RANDOM:$RANDOM"
while :; do
  "${LLV_GATE_BUN:-bun}" "$admission" --wait "$queue_key" "$$"
  if ! command -v flock >/dev/null; then
    if "${LLV_GATE_BUN:-bun}" "$admission" --claim "$queue_key" "$$"; then run "$@"; fi
  else
    for ((i=1; i<=slots; i++)); do
      exec 9>"$lock_dir/llv-heavy-gate.slot$i.lock"
      if flock -n 9; then
        if "${LLV_GATE_BUN:-bun}" "$admission" --claim "$queue_key" "$$"; then run "$@"; fi
      fi
      exec 9>&-
    done
  fi
  sleep "$poll"
done
