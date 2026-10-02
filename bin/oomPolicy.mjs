import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

export function viewerServiceUnit(cgroup) {
  const line = cgroup.split("\n").find((entry) => entry.startsWith("0::"));
  if (!line || !/\/user@\d+\.service\//.test(line)) return null;
  const unit = line.slice(3).split("/").pop();
  return /^(?:[a-zA-Z0-9_:@.-]|\\x[0-9a-fA-F]{2})+\.service$/.test(unit) ? unit : null;
}
export function oomPolicyNotice(unit, policy, lang = "en") {
  if (!unit || !["stop", "kill"].includes(policy.trim())) return null;
  const intro = lang === "uk"
    ? `Delegatus: ${unit} зупинить усіх агентів після одного OOM kill. Додайте drop-in, потім виконайте daemon-reload і перезапустіть сервіс, коли агенти завершать роботу:`
    : `Delegatus: ${unit} stops every agent after one OOM kill. Add this drop-in, then daemon-reload and restart the service when agents finish:`;
  return `${intro}\n# $HOME/.config/systemd/user/${unit}.d/oom.conf\n[Service]\nOOMPolicy=continue\nOOMScoreAdjust=100\n\nsystemctl --user daemon-reload\nsystemctl --user restart '${unit}'`;
}
export function detectOomPolicyNotice(lang, ports = {}) {
  if ((ports.platform ?? process.platform) !== "linux") return null;
  try {
    const unit = viewerServiceUnit((ports.readCgroup ?? (() => readFileSync("/proc/self/cgroup", "utf8")))());
    if (!unit) return null;
    const policy = (ports.policy ?? ((name) => execFileSync("systemctl", ["--user", "show", "-p", "OOMPolicy", "--value", name], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "pipe"] })))(unit);
    return oomPolicyNotice(unit, policy, lang);
  } catch { return null; }
}
