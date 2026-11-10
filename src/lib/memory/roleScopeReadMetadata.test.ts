import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetProjectAliasesForTests } from "@/lib/projects/aliases";
import { roleMemoryCollection, roleScope } from "./roleStore";
import { roleScopeReadMetadata } from "./roleViewSource";
import type { ScopeHistoryEntry } from "./roleTypes";

const PROJECT = "scope-metadata-fixture";
let dir: string, previous: string | undefined;
beforeEach(() => {
  resetProjectAliasesForTests();
  previous = process.env.LLV_STATE_DIR;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-scope-metadata-"));
  process.env.LLV_STATE_DIR = dir;
});
afterEach(() => {
  process.env.LLV_STATE_DIR = previous;
  if (previous === undefined) delete process.env.LLV_STATE_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
  resetProjectAliasesForTests();
});

function writeScope(scope: string, revision: number, curatedAt: string | null, history: Partial<ScopeHistoryEntry>[]) {
  roleMemoryCollection(true)!.boundedPatch(20, tx => {
    tx.put({ kind: "scope", scope, revision, active: [], ...(curatedAt ? { curatedAt } : {}), history: history as ScopeHistoryEntry[] });
  });
}

/** Statements that read a stored row body. The scope body carries the whole
 * retained history, so each such read parses all of it. */
const realQuery = Database.prototype.query;
function bodyReads<T>(work: () => T): { value: T; reads: number } {
  let reads = 0;
  const spy = spyOn(Database.prototype, "query").mockImplementation(function (this: Database, sql: string) {
    if (sql.includes("value_json")) reads++;
    return realQuery.call(this, sql);
  } as never);
  try { const value = work(); return { value, reads }; }
  finally { spy.mockRestore(); }
}

test("pages of one scope at one stored revision read its body once", () => {
  const scope = roleScope(PROJECT, "builder");
  writeScope(scope, 3, "2026-10-11T00:00:00.000Z", [
    { revision: 2, at: "2026-10-11T00:00:01.000Z", by: "curator", pass: "p_other" },
    { revision: 3, at: "2026-10-11T00:00:02.000Z", by: "curator", pass: "p_current" },
  ]);
  const first = bodyReads(() => roleScopeReadMetadata(scope, "p_current"));
  expect(first.value).toEqual({ revision: 3, curatedAt: "2026-10-11T00:00:00.000Z", hasPass: true, departuresSince: "2026-10-11T00:00:01.000Z" });
  expect(first.reads).toBe(1);
  for (let page = 0; page < 5; page++) {
    const next = bodyReads(() => roleScopeReadMetadata(scope, "p_current"));
    expect(next.value).toEqual(first.value);
    expect(next.reads).toBe(0);
  }
});

test("a changed scope row and another pass each get their own answer", () => {
  const scope = roleScope(PROJECT, "builder");
  writeScope(scope, 1, null, [{ revision: 1, at: "2026-10-11T00:00:01.000Z", by: "curator", pass: "p_one" }]);
  expect(roleScopeReadMetadata(scope, "p_two")).toEqual({ revision: 1, curatedAt: null, hasPass: false, departuresSince: "2026-10-11T00:00:01.000Z" });
  expect(roleScopeReadMetadata(scope, "p_one")).toEqual({ revision: 1, curatedAt: null, hasPass: true, departuresSince: "" });
  writeScope(scope, 2, "2026-10-11T00:00:05.000Z", [
    { revision: 1, at: "2026-10-11T00:00:01.000Z", by: "curator", pass: "p_one" },
    { revision: 2, at: "2026-10-11T00:00:05.000Z", by: "curator", pass: "p_two" },
  ]);
  expect(roleScopeReadMetadata(scope, "p_two")).toEqual({ revision: 2, curatedAt: "2026-10-11T00:00:05.000Z", hasPass: true, departuresSince: "2026-10-11T00:00:01.000Z" });
  expect(roleScopeReadMetadata(scope, "p_one")).toEqual({ revision: 2, curatedAt: "2026-10-11T00:00:05.000Z", hasPass: true, departuresSince: "2026-10-11T00:00:05.000Z" });
});

test("a scope that was never stored answers empty and is read again once it exists", () => {
  const scope = roleScope(PROJECT, "reviewer");
  writeScope(roleScope(PROJECT, "builder"), 1, null, []);
  expect(roleScopeReadMetadata(scope, "p_one")).toEqual({ revision: 0, curatedAt: null, hasPass: false, departuresSince: "" });
  writeScope(scope, 1, null, []);
  expect(roleScopeReadMetadata(scope, "p_one")).toEqual({ revision: 1, curatedAt: null, hasPass: false, departuresSince: "" });
});

test("another pass over the same stored scope row reads no body", () => {
  const scope = roleScope(PROJECT, "builder");
  writeScope(scope, 2, "2026-10-11T00:00:05.000Z", [
    { revision: 1, at: "2026-10-11T00:00:01.000Z", by: "curator", pass: "p_one" },
    { revision: 2, at: "2026-10-11T00:00:05.000Z", by: "agent" },
    { revision: 2, at: "2026-10-11T00:00:03.000Z", by: "curator" },
  ]);
  expect(bodyReads(() => roleScopeReadMetadata(scope, "p_one")).reads).toBe(1);
  const other = bodyReads(() => roleScopeReadMetadata(scope, "p_two"));
  expect(other.reads).toBe(0);
  expect(other.value).toEqual({ revision: 2, curatedAt: "2026-10-11T00:00:05.000Z", hasPass: false, departuresSince: "2026-10-11T00:00:03.000Z" });
  expect(roleScopeReadMetadata(scope, "p_one")).toEqual({ revision: 2, curatedAt: "2026-10-11T00:00:05.000Z", hasPass: true, departuresSince: "2026-10-11T00:00:03.000Z" });
});
