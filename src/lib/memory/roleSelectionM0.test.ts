import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { selectionCorpus, localSelectionProvider, corpusRule, CORPUS_PROJECT } from "./roleSelectionCorpus.fixture";
import expected from "./roleSelectionCorpus.expected.json";
import { selectRoleMemory } from "./roleSelect";
import * as rendering from "./roleRender";
import { learnedRulesSnapshot, roleMemoryCollection } from "./roleStore";
import { persistProjectAliases } from "@/lib/projects/aliases";
import { statePath } from "@/lib/configDir";
import type { RoleMemoryRow } from "./roleTypes";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "selection-m0-"));
const previous = process.env.LLV_STATE_DIR;
const { learnedRulesByteCounter, renderLearnedRulesSelection } = rendering;
let generation = 0;
process.env.LLV_STATE_DIR = path.join(root, "initial");
beforeEach(() => { process.env.LLV_STATE_DIR = path.join(root, String(++generation)); });
afterAll(() => {
  if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
  fs.rmSync(root, { force: true, recursive: true });
});

for (const pinned of expected) test(`the pre-M0 corpus is unchanged: ${pinned.size} rules, wide=${pinned.wide}`, async () => {
  const { scopes, brief } = selectionCorpus(pinned.size, pinned.wide);
  let turns = 0;
  let escaped = false;
  const turn = setImmediate(() => { escaped = true; });
  let result;
  try {
    result = await selectRoleMemory(scopes, brief, { provider: localSelectionProvider,
      cooperative: { now: () => 0, turn: async () => { turns++; } } });
  } finally { clearImmediate(turn); }
  const ids = new Set(result.shadowIds);
  const rendered = renderLearnedRulesSelection(scopes.map(scope => ({ ...scope, rules: scope.rules.filter(rule => ids.has(rule.id)) })));
  const actual: typeof pinned = { size: pinned.size, wide: pinned.wide, selector: result.selector, reason: result.reason,
    shadowIds: result.shadowIds, scores: result.scores, bytes: Buffer.byteLength(rendered.block), sha256: createHash("sha256").update(rendered.block).digest("hex") };
  expect(actual).toEqual(pinned);
  expect(turns).toBe(0);
  expect(escaped).toBe(false);
});

test("scoring and packing share 32 ms slices and exclude time waiting for a turn", async () => {
  const { scopes, brief } = selectionCorpus(100);
  let clock = 0;
  const turns: number[] = [];
  const result = await selectRoleMemory(scopes, brief, { provider: localSelectionProvider, cooperative: {
    now: () => ++clock,
    turn: async () => { turns.push(clock); clock += 1000; },
  } });
  expect(result.shadowIds).toEqual(expected[0].shadowIds);
  // 95 documents + 95 scores + 100 pack visits. No phase resets the slice.
  expect(turns).toHaveLength(Math.floor(290 / 32));
  expect(turns[0]).toBe(33);
  expect(turns.slice(1).map((at, i) => at - turns[i])).toEqual(Array(8).fill(1033));
});

test("cancellation while awaiting a slice stops before the next rule", async () => {
  const { scopes, brief } = selectionCorpus(100);
  const controller = new AbortController();
  let clock = 0, turns = 0, keys = 0;
  const result = await selectRoleMemory(scopes, brief, { signal: controller.signal,
    provider: { ...localSelectionProvider, async readKey() { keys++; return null; } },
    cooperative: { now: () => clock += 32, turn: async () => { turns++; controller.abort(); } } });
  expect(result).toMatchObject({ selector: "whole", reason: "selector-timeout", shadowIds: [] });
  expect(turns).toBe(1); expect(keys).toBe(0);
});

test("cancellation on the shared slice at packing entry sends no provider work", async () => {
  const { scopes, brief } = selectionCorpus(100);
  const controller = new AbortController();
  let checkpoints = 0, turns = 0, keys = 0;
  const result = await selectRoleMemory(scopes, brief, { signal: controller.signal,
    provider: { ...localSelectionProvider, async readKey() { keys++; return null; } },
    cooperative: { now: () => ++checkpoints <= 191 ? 0 : 32, turn: async () => { turns++; controller.abort(); } } });
  expect(checkpoints).toBe(192); // Initial clock + 95 documents + 95 scores + pack entry.
  expect(result).toMatchObject({ selector: "whole", reason: "selector-timeout", shadowIds: [] });
  expect(turns).toBe(1); expect(keys).toBe(0);
});

test("provider packing checks the deadline even before a timer can run", async () => {
  const { scopes, brief } = selectionCorpus(100);
  let clock = 0, decided = false;
  const now = spyOn(performance, "now").mockImplementation(() => clock);
  try {
    const result = await selectRoleMemory(scopes, brief, {
      cooperative: { now: () => { if (decided) clock = 3001; return clock; } },
      provider: { id: "fixture", model: "fixture", async readKey() { return "fixture"; }, prepare(input) {
        return { ceilingUsd: 0.0001, requestDigest: "fixture",
          async admit() { return { status: "admitted", httpStatus: 200, limit: null, remaining: null, ceilingUsd: 0.0001 }; },
          async decide() { decided = true; return input.rules.map(() => 0.5); },
        };
      } },
    });
    expect(result).toMatchObject({ selector: "bm25", reason: "jev-timeout,bm25" });
    expect(result.evidence?.phase).toBe("pack-jev");
    expect(result.shadowIds).toEqual(expected[0].shadowIds);
  } finally { now.mockRestore(); }
});

