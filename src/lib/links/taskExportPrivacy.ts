import { storedLessonRevision } from "@/lib/memory/roleStore";

// Enumerable symbols survive object spreads between page, exchange and
// response, while JSON emits none of them. Recheck at the final serializer:
// delivery and publication awaits can outlive the privacy revision we used.
const revision = Symbol.for("delegatus.task-export.privacy-revision");
export function markTaskExport<T extends object>(value: T, from: object | string): T {
  const key = typeof from === "string" ? from : (from as Record<symbol, unknown>)[revision];
  if (typeof key === "string") Object.defineProperty(value, revision, { value: key, enumerable: true });
  return value;
}
export function assertTaskExportCurrent(value: object | undefined): void {
  // Agent parts can be filtered after task parts and nested into the same wire.
  const nested = value as { push?: { agents?: object }; agents?: object } | undefined;
  if (nested?.push?.agents) assertTaskExportCurrent(nested.push.agents);
  if (nested?.agents) assertTaskExportCurrent(nested.agents);
  const key = value && (value as Record<symbol, unknown>)[revision];
  if (typeof key === "string" && storedLessonRevision() !== key) {
    throw Object.assign(new Error("Task export privacy changed; nothing was sent"), { code: "LESSON_PRIVACY_UNAVAILABLE" });
  }
}
