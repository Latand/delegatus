import { expect, test } from "bun:test";
import { observeSpawnedTurn } from "./autonomousConversation";

const claimedAt = "2031-02-01T11:00:00.000Z";

function sources(reason: string, receiptState: string = "failed") {
  let livenessReads = 0;
  return {
    value: {
      registry: () => ({ spawnReceiptForClientAttempt: () => ({
        state: receiptState, rejection: null, conversationId: "conversation-test", launchId: "launch-test",
        artifactPath: null, error: "launch failed",
      }) }) as never,
      liveness: async () => {
        livenessReads++;
        return [{ reason, lastRecordAt: claimedAt }] as never;
      },
      now: () => Date.parse(claimedAt),
    },
    reads: () => livenessReads,
  };
}

test("failed spawn receipt remains non-quiescent while liveness retains an open host", async () => {
  const fixture = sources("host_alive_turn_open");
  const observed = await observeSpawnedTurn({ clientAttemptId: "attempt-test", claimedAt }, fixture.value);
  expect(fixture.reads()).toBe(1);
  expect(observed).toMatchObject({
    state: "failed", quiescent: false, conversationId: "conversation-test", launchId: "launch-test",
    failure: { kind: "launch-failed", detail: "launch failed" },
  });
});

test("failed spawn receipt proves quiescence only after liveness records settled host retirement", async () => {
  const fixture = sources("host_gone_turn_settled");
  const observed = await observeSpawnedTurn({ clientAttemptId: "attempt-test", claimedAt }, fixture.value);
  expect(fixture.reads()).toBe(1);
  expect(observed).toMatchObject({ state: "failed", quiescent: true });
});

test("completed receipt preserves the durable terminal observation time", async () => {
  const completedAt = "2031-02-01T11:30:00.000Z";
  const fixture = sources("host_gone_turn_settled", "completed");
  fixture.value.liveness = async () => [{ reason: "host_gone_turn_settled", lastRecordAt: completedAt }] as never;
  const observed = await observeSpawnedTurn({ clientAttemptId: "attempt-test", claimedAt, launchedAt: claimedAt },
    fixture.value, () => ({ text: "report", error: null }));
  expect(observed).toMatchObject({ state: "ended", completedAt, quiescent: true, finalText: "report" });
});
