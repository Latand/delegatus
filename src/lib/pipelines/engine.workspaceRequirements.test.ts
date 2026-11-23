import { pipelineStageRead } from "@/lib/mcp/compactAnswers";
import { encodeCodexStructuredUserText } from "@/lib/runtime/codexStructuredUserText.server";
import { expect, test, loadPipelines, savePipelines, providerRecoveryHarness, readFixtures, SPARE_ACCOUNT, stageTranscript, tickPipelines, entry } from "./engine.fixture";
import { recoverPipelineProviderTurn } from "./engine";

const workspaceError = "failed to load workspace requirements: invalid data";
const unrelatedError = "failed to load the session: invalid data";

test.each(["success", "previous-classification", "exhausted", "exhausted-restarts", "unrelated"] as const)("handles a native Codex terminal provider record (%s)", async outcome => {
  const error = outcome === "unrelated" ? unrelatedError : workspaceError;
  const f = await providerRecoveryHarness("codex", "other", error);
  const pipeline = () => loadPipelines()[0]!;
  const original = pipeline();
  const stageId = original.cursor!.stageId;
  const attempt = original.runs[0]!.attempts[0]!;
  const originalAttempt = { n: attempt.n, launchId: attempt.launchId, conversationId: attempt.conversationId, agentPath: attempt.agentPath, sessionId: attempt.sessionId };
  const current = () => pipelineStageRead(pipeline(), stageId).attempt!;
  const tick = async () => { await tickPipelines([], { ...f.h.ports }); };
  const records: Record<string, unknown>[] = [];
  const deliveredKeys = new Set<string>();
  let preAcknowledgementSnapshot: ReturnType<typeof loadPipelines> | undefined;
  const append = (payload: Record<string, unknown>) => records.push({ type: "event_msg", timestamp: f.h.ports.now(), payload });
  const write = () => readFixtures(f.h, { [originalAttempt.agentPath!]: stageTranscript(`workspace-requirements-${outcome}`, records) });
  const fail = (message: string) => {
    append({ type: "task_complete", error: { message, codex_error_info: "other" } });
    f.h.setConversationActive(false);
    write();
  };
  const sends: Array<{ key: string; at: string; text: string }> = [];
  f.h.ports.resumeSeveredTurn = async input => {
    expect(await input.continuationAllowed?.()).toBe(true);
    expect(input).toMatchObject({ conversationId: originalAttempt.conversationId, transcriptPath: originalAttempt.agentPath, cwd: original.worktreeDir, policy: "queue" });
    sends.push({ key: input.clientMessageId, at: f.h.ports.now(), text: input.text });
    deliveredKeys.add(input.clientMessageId);
    if (outcome === "exhausted-restarts") preAcknowledgementSnapshot = structuredClone(loadPipelines());
    f.h.setConversationActive(true);
    return true;
  };
  f.h.ports.conversationDeliveryCompleted = (_conversationId, key) => deliveredKeys.has(key);
  f.advance(1_000);
  append({ type: "task_started" });
  f.advance(1_000);
  fail(error);
  if (outcome === "previous-classification") {
    const at = f.h.ports.now();
    attempt.providerWait = { condition: { kind: "other", label: "provider error", scope: null, resetLabel: null },
      text: workspaceError, accountId: null, turnTs: f.now(), tries: 0, startedAt: at, resumeAt: at, resetsAt: null };
    savePipelines([original]);
  } else if (outcome === "exhausted") {
    // An earlier account limit still has a future reset when this cut parks.
    attempt.usageLimitedAccounts = [{ accountId: SPARE_ACCOUNT, engine: "codex", resetsAt: (f.now() + 9 * 60_000) / 1_000 }];
    savePipelines([original]);
  }
  await recoverPipelineProviderTurn(original.id, { ...f.h.ports });
  if (outcome === "unrelated") {
    expect(pipeline()).toMatchObject({ state: "needs_decision", stateDetail: `stage cut by provider error after 0 tries; last: ${unrelatedError}` });
    f.advance(10 * 60_000);
    await tick();
    expect(sends).toEqual([]);
    expect(f.h.spawnInputs).toHaveLength(1);
    return;
  }

  let lastError = error;
  const delays = outcome === "exhausted" || outcome === "exhausted-restarts" ? [60_000, 120_000, 240_000] : [60_000];
  for (const [index, delay] of delays.entries()) {
    expect(pipeline().state).toBe("running");
    expect(current().providerWait).toEqual({ tries: index, resumeAt: new Date(f.now() + delay).toISOString(), lastError });
    f.advance(delay - 1);
    await tick();
    expect(sends).toHaveLength(index);
    f.advance(1);
    await tick();
    expect(sends).toHaveLength(index + 1);
    expect(current().providerWait?.tries).toBe(index + 1);
    const sent = sends[index]!;
    f.advance(1_000);
    append({ type: "user_message", message: await encodeCodexStructuredUserText(sent.text, undefined, null, { kind: "agent", role: "pipeline" }) });
    append({ type: "task_started" });
    f.advance(6_000);
    if (outcome !== "exhausted" && outcome !== "exhausted-restarts") {
      append({ type: "agent_message", message: 'Stage completed.\n\n```json\n{"status":"pass"}\n```' });
      append({ type: "task_complete" });
      f.h.setConversationActive(false);
      write();
    } else {
      lastError = `${workspaceError} (retry ${index + 1})`;
      fail(lastError);
      if (outcome === "exhausted-restarts") {
        expect(preAcknowledgementSnapshot).toBeDefined();
        savePipelines(preAcknowledgementSnapshot!);
      }
    }
    await tick();
  }

  if (outcome !== "exhausted" && outcome !== "exhausted-restarts") {
    expect(current()).toMatchObject({ verdict: "pass" });
    expect(current().providerWait).toBeUndefined();
  } else {
    expect(pipeline()).toMatchObject({ state: "needs_decision", stateDetail: `stage cut by workspace requirements failure after 3 tries; last: ${lastError}` });
    expect(current().providerWait).toMatchObject({ tries: 3, lastError });
    expect(pipeline().runs[0]!.attempts[0]!.providerWait?.stageRetry).toBeUndefined();
    f.advance(10 * 60_000);
    await tick();
    expect(sends).toHaveLength(3);
  }
  const continuations = current().providerRecoveries?.filter(row => row.action === "continue");
  expect(continuations?.map(row => row.at)).toEqual(sends.map(send => send.at));
  expect(continuations?.map(row => row.summary)).toEqual(sends.map((_, index) =>
    `continuing after workspace requirements failure (${index + 1} of 3); last: ${workspaceError}${index > 0 ? ` (retry ${index})` : ""}`));
  expect(new Set(sends.map(send => send.key)).size).toBe(delays.length);
  expect(f.h.spawnInputs).toHaveLength(1);
  expect(pipeline()).toMatchObject({ worktreeDir: original.worktreeDir });
  expect(pipeline().runs[0]!.attempts).toEqual([expect.objectContaining(originalAttempt)]);
});

