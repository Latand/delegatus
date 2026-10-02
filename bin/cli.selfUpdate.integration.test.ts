import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterAll, afterEach, expect, test } from "bun:test";

/*
 * #2007: the launcher's half of self-update, driven through the real
 * `bin/cli.mjs`. The install is a git checkout whose `next` and runtime host
 * are stubs committed into the repository, so every release worktree carries
 * them too: a stub answers with the directory it runs from, which is how the
 * test tells which release serves. Every child here is one the test started
 * (the CLI) or one the CLI started; the test signals only the CLI, by the
 * handle it spawned.
 */

const roots: string[] = [];
const children = new Set<ReturnType<typeof spawn>>();

/* A child the test already stopped has fired its exit: waiting for it again
   would only run out the hook's own time. */
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await Promise.race([exited, Bun.sleep(4_000)]);
  }
  children.clear();
}, 10_000);
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const identity = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false"];
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", [...identity, ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

const STUB_NEXT = (exitAtOnce: boolean, tokenProtected = false) => exitAtOnce ? "process.exit(3);\n" : `
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT),
  fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (${tokenProtected} && (pathname === "/" || pathname === "/api/self-update/launcher-admission")) {
      if (request.headers.get("authorization") !== "Bearer " + process.env.LLV_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }
    }
    if (pathname === "/api/self-update/launcher-admission") return Response.json({ admitted: true });
    return new Response(process.cwd());
  },
});
const stop = () => { server.stop(true); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
`;

const STUB_HOST = `
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
const socketPath = process.env.LLV_RUNTIME_HOST_SOCKET;
const fencePath = process.env.LLV_RUNTIME_HOST_FENCE;
mkdirSync(path.dirname(socketPath), { recursive: true });
rmSync(socketPath, { force: true });
const server = net.createServer((socket) => socket.end());
server.listen(socketPath, () => writeFileSync(fencePath, JSON.stringify({
  pid: process.pid,
  startIdentity: process.pid + ":fixture",
  acquisitionId: "fixture-acquisition-id",
})));
const stop = () => server.close(() => { rmSync(fencePath, { force: true }); process.exit(0); });
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
`;

const BROKEN_HOST = "process.exit(3);\n";

function install(options: { oldSupervisor?: boolean; oldServerRuntime?: boolean; tokenProtected?: boolean } = {}) {
  const root = mkdtempSync("/var/tmp/llv-cli-self-update-");
  roots.push(root);
  const checkout = path.join(root, "checkout");
  const home = path.join(root, "home");
  const state = path.join(root, "state");
  const cache = path.join(root, "cache");
  for (const dir of [path.join(checkout, "bin"), path.join(checkout, "node_modules", ".bin"), path.join(checkout, "dist"), home, state, cache, path.join(root, "tmp")]) {
    mkdirSync(dir, { recursive: true });
  }
  for (const name of ["cli.mjs", "telemetry-notice.mjs", "agent-binaries.mjs", "server-runtime.mjs", "tailscale.mjs", "self-update-supervisor.mjs", "appDir.mjs", "envAlias.mjs", "legacySystemd.mjs", "internalService.mjs", "skillLinks.mjs", "oomPolicy.mjs"]) {
    copyFileSync(path.resolve("bin", name), path.join(checkout, "bin", name));
  }
  if (options.oldSupervisor) {
    const supervisor = path.join(checkout, "bin", "self-update-supervisor.mjs");
    writeFileSync(supervisor, readFileSync(supervisor, "utf8").replace(", autoAdmission: 1", ""));
  }
  if (options.oldServerRuntime) {
    const runtime = path.join(checkout, "bin", "server-runtime.mjs");
    writeFileSync(runtime, readFileSync(runtime, "utf8").replace("export function discardUnsupportedApiCredentials(", "function discardUnsupportedApiCredentials("));
  }
  writeFileSync(path.join(checkout, "package.json"), JSON.stringify({ type: "module", version: "0.0.0" }));
  writeFileSync(path.join(checkout, "node_modules", ".bin", "next"), STUB_NEXT(false, options.tokenProtected));
  writeFileSync(path.join(checkout, "dist", "runtime-host.mjs"), STUB_HOST);
  git(checkout, "init", "--initial-branch=main");
  git(checkout, "add", "-f", ".");
  git(checkout, "commit", "-m", "first");
  const first = git(checkout, "rev-parse", "HEAD");
  return {
    root,
    checkout,
    first,
    state,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_CACHE_HOME: cache,
      LLV_STATE_DIR: state,
      TMPDIR: path.join(root, "tmp"),
      LLV_BUN_EXECUTABLE: process.execPath,
    },
  };
}

