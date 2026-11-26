import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetProjectAliasesForTests } from "@/lib/projects/aliases";
import { roleMemoryCollection, roleScope } from "./roleStore";
import { activeRoleRuleRows, roleScopeReadMetadata } from "./roleViewSource";
import type { RoleMemoryRule, ScopeHistoryEntry } from "./roleTypes";

const PROJECT = "memory-reads-fixture";
const AT = "2026-10-11T00:00:00.000Z";
let dir: string, previous: string | undefined;
beforeEach(() => {
  resetProjectAliasesForTests();
  previous = process.env.LLV_STATE_DIR;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-memory-reads-"));
  process.env.LLV_STATE_DIR = dir;
});
afterEach(() => {
  process.env.LLV_STATE_DIR = previous;
  if (previous === undefined) delete process.env.LLV_STATE_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
  resetProjectAliasesForTests();
});

/** Bytes this thread asked the kernel for, the counter the Viewer's loop
 * monitor reports as readBytes. Linux only. */
const linux = process.platform === "linux";
function threadReadBytes(): number {
  return Number(/rchar: (\d+)/.exec(fs.readFileSync("/proc/thread-self/io", "utf8"))![1]);
}
function readBytes<T>(work: () => T): { value: T; bytes: number } {
  const before = threadReadBytes();
  const value = work();
  return { value, bytes: threadReadBytes() - before };
}

function rule(id: string, scope: string, text: string): RoleMemoryRule {
  return { kind: "rule", id, scope, rule: text, why: "fixture", state: "active", hints: [], createdAt: AT, changedAt: AT,
    source: { project: PROJECT, pipelineId: "p", stageId: "s", attempt: 1, roleId: "builder", fixRound: false, conversationId: "c" } } as RoleMemoryRule;
}
/** A curator entry with an undo payload of about `bytes`, like the retained
 * entries that make up nearly all of a long-lived scope's stored size. */
function curatorEntry(revision: number, bytes: number): ScopeHistoryEntry {
  return { revision, at: new Date(Date.parse(AT) + revision * 1000).toISOString(), by: "curator", pass: `p_${revision % 7}`,
    before: [], created: [], added: [], merged: [], archived: [],
    prior: [{ id: "r_0000000000000001", version: null, fields: { note: "n".repeat(bytes) } as never }] };
}
function storedBytes(scope: string): number {
  return Buffer.byteLength(JSON.stringify(roleMemoryCollection()!.get(`s:${scope}`)));
}

test.skipIf(!linux)("a scope's read metadata costs a few reads of its row however many entries it retains", () => {
  const scope = roleScope(PROJECT, "builder");
  const history = Array.from({ length: 400 }, (_, index) => curatorEntry(index + 1, 16_000));
  roleMemoryCollection(true)!.boundedPatch(8, tx => { tx.put({ kind: "scope", scope, revision: 400, active: [], history }); });
  const row = storedBytes(scope);
  expect(row).toBeGreaterThan(6_000_000);
  const read = readBytes(() => roleScopeReadMetadata(scope, "p_3"));
  expect(read.value).toMatchObject({ revision: 400, hasPass: true });
  expect(read.bytes).toBeLessThan(row * 3);
});

test.skipIf(!linux)("a search of active rules costs a few reads of each scope row however many entries it retains", () => {
  const scope = roleScope(PROJECT, "builder");
  const history = Array.from({ length: 400 }, (_, index) => curatorEntry(index + 1, 16_000));
  roleMemoryCollection(true)!.boundedPatch(8, tx => {
    tx.put(rule("r_00000000000000aa", scope, "Keep the amber fixture readable"));
    tx.put({ kind: "scope", scope, revision: 400, active: ["r_00000000000000aa"], history });
  });
  const row = storedBytes(scope);
  const read = readBytes(() => activeRoleRuleRows({ project: PROJECT, terms: ["amber"], limit: 10 }));
  expect(read.value.map(found => found.id)).toEqual(["r_00000000000000aa"]);
  expect(read.bytes).toBeLessThan(row * 3);
});
