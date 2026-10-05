"use client";

/*
 * Second-round design prototype (docs/design/own-message-steps.md): step to
 * the previous and next message the operator typed, with the controls in space
 * that is theirs. Only the conversation evidence fixture mounts this
 * (`?case=own-message-steps&variant=1|2|3|4`); no product file imports it.
 *
 * The pane is the production one: `BranchPane` on the desktop, and on the
 * phone `BranchPane` inside `MobileShell` with the conversation's own `⋯`
 * menu. Two placements use slots those components already have (`barAction`,
 * `composerMount`). The others (right of the header's title, the composer's
 * own row, the feed's way-back row, the `⋯` sheet) have no slot today, so this
 * file inserts a host node there, which is what the build would replace with
 * a prop.
 *
 * A message is the operator's when the feed renders it as their bubble
 * (`data-feed-kind="user"`). Stepping reads those rows and scrolls the feed's
 * own scroller.
 */

import { ChevronDown, ChevronUp, ChevronsUpDown, ScrollText } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { BranchPane } from "@/components/BranchPane";
import { MobileConversationMenu } from "@/components/mobile/MobileConversationMenu";
import { MobileSheetDivider, MobileSheetRow } from "@/components/mobile/MobileSheet";
import { MobileBarTitle, MobileShell } from "@/components/mobile/MobileShell";
import { useMobileNavStore } from "@/components/mobile/mobileNav";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useLocale, type Locale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { STEP_PAD_DESKTOP_PX, STEP_PAD_PHONE_PX, stepCountLabel, stepScrollTop, stepState, stepTarget, type StepReading, type StepState } from "./ownMessageSteps.prototype.model";

export type StepVariant = 0 | 1 | 2 | 3 | 4;

const COPY = {
  en: {
    previous: "Previous message of mine",
    next: "Next message of mine",
    previousShort: "Previous mine",
    nextShort: "Next mine",
    count: (state: StepState) => `Your message ${state.position} of ${state.total}${state.olderUnloaded ? ", earlier ones not loaded" : ""}`,
    keys: "Alt+↑ / Alt+↓",
    reports: "Report log",
    title: "Orchestrator",
    working: "working",
    variants: ["Today's pane, no controls", "In the header", "A row above the composer", "In the composer's own row", "Shortcut and menu rows"],
  },
  uk: {
    previous: "Попереднє моє повідомлення",
    next: "Наступне моє повідомлення",
    previousShort: "Попереднє моє",
    nextShort: "Наступне моє",
    count: (state: StepState) => `Ваше повідомлення ${state.position} з ${state.total}${state.olderUnloaded ? ", раніші не завантажено" : ""}`,
    keys: "Alt+↑ / Alt+↓",
    reports: "Журнал звітів",
    title: "Оркестратор",
    working: "працює",
    variants: ["Сьогоднішня панель без керування", "У шапці", "Рядок над полем вводу", "У рядку самого поля вводу", "Клавіші та рядки меню"],
  },
} as const;
type Copy = (typeof COPY)[keyof typeof COPY];

const EMPTY: StepState = { position: 0, total: 0, olderUnloaded: false, canPrev: false, canNext: false };
const SCROLLER = "[data-log-feed-scroller]";

function readFeed(pane: HTMLElement | null, pad: number): { scroller: HTMLElement; rows: HTMLElement[]; reading: StepReading } | null {
  const scroller = pane?.querySelector<HTMLElement>(SCROLLER);
  if (!scroller) return null;
  const box = scroller.getBoundingClientRect();
  const rows = Array.from(scroller.querySelectorAll<HTMLElement>('[data-feed-kind="user"]'));
  return {
    scroller,
    rows,
    reading: {
      tops: rows.map((row) => row.getBoundingClientRect().top - box.top + scroller.scrollTop),
      scrollTop: scroller.scrollTop,
      viewport: scroller.clientHeight,
      maxScroll: scroller.scrollHeight - scroller.clientHeight,
      olderUnloaded: Number(scroller.dataset.tailLinesStart ?? 0) > 0,
      pad,
    },
  };
}

interface Steps {
  state: StepState;
  step: (direction: -1 | 1) => void;
}

