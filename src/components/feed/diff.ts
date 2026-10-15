import { redactSecrets } from "@/lib/review";

/* Source-agnostic diff model shared by Claude Edit/MultiEdit/Write and Codex
   apply_patch. Every string it exposes is redacted and capped in one place
   (`finalize`), so a renderer or copy consumer never sees an unbounded or
   unredacted line — the funnel invariant from the issue #9 contract §4/§5. */

export type FileOp = "add" | "update" | "delete" | "move";
export type IntralineSpan = { text: string; changed: boolean };
export type DiffLine = { t: "+" | "-" | " "; text: string; intraline?: IntralineSpan[] };
export type Hunk = { header?: string; lines: DiffLine[] };
export interface FileDiff {
  path: string;
  op: FileOp;
  hunks: Hunk[];
  /** True line counts, measured before any cap is applied. */
  added: number;
  removed: number;
  binary: boolean;
  /** Any per-file cap (lines, chars, total budget) was hit. */
  truncated: boolean;
}
export interface DiffModel {
  files: FileDiff[];
  filesTruncated: boolean;
}

export interface DiffCaps {
  files: number;
  hunksPerFile: number;
  linesPerFile: number;
  charsPerLine: number;
  totalChars: number;
}

export const DIFF_CAPS = {
  files: 8,
  hunksPerFile: 16,
  linesPerFile: 200,
  charsPerLine: 2_000,
  totalChars: 64_000,
} as const satisfies DiffCaps;

/** Caps for a whole-text diff (the rotation dialog's mandate). Two mandates at
    the 32,000-byte structured envelope total at most 64,000 chars, so this
    leaves twice that headroom for a draft typed past the envelope. */
export const TEXT_DIFF_CAPS: DiffCaps = {
  files: 1,
  hunksPerFile: 500,
  linesPerFile: 2_000,
  charsPerLine: 8_000,
  totalChars: 128_000,
};

const BLOB_MIN = 20_000;
const INTRALINE_MIN_SIMILARITY = 0.5;
const INTRALINE_MAX_CELLS = 250_000;

type IntralineEdit = { kind: "same" | "remove" | "add"; text: string };

function addSpan(spans: IntralineSpan[], text: string, changed: boolean): void {
  if (!text) return;
  const previous = spans.at(-1);
  if (previous && previous.changed === changed) {
    previous.text += text;
    return;
  }
  spans.push({ text, changed });
}

/**
 * Build a compact character-level LCS edit sequence for a pair of replacement
 * lines. A bounded table prevents generated lines from making one tool event
 * expensive to render.
 */
function intralineEdits(removed: string, added: string): IntralineEdit[] | null {
  const oldChars = Array.from(removed);
  const newChars = Array.from(added);
  if (!oldChars.length || !newChars.length || oldChars.length * newChars.length > INTRALINE_MAX_CELLS) return null;

  const columns = newChars.length + 1;
  const table = new Uint16Array((oldChars.length + 1) * columns);
  for (let oldIndex = 1; oldIndex <= oldChars.length; oldIndex += 1) {
    for (let newIndex = 1; newIndex <= newChars.length; newIndex += 1) {
      const cell = oldIndex * columns + newIndex;
      table[cell] =
        oldChars[oldIndex - 1] === newChars[newIndex - 1]
          ? table[(oldIndex - 1) * columns + newIndex - 1] + 1
          : Math.max(table[(oldIndex - 1) * columns + newIndex], table[oldIndex * columns + newIndex - 1]);
    }
  }
  const lcsLength = table[oldChars.length * columns + newChars.length];
  if (lcsLength / Math.max(oldChars.length, newChars.length) < INTRALINE_MIN_SIMILARITY) return null;

  const reverse: IntralineEdit[] = [];
  let oldIndex = oldChars.length;
  let newIndex = newChars.length;
  while (oldIndex || newIndex) {
    if (oldIndex && newIndex && oldChars[oldIndex - 1] === newChars[newIndex - 1]) {
      reverse.push({ kind: "same", text: oldChars[oldIndex - 1] });
      oldIndex -= 1;
      newIndex -= 1;
    } else if (oldIndex && (!newIndex || table[(oldIndex - 1) * columns + newIndex] >= table[oldIndex * columns + newIndex - 1])) {
      reverse.push({ kind: "remove", text: oldChars[oldIndex - 1] });
      oldIndex -= 1;
    } else {
      reverse.push({ kind: "add", text: newChars[newIndex - 1] });
      newIndex -= 1;
    }
  }
  return reverse.reverse();
}

