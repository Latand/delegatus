"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

import { ChoiceRow, SectionHead, useDensity } from "@/components/settings/settingsRows";
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
 * The microphone and speakers a voice call uses, in the Voice section of Settings
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
  const sheet = useDensity() === "sheet";
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
    const label = t(kind === "input" ? "voiceCompanion.devices.microphone" : "voiceCompanion.devices.speakers");
    const hintId = kind === "input" ? ids.microphoneHint : ids.speakersHint;
    return (
      <ChoiceRow
        label={label}
        wide
        attrs={{ "data-voice-device": kind, "data-device-state": resolved.state }}
        id={kind === "input" ? ids.microphone : ids.speakers}
        value={value}
        disabled={disabled}
        describedBy={lines.length > 0 ? hintId : undefined}
        onChange={onChange}
        options={[
          { value: "", label: t("voiceCompanion.devices.default") },
          ...(resolved.state === "missing" ? [{ value: choice!.id, label: t("voiceCompanion.devices.missingOption", { name: resolved.label }), disabled: true }] : []),
          ...(hidden ? [] : entries.map(entry => ({ value: entry.id, label: nameOf(entry, entries) }))),
        ]}
      >
        {lines.length > 0 ? <div id={hintId} data-settings-unit="" className={`${sheet ? "px-4" : "px-5"} pb-1.5 text-ui leading-snug text-muted`} data-voice-device-hint={kind}>{lines.filter(entry => sheet || !entry.phoneOnly).map(entry => <p key={entry.key}>{entry.text}</p>)}</div> : null}
      </ChoiceRow>
    );
  };

  /* The lines a row carries under its select, each whole at 390 px where a native select cuts a long device name: the
     device in use (the window's wide select shows it whole, so the chosen device's line is drawn in the sheet only), the marker of a
     choice that is not connected, and the row's own remark. A row with nothing to say draws none. */
  const hint = (kind: VoiceDeviceKind, state: "default" | "present" | "missing", chosen: string, stored: string, defaultName: string | null): HintLine[] => {
    const inUse = (name: string, phoneOnly: boolean): HintLine => ({ key: "in-use", phoneOnly, text: t("voiceCompanion.devices.inUse", { name }) });
    const gone: HintLine = { key: "gone", text: t("voiceCompanion.devices.missingHint", { name: stored }) };
    if (kind === "input") {
      if (denied) return [{ key: "denied", text: t("voiceCompanion.devices.denied") }];
      if (!list.labelled) return [{ key: "permission", text: (
        <>
          {t("voiceCompanion.devices.permission")}{" "}
          <button type="button" data-voice-devices-allow onClick={() => void allow()} className="min-h-9 rounded-[6px] font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 settings-sheet:min-h-11">{t("voiceCompanion.devices.allow")}</button>
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
    <div data-voice-devices="">
      <SectionHead title={t("voiceCompanion.devices.title")} />
      {row("input")}
      {row("output")}
    </div>
  );
}
