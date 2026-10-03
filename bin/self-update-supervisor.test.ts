import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createLauncherRecord,
  exitError,
  hostEntrypoint,
  installedRelease,
  probePageAndChunk,
  readStartIdentity,
  selfUpdatePaths,
  watchRestartRequests,
} from "./self-update-supervisor.mjs";

/* The launcher's half of self-update (#2007). A real git checkout and a
   release worktree stand in for an install; nothing is started or signalled. */
const root = mkdtempSync("/var/tmp/self-update-launcher-");
const checkout = join(root, "checkout");
const release = join(root, "release");
const identity = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false"];

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", [...identity, ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

let first = "";
let second = "";

beforeAll(() => {
  mkdirSync(checkout, { recursive: true });
  git(checkout, "init", "--initial-branch=main");
  writeFileSync(join(checkout, "package.json"), "{\"version\":\"1.0.0\"}\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "-m", "first");
  first = git(checkout, "rev-parse", "HEAD");
  writeFileSync(join(checkout, "notes.txt"), "second\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "-m", "second");
  second = git(checkout, "rev-parse", "HEAD");
  git(checkout, "checkout", "--detach", first);
  git(checkout, "worktree", "add", "--detach", release, second);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function publish(pointer: string, body: Record<string, unknown>): void {
  writeFileSync(pointer, `${JSON.stringify(body)}\n`);
}

describe("installedRelease", () => {
  const pointer = join(root, "release.json");

  test("with nothing published the package root runs, at its HEAD", () => {
    expect(installedRelease(pointer, checkout)).toEqual({ dir: checkout, sha: first, published: false });
  });

  test("a published release without a build is not run", () => {
    publish(pointer, { sha: second, dir: release, checkoutHead: first });
    expect(installedRelease(pointer, checkout).dir).toBe(checkout);
  });

  test("a built release of the named commit is run", () => {
    mkdirSync(join(release, ".next"), { recursive: true });
    writeFileSync(join(release, ".next", "BUILD_ID"), "build\n");
    publish(pointer, { sha: second, dir: release, checkoutHead: first });
    expect(installedRelease(pointer, checkout)).toEqual({ dir: release, sha: second, published: true });
  });

  test("a pointer naming a commit its directory does not hold is not run", () => {
    publish(pointer, { sha: first, dir: release, checkoutHead: first });
    expect(installedRelease(pointer, checkout).dir).toBe(checkout);
  });

  test("a package root that moved since the release was published wins", () => {
    publish(pointer, { sha: second, dir: release, checkoutHead: "0".repeat(40) });
    expect(installedRelease(pointer, checkout)).toEqual({ dir: checkout, sha: first, published: false });
  });

  test("an unreadable pointer falls back to the package root", () => {
    writeFileSync(pointer, "{not json");
    expect(installedRelease(pointer, checkout).dir).toBe(checkout);
  });
});

describe("paths, entry and identity", () => {
  test("the record, request and pointer live in the state directory; releases in the cache", () => {
    const paths = selfUpdatePaths({ stateDirectory: "/s", cacheDirectory: "/c", installId: "abc" });
    expect(paths).toEqual({
      record: "/s/self-update/launcher-abc.json",
      request: "/s/self-update/request-abc.json",
      releasePointer: "/s/self-update/release-abc.json",
      trial: "/s/self-update/trial-abc.json",
      adopt: "/s/self-update/adopt-abc.json",
      releasesDir: "/c/delegatus/self-update/abc/releases",
    });
  });

  test("an existing install's cache keeps its agent-log-viewer spelling", () => {
    const cache = mkdtempSync(join(tmpdir(), "llv-self-update-cache-"));
    try {
      mkdirSync(join(cache, "agent-log-viewer"));
      expect(selfUpdatePaths({ stateDirectory: "/s", cacheDirectory: cache, installId: "abc" }).releasesDir)
        .toBe(join(cache, "agent-log-viewer", "self-update", "abc", "releases"));
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });

  test("the host entry of a release is its bundle when present, else the source entry", () => {
    expect(hostEntrypoint(release)).toBe(join(release, "src", "runtime-host", "main.ts"));
    mkdirSync(join(release, "dist"), { recursive: true });
    writeFileSync(join(release, "dist", "runtime-host.mjs"), "");
    expect(hostEntrypoint(release)).toBe(join(release, "dist", "runtime-host.mjs"));
  });

  test("this process has a start identity, and a PID that does not exist has none", () => {
    expect(readStartIdentity(process.pid)).toMatch(process.platform === "win32" ? /^\d+:\d+$/ : process.platform === "darwin" ? /^ps:/ : /^\d+$/);
    expect(readStartIdentity(2 ** 30)).toBeNull();
  });

  test("an exit is recorded as facts the surface words", () => {
    expect(exitError({ exitCode: 3, signalCode: null }, 1_000, () => 1_800)).toEqual({ kind: "exit", code: 3, signal: null, afterMs: 800 });
  });
});

describe("the launcher record", () => {
  test("records the launcher, then each child with its PID, identity and release", () => {
    const file = join(root, "record", "launcher.json");
    const record = createLauncherRecord(file, {
      checkout,
      releasesDir: "/c/releases",
      releasePointer: "/s/release.json",
      requestFile: "/s/request.json",
      port: 45123,
      socket: "/s/runtime-host.sock",
    }, () => Date.parse("2026-09-22T12:00:00Z"));
    record.started("web", { pid: process.pid }, { sha: second });
    record.set("web", { state: "healthy" });
    const written = JSON.parse(readFileSync(file, "utf8"));
    expect(written.version).toBe(1);
    expect(written.launcher.pid).toBe(process.pid);
    expect(written.launcher.startIdentity).toBe(readStartIdentity(process.pid));
    expect(written.launcher.autoAdmission).toBe(1);
    expect(written.checkout).toBe(checkout);
    expect(written.web).toMatchObject({ state: "healthy", pid: process.pid, revision: second.slice(0, 7), startedAt: "2026-09-22T12:00:00.000Z" });
    expect(written.web.startIdentity).toBe(readStartIdentity(process.pid));
    expect(written.runtimeHost.state).toBe("stopped");
    record.remove();
    expect(existsSync(file)).toBe(false);
  });
});

describe("restart requests", () => {
  test("an automatic request without a final admission callback is discarded", async () => {
    const file = join(root, "request-auto-unadmitted.json");
    const gateFile = join(root, "auto-admission.json");
    let restarted = false;
    writeFileSync(gateFile, JSON.stringify({ id: "unadmitted", until: Date.now() + 60_000 }));
    writeFileSync(file, JSON.stringify({ requestId: "unadmitted", role: "web", autoGateId: "unadmitted" }));
    const watcher = watchRestartRequests(file, async () => { restarted = true; }, { intervalMs: 60_000 });
    try {
      await watcher.poll();
      expect(restarted).toBe(false);
      expect(JSON.parse(readFileSync(`${file}.result.json`, "utf8"))).toMatchObject({ requestId: "unadmitted", state: "rejected" });
      expect(existsSync(file)).toBe(false);
      expect(existsSync(gateFile)).toBe(false);
    } finally { watcher.stop(); }
  });

  for (const role of ["web", "runtime-host"] as const) {
    test(`automatic ${role} admission defers work that started after the web probe`, async () => {
      const file = join(root, `request-auto-${role}.json`);
      const gateFile = join(root, "auto-admission.json");
      const seen: string[] = [];
      let working = true;
      const watcher = watchRestartRequests(file, async (request) => { seen.push(request.role); }, {
        intervalMs: 60_000,
        admitAuto: async () => !working,
      });
      try {
        writeFileSync(gateFile, JSON.stringify({ id: "gate", until: Date.now() + 60_000 }));
        writeFileSync(file, JSON.stringify({ requestId: "busy", role, autoGateId: "gate" }));
        await watcher.poll();
        expect(seen).toEqual([]);
        expect(existsSync(file)).toBe(false);
        expect(existsSync(gateFile)).toBe(false);
        working = false;
        writeFileSync(gateFile, JSON.stringify({ id: "gate-2", until: Date.now() + 60_000 }));
        writeFileSync(file, JSON.stringify({ requestId: "quiet", role, autoGateId: "gate-2" }));
        await watcher.poll();
        expect(seen).toEqual([role]);
        expect(existsSync(gateFile)).toBe(false);
      } finally { watcher.stop(); }
    });
  }

  test("a request is consumed once and handed over; malformed ones are dropped", async () => {
    const file = join(root, "request.json");
    const seen: string[] = [];
    const watcher = watchRestartRequests(file, async (request) => { seen.push(`${request.role}:${request.requestId}`); }, { intervalMs: 60_000 });
    try {
      writeFileSync(file, JSON.stringify({ requestId: "r1", role: "web" }));
      await watcher.poll();
      expect(seen).toEqual(["web:r1"]);
      expect(existsSync(file)).toBe(false);
      await watcher.poll();
      expect(seen).toEqual(["web:r1"]);
      writeFileSync(file, JSON.stringify({ requestId: "r2", role: "everything" }));
      await watcher.poll();
      writeFileSync(file, "not json");
      await watcher.poll();
      expect(seen).toEqual(["web:r1"]);
      expect(existsSync(file)).toBe(false);
    } finally {
      watcher.stop();
    }
  });

  test("a request that arrives while one is handled waits for it", async () => {
    const file = join(root, "request-serial.json");
    const seen: string[] = [];
    let release: () => void = () => {};
    const watcher = watchRestartRequests(file, (request) => {
      seen.push(request.requestId);
      return request.requestId === "a" ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve();
    }, { intervalMs: 60_000 });
    try {
      writeFileSync(file, JSON.stringify({ requestId: "a", role: "runtime-host" }));
      const first = watcher.poll();
      await Bun.sleep(5);
      writeFileSync(file, JSON.stringify({ requestId: "b", role: "web" }));
      await watcher.poll();
      expect(seen).toEqual(["a"]);
      expect(existsSync(file)).toBe(true);
      release();
      await first;
      await watcher.poll();
      expect(seen).toEqual(["a", "b"]);
    } finally {
      watcher.stop();
    }
  });
});

describe("probePageAndChunk", () => {
  let server: Server;
  let port = 0;
  let chunkStatus = 200;
  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === "/") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end('<script src="/_next/static/chunks/app.js"></script>');
        return;
      }
      response.writeHead(request.url === "/_next/static/chunks/app.js" ? chunkStatus : 404);
      response.end("");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => { server.close(); });

  test("ready when the page and the first chunk it references both answer 200", async () => {
    chunkStatus = 200;
    expect(await probePageAndChunk(port)).toBeNull();
  });

  test("not ready when the page answers but its own chunk does not", async () => {
    chunkStatus = 500;
    expect(await probePageAndChunk(port)).toBe("GET /_next/static/chunks/app.js answered 500");
  });

  test("does not expose malformed bearer values from fetch errors", async () => {
    const token = `fixture-prefix\nfixture-suffix`;
    const error = await probePageAndChunk(port, 5_000, { authorization: `Bearer ${token}` });
    expect(error).toMatch(/^Viewer readiness probe failed( \([A-Za-z0-9_]+\))?$/);
    expect(error).not.toContain(token);
  });

  test("a refused connection and a timeout are told apart without the error's text", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const closedPort = (closed.address() as { port: number }).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const refused = await probePageAndChunk(closedPort);

    const silent = createServer(() => { /* never answers */ });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const timedOut = await probePageAndChunk((silent.address() as { port: number }).port, 200);
    silent.closeAllConnections();
    silent.close();

    expect(refused).toMatch(/^Viewer readiness probe failed \([A-Za-z0-9_]+\)$/);
    expect(timedOut).toMatch(/^Viewer readiness probe failed \([A-Za-z0-9_]+\)$/);
    expect(refused).not.toBe(timedOut);
  });
});

test("a packaged pointer survives bootstrap until a manual package upgrade", () => {
  const root = mkdtempSync(join(tmpdir(), "package-pointer-"));
  try {
    const base = join(root, "base"); const release = join(root, "release");
    mkdirSync(join(base, "dist"), { recursive: true });
    mkdirSync(join(release, "dist", "standalone"), { recursive: true });
    writeFileSync(join(base, "package.json"), JSON.stringify({ version: "1.0.0" }));
    writeFileSync(join(release, "package.json"), JSON.stringify({ version: "1.0.1" }));
    writeFileSync(join(release, "dist", "standalone", "server.js"), "");
    writeFileSync(join(release, "dist", "runtime-host.mjs"), "");
    const pointer = join(root, "pointer.json"); const sha = "a".repeat(40);
    writeFileSync(pointer, JSON.stringify({ kind: "package", version: "1.0.1", baseVersion: "1.0.0", dir: release, sha }));
    expect(installedRelease(pointer, base)).toMatchObject({ dir: release, sha, published: true });
    writeFileSync(join(base, "package.json"), JSON.stringify({ version: "1.0.2" }));
    expect(installedRelease(pointer, base)).toMatchObject({ dir: base, published: false });
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("Windows launcher and Viewer identities agree on the kernel creation token", async () => {
  const { readStartIdentity: viewerIdentity } = await import("../src/lib/selfUpdate/pid");
  const pid = 2147483000; const calls: unknown[][] = [];
  const run = (...args: unknown[]) => { calls.push(args); return { status: 0, stdout: "133000000000000001\r\n" }; };
  expect(readStartIdentity(pid, "win32", run as never)).toBe(`${pid}:133000000000000001`);
  expect(viewerIdentity(pid, "win32", run as never)).toBe(`${pid}:133000000000000001`);
  expect(calls.length).toBe(2);
  const script = Buffer.from((calls[0]![1] as string[]).at(-1)!, "base64").toString("utf16le");
  expect(script).toContain("GetProcessById"); expect(script).toContain("StartTime.ToFileTimeUtc()"); expect(script).toContain("HasExited");
  expect(readStartIdentity(pid, "win32", (() => ({ status: 1, stdout: "133000000000000001" })) as never)).toBeNull();
  expect(readStartIdentity(pid, "win32", (() => ({ status: 0, stdout: "1" })) as never)).toBeNull();
});


test("macOS orphan takeover verifies the kernel fence and retains legacy launcher identity", async () => {
  const { takeOverOrphanHost } = await import("./launcher-adoption.mjs");
  const { parseDarwinProcBsdInfoIdentity } = await import("../src/lib/proc/darwinIdentity");
  const root = mkdtempSync(join(tmpdir(), "macos-orphan-fence-"));
  try {
    const pid = 42420; const buffer = Buffer.alloc(136);
    buffer.writeUInt32LE(pid, 12); buffer.writeBigUInt64LE(1_700_000_000n, 120); buffer.writeBigUInt64LE(123456n, 128);
    const kernel = parseDarwinProcBsdInfoIdentity(pid, buffer, 136)!;
    const { parseDarwinIdentity } = await import("./darwin-process-identity.mjs");
    expect(parseDarwinIdentity(pid, buffer, 136)).toBe(kernel);
    const fencePath = join(root, "fence.json"); const stopped: unknown[] = [];
    const ports = { launcherIdentity: () => "ps:fixture start", hostIdentity: () => kernel,
      stop: async (...args: unknown[]) => { stopped.push(args); return true; } };
    writeFileSync(fencePath, JSON.stringify({ pid, startIdentity: kernel }));
    const config = { fencePath, socketPath: join(root, "host.sock") };
    expect(await takeOverOrphanHost({ record: join(root, "record.json") }, config, ports)).toBe(true);
    expect(stopped[0]).toEqual([{ pid, startIdentity: "ps:fixture start" }, config.socketPath]);
    writeFileSync(fencePath, JSON.stringify({ pid, startIdentity: `${pid}:1700000000:123457` }));
    expect(await takeOverOrphanHost({ record: join(root, "record.json") }, config, ports)).toBe(false);
    expect(stopped.length).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
