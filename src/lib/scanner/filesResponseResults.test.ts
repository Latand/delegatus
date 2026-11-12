import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";

import { runTempSweep } from "@/lib/tempSweep";
import {
  FILES_RESPONSE_RESULT_MIN_AGE_MS,
  filesResponseSweepStatus,
  sweepFilesResponseResults,
  type WriterProbe,
} from "./filesResponseResults";

const MINUTE = 60_000;
const made: string[] = [];
afterEach(() => { for (const directory of made.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function directory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-files-response-results-"));
  made.push(root);
  return root;
}
const uuid = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const SCOPE = "a".repeat(40);
/** Writers 100 and 200 are alive since long before the files; every other pid is gone. */
function probe(overrides: Partial<WriterProbe> = {}): WriterProbe {
  return { alive: pid => pid === 100 || pid === 200, startedAt: () => 0, bootAt: () => null, ...overrides };
}
function write(root: string, name: string, body = "{}") {
  fs.writeFileSync(path.join(root, name), body);
  return path.join(root, name);
}
const later = (ms: number) => () => Date.now() + ms;
const OLD = FILES_RESPONSE_RESULT_MIN_AGE_MS + 10 * MINUTE;

test("an old result whose writer exited goes; young, live-writer, delta-base and unknown files stay", () => {
  const root = directory();
  const gone = [`300-${uuid(1)}.json`, `300-${uuid(2)}.delta.json`, `301-${uuid(3)}.base.json`, `seat-agenda-${uuid(4)}.json`,
    `delta-base-${SCOPE}.json.302.tmp`];
  const stay = [`100-${uuid(5)}.json`, `200-${uuid(6)}.base.json`, `delta-base-${SCOPE}.json`, `notes.json`, `300-not-a-uuid.json`];
  for (const name of [...gone, ...stay]) write(root, name, "x".repeat(10));

  const young = sweepFilesResponseResults({ mode: "on", directory: root, probe: probe(), now: later(FILES_RESPONSE_RESULT_MIN_AGE_MS - 10 * MINUTE) });
  expect(young.removed).toEqual([]);
  expect(young.kept.young).toBe(gone.length + 2);
  expect(fs.readdirSync(root).sort()).toEqual([...gone, ...stay].sort());

  const report = sweepFilesResponseResults({ mode: "on", directory: root, probe: probe(), now: later(OLD) });
  expect(report.removed.map(row => [row.name, row.reason]).sort()).toEqual(gone.map(name =>
    [name, name.startsWith("seat-agenda-") ? "request-ended" : "writer-exited"]).sort());
  expect(report.removedBytes).toBe(10 * gone.length);
  expect(report.kept).toMatchObject({ "writer-alive": 2, "delta-base": 1, unrecognized: 2, young: 0 });
  expect(report.errors).toEqual([]);
  expect(fs.readdirSync(root).sort()).toEqual([...stay].sort());
});

test("a reused writer pid and a file from before this boot prove the writer gone", () => {
  const root = directory();
  const name = `100-${uuid(1)}.json`;
  write(root, name);
  const now = later(OLD);
  // The process now at pid 100 started after the file was written.
  const reused = sweepFilesResponseResults({ mode: "dry-run", directory: root, now, probe: probe({ startedAt: () => Date.now() + MINUTE }) });
  expect(reused.removed.map(row => row.reason)).toEqual(["writer-exited"]);
  // Started a moment before the write, within the clock slack: kept.
  expect(sweepFilesResponseResults({ mode: "dry-run", directory: root, now, probe: probe({ startedAt: () => Date.now() + 1_000 }) }).kept["writer-alive"]).toBe(1);
  const rebooted = sweepFilesResponseResults({ mode: "dry-run", directory: root, now, probe: probe({ bootAt: () => Date.now() + MINUTE }) });
  expect(rebooted.removed.map(row => row.reason)).toEqual(["writer-previous-boot"]);
  // Dry-run reports and removes nothing.
  expect(fs.existsSync(path.join(root, name))).toBeTrue();
});

test("symlinks, directories and other users' files are never followed or removed", () => {
  const root = directory(); const outside = directory();
  const target = write(outside, "precious.json", "keep");
  fs.symlinkSync(target, path.join(root, `300-${uuid(1)}.json`));
  fs.mkdirSync(path.join(root, `300-${uuid(2)}.json`));
  write(root, `300-${uuid(3)}.json`);
  const report = sweepFilesResponseResults({ mode: "on", directory: root, probe: probe(), now: later(OLD), uid: (process.getuid?.() ?? 0) + 1 });
  // The results directory itself belongs to someone else here: nothing is touched.
  expect(report.removed).toEqual([]);
  expect(report.errors).toHaveLength(1);
  const own = sweepFilesResponseResults({ mode: "on", directory: root, probe: probe(), now: later(OLD) });
  expect(own.removed.map(row => row.name)).toEqual([`300-${uuid(3)}.json`]);
  expect(own.kept["not-a-file"]).toBe(2);
  expect(fs.readFileSync(target, "utf8")).toBe("keep");
  expect(fs.lstatSync(path.join(root, `300-${uuid(1)}.json`)).isSymbolicLink()).toBeTrue();
});

test("a results directory that is a symlink is refused, and a missing one is an empty pass", () => {
  const real = directory(); const parent = directory();
  write(real, `300-${uuid(1)}.json`);
  fs.symlinkSync(real, path.join(parent, "files-response-results"));
  const linked = sweepFilesResponseResults({ mode: "on", directory: path.join(parent, "files-response-results"), probe: probe(), now: later(OLD) });
  expect(linked.removed).toEqual([]);
  expect(linked.errors).toHaveLength(1);
  expect(fs.readdirSync(real)).toHaveLength(1);
  const missing = sweepFilesResponseResults({ mode: "on", directory: path.join(parent, "absent"), probe: probe(), now: later(OLD) });
  expect(missing).toMatchObject({ removed: [], errors: [] });
});

test("a decision is made again right before the unlink: a writer that comes back or a rewritten file keeps it", () => {
  const root = directory();
  const revived = `300-${uuid(1)}.json`, rewritten = `301-${uuid(2)}.json`;
  write(root, revived); write(root, rewritten);
  const calls = new Map<number, number>();
  const report = sweepFilesResponseResults({ mode: "on", directory: root, now: later(OLD), probe: probe({
    alive: pid => {
      const seen = (calls.get(pid) ?? 0) + 1; calls.set(pid, seen);
      if (pid === 301 && seen === 1) fs.appendFileSync(path.join(root, rewritten), "more");
      return pid === 300 && seen > 1;
    },
  }) });
  expect(report.removed).toEqual([]);
  expect(report.kept.changed).toBe(2);
  expect(fs.readdirSync(root).sort()).toEqual([revived, rewritten].sort());
});

test.skipIf(process.platform !== "linux")("the hourly temp sweep removes orphaned results and writes its own report", async () => {
  const state = directory();
  const previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = state;
  try {
    const results = path.join(state, "files-response-results");
    fs.mkdirSync(results, { mode: 0o700 });
    // pid_max never exceeds 4194304, so no process can hold this pid.
    const orphan = `4194999-${uuid(1)}.json`, live = `${process.pid}-${uuid(2)}.json`;
    write(results, orphan, "x".repeat(64)); write(results, live);
    await runTempSweep({ NODE_ENV: "test", LLV_TEMP_SWEEP_MAX_AGE_HOURS: "24" }, { roots: [], now: later(OLD) }).catch(() => null);
    expect(fs.readdirSync(results)).toEqual([live]);
    const report = JSON.parse(fs.readFileSync(path.join(state, "files-response-sweep-report.json"), "utf8"));
    expect(report.removed).toMatchObject([{ name: orphan, reason: "writer-exited", bytes: 64 }]);
    expect(filesResponseSweepStatus()).toMatchObject({ mode: "on", removed: 1, removedBytes: 64, kept: { "writer-alive": 1 } });
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
  }
});
