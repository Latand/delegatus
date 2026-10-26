import { describe, expect, test } from "bun:test";

import { diffFromGitFilePatch, type DiffCaps, type FileDiff } from "@/components/feed/diff";
import { findRow, laneReviewDraftKey, numberRows, orderComments, parseHunkHeader, parseLaneReviewDraft, reanchor, rowAnchor, rowQuote, type LaneReviewComment } from "./model";

/* Patches in the exact shape `git diff -U3` prints them. */
const PATCH = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -2,7 +2,7 @@ line 1",
  " line 2",
  " line 3",
  " line 4",
  "-line 5",
  "+line five",
  " line 6",
  " line 7",
  " line 8",
  "@@ -23,6 +23,7 @@ line 22",
  " line 23",
  " line 24",
  " line 25",
  "+line 25b",
  " line 26",
  " line 27",
  " line 28",
  "",
].join("\n");

const file = (patch: string, caps?: DiffCaps): FileDiff => diffFromGitFilePatch("src/app.ts", "update", patch, caps);

const comment = (overrides: Partial<LaneReviewComment>): LaneReviewComment => ({
  id: "c1", path: "src/app.ts", side: "new", line: 5, quote: "line five", body: "Name it.", state: "anchored", ...overrides,
});

describe("line numbers", () => {
  test("come from git's hunk headers; a context row has both sides", () => {
    expect(parseHunkHeader("-2,7 +2,7 @@ line 1")).toEqual({ old: 2, new: 2 });
    expect(parseHunkHeader("-0,0 +1 @@")).toEqual({ old: 0, new: 1 });
    expect(parseHunkHeader("Update File")).toBeNull();
    const rows = numberRows(file(PATCH).hunks);
    const at = (text: string) => rows.find((row) => row.line.text === text)!;
    expect([at("line 5").old, at("line 5").new]).toEqual([5, undefined]);
    expect([at("line five").old, at("line five").new]).toEqual([undefined, 5]);
    expect([at("line 26").old, at("line 26").new]).toEqual([26, 27]);
    expect([at("line 28").old, at("line 28").new]).toEqual([28, 29]);
  });

  test("a context row anchors to the new side, a removed row to the old one", () => {
    const rows = numberRows(file(PATCH).hunks);
    expect(rowAnchor(rows.find((row) => row.line.text === "line 26")!)).toEqual({ side: "new", line: 27 });
    expect(rowAnchor(rows.find((row) => row.line.text === "line 5")!)).toEqual({ side: "old", line: 5 });
    expect(findRow(rows, "old", 26)?.line.text).toBe("line 26");
  });

  test("rows dropped by a cap have no number to take a comment", () => {
    const capped = file(PATCH, { files: 1, hunksPerFile: 200, linesPerFile: 8, charsPerLine: 2_000, totalChars: 256_000 });
    expect(capped.truncated).toBe(true);
    const rows = numberRows(capped.hunks);
    expect(rows.length).toBe(8);
    expect(findRow(rows, "new", 23)).toBeUndefined();
    expect(findRow(rows, "new", 8)?.line.text).toBe("line 8");
  });

  test("header-like content inside a hunk stays content; git's binary marker is binary", () => {
    const patch = ["--- a/x", "+++ b/x", "@@ -1,2 +1,2 @@", "--- a/x", "+++ b/x", ""].join("\n");
    expect(file(patch).hunks[0]!.lines.map((line) => `${line.t}${line.text}`)).toEqual(["--- a/x", "+++ b/x"]);
    expect(file("diff --git a/x b/x\nBinary files a/x and b/x differ\n")).toMatchObject({ binary: true, hunks: [] });
  });

  test("a row's quote is its redacted text cut to 200 characters", () => {
    expect(rowQuote("x".repeat(250))).toBe("x".repeat(200));
    /* Assembled, so no credential-shaped line sits in this file. */
    const keyword = ["pass", "word"].join("");
    const secret = ["fixture", "value", "4242"].join("-");
    const rows = numberRows(file(["@@ -1 +1 @@", `-const ${keyword} = "${secret}";`, `+const ${keyword} = process.env.KEY;`, ""].join("\n")).hunks);
    expect(rows[0]!.line.text).toBe(`const ${keyword} = "[redacted]";`);
  });
});

