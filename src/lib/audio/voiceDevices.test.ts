import { afterEach, beforeEach, expect, test } from "bun:test";

import {
  activeVoiceInput,
  attachVoiceOutput,
  configureVoiceDeviceStorage,
  listVoiceDevices,
  openVoiceMicrophone,
  outputChoiceSupported,
  releaseVoiceMicrophone,
  resolveVoiceChoice,
  setVoiceDeviceChoice,
  voiceDeviceChoice,
  voiceOutputFellBack,
  VOICE_INPUT_KEY,
  VOICE_OUTPUT_KEY,
} from "./voiceDevices";

const originals = new Map<string, PropertyDescriptor | undefined>();
function install(name: string, value: unknown) {
  if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

function memoryStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
}

type Info = Pick<MediaDeviceInfo, "deviceId" | "kind" | "label" | "groupId">;
const mic = (deviceId: string, label: string, groupId = deviceId): Info => ({ deviceId, kind: "audioinput", label, groupId });
const speaker = (deviceId: string, label: string, groupId = deviceId): Info => ({ deviceId, kind: "audiooutput", label, groupId });
const DEVICES: Info[] = [
  mic("default", "Default - Headset Mic", "g-headset"),
  mic("communications", "Communications - Headset Mic", "g-headset"),
  mic("mic-headset", "Headset Mic", "g-headset"),
  mic("mic-array", "Microphone Array (Realtek(R) Audio)", "g-array"),
  speaker("default", "Default - Headphones", "g-headset"),
  speaker("spk-headset", "Headphones", "g-headset"),
  speaker("spk-desk", "Desk speakers", "g-desk"),
];

