import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as cooperative from "@/lib/cooperative";
import { persistProjectAliases, resetProjectAliasesForTests } from "@/lib/projects/aliases";
import { recordLessonRequest, roleMemoryCollection } from "../roleStore";
import { ROLE_MEMORY_BOUND, type RoleMemoryRule, type RoleMemoryScopeRow } from "../roleTypes";
import * as store from "./store";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/monitor/seat-tick/settings/route";
import { defaultSeatTickSettings, writeSeatTickSettings } from "@/lib/monitor/seatTickSettings";
import { chooseSource } from "../fixtures/source";
import * as source from "../roleViewSource";
import * as imports from "../importCuration";
import { importCandidate, seedImport } from "../fixtures/import";
import { saveTasks } from "@/lib/tasks/store";
import { viewerMcpBindings } from "@/lib/mcp/bindings";
import { readSeatTickSettings, effectiveSeatTickSettings } from "@/lib/monitor/seatTickSettings";
import { curationAnswer } from "./answer";

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

function settingsTool() {
  return viewerMcpBindings(undefined, undefined, {
    registrySnapshot: () => ({ conversations: {} }),
    callerAttribution: () => ({ kind: "manager", conversationId: "conversation_status_seat", role: "orchestrator" }),
    authorizedSeats: () => [{ conversationId: "conversation_status_seat", path: null, project: PROJECT }],
    callerProject: () => PROJECT,
    readTickSettings: readSeatTickSettings,
    writeTickSettings: writeSeatTickSettings,
  } as never).seat_tick_settings;
}

test("the MCP curation read lets a heartbeat run before returning the unchanged answer", async () => {
  seed(4096);
  let heartbeat = false;
  const timer = setTimeout(() => { heartbeat = true; }, 0);
  try {
    const result = await settingsTool()({ verbose: true });
    expect(heartbeat).toBe(true);
    expect(result.curation).toEqual(curationAnswer(PROJECT, effectiveSeatTickSettings(readSeatTickSettings(PROJECT), NOW, 3_600_000), NOW));
  } finally { clearTimeout(timer); }
  checkpoint();
});

test("the MCP curation read observes cancellation during retained history", async () => {
  seed(4096);
  const controller = new AbortController(), reason = Error("caller cancelled curation read");
  const timer = setTimeout(() => controller.abort(reason), 0);
  try { await expect(settingsTool()({ verbose: true }, { signal: controller.signal })).rejects.toBe(reason); }
  finally { clearTimeout(timer); }
  checkpoint();
});

test("the MCP curation read refreshes settings changed while yielding", async () => {
  seed(4096);
  const original = cooperative.yieldToRuntime;
  let changed = false;
  const hook = spyOn(cooperative, "yieldToRuntime").mockImplementation(async () => {
    await original();
    if (changed) return;
    changed = true;
    writeSeatTickSettings(PROJECT, { ...defaultSeatTickSettings(PROJECT), enabled: false, reason: "Paused during read" });
  });
  try {
    const result = await settingsTool()({ verbose: true });
    expect(changed).toBe(true);
    expect(result).toMatchObject({ settings: { enabled: false }, effective: { enabled: false }, curation: { waitingOn: "wakes-off" } });
  } finally { hook.mockRestore(); }
  checkpoint();
});

test("the MCP curation read enforces the caller deadline across yields", async () => {
  seed(4096);
  const original = cooperative.yieldToRuntime;
  const hook = spyOn(cooperative, "yieldToRuntime").mockImplementation(async () => {
    await original();
    setSystemTime(new Date(NOW + 101));
  });
  try { await expect(settingsTool()({ verbose: true }, { deadlineAt: NOW + 100 })).rejects.toThrow("deadline exceeded"); }
  finally { hook.mockRestore(); }
  checkpoint();
});

test("a compact MCP settings write acknowledges without scanning curation history", async () => {
  seed(4096);
  const original = cooperative.yieldToRuntime;
  let yields = 0;
  const hook = spyOn(cooperative, "yieldToRuntime").mockImplementation(async () => { yields++; await original(); });
  try {
    const result = await settingsTool()({ enabled: false, reason: "Pause fixture" });
    expect(result).toMatchObject({ changed: true, changedFields: ["enabled", "reason"] });
    expect(result).not.toHaveProperty("curation");
    expect(yields).toBe(0);
  } finally { hook.mockRestore(); }
});

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

