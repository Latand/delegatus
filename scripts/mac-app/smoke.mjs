// One driver for the native launcher. Runs only on disposable macOS CI machines.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { intelIsTranslated } from "./smoke-platform.mjs";

const [image, reportArg] = process.argv.slice(2);
if (process.platform !== "darwin" || !image || !reportArg || process.env.CI !== "true") throw new Error("Usage on disposable macOS CI: node smoke.mjs DMG REPORT");
const report = resolve(reportArg);
mkdirSync(report, { recursive: true });
const startedAt = Date.now();
const checks = [];
const commands = [];
let home = "";
const user = "dlgsmoke";
let created = false;
let mount;
const owned = new Set();
let serial = 0;
const surfaces = ["install", "installing", "cancelling", "menu", "stop", "login", "update", "quit"];
const visualCases = [
  ...["en", "uk"].flatMap(language => ["Light", "Dark"].flatMap(appearance => [
    ["minimum", ["--evidence-minimum-size"]], ["intermediate", ["--evidence-intermediate-size"]], ["default", []]
  ].map(([size, args]) => ({ language, appearance, size, args }))))
];
let accountPassphrase = "";
const accessKey = randomBytes(16).toString("hex");
function redact(value) {
  return String(value).replaceAll(accountPassphrase || "\0", "[redacted]").replaceAll(home || "\0", "$HOME")
    .replaceAll(process.env.HOME || "\0", "$RUNNER_HOME")
    .replace(/([?&]k=|Bearer )[A-Za-z0-9%._~-]+/gi, "$1[redacted]")
    .replace(/\b[0-9a-f]{32}\b/g, "[redacted]");
}
function run(command, args, options = {}) {
  let status = 0;
  try { return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180_000, ...options }); }
  catch (error) { status = error.status ?? 1; throw new Error(`${command} exited ${status}: ${redact(error.stderr ?? error.message)}`); }
  finally { commands.push({ command: redact([command, ...args].join(" ")), exit: status }); }
}
const sudo = args => run("sudo", ["-n", ...args]);
function asUser(command, args = [], options = {}) {
  return sudo(["-u", user, "-H", "/usr/bin/env", "-i", `HOME=${home}`, `USER=${user}`, `LOGNAME=${user}`, "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "DELEGATUS_TELEMETRY=0", command, ...args], options);
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
function logs() {
  try { return asUser("/bin/sh", ["-c", 'cat "$HOME"/Library/Logs/Delegatus/app-*.log']); } catch { return ""; }
}
function processLog(pid) {
  try { return asUser("/bin/sh", ["-c", 'cat "$HOME"/Library/Logs/Delegatus/app-*-' + Number(pid) + '.log']); } catch { return ""; }
}
function capturedFrames(directory) {
  try { return asUser("/usr/bin/find", [directory, "-type", "f", "-name", "*.png"]).trim().split("\n").filter(Boolean).length; } catch { return 0; }
}
function launch(args, label) {
  const pidFile = join(home, `app-${++serial}.pid`);
  const frames = join(home, "Library", "Evidence", label);
  const process = spawn("sudo", ["-n", "-u", user, "-H", "/usr/bin/env", "-i", `HOME=${home}`, `USER=${user}`, `LOGNAME=${user}`, "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "DELEGATUS_TELEMETRY=0", "/bin/sh", "-c", 'echo $$ > "$1"; shift; exec "$@"', "sh", pidFile,
    join(home, "Applications", "Delegatus.app", "Contents", "MacOS", "Delegatus"), "--evidence-dir", frames, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", exitCode = null, signal = null, spawnError = null;
  const append = (current, chunk) => (current + redact(chunk.toString("utf8"))).slice(-12_000);
  process.stdout.on("data", chunk => { stdout = append(stdout, chunk); });
  process.stderr.on("data", chunk => { stderr = append(stderr, chunk); });
  process.on("error", error => { spawnError = redact(error.message); });
  process.on("exit", (code, endedBy) => { exitCode = code; signal = endedBy; });
  const diagnostics = () => `app launch exit=${exitCode ?? "running"} signal=${signal ?? "none"}${spawnError ? ` spawnError=${spawnError}` : ""}\nstdout:\n${stdout || "(empty)"}\nstderr:\n${stderr || "(empty)"}`;
  return { process, pidFile, frames, diagnostics };
}
async function startViewer(bun, cli, extraEnvironment = {}) {
  const pidFile = join(home, `viewer-${++serial}.pid`);
  const args = ["-n", "-u", user, "-H", "/usr/bin/env", "-i", `HOME=${home}`, `USER=${user}`, `LOGNAME=${user}`, "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "DELEGATUS_TELEMETRY=0", ...Object.entries(extraEnvironment).map(([key, value]) => `${key}=${value}`), "/bin/sh", "-c", 'echo $$ > "$1"; shift; exec "$@"', "sh", pidFile, bun, cli, "--no-open", "--port", "8898"];
  const child = spawn("sudo", args, { stdio: "ignore" });
  child.on("error", error => { throw error; });
  commands.push({ command: redact(["sudo", ...args].join(" ")), exit: "started" });
  await until("replacement Delegatus PID", () => existsSync(pidFile) || (() => { try { sudo(["test", "-f", pidFile]); return true; } catch { return false; } })());
  const pid = Number(sudo(["cat", pidFile]).trim());
  assert(Number.isSafeInteger(pid) && pid > 1); owned.add(pid);
  return pid;
}
async function register(app) {
  await until("app PID", () => existsSync(app.pidFile) || (() => { try { sudo(["test", "-f", app.pidFile]); return true; } catch { return false; } })(), 60_000, app.diagnostics);
  app.pid = Number(sudo(["cat", app.pidFile]).trim());
  assert(Number.isSafeInteger(app.pid) && app.pid > 1); owned.add(app.pid);
  return app;
}
async function end(app) {
  if (!app?.pid || !owned.has(app.pid)) return;
  sudo(["kill", "-TERM", String(app.pid)]);
  await until("owned app exit", () => { try { sudo(["kill", "-0", String(app.pid)]); return false; } catch { return true; } });
  owned.delete(app.pid);
}
async function http(method = "GET", authorized = false) {
  try { return await fetch("http://127.0.0.1:8898" + (method === "HEAD" ? "/api/onboarding/diagnostics" : "/"), { method, headers: authorized ? { Authorization: `Bearer ${accessKey}` } : {}, signal: AbortSignal.timeout(2000) }); } catch { return null; }
}
function launcherPID() {
  const processes = asUser("/bin/ps", ["-u", user, "-o", "pid=,command="]);
  const root = join(home, "Library/Application Support/Delegatus/Runtime");
  const row = processes.split("\n").find(line => line.includes(join(root, "bun/bin/bun")) && line.includes(join(root, "packages/node_modules/delegatus-cli/bin/cli.mjs")) && !line.includes("stop --all"));
  assert(row, "private launcher belongs to the fresh account"); return Number(row.trim().split(/\s+/)[0]);
}
function seedInstalledRelease(runtime) {
  const packageRoot = join(runtime, "packages/node_modules/delegatus-cli");
  const installId = createHash("sha256").update(resolve(packageRoot)).digest("hex").slice(0, 16);
  const sourceManifest = JSON.parse(asUser("/bin/cat", [join(packageRoot, "package.json")]));
  const releaseVersion = sourceManifest.version.replace(/(\d+)$/, (_, patch) => String(Number(patch) + 1));
  const release = join(home, ".cache/delegatus/self-update", installId, "releases", `npm-${releaseVersion}`, "node_modules/delegatus-cli");
  asUser("/bin/mkdir", ["-p", join(release, "dist")]);
  asUser("/bin/ln", ["-s", join(packageRoot, "dist/standalone"), join(release, "dist/standalone")]);
  asUser("/bin/ln", ["-s", join(packageRoot, "dist/runtime-host.mjs"), join(release, "dist/runtime-host.mjs")]);
  sourceManifest.version = releaseVersion;
  asUser("/usr/bin/tee", [join(release, "package.json")], { input: `${JSON.stringify(sourceManifest)}\n` });
  const pointer = {
    kind: "package", version: releaseVersion, sha: randomBytes(20).toString("hex"),
    baseVersion: JSON.parse(asUser("/bin/cat", [join(packageRoot, "package.json")])).version, dir: release,
  };
  const pointerFile = join(home, ".config/delegatus/state/self-update", `release-${installId}.json`);
  asUser("/bin/mkdir", ["-p", join(home, ".config/delegatus/state/self-update")]);
  asUser("/usr/bin/tee", [pointerFile], { input: `${JSON.stringify(pointer)}\n` });
  assert(asUser("/bin/test", ["-f", join(release, "dist/standalone/server.js")]) !== undefined, "updated release contains its Viewer");
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
  await check("fresh-account", () => {
    try { run("id", [user]); } catch { /* expected absent */ }
    assert.throws(() => execFileSync("id", [user], { stdio: "ignore" }));
    accountPassphrase = randomBytes(36).toString("base64url");
    sudo(["sysadminctl", "-addUser", user, "-fullName", "Launcher smoke", "-password", accountPassphrase]);
    created = true;
    sudo(["createhomedir", "-c", "-u", user]);
    home = sudo(["dscl", ".", "-read", `/Users/${user}`, "NFSHomeDirectory"]).trim().replace(/^NFSHomeDirectory:\s*/, "");
    assert(home.startsWith("/"));
    assert(!sudo(["id", "-Gn", user]).split(/\s+/).includes("admin"));
  });
  await check("drag-install", () => {
    const plist = run("hdiutil", ["attach", "-readonly", "-nobrowse", "-plist", resolve(image)]);
    const file = join(report, "mount.plist"); writeFileSync(file, plist);
    const parsed = JSON.parse(run("plutil", ["-convert", "json", "-o", "-", file]));
    mount = parsed["system-entities"].find(entry => entry["mount-point"])?.["mount-point"];
    assert(mount);
    asUser("/bin/mkdir", ["-p", join(home, "Applications")]);
    asUser("/usr/bin/ditto", [join(mount, "Delegatus.app"), join(home, "Applications", "Delegatus.app")]);
  });
  const tokenPath = join(home, ".config", "delegatus", "token");
  asUser("/bin/mkdir", ["-p", join(home, ".config", "delegatus")]);
  asUser("/usr/bin/tee", [tokenPath], { input: `${accessKey}\n` });
  asUser("/bin/chmod", ["600", tokenPath]);
  asUser("/bin/chmod", ["700", join(home, ".config", "delegatus")]);
  const before = asUser("/bin/ls", ["-A", home]).trim().split("\n");
  await check("confirm-without-install", async () => {
    const app = await register(launch(["--evidence-minimum-size", "-AppleLanguages", "(en)"], "confirm-en-light-minimum"));
    await until("confirmation", () => processLog(app.pid).includes("STATE needs-install"), 60_000, app.diagnostics);
    await sleep(20_000);
    assert.throws(() => asUser("/bin/test", ["-e", join(home, "Library/Application Support/Delegatus/Runtime")]));
    await end(app);
  });
  for (const surface of surfaces) {
    for (const { language, appearance, size, args } of visualCases) await check(`surface-${surface}-${language}-${appearance}-${size}`, async () => {
      const frames = join(home, "Library", "Evidence", `surface-${surface}-${language}-${appearance}-${size}`);
      const app = await register(launch([...args, "--evidence-surface", surface, "-AppleLanguages", `(${language})`, "-AppleInterfaceStyle", appearance], `surface-${surface}-${language}-${appearance}-${size}`));
      await until(`render ${surface}`, () => {
        const log = processLog(app.pid);
        if (!log.includes(`SURFACE ${surface}`) || capturedFrames(frames) === 0) return false;
        if (["menu", "stop", "login", "update", "quit"].includes(surface)) {
          const name = surface === "menu" ? "menu" : `dialog-${surface}`;
          return log.includes(`CAPTURED ${name}`) && log.includes(`SURFACE-CLOSED ${surface}`);
        }
        return true;
      }, 60_000, app.diagnostics);
      await end(app);
    });
  }
  for (const item of visualCases) {
    const { language, appearance, size, args } = item;
    if (language === "en" && appearance === "Light" && size === "minimum") continue;
    await check(`confirmation-${language}-${appearance}-${size}`, async () => {
      const app = await register(launch([...args, "-AppleLanguages", `(${language})`, "-AppleInterfaceStyle", appearance], `confirm-${language}-${appearance}-${size}`));
      await until("localized confirmation", () => processLog(app.pid).includes("STATE needs-install"), 60_000, app.diagnostics);
      await sleep(1200); await end(app);
    });
  }
  for (const { language, appearance, size, args } of visualCases) await check(`error-${language}-${appearance}-${size}`, async () => {
    const app = await register(launch([...args, "--evidence-error", "-AppleLanguages", `(${language})`, "-AppleInterfaceStyle", appearance], `error-${language}-${appearance}-${size}`));
    await until("localized error screen", () => processLog(app.pid).includes("STATE failed"), 60_000, app.diagnostics);
    await sleep(900); await end(app);
  });
  let original;
  await check("first-run-http-200", async () => {
    const app = await register(launch(["--accept-install", "-AppleLanguages", "(en)"], "first-en-light"));
    await until("HTTP 200", async () => (await http())?.status === 200, 720_000);
    const head = await http("HEAD"); assert.equal(head?.status, 204); assert.equal(head?.headers.get("x-delegatus-diagnostics"), "1");
    await until("ready and web language", () => logs().includes("STATE ready") && /WEB language=en/.test(logs()));
    original = launcherPID();
    const after = asUser("/bin/ls", ["-A", home]).trim().split("\n");
    for (const entry of after.filter(entry => !before.includes(entry))) assert(["Library", ".config", ".cache"].includes(entry) || /^app-\d+\.pid$/.test(entry), `unexpected home entry ${entry}`);
    await sleep(4000); await end(app);
    assert.equal((await http())?.status, 200, "server survives app exit");
  });
  for (const { language, appearance, size, args } of visualCases) {
    await check(`reuse-${language}-${appearance}-${size}`, async () => {
      const app = await register(launch([...args, "-AppleLanguages", `(${language})`, "-AppleInterfaceStyle", appearance], `reuse-${language}-${appearance}-${size}`));
      await until("reuse and language", () => { const output = processLog(app.pid); return output.includes("STATE reused") && new RegExp(`WEB language=${language}`).test(output); });
      assert.equal(launcherPID(), original); await sleep(900); await end(app);
    });
  }
  await check("protected-reuse-and-refusal", async () => {
    const runtime = join(home, "Library/Application Support/Delegatus/Runtime");
    await asUser(join(runtime, "bun/bin/bun"), [join(runtime, "packages/node_modules/delegatus-cli/bin/cli.mjs"), "stop", "--all"]);
    await until("port free before protected server", async () => !(await http()));
    seedInstalledRelease(runtime);
    asUser("/usr/bin/tee", [join(home, ".config/delegatus/phone-access")], { input: "enabled\n" });
    const protectedPID = await startViewer(join(runtime, "bun/bin/bun"), join(runtime, "packages/node_modules/delegatus-cli/bin/cli.mjs"), { LLV_TOKEN: accessKey });
    original = protectedPID;
    await until("protected anonymous rejection", async () => (await http())?.status === 403);
    const authorized = await fetch("http://127.0.0.1:8898/", { headers: { Authorization: `Bearer ${accessKey}` }, signal: AbortSignal.timeout(2000) });
    assert.equal(authorized.status, 200, "the saved key opens the protected Viewer");
    const app = await register(launch(["-AppleLanguages", "(uk)", "-AppleInterfaceStyle", "Dark"], "protected-reuse-uk-dark"));
    await until("protected saved-key reuse", () => processLog(app.pid).includes("STATE reused") && /WEB language=uk/.test(processLog(app.pid)), 60_000,
      () => `${app.diagnostics()}\napp log:\n${processLog(app.pid) || "(empty)"}`);
    assert.equal(launcherPID(), original);
    await sleep(900); await end(app);
  });
  for (const { language, appearance, size, args } of visualCases) await check(`recovery-${language}-${appearance}-${size}`, async () => {
    const app = await register(launch([...args, "-AppleLanguages", `(${language})`, "-AppleInterfaceStyle", appearance], `recovery-${language}-${appearance}-${size}`));
    await until("recovery app attaches", () => processLog(app.pid).includes("STATE reused"), 60_000, app.diagnostics);
    const runtime = join(home, "Library/Application Support/Delegatus/Runtime");
    asUser(join(runtime, "bun/bin/bun"), [join(runtime, "packages/node_modules/delegatus-cli/bin/cli.mjs"), "stop", "--all"]);
    await until("monitor reports stopped", () => processLog(app.pid).includes("STATE stopped"), 90_000, app.diagnostics);
    await startViewer(join(runtime, "bun/bin/bun"), join(runtime, "packages/node_modules/delegatus-cli/bin/cli.mjs"));
    await until("monitor restores the web view", async () => processLog(app.pid).includes("STATE recovered") && /WEB language=/.test(processLog(app.pid)) && (await http("GET", true))?.status === 200, 90_000, app.diagnostics);
    await sleep(4000); await end(app);
  });
  await check("busy-port-setup", async () => {
    const runtime = join(home, "Library/Application Support/Delegatus/Runtime");
    asUser(join(runtime, "bun/bin/bun"), [join(runtime, "packages/node_modules/delegatus-cli/bin/cli.mjs"), "stop", "--all"]);
    await until("port free", async () => !(await http()));
    const file = join(home, "listener.py");
    const foreignAuth = join(home, "foreign-auth-received");
    run("sudo", ["-n", "-u", user, "tee", file], { input: 'import http.server,os\nopen(os.path.expanduser("~/listener.pid"),"w").write(str(os.getpid()))\nclass Handler(http.server.BaseHTTPRequestHandler):\n def refuse(self):\n  if self.headers.get("Authorization"): open(os.path.expanduser("~/foreign-auth-received"),"w").write("credential received")\n  self.send_response(401); self.end_headers()\n def do_GET(self): self.refuse()\n def do_HEAD(self): self.refuse()\n def log_message(self,*args): pass\nhttp.server.HTTPServer(("127.0.0.1",8898),Handler).serve_forever()\n' });
    const listener = spawn("sudo", ["-n", "-u", user, "-H", "/usr/bin/env", `HOME=${home}`, "/usr/bin/python3", file], { stdio: "ignore" });
    listener.on("error", () => {});
    await until("foreign listener", async () => !!(await http()));
    assert.equal((await http("HEAD"))?.status, 401, "foreign listener exercises the app's HEAD authorization path");
    const pid = Number(sudo(["cat", join(home, "listener.pid")]).trim()); owned.add(pid);
    for (const { language, appearance, size, args } of visualCases) {
      const app = await register(launch([...args, "-AppleLanguages", `(${language})`, "-AppleInterfaceStyle", appearance], `busy-${language}-${appearance}-${size}`));
      await until("busy screen", () => processLog(app.pid).includes("STATE port-busy") && processLog(app.pid).includes(String(pid)));
      assert.throws(launcherPID); sudo(["kill", "-0", String(pid)]);
      await sleep(900); await end(app);
    }
    assert.throws(() => asUser("/bin/test", ["-e", foreignAuth]), "foreign 401 listener never receives the saved key");
    sudo(["kill", "-TERM", String(pid)]); owned.delete(pid);
  });
} catch (error) { exit = 1; console.error(redact(error.message)); }
finally {
  if (created) {
    writeFileSync(join(report, "app.log"), redact(logs()));
    if (exit !== 0) {
      try {
        const diagnostic = run("/usr/bin/log", ["show", "--last", "5m", "--style", "compact", "--predicate", 'process == "Delegatus" || eventMessage CONTAINS "Delegatus"'], { timeout: 60_000 });
        writeFileSync(join(report, "macos-diagnostics.log"), redact(diagnostic.slice(-200_000)));
      } catch (error) { writeFileSync(join(report, "macos-diagnostics.log"), redact(error.message)); }
      try {
        const crashDirectory = join(process.env.HOME, "Library/Logs/DiagnosticReports");
        const crashes = readdirSync(crashDirectory)
          .filter(name => name.startsWith("Delegatus-") && name.endsWith(".ips"))
          .map(name => join(crashDirectory, name))
          .filter(file => statSync(file).mtimeMs >= startedAt)
          .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
          .map(file => readFileSync(file, "utf8"));
        if (crashes.length) writeFileSync(join(report, "crash-reports.log"), redact(crashes.join("\n").slice(-200_000)));
      } catch { /* crash reports are optional on runners that use unified logging only */ }
    }
    for (const pid of owned) { try { sudo(["kill", "-TERM", String(pid)]); } catch { /* already exited */ } }
    try {
      const runtime = join(home, "Library/Application Support/Delegatus/Runtime");
      asUser(join(runtime, "bun/bin/bun"), [join(runtime, "packages/node_modules/delegatus-cli/bin/cli.mjs"), "stop", "--all"]);
    } catch { /* failed installation has no server */ }
    try { sudo(["ditto", join(home, "Library/Evidence"), join(report, "frames")]); sudo(["chmod", "-R", "a+rX", join(report, "frames")]); } catch { /* retain failure report */ }
    try { sudo(["sysadminctl", "-deleteUser", user]); } catch { exit = 1; }
  }
  if (mount) { try { run("hdiutil", ["detach", mount]); } catch { exit = 1; } }
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
  writeFileSync(join(report, "report.json"), redact(JSON.stringify({ exit, passed: checks.filter(c => c.exit === 0).length, failed: checks.filter(c => c.exit !== 0).length, frames, checks, commands }, null, 2)));
  console.log(`macOS smoke: exit=${exit}, passed=${checks.filter(c => c.exit === 0).length}, failed=${checks.filter(c => c.exit !== 0).length}, frames=${frames}`);
}
process.exitCode = exit;
