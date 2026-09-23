"use client";

import { CircleDot, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from "lucide-react";
import { useState, type FormEvent } from "react";

import { fmtAge } from "@/components/utils";
import type { ResolvedWorkLinks, WorkLink } from "@/lib/forge/workLinks";
import { useLocale, type TFunction } from "@/lib/i18n";

import { useWorkLinks, type WorkLinkTarget } from "./workLinksContext";

/*
 * PR and issue chips (#2059, docs/design/pr-issue-chips.md §6). A chip is a
 * real link, so middle-click and "copy link" work, and its glyph carries the
 * state, so colour is never the only signal. The text is `#N` in any
 * language, which is what keeps the Ukrainian board as narrow as the English.
 */

/** Chips a row draws before the rest fold behind "+N". */
export const SHOWN_WORK_LINKS = 3;
/** After this long without a sweep, a state reads "as of" its time. */
const STALE_MS = 30 * 60_000;

type ChipTone = "open" | "draft" | "merged" | "closed" | "unknown" | "issue";

function toneOf(link: WorkLink): ChipTone {
  if (link.kind === "issue") return "issue";
  return link.kind === "pr" && link.state ? link.state : "unknown";
}

function Glyph({ tone }: { tone: ChipTone }) {
  const props = { className: "wl-glyph", "aria-hidden": true, size: 12, strokeWidth: 2.25 } as const;
  if (tone === "draft") return <GitPullRequestDraft {...props} />;
  if (tone === "merged") return <GitMerge {...props} />;
  if (tone === "closed") return <GitPullRequestClosed {...props} />;
  if (tone === "issue") return <CircleDot {...props} />;
  return <GitPullRequest {...props} />;
}

/** The whole fact, for the tooltip and the accessible name. */
export function workLinkDescription(t: TFunction, link: WorkLink, nowMs = Date.now()): string {
  const what = link.kind === "issue"
    ? t("workLinks.kind.issue", { number: link.number })
    : link.kind === "pr" ? t("workLinks.kind.pr", { number: link.number }) : t("workLinks.kind.unknown", { number: link.number });
  const parts = [what];
  if (link.kind === "pr") parts.push(t(`workLinks.state.${link.state ?? "unknown"}`));
  const checked = link.checkedAt ? Date.parse(link.checkedAt) : Number.NaN;
  if (link.kind === "pr" && Number.isFinite(checked)) {
    parts.push(nowMs - checked > STALE_MS
      ? t("workLinks.asOf", { time: new Date(checked).toLocaleString() })
      : t("workLinks.checked", { age: fmtAge(checked / 1000) }));
  }
  parts.push(link.via.map((via) => t(`workLinks.via.${via}`)).join(", "));
  return parts.join(" · ");
}

export function WorkLinkChip({ link }: { link: WorkLink }) {
  const { t } = useLocale();
  const tone = toneOf(link);
  const description = workLinkDescription(t, link);
  return (
    <a
      className="wl-chip"
      data-work-link={link.key}
      data-tone={tone}
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      title={description}
      aria-label={description}
      /* The card underneath treats a press as the start of a drag or a
         selection; a link's press is its own. */
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <Glyph tone={tone} />
      <span className="wl-num">#{link.number}</span>
    </a>
  );
}

/** The passive clause a phone row's sentence carries (§6.4): a row is one
    tap target, so a link cannot sit inside it. */
export function workLinkClause(t: TFunction, resolved: ResolvedWorkLinks | null): string | null {
  const pr = resolved?.links.find((link) => link.kind === "pr");
  if (pr) return t("workLinks.rowClause", { number: pr.number, state: t(`workLinks.state.${pr.state ?? "unknown"}`) });
  return resolved?.noPr ? t("workLinks.rowNoPr") : null;
}

/**
 * A row of chips: the first three, then "+N" opening every link, or plain
 * "no PR" for a lane whose branches have none. Nothing at all when there is
 * nothing to say.
 */
export function WorkLinkRow({ resolved, showNoPr, onMore, className, testId }: {
  resolved: ResolvedWorkLinks | null;
  showNoPr: boolean;
  /** Opens the whole list; absent, every chip is drawn. */
  onMore?: (anchor: HTMLElement) => void;
  className?: string;
  testId: string;
}) {
  const { t } = useLocale();
  const links = resolved?.links ?? [];
  if (!links.length && !(showNoPr && resolved?.noPr)) return null;
  const shown = onMore && links.length > SHOWN_WORK_LINKS ? links.slice(0, SHOWN_WORK_LINKS) : links;
  const rest = links.length - shown.length;
  return (
    <div className={`wl-row${className ? ` ${className}` : ""}`} data-work-links={testId} role="list" aria-label={t("workLinks.listTitle")}>
      {shown.map((link) => <span key={link.key} role="listitem" className="wl-item"><WorkLinkChip link={link} /></span>)}
      {rest > 0 && onMore ? (
        <button
          type="button"
          className="wl-more"
          data-work-links-more={rest}
          aria-label={t("workLinks.moreAria", { count: rest })}
          title={t("workLinks.moreAria", { count: rest })}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); onMore(event.currentTarget); }}
        >
          {t("workLinks.more", { count: rest })}
        </button>
      ) : null}
      {!links.length ? <span className="wl-nopr" data-work-links-nopr="" title={t("workLinks.noPrTitle")}>{t("workLinks.noPr")}</span> : null}
    </div>
  );
}

/** Every link of a record as full-width rows, the manual ones detachable, and
    the attach form under them. The popover and the phone sheet both draw it. */
export function WorkLinksPanel({ target, resolved }: { target: WorkLinkTarget; resolved: ResolvedWorkLinks | null }) {
  const { t } = useLocale();
  const { edit } = useWorkLinks();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const links = resolved?.links ?? [];
  const run = async (action: "attach" | "detach", link: string) => {
    setBusy(true);
    const refusal = await edit(target, action, link);
    setBusy(false);
    setError(refusal);
    if (!refusal && action === "attach") setDraft("");
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (draft.trim() && !busy) void run("attach", draft.trim());
  };
  return (
    <div className="wl-panel" data-work-links-panel={`${target.kind}:${target.id}`}>
      {links.length ? (
        <ul className="wl-list">
          {links.map((link) => (
            <li key={link.key} className="wl-list-row" data-work-link-row={link.key}>
              <WorkLinkChip link={link} />
              <span className="wl-via">{link.source === "manual" ? t("workLinks.via.manual") : link.via.map((via) => t(`workLinks.via.${via}`)).join(", ")}</span>
              {link.source === "manual" ? (
                <button
                  type="button"
                  className="wl-detach"
                  data-work-link-detach={link.key}
                  disabled={busy}
                  aria-label={t("workLinks.detachAria", { link: `#${link.number}` })}
                  title={t("workLinks.detachAria", { link: `#${link.number}` })}
                  onClick={() => void run("detach", `${link.repository}#${link.number}`)}
                >
                  ×
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : <p className="wl-empty">{resolved?.noPr ? t("workLinks.noPrTitle") : t("workLinks.none")}</p>}
      <form className="wl-form" onSubmit={submit}>
        <input
          type="text"
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          className="wl-input"
          data-work-link-input=""
          placeholder={t("workLinks.placeholder")}
          aria-label={t("workLinks.inputAria")}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className="wl-attach" data-work-link-attach="" disabled={busy || !draft.trim()}>{t("workLinks.attachButton")}</button>
      </form>
      {error ? <p className="wl-error" role="alert" data-work-link-error="">{error}</p> : null}
    </div>
  );
}
