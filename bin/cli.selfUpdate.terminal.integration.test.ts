import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import {
  ADMISSION_LOG, STUB_NEXT, WORK_STARTED, children, cleanTerminalEnv, git, install, perimeterRemains, pointerFile, protectedInstall, readRecord, recordFile, registerSelfUpdateCleanup, release, request, roots, served, serviceShown, socketAnswers, start, stateText, until, type LauncherRecord,
} from "./__fixtures__/cli-self-update";

/*
 * #2007: the launcher's half of self-update, driven through the real
 * `bin/cli.mjs`. The install is a git checkout whose `next` and runtime host
 * are stubs committed into the repository, so every release worktree carries
 * them too: a stub answers with the directory it runs from, which is how the
 * test tells which release serves. Every child here is one the test started
 * (the CLI) or one the CLI started; the test signals only the CLI, by the
 * handle it spawned.
 */

registerSelfUpdateCleanup();

/** A launcher a fake service manager started detached belongs to no child
    handle of this test. The manager records the process it started: that is
    the bootstrap, which forwards a signal to the launcher it handed off to.
    Signalling only the recorded launcher makes the bootstrap start its own in
    its place, and that one outlives the file. Stop the bootstrap and wait for
    it, the recorded launcher and the children they supervise. */
async function stopManagedLauncher(pidFile: string, state: string): Promise<void> {
  const { isAlive, readStartIdentity } = await import("../src/lib/selfUpdate/pid");
  let pid: number;
  try { pid = Number(readFileSync(pidFile, "utf8")); } catch { return; }
  const identity = readStartIdentity(pid);
  let record: LauncherRecord | null = null;
  try { record = readRecord(state); } catch { /* the launcher never wrote one */ }
  const owned = [pid, record?.launcher.pid, record?.web.pid, record?.runtimeHost.pid].filter((entry): entry is number => !!entry);
  if (identity && isAlive(pid)) process.kill(pid, "SIGTERM");
  await until(() => owned.every(entry => !isAlive(entry)) || (identity !== null && isAlive(pid) && readStartIdentity(pid) !== identity), 10_000);
}
// Uses two exported, built revisions. Every process and listener belongs to
// this fixture; the operator's install and fixed ports are never consulted.
test.skipIf(process.env.LLV_SELF_UPDATE_REHEARSAL !== "1")("real built revisions apply, roll back, and re-adopt a recovery Viewer", async () => {
  const firstDir = process.env.LLV_REHEARSAL_FIRST!;
  const nextDir = process.env.LLV_REHEARSAL_NEXT!;
  for (const directory of [firstDir, nextDir]) {
    if (!directory || !path.resolve(directory).startsWith("/var/tmp/")) throw new Error("Rehearsal builds must be isolated exports");
    expect(existsSync(path.join(directory, ".next", "BUILD_ID"))).toBe(true);
    expect(existsSync(path.join(directory, "dist", "runtime-host.mjs")) || existsSync(path.join(directory, "src", "runtime-host", "main.ts"))).toBe(true);
  }
  const root = mkdtempSync("/var/tmp/delegatus-real-apply-"); roots.push(root);
  const first = git(firstDir, "rev-parse", "HEAD");
  const target = git(nextDir, "rev-parse", "HEAD");
  expect(first).not.toBe(target);
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(LLV_|DELEGATUS_|NEXT_|__NEXT_|GIT_)/.test(key)
    && !["PORT", "HOSTNAME", "NODE_ENV", "TMPDIR"].includes(key)));
  const token = "fixture-rehearsal-access-key";
  const state = path.join(root, "state");
  const env = { ...clean, HOME: path.join(root, "home"), XDG_CONFIG_HOME: path.join(root, "config"), XDG_CACHE_HOME: path.join(root, "cache"),
    TMPDIR: path.join(root, "tmp"), LLV_STATE_DIR: state, LLV_BUN_EXECUTABLE: process.execPath, LLV_TOKEN: token, LLV_DEBUG: "1", NODE_ENV: "production" as const };
  for (const directory of [env.HOME, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.TMPDIR, state]) mkdirSync(directory, { recursive: true });
  const fixture = { root, checkout: firstDir, first, state, env };
  const running = await start(fixture);
  const readHealthy = () => { const r = readRecord(state); return r.launcher.state === "healthy" && r.web.state === "healthy" && r.runtimeHost.state === "healthy" ? r : null; };
  let record = await until(readHealthy, 120_000);
  const { UnixRuntimeHostClient } = await import("../src/lib/runtime/client");
  const health = async (r: LauncherRecord) => {
    const answer = await new UnixRuntimeHostClient(r.socket).runtimeHostHealth();
    expect(answer.pid).toBe(r.runtimeHost.pid!);
    const page = await fetch(`http://127.0.0.1:${running.port}/`, { headers: { authorization: `Bearer ${token}` } });
    expect(page.status).toBe(200);
    expect((await page.text()).includes("/_next/static/")).toBe(true);
  };
  await health(record);
  const oldWeb = record.web.pid;
  const oldHost = record.runtimeHost.pid;
  const { ApplyController } = await import("../src/lib/selfUpdate/apply");
  const applyDirectory = path.join(state, "self-update");
  const apply = new ApplyController(applyDirectory);
  apply.begin(record as unknown as import("../src/lib/selfUpdate/launcher").LauncherRecord, target, "operator");
  apply.patch({ state: "ready" });
  const pointer = JSON.stringify({ sha: target, dir: nextDir, checkoutHead: first });
  writeFileSync(record.releasePointer, pointer);
  apply.send(record as unknown as import("../src/lib/selfUpdate/launcher").LauncherRecord);
  record = await until(() => { const r = readHealthy(); return r?.launcher.requestId === apply.current!.requestId && r.launcher.revision === target ? r : null; }, 150_000);
  expect(record.web.pid).not.toBe(oldWeb); expect(record.runtimeHost.pid).not.toBe(oldHost);
  expect(record.web.revision).toBe(target.slice(0, 7)); expect(record.runtimeHost.revision).toBe(target.slice(0, 7));
  await health(record);
  const settled = await fetch(`http://127.0.0.1:${running.port}/api/self-update`, { headers: { authorization: `Bearer ${token}` } });
  expect(settled.status).toBe(200);
  expect((await settled.json()).processes.runtimeHost.state).toBe("healthy");
  expect(JSON.parse(readFileSync(path.join(applyDirectory, "apply.json"), "utf8")).state).toBe("done");

  const brokenDir = path.join(root, "broken");
  git(root, "clone", "--shared", nextDir, brokenDir);
  // Compiled artifacts represent a deliberately broken candidate at the
  // same revision. The rollback restores the exact serving pointer bytes.
  const { cpSync, symlinkSync } = await import("node:fs");
  symlinkSync(path.join(nextDir, "node_modules"), path.join(brokenDir, "node_modules"));
  symlinkSync(path.join(nextDir, ".next"), path.join(brokenDir, ".next"));
  cpSync(path.join(nextDir, "dist"), path.join(brokenDir, "dist"), { recursive: true });
  writeFileSync(path.join(brokenDir, "dist", "runtime-host.mjs"), "process.exit(3);\n");
  writeFileSync(record.releasePointer, JSON.stringify({ sha: target, dir: brokenDir, checkoutHead: first }));
  writeFileSync(record.requestFile, JSON.stringify({ role: "relaunch", requestId: "real-rollback", target, rollbackPointer: pointer }));
  record = await until(() => { const r = readHealthy(); return r?.launcher.requestId === "real-rollback" && r.launcher.error?.kind === "fell-back" ? r : null; }, 150_000);
  expect(readFileSync(record.releasePointer, "utf8")).toBe(pointer);
  expect(readlinkSync(`/proc/${record.launcher.pid}/cwd`)).toBe(nextDir);
  await health(record);

  // Suspend only our recorded supervisor while replacing its owned child
  // with a manually started recovery process. Adoption runs after resume.
  const supervisor = record.launcher.pid;
  process.kill(supervisor, "SIGSTOP");
  let orphan: ReturnType<typeof spawn> | null = null;
  try {
    process.kill(record.web.pid!, "SIGTERM");
    await until(() => { try { return readFileSync(`/proc/${record.web.pid}/stat`, "utf8").includes(") Z "); } catch { return true; } }, 20_000);
    orphan = spawn(process.execPath, ["--bun", path.join(nextDir, "node_modules", "next", "dist", "bin", "next"), "start", "--hostname", "127.0.0.1", "--port", String(running.port)], {
      cwd: nextDir, env: { ...env, PORT: String(running.port), HOSTNAME: "127.0.0.1", LLV_STATE_OWNER: "viewer", LLV_RUNTIME_HOST_SOCKET: record.socket }, stdio: "ignore",
    });
    children.add(orphan);
    await until(() => { try { return existsSync(`/proc/${orphan!.pid}`) && orphan!.exitCode === null; } catch { return false; } });
    const { readStartIdentity } = await import("./self-update-supervisor.mjs");
    const adopted = record.requestFile.replace(/request-([^/]+)\.json$/, "adopt-$1.json");
    writeFileSync(adopted, JSON.stringify({ pid: orphan.pid, startIdentity: readStartIdentity(orphan.pid!), port: running.port, socket: record.socket }));
    // Require this recovery web to answer before allowing takeover.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try { if ((await fetch(`http://127.0.0.1:${running.port}/`, { headers: { authorization: `Bearer ${token}` } })).status === 200) break; } catch { /* recovery boot */ }
      await Bun.sleep(100);
    }
    expect((await fetch(`http://127.0.0.1:${running.port}/`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
  } finally { process.kill(supervisor, "SIGCONT"); }
  const orphanPid = orphan!.pid;
  record = await until(() => { const r = readHealthy(); return r && r.web.pid !== orphanPid && !existsSync(`/proc/${orphanPid}`) ? r : null; }, 120_000);
  expect(record.launcher.pid).toBe(supervisor); expect(record.web.revision).toBe(target.slice(0, 7));
  await health(record);

  // A first-party manual launch has no launcher record or inherited socket.
  // Opening its Update dialog must publish custody before Start launcher.
  const exited = new Promise(resolve => running.child.once("exit", resolve));
  running.child.kill("SIGTERM"); await exited;
  const manual = spawn(process.execPath, ["--bun", path.join(nextDir, "node_modules", "next", "dist", "bin", "next"), "start", "--hostname", "127.0.0.1", "--port", String(running.port)], {
    cwd: nextDir, env: { ...env, PORT: undefined, HOSTNAME: "127.0.0.1", LLV_STATE_OWNER: "viewer" }, stdio: "ignore",
  }); children.add(manual);
  const manualDeadline = Date.now() + 60_000;
  while (Date.now() < manualDeadline) {
    try { if ((await fetch(`http://127.0.0.1:${running.port}/api/self-update`, { headers: { authorization: `Bearer ${token}` } })).status === 200) break; } catch { /* manual boot */ }
    await Bun.sleep(100);
  }
  const { cliRuntimeHostConfig } = await import("./server-runtime.mjs");
  const manualConfig = cliRuntimeHostConfig(nextDir, { env });
  expect(JSON.parse(readFileSync(path.join(state, "self-update", `adopt-${manualConfig.installId}.json`), "utf8"))).toMatchObject({ pid: manual.pid, installRoot: nextDir });
  const restarted = spawn(process.execPath, ["--bun", path.join(nextDir, "bin", "cli.mjs"), "--no-open", "--port", String(running.port)], { cwd: nextDir, env, stdio: "ignore" }); children.add(restarted);
  await until(() => !existsSync(`/proc/${manual.pid}`), 30_000);
  record = await until(readHealthy, 120_000);
  expect(record.web.pid).not.toBe(manual.pid);
  await health(record);
}, 480_000);


