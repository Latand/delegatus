#!/usr/bin/env bash
# Turns a fresh Ubuntu 24.04 host into a gate runner that meets the runner
# contract of docs/design/remote-gate-runner.md §8.5. Every step checks its
# result first, so a second run changes nothing.
#
#   ssh root@<new host> 'bash -s' -- --key "<public key>" --repository <public clone URL> \
#     --bun "$(bun -e 'console.log(require("./scripts/local-gate.ts").pinnedBunVersion(require("fs").readFileSync("Dockerfile","utf8")))')" \
#     < scripts/gate-runner/provision.sh
#   provision.sh --print-settings   print the derived slots and MemoryHigh; change nothing
#   provision.sh --user-settings    as the runner account: write only the env file and the slice drop-in
#
# LLV_PROVISION_CPUS and LLV_PROVISION_MEMTOTAL_KB replace the two readings.
set -euo pipefail

repository=""
bun_version=""
runner_user=gate
key=""
mode=root
while [[ $# -gt 0 ]]; do
  case $1 in
    --print-settings) mode=print ;;
    --user-settings) mode=user ;;
    --key) key=$2; shift ;;
    --repository) repository=$2; shift ;;
    --bun) bun_version=$2; shift ;;
    *) echo "provision.sh: unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done

# Slots are the smaller of a CPU bound (three work-slice CPUs per slot, as on
# the development machine) and a memory bound (one 8 GiB gate unit per slot,
# 4 GiB kept for sshd, the user manager and git).
settings() {
  local cpus mem_kb reserve_kb unit_kb by_cpu by_mem slots high_kb
  cpus=${LLV_PROVISION_CPUS:-$(nproc)}
  mem_kb=${LLV_PROVISION_MEMTOTAL_KB:-$(awk '/^MemTotal:/{print $2}' /proc/meminfo)}
  reserve_kb=$((4 * 1024 * 1024)); unit_kb=$((8 * 1024 * 1024))
  by_cpu=$((cpus * 3 / 4 / 3))
  by_mem=$(((mem_kb - reserve_kb) / unit_kb))
  slots=$((by_cpu < by_mem ? by_cpu : by_mem)); ((slots >= 1)) || slots=1
  high_kb=$((mem_kb - reserve_kb))
  echo "LLV_GATE_SLOTS=$slots"
  echo "MemoryHigh=${high_kb}K"
}

user_settings() {
  local slots high
  slots=$(settings | sed -n 's/^LLV_GATE_SLOTS=//p')
  high=$(settings | sed -n 's/^MemoryHigh=//p')
  local env_file="$HOME/.gate-runner.env" dropin="$HOME/.config/systemd/user/delegatus-agents-work.slice.d/50-memory.conf"
  local want_env="LLV_GATE_SLOTS=$slots" want_dropin
  want_dropin=$(printf '[Slice]\nMemoryHigh=%s\n' "$high")
  if [[ ! -f $env_file ]] || ! grep -qx "$want_env" "$env_file"; then
    { grep -v '^LLV_GATE_SLOTS=' "$env_file" 2>/dev/null || true; echo "$want_env"; } > "$env_file.next"
    mv "$env_file.next" "$env_file"
  fi
  if [[ "$(cat "$dropin" 2>/dev/null)" != "$want_dropin" ]]; then
    mkdir -p "$(dirname "$dropin")"
    printf '%s\n' "$want_dropin" > "$dropin"
    XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)} systemctl --user daemon-reload
  fi
}

case $mode in
  print) settings; exit 0 ;;
  user) user_settings; exit 0 ;;
esac

