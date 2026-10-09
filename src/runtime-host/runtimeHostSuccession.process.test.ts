import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import type { RuntimeEvent, ViewerDeploymentStatus } from "@/lib/runtime/contracts";
import type { RuntimeHostStartupRecord } from "./runtimeHostStartup";
import { expect, test } from "bun:test";
import { viewerComposeSnapshotPath } from "./deploymentArtifacts";
import { RuntimeHostFence } from "./host";
import { RuntimeJournal } from "./journal";
import { largeJournal } from "./fixtures/largeRuntimeJournal";
import { ephemeralPort, runtimeHostRehearsalPorts, runtimeHostRehearsalEnvironment, runtimeHostRehearsalFiles, runtimeHostRehearsalGenerations } from "./hostRehearsalRun";
import { probeRuntimeHostSuccessor } from "./runtimeHostStartup";
import { writeRuntimeHostHandoffIntent, writeRuntimeHostRelease, readRuntimeHostRollbackTarget } from "./hostRelease";

const root = path.resolve(import.meta.dir, "../..");
function record(filename: string): RuntimeHostStartupRecord | null { try { return JSON.parse(fs.readFileSync(filename, "utf8")) as RuntimeHostStartupRecord; } catch { return null; } }
function boot(options: { root: string; runtimeBin: string; stateDir: string; port: number }, role: "predecessor" | "successor") {
  const environment = runtimeHostRehearsalEnvironment(options, role);
  environment.LLV_RUNTIME_HOST_STARTUP_TARGET = path.join(options.stateDir, `${role}.json`);
  environment.LLV_RUNTIME_HOST_FENCE = path.join(options.stateDir, "fence.lock");
  // Instrument only this fixture's children, keeping fence timing out of the
  // production startup wire contract. Each write is local diagnostic data.
  const trace = path.join(options.stateDir, "fence-trace.jsonl");
  const preload = path.join(options.stateDir, "fence-trace.ts");
  fs.writeFileSync(preload, `import fs from "node:fs"; import { RuntimeHostFence } from ${JSON.stringify(path.join(root, "src/runtime-host/runtimeHostFence.ts"))};
    for (const method of ["acquire", "release"] as const) { const original = RuntimeHostFence.prototype[method]; RuntimeHostFence.prototype[method] = function() {
      const startedAt = Date.now(); let success = false;
      try { const result = original.call(this); success = true; return result; }
      finally { fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ pid: process.pid, method, startedAt, endedAt: Date.now(), success }) + "\\n"); }
    }; }`);
  const child = spawn(process.execPath, ["run", "--preload", preload, "src/runtime-host/main.ts"], { cwd: root, env: environment as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout!.on("data", (s) => { log += s; }); child.stderr!.on("data", (s) => { log += s; });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return { child, log: () => log, exited };
}
async function stop(process: ReturnType<typeof boot>) {
  if (process.child.exitCode !== null || process.child.signalCode !== null) return;
  process.child.kill("SIGTERM");
  const timer = setTimeout(() => process.child.kill("SIGKILL"), 3000);
  try { await process.exited; } finally { clearTimeout(timer); }
}
async function until(predicate: () => boolean | undefined, child?: ReturnType<typeof boot>, timeout = 120000): Promise<void> {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    if (child && (child.child.exitCode !== null || child.child.signalCode !== null)) throw new Error(`isolated host exited: ${child.log()}`);
    if (performance.now() > deadline) throw new Error(`isolated host deadline: ${child?.log()}`);
    await Bun.sleep(25);
  }
}
function stable(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const request = http.get({ hostname: "127.0.0.1", port, path: "/", agent: false }, (response) => { response.resume(); response.once("end", () => resolve(response.statusCode ?? null)); });
    request.once("error", () => resolve(null)); request.setTimeout(3000, () => { request.destroy(); resolve(null); });
  });
}
function call(socketPath: string, method: string, params: unknown): Promise<RuntimeEvent> {
  return new Promise((resolve, reject) => {
    const peer = net.createConnection(socketPath); let body = "";
    const timer = setTimeout(() => { peer.destroy(); reject(new Error("fixture socket deadline")); }, 5000);
    peer.once("error", reject);
    peer.once("connect", () => peer.write(`${JSON.stringify({ id: "fixture-request", method, params: method === "append" ? { event: params } : params })}\n`));
    peer.on("data", (data) => { body += data; if (!body.includes("\n")) return; clearTimeout(timer); peer.destroy(); const value = JSON.parse(body.split("\n")[0]!); value.ok ? resolve(value.result) : reject(new Error(value.error)); });
  });
}

