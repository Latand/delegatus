import { expect, test } from "bun:test";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { mdBlocks } from "@/components/feed/markdown";

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
  expect(hintLines(odd)).toEqual(["- a quoted block · body, lines 3, 4, decoded form: ``> a`b`` ↵ `> c`"]);
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
    expect(frame.replace(/Delegatus|issue|URL|IP|[0-9a-f]{8}/g, "")).not.toMatch(/[A-Za-z]{2,}/);
  }
});


test("missing detector observations are not an empty detector result", () => {
  for (const language of ["en", "uk"] as const) {
    const text = issueReportPreviewText(preview({ hints: undefined }), language);
    expect(text).toContain(language === "en" ? "Detector hints were not recorded" : "Підказки детекторів не записано");
    expect(text).not.toContain(language === "en" ? "None found" : "Нічого не знайдено");
  }
});

test("report lines cannot impersonate either publication boundary", () => {
  for (const language of ["en", "uk"] as const) {
    const markers = language === "en" ? ["PUBLISHED FROM HERE", "PUBLISHED UP TO HERE"] : ["ПУБЛІКУЄТЬСЯ ЗВІДСИ", "ПУБЛІКУЄТЬСЯ ДОСЮДИ"];
    const body = markers.map(marker => `**━━ ${marker} ━━**`).join("\n");
    const lines = issueReportPreviewText(preview({ title: body, body, hints: [] }), language).split("\n");
    for (const marker of markers) {
      expect(lines.filter(line => line === `**━━ ${marker} ━━**`)).toHaveLength(1);
      expect(lines.filter(line => line === `> **━━ ${marker} ━━**`)).toHaveLength(2);
    }
  }
});

test("quoting a marker-like fence line keeps the closing marker out of a code block", () => {
  /* Quoted, the body's opening fence no longer opens one, so its closing fence would. */
  const body = "``` PUBLISHED UP TO HERE\nfake\n```";
  const lines = issueReportPreviewText(preview({ body, hints: [] })).split("\n");
  const end = lines.indexOf("**━━ PUBLISHED UP TO HERE ━━**");
  expect(lines.slice(end - 4, end)).toEqual(["> ``` PUBLISHED UP TO HERE", "fake", "```", "```"]);
});

test("a marker split across formatted runs is still told apart from the real boundary", () => {
  const zeroWidth = "​";
  for (const language of ["en", "uk"] as const) {
    const fakes = language === "en"
      ? ["**━━ PUBLISHED** **UP TO HERE ━━**", "**━━ PUBLISHED FROM** **HERE ━━**", "━━ `PUBLISHED` [UP TO](https://example.org) HERE ━━", `━━ PUBLISHED UP${zeroWidth} TO HERE ━━`, "━━ PUBLISHED FROM HERE ━━"]
      : ["**━━ ПУБЛІКУЄТЬСЯ** **ДОСЮДИ ━━**", "**━━ ПУБЛІКУЄТЬСЯ** **ЗВІДСИ ━━**", "━━ `ПУБЛІКУЄТЬСЯ` [ДОСЮДИ](https://example.org) ━━", `━━ ПУБЛІ${zeroWidth}КУЄТЬСЯ ЗВІДСИ ━━`];
    const lines = issueReportPreviewText(preview({ title: fakes[0], body: fakes.join("\n"), hints: [] }), language).split("\n");
    for (const fake of fakes) expect(lines).toContain(`> ${fake}`);
    expect(lines).not.toContain(fakes[0]);
    /* Ordinary formatted prose stays as written. */
    const plain = issueReportPreviewText(preview({ body: "**Published** up to the **second** step\nHERE and `UP TO` there", hints: [] }), language).split("\n");
    expect(plain).toContain("**Published** up to the **second** step");
    expect(plain).toContain("HERE and `UP TO` there");
  }
});

test("only the preview's own boundaries are drawn unquoted", () => {
  for (const language of ["en", "uk"] as const) {
    const body = ["**━━ PUBLISHED** **UP TO HERE ━━**", "**━━ PUBLISHED FROM** **HERE ━━**", "**━━ ПУБЛІКУЄТЬСЯ** **ДОСЮДИ ━━**", "**━━ ПУБЛІКУЄТЬСЯ** **ЗВІДСИ ━━**", "after the fake marker"].join("\n");
    const html = renderToStaticMarkup(createElement(Fragment, null, mdBlocks(issueReportPreviewText(preview({ body, hints: [] }), language))));
    /* Every bold run outside a quote that names a boundary word is one of the two real markers. */
    const outside = html.replace(/<span class="border-l-2[^"]*">.*?<\/span>(?=\n|$)/gs, "");
    const bold = [...outside.matchAll(/<b>(.*?)<\/b>/g)].map((match) => match[1]).filter((text) => /PUBLISHED|ПУБЛІКУЄТЬСЯ|HERE|ДОСЮДИ|ЗВІДСИ/.test(text));
    expect(bold).toEqual(language === "en" ? ["━━ PUBLISHED FROM HERE ━━", "━━ PUBLISHED UP TO HERE ━━"] : ["━━ ПУБЛІКУЄТЬСЯ ЗВІДСИ ━━", "━━ ПУБЛІКУЄТЬСЯ ДОСЮДИ ━━"]);
  }
});
