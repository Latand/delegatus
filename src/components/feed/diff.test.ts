import { describe, expect, test } from "bun:test";

import {
  DIFF_CAPS,
  TEXT_DIFF_CAPS,
  diffFromApplyPatch,
  diffFromTexts,
  diffTextLines,
  diffFromClaudeEdit,
  diffFromCodexFileChange,
  normalizeEdit,
  type FileDiff,
} from "./diff";

function only(files: FileDiff[]): FileDiff {
  expect(files).toHaveLength(1);
  return files[0];
}

describe("Claude Edit / MultiEdit / Write normalization", () => {
  test("Edit becomes an update with removed then added lines and true counts", () => {
    const model = normalizeEdit("Edit", { file_path: "/repo/src/route.ts", old_string: "a\nb", new_string: "a\nB\nc" });
    const file = only(model.files);
    expect(file.op).toBe("update");
    expect(file.path).toBe("/repo/src/route.ts");
    expect(file.added).toBe(3);
    expect(file.removed).toBe(2);
    expect(file.binary).toBe(false);
    expect(file.truncated).toBe(false);
    const kinds = file.hunks.flatMap((h) => h.lines.map((l) => l.t + l.text));
    expect(kinds).toEqual(["-a", "-b", "+a", "+B", "+c"]);
  });

  test("Edit without old_string becomes an all-added file safely", () => {
    const model = normalizeEdit("Edit", { file_path: "/repo/new.ts", new_string: "line1\nline2" });
    const file = only(model.files);
    expect(file.op).toBe("add");
    expect(file.removed).toBe(0);
    expect(file.added).toBe(2);
    expect(file.hunks[0].lines.every((l) => l.t === "+")).toBe(true);
  });

  test("Write is a pure all-added file", () => {
    const model = normalizeEdit("Write", { file_path: "/repo/a.txt", content: "x\ny\nz" });
    const file = only(model.files);
    expect(file.op).toBe("add");
    expect(file.added).toBe(3);
    expect(file.removed).toBe(0);
  });

  test("MultiEdit collapses several edits into one file with multiple hunks", () => {
    const model = normalizeEdit("MultiEdit", {
      file_path: "/repo/m.ts",
      edits: [{ old_string: "one", new_string: "ONE" }, { old_string: "two", new_string: "TWO" }],
    });
    const file = only(model.files);
    expect(file.op).toBe("update");
    expect(file.hunks).toHaveLength(2);
    expect(file.added).toBe(2);
    expect(file.removed).toBe(2);
  });

  test("empty edit yields no files", () => {
    expect(normalizeEdit("Edit", { file_path: "/repo/x.ts", old_string: "", new_string: "" }).files).toHaveLength(0);
  });

  test("malformed/unknown args never throw and produce no files", () => {
    expect(() => normalizeEdit("Edit", {})).not.toThrow();
    expect(normalizeEdit("Edit", {}).files).toHaveLength(0);
    expect(normalizeEdit("Write", { file_path: 42 as unknown as string }).files).toHaveLength(0);
    expect(diffFromClaudeEdit({ edits: "not-an-array" }).files).toHaveLength(0);
  });
});

