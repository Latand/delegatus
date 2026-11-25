// destructive-code: no received command is ever executed by the SSH double.
import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { makeHarness, normalizeRunnerOutput } from "./harness.fixture";
import { admissionLockWait } from "../cpu-admission-lock";

test("runner parity ignores queue timings emitted by admission and preserves its failure", async () => {
  for (const extra of [0, 37]) {
    let now = 0, calls = 0;
    const lines: string[] = [];
    await admissionLockWait(1000, line => lines.push(line), {
      now: () => now, sleep: async ms => { now += ms + extra; },
    })(() => { if (calls++ === 0) throw Object.assign(new Error("fixture lock"), { code: "SQLITE_BUSY" }); return "ok"; });
    expect(lines).toHaveLength(2);
    expect(normalizeRunnerOutput(lines.join("\n") + "\napplication output\n")).toBe("application output\n");
  }
  let now = 0;
  const lines: string[] = [];
  const failure = await admissionLockWait(50, line => lines.push(line), {
    now: () => now, sleep: async ms => { now += ms; },
  })<never>(() => { throw Object.assign(new Error("fixture lock"), { code: "SQLITE_LOCKED" }); }).catch(error => error as Error);
  expect(failure).toBeInstanceOf(Error);
  expect(normalizeRunnerOutput(lines.join("\n") + "\n" + failure.message + "\n")).toBe(failure.message + "\n");
});

test("runner parity ignores every admission progress line and keeps other gate-slot reports", () => {
  const progress = [
    "gate-slot: Waiting for the CPU queue · 2nd · waited 1 min · normal priority",
    "gate-slot: Waiting for a heavy command slot · all 6 busy · waited 0 min",
    "gate-slot: Waiting for legacy heavy commands to drain · waited 10 min",
    "gate-slot: Waiting for measured CPU pressure to stay below 20% for 0 s · 1st in CPU queue · waited 0 min",
  ];
  for (const line of progress) {
    expect(normalizeRunnerOutput(`${line}\napplication output\n`)).toBe("application output\n");
    expect(normalizeRunnerOutput(`application output\n${line}`)).toBe("application output\n");
  }
  const refusal = "gate-slot: no verdict: legacy heavy-command ownership is unverified; retry after the older gate drains or upgrade its wrapper. This check did not start.";
  expect(normalizeRunnerOutput(`${refusal}\n`)).toBe(`${refusal}\n`);
  expect(normalizeRunnerOutput("application output: Waiting for the CPU queue\n")).toBe("application output: Waiting for the CPU queue\n");
});

test("SSH double records and refuses arbitrary shell text, including metacharacters around a known verb", () => {
  const h = makeHarness();
  try {
    const marker = path.join(h.root, "must-not-exist");
    for (const command of [`touch '${marker}'`, `~/.bun/bin/bun ~/runs/aaaaaaaaaaaa/serve.ts run ~/runs/aaaaaaaaaaaa; touch '${marker}'`, `mkdir -p ~/runs/../../outside && tar -xf - -C ~/runs/../../outside`]) {
      const result = spawnSync(h.stub, ["fixture-host", command], { env: h.env(), encoding: "utf8" });
      expect(result.status, result.stderr).toBe(255);
      expect(fs.existsSync(marker)).toBeFalse();
    }
    expect(h.calls()).toHaveLength(3);
    expect(h.calls().every(call => (call as { refused?: boolean }).refused)).toBeTrue();
  } finally { h.cleanup(); }
});
