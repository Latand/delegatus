import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as cooperative from "@/lib/cooperative";
import { persistProjectAliases, resetProjectAliasesForTests } from "@/lib/projects/aliases";
import { roleMemoryCollection } from "../roleStore";
import { ROLE_MEMORY_BOUND, type RoleMemoryRule, type RoleMemoryScopeRow } from "../roleTypes";
import * as store from "./store";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/monitor/seat-tick/settings/route";
import { defaultSeatTickSettings, writeSeatTickSettings } from "@/lib/monitor/seatTickSettings";
import { chooseSource } from "../fixtures/source";

const PROJECT = "status-project", SCOPE = `role:${PROJECT}:builder`, ID = "r_status";
const NOW = Date.parse("2026-10-12T12:00:00Z"), AT = new Date(NOW).toISOString();
const SETTING = { enabled: true, intervalHours: 6, intervalMs: 21_600_000 };
let dir: string, prior: string | undefined;
beforeEach(() => {
  prior = process.env.LLV_STATE_DIR;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "curation-status-"));
  process.env.LLV_STATE_DIR = dir;
  resetProjectAliasesForTests();
  setSystemTime(new Date(NOW));
});
afterEach(() => {
  setSystemTime();
  if (prior === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = prior;
  resetProjectAliasesForTests();
  fs.rmSync(dir, { recursive: true, force: true });
});
function seed(history = 1024) {
  const memory = roleMemoryCollection(true)!;
  const rule: RoleMemoryRule = { kind: "rule", id: ID, scope: SCOPE, rule: "Check the current revision before applying changes.", why: "Concurrent writes can invalidate a plan.",
    state: "active", hints: [], createdAt: AT, changedAt: AT,
    source: { project: PROJECT, pipelineId: "fixture", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "fixture" } };
  memory.boundedPatch(4, tx => {
    tx.put(rule);
    tx.put({ kind: "scope", scope: SCOPE, active: [ID], revision: history + 1,
      history: Array.from({ length: history }, (_, index) => ({ revision: index + 1, at: AT, by: "agent", added: [ID], merged: [], archived: [] })) });
  });
  return memory;
}
function changeRule(text = "x".repeat(ROLE_MEMORY_BOUND + 1)) {
  roleMemoryCollection()!.boundedPatch(2, tx => {
    const rule = tx.get(`r:${ID}`) as RoleMemoryRule;
    tx.put({ ...rule, rule: text });
  });
}
function checkpoint() {
  const db = new Database(path.join(dir, "state.sqlite"));
  try { expect(db.query<{ busy: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)").get()?.busy).toBe(0); }
  finally { db.close(); }
}

test("rule refresh neither clones unchanged histories nor reads retained pass authorities", () => {
  seed();
  const pass = store.claimPass({ project: PROJECT, repoDir: null, now: NOW, setting: SETTING })!;
  store.patchPass(pass.id, { state: "succeeded", endedAt: AT });
  const expected = store.curationStatus(PROJECT, NOW, SETTING);
  changeRule();
  const clone = structuredClone;
  let histories = 0;
  const cloning = spyOn(globalThis, "structuredClone").mockImplementation(value => {
    const row = value as Partial<RoleMemoryScopeRow> | null;
    if (row?.kind === "scope" && Array.isArray(row.history)) histories += row.history.length;
    return clone(value);
  });
  const held = store.curationCollection()!, get = held.get.bind(held);
  let passReads = 0;
  const reading = spyOn(held, "get").mockImplementation(key => { if (key.startsWith("r:")) passReads++; return get(key); });
  try {
    expect(store.curationStatus(PROJECT, NOW, SETTING)).toMatchObject({ newLessons: expected.newLessons, pressure: true, due: false });
    expect(histories).toBe(0);
    // The last pass is read once to determine pending import eligibility.
    expect(passReads).toBe(1);
  } finally { cloning.mockRestore(); reading.mockRestore(); }
});

test("cooperative status agrees with authority and callers cannot modify its cache", async () => {
  seed();
  const first = await store.curationStatusCooperatively(PROJECT, NOW, SETTING);
  expect(first).toEqual(store.curationStatus(PROJECT, NOW, SETTING));
  expect(first.newLessons).toBe(1024);
  first.newLessons = -1;
  expect((await store.curationStatusCooperatively(PROJECT, NOW, SETTING)).newLessons).toBe(1024);
  changeRule();
  expect(await store.curationStatusCooperatively(PROJECT, NOW, SETTING)).toEqual(store.curationStatus(PROJECT, NOW, SETTING));
});

for (const afterYield of [1, 2, 3, 4, 5, 6, 7, 8]) test(`a write after yield ${afterYield} restarts with fresh rule and scope membership`, async () => {
  const memory = seed();
  const original = cooperative.yieldToRuntime;
  let yields = 0, changed = false;
  const hook = spyOn(cooperative, "yieldToRuntime").mockImplementation(async () => {
    await original();
    if (++yields === afterYield) {
      changed = true;
      memory.boundedPatch(4, tx => {
        const row = tx.get(`s:${SCOPE}`) as RoleMemoryScopeRow;
        tx.put({ ...row, revision: row.revision + 1, active: [], history: [...row.history,
          { revision: row.revision + 1, at: AT, by: "agent", added: ["peer"], merged: [], archived: [] }] });
      });
    }
  });
  try {
    const status = await store.curationStatusCooperatively(PROJECT, NOW, SETTING);
    expect(changed).toBe(true);
    expect(status).toMatchObject({ active: false, newLessons: 1025 });
    expect(status).toEqual(store.curationStatus(PROJECT, NOW, SETTING));
  } finally { hook.mockRestore(); }
  checkpoint();
});

test("cancelling one reader releases its cursor and leaves an independent caller running", async () => {
  seed();
  const controller = new AbortController(), reason = Error("caller cancelled");
  const original = cooperative.yieldToRuntime;
  const hook = spyOn(cooperative, "yieldToRuntime").mockImplementation(async () => { await original(); controller.abort(reason); });
  try {
    const [cancelled, completed] = await Promise.allSettled([
      store.curationStatusCooperatively(PROJECT, NOW, SETTING, controller.signal),
      store.curationStatusCooperatively(PROJECT, NOW, SETTING),
    ]);
    expect(cancelled).toMatchObject({ status: "rejected", reason });
    expect(completed).toMatchObject({ status: "fulfilled", value: { newLessons: 1024 } });
    await expect(store.curationStatusCooperatively(PROJECT, NOW, SETTING, controller.signal)).rejects.toBe(reason);
  } finally { hook.mockRestore(); }
  checkpoint();
});

test("a deadline expires across yields and releases the history cursor", async () => {
  seed();
  let now = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const original = cooperative.yieldToRuntime;
  const hook = spyOn(cooperative, "yieldToRuntime").mockImplementation(async () => { await original(); now = 5001; });
  try { await expect(store.curationStatusCooperatively(PROJECT, NOW, SETTING)).rejects.toThrow("timed out"); }
  finally { hook.mockRestore(); clock.mockRestore(); }
  checkpoint();
  expect((await store.curationStatusCooperatively(PROJECT, NOW, SETTING)).newLessons).toBe(1024);
});

test("continuously changing input refuses after bounded retries without retaining a cursor", async () => {
  seed();
  const original = cooperative.yieldToRuntime;
  let changes = 0;
  const hook = spyOn(cooperative, "yieldToRuntime").mockImplementation(async () => {
    await original(); changes++;
    roleMemoryCollection()!.boundedPatch(2, tx => {
      const row = tx.get(`s:${SCOPE}`) as RoleMemoryScopeRow;
      tx.put({ ...row, revision: row.revision + 1 });
    });
  });
  try {
    await expect(store.curationStatusCooperatively(PROJECT, NOW, SETTING)).rejects.toThrow("memory changed while reading curation status");
    expect(changes).toBe(3);
  } finally { hook.mockRestore(); }
  checkpoint();
});

test("an alias changed during a read recomputes physical membership and the canonical budget", async () => {
  seed();
  const memory = roleMemoryCollection()!;
  memory.boundedPatch(4, tx => {
    const rule = tx.get(`r:${ID}`) as RoleMemoryRule;
    tx.put({ ...rule, id: "r_alias", rule: "x".repeat(ROLE_MEMORY_BOUND), scope: "role:old-project:builder" });
    tx.put({ kind: "scope", scope: "role:old-project:builder", revision: 1, active: ["r_alias", ID], history: [] });
  });
  const original = cooperative.yieldToRuntime;
  let changed = false;
  const hook = spyOn(cooperative, "yieldToRuntime").mockImplementation(async () => {
    await original();
    if (!changed) { changed = true; persistProjectAliases([{ source: "old-project", target: PROJECT, displayName: "Current project" }]); }
  });
  try {
    expect(await store.curationStatusCooperatively(PROJECT, NOW, SETTING)).toMatchObject({ pressure: true, urgent: true, newLessons: 1024 });
  } finally { hook.mockRestore(); }
});

test("warm rule cache observes a replacement database with reused row revisions", async () => {
  seed(0);
  const first = await store.curationStatusCooperatively(PROJECT, NOW, SETTING);
  expect(first.pressure).toBe(false);
  const filename = path.join(dir, "state.sqlite"), replacement = path.join(dir, "replacement.sqlite");
  const db = new Database(filename);
  db.query("VACUUM INTO ?").run(replacement); db.close();
  const copy = new Database(replacement);
  copy.query("UPDATE state_rows SET value_json=json_set(value_json, '$.rule', ?) WHERE collection='role_memory' AND row_key=?")
    .run("x".repeat(ROLE_MEMORY_BOUND + 1), `r:${ID}`);
  copy.close();
  checkpoint();
  fs.renameSync(replacement, filename);
  expect(await store.curationStatusCooperatively(PROJECT, NOW, SETTING)).toMatchObject({ pressure: true, urgent: true });
});

function request(signal?: AbortSignal) {
  return new NextRequest(`http://127.0.0.1/api/monitor/seat-tick/settings?project=${PROJECT}`, { signal });
}
function servingSeed() {
  const memory = seed();
  chooseSource("active");
  writeSeatTickSettings(PROJECT, { ...defaultSeatTickSettings(PROJECT), enabled: true });
  return memory;
}

test("the serving route yields and observes peer membership and settings changes", async () => {
  const memory = servingSeed();
  const original = cooperative.yieldToRuntime;
  let changed = false;
  const hook = spyOn(cooperative, "yieldToRuntime").mockImplementation(async () => {
    await original();
    if (changed) return;
    changed = true;
    memory.boundedPatch(2, tx => {
      const row = tx.get(`s:${SCOPE}`) as RoleMemoryScopeRow;
      tx.put({ ...row, revision: row.revision + 1, active: [] });
    });
    writeSeatTickSettings(PROJECT, { ...defaultSeatTickSettings(PROJECT), enabled: true,
      curation: { enabled: true, intervalHours: 12, updatedAt: AT, setBy: { kind: "gateway", conversationId: null, project: null, seatEpoch: null } } });
  });
  try {
    const response = await GET(request());
    expect(response.status).toBe(200);
    const answer = await response.json();
    expect(changed).toBe(true);
    expect(answer.curation).toMatchObject({ intervalHours: 12, nextRunAt: null, waitingOn: "no-rules", runsError: null });
  } finally { hook.mockRestore(); }
  checkpoint();
});

test("the serving route cancels only its request and returns the original error", async () => {
  servingSeed();
  const controller = new AbortController();
  const original = cooperative.yieldToRuntime;
  const hook = spyOn(cooperative, "yieldToRuntime").mockImplementation(async () => { await original(); controller.abort(Error("request cancelled")); });
  try {
    const [cancelled, independent] = await Promise.all([GET(request(controller.signal)), GET(request())]);
    expect(cancelled.status).toBe(500);
    expect(await cancelled.json()).toEqual({ error: "request cancelled" });
    expect(independent.status).toBe(200);
    expect((await independent.json()).curation.runsError).toBeNull();
  } finally { hook.mockRestore(); }
  checkpoint();
});

test("the serving route retains timer controls and the reason for malformed history", async () => {
  const memory = servingSeed();
  memory.boundedPatch(2, tx => {
    const row = tx.get(`s:${SCOPE}`) as RoleMemoryScopeRow;
    tx.put({ ...row, history: [null] } as unknown as RoleMemoryScopeRow);
  });
  const response = await GET(request());
  expect(response.status).toBe(200);
  expect((await response.json()).curation).toMatchObject({ enabled: true, runsError: "invalid projected memory history", nextRunAt: null });
  checkpoint();
});

test("replacement during a cooperative history read retries against the new database", async () => {
  seed();
  const filename = path.join(dir, "state.sqlite"), replacement = path.join(dir, "replacement.sqlite");
  const db = new Database(filename);
  db.query("VACUUM INTO ?").run(replacement); db.close();
  const copy = new Database(replacement);
  copy.query("UPDATE state_rows SET value_json=json_set(value_json, '$.rule', ?) WHERE collection='role_memory' AND row_key=?")
    .run("x".repeat(ROLE_MEMORY_BOUND + 1), `r:${ID}`);
  copy.close(); checkpoint();
  const original = cooperative.yieldToRuntime;
  let swapped = false;
  const hook = spyOn(cooperative, "yieldToRuntime").mockImplementation(async () => {
    await original();
    if (!swapped) { swapped = true; fs.renameSync(replacement, filename); }
  });
  try {
    expect(await store.curationStatusCooperatively(PROJECT, NOW, SETTING)).toMatchObject({ pressure: true, urgent: true, newLessons: 1024 });
    expect(swapped).toBe(true);
  } finally { hook.mockRestore(); }
  checkpoint();
});

test("a second caller sees a peer commit while the first caller still holds a history cursor", async () => {
  const memory = seed();
  const original = cooperative.yieldToRuntime;
  let observed: Awaited<ReturnType<typeof store.curationStatusCooperatively>> | undefined;
  let changed = false;
  const hook = spyOn(cooperative, "yieldToRuntime").mockImplementation(async () => {
    await original();
    if (changed) return;
    changed = true;
    memory.boundedPatch(2, tx => {
      const row = tx.get(`s:${SCOPE}`) as RoleMemoryScopeRow;
      tx.put({ ...row, revision: row.revision + 1, active: [] });
    });
    observed = await store.curationStatusCooperatively(PROJECT, NOW, SETTING);
  });
  try {
    const first = await store.curationStatusCooperatively(PROJECT, NOW, SETTING);
    expect(observed).toMatchObject({ active: false, newLessons: 1024 });
    expect(first).toEqual(observed!);
  } finally { hook.mockRestore(); }
  checkpoint();
});

test("synchronous status and claim authority stay fresh while a cooperative cursor is paused", async () => {
  const memory = seed();
  const writer = new Database(path.join(dir, "state.sqlite"));
  writer.exec("PRAGMA busy_timeout=0");
  const original = cooperative.yieldToRuntime;
  let checked = false;
  const hook = spyOn(cooperative, "yieldToRuntime").mockImplementation(async () => {
    await original();
    if (checked || writer.query<{ busy: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)").get()?.busy !== 1) return;
    checked = true;
    memory.boundedPatch(2, tx => {
      const row = tx.get("s:" + SCOPE) as RoleMemoryScopeRow;
      tx.put({ ...row, revision: row.revision + 1, active: [] });
    });
    expect(store.curationStatus(PROJECT, NOW, SETTING)).toMatchObject({ active: false, due: false });
    expect(store.claimPass({ project: PROJECT, repoDir: null, now: NOW, setting: SETTING })).toBeNull();
  });
  try {
    expect(await store.curationStatusCooperatively(PROJECT, NOW, SETTING)).toMatchObject({ active: false });
    expect(checked).toBe(true);
  } finally { hook.mockRestore(); writer.close(); }
  checkpoint();
});

test("claim authority sees recovery archives while a project-view cursor holds an older snapshot", async () => {
  const memory = seed();
  const { projectViewRowsCooperatively } = await import("../roleViewSource");
  const writer = new Database(path.join(dir, "state.sqlite"));
  writer.exec("PRAGMA busy_timeout=0");
  const original = cooperative.yieldToRuntime;
  let checked = false;
  const hook = spyOn(cooperative, "yieldToRuntime").mockImplementation(async () => {
    await original();
    if (checked || writer.query<{ busy: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)").get()?.busy !== 1) return;
    checked = true;
    memory.boundedPatch(4, tx => {
      const row = tx.get("s:" + SCOPE) as RoleMemoryScopeRow;
      tx.put({ ...row, revision: row.revision + 1, active: [] });
      tx.put({ ...(tx.get("r:" + ID) as RoleMemoryRule), state: "archived", reason: "budget" });
    });
    expect(store.curationStatus(PROJECT, NOW, SETTING)).toMatchObject({ active: true, urgent: true, due: true });
    expect(store.claimPass({ project: PROJECT, repoDir: null, now: NOW, setting: SETTING })?.budgetSweepCandidates?.[SCOPE]).toEqual([ID]);
  });
  try { await projectViewRowsCooperatively(PROJECT); expect(checked).toBe(true); }
  finally { hook.mockRestore(); writer.close(); }
  checkpoint();
});
