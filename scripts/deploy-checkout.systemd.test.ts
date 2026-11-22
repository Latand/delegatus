import fs from "node:fs";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { availablePort, git, install, release, until } from "../bin/__fixtures__/cli-self-update";
import { captureProcessIdentity, processIdentityStatus, type ProcessIdentity } from "../src/lib/processIdentity";

const repo = path.dirname(import.meta.dir);
const baseline = "5bbb7d564168d3f598a68721c69caae4e96be478";
const olderLauncher = "fa357e9fa8b0e72fb7c2b50406dc178f80b7ba2a";
const enabled = process.platform === "linux" && process.env.LLV_CHECKOUT_SYSTEMD_TEST === "1";
const evidenceDir = process.env.LLV_EVIDENCE_DIR;

function checked(argv: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}) {
  const result = Bun.spawnSync(argv, { cwd: options.cwd, env: options.env, timeout: options.timeout ?? 10_000 });
  if (!result.success) throw new Error(argv[0] + " failed: " + result.stderr.toString());
  return result.stdout.toString().trim();
}
const manager = (...args: string[]) => checked(["systemctl", "--user", ...args]);
const properties = (unit: string, props: string[]) => Object.fromEntries(
  manager("show", unit, ...props.flatMap(prop => ["-p", prop])).split("\n").map(line => {
    const at = line.indexOf("=");
    return [line.slice(0, at), line.slice(at + 1)];
  }),
);
const invocation = (unit: string) => properties(unit, ["InvocationID", "MainPID", "NRestarts", "ActiveState", "ControlGroup"]);
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value) + "\n", { mode: 0o600 });
const lines = (file: string) => fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];

function members(group: string): ProcessIdentity[] {
  if (!group) return [];
  const directory = "/sys/fs/cgroup" + group;
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { encoding: "utf8", recursive: true }).filter(file => path.basename(file) === "cgroup.procs")
    .flatMap(file => fs.readFileSync(path.join(directory, file), "utf8").trim().split("\n").filter(Boolean).map(Number))
    .map(pid => captureProcessIdentity(pid)).filter(process => process.startIdentity);
}

function journal(unit: string, since: string) {
  return checked(["journalctl", "--user", "--no-pager", "--output=short-iso-precise", "--since", since, "--user-unit", unit]);
}

