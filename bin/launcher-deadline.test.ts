import { expect, test } from "bun:test";
import { startupHandoffSucceeded } from "./launcher-deadline.mjs";

const healthyRecord = {
  launcher: { pid: 41, startIdentity: "41:fixed", state: "healthy" },
  web: { pid: 51, state: "healthy" },
  runtimeHost: { pid: 61, state: "healthy" },
};

test("startup expiry yields supervision only to its live, recorded healthy child", () => {
  expect(startupHandoffSucceeded(41, true, false, healthyRecord)).toBe(true);
  expect(startupHandoffSucceeded(42, true, false, healthyRecord)).toBe(false);
  expect(startupHandoffSucceeded(41, false, false, healthyRecord)).toBe(false);
  expect(startupHandoffSucceeded(41, true, true, healthyRecord)).toBe(false);
  expect(startupHandoffSucceeded(41, true, false, { ...healthyRecord, web: { state: "starting" } })).toBe(false);
  expect(startupHandoffSucceeded(41, true, false, { ...healthyRecord, runtimeHost: { state: "starting" } })).toBe(false);
  expect(startupHandoffSucceeded(41, true, false, { ...healthyRecord, launcher: { pid: 41, startIdentity: "", state: "healthy" } })).toBe(false);
});
