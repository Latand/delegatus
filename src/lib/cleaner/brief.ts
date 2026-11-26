import { formatDiskBytes, type DiskPressure } from "@/lib/state/diskPressure";
import type { CleanerDiskEvidence, CleanerRun } from "./store";

export function cleanerDiskEvidence(pressure: DiskPressure | null): CleanerDiskEvidence {
  return {
    volumes: (pressure?.volumes ?? []).slice(0, 20).map(({ roles, freeBytes, totalBytes, level }) => ({ roles, freeBytes, totalBytes, level })),
    categories: (pressure?.categories ?? pressure?.consumers.map(row => ({ name: row.kind, bytes: row.bytes })) ?? []).slice(0, 40),
  };
}

export function cleanerBrief(run: CleanerRun, previous: CleanerRun | null): string {
  const bytes = (value: number | null | undefined) => value == null ? "unknown" : formatDiskBytes(value);
  return [
    "Review reclaimable temporary work using the proof rules in docs/design/cleaner-agent.md. Inspect and report the candidates.",
    `Run ${run.runId}. Trigger ${run.trigger}. Mode ${run.mode}.`,
    "Volumes at claim (free / total)",
    ...run.evidence.volumes.map(row => `- ${row.roles.join(", ")} · ${bytes(row.freeBytes)} / ${bytes(row.totalBytes)} · ${row.level}`),
    "Measured categories",
    ...run.evidence.categories.map(row => `- ${row.name} · ${bytes(row.bytes)}`),
    previous ? `Previous run ${previous.trigger} · ${previous.failure?.kind ?? previous.report?.verdict ?? "settled"} · ${previous.report?.kept.length ?? 0} kept` : "First cleaner run.",
    "End with a fenced JSON report containing verdict (pass, fail or needs_decision), kept (an array of items with target and reason), and notes (a string).",
  ].join("\n");
}
