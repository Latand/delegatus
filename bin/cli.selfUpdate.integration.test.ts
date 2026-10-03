import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

/* The `tokenProtected` stub gates the way a Viewer does: on the key its
   environment sets, else on the key file while a links gate or the
   phone-access flag is present. It reads the files on every request, as the
   Viewer's own gate can come on while it runs. The rule is written out here
   on purpose, so the launcher's resolver is checked against a second copy. */
const STUB_NEXT = (exitAtOnce: boolean, tokenProtected = false) => exitAtOnce ? "process.exit(3);\n" : `
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const config = join(process.env.XDG_CONFIG_HOME, "delegatus");
const links = join(process.env.LLV_STATE_DIR, "links");
const gateKey = () => {
  if (process.env.LLV_TOKEN) return process.env.LLV_TOKEN;
  let outward = false;
  try {
    const { publicUrl } = JSON.parse(readFileSync(join(links, "self.json"), "utf8"));
    outward = !["localhost", "127.0.0.1"].includes(new URL(publicUrl).hostname);
  } catch { /* no saved address */ }
  if (!outward && !existsSync(join(links, "grants.json")) && !existsSync(join(config, "phone-access"))) return null;
  return readFileSync(join(config, "token"), "utf8").trim();
};
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT),
  fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (${tokenProtected} && (pathname === "/" || pathname === "/api/self-update/launcher-admission")) {
      const key = gateKey();
      if (key && request.headers.get("authorization") !== "Bearer " + key) {
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
  for (const name of ["cli.mjs", "telemetry-notice.mjs", "agent-binaries.mjs", "server-runtime.mjs", "tailscale.mjs", "self-update-supervisor.mjs", "appDir.mjs", "envAlias.mjs", "legacySystemd.mjs", "internalService.mjs", "skillLinks.mjs", "oomPolicy.mjs", "launcher-relaunch.mjs", "launcher-adoption.mjs", "launcher-lock.mjs", "windows-process-identity.mjs", "viewerGateKey.mjs"]) {
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

type Entry = { state: string; pid: number | null; revision: string | null; requestId: string | null; error: { kind: string; revision?: string; detail?: string; text?: string } | null };
type LauncherRecord = { launcher: { pid: number; autoAdmission?: number; requestId?: string; state?: string; error?: {kind: string}; revision?: string }; checkout: string | null; releasePointer: string; requestFile: string; socket: string; web: Entry; runtimeHost: Entry };

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

test("relaunch replaces launcher, web and host under the same supervisor PID", async () => {
  const fixture = install();
  const { port, child } = await start(fixture);
  const before = await until(() => {
    const record = readRecord(fixture.state);
    return record.web.state === "healthy" && record.runtimeHost.state === "healthy" ? record : null;
  });
  const next = release(fixture, "whole-install");
  writeFileSync(before.releasePointer, JSON.stringify({ sha: next.sha, dir: next.dir, checkoutHead: fixture.first }));
  writeFileSync(before.requestFile, JSON.stringify({ requestId: "whole-install", role: "relaunch", target: next.sha }));
  const after = await until(() => {
    const record = readRecord(fixture.state);
    const launcher = record.launcher as typeof record.launcher & { requestId?: string; revision?: string; state?: string };
    return launcher.requestId === "whole-install" && launcher.state === "healthy" && launcher.revision === next.sha
      && record.web.state === "healthy" && record.web.revision === next.sha.slice(0, 7)
      && record.runtimeHost.state === "healthy" && record.runtimeHost.revision === next.sha.slice(0, 7) ? record : null;
  });
  expect(after.launcher.pid).toBe(before.launcher.pid);
  expect(readlinkSync(`/proc/${after.launcher.pid}/cwd`)).toBe(next.dir);
  expect(after.web.pid).not.toBe(before.web.pid);
  expect(after.runtimeHost.pid).not.toBe(before.runtimeHost.pid);
  expect(after.web.revision).toBe(next.sha.slice(0, 7));
  expect(after.runtimeHost.revision).toBe(next.sha.slice(0, 7));
  expect(existsSync(`/proc/${before.web.pid}`)).toBe(false);
  expect(existsSync(`/proc/${before.runtimeHost.pid}`)).toBe(false);
  expect(await served(port)).toBe(next.dir);
  expect(child.exitCode).toBeNull();
}, 30_000);

test("a competing startup preserves the owner's in-flight relaunch trial", async () => {
  const fixture = install();
  const { port, child } = await start(fixture);
  const before = await until(() => { const record = readRecord(fixture.state); return record.web.state === "healthy" ? record : null; });
  const next = release(fixture, "slow-trial");
  writeFileSync(path.join(next.dir, "node_modules", ".bin", "next"), "await Bun.sleep(4000);\n" + STUB_NEXT(false));
  const pointer = JSON.stringify({ ...next, checkoutHead: fixture.first });
  writeFileSync(before.releasePointer, pointer);
  writeFileSync(before.requestFile, JSON.stringify({ role: "relaunch", requestId: "owned-trial", target: next.sha, rollbackPointer: null }));
  const trialFile = before.requestFile.replace("request-", "trial-");
  await until(() => existsSync(trialFile) && readRecord(fixture.state).web.state === "starting");
  const intent = readFileSync(trialFile, "utf8");
  const competitor = spawn(process.execPath, ["--bun", path.join(fixture.checkout, "bin", "cli.mjs"), "--no-open", "--port", String(await availablePort())], {
    cwd: fixture.checkout, env: fixture.env, stdio: "ignore",
  });
  children.add(competitor);
  await until(() => competitor.exitCode !== null);
  expect(competitor.exitCode).toBe(1);
  expect(existsSync(before.releasePointer)).toBe(true);
  expect(readFileSync(before.releasePointer, "utf8")).toBe(pointer);
  expect(readFileSync(trialFile, "utf8")).toBe(intent);
  const after = await until(() => {
    const record = readRecord(fixture.state);
    return record.web.state === "healthy" && record.web.revision === next.sha.slice(0, 7)
      && !existsSync(trialFile) ? record : null;
  });
  expect(after.launcher.pid).toBe(child.pid!);
  expect(after.runtimeHost.revision).toBe(next.sha.slice(0, 7));
  expect(await served(port)).toBe(next.dir);
}, 30_000);

test("a trial persistence failure leaves the serving processes untouched", async () => {
  const fixture = install();
  const { child, port } = await start(fixture);
  const before = await until(() => { const record = readRecord(fixture.state); return record.web.state === "healthy" ? record : null; });
  const next = release(fixture, "unwritable-trial");
  writeFileSync(before.releasePointer, JSON.stringify({ ...next, checkoutHead: fixture.first }));
  mkdirSync(before.requestFile.replace("request-", "trial-"));
  writeFileSync(before.requestFile, JSON.stringify({ requestId: "unwritable-trial", role: "relaunch", target: next.sha, rollbackPointer: null }));
  await until(() => !existsSync(before.requestFile));
  await Bun.sleep(250);
  expect(existsSync(`/proc/${before.web.pid}`)).toBe(true);
  expect(existsSync(`/proc/${before.runtimeHost.pid}`)).toBe(true);
  expect(readRecord(fixture.state).launcher.pid).toBe(before.launcher.pid);
  expect(await served(port)).toBe(fixture.checkout);
  expect(child.exitCode).toBeNull();
}, 30_000);

for (const failure of ["web", "host", "launcher", "startup"] as const) {
  test(`relaunch rolls back ${failure} failure and restores the exact pointer`, async () => {
    const fixture = install();
    const old = release(fixture, "serving");
    const rawPointer = `${JSON.stringify({ ...old, checkoutHead: fixture.first }, null, 3)}\n`;
    mkdirSync(path.dirname(pointerFile(fixture)), { recursive: true });
    writeFileSync(pointerFile(fixture), rawPointer);
    const { port, child } = await start(fixture);
    const before = await until(() => {
      const record = readRecord(fixture.state);
      return record.web.state === "healthy" && record.runtimeHost.state === "healthy" ? record : null;
    });
    const next = release(fixture, "broken-trial", {
      broken: failure === "web", brokenHost: failure === "host",
      ...(failure === "launcher" ? { launcher: 'throw new Error("fixture load failure");' } : {}),
    });
    // --version loads successfully; normal startup reaches this module later.
    if (failure === "startup") rmSync(path.join(next.dir, "bin", "oomPolicy.mjs"));
    writeFileSync(before.releasePointer, JSON.stringify({ ...next, checkoutHead: fixture.first }));
    writeFileSync(before.requestFile, JSON.stringify({ requestId: `rollback-${failure}`, role: "relaunch", target: next.sha, rollbackPointer: rawPointer }));
    const after = await until(() => {
      const record = readRecord(fixture.state);
      const launcher = record.launcher as typeof record.launcher & { requestId?: string; error?: { kind: string } };
      return launcher.requestId === `rollback-${failure}` && launcher.error?.kind === "fell-back"
        && record.web.state === "healthy" && record.runtimeHost.state === "healthy" ? record : null;
    });
    expect(readFileSync(before.releasePointer, "utf8")).toBe(rawPointer);
    expect(after.launcher.pid).toBe(before.launcher.pid);
    expect(after.web.revision).toBe(old.sha.slice(0, 7));
    expect(after.runtimeHost.revision).toBe(old.sha.slice(0, 7));
    expect(await served(port)).toBe(old.dir);
    if (failure === "launcher") {
      expect(after.web.pid).toBe(before.web.pid);
      expect(after.runtimeHost.pid).toBe(before.runtimeHost.pid);
    }
    expect(child.exitCode).toBeNull();
  }, 40_000);
}

test("relaunch without a saved pointer rolls back to the release currently serving web", async () => {
  const fixture = install();
  const { port, child } = await start(fixture);
  const before = await until(() => { const record = readRecord(fixture.state); return record.web.state === "healthy" ? record : null; });
  const serving = release(fixture, "web-already-updated");
  writeFileSync(before.releasePointer, JSON.stringify({ ...serving, checkoutHead: fixture.first }));
  request(before, "web", "web-before-relaunch");
  await until(() => {
    const record = readRecord(fixture.state);
    return record.web.state === "healthy" && record.web.revision === serving.sha.slice(0, 7);
  });
  const next = release(fixture, "failed-followup", { broken: true });
  writeFileSync(before.releasePointer, JSON.stringify({ ...next, checkoutHead: fixture.first }));
  writeFileSync(before.requestFile, JSON.stringify({ requestId: "followup-relaunch", role: "relaunch", target: next.sha }));
  const after = await until(() => {
    const record = readRecord(fixture.state);
    const launcher = record.launcher as typeof record.launcher & { requestId?: string; error?: { kind: string } };
    return launcher.requestId === "followup-relaunch" && launcher.error?.kind === "fell-back"
      && record.web.state === "healthy" && record.runtimeHost.state === "healthy" ? record : null;
  });
  expect(existsSync(before.releasePointer)).toBe(true);
  expect(JSON.parse(readFileSync(before.releasePointer, "utf8"))).toEqual({ sha: serving.sha, dir: serving.dir });
  expect(after.web.revision).toBe(serving.sha.slice(0, 7));
  expect(after.runtimeHost.revision).toBe(serving.sha.slice(0, 7));
  expect(await served(port)).toBe(serving.dir);
  expect(child.exitCode).toBeNull();
}, 30_000);

test("rollback retains the cold-restart readiness budget for the previous release", async () => {
  const fixture = install();
  writeFileSync(path.join(fixture.checkout, "node_modules", ".bin", "next"),
    'if (process.env.LLV_LAUNCHER_TRIAL) await Bun.sleep(16000);\n' + STUB_NEXT(false));
  git(fixture.checkout, "add", "-f", ".");
  git(fixture.checkout, "commit", "-m", "cold rollback fixture");
  fixture.first = git(fixture.checkout, "rev-parse", "HEAD");
  const old = release(fixture, "cold-serving");
  const rawPointer = JSON.stringify({ ...old, checkoutHead: fixture.first });
  mkdirSync(path.dirname(pointerFile(fixture)), { recursive: true });
  writeFileSync(pointerFile(fixture), rawPointer);
  const { child, port } = await start(fixture);
  const before = await until(() => { const record = readRecord(fixture.state); return record.web.state === "healthy" ? record : null; });
  const next = release(fixture, "cold-broken", { broken: true });
  writeFileSync(before.releasePointer, JSON.stringify({ ...next, checkoutHead: fixture.first }));
  writeFileSync(before.requestFile, JSON.stringify({ requestId: "cold-rollback", role: "relaunch", target: next.sha, rollbackPointer: rawPointer }));
  const after = await until(() => {
    const record = readRecord(fixture.state);
    const launcher = record.launcher as typeof record.launcher & { requestId?: string; error?: { kind: string } };
    return launcher.requestId === "cold-rollback" && launcher.error?.kind === "fell-back" && record.web.state === "healthy" ? record : null;
  }, 25_000);
  expect(after.launcher.pid).toBe(before.launcher.pid);
  expect(after.web.revision).toBe(old.sha.slice(0, 7));
  expect(readFileSync(before.releasePointer, "utf8")).toBe(rawPointer);
  expect(await served(port)).toBe(old.dir);
  expect(child.exitCode).toBeNull();
}, 30_000);

for (const shape of ["socket", "manual-port", "foreign-port"] as const) for (const matchingIdentity of [true, false]) {
test(`a recovery Viewer takeover requires its start identity, shape=${shape}, matching=${matchingIdentity}`, async () => {
  const fixture = install();
  const port = await availablePort();
  const installId = createHash("sha256").update(path.resolve(fixture.checkout)).digest("hex").slice(0, 16);
  const socket = path.join(fixture.state, `runtime-host-${installId}.sock`);
  const orphan = spawn(process.execPath, ["--bun", path.join(fixture.checkout, "node_modules", ".bin", "next")], {
    cwd: shape === "foreign-port" ? fixture.root : fixture.checkout,
    env: { ...fixture.env, PORT: String(port), ...(shape === "socket" ? { LLV_RUNTIME_HOST_SOCKET: socket } : { LLV_STATE_OWNER: "viewer" }) }, stdio: "ignore",
  });
  children.add(orphan);
  await until(() => orphan.pid && existsSync(`/proc/${orphan.pid}/stat`));
  await Bun.sleep(200);
  expect(await served(port)).toBe(shape === "foreign-port" ? fixture.root : fixture.checkout);
  const stat = readFileSync(`/proc/${orphan.pid}/stat`, "utf8");
  const startIdentity = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  const base = path.join(fixture.state, "self-update");
  mkdirSync(base, { recursive: true });
  writeFileSync(path.join(base, `adopt-${installId}.json`), JSON.stringify({ pid: orphan.pid, startIdentity: matchingIdentity ? startIdentity : "0", port, socket, installRoot: fixture.checkout }));
  const child = spawn(process.execPath, ["--bun", path.join(fixture.checkout, "bin", "cli.mjs"), "--no-open", "--port", String(port)], {
    cwd: fixture.checkout, env: fixture.env, stdio: "ignore",
  });
  children.add(child);
  if (!matchingIdentity || shape === "foreign-port") {
    await until(() => child.exitCode !== null);
    expect(child.exitCode).toBe(1);
    expect(orphan.exitCode).toBeNull();
    expect(await served(port)).toBe(shape === "foreign-port" ? fixture.root : fixture.checkout);
    return;
  }
  const record = await until(() => {
    const record = readRecord(fixture.state);
    return record.web.state === "healthy" && record.runtimeHost.state === "healthy" ? record : null;
  });
  expect(record.web.pid).not.toBe(orphan.pid);
  expect(orphan.signalCode).toBeNull();
  expect(orphan.exitCode).toBe(0);
  expect(await served(port)).toBe(fixture.checkout);
}, 30_000);
}

test("overlapping starts retain one launcher while recovery adoption waits", async () => {
  const fixture = install();
  const port = await availablePort();
  const installId = createHash("sha256").update(path.resolve(fixture.checkout)).digest("hex").slice(0, 16);
  const socket = path.join(fixture.state, `runtime-host-${installId}.sock`);
  const stopping = path.join(fixture.root, "orphan-stopping");
  const orphanEntry = path.join(fixture.root, "orphan.mjs");
  writeFileSync(orphanEntry, 'import { writeFileSync } from "node:fs";\n' + STUB_NEXT(false).replace(
    'const stop = () => { server.stop(true); process.exit(0); };',
    `const stop = () => { writeFileSync(${JSON.stringify(stopping)}, "stopping"); setTimeout(() => { server.stop(true); process.exit(0); }, 1500); };`));
  const orphan = spawn(process.execPath, ["--bun", orphanEntry], {
    cwd: fixture.checkout, env: { ...fixture.env, PORT: String(port), LLV_RUNTIME_HOST_SOCKET: socket }, stdio: "ignore",
  });
  children.add(orphan);
  await Bun.sleep(200);
  expect(await served(port)).toBe(fixture.checkout);
  const stat = readFileSync(`/proc/${orphan.pid}/stat`, "utf8");
  const startIdentity = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  const base = path.join(fixture.state, "self-update");
  mkdirSync(base, { recursive: true });
  writeFileSync(path.join(base, `adopt-${installId}.json`), JSON.stringify({ pid: orphan.pid, startIdentity, port, socket }));
  const launch = (onPort: number) => {
    const child = spawn(process.execPath, ["--bun", path.join(fixture.checkout, "bin", "cli.mjs"), "--no-open", "--port", String(onPort)], {
      cwd: fixture.checkout, env: fixture.env, stdio: "ignore",
    });
    children.add(child);
    return child;
  };
  const first = launch(port);
  await until(() => existsSync(stopping));
  const second = launch(await availablePort());
  await until(() => second.exitCode !== null);
  expect(second.exitCode).toBe(1);
  const record = await until(() => {
    const record = readRecord(fixture.state);
    return record.web.state === "healthy" && record.runtimeHost.state === "healthy" ? record : null;
  });
  expect(record.launcher.pid).toBe(first.pid!);
  expect(first.exitCode).toBeNull();
  expect(await served(port)).toBe(fixture.checkout);
}, 30_000);

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

/* Where the key the Viewer gates on comes from. The first three reach it
   through the launcher's environment; the last three are a key the Viewer
   picks for itself from the key file, which the launcher never handed it. */
const KEY_SOURCES = ["LLV_TOKEN", "DELEGATUS_TOKEN", "generated", "links-grants", "links-public-address", "phone-access-after-start"] as const;

for (const tokenSource of KEY_SOURCES) {
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
      const fromEnvironment = tokenSource === "LLV_TOKEN" || tokenSource === "DELEGATUS_TOKEN";
      const fromKeyFile = !fromEnvironment && tokenSource !== "generated";
      const token = fromKeyFile ? randomBytes(16).toString("hex") : "fixture-update-access";
      const config = path.join(env.XDG_CONFIG_HOME as string, "delegatus");
      if (fromEnvironment) env[tokenSource] = token;
      if (fromKeyFile) {
        mkdirSync(path.join(fixture.state, "links"), { recursive: true });
        mkdirSync(config, { recursive: true });
        writeFileSync(path.join(config, "token"), `${token}\n`, { mode: 0o600 });
      }
      if (tokenSource === "links-grants") writeFileSync(path.join(fixture.state, "links", "grants.json"), "{}\n");
      if (tokenSource === "links-public-address") {
        writeFileSync(path.join(fixture.state, "links", "self.json"), JSON.stringify({ publicUrl: "https://board.example.test" }));
      }
      const running = await start(fixture, tokenSource === "generated" ? ["--hostname", "0.0.0.0"] : []);
      const before = await until(() => {
        const record = readRecord(fixture.state);
        return record.web.state === "healthy" && record.runtimeHost.state === "healthy" ? record : null;
      });
      const url = `http://127.0.0.1:${running.port}/`;
      if (tokenSource === "phone-access-after-start") {
        /* The phone-access button: the gate comes on in a Viewer whose
           launcher started before the choice was made. */
        expect((await fetch(url)).status).toBe(200);
        writeFileSync(path.join(config, "phone-access"), "tailscale\n");
      }
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
      if (fromKeyFile) {
        expect(stateText(fixture.state)).not.toContain(token);
        expect(running.output()).not.toContain(token);
      }
    }, 60_000);
  }
}

