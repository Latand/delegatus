import { expect, test } from "bun:test";
import { cgroupScopeContainsUnit } from "./cpuAdmission";

test("recorded service scope matches the exact systemd service and its descendants", () => {
  const unit = "delegatus-gate-abc.service";
  expect(cgroupScopeContainsUnit(`0::/user.slice/user-1000.slice/${unit}`, unit)).toBe(true);
  expect(cgroupScopeContainsUnit(`0::/user.slice/user-1000.slice/${unit}/runner`, unit)).toBe(true);
  expect(cgroupScopeContainsUnit(`0::/user.slice/other.service/${unit}-lookalike`, unit)).toBe(false);
  expect(cgroupScopeContainsUnit(`0::/user.slice/${unit}`, "bad/unit.service")).toBe(false);
});
