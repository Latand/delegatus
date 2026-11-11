import { afterEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, readdirSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loginServiceHost, renderLoginService, runServiceCommand, serviceEnvironment, SERVICE_MARKER } from "./login-service.mjs";
import { cliRuntimeHostConfig } from "./server-runtime.mjs";
import { readStartIdentity } from "./self-update-supervisor.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(platform: "linux" | "darwin" = "linux") {
  const base = mkdtempSync(path.join(tmpdir(), "login-service-")); roots.push(base);
  const root = path.join(base, "global package % <&");
  const home = path.join(base, "home");
  const managerConfig = path.join(base, "manager-config");
  mkdirSync(path.join(root, "dist", "standalone"), { recursive: true });
  mkdirSync(home);
  writeFileSync(path.join(root, "dist", "standalone", "server.js"), "");
  writeFileSync(path.join(root, "dist", "runtime-host.mjs"), "");
  const file = platform === "linux" ? path.join(managerConfig, "systemd/user/delegatus.service") : path.join(home, "Library/LaunchAgents/org.delegatus.server.plist");
  const calls: string[][] = [], output: string[] = [];
  const manager = { load: "not-found", enabled: "disabled", active: "inactive", fragment: "", graphical: true, loaded: false, fail: "" };
  const host: ReturnType<typeof loginServiceHost> = {
    ...loginServiceHost(), platform, uid: 501, home, accountHome: home, container: false,
    temp: path.join(base, "tmp"), bun: process.execPath,
    env: { PATH: path.dirname(process.execPath), XDG_CONFIG_HOME: path.join(home, "shell-config"), XDG_CACHE_HOME: path.join(home, "cache"), LLV_LANG: "en", NODE_ENV: "test" },
    live: () => false, portFree: async () => true,
    run: async (_command, args) => {
      calls.push(args);
      if (args.includes(manager.fail)) return { code: 1, stdout: "", stderr: "denied" };
      const cmd = platform === "linux" ? args[1] : args[0];
      let stdout = "";
      if (cmd === "show-environment") stdout = `XDG_CONFIG_HOME=${managerConfig}\n`;
      if (cmd === "show") stdout = args.includes("--property=Version") ? "Version=252\n" : `LoadState=${manager.load}\nFragmentPath=${manager.fragment}\nUnitFileState=${manager.enabled}\nActiveState=${manager.active}\n`;
      if (cmd === "print") return { code: args[1] === "gui/501" ? Number(!manager.graphical) : Number(!manager.loaded), stdout, stderr: "" };
      if (cmd === "list") stdout = manager.active === "active" ? '{ "PID" = 123; "LastExitStatus" = 0; }' : '{ "LastExitStatus" = 0; }';
      if (cmd === "enable") { manager.enabled = "enabled"; manager.load = "loaded"; manager.fragment = file; }
      if (cmd === "start") manager.active = "active";
      if (cmd === "reset-failed") manager.active = "inactive";
      if (cmd === "disable") { manager.enabled = "disabled"; manager.active = "inactive"; }
      if (cmd === "daemon-reload" && !existsSync(file)) { manager.load = "not-found"; manager.fragment = ""; }
      if (cmd === "bootstrap" || cmd === "kickstart") { manager.loaded = true; manager.active = "active"; }
      if (cmd === "bootout") { manager.loaded = false; manager.active = "inactive"; }
      return { code: 0, stdout, stderr: "" };
    },
  };
  const run = (args = ["install"]) => runServiceCommand(args, { root, host, log: line => output.push(line) });
  const mutations = () => calls.filter(args => !["show", "show-environment", "print", "list"].includes(args[platform === "linux" ? 1 : 0]));
  return { base, root, home, host, file, manager, calls, output, run, mutations };
}

test("service commands refuse a checkout before launcher startup", () => {
  const f = fixture();
  mkdirSync(path.join(f.root, "bin"));
  for (const name of readdirSync("bin").filter(name => name.endsWith(".mjs"))) copyFileSync(path.join("bin", name), path.join(f.root, "bin", name));
  writeFileSync(path.join(f.root, "package.json"), "{}");
  writeFileSync(path.join(f.root, ".git"), "gitdir: fixture");
  const result = spawnSync(process.execPath, [path.join(f.root, "bin/cli.mjs"), "service", "install"], {
    env: { ...process.env, LLV_LANG: "en" }, encoding: "utf8",
  });
  expect(result.status).toBe(1);
  expect(result.stdout + result.stderr).toContain("checkout");
  expect(result.stdout + result.stderr).not.toContain("Unknown option");
});