describe("Codex apply_patch grammar", () => {
  const patch = [
    "*** Begin Patch",
    "*** Add File: a.txt",
    "+hello",
    "+world",
    "*** Update File: b.ts",
    "@@ ctx",
    " keep",
    "-old",
    "+new",
    "*** Delete File: gone.md",
    "*** End Patch",
  ].join("\n");

  test("parses add, update, and delete files with counts and ops", () => {
    const model = diffFromApplyPatch(patch);
    expect(model.files.map((f) => [f.path, f.op])).toEqual([
      ["a.txt", "add"],
      ["b.ts", "update"],
      ["gone.md", "delete"],
    ]);
    const add = model.files[0];
    expect(add.added).toBe(2);
    expect(add.removed).toBe(0);
    const update = model.files[1];
    expect(update.added).toBe(1);
    expect(update.removed).toBe(1);
    expect(update.hunks[0].lines).toEqual([
      { t: " ", text: "keep" },
      { t: "-", text: "old" },
      { t: "+", text: "new" },
    ]);
  });

  test("Move to sets op move and the destination path", () => {
    const moved = diffFromApplyPatch(["*** Begin Patch", "*** Update File: old/p.ts", "*** Move to: new/p.ts", "@@", "-a", "+b", "*** End Patch"].join("\n"));
    expect(moved.files[0].op).toBe("move");
    expect(moved.files[0].path).toBe("new/p.ts");
  });

  test("+++-looking content inside a hunk stays a single added line", () => {
    const model = diffFromApplyPatch(["*** Begin Patch", "*** Update File: c.ts", "@@", "+++weird", "*** End Patch"].join("\n"));
    expect(model.files[0].hunks[0].lines).toEqual([{ t: "+", text: "++weird" }]);
    expect(model.files[0].added).toBe(1);
  });

  test("missing terminator still parses the open file", () => {
    const model = diffFromApplyPatch(["*** Begin Patch", "*** Add File: t.txt", "+only"].join("\n"));
    expect(model.files).toHaveLength(1);
    expect(model.files[0].added).toBe(1);
  });

  test("no recognizable files yields an empty model without throwing", () => {
    expect(diffFromApplyPatch("garbage\nnot a patch").files).toHaveLength(0);
    expect(diffFromApplyPatch("").files).toHaveLength(0);
  });
});

describe("Codex FileChange add/delete content lines", () => {
  test("drops the terminal split element from newline-terminated add and delete content", () => {
    const model = diffFromCodexFileChange({
      "src/added.ts": { type: "add", content: "export const added = true;\n" },
      "src/deleted.ts": { type: "delete", content: "export const deleted = true;\n" },
    });

    expect(model.files.map((file) => ({
      path: file.path,
      added: file.added,
      removed: file.removed,
      lines: file.hunks.flatMap((hunk) => hunk.lines),
    }))).toEqual([
      { path: "src/added.ts", added: 1, removed: 0, lines: [{ t: "+", text: "export const added = true;" }] },
      { path: "src/deleted.ts", added: 0, removed: 1, lines: [{ t: "-", text: "export const deleted = true;" }] },
    ]);
  });

  test("keeps the final signed line in non-terminated add and delete content", () => {
    const model = diffFromCodexFileChange({
      "src/added.ts": { type: "add", content: "first added\nlast added" },
      "src/deleted.ts": { type: "delete", content: "first deleted\nlast deleted" },
    });

    expect(model.files.map((file) => file.hunks.flatMap((hunk) => hunk.lines))).toEqual([
      [{ t: "+", text: "first added" }, { t: "+", text: "last added" }],
      [{ t: "-", text: "first deleted" }, { t: "-", text: "last deleted" }],
    ]);
    expect(model.files.map((file) => [file.added, file.removed])).toEqual([[2, 0], [0, 2]]);
  });
});

describe("intraline replacement highlighting", () => {
  test("segments a similar removed and added line around their changed characters", () => {
    const model = diffFromApplyPatch(
      ["*** Begin Patch", "*** Update File: src/limit.ts", "@@", "-const limit = 10;", "+const limit = 20;", "*** End Patch"].join("\n"),
    );
    const lines = only(model.files).hunks[0].lines;

    expect(lines).toEqual([
      {
        t: "-",
        text: "const limit = 10;",
        intraline: [
          { text: "const limit = ", changed: false },
          { text: "1", changed: true },
          { text: "0;", changed: false },
        ],
      },
      {
        t: "+",
        text: "const limit = 20;",
        intraline: [
          { text: "const limit = ", changed: false },
          { text: "2", changed: true },
          { text: "0;", changed: false },
        ],
      },
    ]);
  });

  test("pairs replacement runs by line position", () => {
    const model = diffFromApplyPatch(
      [
        "*** Begin Patch",
        "*** Update File: src/limit.ts",
        "@@",
        "-const first = 10;",
        "-const second = 30;",
        "+const first = 20;",
        "+const second = 40;",
        "*** End Patch",
      ].join("\n"),
    );
    const changes = only(model.files).hunks[0].lines.map((line) =>
      line.intraline
        ?.filter((span) => span.changed)
        .map((span) => span.text)
        .join(""),
    );

    expect(changes).toEqual(["1", "3", "2", "4"]);
  });

  test("keeps unrelated replacement lines at line-level emphasis", () => {
    const model = diffFromApplyPatch(
      ["*** Begin Patch", "*** Update File: src/value.ts", "@@", "-aaaaaaaaaaaaaaaa", "+bbbbbbbbbbbbbbbb", "*** End Patch"].join("\n"),
    );

    expect(only(model.files).hunks[0].lines).toEqual([
      { t: "-", text: "aaaaaaaaaaaaaaaa" },
      { t: "+", text: "bbbbbbbbbbbbbbbb" },
    ]);
  });
});

