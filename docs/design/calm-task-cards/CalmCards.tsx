/*
 * The three calm cards (docs/design/calm-task-cards.md §7). Each is drawn in
 * the board's own card shell (`.kb .card`), with the real task icon and the
 * real one-line stage chain (`PipelineBlock` at card density); what is new is
 * the state line with its dot, and the opened view.
 *
 *   1  Reason on expand: why it stopped, what the orchestrator does, then the
 *      lane's own answers under «If you want to act yourself».
 *   2  Chronology: the task in order, the stop and the orchestrator's step at
 *      its end, the answers on the stop's entry, which never folds.
 *   3  Decisions only: no chain on the closed card; the opened card is a
 *      short summary whose last row holds the lane's answers as quiet links
 *      («Answer» stands before them when the operator must act), and a folded
 *      chronology.
 *
 * In every variant a closed card shows a button only when the operator must
 * answer, and that button is «Answer».
 */
import { Bot, ChevronDown, ChevronRight, MoreHorizontal } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useLocale } from "@/lib/i18n";
import { humanizeDuration } from "@/components/turnDuration";
import { TaskIcon } from "@/components/tasks/TaskIcon";
import { TASK_COLOR_HEX } from "@/components/tasks/taskColorHex";
import type { KanbanCard } from "@/components/kanban/kanbanModel";
import { PipelineBlock } from "@/components/pipelines/PipelineBlock";
import type { ManagedOn } from "@/components/pipelines/remoteLaneSummary";
import { WorkLinkText } from "@/components/workLinks/WorkLinkChips";
import { useWorkLinks } from "@/components/workLinks/workLinksContext";

import { laneActions, laneWords, words, type CalmLane, type Owner, type TimelineEvent, type Words } from "./calmModel";

/* The real chain with no reason line, no PR tail and no answers: the state
   line above it says the rest once. */
const QUIET: ManagedOn = { host: "", note: null, reason: null };

export type Variant = 1 | 2 | 3;

export interface CalmCardProps {
  variant: Variant;
  card: KanbanCard;
  lanes: readonly CalmLane[];
  timeline: readonly TimelineEvent[];
  nowMs: number;
  phone: boolean;
  /** The frame's starting state: opened, the dot's popover shown, details or
      chronology open. */
  open?: boolean;
  popOpen?: boolean;
  detailsOpen?: boolean;
  historyOpen?: boolean;
}

function age(locale: "en" | "uk", nowMs: number, since: number): string {
  return humanizeDuration(Math.max(60, Math.floor((nowMs - since) / 60_000) * 60), locale);
}

/* The dot opens its popover on hover and focus, and a tap pins it. The
   popover itself is a row of the card, under the state line (see CalmCard). */
function StatusDot({ owner, text, open, popId, onHover, onPin }: { owner: Owner; text: string; open: boolean; popId: string; onHover: (over: boolean) => void; onPin: () => void }) {
  return (
    <span className="cc-dotwrap">
      <button
        type="button" className="cc-dot" data-owner={owner} aria-label={text} aria-expanded={open} aria-controls={popId}
        onClick={onPin} onMouseEnter={() => onHover(true)} onMouseLeave={() => onHover(false)} onFocus={() => onHover(true)} onBlur={() => onHover(false)}
      />
    </span>
  );
}

function ActionButtons({ lane, w, phone, primary }: { lane: CalmLane; w: Words; phone: boolean; primary: boolean }) {
  const { t } = useLocale();
  const actions = laneActions(t, lane);
  return (
    <div className={`cc-acts${phone ? " phone" : ""}`}>
      {primary ? <button type="button" className="cc-act primary" data-cc-answer="">{w("answer")}</button> : null}
      {actions.map((action) => (
        <button key={action.action} type="button" className="cc-act" data-cc-action={action.action}>{action.label}</button>
      ))}
      <button type="button" className="cc-act quiet" data-cc-ask=""><Bot aria-hidden size={14} />{w("ask")}</button>
    </div>
  );
}

