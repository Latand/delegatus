// One driver for the native launcher. Runs only on disposable macOS CI machines.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readdirSync, readFileSync, statSync, rmSync, symlinkSync } from "node:fs";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { appSessionData, comparablePath, commandFailure, intelIsTranslated, runCommand, smokeEnvironment, smokeStdio } from "./smoke-platform.mjs";

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
const homes = [];
let mount;
const owned = new Map();
// Launchers this driver started itself; `stop --all` must see them reaped.
const replacements = new Set();
const surfaces = ["install", "installing", "cancelling", "menu", "stop", "login", "update", "quit"];
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
async function inHome(caseHome, command, args = []) {
  let status = 0;
  try { return await runCommand(command, args, { env: smokeEnvironment({ user, home: caseHome }) }); }
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
function appLogs(caseHome, pid) {
  const directory = join(caseHome, "Library/Logs/Delegatus");
  try {
    return readdirSync(directory).filter(name => name.startsWith("app-") && name.endsWith(pid === undefined ? ".log" : `-${Number(pid)}.log`)).sort()
      .map(name => readFileSync(join(directory, name), "utf8")).join("");
  } catch { return ""; }
}
const processLog = app => appLogs(app.home, app.pid);
function capturedFrames(directory) {
  try { return readdirSync(directory).filter(name => name.endsWith(".png")).length; } catch { return 0; }
}
function exited(child) { return child.exitCode !== null || child.signalCode !== null; }
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
let foreignListener = 0;
function own(child, label) {
  assert(Number.isSafeInteger(child.pid) && child.pid > 1, `${label} started`);
  owned.set(child.pid, child);
  return child.pid;
}
function launch(caseHome, args, label) {
  resetSessionData();
  const frames = join(report, "frames", label);
  const child = spawn(app, ["--evidence-dir", frames, "-ApplePersistenceIgnoreState", "YES", ...args],
    { env: smokeEnvironment({ user, home: caseHome }), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", spawnError = null;
  const append = (current, chunk) => (current + redact(chunk.toString("utf8"))).slice(-12_000);
  child.stdout.on("data", chunk => { stdout = append(stdout, chunk); });
  child.stderr.on("data", chunk => { stderr = append(stderr, chunk); });
  child.on("error", error => { spawnError = redact(error.message); });
  const diagnostics = () => `app launch exit=${child.exitCode ?? "running"} signal=${child.signalCode ?? "none"}${spawnError ? ` spawnError=${spawnError}` : ""}\nstdout:\n${stdout || "(empty)"}\nstderr:\n${stderr || "(empty)"}`;
  const pid = own(child, `app ${label}`);
  return { process: child, pid, home: caseHome, frames, diagnostics };
}
async function end(entry) {
  const child = owned.get(entry?.pid);
  if (!child) return;
  if (!exited(child)) child.kill("SIGTERM");
  await until("owned process exit", () => exited(child));
  owned.delete(entry.pid);
}
function startViewer(bun, cli, settings = {}) {
  const child = spawn(bun, [cli, "--no-open", "--port", "8898"], { env: smokeEnvironment({ user, home }, settings), stdio: "ignore" });
  child.on("error", () => {});
  commands.push({ command: redact([bun, cli, "--no-open", "--port", "8898"].join(" ")), exit: "started" });
  const pid = own(child, "replacement Delegatus");
  replacements.add(pid);
  return pid;
}
async function http(method = "GET", authorized = false) {
  try { return await fetch("http://127.0.0.1:8898" + (method === "HEAD" ? "/api/onboarding/diagnostics" : "/"), { method, headers: authorized ? { Authorization: `Bearer ${accessKey}` } : {}, signal: AbortSignal.timeout(2000) }); } catch { return null; }
}
const runtimeOf = caseHome => join(caseHome, "Library/Application Support/Delegatus/Runtime");
function launcherPID() {
  const processes = run("/bin/ps", ["-U", String(userInfo().uid), "-o", "pid=,command="]);
  const runtime = runtimeOf(home);
  const bun = comparablePath(join(runtime, "bun/bin/bun")), cli = comparablePath(join(runtime, "packages/node_modules/delegatus-cli/bin/cli.mjs"));
  const row = processes.split("\n").map(comparablePath).find(line => line.includes(bun) && line.includes(cli) && !line.includes("stop --all"));
  assert(row, "the launcher runs from this run's private runtime"); return Number(row.trim().split(/\s+/)[0]);
}
// What the app's listener check reads: who holds the port and the process
// chain above it. Diagnostics only; a failed read is recorded, never thrown.
function listenerSnapshot() {
  const read = (command, args) => { try { return run(command, args, { timeout: 20_000 }); } catch (error) { return error.message; } };
  const listing = read("/usr/sbin/lsof", ["-nP", "-a", "-iTCP:8898", "-sTCP:LISTEN", "-Fpcu"]);
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
  await check("runner-session-fresh-data", () => {
    // The hosted runner has one graphical session, the runner user's. The app
    // runs there; a fresh data root per run and a fresh home per case replace
    // a second operating-system account, which has no window-server access.
    assert(userInfo().uid > 0, "the smoke runs as the unprivileged runner user");
    session.manager = run("/bin/launchctl", ["managername"]).trim();
    session.bootstrap = run("/bin/launchctl", ["manageruid"]).trim() === String(userInfo().uid) ? "runner" : "other";
    root = mkdtempSync("/private/tmp/dlg-");
    home = freshHome("installed");
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
    await until("HTTP 200", async () => (await http())?.status === 200, 720_000, () => `${instance.diagnostics()}\napp log:\n${processLog(instance) || "(empty)"}`);
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
    original = launcherPID();
    for (const entry of readdirSync(home).filter(entry => !before.includes(entry))) assert(["Library", ".config", ".cache"].includes(entry), `unexpected home entry ${entry}`);
    await sleep(4000); await end(instance);
    assert.equal((await http())?.status, 200, "server survives app exit");
  });
  for (const { language, appearance, size, args } of visualCases) {
    await check(`reuse-${language}-${appearance}-${size}`, async () => {
      const instance = launch(home, [...args, "-AppleLanguages", `(${language})`, "-AppleInterfaceStyle", appearance], `reuse-${language}-${appearance}-${size}`);
      await until("reuse and language", () => { const output = processLog(instance); return output.includes("STATE reused") && new RegExp(`WEB language=${language}`).test(output); }, 60_000,
        () => `${instance.diagnostics()}\napp log:\n${processLog(instance) || "(empty)"}\n${listenerSnapshot()}`);
      assert.equal(launcherPID(), original); await sleep(900); await end(instance);
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
    const authorized = await fetch("http://127.0.0.1:8898/", { headers: { Authorization: `Bearer ${accessKey}` }, signal: AbortSignal.timeout(2000) });
    assert.equal(authorized.status, 200, "the saved key opens the protected Viewer");
    const instance = launch(home, ["-AppleLanguages", "(uk)", "-AppleInterfaceStyle", "Dark"], "protected-reuse-uk-dark");
    await until("protected saved-key reuse", () => processLog(instance).includes("STATE reused") && /WEB language=uk/.test(processLog(instance)), 60_000,
      () => `${instance.diagnostics()}\napp log:\n${processLog(instance) || "(empty)"}`);
    assert.equal(launcherPID(), original);
    await sleep(900); await end(instance);
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
    writeFileSync(file, 'import http.server,os\nopen(os.path.expanduser("~/listener.pid"),"w").write(str(os.getpid()))\nclass Handler(http.server.BaseHTTPRequestHandler):\n def refuse(self):\n  if self.headers.get("Authorization"): open(os.path.expanduser("~/foreign-auth-received"),"w").write("credential received")\n  self.send_response(401); self.end_headers()\n def do_GET(self): self.refuse()\n def do_HEAD(self): self.refuse()\n def log_message(self,*args): pass\nhttp.server.HTTPServer(("127.0.0.1",8898),Handler).serve_forever()\n');
    const listener = spawn("/usr/bin/python3", [file], { env: smokeEnvironment({ user, home }), stdio: "ignore" });
    listener.on("error", () => {});
    own(listener, "foreign listener");
    await until("foreign listener", async () => !!(await http()));
    assert.equal((await http("HEAD"))?.status, 401, "foreign listener exercises the app's HEAD authorization path");
    // /usr/bin/python3 can be a shim, so the listener names its own PID.
    await until("foreign listener PID", () => existsSync(join(home, "listener.pid")));
    const pid = Number(readFileSync(join(home, "listener.pid"), "utf8").trim());
    assert(Number.isSafeInteger(pid) && pid > 1); foreignListener = pid;
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
  if (foreignListener) { try { process.kill(foreignListener, "SIGTERM"); } catch { /* already exited */ } }
  for (const child of owned.values()) { if (!exited(child)) child.kill("SIGTERM"); }
  if (home && existsSync(runtimeOf(home))) { try { await stopAll(); } catch { /* failed installation has no server */ } }
  for (const [pid, child] of owned) {
    try { await until("owned process exit", () => exited(child), 10_000); }
    catch { commands.push({ command: `owned process ${pid} after SIGTERM`, exit: "running" }); }
  }
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
  ]);
  for (const surface of surfaces) {
    expectedEvidence.push(...visualCases.map(({ language, appearance, size }) => `surface-${surface}-${language}-${appearance}-${size}`));
  }
  const missingEvidence = expectedEvidence.filter(label => !frameNames.some(name => name.toLowerCase().includes(label.toLowerCase())));
  if (exit === 0 && missingEvidence.length) { checks.push({ name: "rendered-matrix", exit: 1, error: `Missing screenshots: ${missingEvidence.join(", ")}` }); exit = 1; }
  writeFileSync(join(report, "report.json"), redact(JSON.stringify({ exit, passed: checks.filter(c => c.exit === 0).length, failed: checks.filter(c => c.exit !== 0).length, frames, session, checks, commands }, null, 2)));
  console.log(`macOS smoke: exit=${exit}, passed=${checks.filter(c => c.exit === 0).length}, failed=${checks.filter(c => c.exit !== 0).length}, frames=${frames}`);
}
process.exitCode = exit;
