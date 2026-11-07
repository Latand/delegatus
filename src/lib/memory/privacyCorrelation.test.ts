import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { TaskPageWorker, runPrivacyWork, shutdownTaskPageWorker, taskPageWorkerDiagnostics, type TaskPageWorkerRuntime } from "@/lib/links/taskPageWorker";
import { OperationLease } from "@/lib/operationLease";
import { roleMemoryCollection } from "./roleStore";
import type { PrivacyWorkerObservation } from "./privacyDiagnostics";

const text = "Preserve amber orchard receipts until the owning operation completes";
const root = process.env.LLV_STATE_DIR!;
let generation = 0;
let fixtureId = 0;
const workers: TaskPageWorker[] = [];
let restoreIds: () => void;
beforeEach(() => {
  setSystemTime(new Date("2026-11-05T00:00:00Z")); // Wall time only; deadlines use the real monotonic clock.
  const ids = spyOn(crypto, "randomUUID").mockImplementation(() => `20000000-0000-4000-8000-${String(++fixtureId).padStart(12, "0")}`);
  restoreIds = () => ids.mockRestore();
});
afterEach(async () => {
  await shutdownTaskPageWorker();
  for (const worker of workers.splice(0)) await worker.shutdown();
  process.env.LLV_STATE_DIR = root;
  restoreIds(); setSystemTime();
});
function store() {
  process.env.LLV_STATE_DIR = path.join(root, `correlation-${++generation}`);
  roleMemoryCollection(true)!.boundedPatch(1, tx => tx.put({ kind: "rule", id: "r_correlation", scope: "machine", rule: text,
    why: "", state: "active", hints: [], source: { project: "fixture", pipelineId: "fixture", stageId: "build", attempt: 1,
      roleId: "builder", fixRound: false, conversationId: "conversation_fixture" },
    createdAt: "2026-11-05T00:00:00Z", changedAt: "2026-11-05T00:00:00Z" }));
}
function rows(): PrivacyWorkerObservation[] {
  return taskPageWorkerDiagnostics().privacy?.rows ?? [];
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function worker(runtime: TaskPageWorkerRuntime = {}) {
  const result = new TaskPageWorker(runtime); workers.push(result); return result;
}
function fixture(name: string, source: string) {
  const file = path.join(process.env.TMPDIR!, `${name}.ts`);
  fs.writeFileSync(file, source); return { executable: process.execPath, workerPath: file };
}

test("production privacy worker correlates real envelopes and successful completion", async () => {
  store();
  const before = new Set(rows().map(row => row.jobId));
  const result = await runPrivacyWork({ kind: "filter", value: { prompt: text } });
  expect(result.value).toEqual({ prompt: "[learned rule]" });
  const observed = rows().filter(row => !before.has(row.jobId));
  expect(observed.map(row => row.phase)).toEqual(["queued", "dispatched", "started", "compile", "match", "settled"]);
  expect(new Set(observed.map(row => row.requestId)).size).toBe(1);
  expect(new Set(observed.map(row => row.jobId)).size).toBe(1);
  expect(observed.at(-1)).toMatchObject({ owner: "unknown", cancelled: false, queueMs: expect.any(Number), executeMs: expect.any(Number) });
  expect(JSON.stringify(observed)).not.toContain(text);
});

test("real worker queue timeout and started timeout retain distinct observations", async () => {
  store();
  const { withPrivacyWorkerOwner } = await import("./privacyDiagnostics");
  const ready = deferred();
  // Pause the real worker's transport immediately after its actual match
  // notification. No response or clock is invented by this control.
  const launch = fixture("privacy-held-transport", `
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk, ...args) => {
 const result = write(chunk, ...args);
 if (String(chunk).includes('"phase":"match"')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
 return result;
});
await import(${JSON.stringify(path.join(process.cwd(), "src/lib/taskPage.worker.ts"))});`);
  const runtime: TaskPageWorkerRuntime = { launch, timeoutMs: 4_000, onPhase: phase => { if (phase === "match") ready.resolve(); } };
  const held = worker(runtime);
  const active = withPrivacyWorkerOwner("fixture-lane", "build", 3, () => held.privacy({ kind: "filter", value: text }))
    .then(() => null, error => error);
  await Promise.race([ready.promise, active.then(error => { throw error; })]);
  runtime.timeoutMs = 150;
  const queuedAt = performance.now();
  const queued = await withPrivacyWorkerOwner("fixture-lane", "build", 3, () => held.privacy({ kind: "filter", value: text }))
    .then(() => null, error => error);
  expect(queued).toMatchObject({ failure: "worker-timeout", code: "LESSON_PRIVACY_UNAVAILABLE" });
  expect(performance.now() - queuedAt).toBeGreaterThanOrEqual(140);
  const queueTimeout = rows().findLast(row => row.phase === "timeout")!;
  expect(queueTimeout).toMatchObject({ lastPhase: "queued", budgetMs: 150, queueMs: expect.any(Number), executeMs: "unknown", cancelled: false });
  expect(await active).toMatchObject({ failure: "worker-timeout" });
  const activeTimeout = rows().findLast(row => row.phase === "timeout")!;
  expect(activeTimeout).toMatchObject({ lastPhase: "match", budgetMs: 4_000, cancelled: false, queueMs: expect.any(Number), executeMs: expect.any(Number) });
  expect(activeTimeout.jobId).not.toBe(queueTimeout.jobId);
  expect(activeTimeout.elapsedMs).toBeGreaterThanOrEqual(3_990);
  expect(activeTimeout.owner).toEqual(queueTimeout.owner);
}, 15_000);

test("shutdown settles queued cancellation without admitting it and a new worker succeeds", async () => {
  store();
  const ready = deferred();
  const launch = fixture("privacy-waiting-start", `import readline from "node:readline";
for await (const line of readline.createInterface({ input: process.stdin })) {
 const { id, correlation } = JSON.parse(line);
 process.stdout.write(JSON.stringify({ id, correlation, phase: "started" }) + "\\n");
 process.stdout.write(JSON.stringify({ id, correlation, phase: "match" }) + "\\n");
 Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}`);
  const held = worker({ launch, onPhase: ready.resolve });
  const first = held.privacy({ kind: "filter", value: text }).catch(error => error);
  await Promise.race([ready.promise, first.then(error => { throw error; })]);
  const lease = new OperationLease();
  const next = lease.run(() => held.privacy({ kind: "filter", value: text })).catch(error => error);
  const cancelledJob = rows().at(-1)!.jobId;
  lease.expire();
  const rest = Array.from({ length: 14 }, () => held.privacy({ kind: "filter", value: text }).catch(error => error));
  await expect(held.privacy({ kind: "filter", value: text })).rejects.toMatchObject({ failure: "worker-queue-full" });
  expect(rows().at(-1)).toMatchObject({ phase: "settled", lastPhase: "queued", failure: "worker-queue-full", executeMs: "unknown" });
  await held.shutdown();
  expect(await first).toMatchObject({ failure: "worker-shutdown" });
  expect(await next).toMatchObject({ name: "OperationLeaseExpiredError" });
  expect((await Promise.all(rest)).every(error => error.failure === "worker-shutdown")).toBe(true);
  expect(rows().findLast(row => row.jobId === cancelledJob)).toMatchObject({ phase: "settled", lastPhase: "queued", cancelled: true, failure: "worker-shutdown" });
  expect((await runPrivacyWork({ kind: "filter", value: text })).value).toBe("[learned rule]");
});

test("a lease revoked at the real worker's first phase preserves caller cancellation", async () => {
  store();
  const lease = new OperationLease();
  const real = worker({ onPhase: () => lease.expire() });
  await expect(lease.run(() => real.privacy({ kind: "filter", value: text }))).rejects.toMatchObject({ name: "OperationLeaseExpiredError" });
  await real.shutdown();
  const terminal = rows().findLast(row => row.phase === "settled")!;
  expect(terminal.cancelled).toBe(true);
  expect(terminal.executeMs).toEqual(expect.any(Number));
  expect(terminal.failure).toBeDefined();
});

for (const field of ["requestId", "jobId"] as const) test.each(["started", "compile", "match", "result", "error"])(`forged ${field} is refused before consuming %s`, async phase => {
  store();
  const launch = fixture(`privacy-forged-${field}-${phase}`, `import readline from "node:readline";
for await (const line of readline.createInterface({ input: process.stdin })) {
 const { id, correlation } = JSON.parse(line);
 process.stdout.write(JSON.stringify({ id, correlation: { ...correlation, ${field}: ${JSON.stringify(text)} },
 phase: ${JSON.stringify(phase)}, result: { privacyRevision: "", value: "unchecked" }, error: ${JSON.stringify(text)} }) + "\\n");
}`);
  await expect(worker({ launch }).privacy({ kind: "filter", value: text })).rejects.toMatchObject({ failure: "worker-invalid-reply" });
  expect(rows().at(-1)).toMatchObject({ phase: "settled", failure: "worker-invalid-reply", executeMs: "unknown" });
  expect(JSON.stringify(rows())).not.toContain(text);
});

test.each(["invalid", "partial", "null"])("production worker refuses a malformed incoming correlation: %s", async mode => {
  store();
  // Change only the envelope on its way into the production worker. Its real
  // parser and error writer still produce the reply consumed by the parent.
  const launch = fixture(`privacy-malformed-${mode}`, `
import { PassThrough } from "node:stream";
import readline from "node:readline";
const source = process.stdin, input = new PassThrough();
Object.defineProperty(process, "stdin", { value: input });
void (async () => {
 for await (const line of readline.createInterface({ input: source })) {
  const frame = JSON.parse(line);
  frame.correlation = ${mode === "null" ? "null" : mode === "partial" ? `{ requestId: frame.correlation.requestId }` : `{ requestId: ${JSON.stringify(text)}, jobId: ${JSON.stringify(text)} }`};
  input.write(JSON.stringify(frame) + "\\n");
 }
 input.end();
})();
await import(${JSON.stringify(path.join(process.cwd(), "src/lib/taskPage.worker.ts"))});`);
  await expect(worker({ launch }).privacy({ kind: "filter", value: text })).rejects.toMatchObject({ failure: "worker-invalid-reply" });
  expect(rows().at(-1)).toMatchObject({ phase: "settled", failure: "worker-invalid-reply", executeMs: "unknown" });
  expect(JSON.stringify(rows())).not.toContain(text);
});

test("legacy replies explicitly leave execution duration unknown", async () => {
  process.env.LLV_STATE_DIR = path.join(root, `legacy-${++generation}`);
  const launch = fixture("privacy-legacy", `import readline from "node:readline";
for await (const line of readline.createInterface({ input: process.stdin })) {
 const { id } = JSON.parse(line);
 process.stdout.write(JSON.stringify({ id, result: { privacyRevision: "", value: null } }) + "\\n");
}`);
  expect((await worker({ launch }).privacy({ kind: "filter", value: null })).value).toBeNull();
  expect(rows().at(-1)).toMatchObject({ phase: "settled", lastPhase: "dispatched", queueMs: "unknown", executeMs: "unknown" });
});

test("production reader accepts every worker reply family and retains curation refusal", async () => {
  store();
  const real = worker();
  const deny = { accounts: [], people: [], local: [], projects: [] };
  await real.privacy({ kind: "report", input: { class: "status", name: "Delegatus", at: "2026-11-05T00:00:00Z",
    locale: "en", timeZone: "UTC", summary: "The operation completed", sections: { merged: [text] }, deny } });
  expect(rows().at(-1)).toMatchObject({ phase: "settled", executeMs: expect.any(Number) });
  await real.privacy({ kind: "issue", report: { title: text, body: text }, deny });
  expect(rows().at(-1)).toMatchObject({ phase: "settled", executeMs: expect.any(Number) });
  await real.privacy({ kind: "curation-known-values" });
  expect(rows().at(-1)).toMatchObject({ phase: "settled", lastPhase: "compile" });
  await expect(real.privacy({ kind: "curation-undo", passId: "missing-fixture-pass" })).rejects.toMatchObject({ code: "CURATE_LIVE" });
  expect(rows().at(-1)).toMatchObject({ phase: "settled", executeMs: expect.any(Number) });
  expect(rows().at(-1)?.failure).toBe("CURATE_LIVE");
  const filter = { self: { id: "fixture", prefix: "fixture" }, projects: new Set<string>(), skipPrefix: null, now: 1_700_000_000_000 };
  await real.build({ kind: "scan", after: "" }, filter);
  expect(rows().at(-1)).toMatchObject({ phase: "settled", executeMs: expect.any(Number) });
  await real.build({ kind: "log", after: [] }, filter);
  expect(rows().at(-1)).toMatchObject({ phase: "settled", executeMs: expect.any(Number) });
});

test("caller context hashes hostile labels, preserves nested requests and isolates concurrent owners", async () => {
  store();
  const { withPrivacyWorkerOwner } = await import("./privacyDiagnostics");
  let nextId = 0;
  const ids = spyOn(crypto, "randomUUID").mockImplementation(() => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`);
  try {
    const jobs = await Promise.all([1, 2].map(attempt => withPrivacyWorkerOwner(text, text, attempt,
      () => withPrivacyWorkerOwner(text, text, attempt, () => runPrivacyWork({ kind: "filter", value: text })))));
    expect(jobs.map(job => job.value)).toEqual(["[learned rule]", "[learned rule]"]);
    const settled = rows().filter(row => row.phase === "settled").slice(-2);
    expect(settled.map(row => row.owner === "unknown" ? 0 : row.owner.attempt)).toEqual([1, 2]);
    expect(new Set(settled.map(row => row.requestId)).size).toBe(2);
    expect(nextId).toBe(4);
    expect(JSON.stringify(settled)).not.toContain(text);
    await withPrivacyWorkerOwner(text, text, 3, async () => {
      await runPrivacyWork({ kind: "filter", value: text });
      await runPrivacyWork({ kind: "filter", value: text });
    });
    const sameRequest = rows().filter(row => row.phase === "settled").slice(-2);
    expect(new Set(sameRequest.map(row => row.requestId)).size).toBe(1);
    expect(new Set(sameRequest.map(row => row.jobId)).size).toBe(2);
    expect((await runPrivacyWork({ kind: "filter", value: text })).value).toBe("[learned rule]");
    expect(rows().at(-1)?.owner).toBe("unknown");
  } finally { ids.mockRestore(); }
});

test("diagnostic retention is bounded and a restarted process owns a fresh tail", async () => {
  for (const count of [40, 1]) {
    const child = Bun.spawn([process.execPath, "test", import.meta.path, "-t", "^privacy diagnostic restart child$"], {
      env: { ...process.env, LLV_PRIVACY_TRACE_CHILD: String(count) }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit, out + err).toBe(0);
  }
}, 30_000);

test.skipIf(!process.env.LLV_PRIVACY_TRACE_CHILD)("privacy diagnostic restart child", async () => {
  const { PRIVACY_OBSERVATION_LIMIT, privacyWorkerObservations } = await import("./privacyDiagnostics");
  expect(privacyWorkerObservations()).toMatchObject({ rows: [], evicted: 0, droppedLogs: 0 });
  store();
  const count = Number(process.env.LLV_PRIVACY_TRACE_CHILD);
  for (let i = 0; i < count; i++) await runPrivacyWork({ kind: "filter", value: text });
  const snapshot = privacyWorkerObservations();
  // First request compiles; later requests use the real worker's cached matcher.
  expect(snapshot.rows.length).toBeLessThanOrEqual(PRIVACY_OBSERVATION_LIMIT);
  expect(snapshot.evicted > 0).toBe(count === 40);
  expect(snapshot.rows.at(-1)?.phase).toBe("settled");
  snapshot.rows.splice(0);
  expect(privacyWorkerObservations().rows.length).toBeGreaterThan(0);
});
