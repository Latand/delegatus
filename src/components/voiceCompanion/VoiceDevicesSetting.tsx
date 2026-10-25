"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

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

type HintLine = { key: string; text: ReactNode; phoneOnly?: boolean };

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
    const lines = hint(kind, resolved.state, resolved.state === "present" ? resolved.label : "", choice?.label ?? "", defaultName);
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
          aria-describedby={lines.length > 0 ? (kind === "input" ? ids.microphoneHint : ids.speakersHint) : undefined}
          onChange={event => onChange(event.target.value)}
        >
          <option value="">{t("voiceCompanion.devices.default")}</option>
          {resolved.state === "missing" ? <option value={choice!.id} disabled>{t("voiceCompanion.devices.missingOption", { name: resolved.label })}</option> : null}
          {hidden ? null : entries.map(entry => <option key={entry.id} value={entry.id}>{nameOf(entry, entries)}</option>)}
        </Select>
        {lines.length > 0 ? <div id={kind === "input" ? ids.microphoneHint : ids.speakersHint} className="mt-1 text-[12px] leading-snug text-muted" data-voice-device-hint={kind}>{lines.map(entry => <p key={entry.key} className={entry.phoneOnly ? "sm:hidden" : undefined}>{entry.text}</p>)}</div> : null}
      </div>
    );
  };

  /* The lines a row carries under its select, each whole at 390 px where a native select cuts a long device name: the
     device in use (the select shows it too, so the chosen device's line is drawn on the phone only), the marker of a
     choice that is not connected, and the row's own remark. A row with nothing to say draws none. */
  const hint = (kind: VoiceDeviceKind, state: "default" | "present" | "missing", chosen: string, stored: string, defaultName: string | null): HintLine[] => {
    const inUse = (name: string, phoneOnly: boolean): HintLine => ({ key: "in-use", phoneOnly, text: t("voiceCompanion.devices.inUse", { name }) });
    const gone: HintLine = { key: "gone", text: t("voiceCompanion.devices.missingHint", { name: stored }) };
    if (kind === "input") {
      if (denied) return [{ key: "denied", text: t("voiceCompanion.devices.denied") }];
      if (!list.labelled) return [{ key: "permission", text: (
        <>
          {t("voiceCompanion.devices.permission")}{" "}
          <button type="button" data-voice-devices-allow onClick={() => void allow()} className="min-h-9 rounded-[6px] font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:min-h-11">{t("voiceCompanion.devices.allow")}</button>
        </>
      ) }];
      const using = state === "present" ? chosen : defaultName ?? "";
      const lines: HintLine[] = state === "missing" ? [gone] : using ? [inUse(using, state === "present")] : [];
      if (state !== "missing" && active && active.label && using && using !== active.label) lines.push({ key: "next-call", text: t("voiceCompanion.devices.nextCall") });
      return lines;
    }
    if (hidden) return [];
    if (!speakersSupported) return [{ key: "unsupported", text: t("voiceCompanion.devices.outputUnsupported") }];
    if (state === "missing") return [gone];
    const using = state === "present" ? chosen : defaultName ?? "";
    return using ? [inUse(using, state === "present")] : [];
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
