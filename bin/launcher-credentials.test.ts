import { afterEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { installAction } from "../src/lib/selfUpdate/actions";
import type { LauncherRecord } from "../src/lib/selfUpdate/launcher";
import { isAlive } from "../src/lib/selfUpdate/pid";
import { readStartIdentity } from "./self-update-supervisor.mjs";
import { prepareLauncherCredentials } from "./launcher-credentials.mjs";
import { ApplyController } from "../src/lib/selfUpdate/apply";

const fixtures: string[] = [];
const children = new Set<ReturnType<typeof spawn>>();
const owners = new Map<number, string>();
async function stop(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM");
  await Promise.race([exited, Bun.sleep(3000)]);
  if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
}
afterEach(async () => {
  for (const child of children) await stop(child); children.clear();
  for (const [pid, identity] of owners) {
    if (!isAlive(pid) || readStartIdentity(pid) !== identity) continue;
    try { process.kill(pid, "SIGTERM"); } catch { continue; }
    const deadline = Date.now() + 3000;
    while (isAlive(pid) && Date.now() < deadline) await Bun.sleep(50);
    if (isAlive(pid) && readStartIdentity(pid) === identity) { try { process.kill(pid, "SIGKILL"); } catch { /* exited */ } }
  }
  owners.clear();
  for (const root of fixtures) rmSync(root, { force: true, recursive: true }); fixtures.length = 0;
}, 30000);
async function until<T>(read: () => T | false | null, budget = 30000): Promise<T> {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) { const value = read(); if (value) return value; await Bun.sleep(50); }
  throw new Error("Private handoff did not settle");
}
async function fixture(alias: "LLV_TOKEN" | "DELEGATUS_TOKEN" = "LLV_TOKEN") {
  const root = mkdtempSync(path.join(process.platform === "win32" ? tmpdir() : "/var/tmp", "dlg-custody-")); fixtures.push(root);
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
// Failure-only observation. Never log records, commands, environment values,
// credential digests or Windows account identifiers. Replay the exact ACL
// program on a separate empty directory, leaving the failed custody untouched.
function custodyFailure(f: Awaited<ReturnType<typeof fixture>>, action = "prepare-refused") {
  if (process.platform !== "win32") return;
  const safe = (value: string) => {
    for (const secret of [f.key, f.env.LLV_TOKEN, f.env.DELEGATUS_TOKEN]) if (secret) value = value.replaceAll(secret, "[credential]");
    for (const root of [f.root, process.cwd(), process.env.USERPROFILE, process.env.HOME, process.env.RUNNER_TEMP]) if (root) value = value.replaceAll(root, "[fixture-root]");
    return value.replace(/S-1-[\d-]+/g, "[sid]").slice(0, 3072);
  };
  const snapshot = String.raw`
function Snapshot {
  try {
    $s = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $i = Get-Item -LiteralPath $env:DELEGATUS_CUSTODY_PATH -Force
    $a = Get-Acl -LiteralPath $env:DELEGATUS_CUSTODY_PATH
    $r = @($a.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
      $principal = if ($_.IdentityReference.Value -eq $s.Value) { 'current-user' } elseif ($_.IdentityReference.Value -eq 'S-1-5-18') { 'system' } elseif ($_.IdentityReference.Value -eq 'S-1-5-32-544') { 'administrators' } elseif ($_.IdentityReference.Value -eq 'S-1-1-0') { 'everyone' } else { 'other' }
      @{ currentUser=($principal -eq 'current-user'); system=($principal -eq 'system'); administrators=($principal -eq 'administrators'); everyone=($principal -eq 'everyone'); other=($principal -eq 'other'); fullControl=($_.FileSystemRights -eq 'FullControl'); allow=($_.AccessControlType -eq 'Allow'); inherited=$_.IsInherited }
    })
    @{ ownerMatchesCurrentSid=($a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -eq $s.Value); protected=$a.AreAccessRulesProtected; reparse=(($i.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0); rules=$r } | ConvertTo-Json -Compress -Depth 4
  } catch { 'snapshot-unavailable' }
}
`;
  const original = /const ACL_SCRIPT = String.raw`([\s\S]*?)`;/m.exec(readFileSync("bin/launcher-credentials.mjs", "utf8"))![1]!;
  const traced = original.replace(/^(\s*)(\$item =|if \(\$item.PSIsContainer|\$acl\.SetOwner|\$acl\.SetAccessRuleProtection|\$acl\.AddAccessRule|Set-Acl|\$acl = Get-Acl|\$rules =|if \(!\$acl|if \(\$rules.Count)/gm,
    (line, space: string, operation: string) => `${space}$stage = '${operation.replaceAll("'", "")}';\n${line}`)
    .replace("else { $acl =", "else { $stage = 'new-file-security'; $acl =")
    .replace("exit 0", "Snapshot; exit 0")
    .replace("} catch { exit 1 }", "} catch { @{ stage=$stage; error=$_.Exception.Message; errorType=$_.Exception.GetType().Name } | ConvertTo-Json -Compress; Snapshot; exit 1 }");
  const replay = path.join(f.root, "acl-replay"), isolated = path.join(f.root, "acl-isolated-replay"); mkdirSync(replay); mkdirSync(isolated);
  const moduleProbe = String.raw`
$ErrorActionPreference = 'Stop'
@{ shellMajor=$PSVersionTable.PSVersion.Major; inheritedModulePath=[bool]$env:PSModulePath } | ConvertTo-Json -Compress
try { Import-Module Microsoft.PowerShell.Security -ErrorAction Stop; 'security-module-loaded' }
catch { @{ operation='import-security-module'; error=$_.Exception.Message; errorType=$_.Exception.GetType().Name } | ConvertTo-Json -Compress }
`;
  for (const [kind, file, script, create, cleanModulePath] of [
    ["failed-directory", f.directory, snapshot + "\nSnapshot", "0", false],
    ["exact-create-replay", replay, moduleProbe + snapshot + traced, "1", false],
    ["isolated-module-create-replay", isolated, moduleProbe + snapshot + traced, "1", true],
  ] as const) {
    const childEnv = { ...process.env, DELEGATUS_CUSTODY_PATH: file, DELEGATUS_CUSTODY_CREATE: create };
    if (cleanModulePath) for (const name of Object.keys(childEnv)) if (name.toLowerCase() === "psmodulepath") delete childEnv[name as keyof typeof childEnv];
    const observed = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script!, "utf16le").toString("base64")], {
      env: childEnv, encoding: "utf8", timeout: 10000,
    });
    console.error("[custody-diagnostic]", JSON.stringify({ kind, spawned: !observed.error, exit: observed.status, spawnError: (observed.error as NodeJS.ErrnoException | undefined)?.code ?? null, stdout: safe(observed.stdout ?? ""), stderr: safe(observed.stderr ?? "") }));
  }
  const entries = ["identity.json", "environment.json"].map(name => {
    try { const s = lstatSync(path.join(f.directory, name)); return { name, present: true, link: s.isSymbolicLink(), file: s.isFile(), links: s.nlink, empty: s.size === 0 }; }
    catch { return { name, present: false }; }
  });
  let identity = "not-written", fingerprint = "not-written";
  try {
    const record = JSON.parse(readFileSync(path.join(f.directory, "identity.json"), "utf8"));
    identity = record.installRoot === path.resolve(f.base) ? "install-matches" : "install-mismatch";
    fingerprint = record.keyDigest === createHash("sha256").update(f.key).digest("hex") ? "matches" : "mismatch";
  } catch { /* Do not print parsing errors or record bytes. */ }
  console.error("[custody-diagnostic]", JSON.stringify({ action, prerequisite: "protected-custody-or-reader", entries, identity, fingerprint }));
}
async function gateIntact(port: number, key: string) {
  for (const route of ["/api/files", "/api/runtime/deployments", "/api/mcp"]) for (const [credential, status] of [[undefined, 403], ["synthetic-wrong-key", 403], [key, 200]] as const) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { headers: credential ? { authorization: `Bearer ${credential}` } : {}, signal: AbortSignal.timeout(2000) });
    expect(response.status === status).toBe(true); expect((await response.text()).includes(key)).toBe(false);
  }
}
for (const alias of ["LLV_TOKEN", "DELEGATUS_TOKEN"] as const) for (const actionId of ["start-launcher", "restart-terminal"] as const)
for (const rollback of [false, true]) test(`native protected terminal gate ${alias}/${actionId}, rollback=${rollback}`, async () => {
  const f = await fixture(alias);
  const listener = net.createServer(); await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as net.AddressInfo).port; await new Promise<void>(resolve => listener.close(() => resolve()));
  const old = spawn(process.execPath, ["--bun", path.join(f.base, "bin/cli.mjs"), "--port", String(port), "--no-open"], { cwd: f.base, env: f.env, stdio: "ignore" }); children.add(old);
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
  if (action?.id !== (rollback ? "restart-terminal" : actionId)) custodyFailure(f, action?.id ?? "null");
  expect(action?.id).toBe(rollback ? "restart-terminal" : actionId); expect(Boolean(action?.command?.includes(f.key))).toBe(false);
  await stop(old);
  // On Windows the recorded children can outlive termination of their parent.
  for (const entry of [before.web, before.runtimeHost]) if (entry.pid && entry.startIdentity && isAlive(entry.pid) && readStartIdentity(entry.pid) === entry.startIdentity) {
    process.kill(entry.pid, "SIGTERM"); await until(() => !isAlive(entry.pid!) ? true : null);
  }
  const child = process.platform === "win32"
    ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", action!.command!], { cwd: f.base, env: f.clean, stdio: ["ignore", "pipe", "pipe"] })
    : spawn("sh", ["-c", `exec ${action!.command!}`], { cwd: f.base, env: f.clean, stdio: ["ignore", "pipe", "pipe"] }); children.add(child);
  let output = ""; child.stdout!.on("data", data => output += data); child.stderr!.on("data", data => output += data);
  let after = await until(() => { const r = f.readRecord(); return r?.launcher.pid !== before.launcher.pid && r?.web.state === "healthy" && r.runtimeHost.state === "healthy" ? r : null; });
  await gateIntact(port, f.key);
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
      : spawn("sh", ["-c", `exec ${recovery!.command!}`], { cwd: f.base, env: f.clean, stdio: ["ignore", "pipe", "pipe"] }); children.add(recovered);
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
    const observed = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", timeout: 10000 });
    expect(observed.status).toBe(0); expect(observed.stdout.includes(f.key)).toBe(false); expect(observed.stderr.includes(f.key)).toBe(false);
  }
}, 120000);

