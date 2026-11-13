import fs from "node:fs/promises";
import path from "node:path";
import { statePath } from "./configDir";
import { withFileTransaction } from "./state/fileTransaction";
import { createLoopProfiler, LOOP_PROFILE_ARM_MS } from "./loopProfiler";
import { createLoopLogSink, type createViewerLoopMonitor } from "./viewerLoopMonitor";
import { createLoopProfilerSupervisor, loopProfileCaptureRefusal, LOOP_PROFILE_CAPTURE_MS, LOOP_PROFILE_POLL_MS, LOOP_PROFILE_STALL_MS, type ProfilerControl } from "./loopProfilerSupervisor";
import { createLoopProfileStore } from "./loopProfilerStore";
import type { LoopGapProfile, LoopProfilerPorts } from "./loopProfiler";

/** Tiny diagnostic settings/ledger reads cannot materialize arbitrary files. */
async function readSmall(file: string) {
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(513);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 512) throw new Error("oversized profiler configuration");
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally { await handle.close(); }
}

/** Armed by default: only a settings file that explicitly holds
 * {"enabled": false} switches the profiler off. An absent or unreadable file
 * leaves it on. */
export async function loopProfilerEnabled(directory: string) {
  try { return (await readSmall(path.join(directory, "loop-profiler.json")))?.enabled !== false; }
  catch { return true; }
}

/** Existing operator surface; missing/invalid files preserve default-on policy. */
export async function loopProfilerControl(directory: string): Promise<ProfilerControl> {
  let settings;
  try { settings = await readSmall(path.join(directory, "loop-profiler.json")); } catch { /* default policy */ }
  return { enabled: settings?.enabled !== false, automatic: settings?.automatic !== false,
    manualUntil: typeof settings?.manualUntil === "number" && Number.isFinite(settings.manualUntil) ? settings.manualUntil : 0 };
}

/** Legacy duration reader retained for old diagnostic callers. Serving now
 * uses lifetime control and ignores armMinutes. */
export async function loopProfilerSettings(directory: string, report = (message: string) => console.warn(message)) {
  let settings;
  try { settings = await readSmall(path.join(directory, "loop-profiler.json")); }
  catch { return { enabled: true, armMs: LOOP_PROFILE_ARM_MS }; }
  const minutes = settings?.armMinutes;
  let armMs = LOOP_PROFILE_ARM_MS;
  if (minutes !== undefined) {
    if (typeof minutes === "number" && Number.isFinite(minutes) && minutes >= 30 && minutes <= 120) armMs = minutes * 60_000;
    else report("[loop-profiler] invalid armMinutes; expected a number from 30 to 120; using 30 minutes");
  }
  return { enabled: settings?.enabled !== false, armMs };
}

/** Native compiled fixture target; kept beside the serving recorder so the
 * verification can sample a callable emitted into the production bundle. */
export function syntheticThreeSecondBlockForProfilerFixture() {
  const until = performance.now() + 3000;
  let value = 0;
  while (performance.now() < until) value += Math.sqrt(value + 1) % 123;
  return value;
}

/** Legacy claim API, unused by serving. First start consumes its opportunity even if the
 * kill switch is set.
 * Same-revision restarts cannot renew the in-memory arm budget. */
