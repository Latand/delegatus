import fs from "node:fs";
import path from "node:path";
import { checkFixtureParent } from "@/lib/testing/fixtureLifetime";

// Longer than the longest parent race test; still finite if the runner hangs.
export const FIXTURE_BARRIER_TIMEOUT_MS = 120_000;

function checkBarrier(filename: string, deadline: number): void {
  checkFixtureParent();
  if (!fs.existsSync(path.dirname(filename))) process.exit(87);
  if (Date.now() >= deadline) process.exit(88);
}

export function waitForFixtureFile(filename: string): void {
  const deadline = Date.now() + FIXTURE_BARRIER_TIMEOUT_MS;
  while (!fs.existsSync(filename)) {
    checkBarrier(filename, deadline);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
}

export async function awaitFixtureFile(filename: string): Promise<void> {
  const deadline = Date.now() + FIXTURE_BARRIER_TIMEOUT_MS;
  while (!fs.existsSync(filename)) {
    checkBarrier(filename, deadline);
    await Bun.sleep(25);
  }
}

export function waitUntilFixtureTime(targetMs: number, fixtureFile: string): void {
  const deadline = Date.now() + FIXTURE_BARRIER_TIMEOUT_MS;
  if (!Number.isFinite(targetMs)) process.exit(88);
  let nextCheck = 0;
  while (Date.now() < targetMs) {
    if (Date.now() >= nextCheck) {
      checkBarrier(fixtureFile, deadline);
      nextCheck = Date.now() + 25;
    }
  }
}