/* A key no header can carry: the probe goes out without it and is refused.
   The process that refused it is up and gating, so the restart ends with the
   release that served before still serving, never with no web. */
for (const invalidCharacter of ["\n", "\r", "\u0100", "\u0436", "\u00e9"] as const) {
  test(`a key the probe cannot send keeps the previous release serving and stays out of diagnostics (${JSON.stringify(invalidCharacter)})`, async () => {
    const fixture = install({ tokenProtected: true });
    const token = `fixture-prefix${invalidCharacter}fixture-suffix`;
    fixture.env.LLV_TOKEN = token;
    const running = await start(fixture);
    const before = await until(() => {
      const record = readRecord(fixture.state);
      return record.web.state === "healthy" && record.runtimeHost.state === "healthy" ? record : null;
    });
    const url = `http://127.0.0.1:${running.port}/`;
    expect((await fetch(url)).status).toBe(401);
    const next = release(fixture, "malformed-token-update");
    writeFileSync(before.releasePointer, JSON.stringify({ ...next, checkoutHead: fixture.first }));
    request(before, "web", "restart-malformed-token");

    const after = await until(() => {
      const record = readRecord(fixture.state);
      return record.web.requestId === "restart-malformed-token" && ["healthy", "failed"].includes(record.web.state) ? record : null;
    });
    expect(after.web.state).toBe("healthy");
    expect(after.web.revision).toBe(fixture.first.slice(0, 7));
    expect(after.web.error).toMatchObject({ kind: "fell-back", revision: next.sha.slice(0, 7) });
    expect(after.web.error?.detail).toContain("GET / answered 401");
    expect(after.web.pid).not.toBe(before.web.pid);
    expect(existsSync(`/proc/${after.web.pid}`)).toBe(true);
    /* Still up and still gating. */
    expect((await fetch(url)).status).toBe(401);
    expect(stateText(fixture.state)).not.toContain(token);
    expect(running.output()).not.toContain(token);
    expect(after.runtimeHost.pid).toBe(before.runtimeHost.pid);
    expect(await socketAnswers(before.socket)).toBe(true);
    expect(running.child.exitCode).toBeNull();

    /* With nothing new published the restarted release is the one that was
       serving, so a refusal keeps it without a second start. */
    writeFileSync(before.releasePointer, JSON.stringify({ sha: fixture.first, dir: fixture.checkout, checkoutHead: fixture.first }));
    request(after, "web", "restart-malformed-token-again");
    const again = await until(() => {
      const record = readRecord(fixture.state);
      return record.web.requestId === "restart-malformed-token-again" && ["healthy", "failed"].includes(record.web.state) ? record : null;
    });
    expect(again.web.state).toBe("healthy");
    expect(again.web.error?.kind).toBe("message");
    expect(again.web.error?.text).toContain("GET / answered 401");
    expect((await fetch(url)).status).toBe(401);
    expect(stateText(fixture.state)).not.toContain(token);
    expect(running.output()).not.toContain(token);
  }, 60_000);
}

