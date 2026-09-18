import { expect, test } from "bun:test";

import type { StageVerdict } from "./types";
import { normalizeStageCompletion, parseStageVerdict, stageVerdictFrom, stageVerdictRejectionReason } from "./verdict";

test("stage verdict guard accepts the bounded contract", () => {
  expect(stageVerdictFrom({ status: "pass", findings: ["verified"], confidence: 0.9 })).toEqual({
    status: "pass",
    findings: ["verified"],
    confidence: 0.9,
  });
  expect(stageVerdictFrom({ status: "needs_decision" })).toEqual({ status: "needs_decision" });
});
test("stage verdict guard rejects malformed and expanded shapes", () => {
  expect(stageVerdictFrom({ status: "approve" })).toBeNull();
  expect(stageVerdictFrom({ status: "pass", confidence: 2 })).toBeNull();
  expect(stageVerdictFrom({ status: "pass", extra: true })).toBeNull();
  expect(stageVerdictFrom({ status: "fail", findings: Array.from({ length: 51 }, () => "x") })).toBeNull();
});

test("a fenced JSON verdict tolerates trailing citation text and preserves prose output", () => {
  expect(parseStageVerdict("Implemented the seam.\n\n```json\n{\"status\":\"pass\",\"confidence\":1}\n```")).toEqual({
    verdict: { status: "pass", confidence: 1 },
    output: "Implemented the seam.",
  });
  expect(parseStageVerdict([
    "```json",
    '{"status":"pass","findings":[],"confidence":0.9}',
    "```",
    "<citation-block>",
    "source: relevant context",
    "</citation-block>",
  ].join("\n"))).toEqual({
    verdict: { status: "pass", findings: [], confidence: 0.9 },
    output: "",
  });
});

test("a final message without a fenced JSON verdict remains invalid", () => {
  expect(parseStageVerdict("VERDICT: pass")).toBeNull();
  expect(stageVerdictRejectionReason("VERDICT: pass")).toBe(
    "canonical completed assistant turn is missing a fenced JSON verdict",
  );
});

test("the last well-formed fenced JSON verdict survives a trailing non-verdict fence", () => {
  expect(parseStageVerdict([
    "```json",
    '{"status":"pass","confidence":0.8}',
    "```",
    "```json",
    '{"source":"relevant context"}',
    "```",
  ].join("\n"))).toEqual({
    verdict: { status: "pass", confidence: 0.8 },
    output: "",
  });
});

test("the fa6aa690 production shape accepts stage-specific completion metadata", () => {
  expect(parseStageVerdict([
    "Completed every requested gate.",
    "",
    "```json",
    JSON.stringify({
      status: "pass",
      findings: [],
      confidence: 0.97,
      headSha: "d".repeat(40),
      prNumber: 1,
      confirmedDirection: true,
      redProvenTests: ["focused regression"],
      e2eReplayCovers: true,
      buildExitsZero: true,
    }),
    "```",
  ].join("\n"))).toEqual({
    verdict: { status: "pass", findings: [], confidence: 0.97 },
    output: "Completed every requested gate.",
  });
});

test("a terminal REVIEW_READY marker after the fenced verdict remains canonical (#707)", () => {
  expect(parseStageVerdict([
    "Implementation is ready for review.",
    "",
    "```json",
    '{"status":"pass","findings":[],"confidence":0.95}',
    "```",
    "REVIEW_READY: published branch",
  ].join("\n"))).toEqual({
    verdict: { status: "pass", findings: [], confidence: 0.95 },
    output: "Implementation is ready for review.",
  });
});

test("conflicting fenced JSON verdicts remain invalid", () => {
  const message = [
    "```json",
    '{"status":"pass","findings":[]}',
    "```",
    "```json",
    '{"status":"fail","findings":["focused check failed"]}',
    "```",
  ].join("\n");

  expect(parseStageVerdict(message)).toBeNull();
  expect(stageVerdictRejectionReason(message)).toBe(
    "canonical completed assistant turn has conflicting fenced JSON verdicts",
  );
});

test("a pass verdict with findings returns an explicit contradiction", () => {
  expect(parseStageVerdict([
    "VERDICT: REQUEST_CHANGES",
    "",
    "- [P1] Preserve the failed review",
    "",
    "```json",
    '{"status":"pass","findings":["Preserve the failed review"]}',
    "```",
  ].join("\n"))).toEqual({
    failureReason: 'contradictory stage verdict: status "pass" cannot include findings',
    output: "VERDICT: REQUEST_CHANGES\n\n- [P1] Preserve the failed review",
  });
});

