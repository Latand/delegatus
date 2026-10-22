import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { derivedWindows, parseArgs } from "./memory-weekly-metrics";

/* The script end to end, as its own process, on a fixture state directory:
   it reads VACUUM INTO copies, leaves the sources byte for byte unchanged and
   removes only the directory it created. */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "memory-weekly-test-"));
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));
const SCRIPT = path.join(import.meta.dir, "memory-weekly-metrics.ts");
const at = (iso: string, hours: number) => new Date(Date.parse(iso) + hours * 3600_000).toISOString();
const PRESS = "2026-10-08T00:00:00.000Z", DRAINED = "2026-10-09T00:00:00.000Z";

function lane(id: string, start: string, verdict: string) {
  const role = (roleId: string) => ({ roleId, engine: "codex", model: "m", promptScaffold: `${roleId} scaffold` });
  return { id, project: "A", stages: [{ id: "build", kind: "run" }, { id: "review", kind: "run", onFail: { to: "build", maxRounds: 1 } }],
    runs: [{ stageId: "build", attempts: [{ n: 1, startedAt: start, completedAt: at(start, 1), sessionId: `s-${id}`, effectiveRole: role("builder"), activatedBy: null, verdict: { status: "pass" } }] },
      { stageId: "review", attempts: [{ n: 1, startedAt: at(start, 1), completedAt: at(start, 2), effectiveRole: role("reviewer"), activatedBy: { edge: "pass" }, report: { at: at(start, 2), verdict: { status: verdict } } }] }] };
}

function fixture(name: string, options: { engineMemoryInFirstWeek: boolean }) {
  const dir = path.join(sandbox, name);
  fs.mkdirSync(path.join(dir, "role-memory"), { recursive: true });
  const db = new Database(path.join(dir, "state.sqlite"), { create: true });
  db.exec("CREATE TABLE state_rows (collection TEXT NOT NULL, row_key TEXT NOT NULL, value_json TEXT NOT NULL, row_order INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(collection, row_key))");
  const put = db.query("INSERT INTO state_rows(collection,row_key,value_json) VALUES (?,?,?)");
  const pipelines = [
    ...Array.from({ length: 10 }, (_, i) => lane(`base-${i}`, at("2026-10-01T00:00:00.000Z", i * 10), i < 2 ? "fail" : "pass")),
    ...Array.from({ length: 10 }, (_, i) => lane(`week1-${i}`, at(DRAINED, i * 10), i < 9 ? "fail" : "pass")),
    ...Array.from({ length: 10 }, (_, i) => lane(`week2-${i}`, at(DRAINED, 168 + i * 10), i < 4 ? "fail" : "pass")),
  ];
  for (const pipeline of pipelines) put.run(pipeline.id.startsWith("base") ? "pipelines_archive" : "pipelines", pipeline.id, JSON.stringify(pipeline));
  put.run("role_memory", "q:1", JSON.stringify({ kind: "request", pipelineId: "week2-0", stageId: "build", attempt: 1, at: at(DRAINED, 170), ruleIds: [], none: "covered" }));
  db.close();
  const ledger = new Database(path.join(dir, "role-memory", "delivery.sqlite"), { create: true });
  ledger.exec("CREATE TABLE deliveries (sequence INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL)");
  ledger.query("INSERT INTO deliveries(body) VALUES (?)").run(JSON.stringify({ at: at(DRAINED, 3), engineMemory: options.engineMemoryInFirstWeek ? [{ kind: "codex-summary", hash: "h", bytes: 1, loadedBytes: 1 }] : [] }));
  ledger.close();
  fs.writeFileSync(path.join(dir, "memory-source.json"), JSON.stringify({ schemaVersion: 1, source: "delegatus", phase: "active", changedAt: PRESS, importId: "i", importStartedAt: PRESS, flippedAt: at(PRESS, 12), drainedAt: DRAINED }));
  return dir;
}

const digest = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

