import { createHash } from "node:crypto";
import { statePath } from "@/lib/configDir";
import { initializeStateCollectionsAsync, SqliteStateCollection, stateCollectionsInitialized } from "@/lib/state/sqliteStateStore";
import { renderLearnedRulesSelection } from "./roleRender";
import { roleMemoryCollection, type learnedRulesSnapshot } from "./roleStore";
import type { MemoryEngineStart } from "./deliveryLedger";
import type { RoleMemoryRule } from "./roleTypes";
import metadata from "../../../package.json";
import { frozenSwarmRule } from "./swarmPack";
import { scopeKind } from "./roleScopes";
import { swarmRulesEnabled } from "./settings";
import { engineMemoryOff } from "./source";

type Attempt = NonNullable<MemoryEngineStart["attempt"]>;
type Snapshot = ReturnType<typeof learnedRulesSnapshot>;
export type SelectionRemoval = { id: string; reason: "deleted" | "unresolved"; at: string };
export interface RoleMemorySelection extends Attempt {
  createdAt: string;
  release: string;
  mode: "whole" | "bm25" | "jev";
  shadow: boolean;
  selector: "whole" | "bm25" | "jev";
  selectorVersion: string;
  reason: string;
  scopes: string[];
  block: string;
  entries: [number, string, string][];
  scores: [string, number][];
  shadowIds: string[];
  removed: SelectionRemoval[];
}
export const selectionKey = (attempt: Attempt) => JSON.stringify([attempt.pipelineId, attempt.stageId, attempt.attempt]);
const key = selectionKey;
const seed = { collection: "role_memory_selection", schemaVersion: 1, migrationId: "role-memory-selection-v1", key, loadRecords: (): RoleMemorySelection[] => [] };
function decode(value: unknown): RoleMemorySelection | null {
  if (!value || typeof value !== "object") return null;
  const row = value as RoleMemorySelection;
  const fields = ["pipelineId", "stageId", "attempt", "createdAt", "release", "mode", "shadow", "selector", "selectorVersion", "reason", "scopes", "block", "entries", "scores", "shadowIds", "removed"];
  if (Object.keys(row).length !== fields.length || fields.some(field => !(field in row))
    || typeof row.pipelineId !== "string" || typeof row.stageId !== "string" || !Number.isSafeInteger(row.attempt) || row.attempt < 1
    || !Number.isFinite(Date.parse(row.createdAt)) || typeof row.release !== "string" || !["whole", "bm25", "jev"].includes(row.mode) || typeof row.shadow !== "boolean"
    || !["whole", "bm25", "jev"].includes(row.selector) || typeof row.selectorVersion !== "string" || typeof row.reason !== "string"
    || typeof row.block !== "string" || !Array.isArray(row.scopes) || row.scopes.some(scope => typeof scope !== "string")
    || !Array.isArray(row.entries) || row.entries.some(entry => !Array.isArray(entry) || entry.length !== 3 || !Number.isInteger(entry[0]) || entry[0] < 0 || entry[0] >= row.scopes.length || typeof entry[1] !== "string" || !/^[a-f0-9]{64}$/.test(entry[2]))
    || !Array.isArray(row.removed) || row.removed.some(item => typeof item.id !== "string" || !["deleted", "unresolved"].includes(item.reason) || !Number.isFinite(Date.parse(item.at)))
    || !Array.isArray(row.shadowIds) || row.shadowIds.some(id => typeof id !== "string")
    || !Array.isArray(row.scores) || row.scores.some(score => !Array.isArray(score) || score.length !== 2 || !(row.shadow ? row.shadowIds : row.entries.map(entry => entry[1])).includes(score[0]) || !Number.isFinite(score[1]) || score[1] < 0)) return null;
  return row;
}
export function roleSelectionCollection(): SqliteStateCollection<RoleMemorySelection> | null {
  const file = statePath("state.sqlite");
  if (!stateCollectionsInitialized(file, [seed])) return null;
  return new SqliteStateCollection<RoleMemorySelection>(file, { ...seed, busyMessage: "memory selection busy", decode, clone: structuredClone, strictDecode: true });
}
export async function prepareRoleSelection(): Promise<void> {
  await initializeStateCollectionsAsync(statePath("state.sqlite"), [seed]);
}
export function memorySelection(attempt: Attempt): RoleMemorySelection | null {
  const store = roleSelectionCollection();
  try { return store?.get(key(attempt)) ?? null; }
  finally { store?.close(); }
}
export function selectionCandidate(attempt: Attempt, snapshot: Snapshot): RoleMemorySelection {
  return { ...attempt, createdAt: new Date().toISOString(), release: process.env.DELEGATUS_HOT_STATE_RELEASE_REVISION ?? process.env.LLV_HOT_STATE_RELEASE_REVISION ?? metadata.version,
    mode: "whole", shadow: false, selector: "whole", selectorVersion: "1", reason: "whole", scopes: snapshot.scopes.map(scope => scope.scope), block: snapshot.block,
    entries: snapshot.entries, scores: [], shadowIds: [], removed: [] };
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
/** Only explicit withdrawal or loss of the exact stored text changes a block.
 * Moves, rewrites and all other archives retain the first start's content. */
function withdrawn(row: RoleMemorySelection) {
  const store = roleMemoryCollection();
  const removed = [...row.removed];
  const scopes = row.scopes.map(scope => ({ scope, rules: [] as RoleMemoryRule[] }));
  const entries = row.entries.filter(([index, id, digest]) => {
    if (scopeKind(row.scopes[index] ?? "") === "swarm") {
      const exact = frozenSwarmRule(row.scopes[index], id, digest, row.block);
      if (exact) { scopes[index].rules.push(exact); return true; }
      removed.push({ id, reason: "unresolved", at: new Date().toISOString() });
      return false;
    }
    const current = store?.get(`r:${id}`);
    let reason: SelectionRemoval["reason"] | null = current?.kind === "rule" && current.reason === "deleted" ? "deleted" : null;
    const versions = current?.kind === "rule" ? [current, ...(current.versions ?? []).map(version => store?.get(`r:${version}`))] : [];
    const exact = versions.find(rule => rule?.kind === "rule" && hash(rule.rule) === digest);
    if (exact?.kind !== "rule" || !scopes[index]) reason ??= "unresolved";
    if (reason) { removed.push({ id, reason, at: new Date().toISOString() }); return false; }
    scopes[index].rules.push({ ...exact as RoleMemoryRule, id, scope: row.scopes[index] });
    return true;
  });
  return { scopes, row: entries.length === row.entries.length ? row : { ...row, block: renderLearnedRulesSelection(scopes).block, entries, removed } };
}

/** Called inside ledger admission; every contender reads the row the single
 * state transaction kept. No network or asynchronous work holds this lock. */
export function frozenSelection(candidate: RoleMemorySelection, snapshot?: Snapshot) {
  const store = roleSelectionCollection();
  if (!store) throw Error("memory selection is not prepared");
  try { return store.boundedPatch(2, tx => {
    const existing = tx.get(key(candidate));
    const { row, scopes } = withdrawn(existing ?? candidate);
    if (!existing || row !== existing) tx.put(row);
    // Consent also applies to resumed attempts. Retain the first durable
    // selection; the ledger records only the scopes delivered this time.
    const visible = scopes.filter(scope => scopeKind(scope.scope) !== "swarm" || swarmRulesEnabled());
    const entries: RoleMemorySelection["entries"] = row.entries.flatMap(([index, id, digest]) => {
      const next = visible.indexOf(scopes[index]);
      return next < 0 ? [] : [[next, id, digest] as [number, string, string]];
    });
    const delivered = { scopes: visible.map(scope => scope.scope), entries,
      block: visible.length === scopes.length ? row.block : renderLearnedRulesSelection(visible, Infinity, { engineMemoryOff: engineMemoryOff() }).block };
    return { block: delivered.block, scopes: !existing && snapshot ? snapshot.scopes.filter(scope => delivered.scopes.includes(scope.scope)) : delivered.scopes.map(scope => ({ scope, revisions: [] })),
      rules: delivered.entries.map(([, id, hash]) => ({ id, hash })), entries: delivered.entries,
      reason: existing ? "frozen" : row.reason, shadowIds: row.shadowIds, removed: row.removed };
  }); } finally { store.close(); }
}
