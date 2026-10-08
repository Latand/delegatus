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

# CPU-pressure admission with hysteresis, as in src/lib/runtime/cpuPressure.ts:
# hold at avg10 >= hold, release after release_after seconds below release. A
# failed sample admits; the scope quotas still bound the work.
psi_file=${LLV_GATE_PSI_FILE:-/proc/pressure/cpu}
hold=${DELEGATUS_CPU_PRESSURE_HOLD:-${LLV_CPU_PRESSURE_HOLD:-20}}
release=${DELEGATUS_CPU_PRESSURE_RELEASE:-${LLV_CPU_PRESSURE_RELEASE:-10}}
release_after=${LLV_GATE_PSI_RELEASE_SECONDS:-10}
defer_after=${LLV_GATE_PSI_DEFER_SECONDS:-120}
held=0 held_since=0 below_since=-1 deferred=0
avg10() { awk '/^some /{for(i=2;i<=NF;i++) if($i ~ /^avg10=/){sub(/^avg10=/,"",$i); print $i; exit}}' "$psi_file" 2>/dev/null; }
at_least() { awk -v a="$1" -v b="$2" 'BEGIN{exit !(a+0 >= b+0)}'; }
pressure_admits() {
  [[ ${DELEGATUS_CPU_PRESSURE:-${LLV_CPU_PRESSURE:-on}} == off ]] && return 0
  local value now=$SECONDS
  value=$(avg10) || value=""
  if [[ ! "$value" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then held=0; return 0; fi
  if (( ! held )); then
    at_least "$value" "$hold" || return 0
    held=1 held_since=$now below_since=-1
    echo "gate-slot: held for CPU pressure: avg10 ${value}% >= ${hold}%; starts once it stays below ${release}% for ${release_after}s" >&2
    return 1
  fi
  if at_least "$value" "$release"; then below_since=-1
  else
    (( below_since >= 0 )) || below_since=$now
    if (( now - below_since >= release_after )); then
      held=0
      echo "gate-slot: admitted after $(( now - held_since ))s of CPU pressure" >&2
      return 0
    fi
  fi
  if (( ! deferred && now - held_since >= defer_after )); then
    deferred=1
    echo "gate-slot: deferred by CPU pressure for ${defer_after}s (avg10 ${value}%); still waiting" >&2
  fi
  return 1
}

# macOS has neither flock nor a systemd user manager.
if ! command -v flock >/dev/null; then
  until pressure_admits; do sleep "$poll"; done
  run "$@"
fi
lock_dir=${LLV_GATE_LOCK_DIR:-/var/tmp}
mkdir -p "$lock_dir"
# Pressure is sampled in the pass that takes the slot, so a gate that waited
# behind busy slots starts on a fresh sample, and a held gate occupies no slot.
while :; do
  if pressure_admits; then
    for ((i=1; i<=slots; i++)); do
      exec 9>"$lock_dir/llv-heavy-gate.slot$i.lock"
      if flock -n 9; then run "$@"; fi
      exec 9>&-
    done
  fi
  sleep "$poll"
done