function intralineSpans(edits: IntralineEdit[], side: "remove" | "add"): IntralineSpan[] {
  const spans: IntralineSpan[] = [];
  for (const edit of edits) {
    if (edit.kind === "same") addSpan(spans, edit.text, false);
    else if (edit.kind === side) addSpan(spans, edit.text, true);
  }
  return spans;
}

/** Add spans only to paired runs of removed and added lines in one hunk. */
function addIntralineHighlights(lines: DiffLine[]): DiffLine[] {
  const highlighted = lines.map((line) => ({ ...line }));
  let index = 0;
  while (index < highlighted.length) {
    if (highlighted[index].t !== "-") {
      index += 1;
      continue;
    }
    const removedStart = index;
    while (index < highlighted.length && highlighted[index].t === "-") index += 1;
    const addedStart = index;
    while (index < highlighted.length && highlighted[index].t === "+") index += 1;
    const pairs = Math.min(addedStart - removedStart, index - addedStart);
    for (let pair = 0; pair < pairs; pair += 1) {
      const removed = highlighted[removedStart + pair];
      const added = highlighted[addedStart + pair];
      if (removed.text === added.text) continue;
      const edits = intralineEdits(removed.text, added.text);
      if (!edits) continue;
      removed.intraline = intralineSpans(edits, "remove");
      added.intraline = intralineSpans(edits, "add");
    }
  }
  return highlighted;
}

/* A near-whitespace-free run this large is base64/binary content. Its renderer
   shows a size chip and hides thousands of unreadable "+" lines. */
function looksLikeBinary(text: string): boolean {
  if (text.length <= BLOB_MIN) return false;
  const ws = text.match(/\s/g)?.length ?? 0;
  return ws / text.length < 0.02;
}

interface RawFile {
  path: string;
  op: FileOp;
  /** ThreadItem changes are meaningful even when an added file is empty. */
  includeEmpty?: boolean;
  /** Raw (unredacted, uncapped) lines grouped by hunk. */
  hunks: { header?: string; lines: DiffLine[] }[];
  /** Original payload used only for the binary heuristic. */
  content: string;
}

