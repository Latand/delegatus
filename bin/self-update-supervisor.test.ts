import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createLauncherRecord,
  createReadinessJournal,
  TERMINAL_BOOTSTRAP_TIMEOUT_MS,
  waitForPageAndChunk,
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
      readiness: "/s/self-update/readiness-abc.json",
      startupOutput: "/s/self-update/startup-output-abc.json",
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
    const file = join(root, "malformed-header-readiness.json");
    const journal = createReadinessJournal(file, { revision: "candidate", pid: 125 });
    const error = await probePageAndChunk(port, 5_000, { authorization: `Bearer ${token}` }, journal.observe);
    journal.finish(error);
    expect(error).toMatch(/^Viewer readiness probe failed( \([A-Za-z0-9_]+\))?$/);
    expect(error).not.toContain(token);
    const persisted = readFileSync(file, "utf8");
    expect(persisted).not.toContain("fixture-prefix");
    expect(persisted).not.toContain("fixture-suffix");
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
    buffer.writeUInt32LE(pid, 12); buffer.writeBigUInt64LE(BigInt(1_700_000_000), 120); buffer.writeBigUInt64LE(BigInt(123456), 128);
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


test.each(["gate-expired", "issuer-changed", "launcher-changed"] as const)("watcher final response fence retains stale relaunch custody: %s", async change => {
  const dir = mkdtempSync(join(root, "dispatch-response-"));
  const file = join(dir, "request.json"), gateFile = join(dir, "auto-admission.json"), ownerFile = join(dir, "launcher.json");
  const request = JSON.stringify({ requestId: "accepted-relaunch", role: "relaunch", target: "a".repeat(40), autoGateId: "issuer-gate" });
  const gate = { id: "issuer-gate", until: Date.now() + 60000, issuerPid: process.pid, issuerIdentity: readStartIdentity(process.pid) };
  writeFileSync(file, request); writeFileSync(gateFile, JSON.stringify(gate));
  writeFileSync(ownerFile, JSON.stringify({ launcher: { pid: process.pid, startIdentity: readStartIdentity(process.pid) } }));
  let resume!: () => void, entered!: () => void, dispatched = 0;
  const wait = new Promise<void>(resolve => { resume = resolve; }), arrival = new Promise<void>(resolve => { entered = resolve; });
  const watcher = watchRestartRequests(file, async () => { dispatched++; }, { intervalMs: 60000,
    admitAuto: async () => { entered(); await wait; return true; } });
  try {
    const polling = watcher.poll(); await arrival;
    if (change === "gate-expired") writeFileSync(gateFile, JSON.stringify({ ...gate, until: 0 }));
    if (change === "issuer-changed") writeFileSync(gateFile, JSON.stringify({ ...gate, issuerIdentity: "stale-issuer" }));
    if (change === "launcher-changed") writeFileSync(ownerFile, JSON.stringify({ launcher: { pid: process.pid, startIdentity: "stale-launcher" } }));
    const expectedGate = readFileSync(gateFile, "utf8"), expectedOwner = readFileSync(ownerFile, "utf8");
    resume(); await polling;
    expect(dispatched).toBe(0); expect(readFileSync(file, "utf8")).toBe(request);
    expect(readFileSync(gateFile, "utf8")).toBe(expectedGate); expect(readFileSync(ownerFile, "utf8")).toBe(expectedOwner);
    expect(JSON.parse(readFileSync(`${file}.result.json`, "utf8"))).toMatchObject({ requestId: "accepted-relaunch", state: "rejected" });
  } finally { resume(); watcher.stop(); }
});