/** A built release of a new commit, as the Viewer's step runner leaves it. */
function release(fixture: ReturnType<typeof install>, name: string, options: { broken?: boolean; brokenHost?: boolean; upgradeSupervisor?: boolean; upgradeServerRuntime?: boolean; launcher?: string } = {}): { dir: string; sha: string } {
  git(fixture.checkout, "checkout", "--quiet", "--detach", fixture.first);
  writeFileSync(path.join(fixture.checkout, "notes.txt"), `${name}\n`);
  if (options.upgradeSupervisor) copyFileSync(path.resolve("bin", "self-update-supervisor.mjs"), path.join(fixture.checkout, "bin", "self-update-supervisor.mjs"));
  if (options.upgradeServerRuntime) copyFileSync(path.resolve("bin", "server-runtime.mjs"), path.join(fixture.checkout, "bin", "server-runtime.mjs"));
  if (options.launcher) writeFileSync(path.join(fixture.checkout, "bin", "cli.mjs"), options.launcher);
  if (options.broken) writeFileSync(path.join(fixture.checkout, "node_modules", ".bin", "next"), STUB_NEXT(true));
  if (options.brokenHost) writeFileSync(path.join(fixture.checkout, "dist", "runtime-host.mjs"), BROKEN_HOST);
  git(fixture.checkout, "add", "-f", ".");
  git(fixture.checkout, "commit", "--quiet", "-m", name);
  const sha = git(fixture.checkout, "rev-parse", "HEAD");
  /* The package root stays at its first commit: the update is a release. */
  git(fixture.checkout, "checkout", "--quiet", "--force", "--detach", fixture.first);
  const dir = path.join(fixture.root, "releases", name);
  git(fixture.checkout, "worktree", "add", "--detach", dir, sha);
  mkdirSync(path.join(dir, ".next"), { recursive: true });
  writeFileSync(path.join(dir, ".next", "BUILD_ID"), `${name}\n`);
  return { dir, sha };
}

async function availablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function recordFile(state: string): string {
  const dir = path.join(state, "self-update");
  const name = readdirSync(dir).find((entry) => entry.startsWith("launcher-") && entry.endsWith(".json"));
  if (!name) throw new Error("no launcher record");
  return path.join(dir, name);
}

function stateText(directory: string): string {
  return readdirSync(directory, { withFileTypes: true }).map((entry) => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return stateText(filename);
    return entry.isFile() ? readFileSync(filename, "utf8") : "";
  }).join("\n");
}

function pointerFile(fixture: ReturnType<typeof install>): string {
  const installId = createHash("sha256").update(path.resolve(fixture.checkout)).digest("hex").slice(0, 16);
  return path.join(fixture.state, "self-update", `release-${installId}.json`);
}

function version(fixture: ReturnType<typeof install>, extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, ["--bun", path.join(fixture.checkout, "bin", "cli.mjs"), "--version"], {
    cwd: fixture.checkout,
    env: { ...fixture.env, ...extraEnv },
    encoding: "utf8",
    timeout: 5_000,
  });
}

type Entry = { state: string; pid: number | null; revision: string | null; requestId: string | null; error: { kind: string; revision?: string } | null };
type LauncherRecord = { launcher: { pid: number; autoAdmission?: number }; checkout: string | null; releasePointer: string; requestFile: string; socket: string; web: Entry; runtimeHost: Entry };

async function until<T>(read: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = read();
      if (value) return value;
      last = value;
    } catch (error) {
      last = error;
    }
    await Bun.sleep(50);
  }
  throw new Error(`timed out; last read ${String(last)}`);
}

function readRecord(state: string): LauncherRecord {
  return JSON.parse(readFileSync(recordFile(state), "utf8")) as LauncherRecord;
}

async function served(port: number): Promise<string> {
  return (await fetch(`http://127.0.0.1:${port}/`)).text();
}

