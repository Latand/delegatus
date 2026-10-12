import { expect, test } from "bun:test";
import { compactLiveness } from "./compactAnswers";
import type { AgentLivenessSnapshot } from "@/lib/lifecycle/liveness";
test("compact activity marks verification and omits unmeasured silence", () => {
  const row = { conversationId: "conversation_one", title: "check", turnState: "busy", lifecycle: "running", silentForMs: 17_482_029, stalledForMs: null, pipeline: null, evidenceSource: "projection", verified: false };
  const snapshot = { count: 1, conversations: [row], stalledCount: 0, stalledConfirmedCount: 0, observedAt: "2026-10-12T05:45:29Z", selection: { cacheStatus: "stale", projected: 1 } } as unknown as AgentLivenessSnapshot;
  const projected = compactLiveness(snapshot).conversations[0];
  expect(projected.verified).toBe(false);
  expect(projected).not.toHaveProperty("silentForMs");
  const checked = compactLiveness({ ...snapshot, conversations: [{ ...row, evidenceSource: "transcript", verified: true, silentForMs: 10_000, activity: { state: "checking", check: "bun test", idleForMs: null } }] } as unknown as AgentLivenessSnapshot).conversations[0];
  expect(checked).toMatchObject({ verified: true, silentForMs: 10_000, activity: { state: "checking", check: "bun test" } });
});
