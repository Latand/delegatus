import { expect, test } from "bun:test";

import type { PrototypeDecision, PrototypeReviewRound } from "@/lib/prototypeReview/types";

import { ISSUE_REPORT_QUESTION_ID, issueReportApprovalForm, issueReportApprovalReplies, issueReportDecisionApproves, issueReportFormLanguage } from "./approvalForm";

/*
 * #2518: the operator approves one bug report in a decision form. The form
 * names the whole digest in its approving option, and only a person's explicit
 * choice of that option approves.
 */

const PREVIEW = { digest: "ab".repeat(32), title: "send_message answers delivered while the recipient never receives it" };
const OTHER = { digest: "cd".repeat(32), title: PREVIEW.title };

function round(form: { title: string; questions?: PrototypeReviewRound["questions"] }, variants: PrototypeReviewRound["variants"] = []): Pick<PrototypeReviewRound, "title" | "questions" | "variants"> {
  return { title: form.title, ...(form.questions ? { questions: form.questions } : {}), variants };
}

function decision(patch: Partial<PrototypeDecision>, options: number[] = [0], extra: Record<string, unknown> = {}): PrototypeDecision {
  return {
    chosen: [], comment: "", at: "2026-10-15T00:00:00.000Z", decidedBy: { kind: "operator" },
    answers: [{ questionId: ISSUE_REPORT_QUESTION_ID, options, ...extra }],
    delivery: { state: "sent", conversationId: "conversation_seat", clientMessageId: "prototype-decision:x", text: "" },
    ...patch,
  } as PrototypeDecision;
}

test("the approving option carries the whole digest, in either language", () => {
  const replies = issueReportApprovalReplies(PREVIEW.digest);
  expect(replies.en).toEndWith(PREVIEW.digest);
  expect(replies.uk).toEndWith(PREVIEW.digest);
  for (const language of ["en", "uk"] as const) {
    const form = issueReportApprovalForm(PREVIEW, language);
    expect(form.questions).toHaveLength(1);
    const [question] = form.questions;
    expect(question).toMatchObject({ id: ISSUE_REPORT_QUESTION_ID, other: true });
    expect(question!.text).toContain(PREVIEW.title);
    expect(question!.options[0]).toEqual({ label: replies[language], recommended: true });
    expect(question!.options.filter((option) => option.recommended)).toHaveLength(1);
    expect(question!.options).toHaveLength(3);
  }
});

test("a round is this preview's form only when it asks exactly that form", () => {
  expect(issueReportFormLanguage(round(issueReportApprovalForm(PREVIEW, "en")), PREVIEW)).toBe("en");
  expect(issueReportFormLanguage(round(issueReportApprovalForm(PREVIEW, "uk")), PREVIEW)).toBe("uk");
  /* Stored key order does not matter. */
  const [question] = issueReportApprovalForm(PREVIEW, "en").questions;
  const reordered = { other: true as const, options: question!.options.map((option) => ({ ...(option.recommended ? { recommended: true } : {}), label: option.label })), text: question!.text, id: question!.id };
  expect(issueReportFormLanguage(round({ title: issueReportApprovalForm(PREVIEW, "en").title, questions: [reordered] }), PREVIEW)).toBe("en");
  /* Another preview's form, an edited form, a form with variants and no form at all are not it. */
  expect(issueReportFormLanguage(round(issueReportApprovalForm(OTHER, "en")), PREVIEW)).toBeNull();
  expect(issueReportFormLanguage(round({ ...issueReportApprovalForm(PREVIEW, "en"), title: "Publish?" }), PREVIEW)).toBeNull();
  expect(issueReportFormLanguage(round({ ...issueReportApprovalForm(PREVIEW, "en"), questions: [{ ...question!, multiple: true }] }), PREVIEW)).toBeNull();
  expect(issueReportFormLanguage(round(issueReportApprovalForm(PREVIEW, "en"), [{ number: 1, name: "One", description: "", frames: [], videos: [] }] as never), PREVIEW)).toBeNull();
  expect(issueReportFormLanguage(round({ title: issueReportApprovalForm(PREVIEW, "en").title }), PREVIEW)).toBeNull();
});

