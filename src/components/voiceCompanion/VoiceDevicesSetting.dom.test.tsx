import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { installOnboardingDom, settle } from "@/test-helpers/onboardingDom";

/*
 * The «Microphone and speakers» section of the voice settings
 * (docs/design/voice-device-picker.md §2) over a fake `navigator.mediaDevices`:
 * each row of the state table in English and Ukrainian, what a choice writes,
 * and the list following `devicechange`.
 */

const harness = installOnboardingDom();
installActEnv();
const { createRoot } = await import("react-dom/client");
const { VoiceDevicesSetting } = await import("./VoiceDevicesSetting");
const { translate } = await import("@/lib/i18n/core");
const { resetLocaleForTests, setLocale } = await import("@/lib/i18n");
const voice = await import("@/lib/audio/voiceDevices");

type Info = Pick<MediaDeviceInfo, "deviceId" | "kind" | "label" | "groupId">;
const mic = (deviceId: string, label: string, groupId = deviceId): Info => ({ deviceId, kind: "audioinput", label, groupId });
const speaker = (deviceId: string, label: string, groupId = deviceId): Info => ({ deviceId, kind: "audiooutput", label, groupId });
const LABELLED: Info[] = [
  mic("default", "Default - Microphone Array (Realtek(R) Audio)", "g-array"),
  mic("mic-array", "Microphone Array (Realtek(R) Audio)", "g-array"),
  mic("mic-pods", "Навушники AirPods Pro (Bluetooth)", "g-pods"),
  speaker("default", "Default - Realtek Speakers", "g-array"),
  speaker("spk-array", "Realtek Speakers", "g-array"),
  speaker("spk-pods", "Навушники AirPods Pro (Bluetooth)", "g-pods"),
];

const nav = navigator as unknown as Record<string, unknown>;
const target = new harness.dom.EventTarget();
const world = { devices: LABELLED as Info[], permission: "granted" as string, sinkId: true, asked: 0 };
function installWorld() {
  Object.defineProperty(nav, "mediaDevices", {
    configurable: true,
    value: Object.assign(target, {
      enumerateDevices: async () => world.devices,
      getUserMedia: async () => {
        world.asked += 1;
        if (world.permission === "denied") throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
        world.permission = "granted";
        world.devices = LABELLED;
        return { getTracks: () => [{ stop() {} }] };
      },
    }),
  });
  Object.defineProperty(nav, "permissions", { configurable: true, value: { query: async () => ({ state: world.permission }) } });
  Object.defineProperty(globalThis, "HTMLMediaElement", { configurable: true, writable: true, value: world.sinkId ? class { setSinkId() {} } : class {} });
}

const store = new Map<string, string>();
let mounted: { root: Root; host: HTMLElement } | null = null;
beforeEach(() => {
  world.devices = LABELLED; world.permission = "granted"; world.sinkId = true; world.asked = 0;
  store.clear();
  voice.configureVoiceDeviceStorage({ getItem: key => store.get(key) ?? null, setItem: (key, value) => { store.set(key, value); }, removeItem: key => { store.delete(key); } });
  installWorld();
});
afterEach(async () => {
  if (mounted) { const { root, host } = mounted; await act(async () => root.unmount()); host.remove(); mounted = null; }
  voice.configureVoiceDeviceStorage(undefined);
  resetLocaleForTests();
  localStorage.removeItem("llv_lang");
});

async function mount(locale: "en" | "uk" = "en"): Promise<HTMLElement> {
  localStorage.removeItem("llv_lang"); resetLocaleForTests(); setLocale(locale);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => root.render(<VoiceDevicesSetting />));
  await act(async () => settle());
  return host;
}
const select = (host: Element, kind: "input" | "output") => host.querySelector<HTMLSelectElement>(`[data-voice-device='${kind}'] select`)!;
const options = (element: HTMLSelectElement) => [...element.options].map(option => option.textContent);
const hint = (host: Element, kind: "input" | "output") => host.querySelector(`[data-voice-device-hint='${kind}']`)?.textContent ?? null;
async function choose(element: HTMLSelectElement, value: string) {
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => settle());
}
const tr = (locale: "en" | "uk", key: string, params?: Record<string, string | number>) => translate(locale, key as never, params as never);

