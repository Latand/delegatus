import readline from "node:readline";
import { TaskPageBuilder, type PageBuildRequest } from "./links/taskPageBuild";

import { observeLessonPrivacyPhase, storedLessonPatterns, storedLessonRevision, hasStoredLesson, withoutStoredLessonsIn } from "./memory/roleStore";
import { renderReport } from "./bridge/reportRender";
import { lessonPattern } from "./memory/roleConsolidate";
import { EMPTY_DENY_LIST } from "./bridge/publicSafe";
import { scrubIssueReport } from "./issueReports/scrub";
import type { PrivacyRequest } from "./memory/privacyWork";
import { performanceSpans } from "./performanceSpans";

const builder = new TaskPageBuilder();
const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  let id: unknown;
  try {
    const frame = JSON.parse(line) as { id: number; request: PageBuildRequest | PrivacyRequest };
    id = frame.id;
    const cpu = process.cpuUsage();
    let previousPhase: string | undefined;
    observeLessonPrivacyPhase(phase => {
      if (phase !== previousPhase) process.stdout.write(`${JSON.stringify({ id, phase })}\n`);
      previousPhase = phase;
    });
    if (["filter", "report", "issue"].includes(frame.request.kind)) {
      const request = frame.request as PrivacyRequest;
      const privacyRevision = storedLessonRevision();
      let value: unknown;
      if (request.kind === "filter") value = withoutStoredLessonsIn(request.value, { requireComplete: true });
      else {
        const deny = (request.kind === "report" ? request.input.deny : request.deny) ?? EMPTY_DENY_LIST;
        // The worker always checks authoritative lessons. Explicit deny-list
        // lessons supplement them and cannot disable the stored privacy fence.
        withoutStoredLessonsIn(null, { requireComplete: true });
        const localDeny = request.kind === "report"
          ? { ...deny, hasLesson: hasStoredLesson }
          : { ...deny, lessonPatterns: [...storedLessonPatterns(), ...(deny.lessons ?? []).flatMap(text => {
            const pattern = lessonPattern(text); return pattern ? [pattern] : [];
          })] };
        process.stdout.write(`${JSON.stringify({ id, phase: "match" })}\n`);
        value = performanceSpans.sync("privacy.match", () => request.kind === "report"
          ? renderReport({ ...request.input, at: new Date(request.input.at), deny: localDeny })
          : scrubIssueReport(request.report, localDeny));
      }
      if (storedLessonRevision() !== privacyRevision) throw new Error("LESSON_PRIVACY_UNAVAILABLE");
      process.stdout.write(`${JSON.stringify({ id, result: { privacyRevision, value } })}\n`);
      continue;
    }
    const result = builder.build(frame.request as PageBuildRequest);
    const cpuUsed = process.cpuUsage(cpu);
    process.stdout.write(`{"id":${JSON.stringify(id)},"result":{"page":${result.pageJson},"privacyRevision":${JSON.stringify(result.privacyRevision)},"builds":${result.builds},"startRevision":${result.startRevision},"cpu":${JSON.stringify(cpuUsed)}}}\n`);
  } catch {
    // Store errors may contain task text or paths. Carry only the error class.
    process.stdout.write(`${JSON.stringify({ id, error: "LESSON_PRIVACY_UNAVAILABLE" })}\n`);
  }
}
