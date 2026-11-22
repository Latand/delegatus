import { expect, test, fs, path, harness, create, tickPipelines, loadPipelines, savePipelines,
  defaultPipelinePorts, engineModule, failedReceipt, durableStageTurnEvidence } from "./engine.fixture";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import type { RuntimeOperationResult } from "@/lib/runtime/contracts";
import { sharedClaudeProjectsRoot } from "@/lib/accounts/claude";

const TIMEOUT = "delivery was started and the structured host did not answer; whether it reached the recipient is unverified: Claude delivery confirmation timed out; outcome is uncertain";
const NOW = "2026-11-17T12:00:00.000Z";

async function confirmationPark(withTranscript = true) {
  const h = harness();
  h.ports.now = () => NOW;
  const pathname = path.join(sharedClaudeProjectsRoot(), withTranscript ? "confirmation-project" : "pending-confirmation-project", "confirmation.jsonl");
  if (withTranscript) {
    fs.mkdirSync(path.dirname(pathname), { recursive: true });
    fs.writeFileSync(pathname, "");
  }
  const receipt = { ...failedReceipt("launch-1", "conversation_stage_1", TIMEOUT),
    staged: true, currentGeneration: true, stagedTranscript: pathname };
  let message: RuntimeOperationResult = { operationId: "spawn_message_launch-1", replayed: false,
    receipt: { operationId: "spawn_message_launch-1", conversationId: receipt.conversationId,
      kind: "send", idempotencyKey: "spawn_message_launch-1", at: NOW, revision: 1,
      status: "failed", deliveryUnverified: true, reason: TIMEOUT } };
  const launch: RuntimeOperationResult = { operationId: "launch-1", replayed: false,
    receipt: { operationId: "launch-1", conversationId: receipt.conversationId, kind: "spawn",
      idempotencyKey: "launch-1", at: NOW, revision: 1, status: "applied" } };
  const client = { operationStatus: async (id: string) => id === launch.operationId ? launch : message } as RuntimeHostClient;
  h.ports.originalLaunchOperations = defaultPipelinePorts({ spawnRecoveryClient: () => client }).originalLaunchOperations;
  const spawn = h.ports.spawnAgent;
  h.ports.spawnAgent = async (input, reserved) => { await spawn(input, reserved); throw new Error(TIMEOUT); };
  h.ports.spawnReceipt = () => structuredClone(receipt);
  h.ports.pathForConversation = () => pathname;
  const sourcePathAllowed = defaultPipelinePorts().sourcePathAllowed;
  h.ports.sourcePathAllowed = file => sourcePathAllowed(file) || file.startsWith("/codex/");
  h.ports.transcriptPresent = file => fs.existsSync(file);
  h.ports.durableTurnEvidence = (engine, file, since, floor) => durableStageTurnEvidence(engine, file, since, floor);
  await create(h.ports, [{ id: "build", kind: "run", engine: "claude", role: { roleId: "architect" },
    access: "read-only", prompt: "Review delivery", next: null }] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  const nativeTurn = () => fs.writeFileSync(pathname, JSON.stringify({ type: "assistant", timestamp: "2026-11-17T12:00:01.000Z",
    message: { role: "assistant", content: [{ type: "tool_use", id: "tool-review", name: "Read", input: { file_path: "README.md" } }] } }) + "\n");
  const report = () => engineModule.reportStageCompletion({ verdict: "pass", summary: "Delivery verified" },
    { kind: "agent", role: "architect", conversationId: receipt.conversationId }, h.ports);
  return { h, receipt, pathname, nativeTurn, report, client, setMessage: (value: RuntimeOperationResult) => { message = value; },
    delivered: () => { message = { ...message, receipt: { ...message.receipt, status: "delivered", deliveryUnverified: false } }; } };
}

test("#4068: native Claude work reopens a confirmation timeout and accepts its report", async () => {
  const f = await confirmationPark();
  expect(await f.report()).toMatchObject({ code: "STAGE_REPORT_SETTLED" });
  f.nativeTurn();
  expect((await f.report()).error).toBeUndefined();
  expect(loadPipelines()[0]).toMatchObject({ state: "running", stateDetail: null });
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
  expect(f.h.spawnInputs).toHaveLength(1);
});

test.each(["native", "receipt"] as const)("#4068: controller reconciliation reopens from %s proof", async proof => {
  const f = await confirmationPark();
  if (proof === "native") f.nativeTurn(); else f.delivered();
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]).toMatchObject({ state: "running", stateDetail: null });
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ state: "running", error: null });
  expect(f.h.spawnInputs).toHaveLength(1);
});

test.each(["tick", "report"] as const)("#4068: %s trusts the delivered receipt before the transcript materializes", async entry => {
  const f = await confirmationPark(false);
  expect(fs.existsSync(f.pathname)).toBe(false);
  expect(await f.report()).toMatchObject({ code: "STAGE_REPORT_SETTLED" });
  f.delivered();
  if (entry === "tick") await tickPipelines([], f.h.ports);
  else expect((await f.report()).report?.verdict.status).toBe("pass");
  expect(fs.existsSync(f.pathname)).toBe(false);
  expect(loadPipelines()[0]).toMatchObject({ state: "running", stateDetail: null });
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ state: "running", error: null });
  expect(f.h.spawnInputs).toHaveLength(1);
});

test.each(["rejected", "foreign", "generation", "decision", "replaced", "old-turn", "empty"] as const)("confirmation recovery preserves the %s fence", async fence => {
  const f = await confirmationPark();
  f.nativeTurn();
  if (fence === "old-turn") fs.writeFileSync(f.pathname, fs.readFileSync(f.pathname, "utf8").replace("12:00:01", "11:00:01"));
  if (fence === "empty") fs.writeFileSync(f.pathname, "");
  if (fence === "rejected" || fence === "foreign") f.setMessage({ operationId: "spawn_message_launch-1", replayed: false,
    receipt: { operationId: "spawn_message_launch-1", conversationId: fence === "foreign" ? "conversation_other" : f.receipt.conversationId,
      kind: "send", idempotencyKey: "spawn_message_launch-1", at: NOW, revision: 1,
      status: fence === "foreign" ? "delivered" : "rejected" } });
  if (fence === "generation") f.receipt.currentGeneration = false;
  if (fence === "decision" || fence === "replaced") {
    const lane = loadPipelines()[0]!;
    if (fence === "decision") lane.runs[0]!.attempts[0]!.error = "operator decision required";
    else lane.runs[0]!.attempts[0]!.launchId = "launch-replacement";
    savePipelines([lane]);
  }
  expect(await f.report()).toMatchObject({ code: "STAGE_REPORT_SETTLED" });
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
});

test.each(["transcript", "launch", "message", "report-admission"] as const)("confirmation recovery rechecks identity after %s awaits", async boundary => {
  const f = await confirmationPark();
  f.nativeTurn();
  if (boundary === "transcript" || boundary === "report-admission") {
    const read = f.h.ports.durableTurnEvidence;
    let reads = 0;
    f.h.ports.durableTurnEvidence = async (...args) => {
      const evidence = await read(...args);
      if (++reads === (boundary === "transcript" ? 1 : 2)) f.receipt.accountId = "account-replacement";
      return evidence;
    };
  } else {
    const read = f.client.operationStatus;
    f.client.operationStatus = async id => {
      const evidence = await read(id);
      if (id === (boundary === "launch" ? "launch-1" : "spawn_message_launch-1")) f.receipt.accountId = "account-replacement";
      return evidence;
    };
  }
  expect(await f.report()).toMatchObject({ code: "STAGE_REPORT_SETTLED" });
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.report).toBeUndefined();
});
