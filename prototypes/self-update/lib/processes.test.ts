import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { freePort, isAlive, ManagedProcess, ProcessRegistry, readStartIdentity, webProbe, type ProcessSpec } from "./processes";

const STUB = join(import.meta.dir, "fixtures", "stub-child.ts");
const root = mkdtempSync("/var/tmp/self-update-processes-");
afterAll(() => rmSync(root, { recursive: true, force: true }));

/* Every process a test starts is stopped by the PID the test recorded. */
const started: ManagedProcess[] = [];
const bystanders: ChildProcess[] = [];
afterEach(async () => {
  for (const managed of started.splice(0)) await managed.stop();
  for (const child of bystanders.splice(0)) if (child.pid && isAlive(child.pid)) child.kill("SIGKILL");
});

let fileCounter = 0;
function registry(): ProcessRegistry {
  fileCounter += 1;
  return new ProcessRegistry(join(root, `processes-${fileCounter}.json`));
}

async function stubSpec(mode: string, port?: number): Promise<ProcessSpec> {
  const chosen = port ?? await freePort();
  return {
    role: "web",
    command: [process.execPath, STUB],
    cwd: root,
    env: { ...process.env, PORT: String(chosen), STUB_MODE: mode } as Record<string, string>,
    port: chosen,
    socket: null,
    readyBudgetMs: 5_000,
    readyPollMs: 50,
    readyTimeout: "No HTTP 200 within 5 s",
    stopGraceMs: 600,
    killGraceMs: 2_000,
    async probe() {
      const response = await fetch(`http://127.0.0.1:${chosen}/`, { signal: AbortSignal.timeout(1_000) });
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
    },
  };
}

function bystander(): ChildProcess {
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  bystanders.push(child);
  return child;
}

describe("ManagedProcess with a stub child", () => {
  test("start records the PID and its start identity, and waits for readiness", async () => {
    const reg = registry();
    const spec = await stubSpec("serve");
    const managed = new ManagedProcess(spec, reg, () => {});
    started.push(managed);
    await managed.start();
    expect(managed.status.state).toBe("healthy");
    const pid = managed.status.pid!;
    expect(pid).toBeGreaterThan(1);
    expect(managed.status.port).toBe(spec.port!);
    const record = JSON.parse(readFileSync(reg.file, "utf8")).web;
    expect(record.pid).toBe(pid);
    expect(record.startIdentity).toBe(readStartIdentity(pid)!);
    expect(record.port).toBe(spec.port);
  });

  test("stop signals the recorded group and nothing else", async () => {
    const reg = registry();
    const managed = new ManagedProcess(await stubSpec("serve"), reg, () => {});
    started.push(managed);
    const other = bystander();
    await managed.start();
    const pid = managed.status.pid!;
    await managed.stop();
    expect(isAlive(pid)).toBe(false);
    expect(managed.status.state).toBe("stopped");
    expect(managed.status.pid).toBeNull();
    expect(JSON.parse(readFileSync(reg.file, "utf8")).web).toBeUndefined();
    expect(isAlive(other.pid!)).toBe(true);
    expect(isAlive(process.pid)).toBe(true);
  });

  test("a child that ignores SIGTERM is killed after the grace period", async () => {
    const managed = new ManagedProcess(await stubSpec("ignore-term"), registry(), () => {});
    started.push(managed);
    await managed.start();
    const pid = managed.status.pid!;
    const before = Date.now();
    await managed.stop();
    expect(isAlive(pid)).toBe(false);
    expect(Date.now() - before).toBeGreaterThanOrEqual(500);
    expect(managed.lines().some((line) => line.includes("ignoring SIGTERM"))).toBe(true);
  });

  test("a child that exits before readiness is failed with its exit code", async () => {
    const managed = new ManagedProcess(await stubSpec("exit3"), registry(), () => {});
    started.push(managed);
    await managed.start();
    expect(managed.status.state).toBe("failed");
    expect(managed.status.error).toMatch(/^Exited with code 3 after \d+(\.\d)? s$/);
    expect(managed.status.pid).toBeNull();
    expect(managed.lines()).toContain("stub: exiting with 3");
  });

  test("a port already in use fails the start and frees nothing", async () => {
    const holder = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("held") });
    try {
      const managed = new ManagedProcess(await stubSpec("serve", holder.port), registry(), () => {});
      started.push(managed);
      await managed.start();
      expect(managed.status.state).toBe("failed");
      expect(managed.status.error).toBe(`Port ${holder.port} is in use`);
      expect(await (await fetch(`http://127.0.0.1:${holder.port}/`)).text()).toBe("held");
    } finally {
      holder.stop(true);
    }
  });

  test("a record whose start identity does not match is dropped without a signal", async () => {
    const reg = registry();
    const other = bystander();
    reg.write("web", { role: "web", pid: other.pid!, startIdentity: "1", startedAt: new Date().toISOString(), port: 1, socket: null });
    const managed = new ManagedProcess(await stubSpec("serve"), reg, () => {});
    managed.adopt();
    expect(managed.status.state).toBe("stopped");
    expect(managed.status.pid).toBeNull();
    await managed.stop();
    expect(isAlive(other.pid!)).toBe(true);
    expect(JSON.parse(readFileSync(reg.file, "utf8")).web).toBeUndefined();
  });

  test("a fresh ManagedProcess adopts the record from the file and can stop it", async () => {
    const reg = registry();
    const spec = await stubSpec("serve");
    const first = new ManagedProcess(spec, reg, () => {});
    await first.start();
    const pid = first.status.pid!;
    const adopted = new ManagedProcess(spec, new ProcessRegistry(reg.file), () => {});
    started.push(adopted);
    adopted.adopt();
    expect(adopted.status.pid).toBe(pid);
    await adopted.checkHealth();
    expect(adopted.status.state).toBe("healthy");
    expect(adopted.status.lastHealthOk).toBe(true);
    await adopted.stop();
    expect(isAlive(pid)).toBe(false);
  });

  test("a health miss flips healthy to failed and the next success flips it back", async () => {
    const spec = await stubSpec("serve");
    let fail = false;
    const probe = spec.probe;
    spec.probe = async (pid) => { if (fail) throw new Error("health probe refused"); await probe(pid); };
    const managed = new ManagedProcess(spec, registry(), () => {});
    started.push(managed);
    await managed.start();
    fail = true;
    await managed.checkHealth();
    expect(managed.status.state).toBe("failed");
    expect(managed.status.error).toBe("health probe refused");
    fail = false;
    await managed.checkHealth();
    expect(managed.status.state).toBe("healthy");
    expect(managed.status.error).toBeNull();
  });

  test("restart replaces the PID on the same port", async () => {
    const spec = await stubSpec("serve");
    const managed = new ManagedProcess(spec, registry(), () => {});
    started.push(managed);
    await managed.start();
    const firstPid = managed.status.pid!;
    await managed.restart();
    expect(managed.status.state).toBe("healthy");
    expect(managed.status.pid).not.toBe(firstPid);
    expect(managed.status.port).toBe(spec.port!);
    expect(isAlive(firstPid)).toBe(false);
  });
});

