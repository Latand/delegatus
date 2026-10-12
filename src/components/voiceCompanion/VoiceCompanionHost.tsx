"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useOrchestratorSeat } from "@/components/orchestrator/useOrchestratorSeat";
import { useVoiceCompanionSettings } from "@/hooks/useVoiceCompanionSettings";
import { useLocale } from "@/lib/i18n";
import type { VoiceCompanionAdapter } from "@/lib/voiceCompanion/contract";
import { OfficialVoiceCompanionAdapter } from "@/lib/voiceCompanion/liveAdapter";

import { COMPANION_PROTECT, COMPANION_ROWS, COMPANION_SETTINGS_EVENT, companionReserved, companionShellReady } from "./hostSurfaces";
import { PhoneVoiceCompanion } from "./PhoneVoiceCompanion";
import { setPhoneVoiceAvailable, usePhoneVoice } from "./phoneVoiceStore";
import { VoiceCompanion } from "./VoiceCompanion";
import { openVoiceCompanionSettings } from "./VoiceCompanionSetting";

/* The voice every mount talks through. The phone's rendered-evidence fixture puts a simulator here; no setting does. */
let createAdapter: () => VoiceCompanionAdapter = () => new OfficialVoiceCompanionAdapter();
export function setVoiceCompanionAdapterForTests(factory: (() => VoiceCompanionAdapter) | null) {
  createAdapter = factory ?? (() => new OfficialVoiceCompanionAdapter());
}

/**
 * The voice companion on the shell (#2519). Off by default: nothing is
 * mounted, and nothing but the settings read is requested, until the operator
 * turns it on in the settings.
 *
 * On the desktop it is the floating window. On the phone it is the head of
 * docs/design/phone-voice-head-build.md, which the operator can hide; hidden,
 * nothing is mounted, and «Показати голос» in the ⋯ menu brings it back. A
 * window that crosses the phone breakpoint ends a call on the crossing: each
 * surface mounts its own adapter.
 *
 * It talks about the project in view and, on request, to that project's
 * designated orchestrator, through the voice the settings choose: the
 * official live voice API minted by the Viewer, or a Codex V3 call on a
 * managed account's plan. On is that real voice and nothing else: the simulator and its
 * scripts are test fixtures and rendered-evidence drivers, which no setting
 * reaches. Mounting starts no call: only the tap on Talk does.
 */
export function VoiceCompanionHost({ project, mobile }: { project: string | null; mobile: boolean }) {
  const { settings, refresh } = useVoiceCompanionSettings(true);
  useEffect(() => {
    const reread = () => { void refresh(); };
    window.addEventListener(COMPANION_SETTINGS_EVENT, reread);
    return () => window.removeEventListener(COMPANION_SETTINGS_EVENT, reread);
  }, [refresh]);
  if (!settings?.enabled) return null;
  /* The key and the cap belong to the API; a Codex call needs neither. */
  const api = settings.backend !== "codex";
  const keyMissing = api && settings.keySource === "missing";
  const capReached = api && settings.usageUsd + settings.reservedUsd >= settings.monthlyCapUsd;
  if (mobile) return <PhoneCompanion project={project} keyMissing={keyMissing} capReached={capReached} onSessionEnd={refresh} />;
  return <MountedCompanion project={project} mobile={false} keyMissing={keyMissing} capReached={capReached} onSessionEnd={refresh} />;
}

/** The phone's head, unless the operator hid it. Hidden, nothing is mounted: no adapter, no poll, no microphone. */
function PhoneCompanion(props: { project: string | null; keyMissing: boolean; capReached: boolean; onSessionEnd: () => Promise<void> }) {
  const { hidden } = usePhoneVoice();
  useEffect(() => {
    setPhoneVoiceAvailable(true);
    return () => setPhoneVoiceAvailable(false);
  }, []);
  /* A head that was hidden heard no `session.closed`: the month's usage is read again when it comes back. */
  const { onSessionEnd } = props;
  const wasHidden = useRef(hidden);
  useEffect(() => {
    if (wasHidden.current && !hidden) void onSessionEnd();
    wasHidden.current = hidden;
  }, [hidden, onSessionEnd]);
  if (hidden) return null;
  return <MountedCompanion {...props} mobile />;
}

function MountedCompanion({ project, mobile, keyMissing, capReached, onSessionEnd }: { project: string | null; mobile: boolean; keyMissing: boolean; capReached: boolean; onSessionEnd: () => Promise<void> }) {
  const { locale } = useLocale();
  const speech = locale === "uk" ? "uk" as const : "en" as const;
  const seatRead = useOrchestratorSeat(project).status;
  const seat = seatRead?.seat && seatRead.exists && seatRead.seat.conversationId ? seatRead.seat : null;
  /* Unknown until the seat was read: nothing is said about an orchestrator that may well be there. */
  const hasSeat = project === null || seatRead === null ? undefined : seat !== null;
  const [adapter] = useState<VoiceCompanionAdapter>(() => createAdapter());
  useEffect(() => { void adapter.setProject?.(project).catch(() => undefined); }, [adapter, project]);
  /* The month's usage is read again when a conversation ends. */
  useEffect(() => adapter.subscribe((event) => { if (event.type === "session.closed") void onSessionEnd(); }), [adapter, onSessionEnd]);
  /* With no key it says that a key is needed, and with the cap reached that the month is spent, before any microphone or session. */
  const preflight = useCallback(() => (keyMissing ? "NO_KEY" : capReached ? "CAP_REACHED" : null), [keyMissing, capReached]);
  if (mobile) return <PhoneVoiceCompanion adapter={adapter} project={project} locale={speech} seat={hasSeat} preflight={preflight} onOpenSettings={openVoiceCompanionSettings} />;
  return (
    <VoiceCompanion
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
