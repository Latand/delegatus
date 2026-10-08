import { expect, test } from "bun:test";

import { issueReportPreviewText } from "./previewText";
import { scrubIssueReport } from "./scrub";

/*
 * The operator decides on what the preview shows (#2518, PR #2530): which
 * lines become public, that approving publishes them, and what each hint
 * points at. Addresses are from the documentation ranges and names invented.
 */

const DIGEST = "ab".repeat(32);
/* Joined here so no line of this file holds a path, an address or a token of its own. */
const TOKEN = ["ghp", "0123456789abcdefghijklmnopqrstuvwxyzAB"].join("_");
const PATH = ["", "home", "someone", ".config", "app", "state", "launches.json"].join("/");
const ADDRESS = [192, 168, 14, 22].join(".");
const BODY = [
  "## Symptom",
  'The tool answered "connection refused during startup".',
  "",
  "> the operator said the second project should start first",
  "",
  `It read ${PATH} and the host answered from ${ADDRESS}:8898.`,
  `Contact someone@example.org for the trace; token ${TOKEN} was in the header.`,
  "![screenshot of the board](https://example.org/board.png)",
].join("\n");
const JUDGMENT = { assessment: "Still identifies a machine.", removed: "Nothing yet.", harmlessHints: "The quoted answer is an error message.", uncertainties: "The address and the token." };
const preview = (extra: Partial<Parameters<typeof issueReportPreviewText>[0]> = {}) => ({
  digest: DIGEST, title: "Delegatus refuses a requested launch", body: BODY, privacyJudgment: JUDGMENT,
  hints: scrubIssueReport({ title: "Delegatus refuses a requested launch", body: BODY }), hintWarnings: [], ...extra,
});
const hintLines = (text: string) => text.split("\n").filter((line) => line.startsWith("- "));
/* What the chat shows for a hint: inline code is drawn character for character, without its backticks. */
const drawn = (line: string) => line.slice(line.indexOf(": ") + 2).replace(/`([^`]+)`/g, "$1");

test("the published part is one bounded unit and everything else comes after it", () => {
  for (const language of ["en", "uk"] as const) {
    const lines = issueReportPreviewText(preview(), language).split("\n");
    const [from, to] = language === "en" ? ["PUBLISHED FROM HERE", "PUBLISHED UP TO HERE"] : ["ПУБЛІКУЄТЬСЯ ЗВІДСИ", "ПУБЛІКУЄТЬСЯ ДОСЮДИ"];
    const start = lines.findIndex((line) => line.includes(from));
    const end = lines.findIndex((line) => line.includes(to));
    expect(lines.filter((line) => line.includes(from) || line.includes(to))).toHaveLength(2);
    expect(lines.slice(start + 1, end).join("\n")).toBe(
      `> ${language === "en" ? "Title" : "Назва"}\nDelegatus refuses a requested launch\n> ${language === "en" ? "Body" : "Текст"}\n${BODY}`);
    expect(lines[end + 1]).toBe(language === "en" ? "Everything below this line stays in this chat." : "Усе нижче цього рядка лишається в цьому чаті.");
    expect(lines.slice(0, start).join("\n")).not.toContain(JUDGMENT.assessment);
    for (const outside of [JUDGMENT.assessment, language === "en" ? "Detector hints" : "Підказки детекторів"]) {
      expect(lines.findIndex((line) => line.includes(outside))).toBeGreaterThan(end + 1);
    }
  }
});

test("an open code fence in the body cannot swallow the closing marker", () => {
  const body = "first\n```\nunclosed";
  const lines = issueReportPreviewText(preview({ body, hints: [] })).split("\n");
  const end = lines.indexOf("**━━ PUBLISHED UP TO HERE ━━**");
  expect(lines.slice(end - 4, end)).toEqual(["first", "```", "unclosed", "```"]);
  const closed = issueReportPreviewText(preview({ body: `${body}\n\`\`\``, hints: [] })).split("\n");
  expect(closed[closed.indexOf("**━━ PUBLISHED UP TO HERE ━━**") - 2]).toBe("unclosed");
});

