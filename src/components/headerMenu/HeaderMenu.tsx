"use client";

import {
  Activity, Bell, Brain, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, CircleArrowUp, Compass, KeyRound, Languages, LifeBuoy, Link2,
  ListChecks, LogOut, MessagesSquare, Mic, QrCode, Route, Settings, ShieldCheck, SlidersHorizontal, Users, type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { AccessQrButton } from "@/components/AccessQrButton";
import { activityMobileMenuEntry } from "@/components/activity/menuEntry";
import { openExternalRelaySettings } from "@/components/externalRelay/openExternalRelaySettings";
import { KeepAwakeMenuRow, useKeepAwake } from "@/components/KeepAwakeControl";
import { LanguageToggle } from "@/components/LanguageToggle";
import { openLinkedSettings } from "@/components/links/openLinkedSettings";
import { KeyPanel, KeyStateWord, MemoryPanel, MemoryReadingProvider, MemoryStateWord } from "@/components/memory/MemoryPage";
import { MobileMenuSheet, type MobileMenuEntry } from "@/components/mobile/MobileMenuSheet";
import type { MobileNav } from "@/components/mobile/mobileNav";
import { onboardingMobileMenuEntries } from "@/components/onboarding/menuEntries";
import { openOnboarding } from "@/components/onboarding/useOnboarding";
import { startInterfaceWalk } from "@/components/onboarding/walkStop";
import { PushBell } from "@/components/PushBell";
import { selfUpdateMobileMenuEntry } from "@/components/selfUpdate/menuEntry";
import { openSelfUpdate } from "@/components/selfUpdate/openSelfUpdate";
import { SoundToggle } from "@/components/SoundToggle";
import { teamMobileMenuEntry } from "@/components/team/menuEntry";
import { useTeamView } from "@/components/team/teamClient";
import { openTelemetrySettings } from "@/components/telemetry/TelemetrySettings";
import { useLocale } from "@/lib/i18n";

import { HEADER_LAYOUTS, type HeaderItem } from "./headerMenuModel";

/* The app header's ⋯ (docs/design/header-menu.md): variant 2's row of icon
   cells for the three places opened most, and variant 3's rows under it.
   Settings is a page of the menu with a back row
   (in place it would pass the menu's 360 px), and its memory and key rows
   open a page each; Help and learning opens in place. Every entry calls the
   handler it called before the regrouping. */

type View = "rest" | "settings" | "memory" | "key";
/** The page a back row returns to. */
const PARENT: Record<Exclude<View, "rest">, View> = { settings: "rest", memory: "settings", key: "settings" };
type PhoneView = View | "help" | "rules";
const PHONE_PARENT: Record<Exclude<PhoneView, "rest">, PhoneView> = { ...PARENT, help: "rest", rules: "rest" };

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

/** The desktop panel's contents; the trigger and the dismissal stay with the rail's header. */
export function HeaderMenuPanel({ project, onClose }: { project: string | null; onClose: () => void }) {
  const { t, locale } = useLocale();
  const [view, setView] = useState<View>("rest");
  const [helpOpen, setHelpOpen] = useState(false);
  /* Passive: the app's session guard loads the team view once per page. */
  const team = useTeamView({ load: false });
  const teamMe = team?.mode === "team" ? team.me : null;
  const [push, setPush] = useState({ supported: false, enabled: false });
  const onPushStatus = useCallback((status: { supported: boolean; enabled: boolean }) => setPush(status), []);
  const panel = useRef<HTMLDivElement | null>(null);
  /* Where focus goes after a swap: the back row of a page that opened, or the row that opened the page left. */
  const focusNext = useRef<string | null>(null);
  useEffect(() => {
    if (!focusNext.current) return;
    panel.current?.querySelector<HTMLElement>(focusNext.current)?.focus();
    focusNext.current = null;
  }, [view]);
  const open = (next: View) => { focusNext.current = "[data-rail-menu-back]"; setView(next); };
  const back = () => {
    if (view === "rest") return;
    focusNext.current = `[data-rail-menu-${view}]`;
    setView(PARENT[view]);
  };
  const act = (run: () => void) => () => { onClose(); run(); };
  const pushLabel = !push.supported ? t("rail.menuNotificationsUnavailable") : push.enabled ? t("rail.menuNotificationsOn") : t("rail.menuNotificationsOff");
  const settingsItems = HEADER_LAYOUTS.desktop.rows.flatMap((row) => (row.kind === "page" ? row.items : []))
    .filter((item) => item !== "memory" || project);
  const helpItems = HEADER_LAYOUTS.desktop.rows.flatMap((row) => (row.kind === "fold" ? row.items : []));

  const settingsRow = (item: HeaderItem): ReactNode => {
    switch (item) {
      case "language":
        return (
          <div key={item} data-header-menu-language="" className={STILL}>
            <Icon icon={Languages} />
            <Title>{t("rail.menuLanguage")}: {locale === "en" ? "English" : "Українська"}</Title>
            <LanguageToggle />
          </div>
        );
      case "push":
        return (
          <div key={item} data-header-menu-push="" className={STILL}>
            <Icon icon={Bell} />
            <Title>{pushLabel}</Title>
            <PushBell onStatus={onPushStatus} />
          </div>
        );
      case "memory":
        return (
          <button key={item} type="button" data-rail-menu-memory="" className={`${ROW} py-1`} onClick={() => open("memory")}>
            <Icon icon={Brain} />
            <TwoLines title={t("headerMenu.memory")} state={<MemoryStateWord />} />
            <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
          </button>
        );
      case "key":
        return (
          <button key={item} type="button" data-rail-menu-key="" className={`${ROW} py-1`} onClick={() => open("key")}>
            <Icon icon={KeyRound} />
            <TwoLines title={t("providerKey.label")} state={<KeyStateWord />} />
            <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
          </button>
        );
      case "mapping":
        return <button key={item} type="button" data-rail-menu-agent-mapping="" className={ROW} onClick={act(() => openOnboarding("mapping"))}><Icon icon={SlidersHorizontal} /><Title>{t("headerMenu.mapping")}</Title></button>;
      case "dictation":
        return <button key={item} type="button" data-rail-menu-dictation="" className={ROW} onClick={act(() => openOnboarding("voice"))}><Icon icon={Mic} /><Title>{t("onboarding.menu.voice")}</Title></button>;
      case "linked":
        return <button key={item} type="button" data-rail-menu-linked-settings="" className={ROW} onClick={act(openLinkedSettings)}><Icon icon={Link2} /><Title>{t("links.title")}</Title></button>;
      case "relay":
        return <button key={item} type="button" data-rail-menu-external-relay="" className={ROW} onClick={act(openExternalRelaySettings)}><Icon icon={MessagesSquare} /><Title>{t("headerMenu.relay")}</Title></button>;
      case "ping":
        return <button key={item} type="button" data-rail-menu-ping="" className={ROW} onClick={act(openTelemetrySettings)}><Icon icon={ShieldCheck} /><Title>{t("headerMenu.ping")}</Title></button>;
      default:
        return null;
    }
  };

  const backRow = (title: string) => (
    <button
      type="button"
      data-rail-menu-back=""
      className={`mb-1 flex w-full min-h-[30px] items-center gap-1.5 rounded-t-[8px] border-b border-border px-2 py-1.5 text-left text-[12px] hover:bg-sunken ${FOCUS}`}
      onClick={back}
    >
      <ChevronLeft className="h-4 w-4 shrink-0 text-secondary" aria-hidden />
      <span className="shrink-0 font-semibold text-secondary">{t("headerMenu.back")}</span>
      <span aria-hidden className="shrink-0 text-muted">·</span>
      <span className="min-w-0 flex-1 truncate font-bold text-primary">{title}</span>
    </button>
  );

  return (
    <MemoryReadingProvider project={project}>
      <div ref={panel} data-header-menu="" data-header-menu-view={view}>
        {view === "settings" ? (
          <div data-header-menu-page="settings">
            {backRow(t("headerMenu.settings"))}
            {settingsItems.map(settingsRow)}
          </div>
        ) : view === "memory" ? (
          <div data-header-menu-page="memory">
            {backRow(t("headerMenu.memory"))}
            <MemoryPanel />
          </div>
        ) : view === "key" ? (
          <div data-header-menu-page="key">
            {backRow(t("providerKey.label"))}
            <KeyPanel />
          </div>
        ) : (
          <>
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
            <button type="button" data-rail-menu-settings="" className={`${ROW} ${project ? "py-1" : ""}`} onClick={() => open("settings")}>
              <Icon icon={Settings} />
              {project ? <TwoLines title={t("headerMenu.settings")} state={<MemoryStateWord short />} /> : <Title>{t("headerMenu.settings")}</Title>}
              <Count n={settingsItems.length} />
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
            {teamMe ? (
              <button type="button" data-rail-menu-sign-out="" className={`${ROW} text-secondary hover:text-primary`} onClick={act(() => void signOutMember())}>
                <Icon icon={LogOut} />
                <Title>{t("team.signOut", { name: teamMe.name })}</Title>
              </button>
            ) : null}
          </>
        )}
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
  const keepAwake = useKeepAwake();
  /* As on the desktop: a page that opens takes focus on its back row, and back returns it to the row that opened the page. */
  const [{ view, focus }, setPlace] = useState<{ view: PhoneView; focus: string | null }>({ view: "rest", focus: null });
  useEffect(() => {
    if (focus) document.querySelector<HTMLElement>(`[data-mobile2-sheet='menu'] [data-mobile2-menu-row='${focus}']`)?.focus();
  }, [view, focus]);
  const go = (next: Exclude<PhoneView, "rest">) => setPlace({ view: next, focus: "back" });
  const back = () => { if (view !== "rest") setPlace({ view: PHONE_PARENT[view], focus: view }); };
  const close = onClose;
  /* The rows the phone has always had for these entries, with their handlers, icons and test ids. */
  const [guide, walk, mapping, dictation] = onboardingMobileMenuEntries(t, close);
  const activity = activityMobileMenuEntry(t, nav);
  const team = teamMobileMenuEntry(t, nav);
  const update = selfUpdateMobileMenuEntry(t, close);
  const settingsItems = HEADER_LAYOUTS.phone.rows.flatMap((row) => (row.kind === "page" && row.id === "settings" ? row.items : []))
    .filter((item) => (item !== "memory" || project) && (item !== "awake" || keepAwake));
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

  const settingsEntry = (item: HeaderItem): MobileMenuEntry | null => {
    switch (item) {
      case "sound":
        return {
          kind: "custom",
          key: "sound",
          node: (
            <div className="flex min-h-11 items-center gap-2 px-4">
              <span className="min-w-0 flex-1 text-body font-semibold text-primary">{t("mobile2.menu.sound")}</span>
              <SoundToggle />
            </div>
          ),
        };
      case "awake":
        /* «Keep screen awake» (issue #712) reads the Viewer-level controller that outlives this sheet. */
        return { kind: "custom", key: "awake", node: <div className="px-2.5"><KeepAwakeMenuRow /></div> };
      case "memory":
        return row("memory", Brain, t("headerMenu.memory"), () => go("memory"), <><MemoryStateWord size="sheet" />{chevron}</>);
      case "key":
        return row("key", KeyRound, t("providerKey.label"), () => go("key"), <><KeyStateWord size="sheet" />{chevron}</>);
      case "mapping":
        return mapping?.kind === "row" ? { ...mapping, label: t("headerMenu.mapping") } : null;
      case "dictation":
        return dictation ?? null;
      case "linked":
        return row("linked-settings", Link2, t("links.title"), () => { close(); openLinkedSettings(); });
      case "relay":
        return row("external-relay", MessagesSquare, t("headerMenu.relay"), () => { close(); openExternalRelaySettings(); });
      case "ping":
        return row("ping", ShieldCheck, t("headerMenu.ping"), () => { close(); openTelemetrySettings(); });
      default:
        return null;
    }
  };

  let entries: MobileMenuEntry[];
  if (view === "settings") entries = [backRow(t("headerMenu.settings")), ...settingsItems.flatMap((item) => settingsEntry(item) ?? [])];
  else if (view === "memory") entries = [backRow(t("headerMenu.memory")), { kind: "custom", key: "memory-page", node: <MemoryPanel size="sheet" /> }];
  else if (view === "key") entries = [backRow(t("providerKey.label")), { kind: "custom", key: "key-page", node: <KeyPanel size="sheet" /> }];
  else if (view === "help") entries = [backRow(t("headerMenu.help")), ...helpItems];
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
      row("settings", Settings, t("headerMenu.settings"), () => go("settings"), <>{project ? <MemoryStateWord short size="sheet" /> : null}<span className="tabular-nums">{settingsItems.length}</span>{chevron}</>),
      row("help", LifeBuoy, t("headerMenu.help"), () => go("help"), <><span className="tabular-nums">{helpItems.length}</span>{chevron}</>),
      ...(ruleCount ? [row("rules", ListChecks, t("headerMenu.rules"), () => go("rules"), <><span className="tabular-nums">{ruleCount}</span>{chevron}</>)] : []),
    ];
  }
  return <MobileMenuSheet title={title} entries={entries} onClose={onClose} />;
}