async function runScript(args: string[]) {
  const tmp = fs.mkdtempSync(path.join(sandbox, "child-tmp-"));
  const child = Bun.spawn([process.execPath, SCRIPT, ...args], { env: { PATH: process.env.PATH ?? "", HOME: sandbox, TMPDIR: tmp }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code, leftovers: fs.readdirSync(tmp) };
}

test("the script derives the windows from the switch, reads copies and decides on the valid week only", async () => {
  const dir = fixture("derived", { engineMemoryInFirstWeek: true });
  const before = ["state.sqlite", "role-memory/delivery.sqlite"].map(file => digest(path.join(dir, file)));
  const { stdout, stderr, code, leftovers } = await runScript(["--state-dir", dir, "--now", at(DRAINED, 15 * 24)]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(leftovers).toEqual([]);
  expect(["state.sqlite", "role-memory/delivery.sqlite"].map(file => digest(path.join(dir, file)))).toEqual(before);
  const report = JSON.parse(stdout);
  expect(report.baseline.window).toMatchObject({ from: "2026-10-01T00:00:00.000Z", to: PRESS });
  expect(report.baseline.failedReview).toMatchObject({ failed: 2, reviewed: 10 });
  expect(report.windows.map((window: { window: { from: string } }) => window.window.from)).toEqual([DRAINED, at(DRAINED, 168)]);
  expect(report.windows[0]).toMatchObject({ valid: false, invalidBecause: ["engine-memory-loaded"], failedReview: { failed: 9, reviewed: 10 } });
  expect(report.windows[1]).toMatchObject({ valid: true, failedReview: { failed: 4, reviewed: 10 }, lessons: { stage: { none: 1 } } });
  // Counted as valid, week 1's 9 of 10 would have been a clear rise.
  expect(report.decision).toMatchObject({ outcome: "delegatus", usedWindows: [1], invalidWindows: [{ index: 0 }] });
  expect(stdout).not.toContain("builder scaffold");
});

test("explicit windows on a fixture with no engine memory count the first week", async () => {
  const dir = fixture("explicit", { engineMemoryInFirstWeek: false });
  const { stdout, code } = await runScript(["--state-dir", dir, "--baseline", `2026-10-01T00:00:00Z/${PRESS}`, "--window", `${DRAINED}/${at(DRAINED, 168)}`]);
  expect(code).toBe(0);
  const report = JSON.parse(stdout);
  expect(report.windows).toHaveLength(1);
  expect(report.windows[0].valid).toBe(true);
  // A clear rise with no corroborating metric asks for one more valid week.
  expect(report.decision).toMatchObject({ outcome: "extend", usedWindows: [0] });
});

test("bad arguments exit 2 with a reason and leave no copy behind", async () => {
  const dir = fixture("refused", { engineMemoryInFirstWeek: false });
  for (const args of [[], ["--state-dir", dir, "--window", "x/y"], ["--state-dir", dir, "--baseline", `${PRESS}/${DRAINED}`], ["--state-dir", dir, "--bogus"]]) {
    const { code, stderr, leftovers } = await runScript(args);
    expect(code).toBe(2);
    expect(stderr).toStartWith("memory-weekly-metrics: ");
    expect(leftovers).toEqual([]);
  }
  expect(() => parseArgs(["--state-dir", dir, "--baseline", `${DRAINED}/${PRESS}`, "--window", `${DRAINED}/${at(DRAINED, 1)}`])).toThrow(/FROM before TO/);
});

test("window derivation counts only complete trial weeks", () => {
  expect(derivedWindows({ importStartedAt: PRESS, drainedAt: DRAINED }, at(DRAINED, 167)).windows).toEqual([]);
  expect(derivedWindows({ importStartedAt: PRESS, drainedAt: DRAINED }, at(DRAINED, 168)).windows).toHaveLength(1);
  expect(derivedWindows({ importStartedAt: PRESS }, at(DRAINED, 500)).windows).toEqual([]);
  expect(() => derivedWindows(null, PRESS)).toThrow(/no switch press/);
});