test("another project's curator progress keeps warm summaries and pass counts reusable", () => {
  seed();
  const pass = store.claimPass({ project: PROJECT, repoDir: null, now: NOW, setting: SETTING })!;
  store.patchPass(pass.id, { state: "succeeded", endedAt: AT, counts: { ...pass.counts, calls: 3 } });
  const expectedStatus = store.curationStatus(PROJECT, NOW, SETTING);
  const expectedPass = store.readPass(pass.id);
  store.curationCollection()!.boundedPatch(1, tx => {
    tx.put({ ...pass, id: "curate_other_project", project: "other-project", counts: { ...pass.counts, calls: 9 } });
  });
  const original = source.curationScopeInputs;
  let historyReads = 0;
  const histories = spyOn(source, "curationScopeInputs").mockImplementation(function* (...args) {
    historyReads++;
    return yield* original(...args);
  });
  try {
    expect(store.curationStatus(PROJECT, NOW, SETTING)).toEqual(expectedStatus);
    expect(store.readPass(pass.id)).toEqual(expectedPass);
    expect(historyReads).toBe(0);
    store.patchPass(pass.id, { counts: { ...pass.counts, calls: 7 } });
    expect(store.readPass(pass.id)?.counts.calls).toBe(7);
  } finally { histories.mockRestore(); }
});

test("a timed-out curation panel retains the completed run's durable identity", async () => {
  seed();
  const pass = store.claimPass({ project: PROJECT, repoDir: null, now: NOW, setting: SETTING })!;
  store.patchPass(pass.id, { state: "succeeded", endedAt: AT, conversationId: "conversation_completed_curator" });
  let now = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const original = cooperative.yieldToRuntime;
  const waiting = spyOn(cooperative, "yieldToRuntime").mockImplementation(async () => { await original(); now = 5001; });
  try {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect((await response.json()).curation).toMatchObject({
      lastRun: { id: pass.id, state: "succeeded", endedAt: AT, conversationId: "conversation_completed_curator" },
      nextRunAt: null, runsError: "curation status read timed out",
    });
  } finally { waiting.mockRestore(); clock.mockRestore(); }
  checkpoint();
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

for (const noise of ["task", "request", "same-project-request", "lesson"] as const) {
  for (const surface of ["status", "route"] as const) test(surface + " accepts unrelated " + noise + " writes after every yield", async () => {
    const memory = servingSeed();
    const template = memory.get("r:" + ID) as RoleMemoryRule;
    const original = cooperative.yieldToRuntime;
    let writes = 0;
    const hook = spyOn(cooperative, "yieldToRuntime").mockImplementation(async () => {
      await original(); writes++;
      if (noise === "task") {
        saveTasks([{ id: "noise-task", project: "other-project", text: "Unrelated update " + writes,
          status: "inbox", placement: "unplaced", assignments: [], createdAt: AT, updatedAt: AT }], path.join(dir, "tasks.json"));
      } else if (noise === "request" || noise === "same-project-request") {
        recordLessonRequest({ project: noise === "same-project-request" ? PROJECT : "other-project", pipelineId: "noise", stageId: "build", attempt: writes,
          roleId: "builder", conversationId: "noise-conversation", at: AT });
      } else {
        memory.boundedPatch(4, tx => {
          tx.put({ ...template, id: "r_noise", scope: "role:other-project:builder", rule: "Unrelated guidance " + writes });
          tx.put({ kind: "scope", scope: "role:other-project:builder", revision: writes, active: ["r_noise"], history: [] });
        });
      }
    });
    try {
      if (surface === "status") expect(await store.curationStatusCooperatively(PROJECT, NOW, SETTING)).toMatchObject({ active: true, newLessons: 1024 });
      else {
        const response = await GET(request());
        expect(response.status).toBe(200);
        expect((await response.json()).curation).toMatchObject({ runsError: null, nextRunAt: AT });
      }
      expect(writes).toBeGreaterThan(3);
    } finally { hook.mockRestore(); }
    checkpoint();
  });
}

test("synchronous status accepts real unrelated commits after each version observation", () => {
  seed();
  const writer = new Database(path.join(dir, "state.sqlite"));
  writer.exec("CREATE TABLE noise(value INTEGER); INSERT INTO noise VALUES(0)");
  const query = Database.prototype.query;
  let commits = 0;
  const hook = spyOn(Database.prototype, "query").mockImplementation((function(this: Database, sql: string, ...args: unknown[]) {
    const statement = query.call(this, sql, ...args as []);
    if (sql.trim() !== "PRAGMA data_version") return statement;
    return new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === "get") return (...args: unknown[]) => {
        const result = value.apply(target, args);
        writer.exec("UPDATE noise SET value=value+1"); commits++;
        return result;
      };
      return typeof value === "function" ? value.bind(target) : value;
    } });
  }) as typeof Database.prototype.query);
  try {
    expect(store.curationStatus(PROJECT, NOW, SETTING)).toMatchObject({ active: true, due: true, newLessons: 1024 });
    expect(commits).toBeGreaterThan(3);
  } finally { hook.mockRestore(); writer.close(); }
});

