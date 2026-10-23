"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

import { Select } from "@/components/ui/Select";
import {
  listVoiceDevices,
  outputChoiceSupported,
  resolveVoiceChoice,
  setVoiceDeviceChoice,
  useActiveVoiceInput,
  useVoiceDeviceChoice,
  type VoiceDeviceEntry,
  type VoiceDeviceKind,
  type VoiceDeviceList,
} from "@/lib/audio/voiceDevices";
import { useLocale } from "@/lib/i18n";
import { queryMicPermission, rememberMicGrant, type MicPermissionState, type PermissionsLike } from "@/lib/micPermission";

const NO_DEVICES: VoiceDeviceList = { inputs: [], outputs: [], defaultInputName: null, defaultOutputName: null, labelled: false };

/**
 * The microphone and speakers a voice call uses, in the Voice Delegatus dialog
 * (docs/design/voice-device-picker.md §2). It reads no server settings: the
 * choice is this browser's alone, and the composer's voice conversation uses it
 * even while the companion is off.
 */
export function VoiceDevicesSetting() {
  const { t } = useLocale();
  const [list, setList] = useState<VoiceDeviceList>(NO_DEVICES);
  const [permission, setPermission] = useState<MicPermissionState>("unavailable");
  const input = useVoiceDeviceChoice("input");
  const output = useVoiceDeviceChoice("output");
  const active = useActiveVoiceInput();
  const ids = { microphone: useId(), speakers: useId(), microphoneHint: useId(), speakersHint: useId() };
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    const [devices, state] = await Promise.all([
      listVoiceDevices(),
      queryMicPermission(typeof navigator === "undefined" ? undefined : navigator.permissions as unknown as PermissionsLike | undefined),
    ]);
    if (!alive.current) return;
    setList(devices);
    setPermission(state);
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const source = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
    source?.addEventListener?.("devicechange", refresh);
    return () => {
      alive.current = false;
      source?.removeEventListener?.("devicechange", refresh);
    };
  }, [refresh]);

  /* The one button: asks the browser for the microphone only to learn the device names, and lets it go at once. */
  const allow = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(track => track.stop());
      rememberMicGrant();
    } catch {
      /* A refusal shows as the denied state once the permission is read again. */
    }
    await refresh();
  };

  const denied = permission === "denied";
  const hidden = denied || !list.labelled;
  const speakersSupported = outputChoiceSupported() && (hidden || list.outputs.length > 0);
  const nameOf = (entry: VoiceDeviceEntry, entries: readonly VoiceDeviceEntry[]) => entry.label || t("voiceCompanion.devices.unnamed", { n: entries.indexOf(entry) + 1 });

  const row = (kind: VoiceDeviceKind) => {
    const entries = kind === "input" ? list.inputs : list.outputs;
    const choice = kind === "input" ? input : output;
    const defaultName = kind === "input" ? list.defaultInputName : list.defaultOutputName;
    const resolved = hidden ? ({ state: "default" } as const) : resolveVoiceChoice(choice, entries, list.labelled);
    const disabled = kind === "input" ? denied : hidden || !speakersSupported;
    const value = resolved.state === "default" ? "" : resolved.state === "present" ? resolved.id : choice!.id;
    const onChange = (next: string) => {
      const entry = entries.find(candidate => candidate.id === next);
      setVoiceDeviceChoice(kind, entry ? { id: entry.id, label: entry.label } : null);
    };
    const line = hint(kind, resolved.state, resolved.state === "present" ? resolved.label : "");
    return (
      <div className="min-w-0" data-voice-device={kind} data-device-state={resolved.state}>
        <label htmlFor={kind === "input" ? ids.microphone : ids.speakers} className="font-semibold text-primary">
          {t(kind === "input" ? "voiceCompanion.devices.microphone" : "voiceCompanion.devices.speakers")}
        </label>
        <Select
          roomy
          id={kind === "input" ? ids.microphone : ids.speakers}
          className="mt-1.5 w-full max-sm:min-h-11"
          value={value}
          disabled={disabled}
          aria-describedby={line ? (kind === "input" ? ids.microphoneHint : ids.speakersHint) : undefined}
          onChange={event => onChange(event.target.value)}
        >
          <option value="">{defaultName && !hidden ? t("voiceCompanion.devices.defaultNamed", { name: defaultName }) : t("voiceCompanion.devices.default")}</option>
          {resolved.state === "missing" ? <option value={choice!.id} disabled>{t("voiceCompanion.devices.missingOption", { name: resolved.label })}</option> : null}
          {hidden ? null : entries.map(entry => <option key={entry.id} value={entry.id}>{nameOf(entry, entries)}</option>)}
        </Select>
        {line ? <p id={kind === "input" ? ids.microphoneHint : ids.speakersHint} className="mt-1 text-[12px] leading-snug text-muted" data-voice-device-hint={kind}>{line}</p> : null}
      </div>
    );
  };

  /* The one line a row can carry; a row with nothing to say draws none. */
  const hint = (kind: VoiceDeviceKind, state: "default" | "present" | "missing", chosen: string) => {
    if (kind === "input") {
      if (denied) return t("voiceCompanion.devices.denied");
      if (!list.labelled) return (
        <>
          {t("voiceCompanion.devices.permission")}{" "}
          <button type="button" data-voice-devices-allow onClick={() => void allow()} className="min-h-9 rounded-[6px] font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:min-h-11">{t("voiceCompanion.devices.allow")}</button>
        </>
      );
      if (state === "missing") return t("voiceCompanion.devices.missingHint");
      const using = state === "present" ? chosen : list.defaultInputName ?? "";
      if (active && active.label && using && using !== active.label) return t("voiceCompanion.devices.nextCall");
      return null;
    }
    if (hidden) return null;
    if (!speakersSupported) return t("voiceCompanion.devices.outputUnsupported");
    if (state === "missing") return t("voiceCompanion.devices.missingHint");
    return null;
  };

  return (
    <section data-voice-devices className="mt-4 min-w-0 border-t border-border pt-3 text-[13px] [overflow-wrap:anywhere]">
      <h3 className="min-h-6 font-semibold">{t("voiceCompanion.devices.title")}</h3>
      <div className="mt-2 flex flex-col gap-3">
        {row("input")}
        {row("output")}
      </div>
    </section>
  );
}