test("a key with a tab inside is sent, and the restart moves onto the new release", async () => {
  const fixture = install({ tokenProtected: true });
  const token = "fixture-prefix\tfixture-suffix";
  fixture.env.LLV_TOKEN = token;
  const running = await start(fixture);
  const before = await until(() => {
    const record = readRecord(fixture.state);
    return record.web.state === "healthy" && record.runtimeHost.state === "healthy" ? record : null;
  });
  const next = release(fixture, "tab-token-update");
  writeFileSync(before.releasePointer, JSON.stringify({ ...next, checkoutHead: fixture.first }));
  request(before, "web", "restart-tab-token");
  const after = await until(() => {
    const record = readRecord(fixture.state);
    return record.web.requestId === "restart-tab-token" && ["healthy", "failed"].includes(record.web.state) ? record : null;
  });
  expect(after.web.state).toBe("healthy");
  expect(after.web.error).toBeNull();
  expect(after.web.revision).toBe(next.sha.slice(0, 7));
  expect((await fetch(`http://127.0.0.1:${running.port}/`)).status).toBe(401);
  expect(stateText(fixture.state)).not.toContain(token);
  expect(running.output()).not.toContain(token);
}, 60_000);

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

test("the serving web is recovered with backoff after an unexpected exit", async () => {
  const fixture = install();
  const { port, child } = await start(fixture);
  const before = await until(() => { const record = readRecord(fixture.state); return record.web.state === "healthy" ? record : null; });
  // Signal exactly the child recorded by this test's own launcher.
  process.kill(before.web.pid!, "SIGTERM");
  const after = await until(() => {
    const record = readRecord(fixture.state);
    return record.web.state === "healthy" && record.web.pid !== before.web.pid ? record : null;
  });
  expect(after.launcher.pid).toBe(before.launcher.pid);
  expect(after.runtimeHost.pid).toBe(before.runtimeHost.pid);
  expect(await served(port)).toBe(fixture.checkout);
  expect(child.exitCode).toBeNull();
}, 30_000);