export async function claimLoopProfilerDeploy(directory: string, revision: string, at: number) {
  if (!/^[a-f0-9]{7,40}$/.test(revision)) return false;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const ledger = path.join(directory, "loop-profiler-deploy.json");
  return withFileTransaction(ledger, "profiler deploy ledger busy", async () => {
    try { if ((await readSmall(ledger)).revision === revision) return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
    // A fixed sibling under the transaction lock, atomic across a crash.
    const temporary = `${ledger}.next`;
    await fs.writeFile(temporary, JSON.stringify({ revision, startedAt: at }), { mode: 0o600 });
    await fs.rename(temporary, ledger);
    return true;
  });
}

export async function startServingLoopProfiler(monitor: ReturnType<typeof createViewerLoopMonitor>, env = process.env,
  injected: Partial<Pick<LoopProfilerPorts, "collect" | "sleep" | "now">> & { wallNow?: () => number; decision?: (reason: string) => void; poll?: false; afterBeginCapturePersistence?: () => Promise<void> } = {}) {
  if (env.LLV_STATE_OWNER !== "viewer" || env.NODE_ENV !== "production" || !process.versions.bun || env.NEXT_PHASE?.includes("build")) return;
  const revision = [env.LLV_DIAGNOSTIC_REVISION, env.LLV_HOT_STATE_RELEASE_REVISION].find(value => value && /^[a-f0-9]{7,40}$/.test(value)) ?? "";
  if (!/^[a-f0-9]{7,40}$/.test(revision)) return;
  const directory = path.dirname(statePath("loop-profiler.json"));
  // Diagnostic refusal must never stop serving. No raw errors or paths log.
  try {
    const now = injected.now ?? (() => performance.now());
    const store = createLoopProfileStore(directory, { afterBeginCapturePersistence: injected.afterBeginCapturePersistence });
    const decisions = createLoopLogSink();
    let active: ReturnType<typeof createLoopProfiler> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const supervisor = createLoopProfilerSupervisor({ now: injected.wallNow ?? Date.now,
      settings: () => monitor.run("loop-profiler.settings", () => loopProfilerControl(directory)),
      reserve: at => monitor.run("loop-profiler.settings", () => store.reserve(at)),
      beginCapture: (at, admittedAt) => monitor.run("loop-profiler.settings", () => store.beginCapture(at, admittedAt)),
      cancel: admittedAt => monitor.run("loop-profiler.settings", async () => { await store.cancelCapture(admittedAt); }),
      complete: (startedAt, admittedAt) => monitor.run("loop-profiler.settings", async () => { await store.completeCapture(startedAt, admittedAt); }),
      decision: injected.decision ?? (reason => decisions.enqueue(`[loop-profiler] ${reason}`)),
      capture: async (source, beginCapture, captureStarted) => {
        // Only an admitted capture loads the Bun builtin. Idle polling does
        // not sample stacks or read source files.
        const collect = injected.collect ?? (await monitor.run("loop-profiler.settings", () => import(/* webpackIgnore: true */ "bun:jsc"))).profile;
        let refusal: string | undefined;
        const enabled = async () => {
          const control = await monitor.run("loop-profiler.settings", () => loopProfilerControl(directory));
          refusal = stopped ? "stopped" : loopProfileCaptureRefusal(control, source, (injected.wallNow ?? Date.now)());
          return !refusal;
        };
        if (!await enabled()) return refusal;
        let captured: LoopGapProfile | undefined;
        const recorder = active = createLoopProfiler({ now,
          enabled, collect,
          beforeCollect: async () => {
            const began = await beginCapture((injected.wallNow ?? Date.now)());
            if (!began) refusal = "cooldown";
            return began;
          },
          captureStarted,
          sleep: injected.sleep ?? (ms => new Promise(resolve => { const timeout = setTimeout(resolve, ms); timeout.unref(); })),
          flushTick: () => monitor.tick(), root: process.cwd(),
          phase: (phase, work) => monitor.run(`loop-profiler.${phase}`, work),
          completed: profile => { captured = profile; },
        }, now() + LOOP_PROFILE_CAPTURE_MS);
        try {
          await recorder.start();
          if (!captured) { if (refusal) return refusal; throw new Error("capture-failed"); }
          await monitor.run("loop-profiler.settings", () => store.save(captured!, revision, (injected.wallNow ?? Date.now)()));
        } finally {
          recorder.stop(); if (active === recorder) active = undefined;
        }
      },
    });
    monitor.setProfiler({
      correlate(from, to, gapMs, emit) {
        supervisor.stall(gapMs);
        if (gapMs > LOOP_PROFILE_STALL_MS) void supervisor.refresh();
        if (active) return active.correlate(from, to, gapMs, emit);
        if (gapMs < 2000) return false;
        emit({ status: "not-armed", reason: "waiting-for-capture" }); return true;
      },
      start: async () => {},
      stop() { stopped = true; if (timer) clearTimeout(timer); supervisor.stop(); active?.stop(); },
    });
    const poll = async () => {
      await supervisor.refresh();
      if (!stopped && injected.poll !== false) { timer = setTimeout(() => { void poll(); }, LOOP_PROFILE_POLL_MS); timer.unref(); }
    };
    await poll();
    return supervisor;
  } catch { /* Fail closed: serving and the existing monitor remain available. */ }
}
