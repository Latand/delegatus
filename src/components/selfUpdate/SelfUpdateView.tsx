"use client";

import { Fragment, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useLocale, type TFunction } from "@/lib/i18n";
import { parseInline, splitItem, type Inline } from "@/lib/selfUpdate/changelogMarkup";
import type { ProcessView, Snapshot, Step } from "@/lib/selfUpdate/types";

import type { Live } from "./useSelfUpdateFeed";
import {
  appliedCopy,
  clock,
  duration,
  headerStatus,
  checkErrorText,
  processErrorText,
  refusalText,
  revisionText,
  runningStepNumber,
  staleProcesses,
  stepLabel,
  stepFailureText,
  stepName,
  targetText,
  type ActionError,
  type IconKind,
} from "./selfUpdateCopy";

/* The Update surface's body (#2007): the prototype's four sections — the
   version header with the check, the update and its steps, what changes, and
   one block per process — rendered from one Snapshot. Pure over its props:
   the dialog owns the feed and the actions, and the DOM tests render this
   with fixture snapshots. */

export interface ViewState {
  now: number;
  armed: boolean;
  openLogs: ReadonlySet<string>;
  pending: ReadonlySet<string>;
  /** Why the last action was refused, worded here in the operator's language. */
  error: ActionError | null;
  /** A web restart was asked for and nothing answers yet. */
  waitingForWeb: boolean;
  /** The web process answering now is not the one that served this page. */
  reloadTo: string | null;
}

export interface ViewActions {
  check(): void;
  update(): void;
  retry(): void;
  restartWeb(): void;
  armHost(): void;
  cancelHost(): void;
  confirmHost(): void;
  toggleLog(id: string): void;
  reload(): void;
}

const CARD = "flex min-w-0 flex-col gap-3 rounded-[12px] border border-border bg-card p-4 shadow-1 max-sm:p-3.5";
const EDGE: Record<"warning" | "danger" | "success" | "accent", string> = {
  warning: "shadow-[inset_0_3px_0_var(--color-warning),var(--shadow-1)]",
  danger: "shadow-[inset_0_3px_0_var(--color-danger),var(--shadow-1)]",
  success: "shadow-[inset_0_3px_0_var(--color-success),var(--shadow-1)]",
  accent: "shadow-[inset_0_3px_0_var(--color-accent),var(--shadow-1)]",
};
const BUTTON = "inline-flex h-8 shrink-0 items-center justify-center whitespace-nowrap rounded-[8px] border px-3.5 text-ui font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-55 pointer-coarse:h-11 max-sm:h-11 max-sm:w-full";
const TONE = {
  secondary: "border-border bg-card text-primary hover:enabled:border-strong focus-visible:ring-accent/40",
  primary: "border-brand bg-brand text-on-brand hover:enabled:opacity-90 focus-visible:ring-accent/40",
  warning: "border-warning bg-card text-warning focus-visible:ring-warning/40",
  warningPrimary: "border-warning bg-warning text-canvas focus-visible:ring-warning/40",
} as const;
const LINK = "inline-flex shrink-0 items-center py-0.5 text-label font-semibold text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 pointer-coarse:min-h-11 pointer-coarse:px-1";

