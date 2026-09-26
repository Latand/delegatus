import type { ReportLogAsk } from "@/lib/asks/types";
import type { ReportLogCard, ReportLogEntry } from "@/lib/bridge/reportLog";

/*
 * The report log's pure half (#2146): how a body splits into text and links,
 * how an entry's time reads, and where the operator last looked.
 */

export type BodySegment =
  | { kind: "text"; text: string }
  | { kind: "github"; text: string; href: string }
  | { kind: "card"; text: string; card: ReportLogCard };

/* `#123`, or `owner/repo#123`, not inside a word or a URL fragment. */
const ISSUE_REF = /(?<![\w/&#])(?:([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+))?#(\d+)(?![\w-])/g;
const ID_CHAR = /[A-Za-z0-9._-]/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The body as written, cut into text and links: `#123` to the project's GitHub
 * repository (none without one), `owner/repo#123` to that repository, and every
 * card id the server said the board knows to that card.
 */
export function bodySegments(body: string, github: string | null, cards: readonly ReportLogCard[]): BodySegment[] {
  const spans: { start: number; end: number; segment: BodySegment }[] = [];
  for (const match of body.matchAll(ISSUE_REF)) {
    const repository = match[1] ?? github;
    if (!repository) continue;
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      segment: { kind: "github", text: match[0], href: `https://github.com/${repository}/issues/${match[2]}` },
    });
  }
  for (const card of cards) {
    for (const match of body.matchAll(new RegExp(escapeRegExp(card.id), "g"))) {
      const before = body[match.index - 1];
      const after = body[match.index + card.id.length];
      if ((before && ID_CHAR.test(before)) || (after && ID_CHAR.test(after) && !/[.]/.test(after))) continue;
      spans.push({ start: match.index, end: match.index + card.id.length, segment: { kind: "card", text: card.id, card } });
    }
  }
  spans.sort((left, right) => left.start - right.start || right.end - left.end);
  const segments: BodySegment[] = [];
  let at = 0;
  for (const span of spans) {
    if (span.start < at) continue;
    if (span.start > at) segments.push({ kind: "text", text: body.slice(at, span.start) });
    segments.push(span.segment);
    at = span.end;
  }
  if (at < body.length) segments.push({ kind: "text", text: body.slice(at) });
  return segments;
}

/** The entry's local time: the clock alone today, the day and the clock before. */
export function entryTime(at: string, locale: string, now: Date = new Date()): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  const clock = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  if (sameDay) return clock;
  const day = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  }).format(date);
  return `${day} ${clock}`;
}

const SEEN_KEY = (project: string) => `llvReportLogSeen:${project}`;

