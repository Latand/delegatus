import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { launcherControlFile } from "./launcher";
import { headOf, ReleasePointer } from "./release";
import type { ModeDecision } from "./mode";
import type { InstallAction } from "./types";
import { sameProcess } from "./pid";
import { prepareLauncherCredentials } from "../../../bin/launcher-credentials.mjs";

const quote = (text: string) => `\u0027${text.replaceAll("\u0027", "\u0027\\\u0027\u0027")}\u0027`;
export function userUnit(cgroup: string): string | null {
  if (!/\/user@\d+\.service\//.test(cgroup)) return null;
  const match = /\/([A-Za-z0-9_.@\\x-]+\.service)(?:\n|$)/.exec(cgroup);
  return match?.[1] ?? null;
}
function read(file: string): string { try { return readFileSync(file, "utf8"); } catch { return ""; } }
async function ready(pointer: string, root: string): Promise<boolean> {
  try {
    const value = JSON.parse(read(pointer));
    const release = await new ReleasePointer(pointer, root).current();
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
export async function installAction(decision: ModeDecision, ports: { cgroup(pid: number): string; ready(pointer: string, root: string): boolean | Promise<boolean>; argv?(pid: number): string[]; env?: Partial<NodeJS.ProcessEnv>; platform?: NodeJS.Platform } = {
  cgroup: (pid: number) => read(`/proc/${pid}/cgroup`), ready,
  argv: (pid: number): string[] => read(`/proc/${pid}/cmdline`).split("\0").filter(Boolean),
}, root = decision.record?.checkout ?? decision.record?.installRoot ?? decision.installRoot ?? process.cwd()): Promise<InstallAction | null> {
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
  const env = ports.env ?? process.env;
  if (!decision.record) {
    const port = Number(env.PORT);
    if (Number.isInteger(port) && port > 0 && port <= 65_535) args.push("--port", String(port));
  }
  if (env.HOSTNAME?.trim() && !args.some(arg => ["--hostname", "-H"].includes(arg) || arg.startsWith("--hostname="))) args.push("--hostname", env.HOSTNAME);
  const windows = (ports.platform ?? process.platform) === "win32";
  const shellQuote = (value: string) => windows ? `'${value.replaceAll("'", "''")}'` : quote(value);
  // State custody and config belong to the install even in a clean terminal.
  // Explicit allowlisting keeps credentials out of the displayed command.
  const context: Record<string, string> = Object.fromEntries(["HOME", "LLV_STATE_DIR", "XDG_CONFIG_HOME"].flatMap(name => {
    const value = env[name as keyof typeof env];
    return value ? [[name, value]] : [];
  }));
  const withContext = (invocation: string, environment: Record<string, string> = context): string => {
    if (!Object.keys(environment).length) return invocation;
    return windows
      ? Object.entries(environment).map(([name, value]) => `$env:${name}=${shellQuote(value)}; `).join("") + invocation
      : "env " + Object.entries(environment).map(([name, value]) => `${name}=${shellQuote(value)}`).join(" ") + " " + invocation;
  };
  const fallbackCommand = (windows ? "& " : "") + [process.execPath, join(root, "bin", "cli.mjs"), ...args, "--no-open"]
    .map(value => windows ? `'${value.replaceAll("'", "''")}'` : quote(value)).join(" ");
  let command = withContext(fallbackCommand);
  if (decision.record) {
    if (!await ports.ready(decision.record.releasePointer, root)) return { id: "update-first", button: true };
    const next = await new ReleasePointer(decision.record.releasePointer, root).current();
    const terminalEntry = join(next.dir, "bin", "launcher-relaunch.mjs");
    if (read(terminalEntry).includes("delegatus-terminal-bootstrap-v1") && next.dir !== root) {
      const record = decision.record;
      // Old code can publish B and switch only web. Its resident host still
      // identifies A, so the current pointer cannot supply rollback custody.
      let rollbackPointer: string | null | undefined;
      if (record.runtimeHost.state === "healthy") {
        if (record.checkout) {
          const head = await headOf(root);
          if (head?.slice(0, 7) === record.runtimeHost.revision) rollbackPointer = null;
          else if (record.runtimeHost.revision) {
            const candidates: string[] = [];
            if (record.runtimeHost.pid && record.runtimeHost.startIdentity && sameProcess({ pid: record.runtimeHost.pid, startIdentity: record.runtimeHost.startIdentity })) {
              try { candidates.push(readlinkSync(`/proc/${record.runtimeHost.pid}/cwd`)); } catch { /* Use the install's release cache on other platforms. */ }
            }
            try { candidates.push(...readdirSync(record.releasesDir).map(name => join(record.releasesDir, name))); } catch { /* An unverified prior release yields a refusing command. */ }
            for (const dir of candidates) {
              const sha = await headOf(dir);
              if (sha?.slice(0, 7) === record.runtimeHost.revision && read(join(dir, ".next", "BUILD_ID"))) rollbackPointer = JSON.stringify({ sha, dir, checkoutHead: head }) + "\n";
            }
          }
        } else if (record.runtimeHost.revision === null) rollbackPointer = null;
      }
      // A legitimate build already captured its prior pointer before B was
      // published. Preserve that transaction rather than starting another.
      let intent: { target?: string; rollbackPointer?: string | null; requestId?: string; state?: string } | null = null;
      try { intent = JSON.parse(read(join(dirname(record.requestFile), "apply.json"))); } catch { /* legacy no-intent */ }
      if (intent?.target === next.sha && ["ready", "switching"].includes(intent.state ?? "") && typeof intent.requestId === "string"
        && (intent.rollbackPointer === null || typeof intent.rollbackPointer === "string")) rollbackPointer = intent.rollbackPointer;
      const metadata = Buffer.from(JSON.stringify({ target: next.sha, root, requestFile: record.requestFile, releasePointer: record.releasePointer,
        rollbackPointer, priorRevision: record.runtimeHost.revision,
        priorVersion: !record.checkout ? JSON.parse(read(join(typeof rollbackPointer === "string" ? JSON.parse(rollbackPointer).dir : root, "package.json"))).version : null,
        checkout: !!record.checkout })).toString("base64");
      const invocation = (windows ? "& " : "") + [process.execPath, terminalEntry, "--terminal", metadata, join(next.dir, "bin", "cli.mjs"), ...args, "--no-open"]
        .map(shellQuote).join(" ");
      command = withContext(invocation);
      if (windows) command += "; exit $LASTEXITCODE";
    } else if (!decision.record.checkout && !read(join(root, "bin", "cli.mjs")).includes("delegatus-launcher-relaunch-v1")) {
      if (next.dir !== root) {
        let requestId: string | undefined;
        try {
          const trial = JSON.parse(read(launcherControlFile(decision.record.requestFile, "trial")));
          if (trial.target === next.sha && typeof trial.requestId === "string") requestId = trial.requestId;
        } catch { /* An already built pointer can predate apply custody. */ }
        const invocation = [process.execPath, join(next.dir, "bin", "cli.mjs"), ...args, "--no-open"]
          .map(value => windows ? `'${value.replaceAll("'", "''")}'` : quote(value)).join(" ");
        const environment = { ...context, LLV_LAUNCHER_REEXEC: "1", LLV_LAUNCHER_INSTALL_ROOT: root, ...(requestId ? { LLV_LAUNCHER_TRIAL: requestId } : {}) };
        if (windows) {
          const script = Object.entries(environment).map(([name, value]) => `$env:${name}='${value.replaceAll("'", "''")}'`).join("; ")
            + `; & ${invocation}; if($LASTEXITCODE -eq 75){ & ${fallbackCommand.slice(2)} }`;
          command = `& powershell.exe -NoProfile -EncodedCommand '${Buffer.from(script, "utf16le").toString("base64")}'`;
        } else command = "env " + Object.entries(environment).map(([name, value]) => `${name}=${quote(value)}`).join(" ") + " " + invocation;
      }
    }
    const unit = userUnit(ports.cgroup(decision.record.launcher.pid));
    if (!unit) {
      try {
        if (prepareLauncherCredentials(root, env)) {
          const entry = command.includes("--terminal") ? join(next.dir, "bin", "launcher-credentials.mjs") : join(root, "bin", "launcher-credentials.mjs");
          if (!read(entry).includes("delegatus-launcher-credential-custody-v1")) throw new Error("prerequisite");
          command = withContext(command, { LLV_LAUNCHER_CREDENTIAL_HANDOFF: "1" });
        }
      } catch { return { id: "secure-handoff", button: false }; }
    }
    return unit ? { id: "restart-service", button: true, unit }
      : { id: "restart-terminal", button: false, command, ...(windows ? { terminalEveryUpdate: true } : {}) };
  }
  const unit = serviceFor(root);
  if (!unit) {
    try {
      if (prepareLauncherCredentials(root, env)) {
        if (!read(join(root, "bin", "launcher-credentials.mjs")).includes("delegatus-launcher-credential-custody-v1")) throw new Error("prerequisite");
        command = withContext(command, { LLV_LAUNCHER_CREDENTIAL_HANDOFF: "1" });
      }
    } catch { return { id: "secure-handoff", button: false }; }
  }
  return unit ? { id: "start-service", button: true, unit } : { id: "start-launcher", button: false, command };
}
export interface ServiceRecovery { file: string; entry: string; bun: string }
export function runInstallAction(action: InstallAction, run: (args: string[]) => void = args => {
  const result = spawnSync(args[0]!, args.slice(1), { stdio: "ignore", timeout: 10_000 });
  if (result.status !== 0) throw new Error("The user service manager did not accept the launcher action");
}, recovery?: ServiceRecovery): void {
  if (!action.button || !action.unit || !/^[A-Za-z0-9_.@\\x-]+\.service$/.test(action.unit)
    || !["restart-service", "start-service"].includes(action.id)) throw new Error("The install action cannot run here");
  run(["systemd-run", "--user", "--collect", "--quiet", `--unit=delegatus-apply-${crypto.randomUUID()}`, "--",
    ...(recovery ? [recovery.bun, "--bun", recovery.entry, "--recover-service", recovery.file]
      : ["systemctl", "--user", action.id === "restart-service" ? "restart" : "start", action.unit])]);
}
