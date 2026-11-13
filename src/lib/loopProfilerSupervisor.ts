/** Lifetime arming. The monitor reports a stall on its first recovered turn. */
export const LOOP_PROFILE_STALL_MS = 5000;
export const LOOP_PROFILE_CAPTURE_MS = 5000;
export const LOOP_PROFILE_COOLDOWN_MS = 10 * 60_000;
export const LOOP_PROFILE_POLL_MS = 1000;
export const LOOP_PROFILE_MANUAL_MAX_MS = 60_000;
export type ProfilerControl = { enabled: boolean; automatic: boolean; manualUntil: number };
export type CaptureSource = "manual" | "automatic";
/** Rechecked after asynchronous admission and native-module loading. */
export function loopProfileCaptureRefusal(settings: ProfilerControl, source: CaptureSource, at: number) {
  if (!settings.enabled) return "kill-switch";
  if (source === "automatic" && !settings.automatic) return "automatic-disabled";
  const remaining = settings.manualUntil - at;
  if (source === "manual" && !(remaining > 0 && remaining <= LOOP_PROFILE_MANUAL_MAX_MS)) return "manual-expired";
}
type Ports = {
  now(): number;
  settings(): Promise<ProfilerControl>;
  reserve(at: number): Promise<boolean>;
  beginCapture(at: number, admittedAt: number): Promise<boolean>;
  capture(source: CaptureSource, beginCapture: (at: number) => Promise<boolean>): Promise<void | string>;
  decision(reason: string): void;
};

export function createLoopProfilerSupervisor(ports: Ports) {
  let stopped = false, stalled = false, pending: Promise<void> | undefined;
  let previous = "", nextAttempt = 0;
  const decision = (reason: string) => {
    if (previous === reason) return;
    previous = reason; ports.decision(reason);
  };
  const source = (settings: ProfilerControl, automatic: boolean) => {
    const remaining = settings.manualUntil - ports.now();
    if (!settings.enabled) return "kill-switch";
    if (remaining > 0 && remaining <= LOOP_PROFILE_MANUAL_MAX_MS) return "armed-manual";
    if (!settings.automatic) return "automatic-disabled";
    return automatic ? "armed-automatic" : "waiting-for-stall";
  };
  const refresh = async () => {
    try {
      let settings = await ports.settings();
      if (stopped) return;
      const automatic = stalled; stalled = false;
      let reason = source(settings, automatic);
      if (!reason.startsWith("armed-")) { decision(reason); return; }
      if (ports.now() < nextAttempt) { decision("cooldown"); return; }
      // Persist admission BEFORE starting native sampling. A lost capture or
      // a process restart still spends this bounded diagnostic opportunity.
      const admittedAt = ports.now();
      let admitted;
      try { admitted = await ports.reserve(admittedAt); }
      catch { if (!stopped) decision("admission-unavailable"); return; }
      if (!admitted) {
        if (!stopped) { nextAttempt = ports.now() + LOOP_PROFILE_POLL_MS; decision("cooldown"); }
        return;
      }
      if (stopped) return;
      nextAttempt = admittedAt + LOOP_PROFILE_COOLDOWN_MS;
      settings = await ports.settings();
      if (stopped) return;
      reason = source(settings, automatic);
      if (!reason.startsWith("armed-")) { decision(reason); return; }
      decision(reason);
      try {
        const beginCapture = async (at: number) => {
          const began = await ports.beginCapture(at, admittedAt);
          if (began) nextAttempt = at + LOOP_PROFILE_COOLDOWN_MS;
          return began;
        };
        const refusal = await ports.capture(reason === "armed-manual" ? "manual" : "automatic", beginCapture);
        if (!stopped) decision(refusal ?? "cooldown");
      }
      catch { if (!stopped) decision("capture-failed"); }
      // A stall observed inside a capture cannot queue a second capture.
      stalled = false;
    } catch { if (!stopped) decision("settings-unavailable"); }
  };
  return {
    stall(gapMs: number) { if (!stopped && gapMs > LOOP_PROFILE_STALL_MS) stalled = true; },
    refresh(): Promise<void> {
      if (stopped) return Promise.resolve();
      return pending ??= refresh().finally(() => { pending = undefined; });
    },
    stop() { stopped = true; stalled = false; decision("stopped"); },
  };
}
