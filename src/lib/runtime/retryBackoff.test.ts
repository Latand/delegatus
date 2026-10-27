import { expect, spyOn, test } from "bun:test";
import * as deadline from "../deadline";
import { RetryBackoff } from "./retryBackoff";

test("runtime retry delegates one-based attempts to the shared arithmetic without jitter", () => {
  const calculate = spyOn(deadline, "backoffDelayMs");
  try {
    const retry = new RetryBackoff();
    retry.nextDelayMs();
    expect(calculate).toHaveBeenCalledWith(1, { baseMs: 1_000, maxMs: 30_000, jitter: 0 });
  } finally {
    calculate.mockRestore();
  }
});

test("retry deadlines survive unrelated wakes, saturate, and reset only on success", () => {
  const retry = new RetryBackoff();
  let now = 100;
  expect(retry.ready(now)).toBe(true);
  for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]) {
    expect(retry.nextDelayMs()).toBe(delay);
    expect(retry.nextDelayMs()).toBe(delay);
    retry.fail(now);
    expect(retry.ready(now)).toBe(false);
    expect(retry.ready(now + delay / 2)).toBe(false);
    expect(retry.ready(now + delay - 1)).toBe(false);
    now += delay;
    expect(retry.ready(now)).toBe(true);
  }
  retry.reset();
  expect(retry.ready(0)).toBe(true);
  expect(retry.nextDelayMs()).toBe(1_000);
  retry.fail(now);
  expect(retry.ready(now + 999)).toBe(false);
  expect(retry.ready(now + 1_000)).toBe(true);
});