describe("bounded page and chunk readiness", () => {
  for (const slowPhase of ["page", "html", "chunk"] as const) {
    test(`retries after one stalled ${slowPhase} with deterministic time`, async () => {
      const file = join(root, `readiness-${slowPhase}.json`);
      const journal = createReadinessJournal(file, { revision: "candidate", pid: 123 });
      let now = 0;
      let attempts = 0;
      try {
        const error = await waitForPageAndChunk(43123, {
          timeoutMs: 2_000, attemptTimeoutMs: 100, intervalMs: 20, onPhase: journal.observe,
          now: () => now,
          sleep: async milliseconds => { now += milliseconds; },
          probe: async (_port, _timeout, _headers, onPhase) => {
            attempts++;
            const stalledPhase = attempts === 1 ? slowPhase : null;
            const phase = "page";
            onPhase({ phase, status: "running" });
            now += stalledPhase && slowPhase !== "chunk" ? 100 : 1;
            if (slowPhase === "chunk") {
              onPhase({ phase: "page", status: "ready" });
              onPhase({ phase: "chunk", status: "running" });
              now += stalledPhase ? 99 : 1;
              onPhase({ phase: "chunk", status: stalledPhase ? "failed" : "ready", detail: stalledPhase ? "probe-failed" : null });
            } else {
              onPhase({ phase, status: stalledPhase ? "failed" : "ready", detail: stalledPhase ? "probe-failed" : null });
            }
            return stalledPhase ? "probe-failed" : null;
          },
        });
        journal.finish(error);
        expect(error).toBeNull();
        const run = JSON.parse(readFileSync(file, "utf8")).runs[0];
        expect(run.status).toBe("ready");
        expect(attempts).toBe(2);
        expect(run.phases.page.attempts).toBe(2);
        expect(run.phases.page.status).toBe("ready");
        if (slowPhase === "chunk") expect(run.phases.chunk).toMatchObject({ attempts: 2, status: "ready" });
        else expect(run.phases.chunk).toMatchObject({ attempts: 0, status: "pending" });
        expect(now).toBe(slowPhase === "chunk" ? 122 : 121);
      } finally { rmSync(file, { force: true }); }
    });

    test(`a permanent ${slowPhase} stall exhausts the shared deadline deterministically`, async () => {
      const file = join(root, `permanent-${slowPhase}.json`);
      const journal = createReadinessJournal(file, { revision: "failed", pid: 124 });
      let now = 0;
      let attempts = 0;
      const budgets: number[] = [];
      try {
        const failure = await waitForPageAndChunk(43123, {
          timeoutMs: 350, attemptTimeoutMs: 100, intervalMs: 30, onPhase: journal.observe,
          now: () => now,
          sleep: async milliseconds => { now += milliseconds; },
          probe: async (_port, budget, _headers, onPhase) => {
            attempts++;
            budgets.push(budget);
            const phase = slowPhase === "chunk" ? "chunk" : "page";
            if (slowPhase === "chunk") {
              onPhase({ phase: "page", status: "running" });
              now += 1;
              onPhase({ phase: "page", status: "ready" });
              onPhase({ phase, status: "running" });
              now += 99;
            } else {
              onPhase({ phase, status: "running" });
              now += 100;
            }
            onPhase({ phase, status: "failed", detail: "probe-failed" });
            return "probe-failed";
          },
        });
        journal.finish(failure);
        expect(failure).toBe("probe-failed");
        expect(attempts).toBe(3);
        expect(budgets).toEqual([100, 100, 90]);
        expect(now).toBe(360);
        const run = JSON.parse(readFileSync(file, "utf8")).runs[0];
        expect(run.status).toBe("failed");
        expect(run.phases[slowPhase === "chunk" ? "chunk" : "page"]).toMatchObject({ attempts: 3, status: "failed" });
      } finally { rmSync(file, { force: true }); }
    });
  }

  test("terminal handoff covers candidate and rollback startup bounds", () => {
    expect(TERMINAL_BOOTSTRAP_TIMEOUT_MS).toBeGreaterThanOrEqual(2 * (15_000 + 90_000 + 90_000));
    expect(TERMINAL_BOOTSTRAP_TIMEOUT_MS).toBeLessThan(10 * 60_000);
  });

  test("a real never-ready child settles under a parent watchdog", async () => {
    const child = spawn(process.execPath, ["--eval", `
      import { createServer } from "node:http";
      import { waitForPageAndChunk } from ${JSON.stringify(new URL("./self-update-supervisor.mjs", import.meta.url).href)};
      const server = createServer(() => {});
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      await waitForPageAndChunk(server.address().port, { timeoutMs: 250, attemptTimeoutMs: 100, intervalMs: 10 });
      server.closeAllConnections(); server.close();
    `], { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: process.env });
    const output: Buffer[] = [];
    child.stdout.on("data", chunk => output.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => output.push(Buffer.from(chunk)));
    let watchdogFired = false;
    const watchdog = setTimeout(() => {
      watchdogFired = true;
      if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    }, 2_000);
    try {
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      expect(watchdogFired).toBe(false);
      expect(result.code).toBe(0);
      expect(Buffer.concat(output).toString()).toBe("");
    } finally { clearTimeout(watchdog); }
  });

  test("journal measures phase time including backoff and retains bounded runs across reopen", () => {
    const file = join(root, "reopened-readiness.json");
    let now = 0;
    const journal = createReadinessJournal(file, { revision: "candidate", pid: 123 }, () => now);
    journal.observe({ phase: "files", status: "running" });
    now = 50;
    journal.observe({ phase: "files", status: "failed" });
    now = 250;
    journal.observe({ phase: "files", status: "running" });
    now = 300;
    journal.observe({ phase: "files", status: "ready" });
    journal.finish();
    expect(JSON.parse(readFileSync(file, "utf8")).runs[0].phases.files).toMatchObject({ attempts: 2, elapsedMs: 300, status: "ready" });
    for (let n = 0; n < 4; n++) createReadinessJournal(file, { revision: `rollback-${n}`, pid: 124 + n }, () => now).finish();
    const runs = JSON.parse(readFileSync(file, "utf8")).runs;
    expect(runs).toHaveLength(4);
    expect(runs.map((run: { revision: string }) => run.revision)).toEqual(["rollback-0", "rollback-1", "rollback-2", "rollback-3"]);
  });

  test("journal failures at initial, phase and final writes stay best effort and details are sanitized", () => {
    const file = join(root, "unwritable-readiness.json");
    mkdirSync(file);
    const initial = createReadinessJournal(file, { revision: "candidate", pid: 123 });
    expect(() => initial.observe({ phase: "files", status: "running" })).not.toThrow();
    const blocked = join(root, "blocked-readiness.json");
    const journal = createReadinessJournal(blocked, { revision: "candidate", pid: 123 });
    rmSync(blocked);
    mkdirSync(blocked);
    expect(() => journal.observe({ phase: "page", status: "failed", detail: "spawn /private/sentinel with secret-value" })).not.toThrow();
    expect(() => journal.finish("spawn /private/sentinel with secret-value")).not.toThrow();
    const privacyFile = join(root, "private-detail.json");
    const privateJournal = createReadinessJournal(privacyFile, { revision: "candidate", pid: 123 });
    privateJournal.observe({ phase: "page", status: "failed", detail: "spawn /private/sentinel with secret-value" });
    privateJournal.finish("spawn /private/sentinel with secret-value");
    const persisted = readFileSync(privacyFile, "utf8");
    expect(persisted).not.toContain("/private/sentinel");
    expect(persisted).not.toContain("secret-value");

    const legacyFile = join(root, "legacy-private-detail.json");
    writeFileSync(legacyFile, JSON.stringify({
      version: 1,
      runs: [{ revision: "old", detail: "spawn /private/sentinel with secret-value",
        phases: { files: { detail: "spawn /private/sentinel with secret-value" } } }],
    }));
    createReadinessJournal(legacyFile, { revision: "current", pid: 126 });
    const migrated = readFileSync(legacyFile, "utf8");
    expect(migrated).not.toContain("/private/sentinel");
    expect(migrated).not.toContain("secret-value");
  });
});