function useOwnSteps(pane: HTMLElement | null, pad: number): Steps {
  const [state, setState] = useState<StepState>(EMPTY);
  useEffect(() => {
    if (!pane) return;
    let frame = 0;
    let watched: HTMLElement | null = null;
    const publish = () => {
      frame = 0;
      const next = stepState(readFeed(pane, pad)?.reading ?? { tops: [], scrollTop: 0, viewport: 0, maxScroll: 0, olderUnloaded: false, pad });
      setState((previous) => (Object.keys(next) as (keyof StepState)[]).every((key) => previous[key] === next[key]) ? previous : next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(publish); };
    const resize = new ResizeObserver(schedule);
    const attach = () => {
      const scroller = pane.querySelector<HTMLElement>(SCROLLER);
      if (scroller !== watched) {
        watched?.removeEventListener("scroll", schedule);
        resize.disconnect();
        watched = scroller;
        scroller?.addEventListener("scroll", schedule, { passive: true });
        if (scroller) resize.observe(scroller);
      }
      schedule();
    };
    const mutation = new MutationObserver(attach);
    mutation.observe(pane, { childList: true, subtree: true });
    attach();
    return () => {
      mutation.disconnect();
      resize.disconnect();
      watched?.removeEventListener("scroll", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [pane, pad]);

  const step = useCallback((direction: -1 | 1) => {
    const feed = readFeed(pane, pad);
    if (!feed) return;
    const target = stepTarget(feed.reading, direction);
    const top = target !== null ? stepScrollTop(feed.reading, target) : direction < 0 && feed.reading.olderUnloaded ? 0 : null;
    if (top === null) return;
    const move = (to: number) => {
      /* The feed tells its own scrolls from the reader's by the input that
         preceded them, and loads older history on the reader's way up; a step
         is the reader's, so it says so the same way a wheel does. In the build
         the feed's own functions do this. */
      feed.scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: to > feed.scroller.scrollTop ? 1 : -1, bubbles: true }));
      if (feed.scroller.scrollTop === to) feed.scroller.dispatchEvent(new Event("scroll"));
      else feed.scroller.scrollTop = to;
    };
    move(top);
    const row = target === null ? null : feed.rows[target];
    if (!row) return;
    /* Rows off screen are laid out at an estimated height, so the landing is
       held for half a second while the rows around it take their real one,
       and let go the moment the reader scrolls. */
    const until = performance.now() + 500;
    let released = false;
    const release = (event: Event) => { if (event.isTrusted) released = true; };
    for (const type of ["wheel", "touchstart", "pointerdown", "keydown"]) feed.scroller.addEventListener(type, release, { passive: true });
    const settle = () => {
      const now = readFeed(pane, pad);
      const index = now?.rows.indexOf(row) ?? -1;
      if (!released && now && index !== -1) {
        const wanted = stepScrollTop(now.reading, index);
        if (Math.abs(wanted - now.scroller.scrollTop) > 1) move(wanted);
        if (performance.now() < until) { requestAnimationFrame(settle); return; }
      }
      for (const type of ["wheel", "touchstart", "pointerdown", "keydown"]) feed.scroller.removeEventListener(type, release);
    };
    requestAnimationFrame(settle);
  }, [pane, pad]);
  return { state, step };
}

/** A host node kept inside an element the pane owns, for the two places that
    have no slot today. React never sees it, so it is put back if a render of
    the parent drops it. */
function useInjectedHost(root: HTMLElement | null, find: ((root: HTMLElement) => { parent: HTMLElement; before: Node | null } | null) | null): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const finder = useRef(find);
  useEffect(() => { finder.current = find; });
  const enabled = find !== null;
  useEffect(() => {
    if (!root || !enabled) return;
    const node = document.createElement("span");
    node.style.display = "contents";
    node.dataset.ownStepsHost = "";
    const place = () => {
      const spot = finder.current?.(root) ?? null;
      if (!spot) {
        if (node.isConnected) { node.remove(); setHost(null); }
        return;
      }
      if (node.parentElement === spot.parent && (spot.before === node || node.nextSibling === spot.before)) return;
      spot.parent.insertBefore(node, spot.before);
      setHost(node);
    };
    const observer = new MutationObserver(place);
    observer.observe(root, { childList: true, subtree: true });
    place();
    return () => { observer.disconnect(); node.remove(); setHost(null); };
  }, [root, enabled]);
  return host;
}