test("a hint quotes its span character for character, under its plain label", () => {
  const text = issueReportPreviewText(preview());
  const shown = hintLines(text).map(drawn);
  for (const span of [ADDRESS, "someone@example.org", PATH, TOKEN,
    '"connection refused during startup"', "> the operator said the second project should start first", "![screenshot of the board]("]) {
    expect(shown).toContain(span);
    expect(BODY).toContain(span);
  }
  expect(hintLines(text).join("\n")).not.toContain("\\");
  for (const line of hintLines(text)) expect(line.slice(0, line.indexOf(": "))).not.toMatch(/_|\(written\)/);
  expect(text).toContain("- a quotation · body, line 2: `\"connection refused during startup\"`");
});

test("one span is one line however many detectors point at it", () => {
  const hints = preview().hints;
  const text = issueReportPreviewText(preview());
  const address = hintLines(text).filter((line) => drawn(line) === ADDRESS);
  expect(hints.filter((hint) => hint.span.text === ADDRESS).length).toBeGreaterThan(1);
  expect(address).toEqual([`- an IP address, a private network address · body, line 6: \`${ADDRESS}\``]);
  expect(new Set(hintLines(text).map((line) => line.slice(line.indexOf(" · ")))).size).toBe(hintLines(text).length);
  /* A backtick and a line break sit between the code pieces, and nothing of the span is lost. */
  const odd = issueReportPreviewText(preview({ hints: [{ class: "quote", label: "a quoted block", where: "body", lines: [3, 4], reading: "decoded", span: { start: 0, end: 9, text: "\n> a`b\n> c" } }] }));
  expect(hintLines(odd)).toEqual(["- a quoted block · body, lines 3, 4, decoded form: `> a```b` ↵ `> c`"]);
});

test("a source warning is set apart from the hints", () => {
  const warning = "Known-name hints are unavailable; review names and identities yourself.";
  const en = issueReportPreviewText(preview({ hints: [], hintWarnings: [warning] }));
  expect(hintLines(en)).toEqual([]);
  expect(en).toContain(`\n\nWarning: ${warning}\n\n`);
  expect(issueReportPreviewText(preview({ hintWarnings: [warning] }), "uk")).toContain("\n\nПопередження: Підказки щодо відомих імен недоступні; перевірте імена й особи самостійно.\n\n");
});

test("the closing line says what approving does, in every variant and both languages", () => {
  const variants = [preview(), preview({ hints: [] }), preview({ privacyJudgment: undefined, hints: undefined, hintWarnings: undefined })];
  for (const variant of variants) {
    const en = issueReportPreviewText(variant).split("\n").at(-1)!;
    for (const fact of ["files exactly the title and body above", "public issue in the Delegatus repository", "readable by anyone", "Hints do not prevent this"]) expect(en).toContain(fact);
    const uk = issueReportPreviewText(variant, "uk").split("\n").at(-1)!;
    for (const fact of ["із назви й тексту вище", "публічний issue в репозиторії Delegatus", "може прочитати будь-хто", "Підказки цьому не перешкоджають"]) expect(uk).toContain(fact);
  }
  expect(issueReportPreviewText(variants[1]!)).toContain("None found. A clean result proves nothing");
  expect(issueReportPreviewText(variants[2]!)).toContain("No agent judgment was recorded for this preview.");
});

test("in Ukrainian only the report and the agent's judgment keep their own language", () => {
  const variant = preview({ hintWarnings: ["Known-name hints are unavailable; review names and identities yourself."] });
  const own = new Set([variant.title, ...BODY.split("\n"), ...Object.values(JUDGMENT)]);
  for (const line of issueReportPreviewText(variant, "uk").split("\n")) {
    if (!line.trim() || own.has(line) || line === "```") continue;
    /* A hint's quoted span and a judgment's text are the report's own words. */
    const frame = line.startsWith("- ") ? line.slice(0, line.indexOf(": ")) : line.includes(": ") && Object.values(JUDGMENT).some((value) => line.endsWith(value)) ? line.slice(0, line.indexOf(": ")) : line;
    expect(frame.replace(/Delegatus|issue|URL|IP|[0-9a-f]{64}/g, "")).not.toMatch(/[A-Za-z]{2,}/);
  }
});
