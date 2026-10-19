import { runPrivacyWork } from "@/lib/links/taskPageWorker";
import { storedLessonRevision, RoleMemoryRefusal, ROLE_MEMORY_CHANGED_MESSAGE } from "./roleStore";
import type { PrivacyRequest, RenderReportInput, RenderReportResult, IssueReportFinding } from "./privacyWork";
import type { PublicDenyList } from "@/lib/bridge/publicSafe";

/** A revision conflict is safe to retry only before dispatch. Never carries text. */
export class RoleMemoryChanged extends RoleMemoryRefusal {
  constructor() { super("LESSON_PRIVACY_UNAVAILABLE", ROLE_MEMORY_CHANGED_MESSAGE); }
}

/** Restart from original inputs. A failed read of an unchanged store remains
 * decisive; only an observed revision change permits another privacy pass. */
export async function withCurrentRoleMemory<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const revision = storedLessonRevision();
    try {
      const value = await work();
      if (storedLessonRevision() === revision) return value;
    } catch (error) {
      if (!(error instanceof RoleMemoryRefusal) || storedLessonRevision() === revision) throw error;
    }
  }
  throw new RoleMemoryChanged();
}

async function run<T>(request: PrivacyRequest): Promise<T> {
  return withCurrentRoleMemory(async () => {
    try { return (await runPrivacyWork(request)).value as T; }
    catch { throw new RoleMemoryRefusal("LESSON_PRIVACY_UNAVAILABLE", "role memory could not be read or filtered; nothing was sent"); }
  });
}
export function withoutStoredLessonsAsync<T>(value: T): Promise<T> { return run({ kind: "filter", value }); }
export function renderReportAsync(input: RenderReportInput): Promise<RenderReportResult> {
  return run({ kind: "report", input: { ...input, at: input.at.toISOString() } });
}
export function scrubIssueReportAsync(report: { title: string; body: string }, deny: PublicDenyList): Promise<IssueReportFinding[]> {
  return run({ kind: "issue", report, deny });
}
