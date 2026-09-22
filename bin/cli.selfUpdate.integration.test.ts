import { spawn, spawnSync } from "node:child_process";
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

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await Promise.race([new Promise<void>((resolve) => child.once("exit", () => resolve())), Bun.sleep(5_000)]);
  }
  children.clear();
});
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const identity = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false"];
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", [...identity, ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

const STUB_NEXT = (exitAtOnce: boolean) => exitAtOnce ? "process.exit(3);\n" : `
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT),
  fetch() { return new Response(process.cwd()); },
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

function install() {
  const root = mkdtempSync("/var/tmp/llv-cli-self-update-");
  roots.push(root);
  const checkout = path.join(root, "checkout");
  const home = path.join(root, "home");
  const state = path.join(root, "state");
  const cache = path.join(root, "cache");
  for (const dir of [path.join(checkout, "bin"), path.join(checkout, "node_modules", ".bin"), path.join(checkout, "dist"), home, state, cache, path.join(root, "tmp")]) {
    mkdirSync(dir, { recursive: true });
  }
  for (const name of ["cli.mjs", "server-runtime.mjs", "tailscale.mjs", "self-update-supervisor.mjs"]) {
    copyFileSync(path.resolve("bin", name), path.join(checkout, "bin", name));
  }
  writeFileSync(path.join(checkout, "package.json"), JSON.stringify({ type: "module", version: "0.0.0" }));
  writeFileSync(path.join(checkout, "node_modules", ".bin", "next"), STUB_NEXT(false));
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
function release(fixture: ReturnType<typeof install>, name: string, options: { broken?: boolean; brokenHost?: boolean } = {}): { dir: string; sha: string } {
  git(fixture.checkout, "checkout", "--quiet", "--detach", fixture.first);
  writeFileSync(path.join(fixture.checkout, "notes.txt"), `${name}\n`);
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

type Entry = { state: string; pid: number | null; revision: string | null; requestId: string | null; error: { kind: string; revision?: string } | null };
type Record = { checkout: string | null; releasePointer: string; requestFile: string; web: Entry; runtimeHost: Entry };

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

function readRecord(state: string): Record {
  return JSON.parse(readFileSync(recordFile(state), "utf8")) as Record;
}

async function served(port: number): Promise<string> {
  return (await fetch(`http://127.0.0.1:${port}/`)).text();
}

async function start(fixture: ReturnType<typeof install>) {
  const port = await availablePort();
  const child = spawn(process.execPath, ["--bun", path.join(fixture.checkout, "bin", "cli.mjs"), "--no-open", "--port", String(port)], {
    cwd: fixture.checkout,
    env: fixture.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let output = "";
  child.stdout?.on("data", (chunk) => { output += String(chunk); });
  child.stderr?.on("data", (chunk) => { output += String(chunk); });
  await until(() => output.includes("Agent Log Viewer"), 20_000).catch((error) => { throw new Error(`${String(error)}\n${output}`); });
  return { port, child, output: () => output };
}

function request(record: Record, role: "web" | "runtime-host", requestId: string): void {
  writeFileSync(record.requestFile, JSON.stringify({ requestId, role }));
}

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
  expect(failed.runtimeHost.error?.kind).toBe("message");
  expect(existsSync(`/proc/${before.runtimeHost.pid}`)).toBe(false);

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