test("separate-process succession keeps the stable Viewer available throughout large journal open", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "host-journal-handoff-"));
  const port = await ephemeralPort(), options = { root, runtimeBin: process.execPath, stateDir: directory, port };
  const files = runtimeHostRehearsalFiles(directory), { failed: previous, retained: successor } = runtimeHostRehearsalGenerations(port);
  const filename = path.join(directory, "runtime-events.sqlite"), socket = path.join(directory, "runtime-host.sock");
  let p: ReturnType<typeof boot> | undefined, s: ReturnType<typeof boot> | undefined;
  const viewer = http.createServer((_, response) => response.end("fixture Viewer")); viewer.listen(0, "127.0.0.1"); await once(viewer, "listening");
  try {
    largeJournal(filename); runtimeHostRehearsalPorts(options);
    fs.writeFileSync(path.join(directory, "viewer-release.json"), JSON.stringify({ ...previous, endpoint: `http://127.0.0.1:${(viewer.address() as net.AddressInfo).port}` }));
    writeRuntimeHostRelease(previous, files.release); p = boot(options, "predecessor");
    await until(() => record(path.join(directory, "predecessor.json"))?.phases.some((p) => p.phase === "ready"), p);
    let latestSequence = 300000;
    for (let i = 0; i < 400; i++) latestSequence = (await call(socket, "append", { scope: { type: "session", id: "conversation-fixture" }, kind: "fixture.history", payload: {}, producer: { kind: "codex-app-server", eventKey: `engine-host:codex:session-${i}:${400000 + i}` } })).seq;
    s = boot(options, "successor");
    await until(() => record(path.join(directory, "successor.json"))?.phases[0]?.phase === "fence-waiting", s);
    // The waiting process owns neither mutations nor the stable listener.
    expect(record(path.join(directory, "successor.json"))!.phases.length).toBe(1);
    writeRuntimeHostHandoffIntent({ revision: successor.revision, image: successor.image, successorContainer: successor.container, predecessorId: previous.container, previousRelease: previous, successorRelease: successor, recordedAt: "2026-01-01T00:00:00.000Z" }, files.handoffIntent);
    writeRuntimeHostRelease(successor, files.release);
    const drainedRequest = call(socket, "wait", { after: latestSequence, timeoutMs: 750 });
    await Bun.sleep(25);
    const signalledAt = Date.now();
    let predecessorExitedAt: number | null = null;
    void p.exited.then(() => { predecessorExitedAt = Date.now(); });
    p.child.kill("SIGTERM");
    const polls: { record: RuntimeHostStartupRecord | null; status: number | null; startedAt: number; endedAt: number }[] = [];
    const deadline = performance.now() + 180000;
    while (performance.now() < deadline) {
      const r = record(path.join(directory, "successor.json"));
      const startedAt = Date.now();
      polls.push({ record: r, status: await stable(port), startedAt, endedAt: Date.now() });
      if (r?.phases.some((p) => p.phase === "ready")) break;
      if (s.child.exitCode !== null) throw new Error(s.log());
      await Bun.sleep(25);
    }
    await drainedRequest;
    console.log(JSON.stringify({ boot: "handoff-probes", polls: polls.length, refused: polls.filter((p) => p.status === null).length, journalProgressPolls: polls.filter((p) => p.record?.journal).length }));
    expect(polls.some((p) => p.record?.phases.length === 1 && p.status === 200)).toBe(true);
    const final = record(path.join(directory, "successor.json"));
    if (!final) throw new Error("successor startup evidence is absent");
    expect(final?.phases.at(-1)?.phase).toBe("ready");
    const acquiredAt = Date.parse(final.phases.find((phase) => phase.phase === "fence-acquired")!.recordedAt);
    const fenceTrace = fs.readFileSync(path.join(directory, "fence-trace.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { pid: number; method: string; startedAt: number; endedAt: number; success: boolean });
    const releasedAt = fenceTrace.find((event) => event.pid === p!.child.pid && event.method === "release" && event.success)?.endedAt ?? null;
    const acquireTrace = fenceTrace.filter((event) => event.pid === s!.child.pid && event.method === "acquire");
    const refused = polls.filter((poll) => poll.status === null);
    console.log(JSON.stringify({ boot: "handoff-transfer", signalledAt, predecessorExitedAt, releasedAt, acquiredAt,
      releaseToAcquireMs: releasedAt === null ? null : acquiredAt - releasedAt,
      firstRefusedAt: refused[0]?.startedAt, lastRefusedAt: refused.at(-1)?.endedAt,
      refusedBeforeAcquire: refused.filter((poll) => poll.endedAt < acquiredAt).length,
      refusedAfterAcquire: refused.filter((poll) => poll.startedAt >= acquiredAt).length,
      acquireAttempts: acquireTrace.map(({ startedAt, endedAt, success }) => ({ startedAt, endedAt, success })) }));
    const progress = polls.filter((p) => p.record?.journal);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every((p) => p.record!.stableEntry === "listening")).toBe(true);
    const bound = polls.findIndex((p) => p.record?.stableEntry === "listening");
    expect(bound).toBeGreaterThanOrEqual(0);
    expect(polls.slice(bound).every((p) => p.status === 200)).toBe(true);
    expect(progress.some((p) => p.status === 200 && !p.record!.phases.some((phase) => phase.phase === "journal-open"))).toBe(true);
    expect((await probeRuntimeHostSuccessor(socket, successor)).generation).toEqual({ image: successor.image, revision: successor.revision, container: successor.container });
    const native = await call(socket, "append", { scope: "session:conversation-fixture", kind: "fixture.history", payload: {}, producer: { kind: "viewer", eventKey: "native:op-1" } });
    const stale = await call(socket, "append", { scope: "session:conversation-fixture", kind: "fixture.history", payload: {}, producer: { kind: "codex-app-server", eventKey: "engine-host:codex:session-1:1" } });
    expect(native.seq).toBe(280001); expect(stale.seq).toBeGreaterThan(300000);
    console.log(JSON.stringify({ boot: "handoff-300k", durationMs: Date.parse(final.phases.at(-1)!.recordedAt) - Date.parse(final.phases[1]!.recordedAt), pollsDuringJournal: progress.length, refusedAfterStableEntry: polls.slice(bound).filter((p) => p.status === null).length }));
    await stop(s); s = undefined; await stop(p); p = undefined;
    const reopened = new RuntimeJournal(filename); expect(reopened.isWritable()).toBe(true); reopened.close();
  } finally { if (s) await stop(s); if (p) await stop(p); viewer.close(); await once(viewer, "close"); fs.rmSync(directory, { recursive: true, force: true }); }
}, 240000);