[[ $(id -u) == 0 ]] || { echo "provision.sh: run as root (or use --user-settings as $runner_user)" >&2; exit 2; }
[[ -n $repository && $bun_version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "provision.sh: --repository and --bun <pinned version> are required" >&2; exit 2; }
as_runner() { runuser -u "$runner_user" -- env HOME="/home/$runner_user" XDG_RUNTIME_DIR="/run/user/$(id -u "$runner_user")" bash -c "$1"; }

# 1. The account, its key, lingering and swap.
id "$runner_user" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$runner_user"
install -d -m 700 -o "$runner_user" -g "$runner_user" "/home/$runner_user/.ssh"
if [[ -n $key ]] && ! grep -qxF "$key" "/home/$runner_user/.ssh/authorized_keys" 2>/dev/null; then
  echo "$key" >> "/home/$runner_user/.ssh/authorized_keys"
  chown "$runner_user:$runner_user" "/home/$runner_user/.ssh/authorized_keys"; chmod 600 "/home/$runner_user/.ssh/authorized_keys"
fi
loginctl enable-linger "$runner_user"
if ! swapon --show=NAME --noheadings | grep -q .; then
  fallocate -l 16G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# 2. Packages and Node 22 from a checksum-verified official tarball.
export DEBIAN_FRONTEND=noninteractive
missing=()
for package in git curl unzip build-essential rsync zstd unattended-upgrades; do dpkg -s "$package" >/dev/null 2>&1 || missing+=("$package"); done
if ((${#missing[@]})); then apt-get update -q && apt-get install -yq "${missing[@]}"; fi
if ! command -v node >/dev/null || [[ $(node --version) != v22.* ]]; then
  base=https://nodejs.org/dist/latest-v22.x
  tarball=$(curl -fsSL "$base/SHASUMS256.txt" | awk '/linux-x64.tar.xz$/{print $2}')
  work=$(mktemp -d)
  curl -fsSL -o "$work/$tarball" "$base/$tarball"
  (cd "$work" && curl -fsSL "$base/SHASUMS256.txt" | grep " $tarball\$" | sha256sum -c -)
  tar -xJf "$work/$tarball" -C /usr/local --strip-components=1
  rm -rf -- "$work"
fi

# 3. The Bun the Dockerfile pins, as the runner account.
as_runner "[[ \$(~/.bun/bin/bun --version 2>/dev/null) == $bun_version ]] || curl -fsSL https://bun.sh/install | bash -s bun-v$bun_version"

# 4. The mirror, the warm checkout and their refresh timer.
as_runner "[[ -d ~/mirror/delegatus.git ]] || git clone --quiet --mirror $repository ~/mirror/delegatus.git"
as_runner "[[ -d ~/warm/.git ]] || git clone --quiet --shared ~/mirror/delegatus.git ~/warm"
as_runner 'mkdir -p ~/bin ~/.config/systemd/user ~/runs'
as_runner 'cat > ~/bin/refresh-mirror <<"EOF"
#!/bin/bash
set -eu
git --git-dir ~/mirror/delegatus.git fetch --quiet --prune origin
cd ~/warm
before=$(git rev-parse HEAD:bun.lock 2>/dev/null || true)
git fetch --quiet origin && git checkout --quiet --detach origin/main
after=$(git rev-parse HEAD:bun.lock)
if [[ $before != "$after" || ! -d node_modules ]]; then ~/.bun/bin/bun install --frozen-lockfile >/dev/null; fi
EOF
chmod 755 ~/bin/refresh-mirror'
as_runner 'cat > ~/.config/systemd/user/refresh-mirror.service <<"EOF"
[Service]
Type=oneshot
ExecStart=%h/bin/refresh-mirror
EOF
cat > ~/.config/systemd/user/refresh-mirror.timer <<"EOF"
[Timer]
OnBootSec=1min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
EOF
systemctl --user daemon-reload && systemctl --user enable --now refresh-mirror.timer >/dev/null && ~/bin/refresh-mirror'

# 5. Chromium from the lockfile's playwright-core, with its system libraries.
as_runner 'ls -d ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome >/dev/null 2>&1 || (cd ~/warm && ~/.bun/bin/bun node_modules/playwright-core/cli.js install chromium)'
(cd "/home/$runner_user/warm" && PLAYWRIGHT_BROWSERS_PATH="/home/$runner_user/.cache/ms-playwright" node node_modules/playwright-core/cli.js install-deps chromium >/dev/null)

# 6. Concurrency from nproc and MemTotal.
as_runner "$(declare -f settings user_settings); user_settings"

# 7. SSH: keys only; root keeps key login so this script can run again.
conf=/etc/ssh/sshd_config.d/50-gate-runner.conf
want=$'PasswordAuthentication no\nPermitRootLogin prohibit-password\nClientAliveInterval 15\nClientAliveCountMax 3'
if [[ "$(cat "$conf" 2>/dev/null)" != "$want" ]]; then printf '%s\n' "$want" > "$conf"; systemctl reload ssh; fi

# 8. A command cannot read the memory of the process that holds the run's nonce.
if [[ $(cat /proc/sys/kernel/yama/ptrace_scope) == 0 ]]; then
  echo 'kernel.yama.ptrace_scope = 1' > /etc/sysctl.d/60-gate-runner-ptrace.conf
  sysctl -q -p /etc/sysctl.d/60-gate-runner-ptrace.conf
fi
echo "provision.sh: the host meets the runner contract"
