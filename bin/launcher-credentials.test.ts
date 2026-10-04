import { afterEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { installAction } from "../src/lib/selfUpdate/actions";
import type { LauncherRecord } from "../src/lib/selfUpdate/launcher";
import { isAlive } from "../src/lib/selfUpdate/pid";
import { readStartIdentity } from "./self-update-supervisor.mjs";
import { prepareLauncherCredentials } from "./launcher-credentials.mjs";
import { ApplyController } from "../src/lib/selfUpdate/apply";
import { resetWindowsSnapshotForTests, windowsBackend } from "../src/lib/proc/windows";

const fixtures: string[] = [];
const fixtureRoots = new Map<string, { tempRoot: string; dev: number; ino: number; label: string }>();
let cleanupCase: string | null = null;
const children = new Set<ReturnType<typeof spawn>>();
const owners = new Map<number, string>();
const terminalOwners = new Map<number, { startIdentity: string; role: string; fixtureCwd: boolean }>();
const ownedIdentity = (pid: number) => process.platform === "win32" ? windowsBackend.processIdentity(pid) : readStartIdentity(pid);
function cleanupEvidence(event: string, facts: Record<string, unknown> = {}) {
  if (process.platform === "win32") console.error("[custody-cleanup]", JSON.stringify({ event, case: cleanupCase, ...facts }));
}
function assertFixtureRoot(root: string) {
  const held = fixtureRoots.get(root);
  if (!held || path.dirname(root) !== held.tempRoot || !path.basename(root).startsWith("dlg-custody-")) throw new Error("Removal requires this test's own temp fixture");
  const current = lstatSync(root);
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== held.dev || current.ino !== held.ino
    || realpathSync(root) !== root || realpathSync(path.dirname(root)) !== held.tempRoot) throw new Error("Removal fixture identity changed");
}
function track(child: ReturnType<typeof spawn>) {
  children.add(child);
  if (child.pid) { const identity = ownedIdentity(child.pid); if (identity) owners.set(child.pid, identity); }
}
function observeTerminal(child: ReturnType<typeof spawn>, root: string) {
  if (process.platform !== "win32" || !child.pid) return;
  const shellIdentity = owners.get(child.pid);
  if (!shellIdentity || ownedIdentity(child.pid) !== shellIdentity) return;
  resetWindowsSnapshotForTests();
  const parents = windowsBackend.ppidMap();
  // Enroll only the bootstrap directly spawned by our identity-verified shell.
  // The snapshot filters stale parent links using both creation times.
  for (const [pid, parent] of parents) {
    if (parent !== child.pid) continue;
    const argv = windowsBackend.readArgv(pid);
    if (!argv.includes("--terminal") || !argv.some(arg => /[/\\]launcher-relaunch\.mjs$/.test(arg))) continue;
    const identity = ownedIdentity(pid), cwd = windowsBackend.readCwd(pid);
    if (!identity || ownedIdentity(child.pid) !== shellIdentity || ownedIdentity(pid) !== identity) continue;
    const relative = cwd === null ? null : path.relative(root, cwd);
    const fixtureCwd = relative !== null && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
    owners.set(pid, identity); terminalOwners.set(pid, { startIdentity: identity, role: "terminal-bootstrap", fixtureCwd });
    cleanupEvidence("terminal-owner-observed", { pid, startIdentity: identity, shellPid: child.pid, shellStartIdentity: shellIdentity, fixtureCwd, alive: isAlive(pid) });
  }
}
function ownerExited(pid: number, identity: string) {
  if (!isAlive(pid)) return true;
  const current = ownedIdentity(pid);
  return current !== null && current !== identity; // Reuse also proves our process exited.
}
function assertOwnersExited() {
  for (const [pid, identity] of owners) if (!ownerExited(pid, identity)) throw new Error("Fixture owner is still running before removal");
}
async function removeFixture(root: string, ports: {
  remove?: (root: string) => Promise<void>;
  sleep?: (ms: number) => Promise<unknown>;
  retry?: boolean;
} = {}) {
  const limit = (ports.retry ?? process.platform === "win32") ? 6 : 0;
  const remove = ports.remove ?? (root => rm(root, { force: true, recursive: true }));
  const sleep = ports.sleep ?? (ms => Bun.sleep(ms));
  for (let attempt = 0; ; attempt++) {
    assertOwnersExited();
    assertFixtureRoot(root);
    try { await remove(root); return { attempts: attempt + 1, waitedMs: attempt * 350 }; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (attempt === limit || code !== "EBUSY" && code !== "EPERM") throw error;
      cleanupEvidence("removal-retry", { attempt: attempt + 1, code, delayMs: 350 });
      await sleep(350);
    }
  }
}
async function stop(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (!child.pid || owners.get(child.pid) !== ownedIdentity(child.pid)) throw new Error("Owned child identity could not be verified");
  const exited = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM");
  await Promise.race([exited, Bun.sleep(3000)]);
  if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
}
afterEach(async () => {
  cleanupEvidence("teardown-start", { terminalOwners: [...terminalOwners].map(([pid, record]) => ({ pid, ...record, exited: ownerExited(pid, record.startIdentity) })) });
  for (const child of children) await stop(child);
  children.clear();
  for (const [pid, identity] of owners) {
    if (ownerExited(pid, identity)) { cleanupEvidence("owner-exited", { pid, startIdentity: identity }); continue; }
    if (ownedIdentity(pid) !== identity) throw new Error("Fixture owner identity could not be verified");
    try { process.kill(pid, "SIGTERM"); } catch { continue; }
    const deadline = Date.now() + 3000;
    while (!ownerExited(pid, identity) && Date.now() < deadline) await Bun.sleep(50);
    if (!ownerExited(pid, identity) && ownedIdentity(pid) === identity) { try { process.kill(pid, "SIGKILL"); } catch { /* exited */ } }
    await until(() => ownerExited(pid, identity) ? true : null, 3000);
    cleanupEvidence("owner-exited", { pid, startIdentity: identity });
  }
  assertOwnersExited();
  cleanupEvidence("all-owners-exited-before-remove");
  for (const root of fixtures) {
    assertFixtureRoot(root);
    // Only verified, exited owners admit this bounded NTFS handle-release
    // retry. Exhaustion rejects the hook; no permission or ACL is repaired.
    const started = Date.now();
    let result;
    try { result = await removeFixture(root); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      cleanupEvidence("removal-refused", { elapsedMs: Date.now() - started, code: code ?? "non-filesystem-error" });
      throw error;
    }
    if (existsSync(root)) throw new Error("Fixture removal did not complete");
    cleanupEvidence("fixture-removed", { case: fixtureRoots.get(root)!.label, elapsedMs: Date.now() - started, ...result, maxRetries: process.platform === "win32" ? 6 : 0, retryDelayMs: 350 });
    fixtureRoots.delete(root);
  }
  fixtures.length = 0;
  owners.clear();
  terminalOwners.clear();
  cleanupCase = null;
}, 30000);
async function until<T>(read: () => T | false | null, budget = 30000): Promise<T> {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) { const value = read(); if (value) return value; await Bun.sleep(50); }
  throw new Error("Private handoff did not settle");
}
async function fixture(alias: "LLV_TOKEN" | "DELEGATUS_TOKEN" = "LLV_TOKEN", label = "custody-fixture") {
  cleanupCase = label;
  if (process.platform === "win32" && !ownedIdentity(process.pid)) throw new Error("Native kernel identity reader is unavailable");
  const tempRoot = realpathSync(process.platform === "win32" ? tmpdir() : "/var/tmp");
  const root = realpathSync(mkdtempSync(path.join(tempRoot, "dlg-custody-"))); fixtures.push(root);
  const created = lstatSync(root);
  fixtureRoots.set(root, { tempRoot, dev: created.dev, ino: created.ino, label });
  const base = path.join(root, "package"), candidate = path.join(root, "candidate"), state = path.join(root, "state");
  mkdirSync(state);
  const gate = await Bun.build({ entrypoints: [path.resolve("src/proxy.ts")], target: "bun", external: ["next/server"] });
  if (!gate.success) throw new Error("Could not compile production perimeter");
  for (const [directory, version] of [[base, "0.0.0"], [candidate, "0.0.1"]]) {
    mkdirSync(path.join(directory!, "bin"), { recursive: true }); mkdirSync(path.join(directory!, "dist/standalone"), { recursive: true });
    mkdirSync(path.join(directory!, "node_modules")); symlinkSync(path.resolve("node_modules/next"), path.join(directory!, "node_modules/next"), process.platform === "win32" ? "junction" : "dir");
    for (const file of readdirSync("bin").filter(file => file.endsWith(".mjs"))) copyFileSync(path.resolve("bin", file), path.join(directory!, "bin", file));
    writeFileSync(path.join(directory!, "package.json"), JSON.stringify({ type: "module", version }));
    writeFileSync(path.join(directory!, "dist/perimeter.mjs"), await gate.outputs[0]!.text());
    writeFileSync(path.join(directory!, "dist/standalone/server.js"), `
      import { proxy } from "../perimeter.mjs";
      import { NextRequest } from "next/server";
      const server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT), fetch(request) {
        const result = proxy(new NextRequest(request));
        return result.headers.get("x-middleware-next") === "1" ? new Response("synthetic route") : result;
      } });
      process.on("SIGTERM", () => { server.stop(true); process.exit(0); });
    `);
    writeFileSync(path.join(directory!, "dist/runtime-host.mjs"), `
      import net from "node:net";
      import { writeFileSync, rmSync } from "node:fs";
      import { readStartIdentity, runtimeHostStartIdentity } from "../bin/self-update-supervisor.mjs";
      if (process.platform !== "win32") rmSync(process.env.LLV_RUNTIME_HOST_SOCKET, { force: true });
      const server = net.createServer(socket => {
        socket.on("error", () => {}); socket.on("data", bytes => {
          const request = JSON.parse(String(bytes));
          socket.end(JSON.stringify({ id: request.id, ok: true, result: { pid: process.pid, startIdentity: readStartIdentity(process.pid), hostEpoch: 1 } }) + "\\n");
        });
      });
      writeFileSync(process.env.LLV_RUNTIME_HOST_FENCE, JSON.stringify({ pid: process.pid, startIdentity: runtimeHostStartIdentity(process.pid), acquisitionId: "fixture-acquisition" }));
      server.listen(process.env.LLV_RUNTIME_HOST_SOCKET);
      process.on("SIGTERM", () => server.close(() => { rmSync(process.env.LLV_RUNTIME_HOST_FENCE, { force: true }); process.exit(0); }));
    `);
  }
  const key = randomBytes(32).toString("hex");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"), LLV_STATE_DIR: state, XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_CACHE_HOME: path.join(root, "cache"), LLV_BUN_EXECUTABLE: process.execPath, TMPDIR: root, TMP: root, TEMP: root };
  delete env.LLV_TOKEN; delete env.DELEGATUS_TOKEN; env[alias] = key;
  if (alias === "DELEGATUS_TOKEN") env.LLV_TOKEN = randomBytes(32).toString("hex");
  const id = createHash("sha256").update(path.resolve(base)).digest("hex").slice(0, 16);
  const directory = path.join(state, `launcher-custody-${id}`);
  const clean = { ...env }; delete clean.LLV_TOKEN; delete clean.DELEGATUS_TOKEN;
  const recordFile = path.join(state, "self-update", `launcher-${id}.json`);
  const readRecord = (): LauncherRecord | null => {
    try {
      const record = JSON.parse(readFileSync(recordFile, "utf8")) as LauncherRecord;
      for (const entry of [record.launcher, record.web, record.runtimeHost]) if (entry.pid && entry.startIdentity) owners.set(entry.pid, entry.startIdentity);
      return record;
    } catch { return null; }
  };
  return { root, base, candidate, state, env, clean, key, directory, readRecord };
}
async function gateIntact(port: number, key: string) {
  for (const route of ["/api/files", "/api/runtime/deployments", "/api/mcp"]) for (const [credential, status] of [[undefined, 403], ["synthetic-wrong-key", 403], [key, 200]] as const) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { headers: credential ? { authorization: `Bearer ${credential}` } : {}, signal: AbortSignal.timeout(2000) });
    expect(response.status === status).toBe(true); expect((await response.text()).includes(key)).toBe(false);
  }
}
for (const alias of ["LLV_TOKEN", "DELEGATUS_TOKEN"] as const) for (const actionId of ["start-launcher", "restart-terminal"] as const)
for (const rollback of [false, true]) test(`native protected terminal gate ${alias}/${actionId}, rollback=${rollback}`, async () => {
  const f = await fixture(alias, `transition/${alias}/${actionId}/rollback=${rollback}`);
  const listener = net.createServer(); await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as net.AddressInfo).port; await new Promise<void>(resolve => listener.close(() => resolve()));
  const old = spawn(process.execPath, ["--bun", path.join(f.base, "bin/cli.mjs"), "--port", String(port), "--no-open"], { cwd: f.base, env: f.env, stdio: "ignore" }); track(old);
  const before = await until(() => { const r = f.readRecord(); return r?.web.state === "healthy" && r.runtimeHost.state === "healthy" ? r : null; });
  await gateIntact(port, f.key);
  const target = "b".repeat(40);
  const apply = new ApplyController(path.dirname(before.requestFile));
  // restart-terminal runs the real trial/rollback path on native Windows.
  if (actionId === "restart-terminal" || rollback) { apply.begin(before, target, "operator"); apply.patch({ state: "ready" }); }
  if (rollback) writeFileSync(path.join(f.candidate, "bin/cli.mjs"), 'throw new Error("synthetic load failure");\n');
  writeFileSync(before.releasePointer, JSON.stringify({ kind: "package", sha: target, dir: f.candidate, baseVersion: "0.0.0", version: "0.0.1" }));
  const action = await installAction(actionId === "restart-terminal" || rollback ? { mode: "package", reason: null, record: { ...before, launcher: { ...before.launcher, relaunch: undefined } } }
    : { mode: "unsupported", reason: "no-launcher", record: null, installRoot: f.base }, { cgroup: () => "", ready: () => true, env: { ...f.env, PORT: String(port) }, argv: () => [] });
  expect(action?.id).toBe(rollback ? "restart-terminal" : actionId); expect(Boolean(action?.command?.includes(f.key))).toBe(false);
  await stop(old);
  // On Windows the recorded children can outlive termination of their parent.
  for (const entry of [before.web, before.runtimeHost]) if (entry.pid && entry.startIdentity && isAlive(entry.pid) && readStartIdentity(entry.pid) === entry.startIdentity) {
    process.kill(entry.pid, "SIGTERM"); await until(() => !isAlive(entry.pid!) ? true : null);
  }
  const child = process.platform === "win32"
    ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", action!.command!], { cwd: f.base, env: f.clean, stdio: ["ignore", "pipe", "pipe"] })
    : spawn("sh", ["-c", `exec ${action!.command!}`], { cwd: f.base, env: f.clean, stdio: ["ignore", "pipe", "pipe"] }); track(child);
  let output = ""; child.stdout!.on("data", data => output += data); child.stderr!.on("data", data => output += data);
  let after = await until(() => { const r = f.readRecord(); return r?.launcher.pid !== before.launcher.pid && r?.web.state === "healthy" && r.runtimeHost.state === "healthy" ? r : null; });
  await gateIntact(port, f.key);
  // The bootstrap still verifies health after the record becomes healthy.
  // Let the tracked terminal command finish before teardown can stop its
  // launcher and leave the bootstrap holding the fixture's Windows cwd.
  if (action?.id === "restart-terminal") {
    observeTerminal(child, f.root);
    await until(() => child.exitCode !== null ? true : null);
    expect(child.exitCode).toBe(rollback ? 1 : 0);
    cleanupEvidence("terminal-command-complete", { pid: child.pid, startIdentity: child.pid ? owners.get(child.pid) : null, exit: child.exitCode,
      terminalOwners: [...terminalOwners].map(([pid, record]) => ({ pid, ...record, exited: ownerExited(pid, record.startIdentity) })) });
  }
  if (actionId === "start-launcher" && rollback) {
    // A failed real terminal trial is already rolled back. Cold recovery via
    // start-launcher must still read that exact credential in a clean shell.
    for (const entry of [after.launcher, after.web, after.runtimeHost]) if (entry.pid && entry.startIdentity && isAlive(entry.pid) && readStartIdentity(entry.pid) === entry.startIdentity) {
      process.kill(entry.pid, "SIGTERM"); await until(() => !isAlive(entry.pid!) ? true : null);
    }
    const recovery = await installAction({ mode: "unsupported", reason: "no-launcher", record: null, installRoot: f.base },
      { cgroup: () => "", ready: () => false, env: { ...f.env, PORT: String(port) } });
    expect(recovery?.id).toBe("start-launcher");
    const recovered = process.platform === "win32"
      ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", recovery!.command!], { cwd: f.base, env: f.clean, stdio: ["ignore", "pipe", "pipe"] })
      : spawn("sh", ["-c", `exec ${recovery!.command!}`], { cwd: f.base, env: f.clean, stdio: ["ignore", "pipe", "pipe"] }); track(recovered);
    recovered.stdout!.on("data", data => output += data); recovered.stderr!.on("data", data => output += data);
    const priorPid = after.launcher.pid;
    after = await until(() => { const r = f.readRecord(); return r?.launcher.pid !== priorPid && r?.web.state === "healthy" && r.runtimeHost.state === "healthy" ? r : null; });
    await gateIntact(port, f.key);
  }
  expect(after.socket).toBe(before.socket); expect(after.releasePointer).toBe(before.releasePointer);
  expect(after.web.revision).toBe(rollback ? null : target.slice(0, 7)); expect(after.runtimeHost.revision).toBe(after.web.revision);
  expect(output.includes(f.key)).toBe(false);
  if (process.platform !== "win32") {
    expect(statSync(f.directory).mode & 0o077).toBe(0); expect(statSync(path.join(f.directory, "environment.json")).mode & 0o077).toBe(0);
    for (const entry of [after.launcher, after.web, after.runtimeHost]) expect(readFileSync(`/proc/${entry.pid}/cmdline`, "utf8").includes(f.key)).toBe(false);
  } else {
    // Read native argv without printing it or passing a secret to PowerShell.
    const script = "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | Where-Object { @(" + [after.launcher.pid, after.web.pid, after.runtimeHost.pid].join(",") + ") -contains $_.ProcessId } | ForEach-Object { [Console]::WriteLine($_.CommandLine) }";
    const observed = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { env: windowsPowerShellEnv(), encoding: "utf8", timeout: 10000 });
    expect(observed.status).toBe(0); expect(observed.stdout.includes(f.key)).toBe(false); expect(observed.stderr.includes(f.key)).toBe(false);
  }
  cleanupEvidence("body-complete", { alias, actionId, rollback, assertionsCompleted: true });
}, 120000);

function windowsPowerShellEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const name of Object.keys(env)) if (name.toUpperCase() === "PSMODULEPATH") delete env[name];
  return env;
}
function alterAcl(file: string, right: "Read" | "Write") {
  const script = String.raw`$ErrorActionPreference='Stop'; try { $p=$env:DELEGATUS_TEST_CUSTODY_PATH; $a=Get-Acl -LiteralPath $p; $sid=New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0'); $r=New-Object System.Security.AccessControl.FileSystemAccessRule($sid, '` + right + String.raw`', 'Allow'); $a.AddAccessRule($r); Set-Acl -LiteralPath $p -AclObject $a; exit 0 } catch { exit 1 }`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { env: windowsPowerShellEnv({ DELEGATUS_TEST_CUSTODY_PATH: file }), stdio: "ignore", timeout: 10000 });
  expect(result.status).toBe(0);
}
for (const unsafe of ["readable", "writable", "directory", "link", "foreign-identity", "stale-key"] as const) test(`native private custody refuses ${unsafe} before reading its credential`, async () => {
  const f = await fixture("LLV_TOKEN", `unsafe/${unsafe}`);
  const listener = net.createServer(); await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as net.AddressInfo).port; await new Promise<void>(resolve => listener.close(() => resolve()));
  const old = spawn(process.execPath, ["--bun", path.join(f.base, "bin/cli.mjs"), "--port", String(port), "--no-open"], { cwd: f.base, env: f.env, stdio: "ignore" }); track(old);
  const before = await until(() => { const r = f.readRecord(); return r?.web.state === "healthy" && r.runtimeHost.state === "healthy" ? r : null; });
  expect(prepareLauncherCredentials(f.base, f.env)).toBe(true);
  const file = path.join(f.directory, "environment.json"), receipt = path.join(f.root, "credential-read");
  if (unsafe === "readable" || unsafe === "writable" || unsafe === "directory") {
    const target = unsafe === "directory" ? f.directory : file;
    if (process.platform === "win32") alterAcl(target, unsafe === "writable" ? "Write" : "Read");
    else chmodSync(target, unsafe === "directory" ? 0o755 : unsafe === "writable" ? 0o620 : 0o640);
  } else if (unsafe === "link") {
    renameSync(f.directory, f.directory + "-saved"); symlinkSync(f.directory + "-saved", f.directory, process.platform === "win32" ? "junction" : "dir");
  } else if (unsafe === "foreign-identity") {
    const identity = path.join(f.directory, "identity.json");
    const record = JSON.parse(readFileSync(identity, "utf8")); record.installRoot = path.join(f.root, "foreign-install"); writeFileSync(identity, JSON.stringify(record));
  }
  const preload = path.join(f.root, "read-observer.mjs");
  writeFileSync(preload, `
    import fs from "node:fs"; import { mock } from "bun:test";
    const descriptors = new Set();
    mock.module("node:fs", () => ({ ...fs, default: fs,
      openSync(file, ...args) { const fd = fs.openSync(file, ...args); if (String(file).endsWith("environment.json")) descriptors.add(fd); return fd; },
      readFileSync(file, ...args) { if (descriptors.has(file) || String(file).endsWith("environment.json")) fs.writeFileSync(${JSON.stringify(receipt)}, "read"); return fs.readFileSync(file, ...args); }
    }));
  `);
  const producer = path.join(f.root, "refusing-producer.mjs");
  if (unsafe === "stale-key") writeFileSync(producer, `
    import { prepareLauncherCredentials } from "./package/bin/launcher-credentials.mjs";
    import { randomBytes } from "node:crypto";
    import { fileURLToPath } from "node:url";
    try { prepareLauncherCredentials(fileURLToPath(new URL("./package", import.meta.url)), { ...process.env, LLV_TOKEN: randomBytes(32).toString("hex") }); }
    catch (error) { console.error(error.message); process.exit(1); }
  `);
  const run = spawnSync(process.execPath, ["--bun", "--preload", preload, unsafe === "stale-key" ? producer : path.join(f.base, "bin/cli.mjs"), "--version"], { cwd: f.base, env: { ...f.clean, LLV_LAUNCHER_CREDENTIAL_HANDOFF: "1" }, encoding: "utf8", timeout: 30000 });
  expect(run.status).toBe(1); expect(run.stderr.includes("Protected launcher handoff is unavailable")).toBe(true);
  expect(existsSync(receipt)).toBe(false); expect((run.stdout + run.stderr).includes(f.key)).toBe(false);
  const action = await installAction({ mode: "unsupported", reason: "no-launcher", record: null, installRoot: f.base }, { cgroup: () => "", ready: () => false, env: unsafe === "stale-key" ? { ...f.env, LLV_TOKEN: randomBytes(32).toString("hex") } : f.env });
  expect(action).toEqual({ id: "secure-handoff", button: false });
  await gateIntact(port, f.key); expect(f.readRecord()?.launcher.pid).toBe(before.launcher.pid);
}, 120000);

