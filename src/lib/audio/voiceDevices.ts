"use client";

import { useSyncExternalStore } from "react";

/**
 * The microphone and the speakers a voice call uses, chosen per browser.
 *
 * The choice lives in this browser's `localStorage` and nowhere else: device ids
 * belong to one origin in one browser profile, so a server copy could name a
 * device the next browser has never seen. Two calls open the microphone and play
 * sound, the floating companion and the composer's voice conversation, and both
 * go through this module so a choice made once is heard in both.
 *
 * A stored device that is no longer connected never blocks a call: the call
 * falls back to the system default and says so (`fellBack`). The stored choice
 * stays, so plugging the device in again restores it.
 */

export const VOICE_INPUT_KEY = "llvVoiceInputDevice";
export const VOICE_OUTPUT_KEY = "llvVoiceOutputDevice";

export type VoiceDeviceKind = "input" | "output";

/** What is stored for a kind: the device id and the name it had when it was chosen. */
export interface VoiceDeviceChoice {
  id: string;
  label: string;
}

export interface VoiceDeviceEntry {
  id: string;
  /** Empty while the browser withholds names; the settings row numbers such a device. */
  label: string;
}

export interface VoiceDeviceList {
  inputs: VoiceDeviceEntry[];
  outputs: VoiceDeviceEntry[];
  /** The real device behind Chrome's `default` pseudo-entry, when it can be told. */
  defaultInputName: string | null;
  defaultOutputName: string | null;
  /** False while every label is empty: the browser has not been given the microphone yet. */
  labelled: boolean;
}

export type ResolvedVoiceChoice =
  | { state: "default" }
  | { state: "present"; id: string; label: string }
  | { state: "missing"; label: string };

export interface ActiveVoiceInput {
  /** The microphone the live call listens to; empty when the browser gave no name. */
  label: string;
  /** The chosen microphone was not there, so the call took the system default. */
  fellBack: boolean;
}

/** The slice of `Storage` this module needs, so tests can hand over a fake. */
export interface VoiceDeviceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const KEYS: Record<VoiceDeviceKind, string> = { input: VOICE_INPUT_KEY, output: VOICE_OUTPUT_KEY };

let injected: VoiceDeviceStorage | null | undefined;
const choices: Record<VoiceDeviceKind, VoiceDeviceChoice | null | undefined> = { input: undefined, output: undefined };
const listeners = new Set<() => void>();
let stopStorageWatch: (() => void) | null = null;

/** Test seam: pin the storage (or `null` for a browser with none). */
export function configureVoiceDeviceStorage(storage: VoiceDeviceStorage | null | undefined): void {
  injected = storage;
  choices.input = undefined;
  choices.output = undefined;
  notify();
}

function activeStorage(): VoiceDeviceStorage | null {
  if (injected !== undefined) return injected;
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    /* Storage disabled: the choice then lasts for this page only. */
    return null;
  }
}

function parseChoice(raw: string | null): VoiceDeviceChoice | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null) return null;
    const { id, label } = value as Record<string, unknown>;
    if (typeof id !== "string" || !id) return null;
    return { id, label: typeof label === "string" ? label : "" };
  } catch {
    return null;
  }
}

/** The stored choice for a kind; null is System default. Memoized between writes so a store snapshot is stable. */
export function voiceDeviceChoice(kind: VoiceDeviceKind): VoiceDeviceChoice | null {
  const cached = choices[kind];
  if (cached !== undefined) return cached;
  let raw: string | null = null;
  try {
    raw = activeStorage()?.getItem(KEYS[kind]) ?? null;
  } catch {
    raw = null;
  }
  return (choices[kind] = parseChoice(raw));
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/** Stores a choice, or clears it with null (System default). A live call's speakers follow at once. */
export function setVoiceDeviceChoice(kind: VoiceDeviceKind, choice: VoiceDeviceChoice | null): void {
  const storage = activeStorage();
  try {
    if (choice) storage?.setItem(KEYS[kind], JSON.stringify({ id: choice.id, label: choice.label }));
    else storage?.removeItem(KEYS[kind]);
  } catch {
    /* The write was refused: the choice still applies for this page. */
  }
  choices[kind] = choice ? { id: choice.id, label: choice.label } : null;
  notify();
  if (kind === "output") reapplyOutputs();
}

function watchStorage(): void {
  if (stopStorageWatch || typeof window === "undefined") return;
  /* Another tab of this browser chose a device — adopt it, don't fight it. */
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== VOICE_INPUT_KEY && event.key !== VOICE_OUTPUT_KEY) return;
    choices.input = undefined;
    choices.output = undefined;
    notify();
    reapplyOutputs();
  };
  window.addEventListener("storage", onStorage);
  stopStorageWatch = () => window.removeEventListener("storage", onStorage);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  watchStorage();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      stopStorageWatch?.();
      stopStorageWatch = null;
    }
  };
}

