import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { captureProcessIdentity, processIdentityStatus } from "../src/lib/processIdentity";
import { stopFixtureProcess } from "../src/lib/testing/fixtureProcess";
import { serviceSurvivors } from "./owned-runner.cleanup";

function child() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
}

test("service cleanup discards a stale cgroup entry after its process exits during broker shutdown", async () => {
  const worker = child();
  const identity = captureProcessIdentity(worker.pid!);
  try {
    expect(processIdentityStatus(identity)).toBe("alive");
    const survivors = await serviceSurvivors(() => [identity.pid], async () => {
      const closed = once(worker, "close");
      worker.kill("SIGKILL");
      await closed;
    });
    expect(processIdentityStatus(identity)).toBe("dead");
    expect(survivors).toEqual([]);
  } finally { await stopFixtureProcess(worker); }
});

test("service cleanup retains a live member after broker shutdown", async () => {
  const worker = child();
  const identity = captureProcessIdentity(worker.pid!);
  try {
    expect(await serviceSurvivors(() => [identity.pid], async () => {})).toEqual([identity]);
    expect(processIdentityStatus(identity)).toBe("alive");
  } finally { await stopFixtureProcess(worker); }
});

test("service cleanup observes a new member created while broker shutdown awaits", async () => {
  const members: number[] = [];
  let worker: ReturnType<typeof child> | undefined;
  try {
    const survivors = await serviceSurvivors(() => [...members], async () => {
      await Promise.resolve();
      worker = child();
      members.push(worker.pid!);
    });
    expect(survivors).toEqual([captureProcessIdentity(worker!.pid!)]);
    expect(processIdentityStatus(survivors[0]!)).toBe("alive");
  } finally { if (worker) await stopFixtureProcess(worker); }
});

test("service cleanup keeps a shutdown refusal decisive", async () => {
  const refusal = new Error("broker shutdown refused");
  await expect(serviceSurvivors(() => [], async () => { throw refusal; })).rejects.toBe(refusal);
});