test.each(["delivered", "pre-execution-refused"] as const)("a newer cut charges only a %s prior continuation", async receipt => {
  const f = await providerRecoveryHarness("codex", "other", workspaceError);
  const pipeline = loadPipelines()[0]!;
  const attempt = pipeline.runs[0]!.attempts[0]!;
  const oldCut = f.now() - 1_000;
  attempt.providerWait = { condition: { kind: "transient", label: "workspace requirements failure", scope: null, resetLabel: null },
    text: workspaceError, accountId: null, turnTs: oldCut, tries: 0, startedAt: new Date(oldCut).toISOString(),
    resumeAt: new Date(oldCut).toISOString(), resetsAt: null, continuationRequestedAt: new Date(oldCut + 1).toISOString() };
  attempt.providerRecoveryBudget = { tries: 0, startedAt: new Date(oldCut).toISOString(), engine: "codex" };
  savePipelines([pipeline]);
  f.h.ports.conversationDeliveryCompleted = (_conversationId, key) => receipt === "delivered" && key.endsWith(`-${oldCut}`);
  f.h.ports.conversationDeliveryRetryable = async (_conversationId, key) => receipt === "pre-execution-refused" && key.endsWith(`-${oldCut}`);

  f.advance(1_000);
  f.cut();
  await recoverPipelineProviderTurn(pipeline.id, { ...f.h.ports });

  const next = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  const tries = receipt === "delivered" ? 1 : 0;
  expect(next.providerWait).toMatchObject({
    condition: { kind: "transient" }, tries,
    resumeAt: new Date(f.now() + 60_000 * 2 ** tries).toISOString(),
  });
  expect(next.providerRecoveryBudget).toMatchObject({ tries, startedAt: new Date(oldCut).toISOString() });
});

test.each(["ordinary tick", "provider observer"] as const)("a delayed continuation receipt is retained and the %s parks after three deliveries", async entrypoint => {
  const f = await providerRecoveryHarness("codex", "other", workspaceError);
  const initial = loadPipelines()[0]!;
  const attempt = initial.runs[0]!.attempts[0]!;
  const transcriptPath = attempt.agentPath!;
  let preAcknowledgement: ReturnType<typeof loadPipelines> | undefined;
  const available = new Set<string>();
  const sent: string[] = [];
  f.h.ports.resumeSeveredTurn = async input => {
    sent.push(input.clientMessageId);
    preAcknowledgement = structuredClone(loadPipelines());
    f.h.setConversationActive(true);
    return true;
  };
  f.h.ports.conversationDeliveryCompleted = (_id, key) => available.has(key);
  f.h.ports.conversationDeliveryRetryable = async () => false;
  const process = async () => {
    if (entrypoint === "ordinary tick") await tickPipelines([entry(transcriptPath)], { ...f.h.ports });
    else await recoverPipelineProviderTurn(initial.id, { ...f.h.ports });
  };

  await process();
  f.advance(60_000);
  await process();
  expect(sent).toHaveLength(1);

  for (let delivered = 1; delivered <= 3; delivered += 1) {
    expect(preAcknowledgement).toBeDefined();
    savePipelines(preAcknowledgement!);
    f.h.setConversationActive(false);
    f.advance(1_000);
    f.cut();
    const cutTs = f.now();
    await process();
    let current = loadPipelines()[0]!;
    expect(current.runs[0]!.attempts[0]!.providerWait).toMatchObject({ tries: delivered - 1, receiptWaitStartedAt: expect.any(String) });
    expect(current.runs[0]!.attempts[0]!.providerWait!.turnTs).not.toBe(cutTs);
    expect(sent).toHaveLength(delivered);

    available.add(sent[delivered - 1]!);
    await process();
    current = loadPipelines()[0]!;
    if (delivered === 3) {
      expect(current).toMatchObject({ state: "needs_decision", stateDetail: `stage cut by workspace requirements failure after 3 tries; last: ${workspaceError}` });
      expect(current.runs[0]!.attempts[0]!.providerWait).toMatchObject({ tries: 3 });
      expect(sent).toHaveLength(3);
      break;
    }
    expect(current.runs[0]!.attempts[0]!.providerWait).toMatchObject({ tries: delivered, turnTs: cutTs });
    f.advance(60_000 * 2 ** delivered);
    await process();
    expect(sent).toHaveLength(delivered + 1);
  }
});
