import { expect, spyOn, test } from "bun:test";
import { viewerStartupPhases } from "./viewerReadiness";

test("startup progress is gated, increasing, rate-limited per phase and fits a receipt", () => {
  const previous = process.env.LLV_VIEWER_STARTUP_PHASES;
  const now = spyOn(performance, "now").mockReturnValue(0);
  const stderr = spyOn(console, "error").mockImplementation(() => {});
  try {
    delete process.env.LLV_VIEWER_STARTUP_PHASES;
    const phases = viewerStartupPhases();
    phases.begin("state-compatibility");
    phases.progress(1, 8);
    expect(stderr).not.toHaveBeenCalled();

    process.env.LLV_VIEWER_STARTUP_PHASES = "1";
    phases.begin("registry");
    phases.progress(5, 100);
    now.mockReturnValue(999);
    phases.progress(6, 100);
    now.mockReturnValue(1_000);
    phases.progress(4, 100);
    phases.progress(5, 100);
    phases.progress(7, 100);
    phases.progress(8, 100);
    now.mockReturnValue(2_000);
    phases.progress(8, 100);
    phases.begin("activation");
    phases.progress(9_999_999_998, 9_999_999_999);
    phases.finish();
    now.mockReturnValue(3_000);
    phases.progress(9_999_999_999, 9_999_999_999);

    const receipts = stderr.mock.calls.map(([line]) => String(line)).filter(line => line.includes(" progress "));
    expect(receipts).toEqual([
      "[viewer startup phase] registry progress 5 100",
      "[viewer startup phase] registry progress 7 100",
      "[viewer startup phase] activation progress 9999999998 9999999999",
    ]);
    expect(receipts.every(line => line.length <= 120)).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.LLV_VIEWER_STARTUP_PHASES;
    else process.env.LLV_VIEWER_STARTUP_PHASES = previous;
    stderr.mockRestore();
    now.mockRestore();
  }
});