export function useVoiceDeviceChoice(kind: VoiceDeviceKind): VoiceDeviceChoice | null {
  return useSyncExternalStore(subscribe, () => voiceDeviceChoice(kind), () => null);
}

// ---- listing --------------------------------------------------------------

function mediaDevices(): MediaDevices | null {
  if (typeof navigator === "undefined") return null;
  return navigator.mediaDevices ?? null;
}

const PSEUDO_IDS = new Set(["default", "communications"]);

function listKind(devices: MediaDeviceInfo[], type: "audioinput" | "audiooutput"): { entries: VoiceDeviceEntry[]; defaultName: string | null } {
  const of = devices.filter(device => device.kind === type && device.deviceId);
  const pseudo = of.find(device => device.deviceId === "default");
  const entries = of.filter(device => !PSEUDO_IDS.has(device.deviceId)).map(device => ({ id: device.deviceId, label: device.label ?? "" }));
  const behind = pseudo?.groupId ? of.find(device => !PSEUDO_IDS.has(device.deviceId) && device.groupId === pseudo.groupId) : undefined;
  return { entries, defaultName: behind?.label || null };
}

/** The browser's audio devices. An API that is missing or refuses reads as an empty, unlabelled list. */
export async function listVoiceDevices(): Promise<VoiceDeviceList> {
  let devices: MediaDeviceInfo[] = [];
  try {
    const source = mediaDevices();
    if (source && typeof source.enumerateDevices === "function") devices = await source.enumerateDevices();
  } catch {
    devices = [];
  }
  const input = listKind(devices, "audioinput");
  const output = listKind(devices, "audiooutput");
  const labelled = devices.some(device => (device.kind === "audioinput" || device.kind === "audiooutput") && !!device.label);
  return { inputs: input.entries, outputs: output.entries, defaultInputName: input.defaultName, defaultOutputName: output.defaultName, labelled };
}

/**
 * Where a stored choice stands among the listed devices. The id decides; when the
 * browser rotated ids and names are visible, an exact name match finds the device.
 * Without names nothing can be told, so the stored id is trusted and the browser
 * answers when it is used.
 */
export function resolveVoiceChoice(choice: VoiceDeviceChoice | null, entries: readonly VoiceDeviceEntry[], labelled: boolean): ResolvedVoiceChoice {
  if (!choice) return { state: "default" };
  const byId = entries.find(entry => entry.id === choice.id);
  if (byId) return { state: "present", id: byId.id, label: byId.label || choice.label };
  if (!labelled) return { state: "present", id: choice.id, label: choice.label };
  const byLabel = choice.label ? entries.find(entry => entry.label === choice.label) : undefined;
  return byLabel ? { state: "present", id: byLabel.id, label: byLabel.label } : { state: "missing", label: choice.label };
}

// ---- the active call ------------------------------------------------------

interface CallDevices {
  input: ActiveVoiceInput | null;
  /** The chosen speakers were not there, so the call plays through the system default. */
  outputFellBack: boolean;
}

let callDevices: CallDevices = { input: null, outputFellBack: false };

function setCallDevices(patch: Partial<CallDevices>): void {
  callDevices = { ...callDevices, ...patch };
  notify();
}

/** The microphone the live call uses; null while no call holds one. */
export function activeVoiceInput(): ActiveVoiceInput | null {
  return callDevices.input;
}
export function voiceOutputFellBack(): boolean {
  return callDevices.outputFellBack;
}
export function useActiveVoiceInput(): ActiveVoiceInput | null {
  return useSyncExternalStore(subscribe, activeVoiceInput, () => null);
}
export function useVoiceOutputFellBack(): boolean {
  return useSyncExternalStore(subscribe, voiceOutputFellBack, () => false);
}

function refusedDevice(error: unknown): boolean {
  const name = error instanceof Error || (typeof error === "object" && error !== null) ? (error as { name?: unknown }).name : null;
  return name === "OverconstrainedError" || name === "NotFoundError";
}

function trackName(track: MediaStreamTrack | undefined, list: VoiceDeviceList): string {
  if (!track) return "";
  let id: string | undefined;
  try {
    id = track.getSettings?.().deviceId;
  } catch {
    id = undefined;
  }
  if (id === "default" && list.defaultInputName) return list.defaultInputName;
  const listed = id ? list.inputs.find(entry => entry.id === id) : undefined;
  if (listed?.label) return listed.label;
  return (track.label ?? "").replace(/^(Default|Communications) - /, "");
}

export interface VoiceMicrophone {
  stream: MediaStream;
  /** The chosen microphone was not connected, so the system default was opened. */
  fellBack: boolean;
  /** Clears the active-input record this opening made. Safe to call twice. */
  release(): void;
}