test("generation read after the singleton fence prevents same-revision self-handoff", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "host-self-handoff-"));
  const port = await ephemeralPort(), options = { root, runtimeBin: process.execPath, stateDir: directory, port };
  const files = runtimeHostRehearsalFiles(directory), { failed: previous, retained: successor } = runtimeHostRehearsalGenerations(port);
  const fence = new RuntimeHostFence(path.join(directory, "fence.lock")); let s: ReturnType<typeof boot> | undefined;
  try {
    runtimeHostRehearsalPorts(options);
    const compose = viewerComposeSnapshotPath(directory, successor.container);
    fs.mkdirSync(path.dirname(compose), { recursive: true });
    fs.writeFileSync(compose, JSON.stringify({ services: { viewer: {
      build: null, command: null, entrypoint: null, environment: {}, image: successor.image,
      network_mode: "host", pid: "host", privileged: false, restart: "unless-stopped",
      "user": "1000:1000", volumes: [], working_dir: "/app",
    } } }));
    const journal = new RuntimeJournal(path.join(directory, "runtime-events.sqlite"));
    const receipt = journal.admitViewerDeployment({ idempotencyKey: "fixture-handoff", requestedRevision: successor.revision, revision: successor.revision }, { pid: 2147483647, startIdentity: "gone" });
    if (receipt.state !== "accepted") throw new Error("fixture deployment was refused");
    journal.updateViewerDeployment(receipt.deploymentId, { phase: "host-handoff", previous, candidate: successor }); journal.close();
    fence.acquire(); writeRuntimeHostRelease(previous, files.release); s = boot(options, "successor");
    await until(() => record(path.join(directory, "successor.json"))?.phases[0]?.phase === "fence-waiting", s);
    writeRuntimeHostHandoffIntent({ revision: successor.revision, image: successor.image, successorContainer: successor.container, predecessorId: previous.container, previousRelease: previous, successorRelease: successor, recordedAt: "2026-01-01T00:00:00.000Z" }, files.handoffIntent);
    writeRuntimeHostRelease(successor, files.release); fence.release();
    let status: ViewerDeploymentStatus | undefined;
    await until(() => { const db = new Database(path.join(directory, "runtime-events.sqlite"), { readonly: true }); try { status = JSON.parse(db.query<{ status_json: string }, [string]>("SELECT status_json FROM viewer_deployments WHERE deployment_id=?").get(receipt.deploymentId)!.status_json); return status?.terminal === true; } finally { db.close(); } }, s);
    console.log(JSON.stringify({ boot: "staged-generation", phase: status!.phase, untracked: s.log().includes("running generation is untracked"), dockerCalls: fs.existsSync(files.dockerCalls) ? fs.readFileSync(files.dockerCalls, "utf8").trim().split("\n") : [] }));
    expect(status!.phase).toBe("succeeded"); expect(status!.runtimeHostHandoff?.generation).toEqual({ image: successor.image, revision: successor.revision, container: successor.container });
    expect(s.child.exitCode).toBeNull(); expect(fs.existsSync(files.handoffIntent)).toBe(false);
    expect(readRuntimeHostRollbackTarget(files.rollbackTarget)).toMatchObject({ previous, active: successor });
    const docker = fs.readFileSync(files.dockerCalls, "utf8");
    expect(docker).not.toContain(`container start ${successor.container}`); expect(docker).not.toContain("container update --restart no"); expect(s.log()).not.toContain("running generation is untracked");
  } finally { fence.release(); if (s) await stop(s); fs.rmSync(directory, { recursive: true, force: true }); }
}, 180000);