for (const intervening of ["none", "runtime-host", "relaunch"] as const) {
test(`a foreign port owner is left alone and recovery survives ${intervening}`, async () => {
  const fixture = install();
  const { port, child } = await start(fixture);
  const before = await until(() => { const record = readRecord(fixture.state); return record.web.state === "healthy" ? record : null; });
  process.kill(before.web.pid!, "SIGTERM");
  await until(() => !existsSync(`/proc/${before.web.pid}`));
  const foreign = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("foreign") });
  try {
    request(before, "web", "foreign-port");
    const refused = await until(() => {
      const record = readRecord(fixture.state);
      return record.web.requestId === "foreign-port" && record.web.error?.kind === "port-in-use" ? record : null;
    });
    expect(refused.runtimeHost.pid).toBe(before.runtimeHost.pid);
    expect(await served(port)).toBe("foreign");
    expect(child.exitCode).toBeNull();
    if (intervening === "runtime-host") {
      request(before, "runtime-host", "intervening-host");
      await until(() => {
        const record = readRecord(fixture.state);
        return record.runtimeHost.requestId === "intervening-host" && record.runtimeHost.state === "healthy";
      });
    }
    if (intervening === "relaunch") {
      const next = release(fixture, "failed-preflight", { launcher: 'throw new Error("fixture preflight failure");' });
      writeFileSync(before.releasePointer, JSON.stringify({ ...next, checkoutHead: fixture.first }));
      writeFileSync(before.requestFile, JSON.stringify({ role: "relaunch", requestId: "intervening-relaunch", target: next.sha }));
      await until(() => {
        const record = readRecord(fixture.state);
        const launcher = record.launcher as typeof record.launcher & { requestId?: string; error?: { kind: string } };
        return launcher.requestId === "intervening-relaunch" && launcher.error?.kind === "fell-back";
      });
    }
  } finally { foreign.stop(true); }
  const after = await until(() => {
    const record = readRecord(fixture.state);
    return record.web.state === "healthy" && record.web.pid !== before.web.pid ? record : null;
  });
  if (intervening !== "runtime-host") expect(after.runtimeHost.pid).toBe(before.runtimeHost.pid);
  expect(await served(port)).toBe(fixture.checkout);
}, 30_000);
}