function splitLines(text: string): string[] {
  if (!text.length) return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function fileHasContent(raw: RawFile): boolean {
  if (raw.includeEmpty) return true;
  if (raw.op === "delete" || raw.op === "move") return true;
  return raw.hunks.some((hunk) => hunk.lines.length > 0);
}

/* Applies every §4 cap once, redacting each line before it is sliced so a secret
   straddling the char boundary cannot survive in the kept half. `budget` is the
   per-event total-char allowance, shared across the files of one event. */
function finalizeFile(raw: RawFile, budget: { remaining: number }, caps: DiffCaps = DIFF_CAPS): FileDiff {
  let added = 0;
  let removed = 0;
  for (const hunk of raw.hunks) {
    for (const line of hunk.lines) {
      if (line.t === "+") added += 1;
      else if (line.t === "-") removed += 1;
    }
  }
  if (looksLikeBinary(raw.content)) {
    return { path: raw.path, op: raw.op, hunks: [], added, removed, binary: true, truncated: false };
  }
  let truncated = false;
  let lineCount = 0;
  let hunkCount = 0;
  const hunks: Hunk[] = [];
  for (const rawHunk of raw.hunks) {
    if (hunkCount >= caps.hunksPerFile) {
      truncated = true;
      break;
    }
    const lines: DiffLine[] = [];
    let stop = false;
    for (const rawLine of rawHunk.lines) {
      if (lineCount >= caps.linesPerFile) {
        truncated = true;
        stop = true;
        break;
      }
      let text = redactSecrets(rawLine.text);
      if (text.length > caps.charsPerLine) {
        text = text.slice(0, caps.charsPerLine);
        truncated = true;
      }
      if (budget.remaining - text.length < 0) {
        truncated = true;
        stop = true;
        break;
      }
      budget.remaining -= text.length;
      lines.push({ t: rawLine.t, text });
      lineCount += 1;
    }
    /* Flush the lines gathered before the cap tripped, then stop — a `break`
       past this push would silently drop the kept half of the diff. */
    if (lines.length) {
      const highlighted = addIntralineHighlights(lines);
      hunks.push(rawHunk.header ? { header: rawHunk.header, lines: highlighted } : { lines: highlighted });
      hunkCount += 1;
    }
    if (stop) break;
  }
  return { path: raw.path, op: raw.op, hunks, added, removed, binary: false, truncated };
}

function finalize(rawFiles: RawFile[]): DiffModel {
  const meaningful = rawFiles.filter(fileHasContent);
  const filesTruncated = meaningful.length > DIFF_CAPS.files;
  const kept = meaningful.slice(0, DIFF_CAPS.files);
  const budget = { remaining: DIFF_CAPS.totalChars };
  return { files: kept.map((raw) => finalizeFile(raw, budget)), filesTruncated };
}

const EMPTY: DiffModel = { files: [], filesTruncated: false };

function replacementHunk(oldText: string, newText: string): { hunk: { lines: DiffLine[] }; content: string } {
  const lines: DiffLine[] = [];
  for (const text of splitLines(oldText)) lines.push({ t: "-", text });
  for (const text of splitLines(newText)) lines.push({ t: "+", text });
  return { hunk: { lines }, content: `${oldText}\n${newText}` };
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function validPath(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Claude `Write`: the whole file is new, so every line is an addition. */
export function diffFromWrite(args: Record<string, unknown>): DiffModel {
  const path = validPath(args.file_path ?? args.path);
  const content = str(args.content ?? args.new_string);
  if (!path) return EMPTY;
  const { hunk, content: payload } = replacementHunk("", content);
  return finalize([{ path, op: "add", hunks: [hunk], content: payload }]);
}

/** Claude `Edit`/`MultiEdit`/`NotebookEdit`: one file, one hunk per edit. An
    edit with no `old_string` is a new-file write (all additions). */
export function diffFromClaudeEdit(args: Record<string, unknown>): DiffModel {
  const path = validPath(args.file_path ?? args.path ?? args.notebook_path);
  if (!path) return EMPTY;
  const editList = Array.isArray(args.edits)
    ? args.edits.filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
    : [{ old_string: args.old_string, new_string: args.new_string ?? args.new_source ?? args.content }];
  const hunks: { lines: DiffLine[] }[] = [];
  const contentParts: string[] = [];
  let anyRemoval = false;
  for (const edit of editList) {
    const oldText = str(edit.old_string);
    const newText = str(edit.new_string ?? edit.new_source ?? edit.content);
    if (!oldText && !newText) continue;
    if (oldText) anyRemoval = true;
    const { hunk, content } = replacementHunk(oldText, newText);
    hunks.push(hunk);
    contentParts.push(content);
  }
  if (!hunks.length) return EMPTY;
  return finalize([{ path, op: anyRemoval ? "update" : "add", hunks, content: contentParts.join("\n") }]);
}

const PATCH_ADD_RE = /^\*{0,3}\s*Add File:\s*(.+)$/;
const PATCH_UPDATE_RE = /^\*{0,3}\s*Update File:\s*(.+)$/;
const PATCH_DELETE_RE = /^\*{0,3}\s*Delete File:\s*(.+)$/;
const PATCH_MOVE_RE = /^\*{0,3}\s*Move to:\s*(.+)$/;
const PATCH_HUNK_RE = /^@@(.*)$/;

/** Codex `apply_patch` grammar → the same capped model. Tolerant of a missing
    terminator and of `+++`/`---`-looking content inside a hunk (the leading
    marker is consumed, the remainder is literal text). */
export function diffFromApplyPatch(patch: string): DiffModel {
  const files: RawFile[] = [];
  let current: RawFile | null = null;
  let hunk: { header?: string; lines: DiffLine[] } | null = null;
  const startHunk = (header?: string) => {
    if (!current) return;
    hunk = header !== undefined ? { header, lines: [] } : { lines: [] };
    current.hunks.push(hunk);
  };
  const pushLine = (line: DiffLine) => {
    if (!current) return;
    if (!hunk) startHunk();
    hunk!.lines.push(line);
  };
  for (const rawLine of patch.split("\n")) {
    if (/^\*{3}\s*(Begin|End) Patch/.test(rawLine)) continue;
    const add = rawLine.match(PATCH_ADD_RE);
    const update = rawLine.match(PATCH_UPDATE_RE);
    const del = rawLine.match(PATCH_DELETE_RE);
    const move = rawLine.match(PATCH_MOVE_RE);
    if (add) {
      current = { path: add[1].trim(), op: "add", hunks: [], content: "" };
      hunk = null;
      files.push(current);
      continue;
    }
    if (update) {
      current = { path: update[1].trim(), op: "update", hunks: [], content: "" };
      hunk = null;
      files.push(current);
      continue;
    }
    if (del) {
      current = { path: del[1].trim(), op: "delete", hunks: [], content: "" };
      hunk = null;
      files.push(current);
      continue;
    }
    if (move && current) {
      current.op = "move";
      current.path = move[1].trim();
      continue;
    }
    const hunkHeader = rawLine.match(PATCH_HUNK_RE);
    if (hunkHeader) {
      startHunk(hunkHeader[1].trim());
      continue;
    }
    if (!current) continue;
    const marker = rawLine[0];
    if (marker === "+") pushLine({ t: "+", text: rawLine.slice(1) });
    else if (marker === "-") pushLine({ t: "-", text: rawLine.slice(1) });
    else pushLine({ t: " ", text: rawLine.startsWith(" ") ? rawLine.slice(1) : rawLine });
  }
  for (const file of files) {
    file.content = file.hunks.flatMap((h) => h.lines.map((l) => l.text)).join("\n");
  }
  return finalize(files);
}

/** Codex 0.151 ThreadItem file changes. Rollouts carry a path-keyed map with
    `type` plus `unified_diff`, or `content` for add/delete; pagination carries an array with
    `path`/`kind`/`diff`. Both shapes enter the existing capped DiffModel so the
    feed keeps one edit-card renderer and one redaction boundary. */
export function diffFromCodexFileChange(changes: unknown): DiffModel {
  const entries: Array<{ path: string; change: Record<string, unknown> }> = Array.isArray(changes)
    ? changes.flatMap((value) => {
        const change = record(value);
        const path = validPath(change.path);
        return path ? [{ path, change }] : [];
      })
    : Object.entries(record(changes)).flatMap(([path, value]) => path.trim() ? [{ path, change: record(value) }] : []);
  const files: RawFile[] = [];
  for (const { path: sourcePath, change } of entries) {
    const kind = record(change.kind);
    const changeType = str(kind.type ?? change.type).toLowerCase();
    const movePath = validPath(kind.move_path ?? kind.movePath ?? change.move_path ?? change.movePath);
    let op: FileOp = "update";
    if (movePath) op = "move";
    else if (changeType === "add" || changeType === "delete") op = changeType;
    const path = movePath ?? sourcePath;
    const patch = str(change.diff ?? change.unified_diff ?? change.unifiedDiff);
    const fileContent = str(change.content);
    const content = patch || (op === "add" || op === "delete" ? fileContent : "");
    const hunks: RawFile["hunks"] = [];
    let hunk: RawFile["hunks"][number] | null = null;
    const startHunk = (header?: string) => {
      hunk = header ? { header, lines: [] } : { lines: [] };
      hunks.push(hunk);
    };
    if (!patch && (op === "add" || op === "delete")) {
      const marker = op === "add" ? "+" : "-";
      const lines = splitLines(fileContent).map((text): DiffLine => ({ t: marker, text }));
      if (lines.length) hunks.push({ lines });
    }
    for (const line of patch.split("\n")) {
      const header = line.match(/^@@(.*)$/);
      if (header) {
        startHunk(header[1].trim());
        continue;
      }
      if (/^(?:diff --git|index |--- |\+\+\+ |\\ No newline at end of file)/.test(line)) continue;
      const marker = line[0];
      if (marker !== "+" && marker !== "-" && marker !== " ") continue;
      if (!hunk) startHunk();
      hunk!.lines.push({ t: marker, text: line.slice(1) });
    }
    files.push({ path, op, hunks, content, includeEmpty: true });
  }
  return finalize(files);
}

/** Dispatch by tool name; the one entry point the parser calls for Claude
    edits. Codex `apply_patch` reaches {@link diffFromApplyPatch} directly. */
export function normalizeEdit(tool: string, args: Record<string, unknown>): DiffModel {
  if (tool === "Write") return diffFromWrite(args);
  if (tool === "Edit" || tool === "MultiEdit" || tool === "NotebookEdit") return diffFromClaudeEdit(args);
  if (tool === "apply_patch") return diffFromApplyPatch(str(args.input));
  return EMPTY;
}

/** Largest LCS table a whole-text diff builds (cells). A middle run past it
    becomes one removal run and one addition run. */
const TEXT_DIFF_MAX_CELLS = 1_000_000;

/**
 * A line diff of two whole texts. Both are split on "\n" and every segment is
 * kept, so a trailing newline or a CRLF is a changed line, exactly as the
 * receiver would see it. The common prefix and suffix are trimmed, then an LCS
 * table (bounded by `TEXT_DIFF_MAX_CELLS`) decides the middle. On ties
 * removals come before additions, so a reworded paragraph reads `-old` then
 * `+new` and pairs up for the intraline highlight.
 */
export function diffTextLines(oldText: string, newText: string): DiffLine[] {
  if (oldText === newText) return oldText.split("\n").map((text): DiffLine => ({ t: " ", text }));
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  const out: DiffLine[] = oldLines.slice(0, start).map((text): DiffLine => ({ t: " ", text }));
  const rows = oldEnd - start;
  const columns = newEnd - start;
  if (rows === 0 || columns === 0 || (rows + 1) * (columns + 1) > TEXT_DIFF_MAX_CELLS) {
    for (let i = start; i < oldEnd; i += 1) out.push({ t: "-", text: oldLines[i] });
    for (let j = start; j < newEnd; j += 1) out.push({ t: "+", text: newLines[j] });
  } else {
    /* table[i][j] is the LCS of the middle's tails from old row i and new row j. */
    const width = columns + 1;
    const table = new Uint32Array((rows + 1) * width);
    for (let i = rows - 1; i >= 0; i -= 1) {
      for (let j = columns - 1; j >= 0; j -= 1) {
        table[i * width + j] =
          oldLines[start + i] === newLines[start + j]
            ? table[(i + 1) * width + j + 1] + 1
            : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < rows || j < columns) {
      if (i < rows && j < columns && oldLines[start + i] === newLines[start + j]) {
        out.push({ t: " ", text: oldLines[start + i] });
        i += 1;
        j += 1;
      } else if (i < rows && (j >= columns || table[(i + 1) * width + j] >= table[i * width + j + 1])) {
        out.push({ t: "-", text: oldLines[start + i] });
        i += 1;
      } else {
        out.push({ t: "+", text: newLines[start + j] });
        j += 1;
      }
    }
  }
  for (let i = oldEnd; i < oldLines.length; i += 1) out.push({ t: " ", text: oldLines[i] });
  return out;
}

const HEADING_RE = /^#{1,6} /;

/**
 * The whole-text diff as the shared `FileDiff` model: `context` unchanged
 * lines around each change (lines are paragraphs, so one is enough), each hunk
 * headed by the nearest heading above it, and the model's own redaction,
 * intraline highlights and truncation under `TEXT_DIFF_CAPS`. Equal texts give
 * a model with no hunks.
 */
export function diffFromTexts(oldText: string, newText: string, options: { path?: string; context?: number } = {}): FileDiff {
  const context = options.context ?? 1;
  const ops = diffTextLines(oldText, newText);
  const near = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, index) => {
    if (op.t === " ") return;
    for (let k = Math.max(0, index - context); k <= Math.min(ops.length - 1, index + context); k += 1) near[k] = true;
  });
  const hunks: { header?: string; lines: DiffLine[] }[] = [];
  let index = 0;
  while (index < ops.length) {
    if (!near[index]) {
      index += 1;
      continue;
    }
    const first = index;
    while (index < ops.length && near[index]) index += 1;
    let header: string | undefined;
    if (!(ops[first].t !== "-" && HEADING_RE.test(ops[first].text))) {
      for (let k = first - 1; k >= 0; k -= 1) {
        if (ops[k].t !== "-" && HEADING_RE.test(ops[k].text)) {
          header = ops[k].text;
          break;
        }
      }
    }
    const lines = ops.slice(first, index);
    hunks.push(header ? { header, lines } : { lines });
  }
  return finalizeFile(
    { path: options.path ?? "mandate", op: "update", hunks, content: "", includeEmpty: true },
    { remaining: TEXT_DIFF_CAPS.totalChars },
    TEXT_DIFF_CAPS,
  );
}
