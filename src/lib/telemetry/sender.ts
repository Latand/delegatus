import fs from "node:fs";
import { environmentOff, preferences, installPingId, claimDay, telemetryFile } from "./store";
import { detectMode, type ModePorts } from "@/lib/selfUpdate/mode";
import packageInfo from "../../../package.json";
import { telemetryNotice } from "../../../bin/telemetry-notice.mjs";
import { operatorLocale } from "@/lib/operator/settings";

function productionViewer(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.LLV_STATE_OWNER === "viewer" && env.NODE_ENV === "production" &&
    !env.NEXT_PHASE?.includes("build") && !env.NEXT_PHASE?.includes("development") && !env.CI && !env.BUN_TEST && !env.JEST_WORKER_ID;
}
export function maySend(env: Readonly<Record<string, string | undefined>>): boolean {
  return productionViewer(env) && !environmentOff(env);
}
export interface PingPorts {
  env: Readonly<Record<string, string | undefined>>;
  now(): Date;
  fetch: typeof fetch;
  mode: ModePorts;
  os: string;
  arch: string;
}
export async function sendInstallPing(ports: PingPorts): Promise<void> {
  if (!maySend(ports.env) || !preferences().enabled) return;
  const mode = await detectMode(ports.mode);
  // A choice made during the mode probe must win.
  if (!maySend(ports.env) || !preferences().enabled) return;
  const kind = mode.mode === "managed" ? "docker" : mode.mode === "checkout" ? "checkout" : mode.reason === "not-a-checkout" ? "packaged" : null;
  if (!kind) return;
  const id = installPingId();
  if (!claimDay(ports.now().toISOString().slice(0, 10))) return;
  await ports.fetch("https://delegatus.org/api/ping", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, v: packageInfo.version, os: ports.os, arch: ports.arch, kind }),
    signal: AbortSignal.timeout(5000), redirect: "error", credentials: "omit",
  });
}
let started = false;
export function startInstallPing(mode: ModePorts): void {
  if (started || !productionViewer(process.env) || process.argv.includes("dev") || process.argv.includes("test")) return;
  started = true;
  try {
    const marker = telemetryFile("notice-output");
    if (!fs.existsSync(marker)) {
      console.log(telemetryNotice[operatorLocale() ?? "en"]);
      fs.mkdirSync(telemetryFile("."), { recursive: true, mode: 0o700 });
      fs.writeFileSync(marker, "1", { mode: 0o600 });
    }
  } catch { console.warn("[telemetry] notice state unavailable"); }
  if (environmentOff(process.env)) return;
  const tick = async () => {
    try {
      await sendInstallPing({ env: process.env, now: () => new Date(), fetch,
        mode, os: process.platform, arch: process.arch });
    } catch { console.warn("[telemetry] daily ping unavailable; no retry today"); }
  };
  scheduleInstallPing(tick);
}

export function scheduleInstallPing(tick: () => Promise<void>, timers = { setTimeout, setInterval }): void {
  const boot = timers.setTimeout(() => {
    void tick();
    timers.setInterval(() => { void tick(); }, 60_000).unref();
  }, 60_000);
  boot.unref();
}
