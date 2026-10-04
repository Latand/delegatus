import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterAll, afterEach, expect } from "bun:test";

/*
 * The install the self-update integration files drive through the real
 * `bin/cli.mjs`: a git checkout whose `next` and runtime host are stubs
 * committed into the repository. Each test file that imports it calls
 * `registerSelfUpdateCleanup()` once, so its own children and roots are
 * collected by its own hooks.
 */

export const roots: string[] = [];
export const children = new Set<ReturnType<typeof spawn>>();
export const fixtureProcesses = new Map<number, string>();

export function registerSelfUpdateCleanup(): void {
  /* A child the test already stopped has fired its exit: waiting for it again
     would only run out the hook's own time. */
  afterEach(async () => {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      await Promise.race([exited, Bun.sleep(4_000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await Promise.race([exited, Bun.sleep(1_000)]);
      }
    }
    children.clear();
    const { isAlive, readStartIdentity } = await import("../../src/lib/selfUpdate/pid");
    for (const [pid, identity] of fixtureProcesses) {
      if (!isAlive(pid) || readStartIdentity(pid) !== identity) continue;
      process.kill(pid, "SIGTERM");
      const deadline = Date.now() + 2000;
      while (isAlive(pid) && Date.now() < deadline) await Bun.sleep(25);
      if (isAlive(pid) && readStartIdentity(pid) === identity) process.kill(pid, "SIGKILL");
    }
    fixtureProcesses.clear();
  }, 10_000);
  afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
}

export const identity = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false"];
export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", [...identity, ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/* The `tokenProtected` stub gates the way a Viewer does: on the key its
   environment sets, else on the key file while a links gate or the
   phone-access flag is present. It reads the files on every request, as the
   Viewer's own gate can come on while it runs. The rule is written out here
   on purpose, so the launcher's resolver is checked against a second copy. */
/* The fixture Viewer's admission, as the launcher sees the real one: it is
   the only reader of the work an installation has admitted. Each question is
   logged with whether the launcher had taken the request by then, and the
   answer is a refusal while work the admission never saw is running. */
export const ADMISSION_LOG = "fixture-admissions.log";
export const WORK_STARTED = "fixture-work-started";
export const STUB_ADMISSION = `if (pathname === "/api/self-update/launcher-admission") {
      const fs = require("node:fs"), state = process.env.LLV_STATE_DIR;
      const filed = fs.readdirSync(state + "/self-update").some((name) => name.startsWith("request-") && !name.includes(".result") && name.endsWith(".json"));
      fs.appendFileSync(state + "/${ADMISSION_LOG}", (filed ? "request filed" : "request taken") + "\\n");
      if (fs.existsSync(state + "/${WORK_STARTED}")) return Response.json({ admitted: false });
    }`;

export const STUB_NEXT = (exitAtOnce: boolean, tokenProtected = false) => exitAtOnce ? "process.exit(3);\n" : `
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
export const config = join(process.env.XDG_CONFIG_HOME, "delegatus");
export const links = join(process.env.LLV_STATE_DIR, "links");
export const gateKey = () => {
  if (process.env.LLV_TOKEN) return process.env.LLV_TOKEN;
  let outward = false;
  try {
    const { publicUrl } = JSON.parse(readFileSync(join(links, "self.json"), "utf8"));
    outward = !["localhost", "127.0.0.1"].includes(new URL(publicUrl).hostname);
  } catch { /* no saved address */ }
  if (!outward && !existsSync(join(links, "grants.json")) && !existsSync(join(config, "phone-access"))) return null;
  return readFileSync(join(config, "token"), "utf8").trim();
};
export const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? process.argv[process.argv.indexOf("--port") + 1]),
  fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (${tokenProtected} && (pathname === "/" || pathname === "/api/self-update/launcher-admission")) {
      const key = gateKey();
      if (key && request.headers.get("authorization") !== "Bearer " + key) {
        return new Response("Unauthorized", { status: 401 });
      }
    }
    ${STUB_ADMISSION}
    if (pathname === "/api/self-update/launcher-admission") return Response.json({ admitted: true });
    return new Response(process.cwd());
  },
});
export const stop = () => { server.stop(true); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
`;

export const STUB_HOST = `
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
export const socketPath = process.env.LLV_RUNTIME_HOST_SOCKET;
export const fencePath = process.env.LLV_RUNTIME_HOST_FENCE;
mkdirSync(path.dirname(socketPath), { recursive: true });
rmSync(socketPath, { force: true });
export const server = net.createServer((socket) => {
  socket.on("error", () => {});
  socket.on("data", frame => {
    const request = JSON.parse(String(frame));
    const startIdentity = readFileSync("/proc/" + process.pid + "/stat", "utf8").split(") ")[1].split(" ")[19];
    socket.end(JSON.stringify({ id: request.id, ok: true, result: { pid: process.pid, startIdentity, hostEpoch: 1 } }) + "\\n");
  });
});
server.listen(socketPath, () => writeFileSync(fencePath, JSON.stringify({
  pid: process.pid,
  startIdentity: process.pid + ":fixture",
  acquisitionId: "fixture-acquisition-id",
})));
export const stop = () => server.close(() => { rmSync(fencePath, { force: true }); process.exit(0); });
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
`;

export const BROKEN_HOST = "process.exit(3);\n";

export function install(options: { oldSupervisor?: boolean; oldServerRuntime?: boolean; tokenProtected?: boolean } = {}) {
  const root = mkdtempSync("/var/tmp/llv-cli-self-update-");
  roots.push(root);
  const checkout = path.join(root, "checkout");
  const home = path.join(root, "home");
  const state = path.join(root, "state");
  const cache = path.join(root, "cache");
  for (const dir of [path.join(checkout, "bin"), path.join(checkout, "node_modules", ".bin"), path.join(checkout, "dist"), home, state, cache, path.join(root, "tmp")]) {
    mkdirSync(dir, { recursive: true });
  }
  for (const name of ["cli.mjs", "telemetry-notice.mjs", "agent-binaries.mjs", "server-runtime.mjs", "tailscale.mjs", "self-update-supervisor.mjs", "appDir.mjs", "envAlias.mjs", "legacySystemd.mjs", "internalService.mjs", "skillLinks.mjs", "oomPolicy.mjs", "launcher-relaunch.mjs", "launcher-adoption.mjs", "launcher-lock.mjs", "windows-process-identity.mjs", "viewerGateKey.mjs", "darwin-process-identity.mjs", "launcher-credentials.mjs"]) {
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
    } as NodeJS.ProcessEnv,
  };
}

