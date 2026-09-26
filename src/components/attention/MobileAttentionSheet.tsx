"use client";

import { useEffect, useState } from "react";

import { ChevronDown, ChevronRight, X } from "@/components/icons";
import { ChatEngineMark } from "@/components/mobile/chatEngineMark";
import type { MobileBoardPipelineRow } from "@/components/mobile/mobileBoardModel";
import { showReceipt } from "@/components/mobile/MobileReceipt";
import { topScreen, useMobileNav, type MobileScreen } from "@/components/mobile/mobileNav";
import { MobileSheet, MobileSheetSection } from "@/components/mobile/MobileSheet";
import type { AttentionNotice } from "@/lib/attention/types";
import { projectTitle } from "@/lib/displayNames";
import { useLocale } from "@/lib/i18n";
import type { Pipeline } from "@/lib/pipelines/types";
import type { FrameRole } from "@/lib/roleFrames";

import type { AttentionItem } from "../attention";
import { pipelineReviewHeads, stageCardLabel, stageLatestAttemptPlace } from "../pipelines/pipelineModel";
import { RoleTag } from "../RoleFrameMark";
import { humanizeDuration } from "../turnDuration";
import { cleanTitle, fileModelLabel } from "../utils";
import type { MobileAttentionEntry } from "./attentionQueue";
import { decisionLine, reasonLine } from "./decision";
import { sendDismissal } from "./dismissalOverlay";
import { needsYouDismissal, needsYouEntryRole, needsYouSections } from "./needsYouPanel";
import { PermissionActions } from "./PermissionActions";

/*
 * The Needs-you sheet (issue #1439, lane 8; docs/design/mobile-v2/README.md
 * §4.1, §4.6; the prototype's `attentionSheet`). The bar's `⚠ n` opens it
 * over whatever screen is showing, and it lists the ONE phone queue
 * (`attentionQueue.ts`): conversations waiting on a decision, and pipelines in
 * `needs_decision`, in the board's Needs-you order, one section per project.
 * Its header says «Needs you · n» and carries «Dismiss all»; there is no
 * «Next ›» (docs/design/needs-you-options.md, option B): the rows are the way
 * in, and nothing walks the operator.
 *
 * Rows are the sheet-row anatomy (`.mrow`): the role of the agent behind it
 * (the needs-you panel's role tag), the title, one meta
 * line, a chevron. The meta line of a conversation is the DECISION — the one
 * `decisionLine` the desktop's toast and popover row also read (#1167) — then
 * how long it has waited, the engine glyph and the model; a pipeline's reads
 * `pipeline · stage k/n · <stage> failed · n findings · age`, the same words
 * the board's queue row uses (`MobilePipelineQueueRow`), so the two entries
 * cannot describe one pipeline differently.
 *
 * A row is the phone's OPEN gesture (#1244): the conversation screen it pushes
 * stamps the card seen. Pipelines have a destination once lane 7 lands the
 * pipeline screen; until the host passes `onOpenPipeline`, a pipeline row is a
 * statement rather than a control. Every row has «Dismiss», the needs-you
 * dismissal every card makes, with the receipt's Undo; a section of a sheet
 * that lists more than one project has its own «Dismiss all».
 *
 * Above the queue, «From your agents» lists the root agent's recent
 * `request_attention` calls (docs/design/needs-attention.md §6): on the phone
 * a request is this row and the bar's dot, never a move. A tap goes where it
 * points, × clears it on this phone, and opening the sheet marks the rows it
 * shows as seen, which puts the dot out. The count stays the queue's.
 */

/** One notice as the sheet draws it: the host names its target. */
export interface MobileNoticeRow {
  notice: AttentionNotice;
  /** The target's own name (a conversation's title, a lane's task), or its
      kind when the board holds no row for it. */
  target: string;
  /** Who asked, in the operator's words. */
  by: string;
}

