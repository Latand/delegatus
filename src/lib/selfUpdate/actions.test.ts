import { captureProcessIdentity } from "@/lib/processIdentity";
import { fixtureReport, ownFixtureTree, stopFixtureIdentity, stopFixtureProcess } from "@/lib/testing/fixtureProcess";
import { afterAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { installAction, launcherService, runInstallAction, unitRunsLauncher } from "./actions";
const record = { launcher: { pid: 12, startIdentity: "7" }, checkout: "/srv/checkout", releasePointer: "/state/release.json" };
test("legacy systemd launcher offers one external restart", async () => {
  const action = await installAction({ mode: "checkout", record } as never, {
    cgroup: () => "0::/user.slice/user-1000.slice/user@1000.service/app.slice/delegatus.service", ready: () => true, proven: () => true,
  });
  expect(action).toMatchObject({ id: "restart-service", button: true, unit: "delegatus.service" });
  const calls: string[][] = [];
  runInstallAction(action!, command => calls.push(command), undefined, { root: record.checkout, launcherPid: record.launcher.pid }, () => true);
  expect(calls[0]?.slice(0, 4)).toEqual(["systemd-run", "--user", "--collect", "--quiet"]);
  expect(calls[0]?.slice(-4)).toEqual(["systemctl", "--user", "restart", "delegatus.service"]);
});
/* A launcher started in a terminal multiplexer pane, in a terminal emulator or
   by a desktop autostart entry sits in that unit's cgroup. The unit runs other
   things and would not bring the launcher back. */
const shows = (start: string, main = 0, directory = "") => `MainPID=${main}\nExecStart={ path=${start.split(" ")[0]} ; argv[]=${start} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=${main} ; code=(null) ; status=0/0 }\nWorkingDirectory=${directory}\n`;
test.each([
  ["tmux.service", "/usr/bin/tmux new-session -d -s main"],
  ["gnome-terminal-server.service", "/usr/libexec/gnome-terminal-server"],
  ["app-org.example.Terminal@autostart.service", "/usr/bin/example-terminal --session"],
])("a unit the launcher merely runs inside is never restarted: %s", async (unit, start) => {
  const cgroup = () => `0::/user.slice/user-1000.slice/user@1000.service/${unit}\n`;
  const asked: string[] = [];
  // The unit's main process is the launcher's own parent, as a terminal is of
  // what was typed into it, and neither it nor the unit's command is this install.
  const proven = (name: string, root: string, pid?: number) => unitRunsLauncher(name, root, pid,
    { show: () => shows(start, 4242), parent: () => 4242, argv: () => start.split(" "), cwd: () => "/srv/checkout" });
  const action = await installAction({ mode: "checkout", record } as never, { cgroup, ready: () => true, env: {}, proven: (...proof) => { asked.push(proof[0]); return proven(...proof); } });
  expect(asked).toEqual([unit]);
  expect(action).toMatchObject({ id: "restart-terminal", button: false });
  expect(action?.unit).toBeUndefined();
  expect(action?.command).toContain("bin/cli.mjs");
  expect(launcherService(record.launcher.pid, record.checkout, cgroup, proven)).toBeNull();
  const calls: string[][] = [];
  const offered = { id: "restart-service" as const, button: true, unit };
  expect(() => runInstallAction(offered, command => calls.push(command), undefined, { root: record.checkout, launcherPid: record.launcher.pid }, proven)).toThrow("not proven");
  expect(() => runInstallAction(offered, command => calls.push(command))).toThrow("not proven");
  expect(calls).toEqual([]);
});
test("a service is accepted on proof: the manager starts this install, or its main process is the launcher or the bootstrap that started it", () => {
  const root = "/srv/checkout", entry = "/srv/checkout/bin/cli.mjs";
  const unit = (shown: string | null, process: { parent?: number | null; argv?: string[]; cwd?: string | null } = {}, pid: number | null = 12, name = "delegatus.service") =>
    unitRunsLauncher(name, root, pid ?? undefined, { show: () => shown, parent: () => process.parent ?? null, argv: () => process.argv ?? [], cwd: () => process.cwd ?? null });
  expect(unit(shows(`/usr/bin/bun --bun ${entry} --no-open`))).toBe(true);
  expect(unit(shows("/usr/bin/bun --bun /srv/elsewhere/bin/cli.mjs --no-open"))).toBe(false);
  expect(unit(shows("/usr/bin/bun bin/cli.mjs", 0, "/srv/checkout"))).toBe(true);
  expect(unit(shows("/usr/bin/bun bin/cli.mjs", 0, "/srv/elsewhere"))).toBe(false);
  expect(unit(shows("/usr/bin/bun bin/cli.mjs"))).toBe(false);
  // A root with a space in it is one argument, though the manager prints it in two words.
  expect(unitRunsLauncher("delegatus.service", "/srv/my checkout", undefined, { show: () => shows("/usr/bin/bun /srv/my checkout/bin/cli.mjs --no-open") })).toBe(true);
  // The main process is the recorded launcher itself.
  expect(unit(shows("/usr/local/bin/start", 12))).toBe(true);
  // Or the bootstrap that started it, when the script it runs is this install's entry.
  expect(unit(shows("/usr/local/bin/start", 40), { parent: 40, argv: ["/usr/bin/bun", "--bun", entry, "--no-open"] })).toBe(true);
  expect(unit(shows("/usr/local/bin/start", 40), { parent: 40, argv: ["/usr/bin/bun", "bin/cli.mjs"], cwd: "/srv/checkout" })).toBe(true);
  expect(unit(shows("/usr/local/bin/start", 40), { parent: 40, argv: ["/usr/bin/bun", "bin/cli.mjs"], cwd: "/srv/elsewhere" })).toBe(false);
  expect(unit(shows("/usr/local/bin/start", 40), { parent: 40, argv: ["/usr/bin/bun", "/srv/elsewhere/bin/cli.mjs"] })).toBe(false);
  // A main process that merely names the entry among its arguments runs something else.
  expect(unit(shows("/usr/bin/tmux", 40), { parent: 40, argv: ["/usr/bin/tmux", "new-session", "bun", entry] })).toBe(false);
  // Another process's parent proves nothing.
  expect(unit(shows("/usr/local/bin/start", 40), { parent: 41, argv: ["/usr/bin/bun", entry] })).toBe(false);
  // A start has no launcher to compare: only the command the unit starts proves it.
  expect(unit(shows("/usr/local/bin/start", 12), {}, null)).toBe(false);
  expect(unit(null)).toBe(false);
  expect(unit(shows(`/usr/bin/bun ${entry}`), {}, 12, "not a unit")).toBe(false);
  const cgroup = () => "0::/user.slice/user-1000.slice/user@1000.service/app.slice/delegatus.service";
  expect(launcherService(12, root, cgroup, (name, at, pid) => unitRunsLauncher(name, at, pid, { show: () => shows(`/usr/bin/bun ${entry}`) }))).toBe("delegatus.service");
});
/* An install that is not running has no cgroup to name its unit. The user's
   own unit files nominate candidates, and the manager proves the one. */
test("a stopped install is started through the one unit the manager shows starting it", async () => {
  const home = mkdtempSync("/var/tmp/action-unit-proof-"); const units = join(home, ".config", "systemd", "user"); mkdirSync(units, { recursive: true });
  try {
    writeFileSync(join(units, "delegatus.service"), "[Service]\nWorkingDirectory=%h/checkout\nExecStart=%h/.bun/bin/bun %h/checkout/bin/cli.mjs --no-open\n");
    writeFileSync(join(units, "other.service"), "[Service]\nExecStart=%h/.bun/bin/bun %h/elsewhere/bin/cli.mjs --no-open\n");
    writeFileSync(join(units, "tmux.service"), "[Service]\nExecStart=/usr/bin/tmux new-session -d\n");
    const asked: string[] = [];
    const proven = (unit: string, root: string, pid?: number) => { asked.push(unit); return unitRunsLauncher(unit, root, pid,
      { show: () => shows(`/srv/operator/.bun/bin/bun /srv/operator/${unit === "other.service" ? "elsewhere" : "checkout"}/bin/cli.mjs --no-open`) }); };
    const ports = { cgroup: () => "", ready: () => true, env: {}, proven, home };
    expect(await installAction({ mode: "checkout", record: null, reason: null } as never, ports, "/srv/operator/checkout"))
      .toEqual({ id: "start-service", button: true, unit: "delegatus.service" });
    expect(asked.sort()).toEqual(["delegatus.service", "other.service"]);
    expect(await installAction({ mode: "checkout", record: null, reason: null } as never, ports, "/srv/operator/third"))
      .toMatchObject({ id: "start-launcher", button: false });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
test("terminal legacy launcher gives its single command", async () => {
  expect(await installAction({ mode: "checkout", record } as never, { cgroup: () => "", ready: () => true }))
    .toMatchObject({ id: "restart-terminal", button: false });
});
test("an unbuilt upgrade needs Update first", async () => {
  expect(await installAction({ mode: "checkout", record } as never, { cgroup: () => "", ready: () => false }))
    .toMatchObject({ id: "update-first", button: true });
});
test("default install-action ports safely read custody for a legacy record without a socket", async () => {
  const root = mkdtempSync("/var/tmp/action-default-env-");
  try {
    const legacy = { ...record, requestFile: join(root, "request.json") };
    expect(await installAction({ mode: "checkout", record: legacy } as never)).toMatchObject({ id: "update-first", button: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("new and Docker launchers need no bootstrap action", async () => {
  expect(await installAction({ mode: "checkout", record: { ...record, launcher: { ...record.launcher, relaunch: 1 } } } as never)).toBeNull();
  expect(await installAction({ mode: "managed", record: null, reason: null })).toBeNull();
});

test("terminal bootstrap preserves a custom port and safe access arguments", async () => {
  const action = await installAction({ mode: "checkout", record: { ...record, port: 45678 } } as never,
    { cgroup: () => "", ready: () => true, argv: () => ["bun", "/srv/checkout/bin/cli.mjs", "--port", "45678", "--hostname", "0.0.0.0", "--tailscale", "--new-token"] });
  expect(action?.command).toContain("'45678'");
  expect(action?.command).toContain("'--tailscale'");
  expect(action?.command).not.toContain("--new-token");
});


test("manual no-record launch preserves the Viewer's custom listener", async () => {
  const action = await installAction({ mode: "unsupported", record: null, reason: "no-launcher", installRoot: "/srv/manual" },
    { cgroup: () => "", ready: () => false, env: { PORT: "45678", HOSTNAME: "0.0.0.0" } });
  expect(action).toMatchObject({ id: "start-launcher", button: false });
  expect(action?.command).toContain("'--port' '45678'");
  expect(action?.command).toContain("'--hostname' '0.0.0.0'");
});


test("Windows prerequisite uses PowerShell invocation and quote escaping", async () => {
  const action = await installAction({ mode: "checkout", record } as never,
    { cgroup: () => "", ready: () => true, platform: "win32", argv: () => [], env: {} }, "/srv/fixture's install");
  expect(action?.command).toStartWith("& '");
  expect(action?.command).toContain("fixture''s install");
  expect(action?.command).not.toContain("'\\''");
});


const packageFixtures: string[] = [];
afterAll(() => packageFixtures.forEach(root => rmSync(root, { recursive: true, force: true })));
test.each(["linux", "win32"] as const)("an old packaged bootstrap starts the verified new entry with retained install identity: %s", async platform => {
  const root = mkdtempSync("/var/tmp/package-action-"); packageFixtures.push(root);
  const next = join(root, "next"); mkdirSync(join(root, "bin")); mkdirSync(join(next, "bin"), { recursive: true }); mkdirSync(join(next, "dist", "standalone"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "delegatus-cli", version: "1.0.0" }));
  writeFileSync(join(root, "bin", "cli.mjs"), "// actual old bootstrap has no package-pointer protocol\n");
  writeFileSync(join(next, "package.json"), JSON.stringify({ name: "delegatus-cli", version: "1.0.1" }));
  writeFileSync(join(next, "bin", "launcher-relaunch.mjs"), "delegatus-launcher-relaunch-v1");
  writeFileSync(join(next, "dist", "standalone", "server.js"), ""); writeFileSync(join(next, "dist", "runtime-host.mjs"), "");
  const pointer = join(root, "pointer.json"); writeFileSync(pointer, JSON.stringify({ kind: "package", baseVersion: "1.0.0", version: "1.0.1", dir: next, sha: "a".repeat(40) }));
  const action = await installAction({ mode: "package", reason: null, record: { ...record, checkout: null, installRoot: root, releasePointer: pointer, port: 45678 } } as never,
    { cgroup: () => "", ready: () => true, platform, argv: () => [] });
  const command = platform === "win32" ? Buffer.from(action!.command!.split(" ").at(-1)!.replaceAll("'", ""), "base64").toString("utf16le") : action!.command!;
  expect(command).toContain(join(next, "bin", "cli.mjs"));
  expect(command).toContain("LLV_LAUNCHER_INSTALL_ROOT"); expect(command).toContain(root);
  expect(command).toContain("--port"); expect(command).toContain("45678");
});


test.each(["darwin", "win32"] as const)("legacy bootstrap retains Viewer bind when native argv is unavailable: %s", async platform => {
  const action = await installAction({ mode: "checkout", record: { ...record, port: 45678 } } as never,
    { cgroup: () => "", ready: () => true, platform, argv: () => [], env: { HOSTNAME: "0.0.0.0" } });
  expect(action?.command).toContain("'--port' '45678'");
  expect(action?.command).toContain("'--hostname' '0.0.0.0'");
});

test.each(["linux", "win32"] as const)("terminal context escapes state/config and excludes credentials: %s", async platform => {
  const state = "/srv/state ' $(literal); spaced";
  const config = "/srv/config ' $(literal); spaced";
  const action = await installAction({ mode: "checkout", record } as never, {
    cgroup: () => "", ready: () => true, platform, env: { HOME: "/srv/fixture home", LLV_STATE_DIR: state, XDG_CONFIG_HOME: config } as never,
  });
  expect(action?.command).toContain(platform === "win32" ? "$env:HOME=" : "HOME=");
  expect(action?.command).toContain("LLV_STATE_DIR");
  expect(action?.command).toContain("XDG_CONFIG_HOME");
  expect(action?.command).not.toContain("synthetic-secret");
  expect(action?.command).not.toContain("LLV_TOKEN");
  const escaped = platform === "win32" ? state.replaceAll("'", "''") : state.replaceAll("'", "'\\''");
  expect(action?.command).toContain(escaped);
});

test.each(["linux", "win32"] as const)("an env-only gate with unavailable private storage refuses its command: %s", async platform => {
  const action = await installAction({ mode: "unsupported", record: null, reason: "no-launcher", installRoot: "/srv/nonexistent-fixture" },
    { cgroup: () => "", ready: () => false, platform, env: { LLV_TOKEN: "synthetic-key" } });
  expect(action).toEqual({ id: "secure-handoff", button: false });
});

test("a leftover custody module cannot make an old CLI a credential reader", async () => {
  const root = mkdtempSync("/var/tmp/legacy-custody-reader-"); packageFixtures.push(root);
  mkdirSync(join(root, "bin")); mkdirSync(join(root, "state"));
  writeFileSync(join(root, "bin", "cli.mjs"), "// legacy launcher without a custody reader\n");
  copyFileSync(resolve("bin/launcher-credentials.mjs"), join(root, "bin", "launcher-credentials.mjs"));
  const action = await installAction({ mode: "unsupported", reason: "no-launcher", record: null, installRoot: root },
    { cgroup: () => "", ready: () => false, env: { LLV_STATE_DIR: join(root, "state"), LLV_TOKEN: "synthetic-key" } });
  expect(action).toEqual({ id: "secure-handoff", button: false });
});


test("credential preflight refuses a launcher changed during its awaited readiness read", async () => {
  const decision = { mode: "checkout", record: { ...record, launcher: { ...record.launcher } } };
  let release!: () => void, entered!: () => void;
  const arrival = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  const action = installAction(decision as never, { cgroup: () => "", env: {}, ready: async () => { entered(); await wait; return true; } });
  await arrival; decision.record.launcher.startIdentity = "successor"; release();
  expect(await action).toEqual({ id: "secure-handoff", button: false });
});


if (process.platform === "linux") for (const change of ["gate-expired", "new-work", "custody-changed"] as const)
test(`credential preflight fences the last genuine Git read: ${change}`, async () => {
  const root = mkdtempSync("/var/tmp/credential-dispatch-"); packageFixtures.push(root);
  const state = join(root, "state"), dir = join(state, "self-update"), bin = join(root, "bin");
  mkdirSync(dir, { recursive: true }); mkdirSync(bin); mkdirSync(join(root, ".next"));
  for (const name of ["cli.mjs", "launcher-credentials.mjs"]) copyFileSync(resolve("bin", name), join(bin, name));
  writeFileSync(join(root, ".next", "BUILD_ID"), "fixture");
  const git = Bun.which("git")!;
  const run = (...args: string[]) => {
    const result = spawnSync(git, args, { cwd: root, encoding: "utf8" });
    expect(result.status).toBe(0); return result.stdout.trim();
  };
  run("init", "-q", "-b", "main"); run("add", ".");
  run("-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "-qm", "credential fixture");
  const sha = run("rev-parse", "HEAD");
  const requestFile = join(dir, "request.json"), pointer = join(dir, "release.json"), gate = join(dir, "auto-admission.json");
  writeFileSync(pointer, JSON.stringify({ sha, dir: root, checkoutHead: sha }));
  writeFileSync(gate, JSON.stringify({ id: "owned-preflight", until: Date.now() + 60000 }));
  const decision = { mode: "checkout", record: { ...record, checkout: root, requestFile, releasePointer: pointer, socket: "fixture-socket", launcher: { ...record.launcher } } };
  const entered = join(root, "entered"), release = join(root, "release"), count = join(root, "count");
  writeFileSync(join(bin, "git"), `#!/bin/sh
n=0
[ ! -f "$CREDENTIAL_COUNT" ] || n=$(cat "$CREDENTIAL_COUNT")
n=$((n+1))
printf "%s" "$n" > "$CREDENTIAL_COUNT"
if [ "$n" = 2 ]; then touch "$CREDENTIAL_ENTERED"; while [ ! -f "$CREDENTIAL_RELEASE" ]; do sleep 0.01; done; fi
exec "$CREDENTIAL_GIT" "$@"
`, { mode: 0o700 });
  const names = ["PATH", "CREDENTIAL_COUNT", "CREDENTIAL_ENTERED", "CREDENTIAL_RELEASE", "CREDENTIAL_GIT"] as const;
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  Object.assign(process.env, { PATH: `${bin}:${process.env.PATH}`, CREDENTIAL_COUNT: count, CREDENTIAL_ENTERED: entered, CREDENTIAL_RELEASE: release, CREDENTIAL_GIT: git });
  let pending;
  try {
    // The Viewer's own evidence of admitted work; the state directory holds
    // no file that names a record.
    let work = "admitted";
    pending = installAction(decision as never, { cgroup: () => "", ready: () => true, env: { LLV_STATE_DIR: state } }, undefined, () => work);
    const deadline = Date.now() + 1500;
    while (!existsSync(entered) && Date.now() < deadline) await Bun.sleep(5);
    expect(existsSync(entered)).toBe(true);
    if (change === "gate-expired") writeFileSync(gate, JSON.stringify({ id: "owned-preflight", until: 0 }));
    writeFileSync(join(state, "state.sqlite-wal"), "an open turn's traffic");
    if (change === "new-work") work = "admitted, and a new turn";
    if (change === "custody-changed") decision.record.launcher.startIdentity = "successor";
    const pointerBefore = readFileSync(pointer, "utf8"), gateBefore = readFileSync(gate, "utf8");
    writeFileSync(release, "");
    expect(await pending).toEqual({ id: "secure-handoff", button: false });
    expect(readFileSync(pointer, "utf8")).toBe(pointerBefore); expect(readFileSync(gate, "utf8")).toBe(gateBefore);
    expect(existsSync(requestFile)).toBe(false);
  } finally {
    writeFileSync(release, ""); await pending;
    for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
  }
});

/* An ordinary systemd install. The service manager is a stand-in on PATH that
   answers `show` the way systemd does, with every specifier expanded, and
   records anything else it is asked. Nothing is written under a home. */
const managed = mkdtempSync("/var/tmp/action-service-manager-");
afterAll(() => rmSync(managed, { recursive: true, force: true }));
function manager(units: Record<string, { start: string; directory?: string; main?: number }>): { path: string; asked: () => string[] } {
  const dir = mkdtempSync(join(managed, "manager-")); const log = join(dir, "asked.log");
  const answers = Object.entries(units).map(([unit, shown]) => `  *${unit}) main=${shown.main ?? 0}
    exec='ExecStart={ path=${shown.start.split(" ")[0]} ; argv[]=${shown.start} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=${shown.main ?? 0} ; code=(null) ; status=0/0 }'
    directory='WorkingDirectory=${shown.directory ?? ""}' ;;`).join("\n");
  writeFileSync(join(dir, "systemctl"), `#!/bin/sh
case "$*" in *" show "*) ;; *) printf '%s\\n' "$*" >> '${log}'; exit 0 ;; esac
main=0; exec=; directory=
case "$*" in
${answers}
esac
case "$*" in *--value*) printf '%s\\n' "$main" ;; *) printf 'MainPID=%s\\n%s\\n%s\\n' "$main" "$exec" "$directory" ;; esac
`, { mode: 0o700 });
  return { path: dir, asked: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [] };
}
async function underManager<T>(dir: string, run: () => T | Promise<T>): Promise<T> {
  const before = process.env.PATH;
  process.env.PATH = `${dir}:${before}`;
  try { return await run(); } finally { process.env.PATH = before; }
}
const serviceCgroup = (unit: string) => () => `0::/user.slice/user-1000.slice/user@1000.service/app.slice/${unit}\n`;
test.each([
  ["a specifier, shown expanded", { start: "/srv/operator/.bun/bin/bun /srv/checkout/bin/cli.mjs --no-open --port 8898", directory: "/srv/checkout" }],
  ["a path relative to its working directory", { start: "/usr/bin/bun --bun bin/cli.mjs --no-open", directory: "/srv/checkout" }],
] as const)("a unit that starts this install with %s is its service", async (_name, shown) => {
  const unit = "delegatus-proof-expanded.service"; const service = manager({ [unit]: { ...shown, main: 999_999_999 } });
  await underManager(service.path, async () => {
    const action = await installAction({ mode: "checkout", record } as never, { cgroup: serviceCgroup(unit), ready: () => true, env: {} });
    expect(action).toEqual({ id: "restart-service", button: true, unit });
    const calls: string[][] = [];
    runInstallAction(action!, command => calls.push(command), undefined, { root: record.checkout, launcherPid: record.launcher.pid });
    expect(calls[0]?.slice(-4)).toEqual(["systemctl", "--user", "restart", unit]);
    // The same unit does not prove another install.
    expect(() => runInstallAction(action!, command => calls.push(command), undefined, { root: "/srv/elsewhere", launcherPid: record.launcher.pid })).toThrow("not proven");
  });
  expect(service.asked()).toEqual([]);
});
/* After the first self-update the entry the unit starts hands off to the
   selected release and stays as its parent: the unit's main process is the
   bootstrap, and the recorded launcher is its child. */
async function bootstrapped(script: (root: string) => string): Promise<{ root: string; bootstrap: number; launcher: number; stop(): Promise<void> }> {
  const root = mkdtempSync(join(managed, "install-")); mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "cli.mjs"), `import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
console.log(JSON.stringify({ launcher: child.pid })); setInterval(() => {}, 1000);
`);
  const parent = ownFixtureTree(spawn(process.execPath, [script(root), "--no-open"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] }));
  const { launcher } = await fixtureReport<{ launcher: number }>(parent, "bootstrap launcher", [], 1_000);
  const identity = captureProcessIdentity(launcher);
  return { root, bootstrap: parent.pid!, launcher, stop: async () => { await stopFixtureIdentity(identity); await stopFixtureProcess(parent); } };
}
test.each([
  ["an absolute entry", (root: string) => join(root, "bin", "cli.mjs")],
  ["an entry relative to its working directory", () => "bin/cli.mjs"],
] as const)("a unit whose main process is the launcher's bootstrap parent is its service: %s", async (_name, script) => {
  const tree = await bootstrapped(script);
  try {
    expect(tree.launcher).toBeGreaterThan(0);
    // The unit starts a wrapper, so its command names no install.
    const unit = "delegatus-proof-bootstrap.service"; const service = manager({ [unit]: { start: "/usr/local/bin/start-delegatus", main: tree.bootstrap } });
    const owned = { ...record, checkout: tree.root, launcher: { pid: tree.launcher, startIdentity: "7" } };
    await underManager(service.path, async () => {
      const action = await installAction({ mode: "checkout", record: owned } as never, { cgroup: serviceCgroup(unit), ready: () => true, env: {} });
      expect(action).toEqual({ id: "restart-service", button: true, unit });
      const calls: string[][] = [];
      runInstallAction(action!, command => calls.push(command), undefined, { root: tree.root, launcherPid: tree.launcher });
      expect(calls[0]?.slice(-4)).toEqual(["systemctl", "--user", "restart", unit]);
      expect(() => runInstallAction(action!, command => calls.push(command), undefined, { root: "/srv/elsewhere", launcherPid: tree.launcher })).toThrow("not proven");
    });
  } finally { await tree.stop(); }
});