for (const source of ["argument", "environment"] as const) {
test(`web recovery consumes operator rotation once from ${source}`, async () => {
  const fixture = install();
  const log = path.join(fixture.root, "rotation-log");
  writeFileSync(path.join(fixture.checkout, "node_modules", ".bin", "next"),
    `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(log)}, String(process.env.LLV_ROTATE_OPERATOR_SPAWN_CAPABILITY) + "\\n");\n` + STUB_NEXT(false));
  const env = source === "environment" ? { ...fixture.env, LLV_ROTATE_OPERATOR_SPAWN_CAPABILITY: "1" } : fixture.env;
  const { port } = await start({ ...fixture, env }, source === "argument" ? ["--new-operator-token"] : []);
  const before = await until(() => { const record = readRecord(fixture.state); return record.web.state === "healthy" ? record : null; });
  process.kill(before.web.pid!, "SIGTERM");
  await until(() => { const record = readRecord(fixture.state); return record.web.state === "healthy" && record.web.pid !== before.web.pid ? record : null; });
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["1", "undefined"]);
  expect(await served(port)).toBe(fixture.checkout);
}, 30_000);
}

test("a second launcher preserves the live launcher's record and children", async () => {
  const fixture = install();
  const first = await start(fixture);
  const before = await until(() => { const record = readRecord(fixture.state); return record.web.state === "healthy" ? record : null; });
  const second = spawn(process.execPath, ["--bun", path.join(fixture.checkout, "bin", "cli.mjs"), "--no-open", "--port", String(await availablePort())], {
    cwd: fixture.checkout, env: fixture.env, stdio: "ignore",
  });
  children.add(second);
  await until(() => second.exitCode !== null);
  expect(second.exitCode).toBe(1);
  const after = readRecord(fixture.state);
  expect(after.launcher.pid).toBe(before.launcher.pid);
  expect(after.web.pid).toBe(before.web.pid);
  expect(after.runtimeHost.pid).toBe(before.runtimeHost.pid);
  expect(await served(first.port)).toBe(fixture.checkout);
}, 30_000);

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
    return record.runtimeHost.requestId === "restart-host-both-broken" && record.runtimeHost.state === "failed"
      && record.runtimeHost.error?.kind === "message" ? record : null;
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

