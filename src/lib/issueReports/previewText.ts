import type { IssueReportPreview } from "./store";

type PreviewText = Pick<IssueReportPreview, "digest" | "title" | "body" | "privacyJudgment" | "hints" | "hintWarnings">;
const literal = (text: string) => text.replaceAll("\n", " ↵ ").replace(/[\\`*_{}\[\]()#+.!<>|~]/g, "\\$&");

/** A chat-ready preview of the stored text with the agent's review beside it. */
export function issueReportPreviewText(preview: PreviewText): string {
  const judgment = preview.privacyJudgment;
  return [
    "PREVIEW", `Digest: ${preview.digest}`, "", preview.title, "", preview.body, "",
    "**Agent privacy judgment**",
    judgment ? `Assessment: ${judgment.assessment}\nRemoved: ${judgment.removed}\nHarmless hints and reasons: ${judgment.harmlessHints}\nUncertainties: ${judgment.uncertainties}`
      : "No agent judgment was recorded for this legacy preview. Review the whole text before approving.",
    "", "**Remaining detector hints**",
    ...(preview.hints?.length ? preview.hints.map((hint) =>
      `- ${hint.class} · ${hint.where} line ${hint.lines.join(", ")} (${hint.reading}): ${literal(hint.span.text)}`)
      : ["None detected. A clean result proves nothing; review the whole text."]),
    ...(preview.hintWarnings ?? []).map((warning) => `- ${warning}`),
    "", "You decide whether to approve this exact text. Hints do not prevent approval.",
  ].join("\n");
}
