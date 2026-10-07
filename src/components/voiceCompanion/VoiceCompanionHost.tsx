"use client";

import { useCallback, useEffect, useMemo } from "react";

import { useOrchestratorSeat } from "@/components/orchestrator/useOrchestratorSeat";
import { useVoiceCompanionSettings } from "@/hooks/useVoiceCompanionSettings";
import { useLocale } from "@/lib/i18n";
import type { VoiceCompanionAdapter } from "@/lib/voiceCompanion/contract";
import { OfficialVoiceCompanionAdapter } from "@/lib/voiceCompanion/liveAdapter";

import { COMPANION_PROTECT, COMPANION_ROWS, COMPANION_SETTINGS_EVENT, companionReserved, companionShellReady } from "./hostSurfaces";
import { VoiceCompanion } from "./VoiceCompanion";
import { openVoiceCompanionSettings } from "./VoiceCompanionSetting";

/**
 * The voice companion on the desktop shell (#2519). Off by default: nothing is
 * mounted, and nothing but the settings read is requested, until the operator
 * turns it on in the settings. Never on the phone.
 *
 * It talks about the project in view and, on request, to that project's
 * designated orchestrator, through the official live voice API minted by the
 * Viewer. On is that real voice and nothing else: the simulator and its
 * scripts are test fixtures and rendered-evidence drivers, which no setting
 * reaches. Mounting starts no call: only the tap on Talk does.
 */
export function VoiceCompanionHost({ project, mobile }: { project: string | null; mobile: boolean }) {
  const { settings, refresh } = useVoiceCompanionSettings(!mobile);
  useEffect(() => {
    if (mobile) return;
    const reread = () => { void refresh(); };
    window.addEventListener(COMPANION_SETTINGS_EVENT, reread);
    return () => window.removeEventListener(COMPANION_SETTINGS_EVENT, reread);
  }, [mobile, refresh]);
  if (mobile || !settings?.enabled) return null;
  return <MountedCompanion project={project} keyMissing={settings.keySource === "missing"} capReached={settings.usageUsd + settings.reservedUsd >= settings.monthlyCapUsd} onSessionEnd={refresh} />;
}

function MountedCompanion({ project, keyMissing, capReached, onSessionEnd }: { project: string | null; keyMissing: boolean; capReached: boolean; onSessionEnd: () => Promise<void> }) {
  const { locale } = useLocale();
  const speech = locale === "uk" ? "uk" as const : "en" as const;
  const seatRead = useOrchestratorSeat(project).status;
  const seat = seatRead?.seat && seatRead.exists && seatRead.seat.conversationId ? seatRead.seat : null;
  /* Unknown until the seat was read: nothing is said about an orchestrator that may well be there. */
  const hasSeat = project === null || seatRead === null ? undefined : seat !== null;
  /* A live conversation belongs to the project it was started in: its reads, its proposals and its
     orchestrator. Another project in view, or none, is another adapter, and leaving closes the session. */
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the project is the adapter's identity
  const adapter: VoiceCompanionAdapter = useMemo(() => new OfficialVoiceCompanionAdapter(), [project]);
  /* The month's usage is read again when a conversation ends. */
  useEffect(() => adapter.subscribe((event) => { if (event.type === "session.closed") void onSessionEnd(); }), [adapter, onSessionEnd]);
  /* With no key it says that a key is needed, and with the cap reached that the month is spent, before any microphone or session. */
  const preflight = useCallback(() => (keyMissing ? "NO_KEY" : capReached ? "CAP_REACHED" : null), [keyMissing, capReached]);
  return (
    <VoiceCompanion
      /* Another project starts idle: only its own tap on Talk opens a paid session. */
      key={`live:${project ?? ""}`}
      adapter={adapter}
      project={project}
      locale={speech}
      seat={hasSeat}
      preflight={preflight}
      onOpenSettings={openVoiceCompanionSettings}
      protect={COMPANION_PROTECT}
      rows={COMPANION_ROWS}
      reserve={companionReserved}
      ready={companionShellReady}
    />
  );
}
