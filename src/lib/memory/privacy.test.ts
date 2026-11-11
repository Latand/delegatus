import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import { Database } from "bun:sqlite";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "privacy-worker-"));
process.env.LLV_STATE_DIR = path.join(root, "initial");
const { recordLessonRequest, roleMemoryCollection, storedLessonRevision, storedLessonTexts, withoutStoredLessonsIn } = await import("./roleStore");
const { withoutStoredLessonsAsync, renderReportAsync, scrubIssueReportAsync } = await import("./privacy");
const { TaskPageWorker, shutdownTaskPageWorker } = await import("@/lib/links/taskPageWorker");
const { renderReport } = await import("@/lib/bridge/reportRender");
const { scrubIssueReport } = await import("@/lib/issueReports/scrub");
const { performanceSpans, performanceSites } = await import("@/lib/performanceSpans");
let generation = 0;
beforeEach(async () => {
  await shutdownTaskPageWorker();
  process.env.LLV_STATE_DIR = path.join(root, String(++generation));
  performanceSpans.clear();
});
afterAll(async () => { await shutdownTaskPageWorker(); fs.rmSync(root, { recursive: true, force: true }); });
const lesson = "Preserve fixtureword receipts until the owning operation completes";
function store(texts: string[]) {
  roleMemoryCollection(true)!.boundedPatch(texts.length, tx => texts.forEach((rule, index) => tx.put({
    kind: "rule", id: `r_fixture_${index}`, scope: "machine", rule, why: "", state: index % 2 ? "archived" : "active", hints: [],
    source: { project: "fixture", pipelineId: "fixture", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "conversation_fixture" },
    createdAt: "2026-10-14T00:00:00Z", changedAt: "2026-10-14T00:00:00Z",
  })));
}
const deny = { accounts: [], people: [], local: [], projects: [] };
const report = () => ({ class: "status" as const, name: "Delegatus", at: new Date("2026-10-14T00:00:00Z"), locale: "en" as const, timeZone: "UTC",
  summary: "The release completed", sections: { merged: [lesson, "The verification passed"], queued: ["Follow the documented procedure"] }, deny });
const compileCount = () => performanceSpans.snapshot().records.filter(row => performanceSites[row.site] === "privacy.compile").reduce((sum, row) => sum + row.count, 0);

test("an absent collection needs no worker and later creation immediately restores the privacy fence", async () => {
  const previous = process.cwd();
  const empty = path.join(root, "no-worker-entry");
  fs.mkdirSync(empty);
  process.chdir(empty);
  try {
    const value = { text: lesson };
    expect(await withoutStoredLessonsAsync(value)).toBe(value);
    store([lesson]);
    await expect(withoutStoredLessonsAsync(lesson)).rejects.toMatchObject({ code: "LESSON_PRIVACY_UNAVAILABLE" });
  } finally {
    await shutdownTaskPageWorker();
    process.chdir(previous);
  }
}, 30_000);

test("stage text, nested records, bridge reports and issue hints retain exact bytes through one worker", async () => {
  store([lesson, "fixtureword receipts", "....++++", "ſilver Kelvin Kernel final ςigma", "[learned rule]"]);
  const value = { text: `Start\n${lesson.toUpperCase().replaceAll(" ", " --\n")}\nEnd`, nested: ["....++++", { text: lesson }], count: 3 };
  expect(JSON.stringify(await withoutStoredLessonsAsync(value))).toBe(JSON.stringify(withoutStoredLessonsIn(value)));
  const count = compileCount();
  expect(count).toBeGreaterThan(0);
  const revision = storedLessonRevision();
  recordLessonRequest({ project: "fixture", pipelineId: "unrelated", stageId: "build", attempt: 1,
    roleId: "builder", conversationId: "conversation_fixture", at: "2026-11-06T00:00:00Z" });
  expect(storedLessonRevision()).toBe(revision);
  const input = report();
  const expected = renderReport({ ...input, deny: { ...deny, lessons: storedLessonTexts() } });
  expect(JSON.stringify(await renderReportAsync(input))).toBe(JSON.stringify(expected));
  expect(compileCount()).toBe(count);
  expect((await renderReportAsync({ ...input, deny: { ...deny, lessons: [] } })).dropped.lesson).toBe(1);
  const markerReport = { ...input, summary: "[learned rule]" };
  expect(JSON.stringify(await renderReportAsync(markerReport))).toBe(JSON.stringify(renderReport({ ...markerReport, deny: { ...deny, lessons: storedLessonTexts() } })));
  const issue = { title: "Verification finding", body: `${lesson}\nfixtureword receipts` };
  expect(await scrubIssueReportAsync(issue, deny)).toEqual(scrubIssueReport(issue, { ...deny, lessons: storedLessonTexts() }));
  const exactCount = compileCount();
  await scrubIssueReportAsync(issue, deny);
  expect(compileCount()).toBe(exactCount);
  const sites = performanceSpans.snapshot().records.map(row => performanceSites[row.site]);
  expect(sites).toContain("privacy.match");
  expect(sites).toContain("privacy.worker");
}, 30_000);