async function snapshotRoute(directory: string): Promise<{ status: number; body: { code?: string; journal?: { subphase: string } } }> {
  const code = `import { GET } from ${JSON.stringify(path.join(root, "src/app/api/runtime/snapshot/route.ts"))}; const response = await GET(new Request("http://localhost/api/runtime/snapshot")); console.log(JSON.stringify({ status: response.status, body: await response.json() }));`;
  const child = Bun.spawn([process.execPath, "-e", code], {
    env: { PATH: process.env.PATH, HOME: directory, TMPDIR: path.join(directory, "tmp"), XDG_CONFIG_HOME: path.join(directory, "config"),
      LLV_STATE_DIR: directory, LLV_RUNTIME_HOST_SOCKET: path.join(directory, "runtime-host.sock"), LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" },
    stdout: "pipe", stderr: "pipe",
  });
  const [output, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exit !== 0) throw new Error(error);
  return JSON.parse(output.trim());
}

test("snapshot reports the fenced boot during a storage stall and recovers after journal open", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "host-slow-storage-"));
  const options = { root, runtimeBin: process.execPath, stateDir: directory, port: await ephemeralPort() };
  const files = runtimeHostRehearsalFiles(directory);
  const { failed: generation } = runtimeHostRehearsalGenerations(options.port);
  const startupFile = path.join(directory, "runtime-host-startup", "host.json");
  const filename = path.join(directory, "runtime-events.sqlite");
  let host: ReturnType<typeof boot> | undefined;
  let storage: Database | undefined;
  try {
    largeJournal(filename, 300, { migrated: true });
    runtimeHostRehearsalPorts(options);
    writeRuntimeHostRelease(generation, files.release);
    // A real SQLite writer holds schema/migration writes. The host's FULL
    // durability and busy timeout remain the production values.
    storage = new Database(filename);
    storage.exec("BEGIN IMMEDIATE");
    const environment = runtimeHostRehearsalEnvironment(options, "predecessor");
    environment.LLV_RUNTIME_HOST_STARTUP_TARGET = startupFile;
    environment.LLV_RUNTIME_HOST_FENCE = path.join(directory, "fence.lock");
    const child = spawn(process.execPath, ["run", "src/runtime-host/main.ts"], { cwd: root, env: environment as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
    let log = ""; child.stdout!.on("data", (chunk) => { log += chunk; }); child.stderr!.on("data", (chunk) => { log += chunk; });
    host = { child, log: () => log, exited: new Promise<void>((resolve) => child.once("exit", () => resolve())) };
    await until(() => record(startupFile)?.phases.some((phase) => phase.phase === "fence-acquired"), host, 4000);
    await Bun.sleep(1000);
    const response = await snapshotRoute(directory);
    expect(response).toMatchObject({ status: 503, body: { code: "runtime-host-booting", journal: { subphase: "schema" } } });
    expect(record(startupFile)!.stableEntry).toBe("listening");
    expect(record(startupFile)!.phases.some((phase) => phase.phase === "journal-open")).toBe(false);
    await expect(call(path.join(directory, "runtime-host.sock"), "append", { scope: "system:fixture", kind: "fixture.history", payload: {} })).rejects.toThrow();
    storage.exec("ROLLBACK"); storage.close(); storage = undefined;
    await until(() => record(startupFile)?.phases.at(-1)?.phase === "ready", host);
    expect((await snapshotRoute(directory)).status).toBe(200);
    expect(record(startupFile)!.phases.at(-1)!.phase).toBe("ready");
    console.log(JSON.stringify({ boot: "slow-storage-snapshot", stalledStatus: response.status, stalledCode: response.body.code, recoveredStatus: 200 }));
  } finally {
    if (storage) { storage.exec("ROLLBACK"); storage.close(); }
    if (host) await stop(host);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 15000);