test("custody survives an incompatible inherited PowerShell module path", async () => {
  const f = await fixture("LLV_TOKEN", "module-path");
  assertFixtureRoot(f.root);
  expect(() => assertFixtureRoot(f.base)).toThrow("Removal requires this test's own temp fixture");
  expect(() => assertFixtureRoot(process.cwd())).toThrow("Removal requires this test's own temp fixture");
  const modules = path.join(f.root, "incompatible-modules"), security = path.join(modules, "Microsoft.PowerShell.Security");
  mkdirSync(security, { recursive: true });
  // A module that Windows PowerShell cannot import makes the old child
  // environment fail before it can establish the private NTFS DACL.
  writeFileSync(path.join(security, "Microsoft.PowerShell.Security.psd1"), "@{ RootModule='reject.psm1'; ModuleVersion='99.0.0'; PowerShellVersion='99.0' }\n");
  writeFileSync(path.join(security, "reject.psm1"), "throw 'Incompatible fixture module'\n");
  const entry = path.join(f.root, "prepare-and-restore.mjs");
  writeFileSync(entry, `
    import { prepareLauncherCredentials, restoreLauncherCredentials } from "./package/bin/launcher-credentials.mjs";
    import { fileURLToPath } from "node:url";
    const root = fileURLToPath(new URL("./package", import.meta.url));
    const env = { ...process.env };
    if (!prepareLauncherCredentials(root, env)) throw new Error("Credential preparation refused");
    delete env.LLV_TOKEN; delete env.DELEGATUS_TOKEN;
    restoreLauncherCredentials(root, env);
    if (env.LLV_TOKEN !== process.env.LLV_TOKEN) throw new Error("Credential restoration disagreed");
  `);
  const run = spawnSync(process.execPath, ["--bun", entry], { env: { ...f.env, PSModulePath: modules }, encoding: "utf8", timeout: 30000 });
  expect(run.status).toBe(0); expect((run.stdout + run.stderr).includes(f.key)).toBe(false);
  if (process.platform === "win32") {
    const script = String.raw`$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $p=$env:DELEGATUS_TEST_CUSTODY_PATH; foreach ($file in @($p, (Join-Path $p 'identity.json'), (Join-Path $p 'environment.json'))) {
      $item=Get-Item -LiteralPath $file -Force; $acl=Get-Acl -LiteralPath $file; $rules=$acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]);
      @{ ownerMatchesCurrentUser=($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -eq $sid.Value); protected=$acl.AreAccessRulesProtected; reparse=(($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0); onlyCurrentUser=($rules.Count -eq 1 -and $rules[0].IdentityReference.Value -eq $sid.Value -and $rules[0].AccessControlType -eq 'Allow' -and $rules[0].FileSystemRights -eq 'FullControl') } | ConvertTo-Json -Compress
    }`;
    const acl = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      env: windowsPowerShellEnv({ DELEGATUS_TEST_CUSTODY_PATH: f.directory }), encoding: "utf8", timeout: 10000,
    });
    expect(acl.status).toBe(0); expect((acl.stdout + acl.stderr).includes(f.key)).toBe(false);
    const facts = acl.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
    expect(facts).toHaveLength(3);
    for (const fact of facts) expect(fact).toEqual({ ownerMatchesCurrentUser: true, protected: true, reparse: false, onlyCurrentUser: true });
  }
}, 120000);

