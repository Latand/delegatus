import { afterEach, expect, spyOn, test } from "bun:test";

import { QUIET_DIAGNOSTICS_ENV, startupDiagnostic, startupDiagnosticsQuiet } from "./startupDiagnostics";

const saved = process.env[QUIET_DIAGNOSTICS_ENV];

afterEach(() => {
  if (saved === undefined) delete process.env[QUIET_DIAGNOSTICS_ENV];
  else process.env[QUIET_DIAGNOSTICS_ENV] = saved;
});

test("a process nobody asked to be quiet prints its startup diagnostics", () => {
  delete process.env[QUIET_DIAGNOSTICS_ENV];
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    startupDiagnostic("error", "[structured hosts] startup progress", { phase: "ready" });
    expect(error).toHaveBeenCalledWith("[structured hosts] startup progress", { phase: "ready" });
  } finally {
    error.mockRestore();
  }
});

test("the CLI launcher's quiet choice silences them", () => {
  process.env[QUIET_DIAGNOSTICS_ENV] = "1";
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    startupDiagnostic("warn", "[limits] codex fallback: app-server-unavailable");
    expect(warn).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});

test("only the exact value 1 reads as quiet", () => {
  expect(startupDiagnosticsQuiet({})).toBe(false);
  expect(startupDiagnosticsQuiet({ [QUIET_DIAGNOSTICS_ENV]: "0" })).toBe(false);
  expect(startupDiagnosticsQuiet({ [QUIET_DIAGNOSTICS_ENV]: "1" })).toBe(true);
});