/** A fake navigator.mediaDevices that records what getUserMedia was asked for. */
function fakeDevices(options: { devices?: Info[]; refuse?: (constraints: MediaStreamConstraints) => Error | null; settingsId?: string } = {}) {
  const asked: MediaStreamConstraints[] = [];
  const target = new EventTarget();
  const state = { devices: options.devices ?? DEVICES };
  const mediaDevices = Object.assign(target, {
    enumerateDevices: async () => state.devices as MediaDeviceInfo[],
    getUserMedia: async (constraints: MediaStreamConstraints) => {
      asked.push(constraints);
      const refusal = options.refuse?.(constraints);
      if (refusal) throw refusal;
      const exact = ((constraints.audio as MediaTrackConstraints | undefined)?.deviceId as ConstrainDOMStringParameters | undefined)?.exact;
      const id = options.settingsId ?? (typeof exact === "string" ? exact : "default");
      const track = { label: state.devices.find(device => device.deviceId === id)?.label ?? "", getSettings: () => ({ deviceId: id }), stop() {} };
      return { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
    },
  });
  install("navigator", { mediaDevices });
  return { asked, state, target };
}

const named = (name: string, message = name) => Object.assign(new Error(message), { name });

beforeEach(() => configureVoiceDeviceStorage(memoryStorage()));
afterEach(() => {
  configureVoiceDeviceStorage(undefined);
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originals.clear();
});

test("the choice is stored per kind as id and label, and System default removes the key", () => {
  const storage = memoryStorage();
  configureVoiceDeviceStorage(storage);
  expect(voiceDeviceChoice("input")).toBeNull();
  setVoiceDeviceChoice("input", { id: "mic-array", label: "Microphone Array (Realtek(R) Audio)" });
  setVoiceDeviceChoice("output", { id: "spk-desk", label: "Desk speakers" });
  expect(JSON.parse(storage.data.get(VOICE_INPUT_KEY)!)).toEqual({ id: "mic-array", label: "Microphone Array (Realtek(R) Audio)" });
  expect(JSON.parse(storage.data.get(VOICE_OUTPUT_KEY)!)).toEqual({ id: "spk-desk", label: "Desk speakers" });
  setVoiceDeviceChoice("input", null);
  expect(storage.data.has(VOICE_INPUT_KEY)).toBe(false);
  expect(voiceDeviceChoice("input")).toBeNull();
  expect(voiceDeviceChoice("output")?.id).toBe("spk-desk");
});

test("a stored value that is not a choice reads as System default", () => {
  configureVoiceDeviceStorage(memoryStorage({ [VOICE_INPUT_KEY]: "not json", [VOICE_OUTPUT_KEY]: JSON.stringify({ id: 7 }) }));
  expect(voiceDeviceChoice("input")).toBeNull();
  expect(voiceDeviceChoice("output")).toBeNull();
  configureVoiceDeviceStorage(null);
  expect(voiceDeviceChoice("input")).toBeNull();
});

test("the list drops pseudo entries and names the device behind default through its group", async () => {
  fakeDevices();
  const list = await listVoiceDevices();
  expect(list.inputs.map(entry => entry.id)).toEqual(["mic-headset", "mic-array"]);
  expect(list.outputs.map(entry => entry.id)).toEqual(["spk-headset", "spk-desk"]);
  expect(list.defaultInputName).toBe("Headset Mic");
  expect(list.defaultOutputName).toBe("Headphones");
  expect(list.labelled).toBe(true);
});

test("without permission every label is empty and entries with no id are dropped", async () => {
  fakeDevices({ devices: [mic("", ""), speaker("", "")] });
  expect(await listVoiceDevices()).toEqual({ inputs: [], outputs: [], defaultInputName: null, defaultOutputName: null, labelled: false });
  fakeDevices({ devices: [mic("m1", ""), speaker("s1", "")] });
  const list = await listVoiceDevices();
  expect(list.labelled).toBe(false);
  expect(list.inputs).toEqual([{ id: "m1", label: "" }]);
});

test("a missing or refusing enumerate reads as an empty unlabelled list", async () => {
  install("navigator", {});
  expect((await listVoiceDevices()).labelled).toBe(false);
  install("navigator", { mediaDevices: { enumerateDevices: async () => { throw new Error("refused"); } } });
  expect((await listVoiceDevices()).inputs).toEqual([]);
});

test("a choice resolves by id, by exact name after the browser rotated ids, and is missing otherwise", () => {
  const entries = [{ id: "a", label: "Headset Mic" }, { id: "b", label: "Array" }];
  expect(resolveVoiceChoice(null, entries, true)).toEqual({ state: "default" });
  expect(resolveVoiceChoice({ id: "b", label: "old name" }, entries, true)).toEqual({ state: "present", id: "b", label: "Array" });
  expect(resolveVoiceChoice({ id: "rotated", label: "Headset Mic" }, entries, true)).toEqual({ state: "present", id: "a", label: "Headset Mic" });
  expect(resolveVoiceChoice({ id: "rotated", label: "Gone" }, entries, true)).toEqual({ state: "missing", label: "Gone" });
  /* Names withheld: nothing can be told, so the stored id is trusted. */
  expect(resolveVoiceChoice({ id: "rotated", label: "Gone" }, [], false)).toEqual({ state: "present", id: "rotated", label: "Gone" });
});

test("with no choice the microphone opens without a device constraint", async () => {
  const media = fakeDevices();
  const opened = await openVoiceMicrophone({ echoCancellation: true });
  expect(media.asked).toEqual([{ audio: { echoCancellation: true } }]);
  expect(opened.fellBack).toBe(false);
  expect(activeVoiceInput()).toEqual({ label: "Headset Mic", fellBack: false });
  opened.release();
  expect(activeVoiceInput()).toBeNull();
});

test("a stored id becomes an exact deviceId and the active input names that microphone", async () => {
  const media = fakeDevices();
  setVoiceDeviceChoice("input", { id: "mic-array", label: "Microphone Array (Realtek(R) Audio)" });
  const opened = await openVoiceMicrophone({ echoCancellation: true, noiseSuppression: true });
  expect(media.asked).toEqual([{ audio: { echoCancellation: true, noiseSuppression: true, deviceId: { exact: "mic-array" } } }]);
  expect(opened.fellBack).toBe(false);
  expect(activeVoiceInput()).toEqual({ label: "Microphone Array (Realtek(R) Audio)", fellBack: false });
  releaseVoiceMicrophone(opened.stream);
  expect(activeVoiceInput()).toBeNull();
});

test("a rotated id is found by its name before the call opens", async () => {
  const media = fakeDevices();
  setVoiceDeviceChoice("input", { id: "stale-id", label: "Microphone Array (Realtek(R) Audio)" });
  const opened = await openVoiceMicrophone({});
  expect(media.asked).toEqual([{ audio: { deviceId: { exact: "mic-array" } } }]);
  expect(opened.fellBack).toBe(false);
});

test("a chosen microphone that is not listed opens the default and says so, keeping the choice", async () => {
  const media = fakeDevices();
  setVoiceDeviceChoice("input", { id: "unplugged", label: "USB Mic" });
  const opened = await openVoiceMicrophone({ echoCancellation: true });
  expect(media.asked).toEqual([{ audio: { echoCancellation: true } }]);
  expect(opened.fellBack).toBe(true);
  expect(activeVoiceInput()?.fellBack).toBe(true);
  expect(voiceDeviceChoice("input")).toEqual({ id: "unplugged", label: "USB Mic" });
});

test("the browser's own refusal of the id retries without a deviceId and sets fellBack", async () => {
  for (const kind of ["OverconstrainedError", "NotFoundError"]) {
    /* Names withheld, so the stored id is tried and the browser answers. */
    const media = fakeDevices({ devices: [mic("m1", "")], refuse: constraints => (constraints.audio as MediaTrackConstraints).deviceId ? named(kind) : null });
    setVoiceDeviceChoice("input", { id: "m-old", label: "USB Mic" });
    const opened = await openVoiceMicrophone({ echoCancellation: true });
    expect(media.asked).toEqual([
      { audio: { echoCancellation: true, deviceId: { exact: "m-old" } } },
      { audio: { echoCancellation: true } },
    ]);
    expect(opened.fellBack).toBe(true);
    opened.release();
  }
});

test("a permission refusal reaches the caller unchanged and leaves no active input", async () => {
  fakeDevices({ devices: [mic("m1", "")], refuse: () => named("NotAllowedError", "Permission denied") });
  setVoiceDeviceChoice("input", { id: "m1", label: "" });
  await expect(openVoiceMicrophone({})).rejects.toMatchObject({ name: "NotAllowedError" });
  expect(activeVoiceInput()).toBeNull();
});

test("a second call's release does not clear the first call's record", async () => {
  fakeDevices();
  const first = await openVoiceMicrophone({});
  const second = await openVoiceMicrophone({});
  first.release();
  expect(activeVoiceInput()).not.toBeNull();
  second.release();
  expect(activeVoiceInput()).toBeNull();
});

// ---- speakers -------------------------------------------------------------

class FakeAudio {
  sinks: string[] = [];
  reject = new Set<string>();
  async setSinkId(id: string) {
    this.sinks.push(id);
    if (this.reject.has(id)) throw named("NotFoundError");
  }
}
const asAudio = (audio: FakeAudio) => audio as unknown as HTMLAudioElement;
const settled = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function withSinkSupport() {
  install("HTMLMediaElement", class { setSinkId() {} });
}

test("without setSinkId the output choice is unsupported and attach does nothing", async () => {
  install("HTMLMediaElement", class {});
  fakeDevices();
  setVoiceDeviceChoice("output", { id: "spk-desk", label: "Desk speakers" });
  expect(outputChoiceSupported()).toBe(false);
  const audio = new FakeAudio();
  const detach = attachVoiceOutput(asAudio(audio));
  await settled();
  expect(audio.sinks).toEqual([]);
  expect(voiceOutputFellBack()).toBe(false);
  detach();
  Reflect.deleteProperty(globalThis, "HTMLMediaElement");
  expect(outputChoiceSupported()).toBe(false);
});

test("the stored speakers are applied, a change in settings reaches a live call, and System default restores the default", async () => {
  withSinkSupport();
  fakeDevices();
  expect(outputChoiceSupported()).toBe(true);
  const audio = new FakeAudio();
  setVoiceDeviceChoice("output", { id: "spk-desk", label: "Desk speakers" });
  const detach = attachVoiceOutput(asAudio(audio));
  await settled();
  expect(audio.sinks).toEqual(["spk-desk"]);
  setVoiceDeviceChoice("output", { id: "spk-headset", label: "Headphones" });
  await settled();
  setVoiceDeviceChoice("output", null);
  await settled();
  expect(audio.sinks).toEqual(["spk-desk", "spk-headset", ""]);
  expect(voiceOutputFellBack()).toBe(false);
  detach();
  setVoiceDeviceChoice("output", { id: "spk-desk", label: "Desk speakers" });
  await settled();
  expect(audio.sinks).toHaveLength(3);
});

test("with no choice an attached element is left on the default sink", async () => {
  withSinkSupport();
  fakeDevices();
  const audio = new FakeAudio();
  const detach = attachVoiceOutput(asAudio(audio));
  await settled();
  expect(audio.sinks).toEqual([]);
  detach();
});

test("a sink the browser rejects falls back to the default with the fallback recorded until the call ends", async () => {
  withSinkSupport();
  fakeDevices({ devices: [speaker("spk-1", "")] });
  setVoiceDeviceChoice("output", { id: "spk-1", label: "Desk speakers" });
  const audio = new FakeAudio();
  audio.reject.add("spk-1");
  const detach = attachVoiceOutput(asAudio(audio));
  await settled();
  expect(audio.sinks).toEqual(["spk-1", ""]);
  expect(voiceOutputFellBack()).toBe(true);
  detach();
  expect(voiceOutputFellBack()).toBe(false);
});

test("a chosen sink that is no longer listed plays through the default without asking for it", async () => {
  withSinkSupport();
  fakeDevices();
  setVoiceDeviceChoice("output", { id: "gone", label: "Bluetooth speaker" });
  const audio = new FakeAudio();
  const detach = attachVoiceOutput(asAudio(audio));
  await settled();
  expect(audio.sinks).toEqual([]);
  expect(voiceOutputFellBack()).toBe(true);
  detach();
});

test("a devicechange that drops the sink sends playback to the default, and replugging restores it", async () => {
  withSinkSupport();
  const media = fakeDevices();
  setVoiceDeviceChoice("output", { id: "spk-desk", label: "Desk speakers" });
  const audio = new FakeAudio();
  const detach = attachVoiceOutput(asAudio(audio));
  await settled();
  expect(audio.sinks).toEqual(["spk-desk"]);
  media.state.devices = DEVICES.filter(device => device.deviceId !== "spk-desk");
  media.target.dispatchEvent(new Event("devicechange"));
  await settled();
  expect(audio.sinks).toEqual(["spk-desk", ""]);
  expect(voiceOutputFellBack()).toBe(true);
  expect(voiceDeviceChoice("output")?.id).toBe("spk-desk");
  media.state.devices = DEVICES;
  media.target.dispatchEvent(new Event("devicechange"));
  await settled();
  expect(audio.sinks).toEqual(["spk-desk", "", "spk-desk"]);
  expect(voiceOutputFellBack()).toBe(false);
  detach();
  media.target.dispatchEvent(new Event("devicechange"));
  await settled();
  expect(audio.sinks).toHaveLength(3);
});
