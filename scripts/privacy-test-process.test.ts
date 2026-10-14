import { expect, test } from "bun:test";
import { runPrivacyTestProcess } from "./privacy-test-process";
import { assertPrivacyWorkBound } from "./privacy-work-bound";

test("a cancelled privacy child releases capacity and later cases keep their own verdict", async () => {
  const slow = await runPrivacyTestProcess({
    cmd: [process.execPath, "-e", "setInterval(() => {}, 1000)"], stdout: "pipe", stderr: "pipe",
  }, { timeoutMs: 100 });
  expect(slow.exitCode).toBe(137);
  const following = await Promise.all(Array.from({ length: 5 }, () => runPrivacyTestProcess({
    cmd: [process.execPath, "-e", "process.stdout.write('independent')"], stdout: "pipe", stderr: "pipe",
  })));
  expect(following.map(result => result.exitCode)).toEqual([0, 0, 0, 0, 0]);
  expect(following.map(result => result.stdout.toString())).toEqual(Array(5).fill("independent"));
});

test("the work bound admits scaled linear work and refuses quadratic growth", () => {
  for (const cpuScale of [0.1, 1, 100]) {
    const samples = (value: number) => [value, value * 1.02, value * 0.98].map(cpu => cpu * cpuScale);
    expect(() => assertPrivacyWorkBound(samples(1), samples(8), "linear")).not.toThrow();
    expect(() => assertPrivacyWorkBound(samples(1), samples(64), "quadratic")).toThrow("exceeds 32x");
  }
});