export interface MobileAttentionSheetProps {
  entries: readonly MobileAttentionEntry[];
  /** Epoch seconds the ages are measured from. */
  now: number;
  onOpenConversation: (item: AttentionItem) => void;
  /** The pipeline screen's opener (lane 7). Absent, pipeline rows are inert. */
  onOpenPipeline?: (row: MobileBoardPipelineRow) => void;
  onClose: () => void;
  /** For the role each row names. */
  pipelines?: readonly Pipeline[];
  /** Project display names, for the section headers. */
  projectNames?: Readonly<Record<string, string>>;
  /** The project behind the sheet, whose section leads. */
  current?: string | null;
  /** Test seam: the screen the rows mark as current. Production reads the nav store. */
  screen?: MobileScreen;
  /** Test seam. */
  dismiss?: typeof sendDismissal;
  /** An agent's requests for the operator, newest first. */
  notices?: readonly MobileNoticeRow[];
  onOpenNotice?: (notice: AttentionNotice) => void;
  onClearNotice?: (id: string) => void;
  /** Called with the notices the sheet showed, so the bar's dot goes out. */
  onNoticesSeen?: (ids: readonly string[]) => void;
}

const ROW = "flex min-h-11 w-full items-center gap-3 px-4 py-1.5 text-left active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40";
const META = "flex items-center gap-[5px] overflow-hidden text-label font-medium tabular-nums text-muted";
const SEP = <span aria-hidden className="shrink-0 opacity-60">·</span>;

const NO_NOTICES: readonly MobileNoticeRow[] = [];
const NO_PIPELINES: readonly Pipeline[] = [];
const NO_NAMES: Readonly<Record<string, string>> = {};

export function MobileAttentionSheet({ entries, now, onOpenConversation, onOpenPipeline, onClose, pipelines = NO_PIPELINES, projectNames = NO_NAMES, current = null, screen, dismiss = sendDismissal, notices = NO_NOTICES, onOpenNotice, onClearNotice, onNoticesSeen }: MobileAttentionSheetProps) {
  const { t } = useLocale();
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const shownNotices = notices.map((row) => row.notice.id).join("\n");
  useEffect(() => {
    if (shownNotices) onNoticesSeen?.(shownNotices.split("\n"));
  }, [shownNotices, onNoticesSeen]);
  const navState = useMobileNav();
  const here = screen ?? topScreen(navState);
  const open = (entry: MobileAttentionEntry) => {
    if (entry.kind === "conversation") onOpenConversation(entry.item);
    else onOpenPipeline?.(entry.row);
  };
  /* A dismissal leaves on the tap and the receipt carries its Undo. */
  const clear = (list: readonly MobileAttentionEntry[], text: string) => {
    if (!list.length) return;
    const { target, subjects } = needsYouDismissal(list);
    showReceipt(text, { kind: "undo", run: () => void dismiss(target, subjects, { undo: true, surface: "phone" }) });
    void dismiss(target, subjects, { surface: "phone" }).then((result) => {
      if (!result.ok) showReceipt(t("attention.dismissFailed", { error: result.error }), null, { error: true });
    });
  };
  const rowTitle = (entry: MobileAttentionEntry) => (entry.kind === "conversation" ? cleanTitle(entry.item.file.title, 90) : entry.row.task);
  const sections = needsYouSections(entries, current);
  const titled = sections.length > 1;
  const title = entries.length ? `${t("mobile2.attention.title")} · ${entries.length}` : t("mobile2.attention.title");
  const row = (entry: MobileAttentionEntry) => {
    const role = needsYouEntryRole(entry, pipelines);
    const body = entry.kind === "conversation" ? (
      <ConversationRow item={entry.item} now={now} role={role} current={here.kind === "chat" && here.id === entry.item.file.path} onOpen={() => open(entry)} />
    ) : (
      <PipelineRow row={entry.row} role={role} current={here.kind === "pipeline" && here.id === entry.row.id} onOpen={onOpenPipeline ? () => open(entry) : undefined} />
    );
    return (
      <div key={entry.id} className="flex min-w-0 items-start" data-needs-you-row={entry.id} data-needs-you-role={role}>
        <div className="min-w-0 flex-1">{body}</div>
        <button
          type="button"
          data-needs-you-dismiss={entry.id}
          aria-label={t("needs.dismissAria", { title: rowTitle(entry) })}
          className="inline-flex min-h-11 shrink-0 items-center rounded-[8px] px-3 text-label font-semibold text-muted active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
          onClick={() => clear([entry], t("needs.dismissedReceipt", { title: rowTitle(entry) }))}
        >
          {t("needs.dismiss")}
        </button>
      </div>
    );
  };
  return (
    <MobileSheet
      name="attention"
      title={title}
      onClose={onClose}
      extra={entries.length ? (
        <button
          type="button"
          data-needs-you-dismiss-all=""
          className="inline-flex min-h-11 shrink-0 items-center rounded-[8px] px-2 text-ui font-semibold text-accent active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          title={t("attention.dismissAllTitle")}
          onClick={() => clear(entries, t("needs.dismissedReceipt", { title: t("attention.dismissAll") }))}
        >
          {t("attention.dismissAll")}
        </button>
      ) : null}
    >
      {notices.length ? (
        <div className="flex flex-col" data-mobile2-notices={notices.length}>
          <MobileSheetSection>{t("notices.title")}</MobileSheetSection>
          {notices.map((row) => (
            <NoticeRow
              key={row.notice.id}
              row={row}
              now={now}
              onOpen={onOpenNotice ? () => onOpenNotice(row.notice) : undefined}
              onClear={onClearNotice ? () => onClearNotice(row.notice.id) : undefined}
            />
          ))}
          {entries.length ? <MobileSheetSection>{t("mobile2.attention.title")}</MobileSheetSection> : null}
        </div>
      ) : null}
      {entries.length ? (
        <div className="flex flex-col" data-mobile2-attention-list>
          {titled ? sections.map((section) => {
            const name = projectTitle(section.project, projectNames[section.project]) ?? section.project;
            const isFolded = folded.has(section.project);
            return (
              <div key={section.project} className="flex flex-col" data-needs-you-section={section.project} data-folded={isFolded ? "" : undefined}>
                <div className="flex items-center">
                  <button
                    type="button"
                    className="flex min-h-11 min-w-0 flex-1 items-center text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
                    aria-expanded={!isFolded}
                    aria-label={t(isFolded ? "attention.sectionUnfold" : "attention.sectionFold", { project: name })}
                    data-needs-you-fold={section.project}
                    onClick={() => setFolded((held) => {
                      const next = new Set(held);
                      if (next.has(section.project)) next.delete(section.project);
                      else next.add(section.project);
                      return next;
                    })}
                  >
                    <MobileSheetSection count={section.entries.length}>
                      {isFolded ? <ChevronRight className="h-3.5 w-3.5 text-muted" aria-hidden /> : <ChevronDown className="h-3.5 w-3.5 text-muted" aria-hidden />}
                      <span className="min-w-0 truncate">{name}</span>
                    </MobileSheetSection>
                  </button>
                  <button
                    type="button"
                    data-needs-you-dismiss-section={section.project}
                    aria-label={t("attention.dismissAllIn", { project: name })}
                    className="inline-flex min-h-11 shrink-0 items-center rounded-[8px] px-3 text-label font-semibold text-muted active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
                    onClick={() => clear(section.entries, t("needs.dismissedReceipt", { title: name }))}
                  >
                    {t("attention.dismissAll")}
                  </button>
                </div>
                {isFolded ? null : section.entries.map(row)}
              </div>
            );
          }) : entries.map(row)}
        </div>
      ) : notices.length ? null : (
        <div className="px-4 py-4 text-center text-ui text-muted" data-mobile2-attention-empty>{t("mobile2.attention.empty")}</div>
      )}
    </MobileSheet>
  );
}

