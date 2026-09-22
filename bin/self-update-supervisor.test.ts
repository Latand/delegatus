import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
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
      releasesDir: "/c/agent-log-viewer/self-update/abc/releases",
    });
  });

  test("the host entry of a release is its bundle when present, else the source entry", () => {
    expect(hostEntrypoint(release)).toBe(join(release, "src", "runtime-host", "main.ts"));
    mkdirSync(join(release, "dist"), { recursive: true });
    writeFileSync(join(release, "dist", "runtime-host.mjs"), "");
    expect(hostEntrypoint(release)).toBe(join(release, "dist", "runtime-host.mjs"));
  });

  test("this process has a start identity, and a PID that does not exist has none", () => {
    expect(readStartIdentity(process.pid)).toMatch(/^\d+$/);
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
    expect(written.checkout).toBe(checkout);
    expect(written.web).toMatchObject({ state: "healthy", pid: process.pid, revision: second.slice(0, 7), startedAt: "2026-09-22T12:00:00.000Z" });
    expect(written.web.startIdentity).toBe(readStartIdentity(process.pid));
    expect(written.runtimeHost.state).toBe("stopped");
    record.remove();
    expect(existsSync(file)).toBe(false);
  });
});

describe("restart requests", () => {
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
});
