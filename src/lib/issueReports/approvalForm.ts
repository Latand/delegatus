import type { PrototypeQuestion, PrototypeReviewRound } from "@/lib/prototypeReview/types";

/*
 * The operator's approval of one Delegatus bug report (#2518), asked in a
 * decision form (docs/design/operator-decision-forms.md). Free of server
 * imports: the board's evidence fixture draws the same form.
 *
 * An agent's account of what the operator said proves nothing: the seat that
 * wants to publish is the one that would report the "yes". So publication
 * reads the operator's answer where Delegatus stored it, on the seat's form,
 * with the person who decided it. The seat asks with publish_prototype_review
 * and this exact form; nothing else counts.
 *
 * The form names the text it is for. Its approving option is the sentence
 * that carries the preview's whole digest, so a form for another text has
 * another option and another form, and a "yes" cannot move from the text the
 * operator read to an edited one. The digest goes whole: a prefix of it can be
 * matched by a second text found by trying wordings, and the yes for one
 * would then publish the other.
 */

export type IssueReportLanguage = "en" | "uk";

/** The form's one question. */
export const ISSUE_REPORT_QUESTION_ID = "publish-report";

/** The option that approves this exact preview, one per interface language. */
export function issueReportApprovalReplies(digest: string): Record<IssueReportLanguage, string> {
  return { en: `Yes, publish report ${digest}`, uk: `Так, публікуй звіт ${digest}` };
}

/** The decision form that asks the operator to approve one preview, in their language. */
export function issueReportApprovalForm(preview: { digest: string; title: string }, language: IssueReportLanguage): { title: string; questions: PrototypeQuestion[] } {
  const uk = language === "uk";
  return {
    title: uk ? "Опублікувати звіт про помилку?" : "Publish the bug report?",
    questions: [{
      id: ISSUE_REPORT_QUESTION_ID,
      text: uk
        ? `Опублікувати звіт «${preview.title}» без жодних змін як публічний issue в репозиторії Delegatus? Повний текст показано в чаті.`
        : `File the report «${preview.title}» exactly as previewed in chat as a public issue in the Delegatus repository?`,
      options: [
        { label: issueReportApprovalReplies(preview.digest)[language], recommended: true },
        { label: uk ? "Ні, спершу змініть текст" : "No, change the text first" },
        { label: uk ? "Ні, не публікуйте" : "No, do not publish it" },
      ],
      other: true,
    }],
  };
}

/** The language of the approval form this round asks, when it asks exactly
    the form for this preview; null for any other round. */
export function issueReportFormLanguage(round: Pick<PrototypeReviewRound, "title" | "questions" | "variants">, preview: { digest: string; title: string }): IssueReportLanguage | null {
  if (round.variants.length) return null;
  /* Field by field, so a stored round's key order cannot matter. */
  const shape = (form: { title: string; questions?: PrototypeQuestion[] }) => JSON.stringify([form.title, (form.questions ?? []).map((question) =>
    [question.id, question.text, question.multiple === true, question.other === true, question.options.map((option) => [option.label, option.recommended === true])])]);
  const asked = shape(round);
  return (["en", "uk"] as const).find((language) => shape(issueReportApprovalForm(preview, language)) === asked) ?? null;
}

/** A person chose the approving option, explicitly: a form taken on its
    recommendations, a set-aside question, «Other», a custom note and an
    agent's decision approve nothing. */
export function issueReportDecisionApproves(decision: PrototypeReviewRound["decision"]): boolean {
  if (!decision || decision.skipped || decision.rejected || decision.recommendedWithReservation) return false;
  if (decision.decidedBy?.kind !== "operator" && decision.decidedBy?.kind !== "member") return false;
  const answer = decision.answers?.find((entry) => entry.questionId === ISSUE_REPORT_QUESTION_ID);
  return Boolean(answer && !answer.skipped && !answer.other && !answer.customText
    && answer.options.length === 1 && answer.options[0] === 0);
}
