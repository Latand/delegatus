import { redactBounded } from "@/lib/monitor/redact";
import type { CleanerRun } from "./store";

export type CleanerReport = {
  verdict: "pass" | "fail" | "needs_decision";
  kept: { target: string; reason: string; detail?: string; bytes?: number; location?: string }[];
  notes: string;
};

export function parseCleanerReport(text: string): CleanerReport | null {
  // Only the final report is used. Agent text cannot write the removal journal.
  const tail = `\n${text.slice(-132_000)}`;
  const opening = tail.lastIndexOf("\n```json");
  if (opening === -1) return null;
  const match = /^\n```json[^\S\n]*\n([\s\S]{1,131072}?)\r?\n```\s*$/.exec(tail.slice(opening));
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]!);
    if (!value || !["pass", "fail", "needs_decision"].includes(value.verdict)
      || !Array.isArray(value.kept) || typeof value.notes !== "string") return null;
    const kept = value.kept.slice(0, 500).flatMap((row: unknown) => {
      if (!row || typeof row !== "object") return [];
      const entry = row as Record<string, unknown>;
      const target = typeof entry.target === "string" ? entry.target
        : entry.target && typeof entry.target === "object"
          ? Reflect.get(entry.target, Reflect.get(entry.target, "kind") === "container" ? "id" : "path") : null;
      if (typeof target !== "string" || typeof entry.reason !== "string") return [];
      return [{ target: redactBounded(target, 300), reason: redactBounded(entry.reason, 160),
        ...(typeof entry.detail === "string" ? { detail: redactBounded(entry.detail, 300) } : {}),
        ...(typeof entry.bytes === "number" && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 ? { bytes: entry.bytes } : {}),
        ...(typeof entry.location === "string" && /^L(?:[1-9]|10)$/.test(entry.location) ? { location: entry.location } : {}),
      }];
    });
    return { verdict: value.verdict, kept, notes: redactBounded(value.notes, 1000) };
  } catch {
    return null;
  }
}

export function cleanerCardText(run: CleanerRun, locale: "en" | "uk"): string {
  const uk = locale === "uk";
  const pressure = run.trigger.startsWith("disk-pressure:");
  const title = uk ? "Перевірка диска прибиральником" : "Cleaner disk review";
  const trigger = uk ? (pressure ? "Брак місця на диску" : "Щоденна перевірка")
    : (pressure ? "Low disk space" : "Daily check");
  const mode = uk ? "пробний режим" : "dry-run";
  return `${title}\n${trigger} · ${mode} · ${run.claimedAt}`;
}

export function cleanerCardDetails(run: CleanerRun, locale: "en" | "uk"): string {
  if (!run.settledAt) return run.trigger;
  const uk = locale === "uk";
  const outcome = run.failure ? (uk ? "Помилка" : "Failed") : (uk ? "Завершено" : "Completed");
  return [run.trigger, `${outcome} · ${run.settledAt}`,
    ...(run.failure ? [`${run.failure.kind} · ${run.failure.detail}`] : []),
    ...(run.report ? [`${uk ? "Збережено об’єктів" : "Items kept"} · ${run.report.kept.length}`, run.report.notes] : []),
  ].filter(Boolean).join("\n");
}
