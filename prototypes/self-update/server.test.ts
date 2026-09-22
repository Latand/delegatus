import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type ProcessPort, type RunnerPort, type ServerDeps } from "./server";
import type { CheckOutcome } from "./lib/git";
import { Changes, idleUpdate, type ProcessStatus, type Revision, type Snapshot, type UpdateState } from "./lib/state";

const RUNNING: Revision = { version: "1.2.2", sha: "7fb7345e5".padEnd(40, "0"), short: "7fb7345", date: "2026-09-22T10:00:00+03:00" };
const TIP: Revision = { version: "1.2.3", sha: "a1b2c3d".padEnd(40, "1"), short: "a1b2c3d", date: "2026-09-23T10:00:00+03:00" };

function behind(): CheckOutcome {
  return {
    ok: true,
    installed: RUNNING,
    available: TIP,
    relation: "behind",
    ahead: 0,
    behind: 2,
    delta: {
      commits: [{ short: "a1b2c3d", subject: "Second" }, { short: "0f0f0f0", subject: "First" }],
      changelog: { headings: [], entries: [] },
      summary: { line: "2 commits · No changelog entries for these commits.", groups: [] },
    },
  };
}

class FakeRunner implements RunnerPort {
  state: UpdateState = idleUpdate();
  pending: (() => void) | null = null;
  started: string[] = [];
  constructor(private readonly changes: Changes) {}
  finishAs: "failed" | "done" = "failed";
  start(target: string): Promise<void> {
    this.started.push(target);
    this.state = { ...idleUpdate(), state: "running", target, startedAt: new Date().toISOString() };
    this.changes.emit();
    return new Promise((resolve) => {
      this.pending = () => {
        this.state = { ...this.state, state: this.finishAs, finishedAt: new Date().toISOString() };
        this.changes.emit();
        resolve();
      };
    });
  }
  async retry(): Promise<void> {
    if (this.state.state !== "failed") throw new Error("update is not failed");
    this.state = { ...this.state, state: "done" };
  }
  logPath(step: string): string { return `/var/tmp/does-not-exist/${step}.log`; }
}

class FakeProcess implements ProcessPort {
  restarts = 0;
  status: ProcessStatus = {
    state: "healthy", pid: 4242, port: 45123, socket: null, startedAt: new Date().toISOString(),
    lastHealthAt: null, lastHealthOk: null, error: null, revision: "7fb7345",
  };
  release: (() => void) | null = null;
  restart(): Promise<void> {
    this.restarts += 1;
    return new Promise((resolve) => { this.release = resolve; });
  }
  async checkHealth(): Promise<void> {}
  lines(): string[] { return ["last line"]; }
}

const servers: { stop(): void }[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(); });

function boot(outcome: () => CheckOutcome = behind) {
  const changes = new Changes();
  const reads = { count: 0 };
  const installed = { current: RUNNING };
  const runner = new FakeRunner(changes);
  const web = new FakeProcess();
  const host = new FakeProcess();
  const deps: ServerDeps = {
    changes,
    /* The real checker compares against the installed pointer, as this does. */
    checker: async () => { const result = outcome(); return result.ok ? { ...result, installed: installed.current } : result; },
    readInstalled: async () => { reads.count += 1; return installed.current; },
    describe: async (revision) => [RUNNING, TIP].find((candidate) => candidate.short === revision) ?? { ...RUNNING, sha: revision, short: revision },
    runner,
    web,
    host,
    info: { checkout: "/var/tmp/checkout", remote: "/var/tmp/remote.git", branch: "main", pollMinutes: 60, webPort: 45123 },
    healthIntervalMs: 0,
  };
  const server = createServer(deps, { port: 0 });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  return { base, runner, web, host, changes, server, reads, installed };
}

async function state(base: string): Promise<Snapshot> {
  return await (await fetch(`${base}/api/state`)).json() as Snapshot;
}

