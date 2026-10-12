import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";
import { RUNTIME_JOURNAL_BUSY_TIMEOUT_MS, RuntimeJournal } from "./journal";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "journal-open-contention-"));
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));
const linux = process.platform === "linux";

function existingJournal(name: string): string {
  const filename = path.join(directory, name);
  new RuntimeJournal(filename).close();
  return filename;
}

/** Another process in WAL recovery on `filename`, for `holdMs` or until stopped. */
async function recovering(filename: string, holdMs = 0): Promise<{ stop: () => Promise<void> }> {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/walRecoveryLockHolder.ts"), `${filename}-shm`, String(holdMs)], { stdout: "pipe", stderr: "inherit" });
  const { value } = await child.stdout.getReader().read();
  if (!new TextDecoder().decode(value).startsWith("held")) throw new Error("the recovery lock holder did not start");
  return { stop: async () => { child.kill(); await child.exited; } };
}

test.skipIf(!linux)("an open waits while another process recovers the WAL", async () => {
  const filename = existingJournal("released.sqlite");
  const holder = await recovering(filename, 1000);
  try {
    const started = performance.now();
    const journal = await RuntimeJournal.open(filename);
    const waitedMs = performance.now() - started;
    try {
      expect(journal.isWritable()).toBe(true);
      expect(journal.claimHostEpoch()).toBeGreaterThan(0);
    } finally { journal.close(); }
    expect(waitedMs).toBeGreaterThanOrEqual(900);
    expect(waitedMs).toBeLessThan(RUNTIME_JOURNAL_BUSY_TIMEOUT_MS);
  } finally { await holder.stop(); }
}, 30_000);

test.skipIf(!linux)("an open refuses by name after the bound when the recovery lock never clears", async () => {
  const filename = existingJournal("persistent.sqlite");
  const holder = await recovering(filename);
  try {
    const started = performance.now();
    let refusal: (Error & { code?: string }) | undefined;
    try { (await RuntimeJournal.open(filename)).close(); } catch (error) { refusal = error as Error & { code?: string }; }
    const waitedMs = performance.now() - started;
    expect(refusal?.message).toBe(`runtime journal is still locked by another process after waiting ${RUNTIME_JOURNAL_BUSY_TIMEOUT_MS} ms (SQLITE_BUSY_RECOVERY)`);
    expect(refusal?.code).toBe("SQLITE_BUSY_RECOVERY");
    expect(waitedMs).toBeGreaterThanOrEqual(RUNTIME_JOURNAL_BUSY_TIMEOUT_MS - 500);
    expect(waitedMs).toBeLessThan(RUNTIME_JOURNAL_BUSY_TIMEOUT_MS + 10_000);
  } finally { await holder.stop(); }
  // The refused open left nothing behind that blocks the next one.
  const journal = await RuntimeJournal.open(filename);
  try { expect(journal.isWritable()).toBe(true); } finally { journal.close(); }
}, 60_000);

test("an uncontended open does not wait", async () => {
  const filename = existingJournal("uncontended.sqlite");
  const started = performance.now();
  (await RuntimeJournal.open(filename)).close();
  expect(performance.now() - started).toBeLessThan(1000);
});
