import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { materializeStructuredHostAccess } from "@/lib/runtime/structuredSpawn";
import { readAttemptCheckTiming } from "@/lib/runtime/attemptCheckTiming";
import { cpuOwnerIdentity } from "@/lib/runtime/signalSandboxContext";
import { producerReport, physical } from "./wire";
import { retainForegroundCheckTiming } from "./timing";

test("foreground producer clocks persist without custody and resolve only through the registered launch root", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "foreground-timing-"));
  const access = materializeStructuredHostAccess(false, process.env, null, parent,
    { pipelineId: "timing-lane", launchId: "timing-launch", retainUntilClose: false });
  if (!access.scratchDirectory) throw new Error("expected an owned scratch root");
  const directory = path.join(access.env.TMPDIR!, "check.gate"); fs.mkdirSync(directory);
  const keys = ["LLV_GATE_TIMING_DIRECTORY", "LLV_GATE_TIMING_DIRECTORY_IDENTITY", "LLV_ATTEMPT_TIMING_ROOT", "LLV_ATTEMPT_TIMING_ROOT_IDENTITY", "LLV_RECORDED_CHECK_DIRECTORY"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { LLV_GATE_TIMING_DIRECTORY: directory, LLV_GATE_TIMING_DIRECTORY_IDENTITY: physical(directory),
    LLV_ATTEMPT_TIMING_ROOT: access.env.LLV_ATTEMPT_TIMING_ROOT!, LLV_ATTEMPT_TIMING_ROOT_IDENTITY: access.env.LLV_ATTEMPT_TIMING_ROOT_IDENTITY! });
  delete process.env.LLV_RECORDED_CHECK_DIRECTORY;
  const clock = spyOn(Date, "now").mockReturnValue(3000);
  try {
    expect(producerReport("portable", cpuOwnerIdentity(process.pid))).toBeNull();
    clock.mockReturnValue(10000);
    expect(producerReport("portable", cpuOwnerIdentity(process.pid), { executionStartedAt: 3000, executionEndedAt: 6000, phase: "close", commandExit: 0, cleanup: "confirmed" })).toBeNull();
    retainForegroundCheckTiming(directory, [{ start: 2000, end: 2500 }]);
    const expected = [{ kind: "checkQueue" as const, start: 2000, end: 2500 }, { kind: "checkRunner" as const, start: 3000, end: 6000 }];
    expect(readAttemptCheckTiming("timing-launch", "timing-lane")).toEqual(expected);
    expect(readAttemptCheckTiming("other-launch", "timing-lane")).toEqual([]);
    expect(readAttemptCheckTiming("timing-launch", "other-lane")).toEqual([]);
    const child = Bun.spawn([process.execPath, "-e", `import { readAttemptCheckTiming } from "./src/lib/runtime/attemptCheckTiming"; console.log(JSON.stringify(readAttemptCheckTiming("timing-launch","timing-lane")));`],
      { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, errors }).toEqual({ code: 0, errors: "" }); expect(JSON.parse(output)).toEqual(expected);
    const displaced = access.scratchDirectory + "-previous";
    fs.renameSync(access.scratchDirectory, displaced); fs.mkdirSync(access.scratchDirectory);
    try { expect(readAttemptCheckTiming("timing-launch", "timing-lane")).toEqual([]); }
    finally { fs.rmdirSync(access.scratchDirectory); fs.renameSync(displaced, access.scratchDirectory); }
  } finally {
    clock.mockRestore();
    for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    access.cleanup();
  }
});
