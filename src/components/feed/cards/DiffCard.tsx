"use client";

import { useState } from "react";

import { ChevronUp } from "../../icons";
import { MESSAGE_ACTION } from "../actionStyles";
import { CopyButton } from "../CopyButton";
import { tr, type ToolBody } from "../parse";
import { FileRef } from "./shared";
import type { DiffLine, FileDiff, Hunk } from "../diff";

/** Level-1 visible-line budget per file: a compact preview of the first lines
    shown expanded by default; "show all" reveals the capped rest (issue #90). */
const PREVIEW_LINES = 8;

const OP_TONE: Record<FileDiff["op"], string> = {
  add: "text-diff-add",
  update: "text-accent",
  delete: "text-diff-del",
  move: "text-accent",
};

function humanKb(chars: number): string {
  return `${Math.max(1, Math.round(chars / 1024))} kB`;
}

export type DiffRow = { line: DiffLine; header?: string; /** First row of its hunk. */ start?: boolean };

export function flattenHunks(hunks: Hunk[]): DiffRow[] {
  const out: DiffRow[] = [];
  for (const hunk of hunks) {
    let first = true;
    for (const line of hunk.lines) {
      out.push({ line, header: first ? hunk.header : undefined, start: first });
      first = false;
    }
  }
  return out;
}

function LineRow({ line, prose = false }: { line: DiffLine; prose?: boolean }) {
  const tone =
    line.t === "+"
      ? "bg-diff-add-soft text-diff-add"
      : line.t === "-"
        ? "bg-diff-del-soft text-diff-del"
        : "text-primary";
  /* The wrapping prose rows read as text, so a highlighted word keeps the
     reader's own ink: the row's add/del ink on the stronger tint is 3.8:1. */
  const intralineTone = `${line.t === "+" ? "bg-diff-add-strong" : "bg-diff-del-strong"}${prose ? " text-primary" : ""}`;
  const content = line.intraline
    ? line.intraline.map((span, index) =>
        span.changed ? (
          <span key={index} className={intralineTone}>
            {span.text}
          </span>
        ) : (
          span.text
        ),
      )
    : line.text || " ";
  if (prose) {
    /* Prose rows wrap, so the marker sits in its own column and a wrapped line
       stays under its own text instead of under the marker. */
    return (
      <div className={`flex gap-1.5 px-2 ${tone}`} data-orchestrator-mandate-diff-line={line.t}>
        <span className="w-[1ch] shrink-0 font-mono">{line.t}</span>
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{content}</span>
      </div>
    );
  }
  return (
    <div className={`whitespace-pre px-2 ${tone}`}>
      {/* The +/- marker is real text content, so screen readers and copy keep it. */}
      {line.t}
      {content}
    </div>
  );
}

/** The diff's rows in the feed's own tones and intraline spans. `prose` is the
    wrapping variant a mandate (paragraphs, not code) is read in: sans, wrapped,
    hunk captions without the `@@` prefix. */
export function DiffRows({ rows, prose = false }: { rows: DiffRow[]; prose?: boolean }) {
  return (
    <>
      {rows.map(({ line, header, start }, i) => (
        <div key={i} className={prose && start && i > 0 ? "mt-1 border-t border-border pt-1" : undefined}>
          {header ? (
            <div className={prose ? "break-words px-2 pt-1 text-caption text-muted" : "whitespace-pre px-2 text-muted"}>
              {prose ? header : `@@ ${header}`}
            </div>
          ) : null}
          <LineRow line={line} prose={prose} />
        </div>
      ))}
    </>
  );
}

function FileDiffView({ file }: { file: FileDiff }) {
  const [all, setAll] = useState(false);
  const rows = flattenHunks(file.hunks);
  const overflow = rows.length > PREVIEW_LINES;
  const visible = all ? rows : rows.slice(0, PREVIEW_LINES);
  const copyText = file.hunks.flatMap((hunk) => hunk.lines.map((line) => line.t + line.text)).join("\n");
  return (
    <div className="group/diff relative overflow-hidden rounded-[10px] border border-border bg-sunken">
      <div className="flex items-center gap-2 border-b border-border px-2.5 py-1 text-[11.5px]">
        <span className={`shrink-0 font-semibold uppercase ${OP_TONE[file.op]}`}>{file.op}</span>
        <span className="min-w-0 flex-1 truncate">
          <FileRef file={file.path} />
        </span>
        {file.binary ? null : (
          <span className="shrink-0 font-mono text-[11px]">
            <span className="text-diff-add">+{file.added}</span> <span className="text-diff-del">−{file.removed}</span>
          </span>
        )}
        {copyText ? (
          <CopyButton
            text={copyText}
            label={tr("tools.copyDiff")}
            className={`shrink-0 ${MESSAGE_ACTION} group-hover/diff:opacity-100`}
          />
        ) : null}
      </div>
      {file.binary ? (
        <div className="px-2.5 py-2 text-[11.5px] text-muted">{tr("tools.binaryContent", { size: humanKb(file.added + file.removed) })}</div>
      ) : rows.length ? (
        <>
          <div className="max-w-full overflow-x-auto py-1 font-mono text-[11.5px] leading-[1.5]">
            <DiffRows rows={visible} />
          </div>
          {overflow ? (
            <button
              type="button"
              onClick={() => setAll((value) => !value)}
              className="w-full border-t border-border px-2.5 py-1 text-left text-[11px] font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              {all ? (
                <span className="inline-flex items-center gap-1">
                  {tr("common.collapse")} <ChevronUp className="h-3 w-3" aria-hidden />
                </span>
              ) : (
                tr("tools.showAllLines", { count: rows.length })
              )}
            </button>
          ) : null}
        </>
      ) : null}
      {file.truncated ? <div className="border-t border-border px-2.5 py-0.5 text-[10.5px] text-muted">{tr("tools.diffTruncated")}</div> : null}
    </div>
  );
}

export function DiffCard({ body }: { body: ToolBody }) {
  return (
    <div className="mt-1.5 space-y-1.5">
      {body.files.map((file, i) => (
        <FileDiffView key={`${file.path}:${i}`} file={file} />
      ))}
      {body.filesTruncated ? <div className="text-[11px] text-muted">{tr("tools.moreFiles", { count: body.files.length })}</div> : null}
    </div>
  );
}