test.skipIf(process.platform !== "linux" || process.getuid?.() === 0)("packaged CLI installs and removes through a persistent manager stub in separate processes", () => {
  const f = fixture();
  mkdirSync(path.join(f.root, "bin"));
  for (const name of readdirSync("bin").filter(name => name.endsWith(".mjs"))) copyFileSync(path.join("bin", name), path.join(f.root, "bin", name));
  writeFileSync(path.join(f.root, "package.json"), '{"name":"delegatus-cli"}');
  writeFileSync(path.join(f.root, "bin/launcher-credentials.mjs"), 'throw new Error("custody must not be entered");');
  const commands = path.join(f.base, "commands"); mkdirSync(commands);
  const state = path.join(f.base, "manager.json"), callFile = path.join(f.base, "calls.jsonl");
  writeFileSync(path.join(commands, "systemctl"), `#!${process.execPath}
const fs = require("node:fs");
const file = ${JSON.stringify(state)}, calls = ${JSON.stringify(callFile)};
const args = process.argv.slice(2), command = args[1];
fs.appendFileSync(calls, JSON.stringify(args) + "\\n");
let value = { LoadState: "not-found", FragmentPath: "", ActiveState: "inactive", UnitFileState: "disabled" };
if (fs.existsSync(file)) value = JSON.parse(fs.readFileSync(file, "utf8"));
if (command === "show-environment") console.log("XDG_CONFIG_HOME=" + ${JSON.stringify(path.dirname(path.dirname(path.dirname(f.file))))});
if (command === "show") console.log(args.includes("--property=Version") ? "Version=252" : Object.entries(value).map(([k,v]) => k + "=" + v).join("\\n"));
if (command === "enable") Object.assign(value, { LoadState: "loaded", FragmentPath: ${JSON.stringify(f.file)}, UnitFileState: "enabled" });
if (command === "start") value.ActiveState = "active";
if (command === "disable") Object.assign(value, { ActiveState: "inactive", UnitFileState: "disabled" });
if (command === "daemon-reload" && !fs.existsSync(${JSON.stringify(f.file)})) value.LoadState = "not-found";
fs.writeFileSync(file, JSON.stringify(value));
`, { mode: 0o755 });
  const runtime = path.join(f.base, "runtime"); mkdirSync(runtime, { mode: 0o700 });
  const env = { ...f.host.env, HOME: f.home, PATH: `${commands}:${f.host.env.PATH}:/usr/bin:/bin`, LLV_STATE_DIR: path.join(f.home, "state"), TMPDIR: path.join(f.base, "ephemeral"), XDG_RUNTIME_DIR: runtime, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
  mkdirSync(env.TMPDIR);
  const command = (action: string) => spawnSync(process.execPath, [path.join(f.root, "bin/cli.mjs"), "service", action], { env, encoding: "utf8", timeout: 10000 });
  expect(command("install")).toMatchObject({ status: 0, stderr: "" });
  const first = readFileSync(callFile, "utf8").trim().split("\n").length;
  expect(command("install").status).toBe(0);
  const later = readFileSync(callFile, "utf8").trim().split("\n").slice(first).map(line => JSON.parse(line)[1]);
  expect(later).toEqual(["show", "show-environment", "show"]);
  expect(command("remove").status).toBe(0); expect(existsSync(f.file)).toBe(false);
  expect(command("remove").stdout).toContain("Not installed");
});

test("Linux install captures only settings, preserves state identity and is idempotent across invocations", async () => {
  const f = fixture();
  const privateValue = "private value stays in the installing process";
  for (const name of ["LLV_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) f.host.env[name] = privateValue;
  f.host.env.DO_NOT_TRACK = "1";
  expect(await f.run(["install", "--port", "9123"])).toBe(0);
  const bytes = readFileSync(f.file, "utf8"), stamp = lstatSync(f.file);
  expect(bytes).toContain('ExecStart="' + process.execPath + '" "' + path.join(f.root, "bin/cli.mjs").replaceAll("%", "%%") + '" "--no-open" "--port" "9123"');
  expect(bytes).toContain('Environment="DO_NOT_TRACK=1"');
  expect(bytes).not.toContain("private");
  expect(bytes).not.toContain("STATE_OWNER");
  expect(bytes).toContain("StartLimitIntervalSec=600\nStartLimitBurst=5");
  expect(bytes).toContain("KillMode=process\nTimeoutStopSec=120\nOOMPolicy=continue");
  expect(f.mutations().map(args => args[1])).toEqual(["daemon-reload", "enable", "start"]);
  const serviceEnv = Object.fromEntries(bytes.split("\n").filter(line => line.startsWith("Environment=")).map(line => {
    const value = line.slice('Environment="'.length, -1).replaceAll("%%", "%").replaceAll("\\\\", "\\");
    const index = value.indexOf("="); return [value.slice(0, index), value.slice(index + 1)];
  }));
  const service = cliRuntimeHostConfig(f.root, { env: serviceEnv, home: f.home });
  const manual = cliRuntimeHostConfig(f.root, { env: f.host.env, home: f.home });
  expect(service.stateDirectory).toBe(manual.stateDirectory);
  expect(service.installId).toBe(manual.installId);
  f.calls.length = 0;
  expect(await f.run(["install", "--port", "9123"])).toBe(0);
  expect(f.mutations()).toEqual([]);
  expect(lstatSync(f.file).mtimeMs).toBe(stamp.mtimeMs);
  expect(lstatSync(f.file).ino).toBe(stamp.ino);
  expect(f.output.join("\n")).toContain("Already installed");
  expect(f.output.join("\n")).toContain("Undo: delegatus service remove");
});

test("changing a running service rewrites and reloads without restarting it", async () => {
  const f = fixture(); await f.run(); f.calls.length = 0;
  const bun = path.join(f.base, "new bun"); writeFileSync(bun, ""); f.host.bun = bun;
  expect(await f.run()).toBe(0);
  expect(f.mutations().map(args => args[1])).toEqual(["daemon-reload"]);
  expect(readFileSync(f.file, "utf8")).toContain(bun);
  expect(f.output.join("\n")).toContain("next start");
});

test("manager configuration uses its quoted XDG path or account home, independently of the shell", async () => {
  for (const configured of [true, false]) {
    const f = fixture(); const run = f.host.run;
    const config = configured ? path.join(f.base, "manager's config") : path.join(f.home, ".config");
    f.host.run = async (...args) => args[1].includes("show-environment")
      ? { code: 0, stdout: configured ? `XDG_CONFIG_HOME='${config.replaceAll("'", "'\\''")}'\n` : "", stderr: "" }
      : run(...args);
    expect(await f.run()).toBe(0);
    expect(existsSync(path.join(config, "systemd/user/delegatus.service"))).toBe(true);
    expect(existsSync(path.join(f.host.env.XDG_CONFIG_HOME!, "systemd/user/delegatus.service"))).toBe(false);
  }
});

test("unit rendering is byte stable and quotes systemd specifiers, dollars and backslashes", () => {
  expect(renderLoginService({ platform: "linux", bun: "/opt/bun", root: "/opt/global % $cash", port: 8898, home: "/fixture", env: { PATH: "/bin", LANG: "en_US.UTF-8" } })).toBe(
    `# ${SERVICE_MARKER}\n[Unit]\nDescription=Delegatus\nStartLimitIntervalSec=600\nStartLimitBurst=5\n\n[Service]\nType=simple\nExecStart="/opt/bun" "/opt/global %% $$cash/bin/cli.mjs" "--no-open" "--port" "8898"\nEnvironment="PATH=/bin"\nEnvironment="LANG=en_US.UTF-8"\nRestart=on-failure\nRestartSec=5\nKillMode=process\nTimeoutStopSec=120\nOOMPolicy=continue\nOOMScoreAdjust=100\n\n[Install]\nWantedBy=default.target\n`);
});

test("macOS writes a parseable user agent, bootstraps once and removes twice", async () => {
  const f = fixture("darwin");
  expect(await f.run()).toBe(0);
  const bytes = readFileSync(f.file, "utf8");
  expect(bytes).toContain("&lt;&amp;");
  const parsed = spawnSync("python3", ["-c", "import plistlib,sys,json; print(json.dumps(plistlib.load(sys.stdin.buffer)))"], { input: bytes, encoding: "utf8" });
  expect(parsed.status).toBe(0);
  const plist = JSON.parse(parsed.stdout);
  expect(plist.ProgramArguments).toEqual([process.execPath, path.join(f.root, "bin/cli.mjs"), "--no-open", "--port", "8898"]);
  expect(plist).toMatchObject({ Label: "org.delegatus.server", RunAtLoad: true, KeepAlive: { SuccessfulExit: false }, ExitTimeOut: 120, ProcessType: "Interactive" });
  expect(plist.EnvironmentVariables).toEqual(serviceEnvironment(f.host.env));
  f.calls.length = 0; await f.run(); expect(f.mutations()).toEqual([]);
  expect(await f.run(["remove"])).toBe(0); expect(existsSync(f.file)).toBe(false);
  expect(f.mutations().map(args => args[0])).toEqual(["bootout"]);
  f.calls.length = 0; expect(await f.run(["remove"])).toBe(0); expect(f.mutations()).toEqual([]);
});

test("Linux removal leaves drop-ins, and second removal changes nothing", async () => {
  const f = fixture(); await f.run(); mkdirSync(`${f.file}.d`); writeFileSync(path.join(`${f.file}.d`, "limits.conf"), "custom");
  f.calls.length = 0;
  expect(await f.run(["remove"])).toBe(0); expect(existsSync(f.file)).toBe(false);
  expect(f.mutations().map(args => args[1])).toEqual(["disable", "daemon-reload", "reset-failed"]);
  expect(existsSync(`${f.file}.d`)).toBe(true);
  f.calls.length = 0; expect(await f.run(["remove"])).toBe(0); expect(f.mutations()).toEqual([]);
});

test("a live launcher or a busy port defers start, and another install resumes it", async () => {
  for (const collision of ["launcher", "port"]) {
    const f = fixture();
    f.host.live = () => collision === "launcher"; f.host.portFree = async () => collision !== "port";
    expect(await f.run()).toBe(0);
    expect(f.mutations().map(args => args[1])).toEqual(["daemon-reload", "enable"]);
    f.calls.length = 0; f.host.live = () => false; f.host.portFree = async () => true;
    expect(await f.run()).toBe(0); expect(f.mutations().map(args => args[1])).toEqual(["start"]);
  }
});

test("a launcher appearing while the port probe awaits prevents start", async () => {
  const f = fixture(); let live = false;
  f.host.live = () => live; f.host.portFree = async () => { live = true; return true; };
  expect(await f.run()).toBe(0); expect(f.mutations().map(args => args[1])).not.toContain("start");
});

test("a failed unit is reset and started on the next install", async () => {
  const f = fixture(); await f.run(); f.manager.active = "failed"; f.calls.length = 0;
  expect(await f.run()).toBe(0); expect(f.mutations().map(args => args[1])).toEqual(["reset-failed", "start"]);
});

test("macOS without a graphical login saves the agent for the next login", async () => {
  const f = fixture("darwin"); f.manager.graphical = false;
  expect(await f.run()).toBe(0); expect(existsSync(f.file)).toBe(true); expect(f.mutations()).toEqual([]);
  expect(f.output.join("\n")).toContain("next desktop login");
});

test("macOS install starts a loaded agent again after a successful stop", async () => {
  const f = fixture("darwin"); await f.run(); f.manager.active = "inactive"; f.calls.length = 0;
  expect(await f.run()).toBe(0); expect(f.mutations()).toEqual([["kickstart", "gui/501/org.delegatus.server"]]);
});

for (const reason of ["platform", "root", "container", "bun", "checkout", "temporary", "bunx", "package", "release", "reexec", "state", "value", "port"] as const) test(`refuses ${reason} without writes or manager mutations`, async () => {
  const f = fixture();
  if (reason === "platform") f.host.platform = "win32";
  if (reason === "root") f.host.uid = 0;
  if (reason === "container") f.host.container = true;
  if (reason === "bun") f.host.bun = "";
  if (reason === "checkout") writeFileSync(path.join(f.root, ".git"), "gitdir: fixture");
  if (reason === "temporary") f.host.temp = f.base;
  if (reason === "bunx") f.root = path.join(f.base, "bunx-501-test/package");
  if (reason === "package") rmSync(path.join(f.root, "dist/runtime-host.mjs"));
  if (reason === "release") f.root = path.join(f.base, "self-update/installation/releases/version");
  if (reason === "reexec") f.host.env.LLV_LAUNCHER_REEXEC = "1";
  if (reason === "state") { f.host.env = { PATH: "/bin", NODE_ENV: "test" }; f.host.accountHome = path.join(f.base, "another-home"); }
  if (reason === "value") f.host.env.LANG = "en\nInjected=1";
  const result = await runServiceCommand(reason === "port" ? ["install", "--port", "70000"] : ["install"], { root: f.root, host: f.host, log: () => {} });
  expect(result).toBe(1); expect(existsSync(f.file)).toBe(false); expect(f.calls).toEqual([]);
});

for (const kind of ["foreign", "symlink", "fragment"] as const) test(`preserves a ${kind} service during install and remove`, async () => {
  const f = fixture(); mkdirSync(path.dirname(f.file), { recursive: true });
  if (kind === "fragment") f.manager.fragment = "/etc/systemd/user/delegatus.service";
  else if (kind === "symlink") { const other = path.join(f.base, "other"); writeFileSync(other, "untouched"); symlinkSync(other, f.file); }
  else writeFileSync(f.file, "untouched");
  for (const action of ["install", "remove"]) {
    expect(await f.run([action])).toBe(1); expect(f.mutations()).toEqual([]);
    if (kind !== "fragment") expect(readFileSync(f.file, "utf8")).toBe("untouched");
  }
});

test("manager failure preserves the file for a recoverable retry", async () => {
  const f = fixture(); f.manager.fail = "enable";
  expect(await f.run()).toBe(1); expect(existsSync(f.file)).toBe(true);
  f.manager.fail = ""; expect(await f.run()).toBe(0); expect(f.manager.active).toBe("active");
  f.manager.fail = "disable"; expect(await f.run(["remove"])).toBe(1); expect(existsSync(f.file)).toBe(true);
});

test("removal ignores only its final reset-failed cleanup error", async () => {
  const f = fixture(); await f.run(); const run = f.host.run;
  f.host.run = async (...args) => {
    if (args[1].includes("reset-failed")) throw new Error("cleanup command unavailable");
    return run(...args);
  };
  expect(await f.run(["remove"])).toBe(0); expect(existsSync(f.file)).toBe(false);
});

test("replacement after a manager await refuses later effects", async () => {
  const f = fixture(); const run = f.host.run;
  f.host.run = async (...args) => {
    const result = await run(...args);
    if (args[1].includes("daemon-reload")) writeFileSync(f.file, "foreign replacement");
    return result;
  };
  expect(await f.run()).toBe(1); expect(f.mutations().map(args => args[1])).toEqual(["daemon-reload"]);
  expect(readFileSync(f.file, "utf8")).toBe("foreign replacement");
});

test("a real child with its recorded start identity prevents service start", async () => {
  const f = fixture();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { env: f.host.env, stdio: "ignore" });
  try {
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    const identity = readStartIdentity(child.pid!);
    expect(identity).toBeTruthy();
    const config = cliRuntimeHostConfig(f.root, { env: f.host.env, home: f.home });
    const record = path.join(config.stateDirectory, "self-update", `launcher-${config.installId}.json`);
    mkdirSync(path.dirname(record), { recursive: true });
    writeFileSync(record, JSON.stringify({ launcher: { pid: child.pid, startIdentity: identity } }));
    f.host.live = loginServiceHost().live;
    expect(await f.run()).toBe(0);
    expect(f.mutations().map(args => args[1])).toEqual(["daemon-reload", "enable"]);
    expect(readStartIdentity(child.pid!)).toBe(identity);
  } finally {
    const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
    child.kill("SIGKILL"); await closed;
  }
});

test.skipIf(!Bun.which("systemd-analyze"))("the generated Linux unit passes the native parser in an isolated home", async () => {
  const f = fixture(); await f.run();
  const runtime = path.join(f.base, "runtime"); mkdirSync(runtime, { mode: 0o700 });
  const result = spawnSync("systemd-analyze", ["--user", "verify", f.file], {
    env: { ...process.env, HOME: f.home, XDG_CONFIG_HOME: path.dirname(path.dirname(path.dirname(f.file))), XDG_RUNTIME_DIR: runtime }, encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
});