describe("caps and safety", () => {
  test("more than the file cap flags filesTruncated and drops the rest", () => {
    const parts = ["*** Begin Patch"];
    for (let i = 0; i < DIFF_CAPS.files + 4; i += 1) parts.push(`*** Add File: f${i}.txt`, "+x");
    parts.push("*** End Patch");
    const model = diffFromApplyPatch(parts.join("\n"));
    expect(model.files).toHaveLength(DIFF_CAPS.files);
    expect(model.filesTruncated).toBe(true);
  });

  test("more than the per-file line cap truncates and flags", () => {
    const big = Array.from({ length: DIFF_CAPS.linesPerFile + 50 }, (_, i) => `line ${i}`).join("\n");
    const file = only(normalizeEdit("Write", { file_path: "/repo/big.ts", content: big }).files);
    const total = file.hunks.reduce((n, h) => n + h.lines.length, 0);
    expect(total).toBe(DIFF_CAPS.linesPerFile);
    expect(file.truncated).toBe(true);
    // true count is pre-cap
    expect(file.added).toBe(DIFF_CAPS.linesPerFile + 50);
  });

  test("an over-long line is sliced and the file flagged truncated", () => {
    const line = "z".repeat(DIFF_CAPS.charsPerLine + 500);
    const file = only(normalizeEdit("Write", { file_path: "/repo/l.ts", content: line }).files);
    expect(file.hunks[0].lines[0].text.length).toBe(DIFF_CAPS.charsPerLine);
    expect(file.truncated).toBe(true);
  });

  test("binary-ish content renders as binary with no lines", () => {
    const blob = "A".repeat(30_000);
    const file = only(normalizeEdit("Write", { file_path: "/repo/b.bin", content: blob }).files);
    expect(file.binary).toBe(true);
    expect(file.hunks).toHaveLength(0);
  });

  test("total diff text cap stops parsing and flags file truncation", () => {
    // Spaces keep the content out of the binary heuristic; the total-char
    // budget is what must trip here.
    const line = Array.from({ length: 190 }, () => "yyyyyyyyy").join(" ");
    const many = Array.from({ length: 60 }, () => line).join("\n");
    const file = only(normalizeEdit("Write", { file_path: "/repo/tot.ts", content: many }).files);
    const kept = file.hunks.reduce((n, h) => n + h.lines.reduce((s, l) => s + l.text.length, 0), 0);
    expect(kept).toBeLessThanOrEqual(DIFF_CAPS.totalChars);
    expect(file.truncated).toBe(true);
  });
});

