"use client";

import { useCallback, useEffect, useMemo } from "react";

import { useOrchestratorSeat } from "@/components/orchestrator/useOrchestratorSeat";
import { openTelemetrySettings } from "@/components/telemetry/TelemetrySettings";
import { useVoiceCompanionSettings } from "@/hooks/useVoiceCompanionSettings";
import { useLocale } from "@/lib/i18n";
import type { VoiceCompanionAdapter } from "@/lib/voiceCompanion/contract";
import { OfficialVoiceCompanionAdapter } from "@/lib/voiceCompanion/liveAdapter";
import { scenarioScript } from "@/lib/voiceCompanion/scenarios";
import { createSimulatedCompanion } from "@/lib/voiceCompanion/simulator";

import { COMPANION_PROTECT, COMPANION_ROWS, COMPANION_SETTINGS_EVENT, companionReserved } from "./hostSurfaces";
import { VoiceCompanion } from "./VoiceCompanion";

/**
 * The voice companion on the desktop shell (#2519). Off by default: nothing is
 * mounted, and nothing but the settings read is requested, until the operator
 * turns it on in the settings. Never on the phone.
 *
 * It talks about the project in view and, on request, to that project's
 * designated orchestrator. The real backend is the official live voice API
 * through the Viewer; the demo choice plays the simulator on the same event
 * contract, with no key, no microphone and nothing sent anywhere.
 * Mounting starts no call: only the tap on Talk does.
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
  return <MountedCompanion key={settings.backend} project={project} demo={settings.backend === "demo"} keyMissing={settings.keySource === "missing"} capReached={settings.usageUsd + settings.reservedUsd >= settings.monthlyCapUsd} onSessionEnd={refresh} />;
}

function MountedCompanion({ project, demo, keyMissing, capReached, onSessionEnd }: { project: string | null; demo: boolean; keyMissing: boolean; capReached: boolean; onSessionEnd: () => Promise<void> }) {
  const { locale } = useLocale();
  const speech = locale === "uk" ? "uk" as const : "en" as const;
  const seatRead = useOrchestratorSeat(project).status;
  const seat = seatRead?.seat && seatRead.exists && seatRead.seat.conversationId ? seatRead.seat : null;
  /* Unknown until the seat was read: nothing is said about an orchestrator that may well be there. */
  const hasSeat = project === null || seatRead === null ? undefined : seat !== null;
  const conversationId = seat?.conversationId ?? null;
  const seatEpoch = seat?.seatEpoch ?? 0;
  const engine = seat?.engine === "codex" ? "codex" as const : "claude" as const;
  /* A live conversation belongs to the project it was started in: its reads, its proposals and its
     orchestrator. Another project in view, or none, is another adapter, and leaving closes the session. */
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the project is the adapter's identity
  const live = useMemo(() => new OfficialVoiceCompanionAdapter(), [project]);
  /* The demo plays for the project in view; with no orchestrator it shows the board answers and proposes nothing. */
  const simulated = useMemo(() => (demo && project !== null ? createSimulatedCompanion({
    script: scenarioScript(conversationId ? "demo" : "demoNoSeat", speech),
    recipient: { project, conversationId: conversationId ?? "", seatEpoch, engine },
  }) : null), [demo, project, speech, conversationId, seatEpoch, engine]);
  const adapter: VoiceCompanionAdapter = demo ? simulated ?? live : live;
  /* The month's usage is read again when a conversation ends. */
  useEffect(() => adapter.subscribe((event) => { if (event.type === "session.closed") void onSessionEnd(); }), [adapter, onSessionEnd]);
  const preflight = useCallback(() => (demo ? null : keyMissing ? "NO_KEY" : capReached ? "CAP_REACHED" : null), [demo, keyMissing, capReached]);
  return (
    <VoiceCompanion
      /* A demo for another project, language or seat is another script, so another companion.
         A live one for another project starts idle: only its own tap on Talk opens a paid session. */
      key={demo ? `${project}:${speech}:${conversationId}` : `live:${project ?? ""}`}
      adapter={adapter}
      project={project}
      locale={speech}
      seat={hasSeat}
      preflight={preflight}
      onOpenSettings={openTelemetrySettings}
      protect={COMPANION_PROTECT}
      rows={COMPANION_ROWS}
      reserve={companionReserved}
    />
  );
}