test("only a person's explicit choice of the approving option approves", () => {
  expect(issueReportDecisionApproves(decision({}))).toBe(true);
  expect(issueReportDecisionApproves(decision({ decidedBy: { kind: "member", memberId: "member-a" } }))).toBe(true);
  /* A comment beside the explicit choice does not withdraw it. */
  expect(issueReportDecisionApproves(decision({ comment: "Thanks" }))).toBe(true);
  /* Delivery text is out of band from the structured choice. A focused-card
     prelude and an engine interruption marker cannot change that choice. */
  expect(issueReportDecisionApproves(decision({ comment: [
    "[viewer context — the operator is looking at: project example; focused conversation transcripts/seat.jsonl]",
    "[Request interrupted by user]",
    issueReportApprovalReplies(PREVIEW.digest).en,
  ].join("\n") }))).toBe(true);

  expect(issueReportDecisionApproves(undefined)).toBe(false);
  expect(issueReportDecisionApproves(decision({ decidedBy: { kind: "agent", conversationId: "conversation_seat" } }))).toBe(false);
  expect(issueReportDecisionApproves(decision({ decidedBy: undefined }))).toBe(false);
  expect(issueReportDecisionApproves(decision({ skipped: true }))).toBe(false);
  expect(issueReportDecisionApproves(decision({ rejected: true }))).toBe(false);
  expect(issueReportDecisionApproves(decision({ recommendedWithReservation: true }))).toBe(false);
  expect(issueReportDecisionApproves(decision({}, [1]))).toBe(false);
  expect(issueReportDecisionApproves(decision({}, [2]))).toBe(false);
  expect(issueReportDecisionApproves(decision({}, [0, 1]))).toBe(false);
  expect(issueReportDecisionApproves(decision({}, [], { skipped: true }))).toBe(false);
  expect(issueReportDecisionApproves(decision({}, [0], { other: true }))).toBe(false);
  expect(issueReportDecisionApproves(decision({}, [0], { customText: "yes but later" }))).toBe(false);
  expect(issueReportDecisionApproves(decision({ answers: [{ questionId: "another", options: [0] }] }))).toBe(false);
});

test("consent for one preview never approves another sharing its display prefix", () => {
  const other = { ...PREVIEW, digest: PREVIEW.digest.slice(0, 8) + "cd".repeat(28) };
  for (const language of ["en", "uk"] as const) {
    const form = issueReportApprovalForm(PREVIEW, language);
    expect(issueReportFormLanguage(round(form), other)).toBeNull();
    expect(issueReportFormLanguage(round(form), PREVIEW)).toBe(language);
  }
});

test.each(["en", "uk"] as const)("viewer-context delivery text preserves the structured approval in %s (#2791)", language => {
  const form = issueReportApprovalForm(PREVIEW, language);
  const reply = issueReportApprovalReplies(PREVIEW.digest)[language];
  for (const marker of ["", "[Request interrupted by user]\n"]) {
    const text = `[viewer context — the operator is looking at: project example; focused conversation transcripts/seat.jsonl]\n${marker}${reply}`;
    const answer = decision({ comment: text,
      delivery: { state: "sent", conversationId: "conversation_seat", clientMessageId: "prototype-decision:context", text } });
    expect(issueReportFormLanguage(round(form), PREVIEW)).toBe(language);
    expect(issueReportDecisionApproves(answer)).toBe(true);
    // The same delivery text cannot turn a refusal or an agent's answer
    // into consent, or bind the form to a different preview.
    expect(issueReportDecisionApproves({ ...answer, answers: [{ questionId: ISSUE_REPORT_QUESTION_ID, options: [2] }] })).toBe(false);
    expect(issueReportDecisionApproves({ ...answer, decidedBy: { kind: "agent", conversationId: "conversation_seat" } })).toBe(false);
    expect(issueReportFormLanguage(round(form), OTHER)).toBeNull();
  }
});


test("reworded approval text alone never approves a report", () => {
  for (const text of ["YES, PUBLISH REPORT", " yes  publish report! ", "Yes. publish report,"]) {
    expect(issueReportDecisionApproves(decision({ comment: `${text} ${PREVIEW.digest}`, answers: [] }))).toBe(false);
  }
});