/** A built release of a new commit, as the Viewer's step runner leaves it. */
export function release(fixture: ReturnType<typeof install>, name: string, options: { broken?: boolean; brokenHost?: boolean; upgradeSupervisor?: boolean; upgradeServerRuntime?: boolean; launcher?: string } = {}): { dir: string; sha: string } {
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

export async function availablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export function recordFile(state: string): string {
  const dir = path.join(state, "self-update");
  const name = readdirSync(dir).find((entry) => entry.startsWith("launcher-") && entry.endsWith(".json"));
  if (!name) throw new Error("no launcher record");
  return path.join(dir, name);
}

export function stateText(directory: string): string {
  return readdirSync(directory, { withFileTypes: true }).map((entry) => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return stateText(filename);
    return entry.isFile() ? readFileSync(filename, "utf8") : "";
  }).join("\n");
}

export function pointerFile(fixture: ReturnType<typeof install>): string {
  const installId = createHash("sha256").update(path.resolve(fixture.checkout)).digest("hex").slice(0, 16);
  return path.join(fixture.state, "self-update", `release-${installId}.json`);
}

export function version(fixture: ReturnType<typeof install>, extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, ["--bun", path.join(fixture.checkout, "bin", "cli.mjs"), "--version"], {
    cwd: fixture.checkout,
    env: { ...fixture.env, ...extraEnv },
    encoding: "utf8",
    timeout: 5_000,
  });
}

export type Entry = { state: string; pid: number | null; revision: string | null; requestId: string | null; error: { kind: string; revision?: string; detail?: string; text?: string } | null };
export type LauncherRecord = { launcher: { pid: number; startIdentity: string | null; autoAdmission?: number; requestId?: string; state?: string; error?: {kind: string}; revision?: string }; checkout: string | null; releasePointer: string; requestFile: string; socket: string; web: Entry; runtimeHost: Entry };

