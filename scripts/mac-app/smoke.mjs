// One driver for the native launcher. Runs only on disposable macOS CI machines.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readdirSync, readFileSync, statSync, rmSync, symlinkSync, cpSync } from "node:fs";
import { createServer } from "node:net";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { alive, appLogs, appSessionData, comparablePath, commandFailure, end as endOwnedProcess, exited, hasFinishedPageEvidence, hasRenderedEvidence, intelIsTranslated, legacyPageModes, processCensus, reapEvidenceFilters, runCommand, smokeEnvironment, smokeStdio, plainFailureMessage } from "./smoke-platform.mjs";

const [image, reportArg] = process.argv.slice(2);
if (process.platform !== "darwin" || !image || !reportArg || process.env.CI !== "true") throw new Error("Usage on disposable macOS CI: node smoke.mjs DMG REPORT");
const report = resolve(reportArg);
mkdirSync(report, { recursive: true });
const startedAt = Date.now();
const checks = [];
const commands = [];
const session = {};
const bundle = "org.delegatus.app";
const user = userInfo().username;
const runnerHome = process.env.HOME || userInfo().homedir;
// A short root keeps every socket path the server derives from HOME well
// inside the 104-byte limit.
let root = "";
let home = "";
let app = "";
let port;
const origin = () => `http://127.0.0.1:${port}`;
async function disposablePort() {
  const reservation = createServer();
  await new Promise((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve); });
  const assigned = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  return assigned;
}
const homes = [];
let mount;
const owned = new Map();
const appEntries = new Map();
const cleanupPIDs = new Set();
const evidenceFilters = new Map();
// Launchers this driver started itself; `stop --all` must see them reaped.
const replacements = new Set();
const surfaces = ["install", "installing", "cancelling", "access-unavailable", "open-existing", "menu", "stop", "login", "update", "quit"];
const visualCases = [
  ...["en", "uk"].flatMap(language => ["Light", "Dark"].flatMap(appearance => [
    ["minimum", ["--evidence-minimum-size"]], ["intermediate", ["--evidence-intermediate-size"]], ["default", []]
  ].map(([size, args]) => ({ language, appearance, size, args }))))
];
const accessKey = randomBytes(16).toString("hex");
// App.start's own bound for a launched server to verify (macos/Sources/App.swift).
const APP_START_BOUND_MS = 180_000;
function redact(value) {
  return String(value).replaceAll(root || "\0", "$SMOKE_ROOT").replaceAll(runnerHome || "\0", "$RUNNER_HOME")
    .replace(/([?&]k=|Bearer )[A-Za-z0-9%._~-]+/gi, "$1[redacted]")
    .replace(/\b[0-9a-f]{32}\b/g, "[redacted]");
}
function run(command, args, options = {}) {
  let status = 0;
  try { return execFileSync(command, args, { encoding: "utf8", stdio: smokeStdio(options.input), timeout: 180_000, ...options }); }
  catch (error) { status = error.status ?? 1; throw new Error(redact(commandFailure(command, error))); }
  finally { commands.push({ command: redact([command, ...args].join(" ")), exit: status }); }
}
// Runs a windowless command against one case's data without blocking the
// event loop, so a command that waits on a process this driver started sees
// it reaped.
async function inHome(caseHome, command, args = [], options = {}) {
  let status = 0;
  try { return await runCommand(command, args, { ...options, env: caseEnvironment(caseHome) }); }
  catch (error) { status = error.status ?? 1; throw new Error(redact(commandFailure(command, error))); }
  finally { commands.push({ command: redact([command, ...args].join(" ")), exit: status }); }
}
function freshHome(label) {
  const caseHome = join(root, `h${homes.length}`);
  mkdirSync(caseHome, { mode: 0o700 });
  assert.deepEqual(readdirSync(caseHome), [], "case home starts empty");
  homes.push({ label, home: caseHome });
  return caseHome;
}
function resetSessionData() {
  try { run("/usr/bin/defaults", ["delete", bundle]); } catch { /* no preferences yet */ }
  for (const path of appSessionData(runnerHome, bundle)) rmSync(path, { recursive: true, force: true });
}
function caseEnvironment(caseHome, settings = {}) {
  const temporary = join(caseHome, "Library/Caches/tmp");
  mkdirSync(temporary, { recursive: true });
  return smokeEnvironment({ user, home: caseHome }, {
    ...settings, TMPDIR: temporary, XDG_CONFIG_HOME: join(caseHome, ".config"),
    XDG_CACHE_HOME: join(caseHome, ".cache"), LLV_STATE_DIR: join(caseHome, ".config/delegatus/state"),
  });
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(label, check, timeout = 60_000, diagnostics = () => "") {
  const deadline = Date.now() + timeout;
  do { if (await check()) return; await sleep(500); } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}${diagnostics() ? `\n${diagnostics()}` : ""}`);
}
async function check(name, action) {
  try { await action(); checks.push({ name, exit: 0 }); }
  catch (error) { checks.push({ name, exit: 1, error: redact(error.message) }); throw error; }
}
const processLog = app => appLogs(app.home, app.pid);
async function finishedPage(instance, label, diagnostics) {
  await until(`${label} finished page capture`, () => {
    const log = processLog(instance);
    if (log.includes("PAGE failed:")) throw new Error(`Page did not finish\n${diagnostics()}`);
    return hasFinishedPageEvidence(readdirSync(instance.frames).map(name => `${label}/${name}`), label, log);
  }, 90_000, diagnostics);
}
function capturedFrames(directory) {
  try { return readdirSync(directory).filter(name => name.endsWith(".png")).length; } catch { return 0; }
}
let foreignListener = 0;
function own(child, label) {
  assert(Number.isSafeInteger(child.pid) && child.pid > 1, `${label} started`);
  owned.set(child.pid, child);
  cleanupPIDs.add(child.pid);
  return child.pid;
}
function launch(caseHome, args, label) {
  resetSessionData();
  const frames = join(report, "frames", label);
  const child = spawn(app, ["--evidence-dir", frames, "-ApplePersistenceIgnoreState", "YES", "--evidence-port", String(port), ...args],
    { env: caseEnvironment(caseHome), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", spawnError = null;
  const append = (current, chunk) => (current + redact(chunk.toString("utf8"))).slice(-12_000);
  child.stdout.on("data", chunk => { stdout = append(stdout, chunk); });
  child.stderr.on("data", chunk => { stderr = append(stderr, chunk); });
  child.on("error", error => { spawnError = redact(error.message); });
  const diagnostics = () => `app launch exit=${child.exitCode ?? "running"} signal=${child.signalCode ?? "none"}${spawnError ? ` spawnError=${spawnError}` : ""}\nstdout:\n${stdout || "(empty)"}\nstderr:\n${stderr || "(empty)"}`;
  const pid = own(child, `app ${label}`);
  const entry = { process: child, pid, home: caseHome, frames, diagnostics };
  appEntries.set(pid, entry);
  return entry;
}
async function end(entry) {
  await endOwnedProcess(entry, { owned, until, run, cleanupPIDs, evidenceFilters });
  appEntries.delete(entry?.pid);
}
function startViewer(bun, cli, settings = {}) {
  const child = spawn(bun, [cli, "--no-open", "--port", String(port)], { env: caseEnvironment(home, settings), stdio: "ignore" });
  child.on("error", () => {});
  commands.push({ command: redact([bun, cli, "--no-open", "--port", String(port)].join(" ")), exit: "started" });
  const pid = own(child, "replacement Delegatus");
  replacements.add(pid);
  return pid;
}
async function http(method = "GET", authorized = false) {
  try { return await fetch(origin() + (method === "HEAD" ? "/api/onboarding/diagnostics" : "/"), { method, headers: authorized ? { Authorization: `Bearer ${accessKey}` } : {}, signal: AbortSignal.timeout(2000) }); } catch { return null; }
}
const runtimeOf = caseHome => join(caseHome, "Library/Application Support/Delegatus/Runtime");
function launcherPID() {
  const processes = run("/bin/ps", ["-U", String(userInfo().uid), "-o", "pid=,command="]);
  const runtime = runtimeOf(home);
  const bun = comparablePath(join(runtime, "bun/bin/bun")), cli = comparablePath(join(runtime, "packages/node_modules/delegatus-cli/bin/cli.mjs"));
  const row = processes.split("\n").map(comparablePath).find(line => line.includes(bun) && line.includes(cli) && !line.includes("stop --all"));
  assert(row, "the launcher runs from this run's private runtime");
  const pid = Number(row.trim().split(/\s+/)[0]);
  cleanupPIDs.add(pid);
  return pid;
}
// What the app's listener check reads: who holds the port and the process
// chain above it. Diagnostics only; a failed read is recorded, never thrown.
function listenerSnapshot() {
  const read = (command, args) => { try { return run(command, args, { timeout: 20_000 }); } catch (error) { return error.message; } };
  const listing = read("/usr/sbin/lsof", ["-nP", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpcu"]);
  const rows = read("/bin/ps", ["-ww", "-U", String(userInfo().uid), "-o", "pid=,ppid=,command="]).split("\n")
    .filter(line => root && comparablePath(line).includes(comparablePath(root))).join("\n");
  return redact(`lsof listener:\n${listing || "(empty)"}\nprocesses under the run root:\n${rows || "(none)"}`);
}
// stop --all signals the launcher and waits until its PID is gone. A launcher
// this driver started is gone only once this event loop reaps it, so the stop
// runs asynchronously and must still exit 0; then that child's own exit is
// awaited before the case goes on.
async function stopAll() {
  const runtime = runtimeOf(home);
  const output = await inHome(home, join(runtime, "bun/bin/bun"), [join(runtime, "packages/node_modules/delegatus-cli/bin/cli.mjs"), "stop", "--all"]);
  for (const pid of replacements) {
    const child = owned.get(pid);
    if (child) await until(`replacement Delegatus ${pid} exit after stop --all`, () => exited(child), 30_000);
    owned.delete(pid); replacements.delete(pid);
  }
  return output;
}
function seedInstalledRelease(runtime) {
  const packageRoot = join(runtime, "packages/node_modules/delegatus-cli");
  const installId = createHash("sha256").update(resolve(packageRoot)).digest("hex").slice(0, 16);
  const sourceManifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const baseVersion = sourceManifest.version;
  const releaseVersion = baseVersion.replace(/(\d+)$/, (_, patch) => String(Number(patch) + 1));
  const release = join(home, ".cache/delegatus/self-update", installId, "releases", `npm-${releaseVersion}`, "node_modules/delegatus-cli");
  mkdirSync(join(release, "dist"), { recursive: true });
  symlinkSync(join(packageRoot, "dist/standalone"), join(release, "dist/standalone"));
  symlinkSync(join(packageRoot, "dist/runtime-host.mjs"), join(release, "dist/runtime-host.mjs"));
  writeFileSync(join(release, "package.json"), `${JSON.stringify({ ...sourceManifest, version: releaseVersion })}\n`);
  const pointer = { kind: "package", version: releaseVersion, sha: randomBytes(20).toString("hex"), baseVersion, dir: release };
  const pointerFile = join(home, ".config/delegatus/state/self-update", `release-${installId}.json`);
  mkdirSync(join(home, ".config/delegatus/state/self-update"), { recursive: true });
  writeFileSync(pointerFile, `${JSON.stringify(pointer)}\n`);
  assert(existsSync(join(release, "dist/standalone/server.js")), "updated release contains its Viewer");
  return { release, pointerFile };
}
// Keep every regression verdict even when an earlier case is red.
async function regression(name, action) {
  try { await check(name, action); }
  catch (error) { exit = 1; console.error(`Regression failed: ${name}\n${redact(error.message)}`); }
}
async function download(url) {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  assert(response.ok, `fixture download HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
async function legacyFixture() {
  const directory = join(root, "legacy"); mkdirSync(directory);
  // The released package requires Bun >=1.4.0; the former launcher uses 1.4.3.
  const base = "https://github.com/oven-sh/bun/releases/download/bun-v1.4.3";
  const archive = process.arch === "arm64" ? "bun-darwin-aarch64.zip" : "bun-darwin-x64-baseline.zip";
  const sums = (await download(`${base}/SHASUMS256.txt`)).toString();
  const bytes = await download(`${base}/${archive}`);
  const checksum = sums.split(/\r?\n/).map(line => /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line)).find(row => row?.[2] === archive)?.[1];
  assert.equal(createHash("sha256").update(bytes).digest("hex"), checksum, "old-runtime archive checksum");
  writeFileSync(join(directory, "bun.zip"), bytes);
  run("/usr/bin/ditto", ["-xk", join(directory, "bun.zip"), directory]);
  const bun = join(directory, archive.slice(0, -4), "bun");
  assert.equal(run(bun, ["--version"]).trim(), "1.4.3", "released fixture uses the former launcher's supported runtime");
  const metadata = JSON.parse((await download("https://registry.npmjs.org/delegatus-cli/1.11.0")).toString());
  assert.equal(metadata.name, "delegatus-cli"); assert.equal(metadata.version, "1.11.0");
  assert.equal(metadata.gitHead, "56f63d33d84f812e267f1498d9eddf735ab9b4c4", "released tag identity");
  assert.equal(metadata.dist.tarball, "https://registry.npmjs.org/delegatus-cli/-/delegatus-cli-1.11.0.tgz");
  const packed = await download(metadata.dist.tarball);
  assert.equal(`sha512-${createHash("sha512").update(packed).digest("base64")}`, metadata.dist.integrity, "released package integrity");
  writeFileSync(join(directory, "legacy.tgz"), packed);
  run("/usr/bin/tar", ["-xzf", join(directory, "legacy.tgz"), "-C", directory]);
  const packageRoot = join(directory, "package");
  const installed = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  assert.equal(installed.name, "delegatus-cli"); assert.equal(installed.version, "1.11.0");
  await inHome(directory, bun, ["install", "--production", "--ignore-scripts"], { cwd: packageRoot });
  return { bun, packageRoot };
}
function seedInstallation(fixture, caseHome, community = false) {
  const base = community ? join(caseHome, "Library/Application Support/Delegatus Launcher/Runtime") : join(caseHome, ".bun");
  const bun = join(base, community ? "bun/bin/bun" : "bin/bun");
  const packageRoot = join(base, community ? "packages/node_modules/delegatus-cli" : "install/global/node_modules/delegatus-cli");
  mkdirSync(join(bun, ".."), { recursive: true }); cpSync(fixture.bun, bun);
  if (fixture.packageRoot) cpSync(fixture.packageRoot, packageRoot, { recursive: true });
  else for (const file of ["bin/cli.mjs", "dist/standalone/server.js", "dist/runtime-host.mjs"]) {
    const destination = join(packageRoot, file);
    mkdirSync(join(destination, ".."), { recursive: true }); writeFileSync(destination, "");
  }
  return { bun, cli: join(packageRoot, "bin/cli.mjs") };
}
function fixtureListenerPID(installation) {
  const listing = run("/usr/sbin/lsof", ["-nP", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]).trim();
  const pids = listing.split(/\s+/).filter(Boolean).map(Number);
  assert.equal(pids.length, 1, `expected one listener for the isolated fixture, found ${listing || "none"}`);
  const pid = pids[0];
  const command = comparablePath(run("/bin/ps", ["-ww", "-p", String(pid), "-o", "command="]).trim());
  const fixtureRoot = comparablePath(installation.cli.replace("/bin/cli.mjs", ""));
  assert(command.includes(comparablePath(installation.bun)) && command.includes(fixtureRoot), `listener PID ${pid} belongs to this released fixture`);
  cleanupPIDs.add(pid);
  return pid;
}
async function stopLegacy(caseHome, installation, child, listenerPID, launcherPIDs = []) {
  for (const pid of launcherPIDs) cleanupPIDs.add(pid);
  // The 1.11.0 CLI has no stop command. Reap only this fixture's recorded PID.
  try {
    if (child) {
      try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      await end(child);
    }
    const fixtureRoot = comparablePath(installation.cli.replace("/bin/cli.mjs", ""));
    for (const pid of launcherPIDs) if (alive(pid)) {
      const command = comparablePath(run("/bin/ps", ["-ww", "-p", String(pid), "-o", "command="]).trim());
      assert(command.includes(comparablePath(installation.bun)) && command.includes(comparablePath(installation.cli)), `recorded launcher PID ${pid} belongs to this released fixture`);
      try { process.kill(pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      await until(`released fixture launcher ${pid} exits`, () => !alive(pid));
    }
    if (listenerPID && alive(listenerPID)) {
      const command = comparablePath(run("/bin/ps", ["-ww", "-p", String(listenerPID), "-o", "command="]).trim());
      assert(command.includes(comparablePath(installation.bun)) && command.includes(fixtureRoot), `recorded listener PID ${listenerPID} still belongs to this released fixture`);
      try { process.kill(listenerPID, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  }
  finally { await until("legacy port released", async () => !(await http())); }
}
async function relaunchCases(fixture) {
  for (const forged of [false, true]) await regression(`same-bun-title-${forged ? "forged" : "missing"}-identity-refused`, async () => {
    const caseHome = freshHome("same-bun-title");
    const installation = seedInstallation({ bun: fixture.bun }, caseHome);
    const packageRoot = join(installation.cli, "../.."), authFile = join(caseHome, "auth-received");
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "delegatus-cli", version: "2.0.0" }));
    mkdirSync(join(caseHome, ".config/delegatus"), { recursive: true });
    writeFileSync(join(caseHome, ".config/delegatus/token"), accessKey, { mode: 0o600 });
    const script = join(caseHome, "foreign.mjs");
    writeFileSync(script, `import {writeFileSync} from 'node:fs';
process.title=${JSON.stringify(`${installation.bun} ${join(packageRoot, "dist/standalone/server.js")}`)};
Bun.serve({hostname:'127.0.0.1',port:${port},fetch(request){
 if(request.headers.has('authorization') || request.headers.has('cookie') || new URL(request.url).searchParams.has('k')) writeFileSync(${JSON.stringify(authFile)},'received');
 return new Response(null,{status:403});
}});\n`);
    const child = spawn(installation.bun, [script, "x".repeat(4096)], { env: caseEnvironment(caseHome), stdio: "ignore" });
    own(child, "same-Bun foreign script");
    try {
      await until("same-Bun script answers", async () => (await http("HEAD"))?.status === 403);
      const title = comparablePath(run("/bin/ps", ["-ww", "-p", String(child.pid), "-o", "command="]).trim());
      assert(title.startsWith(comparablePath(`${installation.bun} ${join(packageRoot, "dist/standalone/server.js")}`)), "hostile fixture really copies the installed server's command");
      if (forged) {
        // Construct the reviewed exploit from public kernel fields alone. No
        // launcher ever verified this script or produced this mode-0600 file.
        run("/usr/bin/python3", ["-c", `import ctypes,json,os,struct,sys
pid,port=int(sys.argv[1]),int(sys.argv[2])
info=ctypes.create_string_buffer(136)
lib=ctypes.CDLL('/usr/lib/libproc.dylib')
assert lib.proc_pidinfo(pid,3,0,info,136)==136
sec,usec=struct.unpack_from('QQ',info.raw,120)
uid=struct.unpack_from('I',info.raw,20)[0]
file=os.path.join(sys.argv[3],'Library/Application Support/Delegatus/Listeners',str(port)+'.json')
os.makedirs(os.path.dirname(file),exist_ok=True)
with open(file,'w') as output: json.dump([dict(pid=pid,uid=uid,birth=str(sec)+':'+str(usec),bun=os.path.realpath(sys.argv[4]),cli=os.path.realpath(sys.argv[5]),package=os.path.realpath(sys.argv[6]))],output)
os.chmod(file,0o600)
`, String(child.pid), String(port), caseHome, installation.bun, installation.cli, packageRoot]);
      }
      for (const language of ["en", "uk"]) {
        const instance = launch(caseHome, ["-AppleLanguages", `(${language})`], `same-bun-title-${forged ? "forged" : "missing"}-${language}`);
        try {
          await until("same-Bun title refused", () => processLog(instance).includes("STATE port-busy"), 60_000, () => processLog(instance));
          assert(!processLog(instance).includes("ACTIONS open-existing") && !processLog(instance).includes("WEB language="));
          assert(!existsSync(authFile), "a copied title and forged receipt never receive Authorization, cookies or query keys");
          assert(alive(child.pid), "refusal leaves the foreign process alone");
        } finally { await end(instance); }
      }
    } finally { await end(child); }
  });
  for (const version of ["2.0.0", "99.0.0"]) for (const mode of ["relaunch", "not-found", "key-refused"]) {
    await regression(`relaunch-${version}-${mode}`, async () => {
      const caseHome = freshHome(`relaunch-${version}-${mode}`);
      const installation = seedInstallation({ bun: fixture.bun }, caseHome);
      const packageRoot = join(installation.cli, "../..");
      const handshake = join(caseHome, "relaunch.json"), phase = join(caseHome, "phase"), leakedKey = join(caseHome, "key-on-page");
      writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "delegatus-cli", version }));
      writeFileSync(installation.cli, `import {spawn} from 'node:child_process';
spawn(process.execPath,[${JSON.stringify(join(packageRoot, "dist/standalone/server.js"))},process.argv.at(-1)],{detached:true,stdio:'inherit'});
process.stdin.resume();\n`);
      writeFileSync(join(packageRoot, "dist/standalone/server.js"), `import {existsSync,writeFileSync} from 'node:fs';
const server=Bun.serve({hostname:'127.0.0.1',port:Number(process.argv.at(-1)),fetch(request){
 const url=new URL(request.url), diagnostics=url.pathname==='/api/onboarding/diagnostics';
 const changed=existsSync(${JSON.stringify(phase)});
 if(!diagnostics && (url.searchParams.has('k') || request.headers.has('cookie') || request.headers.has('authorization'))) writeFileSync(${JSON.stringify(leakedKey)},'received');
 const status=diagnostics?(changed?${mode === "not-found" ? 404 : mode === "key-refused" ? 403 : 204}:204):200;
 return new Response(request.method==='HEAD'?null:'<html><body>Delegatus fixture</body></html>',{status,headers:status===204?{'x-delegatus-diagnostics':'1'}:{}});
}});
writeFileSync(${JSON.stringify(handshake)},JSON.stringify({launcher:process.ppid,server:process.pid}));\n`);
      mkdirSync(join(caseHome, ".config/delegatus"), { recursive: true });
      writeFileSync(join(caseHome, ".config/delegatus/token"), accessKey, { mode: 0o600 });
      let instance, pids;
      try {
        instance = launch(caseHome, ["-AppleLanguages", "(en)"], `relaunch-start-${version}-${mode}`);
        await until("app starts relaunch fixture", () => existsSync(handshake) && processLog(instance).includes("STATE ready"), 60_000, () => processLog(instance));
        pids = JSON.parse(readFileSync(handshake, "utf8"));
        cleanupPIDs.add(pids.launcher); cleanupPIDs.add(pids.server);
        await end(instance); instance = undefined;
        assert(alive(pids.server), "server survives app closure");
        // Also exercise the detached-server case where the CLI has gone.
        process.kill(pids.launcher, "SIGTERM");
        await until("old CLI exits", () => !alive(pids.launcher));
        writeFileSync(phase, "reopened");
        for (const language of ["en", "uk"]) {
          const label = `relaunch-${version}-${mode}-${language}`;
          instance = launch(caseHome, ["--evidence-minimum-size", ...(mode === "relaunch" ? [] : ["--evidence-open-existing"]),
            "-AppleLanguages", `(${language})`, "-AppleInterfaceStyle", language === "uk" ? "Dark" : "Light"], label);
          const diagnostics = () => `${instance.diagnostics()}\n${processLog(instance)}\n${listenerSnapshot()}`;
          await until("reopened launcher reuses its surviving instance", () => {
            if (processLog(instance).includes("STATE failed")) throw new Error(diagnostics());
            return processLog(instance).includes("STATE reused");
          }, 60_000, diagnostics);
          if (mode !== "relaunch") {
            const state = mode === "not-found" ? "port-busy" : "access-unavailable";
            assert(processLog(instance).includes(`STATE ${state}`) && processLog(instance).includes("ACTION open-existing"), "the real action row opens the existing instance");
            assert(readdirSync(instance.frames).some(name => name.endsWith(`-${state}.png`)), "button screen retained before clicking");
          }
          await finishedPage(instance, label, diagnostics);
          assert.equal(fixtureListenerPID(installation), pids.server, "no server replacement on relaunch or version difference");
          assert(!existsSync(leakedKey), "manual page receives neither a refused key nor cookies");
          await end(instance); instance = undefined;
        }
      } finally {
        if (instance) await end(instance);
        if (!pids && existsSync(handshake)) pids = JSON.parse(readFileSync(handshake, "utf8"));
        if (pids) {
          for (const pid of [pids.launcher, pids.server]) if (alive(pid)) process.kill(pid, "SIGTERM");
          await until("owned relaunch fixture exits", () => !alive(pids.launcher) && !alive(pids.server));
        }
      }
    });
  }
}
async function notFoundCases() {
  for (const mode of ["not-found", "key", "unauthorized", "open"]) {
    await regression(`foreign-${mode}-no-key`, async () => {
      const caseHome = freshHome(`foreign-${mode}`);
      const authFile = join(caseHome, "auth-received");
      const decoy = seedInstallation({ bun: "/usr/bin/true" }, caseHome);
      writeFileSync(join(decoy.cli, "../../package.json"), JSON.stringify({ name: "delegatus-cli", version: "1.11.0" }));
      mkdirSync(join(caseHome, ".config/delegatus"), { recursive: true });
      writeFileSync(join(caseHome, ".config/delegatus/token"), accessKey, { mode: 0o600 });
      const child = spawn("/usr/bin/python3", ["macos/Tests/ProbeServer.py", decoy.bun, join(decoy.cli, "../../dist/standalone/server.js"), decoy.cli], {
        env: caseEnvironment(caseHome, { PROBE_MODE: mode, PROBE_AUTH_FILE: authFile }), stdio: ["ignore", "pipe", "pipe"],
      });
      const pid = own(child, "foreign ephemeral probe");
      let output = ""; child.stdout.on("data", bytes => { output += bytes.toString(); });
      const savedPort = port;
      try {
        await until("foreign ephemeral address", () => /^\d+\s*$/.test(output)); port = Number(output.trim());
        for (const language of ["en", "uk"]) {
          const instance = launch(caseHome, ["-AppleLanguages", `(${language})`, "-AppleInterfaceStyle", language === "uk" ? "Dark" : "Light"], `foreign-${mode}-${language}`);
          try {
            await until("foreign listener refusal", () => processLog(instance).includes("STATE port-busy"), 60_000, () => processLog(instance));
            assert(!processLog(instance).includes("WEB language="), "no foreign page opens");
            assert(!processLog(instance).includes("ACTIONS open-existing"), "foreign listeners have no Open existing button");
            assert(!existsSync(authFile), "even a copied diagnostics marker receives no key");
            assert(!existsSync(runtimeOf(caseHome)), "refusal installs no replacement");
            assert(alive(pid), "foreign listener survives");
            await until("foreign refusal frame", () => capturedFrames(instance.frames) > 0, 10_000);
          } finally { await end(instance); }
        }
      } finally { port = savedPort; await end(child); }
    });
  }
  let fixture;
  await check("released-1.11.0-fixture", async () => { fixture = await legacyFixture(); });
  await relaunchCases(fixture);
  for (const mode of ["already-running", "app-started", "protected", "missing-key", "wrong-key", "community-running", "community-stopped"]) {
    await regression(`released-1.11.0-${mode}`, async () => {
      const caseHome = freshHome(`legacy-${mode}`);
      const installation = seedInstallation(fixture, caseHome, mode.startsWith("community"));
      const protectedServer = ["protected", "missing-key", "wrong-key"].includes(mode);
      if (protectedServer) {
        mkdirSync(join(caseHome, ".config/delegatus"), { recursive: true });
        writeFileSync(join(caseHome, ".config/delegatus/phone-access"), "enabled\n");
        if (mode === "protected") writeFileSync(join(caseHome, ".config/delegatus/token"), accessKey, { mode: 0o600 });
      }
      let child;
      let instance;
      let listenerPID;
      const appLauncherPIDs = new Set();
      let primaryError;
      try {
        if (!["app-started", "community-stopped"].includes(mode)) {
          child = spawn(installation.bun, [installation.cli, "--no-open", "--port", String(port)], {
            env: caseEnvironment(caseHome, protectedServer ? { LLV_TOKEN: accessKey } : {}), stdio: ["ignore", "pipe", "pipe"], detached: true,
          });
          own(child, "released legacy launcher");
          let log = ""; child.stdout.on("data", bytes => { log = (log + redact(bytes)).slice(-16000); });
          child.stderr.on("data", bytes => { log = (log + redact(bytes)).slice(-16000); });
          await until("released legacy root", async () => (await http("GET", protectedServer))?.status === 200, 180_000, () => log);
          assert.equal((await http("HEAD", protectedServer))?.status, 404, "real released package lacks diagnostics");
          if (mode === "missing-key") rmSync(join(caseHome, ".config/delegatus/token"), { force: true });
          if (mode === "wrong-key") writeFileSync(join(caseHome, ".config/delegatus/token"), randomBytes(16).toString("hex"), { mode: 0o600 });
          checks.push({ name: `reproduced-1.11.0-${mode}-diagnostics-404`, exit: 0 });
        }
        for (const language of ["en", "uk"]) {
          const label = `legacy-${mode}-${language}`;
          instance = launch(caseHome, ["-AppleLanguages", `(${language})`, "-AppleInterfaceStyle", language === "uk" ? "Dark" : "Light"], label);
          const diagnostics = () => `${instance.diagnostics()}\n${processLog(instance)}\n${listenerSnapshot()}`;
          if (mode === "community-stopped") {
            await until("stopped community installation offers install", () => processLog(instance).includes("STATE needs-install"), 60_000, diagnostics);
          } else if (["missing-key", "wrong-key"].includes(mode)) {
            await until("plain legacy access message", () => {
              if (processLog(instance).includes("STATE port-busy")) throw new Error(diagnostics());
              return processLog(instance).includes("STATE access-unavailable");
            }, 60_000, diagnostics);
            assert(!processLog(instance).includes("WEB language="));
            const message = processLog(instance).split("STATE access-unavailable").at(-1);
            assert(message.includes("1.11.0") && (language === "en" ? /access key/i : /ключ/i).test(message), "localized access guidance names the old Delegatus");
          } else {
            if (mode === "already-running" || mode === "community-running") {
              await until("AppKit disables legacy menu actions after validation", () => processLog(instance).includes("MENU-VALIDATED stop=disabled login=disabled"), 60_000, diagnostics);
            }
            await until("legacy opens in app", () => {
              if (/STATE (port-busy|failed)/.test(processLog(instance))) throw new Error(diagnostics());
              return /STATE (ready|reused)/.test(processLog(instance)) && /WEB language=/.test(processLog(instance));
            },
              APP_START_BOUND_MS + 30_000, diagnostics);
            if (mode === "app-started") {
              listenerPID = fixtureListenerPID(installation);
              if (language === "en") {
                assert.equal((await http("HEAD"))?.status, 404, "app-started real release lacks diagnostics");
                checks.push({ name: `reproduced-1.11.0-${mode}-diagnostics-404`, exit: 0 });
              }
            }
            const spawnedPID = Number(processLog(instance).match(/APP-LAUNCHER pid (\d+)/)?.[1]);
            if (Number.isSafeInteger(spawnedPID) && spawnedPID > 1) appLauncherPIDs.add(spawnedPID);
            await sleep(32_000);
            assert(!processLog(instance).includes("STATE stopped"), "monitor retains the verified legacy page");
            assert.equal((await http("GET", protectedServer))?.status, 200);
            await finishedPage(instance, label, diagnostics);
          }
          await until("legacy verdict frame", () => capturedFrames(instance.frames) > 0, 10_000);
          await end(instance); instance = undefined;
        }
      } catch (error) {
        primaryError = error;
        throw error;
      } finally {
        const cleanupErrors = [];
        if (!listenerPID && mode === "app-started") {
          try { listenerPID = fixtureListenerPID(installation); } catch { /* The app never created a verified fixture listener. */ }
        }
        if (mode === "app-started" && instance) {
          const spawnedPID = Number(processLog(instance).match(/APP-LAUNCHER pid (\d+)/)?.[1]);
          if (Number.isSafeInteger(spawnedPID) && spawnedPID > 1) appLauncherPIDs.add(spawnedPID);
        }
        try { if (instance) await end(instance); } catch (error) { cleanupErrors.push(error); }
        try { if (mode !== "community-stopped") await stopLegacy(caseHome, installation, child, listenerPID, [...appLauncherPIDs]); } catch (error) { cleanupErrors.push(error); }
        if (cleanupErrors.length) {
          const errors = primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors;
          throw new AggregateError(errors, errors.map(error => error.message).join("; "));
        }
      }
    });
  }
  for (const mode of ["transient", "persistent", "exit", "legacy-unready", "foreign-replacement"]) for (const language of ["en", "uk"]) {
    await regression(`owned-boot-404-${mode}-${language}`, async () => {
      const caseHome = freshHome(`boot-${mode}-${language}`);
      const installation = seedInstallation({ bun: fixture.bun }, caseHome);
      const packageRoot = join(installation.cli, "../..");
      // This deliberately uses the real launcher/server process relationship;
      // only their HTTP sequence is synthetic. It proves no real boot 404.
      writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "delegatus-cli", version: mode === "legacy-unready" ? "1.11.0" : "2.0.0" }));
      const handshake = join(caseHome, "owned-boot.json"), ready = join(caseHome, "ready"), exitFile = join(caseHome, "exit");
      writeFileSync(installation.cli, `import { spawn } from 'node:child_process';
const child = spawn(process.execPath, [${JSON.stringify(join(packageRoot, "dist/standalone/server.js"))}, process.argv.at(-1)], {stdio:'inherit'});
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', () => process.exit(0));\n`);
      writeFileSync(join(packageRoot, "dist/standalone/server.js"), `import {existsSync,writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
writeFileSync(${JSON.stringify(handshake)}, JSON.stringify({launcher:process.ppid,server:process.pid}));
const server=createServer((request,response)=>{
 const diagnostics=request.url==='/api/onboarding/diagnostics';
 const status=diagnostics?(existsSync(${JSON.stringify(ready)})?204:404):${mode === "legacy-unready" ? 503 : 200};
 ${mode === "exit" ? `const exitAfterHead=diagnostics && request.method==='HEAD' && existsSync(${JSON.stringify(exitFile)});` : ""}
 response.writeHead(status,status===204?{'x-delegatus-diagnostics':'1'}:{});
 response.end(request.method==='HEAD'?null:'<html lang="en"><title>Delegatus fixture</title></html>',()=>{
  ${mode === "exit" ? "if(exitAfterHead){server.close();process.exit(1)}" : ""}
 });
});
server.listen(Number(process.argv.at(-1)),'127.0.0.1');
process.on('SIGTERM',()=>{server.close();process.exit(0)});\n`);
      let pids, replacement;
      const instance = launch(caseHome, ["-AppleLanguages", `(${language})`, "-AppleInterfaceStyle", language === "uk" ? "Dark" : "Light"], `owned-boot-${mode}-${language}`);
      try {
        await until("owned boot handshake", () => existsSync(handshake), 60_000, () => processLog(instance));
        pids = JSON.parse(readFileSync(handshake, "utf8"));
        assert(pids.launcher > 1 && pids.server > 1);
        cleanupPIDs.add(pids.launcher); cleanupPIDs.add(pids.server);
        await until("app observes boot 404", () => processLog(instance).includes("HEAD 404"), 30_000, () => processLog(instance));
        if (mode === "foreign-replacement") {
          process.kill(pids.launcher, "SIGTERM");
          await until("owned boot releases port", () => !alive(pids.launcher) && !alive(pids.server), 30_000);
          const script = join(caseHome, "replacement.py"), authFile = join(caseHome, "replacement-auth");
          writeFileSync(script, `import http.server,os
class Handler(http.server.BaseHTTPRequestHandler):
 def do_HEAD(self):
  if self.headers.get('Authorization'): open(${JSON.stringify(authFile)},'w').write('received')
  self.send_response(204);self.send_header('x-delegatus-diagnostics','1');self.end_headers()
 def log_message(self,*args): pass
http.server.HTTPServer(('127.0.0.1',${port}),Handler).serve_forever()
`);
          replacement = spawn("/usr/bin/python3", [script], { env: caseEnvironment(caseHome), stdio: "ignore" });
          own(replacement, "foreign replacement");
          await until("foreign replacement answers", async () => (await http("HEAD"))?.status === 204);
          await until("foreign replacement refused", () => processLog(instance).includes("STATE port-busy"), 60_000, () => processLog(instance));
          assert(!processLog(instance).includes("WEB language="), "changed listener never opens");
          assert(!existsSync(authFile), "changed listener never receives a key");
          assert(alive(replacement.pid), "foreign replacement survives refusal");
          assert(!/HEAD \d|PROBE |LISTENER /.test(processLog(instance).split("STATE port-busy").at(-1)), "foreign replacement gets plain port guidance");
        } else if (mode === "transient") {
          writeFileSync(ready, "ready");
          await until("owned transient 404 recovers", () => processLog(instance).includes("STATE ready") && /WEB language=/.test(processLog(instance)), 60_000, () => processLog(instance));
        } else {
          if (mode === "exit") writeFileSync(exitFile, "exit");
          const began = Date.now();
          await until("owned boot bounded plain failure", () => processLog(instance).includes("STATE failed"), APP_START_BOUND_MS + 30_000, () => processLog(instance));
          const elapsed = Date.now() - began;
          if (["persistent", "legacy-unready"].includes(mode)) {
            assert(elapsed >= APP_START_BOUND_MS - 10_000 && elapsed <= APP_START_BOUND_MS + 30_000, "persistent 404 uses the existing readiness bound");
            assert(alive(pids.launcher) && alive(pids.server), "owned children survive the pending readiness wait");
          } else {
            assert(elapsed < 45_000, "exited CLI keeps its shorter exit grace");
            assert(processLog(instance).includes("LISTENER absent; recheck free"), "exit after HEAD exercises the vanished-listener recheck");
          }
          assert(!processLog(instance).includes("WEB language="), "root 200 alone cannot accept a modern persistent 404");
          plainFailureMessage(processLog(instance));
        }
        await until("boot verdict frame", () => readdirSync(instance.frames).some(name => name.endsWith(`-${mode === "transient" ? "ready" : mode === "foreign-replacement" ? "port-busy" : "failed"}.png`)), 10_000);
      } finally {
        await end(instance);
        if (replacement) await end(replacement);
        if (pids) {
          // Both IDs came from this fixture's handshake, never from a port scan.
          if (alive(pids.launcher)) process.kill(pids.launcher, "SIGTERM");
          await until("owned boot launcher and server exit", () => !alive(pids.launcher) && !alive(pids.server), 30_000);
        }
      }
    });
  }
}
let exit = 0;
try {
  await check("intel-translation-probe", () => {
    const machine = run("/usr/bin/uname", ["-m"]).trim();
    if (machine !== "x86_64") return;
    assert.equal(process.arch, "x64", "Intel smoke driver runs as x86_64");
    let status = 0, stdout = "", stderr = "";
    try {
      stdout = execFileSync("/usr/sbin/sysctl", ["-n", "sysctl.proc_translated"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      status = error.status ?? -1;
      stdout = error.stdout?.toString("utf8") ?? "";
      stderr = error.stderr?.toString("utf8") ?? "";
    }
    commands.push({ command: "/usr/sbin/sysctl -n sysctl.proc_translated", exit: status });
    assert.equal(intelIsTranslated({ status, stdout, stderr }), false,
      "Intel smoke must run natively; an arm64 process under Rosetta is refused");
  });
  await check("runner-session-fresh-data", async () => {
    // The hosted runner has one graphical session, the runner user's. The app
    // runs there; a fresh data root per run and a fresh home per case replace
    // a second operating-system account, which has no window-server access.
    assert(userInfo().uid > 0, "the smoke runs as the unprivileged runner user");
    session.manager = run("/bin/launchctl", ["managername"]).trim();
    session.bootstrap = run("/bin/launchctl", ["manageruid"]).trim() === String(userInfo().uid) ? "runner" : "other";
    root = mkdtempSync("/private/tmp/dlg-");
    home = freshHome("installed");
    port = await disposablePort();
  });
  await check("drag-install", () => {
    const plist = run("hdiutil", ["attach", "-readonly", "-nobrowse", "-plist", resolve(image)]);
    const file = join(report, "mount.plist"); writeFileSync(file, plist);
    const parsed = JSON.parse(run("plutil", ["-convert", "json", "-o", "-", file]));
    mount = parsed["system-entities"].find(entry => entry["mount-point"])?.["mount-point"];
    assert(mount);
    mkdirSync(join(root, "Applications"));
    run("/usr/bin/ditto", [join(mount, "Delegatus.app"), join(root, "Applications", "Delegatus.app")]);
    app = join(root, "Applications", "Delegatus.app", "Contents", "MacOS", "Delegatus");
    assert(existsSync(app));
  });
  const tokenPath = join(home, ".config", "delegatus", "token");
  await check("saved-key-fixture", () => {
    mkdirSync(join(home, ".config", "delegatus"), { recursive: true, mode: 0o700 });
    writeFileSync(tokenPath, `${accessKey}\n`, { mode: 0o600 });
    assert.equal(readFileSync(tokenPath, "utf8").trim(), accessKey, "saved-key fixture reaches the fresh home");
    assert.equal(statSync(tokenPath).mode & 0o777, 0o600);
  });
  const before = readdirSync(home);
  await notFoundCases();
  await until("regression fixtures released their port", async () => !(await http()));
  await check("confirm-without-install", async () => {
    const instance = launch(home, ["--evidence-minimum-size", "-AppleLanguages", "(en)"], "confirm-en-light-minimum");
    await until("confirmation", () => processLog(instance).includes("STATE needs-install"), 60_000, instance.diagnostics);
    await sleep(20_000);
    assert(!existsSync(runtimeOf(home)), "nothing installs before confirmation");
    await end(instance);
  });
  for (const surface of surfaces) {
    for (const { language, appearance, size, args } of visualCases) await check(`surface-${surface}-${language}-${appearance}-${size}`, async () => {
      const label = `surface-${surface}-${language}-${appearance}-${size}`;
      const instance = launch(freshHome(label), [...args, "--evidence-surface", surface, "-AppleLanguages", `(${language})`, "-AppleInterfaceStyle", appearance], label);
      await until(`render ${surface}`, () => {
        const log = processLog(instance);
        if (!log.includes(`SURFACE ${surface}`) || capturedFrames(instance.frames) === 0) return false;
        if (["menu", "stop", "login", "update", "quit"].includes(surface)) {
          const name = surface === "menu" ? "menu" : `dialog-${surface}`;
          return log.includes(`CAPTURED ${name}`) && log.includes(`SURFACE-CLOSED ${surface}`);
        }
        return true;
      }, 60_000, () => `${instance.diagnostics()}\napp log:\n${processLog(instance) || "(empty)"}`);
      await end(instance);
    });
  }
  for (const item of visualCases) {
    const { language, appearance, size, args } = item;
    if (language === "en" && appearance === "Light" && size === "minimum") continue;
    await check(`confirmation-${language}-${appearance}-${size}`, async () => {
      const label = `confirm-${language}-${appearance}-${size}`;
      const instance = launch(freshHome(label), [...args, "-AppleLanguages", `(${language})`, "-AppleInterfaceStyle", appearance], label);
      await until("localized confirmation", () => processLog(instance).includes("STATE needs-install"), 60_000, instance.diagnostics);
      await sleep(1200); await end(instance);
    });
  }
  for (const { language, appearance, size, args } of visualCases) await check(`error-${language}-${appearance}-${size}`, async () => {
    const label = `error-${language}-${appearance}-${size}`;
    const instance = launch(freshHome(label), [...args, "--evidence-error", "-AppleLanguages", `(${language})`, "-AppleInterfaceStyle", appearance], label);
    await until("localized error screen", () => processLog(instance).includes("STATE failed"), 60_000, instance.diagnostics);
    await sleep(900); await end(instance);
  });
  // From here one home carries the installed runtime: reuse, protection,
  // recovery and the busy port are what these cases test.
  let original;
  await check("first-run-http-200", async () => {
    const instance = launch(home, ["--accept-install", "-AppleLanguages", "(en)"], "first-en-light");
    const bootResponses = [];
    await until("HTTP 200", async () => {
      const head = await http("HEAD");
      bootResponses.push({ elapsedMs: Date.now() - startedAt, status: head?.status ?? "unavailable-or-timeout", marker: head?.headers.get("x-delegatus-diagnostics") ?? null });
      return (await http())?.status === 200;
    }, 720_000, () => `${instance.diagnostics()}\napp log:\n${processLog(instance) || "(empty)"}`);
    writeFileSync(join(report, "first-run-head.json"), JSON.stringify(bootResponses, null, 2));
    const head = await http("HEAD"); assert.equal(head?.status, 204); assert.equal(head?.headers.get("x-delegatus-diagnostics"), "1");
    // The app gives its start 180 s from STATE starting; wait that bound plus
    // margin, and stop at once when the app reports failure.
    const firstRun = () => `${instance.diagnostics()}\napp log:\n${processLog(instance) || "(empty)"}\n${listenerSnapshot()}`;
    await until("ready", () => {
      const output = processLog(instance);
      if (output.includes("STATE failed")) throw new Error(`App reported failure before ready\n${firstRun()}`);
      return output.includes("STATE ready");
    }, APP_START_BOUND_MS + 30_000, firstRun);
    await until("web language", () => /WEB language=en/.test(processLog(instance)), 60_000, firstRun);
    await until("supported menu actions remain enabled after AppKit validation", () => processLog(instance).includes("MENU-VALIDATED stop=enabled login=enabled"), 60_000, firstRun);
    original = launcherPID();
    for (const entry of readdirSync(home).filter(entry => !before.includes(entry))) assert(["Library", ".config", ".cache"].includes(entry), `unexpected home entry ${entry}`);
    await sleep(4000); await end(instance);
    assert.equal((await http())?.status, 200, "server survives app exit");
  });
  for (const { language, appearance, size, args } of visualCases) {
    const label = `reuse-${language}-${appearance}-${size}`;
    await check(label, async () => {
      const instance = launch(home, [...args, "-AppleLanguages", `(${language})`, "-AppleInterfaceStyle", appearance], label);
      const diagnostics = () => `${instance.diagnostics()}\napp log:\n${processLog(instance) || "(empty)"}\n${listenerSnapshot()}`;
      await until("reuse and language", () => { const output = processLog(instance); return output.includes("STATE reused") && new RegExp(`WEB language=${language}`).test(output); }, 60_000,
        diagnostics);
      await finishedPage(instance, label, diagnostics);
      assert.equal(launcherPID(), original); await end(instance);
    });
  }
  await check("protected-reuse-and-refusal", async () => {
    const runtime = runtimeOf(home);
    await stopAll();
    await until("port free before protected server", async () => !(await http()));
    seedInstalledRelease(runtime);
    writeFileSync(join(home, ".config/delegatus/phone-access"), "enabled\n");
    const protectedPID = startViewer(join(runtime, "bun/bin/bun"), join(runtime, "packages/node_modules/delegatus-cli/bin/cli.mjs"), { LLV_TOKEN: accessKey });
    original = protectedPID;
    await until("protected anonymous rejection", async () => (await http())?.status === 403);
    const authorized = await fetch(origin() + "/", { headers: { Authorization: `Bearer ${accessKey}` }, signal: AbortSignal.timeout(2000) });
    assert.equal(authorized.status, 200, "the saved key opens the protected Viewer");
    const instance = launch(home, ["-AppleLanguages", "(uk)", "-AppleInterfaceStyle", "Dark"], "protected-reuse-uk-dark");
    await until("protected saved-key reuse", () => processLog(instance).includes("STATE reused") && /WEB language=uk/.test(processLog(instance)), 60_000,
      () => `${instance.diagnostics()}\napp log:\n${processLog(instance) || "(empty)"}`);
    assert.equal(launcherPID(), original);
    await finishedPage(instance, "protected-reuse-uk-dark", () => `${instance.diagnostics()}\n${processLog(instance)}`);
    await end(instance);
  });
  for (const { language, appearance, size, args } of visualCases) await check(`recovery-${language}-${appearance}-${size}`, async () => {
    const instance = launch(home, [...args, "-AppleLanguages", `(${language})`, "-AppleInterfaceStyle", appearance], `recovery-${language}-${appearance}-${size}`);
    const recovery = () => `${instance.diagnostics()}\napp log:\n${processLog(instance) || "(empty)"}\n${listenerSnapshot()}`;
    await until("recovery app attaches", () => processLog(instance).includes("STATE reused"), 60_000, recovery);
    const runtime = runtimeOf(home);
    await stopAll();
    await until("monitor reports stopped", () => processLog(instance).includes("STATE stopped"), 90_000, recovery);
    startViewer(join(runtime, "bun/bin/bun"), join(runtime, "packages/node_modules/delegatus-cli/bin/cli.mjs"));
    await until("monitor restores the web view", async () => processLog(instance).includes("STATE recovered") && /WEB language=/.test(processLog(instance)) && (await http("GET", true))?.status === 200, 90_000, recovery);
    await sleep(4000); await end(instance);
  });
  await check("busy-port-setup", async () => {
    await stopAll();
    await until("port free", async () => !(await http()));
    const file = join(home, "listener.py");
    const foreignAuth = join(home, "foreign-auth-received");
    writeFileSync(file, 'import http.server,os\nopen(os.path.expanduser("~/listener.pid"),"w").write(str(os.getpid()))\nclass Handler(http.server.BaseHTTPRequestHandler):\n def refuse(self):\n  if self.headers.get("Authorization"): open(os.path.expanduser("~/foreign-auth-received"),"w").write("credential received")\n  self.send_response(401); self.end_headers()\n def do_GET(self): self.refuse()\n def do_HEAD(self): self.refuse()\n def log_message(self,*args): pass\nhttp.server.HTTPServer(("127.0.0.1",int(os.environ["SMOKE_PORT"])),Handler).serve_forever()\n');
    const listener = spawn("/usr/bin/python3", [file], { env: caseEnvironment(home, { SMOKE_PORT: String(port) }), stdio: "ignore" });
    listener.on("error", () => {});
    own(listener, "foreign listener");
    await until("foreign listener", async () => !!(await http()));
    assert.equal((await http("HEAD"))?.status, 401, "foreign listener exercises the app's HEAD authorization path");
    // /usr/bin/python3 can be a shim, so the listener names its own PID.
    await until("foreign listener PID", () => existsSync(join(home, "listener.pid")));
    const pid = Number(readFileSync(join(home, "listener.pid"), "utf8").trim());
    assert(Number.isSafeInteger(pid) && pid > 1); foreignListener = pid;
    cleanupPIDs.add(pid);
    for (const { language, appearance, size, args } of visualCases) {
      const instance = launch(home, [...args, "-AppleLanguages", `(${language})`, "-AppleInterfaceStyle", appearance], `busy-${language}-${appearance}-${size}`);
      await until("busy screen", () => processLog(instance).includes("STATE port-busy") && processLog(instance).includes(String(pid)), 60_000,
        () => `${instance.diagnostics()}\napp log:\n${processLog(instance) || "(empty)"}\n${listenerSnapshot()}`);
      assert.throws(launcherPID); assert(alive(pid), "foreign listener keeps the port");
      await sleep(900); await end(instance);
    }
    assert(!existsSync(foreignAuth), "foreign 401 listener never receives the saved key");
    process.kill(pid, "SIGTERM");
    await until("foreign listener exit", () => !alive(pid));
    foreignListener = 0;
    await end(listener);
  });
} catch (error) { exit = 1; console.error(redact(error.message)); }
finally {
  if (root) {
    writeFileSync(join(report, "app.log"), redact(homes.map(({ label, home: caseHome }) => {
      const text = appLogs(caseHome);
      return text ? `== ${label}\n${text}` : "";
    }).join("")));
  }
  if (exit !== 0) {
    try {
      // The unified log can exceed execFileSync's 1 MiB default buffer,
      // which ends the read with ENOBUFS and no stderr.
      const diagnostic = run("/usr/bin/log", ["show", "--last", "10m", "--style", "compact", "--predicate", 'process == "Delegatus" || eventMessage CONTAINS "Delegatus"'], { timeout: 120_000, maxBuffer: 256 * 1024 * 1024 });
      writeFileSync(join(report, "macos-diagnostics.log"), redact(diagnostic.slice(-200_000)));
    } catch (error) { writeFileSync(join(report, "macos-diagnostics.log"), redact(error.message)); }
    try {
      const crashDirectory = join(runnerHome, "Library/Logs/DiagnosticReports");
      const crashes = readdirSync(crashDirectory)
        .filter(name => name.startsWith("Delegatus-") && name.endsWith(".ips"))
        .map(name => join(crashDirectory, name))
        .filter(file => statSync(file).mtimeMs >= startedAt)
        .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
        .map(file => readFileSync(file, "utf8"));
      if (crashes.length) writeFileSync(join(report, "crash-reports.log"), redact(crashes.join("\n").slice(-200_000)));
    } catch { /* crash reports are optional on runners that use unified logging only */ }
  }
  // Observe all descendants still using this run's private files before any
  // shutdown. This is evidence only; it never grants permission to signal a PID.
  if (root) {
    try {
      const rows = run("/bin/ps", ["-ww", "-U", String(userInfo().uid), "-o", "pid=,command="]);
      for (const row of rows.split("\n")) if (comparablePath(row).includes(`${comparablePath(root)}/`)) {
        const pid = Number(row.trim().split(/\s+/)[0]);
        if (Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid) cleanupPIDs.add(pid);
      }
    } catch (error) { checks.push({ name: "cleanup-process-discovery", exit: 1, error: redact(error.message) }); exit = 1; }
  }
  if (foreignListener) { try { process.kill(foreignListener, "SIGTERM"); } catch { /* already exited */ } }
  for (const [pid, child] of owned) {
    try { await end(appEntries.get(pid) ?? child); }
    catch (error) { checks.push({ name: `cleanup-process-${pid}`, exit: 1, error: redact(error.message) }); exit = 1; }
  }
  if (home && existsSync(runtimeOf(home))) { try { await stopAll(); } catch { /* failed installation has no server */ } }
  try { await check("cleanup-evidence-filters", () => reapEvidenceFilters({ evidenceFilters, until, run, requireStopped: true })); }
  catch { exit = 1; }
  try { await check("cleanup-process-census", () => until("all recorded smoke processes exit", () => processCensus(cleanupPIDs).every(row => !row.running), 30_000)); }
  catch { exit = 1; }
  writeFileSync(join(report, "cleanup-processes.json"), JSON.stringify(processCensus(cleanupPIDs), null, 2));
  if (mount) { try { run("hdiutil", ["detach", mount]); } catch { exit = 1; } }
  try { resetSessionData(); } catch { /* the runner is discarded after the job */ }
  if (root) { try { rmSync(root, { recursive: true, force: true }); } catch { /* the runner is discarded after the job */ } }
  const frameNames = existsSync(join(report, "frames")) ? readdirSync(join(report, "frames"), { recursive: true }).filter(name => String(name).endsWith(".png")).map(String) : [];
  const frames = frameNames.length;
  const expectedEvidence = visualCases.flatMap(({ language, appearance, size }) => [
    `confirm-${language}-${appearance}-${size}`,
    `error-${language}-${appearance}-${size}`,
    `reuse-${language}-${appearance}-${size}`,
    `recovery-${language}-${appearance}-${size}`,
    `busy-${language}-${appearance}-${size}`,
    `surface-access-unavailable-${language}-${appearance}-${size}`,
  ]);
  for (const surface of surfaces) {
    expectedEvidence.push(...visualCases.map(({ language, appearance, size }) => `surface-${surface}-${language}-${appearance}-${size}`));
  }
  expectedEvidence.push(...legacyPageModes.flatMap(mode => ["en", "uk"].map(language => `legacy-${mode}-${language}`)));
  expectedEvidence.push(...["2.0.0", "99.0.0"].flatMap(version => ["relaunch", "not-found", "key-refused"].flatMap(mode =>
    ["en", "uk"].map(language => `relaunch-${version}-${mode}-${language}`))));
  expectedEvidence.push("protected-reuse-uk-dark");
  const missingEvidence = expectedEvidence.filter(label => !hasRenderedEvidence(frameNames, label));
  if (exit === 0 && missingEvidence.length) { checks.push({ name: "rendered-matrix", exit: 1, error: `Missing screenshots: ${missingEvidence.join(", ")}` }); exit = 1; }
  writeFileSync(join(report, "report.json"), redact(JSON.stringify({ exit, passed: checks.filter(c => c.exit === 0).length, failed: checks.filter(c => c.exit !== 0).length, frames, session, checks, commands }, null, 2)));
  console.log(`macOS smoke: exit=${exit}, passed=${checks.filter(c => c.exit === 0).length}, failed=${checks.filter(c => c.exit !== 0).length}, frames=${frames}`);
}
process.exitCode = exit;