for (const broken of [false, true]) {
  test(`a packaged install relaunches all processes and rolls back=${broken}`, async () => {
    const fixture = install();
    const next = release(fixture, "npm-package", { broken });
    writeFileSync(path.join(next.dir, "package.json"), JSON.stringify({ name: "delegatus-cli", version: "0.0.1" }));
    mkdirSync(path.join(next.dir, "dist", "standalone"), { recursive: true });
    writeFileSync(path.join(next.dir, "dist", "standalone", "server.js"), STUB_NEXT(broken));
    renameSync(path.join(fixture.checkout, ".git"), path.join(fixture.root, "saved-git"));
    const running = await start(fixture);
    const before = await until(() => { const r = readRecord(fixture.state); return r.web.state === "healthy" ? r : null; });
    expect(before.checkout).toBeNull();
    writeFileSync(before.releasePointer, JSON.stringify({ kind: "package", version: "0.0.1", baseVersion: "0.0.0", dir: next.dir, sha: next.sha }));
    writeFileSync(before.requestFile, JSON.stringify({ requestId: "package-relaunch", role: "relaunch", target: next.sha, rollbackPointer: null }));
    const after = await until(() => { const r = readRecord(fixture.state);
      return r.launcher.requestId === "package-relaunch" && r.launcher.state === "healthy" && r.web.state === "healthy" && r.runtimeHost.state === "healthy" ? r : null;
    }, 100_000);
    expect(after.launcher.pid).toBe(before.launcher.pid);
    expect(after.web.pid).not.toBe(before.web.pid);
    expect(after.runtimeHost.pid).not.toBe(before.runtimeHost.pid);
    expect(await served(running.port)).toBe(broken ? fixture.checkout : next.dir + "/dist/standalone");
    if (broken) { expect(after.launcher.error?.kind).toBe("fell-back"); expect(existsSync(before.releasePointer)).toBe(false); }
    else expect(after.launcher.revision).toBe(next.sha);
  }, 120_000);
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
  const pointer = JSON.stringify({ sha: target, dir: nextDir, checkoutHead: first });
  writeFileSync(record.releasePointer, pointer);
  writeFileSync(record.requestFile, JSON.stringify({ role: "relaunch", requestId: "real-success", target, rollbackPointer: null }));
  record = await until(() => { const r = readHealthy(); return r?.launcher.requestId === "real-success" && r.launcher.revision === target ? r : null; }, 150_000);
  expect(record.web.pid).not.toBe(oldWeb); expect(record.runtimeHost.pid).not.toBe(oldHost);
  expect(record.web.revision).toBe(target.slice(0, 7)); expect(record.runtimeHost.revision).toBe(target.slice(0, 7));
  await health(record);

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
}, 480_000);


