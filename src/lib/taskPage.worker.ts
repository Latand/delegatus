import { PrivacyWorkError, privacyFailureOf } from "./memory/privacyFailure";
import readline from "node:readline";
import { TaskPageBuilder, type PageBuildRequest } from "./links/taskPageBuild";

import { RoleMemoryRefusal, refreshLessonKnownValues, observeLessonPrivacyPhase, storedLessonPatterns, storedLessonRevision, withoutStoredLessonsIn } from "./memory/roleStore";
import { renderReport } from "./bridge/reportRender";
import { lessonPattern } from "./memory/roleConsolidate";
import { EMPTY_DENY_LIST } from "./bridge/publicSafe";
import { scrubIssueReport } from "./issueReports/scrub";
import type { PrivacyCorrelation } from "./memory/privacyDiagnostics";
import type { PrivacyRequest } from "./memory/privacyWork";
import { performanceSpans } from "./performanceSpans";

const builder = new TaskPageBuilder();
const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  let id: unknown;
  let correlation: PrivacyCorrelation | undefined;
  try {
    const frame = JSON.parse(line) as { id: number; correlation?: PrivacyCorrelation; request: PageBuildRequest | PrivacyRequest };
    id = frame.id;
    if (frame.correlation !== undefined) {
      const opaque = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
      if (!opaque.test(frame.correlation?.requestId ?? "") || !opaque.test(frame.correlation?.jobId ?? "")) throw new PrivacyWorkError("worker-invalid-reply");
      correlation = { requestId: frame.correlation.requestId, jobId: frame.correlation.jobId };
      process.stdout.write(`${JSON.stringify({ id, correlation, phase: "started" })}\n`);
    }
    const cpu = process.cpuUsage();
    let previousPhase: string | undefined;
    observeLessonPrivacyPhase(phase => {
      if (phase !== previousPhase) process.stdout.write(`${JSON.stringify({ id, correlation, phase })}\n`);
      previousPhase = phase;
    });
    if (frame.request.kind === "curation-known-values" || frame.request.kind === "curation-undo") {
      let value: unknown = null;
      if (frame.request.kind === "curation-undo") {
        const { revertCuratorPass } = await import("./memory/curation/apply");
        try { value = revertCuratorPass(frame.request.passId, undefined, { refreshKnownValues: false }); }
        catch (error) {
          if (error instanceof RoleMemoryRefusal && ["CURATE_LIVE", "CURATE_INVALID"].includes(error.code)) {
            process.stdout.write(`${JSON.stringify({ id, correlation, curationRefusal: error.code })}\n`); continue;
          }
          throw error;
        }
      }
      process.stdout.write(`${JSON.stringify({ id, correlation, phase: "compile" })}\n`);
      // Also repairs the known-value file after a committed undo whose first
      // acknowledgement was lost. All history work stays in this leased worker.
      refreshLessonKnownValues();
      process.stdout.write(`${JSON.stringify({ id, correlation, result: { privacyRevision: storedLessonRevision(), value } })}\n`);
      continue;
    }
    if (["filter", "report", "issue"].includes(frame.request.kind)) {
      const request = frame.request as Exclude<PrivacyRequest, { kind: "curation-known-values" | "curation-undo" }>;
      const privacyRevision = storedLessonRevision();
      let value: unknown;
      if (request.kind === "filter") value = withoutStoredLessonsIn(request.value, { requireComplete: true });
      else {
        const deny = (request.kind === "report" ? request.input.deny : request.deny) ?? EMPTY_DENY_LIST;
        // An issue report goes to GitHub: the worker always checks it against
        // the authoritative lessons, and explicit deny-list lessons supplement
        // them. A manager report goes to the operator and the project's own
        // chat: it keeps every other class of the deny list and no lesson check.
        if (request.kind === "issue") withoutStoredLessonsIn(null, { requireComplete: true });
        const localDeny = request.kind === "report"
          ? deny
          : { ...deny, lessonPatterns: [...storedLessonPatterns(), ...(deny.lessons ?? []).flatMap(text => {
            const pattern = lessonPattern(text); return pattern ? [pattern] : [];
          })] };
        process.stdout.write(`${JSON.stringify({ id, correlation, phase: "match" })}\n`);
        value = performanceSpans.sync("privacy.match", () => request.kind === "report"
          ? renderReport({ ...request.input, at: new Date(request.input.at), deny: localDeny })
          : scrubIssueReport(request.report, localDeny));
      }
      if (storedLessonRevision() !== privacyRevision) throw new PrivacyWorkError("store-changed");
      process.stdout.write(`${JSON.stringify({ id, correlation, result: { privacyRevision, value } })}\n`);
      continue;
    }
    const result = builder.build(frame.request as PageBuildRequest);
    const cpuUsed = process.cpuUsage(cpu);
    process.stdout.write(`{"id":${JSON.stringify(id)},${correlation ? `"correlation":${JSON.stringify(correlation)},` : ""}"result":{"page":${result.pageJson},"builds":${result.builds},"startRevision":${result.startRevision},"cpu":${JSON.stringify(cpuUsed)}}}\n`);
  } catch (error) {
    // Store errors may contain task text or paths. Carry only the error class.
    process.stdout.write(`${JSON.stringify({ id, correlation, error: "LESSON_PRIVACY_UNAVAILABLE", failure: privacyFailureOf(error) })}\n`);
  }
}