for (const locale of ["en", "uk"] as const) {
  test(`${locale}: without permission only System default is listed, speakers are disabled and the button asks`, async () => {
    world.devices = [mic("m1", ""), speaker("s1", "")];
    world.permission = "prompt";
    const host = await mount(locale);
    expect(host.querySelector("h3")?.textContent).toBe(tr(locale, "voiceCompanion.devices.title"));
    expect(options(select(host, "input"))).toEqual([tr(locale, "voiceCompanion.devices.default")]);
    expect(select(host, "input").disabled).toBe(false);
    expect(options(select(host, "output"))).toEqual([tr(locale, "voiceCompanion.devices.default")]);
    expect(select(host, "output").disabled).toBe(true);
    expect(hint(host, "input")).toContain(tr(locale, "voiceCompanion.devices.permission"));
    expect(hint(host, "output")).toBeNull();
    const allow = host.querySelector<HTMLButtonElement>("[data-voice-devices-allow]")!;
    expect(allow.textContent).toBe(tr(locale, "voiceCompanion.devices.allow"));
    await act(async () => allow.click());
    await act(async () => settle());
    expect(world.asked).toBe(1);
    expect(host.querySelector("[data-voice-devices-allow]")).toBeNull();
    expect(options(select(host, "input")).length).toBe(3);
    expect(localStorage.getItem("llv_mic_granted")).toBe("1");
  });

  test(`${locale}: a blocked microphone disables both selects and says where to allow it`, async () => {
    world.devices = [mic("m1", "")];
    world.permission = "denied";
    const host = await mount(locale);
    expect([select(host, "input").disabled, select(host, "output").disabled]).toEqual([true, true]);
    expect(hint(host, "input")).toBe(tr(locale, "voiceCompanion.devices.denied"));
    expect(host.querySelector("[data-voice-devices-allow]")).toBeNull();
  });

  test(`${locale}: with nothing stored the default device is named and every device is listed`, async () => {
    const host = await mount(locale);
    const defaultNamed = (name: string) => tr(locale, "voiceCompanion.devices.defaultNamed", { name });
    expect(options(select(host, "input"))).toEqual([defaultNamed("Microphone Array (Realtek(R) Audio)"), "Microphone Array (Realtek(R) Audio)", "Навушники AirPods Pro (Bluetooth)"]);
    expect(options(select(host, "output"))).toEqual([defaultNamed("Realtek Speakers"), "Realtek Speakers", "Навушники AirPods Pro (Bluetooth)"]);
    expect(select(host, "input").value).toBe("");
    expect([select(host, "input").disabled, select(host, "output").disabled]).toEqual([false, false]);
    expect(hint(host, "input")).toBeNull();
    expect(hint(host, "output")).toBeNull();
  });

  test(`${locale}: a stored device that is present is selected`, async () => {
    voice.setVoiceDeviceChoice("input", { id: "mic-pods", label: "Навушники AirPods Pro (Bluetooth)" });
    voice.setVoiceDeviceChoice("output", { id: "spk-pods", label: "Навушники AirPods Pro (Bluetooth)" });
    const host = await mount(locale);
    expect(select(host, "input").value).toBe("mic-pods");
    expect(select(host, "output").value).toBe("spk-pods");
    expect(hint(host, "input")).toBeNull();
  });

  test(`${locale}: a stored device that is gone stays as a disabled option, keeps the choice and says what plays instead`, async () => {
    voice.setVoiceDeviceChoice("input", { id: "usb", label: "USB Microphone" });
    voice.setVoiceDeviceChoice("output", { id: "bt", label: "Bluetooth speaker" });
    const host = await mount(locale);
    const missing = (name: string) => tr(locale, "voiceCompanion.devices.missingOption", { name });
    expect(options(select(host, "input")).slice(0, 2)).toEqual([expect.stringContaining(tr(locale, "voiceCompanion.devices.default")), missing("USB Microphone")]);
    expect(select(host, "input").value).toBe("usb");
    expect(select(host, "input").options[1]!.disabled).toBe(true);
    expect(select(host, "output").options[1]!.textContent).toBe(missing("Bluetooth speaker"));
    expect(hint(host, "input")).toBe(tr(locale, "voiceCompanion.devices.missingHint"));
    expect(hint(host, "output")).toBe(tr(locale, "voiceCompanion.devices.missingHint"));
    expect(voice.voiceDeviceChoice("input")?.id).toBe("usb");
    /* Picking another device replaces it. */
    await choose(select(host, "input"), "mic-array");
    expect(JSON.parse(store.get(voice.VOICE_INPUT_KEY)!)).toEqual({ id: "mic-array", label: "Microphone Array (Realtek(R) Audio)" });
    expect(options(select(host, "input")).some(text => text?.includes("USB Microphone"))).toBe(false);
  });

  test(`${locale}: a browser that cannot choose speakers disables them and says so`, async () => {
    world.sinkId = false;
    installWorld();
    const host = await mount(locale);
    expect(select(host, "output").disabled).toBe(true);
    expect(hint(host, "output")).toBe(tr(locale, "voiceCompanion.devices.outputUnsupported"));
    expect(select(host, "input").disabled).toBe(false);
  });
}

