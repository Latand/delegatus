import type { DiffLine, FileDiff, Hunk } from "@/components/feed/diff";

/* The lane review's comment model (docs/design/lane-diff-comments.md §3),
   shared by the sheet and the send route. Pure: no storage, no network. */

/** `old` is the file at the base commit, `new` the file at the head commit. */
export type LaneReviewSide = "old" | "new";

export type LaneReviewComment = {
  /** Client-made id; never sent to the agent. */
  id: string;
  path: string;
  side: LaneReviewSide;
  /** 1-based in that side's file; null is a comment on the whole file. */
  line: number | null;
  /** The row's text as shown (already redacted), at most `quote` chars. */
  quote: string;
  body: string;
  state: "anchored" | "moved" | "detached";
};

export type LaneReviewSent = { operationId: string | null; clientMessageId: string; head: string; at: string; stageName: string; conversationId: string };

export type LaneReviewDraft = {
  v: 1;
  pipelineId: string;
  /** Renewed after a send; with the head it derives the delivery key. */
  draftId: string;
  /** The full SHAs the comments refer to. */
  base: string;
  head: string;
  targetConversationId: string | null;
  note: string;
  comments: LaneReviewComment[];
  sent?: LaneReviewSent;
  updatedAt: string;
};

export const LANE_REVIEW_LIMITS = { comments: 100, body: 4_000, quote: 200, note: 4_000 } as const;

export const SHA_RE = /^[0-9a-f]{40}$/;

export function laneReviewDraftKey(pipelineId: string): string {
  return `delegatus.laneReview.v1.${pipelineId}`;
}

/** The quote a row gives a comment: its shown text, cut to the quote limit. */
export function rowQuote(text: string): string {
  return text.slice(0, LANE_REVIEW_LIMITS.quote);
}

/** A diff row with its line number in each side's file it belongs to. */
export type NumberedRow = { line: DiffLine; header?: string; start: boolean; old?: number; new?: number };

