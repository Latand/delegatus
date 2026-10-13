import type { ReleaseInput } from "./policy";
export const hour = 3_600_000;
export function ready(): ReleaseInput {
  return { now: 24 * hour, enabled: true, requested: false, tickEnabled: true, mergeEnabled: true,
    live: false, mainVersion: "1.0.0", lastTag: { name: "v1.0.0", version: "1.0.0", at: 0 },
    registryHasTag: true, checks: "green", hold: null, draining: false, deploying: false,
    tools: [], minChanges: 30, minGapHours: 12, changes: Array.from({ length: 30 }, (_, i) => ({ subject: `Change (${i})`, files: ["src/component.ts"] })),
    deployments: [{ revision: "one", at: 0 }], isAncestor: (a, b) => a === b };
}