test("the caller never compiles or executes the stored patterns, including cold and restarted workers", async () => {
  store([lesson, ...Array.from({ length: 500 }, (_, index) => `fixtureword${index} verify every retained receipt before publishing the final result`)]);
  const input = "Ordinary launch instructions. ".repeat(800) + lesson;
  const original = RegExp.prototype.exec;
  RegExp.prototype.exec = function (text: string) {
    if (this.source.includes("fixtureword")) throw new Error("stored pattern executed on the caller thread");
    return original.call(this, text);
  };
  try {
    for (let restart = 0; restart < 2; restart++) {
      expect(await withoutStoredLessonsAsync(input)).toBe(input.slice(0, -lesson.length) + "[learned rule]");
      expect((await renderReportAsync(report())).dropped.lesson).toBe(1);
      expect(await withoutStoredLessonsAsync(input + " " + restart)).toBe(input.slice(0, -lesson.length) + "[learned rule] " + restart);
      await shutdownTaskPageWorker();
    }
  } finally { RegExp.prototype.exec = original; }
}, 30_000);

test("revision changes replace the shared matcher for every operation", async () => {
  store([lesson]);
  expect(await withoutStoredLessonsAsync(lesson)).toBe("[learned rule]");
  const count = compileCount();
  const added = "A different fixtureword rule protects the silver orchard";
  store([lesson, added]);
  expect(await withoutStoredLessonsAsync(added)).toBe("[learned rule]");
  expect(compileCount()).toBeGreaterThan(count);
  expect((await renderReportAsync({ ...report(), summary: added })).dropped.lesson).toBe(2);
}, 30_000);

test("unreadable memory refuses launches, reports and issue hints without returning input", async () => {
  const state = process.env.LLV_STATE_DIR!;
  store([lesson]);
  const database = new Database(path.join(state, "state.sqlite"));
  database.query("UPDATE state_rows SET value_json = ? WHERE collection = 'role_memory' AND row_key LIKE 'r:%'").run(JSON.stringify({ kind: "rule", id: 7, rule: lesson }));
  database.close();
  for (const call of [() => withoutStoredLessonsAsync(lesson), () => renderReportAsync(report()), () => scrubIssueReportAsync({ title: lesson, body: lesson }, deny)]) {
    await expect(call()).rejects.toMatchObject({ code: "LESSON_PRIVACY_UNAVAILABLE" });
  }
}, 30_000);

test("a refused matcher and a missing worker fail closed", async () => {
  store(["oversizedword ".repeat(80_000)]);
  await expect(withoutStoredLessonsAsync(lesson)).rejects.toMatchObject({ code: "LESSON_PRIVACY_UNAVAILABLE" });
  await shutdownTaskPageWorker();
  const worker = new TaskPageWorker({ launch: { executable: path.join(root, "missing-runtime"), workerPath: "missing-worker" } });
  try { await expect(worker.privacy({ kind: "filter", value: lesson })).rejects.toMatchObject({ code: "LESSON_PRIVACY_UNAVAILABLE" }); }
  finally { await worker.shutdown(); }
}, 30_000);

test("queue overflow and a stuck owned worker refuse every call and permit a fresh process", async () => {
  const fixture = path.join(root, "stuck-worker.ts");
  fs.writeFileSync(fixture, `import readline from "node:readline";
process.on("SIGTERM", () => {});
for await (const line of readline.createInterface({ input: process.stdin })) {
 const { id } = JSON.parse(line); process.stdout.write(JSON.stringify({ id, phase: "match" }) + "\\n");
 while (true) { /* guardian must end this owned process */ }
}`);
  const worker = new TaskPageWorker({ launch: { executable: process.execPath, workerPath: fixture }, timeoutMs: 2_000 });
  try {
    const pending = Array.from({ length: 16 }, () => worker.privacy({ kind: "filter", value: lesson }));
    const outcomes = Promise.allSettled(pending);
    await expect(worker.privacy({ kind: "filter", value: lesson })).rejects.toMatchObject({ code: "LESSON_PRIVACY_UNAVAILABLE", failure: "worker-queue-full" });
    const failed = await outcomes;
    expect(failed.every(result => result.status === "rejected")).toBe(true);
    for (const result of failed) if (result.status === "rejected") expect(result.reason).toMatchObject({ failure: "worker-timeout" });
  } finally { await worker.shutdown(); }
  store([lesson]);
  expect(await withoutStoredLessonsAsync(lesson)).toBe("[learned rule]");
}, 30_000);