const HUNK_HEADER_RE = /^-(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** The start lines of a git hunk header as `finalizeFile` keeps it
    (`-25,7 +25,7 @@ context`), or null for any other header. */
export function parseHunkHeader(header: string | undefined): { old: number; new: number } | null {
  const match = header?.match(HUNK_HEADER_RE);
  return match ? { old: Number(match[1]), new: Number(match[2]) } : null;
}

/**
 * Every row of the hunks, numbered from its hunk header: a `-` row has only
 * `old`, a `+` row only `new`, a context row both. A hunk without a git header
 * has no numbers. The caps keep a prefix of each hunk, so the numbering of a
 * kept row never depends on a dropped one; a dropped row has no row at all.
 */
export function numberRows(hunks: readonly Hunk[]): NumberedRow[] {
  const rows: NumberedRow[] = [];
  for (const hunk of hunks) {
    const start = parseHunkHeader(hunk.header);
    let oldLine = start?.old ?? 0;
    let newLine = start?.new ?? 0;
    hunk.lines.forEach((line, index) => {
      const row: NumberedRow = { line, header: index === 0 ? hunk.header : undefined, start: index === 0 };
      if (start) {
        if (line.t !== "+") row.old = oldLine++;
        if (line.t !== "-") row.new = newLine++;
      }
      rows.push(row);
    });
  }
  return rows;
}

/** Where a comment on this row anchors: a context row takes the new side. */
export function rowAnchor(row: NumberedRow): { side: LaneReviewSide; line: number } | null {
  if (row.new !== undefined) return { side: "new", line: row.new };
  if (row.old !== undefined) return { side: "old", line: row.old };
  return null;
}

/** The row a line comment points at, or undefined when the diff has none. */
export function findRow(rows: readonly NumberedRow[], side: LaneReviewSide, line: number): NumberedRow | undefined {
  return rows.find((row) => row[side] === line);
}

export type ReanchorResult = { comments: LaneReviewComment[]; moved: number; detached: number };

/**
 * Re-anchors comments made at an older head onto the diffs of a newer pair.
 * A line comment keeps its line when a row on its side still holds its exact
 * quote there, moves to the nearest row holding it otherwise, and is detached
 * (kept as a file comment with its quote) when no row holds it or its file is
 * no longer listed. A file comment is detached only when its file is gone.
 * Nothing is removed. `diffs` holds the new diff of each listed path that has
 * line comments; a path missing from it has no rows to match.
 */
export function reanchor(comments: readonly LaneReviewComment[], listedPaths: readonly string[], diffs: ReadonlyMap<string, FileDiff>): ReanchorResult {
  const listed = new Set(listedPaths);
  const rowsByPath = new Map<string, NumberedRow[]>();
  let moved = 0;
  let detached = 0;
  const detach = (comment: LaneReviewComment): LaneReviewComment => {
    detached += 1;
    return { ...comment, line: null, state: "detached" };
  };
  const next = comments.map((comment): LaneReviewComment => {
    if (!listed.has(comment.path)) return comment.state === "detached" && comment.line === null ? comment : detach(comment);
    if (comment.line === null) return comment;
    let rows = rowsByPath.get(comment.path);
    if (!rows) {
      rows = numberRows(diffs.get(comment.path)?.hunks ?? []);
      rowsByPath.set(comment.path, rows);
    }
    const old = comment.line;
    let best: number | null = null;
    for (const row of rows) {
      const line = row[comment.side];
      if (line === undefined || rowQuote(row.line.text) !== comment.quote) continue;
      if (best === null || Math.abs(line - old) < Math.abs(best - old) || (Math.abs(line - old) === Math.abs(best - old) && line < best)) best = line;
    }
    if (best === null) return detach(comment);
    if (best === old) return { ...comment, state: "anchored" };
    moved += 1;
    return { ...comment, line: best, state: "moved" };
  });
  return { comments: next, moved, detached };
}

/**
 * The order comments reach the agent in: the file list's order, then within a
 * file the file comments first, then the new side before the old one (their
 * numbers count lines of different files), then by line.
 */
export function orderComments<T extends Pick<LaneReviewComment, "path" | "side" | "line">>(comments: readonly T[], pathOrder: readonly string[]): T[] {
  const index = new Map(pathOrder.map((path, i) => [path, i]));
  const fileRank = (path: string) => index.get(path) ?? Number.MAX_SAFE_INTEGER;
  return comments
    .map((comment, i) => ({ comment, i }))
    .sort((a, b) => {
      const x = a.comment;
      const y = b.comment;
      return fileRank(x.path) - fileRank(y.path)
        || (x.path < y.path ? -1 : x.path > y.path ? 1 : 0)
        || (x.line === null ? 0 : 1) - (y.line === null ? 0 : 1)
        || (x.side === "new" ? 0 : 1) - (y.side === "new" ? 0 : 1)
        || (x.line ?? 0) - (y.line ?? 0)
        || a.i - b.i;
    })
    .map(({ comment }) => comment);
}

/** Parses a stored draft; anything malformed is null, so a corrupt entry
    starts a new draft instead of breaking the sheet. */
export function parseLaneReviewDraft(raw: string | null, pipelineId: string): LaneReviewDraft | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as LaneReviewDraft;
    if (!value || value.v !== 1 || value.pipelineId !== pipelineId || typeof value.draftId !== "string") return null;
    if (!SHA_RE.test(value.base) || !SHA_RE.test(value.head) || !Array.isArray(value.comments)) return null;
    const comments = value.comments.filter((comment) => comment && typeof comment.path === "string" && typeof comment.body === "string"
      && (comment.side === "old" || comment.side === "new") && (comment.line === null || Number.isInteger(comment.line))
      && typeof comment.quote === "string" && typeof comment.id === "string");
    return { ...value, note: typeof value.note === "string" ? value.note : "", comments };
  } catch {
    return null;
  }
}
