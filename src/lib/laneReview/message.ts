import { orderComments, type LaneReviewComment } from "./model";

/* The text an agent receives for a lane review (docs/design/lane-diff-comments.md
   §5). Plain and deterministic: the frame is in the operator's language, the
   bodies are verbatim, and both SHAs are given in full. Composed only on the
   server, after the route checked every quote against the diff. */

export type LaneReviewLocale = "en" | "uk";

export type LaneReviewMessageInput = {
  locale: LaneReviewLocale;
  base: string;
  head: string;
  branch: string;
  note: string;
  comments: ReadonlyArray<Pick<LaneReviewComment, "path" | "side" | "line" | "quote" | "body">>;
  /** The lane's file list, in its own order. */
  pathOrder: readonly string[];
};

const FRAME = {
  en: {
    title: "Line comments on this lane's changes.",
    pair: (base: string, head: string, branch: string) => `Base ${base} · head ${head} (branch ${branch}).`,
    legend: "Line numbers: \"old\" is the file at the base commit, \"new\" is the file at the head commit.",
    overall: "Overall: ",
    side: { old: "old", new: "new" },
    file: "file",
    close: "Address each numbered comment on the branch, or answer why not.",
  },
  uk: {
    title: "Коментарі до змін у цій гілці.",
    pair: (base: string, head: string, branch: string) => `База ${base} · голова ${head} (гілка ${branch}).`,
    legend: "Номери рядків: «старий» — файл у базовому коміті, «новий» — у головному.",
    overall: "Загалом: ",
    side: { old: "старий", new: "новий" },
    file: "файл",
    close: "Виправте кожен пронумерований коментар у гілці або поясніть, чому ні.",
  },
} as const;

const indent = (text: string) => text.split("\n").map((line) => (line ? `   ${line}` : "")).join("\n");

export function composeLaneReviewMessage(input: LaneReviewMessageInput): string {
  const frame = FRAME[input.locale];
  const parts = [`${frame.title}\n${frame.pair(input.base, input.head, input.branch)}\n${frame.legend}`];
  const note = input.note.trim();
  if (note) parts.push(`${frame.overall}${note}`);
  orderComments(input.comments, input.pathOrder).forEach((comment, index) => {
    const where = comment.line === null ? `${comment.path} (${frame.file})` : `${comment.path}:${comment.line} (${frame.side[comment.side]})`;
    const quote = comment.quote ? `\n   > ${comment.quote}` : "";
    parts.push(`${index + 1}. ${where}${quote}\n${indent(comment.body.trim())}`);
  });
  parts.push(frame.close);
  return parts.join("\n\n");
}