function alterAcl(file: string, right: "Read" | "Write") {
  const script = String.raw`$ErrorActionPreference='Stop'; try { $p=$env:DELEGATUS_TEST_CUSTODY_PATH; $a=Get-Acl -LiteralPath $p; $sid=New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0'); $r=New-Object System.Security.AccessControl.FileSystemAccessRule($sid, '` + right + String.raw`', 'Allow'); $a.AddAccessRule($r); Set-Acl -LiteralPath $p -AclObject $a; exit 0 } catch { exit 1 }`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { env: { ...process.env, DELEGATUS_TEST_CUSTODY_PATH: file }, stdio: "ignore", timeout: 10000 });
  expect(result.status).toBe(0);
}
for (const unsafe of ["readable", "writable", "directory", "link", "foreign-identity", "stale-key"] as const) test(`native private custody refuses ${unsafe} before reading its credential`, async () => {
  const f = await fixture();
  const listener = net.createServer(); await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as net.AddressInfo).port; await new Promise<void>(resolve => listener.close(() => resolve()));
  const old = spawn(process.execPath, ["--bun", path.join(f.base, "bin/cli.mjs"), "--port", String(port), "--no-open"], { cwd: f.base, env: f.env, stdio: "ignore" }); children.add(old);
  const before = await until(() => { const r = f.readRecord(); return r?.web.state === "healthy" && r.runtimeHost.state === "healthy" ? r : null; });
  let prepared;
  try { prepared = prepareLauncherCredentials(f.base, f.env); }
  catch (error) { custodyFailure(f); throw error; }
  expect(prepared).toBe(true);
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