async function post(url: string, body?: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("routes", () => {
  test("GET / serves the page and /ui assets", async () => {
    const { base } = boot();
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("/ui/app.js");
    const css = await fetch(`${base}/ui/app.css`);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(await css.text()).toContain("--surface-card");
  });

  test("the transpiled app.js parses", async () => {
    const { base } = boot();
    const response = await fetch(`${base}/ui/app.js`);
    expect(response.headers.get("content-type")).toContain("javascript");
    const source = await response.text();
    expect(source).not.toContain(": Snapshot");
    expect(() => new Function(source)).not.toThrow();
  });

  test("GET /api/state answers the snapshot shape", async () => {
    const { base } = boot();
    const snapshot = await state(base);
    expect(snapshot.installed.short).toBe("7fb7345");
    expect(snapshot.serving.web?.short).toBe("7fb7345");
    expect(snapshot.serving.runtimeHost?.version).toBe("1.2.2");
    expect(snapshot.check.state).toBe("idle");
    expect(snapshot.update.state).toBe("idle");
    expect(snapshot.processes.web.pid).toBe(4242);
    expect(snapshot.processes.runtimeHost.pid).toBe(4242);
    expect(snapshot.busy).toBeNull();
  });

  test("POST /api/check answers 202 and settles on update-available", async () => {
    const { base } = boot();
    const response = await post(`${base}/api/check`);
    expect(response.status).toBe(202);
    await Bun.sleep(20);
    const snapshot = await state(base);
    expect(snapshot.check.state).toBe("update-available");
    expect(snapshot.available?.short).toBe("a1b2c3d");
    expect(snapshot.check.nextPollAt).not.toBeNull();
  });

  test("POST /api/update is 409 until a check found something", async () => {
    const { base } = boot();
    expect((await post(`${base}/api/update`)).status).toBe(409);
  });

  test("one mutating action at a time: update blocks restarts and checks", async () => {
    const { base, runner } = boot();
    await post(`${base}/api/check`);
    await Bun.sleep(20);
    const update = await post(`${base}/api/update`);
    expect(update.status).toBe(202);
    expect(runner.started).toEqual([TIP.sha]);
    expect(((await update.json()) as Snapshot).busy).toBe("update");
    expect((await post(`${base}/api/update`)).status).toBe(409);
    expect((await post(`${base}/api/check`)).status).toBe(409);
    expect((await post(`${base}/api/restart/web`)).status).toBe(409);
    expect((await post(`${base}/api/restart/runtime-host`, { confirm: true })).status).toBe(409);
    runner.pending?.();
    await Bun.sleep(20);
    expect((await state(base)).busy).toBeNull();
  });

  test("the installed release is re-read when an update finishes, not while it runs", async () => {
    const { base, runner, reads, installed } = boot();
    await post(`${base}/api/check`);
    await Bun.sleep(20);
    await post(`${base}/api/update`);
    await Bun.sleep(20);
    expect((await state(base)).installed.short).toBe("7fb7345");
    const before = reads.count;
    installed.current = TIP;
    runner.finishAs = "done";
    runner.pending?.();
    await Bun.sleep(30);
    expect(reads.count).toBeGreaterThan(before);
    expect((await state(base)).installed.short).toBe("a1b2c3d");
  });

  test("serving follows each process's own revision", async () => {
    const { base, web, changes } = boot();
    await Bun.sleep(10);
    web.status = { ...web.status, revision: "a1b2c3d" };
    changes.emit();
    await Bun.sleep(20);
    const snapshot = await state(base);
    expect(snapshot.serving.web?.version).toBe("1.2.3");
    expect(snapshot.serving.runtimeHost?.short).toBe("7fb7345");
    web.status = { ...web.status, pid: null, state: "stopped", revision: null };
    changes.emit();
    await Bun.sleep(20);
    expect((await state(base)).serving.web).toBeNull();
  });

  test("retry is 409 unless the update failed", async () => {
    const { base, runner } = boot();
    expect((await post(`${base}/api/update/retry`)).status).toBe(409);
    await post(`${base}/api/check`);
    await Bun.sleep(20);
    await post(`${base}/api/update`);
    runner.pending?.();
    await Bun.sleep(20);
    expect((await post(`${base}/api/update/retry`)).status).toBe(202);
  });

  test("restart web answers 202 and marks busy until it finishes", async () => {
    const { base, web } = boot();
    const response = await post(`${base}/api/restart/web`);
    expect(response.status).toBe(202);
    expect(web.restarts).toBe(1);
    expect((await state(base)).busy).toBe("restart-web");
    expect((await post(`${base}/api/restart/web`)).status).toBe(409);
    expect((await post(`${base}/api/check`)).status).toBe(202);
    web.release?.();
    await Bun.sleep(20);
    expect((await state(base)).busy).toBeNull();
  });

  test("restart runtime host needs confirm:true", async () => {
    const { base, host } = boot();
    expect((await post(`${base}/api/restart/runtime-host`)).status).toBe(400);
    expect((await post(`${base}/api/restart/runtime-host`, { confirm: "yes" })).status).toBe(400);
    expect(host.restarts).toBe(0);
    const response = await post(`${base}/api/restart/runtime-host`, { confirm: true });
    expect(response.status).toBe(202);
    expect(host.restarts).toBe(1);
    expect((await state(base)).busy).toBe("restart-runtime-host");
    host.release?.();
  });

  test("step logs are text/plain and unknown steps are 404", async () => {
    const { base } = boot();
    const log = await fetch(`${base}/api/steps/build/log`);
    expect(log.status).toBe(200);
    expect(log.headers.get("content-type")).toContain("text/plain");
    expect((await fetch(`${base}/api/steps/deploy/log`)).status).toBe(404);
  });

  test("unknown routes are 404", async () => {
    const { base } = boot();
    expect((await fetch(`${base}/api/nothing`)).status).toBe(404);
  });

  test("SSE delivers a state event within 300 ms of a change", async () => {
    const { base, changes, web } = boot();
    const controller = new AbortController();
    const response = await fetch(`${base}/api/events`, { signal: controller.signal });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const readUntil = async (needle: string) => {
      while (!buffer.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended");
        buffer += decoder.decode(value);
      }
    };
    await readUntil("event: state");
    buffer = "";
    web.status = { ...web.status, pid: 777 };
    const changedAt = Date.now();
    changes.emit();
    await readUntil("\"pid\":777");
    expect(Date.now() - changedAt).toBeLessThan(300);
    controller.abort();
  });
});