test("a revision changed while the worker owns a call refuses its stale response", async () => {
  store([lesson]);
  const release = path.join(root, "release");
  const fixture = path.join(root, "held-worker.ts");
  fs.writeFileSync(fixture, `import fs from "node:fs";
import readline from "node:readline";
import { storedLessonRevision } from ${JSON.stringify(path.join(process.cwd(), "src/lib/memory/roleStore.ts"))};
for await (const line of readline.createInterface({ input: process.stdin })) {
 const { id } = JSON.parse(line), privacyRevision = storedLessonRevision();
 process.stdout.write(JSON.stringify({ id, phase: "match" }) + "\\n");
 while (!fs.existsSync(${JSON.stringify(release)})) await new Promise(done => setTimeout(done, 5));
 process.stdout.write(JSON.stringify({ id, result: { value: "unchecked response", privacyRevision } }) + "\\n");
}`);
  let ready!: () => void;
  const readyPromise = new Promise<void>(resolve => { ready = resolve; });
  const worker = new TaskPageWorker({ launch: { executable: process.execPath, workerPath: fixture }, timeoutMs: 10_000, onPhase: ready });
  const result = worker.privacy({ kind: "filter", value: lesson });
  const outcome = result.then(value => ({ value, error: null }), error => ({ value: null, error }));
  try {
    await readyPromise;
    store([lesson, "A newer rule requires the complete receipt before the handoff"]);
    fs.writeFileSync(release, "release");
    expect((await outcome).error).toMatchObject({ code: "LESSON_PRIVACY_UNAVAILABLE" });
  } finally { await worker.shutdown(); }
}, 30_000);

test("linked agent titles go out as written at the wire length, and a lesson revision does not republish them", async () => {
  const { AgentFeed, agentPart, decodeCursor, dropAgents } = await import("@/lib/links/agentFeed");
  const { sharedLinkState } = await import("@/lib/links/runtimeState");
  const project = `repo-${"a".repeat(32)}`, id = "privacy-agent-fixture";
  const title = "A long fixtureword title preserves every original receipt until its operation completes " + "with the complete documented context ".repeat(6);
  const files = [{ path: "/sandbox/fixture.jsonl", conversationId: "conversation_fixture", project, engine: "claude", proc: "running", activity: "live", mtime: 1, lastAgentWorkAt: 1, pendingQuestion: null, waitingInput: null }];
  const tasks = [{ id: "fixture-task", project, chosen: true, text: title, assignments: [{ path: files[0]!.path }] }];
  const feed = new AgentFeed(id, () => files as never, () => tasks as never, () => [], () => () => false,
    { snapshot: () => ({ conversations: {}, memberships: {}, lineageEdges: {} }), seats: () => [], canonical: p => p });
  sharedLinkState("agentFeed.feeds", () => new Map<string, InstanceType<typeof AgentFeed>>()).set(id, feed);
  const worker = spyOn(TaskPageWorker.prototype, "privacy");
  try {
    const first = await agentPart(id, null, new Set([project]));
    expect(first.rows?.find(row => "task" in row && row.task === "fixture-task")).toMatchObject({ t: title.slice(0, 120), e: "claude" });
    store([title]);
    const after = await agentPart(id, decodeCursor(first.cursor)!, new Set([project]));
    expect(after.rows ?? []).toEqual([]);
    expect((await agentPart(id, null, new Set([project]))).rows?.find(row => "task" in row && row.task === "fixture-task")).toMatchObject({ t: title.slice(0, 120) });
    expect(worker).not.toHaveBeenCalled();
  } finally { worker.mockRestore(); dropAgents(id); }
}, 30_000);

