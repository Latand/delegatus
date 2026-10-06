import { expect, test } from "bun:test";
import { scrubIssueReport } from "./scrub";

const home = ["", "home", "someone", "work"].join("/");

test("hints identify their class and precise span in the written field", () => {
  const title = "The launch on local" + "host failed";
  const body = `Evidence:\nThe log is under ${home}.`;
  const hints = scrubIssueReport({ title, body });
  expect(hints).toEqual(expect.arrayContaining([
    expect.objectContaining({ class: "host", where: "title", lines: [1], reading: "written" }),
    expect.objectContaining({ class: "home_path", where: "body", lines: [2] }),
    expect.objectContaining({ class: "path", where: "body", lines: [2] }),
  ]));
  for (const hint of hints) expect(({ title, body })[hint.where].slice(hint.span.start, hint.span.end)).toBe(hint.span.text);
});

test("each occurrence can be pointed out without repeating the entire report", () => {
  const body = `First ${home}.\nSecond ${home}.`;
  const paths = scrubIssueReport({ title: "A failure", body }).filter((hint) => hint.class === "path");
  expect(paths.map((hint) => hint.lines)).toEqual([[1], [2]]);
  expect(paths.every((hint) => hint.span.text.length < body.length)).toBe(true);
});

test("decoded hints identify the reading their offsets belong to", () => {
  const hints = scrubIssueReport({ title: "A failure", body: encodeURIComponent(home) });
  expect(hints).toEqual(expect.arrayContaining([expect.objectContaining({ class: "path", reading: "decoded", span: expect.objectContaining({ text: home }) })]));
});

test("a general quote hint can be a harmless technical error", () => {
  expect(scrubIssueReport({ title: "A failure", body: 'The tool answered "connection refused during startup".' })).toEqual(expect.arrayContaining([expect.objectContaining({ class: "quote", span: expect.objectContaining({ text: '"connection refused during startup"' }) })]));
});

test("known names use the shared detectors and include matched text", () => {
  expect(scrubIssueReport({ title: "A failure", body: "Person Bee observed it." }, { accounts: [], people: ["Person Bee"], local: [], projects: [] })).toEqual(expect.arrayContaining([expect.objectContaining({ class: "person", span: { start: 0, end: 10, text: "Person Bee" } })]));
});

test("a clean result carries no privacy verdict", () => {
  // A reader must still judge this identifying attribution themselves.
  expect(scrubIssueReport({ title: "A failure", body: "An unfamiliar person observed the failure." })).toEqual([]);
});
