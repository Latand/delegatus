"use client";

import { AudioLines, Bell, Brain, ChevronLeft, ChevronRight, KeyRound, Languages, Link2, MessagesSquare, Mic, Power, Send, Settings, ShieldCheck, SlidersHorizontal, X, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { openExternalRelaySettings } from "@/components/externalRelay/openExternalRelaySettings";
import { StopAllQuestion, useMayStop } from "@/components/headerMenu/HeaderMenu";
import { HEADER_LAYOUTS, settingsSectionsOf } from "@/components/headerMenu/headerMenuModel";
import { KeepAwakeMenuRow, useKeepAwake } from "@/components/KeepAwakeControl";
import { KeysImportPage, KeysMenuPage, KeysStateWord } from "@/components/keys/KeysSection";
import { featureName, OpenAiFeaturePage, type ServiceFeature } from "@/components/keys/OpenAiServices";
import { onOpenKeys, pendingKeys, settleKeys } from "@/components/keys/openKeys";
import { LanguageToggle } from "@/components/LanguageToggle";
import { LAYER, Z } from "@/components/layers";
import { openLinkedSettings } from "@/components/links/openLinkedSettings";
import { MemoryPanel, MemoryReadingProvider, MemoryStateWord } from "@/components/memory/MemoryPage";
import { MemorySourceRow } from "@/components/memory/MemorySourceRow";
import { MobileSheet } from "@/components/mobile/MobileSheet";
import { useMobileNavStore } from "@/components/mobile/mobileNav";
import { useModalLayer } from "@/components/modalLayer";
import { openOnboarding } from "@/components/onboarding/useOnboarding";
import { WorkerLimitSettingsRow } from "@/components/orchestrator/WorkerLimitChip";
import { PushBell } from "@/components/PushBell";
import { SoundToggle } from "@/components/SoundToggle";
import { OPEN_TELEMETRY_SETTINGS_EVENT } from "@/components/telemetry/TelemetrySettings";
import { OPEN_VOICE_COMPANION_SETTINGS_EVENT } from "@/components/voiceCompanion/VoiceCompanionSetting";
import { isPhoneViewport, useIsMobile } from "@/hooks/useIsMobile";
import { useLocale, type MessageKey } from "@/lib/i18n";
import type { KeyId } from "@/lib/keys/shared";

import { onOpenSettings, setSettingsWindowShown, type SettingsSection, type SettingsSub } from "./openSettings";
import { PrivacySection } from "./PrivacySection";
import { FOCUS, Rows, SettingsDensity, useWholeRows } from "./settingsRows";
import { TelegramSection } from "./TelegramSection";
import { VoiceSection } from "./VoiceSection";

/*
 * The one Settings window (variant 3, docs/design/settings-redo/build-brief.md):
 * on the desktop a dialog of a fixed height with the sections on the left and
 * the open section on the right; on the phone one full-height sheet whose back
 * row returns to the section list. A row's page opens in the section's place,
 * under a back row naming the section, so nothing stacks over anything and the
 * header, the × and the list never move.
 */

const SECTION: Record<SettingsSection, { icon: LucideIcon; title: MessageKey; desktop: string; phone: string }> = {
  general: { icon: Settings, title: "settings.section.general", desktop: "data-rail-menu-general", phone: "general" },
  memory: { icon: Brain, title: "headerMenu.memory", desktop: "data-rail-menu-memory", phone: "memory" },
  keys: { icon: KeyRound, title: "keys.title", desktop: "data-rail-menu-keys", phone: "keys" },
  roles: { icon: SlidersHorizontal, title: "settings.section.roles", desktop: "data-rail-menu-roles", phone: "roles" },
  dictation: { icon: Mic, title: "onboarding.menu.voice", desktop: "data-rail-menu-dictation", phone: "dictation" },
  privacy: { icon: ShieldCheck, title: "settings.section.privacy", desktop: "data-rail-menu-ping", phone: "ping" },
  telegram: { icon: Send, title: "settings.section.telegram", desktop: "data-rail-menu-telegram", phone: "telegram" },
  voice: { icon: AudioLines, title: "voiceCompanion.settings.label", desktop: "data-rail-menu-voice-companion", phone: "voice-companion" },
  linked: { icon: Link2, title: "links.title", desktop: "data-rail-menu-linked-settings", phone: "linked-settings" },
  relay: { icon: MessagesSquare, title: "headerMenu.relay", desktop: "data-rail-menu-external-relay", phone: "external-relay" },
};

/* These sections are windows of their own: their row closes this one and calls the opener they always had. */
const HAND_OFF: Partial<Record<SettingsSection, () => void>> = {
  dictation: () => openOnboarding("voice"),
  linked: openLinkedSettings,
  relay: openExternalRelaySettings,
};

const stateWord = (section: SettingsSection, phone: boolean): ReactNode => {
  if (section === "memory") return <MemoryStateWord size={phone ? "sheet" : "menu"} />;
  if (section === "keys") return <KeysStateWord size={phone ? "sheet" : "menu"} />;
  return null;
};

interface KeysFocus { key: KeyId | null; seq: number }

function GeneralSection({ phone, sub, go, back }: { phone: boolean; sub: SettingsSub | null; go: (sub: SettingsSub) => void; back: () => void }) {
  const { t, locale } = useLocale();
  const keepAwake = useKeepAwake();
  const mayStop = useMayStop();
  const [push, setPush] = useState({ supported: false, enabled: false });
  const onPushStatus = useCallback((status: { supported: boolean; enabled: boolean }) => setPush(status), []);
  const pushLabel = !push.supported ? t("rail.menuNotificationsUnavailable") : push.enabled ? t("rail.menuNotificationsOn") : t("rail.menuNotificationsOff");
  if (sub?.id === "stop") return <Rows data-header-menu-page="stop"><div data-settings-unit=""><StopAllQuestion phone onCancel={back} /></div></Rows>;
  const still = `flex items-center gap-3 ${phone ? "min-h-11 px-4 py-1.5" : "min-h-10 px-5 py-1.5"} text-body font-semibold text-primary`;
  const glyph = "h-4 w-4 shrink-0 text-secondary";
  return (
    <Rows data-header-menu-page="settings">
      {phone ? (
        <>
          <div data-settings-unit="" className={still}><span className="min-w-0 flex-1">{t("mobile2.menu.sound")}</span><SoundToggle /></div>
          {keepAwake ? <div data-settings-unit="" className="px-2.5"><KeepAwakeMenuRow /></div> : null}
          {mayStop ? (
            <button type="button" data-settings-unit="" data-settings-sub="stop:" data-mobile2-menu-row="stop-all" onClick={() => go({ id: "stop", title: t("headerMenu.stopAll") })} className={`${still} w-full text-left active:bg-sunken ${FOCUS}`}>
              <Power className={glyph} aria-hidden />
              <span className="min-w-0 flex-1 truncate">{t("headerMenu.stopAll")}</span>
              <ChevronRight data-settings-chevron="" className="h-4 w-4 shrink-0 text-muted" aria-hidden />
            </button>
          ) : null}
        </>
      ) : (
        <>
          <div data-settings-unit="" data-header-menu-language="" className={still}>
            <Languages className={glyph} aria-hidden />
            <span className="min-w-0 flex-1 truncate">{t("rail.menuLanguage")}: {locale === "en" ? "English" : "Українська"}</span>
            <LanguageToggle />
          </div>
          <div data-settings-unit="" data-header-menu-push="" className={still}>
            <Bell className={glyph} aria-hidden />
            <span className="min-w-0 flex-1 truncate">{pushLabel}</span>
            <PushBell onStatus={onPushStatus} />
          </div>
        </>
      )}
    </Rows>
  );
}

function RolesSection({ phone, project, close }: { phone: boolean; project: string | null; close: () => void }) {
  const { t } = useLocale();
  return (
    <Rows data-header-menu-page="roles">
      <button
        type="button"
        data-settings-unit=""
        {...(phone ? { "data-mobile2-menu-row": "agent-mapping", "data-testid": "menu-agent-mapping" } : { "data-rail-menu-agent-mapping": "" })}
        onClick={() => { close(); openOnboarding("mapping"); }}
        className={`flex w-full items-center gap-3 text-left text-body font-semibold text-primary hover:bg-sunken active:bg-sunken ${phone ? "min-h-11 px-4" : "min-h-10 px-5"} ${FOCUS}`}
      >
        <SlidersHorizontal className="h-4 w-4 shrink-0 text-secondary" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{t("headerMenu.mapping")}</span>
      </button>
      <div data-settings-unit="" className={phone ? "" : "px-3"}><WorkerLimitSettingsRow project={project} phone={phone} /></div>
    </Rows>
  );
}

function SectionBody({ section, sub, go, back, phone, project, close, keysFocus }: {
  section: SettingsSection; sub: SettingsSub | null; go: (sub: SettingsSub) => void; back: () => void; phone: boolean; project: string | null; close: () => void; keysFocus: KeysFocus;
}) {
  const { t } = useLocale();
  const size = phone ? "sheet" as const : "menu" as const;
  const inset = phone ? "" : "px-3 pt-2";
  switch (section) {
    case "general": return <GeneralSection phone={phone} sub={sub} go={go} back={back} />;
    case "memory": return (
      <div data-header-menu-page="memory" className={inset}>
        {project ? <MemoryPanel size={size} /> : null}
        <div data-settings-unit=""><MemorySourceRow phone={phone} /></div>
      </div>
    );
    case "keys":
      if (sub?.id === "import") return <div data-header-menu-page="keys-import" className={inset}><KeysImportPage size={size} /></div>;
      if (sub?.id === "service") return <div data-header-menu-page="openai-service" className={inset}><OpenAiFeaturePage feature={sub.arg as ServiceFeature} size={size} /></div>;
      return (
        <div data-header-menu-page="keys" className={inset}>
          <KeysMenuPage
            size={size}
            focusKey={keysFocus.key}
            focusSeq={keysFocus.seq}
            onImport={() => go({ id: "import", title: t("keys.import") })}
            onOpenService={(feature) => go({ id: "service", arg: feature, title: featureName(t, feature) })}
          />
        </div>
      );
    case "roles": return <RolesSection phone={phone} project={project} close={close} />;
    case "privacy": return <PrivacySection />;
    case "telegram": return <TelegramSection sub={sub} go={go} back={back} />;
    case "voice": return <VoiceSection sub={sub} go={go} />;
    default: return null;
  }
}

/** Fits the section's rows to whole lines inside its scroller; a new page starts at its top. */
function Fitted({ page, children }: { page: string; children: ReactNode }) {
  const content = useRef<HTMLDivElement | null>(null);
  useWholeRows(content);
  useEffect(() => {
    const scroller = content.current?.closest("[data-settings-scroller], [data-mobile2-sheet-body]");
    if (scroller) scroller.scrollTop = 0;
  }, [page]);
  return <div ref={content} className="flex min-h-full flex-1 flex-col">{children}</div>;
}

function DesktopWindow({ sections, section, sub, go, back, choose, close, project, keysFocus }: {
  sections: SettingsSection[]; section: SettingsSection; sub: SettingsSub | null; go: (sub: SettingsSub) => void; back: () => void; choose: (section: SettingsSection) => void; close: () => void; project: string | null; keysFocus: KeysFocus;
}) {
  const { t } = useLocale();
  const ref = useRef<HTMLDivElement | null>(null);
  useModalLayer({ containerRef: ref, onClose: close });
  /* The row that opened the window left with the menu: the keyboard comes back to ⋯. */
  useEffect(() => () => {
    if (document.activeElement === document.body || !document.activeElement) document.querySelector<HTMLElement>("[data-rail-menu]")?.focus();
  }, []);
  const title = t(SECTION[section].title);
  const word = stateWord(section, false);
  return (
    <div className={`fixed inset-0 ${Z.modal} flex items-start justify-center bg-black/40 px-4 pt-8`} role="presentation" data-settings-backdrop="" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={t("headerMenu.settings")} tabIndex={-1} data-settings-window="" className="flex h-[calc(100dvh-68px)] w-full max-w-[820px] flex-col rounded-surface bg-card text-primary shadow-2 outline-none">
        <div className="flex min-h-12 shrink-0 items-center gap-2 border-b border-border pl-5 pr-2">
          <h2 className="min-w-0 flex-1 truncate text-title font-semibold text-primary">{t("headerMenu.settings")}</h2>
          <button type="button" data-settings-close="" aria-label={t("telemetry.close")} onClick={close} className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-control text-secondary hover:bg-sunken ${FOCUS}`}>
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
        <div className="flex min-h-0 flex-1">
          <nav aria-label={t("settings.sections")} data-settings-nav="" className="no-scrollbar flex w-[208px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border p-2">
            {sections.map((id) => {
              const { icon: Glyph, title: name, desktop } = SECTION[id];
              const current = id === section;
              return (
                <button key={id} type="button" {...{ [desktop]: "" }} data-settings-section-row={id} aria-current={current ? "page" : undefined} onClick={() => choose(id)}
                  className={`flex min-h-8 w-full items-center gap-2 rounded-control px-2 text-left text-ui font-semibold text-primary hover:bg-sunken ${FOCUS} ${current ? "bg-accent-soft" : ""}`}>
                  <Glyph className={`h-4 w-4 shrink-0 ${current ? "text-accent" : "text-secondary"}`} aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{t(name)}</span>
                </button>
              );
            })}
          </nav>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {sub ? (
              <button type="button" data-settings-back="" onClick={back} className={`flex min-h-[41px] w-full shrink-0 items-center gap-1.5 border-b border-border pl-3 pr-5 text-left text-body hover:bg-sunken ${FOCUS}`}>
                <ChevronLeft className="h-4 w-4 shrink-0 text-secondary" aria-hidden />
                <span className="shrink-0 font-semibold text-secondary">{title}</span>
                <span aria-hidden className="shrink-0 text-muted">·</span>
                <span className="min-w-0 flex-1 truncate font-semibold text-primary" data-settings-title="">{sub.title}</span>
              </button>
            ) : (
              <div className="flex min-h-[41px] shrink-0 items-center gap-3 border-b border-border px-5">
                <h3 className="min-w-0 flex-1 truncate text-body font-semibold text-primary" data-settings-title="">{title}</h3>
                {word}
              </div>
            )}
            <div data-settings-scroller="" className="no-scrollbar min-h-0 flex-1 overflow-y-auto">
              <div className="flex min-h-full flex-col">
                <Fitted page={`${section}/${sub?.id ?? ""}/${sub?.arg ?? ""}`}>
                  <SectionBody key={section} section={section} sub={sub} go={go} back={back} phone={false} project={project} close={close} keysFocus={keysFocus} />
                </Fitted>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PhoneWindow({ sections, section, sub, go, back, choose, close, project, keysFocus }: {
  sections: SettingsSection[]; section: SettingsSection | null; sub: SettingsSub | null; go: (sub: SettingsSub) => void; back: () => void; choose: (section: SettingsSection) => void; close: () => void; project: string | null; keysFocus: KeysFocus;
}) {
  const { t } = useLocale();
  const pinned = section ? (
    <button type="button" data-settings-back="" data-mobile2-menu-row="back" onClick={back} className={`flex min-h-11 w-full shrink-0 items-center gap-3 border-b border-border px-4 text-left text-body font-semibold text-primary active:bg-sunken ${FOCUS}`}>
      <ChevronLeft className="h-[18px] w-[18px] shrink-0 text-secondary" aria-hidden />
      <span className="shrink-0 text-secondary">{sub ? t(SECTION[section].title) : t("settings.sections")}</span>
      <span aria-hidden className="shrink-0 font-normal text-muted">·</span>
      <span className="min-w-0 flex-1 truncate font-bold" data-settings-title="">{sub ? sub.title : t(SECTION[section].title)}</span>
    </button>
  ) : undefined;
  return (
    /* A resting voice head stands one step over a sheet: this sheet fills the screen with rows, so it stands over the
       head instead. A live call's head keeps its place above every layer. */
    <div className="relative" style={{ zIndex: LAYER.sheet + 2 }}>
    <MobileSheet name="settings" title={t("headerMenu.settings")} onClose={close} full pinned={pinned}>
      <div className="flex min-h-full flex-col">
        <Fitted page={`${section ?? ""}/${sub?.id ?? ""}/${sub?.arg ?? ""}`}>
          {section ? <SectionBody key={section} section={section} sub={sub} go={go} back={back} phone project={project} close={close} keysFocus={keysFocus} /> : (
            <Rows data-header-menu-page="settings-sections">
              {sections.map((id) => {
                const { icon: Glyph, title: name, phone } = SECTION[id];
                return (
                  <button key={id} type="button" data-settings-unit="" data-settings-section-row={id} data-mobile2-menu-row={phone} data-testid={`menu-${phone}`} onClick={() => choose(id)} className={`flex min-h-11 w-full items-center gap-3 px-4 text-left text-body font-semibold text-primary active:bg-sunken ${FOCUS}`}>
                    <Glyph className="h-[18px] w-[18px] shrink-0 text-secondary" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{t(name)}</span>
                    {stateWord(id, true)}
                    {HAND_OFF[id] ? null : <ChevronRight data-settings-chevron="" className="h-4 w-4 shrink-0 text-muted" aria-hidden />}
                  </button>
                );
              })}
            </Rows>
          )}
        </Fitted>
      </div>
    </MobileSheet>
    </div>
  );
}

/** Always mounted by the Viewer: it reads nothing and polls nothing until it opens. */
export function SettingsWindowHost({ project }: { project: string | null }) {
  const phone = useIsMobile();
  const nav = useMobileNavStore();
  const phoneSheet = useSyncExternalStore(nav.subscribe, () => nav.getState().sheet, () => null);
  const [desktopOpen, setDesktopOpen] = useState(false);
  const [section, setSection] = useState<SettingsSection | null>(null);
  const [sub, setSub] = useState<SettingsSub | null>(null);
  const [keysFocus, setKeysFocus] = useState<KeysFocus>(() => ({ key: pendingKeys()?.key ?? null, seq: 0 }));
  const open = phone ? phoneSheet === "settings" : desktopOpen;
  /* Where focus goes after a page changes: the back row of a page that opened, the row that opened a page left. */
  const focusNext = useRef<string | null>(null);

  const show = useCallback((nextSection: SettingsSection | null, nextSub: SettingsSub | null) => {
    setSection(nextSection);
    setSub(nextSub);
    if (isPhoneViewport()) nav.openSheet("settings");
    else setDesktopOpen(true);
  }, [nav]);
  const close = useCallback(() => {
    setDesktopOpen(false);
    nav.closeSheet();
  }, [nav]);
  useEffect(() => {
    const stops = [
      onOpenSettings(({ section: next, sub: page }) => show(next, page ?? null)),
      onOpenKeys(({ key }) => { settleKeys(); setKeysFocus((was) => ({ key, seq: was.seq + 1 })); show("keys", null); }),
    ];
    const privacy = () => show("privacy", null);
    const voice = () => show("voice", null);
    window.addEventListener(OPEN_TELEMETRY_SETTINGS_EVENT, privacy);
    window.addEventListener(OPEN_VOICE_COMPANION_SETTINGS_EVENT, voice);
    /* A request made just before this host mounted. */
    let disposed = false;
    queueMicrotask(() => { if (!disposed && pendingKeys()) { settleKeys(); show("keys", null); } });
    return () => {
      disposed = true;
      for (const stop of stops) stop();
      window.removeEventListener(OPEN_TELEMETRY_SETTINGS_EVENT, privacy);
      window.removeEventListener(OPEN_VOICE_COMPANION_SETTINGS_EVENT, voice);
    };
  }, [show]);
  useEffect(() => { setSettingsWindowShown(open); return () => setSettingsWindowShown(false); }, [open]);
  const go = useCallback((next: SettingsSub) => { focusNext.current = "[data-settings-back]"; setKeysFocus((was) => ({ key: null, seq: was.seq })); setSub(next); }, []);
  const back = useCallback(() => {
    if (sub) {
      focusNext.current = sub.id === "import" ? "[data-settings-back]" : sub.id === "service" ? `[data-openai-service="${sub.arg}"]` : `[data-settings-sub="${sub.id}:${sub.arg ?? ""}"]`;
      setSub(null);
      return;
    }
    if (!phone) return;
    if (section) focusNext.current = `[data-settings-section-row="${section}"]`;
    setSection(null);
  }, [sub, section, phone]);
  const choose = useCallback((next: SettingsSection) => {
    const handOff = HAND_OFF[next];
    if (handOff) { close(); handOff(); return; }
    focusNext.current = phone ? "[data-settings-back]" : null;
    setKeysFocus((was) => ({ key: null, seq: was.seq }));
    setSection(next);
    setSub(null);
  }, [close, phone]);
  useEffect(() => {
    if (!open || !focusNext.current) return;
    const selector = focusNext.current;
    focusNext.current = null;
    document.querySelector<HTMLElement>(`[data-settings-window] ${selector}, [data-mobile2-sheet='settings'] ${selector}`)?.focus();
  });

  const sections = settingsSectionsOf(HEADER_LAYOUTS[phone ? "phone" : "desktop"]);
  if (!open || typeof document === "undefined") return null;
  const place = { sections, sub, go, back, choose, close, project, keysFocus };
  return createPortal(
    <SettingsDensity.Provider value={phone ? "sheet" : "dialog"}>
      <MemoryReadingProvider project={project}>
        {phone ? <PhoneWindow {...place} section={section} /> : <DesktopWindow {...place} section={section ?? "general"} />}
      </MemoryReadingProvider>
    </SettingsDensity.Provider>,
    document.body,
  );
}