async function start(fixture: ReturnType<typeof install>, args: string[] = []) {
  const port = await availablePort();
  const child = spawn(process.execPath, ["--bun", path.join(fixture.checkout, "bin", "cli.mjs"), "--no-open", "--port", String(port), ...args], {
    cwd: fixture.checkout,
    env: fixture.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let output = "";
  child.stdout?.on("data", (chunk) => { output += String(chunk); });
  child.stderr?.on("data", (chunk) => { output += String(chunk); });
  await until(() => output.includes("Delegatus v"), 20_000).catch((error) => { throw new Error(`${String(error)}\n${output}`); });
  return { port, child, output: () => output };
}

/** Whether the runtime host's socket takes a connection right now. */
function socketAnswers(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    const finish = (answered: boolean) => { socket.destroy(); resolve(answered); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(2_000, () => finish(false));
  });
}

function request(record: LauncherRecord, role: "web" | "runtime-host", requestId: string): void {
  writeFileSync(record.requestFile, JSON.stringify({ requestId, role }));
}

test("one service restart runs the installed launcher and its admission-capable supervisor while checkout HEAD stays old", async () => {
  const fixture = install({ oldSupervisor: true });
  const initial = await start(fixture);
  const oldRecord = await until(() => {
    const record = readRecord(fixture.state);
    return record.web.state === "healthy" && record.runtimeHost.state === "healthy" ? record : null;
  });
  expect(oldRecord.launcher.autoAdmission).toBeUndefined();
  initial.child.kill("SIGTERM");
  await new Promise<void>((resolve) => initial.child.once("exit", () => resolve()));

  const next = release(fixture, "admission-launcher", { upgradeSupervisor: true });
  writeFileSync(pointerFile(fixture), JSON.stringify({ sha: next.sha, dir: next.dir, checkoutHead: fixture.first }));
  const restarted = await start(fixture);
  const record = await until(() => {
    const current = readRecord(fixture.state);
    return current.web.state === "healthy" && current.runtimeHost.state === "healthy" ? current : null;
  });
  expect(record.launcher.autoAdmission).toBe(1);
  expect(record.launcher.pid).not.toBe(restarted.child.pid);
  expect(record.checkout).toBe(fixture.checkout);
  expect(git(fixture.checkout, "rev-parse", "HEAD")).toBe(fixture.first);
  expect(await served(restarted.port)).toBe(next.dir);

  request(record, "web", "after-launcher-handoff");
  const afterRequest = await until(() => {
    const current = readRecord(fixture.state);
    return current.web.requestId === "after-launcher-handoff" && current.web.state === "healthy" ? current : null;
  });
  expect(afterRequest.web.revision).toBe(next.sha.slice(0, 7));
  expect(afterRequest.runtimeHost.pid).toBe(record.runtimeHost.pid);
  /* systemd's control-group kill reaches both processes; the bootstrap also
     forwards its signal, so the launcher may see SIGTERM twice. */
  process.kill(record.launcher.pid, "SIGTERM");
  restarted.child.kill("SIGTERM");
  await new Promise<void>((resolve) => restarted.child.once("exit", () => resolve()));
  expect(restarted.child.exitCode).toBe(0);
  expect(existsSync(`/proc/${record.web.pid}`)).toBe(false);
  expect(existsSync(`/proc/${record.runtimeHost.pid}`)).toBe(false);
  expect(readdirSync(path.join(fixture.state, "self-update")).some((name) => name.startsWith("launcher-"))).toBe(false);
}, 60_000);

test("release handoff forwards argv, environment and signals, and the marker prevents another handoff", async () => {
  const fixture = install();
  const probeFile = path.join(fixture.root, "probe.json");
  const signalFile = path.join(fixture.root, "signal.txt");
  const probe = `// delegatus-checkout-launcher-v2\nimport { writeFileSync } from "node:fs";\nwriteFileSync(process.env.LLV_TEST_PROBE_FILE, JSON.stringify({ argv: process.argv.slice(2), marker: process.env.LLV_LAUNCHER_REEXEC, checkout: process.env.LLV_LAUNCHER_CHECKOUT, value: process.env.LLV_TEST_VALUE, cwd: process.cwd() }));\nprocess.on("SIGTERM", () => { writeFileSync(process.env.LLV_TEST_SIGNAL_FILE, "SIGTERM"); process.exit(0); });\nsetInterval(() => {}, 1000);\n`;
  const next = release(fixture, "probe-launcher", { launcher: probe });
  mkdirSync(path.dirname(pointerFile(fixture)), { recursive: true });
  writeFileSync(pointerFile(fixture), JSON.stringify({ sha: next.sha, dir: next.dir, checkoutHead: fixture.first }));

  const marked = version(fixture, { LLV_LAUNCHER_REEXEC: "1" });
  expect(marked.status).toBe(0);
  expect(marked.stdout.trim()).toBe("0.0.0");
  expect(existsSync(probeFile)).toBe(false);

  const child = spawn(process.execPath, ["--bun", path.join(fixture.checkout, "bin", "cli.mjs"), "--no-open", "--port", "47123"], {
    cwd: fixture.checkout,
    env: { ...fixture.env, LLV_TEST_PROBE_FILE: probeFile, LLV_TEST_SIGNAL_FILE: signalFile, LLV_TEST_VALUE: "forwarded" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  const observed = await until(() => existsSync(probeFile) ? JSON.parse(readFileSync(probeFile, "utf8")) : null);
  expect(observed).toEqual({ argv: ["--no-open", "--port", "47123"], marker: "1", checkout: fixture.checkout, value: "forwarded", cwd: fixture.checkout });
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  expect(readFileSync(signalFile, "utf8")).toBe("SIGTERM");
  expect(child.exitCode).toBe(0);
}, 30_000);

test("missing and invalid release pointers use the checkout launcher", () => {
  const fixture = install();
  expect(version(fixture)).toMatchObject({ status: 0, stdout: "0.0.0\n" });
  mkdirSync(path.dirname(pointerFile(fixture)), { recursive: true });
  writeFileSync(pointerFile(fixture), JSON.stringify({ sha: "a".repeat(40), dir: path.join(fixture.root, "missing"), checkoutHead: fixture.first }));
  expect(version(fixture)).toMatchObject({ status: 0, stdout: "0.0.0\n" });
});

test("an older handoff protocol keeps the checkout supervisor as fallback", () => {
  const fixture = install();
  const legacy = release(fixture, "legacy-launcher", { launcher: "// delegatus-checkout-launcher-v1\nprocess.stdout.write('legacy\\n');\n" });
  mkdirSync(path.dirname(pointerFile(fixture)), { recursive: true });
  writeFileSync(pointerFile(fixture), JSON.stringify({ sha: legacy.sha, dir: legacy.dir, checkoutHead: fixture.first }));
  expect(version(fixture)).toMatchObject({ status: 0, stdout: "0.0.0\n" });
});

test("the one-time file checkout links against an older checkout and retains its own launcher fallback", async () => {
  const fixture = install({ oldSupervisor: true, oldServerRuntime: true });
  const checkoutCli = path.join(fixture.checkout, "bin", "cli.mjs");
  writeFileSync(checkoutCli, "import './server-runtime.mjs';\nprocess.stdout.write('old launcher\\n');\n");
  git(fixture.checkout, "add", "bin/cli.mjs");
  git(fixture.checkout, "commit", "--amend", "--quiet", "--no-edit");
  fixture.first = git(fixture.checkout, "rev-parse", "HEAD");
  const next = release(fixture, "bootstrap-release", {
    launcher: readFileSync(path.resolve("bin", "cli.mjs"), "utf8"),
    upgradeSupervisor: true,
    upgradeServerRuntime: true,
  });
  writeFileSync(path.join(fixture.checkout, "bin", "cli-checkout.mjs"), git(fixture.checkout, "show", "HEAD:bin/cli.mjs") + "\n");
  mkdirSync(path.dirname(pointerFile(fixture)), { recursive: true });
  writeFileSync(pointerFile(fixture), JSON.stringify({ sha: next.sha, dir: next.dir, checkoutHead: fixture.first }));
  expect(version(fixture).stdout.trim()).toBe("old launcher");

  git(fixture.checkout, "checkout", next.sha, "--", "bin/cli.mjs");
  expect(git(fixture.checkout, "rev-parse", "HEAD")).toBe(fixture.first);
  expect(version(fixture, { LLV_LAUNCHER_REEXEC: "1" }).stdout.trim()).toBe("old launcher");
  expect(version(fixture).stdout.trim()).toBe("0.0.0");
  rmSync(pointerFile(fixture));
  expect(version(fixture).stdout.trim()).toBe("old launcher");
  writeFileSync(pointerFile(fixture), JSON.stringify({ sha: next.sha, dir: next.dir, checkoutHead: fixture.first }));
  const running = await start(fixture);
  const record = await until(() => {
    const current = readRecord(fixture.state);
    return current.web.state === "healthy" && current.runtimeHost.state === "healthy" ? current : null;
  });
  expect(record.launcher.autoAdmission).toBe(1);
  expect(record.checkout).toBe(fixture.checkout);
  expect(await served(running.port)).toBe(next.dir);
}, 60_000);

test("a hand-moved checkout runs its current launcher instead of the saved old one", () => {
  const fixture = install();
  const checkoutCli = path.join(fixture.checkout, "bin", "cli.mjs");
  writeFileSync(checkoutCli, "process.stdout.write('old launcher\\n');\n");
  git(fixture.checkout, "add", "bin/cli.mjs");
  git(fixture.checkout, "commit", "--amend", "--quiet", "--no-edit");
  fixture.first = git(fixture.checkout, "rev-parse", "HEAD");
  const next = release(fixture, "current-launcher", { launcher: readFileSync(path.resolve("bin", "cli.mjs"), "utf8") });
  writeFileSync(path.join(fixture.checkout, "bin", "cli-checkout.mjs"), git(fixture.checkout, "show", "HEAD:bin/cli.mjs") + "\n");
  git(fixture.checkout, "checkout", next.sha, "--", "bin/cli.mjs");
  expect(version(fixture).stdout.trim()).toBe("old launcher");

  git(fixture.checkout, "checkout", "--quiet", "--force", "--detach", next.sha);
  expect(version(fixture)).toMatchObject({ status: 0, stdout: "0.0.0\n" });
  mkdirSync(path.dirname(pointerFile(fixture)), { recursive: true });
  writeFileSync(pointerFile(fixture), JSON.stringify({ sha: next.sha, dir: next.dir, checkoutHead: fixture.first }));
  expect(version(fixture)).toMatchObject({ status: 0, stdout: "0.0.0\n" });
});

test.each([0, 1])("a release launcher exiting %i before recording itself falls back to a healthy checkout launcher", async (exitCode) => {
  const fixture = install();
  const broken = release(fixture, "broken-launcher", { launcher: `// delegatus-checkout-launcher-v2\nprocess.exit(${exitCode});\n` });
  mkdirSync(path.dirname(pointerFile(fixture)), { recursive: true });
  writeFileSync(pointerFile(fixture), JSON.stringify({ sha: broken.sha, dir: broken.dir, checkoutHead: fixture.first }));
  const running = await start(fixture);
  const record = await until(() => {
    const current = readRecord(fixture.state);
    return current.web.state === "healthy" && current.runtimeHost.state === "healthy" ? current : null;
  });
  expect(running.output()).toContain("installed launcher could not start");
  expect(record.launcher.pid).toBe(running.child.pid as number);
  expect(await served(running.port)).toBe(broken.dir);
  expect(await socketAnswers(record.socket)).toBe(true);
}, 60_000);

test("a one-shot team command keeps the release launcher's exit result", () => {
  const fixture = install();
  const broken = release(fixture, "team-command", { launcher: "// delegatus-checkout-launcher-v2\nprocess.exit(1);\n" });
  mkdirSync(path.dirname(pointerFile(fixture)), { recursive: true });
  writeFileSync(pointerFile(fixture), JSON.stringify({ sha: broken.sha, dir: broken.dir, checkoutHead: fixture.first }));
  const result = spawnSync(process.execPath, ["--bun", path.join(fixture.checkout, "bin", "cli.mjs"), "team", "status"], {
    cwd: fixture.checkout, env: fixture.env, encoding: "utf8", timeout: 5_000,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).not.toContain("using the checkout launcher");
});

test("saved checkout launcher handles a group signal once and finishes shutdown", async () => {
  const fixture = install();
  const started = path.join(fixture.root, "backup-started");
  const stopped = path.join(fixture.root, "backup-stopped");
  const checkoutCli = path.join(fixture.checkout, "bin", "cli.mjs");
  const savedLauncher = `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(started)}, "started");
process.once("SIGTERM", () => setTimeout(() => {
  writeFileSync(${JSON.stringify(stopped)}, "stopped");
  process.exit(0);
}, 200));
setInterval(() => {}, 1000);
`;
  writeFileSync(checkoutCli, savedLauncher);
  git(fixture.checkout, "add", "bin/cli.mjs");
  git(fixture.checkout, "commit", "--amend", "--quiet", "--no-edit");
  writeFileSync(path.join(fixture.checkout, "bin", "cli-checkout.mjs"), savedLauncher);
  copyFileSync(path.resolve("bin", "cli.mjs"), checkoutCli);
  const child = spawn(process.execPath, ["--bun", path.join(fixture.checkout, "bin", "cli.mjs")], {
    cwd: fixture.checkout, env: fixture.env, stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  await until(() => existsSync(started));
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  expect(child.exitCode).toBe(0);
  expect(readFileSync(stopped, "utf8")).toBe("stopped");
}, 10_000);

test("a checkout records both children, and a restart request moves each one onto the published release", async () => {
  const fixture = install();
  const { port, child } = await start(fixture);
  const before = await until(() => { const record = readRecord(fixture.state); return record.web.state === "healthy" && record.runtimeHost.state === "healthy" ? record : null; });
  expect(before.checkout).toBe(fixture.checkout);
  expect(before.web.revision).toBe(fixture.first.slice(0, 7));
  expect(await served(port)).toBe(fixture.checkout);

  const next = release(fixture, "second");
  writeFileSync(before.releasePointer, JSON.stringify({ sha: next.sha, dir: next.dir, checkoutHead: fixture.first }));

  request(before, "web", "restart-web-1");
  const afterWeb = await until(() => {
    const record = readRecord(fixture.state);
    return record.web.requestId === "restart-web-1" && record.web.state === "healthy" && record.web.pid !== before.web.pid ? record : null;
  });
  expect(afterWeb.web.revision).toBe(next.sha.slice(0, 7));
  expect(afterWeb.web.error).toBeNull();
  expect(await served(port)).toBe(next.dir);
  /* The old web process is gone; the CLI and the host carried on. */
  expect(existsSync(`/proc/${before.web.pid}`)).toBe(false);
  expect(child.exitCode).toBeNull();
  expect(afterWeb.runtimeHost.pid).toBe(before.runtimeHost.pid);

  request(afterWeb, "runtime-host", "restart-host-1");
  const afterHost = await until(() => {
    const record = readRecord(fixture.state);
    return record.runtimeHost.requestId === "restart-host-1" && record.runtimeHost.state === "healthy" && record.runtimeHost.pid !== before.runtimeHost.pid ? record : null;
  });
  expect(afterHost.runtimeHost.revision).toBe(next.sha.slice(0, 7));
  expect(readlinkSync(`/proc/${afterHost.runtimeHost.pid}/cwd`)).toBe(next.dir);
  expect(existsSync(`/proc/${before.runtimeHost.pid}`)).toBe(false);
  expect(afterHost.web.pid).toBe(afterWeb.web.pid);

  child.kill("SIGTERM");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  /* A clean stop takes the record with it: nothing names a gone launcher. */
  expect(readdirSync(path.join(fixture.state, "self-update")).some((name) => name.startsWith("launcher-"))).toBe(false);
}, 60_000);

for (const tokenSource of ["LLV_TOKEN", "DELEGATUS_TOKEN", "generated"] as const) {
  for (const { broken, automatic } of [
    { broken: false, automatic: false },
    { broken: true, automatic: false },
    { broken: false, automatic: true },
  ]) {
    test(`token-protected web restart uses ${tokenSource}, fallback=${broken}, automatic=${automatic}`, async () => {
      const fixture = install({ tokenProtected: true });
      const env = fixture.env as Record<string, string | undefined>;
      delete env.LLV_TOKEN;
      delete env.DELEGATUS_TOKEN;
      const token = "fixture-update-access";
      if (tokenSource !== "generated") env[tokenSource] = token;
      const running = await start(fixture, tokenSource === "generated" ? ["--hostname", "0.0.0.0"] : []);
      const before = await until(() => {
        const record = readRecord(fixture.state);
        return record.web.state === "healthy" && record.runtimeHost.state === "healthy" ? record : null;
      });
      const url = `http://127.0.0.1:${running.port}/`;
      expect((await fetch(url)).status).toBe(401);
      const next = release(fixture, "token-update", { broken });
      writeFileSync(before.releasePointer, JSON.stringify({ ...next, checkoutHead: fixture.first }));
      if (automatic) {
        writeFileSync(path.join(fixture.state, "self-update", "auto-admission.json"), JSON.stringify({
          id: "token-update-gate", until: Date.now() + 30_000,
        }));
        writeFileSync(before.requestFile, JSON.stringify({
          requestId: "restart-token-protected-web", role: "web", autoGateId: "token-update-gate",
        }));
      } else request(before, "web", "restart-token-protected-web");
      const after = await until(() => {
        const record = readRecord(fixture.state);
        return record.web.requestId === "restart-token-protected-web"
          && ["healthy", "failed"].includes(record.web.state) ? record : null;
      });
      expect(after.web.state).toBe("healthy");
      expect(after.web.revision).toBe((broken ? fixture.first : next.sha).slice(0, 7));
      if (broken) expect(after.web.error).toMatchObject({ kind: "fell-back", revision: next.sha.slice(0, 7) });
      else expect(after.web.error).toBeNull();
      expect(after.runtimeHost.pid).toBe(before.runtimeHost.pid);
      expect(await socketAnswers(before.socket)).toBe(true);
      expect(running.child.exitCode).toBeNull();
      expect((await fetch(url)).status).toBe(401);
      if (tokenSource !== "generated") {
        const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
        expect(response.status).toBe(200);
        expect(await response.text()).toBe(broken ? fixture.checkout : next.dir);
      }
    }, 60_000);
  }
}

for (const invalidCharacter of ["\n", "\r", "\u0100"] as const) {
  test(`malformed Viewer tokens are omitted from restart headers and diagnostics (${JSON.stringify(invalidCharacter)})`, async () => {
    const fixture = install({ tokenProtected: true });
    const token = `fixture-prefix${invalidCharacter}fixture-suffix`;
    fixture.env.LLV_TOKEN = token;
    const running = await start(fixture);
    const before = await until(() => {
      const record = readRecord(fixture.state);
      return record.web.state === "healthy" && record.runtimeHost.state === "healthy" ? record : null;
    });
    const next = release(fixture, "malformed-token-update");
    writeFileSync(before.releasePointer, JSON.stringify({ ...next, checkoutHead: fixture.first }));
    request(before, "web", "restart-malformed-token");

    const after = await until(() => {
      const record = readRecord(fixture.state);
      return record.web.requestId === "restart-malformed-token" && record.web.state === "failed" ? record : null;
    });
    const persistedState = stateText(fixture.state);
    expect(after.web.error).toMatchObject({ kind: "message", text: "GET / answered 401" });
    expect(persistedState).not.toContain(token);
    expect(running.output()).not.toContain(token);
    expect(after.runtimeHost.pid).toBe(before.runtimeHost.pid);
    expect(await socketAnswers(before.socket)).toBe(true);
    expect(running.child.exitCode).toBeNull();
  }, 60_000);
}

test("a release whose web does not start gives way to the one it replaced, and says so", async () => {
  const fixture = install();
  const { port, child } = await start(fixture);
  const before = await until(() => { const record = readRecord(fixture.state); return record.web.state === "healthy" ? record : null; });
  const broken = release(fixture, "broken", { broken: true });
  writeFileSync(before.releasePointer, JSON.stringify({ sha: broken.sha, dir: broken.dir, checkoutHead: fixture.first }));

  request(before, "web", "restart-web-broken");
  const after = await until(() => {
    const record = readRecord(fixture.state);
    return record.web.requestId === "restart-web-broken" && record.web.state === "healthy" && record.web.error ? record : null;
  });
  expect(after.web.error).toMatchObject({ kind: "fell-back", revision: broken.sha.slice(0, 7) });
  expect(after.web.revision).toBe(fixture.first.slice(0, 7));
  expect(await served(port)).toBe(fixture.checkout);
  expect(child.exitCode).toBeNull();
}, 60_000);

test("a web restart whose new and previous releases both fail leaves the web failed and the runtime host serving", async () => {
  const fixture = install();
  const { port, child } = await start(fixture);
  const before = await until(() => { const record = readRecord(fixture.state); return record.web.state === "healthy" && record.runtimeHost.state === "healthy" ? record : null; });
  expect(await socketAnswers(before.socket)).toBe(true);
  const broken = release(fixture, "broken-web", { broken: true });
  const healthy = release(fixture, "healthy-web");
  writeFileSync(before.releasePointer, JSON.stringify({ sha: broken.sha, dir: broken.dir, checkoutHead: fixture.first }));
  /* The package root's own web fails too, so the fallback does not come up either. */
  const rootNext = path.join(fixture.checkout, "node_modules", ".bin", "next");
  writeFileSync(rootNext, STUB_NEXT(true));

  request(before, "web", "restart-web-both-broken");
  const failed = await until(() => {
    const record = readRecord(fixture.state);
    return record.web.requestId === "restart-web-both-broken" && record.web.state === "failed" ? record : null;
  });
  expect(failed.web.error?.kind).toBe("message");
  expect(existsSync(`/proc/${before.web.pid}`)).toBe(false);
  /* The launcher, the host process and its endpoint carried on, and stay up. */
  await Bun.sleep(1_500);
  expect(child.exitCode).toBeNull();
  expect(child.signalCode).toBeNull();
  const stillFailed = readRecord(fixture.state);
  expect(stillFailed.web.state).toBe("failed");
  expect(stillFailed.runtimeHost).toMatchObject({ state: "healthy", pid: before.runtimeHost.pid });
  expect(existsSync(`/proc/${before.runtimeHost.pid}`)).toBe(true);
  expect(await socketAnswers(before.socket)).toBe(true);

  /* The next explicit web restart is still taken, and moves only the web. */
  writeFileSync(before.releasePointer, JSON.stringify({ sha: healthy.sha, dir: healthy.dir, checkoutHead: fixture.first }));
  request(stillFailed, "web", "restart-web-recovered");
  const recovered = await until(() => {
    const record = readRecord(fixture.state);
    return record.web.requestId === "restart-web-recovered" && record.web.state === "healthy" ? record : null;
  });
  expect(recovered.web.error).toBeNull();
  expect(recovered.web.revision).toBe(healthy.sha.slice(0, 7));
  expect(await served(port)).toBe(healthy.dir);
  expect(recovered.runtimeHost.pid).toBe(before.runtimeHost.pid);
  expect(await socketAnswers(before.socket)).toBe(true);
  expect(child.exitCode).toBeNull();
}, 60_000);

test("a host restart whose new and previous releases both fail is retried by the backoff, never left down", async () => {
  const fixture = install();
  const { child } = await start(fixture);
  const before = await until(() => { const record = readRecord(fixture.state); return record.runtimeHost.state === "healthy" ? record : null; });
  const broken = release(fixture, "broken-host", { brokenHost: true });
  writeFileSync(before.releasePointer, JSON.stringify({ sha: broken.sha, dir: broken.dir, checkoutHead: fixture.first }));
  /* The package root's own host fails too, for as long as the restart takes. */
  const rootHost = path.join(fixture.checkout, "dist", "runtime-host.mjs");
  writeFileSync(rootHost, BROKEN_HOST);

  request(before, "runtime-host", "restart-host-both-broken");
  const failed = await until(() => {
    const record = readRecord(fixture.state);
    return record.runtimeHost.requestId === "restart-host-both-broken" && record.runtimeHost.state === "failed" ? record : null;
  });
  /* The restart's own summary: both releases were tried. */
  expect(failed.runtimeHost.error?.kind).toBe("message");
  expect(existsSync(`/proc/${before.runtimeHost.pid}`)).toBe(false);

  /* A backoff attempt that fails before readiness is recorded as failed with
     its own exit, never left reading "starting" under a PID that is gone. */
  const retried = await until(() => {
    const record = readRecord(fixture.state);
    return record.runtimeHost.pid !== failed.runtimeHost.pid && record.runtimeHost.state === "failed" ? record : null;
  }, 15_000);
  expect(retried.runtimeHost.error).toMatchObject({ kind: "exit", code: 3 });
  expect(existsSync(`/proc/${retried.runtimeHost.pid}`)).toBe(false);

  /* The previous release can start again: the backoff finds it without anyone asking. */
  writeFileSync(rootHost, STUB_HOST);
  const back = await until(() => {
    const record = readRecord(fixture.state);
    return record.runtimeHost.state === "healthy" && record.runtimeHost.pid !== before.runtimeHost.pid ? record : null;
  }, 30_000);
  expect(back.runtimeHost.revision).toBe(fixture.first.slice(0, 7));
  expect(readlinkSync(`/proc/${back.runtimeHost.pid}/cwd`)).toBe(fixture.checkout);
  expect(child.exitCode).toBeNull();
}, 60_000);
