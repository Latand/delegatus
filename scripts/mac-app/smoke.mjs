// One driver for the native launcher. Runs only on disposable macOS CI machines.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";

const [image, reportArg] = process.argv.slice(2);
if (process.platform !== "darwin" || !image || !reportArg || process.env.CI !== "true") throw new Error("Usage on disposable macOS CI: node smoke.mjs DMG REPORT");
const report = resolve(reportArg);
mkdirSync(report, { recursive: true });
const checks = [];
const commands = [];
let home = "";
const user = "dlgsmoke";
let created = false;
let mount;
const owned = new Set();
let serial = 0;
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
async function startViewer(bun, cli) {
  const pidFile = join(home, `viewer-${++serial}.pid`);
  const args = ["-n", "-u", user, "-H", "/usr/bin/env", "-i", `HOME=${home}`, `USER=${user}`, `LOGNAME=${user}`, "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "DELEGATUS_TELEMETRY=0", "/bin/sh", "-c", 'echo $$ > "$1"; shift; exec "$@"', "sh", pidFile, bun, cli, "--no-open", "--port", "8898"];
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
async function http(method = "GET") {
  try { return await fetch("http://127.0.0.1:8898" + (method === "HEAD" ? "/api/onboarding/diagnostics" : "/"), { method, signal: AbortSignal.timeout(2000) }); } catch { return null; }
}
function launcherPID() {
  const processes = asUser("/bin/ps", ["-u", user, "-o", "pid=,command="]);
  const root = join(home, "Library/Application Support/Delegatus/Runtime");
  const row = processes.split("\n").find(line => line.includes(join(root, "bun/bin/bun")) && line.includes(join(root, "packages/node_modules/delegatus-cli/bin/cli.mjs")) && !line.includes("stop --all"));
  assert(row, "private launcher belongs to the fresh account"); return Number(row.trim().split(/\s+/)[0]);
}
let exit = 0;
try {
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
    await until("confirmation", () => logs().includes("STATE needs-install"), 60_000, app.diagnostics);
    await sleep(20_000);
    assert.throws(() => asUser("/bin/test", ["-e", join(home, "Library/Application Support/Delegatus/Runtime")]));
    await end(app);
  });
  for (const [language, appearance] of [["en", "Dark"], ["uk", "Light"], ["uk", "Dark"]]) {
    await check(`confirmation-${language}-${appearance}`, async () => {
      const previous = logs().length;
      const app = await register(launch(["-AppleLanguages", `(${language})`, "-AppleInterfaceStyle", appearance], `confirm-${language}-${appearance}-default`));
      await until("localized confirmation", () => logs().slice(previous).includes("STATE needs-install"), 60_000, app.diagnostics);
      await sleep(1200); await end(app);
    });
  }
  await check("error-surface", async () => {
    const previous = logs().length;
    const app = await register(launch(["--evidence-error", "-AppleLanguages", "(en)", "-AppleInterfaceStyle", "Dark"], "error-en-dark-default"));
    await until("localized error screen", () => logs().slice(previous).includes("STATE failed"), 60_000, app.diagnostics);
    await sleep(1200); await end(app);
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
  for (const language of ["en", "uk"]) for (const appearance of ["Light", "Dark"]) {
    await check(`reuse-${language}-${appearance}`, async () => {
      const previous = logs().length;
      const app = await register(launch(["-AppleLanguages", `(${language})`, "-AppleInterfaceStyle", appearance], `reuse-${language}-${appearance}`));
      await until("reuse and language", () => { const tail = logs().slice(previous); return tail.includes("STATE reused") && new RegExp(`WEB language=${language}`).test(tail); });
      assert.equal(launcherPID(), original); await sleep(4000); await end(app);
    });
  }
  await check("transient-restart-recovers", async () => {
    const previous = logs().length;
    const app = await register(launch(["-AppleLanguages", "(uk)", "-AppleInterfaceStyle", "Dark"], "recovery-uk-dark"));
    await until("recovery app attaches", () => logs().slice(previous).includes("STATE reused"), 60_000, app.diagnostics);
    const runtime = join(home, "Library/Application Support/Delegatus/Runtime");
    asUser(join(runtime, "bun/bin/bun"), [join(runtime, "packages/node_modules/delegatus-cli/bin/cli.mjs"), "stop", "--all"]);
    await until("monitor reports stopped", () => logs().slice(previous).includes("STATE stopped"), 90_000, app.diagnostics);
    await startViewer(join(runtime, "bun/bin/bun"), join(runtime, "packages/node_modules/delegatus-cli/bin/cli.mjs"));
    await until("monitor restores the web view", async () => logs().slice(previous).includes("STATE recovered") && (await http())?.status === 200, 90_000, app.diagnostics);
    await sleep(1200); await end(app);
  });
  await check("busy-port", async () => {
    const runtime = join(home, "Library/Application Support/Delegatus/Runtime");
    asUser(join(runtime, "bun/bin/bun"), [join(runtime, "packages/node_modules/delegatus-cli/bin/cli.mjs"), "stop", "--all"]);
    await until("port free", async () => !(await http()));
    const file = join(home, "listener.py");
    run("sudo", ["-n", "-u", user, "tee", file], { input: 'import http.server,os\nopen(os.path.expanduser("~/listener.pid"),"w").write(str(os.getpid()))\nhttp.server.HTTPServer(("127.0.0.1",8898),http.server.SimpleHTTPRequestHandler).serve_forever()\n' });
    const listener = spawn("sudo", ["-n", "-u", user, "-H", "/usr/bin/env", `HOME=${home}`, "/usr/bin/python3", file], { stdio: "ignore" });
    listener.on("error", () => {});
    await until("foreign listener", async () => !!(await http()));
    const pid = Number(sudo(["cat", join(home, "listener.pid")]).trim()); owned.add(pid);
    const previous = logs().length;
    const app = await register(launch(["-AppleLanguages", "(uk)", "-AppleInterfaceStyle", "Dark"], "busy-uk-dark"));
    await until("busy screen", () => logs().slice(previous).includes("STATE port-busy") && logs().slice(previous).includes(String(pid)));
    assert.throws(launcherPID); sudo(["kill", "-0", String(pid)]);
    await sleep(2000); await end(app); sudo(["kill", "-TERM", String(pid)]); owned.delete(pid);
  });
} catch (error) { exit = 1; console.error(redact(error.message)); }
finally {
  if (created) {
    writeFileSync(join(report, "app.log"), redact(logs()));
    for (const pid of owned) { try { sudo(["kill", "-TERM", String(pid)]); } catch { /* already exited */ } }
    try {
      const runtime = join(home, "Library/Application Support/Delegatus/Runtime");
      asUser(join(runtime, "bun/bin/bun"), [join(runtime, "packages/node_modules/delegatus-cli/bin/cli.mjs"), "stop", "--all"]);
    } catch { /* failed installation has no server */ }
    try { sudo(["ditto", join(home, "Library/Evidence"), join(report, "frames")]); sudo(["chmod", "-R", "a+rX", join(report, "frames")]); } catch { /* retain failure report */ }
    try { sudo(["sysadminctl", "-deleteUser", user]); } catch { exit = 1; }
  }
  if (mount) { try { run("hdiutil", ["detach", mount]); } catch { exit = 1; } }
  const frames = existsSync(join(report, "frames")) ? readdirSync(join(report, "frames"), { recursive: true }).filter(name => name.endsWith(".png")).length : 0;
  if (exit === 0 && frames < 7) { checks.push({ name: "frames", exit: 1, error: "Missing rendered evidence" }); exit = 1; }
  writeFileSync(join(report, "report.json"), redact(JSON.stringify({ exit, passed: checks.filter(c => c.exit === 0).length, failed: checks.filter(c => c.exit !== 0).length, frames, checks, commands }, null, 2)));
  console.log(`macOS smoke: exit=${exit}, passed=${checks.filter(c => c.exit === 0).length}, failed=${checks.filter(c => c.exit !== 0).length}, frames=${frames}`);
}
process.exitCode = exit;
