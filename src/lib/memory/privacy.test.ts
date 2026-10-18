import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import { Database } from "bun:sqlite";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "privacy-worker-"));
process.env.LLV_STATE_DIR = path.join(root, "initial");
const { roleMemoryCollection, storedLessonTexts, withoutStoredLessonsIn } = await import("./roleStore");
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
    await expect(worker.privacy({ kind: "filter", value: lesson })).rejects.toMatchObject({ code: "LESSON_PRIVACY_UNAVAILABLE" });
    expect((await outcomes).every(result => result.status === "rejected")).toBe(true);
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

test("linked agent titles are filtered before truncation and republished after a lesson revision", async () => {
  const { AgentFeed, agentPart, decodeCursor, dropAgents } = await import("@/lib/links/agentFeed");
  const { sharedLinkState } = await import("@/lib/links/runtimeState");
  const project = `repo-${"a".repeat(32)}`, id = "privacy-agent-fixture";
  const title = "A long fixtureword title preserves every original receipt until its operation completes " + "with the complete documented context ".repeat(6);
  const files = ["fixture", "unbound"].map(name => ({ path: `/sandbox/${name}.jsonl`, conversationId: `conversation_${name}`, project, engine: "claude", proc: "running", activity: "live", mtime: 1, lastAgentWorkAt: 1 }));
  let tasks = [{ id: "fixture-task", project, chosen: true, text: title, assignments: [{ path: files[0]!.path }] }];
  const feed = new AgentFeed(id, () => files as never, () => tasks as never, () => [], () => () => false,
    { snapshot: () => ({ conversations: {}, memberships: {}, lineageEdges: {} }), seats: () => [], canonical: p => p });
  sharedLinkState("agentFeed.feeds", () => new Map<string, InstanceType<typeof AgentFeed>>()).set(id, feed);
  try {
    const first = await agentPart(id, null, new Set([project]));
    expect(first.rows?.find(row => "task" in row && row.task === "fixture-task")).toMatchObject({ t: title.slice(0, 120), e: "claude" });
    store([title, "claude"]);
    const changed = await agentPart(id, decodeCursor(first.cursor)!, new Set([project]));
    expect(changed.rows?.find(row => "task" in row && row.task === "fixture-task")).toMatchObject({ t: withoutStoredLessonsIn(title).slice(0, 120), e: "claude" });
    expect(changed.rows?.find(row => "t" in row && !("task" in row))).toMatchObject({ t: "claude agent", e: "claude" });
    expect(feed.page(null, new Set([project])).rows?.every(row => !("t" in row) || row.t.length <= 120)).toBe(true);
    const retitled = `${title}Additional receipt context`;
    tasks = [{ ...tasks[0]!, text: retitled }];
    const edited = await agentPart(id, decodeCursor(changed.cursor)!, new Set([project]));
    expect(edited.rows?.find(row => "task" in row && row.task === "fixture-task")).toMatchObject({ t: withoutStoredLessonsIn(retitled).slice(0, 120) });
    const { assertTaskExportCurrent } = await import("@/lib/links/taskExportPrivacy");
    store([title, "claude", lesson]);
    expect(() => assertTaskExportCurrent({ push: { agents: changed } })).toThrow("privacy changed");
  } finally { dropAgents(id); }
}, 30_000);
