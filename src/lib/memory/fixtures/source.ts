import fs from "node:fs";
import { statePath } from "@/lib/configDir";
import { writeJsonDurably } from "@/lib/state/durableJson";
import type { MemorySourceFile } from "../source";

export const SOURCE_STATES = ["unchosen", "importing", "draining", "active", "engines"] as const;
export type SourceState = typeof SOURCE_STATES[number];
export const CHANGED_AT = "2026-10-17T00:00:00.000Z";
export function sourceFixture(state: SourceState): MemorySourceFile | null {
  return state === "unchosen" ? null : {
    schemaVersion: 1, source: state === "engines" ? "engines" : "delegatus", changedAt: CHANGED_AT,
    ...(state === "engines" ? {} : { phase: state, importId: "fixture-import", importStartedAt: CHANGED_AT }),
  };
}
export function chooseSource(state: SourceState): void {
  const file = statePath("memory-source.json");
  const value = sourceFixture(state);
  if (value) writeJsonDurably(file, value);
  else fs.rmSync(file, { force: true });
}
export function sourceTurnsEnginesOff(state: SourceState): boolean {
  return state === "draining" || state === "active";
}