type HostRow = { host: { process: ProcessIdentity; exitWriter: { process: ProcessIdentity; exitFile: string } } };
type Case = "old-stop" | "relaunch" | "legacy-layout" | "pending" | "rollback" | "crash";
async function exercise(testCase: Case) {
  const f = install();
  const unit = "llvswitchtest" + process.pid.toString(16) + randomBytes(4).toString("hex") + ".service";
  const slice = unit.replace(".service", ".slice");
  const agentSlice = unit.replace(".service", "agents.slice");
  const pin = unit.replace(".service", "pin.service");
  const scopes = {
    socket: "delegatus-agent-codex-" + unit.replace(".service", "") + ".scope",
    stdio: "delegatus-agent-claude-" + unit.replace(".service", "") + ".scope",
  };
  const owned = new Map<number, ProcessIdentity>();
  const remember = (entries: ProcessIdentity[]) => {
    for (const entry of entries) if (entry.startIdentity) owned.set(entry.pid, entry);
  };
  const stateFd = fs.openSync(f.state, "r");
  const homeFd = fs.openSync(f.env.HOME!, "r");
  const env: NodeJS.ProcessEnv = { ...f.env, HOME: `/proc/${process.pid}/fd/${homeFd}`,
    LLV_STATE_DIR: `/proc/${process.pid}/fd/${stateFd}`,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? "/run/user/" + process.getuid!(),
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? "unix:path=/run/user/" + process.getuid!() + "/bus",
    LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1", PYTHONDONTWRITEBYTECODE: "1" };
  const stateFile = (name: string) => path.join(f.state, name);
  const seen: Record<string, unknown> = { testCase, unit, scopes, baseline, procedure: git(repo, "rev-parse", "HEAD"),
    systemd: manager("--version").split("\n")[0], bun: Bun.version, launcherSource: testCase === "legacy-layout" ? olderLauncher : git(repo, "rev-parse", "HEAD") };
  const started = Date.now();
  let worker: string | undefined;
  let failure: unknown;
  try {
    const launch = (name: string, broken = false) => {
      const next = release(f, name, { broken });
      if (testCase === "legacy-layout" && name === "release-a") {
        for (const filename of fs.readdirSync(path.join(next.dir, "bin"))) {
          const file = "bin/" + filename;
          fs.writeFileSync(path.join(next.dir, file), checked(["git", "show", olderLauncher + ":" + file], { cwd: repo }) + "\n");
        }
        git(next.dir, "add", "bin");
        if (git(next.dir, "status", "--porcelain", "--untracked-files=no")) {
          git(next.dir, "commit", "-m", "Use prior release launcher");
        }
        next.sha = git(next.dir, "rev-parse", "HEAD");
      }
      const installId = createHash("sha256").update(f.checkout).digest("hex").slice(0, 16);
      const directory = path.join(env.XDG_CACHE_HOME!, "delegatus", "self-update", installId, "releases");
      fs.mkdirSync(directory, { recursive: true });
      const dir = path.join(directory, next.sha.slice(0, 12));
      git(f.checkout, "worktree", "move", next.dir, dir);
      return { sha: next.sha, dir, installId };
    };
    const old = launch("release-a");
    const next = launch("release-b", testCase === "rollback");
    const update = stateFile("self-update");
    fs.mkdirSync(update, { recursive: true, mode: 0o700 });
    const file = (role: string) => path.join(update, role + "-" + old.installId + ".json");
    const pointer = file("release");
    const request = file("request");
    const baselinePointer = { sha: old.sha, dir: old.dir, checkoutHead: f.first };
    write(pointer, baselinePointer);
    const baseBytes = fs.readFileSync(pointer, "utf8");
    const credentials = stateFile("credentials");
    fs.writeFileSync(credentials, "LLV_TOKEN=fixture\n", { mode: 0o600 });
    const verification = stateFile("verification.json");
    write(verification, { sha: next.sha, viewer: "pass", runtimeHost: "pass" });
    const config = stateFile("fixture-plan.json");
    write(config, {
      unit, stateDir: f.state, checkout: f.checkout, checkoutHead: f.first, baselinePointer,
      installId: old.installId, releaseDir: next.dir, target: next.sha, tokenFile: credentials, verificationFile: verification,
      bun: process.execPath, scopes, agentSlice, layout: testCase === "legacy-layout" ? "legacy" : "bound",
      reconnect: testCase === "relaunch" || testCase === "legacy-layout",
    });
    const generation = path.join(import.meta.dir, "deployCheckoutGeneration.fixture.ts");
    fs.writeFileSync(stateFile("fixture-generation.mjs"), `await (await import(${JSON.stringify(generation)})).generation();\n`);
    const port = await availablePort();
    const since = new Date().toISOString().replace("T", " ").replace("Z", " UTC");
    checked(["systemd-run", "--user", "--unit=" + unit, "--slice=" + slice, "--working-directory=" + f.checkout,
      "-p", "KillMode=process", "-p", "Restart=on-failure", "-p", "RestartSec=1",
      "-p", "TimeoutStopSec=120", "-p", "CPUWeight=1000", "-p", "UMask=0077",
      ...Object.entries(env).filter(([key]) => ["HOME", "PATH", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR",
        "DBUS_SESSION_BUS_ADDRESS", "LLV_STATE_DIR", "TMPDIR", "LLV_BUN_EXECUTABLE", "LLV_VIEWER_CONTROL_URL"].includes(key))
        .map(([key, value]) => "--setenv=" + key + "=" + value),
      "--", process.execPath, "--bun", path.join(f.checkout, "bin", "cli.mjs"), "--no-open", "--port", String(port)], { env });
    // Keep the transient service definition loaded across an explicit stop.
    // After= holds a reference without adding a stop-propagating dependency.
    if (testCase === "old-stop") {
      checked(["systemd-run", "--user", "--unit=" + pin, "--remain-after-exit", "--property=After=" + unit,
        "--", "/usr/bin/true"], { env });
      await until(() => invocation(pin).ActiveState === "active");
      seen.referenceUnit = { name: pin, ...invocation(pin) };
    }
    const record = () => read(file("launcher"));
    await until(() => fs.existsSync(stateFile("fixture-hosts.json")) && record().launcher.state === "healthy", 25_000);
    const rows = read(stateFile("fixture-hosts.json")) as HostRow[];
    const host = (index: number) => rows[index]!.host.process;
    const writer = (index: number) => rows[index]!.host.exitWriter;
    const before = invocation(unit);
    const firstScopes = Object.fromEntries(Object.values(scopes).map(scope => [scope, invocation(scope)]));
    const originalMembers = members(before.ControlGroup!);
    remember([...originalMembers, ...rows.map(row => row.host.process)]);
    const originalRecord = record();
    seen.before = { unit: before, scopes: firstScopes, launcher: originalRecord, processes: originalMembers, hosts: rows };
    seen.releases = { old, next };
    expect(record().launcher.revision).toBe(old.sha);
    expect(before.MainPID).not.toBe(String(originalRecord.launcher.pid));
    expect(firstScopes[scopes.socket]?.ActiveState).toBe("active");
    if (testCase !== "legacy-layout") expect(firstScopes[scopes.stdio]?.ActiveState).toBe("active");
    const stopTimeout = properties(scopes.socket, ["TimeoutStopUSec"]).TimeoutStopUSec;
    expect(stopTimeout).toBe("1min 30s");
    seen.scopeTimeout = stopTimeout;
    const source = testCase === "old-stop" ? path.join(f.root, "baseline-deploy-checkout.py") : path.join(import.meta.dir, "deploy-checkout.py");
    if (testCase === "old-stop") fs.writeFileSync(source, checked(["git", "show", baseline + ":scripts/deploy-checkout.py"], { cwd: repo }) + "\n");
    seen.sourceSha256 = createHash("sha256").update(fs.readFileSync(source)).digest("hex");
    const cli = ["python3", path.join(import.meta.dir, "deploy_checkout_systemd_fixture.py"), source, "--config", config];
    if (testCase === "pending") {
      // The launcher's rejected automatic request stays in its own slot.
      write(request, { requestId: "fixture-pending", role: "relaunch", target: old.sha, autoGateId: "expired-fixture-gate" });
      const refusal = Bun.spawnSync([...cli, "--approved", "--start"], { env, timeout: 15_000 });
      seen.refusal = { exit: refusal.exitCode, stdout: refusal.stdout.toString(), stderr: refusal.stderr.toString() };
      expect(refusal.exitCode).toBe(2);
      expect(refusal.stderr.toString()).toContain("launcher request or update already pending");
      expect(fs.readFileSync(pointer, "utf8")).toBe(baseBytes);
      // A stale operator request is consumed by the real launcher and
      // attributed to that request without beginning a transition.
      fs.unlinkSync(request);
      write(request, { requestId: "fixture-stale-target", role: "relaunch", target: next.sha, rollbackPointer: baseBytes });
      await until(() => !fs.existsSync(request) && record().launcher.requestId === "fixture-stale-target");
      expect(record().launcher.error?.kind).toBe("message");
      expect(invocation(unit)).toEqual(before);
      expect(processIdentityStatus(host(0))).toBe("alive");
      seen.stale = record().launcher;
      return;
    }
    const submitted = checked([...cli, "--approved", "--start"], { env, timeout: 25_000 });
    const verdictFile = submitted.match(/verdict: (.*\/([0-9a-f]{32})\/verdict\.json)$/);
    if (!verdictFile) throw new Error("real checkout CLI did not return its detached run");
    const resultPath = verdictFile[1]!;
    worker = "delegatus-deploy-" + verdictFile[2]! + ".service";
    if (testCase === "crash") {
      await until(() => fs.existsSync(request) || fs.existsSync(file("trial")));
      const ownedLauncher = originalMembers.find(entry => entry.pid === originalRecord.launcher.pid);
      if (!ownedLauncher || processIdentityStatus(ownedLauncher) !== "alive") throw new Error("fixture launcher identity changed");
      process.kill(ownedLauncher.pid, "SIGKILL");
    }
    const status = path.join(path.dirname(resultPath), "status.json");
    const verdict = await until(() => read(status).phase === "finished" ? read(resultPath) : false, 140_000);
    const ended = new Date().toISOString().replace("T", " ").replace("Z", " UTC");
    seen.verdict = verdict;
    seen.status = read(status);
    seen.events = fs.readFileSync(path.join(path.dirname(resultPath), "switch.log"), "utf8");
    seen.after = { unit: invocation(unit), scopes: Object.fromEntries(Object.values(scopes).map(scope => [scope, invocation(scope)])),
      launcher: record(), processes: members(invocation(unit).ControlGroup!) };
    remember(members(invocation(unit).ControlGroup!));
    seen.switchWindow = { since, ended };
    const socketEvents = () => lines(stateFile("fixture-engine-socket.jsonl"));
    const stdioEvents = () => lines(stateFile("fixture-engine-stdio.jsonl"));
    const launcherReceipt = request + ".result.json";
    seen.requestResult = fs.existsSync(launcherReceipt) ? read(launcherReceipt) : null;
    const exit = (index: number) => fs.existsSync(writer(index).exitFile) ? read(writer(index).exitFile) : null;
    if (testCase === "old-stop" || testCase === "crash") {
      const terminal = await until(() => exit(0), 110_000);
      expect(terminal.signal).toBe("SIGKILL");
      expect(socketEvents().map(event => event.kind)).toEqual(["ready", "SIGTERM"]);
      expect(journal(scopes.socket, since)).toContain("Stopping timed out. Killing");
      const restarted = await until(() => {
        const current = invocation(unit);
        return current.ActiveState === "active" && current.InvocationID !== before.InvocationID ? current : null;
      });
      seen.restarted = restarted;
      seen.exits = [terminal, exit(1)];
      if (testCase === "old-stop") {
        expect(verdict.verdict).toBe("pass");
        expect(verdict.relocation.started).toBeTrue();
        expect(verdict.serving.viewer.sha).toBe(next.sha);
        expect(verdict.relocation.signalled).toEqual([]);
      } else {
        expect(verdict.verdict).toBe("fail");
        expect(verdict.relaunch.unitLeftActive).toBeTruthy();
        expect(verdict.relaunch.scopeStopped).toContain(scopes.socket);
        expect(verdict.relaunch.signalled).toEqual([]);
      }
      return;
    }
    expect(verdict.relaunch.unitBefore).toEqual(verdict.relaunch.unitAfter);
    expect(invocation(unit)).toEqual(before);
    expect(verdict.relaunch.signalled).toEqual([]);
    expect(verdict.relaunch.scopeStopped).toEqual([]);
    expect(lines(stateFile("fixture-systemctl.jsonl")).filter(args => args[0] === "systemctl")
      .every(args => args.includes("show") || args.includes("list-jobs"))).toBeTrue();
    expect(invocation(scopes.socket)).toEqual(firstScopes[scopes.socket]!);
    expect(socketEvents().map(event => event.kind)).toEqual(["ready"]);
    expect(exit(0)).toBeNull();
    expect(processIdentityStatus(host(0))).toBe("alive");
    expect(processIdentityStatus(writer(0).process)).toBe("alive");
    expect(read(writer(0).exitFile.replace(/\.exit\.json$/, ".writer.json"))).toEqual(writer(0).process);
    expect(journal(scopes.socket, since)).not.toMatch(/Stopping|Killing/);
    if (testCase === "rollback") {
      expect(verdict.verdict).toBe("fail");
      expect(verdict.relaunch.result).toBe("rolled-back");
      expect(verdict.serving.viewer.sha).toBe(old.sha);
      expect(fs.readFileSync(pointer, "utf8")).toBe(baseBytes);
    } else {
      expect(verdict.verdict).toBe("pass");
      expect(verdict.relaunch.result).toBe("done");
      expect(verdict.relocation).toBeNull();
      expect(verdict.relaunch.generationSurvivors).toEqual([]);
      expect(verdict.serving.viewer.sha).toBe(next.sha);
      const socketHost = verdict.relaunch.hosts.find((entry: { process: { pid: number } }) => entry.process.pid === host(0).pid);
      expect(socketHost.helpersBefore.length).toBeGreaterThan(1);
      expect(socketHost.helpersAfter).toEqual(socketHost.helpersBefore);
      expect(socketHost.writerBefore).toEqual(socketHost.writerAfter);
      expect(verdict.protected.find((row: { stageId: string }) => row.stageId === "socket")).toMatchObject({ outcome: "preserved", attempt: 1 });
      const reconnect = lines(stateFile("fixture-reconnect.jsonl"));
      expect(reconnect).toHaveLength(2);
      expect(reconnect[0]).toMatchObject({ turn: "fixture-turn-1", pid: host(0).pid });
      expect(reconnect[1]).toMatchObject({ turn: "fixture-turn-1", pid: host(0).pid });
      expect(reconnect[1].sequence).toBeGreaterThan(reconnect[0].sequence);
      seen.reconnect = reconnect;
    }
    expect(stdioEvents().map(event => event.kind)).toEqual(["ready", "EOF"]);
    expect(exit(1)).toMatchObject({ code: 0, signal: null });
    expect(fs.existsSync(writer(1).exitFile.replace(/\.exit\.json$/, ".writer.json"))).toBeFalse();
    seen.stdioExit = exit(1);
    seen.beforeExplicitStop = { socket: socketEvents(), stdio: stdioEvents(), journal: journal(scopes.socket, since) };
    if (testCase === "relaunch") {
      checked(["systemctl", "--user", "stop", unit], { timeout: 110_000 });
      const terminal = await until(() => exit(0));
      expect(terminal.signal).toBe("SIGKILL");
      expect(socketEvents().map(event => event.kind)).toEqual(["ready", "SIGTERM"]);
      expect(journal(scopes.socket, since)).toContain("Stopping timed out. Killing");
      seen.explicitStop = { exit: terminal, events: socketEvents(), journal: journal(scopes.socket, since) };
    }
  } catch (error) {
    failure = error;
    seen.error = String(error);
    throw error;
  } finally {
    const now = new Date().toISOString().slice(0, 10);
    const commands = lines(stateFile("fixture-systemctl.jsonl"));
    seen.managerCommands = commands.map((args: string[]) => args[0] === "systemd-run" ? args.slice(0, 5) : args);
    for (const ownedUnit of [unit, ...Object.values(scopes)]) {
      const snapshot = invocation(ownedUnit);
      remember(members(snapshot.ControlGroup!));
      seen["journal:" + ownedUnit] = journal(ownedUnit, now);
    }
    for (const scope of Object.values(scopes)) {
      // Teardown happens outside the measured transaction. Skip another
      // 90-second timeout by stopping the exact surviving test engine.
      const group = invocation(scope).ControlGroup!;
      for (const entry of members(group)) if (processIdentityStatus(entry) === "alive") process.kill(entry.pid, "SIGKILL");
    }
    for (const name of [unit, ...Object.values(scopes), ...(worker ? [worker] : []), pin, slice, agentSlice]) {
      Bun.spawnSync(["systemctl", "--user", "stop", name], { timeout: 10_000, stdout: "ignore", stderr: "ignore" });
      Bun.spawnSync(["systemctl", "--user", "reset-failed", name], { timeout: 5_000, stdout: "ignore", stderr: "ignore" });
    }
    for (const entry of owned.values()) if (processIdentityStatus(entry) === "alive") process.kill(entry.pid, "SIGKILL");
    const leaked = await until(() => {
      const survivors = [...owned.values()].filter(entry => processIdentityStatus(entry) === "alive");
      return survivors.length ? false : survivors;
    }, 5_000).catch(() => [...owned.values()].filter(entry => processIdentityStatus(entry) === "alive"));
    seen.cleanupSurvivors = leaked;
    seen.durationMs = Date.now() - started;
    if (evidenceDir) {
      fs.mkdirSync(evidenceDir, { recursive: true });
      write(path.join(evidenceDir, "checkout-systemd-" + testCase + ".json"), seen);
    }
    fs.closeSync(stateFd);
    fs.closeSync(homeFd);
    fs.rmSync(f.root, { recursive: true, force: true });
    if (!failure) expect(leaked).toEqual([]);
  }
}

for (const name of ["legacy-layout", "pending", "rollback", "relaunch", "old-stop", "crash"] as const) {
  test.skipIf(!enabled)("private systemd checkout switch: " + name, () => exercise(name), 240_000);
}