test("native custody refuses a launcher with an incompatible credential reader", async () => {
  const f = await fixture("LLV_TOKEN", "incompatible-reader");
  expect(prepareLauncherCredentials(f.base, f.env)).toBe(true);
  writeFileSync(path.join(f.base, "bin/cli.mjs"), "// Prior launcher without a protected credential reader\n");
  const action = await installAction({ mode: "unsupported", reason: "no-launcher", record: null, installRoot: f.base }, { cgroup: () => "", ready: () => false, env: f.env });
  expect(action).toEqual({ id: "secure-handoff", button: false });
}, 120000);

test("fixture cleanup control awaits its bounded retry and preserves hard failures", async () => {
  const f = await fixture("LLV_TOKEN", "cleanup-controls");
  for (const [code, failures] of [["EBUSY", 2], ["EPERM", 1], ["EBUSY", Infinity], ["EPERM", Infinity], ["EACCES", Infinity]] as const) {
    let attempts = 0, complete = false;
    const delays: number[] = [], release: (() => void)[] = [];
    let lastError: NodeJS.ErrnoException | undefined;
    const run = removeFixture(f.root, {
      retry: true,
      remove: async () => {
        attempts++;
        if (attempts <= failures) { lastError = Object.assign(new Error("Synthetic cleanup control"), { code }); throw lastError; }
      },
      sleep: ms => { delays.push(ms); return new Promise<void>(resolve => release.push(resolve)); },
    }).then(value => { complete = true; return { value, error: undefined }; }, error => { complete = true; return { value: undefined, error }; });
    const waits = code === "EACCES" ? 0 : Math.min(failures, 6);
    for (let index = 0; index < waits; index++) {
      await until(() => delays.length === index + 1 ? true : null, 1000);
      expect(attempts).toBe(index + 1); expect(complete).toBe(false); expect(delays[index]).toBe(350);
      // An unresolved sleep must prevent another attempt, even after a turn
      // of the real event loop. Merely scheduling a delay cannot pass this.
      await Bun.sleep(0); expect(attempts).toBe(index + 1); expect(complete).toBe(false);
      release[index]!();
    }
    const outcome = await run;
    expect(attempts).toBe(code === "EACCES" ? 1 : Math.min(failures + 1, 7));
    expect(delays).toEqual(Array(waits).fill(350));
    if (Number.isFinite(failures)) expect(outcome.value).toEqual({ attempts: failures + 1, waitedMs: failures * 350 });
    else { expect(outcome.error).toBe(lastError); expect(outcome.value).toBeUndefined(); }
  }
}, 30000);
