import fs from "node:fs";
import path from "node:path";
import { statePath } from "@/lib/configDir";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { defaultSeatTickSettings, writeSeatTickSettings } from "@/lib/monitor/seatTickSettings";
import { curationCollection, type CuratorPass } from "../curation/store";
import { importCandidate } from "./import";
import { roleMemoryCollection } from "../roleStore";
import type { RoleMemoryRule } from "../roleTypes";
import { writeImportRows } from "../importStore";
import { setMemorySyncInterval } from "../importSync";
import type { ImportRecord } from "../importTypes";
import type { MemorySourceFile } from "../source";

/* Every state the Settings row of the memory source switch draws
   (memory-source-switch.md §3.4, §4.9), seeded as real state in a private
   state directory so a driver reads them through the real
   `GET /api/memory/source`. The counts are the design's real sizes: 566
   files (500 Claude topic files and 66 Codex summary bullets), seven of them
   longer than one part. `pressed` and `refused` are the row's own press over
   the unchosen and the Delegatus states; the driver holds or refuses the write. */
export const MEMORY_SOURCE_FRAME_STATES = [
  "unchosen", "unchosen-failed", "preparing", "importing", "importing-held", "draining", "draining-last-held", "draining-held", "active",
  "active-undone", "active-partly-undone",
  "engines", "engines-sync-off", "engines-sync-failed", "engines-sync-capped", "engines-sync-hourly-never", "read-failed", "pressed", "refused",
] as const;
export type MemorySourceFrameState = typeof MEMORY_SOURCE_FRAME_STATES[number];

/** The row's state attribute each frame must show. */
export const MEMORY_SOURCE_FRAME_ROW: Record<MemorySourceFrameState, string> = {
  unchosen: "unchosen", "unchosen-failed": "unchosen", preparing: "preparing", importing: "importing", "importing-held": "importing", draining: "draining",
  "draining-last-held": "draining", "draining-held": "draining", active: "active", "active-undone": "active", "active-partly-undone": "active", engines: "engines", "engines-sync-off": "engines", "engines-sync-failed": "engines",
  "engines-sync-capped": "engines", "engines-sync-hourly-never": "engines", "read-failed": "unknown", pressed: "preparing", refused: "active",
};
/** Where the switch stands in each frame: on for every Delegatus phase and both presses' frames, off otherwise; a failed first read draws it off. */
export const MEMORY_SOURCE_FRAME_ON: Record<MemorySourceFrameState, boolean> = Object.fromEntries(MEMORY_SOURCE_FRAME_STATES.map((state) =>
  [state, ["preparing", "importing", "draining", "active"].includes(MEMORY_SOURCE_FRAME_ROW[state])])) as Record<MemorySourceFrameState, boolean>;

const PROGRESS = { files: 566, parts: 575, pendingFiles: 446, pendingParts: 455, pendingLoadedParts: 231, adopted: 80, dropped: 40 };
const FRAME_HOST = "frame-host";
const DONE = { ...PROGRESS, pendingFiles: 0, pendingParts: 0, pendingLoadedParts: 0, adopted: 371, dropped: 195 };