test("a browser that lists no output device reads as unable to choose speakers", async () => {
  world.devices = LABELLED.filter(device => device.kind === "audioinput");
  const host = await mount();
  expect(select(host, "output").disabled).toBe(true);
  expect(hint(host, "output")).toBe(translate("en", "voiceCompanion.devices.outputUnsupported"));
});

test("a choice is written at once, and System default clears it", async () => {
  const host = await mount();
  await choose(select(host, "input"), "mic-pods");
  await choose(select(host, "output"), "spk-array");
  expect(JSON.parse(store.get(voice.VOICE_INPUT_KEY)!)).toEqual({ id: "mic-pods", label: "Навушники AirPods Pro (Bluetooth)" });
  expect(JSON.parse(store.get(voice.VOICE_OUTPUT_KEY)!)).toEqual({ id: "spk-array", label: "Realtek Speakers" });
  expect([select(host, "input").value, select(host, "output").value]).toEqual(["mic-pods", "spk-array"]);
  await choose(select(host, "input"), "");
  await choose(select(host, "output"), "");
  expect(store.has(voice.VOICE_INPUT_KEY)).toBe(false);
  expect(store.has(voice.VOICE_OUTPUT_KEY)).toBe(false);
});

test("devicechange lists again, so a plugged-in device appears and an unplugged choice turns missing", async () => {
  voice.setVoiceDeviceChoice("input", { id: "mic-usb", label: "USB Microphone" });
  const host = await mount();
  expect(options(select(host, "input")).some(text => text?.includes("USB Microphone"))).toBe(true);
  expect(select(host, "input").options[1]!.disabled).toBe(true);
  world.devices = [...LABELLED, mic("mic-usb", "USB Microphone", "g-usb")];
  await act(async () => { target.dispatchEvent(new harness.dom.Event("devicechange")); await settle(); });
  expect(select(host, "input").value).toBe("mic-usb");
  expect(select(host, "input").options[1]!.disabled).toBe(false);
  expect(hint(host, "input")).toBeNull();
  world.devices = LABELLED;
  await act(async () => { target.dispatchEvent(new harness.dom.Event("devicechange")); await settle(); });
  expect(select(host, "input").options[1]!.disabled).toBe(true);
  expect(hint(host, "input")).toBe(translate("en", "voiceCompanion.devices.missingHint"));
});

test("during a call a different microphone is announced for the next call, and the speakers need no such line", async () => {
  const track = { label: "Microphone Array (Realtek(R) Audio)", getSettings: () => ({ deviceId: "mic-array" }), stop() {} };
  Object.defineProperty(nav.mediaDevices as object, "getUserMedia", { configurable: true, value: async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }) });
  const call = await voice.openVoiceMicrophone({});
  try {
    voice.setVoiceDeviceChoice("input", { id: "mic-pods", label: "Навушники AirPods Pro (Bluetooth)" });
    const host = await mount();
    expect(hint(host, "input")).toBe(translate("en", "voiceCompanion.devices.nextCall"));
    expect(hint(host, "output")).toBeNull();
  } finally {
    await act(async () => call.release());
  }
});