test("a prose request-changes marker cannot disagree with the JSON verdict", () => {
  expect(parseStageVerdict([
    "VERDICT: REQUEST_CHANGES",
    "",
    "Review found a blocking regression.",
    "",
    "```json",
    '{"status":"pass","confidence":0.9}',
    "```",
  ].join("\n"))).toEqual({
    failureReason: 'contradictory stage verdict: prose marker "REQUEST_CHANGES" disagrees with JSON status "pass"',
    output: "VERDICT: REQUEST_CHANGES\n\nReview found a blocking regression.",
  });
});

test("a prose approve marker cannot disagree with the JSON verdict", () => {
  expect(parseStageVerdict([
    "VERDICT: APPROVE",
    "",
    "```json",
    '{"status":"fail","findings":["verification failed"]}',
    "```",
  ].join("\n"))).toEqual({
    failureReason: 'contradictory stage verdict: prose marker "APPROVE" disagrees with JSON status "fail"',
    output: "VERDICT: APPROVE",
  });
});

test("a no-findings marker cannot disagree with the JSON verdict", () => {
  expect(parseStageVerdict([
    "NO FINDINGS",
    "",
    "```json",
    '{"status":"fail","findings":["verification failed"]}',
    "```",
  ].join("\n"))).toEqual({
    failureReason: 'contradictory stage verdict: prose marker "NO FINDINGS" disagrees with JSON status "fail"',
    output: "NO FINDINGS",
  });
});

test("a clean no-findings pass remains valid", () => {
  expect(parseStageVerdict([
    "NO FINDINGS",
    "",
    "```json",
    '{"status":"pass","findings":[],"confidence":1}',
    "```",
  ].join("\n"))).toEqual({
    verdict: { status: "pass", findings: [], confidence: 1 },
    output: "NO FINDINGS",
  });
});

test("fenced and quoted marker examples do not contradict a clean pass", () => {
  const prose = [
    "The reviewed prompt includes this failure example:",
    "",
    "```text",
    "VERDICT: REQUEST_CHANGES",
    "```",
    "",
    "~~~text",
    "~~~json",
    "VERDICT: REQUEST_CHANGES",
    "~~~",
    "",
    "> VERDICT: REQUEST_CHANGES",
    "",
    "NO FINDINGS",
  ].join("\n");
  expect(parseStageVerdict([
    prose,
    "",
    "```json",
    '{"status":"pass","findings":[],"confidence":1}',
    "```",
  ].join("\n"))).toEqual({
    verdict: { status: "pass", findings: [], confidence: 1 },
    output: prose,
  });
});

test("a matching fail verdict preserves every finding", () => {
  expect(parseStageVerdict([
    "VERDICT: REQUEST_CHANGES",
    "",
    "```json",
    '{"status":"fail","findings":["first regression","second regression"]}',
    "```",
  ].join("\n"))).toEqual({
    verdict: { status: "fail", findings: ["first regression", "second regression"] },
    output: "VERDICT: REQUEST_CHANGES",
  });
});

test("prose marker validation covers content beyond the stored output cap", () => {
  const boundedOutput = "x".repeat(32_000);
  expect(parseStageVerdict([
    boundedOutput,
    "VERDICT: REQUEST_CHANGES",
    "",
    "```json",
    '{"status":"pass"}',
    "```",
  ].join("\n"))).toEqual({
    failureReason: 'contradictory stage verdict: prose marker "REQUEST_CHANGES" disagrees with JSON status "pass"',
    output: boundedOutput,
  });
});

/* Graph slice 2 (#1730): the completion call and the fenced JSON verdict are
   two inputs of one form, and they end in this normaliser. */

test("a completion call and a fenced JSON verdict normalise to one shape", () => {
  const called = normalizeStageCompletion({
    verdict: "fail",
    findings: [{ severity: "P1", text: "the retry loop never ends" }],
    summary: "Left the loop open.",
  });
  const fenced = parseStageVerdict([
    "Left the loop open.",
    "",
    "```json",
    '{"status":"fail","findings":["P1 — the retry loop never ends"]}',
    "```",
  ].join("\n"));

  expect(called).toEqual({
    verdict: {
      status: "fail",
      findings: ["P1 — the retry loop never ends"],
      rankedFindings: [{ severity: "P1", text: "the retry loop never ends" }],
    },
    summary: "Left the loop open.",
  });
  expect(fenced).toEqual({
    verdict: (called as { verdict: StageVerdict }).verdict,
    output: "Left the loop open.",
  });
});