const HEADER_BUTTON = "inline-flex shrink-0 items-center justify-center rounded-[8px] border border-border bg-canvas px-1.5 py-0.5 text-muted hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40";
const BAR_BUTTON = "flex h-11 w-11 shrink-0 items-center justify-center rounded-[8px] text-secondary active:bg-sunken active:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-35";
const ROW_BUTTON = "inline-flex h-full min-w-11 items-center justify-center gap-1 rounded-[8px] px-2 text-label font-semibold text-secondary hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 disabled:opacity-40";
const CHIP_BUTTON = "inline-flex h-6 shrink-0 items-center justify-center rounded-control border border-border px-1.5 text-muted hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40";
const COUNT = "shrink-0 whitespace-nowrap font-mono text-[10px] tabular-nums text-muted";

function StepButton({ direction, steps, copy, className, icon, children }: {
  direction: -1 | 1;
  steps: Steps;
  copy: Copy;
  className: string;
  icon: string;
  children?: ReactNode;
}) {
  const Icon = direction < 0 ? ChevronUp : ChevronDown;
  const label = direction < 0 ? copy.previous : copy.next;
  return (
    <button
      type="button"
      data-own-step-control={direction < 0 ? "previous" : "next"}
      aria-label={label}
      title={`${label} · ${direction < 0 ? "Alt+↑" : "Alt+↓"}`}
      disabled={direction < 0 ? !steps.state.canPrev : !steps.state.canNext}
      className={className}
      onClick={() => steps.step(direction)}
    >
      <Icon className={icon} aria-hidden />
      {children}
    </button>
  );
}

function StepCount({ steps, copy, className = COUNT, children }: { steps: Steps; copy: Copy; className?: string; children?: ReactNode }) {
  return (
    <span data-own-step-control="count" data-own-step-count={stepCountLabel(steps.state)} aria-label={copy.count(steps.state)} title={copy.keys} className={className}>
      {children}{stepCountLabel(steps.state)}
    </span>
  );
}

/** Variant 1 on the desktop: in the pane header, straight after the title. */
function HeaderSteps({ steps, copy }: { steps: Steps; copy: Copy }) {
  return (
    <span data-own-steps="header" className="inline-flex shrink-0 items-center gap-1">
      <StepButton direction={-1} steps={steps} copy={copy} className={HEADER_BUTTON} icon="h-3 w-3" />
      <StepCount steps={steps} copy={copy} />
      <StepButton direction={1} steps={steps} copy={copy} className={HEADER_BUTTON} icon="h-3 w-3" />
    </span>
  );
}

/** Variant 2: a row of its own between the feed and the composer. */
function StripSteps({ steps, copy, phone }: { steps: Steps; copy: Copy; phone: boolean }) {
  return (
    <div data-own-steps="strip" className={`flex shrink-0 items-center justify-center gap-1 box-content border-t border-border px-2 ${phone ? "h-11" : "h-9"}`}>
      <StepButton direction={-1} steps={steps} copy={copy} className={ROW_BUTTON} icon="h-3.5 w-3.5">{copy.previousShort}</StepButton>
      <StepCount steps={steps} copy={copy} className={`${COUNT} px-2`} />
      <StepButton direction={1} steps={steps} copy={copy} className={ROW_BUTTON} icon="h-3.5 w-3.5">{copy.nextShort}</StepButton>
    </div>
  );
}

/** Variant 3 on the desktop: cells of the composer's options row. */
function ComposerSteps({ steps, copy }: { steps: Steps; copy: Copy }) {
  return (
    <span data-own-steps="composer" className="inline-flex shrink-0 items-center gap-1">
      <StepButton direction={-1} steps={steps} copy={copy} className={CHIP_BUTTON} icon="h-3 w-3" />
      <StepCount steps={steps} copy={copy} />
      <StepButton direction={1} steps={steps} copy={copy} className={CHIP_BUTTON} icon="h-3 w-3" />
    </span>
  );
}