test.each(["lease-abort", "lease-abort-with-worker-error", "worker-failure"] as const)("privacy entry points preserve their failure class: %s", async mode => {
  store([lesson]);
  const { OperationLease, OperationLeaseExpiredError, assertOperationLease } = await import("@/lib/operationLease");
  const workerFailure = new Error("fixture worker unavailable");
  const worker = spyOn(TaskPageWorker.prototype, "privacy");
  try {
    for (const call of [() => withoutStoredLessonsAsync(lesson), () => renderReportAsync(report()),
      () => scrubIssueReportAsync({ title: lesson, body: lesson }, deny),
      () => import("./privacy").then(module => module.refreshCurationKnownValuesAsync())]) {
      // Each caller receives its own fresh pass lease.
      const current = new OperationLease();
      worker.mockImplementation(async () => {
        if (mode !== "worker-failure") current.expire();
        if (mode === "lease-abort") assertOperationLease();
        throw workerFailure;
      });
      const result = current.run<Promise<unknown>>(call);
      if (mode !== "worker-failure") {
        const error = await result.catch(error => error);
        expect(error).toBeInstanceOf(OperationLeaseExpiredError);
        expect(error).toBe(current.abort.signal.reason);
      } else await expect(result).rejects.toMatchObject({ code: "LESSON_PRIVACY_UNAVAILABLE",
        message: "role memory could not be read or filtered; worker-unavailable; nothing was sent" });
      expect(worker).toHaveBeenCalled();
    }
  } finally { worker.mockRestore(); }
});


test("completed exact strings reuse filtering, while new input and new revisions miss", async () => {
  store([lesson]);
  const worker = spyOn(TaskPageWorker.prototype, "privacy");
  try {
    const input = `Launch safely. ${lesson}`;
    const expected = withoutStoredLessonsIn(input);
    expect(await withoutStoredLessonsAsync(input)).toBe(expected);
    expect(worker).toHaveBeenCalledTimes(1);
    expect(await withoutStoredLessonsAsync(input)).toBe(expected);
    expect(worker).toHaveBeenCalledTimes(1);
    recordLessonRequest({ project: "fixture", pipelineId: "request", stageId: "build", attempt: 1,
      roleId: "builder", conversationId: "conversation_fixture", at: "2026-11-09T00:00:00Z" });
    expect(await withoutStoredLessonsAsync(input)).toBe(expected);
    expect(worker).toHaveBeenCalledTimes(1);
    await withoutStoredLessonsAsync(`${input}!`);
    expect(worker).toHaveBeenCalledTimes(2);
    store([lesson, "Launch safely"]);
    expect(await withoutStoredLessonsAsync(input)).toBe(withoutStoredLessonsIn(input));
    expect(worker).toHaveBeenCalledTimes(3);
  } finally { worker.mockRestore(); }
});

test.each(["malformed", "operation"] as const)("worker %s syntax retains its protocol origin", async mode => {
  store([lesson]);
  const file = path.join(process.env.LLV_STATE_DIR!, "reply-fixture.ts");
  fs.writeFileSync(file, `import readline from "node:readline";
    for await (const line of readline.createInterface({ input: process.stdin })) {
      const { id } = JSON.parse(line);
      process.stdout.write(${mode === "malformed" ? JSON.stringify("{" + lesson + "\n") : `JSON.stringify({ id, error: ${JSON.stringify(lesson)}, failure: "syntax-error" }) + String.fromCharCode(10)`});
    }`);
  const worker = new TaskPageWorker({ launch: { executable: process.execPath, workerPath: file } });
  try {
    const error = await worker.privacy({ kind: "filter", value: lesson }).catch(error => error);
    expect(error).toMatchObject({ failure: mode === "malformed" ? "worker-invalid-reply" : "syntax-error" });
    expect(String(error)).not.toContain(lesson);
  } finally { await worker.shutdown(); }
});


test("cache hits recheck revisions, marker inputs and expired caller leases", async () => {
  store([lesson, "[learned rule]"]);
  const worker = spyOn(TaskPageWorker.prototype, "privacy");
  const { OperationLease, OperationLeaseExpiredError } = await import("@/lib/operationLease");
  try {
    const filtered = await withoutStoredLessonsAsync(lesson);
    expect(await withoutStoredLessonsAsync(filtered)).toBe(withoutStoredLessonsIn(filtered));
    expect(worker).toHaveBeenCalledTimes(2);
    const hit = withoutStoredLessonsAsync(lesson);
    store([lesson, "[learned rule]", "ordinary"]);
    expect(await hit).toBe(withoutStoredLessonsIn(lesson));
    expect(worker).toHaveBeenCalledTimes(3);
    const lease = new OperationLease();
    const revoked = lease.run(() => withoutStoredLessonsAsync(lesson));
    lease.expire();
    await expect(revoked).rejects.toBeInstanceOf(OperationLeaseExpiredError);
    expect(worker).toHaveBeenCalledTimes(3);
  } finally { worker.mockRestore(); }
});

