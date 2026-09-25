import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { normalizeRegistry } from "@/lib/agent/registry";
import { SqliteAgentRegistryStore } from "@/lib/agent/sqliteRegistryStore";
import { projectRetirementStatus, readRetirementStatus, RETIREMENT_MAX_PAGES, RETIREMENT_SCAN_LIMIT } from "./structuredHostRetirementStatus";
import type { StructuredHostRetirementReport } from "./structuredHostRetirement";

const generation = "00000000-0000-0000-0000-000000000001";
const replacement = "00000000-0000-0000-0000-000000000002";
const key = `codex:${generation}`;
const conversationId = "conversation_retirement_fixture";
const capturedAt = "2026-07-01T12:00:00.000Z";
const now = () => Date.parse("2026-07-01T12:01:00.000Z");
const roots: string[] = [];
const oldState = process.env.LLV_STATE_DIR;
const capability = "r".repeat(43);
const authentication = { launchId: "retirement-reader", capability };
afterEach(() => {
  if (oldState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = oldState;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function report(): StructuredHostRetirementReport {
  return { version: 1, startedAt: "2026-07-01T11:59:59.000Z", finishedAt: capturedAt, idleHours: 6,
    evaluated: 1, deferred: 0, standDown: null, retired: [], failed: [],
    refused: [{ key, conversationId, clause: "events-flushed", reason: "event tail unavailable", undetermined: true }],
    refusedByFlag: {}, reclaimed: { rssBytes: 0, swapBytes: 0, processes: 0 } };
}

function registryFixture(project = "project-a") {
  return normalizeRegistry({ version: 2, receipts: {},
    entries: { [key]: { key: { engine: "codex", sessionId: generation }, status: "idle",
      structuredHost: { process: { pid: 123, startIdentity: "123:456", bootEpoch: "boot-fixture" } } } },
    conversations: { [conversationId]: { id: conversationId, engine: "codex",
      projectOwnership: { project, source: "operator", setAt: capturedAt, operationId: "fixture-project" },
      generations: [{ id: generation, path: `/sessions/${generation}.jsonl`, accountId: "default" },
        { id: replacement, path: `/sessions/${replacement}.jsonl`, accountId: "default" }] } } });
}

function sources(value = report(), project = "project-a") {
  const file = registryFixture(project);
  return { readReport: () => Buffer.from(JSON.stringify(value)), now,
    subject: () => ({ conversation: file.conversations[conversationId]!, entry: file.entries[key]! }) };
}

test("the real sweep shape retains an undetermined target and separates replacement identity", () => {
  const result = projectRetirementStatus({ project: "project-a" }, sources());
  expect(result).toMatchObject({ status: "observed", capturedAt, ageMs: 60_000, refreshSucceeded: true, hasMore: false });
  expect(result.items).toHaveLength(1);
  expect(result.items[0]).toMatchObject({ conversationId, generationId: generation, sessionKey: key,
    operationId: null, process: null, phase: "evaluation", result: "undetermined", reason: "event tail unavailable",
    current: { generationId: generation, conversationGenerationId: replacement, ownership: "unknown" } });
});

test("the report names the flags behind no-active-flags refusals, per item and across the sweep (#2137)", () => {
  const value = report();
  value.refused = [{ key, conversationId, clause: "no-active-flags", reason: "the host is flagged waitingOnApproval",
    flags: ["waitingOnApproval"] }];
  /* The whole sweep's counts, which include hosts of projects this caller
     cannot see: flag names and counts only, never a host. */
  value.refusedByFlag = { waitingOnApproval: 1, "some-future-capability-v9": 4 };
  const result = projectRetirementStatus({ project: "project-a" }, sources(value));
  expect(result.refusedByFlag).toEqual({ waitingOnApproval: 1, "some-future-capability-v9": 4 });
  expect(result.items[0]).toMatchObject({ result: "refused", clause: "no-active-flags", flags: ["waitingOnApproval"] });

  /* Another project's caller still sees the counts, and none of the targets. */
  const elsewhere = projectRetirementStatus({ project: "project-b" }, sources(value));
  expect(elsewhere.items).toEqual([]);
  expect(elsewhere.refusedByFlag).toEqual({ waitingOnApproval: 1, "some-future-capability-v9": 4 });

  /* A report written before the count existed answers null, not an empty map. */
  const legacy = report() as Partial<StructuredHostRetirementReport>;
  delete legacy.refusedByFlag;
  expect(projectRetirementStatus({ project: "project-a" }, sources(legacy as StructuredHostRetirementReport)).refusedByFlag).toBeNull();
  expect(projectRetirementStatus({ project: "project-a" }, { ...sources(), readReport: () => Buffer.from("{}") }).refusedByFlag).toBeNull();
});

test("pages cap both returned and examined subjects and never expose another project", () => {
  const value = report();
  value.refused = Array.from({ length: 250 }, () => ({ ...value.refused[0]! }));
  let reads = 0;
  const inputs = sources(value, "project-b");
  const subject = inputs.subject;
  inputs.subject = () => { reads++; return subject(); };
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = projectRetirementStatus({ project: "project-a", limit: 999, cursor }, inputs);
    expect(page.limit).toBe(100);
    expect(page.items).toEqual([]);
    expect(JSON.stringify(page)).not.toContain(conversationId);
    expect(reads).toBeLessThanOrEqual(++pages * RETIREMENT_SCAN_LIMIT);
    cursor = page.cursor ?? undefined;
  } while (cursor);
  expect(pages).toBe(3);
  expect(reads).toBe(250);
  expect(projectRetirementStatus({ project: "project-b", limit: 2 }, inputs).items).toHaveLength(2);
});

test("report replacement, cross-project cursors and invalid cursors fail closed", () => {
  const value = report(); value.refused.push({ ...value.refused[0]! });
  const first = projectRetirementStatus({ project: "project-a", limit: 1 }, sources(value));
  expect(first.hasMore).toBe(true);
  const request = { project: "project-a", limit: 1, cursor: first.cursor! };
  expect(projectRetirementStatus(request, sources(value)).hasMore).toBe(false);
  expect(() => projectRetirementStatus({ ...request, project: "project-b" }, sources(value))).toThrow("changed");
  value.finishedAt = "2026-07-01T12:01:00.000Z";
  expect(() => projectRetirementStatus(request, sources(value))).toThrow("changed");
  expect(() => projectRetirementStatus({ ...request, cursor: "invalid" }, sources(value))).toThrow("invalid");
});

test("the page budget is terminal and explicitly incomplete", () => {
  const value = report(); value.refused = Array.from({ length: 21 }, () => ({ ...value.refused[0]! }));
  let cursor: string | undefined;
  for (let index = 0; index < RETIREMENT_MAX_PAGES; index++) {
    const page = projectRetirementStatus({ project: "project-a", limit: 1, cursor }, sources(value));
    cursor = page.cursor ?? undefined;
    if (index === RETIREMENT_MAX_PAGES - 1) {
      expect(page).toMatchObject({ status: "unknown", hasMore: false, cursor: null, coverage: "page-budget-exhausted" });
    } else expect(page.hasMore).toBe(true);
  }
});

test("missing, oversized, malformed and unattributable evidence remains unknown", () => {
  for (const readReport of [() => { throw new Error("missing"); }, () => Buffer.alloc(1024 * 1024 + 1), () => Buffer.from("{}")]) {
    expect(projectRetirementStatus({ project: "project-a" }, { ...sources(), readReport })).toMatchObject({
      status: "unknown", items: [], refreshSucceeded: false, hasMore: false });
  }
  expect(projectRetirementStatus({ project: "project-a" }, { ...sources(), subject: () => { throw new Error("unreadable"); } }))
    .toMatchObject({ status: "unknown", items: [], coverage: "project-attribution-incomplete" });
  const legacy = sources();
  const subject = legacy.subject();
  subject.conversation.projectOwnership = null;
  expect(projectRetirementStatus({ project: "project-a" }, { ...legacy, subject: () => subject }))
    .toMatchObject({ status: "unknown", items: [], coverage: "project-attribution-incomplete" });
  const unrelatedGeneration = sources();
  const replacementOnly = unrelatedGeneration.subject();
  replacementOnly.conversation.generations.shift();
  expect(projectRetirementStatus({ project: "project-a" }, { ...unrelatedGeneration, subject: () => replacementOnly }))
    .toMatchObject({ status: "unknown", items: [] });
});

test("a slow subject read yields a continuation instead of repeatedly waiting on the store", () => {
  const value = report(); value.refused.push({ ...value.refused[0]! });
  const input = sources(value);
  let elapsed = 0;
  let reads = 0;
  const page = projectRetirementStatus({ project: "project-a" }, { ...input,
    now: () => now() + elapsed,
    subject: () => { reads++; elapsed += 5000; return input.subject(); },
  });
  expect(reads).toBe(1);
  expect(page).toMatchObject({ hasMore: true });
  expect(page.items).toHaveLength(1);
});

test("failure and retirement results are read from their own recorded groups", () => {
  const value = report();
  value.failed = [{ key, conversationId, error: "identity changed", remaining: [123] }];
  value.retired = [{ key, conversationId, engine: "codex", sessionId: generation, title: null, role: null, stage: null,
    cwd: "/workspace/project-a", idleMs: 1000, passed: [], via: "already-exited", pids: [],
    reclaimed: { rssBytes: 0, swapBytes: 0, processes: 0 } }];
  const page = projectRetirementStatus({ project: "project-a" }, sources(value));
  expect(page.items.map((item) => item.result)).toEqual(["undetermined", "failed", "retired"]);
  expect(page.items.every((item) => item.operationId === null && item.process === null)).toBe(true);
});

test("production reads only named authorization and subject rows without writing state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-retirement-read-")); roots.push(root);
  process.env.LLV_STATE_DIR = root;
  const filename = path.join(root, "agent-registry.sqlite");
  const seed = new SqliteAgentRegistryStore(filename, { initialSnapshot: registryFixture(), normalize: normalizeRegistry });
  seed.close();
  const database = new Database(filename);
  // An unrelated corrupt receipt must never be parsed by this read.
  database.query("INSERT INTO registry_rows(collection,row_key,value_json,row_order) VALUES ('receipts','unrelated','invalid JSON',0)").run();
  database.query("INSERT INTO registry_rows(collection,row_key,value_json,row_order) VALUES ('receipts',?,?,1)")
    .run(authentication.launchId, JSON.stringify({ conversationId, spawnCapabilityDigest: crypto.createHash("sha256").update(capability).digest("hex") }));
  database.close();
  const reportFile = path.join(root, "host-retirement-report.json");
  fs.writeFileSync(reportFile, JSON.stringify(report()));
  const before = [fs.readFileSync(filename), fs.readFileSync(reportFile)];
  const page = readRetirementStatus({ project: "project-a" }, authentication);
  expect(page.items).toHaveLength(1);
  expect(page.items[0]).toMatchObject({ result: "undetermined", operationId: null });
  expect(readRetirementStatus({ project: "project-a" }, { conversationId, launchId: authentication.launchId }).items).toHaveLength(1);
  expect(readRetirementStatus({ project: "project-a" }, { conversationId, seatProject: "project-a" }).items).toHaveLength(1);
  expect(() => readRetirementStatus({ project: "project-a" }, { conversationId: "conversation_foreign", launchId: authentication.launchId })).toThrow("authenticated");
  expect(() => readRetirementStatus({ project: "project-b" }, { conversationId, seatProject: "project-a" })).toThrow("authenticated");
  expect(fs.readFileSync(filename)).toEqual(before[0]!);
  expect(fs.readFileSync(reportFile)).toEqual(before[1]!);
  expect(fs.existsSync(path.join(root, "agent-registry.json"))).toBe(false);
  let loaded = 0;
  const read: string[] = [];
  const reader = new SqliteAgentRegistryStore(filename, { readOnly: true, initialSnapshot: () => { throw new Error("import"); },
    normalize: normalizeRegistry, onSnapshotLoad: () => { loaded++; }, onRowPayloadRead: (collection) => { read.push(collection); } });
  try {
    expect(reader.retirementCaller(authentication.launchId, crypto.createHash("sha256").update(capability).digest("hex"))).toBe(conversationId);
    expect(reader.retirementSubject(conversationId, key).conversation?.id).toBe(conversationId);
  }
  finally { reader.close(); }
  expect(loaded).toBe(0);
  expect(read).toEqual(["receipts", "conversations", "entries"]);
  expect(() => readRetirementStatus({ project: "project-b" }, authentication)).toThrow("authenticated");
  expect(() => readRetirementStatus({ project: "project-a" }, { ...authentication, capability: "s".repeat(43) })).toThrow("authenticated");
  expect(() => readRetirementStatus({ project: "project-a" }, { ...authentication, capability: "" })).toThrow("capability");
  expect(() => readRetirementStatus({ project: "project-a" }, { ...authentication, launchId: "absent" })).toThrow("authenticated");
  const revoke = new Database(filename);
  revoke.query("UPDATE registry_rows SET value_json=? WHERE collection='receipts' AND row_key=?")
    .run(JSON.stringify({ conversationId, spawnCapabilityDigest: null }), authentication.launchId);
  revoke.close();
  expect(() => readRetirementStatus({ project: "project-a" }, authentication)).toThrow("authenticated");
});
