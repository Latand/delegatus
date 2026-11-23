"use client";

import {
  Activity, AudioLines, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, CircleArrowUp, Compass, LifeBuoy,
  ListChecks, LogOut, Power, QrCode, Route, Settings, Users, type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { AccessQrButton } from "@/components/AccessQrButton";
import { activityMobileMenuEntry } from "@/components/activity/menuEntry";
import { MemoryReadingProvider, MemoryStateWord } from "@/components/memory/MemoryPage";
import { MobileMenuSheet, type MobileMenuEntry } from "@/components/mobile/MobileMenuSheet";
import type { MobileNav } from "@/components/mobile/mobileNav";
import { onboardingMobileMenuEntries } from "@/components/onboarding/menuEntries";
import { openOnboarding } from "@/components/onboarding/useOnboarding";
import { startInterfaceWalk } from "@/components/onboarding/walkStop";
import { selfUpdateMobileMenuEntry } from "@/components/selfUpdate/menuEntry";
import { openSelfUpdate } from "@/components/selfUpdate/openSelfUpdate";
import { openSettings } from "@/components/settings/openSettings";
import { teamMobileMenuEntry } from "@/components/team/menuEntry";
import { useTeamView } from "@/components/team/teamClient";
import { showPhoneVoice, usePhoneVoice } from "@/components/voiceCompanion/phoneVoiceStore";
import { useLocale, type MessageKey } from "@/lib/i18n";

import { HEADER_LAYOUTS, settingsSectionsOf } from "./headerMenuModel";

/* The app header's ⋯ (docs/design/header-menu.md): variant 2's row of icon
   cells for the three places opened most, and variant 3's rows under it.
   Settings opens the one Settings window (docs/design/settings-redo/build-brief.md),
   whose sections hold every setting; Help and learning opens in place.
   Every entry calls the handler it called before the regrouping. */

type PhoneView = "rest" | "help" | "rules";

/** Ends this browser's member session and goes to the sign-in page. */
async function signOutMember(): Promise<void> {
  try {
    await fetch("/api/team/session/sign-out", { method: "POST" });
  } finally {
    window.location.replace("/sign-in");
  }
}

const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
const ROW = `flex w-full min-h-[30px] items-center gap-2 rounded-[8px] px-2 py-1.5 text-left text-[12px] font-semibold text-primary hover:bg-sunken ${FOCUS}`;
const STILL = "flex w-full min-h-[30px] items-center gap-2 rounded-[8px] px-2 py-1 text-[12px] font-semibold text-primary";
const CELL = `flex min-h-[60px] min-w-0 flex-col items-center justify-center gap-1 rounded-[8px] px-0.5 py-2 text-center text-[11.5px] font-semibold leading-tight text-primary hover:bg-sunken ${FOCUS}`;
/* A row inside a group opened in place hangs from one rule at its left. */
const WITHIN = "shadow-[inset_2px_0_0_var(--border-default)]";

const Icon = ({ icon: Glyph }: { icon: LucideIcon }) => <Glyph className="h-4 w-4 shrink-0 text-secondary" aria-hidden />;
const Count = ({ n }: { n: number }) => <span className="mr-0.5 shrink-0 text-[12px] font-medium tabular-nums text-muted">{n}</span>;
const Title = ({ children }: { children: ReactNode }) => <span className="min-w-0 flex-1 truncate">{children}</span>;
const TwoLines = ({ title, state }: { title: string; state: ReactNode }) => (
  <span className="flex min-w-0 flex-1 flex-col gap-px">
    <span className="truncate leading-4">{title}</span>
    {state}
  </span>
);

type StopPhase = { phase: "confirm" | "sending" | "started" } | { phase: "refused"; message: MessageKey };

const STOP_REFUSALS: Record<string, MessageKey> = {
  "no-launcher": "headerMenu.stopAll.noLauncher",
  unavailable: "headerMenu.stopAll.unavailable",
  owner_required: "headerMenu.stopAll.ownerOnly",
};

/** «Stop Delegatus» (`delegatus stop --all`, src/lib/stopAll.ts) is the owner's alone on a team install. */
export function useMayStop(): boolean {
  const team = useTeamView({ load: false });
  return team?.mode !== "team" || team.me?.role === "owner";
}

/** The question and, once asked, the answer, which stays in place: the page
    that asked stops answering soon after. */
export function StopAllQuestion({ phone = false, onCancel, onPhase }: { phone?: boolean; onCancel: () => void; onPhase?: (phase: StopPhase["phase"]) => void }) {
  const { t, locale } = useLocale();
  const [state, setState] = useState<StopPhase>({ phase: "confirm" });
  useEffect(() => { onPhase?.(state.phase); }, [state.phase, onPhase]);
  const stop = async () => {
    setState({ phase: "sending" });
    try {
      const response = await fetch("/api/stop-all", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true, lang: locale }) });
      if (response.status === 202) { setState({ phase: "started" }); return; }
      const body = await response.json().catch(() => ({})) as { code?: unknown };
      setState({ phase: "refused", message: (typeof body.code === "string" && STOP_REFUSALS[body.code]) || "headerMenu.stopAll.failed" });
    } catch {
      setState({ phase: "refused", message: "headerMenu.stopAll.failed" });
    }
  };
  const asking = state.phase === "confirm" || state.phase === "sending";
  const text = asking ? t("headerMenu.stopAll.confirm") : state.phase === "started" ? t("headerMenu.stopAll.started") : state.phase === "refused" ? t(state.message) : "";
  const button = phone
    ? "inline-flex min-h-11 items-center justify-center rounded-control px-3 text-body font-semibold disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    : `inline-flex min-h-[28px] items-center rounded-[6px] px-2 py-0.5 text-[12px] font-semibold disabled:opacity-60 ${FOCUS}`;
  return (
    <div data-stop-all-phase={state.phase} className={phone ? "px-4 py-3" : `${WITHIN} ml-2 px-2 pb-1.5`}>
      <p data-stop-all-text="" role={asking ? undefined : "status"} className={`${phone ? "text-body" : "text-[12px]"} font-normal leading-snug text-secondary`}>{text}</p>
      {asking ? (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <button type="button" data-stop-all-go="" disabled={state.phase === "sending"} className={`${button} bg-danger text-white hover:opacity-90`} onClick={() => void stop()}>
            {state.phase === "sending" ? t("headerMenu.stopAll.stopping") : t("headerMenu.stopAll.go")}
          </button>
          <button type="button" data-stop-all-cancel="" disabled={state.phase === "sending"} className={`${button} text-primary hover:bg-sunken`} onClick={onCancel}>
            {t("headerMenu.stopAll.cancel")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** The desktop row: the question opens under it. A stop once asked keeps its answer there. */
function StopAllRow() {
  const { t } = useLocale();
  const mayStop = useMayStop();
  const [open, setOpen] = useState(false);
  const [held, setHeld] = useState(false);
  const onPhase = useCallback((phase: StopPhase["phase"]) => setHeld(phase === "sending" || phase === "started"), []);
  if (!mayStop) return null;
  return (
    <div data-header-menu-stop-all="">
      <button type="button" data-rail-menu-stop-all="" aria-expanded={open} className={ROW} onClick={() => { if (!held) setOpen((was) => !was); }}>
        <Icon icon={Power} />
        <Title>{t("headerMenu.stopAll")}</Title>
      </button>
      {open ? <StopAllQuestion onCancel={() => setOpen(false)} onPhase={onPhase} /> : null}
    </div>
  );
}

/** The desktop panel's contents; the trigger and the dismissal stay with the rail's header. */
export function HeaderMenuPanel({ project, onClose }: { project: string | null; onClose: () => void }) {
  const { t } = useLocale();
  const [helpOpen, setHelpOpen] = useState(false);
  /* Passive: the app's session guard loads the team view once per page. */
  const team = useTeamView({ load: false });
  const teamMe = team?.mode === "team" ? team.me : null;
  const act = (run: () => void) => () => { onClose(); run(); };
  const sectionCount = settingsSectionsOf(HEADER_LAYOUTS.desktop).length;
  const helpItems = HEADER_LAYOUTS.desktop.rows.flatMap((row) => (row.kind === "fold" ? row.items : []));

  return (
    <MemoryReadingProvider project={project}>
      <div data-header-menu="" data-header-menu-view="rest">
        <div role="group" aria-label={t("headerMenu.cells")} data-header-menu-cells="" className="grid grid-cols-3 gap-0.5 pb-1">
          {/* Your time and your agents' time, per day and per project. */}
          <a href="/activity" data-rail-menu-activity="" title={t("activity.menu")} className={CELL}><Activity className="h-4 w-4 shrink-0" aria-hidden /><span className="max-w-full truncate">{t("headerMenu.cell.activity")}</span></a>
          {/* Members, who did what, sessions and invitations (sign-in-and-team §6.9). */}
          <a href="/team" data-rail-menu-team="" title={t("team.menu")} className={CELL}><Users className="h-4 w-4 shrink-0" aria-hidden /><span className="max-w-full truncate">{t("headerMenu.cell.team")}</span></a>
          {/* #2007: how this install updates itself. */}
          <button type="button" data-rail-menu-update="" title={t("selfUpdate.menu")} className={CELL} onClick={act(openSelfUpdate)}><CircleArrowUp className="h-4 w-4 shrink-0" aria-hidden /><span className="max-w-full truncate">{t("headerMenu.cell.update")}</span></button>
        </div>
        <div data-header-menu-qr="" className={STILL}>
          <Icon icon={QrCode} />
          <Title>{t("headerMenu.openOnPhone")}</Title>
          <AccessQrButton />
        </div>
        <button type="button" data-rail-menu-settings="" className={`${ROW} ${project ? "py-1" : ""}`} onClick={act(() => openSettings())}>
          <Icon icon={Settings} />
          {project ? <TwoLines title={t("headerMenu.settings")} state={<MemoryStateWord short />} /> : <Title>{t("headerMenu.settings")}</Title>}
          <Count n={sectionCount} />
          <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        </button>
        {/* #1876: the setup guide; #2166: the interface walk. */}
        <button type="button" data-rail-menu-help="" aria-expanded={helpOpen} className={ROW} onClick={() => setHelpOpen((was) => !was)}>
          <Icon icon={LifeBuoy} />
          <Title>{t("headerMenu.help")}</Title>
          <Count n={helpItems.length} />
          {helpOpen ? <ChevronUp className="h-4 w-4 shrink-0 text-muted" aria-hidden /> : <ChevronDown className="h-4 w-4 shrink-0 text-muted" aria-hidden />}
        </button>
        {helpOpen ? (
          <div role="group" aria-label={t("headerMenu.help")}>
            <button type="button" data-rail-menu-setup-guide="" className={`${ROW} ${WITHIN}`} onClick={act(() => openOnboarding("guide"))}><Icon icon={Compass} /><Title>{t("onboarding.menu.guide")}</Title></button>
            <button type="button" data-rail-menu-interface-walk="" className={`${ROW} ${WITHIN}`} onClick={act(startInterfaceWalk)}><Icon icon={Route} /><Title>{t("onboarding.menu.walk")}</Title></button>
          </div>
        ) : null}
        <StopAllRow />
        {teamMe ? (
          <button type="button" data-rail-menu-sign-out="" className={`${ROW} text-secondary hover:text-primary`} onClick={act(() => void signOutMember())}>
            <Icon icon={LogOut} />
            <Title>{t("team.signOut", { name: teamMe.name })}</Title>
          </button>
        ) : null}
      </div>
    </MemoryReadingProvider>
  );
}

/* ---- The phone ------------------------------------------------------------ */

const SHEET_ROW = "flex min-h-11 w-full items-center gap-3 px-4 text-left text-body font-semibold text-primary active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40";
const SHEET_CELL = "flex min-h-[60px] min-w-0 flex-col items-center justify-center gap-1.5 rounded-[8px] px-1 py-2 text-center text-label font-semibold text-primary active:bg-sunken disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40";
const glyph = (Glyph: LucideIcon) => <Glyph className="h-[18px] w-[18px]" aria-hidden />;

/**
 * The phone's board menu with the header's entries in it, laid out as the
 * design draws it: the create actions as cells, the board's places as rows,
 * then the header's three cells, Settings and Help and learning (both pages
 * here), and last the project's rules as a page of their own. The language, the QR and the bell
 * stay the three buttons of the project drawer's header, and signing out stays
 * on the Team page.
 */
export function HeaderMenuSheet(props: {
  title: string;
  /** The project memory's switch belongs to; none on the overview. */
  project: string | null;
  nav: MobileNav;
  /** Drawn as a row of cells, above everything. */
  create?: MobileMenuEntry[];
  board: MobileMenuEntry[];
  /** The project's own switches and Archive, behind one row that opens a page. */
  rules?: MobileMenuEntry[];
  onClose: () => void;
}) {
  return (
    <MemoryReadingProvider project={props.project}>
      <PhoneMenu {...props} />
    </MemoryReadingProvider>
  );
}

function PhoneMenu({ title, project, nav, create = [], board, rules = [], onClose }: Parameters<typeof HeaderMenuSheet>[0]) {
  const { t } = useLocale();
  const voice = usePhoneVoice();
  /* As on the desktop: a page that opens takes focus on its back row, and back returns it to the row that opened the page. */
  const [{ view, focus }, setPlace] = useState<{ view: PhoneView; focus: string | null }>({ view: "rest", focus: null });
  useEffect(() => {
    if (!focus) return;
    document.querySelector<HTMLElement>(`[data-mobile2-sheet='menu'] [data-mobile2-menu-row='${focus}']`)?.focus();
  }, [view, focus]);
  const go = (next: Exclude<PhoneView, "rest">) => setPlace({ view: next, focus: "back" });
  const back = () => { if (view !== "rest") setPlace({ view: "rest", focus: view }); };
  const close = onClose;
  /* The rows the phone has always had for these entries, with their handlers, icons and test ids. */
  const [guide, walk] = onboardingMobileMenuEntries(t, close);
  const activity = activityMobileMenuEntry(t, nav);
  const team = teamMobileMenuEntry(t, nav);
  const update = selfUpdateMobileMenuEntry(t, close);
  const sectionCount = settingsSectionsOf(HEADER_LAYOUTS.phone).length;
  const helpItems = [guide, walk].filter((entry): entry is Extract<MobileMenuEntry, { kind: "row" }> => entry?.kind === "row");

  const backRow = (label: string): MobileMenuEntry => ({
    kind: "custom",
    key: "back",
    node: (
      <button type="button" role="menuitem" data-mobile2-menu-row="back" className={`${SHEET_ROW} border-b border-border`} onClick={back}>
        <ChevronLeft className="h-[18px] w-[18px] shrink-0 text-secondary" aria-hidden />
        <span className="shrink-0 text-secondary">{t("headerMenu.back")}</span>
        <span aria-hidden className="shrink-0 font-normal text-muted">·</span>
        <span className="min-w-0 flex-1 truncate font-bold">{label}</span>
      </button>
    ),
  });
  const chevron = <ChevronRight className="h-4 w-4 shrink-0" aria-hidden />;
  const row = (key: string, icon: LucideIcon, label: string, onSelect: () => void, trailing?: ReactNode): MobileMenuEntry => ({ kind: "row", key, icon: glyph(icon), label, onSelect, trailing });

  let entries: MobileMenuEntry[];
  if (view === "help") entries = [backRow(t("headerMenu.help")), ...helpItems];
  else if (view === "rules") entries = [backRow(t("headerMenu.rules")), ...rules];
  else {
    /* A row of the sheet drawn as a cell: its icon over a short caption, its full label for a screen reader. */
    const cell = (entry: MobileMenuEntry | undefined, caption?: string) => entry?.kind === "row" ? (
      <button key={entry.key} type="button" role="menuitem" data-mobile2-menu-row={entry.key} data-testid={entry.testId} aria-label={entry.label} disabled={entry.disabled} className={SHEET_CELL} onClick={entry.onSelect}>
        <span aria-hidden className="flex shrink-0 items-center justify-center text-secondary">{entry.icon}</span>
        <span className="max-w-full truncate">{caption ?? entry.label}</span>
      </button>
    ) : null;
    const ruleCount = rules.filter((entry) => entry.kind !== "divider").length;
    entries = [
      ...(create.length ? [{
        kind: "custom" as const,
        key: "create-cells",
        node: <div role="group" aria-label={t("headerMenu.create")} data-board-menu-cells="" className="grid grid-cols-3 gap-1 px-3 py-1">{create.map((entry) => cell(entry))}</div>,
      }] : []),
      ...board,
      ...(board.length || create.length ? [{ kind: "divider" as const, key: "d-header" }] : []),
      {
        kind: "custom",
        key: "header-cells",
        node: (
          <div role="group" aria-label={t("headerMenu.cells")} data-header-menu-cells="" className="grid grid-cols-3 gap-1 px-3 py-1">
            {cell(activity, t("headerMenu.cell.activity"))}
            {cell(team, t("headerMenu.cell.team"))}
            {cell(update, t("headerMenu.cell.update"))}
          </div>
        ),
      },
      /* The voice head the operator hid comes back from here, only while it is hidden (docs/design/phone-voice-head-build.md). */
      ...(voice.available && voice.hidden ? [row("voice-show", AudioLines, t("voiceCompanion.show"), () => { close(); showPhoneVoice(); })] : []),
      /* The Settings window takes the sheet's place: a sheet opened from a sheet replaces it. */
      row("settings", Settings, t("headerMenu.settings"), () => openSettings(), <>{project ? <MemoryStateWord short size="sheet" /> : null}<span className="tabular-nums">{sectionCount}</span>{chevron}</>),
      row("help", LifeBuoy, t("headerMenu.help"), () => go("help"), <><span className="tabular-nums">{helpItems.length}</span>{chevron}</>),
      ...(ruleCount ? [row("rules", ListChecks, t("headerMenu.rules"), () => go("rules"), <><span className="tabular-nums">{ruleCount}</span>{chevron}</>)] : []),
    ];
  }
  return <MobileMenuSheet title={title} entries={entries} onClose={onClose} />;
}
