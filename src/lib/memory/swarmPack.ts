import { createHash } from "node:crypto";
import { ROLE_IDS } from "@/lib/roles/types";
import { compactSensitiveText, staticSensitiveClasses } from "@/lib/privacy/staticDetectors";
import { CLEAN_ROLE_IDS } from "./eligibility";
import { ruleLine, scopeChars } from "./roleConsolidate";
import { RULE_MAX_CHARS, type RoleMemoryRule } from "./roleTypes";
import shipped from "./swarmRules.json";

export const SWARM_ROLE_BOUND = 4_000;
export const SWARM_PACK_BOUND = 36_000;
export const SWARM_ROLE_IDS = ROLE_IDS.filter(role => !CLEAN_ROLE_IDS.some(clean => clean === role));
export interface SwarmRule { id: string; role: string; rule: string; since: string; replaces?: string }
export interface SwarmPack { schemaVersion: 1; rules: SwarmRule[] }
export const swarmScope = (role: string) => `swarm:${role}`;
export const swarmRuleId = (role: string, rule: string) => `r_${createHash("sha256").update(`${role}\n${rule}`).digest("hex").slice(0, 16)}`;

/** A release input, validated before any public-text exemption can use it. */
export function validateSwarmPack(value: unknown): SwarmPack {
  const pack = value as SwarmPack;
  if (!pack || pack.schemaVersion !== 1 || Object.keys(pack).some(key => !["schemaVersion", "rules"].includes(key)) || !Array.isArray(pack.rules)) throw Error("Invalid swarm pack schema");
  const ids = new Set<string>();
  for (const entry of pack.rules) {
    if (!entry || Object.keys(entry).some(key => !["id", "role", "rule", "since", "replaces"].includes(key))
      || !SWARM_ROLE_IDS.some(role => role === entry.role)
      || typeof entry.rule !== "string" || entry.rule !== entry.rule.trim() || /[\r\n]/u.test(entry.rule)
      || !/[a-z]/i.test(entry.rule) || /\p{Script=Cyrillic}/u.test(entry.rule)
      || [...entry.rule].length > RULE_MAX_CHARS || staticSensitiveClasses(entry.rule).size
      || /\b\S+@\S+\b/u.test(entry.rule)
      || typeof entry.since !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(entry.since) || !Number.isFinite(Date.parse(entry.since)) || new Date(entry.since).toISOString().slice(0, 10) !== entry.since
      || entry.id !== swarmRuleId(entry.role, entry.rule) || ids.has(entry.id)
      || (entry.replaces !== undefined && (!/^r_[a-f0-9]{16}$/u.test(entry.replaces) || entry.replaces === entry.id))) throw Error("Invalid swarm pack entry");
    ids.add(entry.id);
  }
  if (SWARM_ROLE_IDS.some(role => scopeChars(pack.rules.filter(entry => entry.role === role).map(entry => ({ ...entry, why: "" }))) > SWARM_ROLE_BOUND)
    || [...pack.rules.map(entry => ruleLine({ ...entry, why: "" })).join("\n")].length > SWARM_PACK_BOUND) throw Error("Swarm pack exceeds its bound");
  return pack;
}

const pack = validateSwarmPack(shipped);

/** Synthetic read-only rows; these never enter the local rule collection. */
export function swarmMemoryRule(entry: SwarmRule): RoleMemoryRule {
  const at = `${entry.since}T00:00:00.000Z`;
  return { kind: "rule", id: entry.id, scope: swarmScope(entry.role), rule: entry.rule, why: "", state: "active", hints: [], createdAt: at, changedAt: at,
    source: { project: "*", pipelineId: "", stageId: "", attempt: 1, roleId: entry.role, fixRound: false, conversationId: "" } };
}
export function swarmRulesForRole(role: string): RoleMemoryRule[] {
  return pack.rules.filter(entry => entry.role === role).map(swarmMemoryRule);
}
/** Build once per privacy read, with no cross-release or mutable-state cache. */
export function publicSwarmTextMatcher(): (text: string) => boolean {
  const texts = new Set(pack.rules.map(entry => compactSensitiveText(entry.rule)).filter(text => text.length >= 4));
  return text => texts.has(compactSensitiveText(text));
}

/** A removed release entry stays public in its frozen selection. Verify both
 * its content-addressed id and the ledger hash before using the retained line. */
export function frozenSwarmRule(scope: string, id: string, digest: string, block: string): RoleMemoryRule | null {
  const role = scope.slice("swarm:".length);
  if (!SWARM_ROLE_IDS.some(eligible => eligible === role)) return null;
  const current = swarmRulesForRole(role).find(entry => entry.id === id);
  const prefix = `- [${id}] `;
  const text = current?.rule ?? block.split("\n").find(line => line.startsWith(prefix))?.slice(prefix.length);
  if (!text || [...text].length > RULE_MAX_CHARS || swarmRuleId(role, text) !== id || createHash("sha256").update(text).digest("hex") !== digest) return null;
  return current ?? swarmMemoryRule({ id, role, rule: text, since: "1970-01-01" });
}
