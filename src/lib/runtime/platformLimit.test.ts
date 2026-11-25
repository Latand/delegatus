import { expect, spyOn, test } from "bun:test";

import { platformLimitDiagnostic, platformLimitSeverity } from "./platformLimit";

test.each([
  ["darwin", "info"], ["win32", "info"], ["linux", "warn"], ["freebsd", "warn"], ["android", "warn"],
] as const)("a platform limit on %s has %s severity", (platform, severity) => {
  expect(platformLimitSeverity(platform)).toBe(severity);
});

test("information is quiet in a quiet launch and a warning always prints", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const info = spyOn(console, "info").mockImplementation(() => {});
  const quiet = process.env.LLV_QUIET_DIAGNOSTICS;
  try {
    delete process.env.LLV_QUIET_DIAGNOSTICS;
    platformLimitDiagnostic("a", "darwin");
    platformLimitDiagnostic("b", "linux");
    expect(info.mock.calls).toEqual([["a"]]);
    expect(warn.mock.calls).toEqual([["b"]]);
    process.env.LLV_QUIET_DIAGNOSTICS = "1";
    platformLimitDiagnostic("c", "win32");
    platformLimitDiagnostic("d", "linux");
    expect(info.mock.calls).toEqual([["a"]]);
    expect(warn.mock.calls).toEqual([["b"], ["d"]]);
  } finally {
    if (quiet === undefined) delete process.env.LLV_QUIET_DIAGNOSTICS; else process.env.LLV_QUIET_DIAGNOSTICS = quiet;
    warn.mockRestore(); info.mockRestore();
  }
});