const releases = new WeakMap<MediaStream, () => void>();

/** Ends the record `openVoiceMicrophone` made for a stream, for a caller that holds only the stream. */
export function releaseVoiceMicrophone(stream: MediaStream): void {
  releases.get(stream)?.();
}

/**
 * Opens the microphone for a call: the chosen device when there is one, the
 * system default otherwise. A chosen device the browser cannot find falls back to
 * the default with `fellBack: true`; every other error (permission above all)
 * reaches the caller unchanged.
 */
export async function openVoiceMicrophone(base: MediaTrackConstraints): Promise<VoiceMicrophone> {
  const choice = voiceDeviceChoice("input");
  let stream: MediaStream | null = null;
  let fellBack = false;
  if (choice) {
    const list = await listVoiceDevices();
    const resolved = resolveVoiceChoice(choice, list.inputs, list.labelled);
    if (resolved.state === "missing") {
      fellBack = true;
    } else if (resolved.state === "present") {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { ...base, deviceId: { exact: resolved.id } } });
      } catch (error) {
        if (!refusedDevice(error)) throw error;
        fellBack = true;
      }
    }
  }
  stream ??= await navigator.mediaDevices.getUserMedia({ audio: base });
  const opened = stream;
  const record: ActiveVoiceInput = { label: "", fellBack };
  try {
    record.label = trackName(opened.getAudioTracks?.()[0], await listVoiceDevices());
  } catch {
    /* An unnamed microphone still works; the status line then names nothing. */
  }
  setCallDevices({ input: record });
  const release = () => {
    if (callDevices.input === record) setCallDevices({ input: null });
    releases.delete(opened);
  };
  releases.set(opened, release);
  return { stream: opened, fellBack, release };
}

// ---- speakers -------------------------------------------------------------

interface SinkElement extends HTMLAudioElement {
  setSinkId(id: string): Promise<void>;
}

/** Whether this browser lets a page pick the speakers of an audio element. */
export function outputChoiceSupported(): boolean {
  return typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
}

/** Elements that follow the choice: the sink each was last given, and a counter that drops stale answers. */
const attached = new Map<HTMLAudioElement, { sink: string; turn: number }>();
let stopDeviceWatch: (() => void) | null = null;

async function applyOutput(audio: HTMLAudioElement): Promise<void> {
  const entry = attached.get(audio);
  if (!entry || !outputChoiceSupported()) return;
  const turn = ++entry.turn;
  const choice = voiceDeviceChoice("output");
  let target = "";
  let fellBack = false;
  if (choice) {
    const list = await listVoiceDevices();
    const resolved = resolveVoiceChoice(choice, list.outputs, list.labelled);
    if (resolved.state === "present") target = resolved.id;
    else fellBack = true;
  }
  if (attached.get(audio) !== entry || entry.turn !== turn) return;
  if (target !== entry.sink) {
    try {
      await (audio as SinkElement).setSinkId(target);
      entry.sink = target;
    } catch {
      fellBack = fellBack || !!target;
      try {
        await (audio as SinkElement).setSinkId("");
        entry.sink = "";
      } catch {
        /* The element keeps the sink it had. */
      }
    }
    if (attached.get(audio) !== entry || entry.turn !== turn) return;
  }
  if (fellBack !== callDevices.outputFellBack && attached.size) setCallDevices({ outputFellBack: fellBack });
}

function reapplyOutputs(): void {
  for (const audio of [...attached.keys()]) void applyOutput(audio);
}

function watchDevices(): void {
  const source = mediaDevices();
  if (stopDeviceWatch || !source || typeof source.addEventListener !== "function") return;
  /* A sink that was unplugged must not leave the call silent. */
  source.addEventListener("devicechange", reapplyOutputs);
  stopDeviceWatch = () => source.removeEventListener("devicechange", reapplyOutputs);
}

/**
 * Plays an audio element through the chosen speakers for as long as it is
 * attached, following later changes of the choice and of the connected devices.
 * Where the browser has no `setSinkId` this does nothing. The returned function
 * detaches the element; the last one to go ends the call's fallback notice.
 */
export function attachVoiceOutput(audio: HTMLAudioElement): () => void {
  if (!outputChoiceSupported()) return () => undefined;
  attached.set(audio, { sink: "", turn: 0 });
  watchDevices();
  void applyOutput(audio);
  return () => detachVoiceOutput(audio);
}

/** Detaches an element `attachVoiceOutput` registered, for a caller that holds only the element. */
export function detachVoiceOutput(audio: HTMLAudioElement): void {
  if (!attached.delete(audio) || attached.size) return;
  stopDeviceWatch?.();
  stopDeviceWatch = null;
  if (callDevices.outputFellBack) setCallDevices({ outputFellBack: false });
}