describe("reanchor", () => {
  const moved = file(PATCH.replace("@@ -2,7 +2,7 @@ line 1", "@@ -2,7 +4,7 @@ line 1"));
  const listed = ["src/app.ts", "src/other.ts"];

  test("keeps a line whose quote is still there", () => {
    const result = reanchor([comment({})], listed, new Map([["src/app.ts", file(PATCH)]]));
    expect(result).toEqual({ comments: [comment({ state: "anchored" })], moved: 0, detached: 0 });
  });

  test("lines inserted above move the comment to the new number", () => {
    const result = reanchor([comment({})], listed, new Map([["src/app.ts", moved]]));
    expect(result.comments[0]).toEqual(comment({ line: 7, state: "moved" }));
    expect(result.moved).toBe(1);
  });

  test("an edited line detaches the comment and keeps its quote", () => {
    const edited = file(PATCH.replace("+line five", "+line 5 (renamed)"));
    const result = reanchor([comment({})], listed, new Map([["src/app.ts", edited]]));
    expect(result.comments[0]).toEqual(comment({ line: null, state: "detached", quote: "line five" }));
    expect(result.detached).toBe(1);
  });

  test("duplicate text picks the match nearest the old line", () => {
    const twice = file(["@@ -1,0 +1,12 @@", ...Array.from({ length: 12 }, (_, i) => (i === 1 || i === 9 ? "+same" : `+other ${i}`)), ""].join("\n"));
    expect(reanchor([comment({ line: 8, quote: "same" })], listed, new Map([["src/app.ts", twice]])).comments[0]!.line).toBe(10);
    expect(reanchor([comment({ line: 4, quote: "same" })], listed, new Map([["src/app.ts", twice]])).comments[0]!.line).toBe(2);
  });

  test("a file gone from the list detaches every comment on it; nothing is ever removed", () => {
    const comments = [comment({ id: "a" }), comment({ id: "b", line: null, quote: "" }), comment({ id: "c", path: "src/other.ts", line: null, quote: "" })];
    const result = reanchor(comments, ["src/other.ts"], new Map());
    expect(result.comments.map((entry) => [entry.id, entry.line, entry.state])).toEqual([["a", null, "detached"], ["b", null, "detached"], ["c", null, "anchored"]]);
    expect(result.detached).toBe(2);
    expect(result.comments.length).toBe(comments.length);
  });

  test("the old side matches on old numbers only", () => {
    const result = reanchor([comment({ side: "old", line: 5, quote: "line 5" })], listed, new Map([["src/app.ts", moved]]));
    expect(result.comments[0]).toEqual(comment({ side: "old", line: 5, quote: "line 5", state: "anchored" }));
  });
});

test("comments order by file list, then file comments, then new before old, then line", () => {
  const ordered = orderComments([
    { path: "b.ts", side: "new", line: 3 },
    { path: "a.ts", side: "old", line: 1 },
    { path: "a.ts", side: "new", line: 40 },
    { path: "a.ts", side: "new", line: 2 },
    { path: "a.ts", side: "old", line: null },
  ], ["a.ts", "b.ts"]);
  expect(ordered.map((entry) => `${entry.path}:${entry.line}:${entry.side}`)).toEqual(["a.ts:null:old", "a.ts:2:new", "a.ts:40:new", "a.ts:1:old", "b.ts:3:new"]);
});

test("a stored draft parses only for its own lane and shape", () => {
  const draft = { v: 1, pipelineId: "p1", draftId: "d1", base: "a".repeat(40), head: "b".repeat(40), targetConversationId: null, note: "", comments: [comment({}), { broken: true }], updatedAt: "2026-10-23T08:00:00.000Z" };
  expect(laneReviewDraftKey("p1")).toBe("delegatus.laneReview.v1.p1");
  expect(parseLaneReviewDraft(JSON.stringify(draft), "p1")?.comments).toEqual([comment({})]);
  expect(parseLaneReviewDraft(JSON.stringify(draft), "p2")).toBeNull();
  expect(parseLaneReviewDraft("{", "p1")).toBeNull();
  expect(parseLaneReviewDraft(JSON.stringify({ ...draft, head: "HEAD" }), "p1")).toBeNull();
});
