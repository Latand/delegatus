import fs from "node:fs/promises";
import path from "node:path";
import { withFileTransactionAsync } from "./state/fileTransaction";
import { LOOP_PROFILE_BYTES, type LoopGapProfile } from "./loopProfiler";
import { LOOP_PROFILE_COOLDOWN_MS } from "./loopProfilerSupervisor";

export const LOOP_PROFILE_STORED_CAP = 12;
export const LOOP_PROFILE_STORE_BYTES = LOOP_PROFILE_STORED_CAP * (LOOP_PROFILE_BYTES + 256) + 1024;
type StoredProfile = { revision: string; capturedAt: number; profile: LoopGapProfile };
type Ledger = { nextCaptureAt: number; profiles: StoredProfile[] };

/** One bounded summary ring and a durable cooldown, independent of revision.
 * All I/O and lock waits are asynchronous; lock admission has a 100 ms bound. */
export function createLoopProfileStore(directory: string) {
  const file = path.join(directory, "loop-profiler-captures.json");
  const read = async (): Promise<Ledger> => {
    let handle;
    try {
      handle = await fs.open(file, "r");
      const buffer = Buffer.alloc(LOOP_PROFILE_STORE_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > LOOP_PROFILE_STORE_BYTES) throw new Error("profile-store-invalid");
      const value = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
      if (!Number.isFinite(value.nextCaptureAt) || value.nextCaptureAt < 0 || !Array.isArray(value.profiles)
        || value.profiles.length > LOOP_PROFILE_STORED_CAP
        || value.profiles.some((row: StoredProfile) => !row || typeof row.revision !== "string" || !/^[a-f0-9]{7,40}$/.test(row.revision)
          || !Number.isSafeInteger(row.capturedAt) || row.capturedAt < 0
          || !row.profile || row.profile.status !== "captured"
          || Buffer.byteLength(JSON.stringify(row.profile)) > LOOP_PROFILE_BYTES)) throw new Error("profile-store-invalid");
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { nextCaptureAt: 0, profiles: [] };
      throw error;
    } finally { await handle?.close(); }
  };
  const write = async (ledger: Ledger) => {
    const text = JSON.stringify(ledger);
    if (Buffer.byteLength(text) > LOOP_PROFILE_STORE_BYTES) throw new Error("profile-store-invalid");
    await fs.writeFile(`${file}.next`, text, { mode: 0o600 });
    await fs.rename(`${file}.next`, file);
  };
  const transaction = async <T>(work: () => Promise<T>) => {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    return withFileTransactionAsync(file, "profile-store-busy", work, { waitMs: 100 });
  };
  return {
    reserve: (at: number) => transaction(async () => {
      if (!Number.isSafeInteger(at) || at < 0 || at > Number.MAX_SAFE_INTEGER - LOOP_PROFILE_COOLDOWN_MS) throw new Error("profile-store-invalid");
      const ledger = await read();
      if (at < ledger.nextCaptureAt) return false;
      ledger.nextCaptureAt = at + LOOP_PROFILE_COOLDOWN_MS;
      await write(ledger); return true;
    }),
    save: (profile: LoopGapProfile, revision: string, capturedAt: number) => transaction(async () => {
      if (profile.status !== "captured" || Buffer.byteLength(JSON.stringify(profile)) > LOOP_PROFILE_BYTES
        || typeof revision !== "string" || !/^[a-f0-9]{7,40}$/.test(revision) || !Number.isSafeInteger(capturedAt) || capturedAt < 0) throw new Error("profile-store-invalid");
      const ledger = await read();
      ledger.profiles.push({ revision, capturedAt, profile });
      ledger.profiles = ledger.profiles.slice(-LOOP_PROFILE_STORED_CAP);
      await write(ledger);
    }),
  };
}
