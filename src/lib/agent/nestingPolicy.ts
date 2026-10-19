import fs from "node:fs";
import { smallStore } from "@/lib/state/smallStore";

import { statePath } from "@/lib/configDir";

export const SPAWN_NESTING_SCHEMA_VERSION = 1;

/** Conservative default (#393): operator roots at depth 0, their delegates at
    depth 1, and one more helper generation at depth 2. */
export const DEFAULT_MAX_AGENT_NESTING_DEPTH = 2;
export const MIN_AGENT_NESTING_DEPTH = 1;
export const MAX_AGENT_NESTING_DEPTH = 4;

export interface SpawnNestingPolicy {
  maxAgentNestingDepth: number;
}

interface SpawnNestingPolicyFile extends SpawnNestingPolicy {
  schemaVersion: typeof SPAWN_NESTING_SCHEMA_VERSION;
}

const policyFile = () => statePath("spawn-nesting.json");

export function validMaxAgentNestingDepth(value: unknown): value is number {
  return Number.isInteger(value)
    && (value as number) >= MIN_AGENT_NESTING_DEPTH
    && (value as number) <= MAX_AGENT_NESTING_DEPTH;
}

const defaultPolicy = (): SpawnNestingPolicy => ({ maxAgentNestingDepth: DEFAULT_MAX_AGENT_NESTING_DEPTH });

function parsePolicy(value: unknown): SpawnNestingPolicy {
  const raw = (value ?? {}) as Partial<SpawnNestingPolicyFile>;
  return raw.schemaVersion === SPAWN_NESTING_SCHEMA_VERSION && validMaxAgentNestingDepth(raw.maxAgentNestingDepth)
    ? { maxAgentNestingDepth: raw.maxAgentNestingDepth } : defaultPolicy();
}

export const nestingPolicyStore = smallStore<SpawnNestingPolicy>({
  collection: "spawn_nesting", empty: defaultPolicy, parse: parsePolicy,
  toRows: value => [{ key: "policy", value }],
  fromRows: rows => rows[0] ? parsePolicy({ schemaVersion: SPAWN_NESTING_SCHEMA_VERSION, ...(rows[0].value as SpawnNestingPolicy) }) : defaultPolicy(),
  toFile: policy => ({ schemaVersion: SPAWN_NESTING_SCHEMA_VERSION, ...policy }),
  readLegacy: file => {
    try { return parsePolicy(JSON.parse(fs.readFileSync(file, "utf8"))); }
    catch { return defaultPolicy(); }
  },
});

export function loadSpawnNestingPolicy(): SpawnNestingPolicy {
  return nestingPolicyStore.read(policyFile());
}

export function saveSpawnNestingPolicy(policy: SpawnNestingPolicy): void {
  if (!validMaxAgentNestingDepth(policy.maxAgentNestingDepth)) {
    throw new Error(`maxAgentNestingDepth must be an integer between ${MIN_AGENT_NESTING_DEPTH} and ${MAX_AGENT_NESTING_DEPTH}`);
  }
  nestingPolicyStore.mutate(policyFile(), () => ({ next: policy, result: undefined }));
}