test("a newly created relevant scope joins the answer during a read", async () => {
  const memory = seed(), template = memory.get("r:" + ID) as RoleMemoryRule;
  const original = cooperative.yieldToRuntime;
  let changed = false;
  const hook = spyOn(cooperative, "yieldToRuntime").mockImplementation(async () => {
    await original();
    if (changed) return;
    changed = true;
    memory.boundedPatch(4, tx => {
      tx.put({ ...template, id: "r_new_scope", scope: "role:" + PROJECT + ":critic", rule: "x".repeat(ROLE_MEMORY_BOUND + 1) });
      tx.put({ kind: "scope", scope: "role:" + PROJECT + ":critic", revision: 1, active: ["r_new_scope"], history: [] });
    });
  });
  try { expect(await store.curationStatusCooperatively(PROJECT, NOW, SETTING)).toMatchObject({ pressure: true, urgent: true }); }
  finally { hook.mockRestore(); }
});

test("a claim made during projection changes the lesson boundary and due answer", async () => {
  seed();
  const original = cooperative.yieldToRuntime;
  let pass: ReturnType<typeof store.claimPass> = null;
  const hook = spyOn(cooperative, "yieldToRuntime").mockImplementation(async () => {
    await original();
    pass ??= store.claimPass({ project: PROJECT, repoDir: null, now: NOW, setting: SETTING });
  });
  try {
    expect(await store.curationStatusCooperatively(PROJECT, NOW, SETTING)).toMatchObject({ due: false, newLessons: 0, lastClaimAt: AT });
    expect(pass).not.toBeNull();
  } finally { hook.mockRestore(); }
});

test("a pass settled during receipt projection is returned as completed", async () => {
  seed();
  const pass = store.claimPass({ project: PROJECT, repoDir: null, now: NOW, setting: SETTING })!;
  const original = cooperative.yieldToRuntime;
  let changed = false;
  const hook = spyOn(cooperative, "yieldToRuntime").mockImplementation(async () => {
    await original();
    if (changed) return;
    changed = true; store.patchPass(pass.id, { state: "succeeded", endedAt: AT });
  });
  try {
    const data = await store.curationPanelDataCooperatively(PROJECT, NOW, SETTING);
    expect(data).toMatchObject({ runs: { live: null, last: { id: pass.id, state: "succeeded" } }, status: { due: false, lastAt: AT } });
  } finally { hook.mockRestore(); }
});

test("an absent active rule created after lookup invalidates that observation", () => {
  const memory = seed(0), template = memory.get("r:" + ID) as RoleMemoryRule;
  memory.boundedPatch(2, tx => {
    const row = tx.get("s:" + SCOPE) as RoleMemoryScopeRow;
    tx.put({ ...row, active: ["r_absent"] });
  });
  const original = source.curationRuleInputs;
  let changed = false;
  const hook = spyOn(source, "curationRuleInputs").mockImplementation((...args) => {
    const rows = original(...args);
    if (!changed) { changed = true; memory.boundedPatch(2, tx => tx.put({ ...template, id: "r_absent" })); }
    return rows;
  });
  try { expect(store.curationStatus(PROJECT, NOW, SETTING)).toMatchObject({ active: true }); }
  finally { hook.mockRestore(); }
});