test("incremental bytes match rendering through count boundaries, empty scopes and duplicate ids", () => {
  const { scopes } = selectionCorpus(650, true);
  const duplicate = scopes[0].rules[0];
  const input = [...scopes, { scope: "machine", rules: [duplicate] }];
  const ids = new Set<string>();
  const counter = learnedRulesByteCounter(input, ids);
  const bytes = () => Buffer.byteLength(renderLearnedRulesSelection(input.map(scope => ({ ...scope, rules: scope.rules.filter(rule => ids.has(rule.id)) }))).block);
  expect(counter.bytes).toBe(bytes());
  for (const rule of scopes.flatMap(scope => scope.rules)) {
    expect(counter.add(rule.id, Infinity)).toBe(true); ids.add(rule.id);
    expect(counter.bytes).toBe(bytes());
  }
  const fresh = learnedRulesByteCounter(input, new Set());
  const before = fresh.bytes;
  expect(fresh.add(duplicate.id, before)).toBe(false);
  expect(fresh.bytes).toBe(before);
  expect(fresh.add(duplicate.id, Infinity)).toBe(true);
});

test("a launch touches only its keyed scopes and active rules with 1,000 or 100,000 foreign rows", () => {
  const scope = `role:${CORPUS_PROJECT}:builder`;
  const scopeRow = (scope: string, active: string[] = []): RoleMemoryRow => ({ kind: "scope", scope, active, revision: 7, history: [] });
  const rule = corpusRule(1, scope);
  const store = roleMemoryCollection(true)!;
  store.boundedPatch(4, tx => { tx.put(rule); tx.put(scopeRow(scope, [rule.id])); });
  const parse = JSON.parse;
  const observed: number[] = [];
  for (const [from, through] of [[0, 1000], [1000, 100000]]) {
    // Seeding is outside the observed read and keeps no in-memory whole snapshot.
    for (let i = from; i < through; i += 500) store.boundedPatch(500, tx => {
      for (let n = i; n < Math.min(i + 500, through); n++) tx.put(scopeRow(`role:foreign-${n}:builder`));
    });
    let memberships = 0;
    const get = spyOn(store, "get");
    const json = spyOn(JSON, "parse").mockImplementation(((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
      if (text.startsWith('["scope",')) memberships++;
      return parse(text, reviver);
    }) as typeof JSON.parse);
    try {
      const snapshot = learnedRulesSnapshot(CORPUS_PROJECT, "builder");
      expect(snapshot.rules.map(rule => rule.id)).toEqual([rule.id]);
      expect(get.mock.calls.map(call => call[0])).toEqual([`r:${rule.id}`]);
      observed.push(memberships);
    } finally { json.mockRestore(); get.mockRestore(); }
  }
  expect(observed).toEqual([1, 1]);
  const db = new Database(statePath("state.sqlite"), { readonly: true });
  try {
    const plan = db.query<{ detail: string }, [string]>(`EXPLAIN QUERY PLAN SELECT s.value_json FROM json_each(?) wanted CROSS JOIN state_rows s
      WHERE s.collection='role_memory' AND s.row_key='s:' || wanted.value`).all(JSON.stringify([scope]));
    expect(plan.some(row => /SEARCH s .*\(collection=\? AND row_key=\?\)/.test(row.detail))).toBe(true);
  } finally { db.close(); }
});

test("aliased scope rows retain stored order, revisions and current active eligibility", () => {
  const old = `role:old-selection:builder`, current = `role:${CORPUS_PROJECT}:builder`;
  expect(persistProjectAliases([
    { source: "old-selection", target: "middle-selection", displayName: "Synthetic project" },
    { source: "middle-selection", target: CORPUS_PROJECT, displayName: "Synthetic project" },
  ])).toBe(true);
  const store = roleMemoryCollection(true)!;
  const active = corpusRule(2, old), archived = { ...corpusRule(3, old), state: "archived" as const }, version = { ...corpusRule(4, old), versionOf: active.id };
  store.boundedPatch(6, tx => {
    tx.put(corpusRule(1, current));
    tx.put({ kind: "scope", scope: current, revision: 7, active: [corpusRule(1, current).id], history: [] });
    tx.put(active); tx.put(archived); tx.put(version);
    tx.put({ kind: "scope", scope: old, revision: 9, revisionScope: old, active: [active.id, archived.id, version.id, "missing"], history: [] });
  });
  const snapshot = learnedRulesSnapshot("old-selection", "builder");
  expect(snapshot.scopes.find(scope => scope.scope === current)?.revisions).toEqual([
    { scope: current, revision: 7, revisionScope: current }, { scope: old, revision: 9, revisionScope: old },
  ]);
  expect(snapshot.rules.map(rule => rule.id)).toEqual([active.id, corpusRule(1, current).id]);
});

test("a malformed foreign scope is untouched; a malformed readable scope refuses the read", () => {
  const store = roleMemoryCollection(true)!;
  store.boundedPatch(1, tx => { tx.put({ kind: "scope", scope: "role:foreign:builder", active: null } as never); });
  expect(learnedRulesSnapshot(CORPUS_PROJECT, "builder").rules).toEqual([]);
  store.boundedPatch(1, tx => { tx.put({ kind: "scope", scope: `role:${CORPUS_PROJECT}:builder`, active: null } as never); });
  expect(() => learnedRulesSnapshot(CORPUS_PROJECT, "builder")).toThrow("role_memory SQLite row is malformed");
});