function NoticeRow({ row, now, onOpen, onClear }: { row: MobileNoticeRow; now: number; onOpen?: () => void; onClear?: () => void }) {
  const { t } = useLocale();
  const asked = Date.parse(row.notice.createdAt);
  const age = Number.isFinite(asked) ? humanizeDuration(Math.max(0, now - asked / 1000)) : null;
  const Tag = onOpen ? "button" : "div";
  return (
    <div className="flex min-w-0 items-center" data-mobile2-notice-row={row.notice.id}>
      <Tag
        {...(onOpen ? { type: "button" as const, onClick: onOpen, "aria-label": t("notices.open", { title: row.target }) } : {})}
        data-mobile2-notice-open={onOpen ? row.notice.target.kind : undefined}
        className={`${ROW} min-w-0 flex-1`}
      >
        <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-accent" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="min-w-0 truncate text-body font-semibold leading-[1.25] text-primary">{row.notice.reason}</span>
          <span className={META}>
            <span className="min-w-0 truncate">{row.target}</span>
            {SEP}
            <span className="shrink-0">{row.by}</span>
            {age ? <>{SEP}<span className="shrink-0">{age}</span></> : null}
          </span>
        </span>
        {onOpen ? <ChevronRight className="h-[18px] w-[18px] shrink-0 text-muted" aria-hidden /> : null}
      </Tag>
      {onClear ? (
        <button
          type="button"
          data-mobile2-notice-clear={row.notice.id}
          aria-label={t("notices.clear")}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-[8px] text-muted active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
          onClick={onClear}
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

function ConversationRow({ item, now, current, onOpen, role }: { item: AttentionItem; now: number; current: boolean; onOpen: () => void; role?: FrameRole }) {
  const { t } = useLocale();
  /* An orchestrator's question in the report log is its own title. */
  const title = (role && item.reason.report?.body) || cleanTitle(item.file.title, 90);
  /* With the role on its own mark, the line is the wait alone. */
  const decision = role ? reasonLine(t, item.reason) : decisionLine(t, item.file, now) ?? t("attention.decisionQuestion");
  const headline = item.reason.kind === "permission" && Boolean(item.file.pendingPermission);
  const row = (
    <button
      type="button"
      data-attention-row={item.id}
      data-mobile2-row="conversation"
      data-mobile2-go="chat"
      data-mobile2-conversation={item.file.path}
      aria-current={current ? "true" : undefined}
      aria-label={t("mobile2.attention.open", { title })}
      className={ROW}
      onClick={onOpen}
    >
      {role ? null : <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-warning" />}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {role ? <RoleTag role={role} /> : null}
        <span className="min-w-0 truncate text-body font-semibold leading-[1.25] text-primary">{title}</span>
        {/* A permission headline (tool, command, reason) runs to hundreds of
            characters, so it gets a line of its own that ends in an ellipsis
            and the meta line keeps the age in view: the request is denied
            at ten minutes (#2215). */}
        {headline ? <span data-attention-decision className="min-w-0 truncate text-label font-medium text-muted">{decision}</span> : null}
        <span className={META}>
          {headline ? null : (
            <>
              <span data-attention-decision className="shrink-0">{decision}</span>
              {SEP}
            </>
          )}
          <span data-attention-age className="shrink-0">{humanizeDuration(Math.max(0, now - item.since))}</span>
          {item.file.model ? (
            <>
              {SEP}
              <ChatEngineMark file={item.file} />
              <span className="min-w-0 truncate">{fileModelLabel(item.file)}</span>
            </>
          ) : null}
        </span>
      </span>
      <ChevronRight className="h-[18px] w-[18px] shrink-0 text-muted" aria-hidden />
    </button>
  );
  /* A structured permission request is answered right here (#2215). */
  if (!headline) return row;
  return (
    <div className="min-w-0">
      {row}
      <PermissionActions file={item.file} size="touch" />
    </div>
  );
}

function PipelineRow({ row, current, onOpen, role }: { row: MobileBoardPipelineRow; current: boolean; onOpen?: () => void; role?: FrameRole }) {
  const { t } = useLocale();
  const stageName = row.stageRef ? stageCardLabel(t, row.stageRef, stageLatestAttemptPlace(row.pipeline, row.stageRef.id)).toLocaleLowerCase() : "";
  const meta = [
    t("mobile2.attention.pipeline"),
    t(row.stageFailed ? "mobile2.board.pipelineStageFailed" : "mobile2.board.pipelineStage", { stage: row.stage, total: row.total, name: stageName }),
    row.findings ? t("mobile2.board.pipelineFindings", { count: row.findings }) : null,
    pipelineReviewHeads(t, row.review),
  ].filter(Boolean).join(" · ");
  const Tag = onOpen ? "button" : "div";
  return (
    <Tag
      {...(onOpen ? { type: "button" as const, onClick: onOpen, "aria-label": t("mobile2.board.openPipeline", { task: row.task }), "aria-current": current ? ("true" as const) : undefined } : {})}
      data-attention-row={row.id}
      data-mobile2-row="pipeline"
      data-mobile2-go={onOpen ? "pipeline" : undefined}
      data-mobile2-pipeline-row={row.id}
      className={ROW}
    >
      {role ? null : <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-warning" />}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {role ? <RoleTag role={role} /> : null}
        <span className="min-w-0 truncate text-body font-semibold leading-[1.25] text-primary">{row.task}</span>
        <span className={META}>
          <span data-attention-decision className="shrink-0">{meta}</span>
          {row.seconds === null ? null : (
            <>
              {SEP}
              <span className="shrink-0">{humanizeDuration(row.seconds)}</span>
            </>
          )}
        </span>
      </span>
      {onOpen ? <ChevronRight className="h-[18px] w-[18px] shrink-0 text-muted" aria-hidden /> : null}
    </Tag>
  );
}
