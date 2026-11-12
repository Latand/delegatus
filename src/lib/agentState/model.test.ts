import { expect, test } from "bun:test";
import { AGENT_STATE_POLICY, centralIdleEligible, evaluateAgentState, fact, unknown, type AgentFacts } from "./model";

const now = 1_000_000;
function facts(): AgentFacts {
  const evidence = { source: "proc" as const, observedAt: now, subjectRevision: "one", ref: "fixture" };
  return { subject: "fixture", engine: "codex", revision: "one", process: fact({ status: "alive", identity: { pid: 100, startIdentity: "start", bootEpoch: "boot" } }, evidence),
    owner: fact("held", evidence), turn: fact({ state: "closed", nativeId: "turn", localRef: null, opening: "task_started", closing: "task_complete", at: now, tools: 0 }, evidence),
    attention: fact([], evidence), obligations: fact([], evidence), activity: fact({ tools: 0, flags: [], providerRetry: false }, evidence), transcript: fact({ artifact: "opaque", signature: "one", size: 100, mtimeMs: now, coveredFrom: 0, bytesRead: 100 }, evidence) };
}
test("six states share one precedence and preserve silent open-turn facts for unowned and dead processes", () => {
  const f = facts();
  expect(evaluateAgentState(f, now).state).toBe("idle");
  f.turn = { ...f.turn, value: { ...(f.turn.determined ? f.turn.value : {} as never), state: "open" }, determined: true };
  expect(evaluateAgentState(f, now).state).toBe("working");
  expect(evaluateAgentState(f, now + AGENT_STATE_POLICY.stuckMs).state).toBe("stuck");
  f.attention = fact(["permission"], f.attention.evidence);
  expect(evaluateAgentState(f, now).state).toBe("waiting-operator");
  f.owner = fact("absent", f.owner.evidence);
  expect(evaluateAgentState(f, now + AGENT_STATE_POLICY.stuckMs)).toMatchObject({ state: "unowned", stuck: true });
  f.process = fact({ status: "dead", identity: { pid: 100, startIdentity: "start", bootEpoch: "boot" } }, f.process.evidence);
  expect(evaluateAgentState(f, now).state).toBe("dead");
  expect(f.turn.determined && f.turn.value.state).toBe("open");
});
test("missing, expired or independently held evidence cannot authorize idle retirement", () => {
  const f = facts();
  expect(centralIdleEligible(f, now + AGENT_STATE_POLICY.idleMs)).toBe(true);
  for (const key of ["process", "owner", "turn", "attention", "transcript", "obligations", "activity"] as const) {
    const bad = { ...f, [key]: unknown("unreadable", f[key].evidence) };
    expect(centralIdleEligible(bad, now + AGENT_STATE_POLICY.idleMs)).toBe(false);
    expect(evaluateAgentState(bad, now).missing).toContain(key);
  }
  f.obligations = fact(["accepted-delivery"], f.obligations.evidence);
  expect(evaluateAgentState(f, now).state).toBe("idle");
  expect(centralIdleEligible(f, now + AGENT_STATE_POLICY.idleMs)).toBe(false);
  f.obligations = fact([], f.obligations.evidence);
  expect(centralIdleEligible(f, now + AGENT_STATE_POLICY.idleMs)).toBe(true);
  f.obligations = fact([], { ...f.obligations.evidence, validUntil: now - 1 });
  expect(centralIdleEligible(f, now + AGENT_STATE_POLICY.idleMs)).toBe(false);
});
