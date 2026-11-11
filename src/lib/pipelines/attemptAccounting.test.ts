import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildManifest, identitySchema, digest, custodyClock, descriptorDigest, physical, producerReport, readEnvelope, terminalSchema, writeEnvelope } from "@/lib/recordedChecks/wire";
import { cpuOwnerIdentity } from "@/lib/runtime/signalSandboxContext";
import { RecordedCheckStore, rowSchema } from "@/lib/recordedChecks/store";
import { checkTimeSpans } from "./attemptAccounting";
import { splitAttemptTime } from "./accounting";

test("real check producer retains dispatch time through close, serialization and archival", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "check-accounting-"));
  fs.writeFileSync(path.join(root, "source.ts"), "export const fixture = true;\n");
  const identity = identitySchema.parse(cpuOwnerIdentity(process.pid));
  const manifest = await buildManifest({ executionEnvironment: {}, cwd: root, deadline: 1_900_000_000_000, executionMs: 1000,
    selection: ["source.ts"], configurationDigest: "a".repeat(64), roots: [{ directory: root, purpose: "evidence" }],
    inputs: [{ root, file: "source.ts" }], outputs: [{ root, file: "result.txt" }], completion: { root, file: "complete.json" } });
  const unsigned = { version: 1 as const, runId: "b".repeat(64), manifest, argv: ["bun", "test", "source.ts"], recorder: identity,
    wrapper: identity, directoryIdentity: physical(root), startedAt: 2000, startedUptimeMs: custodyClock(), deadlineUptimeMs: manifest.deadlineUptimeMs };
  const { wrapper: _wrapper, ...immutable } = unsigned;
  const descriptor = { ...unsigned, descriptorDigest: descriptorDigest(immutable) };
  writeEnvelope(path.join(root, "descriptor.json"), descriptor);
  const oldDirectory = process.env.LLV_RECORDED_CHECK_DIRECTORY, oldId = process.env.LLV_RECORDED_CHECK_ID;
  process.env.LLV_RECORDED_CHECK_DIRECTORY = root; process.env.LLV_RECORDED_CHECK_ID = descriptor.runId;
  const clock = spyOn(Date, "now").mockReturnValue(3000);
  try {
    producerReport("portable", identity);
    clock.mockReturnValue(6000);
    producerReport("portable", identity, { phase: "close", commandExit: 0, cleanup: "confirmed" });
    const report = readEnvelope(path.join(root, "portable.json"));
    const terminal = terminalSchema.parse({ version: 1, runId: descriptor.runId, descriptorDigest: descriptor.descriptorDigest,
      wrapperExit: 0, wrapperSignal: null, cancellation: null, closedAt: 6100, closedUptimeMs: custodyClock(), report,
      queueSpans: [{ start: 2000, end: 2500 }] });
    expect(terminal.report?.executionStartedAt).toBe(3000);
    const row = rowSchema.parse({ id: descriptor.runId, request: "request", binding: { project: "fixture", pipeline: "lane", stage: "build", attempt: 1,
      launch: "launch", conversation: "conversation", session: "session", runtimeFence: "fence", endpoint: "http://127.0.0.1:1", host: identity },
      log: path.join(root, "check.log"), descriptor, revision: 1, admission: "accepted", reason: "check",
      result: { state: "terminal", reason: "finished", terminal, complete: true, visited: 1, completed: 1, failed: 0,
        evidence: [], evidenceDigest: digest([]), evidenceCount: 0, revision: 1, digest: "d".repeat(64), history: [] }, notification: null,
      acknowledgement: { actor: "controller", resultRevision: 1, resultDigest: "d".repeat(64), evidenceDigest: digest([]), disposition: "adopt-retained", at: 6200 } });
    const filename = path.join(root, "checks.sqlite");
    const store = new RecordedCheckStore(filename);
    store.put(row, null); store.close();
    const reopened = new RecordedCheckStore(filename, false);
    try {
      const retained = reopened.forAttempt("launch");
      expect(retained).toHaveLength(1);
      const split = splitAttemptTime(new Date(1000).toISOString(), new Date(7000).toISOString(), checkTimeSpans(retained[0]!));
      expect(split).toMatchObject({ intervalMs: 6000, checkQueueMs: 500, checkRunnerMs: 3000, unknownMs: 2500 });
      expect(checkTimeSpans({ ...retained[0]!, result: null })).toEqual([]);
      expect(checkTimeSpans({ ...retained[0]!, result: { ...retained[0]!.result!, terminal: { ...retained[0]!.result!.terminal!, report: null } } }))
        .toEqual([{ kind: "checkQueue", start: 2000, end: 2500 }]);
    } finally { reopened.close(); }
  } finally {
    clock.mockRestore();
    if (oldDirectory === undefined) delete process.env.LLV_RECORDED_CHECK_DIRECTORY; else process.env.LLV_RECORDED_CHECK_DIRECTORY = oldDirectory;
    if (oldId === undefined) delete process.env.LLV_RECORDED_CHECK_ID; else process.env.LLV_RECORDED_CHECK_ID = oldId;
  }
});