describe("redaction runs before slicing", () => {
  test("a secret in an added line is redacted and cannot straddle the cap boundary", () => {
    const prefix = "q".repeat(DIFF_CAPS.charsPerLine - 60);
    const sensitiveKey = String.fromCharCode(97, 112, 105, 95, 107, 101, 121);
    const content = `${prefix} ${sensitiveKey}=SUPERSECRETVALUE trailing`;
    const file = only(normalizeEdit("Write", { file_path: "/repo/s.ts", content }).files);
    const text = file.hunks[0].lines.map((l) => l.text).join("\n");
    expect(text).not.toContain("SUPERSECRETVALUE");
    expect(text).toContain("[redacted]");
  });

  test("a secret in an old_string (context) is redacted", () => {
    const file = only(
      normalizeEdit("Edit", { file_path: "/repo/e.ts", old_string: "password=hunter2", new_string: "password=[env]" }).files,
    );
    const joined = file.hunks.flatMap((h) => h.lines.map((l) => l.text)).join("\n");
    expect(joined).not.toContain("hunter2");
  });
});

describe("whole-text diff (the rotation dialog's mandate)", () => {
  const marks = (lines: { t: string; text: string }[]) => lines.filter((line) => line.t !== " ").map((line) => line.t + line.text);

  test("equal texts have no changed rows and no hunks", () => {
    expect(marks(diffTextLines("a\nb", "a\nb"))).toEqual([]);
    const file = diffFromTexts("a\nb", "a\nb");
    expect(file.hunks).toEqual([]);
    expect([file.added, file.removed, file.truncated]).toEqual([0, 0, false]);
  });

  test("a trailing newline and a CRLF are each one changed line, because the receiver sees them", () => {
    expect(marks(diffTextLines("a\nb", "a\nb\n"))).toEqual(["+"]);
    expect(marks(diffTextLines("a\nb", "a\r\nb"))).toEqual(["-a", "+a\r"]);
  });

  test("a reworded paragraph reads removed then added, and the pair carries intraline spans", () => {
    const old = "# Rules\nKeep the project moving and report every decision to the operator.\nEnd.";
    const next = "# Rules\nKeep the project moving and report every decision to the owner.\nEnd.";
    const file = diffFromTexts(old, next);
    const lines = file.hunks.flatMap((hunk) => hunk.lines);
    expect(marks(lines)).toEqual(["-Keep the project moving and report every decision to the operator.", "+Keep the project moving and report every decision to the owner."]);
    expect([file.added, file.removed]).toEqual([1, 1]);
    const [removed, added] = lines.filter((line) => line.t !== " ");
    expect(removed.intraline?.some((span) => span.changed)).toBe(true);
    expect(added.intraline?.some((span) => span.changed)).toBe(true);
    expect(removed.intraline?.map((span) => span.text).join("")).toBe(removed.text);
    expect(added.intraline?.map((span) => span.text).join("")).toBe(added.text);
    /* The shared prefix is not highlighted. */
    expect(removed.intraline?.[0]).toMatchObject({ changed: false });
  });

  test("context one keeps one unchanged line around each change and merges neighbours", () => {
    const old = Array.from({ length: 12 }, (_, i) => `line ${i}`);
    const next = [...old];
    next[2] = "line 2 changed";
    next[4] = "line 4 changed";
    next[10] = "line 10 changed";
    const file = diffFromTexts(old.join("\n"), next.join("\n"));
    expect(file.hunks).toHaveLength(2);
    expect(file.hunks[0].lines.map((line) => line.t + line.text)).toEqual([
      " line 1", "-line 2", "+line 2 changed", " line 3", "-line 4", "+line 4 changed", " line 5",
    ]);
    expect(file.hunks[1].lines.map((line) => line.t + line.text)).toEqual([" line 9", "-line 10", "+line 10 changed", " line 11"]);
  });

  test("a hunk is headed by the nearest heading above it, and not by its own first row", () => {
    const old = "# One\nfirst\nsecond\n## Two\nthird\nfourth\nfifth";
    const next = "# One\nfirst\nsecond\n## Two\nthird\nFOURTH\nfifth";
    expect(diffFromTexts(old, next).hunks.map((hunk) => hunk.header)).toEqual(["## Two"]);
    const headingChanged = diffFromTexts("# One\nfirst", "# Uno\nfirst");
    expect(headingChanged.hunks[0].header).toBeUndefined();
    expect(diffFromTexts("a\nb", "a\nc").hunks[0].header).toBeUndefined();
  });

  test("intraline highlights cover the whole changed word, not a piece of it", () => {
    const file = diffFromTexts("The seat is adjusted soon.", "The seat is receiving soon.");
    const [removed, added] = file.hunks[0].lines;
    expect(removed.intraline?.filter((span) => span.changed).map((span) => span.text)).toEqual(["adjusted"]);
    expect(added.intraline?.filter((span) => span.changed).map((span) => span.text)).toEqual(["receiving"]);
    const joined = (line: typeof removed) => line.intraline?.map((span) => span.text).join("");
    expect(joined(removed)).toBe(removed.text);
    expect(joined(added)).toBe(added.text);
  });

  test("the shared tool-edit diff keeps character-level highlights", () => {
    const file = diffFromClaudeEdit({ file_path: "a.ts", old_string: "adjusted", new_string: "adjuster" }).files[0];
    const changed = file.hunks[0].lines[1].intraline?.filter((span) => span.changed).map((span) => span.text);
    expect(changed).toEqual(["r"]);
  });

  test("two 32,000-byte texts with nothing in common are not truncated under the text caps", () => {
    const paragraph = (seed: string) => Array.from({ length: 200 }, (_, i) => `${seed} ${i} ${"x".repeat(150)}`).join("\n");
    const oldText = paragraph("old").slice(0, 32_000);
    const newText = paragraph("new").slice(0, 32_000);
    const file = diffFromTexts(oldText, newText);
    expect(file.truncated).toBe(false);
    expect(file.removed).toBe(oldText.split("\n").length);
    expect(file.added).toBe(newText.split("\n").length);
    expect(file.hunks.flatMap((hunk) => hunk.lines)).toHaveLength(file.added + file.removed);
  });

  test("past the table bound the middle becomes one removal run then one addition run", () => {
    const oldText = Array.from({ length: 1_100 }, (_, i) => `a${i}`).join("\n");
    const newText = Array.from({ length: 1_100 }, (_, i) => `b${i}`).join("\n");
    const rows = diffTextLines(oldText, newText);
    expect(rows.slice(0, 1_100).every((row) => row.t === "-")).toBe(true);
    expect(rows.slice(1_100).every((row) => row.t === "+")).toBe(true);
  });

  test("text caps truncate a runaway draft and keep the true counts", () => {
    const old = "start";
    const huge = Array.from({ length: TEXT_DIFF_CAPS.linesPerFile + 100 }, (_, i) => `row ${i}`).join("\n");
    const file = diffFromTexts(old, huge);
    expect(file.truncated).toBe(true);
    expect(file.added).toBe(TEXT_DIFF_CAPS.linesPerFile + 100);
    expect(file.hunks.flatMap((hunk) => hunk.lines)).toHaveLength(TEXT_DIFF_CAPS.linesPerFile);
  });

  test("the feed's default caps are unchanged by the caps parameter", () => {
    const big = Array.from({ length: DIFF_CAPS.linesPerFile + 50 }, (_, i) => `line ${i}`).join("\n");
    const file = only(normalizeEdit("Write", { file_path: "/repo/big.ts", content: big }).files);
    expect(file.truncated).toBe(true);
    expect(file.hunks.flatMap((hunk) => hunk.lines)).toHaveLength(DIFF_CAPS.linesPerFile);
    expect(DIFF_CAPS).toEqual({ files: 8, hunksPerFile: 16, linesPerFile: 200, charsPerLine: 2_000, totalChars: 64_000 });
  });

  test("a secret typed into the draft is redacted in the rendered model", () => {
    const sensitiveKey = String.fromCharCode(97, 112, 105, 95, 107, 101, 121);
    const file = diffFromTexts("a", `a\n${sensitiveKey}=SUPERSECRETVALUE`);
    expect(file.hunks.flatMap((hunk) => hunk.lines.map((line) => line.text)).join("\n")).not.toContain("SUPERSECRETVALUE");
  });
});
