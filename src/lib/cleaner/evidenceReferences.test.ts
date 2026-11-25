import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { statePath } from "@/lib/configDir";
import { saveTasks } from "@/lib/tasks/store";
import { createTask } from "@/lib/tasks/commands";
import type { BoardTask } from "@/lib/tasks/types";
import { TemporaryDataStore, type TemporaryDataCandidate } from "@/lib/runtime/temporaryDataStore";
import { sweepTemporaryData } from "@/lib/runtime/temporaryDataRetention";
import { openTaskReferencesEvidence } from "./evidenceReferences";

const roots: string[] = [];
const originalState = process.env.LLV_STATE_DIR;
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  if (originalState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = originalState;
});

test("the evidence sweep keeps a task's aliased file URL and reclaims adjacent evidence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cleaner-evidence-alias-")); roots.push(root);
  process.env.LLV_STATE_DIR = path.join(root, "state");
  const scope = statePath("evidence"), linked = path.join(scope, "linked-capture"), adjacent = path.join(scope, "adjacent-capture");
  for (const directory of [linked, adjacent]) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "screen.png"), directory);
  }
  const alias = path.join(root, "evidence-alias"); fs.symlinkSync(linked, alias, "dir");
  const made = createTask([], { project: "repo-evidence-alias-fixture", text: `[capture](${pathToFileURL(path.join(alias, "screen.png")).href})`, placement: "unplaced" });
  expect(made.ok).toBeTrue();
  if (!made.ok) return;
  const task: BoardTask = made.task;
  saveTasks([task], statePath("tasks.json"));
  const candidate = (directory: string): TemporaryDataCandidate => {
    const stat = fs.lstatSync(directory);
    return { directory, scope, kind: "lane-evidence", owner: "lane-fixture", identity: `${stat.dev}:${stat.ino}`,
      adoptedAt: 0, checkedAt: 0, bytes: 1, reason: "fixture" };
  };
  const authority = { expiresAt: Date.now() - 1, reason: "closed", revision: "fixture", current: () => true, pipelineIds: [] };
  expect(openTaskReferencesEvidence(candidate(linked), authority)).toBeTrue();
  expect(openTaskReferencesEvidence(candidate(adjacent), authority)).toBeFalse();
  const store = new TemporaryDataStore(path.join(root, "retention.sqlite"));
  for (const directory of [linked, adjacent]) store.register({ ...candidate(directory), adoptedAt: Date.now() - 8 * 86400000,
    checkedAt: 0, reason: "expired" });
  const timestamp = new Date(Date.now() - 8 * 86400000);
  for (const directory of [linked, adjacent]) {
    fs.utimesSync(directory, timestamp, timestamp);
    fs.utimesSync(path.join(directory, "screen.png"), timestamp, timestamp);
  }
  const journal: string[] = [];
  const passId = createHash("sha256").update("evidence alias test pass").digest("hex").slice(0, 36);
  const result = await sweepTemporaryData(store, { now: Date.now, mounts: () => [], mode: "on",
    claim: async () => () => {}, authority: async () => authority, references: async () => true,
    taskReferences: openTaskReferencesEvidence,
    cleaner: { id: passId, allowed: () => true, journal: phase => journal.push(phase), processClear: () => true } });
  store.close();
  expect(result.removed).toBe(1);
  expect(fs.readFileSync(path.join(alias, "screen.png"), "utf8")).toBe(linked);
  expect(fs.existsSync(adjacent)).toBeFalse();
  expect(journal).toEqual(["intent", "removed"]);
});