/** Writes the state's source file and import record; the source and sync caches are dropped so the next read sees them. */
export async function seedMemorySourceState(state: MemorySourceFrameState, now = Date.now()): Promise<void> {
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  const id = `frame-${state}`;
  const record = (patch: Partial<ImportRecord>): ImportRecord => ({ kind: "import", id, state: "ready", at: at(300), previous: null,
    backup: statePath(`backups/engine-memory/${id}`), files: 566, candidates: 566, parts: 575, ...patch });
  const source = (value: MemorySourceFile | null) => {
    const file = statePath("memory-source.json");
    if (value) writeJsonDurably(file, value); else fs.rmSync(file, { force: true });
    (globalThis as { __delegatusMemorySource?: unknown }).__delegatusMemorySource = undefined;
  };
  const delegatus = (phase: "importing" | "draining" | "active"): MemorySourceFile => ({ schemaVersion: 1, source: "delegatus", phase, changedAt: at(300), importId: id, importStartedAt: at(300),
    ...(phase !== "importing" ? { flippedAt: at(60) } : {}), ...(phase === "active" ? { drainedAt: at(20) } : {}) });
  /* The admission holds: seat wakes off for the host project, and the automatic update draining. */
  writeSeatTickSettings(FRAME_HOST, { ...defaultSeatTickSettings(FRAME_HOST), enabled: state !== "importing-held" });
  const drain = statePath("self-update", "auto-drain.json");
  if (state === "draining-held") {
    fs.mkdirSync(path.dirname(drain), { recursive: true, mode: 0o700 });
    fs.writeFileSync(drain, JSON.stringify({ id: "frame-drain", target: "frame-release", since: at(5), until: 0, persistent: true }));
  } else fs.rmSync(drain, { force: true });
  setMemorySyncInterval(state === "engines-sync-off" ? 0 : state === "engines-sync-capped" ? 6 : state === "engines-sync-hourly-never" ? 1 : 24, at(400));
  /* Only its own frame shows the failed import: elsewhere that record reads as finished. */
  await writeImportRows([{ ...record({}), id: "frame-unchosen-failed", state: state === "unchosen-failed" ? "failed" : "ready", at: at(2),
    files: 0, candidates: 0, parts: 0, ...(state === "unchosen-failed" ? { reason: "integrity" as const } : {}) }]);
  switch (state) {
    /* A failed read is the driver's own answer; the state under it is the unchosen one. */
    case "unchosen": case "pressed": case "read-failed": source(null); return;
    case "unchosen-failed": source(null); return;
    case "preparing":
      await writeImportRows([record({ state: "copying", at: at(1), files: 0, candidates: 0, parts: 0 })]);
      source(delegatus("importing"));
      return;
    case "importing":
      await writeImportRows([record({ progress: PROGRESS })]);
      source(delegatus("importing"));
      return;
    case "importing-held":
      await writeImportRows([record({ progress: PROGRESS, hostProject: FRAME_HOST })]);
      source(delegatus("importing"));
      return;
    case "draining-held":
      /* The last scan found notes the earlier agents wrote; the automatic update holds the pass that takes them in. */
      await writeImportRows([record({ progress: { ...DONE, pendingFiles: 3, pendingParts: 3, pendingLoadedParts: 3 }, hostProject: FRAME_HOST, flippedAt: at(60),
        legacyGenerations: ["fixture-generation-1", "fixture-generation-2"], remainingGenerations: ["fixture-generation-1", "fixture-generation-2"] })]);
      source(delegatus("draining"));
      return;
    case "active-undone": case "active-partly-undone": {
      /* One import pass undone: its candidate waits for the curator again, or a rule it made survives a later edit. */
      const kept = state === "active-partly-undone";
      const passId = `curate_${id}`, ruleId = `r_${"f".repeat(16)}`;
      const candidate = importCandidate(1, { importId: id, dispositions: [{ at: at(200), pass: passId, kind: "adopt", ruleIds: kept ? [ruleId] : [], occurrences: ["o_0000000000000001"], note: "Retained." }] });
      await writeImportRows([record({ progress: DONE, flippedAt: at(60), drainedAt: at(20), remainingGenerations: [] }), candidate]);
      if (kept) roleMemoryCollection(true)!.boundedPatch(1, tx => tx.put({ kind: "rule", id: ruleId, scope: "machine", rule: "Check the owner first.", why: "Recurring.", state: "active", hints: [], createdAt: at(200), changedAt: at(100),
        source: { origin: "import", project: FRAME_HOST, roleId: null, fixRound: false, candidate: candidate.id, occurrences: candidate.occurrences, engine: "claude", sha256: "b".repeat(64), importId: id } } as unknown as RoleMemoryRule));
      curationCollection(true)!.boundedPatch(1, tx => tx.put({ kind: "pass", id: passId, project: FRAME_HOST, repoDir: null, scopes: ["machine"], clientAttemptId: passId, claimedAt: at(210), state: "succeeded", endedAt: at(200),
        failure: null, conversationId: null, launchId: null, transcriptPath: null, launchedAt: null, importBatch: { importId: id, candidates: [candidate.id] }, revertedAt: at(30), skipped: kept ? [ruleId] : [],
        counts: { calls: 1, changed: 1, rewritten: 0, merged: 0, moved: 0, split: 0, archived: 0, restored: 0 } } satisfies CuratorPass));
      source(delegatus("active"));
      return;
    }
    case "draining":
      await writeImportRows([record({ progress: DONE, flippedAt: at(60), legacyGenerations: ["fixture-generation-1", "fixture-generation-2"], remainingGenerations: ["fixture-generation-1", "fixture-generation-2"] })]);
      source(delegatus("draining"));
      return;
    case "draining-last-held":
      /* The last earlier agent retired and the final scan stopped on a changed note: the line names it. */
      await writeImportRows([record({ progress: DONE, flippedAt: at(60), legacyGenerations: ["fixture-generation-1"], remainingGenerations: [], reason: "source_changed" })]);
      source(delegatus("draining"));
      return;
    case "active": case "refused":
      await writeImportRows([record({ progress: DONE, flippedAt: at(60), drainedAt: at(20), remainingGenerations: [] })]);
      source(delegatus("active"));
      return;
    case "engines": case "engines-sync-off": case "engines-sync-failed": case "engines-sync-capped": case "engines-sync-hourly-never": {
      const sync = state === "engines-sync-failed" ? { lastAt: at(90), result: "failed" as const, added: 0, reason: "interrupted" as const }
        : state === "engines-sync-capped" ? { lastAt: at(25), result: "capped" as const, added: 1 }
        : state === "engines-sync-hourly-never" ? undefined
        : { lastAt: at(180), result: "ok" as const, added: 4 };
      await writeImportRows([record({ progress: DONE, flippedAt: at(60), drainedAt: at(20), remainingGenerations: [], ...(sync ? { sync } : {}) })]);
      source({ ...delegatus("active"), source: "engines", changedAt: at(10) });
      return;
    }
  }
}
