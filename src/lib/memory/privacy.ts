import { runPrivacyWork } from "@/lib/links/taskPageWorker";
import { RoleMemoryRefusal } from "./roleStore";
import type { PrivacyRequest, RenderReportInput, RenderReportResult, IssueReportFinding } from "./privacyWork";
import type { PublicDenyList } from "@/lib/bridge/publicSafe";

async function run<T>(request: PrivacyRequest): Promise<T> {
  try { return (await runPrivacyWork(request)).value as T; }
  catch { throw new RoleMemoryRefusal("LESSON_PRIVACY_UNAVAILABLE", "role memory could not be read or filtered; nothing was sent"); }
}
export function withoutStoredLessonsAsync<T>(value: T): Promise<T> { return run({ kind: "filter", value }); }
export function renderReportAsync(input: RenderReportInput): Promise<RenderReportResult> {
  return run({ kind: "report", input: { ...input, at: input.at.toISOString() } });
}
export function scrubIssueReportAsync(report: { title: string; body: string }, deny: PublicDenyList): Promise<IssueReportFinding[]> {
  return run({ kind: "issue", report, deny });
}

/** Import curation publishes its known values before acknowledging the write. */
export function refreshCurationKnownValuesAsync(): Promise<void> { return run<void>({ kind: "curation-known-values" }); }