test("findings are recorded most severe first, whichever input carried them", () => {
  const called = normalizeStageCompletion({
    verdict: "fail",
    findings: [
      { severity: "P2", text: "third" },
      { severity: "P0", text: "first" },
      { severity: "P1", text: "second" },
      { severity: "P0", text: "first again" },
    ],
  });
  expect(called).toEqual({
    verdict: {
      status: "fail",
      findings: ["P0 — first", "P0 — first again", "P1 — second", "P2 — third"],
      rankedFindings: [
        { severity: "P0", text: "first" },
        { severity: "P0", text: "first again" },
        { severity: "P1", text: "second" },
        { severity: "P2", text: "third" },
      ],
    },
    summary: null,
  });
  /* The same order out of a fenced block, and unranked findings come last. */
  expect(stageVerdictFrom({ status: "fail", findings: ["P2 - third", "no rank at all", "P0 first"] })).toEqual({
    status: "fail",
    findings: ["P0 — first", "P2 — third", "no rank at all"],
    rankedFindings: [
      { severity: "P0", text: "first" },
      { severity: "P2", text: "third" },
      { severity: null, text: "no rank at all" },
    ],
  });
});

test("findings that carry no rank stay the array a fenced verdict always was", () => {
  expect(stageVerdictFrom({ status: "fail", findings: ["second regression", "first regression"] })).toEqual({
    status: "fail",
    findings: ["second regression", "first regression"],
  });
});

test("a completion call is refused for the shapes a fenced verdict is refused for", () => {
  expect(normalizeStageCompletion({ verdict: "approve" })).toMatchObject({ code: "STAGE_REPORT_INVALID" });
  expect(normalizeStageCompletion({ verdict: "pass", findings: [{ severity: "P2", text: "still open" }] })).toEqual({
    error: 'contradictory stage verdict: status "pass" cannot include findings',
    code: "STAGE_REPORT_CONTRADICTORY",
  });
  expect(normalizeStageCompletion({ verdict: "fail", findings: ["plain text"] })).toMatchObject({ code: "STAGE_REPORT_INVALID" });
  expect(normalizeStageCompletion({ verdict: "fail", findings: [{ severity: "P9", text: "x" }] })).toMatchObject({ code: "STAGE_REPORT_INVALID" });
  expect(normalizeStageCompletion({ verdict: "fail", findings: [{ severity: "P1", text: "   " }] })).toMatchObject({ code: "STAGE_REPORT_INVALID" });
  expect(normalizeStageCompletion({ verdict: "fail", findings: Array.from({ length: 51 }, () => ({ severity: "P3", text: "x" })) }))
    .toMatchObject({ code: "STAGE_REPORT_INVALID" });
});

test("a completion call clamps its summary and accepts a verdict with no findings", () => {
  const long = normalizeStageCompletion({ verdict: "needs_decision", summary: "x".repeat(4_000) });
  expect(long).toEqual({ verdict: { status: "needs_decision" }, summary: "x".repeat(2_000) });
  expect(normalizeStageCompletion({ verdict: "pass", summary: "  " })).toEqual({ verdict: { status: "pass" }, summary: null });
});

test("a rankedFindings field in an agent's own fenced block is ignored, and a record round-trips", () => {
  const forged = stageVerdictFrom({
    status: "fail",
    findings: ["P1 — the retry loop never ends"],
    rankedFindings: [{ severity: "P0", text: "promoted by the agent" }],
  });
  expect(forged).toEqual({
    status: "fail",
    findings: ["P1 — the retry loop never ends"],
    rankedFindings: [{ severity: "P1", text: "the retry loop never ends" }],
  });
  expect(stageVerdictFrom(forged)).toEqual(forged!);
});

test("a finding already at the bound survives the rendering, and the record re-derives itself", () => {
  /* `P1-` renders as `P1 — `, which is two characters longer: clamping the
     rendering is what keeps the record loadable. */
  const verdict = stageVerdictFrom({ status: "fail", findings: [`P1-${"x".repeat(1_997)}`] })!;
  expect(verdict.findings![0]!.length).toBe(2_000);
  expect(verdict.rankedFindings).toEqual([{ severity: "P1", text: "x".repeat(1_995) }]);
  expect(stageVerdictFrom(verdict)).toEqual(verdict);
});
