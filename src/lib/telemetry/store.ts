import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { statePath } from "@/lib/configDir";

export const telemetryFile = (name: string) => statePath(`telemetry/${name}`);
function write(name: string, value: unknown): void {
  const file = telemetryFile(name);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, { force: true }); }
}
export function preferences(): { enabled: boolean; noticeDismissed: boolean } {
  const file = telemetryFile("preferences.json");
  if (!fs.existsSync(file)) return { enabled: true, noticeDismissed: false };
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  if (typeof data.enabled !== "boolean" || typeof data.noticeDismissed !== "boolean") throw new Error("Invalid telemetry preferences");
  return { enabled: data.enabled, noticeDismissed: data.noticeDismissed };
}
export function updatePreferences(update: { enabled?: boolean; noticeDismissed?: boolean }): void {
  write("preferences.json", { ...preferences(), ...update });
}
export function environmentOff(env: Readonly<Record<string, string | undefined>>): boolean {
  const telemetry = env.LLV_TELEMETRY_OVERRIDE || env.DELEGATUS_TELEMETRY || env.LLV_TELEMETRY;
  const doNotTrack = env.DO_NOT_TRACK_OVERRIDE || env.DO_NOT_TRACK;
  return telemetry === "0" || doNotTrack === "1";
}
export function telemetryStatus(env: Readonly<Record<string, string | undefined>> = process.env) {
  const p = preferences();
  return { ...p, enabled: p.enabled && !environmentOff(env), locked: environmentOff(env) };
}
// Mint independently; never read the linked-install identity.
export function installPingId(): string {
  const file = telemetryFile("id");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, randomUUID(), { mode: 0o600, flag: "wx" });
    try { fs.linkSync(tmp, file); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  } finally { fs.rmSync(tmp, { force: true }); }
  const id = fs.readFileSync(file, "utf8");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error("Invalid telemetry id");
  return id;
}
// Exclusive claims survive restarts and release overlap, including failed sends.
export function claimDay(day: string): boolean {
  const file = telemetryFile(`days/${day}`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { fs.closeSync(fs.openSync(file, "wx", 0o600)); return true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") return false; throw e; }
}