test("a foreign recovery archive appearing after selection invalidates sweep eligibility", () => {
  const memory = seed(0), template = memory.get("r:" + ID) as RoleMemoryRule;
  memory.boundedPatch(2, tx => {
    const row = tx.get("s:" + SCOPE) as RoleMemoryScopeRow;
    tx.put({ ...row, active: [] });
  });
  const original = source.budgetArchiveCandidates;
  let changed = false;
  const hook = spyOn(source, "budgetArchiveCandidates").mockImplementation((...args) => {
    const rows = original(...args);
    if (!changed) {
      changed = true;
      memory.boundedPatch(2, tx => tx.put({ ...template, id: "r_recovery", scope: "role:other-project:builder", state: "archived", reason: "budget" }));
    }
    return rows;
  });
  try { expect(store.curationStatus(PROJECT, NOW, SETTING)).toMatchObject({ active: true, urgent: true }); }
  finally { hook.mockRestore(); }
});

test("an import batch consumed before completion is validated against its actual selection", async () => {
  const memory = seed(0);
  memory.boundedPatch(2, tx => {
    const row = tx.get("s:" + SCOPE) as RoleMemoryScopeRow;
    tx.put({ ...row, active: [] });
  });
  const candidate = importCandidate(1, { curationProject: PROJECT, suggestedScope: "project:" + PROJECT });
  candidate.occurrences[0].project = PROJECT;
  await seedImport([candidate], PROJECT);
  const original = imports.selectImportBatch;
  let changed = false;
  const hook = spyOn(imports, "selectImportBatch").mockImplementation(project => {
    const batch = original(project);
    if (!changed) { changed = true; chooseSource("engines"); }
    return batch;
  });
  // A real SQLite peer commit makes the outer version observer request
  // validation even though the selection change itself is file-backed.
  const query = Database.prototype.query;
  const db = new Database(path.join(dir, "state.sqlite"));
  db.exec("CREATE TABLE noise(value INTEGER); INSERT INTO noise VALUES(0)");
  const observation = spyOn(Database.prototype, "query").mockImplementation((function(this: Database, sql: string, ...args: unknown[]) {
    const statement = query.call(this, sql, ...args as []);
    if (sql.trim() !== "PRAGMA data_version") return statement;
    return new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === "get") return (...args: unknown[]) => {
        const result = value.apply(target, args); db.exec("UPDATE noise SET value=value+1"); return result;
      };
      return typeof value === "function" ? value.bind(target) : value;
    } });
  }) as typeof Database.prototype.query);
  try {
    expect(store.curationStatus(PROJECT, NOW, SETTING)).toMatchObject({ active: false, due: false });
    expect(changed).toBe(true);
  } finally { observation.mockRestore(); hook.mockRestore(); db.close(); }
});

for (const stop of ["cancel", "deadline"] as const) test(stop + " during dependency validation releases the paused history cursor", async () => {
  seed();
  const controller = new AbortController(), reason = Error("validation cancelled");
  let now = 0, validating = false;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const originalYield = cooperative.yieldToRuntime, originalRows = source.curationRowRevisionSteps;
  const waiting = spyOn(cooperative, "yieldToRuntime").mockImplementation(async () => {
    await originalYield();
    if (validating) return;
    recordLessonRequest({ project: "other-project", pipelineId: "validation-noise", stageId: "build", attempt: 1,
      roleId: "builder", conversationId: "noise-conversation", at: AT });
    validating = true;
  });
  const checking = spyOn(source, "curationRowRevisionSteps").mockImplementation(function* (...args) {
    if (validating && !args[1]) {
      if (stop === "cancel") controller.abort(reason); else now = 5001;
    }
    return yield* originalRows(...args);
  });
  try {
    const read = store.curationStatusCooperatively(PROJECT, NOW, SETTING, controller.signal);
    if (stop === "cancel") await expect(read).rejects.toBe(reason);
    else await expect(read).rejects.toThrow("timed out");
    expect(validating).toBe(true);
  } finally { checking.mockRestore(); waiting.mockRestore(); clock.mockRestore(); }
  checkpoint();
  expect((await store.curationStatusCooperatively(PROJECT, NOW, SETTING)).newLessons).toBe(1024);
});

test("a restarted panel cannot reuse counts derived from an older pass record", async () => {
  seed();
  const pass = store.claimPass({ project: PROJECT, repoDir: null, now: NOW, setting: SETTING })!;
  const collection = store.curationCollection()!, get = collection.get.bind(collection);
  let reads = 0, changed = false;
  const hook = spyOn(collection, "get").mockImplementation(key => {
    const row = get(key);
    // Panel selection reads the pass twice; count reconstruction reads it next.
    if (key === "r:" + pass.id && ++reads === 3) {
      changed = true;
      store.patchPass(pass.id, { counts: { ...pass.counts, calls: 7 } });
    }
    return row;
  });
  try {
    const answer = await store.curationPanelDataCooperatively(PROJECT, NOW, SETTING);
    expect(changed).toBe(true);
    expect(answer).toMatchObject({ runs: { live: { counts: { calls: 7 } } } });
    expect(store.readPass(pass.id)?.counts.calls).toBe(7);
  } finally { hook.mockRestore(); }
});