// A first upgrade can roll back to a launcher that predates this protocol.
// The optional local source fixture is the exact base checkout, never a live install.
const legacySource = process.env.LLV_REHEARSAL_LEGACY;
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
  const action = installAction({ mode: "package", reason: null, record }, { cgroup: () => "", ready: () => true, argv: () => [] });
  const closed = new Promise(resolve => running.child.once("exit", resolve)); running.child.kill("SIGTERM"); await closed;
  const child = spawn("sh", ["-c", action!.command!], { cwd: fixture.checkout, env: fixture.env, stdio: "ignore" }); children.add(child);
  const after = await until(() => { const r = readRecord(fixture.state); return r.launcher.pid !== before.launcher.pid && r.web.state === "healthy" && r.runtimeHost.state === "healthy"
    && (broken ? !existsSync(before.releasePointer) : r.launcher.requestId === controller.current!.requestId) ? r : null; }, 60_000);
  expect(await served(running.port)).toBe((broken ? fixture.checkout : candidate.dir) + "/dist/standalone");
  const cold = new ApplyController(path.dirname(before.requestFile)); expect(cold.observe(after as unknown as import("../src/lib/selfUpdate/launcher").LauncherRecord, await socketAnswers(after.socket))).toBe(broken ? "failed" : "done");
  expect(cold.current).toMatchObject({ state: broken ? "failed" : "done", rolledBack: broken });
}, 90_000);