/** How many entries a chronology shows before the earlier ones fold. */
const RECENT = 8;

function Timeline({ events, w, lane, phone }: { events: readonly TimelineEvent[]; w: Words; lane: CalmLane | null; phone: boolean }) {
  const { t } = useLocale();
  const [all, setAll] = useState(false);
  const fold = all ? 0 : Math.max(0, events.length - RECENT);
  /* The stop the lane's answers belong to never folds: when later entries
     (another lane's work) push it under «Earlier», it stands first after
     the fold, so the answers are read under their reason. */
  const stop = lane ? events.findLast((event) => event.stop === lane) : undefined;
  const pinned = stop && events.indexOf(stop) < fold ? stop : null;
  const hidden = fold - (pinned ? 1 : 0);
  const shown = pinned ? [pinned, ...events.slice(fold)] : events.slice(fold);
  /* The lane's answers ride the stop's own entry; when the records hold no
     such entry (a stop with no parked attempt), they ride the last entry, so
     they are never out of sight. */
  const carrier = lane && laneActions(t, lane).length ? stop ?? shown.at(-1) : undefined;
  return (
    <ol className="cc-tl" data-cc-timeline={events.length}>
      {hidden ? (
        <li className="cc-tl-row cc-tl-fold" data-tone="info">
          {phone ? null : <span className="cc-tl-time" />}
          <span className="cc-tl-mark" aria-hidden="true" />
          <span className="cc-tl-body">
            <button type="button" className="cc-disclose" aria-expanded={false} onClick={() => setAll(true)}><ChevronRight aria-hidden size={14} />{w("ev.earlier", { n: hidden })}</button>
          </span>
        </li>
      ) : null}
      {shown.map((event, index) => (
        <li key={index} className="cc-tl-row" data-tone={event.tone}>
          {phone ? null : <span className="cc-tl-time num">{event.time ?? w("now")}</span>}
          <span className="cc-tl-mark" aria-hidden="true" />
          <span className="cc-tl-body">
            {/* The phone has no room for a time column beside the text: the
                time leads the entry's own line. */}
            <span className="cc-tl-text">{phone ? <span className="cc-tl-when num">{event.time ?? w("now")}</span> : null}{event.text}</span>
            {lane && event === carrier ? (
              <span className={`cc-tl-acts${phone ? " phone" : ""}`}>
                {laneActions(t, lane).map((action) => (
                  <button key={action.action} type="button" className="cc-link" data-cc-action={action.action}>{action.label}</button>
                ))}
              </span>
            ) : null}
            {event.tone === "you" ? (
              <span className={`cc-tl-acts${phone ? " phone" : ""}`}><button type="button" className="cc-act primary" data-cc-answer="">{w("answer")}</button></span>
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Description({ text }: { text: string }) {
  return text ? <p className="cc-desc"><span className="clamp">{text}</span></p> : null;
}

function OpenReason({ lane, w, phone, detailsOpen, description }: { lane: CalmLane; w: Words; phone: boolean; detailsOpen: boolean; description: string }) {
  const said = laneWords(w, lane);
  const [details, setDetails] = useState(detailsOpen);
  return (
    <div className="cc-open" data-cc-open="reason">
      <Description text={description} />
      {said.why ? (
        <section className="cc-sec">
          <h4>{w("section.why")}</h4>
          <p>{said.why}</p>
          {lane.detail ? (
            <>
              <button type="button" className="cc-disclose" aria-expanded={details} onClick={() => setDetails(!details)}>
                {details ? <ChevronDown aria-hidden size={14} /> : <ChevronRight aria-hidden size={14} />}{w("details")}
              </button>
              {details ? (
                <>
                  <pre className="cc-raw" data-cc-raw="">{lane.detail}</pre>
                  <button type="button" className="cc-link cc-full" data-cc-full="">{w("details.full")}</button>
                </>
              ) : null}
            </>
          ) : null}
        </section>
      ) : null}
      {said.seat ? (
        <section className="cc-sec" data-cc-seat={lane.owner}>
          <h4>{w("section.seat")}</h4>
          <p className="cc-seatline"><Bot aria-hidden size={14} className="cc-seaticon" />{said.seat}</p>
        </section>
      ) : null}
      {lane.owner === "you" || lane.answers ? (
        <section className="cc-sec">
          {lane.owner === "you" ? null : <h4>{w("section.self")}</h4>}
          <ActionButtons lane={lane} w={w} phone={phone} primary={lane.owner === "you"} />
        </section>
      ) : null}
    </div>
  );
}

function OpenSummary({ lane, w, timeline, phone, historyOpen, description }: { lane: CalmLane; w: Words; timeline: readonly TimelineEvent[]; phone: boolean; historyOpen: boolean; description: string }) {
  const { t } = useLocale();
  const said = laneWords(w, lane);
  const [history, setHistory] = useState(historyOpen);
  const you = lane.owner === "you";
  const next = you ? w("next.you") : lane.owner === "working" ? w("next.working") : w("next.seat");
  const self = lane.answers ? (
    <>
      <dt>{w("summary.self")}</dt>
      <dd>
        <span className={`cc-tl-acts${phone ? " phone" : ""}`}>
          {laneActions(t, lane).map((action) => <button key={action.action} type="button" className="cc-link" data-cc-action={action.action}>{action.label}</button>)}
        </span>
      </dd>
    </>
  ) : null;
  return (
    <div className="cc-open" data-cc-open="summary">
      <Description text={description} />
      <dl className="cc-sum">
        {said.why ? <><dt>{w("summary.stopped")}</dt><dd>{said.why}</dd></> : null}
        {said.seat ? <><dt>{w("summary.seat")}</dt><dd>{said.seat}</dd></> : null}
        <dt>{w("summary.next")}</dt><dd>{next}</dd>
        {/* A card that needs the operator asks for the answer first, right
            under «Next»; the lane's own answers follow it. */}
        {you ? <div className={`cc-acts cc-sum-act${phone ? " phone" : ""}`}><button type="button" className="cc-act primary" data-cc-answer="">{w("answer")}</button></div> : null}
        {self}
      </dl>
      {you ? <div className={`cc-acts${phone ? " phone" : ""}`}><button type="button" className="cc-act quiet" data-cc-ask=""><Bot aria-hidden size={14} />{w("ask")}</button></div> : null}
      <button type="button" className="cc-disclose" aria-expanded={history} onClick={() => setHistory(!history)}>
        {history ? <ChevronDown aria-hidden size={14} /> : <ChevronRight aria-hidden size={14} />}{w("history.count", { n: timeline.length })}
      </button>
      {history ? <Timeline events={timeline} w={w} lane={null} phone={phone} /> : null}
    </div>
  );
}

export function CalmCard(props: CalmCardProps) {
  const { variant, card, lanes, timeline, nowMs, phone } = props;
  const { locale, t } = useLocale();
  const w = words(locale);
  const linkIndex = useWorkLinks();
  const [open, setOpen] = useState(Boolean(props.open));
  const [pinned, setPinned] = useState(Boolean(props.popOpen));
  const [hover, setHover] = useState(false);
  const pop = pinned || hover;
  const top = lanes[0] ?? null;
  const owner: Owner = top?.owner ?? (card.status === "done" ? "done" : "waiting");
  const said = top ? laneWords(w, top) : null;
  const others = lanes.filter((lane) => lane !== top && lane.owner !== "done").length;
  const chainLane = card.pipelines.find((summary) => summary.pipeline.id === top?.pipeline.id && !["completed", "closed"].includes(summary.pipeline.state))
    ?? card.pipelines.find((summary) => !["completed", "closed"].includes(summary.pipeline.state)) ?? null;
  const since = top?.since ?? card.updatedAtMs;
  /* The PR once, at the end of the chain: the top lane's, else any lane's. A
     lane with no PR says nothing about it. */
  const pr = lanes.map((lane) => linkIndex.of({ kind: "pipeline", id: lane.pipeline.id })).find((resolved) => resolved?.links.length) ?? null;
  /* The time on the card, said once and in words: the popover names what the
     bare duration beside the state line counts. */
  const ownerText = w(`pop.${owner}`, { age: age(locale, nowMs, since) });
  const popId = `cc-pop-${card.id}`;
  const hex = card.color ? TASK_COLOR_HEX[card.color] : null;
  const style = hex ? ({ "--label": hex, "--label-strong": hex } as React.CSSProperties) : undefined;
  let body: ReactNode = null;
  if (open && top) {
    body = variant === 1 ? <OpenReason lane={top} w={w} phone={phone} detailsOpen={Boolean(props.detailsOpen)} description={card.description} />
      : variant === 2 ? <div className="cc-open" data-cc-open="timeline"><Description text={card.description} /><Timeline events={timeline} w={w} lane={top} phone={phone} />{top.owner === "you" ? null : <p className="cc-askline"><button type="button" className="cc-act quiet" data-cc-ask=""><Bot aria-hidden size={14} />{w("ask")}</button></p>}</div>
      : <OpenSummary lane={top} w={w} timeline={timeline} phone={phone} historyOpen={Boolean(props.historyOpen)} description={card.description} />;
  }
  return (
    <article
      className={`card cc-card${phone ? " cc-phone" : ""}${card.status === "done" ? " done" : ""}`}
      data-cc-card={card.id}
      data-cc-owner={owner}
      data-cc-variant={variant}
      data-cc-state={open ? "open" : "closed"}
      data-cc-answers={top ? laneActions(t, top).length : 0}
      data-color={card.color ?? "none"}
      style={style}
      onClick={phone ? (event) => { if (!(event.target as HTMLElement).closest("button")) setOpen(!open); } : undefined}
    >
      <span className="label" aria-hidden="true" />
      <div className="head">
        <span className="task-icon"><TaskIcon icon={card.icon} title={card.title} /></span>
        <h3 className="title"><span className="clamp" data-cc-title="">{card.title}</span></h3>
        <div className="tools">
          <button type="button" className="icon-btn fold" aria-expanded={open} aria-label={card.title} onClick={() => setOpen(!open)}>
            {open ? <ChevronDown /> : <ChevronRight />}
          </button>
          <button type="button" className="icon-btn" aria-haspopup="menu" aria-label={w("menu.card")} data-cc-menu="">
            <MoreHorizontal size={16} />
          </button>
        </div>
      </div>
      <div className="cc-state">
        <StatusDot owner={owner} text={ownerText} open={pop} popId={popId} onHover={setHover} onPin={() => setPinned(!pinned)} />
        <button type="button" className="cc-line" data-cc-line="" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="cc-line-text">{said?.line ?? w(`owner.${owner}`)}</span>
          <span className="cc-age num" title={ownerText}>{age(locale, nowMs, since)}</span>
        </button>
      </div>
      {pop ? <p className="cc-pop" id={popId} role="tooltip" data-cc-pop="">{ownerText}</p> : null}
      {owner === "you" && !open ? <div className="cc-answerrow"><button type="button" className="cc-act primary cc-answer" data-cc-answer="">{w("answer")}</button></div> : null}
      {(variant !== 3 || open) && (chainLane || pr) ? (
        <div className="cc-chain" data-cc-chain={chainLane?.pipeline.id ?? ""}>
          {chainLane ? <PipelineBlock summary={chainLane} density="card" nowMs={nowMs} taskTitle={card.title} managedOn={QUIET} /> : <span className="cc-grow" />}
          {others ? <span className="cc-more">{w("lanes.more", { n: others })}</span> : null}
          {pr ? <WorkLinkText resolved={pr} testId={card.id} className="cc-pr" /> : null}
        </div>
      ) : null}
      {body}
    </article>
  );
}