async function terminalValidationRead(surface: "status" | "route", change: "membership" | "unrelated" | "cancel" | "deadline") {
  const memory = seed(0);
  chooseSource("active");
  writeSeatTickSettings(PROJECT, { ...defaultSeatTickSettings(PROJECT), enabled: true });
  const controller = new AbortController();
  const read = async () => surface === "status"
    ? store.curationStatusCooperatively(PROJECT, NOW, SETTING, controller.signal)
    : (await (await GET(request(controller.signal))).json()).curation;
  const writer = new Database(path.join(dir, "state.sqlite"));
  writer.exec("CREATE TABLE terminal_noise(value INTEGER); INSERT INTO terminal_noise VALUES(0)");
  await read();
  let terminal = false, noise = false, validating = false, changed = false, sealing = false, virtualTime = 0;
  const version = source.curationReadVersion, rows = source.curationRowRevisionSteps;
  const yielding = cooperative.yieldToRuntime, select = imports.selectImportBatch;
  const selection = spyOn(imports, "selectImportBatch").mockImplementation((...args) => {
    const batch = select(...args); terminal = true; return batch;
  });
  const observation = spyOn(source, "curationReadVersion").mockImplementation(() => {
    if (terminal && !noise) { noise = true; writer.exec("UPDATE terminal_noise SET value=value+1"); }
    return version();
  });
  const checking = spyOn(source, "curationRowRevisionSteps").mockImplementation(function* (...args) {
    if (noise) {
      validating = true;
      if (changed && (change === "cancel" || change === "deadline")) {
        sealing = true;
        if (change === "cancel") controller.abort(Error("terminal seal cancelled"));
        else virtualTime = 10_000;
      }
    }
    return yield* rows(...args);
  });
  // Select the existing slice boundary, then freeze the virtual clock once
  // the peer write lands. The clock selects the race boundary without measuring latency.
  const clock = spyOn(performance, "now").mockImplementation(() => changed ? virtualTime : (virtualTime += 9));
  const waiting = spyOn(cooperative, "yieldToRuntime").mockImplementation(async () => {
    await yielding();
    if (!validating || changed) return;
    changed = true;
    if (change === "membership") memory.boundedPatch(2, tx => {
      const row = tx.get("s:" + SCOPE) as RoleMemoryScopeRow;
      tx.put({ ...row, revision: row.revision + 1, active: [] });
    });
    else writer.exec("UPDATE terminal_noise SET value=value+1");
  });
  try { return await read(); }
  finally {
    waiting.mockRestore(); clock.mockRestore(); checking.mockRestore(); observation.mockRestore(); selection.mockRestore(); writer.close();
    expect(changed).toBe(true);
    if (change === "cancel" || change === "deadline") expect(sealing).toBe(true);
    checkpoint();
  }
}

for (const surface of ["status", "route"] as const) {
  test(surface + " rejects a membership change during terminal validation", async () => {
    const result = await terminalValidationRead(surface, "membership");
    if (surface === "status") {
      expect(result).toMatchObject({ active: false, due: false, nextAt: null });
      expect(store.claimPass({ project: PROJECT, repoDir: null, now: NOW, setting: SETTING })).toBeNull();
    } else expect(result).toMatchObject({ waitingOn: "no-rules", nextRunAt: null, runsError: null });
  });
  test(surface + " accepts unrelated commits during terminal validation", async () => {
    const result = await terminalValidationRead(surface, "unrelated");
    if (surface === "status") expect(result).toMatchObject({ active: true, due: true, nextAt: AT });
    else expect(result).toMatchObject({ waitingOn: null, nextRunAt: AT, runsError: null });
  });
}
test("the terminal seal preserves cancellation", async () => {
  await expect(terminalValidationRead("status", "cancel")).rejects.toThrow("terminal seal cancelled");
});
test("the terminal seal uses the original deadline", async () => {
  await expect(terminalValidationRead("status", "deadline")).rejects.toThrow("timed out");
});
