import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mutateTasks, taskFeedSource } from "@/lib/tasks/store";
import type { BoardTask } from "@/lib/tasks/types";
import { statePath } from "@/lib/configDir";
import { isPosition, PAGE_ROWS, readLogPage, readScanPage } from "./taskFeed";
import { decodeWireRow, encodeTask, MAX_WIRE_ROW_BYTES } from "./taskWire";
import { installPrefix, nextStamp } from "./stamp";
import { tombstoneCollection } from "./tombstones";

const original = process.env.LLV_STATE_DIR;
const roots: string[] = [];
const at = "2026-10-17T00:00:00.000Z";
const project = `repo-${"a".repeat(32)}`;
const selfId = ["10000000", "0000", "4000", "8000", "000000000001"].join("-");
const self = { id: selfId, prefix: installPrefix(selfId) };
const legacyId = `startup-quarantine-${"b".repeat(32)}`;
const validId = ["40000000", "0000", "4000", "8000", "000000000001"].join("-");
const withheldId = ["50000000", "0000", "4000", "8000", "000000000001"].join("-");
function task(id: string, extra: Partial<BoardTask> = {}): BoardTask {
  return { id, project, text: "Fixture task", status: "inbox", placement: "unplaced", assignments: [], createdAt: at, updatedAt: at, ...extra };
}
function fixture(tasks: BoardTask[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-feed-schema-"));
  roots.push(root);
  process.env.LLV_STATE_DIR = root;
  setSystemTime(new Date(at));
  const filePath = path.join(root, "tasks.json");
  mutateTasks(() => ({ tasks, result: null }), filePath);
  return { root, filePath, filter: { self, projects: new Set([project]), skipPrefix: null, filePath, includeBoard: false, includePrototypeReview: false, peerTaskWireVersion: 0 } };
}
function diagnostics() {
  return fs.readdirSync(statePath("task-export-rejections")).map(name => JSON.parse(fs.readFileSync(path.join(statePath("task-export-rejections"), name), "utf8")));
}
afterEach(() => {
  if (original === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = original;
  setSystemTime();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test("scan and log skip the legacy quarantine stub and preserve valid withheld rows", () => {
  const privateText = "Private oversized fixture text";
  const f = fixture([task(legacyId, { text: privateText }), task(validId), task(withheldId, { details: privateText.repeat(Math.ceil(MAX_WIRE_ROW_BYTES / privateText.length) + 1) })]);
  const warning = spyOn(console, "warn");
  try {
    const scan = readScanPage("", f.filter);
    const log = readLogPage([0], f.filter);
    expect(log.kind).toBe("page");
    if (log.kind !== "page") throw new Error("expected a log page");
    for (const page of [scan, log]) {
      expect(page.rows.map(row => decodeWireRow(JSON.parse(JSON.stringify(row))))).toEqual(page.rows);
      expect(page.rows.map(row => row.id).sort()).toEqual([validId, withheldId]);
      expect(page.withheld).toEqual([withheldId]);
      expect(JSON.stringify(page.rows)).not.toContain(privateText);
      expect(page.rows.find(row => row.id === withheldId)).toEqual(encodeTask(task(withheldId, { details: privateText.repeat(Math.ceil(MAX_WIRE_ROW_BYTES / privateText.length) + 1) }), self).row);
    }
    readScanPage("", f.filter);
    expect(diagnostics()).toEqual([{ key: `t:${legacyId}`, field: "row" }]);
    expect(warning.mock.calls).toEqual([["[links] skipped malformed task export row", { key: `t:${legacyId}`, field: "row" }]]);
    expect(readLogPage(log.cursor, f.filter)).toMatchObject({ kind: "page", rows: [], more: false });
  } finally { warning.mockRestore(); }
});

test("scan and log validate tombstones too and advance past rejected deletions", () => {
  const f = fixture([task(legacyId), task(validId)]);
  const source = taskFeedSource(f.filePath)!;
  const after = source.revision();
  mutateTasks(() => ({ tasks: [], result: null }), f.filePath);
  const tombstones = tombstoneCollection(source.database, true)!;
  const gone = nextStamp(null, Date.parse(at), self.prefix);
  tombstones.boundedPatch(2, tx => {
    for (const id of [legacyId, validId]) tx.put({ id, project, gone, o: self.prefix });
  });
  const scan = readScanPage("", f.filter);
  const log = readLogPage([after], f.filter);
  expect(log.kind).toBe("page");
  if (log.kind !== "page") throw new Error("expected a log page");
  for (const page of [scan, log]) {
    expect(page.rows).toEqual([{ id: validId, project, gone }]);
    expect(page.rows.map(decodeWireRow)).toEqual(page.rows);
  }
  expect(scan.next).toBeNull();
  expect(log.more).toBe(false);
  expect(diagnostics()).toEqual([{ key: `g:${legacyId}`, field: "row" }]);
});

test("rejection logging survives real process restarts without repeating or leaking task text", async () => {
  const f = fixture([task(legacyId, { text: "Private quarantine fixture" })]);
  const modulePath = path.join(import.meta.dir, "taskFeed.ts");
  const program = `const { readScanPage } = await import(${JSON.stringify(modulePath)});
    const filter = ${JSON.stringify({ ...f.filter, projects: [project] })};
    filter.projects = new Set(filter.projects);
    console.log(JSON.stringify(readScanPage("", filter)));`;
  let first: string | undefined;
  for (let index = 0; index < 2; index++) {
    const child = Bun.spawn([process.execPath, "-e", program], { cwd: process.cwd(), env: { ...process.env, LLV_STATE_OWNER: undefined }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr).toBe(0);
    expect(stderr.includes("skipped malformed task export row")).toBe(index === 0);
    expect(stderr).not.toContain("Private quarantine fixture");
    expect(JSON.parse(stdout)).toMatchObject({ rows: [], next: null });
    expect(diagnostics()).toEqual([{ key: `t:${legacyId}`, field: "row" }]);
    const record = path.join(statePath("task-export-rejections"), fs.readdirSync(statePath("task-export-rejections"))[0]!);
    const stat = fs.statSync(record, { bigint: true });
    const fingerprint = `${stat.ino}:${stat.mtimeNs}:${createHash("sha256").update(fs.readFileSync(record)).digest("hex")}`;
    if (first) expect(fingerprint).toEqual(first); else first = fingerprint;
  }
});

test("failure to record a rejection refuses export without sending the invalid row", () => {
  const f = fixture([task(legacyId)]);
  fs.writeFileSync(statePath("task-export-rejections"), "sentinel");
  expect(() => readScanPage("", f.filter)).toThrow();
  expect(fs.readFileSync(statePath("task-export-rejections"), "utf8")).toBe("sentinel");
});

test("a rejected id beside a full page cannot become an older peer's scan cursor", () => {
  const tasks = Array.from({ length: PAGE_ROWS + 1 }, (_, index) => task(["40000000", "0000", "4000", "8000", String(index).padStart(12, "0")].join("-")));
  const last = tasks[PAGE_ROWS - 1]!.id;
  const f = fixture([...tasks, task(`${last}x`)]);
  const first = readScanPage("", f.filter);
  expect(first.rows).toHaveLength(PAGE_ROWS);
  expect(first.next).toBe(`t:${last}`);
  const second = readScanPage(first.next!, f.filter);
  expect(second.rows.map(decodeWireRow).map(row => row.id)).toEqual([tasks[PAGE_ROWS]!.id]);
  expect(second.next).toBeNull();
  expect(diagnostics()).toEqual([{ key: `t:${last}x`, field: "row" }]);
});

test("a rejected long id beside a full page cannot become a malformed log cursor", () => {
  const tasks = Array.from({ length: PAGE_ROWS + 1 }, (_, index) => task(["40000000", "0000", "4000", "8000", String(index).padStart(12, "0")].join("-")));
  const last = tasks[PAGE_ROWS - 1]!.id;
  const f = fixture([...tasks, task(`${last}${"x".repeat(80)}`)]);
  const first = readLogPage([0], f.filter);
  if (first.kind !== "page") throw new Error("expected a log page");
  expect(first.rows).toHaveLength(PAGE_ROWS);
  expect(first.more).toBe(true);
  expect(isPosition(first.cursor)).toBe(true);
  expect(first.cursor[1]).toBe(`t:${last}`);
  const second = readLogPage(first.cursor, f.filter);
  if (second.kind !== "page") throw new Error("expected a log page");
  expect(second.rows.map(decodeWireRow).map(row => row.id)).toEqual([tasks[PAGE_ROWS]!.id]);
  expect(second.more).toBe(false);
});

test("scan checkpoints an all-rejected task window and reaches the next valid task", async () => {
  const invalid = Array.from({ length: 2_048 }, (_, index) => task(`0-invalid-${String(index).padStart(5, "0")}`));
  const expected = task(validId);
  const f = fixture([...invalid, expected]);
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const first = readScanPage("", f.filter);
    expect(first.rows).toEqual([]);
    expect(first.next).toMatch(/^t:[0-9a-f-]{36}$/);
    const modulePath = path.join(import.meta.dir, "taskFeed.ts");
    const program = `const { readScanPage } = await import(${JSON.stringify(modulePath)});
      const filter = ${JSON.stringify({ ...f.filter, projects: [project] })};
      filter.projects = new Set(filter.projects);
      console.log(JSON.stringify(readScanPage(${JSON.stringify(first.next)}, filter)));`;
    const child = Bun.spawn([process.execPath, "-e", program], { cwd: process.cwd(), env: { ...process.env, LLV_STATE_OWNER: undefined }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr).toBe(0);
    const second = JSON.parse(stdout) as ReturnType<typeof readScanPage>;
    expect(second.rows.map(decodeWireRow).map(row => row.id)).toEqual([expected.id]);
    expect(second.next).toBeNull();
    expect(warning).toHaveBeenCalledTimes(2_048);
  } finally { warning.mockRestore(); }
});

test("log checkpoints an all-rejected long-key window and reaches the next valid task", () => {
  const invalid = Array.from({ length: 4_000 }, (_, index) => task(`0-invalid-${String(index).padStart(5, "0")}-${"x".repeat(70)}`));
  const expected = task(validId);
  const f = fixture([...invalid, expected]);
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const first = readLogPage([0], f.filter);
    if (first.kind !== "page") throw new Error("expected a log page");
    expect(first.rows).toEqual([]);
    expect(first.more).toBe(true);
    expect(isPosition(first.cursor)).toBe(true);
    expect(first.cursor[1]).toMatch(/^x:[0-9a-f-]{36}$/);
    const second = readLogPage(first.cursor, f.filter);
    if (second.kind !== "page") throw new Error("expected a log page");
    expect(second.rows.map(decodeWireRow).map(row => row.id)).toEqual([expected.id]);
    expect(second.more).toBe(false);
    expect(warning).toHaveBeenCalledTimes(4_000);
    setSystemTime(new Date(Date.parse(at) + 31 * 24 * 60 * 60 * 1_000));
    expect(readLogPage(first.cursor, f.filter)).toEqual({ kind: "resync" });
  } finally { warning.mockRestore(); }
});

test("scan checkpoints rejected tombstones at the work limit", () => {
  const invalid = Array.from({ length: 2_048 }, (_, index) => `0-invalid-${String(index).padStart(5, "0")}`);
  const f = fixture([...invalid, validId].map(id => task(id)));
  const source = taskFeedSource(f.filePath)!;
  mutateTasks(() => ({ tasks: [], result: null }), f.filePath);
  const tombstones = tombstoneCollection(source.database, true)!;
  const gone = nextStamp(null, Date.parse(at), self.prefix);
  tombstones.boundedPatch(invalid.length + 1, tx => {
    for (const id of [...invalid, validId]) tx.put({ id, project, gone, o: self.prefix });
  });
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const first = readScanPage("g:", f.filter);
    expect(first.rows).toEqual([]);
    expect(first.next).toMatch(/^g:[0-9a-f-]{36}$/);
    const second = readScanPage(first.next!, f.filter);
    expect(second.rows).toEqual([{ id: validId, project, gone }]);
    expect(second.next).toBeNull();
    expect(warning).toHaveBeenCalledTimes(2_048);
  } finally { warning.mockRestore(); }
});

test("log checkpoints an all-rejected tombstone window and reaches the next valid deletion", () => {
  const invalid = Array.from({ length: 4_000 }, (_, index) => `0-invalid-${String(index).padStart(5, "0")}-${"x".repeat(70)}`);
  const f = fixture([...invalid, validId].map(id => task(id)));
  const source = taskFeedSource(f.filePath)!;
  const start = source.revision();
  mutateTasks(() => ({ tasks: [], result: null }), f.filePath);
  const gone = nextStamp(null, Date.parse(at), self.prefix);
  tombstoneCollection(source.database, true)!.boundedPatch(invalid.length + 1, tx => {
    for (const id of [...invalid, validId]) tx.put({ id, project, gone, o: self.prefix });
  });
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const first = readLogPage([start], f.filter);
    if (first.kind !== "page") throw new Error("expected a log page");
    expect(first.rows).toEqual([]);
    expect(first.more).toBe(true);
    expect(first.cursor[1]).toMatch(/^x:[0-9a-f-]{36}$/);
    const second = readLogPage(first.cursor, f.filter);
    if (second.kind !== "page") throw new Error("expected a log page");
    expect(second.rows).toEqual([{ id: validId, project, gone }]);
    expect(second.more).toBe(false);
    expect(warning).toHaveBeenCalledTimes(4_000);
  } finally { warning.mockRestore(); }
});

test.each(["task", "tombstone"] as const)("expired %s scan checkpoints restart and return the later valid row", kind => {
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const invalid = Array.from({ length: 2_048 }, (_, index) => `!invalid-${String(index).padStart(5, "0")}`);
    const expected = task("00000000-0000-0000-0000-000000000000");
    const f = fixture(kind === "task" ? [...invalid, expected.id].map(id => task(id)) : []);
    if (kind === "tombstone") {
      const source = taskFeedSource(f.filePath)!;
      const gone = nextStamp(null, Date.parse(at), self.prefix);
      tombstoneCollection(source.database, true)!.boundedPatch(invalid.length + 1, tx => {
        for (const id of [...invalid, expected.id]) tx.put({ id, project, gone, o: self.prefix });
      });
    }

    const first = readScanPage(kind === "task" ? "" : "g:", f.filter);
    expect(first.rows).toEqual([]);
    expect(first.next).toMatch(new RegExp(`^${kind === "task" ? "t" : "g"}:[0-9a-f-]{36}$`));

    setSystemTime(new Date(Date.parse(at) + 31 * 24 * 60 * 60 * 1_000));
    const received: string[] = [];
    let cursor: string | null = first.next;
    while (cursor) {
      const resumed = readScanPage(cursor, f.filter);
      received.push(...resumed.rows.map(decodeWireRow).map(row => row.id));
      cursor = resumed.next;
    }
    expect(received).toEqual([expected.id]);
  } finally { warning.mockRestore(); }
});