// A first upgrade can roll back to a launcher that predates this protocol.
// The optional local source fixture is the exact base checkout, never a live install.
const legacySource = process.env.LLV_REHEARSAL_LEGACY;
for (const shape of ["checkout", "checkout-published", "package"] as const) for (const form of ["posix", "powershell"] as const)
for (const failure of ["host", "web", "import"] as const) (legacySource ? test : test.skip)(`legacy terminal no-intent ${shape}/${form} restores prior after ${failure}`, async () => {
  const { installAction } = await import("../src/lib/selfUpdate/actions");
  const { isAlive } = await import("../src/lib/selfUpdate/pid");
  const fixture = install();
  for (const name of readdirSync(path.join(fixture.checkout, "bin"))) {
    const source = path.join(legacySource!, "bin", name); if (existsSync(source)) copyFileSync(source, path.join(fixture.checkout, "bin", name));
  }
  if (shape !== "package") {
    git(fixture.checkout, "add", "-f", "."); git(fixture.checkout, "commit", "-m", "legacy terminal fixture"); fixture.first = git(fixture.checkout, "rev-parse", "HEAD");
  } else {
    writeFileSync(path.join(fixture.checkout, "package.json"), JSON.stringify({ name: "delegatus-cli", type: "module", version: "0.0.0" }));
    mkdirSync(path.join(fixture.checkout, "dist", "standalone"), { recursive: true }); writeFileSync(path.join(fixture.checkout, "dist", "standalone", "server.js"), STUB_NEXT(false));
    renameSync(path.join(fixture.checkout, ".git"), path.join(fixture.root, "saved-git"));
  }
  const priorRelease = shape === "checkout-published" ? release(fixture, "legacy-prior") : null;
  if (priorRelease) {
    mkdirSync(path.dirname(pointerFile(fixture)), { recursive: true });
    writeFileSync(pointerFile(fixture), JSON.stringify({ ...priorRelease, checkoutHead: fixture.first }));
  }
  const newer = install(); const candidate = release(newer, "terminal-candidate", { brokenHost: failure === "host" });
  if (shape === "package") {
    writeFileSync(path.join(candidate.dir, "package.json"), JSON.stringify({ name: "delegatus-cli", type: "module", version: "0.0.1" }));
    mkdirSync(path.join(candidate.dir, "dist", "standalone"), { recursive: true }); writeFileSync(path.join(candidate.dir, "dist", "standalone", "server.js"), STUB_NEXT(false));
  } else git(fixture.checkout, "fetch", candidate.dir, candidate.sha);
  const running = await start(fixture);
  let record = await until(() => { const r = readRecord(fixture.state); return r.web.state === "healthy" && r.runtimeHost.state === "healthy" ? r : null; });
  writeFileSync(record.releasePointer, JSON.stringify(shape !== "package" ? { ...candidate, checkoutHead: fixture.first }
    : { ...candidate, kind: "package", version: "0.0.1", baseVersion: "0.0.0" }));
  if (shape !== "package") {
    request(record, "web", "old-web-only");
    record = await until(() => { const r = readRecord(fixture.state); return r.web.state === "healthy" && r.web.revision === candidate.sha.slice(0, 7) ? r : null; });
  } else {
    // The packaged old CLI has no pointer protocol. A recovery Viewer runs B
    // beside its old host; retain the genuine old launcher's custody record.
    process.kill(record.launcher.pid, "SIGSTOP");
    process.kill(record.web.pid!, "SIGTERM"); await until(() => !isAlive(record.web.pid!));
    const recovery = spawn(process.execPath, ["--bun", path.join(candidate.dir, "dist", "standalone", "server.js")], {
      cwd: path.join(candidate.dir, "dist", "standalone"), env: { ...fixture.env, PORT: String(running.port) }, stdio: "ignore" }); children.add(recovery);
    // The recovery Viewer has read its script once it answers. A process that
    // merely exists may still read the file after the rewrite below and file
    // a failed attempt the launcher under test never made.
    for (const deadline = Date.now() + 20_000; ; await Bun.sleep(25)) {
      if (await served(running.port).catch(() => null) === path.join(candidate.dir, "dist", "standalone")) break;
      if (Date.now() > deadline) throw new Error("The recovery Viewer never answered");
    }
  }
  if (failure === "import") writeFileSync(path.join(candidate.dir, "bin", "cli.mjs"), 'throw new Error("terminal candidate import failed");\n' + readFileSync(path.join(candidate.dir, "bin", "cli.mjs"), "utf8").replace(/^#![^\n]*\n/, ""));
  if (failure === "web") writeFileSync(path.join(candidate.dir, shape === "package" ? "dist/standalone/server.js" : "node_modules/.bin/next"), STUB_NEXT(true));
  const failedAttempts = path.join(candidate.dir, "failed-attempts");
  const failingEntry = path.join(candidate.dir, failure === "host" ? "dist/runtime-host.mjs" : failure === "import" ? "bin/cli.mjs" : shape === "package" ? "dist/standalone/server.js" : "node_modules/.bin/next");
  writeFileSync(failingEntry, `(await import("node:fs")).appendFileSync(${JSON.stringify(failedAttempts)}, "attempt" + String.fromCharCode(10));\n` + readFileSync(failingEntry, "utf8").replace(/^#![^\n]*\n/, ""));
  expect(existsSync(path.join(path.dirname(record.requestFile), "apply.json"))).toBe(false);
  const action = await installAction({ mode: shape === "package" ? "package" : "checkout", reason: null, record: { ...record, installRoot: fixture.checkout, port: running.port } as never },
    { cgroup: () => "", ready: () => true, argv: () => [], env: fixture.env, platform: form === "posix" ? "linux" : "win32" });
  expect(action?.id).toBe("restart-terminal");
  const closed = new Promise(resolve => running.child.once("exit", resolve)); running.child.kill("SIGTERM");
  if (shape === "package") process.kill(record.launcher.pid, "SIGCONT");
  await Promise.race([closed, Bun.sleep(2000)]);
  if (running.child.exitCode === null && running.child.signalCode === null) { running.child.kill("SIGKILL"); await closed; }
  if (record.runtimeHost.pid && isAlive(record.runtimeHost.pid)) { process.kill(record.runtimeHost.pid, "SIGTERM"); await until(() => !isAlive(record.runtimeHost.pid!)); }
  for (const child of children) if (child !== running.child && child.exitCode === null && child.signalCode === null) {
    const done = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM"); await done;
  }
  // Execute both displayed forms; the PowerShell form is interpreted only
  // by PowerShell itself, including its encoded-script and exit semantics.
  const child = spawn(form === "posix" ? "sh" : process.env.LLV_TEST_PWSH ?? "pwsh", form === "posix" ? ["-c", action!.command!]
    : ["-NoProfile", "-Command", action!.command!], { cwd: fixture.checkout, env: cleanTerminalEnv(fixture), stdio: ["ignore", "pipe", "pipe"] }); children.add(child);
  let output = ""; child.stderr?.on("data", value => { output += value; });
  const exit = await Promise.race([new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); }), Bun.sleep(8000).then(() => null)]);
  expect(exit).toBe(1); expect(output).toContain("prior release");
  const after = await until(() => { const r = readRecord(fixture.state); return r.web.state === "healthy" && r.runtimeHost.state === "healthy" ? r : null; });
  try {
    if (priorRelease) expect(JSON.parse(readFileSync(record.releasePointer, "utf8")).sha).toBe(priorRelease.sha);
    else expect(existsSync(record.releasePointer)).toBe(false);
    expect(readFileSync(failedAttempts, "utf8").trim().split("\n")).toHaveLength(1);
    expect(await socketAnswers(after.socket)).toBe(true);
    expect(await served(running.port)).toBe((priorRelease?.dir ?? fixture.checkout) + (shape === "package" ? "/dist/standalone" : ""));
    expect(after.web.revision).toBe(after.runtimeHost.revision);
    const environment = readFileSync(`/proc/${after.web.pid}/environ`, "utf8").split("\0");
    expect(environment).toContain(`HOME=${fixture.env.HOME}`); expect(environment).toContain(`LLV_STATE_DIR=${fixture.state}`); expect(environment).toContain(`XDG_CONFIG_HOME=${fixture.env.XDG_CONFIG_HOME}`);
  } finally { if (isAlive(after.launcher.pid)) process.kill(after.launcher.pid, "SIGTERM"); await until(() => !isAlive(after.launcher.pid)); }
}, 90_000);

for (const priorPublished of [false, true]) for (const failure of ["host", "web", "import"] as const) (legacySource ? test : test.skip)(`a legacy ready pointer without an apply intent restores prior custody after ${failure} failure (prior published=${priorPublished})`, async () => {
  const { SelfUpdateService } = await import("../src/lib/selfUpdate/service");
  const { readRevision } = await import("../src/lib/selfUpdate/git");
  const { readStartIdentity } = await import("../src/lib/selfUpdate/pid");
  const { ApplyController } = await import("../src/lib/selfUpdate/apply");
  const { idleUpdate } = await import("../src/lib/selfUpdate/types");
  const fixture = install();
  for (const name of readdirSync(path.join(fixture.checkout, "bin"))) {
    const source = path.join(legacySource!, "bin", name);
    if (existsSync(source)) copyFileSync(source, path.join(fixture.checkout, "bin", name));
  }
  git(fixture.checkout, "add", "-f", "."); git(fixture.checkout, "commit", "-m", "legacy ready-pointer fixture");
  fixture.first = git(fixture.checkout, "rev-parse", "HEAD");
  const candidateFixture = install();
  const candidate = release(candidateFixture, `ready-broken-${failure}`, { brokenHost: failure === "host" });
  git(fixture.checkout, "fetch", candidate.dir, candidate.sha);
  const prior = priorPublished ? release(fixture, "prior-published") : { sha: fixture.first, dir: fixture.checkout };
  if (priorPublished) {
    const installId = path.basename(pointerFile(fixture)).slice("release-".length, -".json".length);
    const destination = path.join(fixture.env.XDG_CACHE_HOME!, "delegatus", "self-update", installId, "releases", prior.sha.slice(0, 12));
    mkdirSync(path.dirname(destination), { recursive: true });
    git(fixture.checkout, "worktree", "move", prior.dir, destination); prior.dir = destination;
  }
  const priorPointer = priorPublished ? JSON.stringify({ ...prior, checkoutHead: fixture.first }) : null;
  if (priorPointer) { mkdirSync(path.dirname(pointerFile(fixture)), { recursive: true }); writeFileSync(pointerFile(fixture), priorPointer); }
  const running = await start(fixture);
  let record = await until(() => { const r = readRecord(fixture.state); return r.web.state === "healthy" && r.runtimeHost.state === "healthy" ? r : null; });
  writeFileSync(record.releasePointer, JSON.stringify({ ...candidate, checkoutHead: fixture.first }));
  // Old code can switch just the web before the new Viewer owns any apply intent.
  writeFileSync(record.requestFile, JSON.stringify({ role: "web", requestId: "legacy-web-only", requestedAt: new Date().toISOString() }));
  record = await until(() => { const r = readRecord(fixture.state); return r.web.state === "healthy" && r.web.revision === candidate.sha.slice(0, 7) ? r : null; });
  expect(record.runtimeHost.revision).toBe(prior.sha.slice(0, 7));
  const unexpectedStart = path.join(candidate.dir, "unexpected-start");
  if (failure === "import") writeFileSync(path.join(candidate.dir, "bin", "cli.mjs"),
    `if (!process.argv.includes("--version")) (await import("node:fs")).writeFileSync(${JSON.stringify(unexpectedStart)}, "candidate started"); throw new Error("fixture import failure");\n`
      + readFileSync(path.join(candidate.dir, "bin", "cli.mjs"), "utf8").replace(/^#![^\n]*\n/, ""));
  if (failure === "web") writeFileSync(path.join(candidate.dir, "node_modules", ".bin", "next"), STUB_NEXT(true));
  const directory = path.dirname(record.requestFile);
  const managerDir = path.join(fixture.root, "manager"); mkdirSync(managerDir);
  const manager = path.join(managerDir, "systemctl");
  writeFileSync(manager, `#!${process.execPath} --bun
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
if (process.argv.includes("show")) { process.stdout.write(${JSON.stringify(serviceShown(fixture))}); process.exit(0); }
const record = JSON.parse(readFileSync(${JSON.stringify(recordFile(fixture.state))}, "utf8"));
const directory = ${JSON.stringify(directory)};
const intent = JSON.parse(readFileSync(directory + "/apply.json", "utf8"));
const drain = JSON.parse(readFileSync(directory + "/auto-drain.json", "utf8"));
if (intent.state !== "switching" || intent.requestId !== drain.id) process.exit(9);
writeFileSync(${JSON.stringify(path.join(fixture.root, "recovery-custody.json"))}, JSON.stringify({ requestId: intent.requestId, state: intent.state, drain: drain.id }));
// A service restart stops the recorded bootstrap, which forwards to its
// installed-launcher child. Both PIDs belong to this fixture.
const bootstrapPid = ${JSON.stringify(running.child.pid)};
process.kill(bootstrapPid, "SIGTERM");
const deadline = Date.now() + 5000;
while (Date.now() < deadline) { try { process.kill(bootstrapPid, 0); } catch { break; } await Bun.sleep(25); }
const launcher = spawn(process.execPath, ["--bun", ${JSON.stringify(path.join(fixture.checkout, "bin", "cli.mjs"))}, "--no-open", "--port", ${JSON.stringify(String(running.port))}], { cwd: ${JSON.stringify(fixture.checkout)}, detached: true, stdio: "ignore", env: process.env });
writeFileSync(${JSON.stringify(path.join(managerDir, "launcher.pid"))}, String(launcher.pid));
launcher.unref();
`, { mode: 0o700 });
  expect(existsSync(path.join(directory, "apply.json"))).toBe(false);
  let restarting: Promise<void> | undefined;
  let recoveryOutput = "";
  let recoveryHelper: ReturnType<typeof spawn> | undefined;
  const runner = { state: idleUpdate(), start: async () => {}, retry: async () => {}, restore(state: ReturnType<typeof idleUpdate>) { this.state = state; }, logPath: () => "" };
  const service = new SelfUpdateService({
    now: () => Date.now(), env: fixture.env, dir: directory, remote: "https://example.invalid/project.git", branch: "main", pollMinutes: 60, bun: process.execPath,
    mode: async () => ({ mode: "checkout", reason: null, record: readRecord(fixture.state) as unknown as import("../src/lib/selfUpdate/launcher").LauncherRecord }),
    check: async () => ({ ok: false, error: "fixture", installed: null }), describe: readRevision,
    createRunner: () => runner, requestRestart: () => "unused", processAlive: (pid, identity) => readStartIdentity(pid) === identity, processIdentity: (pid) => readStartIdentity(pid),
    hostHealth: async () => { const r = readRecord(fixture.state); return await socketAnswers(r.socket) ? { pid: r.runtimeHost.pid!, startIdentity: readStartIdentity(r.runtimeHost.pid!)!, hostEpoch: 1 } : null; },
    requestDeployment: async () => { throw new Error("unused"); }, readDeployment: async () => null,
    findDeploymentByIdempotencyKey: async () => null, releaseTarget: () => null, prepareCheckRepo: async () => { throw new Error("unused"); },
    buildEnv: () => ({}), web: { pid: record.web.pid!, port: running.port, startedAt: "" },
    install: { action: () => ({ id: "restart-service", button: true, unit: "fixture.service" }), entry: () => path.join(prior.dir, "bin", "cli.mjs"), run: (action, recovery) => {
      if (recovery) {
        restarting = (async () => {
          const { runInstallAction, unitRunsLauncher } = await import("../src/lib/selfUpdate/actions");
          // What the manager shows proves the service, here and in the helper.
          const owner = { root: fixture.checkout };
          runInstallAction(action, args => {
            const command = args.slice(args.indexOf("--") + 1);
            const helper = spawn(command[0]!, command.slice(1), { cwd: fixture.checkout, env: { ...fixture.env, PATH: managerDir + path.delimiter + fixture.env.PATH }, stdio: "pipe" }); children.add(helper); recoveryHelper = helper;
            // The recovery must outlive the Viewer that requested it.
            helper.stderr?.on("data", chunk => { recoveryOutput += String(chunk); });
          }, recovery, owner, (unit, root, pid) => unitRunsLauncher(unit, root, pid, { show: () => serviceShown(fixture) }));
        })();
        return;
      }
      restarting = (async () => {
        const closed = new Promise(resolve => running.child.once("exit", resolve)); running.child.kill("SIGTERM"); await closed;
        const child = spawn(process.execPath, ["--bun", path.join(fixture.checkout, "bin", "cli.mjs"), "--no-open", "--port", String(running.port)], { cwd: fixture.checkout, env: fixture.env, stdio: "ignore" });
        children.add(child);
      })();
    } },
  });
  try {
    const { postInstallAction } = await import("../src/lib/selfUpdate/routes");
    const { setSelfUpdateServiceForTests } = await import("../src/lib/selfUpdate/instance");
    const { NextRequest } = await import("next/server");
    setSelfUpdateServiceForTests(service);
    const response = await postInstallAction(new NextRequest("http://localhost/api/self-update/install-action", { method: "POST", headers: { origin: "http://localhost", host: "localhost", "sec-fetch-site": "same-origin" } }));
    await response.json();
    if (failure === "import") {
      expect(response.status).toBe(503);
      // The action itself must finish owned recovery, without a second restart.
      const settled = readRecord(fixture.state);
      expect(recoveryOutput).toBe("");
      expect(recoveryHelper?.exitCode).toBe(0);
      expect(existsSync(path.join(directory, path.basename(record.requestFile).replace(/^request/, "recovery")))).toBe(false);
      expect(settled.web.revision).toBe(settled.runtimeHost.revision);
      expect(settled.web.revision).toBe(prior.sha.slice(0, 7));
      expect(await served(running.port)).toBe(prior.dir);
      expect(await socketAnswers(settled.socket)).toBe(true);
      expect(restarting).toBeDefined();
      const intent = JSON.parse(readFileSync(path.join(directory, "apply.json"), "utf8"));
      expect(intent).toMatchObject({ state: "failed", rolledBack: true, launcherPid: record.launcher.pid, launcherIdentity: record.launcher.startIdentity });
      expect(JSON.parse(readFileSync(path.join(fixture.root, "recovery-custody.json"), "utf8"))).toEqual({ requestId: intent.requestId, state: "switching", drain: intent.requestId });
      expect(existsSync(unexpectedStart)).toBe(false);
      expect(existsSync(path.join(directory, "auto-drain.json"))).toBe(false);
      expect(new ApplyController(directory).observe(settled as never, await socketAnswers(settled.socket))).toBeNull();
      expect(existsSync(record.releasePointer) ? JSON.parse(readFileSync(record.releasePointer, "utf8")).sha : null).toBe(priorPublished ? prior.sha : null);
      return;
    }
    expect(response.status).toBe(202);
    await restarting;
    const intent = JSON.parse(readFileSync(path.join(directory, "apply.json"), "utf8"));
    expect(intent.rollbackPointer ? JSON.parse(intent.rollbackPointer).sha : null).toBe(priorPublished ? prior.sha : null);
    expect(intent.rollbackWebRevision).toBe(prior.sha.slice(0, 7));
    expect(intent.rollbackHostRevision).toBe(prior.sha.slice(0, 7));
    record = await until(() => { const r = readRecord(fixture.state); return r.web.state === "healthy" && r.runtimeHost.state === "healthy"
      && r.web.revision === prior.sha.slice(0, 7) && r.runtimeHost.revision === prior.sha.slice(0, 7) ? r : null; }, 60_000);
    expect(existsSync(record.releasePointer) ? JSON.parse(readFileSync(record.releasePointer, "utf8")).sha : null).toBe(priorPublished ? prior.sha : null);
    expect(await served(running.port)).toBe(prior.dir);
    const cold = new ApplyController(directory);
    expect(cold.observe(record as unknown as import("../src/lib/selfUpdate/launcher").LauncherRecord, await socketAnswers(record.socket))).toBe("failed");
    expect(cold.current).toMatchObject({ rolledBack: true, state: "failed" });
  } finally {
    const { setSelfUpdateServiceForTests } = await import("../src/lib/selfUpdate/instance"); setSelfUpdateServiceForTests(null); service.stop(); await restarting;
    // The import-failure branch leaves the launcher its fake manager started.
    await stopManagedLauncher(path.join(managerDir, "launcher.pid"), fixture.state);
  }
}, 90_000);

(legacySource ? test : test.skip)("actual legacy bootstrap rollback settles the apply and seat receipt", async () => {
  const { ApplyController } = await import("../src/lib/selfUpdate/apply");
  const { activeDrain, writeDrain } = await import("../src/lib/selfUpdate/drain");
  const fixture = install();
  for (const name of readdirSync(path.join(fixture.checkout, "bin"))) {
    const source = path.join(legacySource!, "bin", name);
    if (existsSync(source)) copyFileSync(source, path.join(fixture.checkout, "bin", name));
  }
  git(fixture.checkout, "add", "-f", "."); git(fixture.checkout, "commit", "-m", "legacy launcher fixture");
  fixture.first = git(fixture.checkout, "rev-parse", "HEAD");
  const candidateFixture = install(); const candidate = release(candidateFixture, "broken-new-host", { brokenHost: true });
  const running = await start(fixture);
  const before = await until(() => { const r = readRecord(fixture.state); return r.web.state === "healthy" && r.runtimeHost.state === "healthy" ? r : null; });
  expect(Object.keys(before.launcher).sort()).toEqual(["autoAdmission", "pid", "startIdentity"]);
  const directory = path.dirname(before.requestFile);
  const controller = new ApplyController(directory);
  writeFileSync(path.join(directory, "deployments.json"), JSON.stringify([{ deploymentId: "legacy-seat", idempotencyKey: "legacy-key", phase: "queued", terminal: false, revisionNumber: 1 }]));
  controller.begin(before as unknown as import("../src/lib/selfUpdate/launcher").LauncherRecord, candidate.sha, "seat", "legacy-seat");
  controller.patch({ state: "switching", externalRestart: true, switchedAt: new Date().toISOString() });
  writeFileSync(before.releasePointer, JSON.stringify({ ...candidate, checkoutHead: fixture.first }));
  const trial = before.requestFile.replace("request-", "trial-");
  writeFileSync(trial, JSON.stringify({ requestId: controller.current!.requestId, target: candidate.sha, rollbackPointer: null,
    previousEntry: path.join(fixture.checkout, "bin", "cli.mjs"), state: "starting", at: controller.current!.startedAt }));
  writeDrain(path.join(directory, "auto-drain.json"), { id: controller.current!.requestId, target: candidate.sha, since: controller.current!.startedAt, until: Date.now() + 600_000, persistent: true });
  const closed = new Promise(resolve => running.child.once("exit", resolve)); running.child.kill("SIGTERM"); await closed;
  const restarted = spawn(process.execPath, ["--bun", path.join(fixture.checkout, "bin", "cli.mjs"), "--no-open", "--port", String(running.port)],
    { cwd: fixture.checkout, env: fixture.env, stdio: "ignore" }); children.add(restarted);
  const after = await until(() => { const r = readRecord(fixture.state); return r.launcher.pid !== before.launcher.pid
    && r.web.state === "healthy" && r.runtimeHost.state === "healthy" && r.web.revision === fixture.first.slice(0, 7) ? r : null; }, 60_000);
  expect(JSON.parse(readFileSync(trial, "utf8")).state).toBe("rolled-back");
  expect(existsSync(before.releasePointer)).toBe(false); expect(await served(running.port)).toBe(fixture.checkout);
  const healthy = await socketAnswers(after.socket);
  const cold = new ApplyController(directory);
  expect(cold.observe(after as unknown as import("../src/lib/selfUpdate/launcher").LauncherRecord, healthy)).toBe("failed");
  expect(cold.current).toMatchObject({ state: "failed", rolledBack: true });
  expect(JSON.parse(readFileSync(path.join(directory, "deployments.json"), "utf8"))[0]).toMatchObject({ phase: "rolled-back", terminal: true });
  expect(activeDrain(path.join(directory, "auto-drain.json"))).toBeNull(); expect(existsSync(trial)).toBe(false);
}, 90_000);

for (const broken of [false, true]) (legacySource ? test : test.skip)(`actual legacy package terminal handoff settles rollback=${broken}`, async () => {
  const { ApplyController } = await import("../src/lib/selfUpdate/apply");
  const { installAction } = await import("../src/lib/selfUpdate/actions");
  const fixture = install();
  for (const name of readdirSync(path.join(fixture.checkout, "bin"))) {
    const source = path.join(legacySource!, "bin", name); if (existsSync(source)) copyFileSync(source, path.join(fixture.checkout, "bin", name));
  }
  writeFileSync(path.join(fixture.checkout, "package.json"), JSON.stringify({ name: "delegatus-cli", type: "module", version: "0.0.0" }));
  mkdirSync(path.join(fixture.checkout, "dist", "standalone"), { recursive: true });
  writeFileSync(path.join(fixture.checkout, "dist", "standalone", "server.js"), STUB_NEXT(false));
  renameSync(path.join(fixture.checkout, ".git"), path.join(fixture.root, "saved-git"));
  const candidateFixture = install(); const candidate = release(candidateFixture, "package-handoff", { brokenHost: broken });
  writeFileSync(path.join(candidate.dir, "package.json"), JSON.stringify({ name: "delegatus-cli", type: "module", version: "0.0.1" }));
  mkdirSync(path.join(candidate.dir, "dist", "standalone"), { recursive: true }); writeFileSync(path.join(candidate.dir, "dist", "standalone", "server.js"), STUB_NEXT(false));
  const running = await start(fixture);
  const before = await until(() => { const r = readRecord(fixture.state); return r.web.state === "healthy" && r.runtimeHost.state === "healthy" ? r : null; });
  const record = { ...before, installRoot: fixture.checkout } as unknown as import("../src/lib/selfUpdate/launcher").LauncherRecord;
  const controller = new ApplyController(path.dirname(before.requestFile)); controller.begin(record, candidate.sha, "operator"); controller.patch({ state: "ready", externalRestart: true });
  writeFileSync(before.releasePointer, JSON.stringify({ kind: "package", version: "0.0.1", baseVersion: "0.0.0", dir: candidate.dir, sha: candidate.sha }));
  writeFileSync(before.requestFile.replace("request-", "trial-"), JSON.stringify({ requestId: controller.current!.requestId, target: candidate.sha,
    rollbackPointer: null, previousEntry: path.join(fixture.checkout, "bin", "cli.mjs"), state: "starting", at: controller.current!.startedAt }));
  const action = await installAction({ mode: "package", reason: null, record }, { cgroup: () => "", ready: () => true, argv: () => [], env: fixture.env });
  const closed = new Promise(resolve => running.child.once("exit", resolve)); running.child.kill("SIGTERM"); await closed;
  const child = spawn("sh", ["-c", `exec ${action!.command!}`], { cwd: fixture.checkout, env: cleanTerminalEnv(fixture), stdio: "ignore" }); children.add(child);
  const after = await until(() => { const r = readRecord(fixture.state); return r.launcher.pid !== before.launcher.pid && r.web.state === "healthy" && r.runtimeHost.state === "healthy"
    && (broken ? !existsSync(before.releasePointer) : r.launcher.requestId === controller.current!.requestId) ? r : null; }, 60_000);
  expect(await served(running.port)).toBe((broken ? fixture.checkout : candidate.dir) + "/dist/standalone");
  const cold = new ApplyController(path.dirname(before.requestFile)); expect(cold.observe(after as unknown as import("../src/lib/selfUpdate/launcher").LauncherRecord, await socketAnswers(after.socket))).toBe(broken ? "failed" : "done");
  expect(cold.current).toMatchObject({ state: broken ? "failed" : "done", rolledBack: broken });
}, 90_000);

for (const trigger of ["operator", "auto"] as const) test(`same-PID rollback keeps ${trigger} custody until a cold snapshot proves coherent serving`, async () => {
  const { ApplyController } = await import("../src/lib/selfUpdate/apply");
  const { SelfUpdateService } = await import("../src/lib/selfUpdate/service");
  const { readStartIdentity, isAlive } = await import("../src/lib/selfUpdate/pid");
  const { activeDrain } = await import("../src/lib/selfUpdate/drain");
  const { initialAuto, writeAuto } = await import("../src/lib/selfUpdate/auto");
  const { idleUpdate } = await import("../src/lib/selfUpdate/types");
  const fixture = install();
  const running = await start(fixture);
  let record = await until(() => { const r = readRecord(fixture.state); return r.web.state === "healthy" && r.runtimeHost.state === "healthy" ? r : null; });
  const candidate = release(fixture, "broken-web", { broken: true });
  const directory = path.join(fixture.state, "self-update");
  const apply = new ApplyController(directory);
  apply.begin(record as unknown as import("../src/lib/selfUpdate/launcher").LauncherRecord, candidate.sha, trigger);
  writeFileSync(record.releasePointer, JSON.stringify({ sha: candidate.sha, dir: candidate.dir, checkoutHead: fixture.first }));
  apply.send(record as unknown as import("../src/lib/selfUpdate/launcher").LauncherRecord);
  record = await until(() => { const r = readRecord(fixture.state); return r.launcher.requestId === apply.current!.requestId && r.launcher.error?.kind === "fell-back" && r.web.state === "healthy" && r.runtimeHost.state === "healthy" ? r : null; }, 60_000);
  expect(record.launcher.pid).toBe(apply.current!.launcherPid);
  if (trigger === "auto") writeAuto(path.join(directory, "auto.json"), { ...initialAuto(), enabled: true,
    drain: { id: apply.current!.requestId, target: { sha: candidate.sha, short: candidate.sha.slice(0, 7), version: "", date: "" }, since: apply.current!.startedAt, overranAt: null, blockers: null, admitted: true } });
  const coherent = structuredClone(record) as unknown as import("../src/lib/selfUpdate/launcher").LauncherRecord;
  let observed = coherent;
  const snapshot = async () => {
    const service = new SelfUpdateService({
      now: () => Date.now(), env: fixture.env, dir: directory, remote: "https://example.invalid/project.git", branch: "main", pollMinutes: 60, bun: process.execPath,
      mode: async () => ({ mode: "checkout", reason: null, record: observed }),
      check: async () => ({ ok: false, error: "fixture", installed: null }),
      describe: async (_repo, sha) => ({ sha, short: sha.slice(0, 7), version: "", date: "" }),
      createRunner: () => ({ state: idleUpdate(), restore() {}, logPath: () => "" }) as never,
      requestRestart: () => "unused", processAlive: (pid, identity) => isAlive(pid) && readStartIdentity(pid) === identity, processIdentity: (pid) => readStartIdentity(pid),
      hostHealth: async () => ({ pid: coherent.runtimeHost.pid!, startIdentity: readStartIdentity(coherent.runtimeHost.pid!)!, hostEpoch: 1 }),
      requestDeployment: async () => { throw new Error("unused"); }, readDeployment: async () => null, findDeploymentByIdempotencyKey: async () => null,
      releaseTarget: () => null, prepareCheckRepo: async () => { throw new Error("unused"); }, buildEnv: () => ({}),
      web: { pid: coherent.web.pid!, port: running.port, startedAt: "" },
    });
    try { return await service.snapshot(); } finally { service.stop(); }
  };
  // A stopped launcher cannot race the deliberately degraded observations.
  process.kill(record.launcher.pid, "SIGSTOP");
  try {
    for (const role of ["web", "runtimeHost"] as const) for (const fault of ["identity", "mixed", "failed"] as const) {
      observed = structuredClone(coherent);
      if (fault === "identity") observed[role].startIdentity = "wrong-identity";
      if (fault === "mixed") observed[role].revision = candidate.sha.slice(0, 7);
      if (fault === "failed") observed[role].state = "failed";
      await snapshot();
      expect(new ApplyController(directory).current?.state).toBe("switching");
      expect(activeDrain(path.join(directory, "auto-drain.json"))).not.toBeNull();
    }
    observed = coherent;
    // Rejection also needs healthy prior serving evidence.
    writeFileSync(`${record.requestFile}.result.json`, JSON.stringify({ requestId: apply.current!.requestId, state: "rejected" }));
    process.kill(record.runtimeHost.pid!, "SIGTERM");
    await until(() => !isAlive(record.runtimeHost.pid!) ? true : null);
    await snapshot();
    expect(new ApplyController(directory).current?.state).toBe("switching");
    expect(activeDrain(path.join(directory, "auto-drain.json"))).not.toBeNull();
    rmSync(`${record.requestFile}.result.json`);
    await snapshot();
    expect(new ApplyController(directory).current?.state).toBe("switching");
    expect(activeDrain(path.join(directory, "auto-drain.json"))).not.toBeNull();
  } finally { process.kill(record.launcher.pid, "SIGCONT"); }
  record = await until(() => { const r = readRecord(fixture.state); return r.runtimeHost.state === "healthy" && r.runtimeHost.pid !== coherent.runtimeHost.pid ? r : null; });
  observed = record as unknown as import("../src/lib/selfUpdate/launcher").LauncherRecord;
  coherent.runtimeHost = observed.runtimeHost;
  process.kill(record.launcher.pid, "SIGSTOP");
  try {
    process.kill(record.web.pid!, "SIGTERM");
    await until(() => !isAlive(record.web.pid!) ? true : null);
    await snapshot();
    expect(new ApplyController(directory).current?.state).toBe("switching");
    expect(activeDrain(path.join(directory, "auto-drain.json"))).not.toBeNull();
  } finally { process.kill(record.launcher.pid, "SIGCONT"); }
  record = await until(() => { const r = readRecord(fixture.state); return r.web.state === "healthy" && r.web.pid !== coherent.web.pid ? r : null; });
  observed = record as unknown as import("../src/lib/selfUpdate/launcher").LauncherRecord;
  coherent.web = observed.web;
  await snapshot();
  expect(new ApplyController(directory).current).toMatchObject({ state: "failed", rolledBack: true });
  expect(activeDrain(path.join(directory, "auto-drain.json"))).toBeNull();
}, 90_000);

test.each(["restart-terminal", "start-launcher"] as const)("the actual %s command carries state and config from a clean shell", async actionId => {
  const { installAction } = await import("../src/lib/selfUpdate/actions");
  const { ApplyController } = await import("../src/lib/selfUpdate/apply");
  const fixture = install();
  // Quotes, spaces and shell expansion characters must remain literal paths.
  fixture.state = path.join(fixture.root, "state ' with $(literal) spaces");
  fixture.env.LLV_STATE_DIR = fixture.state;
  fixture.env.XDG_CONFIG_HOME = path.join(fixture.root, "config ' with $(literal) spaces");
  mkdirSync(fixture.state, { recursive: true });
  const running = await start(fixture);
  const before = await until(() => { const r = readRecord(fixture.state); return r.web.state === "healthy" && r.runtimeHost.state === "healthy" ? r : null; });
  const candidate = release(fixture, "terminal-context");
  const record = before as unknown as import("../src/lib/selfUpdate/launcher").LauncherRecord;
  const apply = new ApplyController(path.dirname(before.requestFile));
  apply.begin(record, candidate.sha, "operator"); apply.patch({ state: "ready", externalRestart: true });
  writeFileSync(before.releasePointer, JSON.stringify({ sha: candidate.sha, dir: candidate.dir, checkoutHead: fixture.first }));
  const decision = actionId === "restart-terminal"
    ? { mode: "checkout" as const, reason: null, record: { ...record, launcher: { ...record.launcher, relaunch: undefined } } }
    : { mode: "unsupported" as const, reason: "no-launcher" as const, record: null, installRoot: fixture.checkout };
  const action = await installAction(decision, { cgroup: () => "", ready: () => true, argv: () => [], env: { ...fixture.env, PORT: String(running.port), HOSTNAME: "127.0.0.1" } });
  expect(action?.id).toBe(actionId);
  const closed = new Promise(resolve => running.child.once("exit", resolve)); running.child.kill("SIGTERM"); await closed;
  let adopted: ReturnType<typeof spawn> | null = null;
  if (actionId === "start-launcher") {
    const { readStartIdentity } = await import("../src/lib/selfUpdate/pid");
    adopted = spawn(process.execPath, ["--bun", path.join(fixture.checkout, "node_modules", ".bin", "next")], {
      cwd: fixture.checkout, env: { ...fixture.env, PORT: String(running.port), LLV_RUNTIME_HOST_SOCKET: before.socket }, stdio: "ignore",
    });
    children.add(adopted);
    await until(() => { try { return readStartIdentity(adopted!.pid!) && true; } catch { return false; } });
    await until(() => { try { return existsSync(`/proc/${adopted!.pid}/environ`); } catch { return false; } });
    await Bun.sleep(150);
    writeFileSync(before.requestFile.replace("request-", "adopt-"), JSON.stringify({ pid: adopted.pid, startIdentity: readStartIdentity(adopted.pid!), port: running.port, socket: before.socket }));
  }
  const child = spawn("sh", ["-c", `exec ${action!.command!}`], { cwd: fixture.checkout, env: cleanTerminalEnv(fixture), stdio: "ignore" }); children.add(child);
  const after = await until(() => { const r = readRecord(fixture.state); return r.launcher.pid !== before.launcher.pid && r.web.state === "healthy" && r.runtimeHost.state === "healthy" ? r : null; });
  expect(await served(running.port)).toBe(candidate.dir);
  expect(after.releasePointer).toBe(before.releasePointer);
  if (adopted) expect(adopted.exitCode !== null || adopted.signalCode !== null).toBe(true);
  expect(new ApplyController(path.dirname(before.requestFile)).current?.requestId).toBe(apply.current!.requestId);
  const webEnvironment = readFileSync(`/proc/${after.web.pid}/environ`, "utf8").split("\0");
  expect(webEnvironment).toContain(`HOME=${fixture.env.HOME}`);
  expect(webEnvironment).toContain(`XDG_CONFIG_HOME=${fixture.env.XDG_CONFIG_HOME}`);
  expect(webEnvironment).toContain(`LLV_STATE_DIR=${fixture.state}`);
}, 45_000);

for (const shape of ["checkout", "package"] as const) for (const alias of ["LLV_TOKEN", "DELEGATUS_TOKEN"] as const)
for (const actionId of ["start-launcher", "restart-terminal"] as const) for (const rollback of [false, true])
test(`private terminal custody ${shape}/${alias}/${actionId}, rollback=${rollback}`, async () => {
  const { installAction } = await import("../src/lib/selfUpdate/actions");
  const { ApplyController } = await import("../src/lib/selfUpdate/apply");
  const { f, candidate, key } = await protectedInstall(shape, alias);
  const running = await start(f);
  const before = await until(() => { const r = readRecord(f.state); return r.web.state === "healthy" && r.runtimeHost.state === "healthy" ? r : null; });
  await perimeterRemains(running.port, key);
  const apply = new ApplyController(path.dirname(before.requestFile));
  apply.begin(before as never, candidate.sha, "operator"); apply.patch({ state: "ready", externalRestart: true });
  writeFileSync(before.releasePointer, JSON.stringify({ ...candidate, ...(shape === "package" ? { kind: "package", baseVersion: "0.0.0", version: "0.0.1" } : { checkoutHead: f.first }) }));
  if (rollback) writeFileSync(path.join(candidate.dir, "bin/cli.mjs"), 'throw new Error("synthetic load failure");\n' + readFileSync(path.join(candidate.dir, "bin/cli.mjs"), "utf8").replace(/^#![^\n]*\n/, ""));
  const decision = actionId === "restart-terminal"
    ? { mode: shape, reason: null, record: { ...before, launcher: { ...before.launcher, relaunch: undefined } } }
    : { mode: "unsupported", reason: "no-launcher", record: null, installRoot: f.checkout };
  const action = await installAction(decision as never, { cgroup: () => "", ready: () => true, argv: () => [], env: { ...f.env, PORT: String(running.port) } });
  expect(action?.id).toBe(actionId);
  expect(Boolean(action?.command?.includes(key))).toBe(false);
  const clean = cleanTerminalEnv(f);
  expect(clean.LLV_TOKEN === undefined && clean.DELEGATUS_TOKEN === undefined).toBe(true);
  const exited = new Promise(resolve => running.child.once("exit", resolve));
  if (actionId === "start-launcher" && rollback) {
    // A real admitted request survives a killed launcher. The cold entrypoint
    // must roll it back before serving, using its original owner and request.
    process.kill(before.launcher.pid, "SIGSTOP"); apply.send(before as never);
    running.child.kill("SIGKILL"); await exited;
    const { isAlive } = await import("../src/lib/selfUpdate/pid");
    for (const role of [before.web, before.runtimeHost]) if (role.pid && isAlive(role.pid)) process.kill(role.pid, "SIGTERM");
    await until(() => !isAlive(before.web.pid!) && !isAlive(before.runtimeHost.pid!));
  } else { running.child.kill("SIGTERM"); await exited; }
  const child = spawn("sh", ["-c", `exec ${action!.command!}`], { cwd: f.checkout, env: clean, stdio: ["ignore", "pipe", "pipe"] }); children.add(child);
  let output = ""; child.stdout!.on("data", bytes => output += bytes); child.stderr!.on("data", bytes => output += bytes);
  const after = await until(() => { const r = readRecord(f.state); return r.launcher.pid !== before.launcher.pid && r.web.state === "healthy" && r.runtimeHost.state === "healthy" ? r : null; });
  await perimeterRemains(running.port, key);
  expect(after.releasePointer).toBe(before.releasePointer); expect(after.socket).toBe(before.socket);
  expect(after.web.revision).toBe(after.runtimeHost.revision);
  if (!rollback) expect(after.web.revision).toBe(candidate.sha.slice(0, 7));
  if (rollback) expect(after.web.revision).toBe(shape === "checkout" ? f.first.slice(0, 7) : null);
  for (const entry of [after.launcher, after.web, after.runtimeHost]) {
    expect(readFileSync(`/proc/${entry.pid}/cmdline`, "utf8").includes(key)).toBe(false);
  }
  expect(output.includes(key)).toBe(false);
}, 60000);


test.each(["gate-expired", "new-work", "launcher-changed"] as const)("resident relaunch fences the last awaited load preflight: %s", async change => {
  const { ApplyController } = await import("../src/lib/selfUpdate/apply");
  const { beginRestartGate, restartGateFile } = await import("../src/lib/selfUpdate/restartGate");
  const { writeDrain } = await import("../src/lib/selfUpdate/drain");
  const { f, key } = await protectedInstall("checkout", "LLV_TOKEN");
  const running = await start(f);
  const before = await until(() => { const r = readRecord(f.state); return r.web.state === "healthy" && r.runtimeHost.state === "healthy" ? r : null; });
  const candidate = release(f, "dispatch-load-fence");
  const entered = path.join(f.root, "load-entered"), released = path.join(f.root, "load-released");
  const entry = path.join(candidate.dir, "bin", "cli.mjs");
  writeFileSync(entry, `if (process.argv.includes("--version")) { const fs = await import("node:fs"); fs.writeFileSync(${JSON.stringify(entered)}, String(process.pid)); while (!fs.existsSync(${JSON.stringify(released)})) await Bun.sleep(5); }\n`
    + readFileSync(entry, "utf8").replace(/^#![^\n]*\n/, ""));
  const dir = path.dirname(before.requestFile), apply = new ApplyController(dir);
  const gateFile = restartGateFile(before.requestFile), gateId = beginRestartGate(gateFile)!;
  apply.begin(before as never, candidate.sha, "auto", undefined, { autoGateId: gateId });
  writeDrain(path.join(dir, "auto-drain.json"), { id: apply.current!.requestId, target: candidate.sha, since: apply.current!.startedAt, until: Date.now() + 600000, persistent: true });
  writeFileSync(before.releasePointer, JSON.stringify({ ...candidate, checkoutHead: f.first }));
  apply.send(before as never, gateId);
  const originalApply = readFileSync(path.join(dir, "apply.json"), "utf8"), originalRequest = readFileSync(before.requestFile, "utf8");
  await until(() => existsSync(entered));
  if (change === "gate-expired") { const gate = JSON.parse(readFileSync(gateFile, "utf8")); writeFileSync(gateFile, JSON.stringify({ ...gate, until: 0 })); }
  // A turn or a stage that starts now is filed in the Viewer's database, with
  // the registry in sqlite: no file the launcher reads names it. The files an
  // open turn writes move as well, and say nothing about new work.
  const admissions = () => readFileSync(path.join(f.state, ADMISSION_LOG), "utf8").trim().split("\n");
  expect(admissions()).toEqual(["request filed"]);
  expect(existsSync(path.join(f.state, "agent-registry.json"))).toBe(false);
  for (const name of ["state.sqlite", "state.sqlite-wal", "runtime-events-fixture.sqlite-wal"]) writeFileSync(path.join(f.state, name), `event ${change}`);
  if (change === "new-work") writeFileSync(path.join(f.state, WORK_STARTED), "");
  if (change === "launcher-changed") { const r = readRecord(f.state); r.launcher.startIdentity = "foreign-custody"; writeFileSync(recordFile(f.state), JSON.stringify(r)); }
  const finalGate = readFileSync(gateFile, "utf8"), finalOwner = readFileSync(recordFile(f.state), "utf8");
  writeFileSync(released, "");
  await until(() => {
    const r = readRecord(f.state);
    try { if (JSON.parse(readFileSync(`${before.requestFile}.result.json`, "utf8")).state === "rejected") return true; } catch { /* no refusal yet */ }
    return r.web.pid !== before.web.pid || r.runtimeHost.pid !== before.runtimeHost.pid;
  });
  let refusal;
  try { refusal = JSON.parse(readFileSync(`${before.requestFile}.result.json`, "utf8")); } catch { /* a stale dispatch produces no refusal */ }
  expect(refusal?.state).toBe("rejected");
  // The Viewer was asked again once the load check was over, with the request
  // already taken, and its answer decided the dispatch.
  expect(admissions().slice(0, 2)).toEqual(["request filed", "request taken"]);
  if (change === "new-work") expect(refusal.detail).toBe("The Viewer did not admit the relaunch after the launcher load check");
  expect(readFileSync(path.join(dir, "apply.json"), "utf8")).toBe(originalApply);
  expect(readFileSync(before.requestFile, "utf8")).toBe(originalRequest);
  expect(readFileSync(gateFile, "utf8")).toBe(finalGate); expect(readFileSync(recordFile(f.state), "utf8")).toBe(finalOwner);
  const after = readRecord(f.state);
  expect(after.web.pid).toBe(before.web.pid); expect(after.runtimeHost.pid).toBe(before.runtimeHost.pid);
  await perimeterRemains(running.port, key);
}, 30000);

test("a refused relaunch keeps both children through the Viewer's settlement and every later poll", async () => {
  const { ApplyController } = await import("../src/lib/selfUpdate/apply");
  const { beginRestartGate, restartGateFile } = await import("../src/lib/selfUpdate/restartGate");
  const fixture = install();
  const running = await start(fixture);
  const before = await until(() => { const r = readRecord(fixture.state); return r.web.state === "healthy" && r.runtimeHost.state === "healthy" ? r : null; });
  const candidate = release(fixture, "refused-relaunch");
  // Each load check announces itself and waits to be let through.
  const gate = path.join(fixture.root, "load"), entry = path.join(candidate.dir, "bin", "cli.mjs");
  writeFileSync(entry, `if (process.argv.includes("--version")) { const fs = await import("node:fs"); let attempt = 0; while (fs.existsSync(${JSON.stringify(gate)} + "-entered-" + attempt)) attempt++;
    fs.writeFileSync(${JSON.stringify(gate)} + "-entered-" + attempt, ""); while (!fs.existsSync(${JSON.stringify(gate)} + "-released-" + attempt)) await Bun.sleep(5); }\n`
    + readFileSync(entry, "utf8").replace(/^#![^\n]*\n/, ""));
  const dir = path.dirname(before.requestFile), apply = new ApplyController(dir);
  const trialFile = before.requestFile.replace("request-", "trial-"), receipt = `${before.requestFile}.result.json`;
  const gateId = beginRestartGate(restartGateFile(before.requestFile))!;
  apply.begin(before as never, candidate.sha, "auto", undefined, { autoGateId: gateId }); apply.patch({ state: "ready" });
  expect(existsSync(before.releasePointer)).toBe(false);
  writeFileSync(before.releasePointer, JSON.stringify({ ...candidate, checkoutHead: fixture.first }));
  apply.send(before as never, gateId);
  // Work the admission never saw starts during the first load check. The
  // Viewer files it in its database, and the launcher learns of it by asking
  // the Viewer again once the load check is over.
  await until(() => existsSync(`${gate}-entered-0`));
  writeFileSync(path.join(fixture.state, WORK_STARTED), "");
  writeFileSync(`${gate}-released-0`, "");
  await until(() => { try { return JSON.parse(readFileSync(receipt, "utf8")).detail === "The Viewer did not admit the relaunch after the launcher load check"; } catch { return false; } });
  expect(readFileSync(path.join(fixture.state, ADMISSION_LOG), "utf8").trim().split("\n").slice(0, 2)).toEqual(["request filed", "request taken"]);
  expect(readRecord(fixture.state).web.pid).toBe(before.web.pid); expect(readRecord(fixture.state).runtimeHost.pid).toBe(before.runtimeHost.pid);
  // That work ends, and the retained request is admitted to a second load check.
  rmSync(path.join(fixture.state, WORK_STARTED));
  await until(() => !existsSync(trialFile) || existsSync(`${gate}-entered-1`));
  // The request is offered again. The Viewer settles the refusal and restores
  // the pointer while that second load check is still running.
  await until(() => existsSync(`${gate}-entered-1`));
  expect(new ApplyController(dir).observe(readRecord(fixture.state) as never, true)).toBe("failed");
  expect(JSON.parse(readFileSync(path.join(dir, "apply.json"), "utf8"))).toMatchObject({ state: "failed", admissionRefused: true });
  expect(existsSync(before.releasePointer)).toBe(false);
  writeFileSync(`${gate}-released-1`, "");
  // Five polling intervals: a launcher that still owned a trial would roll it
  // back here, stopping the Viewer and the runtime host.
  await until(() => !existsSync(trialFile) && !existsSync(before.requestFile));
  await Bun.sleep(2_500);
  const after = readRecord(fixture.state);
  expect(after.launcher.pid).toBe(before.launcher.pid);
  expect(after.web.pid).toBe(before.web.pid); expect(after.runtimeHost.pid).toBe(before.runtimeHost.pid);
  expect(existsSync(`/proc/${before.web.pid}`)).toBe(true); expect(existsSync(`/proc/${before.runtimeHost.pid}`)).toBe(true);
  expect(after.web.state).toBe("healthy"); expect(after.runtimeHost.state).toBe("healthy");
  expect(after.launcher.error ?? null).toBeNull();
  expect(existsSync(trialFile)).toBe(false); expect(existsSync(before.requestFile)).toBe(false);
  expect(existsSync(before.releasePointer)).toBe(false);
  expect(existsSync(`${gate}-entered-2`)).toBe(false);
  expect(await served(running.port)).toBe(fixture.checkout);
  expect(running.child.exitCode).toBeNull();
}, 60_000);

test("journal traffic during the load check does not refuse a relaunch", async () => {
  const { ApplyController } = await import("../src/lib/selfUpdate/apply");
  const { beginRestartGate, restartGateFile } = await import("../src/lib/selfUpdate/restartGate");
  const fixture = install();
  const running = await start(fixture);
  const before = await until(() => { const r = readRecord(fixture.state); return r.web.state === "healthy" && r.runtimeHost.state === "healthy" ? r : null; });
  // A turn that is already running has its record in the state database and
  // its journal beside it.
  for (const name of ["runtime-events-fixture.sqlite", "state.sqlite"]) writeFileSync(path.join(fixture.state, name), "admitted");
  const candidate = release(fixture, "journal-traffic");
  const entered = path.join(fixture.root, "load-entered"), released = path.join(fixture.root, "load-released"), entry = path.join(candidate.dir, "bin", "cli.mjs");
  writeFileSync(entry, `if (process.argv.includes("--version")) { const fs = await import("node:fs"); fs.writeFileSync(${JSON.stringify(entered)}, ""); while (!fs.existsSync(${JSON.stringify(released)})) await Bun.sleep(5); }\n`
    + readFileSync(entry, "utf8").replace(/^#![^\n]*\n/, ""));
  const apply = new ApplyController(path.dirname(before.requestFile));
  const gateId = beginRestartGate(restartGateFile(before.requestFile))!;
  apply.begin(before as never, candidate.sha, "auto", undefined, { autoGateId: gateId }); apply.patch({ state: "ready" });
  writeFileSync(before.releasePointer, JSON.stringify({ ...candidate, checkoutHead: fixture.first }));
  apply.send(before as never, gateId);
  await until(() => existsSync(entered));
  // Every event of that turn moves these while the load check runs.
  for (const name of ["runtime-events-fixture.sqlite", "runtime-events-fixture.sqlite-wal", "state.sqlite", "state.sqlite-wal"]) writeFileSync(path.join(fixture.state, name), "event");
  writeFileSync(released, "");
  const after = await until(() => {
    const r = readRecord(fixture.state);
    return r.launcher.requestId === apply.current!.requestId && r.launcher.state === "healthy" && r.web.state === "healthy" && r.runtimeHost.state === "healthy"
      && r.web.revision === candidate.sha.slice(0, 7) && r.runtimeHost.revision === candidate.sha.slice(0, 7) ? r : null;
  });
  expect(JSON.parse(readFileSync(`${before.requestFile}.result.json`, "utf8"))).toMatchObject({ requestId: apply.current!.requestId, state: "done" });
  // The Viewer admitted the same work twice: before the request was taken,
  // and after the load check that the traffic ran through.
  expect(readFileSync(path.join(fixture.state, ADMISSION_LOG), "utf8").trim().split("\n")).toEqual(["request filed", "request taken"]);
  expect(after.launcher.pid).toBe(before.launcher.pid);
  expect(await served(running.port)).toBe(candidate.dir);
}, 60_000);

// The helper's protocol is the one-time upgrade of a launcher that predates
// relaunch, so the settled outcome needs that launcher: the rehearsal source.
for (const outcome of ["refused", "settled"] as const) (outcome === "refused" || legacySource ? test : test.skip)(`a service recovery plan names protected custody and holds no access key: ${outcome}`, async () => {
  const { SelfUpdateService } = await import("../src/lib/selfUpdate/service");
  const { readRevision } = await import("../src/lib/selfUpdate/git");
  const { readStartIdentity } = await import("../src/lib/selfUpdate/pid");
  const { idleUpdate } = await import("../src/lib/selfUpdate/types");
  const { runInstallAction, unitRunsLauncher } = await import("../src/lib/selfUpdate/actions");
  let f: ReturnType<typeof install>, candidate: ReturnType<typeof release>, key: string;
  if (outcome === "refused") ({ f, candidate, key } = await protectedInstall("checkout", "LLV_TOKEN"));
  else {
    f = install({ tokenProtected: true });
    for (const name of readdirSync(path.join(f.checkout, "bin"))) {
      const source = path.join(legacySource!, "bin", name); if (existsSync(source)) copyFileSync(source, path.join(f.checkout, "bin", name));
    }
    git(f.checkout, "add", "-f", "."); git(f.checkout, "commit", "-m", "legacy service fixture"); f.first = git(f.checkout, "rev-parse", "HEAD");
    candidate = release(install(), "recovery-candidate"); git(f.checkout, "fetch", candidate.dir, candidate.sha);
    key = randomBytes(16).toString("hex"); f.env.LLV_TOKEN = key;
  }
  // The serving Viewer answers the key it was given and nothing else.
  const gateHolds = async (port: number) => {
    if (outcome === "refused") return perimeterRemains(port, key);
    for (const [credential, status] of [[null, 401], ["wrong-synthetic-key", 401], [key, 200]] as const) {
      const response = await fetch(`http://127.0.0.1:${port}/`, { headers: credential ? { authorization: `Bearer ${credential}` } : {}, signal: AbortSignal.timeout(2000) });
      expect(response.status === status).toBe(true); await response.body?.cancel();
    }
  };
  const running = await start(f);
  const record = await until(() => { const r = readRecord(f.state); return r.web.state === "healthy" && r.runtimeHost.state === "healthy" ? r : null; });
  await gateHolds(running.port);
  // The candidate cannot load, so the action must restore the prior release.
  writeFileSync(path.join(candidate.dir, "bin", "cli.mjs"), 'throw new Error("fixture import failure");\n');
  writeFileSync(record.releasePointer, JSON.stringify({ ...candidate, checkoutHead: f.first }));
  const directory = path.dirname(record.requestFile);
  const planFile = path.join(directory, path.basename(record.requestFile).replace(/^request/, "recovery"));
  const custody = path.join(f.state, `launcher-custody-${path.basename(record.requestFile).slice("request-".length, -".json".length)}`);
  // The service manager restarts the unit under the unit's own environment.
  const managerDir = path.join(f.root, "manager"); mkdirSync(managerDir);
  const serviceEnv = path.join(f.root, "service-env.json"); writeFileSync(serviceEnv, JSON.stringify(f.env), { mode: 0o600 });
  writeFileSync(path.join(managerDir, "systemctl"), `#!${process.execPath} --bun
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
if (process.argv.includes("show")) { process.stdout.write(${JSON.stringify(serviceShown(f))}); process.exit(0); }
const bootstrapPid = ${JSON.stringify(running.child.pid)};
process.kill(bootstrapPid, "SIGTERM");
const deadline = Date.now() + 5000;
while (Date.now() < deadline) { try { process.kill(bootstrapPid, 0); } catch { break; } await Bun.sleep(25); }
const launcher = spawn(process.execPath, ["--bun", ${JSON.stringify(path.join(f.checkout, "bin", "cli.mjs"))}, "--no-open", "--port", ${JSON.stringify(String(running.port))}], { cwd: ${JSON.stringify(f.checkout)}, detached: true, stdio: "ignore", env: JSON.parse(readFileSync(${JSON.stringify(serviceEnv)}, "utf8")) });
writeFileSync(${JSON.stringify(path.join(managerDir, "launcher.pid"))}, String(launcher.pid));
launcher.unref();
`, { mode: 0o700 });
  let plan = "", helper: ReturnType<typeof spawn> | undefined, helperOutput = "";
  const runner = { state: idleUpdate(), start: async () => {}, retry: async () => {}, restore(state: ReturnType<typeof idleUpdate>) { this.state = state; }, logPath: () => "" };
  const service = new SelfUpdateService({
    now: () => Date.now(), env: f.env, dir: directory, remote: "https://example.invalid/project.git", branch: "main", pollMinutes: 60, bun: process.execPath,
    mode: async () => ({ mode: "checkout", reason: null, record: readRecord(f.state) as unknown as import("../src/lib/selfUpdate/launcher").LauncherRecord }),
    check: async () => ({ ok: false, error: "fixture", installed: null }), describe: readRevision,
    createRunner: () => runner, requestRestart: () => "unused", processAlive: (pid, identity) => readStartIdentity(pid) === identity, processIdentity: (pid) => readStartIdentity(pid),
    hostHealth: async () => { const r = readRecord(f.state); return await socketAnswers(r.socket) ? { pid: r.runtimeHost.pid!, startIdentity: readStartIdentity(r.runtimeHost.pid!)!, hostEpoch: 1 } : null; },
    requestDeployment: async () => { throw new Error("unused"); }, readDeployment: async () => null,
    findDeploymentByIdempotencyKey: async () => null, releaseTarget: () => null, prepareCheckRepo: async () => { throw new Error("unused"); },
    buildEnv: () => ({}), web: { pid: record.web.pid!, port: running.port, startedAt: "" },
    install: { action: () => ({ id: "restart-service", button: true, unit: "fixture.service" }), entry: () => path.join(f.checkout, "bin", "cli.mjs"), run: (action, recovery) => {
      if (!recovery) throw new Error("the candidate was never meant to start");
      plan = readFileSync(recovery.file, "utf8");
      if (outcome === "refused") throw new Error("the service manager refused the transient unit");
      runInstallAction(action, args => {
        // The transient unit has the manager's environment: no key, no state
        // directory, and a home outside the install.
        const command = args.slice(args.indexOf("--") + 1), env = cleanTerminalEnv(f);
        helper = spawn(command[0]!, command.slice(1), { cwd: f.checkout, env: { ...env, PATH: managerDir + path.delimiter + env.PATH }, stdio: ["ignore", "pipe", "pipe"] }); children.add(helper);
        helper.stderr?.on("data", chunk => { helperOutput += String(chunk); });
      }, recovery, { root: f.checkout }, (unit, root, pid) => unitRunsLauncher(unit, root, pid, { show: () => serviceShown(f) }));
    } },
  });
  try {
    const result = await service.performInstallAction();
    // The plan says where the credentials are held and holds none of them.
    for (const secret of [key, "probe.", "authorization", "Bearer", "x-llv-internal-service"]) expect(plan.includes(secret)).toBe(false);
    expect(JSON.parse(plan)).toMatchObject({ unit: "fixture.service", root: f.checkout, custody: true, requestFile: record.requestFile });
    expect(existsSync(planFile)).toBe(false);
    expect(result).toMatchObject({ ok: false, status: 503 });
    const intent = JSON.parse(readFileSync(path.join(directory, "apply.json"), "utf8"));
    if (outcome === "refused") {
      expect((result as { detail?: string; error?: string }).detail ?? (result as { error?: string }).error).toContain("not accepted");
      // The apply is still open, so its custody stays, private to this user.
      expect(intent.state).toBe("switching");
      expect(statSync(custody).mode & 0o077).toBe(0); expect(statSync(path.join(custody, "environment.json")).mode & 0o077).toBe(0);
      expect(readRecord(f.state).launcher.pid).toBe(record.launcher.pid);
    } else {
      // The helper proved the restarted Viewer's gate with the held key, from
      // an environment that carried none, and the settlement released it.
      expect(helperOutput).toBe(""); expect(helper?.exitCode).toBe(0);
      expect(intent).toMatchObject({ state: "failed", rolledBack: true });
      expect(existsSync(custody)).toBe(false);
      const settled = readRecord(f.state);
      expect(settled.launcher.pid).not.toBe(record.launcher.pid);
      expect(settled.web.revision).toBe(f.first.slice(0, 7)); expect(settled.runtimeHost.revision).toBe(f.first.slice(0, 7));
      expect(existsSync(record.releasePointer)).toBe(false);
    }
    await gateHolds(running.port);
    // Outside the protected custody directory no state file holds the key.
    const outside = readdirSync(f.state, { withFileTypes: true }).filter(entry => path.join(f.state, entry.name) !== custody)
      .map(entry => entry.isDirectory() ? stateText(path.join(f.state, entry.name)) : entry.isFile() ? readFileSync(path.join(f.state, entry.name), "utf8") : "").join("\n");
    expect(outside.includes(key)).toBe(false);
  } finally { service.stop(); await stopManagedLauncher(path.join(managerDir, "launcher.pid"), f.state); }
}, 120_000);

test("a recovery helper that cannot take its plan removes it", async () => {
  const fixture = install();
  const control = path.join(fixture.state, "self-update"); mkdirSync(control, { recursive: true });
  const planFile = path.join(control, "recovery-fixture.json");
  for (const plan of [{ requestId: "absent", requestFile: path.join(control, "request-fixture.json"), unit: "fixture.service", root: fixture.checkout, custody: false }, { unit: "not a unit" }, "not a plan"]) {
    writeFileSync(planFile, typeof plan === "string" ? plan : JSON.stringify(plan));
    const run = spawnSync(process.execPath, ["--bun", path.resolve("bin/launcher-relaunch.mjs"), "--recover-service", planFile], { env: cleanTerminalEnv(fixture), encoding: "utf8", timeout: 30_000 });
    expect(run.status).toBe(1);
    expect(existsSync(planFile)).toBe(false);
  }
});


for (const failurePhase of ["none", "files", "page", "chunk", "output", "journal"] as const) {
  test(`relaunch readiness persists phases across exec and rollback, failure=${failurePhase}`, async () => {
    const failed = failurePhase !== "none";
    const pageFails = failurePhase === "page" || failurePhase === "output" || failurePhase === "journal";
    const fixture = install();
    const running = await start(fixture);
    const before = await until(() => { const record = readRecord(fixture.state); return record.web.state === "healthy" ? record : null; });
    const next = release(fixture, "readiness-trial");
    const supervisor = path.join(next.dir, "bin", "self-update-supervisor.mjs");
    writeFileSync(supervisor, readFileSync(supervisor, "utf8")
      .replace("timeoutMs = 90_000, attemptTimeoutMs = 5_000", "timeoutMs = 1_000, attemptTimeoutMs = 200")
      .replace("timeoutMs = 5_000, headers = {}", "timeoutMs = 200, headers = {}"));
    const launcher = path.join(next.dir, "bin", "cli.mjs");
    writeFileSync(launcher, readFileSync(launcher, "utf8").replace("const RESTART_READINESS_TIMEOUT_MS = 90_000", "const RESTART_READINESS_TIMEOUT_MS = 1_000"));
    writeFileSync(path.join(next.dir, "node_modules", ".bin", "next"), `
      console.log("discarded startup prefix " + "x".repeat(70_000));
      console.log("▲ Next.js fixture startup line");
      console.error("candidate startup diagnostic");
      let pages = 0;
      const server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT ?? process.argv[process.argv.indexOf("--port") + 1]),
        fetch(request) {
          const pathname = new URL(request.url).pathname;
          if (pathname === "/api/files" && ${failurePhase === "files"}) return new Promise(() => {});
          if (pathname.startsWith("/_next/") && ${failurePhase === "chunk"}) return new Promise(() => {});
          if (pathname === "/") {
            pages += 1;
            if (${pageFails}) return new Promise(() => {});
            if (${!failed} && pages === 1) return new Promise(resolve => setTimeout(() => resolve(new Response("late page")), 600));
            return new Response('<script src="/_next/static/chunks/app.js"></script>');
          }
          return new Response("ready");
        }
      });
      process.on("SIGTERM", () => { server.stop(true); process.exit(0); });
    `);
    const outputFile = path.join(path.dirname(before.requestFile), path.basename(before.requestFile).replace("request-", "startup-output-"));
    const installId = path.basename(before.requestFile).slice("request-".length, -".json".length);
    const evidenceFile = path.join(path.dirname(before.requestFile), `readiness-${installId}.json`);
    if (failurePhase === "output") mkdirSync(outputFile);
    if (failurePhase === "journal") { rmSync(evidenceFile, { force: true }); mkdirSync(evidenceFile); }
    writeFileSync(before.releasePointer, JSON.stringify({ ...next, checkoutHead: fixture.first }));
    writeFileSync(before.requestFile, JSON.stringify({ requestId: "readiness-trial", role: "relaunch", target: next.sha, rollbackPointer: null }));
    const resultFile = `${before.requestFile}.result.json`;
    const result = await until(() => existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, "utf8")) : null, 15_000);
    expect(result.state).toBe(failed ? "rolled-back" : "done");
    let runs: Array<{ revision: string; status: string; elapsedMs: number; phases: Record<string, { attempts: number; elapsedMs: number; status: string }> }> = [];
    if (failurePhase === "journal") {
      expect(readRecord(fixture.state).web).toMatchObject({ state: "healthy", revision: fixture.first.slice(0, 7) });
      expect(statSync(evidenceFile).isDirectory()).toBe(true);
    } else {
      runs = JSON.parse(readFileSync(evidenceFile, "utf8")).runs;
      const candidate = runs.find((run: { revision: string }) => run.revision === next.sha)!;
      expect(candidate.status).toBe(failed ? "failed" : "ready");
      expect(candidate.phases.files.attempts).toBeGreaterThanOrEqual(1);
      expect(candidate.phases.files.status).toBe(failurePhase === "files" ? "failed" : "ready");
      if (failurePhase === "files") {
        expect(candidate.phases.page.attempts).toBe(0);
        expect(candidate.phases.page.status).toBe("pending");
      } else {
        expect(candidate.phases.page.attempts).toBeGreaterThanOrEqual(2);
        expect(candidate.phases.page.status).toBe(pageFails ? "failed" : "ready");
        expect(candidate.phases.page.elapsedMs).toBeGreaterThanOrEqual(200);
      }
      expect(candidate.phases.chunk.status).toBe(failurePhase === "none" ? "ready" : failurePhase === "chunk" ? "failed" : "pending");
      expect(statSync(evidenceFile).mode & 0o777).toBe(0o600);
    }
    if (failed) {
      if (failurePhase !== "journal") {
        expect(runs.at(-1)!.revision).toBe(fixture.first);
        expect(runs.at(-1)!.status).toBe("ready");
      }
      if (failurePhase === "output") {
        expect(running.output()).toContain("could not persist candidate startup output; continuing rollback");
      } else if (failurePhase !== "journal") {
        const output = JSON.parse(readFileSync(outputFile, "utf8"));
        expect(output.revision).toBe(next.sha);
        expect(output.stderr).toContain("candidate startup diagnostic");
        expect(output.stdout).toContain("▲ Next.js fixture startup line");
        expect(output.stdout).not.toContain("discarded startup prefix");
        expect(output.stdout.length).toBeLessThanOrEqual(32 * 1024);
        expect(output.stderr.length).toBeLessThanOrEqual(32 * 1024);
        expect(statSync(outputFile).mode & 0o777).toBe(0o600);
      }
    }
    expect(readRecord(fixture.state).launcher.pid).toBe(before.launcher.pid);
    expect(running.child.exitCode).toBeNull();
  }, 25_000);
}