/** Variant 4 on the desktop: no button at all, only where the keys have got to. */
function Indicator({ steps, copy }: { steps: Steps; copy: Copy }) {
  return (
    <StepCount steps={steps} copy={copy} className={`${COUNT} inline-flex items-center gap-0.5`}>
      <ChevronsUpDown className="h-3 w-3" aria-hidden />
    </StepCount>
  );
}

function Band({ variant, copy }: { variant: StepVariant; copy: Copy }) {
  return (
    <div data-own-proto-band className="flex h-10 shrink-0 items-center gap-2.5 border-b border-border bg-sunken px-3">
      <span data-own-variant-number className="text-[30px] font-black leading-none text-accent">{variant}</span>
      <span className="min-w-0 truncate text-label font-semibold text-secondary">{copy.variants[variant]}</span>
    </div>
  );
}

const noop = () => undefined;

interface ProtoControls {
  step: (direction: -1 | 1) => void;
  state: () => StepState;
  /** The on-screen keyboard's overlap, as the phone shell pads it away. */
  keyboard: (px: number) => void;
}

export function OwnMessageStepsPrototype({ file, variant, paneWidth }: {
  file: FileEntry;
  variant: StepVariant;
  /** A board-node-sized pane; absent, the pane fills the window. */
  paneWidth?: number;
}) {
  const phone = useIsMobile();
  const { locale } = useLocale();
  const copy: Copy = COPY[(locale as Locale) === "uk" ? "uk" : "en"];
  const nav = useMobileNavStore();
  const [pane, setPane] = useState<HTMLElement | null>(null);
  const [mount, setMount] = useState<HTMLDivElement | null>(null);
  const [keyboard, setKeyboard] = useState(0);
  const steps = useOwnSteps(pane, phone ? STEP_PAD_PHONE_PX : STEP_PAD_DESKTOP_PX);
  const live = useRef(steps);
  useEffect(() => { live.current = steps; });

  useEffect(() => {
    (window as unknown as { ownSteps: ProtoControls }).ownSteps = {
      step: (direction) => live.current.step(direction),
      state: () => live.current.state,
      keyboard: setKeyboard,
    };
  }, []);

  /* Alt+↑ / Alt+↓ in every variant. The composer keeps the bare arrows for its
     own history, and nothing else in the product takes Alt with an arrow. */
  useEffect(() => {
    if (variant === 0) return;
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      live.current.step(event.key === "ArrowUp" ? -1 : 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [variant]);

  /* Variant 3. The desktop's options row holds the pair and the count. The
     phone's tools row has one free cell at 390 px, so it holds the step back,
     and the step forward sits in the feed's own way-back row: that row exists
     exactly while there is something below to step to. An empty cell of the
     same width on the other side keeps the row's pill where it was. */
  const composerHost = useInjectedHost(pane, variant !== 3 ? null : phone
    ? (root) => {
        const tools = root.querySelector<HTMLElement>("[data-mobile2-tools]");
        return tools ? { parent: tools, before: tools.firstChild } : null;
      }
    : (root) => {
        const left = root.querySelector<HTMLElement>('[data-testid="composer-options-row"]')?.firstElementChild as HTMLElement | null;
        return left ? { parent: left, before: null } : null;
      });
  const jumpRow = variant === 3 && phone;
  const jumpHost = useInjectedHost(pane, jumpRow ? (root) => {
    const strip = root.querySelector<HTMLElement>("[data-feed-jump-strip]");
    return strip ? { parent: strip, before: null } : null;
  } : null);
  const jumpBalance = useInjectedHost(pane, jumpRow ? (root) => {
    const strip = root.querySelector<HTMLElement>("[data-feed-jump-strip]");
    return strip ? { parent: strip, before: strip.querySelector("button") } : null;
  } : null);
  /* Variants 1 and 4 on the desktop sit straight after the title, the one
     flexible cell of the header's first row, so the title gives up their
     width and no button to its right moves. (`headerActions` sits among the
     buttons and would push three of them left.) */
  const headerHost = useInjectedHost(pane, !phone && (variant === 1 || variant === 4) ? (root) => {
    const title = root.querySelector<HTMLElement>("[data-link-path] > header > div > .truncate");
    return title?.parentElement ? { parent: title.parentElement, before: title.nextSibling } : null;
  } : null);
  const menuHost = useInjectedHost(pane, variant === 4 && phone
    ? (root) => {
        const menu = root.querySelector<HTMLElement>('[data-mobile2-sheet="menu"] [role="menu"], [role="dialog"] [role="menu"]');
        return menu ? { parent: menu, before: menu.firstChild } : null;
      }
    : null);

  const menuRow = (direction: -1 | 1) => (
    <MobileSheetRow
      icon={direction < 0 ? <ChevronUp className="h-[18px] w-[18px]" aria-hidden /> : <ChevronDown className="h-[18px] w-[18px]" aria-hidden />}
      label={direction < 0 ? copy.previous : copy.next}
      trailing={<span className={COUNT}>{stepCountLabel(steps.state)}</span>}
      disabled={direction < 0 ? !steps.state.canPrev : !steps.state.canNext}
      onSelect={() => { nav.closeSheet(); steps.step(direction); }}
      attrs={{ "data-own-step-control": direction < 0 ? "previous" : "next", "data-mobile2-menu-row": direction < 0 ? "own-previous" : "own-next" }}
    />
  );

  const portals = (
    <>
      {headerHost ? createPortal(variant === 1 ? <HeaderSteps steps={steps} copy={copy} /> : <Indicator steps={steps} copy={copy} />, headerHost) : null}
      {variant === 2 && mount ? createPortal(<StripSteps steps={steps} copy={copy} phone={phone} />, mount) : null}
      {composerHost ? createPortal(phone
        ? <span data-own-steps="composer" className="flex shrink-0 items-center"><StepButton direction={-1} steps={steps} copy={copy} className={BAR_BUTTON} icon="h-5 w-5" /></span>
        : <ComposerSteps steps={steps} copy={copy} />, composerHost) : null}
      {jumpBalance ? createPortal(<span aria-hidden className="mr-auto block h-11 w-11 shrink-0" />, jumpBalance) : null}
      {jumpHost ? createPortal(<span data-own-steps="jump-row" className="ml-auto flex shrink-0 items-center"><StepButton direction={1} steps={steps} copy={copy} className={BAR_BUTTON} icon="h-5 w-5" /></span>, jumpHost) : null}
      {menuHost ? createPortal(<span data-own-steps="menu" className="contents">{menuRow(-1)}{menuRow(1)}<MobileSheetDivider /></span>, menuHost) : null}
    </>
  );

  if (phone) {
    return (
      <div data-own-proto={variant} className="flex h-dvh min-h-0 flex-col bg-canvas text-primary">
        <Band variant={variant} copy={copy} />
        <div
          ref={setPane}
          data-testid="mobile-chat-shell"
          className="relative flex min-h-0 min-w-0 max-w-[100dvw] flex-1 flex-col overflow-hidden overflow-x-clip"
          style={keyboard > 0 ? { paddingBottom: keyboard } : undefined}
        >
          <MobileShell
            screen="chat"
            screenId={file.conversationId ?? file.path}
            title={(
              <MobileBarTitle meta={variant === 4 ? <span className="flex min-w-0 items-center gap-1.5 text-label text-muted"><span className="truncate">{copy.working}</span><Indicator steps={steps} copy={copy} /></span> : <span className="truncate text-label text-muted">{copy.working}</span>}>
                {copy.title}
              </MobileBarTitle>
            )}
            back
            barAction={(
              <>
                {variant === 1 ? (
                  <span data-own-steps="header" className="flex shrink-0 items-center">
                    <StepButton direction={-1} steps={steps} copy={copy} className={BAR_BUTTON} icon="h-5 w-5" />
                    <StepButton direction={1} steps={steps} copy={copy} className={BAR_BUTTON} icon="h-5 w-5" />
                  </span>
                ) : null}
                {/* The seat's own conversation already has one action here (#2146). */}
                <button type="button" data-mobile2-open="reports" aria-label={copy.reports} className={BAR_BUTTON} onClick={noop}>
                  <ScrollText className="h-5 w-5" aria-hidden />
                </button>
              </>
            )}
            renderSheet={(name, close) => name === "menu" ? (
              <MobileConversationMenu
                file={file}
                stage={null}
                crowned={false}
                hostTaskCount={0}
                onRename={noop}
                onOpenHost={noop}
                onCloseCard={noop}
                projectName="delegatus"
                onClose={close}
              />
            ) : null}
          >
            <BranchPane file={file} tasks={[]} isRoot chromeInMenu onClose={noop} composerMount={variant === 2 ? setMount : undefined} />
          </MobileShell>
        </div>
        {portals}
      </div>
    );
  }
  return (
    <div data-own-proto={variant} className="flex h-dvh min-h-0 flex-col bg-canvas text-primary">
      <Band variant={variant} copy={copy} />
      <div ref={setPane} className="flex min-h-0 flex-1 self-center p-3" style={{ width: paneWidth ? paneWidth + 24 : "100%" }}>
        <BranchPane
          file={file}
          tasks={[]}
          isRoot
          onClose={noop}
          onToggleExpand={noop}
          composerMount={variant === 2 ? setMount : undefined}
        />
      </div>
      {portals}
    </div>
  );
}

/* ── The fixture conversation ───────────────────────────────────────────── */

const TEXT = {
  en: {
    own: [
      "Start the day: what on the board is waiting for me, and where exactly?",
      "Close the old cards that have not moved for over a week, but show me the list first.",
      "What is going on with the release? Why is the main branch red for the second day?",
      "Put a separate analyst on the slow opening of long conversations. I want the cause, with evidence.",
      "I did not follow the part about collecting documentation. Why is it being removed from the checks? Is it needed or not?",
      "Cards on the phone jump when I drag them between columns. Make a task and a pipeline.",
      "Why are so few agents working? The limits are free.",
      "Show me what is left of the reviewer's findings on the search lane.",
      "Fine. Merge the search lane when the browser check passes, and tell me when it is deployed.",
    ],
    replies: [
      "Two cards are waiting for you, the rest move without you.",
      "Found eleven cards with no movement for over a week; the list is below, nothing is closed yet.",
      "The main branch is red because of one check: the privacy test outlives its time budget.",
      "Started an analyst on a separate lane with one requirement: measure the time to the first row on the phone and on the desktop.",
      "Collecting documentation stays; only its repeat in the check before the merge is removed.",
      "Created the card for the jumping phone cards and bound a pipeline to it.",
      "Three lanes are running out of three allowed; the limits are free, the ceiling on parallel lanes is what holds it.",
      "Two findings are left on the search lane, both second priority.",
      "Agreed: the search lane merges as soon as the browser check passes, and I will write here once it is deployed.",
    ],
    detail: [
      "What changed since last time: one lane moved from waiting into work, one card went back for rework after the review, and a third is waiting for the browser check. None of them needs your decision right now.",
      "Next I do this myself and come back with the result: rerun the check on a fresh branch, read the frames at 390 px and only then merge. If the check fails again I open a separate lane for the cause and write here in one message.",
      "I checked this against the board and the lane's journal; nothing here is from memory. The lane's last record is twelve minutes old, the review stage ended with no first-priority findings, and the next step is already assigned.",
      "One answer is needed from you, and it does not block the rest: whether to keep the ceiling at three parallel lanes. My recommendation is to keep it until the end of the day, because two lanes touch the same files and a fourth would add conflicts.",
    ],
    wake: [
      "Orchestrator seat wake. Reason: scheduled board check, fifteen minutes since the last one.",
      "Orchestrator seat wake. Reason: the lane for fast opening of long conversations has not written to its journal for twenty minutes.",
      "Orchestrator seat wake. Reason: a stage finished and its verdict is waiting to be read.",
    ],
    wakeReply: [
      "Checked the board: three lanes in work, no new blocks. Changed nothing.",
      "The lane is alive, the agent is waiting on a long type check. Left it as is and will look again on the next wake.",
      "Read the verdict, moved the card on and started the next stage.",
    ],
    notice: [
      "Agent finished: review of the search lane. Verdict: no findings. The turn ended after 6 min 12 s.",
      "Agent finished: builder of the report log lane. Verdict: pass, two notes. The turn ended after 21 min 40 s.",
    ],
    noticeReply: "Took the agent's result, moved its conclusion into the card and started the fix stage with two findings.",
    pipeline: "Pipeline for the search lane: the fix stage returned the branch to review.",
    pipelineReply: "The search lane is back in review; nothing is needed from you.",
    harness: "<environment_context>\n  <cwd>/workspace/delegatus</cwd>\n  <shell>bash</shell>\n</environment_context>",
  },
  uk: {
    own: [
      "Почни день: що на дошці чекає на мене, а що їде саме?",
      "Закрий старі картки, які висять без руху понад тиждень, але спершу покажи список.",
      "Що зараз із релізом? Чому головна гілка червона другий день?",
      "Запусти окремого аналітика на повільне відкриття довгих розмов. Хочу причину з доказами.",
      "Не зрозумів про збирання документації. Чому воно прибирається з перевірок? Це треба чи ні?",
      "Картки на телефоні стрибають, коли я перетягую їх між колонками. Зроби задачу і пайплайн.",
      "Чому так мало агентів працює? Ліміти ж вільні.",
      "Покажи, що лишилося з зауважень рецензента по лінії з пошуком.",
      "Добре. Зливай лінію пошуку, коли пройде перевірка в браузері, і напиши, коли викотиш.",
    ],
    replies: [
      "На вас чекають дві картки, решта рухається без вашої участі.",
      "Знайшов одинадцять карток без руху понад тиждень; список нижче, нічого ще не закрито.",
      "Головна гілка червона через одну перевірку: тест приватності перевищує відведений час.",
      "Запустив аналітика окремою лінією з однією вимогою: виміряти час до першого рядка на телефоні й на десктопі.",
      "Збирання документації лишається, прибирається тільки його повтор у перевірці перед злиттям.",
      "Створив картку про стрибки карток на телефоні й прив'язав до неї пайплайн.",
      "Працюють три лінії з дозволених трьох; ліміти справді вільні, обмежує стеля одночасних ліній.",
      "По лінії пошуку лишилося два зауваження, обидва другого пріоритету.",
      "Домовилися: лінія пошуку зливається, щойно пройде перевірка в браузері, і я напишу сюди після викочування.",
    ],
    detail: [
      "Що змінилося від попереднього разу: одну лінію переведено з очікування в роботу, одна картка повернулася на доопрацювання після рецензії, а третя чекає на перевірку в браузері. Жодна з них не потребує вашого рішення просто зараз.",
      "Далі я роблю це сам і повернуся з результатом: перезапускаю перевірку на свіжій гілці, читаю знімки на 390 px і лише після цього зливаю. Якщо перевірка знову впаде, відкрию окрему лінію на причину й напишу сюди одним повідомленням.",
      "Перевірив це по стану дошки й по журналу лінії, з пам'яті нічого не брав. Останній запис лінії зроблено дванадцять хвилин тому, етап рецензії завершився без зауважень першого пріоритету, і наступний крок уже призначено.",
      "Від вас потрібна одна відповідь, і вона не блокує решту роботи: чи лишати стелю в три одночасні лінії. Моя рекомендація: лишити до кінця дня, бо дві лінії торкаються тих самих файлів і четверта додала б конфліктів.",
    ],
    wake: [
      "Пробудження місця оркестратора. Причина: планова перевірка дошки, з попередньої минуло п'ятнадцять хвилин.",
      "Пробудження місця оркестратора. Причина: лінія «Швидке відкриття довгих розмов» не писала в журнал двадцять хвилин.",
      "Пробудження місця оркестратора. Причина: етап завершився, його вердикт чекає на прочитання.",
    ],
    wakeReply: [
      "Перевірив дошку: три лінії в роботі, нових блокувань немає. Нічого не змінював.",
      "Лінія жива, агент чекає на довгу перевірку типів. Залишив як є й перевірю на наступному пробудженні.",
      "Прочитав вердикт, пересунув картку далі й запустив наступний етап.",
    ],
    notice: [
      "Агент завершив: рецензія лінії «Пошук по розмовах». Вердикт: без зауважень. Хід завершено, працював 6 хв 12 с.",
      "Агент завершив: виконавець лінії «Журнал звітів». Вердикт: пройдено, дві примітки. Хід завершено, працював 21 хв 40 с.",
    ],
    noticeReply: "Узяв результат агента, переніс висновок у картку й запустив етап виправлення з двома зауваженнями.",
    pipeline: "Пайплайн «Пошук по розмовах»: етап «виправлення» повернув гілку на рецензію.",
    pipelineReply: "Лінія пошуку знову на рецензії; від вас нічого не потрібно.",
    harness: "<environment_context>\n  <cwd>/workspace/delegatus</cwd>\n  <shell>bash</shell>\n</environment_context>",
  },
} as const;

/** How many machine-sent turns follow each own message, oldest first. */
const MACHINE_AFTER = [4, 5, 3, 4, 5, 4, 6, 4, 2] as const;
/** Own messages in the page that is not loaded when the conversation opens. */
export const OWN_STEPS_UNLOADED = 2;
export const OWN_STEPS_TOTAL = 9;

/**
 * A Codex transcript of an orchestrator's day: nine messages the operator
 * typed among thirty-seven machine-sent turns (seat wakes, finished-agent
 * notices, a pipeline message), each answered. Every record carries the
 * structured-user marker a real delivery writes, which is what the feed
 * parser reads the sender from. `loadedFrom` is the line where the loaded
 * window starts. All text is invented.
 */
export function ownStepsTranscript(lang: "en" | "uk"): { lines: string[]; loadedFrom: number } {
  const text = TEXT[lang];
  const lines: string[] = [];
  let clock = Date.parse("2026-09-28T06:00:00.000Z");
  const at = (minutes: number) => new Date(clock += minutes * 60_000).toISOString();
  const user = (marker: string, body: string, minutes: number) => lines.push(JSON.stringify({
    timestamp: at(minutes), type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: marker ? `${marker}\n${body}` : body }] },
  }));
  const agent = (body: string) => lines.push(JSON.stringify({ timestamp: at(1), type: "event_msg", payload: { type: "agent_message", message: body } }));
  const tool = (id: string) => {
    lines.push(JSON.stringify({ timestamp: at(0.2), type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "git status --short"] }), call_id: id } }));
    lines.push(JSON.stringify({ timestamp: at(0.2), type: "response_item", payload: { type: "function_call_output", call_id: id, output: "clean" } }));
  };
  const machine = (role: string) => `<!-- llv:structured-user origin=agent sender=${role} -->`;
  let loadedFrom = 0;
  user("", text.harness, 0);
  for (let own = 0; own < OWN_STEPS_TOTAL; own += 1) {
    if (own === OWN_STEPS_UNLOADED) loadedFrom = lines.length;
    user("<!-- llv:structured-user origin=operator -->", text.own[own]!, 7);
    tool(`call_own_${own}`);
    agent([text.replies[own]!, text.detail[own % 4]!, text.detail[(own + 1) % 4]!, text.detail[(own + 2) % 4]!].join("\n\n"));
    for (let turn = 0; turn < MACHINE_AFTER[own]!; turn += 1) {
      const kind = (own + turn) % 5;
      if (kind === 3) {
        user(machine(turn % 2 ? "reviewer" : "builder"), text.notice[turn % 2]!, 11);
        agent(`${text.noticeReply}\n\n${text.detail[(own + turn) % 4]!}`);
      } else if (kind === 4) {
        user(machine("pipeline"), text.pipeline, 9);
        agent(text.pipelineReply);
      } else {
        user(machine("seat-tick"), text.wake[kind]!, 15);
        tool(`call_wake_${own}_${turn}`);
        agent(kind === 1 ? `${text.wakeReply[kind]!}\n\n${text.detail[turn % 4]!}` : text.wakeReply[kind]!);
      }
    }
  }
  return { lines, loadedFrom };
}