describe("a restart starts from wherever the spec points at that moment", () => {
  test("cwd and revision are read at each start, so a restart runs the newest built release", async () => {
    const releaseA = join(root, "release-a");
    const releaseB = join(root, "release-b");
    for (const dir of [releaseA, releaseB]) mkdirSync(dir, { recursive: true });
    let current = { dir: releaseA, revision: "aaaaaaa" };
    const spec = await stubSpec("serve");
    spec.cwd = () => current.dir;
    spec.revision = () => current.revision;
    const reg = registry();
    const managed = new ManagedProcess(spec, reg, () => {});
    started.push(managed);
    await managed.start();
    expect(managed.lines()).toContain(`stub cwd ${releaseA}`);
    expect(managed.status.revision).toBe("aaaaaaa");
    current = { dir: releaseB, revision: "bbbbbbb" };
    await managed.restart();
    expect(managed.lines()).toContain(`stub cwd ${releaseB}`);
    expect(managed.status.revision).toBe("bbbbbbb");
    expect(JSON.parse(readFileSync(reg.file, "utf8")).web.revision).toBe("bbbbbbb");
  });
});

describe("webProbe", () => {
  let chunkStatus = 200;
  const page = `<!DOCTYPE html><html><head><script src="/_next/static/chunks/webpack-0a1b2c.js" async=""></script></head><body>ok</body></html>`;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/") return new Response(page, { headers: { "content-type": "text/html" } });
      if (pathname === "/_next/static/chunks/webpack-0a1b2c.js") return new Response("//js", { status: chunkStatus });
      return new Response("missing", { status: 404 });
    },
  });
  afterAll(() => server.stop(true));

  test("passes when / and the first script it references both answer 200", async () => {
    chunkStatus = 200;
    await webProbe(server.port!)(1);
  });

  test("fails when / answers 200 but its own script chunk does not", async () => {
    chunkStatus = 500;
    await expect(webProbe(server.port!)(1)).rejects.toThrow("/_next/static/chunks/webpack-0a1b2c.js answered 500");
  });
});

describe("freePort", () => {
  test("hands back a port the kernel assigned", async () => {
    const port = await freePort();
    expect(port).toBeGreaterThan(1024);
  });
});
