import crypto from "node:crypto";

import { scopeChars } from "@/lib/memory/roleConsolidate";
import { MACHINE_SCOPE } from "@/lib/memory/roleScopes";
import type { RoleMemoryRow, RoleMemoryRule, RoleMemoryScopeRow } from "@/lib/memory/roleTypes";

import type { StoredRow } from "./stores";
import type { ScopeFigures } from "./types";

/* Learned rules into an install that may already hold some
   (docs/design/install-memory-transfer.md §4.6). Nothing is deleted and no
   rule leaves an active list:

   - a rule is matched by id; a different text under the same id is stored the
     way a rewrite stores an older text, as an archived version of the
     target's rule with a fresh id;
   - a scope the target lacks is copied with its revision and history; one it
     has gets the incoming active ids it lacks, appended, and one history
     entry by `transfer` naming them;
   - machine-scope rules (operator decision Q2) arrive active and uncurated,
     first in the machine scope's never-curated segment, so the target's next
     curation pass reads them first. */

/** A conflict carries both rows as they were before this import, for the dry run's diff (§4.5). */
export type RoleRecordOutcome = { key: string; outcome: "new" | "same" | "conflict"; action?: "stored-as-version" | "merged"; versions?: { source: RoleMemoryRow; target: RoleMemoryRow } };

export interface RoleMemoryPlan {
  outcomes: RoleRecordOutcome[];
  writes: { key: string; value: RoleMemoryRow }[];
  /** Fresh version id → the source's rule id. */
  versions: Record<string, string>;
}

const isRule = (row: unknown): row is RoleMemoryRule => !!row && typeof row === "object" && (row as RoleMemoryRule).kind === "rule" && typeof (row as RoleMemoryRule).id === "string" && typeof (row as RoleMemoryRule).rule === "string";
const isScope = (row: unknown): row is RoleMemoryScopeRow => !!row && typeof row === "object" && (row as RoleMemoryScopeRow).kind === "scope" && typeof (row as RoleMemoryScopeRow).scope === "string" && Array.isArray((row as RoleMemoryScopeRow).active) && Array.isArray((row as RoleMemoryScopeRow).history);

/** Whether a record is a rule or scope row the role memory store would accept. */
export function validRoleRecord(key: string, value: unknown): boolean {
  if (key.startsWith("r:")) return isRule(value) && key === `r:${value.id}` && typeof value.scope === "string";
  if (key.startsWith("s:")) return isScope(value) && key === `s:${value.scope}` && Number.isSafeInteger(value.revision);
  return false;
}

/** Per scope: rules written under it, active rules, active code points as the store counts them, history entries. */
export function scopeFigures(rows: Iterable<RoleMemoryRow>): Map<string, ScopeFigures> {
  const rules = new Map<string, RoleMemoryRule>();
  const scopes: RoleMemoryScopeRow[] = [];
  for (const row of rows) {
    if (row.kind === "rule") rules.set(row.id, row);
    else if (row.kind === "scope") scopes.push(row);
  }
  const counts = new Map<string, number>();
  for (const rule of rules.values()) counts.set(rule.scope, (counts.get(rule.scope) ?? 0) + 1);
  const figures = new Map<string, ScopeFigures>();
  for (const scope of scopes) {
    const active = scope.active.map(id => rules.get(id)).filter((rule): rule is RoleMemoryRule => !!rule);
    figures.set(scope.scope, { rules: counts.get(scope.scope) ?? 0, active: scope.active.length, codePoints: scopeChars(active), history: scope.history.length });
  }
  return figures;
}

function freshRuleId(taken: (id: string) => boolean, random: () => string): string {
  for (let draw = 0; draw < 64; draw += 1) {
    const id = `r_${random()}`;
    if (!taken(id)) return id;
  }
  throw new Error("no free rule id was drawn for an imported version");
}

export function planRoleMemory(
  incoming: readonly StoredRow[],
  target: ReadonlyMap<string, string>,
  context: { now: string; random?: () => string },
): RoleMemoryPlan {
  const random = context.random ?? (() => crypto.randomBytes(8).toString("hex"));
  const outcomes: RoleRecordOutcome[] = [];
  const writes = new Map<string, RoleMemoryRow>();
  const versions: Record<string, string> = {};
  const incomingKeys = new Set(incoming.map(row => row.key));
  const current = (key: string): RoleMemoryRow | null => {
    const written = writes.get(key);
    if (written) return written;
    const held = target.get(key);
    return held === undefined ? null : JSON.parse(held) as RoleMemoryRow;
  };
  const taken = (id: string) => incomingKeys.has(`r:${id}`) || target.has(`r:${id}`) || writes.has(`r:${id}`);
  /** Rules that will be active on the target after this import. */
  const activeAfter = new Set<string>();

  for (const row of incoming) {
    if (!row.key.startsWith("r:")) continue;
    const rule = row.value as RoleMemoryRule;
    const held = current(row.key);
    if (!held) {
      const arriving: RoleMemoryRule = { ...rule };
      if (arriving.scope === MACHINE_SCOPE) delete arriving.curatedAt;
      writes.set(row.key, arriving);
      outcomes.push({ key: row.key, outcome: "new" });
      if (arriving.state === "active") activeAfter.add(arriving.id);
      continue;
    }
    if (JSON.stringify(held) === JSON.stringify(rule)) {
      outcomes.push({ key: row.key, outcome: "same" });
      if (held.kind === "rule" && held.state === "active") activeAfter.add(held.id);
      continue;
    }
    if (held.kind !== "rule") throw new Error(`role memory row ${row.key} is not a rule on this install`);
    const id = freshRuleId(taken, random);
    const version: RoleMemoryRule = { ...rule, id, state: "archived", reason: "rewritten", versionOf: held.id, changedAt: context.now };
    delete version.versions;
    delete version.mergedInto;
    writes.set(`r:${id}`, version);
    writes.set(row.key, { ...held, versions: [...(held.versions ?? []), id] });
    versions[id] = rule.id;
    outcomes.push({ key: row.key, outcome: "conflict", action: "stored-as-version", versions: { source: rule, target: held } });
    if (held.state === "active") activeAfter.add(held.id);
  }

  for (const row of incoming) {
    if (!row.key.startsWith("s:")) continue;
    const scope = row.value as RoleMemoryScopeRow;
    const held = current(row.key);
    if (!held) {
      writes.set(row.key, structuredClone(scope));
      outcomes.push({ key: row.key, outcome: "new" });
      continue;
    }
    if (JSON.stringify(held) === JSON.stringify(scope)) {
      outcomes.push({ key: row.key, outcome: "same" });
      continue;
    }
    if (held.kind !== "scope") throw new Error(`role memory row ${row.key} is not a scope on this install`);
    const present = new Set(held.active);
    const added = scope.active.filter(id => !present.has(id) && activeAfter.has(id));
    if (added.length) {
      const revision = held.revision + 1;
      writes.set(row.key, {
        ...held,
        revision,
        active: scope.scope === MACHINE_SCOPE ? [...added, ...held.active] : [...held.active, ...added],
        history: [...held.history, { revision, ...(held.revisionScope ? { revisionScope: held.revisionScope } : {}), at: context.now, by: "transfer", added, merged: [], archived: [] }],
      });
    }
    outcomes.push({ key: row.key, outcome: "conflict", action: "merged", versions: { source: scope, target: held } });
  }
  return { outcomes, writes: [...writes].map(([key, value]) => ({ key, value })), versions };
}