test.each(["ttl", "count", "bytes", "oversize"] as const)("completed cache is bounded by %s", async limit => {
  store([lesson]);
  let clock = 0;
  const now = spyOn(performance, "now").mockImplementation(() => clock);
  const worker = spyOn(TaskPageWorker.prototype, "privacy");
  const input = limit === "bytes" ? "x".repeat(48 * 1024) + " " + lesson : limit === "oversize" ? "x".repeat(70 * 1024) + " " + lesson : lesson;
  try {
    await withoutStoredLessonsAsync(input);
    if (limit === "ttl") clock += 600_000;
    if (limit === "count" || limit === "bytes") {
      const count = limit === "count" ? 128 : 90;
      for (let index = 0; index < count; index++) await withoutStoredLessonsAsync(`${input} ${index}`);
    }
    const before = worker.mock.calls.length;
    expect(await withoutStoredLessonsAsync(input)).toBe(withoutStoredLessonsIn(input));
    expect(worker).toHaveBeenCalledTimes(before + 1);
    if (limit !== "oversize") {
      await withoutStoredLessonsAsync(input);
      expect(worker).toHaveBeenCalledTimes(before + 1);
    }
  } finally { worker.mockRestore(); now.mockRestore(); }
}, 60_000);

test("cache generation follows root, replacement, ABA, deletion, archive and reason writes", async () => {
  const text = `${lesson} secondary private reason`;
  store([lesson]);
  const worker = spyOn(TaskPageWorker.prototype, "privacy");
  const verify = async () => {
    const before = worker.mock.calls.length;
    expect(await withoutStoredLessonsAsync(text)).toBe(withoutStoredLessonsIn(text));
    expect(worker).toHaveBeenCalledTimes(before + 1);
    await withoutStoredLessonsAsync(text);
    expect(worker).toHaveBeenCalledTimes(before + 1);
  };
  try {
    await verify();
    store(["other protected wording"]); await verify();
    store([lesson]); await verify();
    const collection = roleMemoryCollection()!;
    const original = collection.get("r:r_fixture_0");
    if (!original || original.kind !== "rule") throw new Error("fixture rule unavailable");
    collection.boundedPatch(1, tx => tx.put({ ...original, state: "archived" })); await verify();
    collection.boundedPatch(1, tx => tx.put({ ...original, why: "secondary private reason" })); await verify();
    collection.boundedPatch(1, tx => tx.delete(`r:${original.id}`)); await verify();
    const previous = process.env.LLV_STATE_DIR!;
    process.env.LLV_STATE_DIR = path.join(root, `replacement-${generation}`);
    store([lesson]); await verify();
    const replacement = process.env.LLV_STATE_DIR!;
    await shutdownTaskPageWorker();
    // Build a different database with the production writer, then replace the
    // directory while the parent's old source handles are still resident.
    const incoming = replacement + "-incoming";
    process.env.LLV_STATE_DIR = incoming;
    store(["secondary private reason"]);
    fs.renameSync(replacement, replacement + "-retained");
    fs.renameSync(incoming, replacement);
    process.env.LLV_STATE_DIR = replacement;
    const beforeReplacement = worker.mock.calls.length;
    expect(await withoutStoredLessonsAsync(text)).toBe(`${lesson} [learned rule]`);
    expect(worker).toHaveBeenCalledTimes(beforeReplacement + 1);
    expect(await withoutStoredLessonsAsync(text)).toBe(`${lesson} [learned rule]`);
    expect(worker).toHaveBeenCalledTimes(beforeReplacement + 1);
    process.env.LLV_STATE_DIR = previous;
    await verify();
  } finally { worker.mockRestore(); }
}, 30_000);

