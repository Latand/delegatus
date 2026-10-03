import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ReleasePointer } from "./release";
import type { ModeDecision } from "./mode";
import type { InstallAction } from "./types";

const quote = (text: string) => `\u0027${text.replaceAll("\u0027", "\u0027\\\u0027\u0027")}\u0027`;
export function userUnit(cgroup: string): string | null {
  if (!/\/user@\d+\.service\//.test(cgroup)) return null;
  const match = /\/([A-Za-z0-9_.@\\x-]+\.service)(?:\n|$)/.exec(cgroup);
  return match?.[1] ?? null;
}
function read(file: string): string { try { return readFileSync(file, "utf8"); } catch { return ""; } }
function ready(pointer: string, root: string): boolean {
  try {
    const value = JSON.parse(read(pointer));
    const release = new ReleasePointer(pointer, root).current();
    if (release.sha !== value.sha || release.dir !== value.dir) return false;
    return read(join(value.dir, "bin", "launcher-relaunch.mjs")).includes("delegatus-launcher-relaunch-v1");
  } catch { return false; }
}
function serviceFor(root: string): string | null {
  const directory = join(homedir(), ".config", "systemd", "user");
  try {
    const units = readdirSync(directory).filter(name => /^[A-Za-z0-9_.@-]+\.service$/.test(name)
      && read(join(directory, name)).split("\n").some(line => line.startsWith("ExecStart=") && line.includes(join(root, "bin", "cli.mjs"))));
    return units.length === 1 ? units[0]! : null;
  } catch { return null; }
}
export function installAction(decision: ModeDecision, ports: { cgroup(pid: number): string; ready(pointer: string, root: string): boolean; argv?(pid: number): string[] } = {
  cgroup: (pid: number) => read(`/proc/${pid}/cgroup`), ready,
  argv: (pid: number): string[] => read(`/proc/${pid}/cmdline`).split("\0").filter(Boolean),
}, root = decision.record?.checkout ?? decision.record?.installRoot ?? decision.installRoot ?? process.cwd()): InstallAction | null {
  if (decision.mode === "managed" || decision.record?.launcher.relaunch === 1) return null;
  if (decision.reason === "docker-deployments") return { id: "docker-deployments", button: false,
    command: "LLV_VIEWER_DEPLOYMENTS=1 docker compose --profile runtime-host up -d" };
  const args: string[] = [];
  const original = decision.record ? ports.argv?.(decision.record.launcher.pid) ?? [] : [];
  for (let i = 0; i < original.length; i++) {
    const arg = original[i]!;
    if (["--port", "-p", "--hostname", "-H"].includes(arg) && original[i + 1]) args.push(arg, original[++i]!);
    else if (arg === "--tailscale" || arg.startsWith("--port=") || arg.startsWith("--hostname=")) args.push(arg);
  }
  if (decision.record?.port && !args.some(arg => ["--port", "-p"].includes(arg) || arg.startsWith("--port="))) args.push("--port", String(decision.record.port));
  const command = [process.execPath, join(root, "bin", "cli.mjs"), ...args, "--no-open"].map(quote).join(" ");
  if (decision.record) {
    if (!ports.ready(decision.record.releasePointer, root)) return { id: "update-first", button: true };
    const unit = userUnit(ports.cgroup(decision.record.launcher.pid));
    return unit ? { id: "restart-service", button: true, unit }
      : { id: "restart-terminal", button: false, command };
  }
  const unit = serviceFor(root);
  return unit ? { id: "start-service", button: true, unit } : { id: "start-launcher", button: false, command };
}
export function runInstallAction(action: InstallAction, run: (args: string[]) => void = args => {
  const result = spawnSync(args[0]!, args.slice(1), { stdio: "ignore", timeout: 10_000 });
  if (result.status !== 0) throw new Error("The user service manager did not accept the launcher action");
}): void {
  if (!action.button || !action.unit || !/^[A-Za-z0-9_.@\\x-]+\.service$/.test(action.unit)
    || !["restart-service", "start-service"].includes(action.id)) throw new Error("The install action cannot run here");
  run(["systemd-run", "--user", "--collect", "--quiet", `--unit=delegatus-apply-${crypto.randomUUID()}`, "--",
    "systemctl", "--user", action.id === "restart-service" ? "restart" : "start", action.unit]);
}
