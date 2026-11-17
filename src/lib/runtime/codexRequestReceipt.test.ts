import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { codexRequestDigest, codexRequestIdentity, validCodexRequestReceipt, type CodexRequestReceipt } from "./codexRequestReceipt";
import { bindGateCheckRoot, runGateCheckTool } from "./gateCheckTool";
import { cpuOwnerIdentity } from "./signalSandboxContext";
import { custodyClock, physical } from "../recordedChecks/wire";
import { FileRuntimeEventStore } from "./eventStore";

test("real gate responses round-trip through the receipt reader, including escaped tails and refusals", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-receipt-"));
  try {
    const log = path.join(root, "check.log"), directory = `${log}.gate`;
    fs.mkdirSync(directory);
    fs.writeFileSync(log, "\u0000".repeat(16_384));
    const recorder = cpuOwnerIdentity(process.pid);
    fs.writeFileSync(path.join(directory, "owner.json"), JSON.stringify(recorder));
    fs.writeFileSync(path.join(directory, "completion.json"), JSON.stringify({ recorder, directoryIdentity: physical(directory), deadlineUptimeMs: custodyClock() + 60_000 }));
    fs.writeFileSync(path.join(directory, "exit"), "0\n");
    const args = { log, reason: "retained check" };
    const result = await runGateCheckTool(args, bindGateCheckRoot(root), new AbortController().signal);
    expect(result.success).toBe(true);
    expect(result.contentItems[0].text.length).toBeGreaterThan(32_768);
    const runId = JSON.parse(result.contentItems[0].text).runId;
    const pending: CodexRequestReceipt = {
      identity: codexRequestIdentity("generation", "item/tool/call", "wait", { threadId: "thread", turnId: "turn" }),
      receivedAt: "2026-01-01T00:00:00.000Z", requestDigest: codexRequestDigest(args), gateWait: { runId },
    };
    const store = new FileRuntimeEventStore(path.join(root, "events"));
    let seq = 0;
    const roundTrip = (receipt: CodexRequestReceipt) => {
      expect(validCodexRequestReceipt(receipt)).toBe(true);
      store.append("thread", { kind: "attention", id: "wait", method: "item/tool/call", attention: args, codexReceipt: receipt, seq: ++seq });
      expect(new FileRuntimeEventStore(path.join(root, "events")).load("thread").at(-1)).toMatchObject({ codexReceipt: receipt });
    };
    roundTrip(pending);
    const dispatched = { ...pending, gateWait: { runId, result }, dispatch: { digest: codexRequestDigest(result), at: pending.receivedAt } };
    roundTrip(dispatched);
    roundTrip({ ...dispatched, serverResolution: { at: pending.receivedAt, outcome: "answered" } });
    fs.writeFileSync(path.join(directory, "completion.json"), "{}");
    const refused = await runGateCheckTool(args, bindGateCheckRoot(root), new AbortController().signal, runId);
    expect(refused.success).toBe(false);
    roundTrip({ ...pending, gateWait: { runId, result: refused }, dispatch: { digest: codexRequestDigest(refused), at: pending.receivedAt } });
    expect(validCodexRequestReceipt({ ...dispatched, dispatch: undefined })).toBe(false);
    expect(validCodexRequestReceipt({ ...dispatched, gateWait: { runId, result: { ...result, success: false } } })).toBe(false);
    expect(validCodexRequestReceipt({ ...pending, gateWait: { runId: "invalid" } })).toBe(false);
    expect(validCodexRequestReceipt({ ...pending, gateWait: undefined })).toBe(true);
    // A refused wait has no run id; its refusal is retained for replay.
    const invalid = await runGateCheckTool({ log: "relative.log", reason: "refused check" }, bindGateCheckRoot(root), new AbortController().signal);
    expect(invalid.success).toBe(false);
    roundTrip({ ...pending, gateWait: {} });
    roundTrip({ ...pending, gateWait: { result: invalid }, dispatch: { digest: codexRequestDigest(invalid), at: pending.receivedAt } });
    for (const gateWait of ["run", [], null]) expect(validCodexRequestReceipt({ ...pending, gateWait } as unknown as CodexRequestReceipt)).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
