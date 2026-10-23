/*
 * A page-side stub of `navigator.mediaDevices` and `navigator.permissions` for the browser drivers that read the voice
 * device picker (docs/design/voice-device-picker.md). Handed to `addInitScript`, so it runs in the page before its own
 * scripts and must not refer to anything outside its body. `?dev=<state>` picks the scene: `default`, `chosen`, `gone`
 * (the stored devices are not connected), `noperm` (names withheld until Show devices), `denied`, `nosink` (no
 * `setSinkId`), and `callchosen` / `callgone` for a call whose stored microphone is present or missing.
 */
export function stubVoiceDevices(): void {
  const state = new URLSearchParams(location.search).get("dev");
  if (!state) return;
  const info = (deviceId: string, kind: string, label: string, groupId: string) => ({ deviceId, kind, label, groupId });
  const FULL = [
    info("default", "audioinput", "Default - Microphone Array (Realtek(R) Audio)", "g-array"),
    info("communications", "audioinput", "Communications - Microphone Array (Realtek(R) Audio)", "g-array"),
    info("mic-array", "audioinput", "Microphone Array (Realtek(R) Audio)", "g-array"),
    info("mic-pods", "audioinput", "Навушники AirPods Pro (Bluetooth)", "g-pods"),
    info("mic-yeti", "audioinput", "USB Audio Device (Blue Yeti Nano)", "g-yeti"),
    info("default", "audiooutput", "Default - Speakers (Realtek(R) Audio)", "g-array"),
    info("spk-array", "audiooutput", "Speakers (Realtek(R) Audio)", "g-array"),
    info("spk-pods", "audiooutput", "Навушники AirPods Pro (Bluetooth)", "g-pods"),
    info("spk-monitor", "audiooutput", "DELL U2723QE (NVIDIA High Definition Audio)", "g-monitor"),
  ];
  const HIDDEN = [info("", "audioinput", "", ""), info("", "audiooutput", "", "")];
  const seeds: Record<string, Record<string, { id: string; label: string }>> = {
    chosen: { llvVoiceInputDevice: { id: "mic-pods", label: "Навушники AirPods Pro (Bluetooth)" }, llvVoiceOutputDevice: { id: "spk-monitor", label: "DELL U2723QE (NVIDIA High Definition Audio)" } },
    callchosen: { llvVoiceInputDevice: { id: "mic-pods", label: "Навушники AirPods Pro (Bluetooth)" } },
    gone: { llvVoiceInputDevice: { id: "mic-gone", label: "Конференц-мікрофон Jabra Speak 750" }, llvVoiceOutputDevice: { id: "spk-gone", label: "Bluetooth Speaker (JBL Flip 6)" } },
    callgone: { llvVoiceInputDevice: { id: "mic-gone", label: "Конференц-мікрофон Jabra Speak 750" } },
  };
  for (const [key, value] of Object.entries(seeds[state] ?? {})) localStorage.setItem(key, JSON.stringify(value));
  let granted = state !== "noperm" && state !== "denied";
  const mediaDevices = Object.assign(new EventTarget(), {
    enumerateDevices: async () => (granted ? FULL : HIDDEN),
    getUserMedia: async (constraints: { audio?: { deviceId?: { exact?: string } } }) => {
      if (state === "denied") throw Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
      granted = true;
      const id = constraints.audio?.deviceId?.exact ?? "default";
      const track = { enabled: true, label: FULL.find((device) => device.deviceId === id && device.kind === "audioinput")?.label ?? "", getSettings: () => ({ deviceId: id }), stop() {} };
      return { getTracks: () => [track], getAudioTracks: () => [track] };
    },
  });
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: mediaDevices });
  Object.defineProperty(navigator, "permissions", { configurable: true, value: { query: async () => ({ state: state === "denied" ? "denied" : granted ? "granted" : "prompt" }) } });
  if (state === "nosink") delete (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId;
  else if (!("setSinkId" in HTMLMediaElement.prototype)) Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", { configurable: true, value: async () => undefined });
}
