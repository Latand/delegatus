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

# The pre-push parent owns local privacy and dispatches its heavy --admitted
# half itself. Admitting the parent here would classify it as ineligible and
# turn the runner off before that dispatch. Keep its existing execution and
# cleanup fence without taking a local slot. Its owning service contains
# privacy and the remote client; heavy checks take their slot on the runner.
pre_push_parent() {
  local script expected root directory
  if [[ $# -eq 3 && ${1##*/} == bun && ${2##*/} == local-gate.ts && $3 == pre-push ]]; then
    script=$2; expected=scripts/local-gate.ts
  elif [[ $# -ge 2 && ( ${1##*/} == bash || ${1##*/} == sh ) && ${2##*/} == pre-push ]]; then
    script=$2; expected=.githooks/pre-push
  elif [[ ${1##*/} == pre-push ]]; then
    script=$1; expected=.githooks/pre-push
  else
    return 1
  fi
  [[ -f $script ]] || return 1
  directory=$(cd -- "$(dirname -- "$script")" && pwd -P) || return 1
  root=$(git -C "$directory" rev-parse --show-toplevel 2>/dev/null) || return 1
  root=$(cd -- "$root" && pwd -P) || return 1
  [[ $directory/${script##*/} == "$root/$expected" && -d $root/scripts/gate-runner ]]
}
# Inside an agent signal domain the gate service enters the caller's
# namespaces before the command runs (src/lib/runtime/sandboxGateEntry.ts), so
# the command keeps the gate's limits and the agent's signal boundary. Only
# without a user manager does it run in a leaf of the agent's own scope, whose
# memory cap then applies; that fallback is announced, never silent.
run() {
  if [[ -n ${LLV_SIGNAL_SANDBOX:-} ]] && ! user_manager; then
    echo "gate-slot: no reachable systemd user manager, so no gate service with MemoryMax=${LLV_GATE_MEM:-8G}; running in a bounded leaf of this agent's own scope instead, under the agent's memory cap" >&2
    exec "${LLV_GATE_BUN:-bun}" "$(dirname "${BASH_SOURCE[0]}")/owned-runner.ts" --namespace "$@"
  fi
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
if pre_push_parent "$@"; then run "$@"; fi

# Keep the ticket until a slot is locked and its admission is committed.
# CPU waits precede the owned runner's execution deadline.
lock_dir=${LLV_GATE_LOCK_DIR:-/var/tmp}
mkdir -p "$lock_dir"
admission="$(dirname "${BASH_SOURCE[0]}")/cpu-admission.ts"
# A nested command continues an already admitted job. The helper validates
# the parent start identity and its kernel-held slot before reusing it.
reuse_code=0
"${LLV_GATE_BUN:-bun}" "$admission" --reuse-slot || reuse_code=$?
if [[ $reuse_code == 0 ]]; then run "$@"; fi
if [[ $reuse_code != 75 ]]; then exit "$reuse_code"; fi
# A top-level heavy command may run on the gate runner instead
# (docs/design/remote-gate-runner.md §8.3). The runner file sits under the
# passwd home, which agents' private HOME and XDG_CONFIG_HOME do not hide. The
# client either exits with the remote verdict or writes "here", and the command
# is then admitted and run on this machine as before. A saturation decision
# is advisory: it skips no pressure, queue, slot or containment checks below.
runner_client="$(dirname "${BASH_SOURCE[0]}")/gate-runner/client.ts"
if [[ ${LLV_GATE_RUNNER:-} != off && ${NODE_ENV:-} != test && -f $runner_client && $(uname -s 2>/dev/null) == Linux ]] \
  && [[ -n ${LLV_GATE_RUNNER:-} || -n ${LLV_GATE_RUNNER_CONFIG:-} || -f "$(getent passwd "$(id -u)" | cut -d: -f6)/.config/delegatus/gate-runner.json" ]]; then
  runner_decision=$(mktemp "${TMPDIR:-/tmp}/gate-runner-decision.XXXXXXXX")
  # The client runs as a job so a TERM or INT sent to this shell reaches it:
  # it stops the remote run and confirms the stop before it exits.
  LLV_GATE_RUNNER_DECISION=$runner_decision "${LLV_GATE_BUN:-bun}" "$runner_client" "$@" <&0 &
  runner_pid=$!
  trap 'kill -TERM "$runner_pid" 2>/dev/null || true' TERM
  trap 'kill -INT "$runner_pid" 2>/dev/null || true' INT
  runner_code=0
  while :; do
    runner_code=0; wait "$runner_pid" || runner_code=$?
    kill -0 "$runner_pid" 2>/dev/null || break
  done
  trap - TERM INT
  runner_here=$(<"$runner_decision"); rm -f -- "$runner_decision"
  if [[ $runner_here != here ]]; then exit "$runner_code"; fi
  export LLV_GATE_RUNNER=off
fi
# MSYS/Cygwin shell PIDs differ from the Windows PIDs the native Bun helper
# probes. The shell's virtual proc file supplies its native PID.
owner_pid=$$
winpid_file="${LLV_GATE_PROC_ROOT:-/proc}/$$/winpid"
if [[ -r "$winpid_file" ]]; then owner_pid=$(< "$winpid_file"); fi
if [[ ! "$owner_pid" =~ ^[1-9][0-9]*$ ]]; then
  echo "gate-slot: the shell's native owner PID is invalid" >&2
  exit 2
fi
# The shell's pauses after a lost lock race are admission time too. Keep one
# ledger interval alive until the successful claim, including helper handoffs.
wait_dir=""
end_cpu_wait() {
  if [[ -n "$wait_dir" ]]; then
    touch "$wait_dir/done"
    wait "$wait_pid" || true
    rm -rf -- "$wait_dir"
    wait_dir=""
  fi
}
if [[ -n ${LLV_CPU_WAIT_ROOTS:-} && ${LLV_CPU_WAIT_ROOTS:-} != '[]' ]]; then
  wait_dir=$(mktemp -d "${TMPDIR:-/tmp}/delegatus-cpu-wait.XXXXXXXX")
  "${LLV_GATE_BUN:-bun}" "$admission" --watch-wait "$wait_dir" "$owner_pid" &
  wait_pid=$!
  trap end_cpu_wait EXIT
  trap 'end_cpu_wait; exit 130' INT TERM
  while [[ ! -f "$wait_dir/ready" ]]; do
    kill -0 "$wait_pid" 2>/dev/null || { echo "gate-slot: CPU wait monitor did not start" >&2; exit 70; }
    sleep 0.02
  done
fi
queue_key="command:$$:$RANDOM:$RANDOM"
while :; do
  "${LLV_GATE_BUN:-bun}" "$admission" --wait "$queue_key" "$owner_pid"
  if ! command -v flock >/dev/null; then
    if "${LLV_GATE_BUN:-bun}" "$admission" --claim "$queue_key" "$owner_pid"; then end_cpu_wait; run "$@"; fi
  else
    for ((i=1; i<=slots; i++)); do
      exec 9>"$lock_dir/llv-heavy-gate.slot$i.lock"
      if flock -n 9; then
        if "${LLV_GATE_BUN:-bun}" "$admission" --claim "$queue_key" "$owner_pid"; then end_cpu_wait; run "$@"; fi
      fi
      exec 9>&-
    done
  fi
  sleep "$poll"
done