test("a permanent failure plus a concurrent rule change is never replayed or cached", async () => {
  store([lesson]);
  const { PrivacyWorkError } = await import("./privacyFailure");
  const real = TaskPageWorker.prototype.privacy;
  const worker = spyOn(TaskPageWorker.prototype, "privacy").mockImplementation(async () => {
    store([lesson, "new private wording"]);
    throw new PrivacyWorkError("syntax-error");
  });
  try {
    await expect(withoutStoredLessonsAsync(lesson)).rejects.toMatchObject({ code: "LESSON_PRIVACY_UNAVAILABLE" });
    expect(worker).toHaveBeenCalledTimes(1);
    worker.mockImplementation(real);
    expect(await withoutStoredLessonsAsync(lesson)).toBe(withoutStoredLessonsIn(lesson));
    expect(worker).toHaveBeenCalledTimes(2);
  } finally { worker.mockRestore(); }
});

test("concurrent callers own independent leases and no rejected result enters the cache", async () => {
  store([lesson]);
  const { OperationLease, OperationLeaseExpiredError } = await import("@/lib/operationLease");
  const first = new OperationLease(), second = new OperationLease();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let timer!: ReturnType<typeof setTimeout>;
  const watchdog = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("lease fixture barrier deadline")), 10_000); });
  const bounded = <T>(work: Promise<T>) => Promise.race([work, watchdog]);
  const real = TaskPageWorker.prototype.privacy;
  let calls = 0;
  const worker = spyOn(TaskPageWorker.prototype, "privacy").mockImplementation(async function(this: InstanceType<typeof TaskPageWorker>, request) {
    const firstCall = ++calls === 1;
    const result = await real.call(this, request);
    if (firstCall) { entered(); await held; }
    return result;
  });
  const abandoned = Promise.allSettled([first.run(() => withoutStoredLessonsAsync(lesson))]);
  let peer: Promise<string> | undefined;
  try {
    await bounded(started);
    // Retire this fixture's completed worker before the peer starts. The held
    // result still belongs to the first caller and cannot borrow the peer lease.
    await shutdownTaskPageWorker();
    first.expire();
    peer = second.run(() => withoutStoredLessonsAsync(lesson));
    expect(await bounded(peer)).toBe("[learned rule]");
    release();
    const [outcome] = await bounded(abandoned);
    expect(outcome!.status).toBe("rejected");
    if (outcome!.status === "rejected") expect(outcome.reason).toBeInstanceOf(OperationLeaseExpiredError);
    expect(calls).toBe(2);
    expect(await withoutStoredLessonsAsync(lesson)).toBe("[learned rule]");
    expect(calls).toBe(2);
  } finally {
    clearTimeout(timer); release(); first.expire(); second.expire();
    await shutdownTaskPageWorker();
    await abandoned;
    if (peer) await Promise.allSettled([peer]);
    worker.mockRestore();
  }
}, 30_000);



test("a restarted filter process starts cold and revalidates the same source", async () => {
  store([lesson]);
  const script = `
    import { TaskPageWorker, shutdownTaskPageWorker } from "./src/lib/links/taskPageWorker";
    import { withoutStoredLessonsAsync } from "./src/lib/memory/privacy";
    let calls = 0;
    const real = TaskPageWorker.prototype.privacy;
    TaskPageWorker.prototype.privacy = async function(request) { calls++; return real.call(this, request); };
    const input = ${JSON.stringify(lesson)};
    const first = await withoutStoredLessonsAsync(input);
    const second = await withoutStoredLessonsAsync(input);
    console.log(JSON.stringify({ equal: first === second, privateTextAbsent: !first.includes(input), calls }));
    await shutdownTaskPageWorker();
  `;
  for (let restart = 0; restart < 2; restart++) {
    const child = Bun.spawn([process.execPath, "-e", script], { cwd: process.cwd(), env: { ...process.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [exit, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit, errors).toBe(0);
    expect(JSON.parse(output)).toEqual({ equal: true, privateTextAbsent: true, calls: 1 });
  }
}, 30_000);


test("completed cache evicts the least recently used exact input", async () => {
  store([lesson]);
  const worker = spyOn(TaskPageWorker.prototype, "privacy");
  try {
    for (let index = 0; index < 128; index++) await withoutStoredLessonsAsync(`${lesson} ${index}`);
    await withoutStoredLessonsAsync(`${lesson} 0`);
    expect(worker).toHaveBeenCalledTimes(128);
    await withoutStoredLessonsAsync(`${lesson} 128`);
    await withoutStoredLessonsAsync(`${lesson} 0`);
    expect(worker).toHaveBeenCalledTimes(129);
    await withoutStoredLessonsAsync(`${lesson} 1`);
    expect(worker).toHaveBeenCalledTimes(130);
  } finally { worker.mockRestore(); }
}, 30_000);