function Icon({ kind, className = "" }: { kind: IconKind; className?: string }) {
  const tone: Record<IconKind, string> = { pending: "text-muted", running: "text-accent", done: "text-success", failed: "text-danger", warning: "text-warning" };
  const spin = kind === "running" ? "animate-spin motion-reduce:animate-none" : "";
  return (
    <svg viewBox="0 0 14 14" aria-hidden="true" data-icon={kind} className={`inline-block h-3.5 w-3.5 shrink-0 ${tone[kind]} ${spin} ${className}`}>
      {kind === "pending" ? <circle cx="7" cy="7" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.5" /> : null}
      {kind === "running" ? (
        <>
          <circle cx="7" cy="7" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M7 1.75a5.25 5.25 0 0 1 0 10.5z" fill="currentColor" />
        </>
      ) : null}
      {kind === "done" ? (
        <>
          <circle cx="7" cy="7" r="6" fill="currentColor" />
          <path d="M4.4 7.2l1.8 1.8 3.5-3.7" fill="none" stroke="var(--color-card)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : null}
      {kind === "failed" ? (
        <>
          <circle cx="7" cy="7" r="6" fill="currentColor" />
          <path d="M4.9 4.9l4.2 4.2M9.1 4.9l-4.2 4.2" stroke="var(--color-card)" strokeWidth="1.6" strokeLinecap="round" />
        </>
      ) : null}
      {kind === "warning" ? (
        <>
          <path d="M7 1.4l6 10.8H1z" fill="currentColor" />
          <path d="M7 5.4v3.2" stroke="var(--color-card)" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="7" cy="10.3" r=".85" fill="var(--color-card)" />
        </>
      ) : null}
    </svg>
  );
}

function Badge({ state, t }: { state: ProcessView["state"]; t: TFunction }) {
  const map: Record<ProcessView["state"], [string, IconKind]> = {
    healthy: ["bg-success-soft text-success", "done"],
    starting: ["bg-accent-soft text-accent", "running"],
    stopping: ["bg-accent-soft text-accent", "running"],
    failed: ["bg-danger-soft text-danger", "failed"],
    stopped: ["border border-border bg-sunken text-muted", "pending"],
  };
  const [tone, kind] = map[state];
  return (
    <span data-badge={state} className={`inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 text-caption font-semibold ${tone}`}>
      <Icon kind={kind} className="!h-2.5 !w-2.5 !text-current" />
      {t(`selfUpdate.badge.${state}`)}
    </span>
  );
}

function Button({ label, onClick, tone = "secondary", disabled, title, action }: {
  label: string;
  onClick: () => void;
  tone?: keyof typeof TONE;
  disabled?: boolean;
  title?: string;
  action: string;
}) {
  return (
    <button type="button" data-action={action} disabled={disabled} title={title} onClick={onClick} className={`${BUTTON} ${TONE[tone]}`}>
      {label}
    </button>
  );
}

/** A log that was scrolled to its end (or is new) follows the output. */
function LogTail({ lines, wrap, label, id }: { lines: string[]; wrap: boolean; label: string; id: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const following = useRef(true);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, [lines]);
  return (
    <pre
      ref={ref}
      data-log={id}
      tabIndex={0}
      aria-label={label}
      onScroll={(event) => {
        const element = event.currentTarget;
        following.current = element.scrollTop + element.clientHeight >= element.scrollHeight - 4;
      }}
      className={`m-0 max-h-[calc(16*1.45em+16px)] overflow-auto rounded-[8px] border border-border bg-sunken px-2.5 py-2 font-mono text-label leading-[1.45] text-secondary ${wrap ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre"}`}
    >
      {lines.join("\n")}
    </pre>
  );
}

function Pair({ label, value }: { label: string; value: string }) {
  return (
    <span className="whitespace-nowrap max-sm:whitespace-normal">
      <span className="mr-1.5 text-muted">{label}</span>
      <span className="text-primary">{value}</span>
    </span>
  );
}

function Header({ s, state, actions, t, locale }: { s: Snapshot; state: ViewState; actions: ViewActions; t: TFunction; locale: "en" | "uk" }) {
  const status = headerStatus(s, t);
  const checkError = checkErrorText(s.check, `origin/${s.meta.branch}`, t);
  const updating = s.busy === "update";
  const checking = s.check.state === "checking" || state.pending.has("check");
  const { web, runtimeHost } = s.serving;
  const stale = staleProcesses(s);
  const pairs: ReactNode[] = [];
  if (web && runtimeHost && web.short !== runtimeHost.short) {
    pairs.push(<Pair key="web" label={t("selfUpdate.label.webRuns")} value={revisionText(web, locale)} />);
    pairs.push(<Pair key="host" label={t("selfUpdate.label.hostRuns")} value={revisionText(runtimeHost, locale)} />);
  } else {
    const running = web ?? runtimeHost;
    pairs.push(<Pair key="running" label={t("selfUpdate.label.running")} value={running ? revisionText(running, locale) : t("selfUpdate.label.nothing")} />);
  }
  if (s.mode === "checkout" && s.installed.short && (stale.web || stale.host || (!web && !runtimeHost))) {
    pairs.push(<Pair key="built" label={t("selfUpdate.label.built")} value={revisionText(s.installed, locale)} />);
  }
  if (s.available) pairs.push(<Pair key="available" label={t("selfUpdate.label.available")} value={revisionText(s.available, locale)} />);
  const checkButton = (
    <Button
      action="check"
      label={s.check.state === "failed" ? t("selfUpdate.retryCheck") : t("selfUpdate.checkNow")}
      onClick={actions.check}
      disabled={updating || checking}
      title={updating ? t("selfUpdate.updateInProgress") : undefined}
    />
  );
  return (
    <section data-section="header" aria-label={t("selfUpdate.title")} className={`${CARD} ${status.edge ? EDGE[status.edge] : ""}`}>
      {/* On the phone the row dissolves: Check now moves under the status,
          full width, as the last thing in the card. */}
      <div className="flex min-w-0 items-start justify-between gap-3 max-sm:contents">
        <div className="flex min-w-0 flex-wrap gap-x-6 gap-y-1.5 text-ui tabular-nums max-sm:flex-col max-sm:gap-y-1">{pairs}</div>
        <div className="max-sm:order-last">{checkButton}</div>
      </div>
      <div role="status" className="flex items-start gap-2 text-ui text-primary">
        <Icon kind={status.icon} className="mt-px" />
        <span data-status="" className="min-w-0 [overflow-wrap:anywhere]">
          {status.text}
          {status.next ? <span className="text-muted"> · {status.next}</span> : null}
        </span>
      </div>
      {s.check.state === "failed" && checkError ? <p data-error="check" className={ERROR_LINE}>{checkError}</p> : null}
      {state.error ? <p data-error="action" className={ERROR_LINE}>{refusalText(state.error, t)}</p> : null}
    </section>
  );
}

const ERROR_LINE = "m-0 rounded-[8px] bg-danger-soft px-2 py-1.5 font-mono text-label text-danger [overflow-wrap:anywhere]";

function StepRow({ step, short, state, actions, t, managed }: { step: Step; short: string; state: ViewState; actions: ViewActions; t: TFunction; managed: boolean }) {
  const kind: IconKind = step.state === "pending" ? "pending" : step.state === "running" ? "running" : step.state === "done" ? "done" : "failed";
  const elapsed = step.state === "running" && step.startedAt ? state.now - Date.parse(step.startedAt) : step.durationMs;
  const label = stepLabel(step.name, short, t);
  let title = label;
  if (elapsed !== null && step.state !== "pending") title += ` · ${duration(elapsed, t)}`;
  if (step.state === "failed" && step.exitCode !== null) title += ` · ${t("selfUpdate.step.exit", { code: step.exitCode })}`;
  const id = `step-${step.name}`;
  const open = state.openLogs.has(id);
  const hasOutput = step.tail.length > 0;
  const tone = step.state === "pending" ? "text-muted" : step.state === "running" ? "font-semibold text-accent" : step.state === "failed" ? "font-semibold text-danger" : "text-primary";
  return (
    <li data-step={step.name} data-state={step.state} className="flex flex-col gap-1.5 py-1.5 [&+&]:border-t [&+&]:border-border">
      <div className="flex min-h-[22px] min-w-0 items-center gap-2">
        <Icon kind={kind} />
        <span title={title} className={`min-w-0 flex-1 truncate text-ui tabular-nums ${tone}`}>{title}</span>
        {hasOutput ? (
          <button type="button" data-action="toggle-log" aria-expanded={open} onClick={() => actions.toggleLog(id)} className={LINK}>
            {open ? t("selfUpdate.log.hide") : t("selfUpdate.log.show")}
          </button>
        ) : null}
      </div>
      {open && hasOutput ? (
        <div className="flex flex-col gap-1.5">
          <LogTail id={id} lines={step.tail} wrap={step.state === "failed"} label={t("selfUpdate.log.aria", { step: label, count: step.tail.length })} />
          {managed ? null : (
            <div className="flex justify-end">
              <a href={`/api/self-update/steps/${step.name}/log`} target="_blank" rel="noopener" className="text-label font-semibold text-accent no-underline hover:underline">{t("selfUpdate.log.full")}</a>
            </div>
          )}
        </div>
      ) : null}
    </li>
  );
}

function UpdateSection({ s, state, actions, t }: { s: Snapshot; state: ViewState; actions: ViewActions; t: TFunction }) {
  const update = s.update;
  const managed = s.mode === "managed";
  const branch = `origin/${s.meta.branch}`;
  const freshTarget = s.available && s.check.state === "update-available" && s.available.sha !== update.target ? s.available : null;
  const heading = (text: string) => <h2 className="m-0 min-w-0 text-body font-semibold leading-tight text-primary">{text}</h2>;
  const steps = (short: string, list: Step[]) => (
    <ol className="m-0 flex list-none flex-col p-0">
      {list.map((step) => <StepRow key={step.name} step={step} short={short} state={state} actions={actions} t={t} managed={managed} />)}
    </ol>
  );

  if (update.state === "idle" || (update.state === "done" && freshTarget) || (managed && update.state === "failed" && freshTarget)) {
    if (!s.available || s.check.state !== "update-available") {
      const copy = s.check.state === "up-to-date"
        ? t(managed ? "selfUpdate.update.nothingToDeploy" : "selfUpdate.update.nothingToBuild", { sha: s.installed.short, branch })
        : s.check.state === "failed" ? t("selfUpdate.update.lastCheckFailed")
        : s.check.state === "checking" ? t("selfUpdate.status.checking", { branch })
        : t("selfUpdate.update.runCheck");
      return (
        <section data-section="update" data-update="idle" className={CARD}>
          {heading(t("selfUpdate.update.heading"))}
          <p className="m-0 text-ui text-secondary">{copy}</p>
        </section>
      );
    }
    const target = s.available;
    return (
      <section data-section="update" data-update="available" className={CARD}>
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
          {heading(t("selfUpdate.update.to", { target: targetText(target.short, target.version || null) }))}
          <div className="flex justify-end max-sm:w-full">
            <Button action="update" tone="primary" label={t("selfUpdate.update.button")} onClick={actions.update} disabled={s.busy !== null || state.pending.has("update")} />
          </div>
        </div>
        <p className="m-0 text-ui text-secondary">{t(managed ? "selfUpdate.update.noteManaged" : "selfUpdate.update.note")}</p>
        {steps(target.short, update.steps.map((step) => ({ ...step, state: "pending", tail: [], durationMs: null, startedAt: null })))}
      </section>
    );
  }

  const short = update.targetShort ?? "";
  const target = targetText(short, update.targetVersion);
  const elapsed = update.startedAt ? (update.finishedAt ? Date.parse(update.finishedAt) : state.now) - Date.parse(update.startedAt) : 0;

  if (update.state === "running") {
    return (
      <section data-section="update" data-update="running" className={`${CARD} ${EDGE.accent}`}>
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
          {heading(t("selfUpdate.update.to", { target }))}
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-ui font-semibold text-accent">
            <Icon kind="running" />
            {t("selfUpdate.update.progress", { n: runningStepNumber(update.steps), total: update.steps.length })}
          </span>
        </div>
        {steps(short, update.steps)}
      </section>
    );
  }
  if (update.state === "done") {
    return (
      <section data-section="update" data-update="done" className={`${CARD} ${EDGE.success}`}>
        {heading(t("selfUpdate.update.updatedTo", { target }))}
        <p data-outcome="done" className="m-0 rounded-[8px] bg-success-soft px-2.5 py-2 text-ui text-success">
          {t(managed ? "selfUpdate.update.deployed" : "selfUpdate.update.built", { sha: short, duration: duration(elapsed, t) })} {appliedCopy(s, short, t)}
        </p>
        {steps(short, update.steps)}
      </section>
    );
  }
  const failed = update.steps.find((step) => step.state === "failed") ?? update.steps[0]!;
  const remoteMoved = !managed && failed.failure?.kind === "remote-moved";
  const failedName = stepName(failed.name, t);
  const cause = stepFailureText(failed, t);
  const copy = managed
    ? t(update.rolledBack ? "selfUpdate.update.rolledBack" : "selfUpdate.update.failedManaged", { step: failedName, duration: duration(elapsed, t) })
    : t("selfUpdate.update.failed", { step: failedName, duration: duration(elapsed, t) });
  return (
    <section data-section="update" data-update="failed" className={`${CARD} ${EDGE.danger}`}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        {heading(t("selfUpdate.update.to", { target }))}
        <div className="flex flex-wrap justify-end gap-2 max-sm:w-full">
          {freshTarget ? <Button action="update-checked" tone="primary" label={t("selfUpdate.update.checkedTarget", { target: freshTarget.short })} onClick={actions.update} disabled={s.busy !== null || state.pending.has("update")} /> : null}
          {remoteMoved && !freshTarget ? <Button action="check-failed" tone="primary" label={t("selfUpdate.update.checkAgain")} onClick={actions.check} disabled={s.busy !== null || s.check.state === "checking" || state.pending.has("check")} /> : null}
          {!remoteMoved ? <Button
            action="retry"
            tone={freshTarget ? "secondary" : "primary"}
            label={managed ? t("selfUpdate.update.deployAgain") : t("selfUpdate.update.retryFrom", { step: failedName })}
            onClick={actions.retry}
            disabled={s.busy !== null || state.pending.has("update")}
          /> : null}
        </div>
      </div>
      <div data-outcome="failed" className="flex flex-col gap-1 rounded-[8px] bg-danger-soft px-2.5 py-2 text-ui text-danger">
        <p className="m-0">{copy}</p>
        {cause ? <p data-cause="" className="m-0 font-mono text-label [overflow-wrap:anywhere]">{cause}</p> : null}
      </div>
      {steps(short, update.steps)}
    </section>
  );
}

/* Raised over the expand's grown hit area, which reaches into the lines
   around it: a tap on a link always opens the link. */
const INLINE_LINK = "relative z-[1] rounded-[2px] text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
/* Inline in the item's line; the hit area grows past the text, more on touch. */
const ENTRY_TOGGLE = "relative whitespace-nowrap rounded-[4px] text-label font-semibold text-accent before:absolute before:-inset-x-1.5 before:-inset-y-1 before:content-[''] pointer-coarse:before:-inset-y-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

/** Changelog markup as elements (`changelogMarkup.ts`). Text only ever
    becomes a text node, and a link opens its PR or issue in a new tab. */
function Inlines({ nodes }: { nodes: readonly Inline[] }): ReactNode {
  return nodes.map((node, index) => {
    switch (node.kind) {
      case "text": return <Fragment key={index}>{node.text}</Fragment>;
      case "code": return <code key={index} className="rounded-[4px] border border-border bg-sunken px-[3px] font-mono text-[0.92em]">{node.text}</code>;
      case "strong": return <strong key={index} className="font-semibold"><Inlines nodes={node.children} /></strong>;
      case "em": return <em key={index}><Inlines nodes={node.children} /></em>;
      case "link": return <a key={index} href={node.href} target="_blank" rel="noopener noreferrer" title={node.href} className={INLINE_LINK}><Inlines nodes={node.children} /></a>;
    }
  });
}

/** One changelog item: its bold lead (or first sentence), and the rest
    behind its own expand, so nothing is cut inside a span. */
function ChangelogItem({ text, t }: { text: string; t: TFunction }) {
  const [open, setOpen] = useState(false);
  const { lead, rest, cut } = useMemo(() => splitItem(parseInline(text)), [text]);
  const more = rest.length > 0;
  return (
    <li data-entry={open ? "open" : more ? "collapsed" : "whole"} className="[overflow-wrap:anywhere]">
      <Inlines nodes={lead} />
      {more && open ? <Inlines nodes={rest} /> : null}
      {more && !open && cut ? "…" : null}
      {more ? (
        <>
          {" "}
          <button type="button" data-action="toggle-entry" aria-expanded={open} onClick={() => setOpen((value) => !value)} className={ENTRY_TOGGLE}>
            {t(open ? "selfUpdate.changes.collapse" : "selfUpdate.changes.expand")}
          </button>
        </>
      ) : null}
    </li>
  );
}

function ChangesSection({ s, t }: { s: Snapshot; t: TFunction }) {
  const delta = s.check.delta;
  if (!delta || s.check.state !== "update-available") return null;
  const { summary } = delta;
  const commits = t("selfUpdate.changes.commits", { count: summary.commitCount });
  const line = summary.entryCount === 0
    ? `${commits} · ${t("selfUpdate.changes.none")}`
    : `${commits} · ${t("selfUpdate.changes.entries", { count: summary.entryCount })} (${summary.counts.map((entry) => `${entry.count} ${entry.type}`).join(", ")})`;
  const shown = delta.commits.slice(0, 20);
  return (
    <section data-section="changes" aria-label={t("selfUpdate.changes.heading")} className={CARD}>
      <div>
        <h2 className="m-0 text-body font-semibold leading-tight text-primary">{t("selfUpdate.changes.heading")}</h2>
        <p data-summary="" className="m-0 mt-1 text-label text-muted">{line}</p>
      </div>
      {summary.groups.length > 0 ? (
        <div className="flex flex-col gap-2">
          {summary.groups.map((group) => (
            <div key={group.type}>
              <h3 className="m-0 mt-1 text-label font-semibold text-secondary">{group.type}</h3>
              <ul className="m-0 flex list-disc flex-col gap-1 pl-4 text-ui text-primary marker:text-muted">
                {group.items.map((item, index) => <ChangelogItem key={`${index}:${item}`} text={item} t={t} />)}
              </ul>
              {group.more > 0 ? <p className="m-0 text-label text-muted">{t("selfUpdate.changes.more", { count: group.more })}</p> : null}
            </div>
          ))}
        </div>
      ) : null}
      <div>
        <h3 className="m-0 mt-1 text-label font-semibold text-secondary">{t("selfUpdate.changes.commitList")}</h3>
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {shown.map((commit, index) => (
            <li key={`${commit.short}-${index}`} className="flex min-w-0 gap-2.5 text-ui">
              <span data-commit="" className="shrink-0 pt-px font-mono text-label text-muted">{commit.short}</span>
              <span title={commit.subject} className="min-w-0 truncate text-primary">{commit.subject}</span>
            </li>
          ))}
        </ul>
        {delta.commits.length > shown.length ? <p className="m-0 text-label text-muted">{t("selfUpdate.changes.more", { count: delta.commits.length - shown.length })}</p> : null}
      </div>
    </section>
  );
}

/** One line of facts, dot-separated; a line that does not fit ends in an
    ellipsis instead of wrapping a lone separator onto the next line. */
function Facts({ lines }: { lines: (ReactNode | null)[][] }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 text-ui tabular-nums text-secondary">
      {lines.map((line, row) => {
        const parts = line.filter((part) => part !== null);
        if (parts.length === 0) return null;
        return (
          <p key={row} className="m-0 min-w-0 truncate">
            {parts.map((part, index) => (
              <span key={index}>
                {index > 0 ? <span aria-hidden="true" className="mx-1.5 text-muted">·</span> : null}
                {part}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}

function ProcessBlock({ s, role, state, actions, t }: { s: Snapshot; role: "web" | "runtimeHost"; state: ViewState; actions: ViewActions; t: TFunction }) {
  const status = s.processes[role];
  const isHost = role === "runtimeHost";
  const managed = s.mode === "managed";
  const busyKey = isHost ? "restart-runtime-host" : "restart-web";
  const acting = s.busy === busyKey || state.pending.has(busyKey);
  const blocked = s.busy !== null || state.pending.has(busyKey);
  const target = s.update.targetShort ?? s.installed.short;

  const pid = status.pid !== null ? <span className="whitespace-nowrap">PID <span className="font-mono">{status.pid}</span></span> : null;
  const where = isHost
    ? (status.socket ? <span className="whitespace-nowrap font-mono">{status.socket.split("/").pop()}</span> : null)
    : (status.port !== null ? <span className="whitespace-nowrap">{t("selfUpdate.process.port", { port: status.port })}</span> : null);
  const up = status.startedAt ? t("selfUpdate.process.up", { duration: duration(state.now - Date.parse(status.startedAt), t) }) : null;
  const checked = status.lastHealthAt ? t("selfUpdate.process.checked", { time: clock(status.lastHealthAt, true) }) : null;
  const errorText = processErrorText(status.error, role, t);

  let body: ReactNode;
  if (status.state === "healthy") {
    body = <Facts lines={[[pid, where], [up, checked]]} />;
  } else if (status.state === "stopping") {
    body = <p className="m-0 text-ui tabular-nums text-primary">{t(isHost ? "selfUpdate.process.stoppingHost" : "selfUpdate.process.stoppingWeb", { pid: status.pid ?? "…" })}</p>;
  } else if (status.state === "starting") {
    const copy = managed
      ? t(isHost ? "selfUpdate.process.handingOverHost" : "selfUpdate.process.switchingWeb", { sha: target })
      : isHost ? t("selfUpdate.process.startingHost") : t("selfUpdate.process.startingWeb", { port: status.port ?? "…" });
    body = (
      <>
        <p className="m-0 text-ui tabular-nums text-primary">{copy}</p>
        {pid ? <Facts lines={[[pid, where]]} /> : null}
      </>
    );
  } else if (status.state === "failed") {
    body = pid ? <Facts lines={[[pid, where], [checked]]} /> : null;
  } else {
    body = <p className="m-0 text-ui text-primary">{t("selfUpdate.process.notRunning")}</p>;
  }

  /* Once an update is built and published, a process started earlier serves
     the previous release until it restarts. Never mid-build: the installed
     release moves only when a build is ready. */
  const stale = !managed && status.revision && status.pid !== null && s.installed.short
    && status.revision !== s.installed.short && status.state !== "stopping";

  const running = status.pid !== null;
  const label = running ? (isHost ? t("selfUpdate.action.restartHost") : t("selfUpdate.action.restartWeb")) : (isHost ? t("selfUpdate.action.startHost") : t("selfUpdate.action.startWeb"));
  const otherTitle = s.busy && s.busy !== busyKey ? t("selfUpdate.otherAction") : undefined;
  const disabled = blocked || status.state === "stopping" || status.state === "starting";

  let action: ReactNode = null;
  if (managed) {
    action = null;
  } else if (isHost && state.armed && !acting) {
    action = (
      <div role="alertdialog" aria-label={t("selfUpdate.confirm.aria")} data-confirm="" className="flex flex-col gap-2.5 rounded-[8px] border border-warning bg-warning-soft p-3 text-ui text-primary">
        <p className="m-0">{t("selfUpdate.confirm.text")}</p>
        <div className="flex flex-wrap gap-2 max-sm:flex-col">
          <Button action="confirm-host" tone="warningPrimary" label={t("selfUpdate.confirm.go")} onClick={actions.confirmHost} disabled={blocked} />
          <Button action="cancel-host" label={t("selfUpdate.confirm.cancel")} onClick={actions.cancelHost} />
        </div>
      </div>
    );
  } else if (isHost) {
    /* A stopped or failed host supervises nobody, so starting it drops
       nothing and asks nothing. */
    action = (
      <div className="flex justify-end">
        <Button action={running ? "arm-host" : "start-host"} tone="warning" label={label} onClick={running ? actions.armHost : actions.confirmHost} disabled={disabled} title={otherTitle} />
      </div>
    );
  } else {
    action = (
      <div className="flex justify-end">
        <Button action="restart-web" label={label} onClick={actions.restartWeb} disabled={disabled} title={otherTitle} />
      </div>
    );
  }

  const edge = status.state === "failed" ? EDGE.danger : isHost ? EDGE.warning : "";
  return (
    <section data-section={isHost ? "host" : "web"} data-process-state={status.state} aria-label={t(isHost ? "selfUpdate.process.host" : "selfUpdate.process.web")} className={`${CARD} ${edge}`}>
      <div className="flex min-w-0 items-center justify-between gap-3">
        <h2 className="m-0 min-w-0 truncate text-body font-semibold leading-tight text-primary">{t(isHost ? "selfUpdate.process.host" : "selfUpdate.process.web")}</h2>
        <Badge state={status.state} t={t} />
      </div>
      {isHost ? (
        <p className="m-0 flex items-start gap-2 text-ui text-warning">
          <Icon kind="warning" className="mt-0.5" />
          <span>{t(managed ? "selfUpdate.process.hostWarningManaged" : "selfUpdate.process.hostWarning")}</span>
        </p>
      ) : null}
      {body}
      {errorText ? (
        <p data-error="process" className={status.state === "failed" ? ERROR_LINE : "m-0 rounded-[8px] bg-warning-soft px-2 py-1.5 text-label text-warning [overflow-wrap:anywhere]"}>{errorText}</p>
      ) : null}
      {stale ? <p data-stale="" className="m-0 rounded-[8px] bg-accent-soft px-2 py-1.5 text-ui text-primary">{t("selfUpdate.process.stale", { old: status.revision!, new: s.installed.short })}</p> : null}
      {action}
    </section>
  );
}

function Footer({ s, live, t }: { s: Snapshot; live: Live; t: TFunction }) {
  const liveText = live === "sse" ? t("selfUpdate.footer.live") : live === "polling" ? t("selfUpdate.footer.polling") : t("selfUpdate.footer.connecting");
  return (
    <footer className="flex flex-wrap gap-x-3 gap-y-1 px-1 text-label text-muted">
      <span className={live === "polling" ? "text-warning" : ""}>{liveText}</span>
      {s.mode === "checkout" && s.meta.checkout ? (
        <span className="[overflow-wrap:anywhere]">{t("selfUpdate.footer.checkout", { path: "" })}<span className="font-mono">{s.meta.checkout}</span></span>
      ) : null}
      {s.mode === "managed" ? <span>{t("selfUpdate.footer.managed")}</span> : null}
      {s.mode !== "unsupported" ? <span>{t("selfUpdate.footer.every", { minutes: s.meta.pollMinutes })}</span> : null}
    </footer>
  );
}

export function SelfUpdateView({ snapshot: s, live, state, actions }: { snapshot: Snapshot; live: Live; state: ViewState; actions: ViewActions }) {
  const { t, locale } = useLocale();
  const banner = state.waitingForWeb
    ? <p data-banner="waiting" role="status" className="m-0 flex items-center gap-2 rounded-[8px] bg-accent-soft px-3 py-2 text-ui text-primary"><Icon kind="running" />{t("selfUpdate.reconnect.waiting")}</p>
    : state.reloadTo
      ? (
        <div data-banner="reload" role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-[8px] bg-accent-soft px-3 py-2 text-ui text-primary">
          <span className="min-w-0">{t("selfUpdate.reconnect.newVersion", { sha: state.reloadTo })}</span>
          <Button action="reload" tone="primary" label={t("selfUpdate.reconnect.reload")} onClick={actions.reload} />
        </div>
      )
      : null;
  if (s.mode === "unsupported") {
    return (
      <div data-mode="unsupported" className="flex flex-col gap-4 max-sm:gap-3">
        <section data-section="header" className={CARD}>
          <p data-unsupported={s.unsupportedReason ?? ""} className="m-0 text-ui text-secondary">{t(`selfUpdate.unsupported.${s.unsupportedReason ?? "no-launcher"}`)}</p>
        </section>
        <Footer s={s} live={live} t={t} />
      </div>
    );
  }
  return (
    <div data-mode={s.mode} className="flex flex-col gap-4 max-sm:gap-3">
      {banner}
      <Header s={s} state={state} actions={actions} t={t} locale={locale} />
      {/* Two columns from 900 px; below that the restart blocks come first,
          since they are what the operator reaches for after an update, and
          the long log tails go last. */}
      <div className="flex flex-col gap-4 max-sm:gap-3 min-[900px]:grid min-[900px]:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] min-[900px]:items-start">
        <div className="contents min-[900px]:flex min-[900px]:min-w-0 min-[900px]:flex-col min-[900px]:gap-4">
          <div className="order-3 min-w-0 min-[900px]:order-none"><UpdateSection s={s} state={state} actions={actions} t={t} /></div>
          <div className="order-4 min-w-0 empty:hidden min-[900px]:order-none"><ChangesSection s={s} t={t} /></div>
        </div>
        <div className="contents min-[900px]:flex min-[900px]:min-w-0 min-[900px]:flex-col min-[900px]:gap-4">
          <div className="order-1 min-w-0 min-[900px]:order-none"><ProcessBlock s={s} role="web" state={state} actions={actions} t={t} /></div>
          <div className="order-2 min-w-0 min-[900px]:order-none"><ProcessBlock s={s} role="runtimeHost" state={state} actions={actions} t={t} /></div>
        </div>
      </div>
      <Footer s={s} live={live} t={t} />
    </div>
  );
}