/** The newest seq the operator has seen, or null before they ever looked. */
export function readSeenSeq(project: string): number | null {
  try {
    const value = Number(window.localStorage.getItem(SEEN_KEY(project)));
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function writeSeenSeq(project: string, seq: number): void {
  try {
    const held = readSeenSeq(project);
    if (held !== null && held >= seq) return;
    window.localStorage.setItem(SEEN_KEY(project), String(seq));
  } catch {
    /* private mode: every open starts with nothing marked */
  }
}

/**
 * The newest page merged into what the log holds. A page that does not reach
 * back to the held head (more arrived than one page holds) replaces the list,
 * so the log never shows a hole.
 */
export function mergeNewest(
  held: readonly ReportLogEntry[],
  heldBefore: number | null,
  page: { entries: readonly ReportLogEntry[]; nextBefore: number | null },
): { entries: ReportLogEntry[]; nextBefore: number | null } {
  if (held.length === 0) return { entries: [...page.entries], nextBefore: page.nextBefore };
  const head = held[0]!.seq;
  const fresh = page.entries.filter((entry) => entry.seq > head);
  const oldest = page.entries.at(-1);
  if (page.nextBefore !== null && oldest && oldest.seq > head) return { entries: [...page.entries], nextBefore: page.nextBefore };
  return { entries: [...fresh, ...held], nextBefore: heldBefore };
}

/** Ask lines held and arrived, one per id, newest first. */
export function mergeAsks(held: readonly ReportLogAsk[], incoming: readonly ReportLogAsk[]): ReportLogAsk[] {
  if (!incoming.length) return [...held];
  const byId = new Map(held.map((ask) => [ask.id, ask] as const));
  for (const ask of incoming) byId.set(ask.id, ask);
  return [...byId.values()].sort((left, right) => Date.parse(right.at) - Date.parse(left.at) || left.id.localeCompare(right.id));
}

/** The server's order for ask lines: newest first, then by id. */
function askPrecedes(left: ReportLogAsk, right: ReportLogAsk): boolean {
  const byTime = Date.parse(left.at) - Date.parse(right.at);
  return byTime > 0 || (byTime === 0 && left.id.localeCompare(right.id) < 0);
}

/**
 * The newest ask page merged into the asks held, as `mergeNewest` does for the
 * reports: a page that does not reach back to the held head (more asked than
 * one page holds) replaces the list and its cursor, so no line goes missing
 * between them.
 */
export function mergeNewestAsks(
  held: readonly ReportLogAsk[],
  heldBefore: string | null,
  page: { asks: readonly ReportLogAsk[]; nextAsksBefore: string | null },
): { asks: ReportLogAsk[]; nextAsksBefore: string | null } {
  if (held.length === 0) return { asks: [...page.asks], nextAsksBefore: page.nextAsksBefore };
  const oldest = page.asks.at(-1);
  if (page.nextAsksBefore !== null && oldest && askPrecedes(oldest, held[0]!)) return { asks: [...page.asks], nextAsksBefore: page.nextAsksBefore };
  return { asks: mergeAsks(held, page.asks), nextAsksBefore: heldBefore };
}

export type ReportLogRow =
  | { kind: "report"; key: string; entry: ReportLogEntry }
  | { kind: "ask"; key: string; ask: ReportLogAsk };

/**
 * The log as one timeline, newest first: the orchestrator's reports and the
 * Viewer's ask lines by time. Each pages on its own cursor, so a line shows
 * only once everything newer of both kinds is held: nothing older than the
 * oldest report held while older reports remain, nor than the oldest ask held
 * while older asks remain. A line never shows out of its place, and the last
 * page shows the rest.
 */
export function reportLogRows(
  entries: readonly ReportLogEntry[],
  asks: readonly ReportLogAsk[],
  complete: { reports: boolean; asks: boolean },
): ReportLogRow[] {
  const oldestEntry = entries.at(-1);
  const oldestAsk = asks.at(-1);
  const floor = Math.max(
    !complete.reports && oldestEntry ? Date.parse(oldestEntry.at) : Number.NEGATIVE_INFINITY,
    !complete.asks && oldestAsk ? Date.parse(oldestAsk.at) : Number.NEGATIVE_INFINITY,
  );
  /* A time that does not parse keeps its row: it cannot be placed, but it was sent. */
  const within = (at: number) => !(at < floor);
  const rows: { at: number; row: ReportLogRow }[] = [
    ...entries
      .map((entry) => ({ at: Date.parse(entry.at), row: { kind: "report" as const, key: `r:${entry.seq}`, entry } }))
      .filter((row) => within(row.at)),
    ...asks
      .map((ask) => ({ at: Date.parse(ask.at), row: { kind: "ask" as const, key: `a:${ask.id}`, ask } }))
      .filter((row) => within(row.at)),
  ];
  return rows
    .sort((left, right) => (right.at || 0) - (left.at || 0) || (left.row.kind === right.row.kind ? 0 : left.row.kind === "report" ? -1 : 1))
    .map((item) => item.row);
}

/** Where an ask line's link goes: the conversation, by its durable id. */
export function askHref(ask: Pick<ReportLogAsk, "conversationId" | "path">): string {
  return ask.conversationId ? `#c=${encodeURIComponent(ask.conversationId)}` : `#f=${encodeURIComponent(ask.path)}`;
}