export async function until<T>(read: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
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

export function readRecord(state: string): LauncherRecord {
  const record = JSON.parse(readFileSync(recordFile(state), "utf8"));
  for (const role of [record.launcher, record.web, record.runtimeHost]) {
    if (role.pid && role.startIdentity) fixtureProcesses.set(role.pid, role.startIdentity);
  }
  return record as LauncherRecord;
}

export async function served(port: number): Promise<string> {
  return (await fetch(`http://127.0.0.1:${port}/`)).text();
}

export async function start(fixture: ReturnType<typeof install>, args: string[] = []) {
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
export function socketAnswers(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    const finish = (answered: boolean) => { socket.destroy(); resolve(answered); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(2_000, () => finish(false));
  });
}

export function request(record: LauncherRecord, role: "web" | "runtime-host", requestId: string): void {
  writeFileSync(record.requestFile, JSON.stringify({ requestId, role }));
}


export function cleanTerminalEnv(fixture: ReturnType<typeof install>): NodeJS.ProcessEnv {
  const env = { ...fixture.env };
  delete env.LLV_STATE_DIR;
  delete env.XDG_CONFIG_HOME;
  delete env.LLV_TOKEN;
  delete env.DELEGATUS_TOKEN;
  env.HOME = path.join(fixture.root, "terminal-home");
  mkdirSync(env.HOME, { recursive: true });
  return env;
}

// Compile the actual perimeter into the fixture. Launcher children serve it on
// their own listener; no copied authentication predicate can hide a lost key.
export async function protectedInstall(shape: "checkout" | "package", alias: "LLV_TOKEN" | "DELEGATUS_TOKEN") {
  const f = install();
  const bundle = await Bun.build({ entrypoints: [path.resolve("src/proxy.ts")], target: "bun", external: ["next/server"] });
  if (!bundle.success) throw new Error("Production perimeter fixture did not compile");
  writeFileSync(path.join(f.checkout, "dist", "perimeter.mjs"), await bundle.outputs[0]!.text());
  symlinkSync(path.resolve("node_modules/next"), path.join(f.checkout, "node_modules/next"), "dir");
  const server = `
    import { proxy } from "../../dist/perimeter.mjs";
    import { NextRequest } from "next/server";
    const server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT), fetch(request) {
      const result = proxy(new NextRequest(request));
      if (result.headers.get("x-middleware-next") !== "1") return result;
      const pathname = new URL(request.url).pathname;
      ${STUB_ADMISSION}
      if (pathname === "/api/self-update/launcher-admission") return Response.json({ admitted: true });
      return new Response(process.cwd());
    } });
    const stop = () => { server.stop(true); process.exit(0); };
    process.on("SIGTERM", stop); process.on("SIGINT", stop);
  `;
  writeFileSync(path.join(f.checkout, "node_modules/.bin/next"), server);
  if (shape === "package") {
    mkdirSync(path.join(f.checkout, "dist/standalone"));
    writeFileSync(path.join(f.checkout, "dist/standalone/server.js"), server.replace("../../dist/perimeter.mjs", "../perimeter.mjs"));
  }
  git(f.checkout, "add", "-f", "."); git(f.checkout, "commit", "-m", "production perimeter fixture");
  f.first = git(f.checkout, "rev-parse", "HEAD");
  // The security fixture publishes the real kernel identity before listen.
  // It never invents a fence identity for an owned host process.
  const host = STUB_HOST.replace('import path from "node:path";', 'import path from "node:path";\nimport { runtimeHostStartIdentity } from "../bin/self-update-supervisor.mjs";')
    .replace('process.pid + ":fixture"', 'runtimeHostStartIdentity(process.pid)')
    .replace('server.listen(socketPath, () => writeFileSync(fencePath, JSON.stringify({', 'writeFileSync(fencePath, JSON.stringify({')
    .replace('})));', '}));\nserver.listen(socketPath);');
  writeFileSync(path.join(f.checkout, "dist/runtime-host.mjs"), host);
  git(f.checkout, "add", "-f", "."); git(f.checkout, "commit", "-m", "kernel fence identity fixture");
  f.first = git(f.checkout, "rev-parse", "HEAD");
  const candidate = release(f, "private-terminal-candidate");
  if (shape === "package") {
    renameSync(path.join(f.checkout, ".git"), path.join(f.root, "saved-git"));
    writeFileSync(path.join(candidate.dir, "package.json"), JSON.stringify({ type: "module", version: "0.0.1" }));
  }
  const key = randomBytes(32).toString("hex");
  delete f.env.LLV_TOKEN; delete f.env.DELEGATUS_TOKEN;
  f.env[alias] = key;
  if (alias === "DELEGATUS_TOKEN") f.env.LLV_TOKEN = randomBytes(32).toString("hex");
  return { f, candidate, key };
}
export async function perimeterRemains(port: number, key: string) {
  for (const route of ["/api/files", "/api/runtime/deployments", "/api/mcp"]) {
    for (const [credential, status] of [[null, 403], ["wrong-synthetic-key", 403], [key, 200]] as const) {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, { headers: credential ? { authorization: `Bearer ${credential}` } : {}, signal: AbortSignal.timeout(2000) });
      // Keep expectations boolean: a failed assertion must never print a key.
      expect(response.status === status).toBe(true);
      expect((await response.text()).includes(key)).toBe(false);
    }
  }
}
