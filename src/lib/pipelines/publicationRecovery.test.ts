import { expect, test, fs, os, path, harness, tickPipelines, createPipelineFromRequest, loadPipelines, savePipelines, pipelineRevision, rawPatchPipeline, entry } from "./engine.fixture";
import { realExec, type ExecPort } from "@/lib/workflows/provision";
import { prepareStageGitGuard, stageGitReceiptDirectory } from "@/lib/git/stageAttemptGuard";
import { agentPublicationIdentityEnv } from "@/lib/git/agentPublicationIdentity";
import { OPERATOR_PAUSE_RESUME_ACTOR } from "@/lib/pauseResumeActor";
import { RuntimeJournal } from "@/runtime-host/journal";
import { RuntimeHost } from "@/runtime-host/host";
import { serveRuntimeHost } from "@/runtime-host/socket";
import { once } from "node:events";
import { defaultPipelinePorts } from "./engine";
import { beforeEach, afterEach } from "bun:test";

// Literal Git wrappers also read the parent's command configuration. Isolate
// that source as well as each child overlay, then restore the caller exactly.
let inheritedGit: Record<string, string | undefined>;
const gitKey = (key: string) => key.startsWith("GIT_") || key.startsWith("LLV_STAGE_GIT_");
beforeEach(() => {
  inheritedGit = Object.fromEntries(Object.entries(process.env).filter(([key]) => gitKey(key)));
  for (const key of Object.keys(process.env).filter(gitKey)) delete process.env[key];
});
afterEach(() => {
  for (const key of Object.keys(process.env).filter(gitKey)) delete process.env[key];
  Object.assign(process.env, inheritedGit);
});

const stages = [
  { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: "review" },
  { id: "review", kind: "run", role: { roleId: "reviewer" }, access: "read-only", prompt: "Review", next: null },
];
const current = () => loadPipelines()[0]!;

test.each(["resolve-decision", "retry-stage"] as const)(
  "a running producer behind an idle runtime alias still refuses %s after failed delivery", async action => {
    const f = await fixture();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-repair-alias-"));
    const journal = new RuntimeJournal(path.join(root, "runtime.sqlite"));
    const host = new RuntimeHost(journal);
    const socketPath = path.join(root, "host.sock");
    const server = serveRuntimeHost(socketPath, { handle: request => host.handle(request) });
    const priorSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
    process.env.LLV_RUNTIME_HOST_SOCKET = socketPath;
    try {
      await once(server, "listening");
      let clock = Date.parse("2026-10-16T10:00:00.000Z");
      f.h.ports.now = () => new Date(clock).toISOString();
      f.h.ports.resumeSeveredTurn = async () => true;
      f.h.ports.conversationDeliveryOutstanding = () => false;
      f.h.ports.stageRepairDelivery = async () => ({ operationId: "failed-alias-repair", state: "failed", safeToReplace: false });
      await f.commit("implementation"); f.refuse(); await f.finish();
      clock += 21 * 60_000;
      const parked = current();
      const attempt = parked.runs[0]!.attempts[0]!;
      const conversationId = attempt.conversationId!;
      attempt.publicationRepair!.delivery = { operationId: "failed-alias-repair", state: "failed", safeToReplace: false };
      savePipelines([parked]);
      f.h.ports.durableTurnEvidence = async () => null;
      f.h.ports.conversationAgentActive = defaultPipelinePorts().conversationAgentActive;
      for (const [id, turn] of [["idle-alias", "idle"], ["running-owner", "running"]] as const) {
        journal.append({ scope: { type: "session", id }, kind: "session-status",
          payload: { conversationId, sessionKey: { engine: "codex", sessionId: id },
            hostKind: "codex-app-server", host: "hosted", turn, attentionIds: [] },
        });
      }
      expect(await f.h.ports.conversationAgentActive(conversationId)).toBe(true);
      await tickPipelines([], f.h.ports);
      expect(current().state).toBe("needs_decision");
      const ready = current();

      const result = await rawPatchPipeline(ready.id, { action,
        ...(action === "resolve-decision" ? { clientRequestId: "running-alias-answer", answer: "Continue the accepted work.",
          expectedStageId: "build", expectedAttempt: 1, expectedRevision: pipelineRevision(ready) } : {}),
      }, f.h.ports, OPERATOR_PAUSE_RESUME_ACTOR);
      expect(result.status).toBe(409);
      expect(result.error).toContain("producer repair turn may still be running or queued");
      expect(current().state).toBe("needs_decision");
      expect(current().runs[0]!.attempts).toHaveLength(1);
      expect(current().runs[0]!.attempts[0]!.publicationRepair?.delivery?.operationId).toBe("failed-alias-repair");
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (priorSocket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET;
      else process.env.LLV_RUNTIME_HOST_SOCKET = priorSocket;
      journal.close(); fs.rmSync(root, { recursive: true, force: true }); f.close();
    }
  });

test.each(["resolve-decision", "retry-stage"] as const)(
  "a stored legacy rejected repair with a failed send permits %s", async action => {
    const f = await fixture();
    try {
      let clock = Date.parse("2026-10-16T10:00:00.000Z");
      f.h.ports.now = () => new Date(clock).toISOString();
      f.h.ports.resumeSeveredTurn = async () => false;
      f.h.ports.conversationAgentActive = async () => false;
      f.h.ports.conversationDeliveryOutstanding = () => false;
      f.h.ports.stageRepairDelivery = async () => ({ operationId: "repair-delivery", state: "failed", safeToReplace: false });
      await f.commit("implementation"); f.refuse(); await f.finish();
      clock += 21 * 60_000;
      await tickPipelines([], f.h.ports);
      const stored = current();
      const repair = stored.runs[0]!.attempts[0]!.publicationRepair!;
      // The old writer only recorded the send key on acceptance. Its rejected
      // record retained the original pass, with no start or delivery fields.
      delete repair.clientMessageId;
      delete repair.delivery;
      expect(repair.requestedAt).toBeUndefined();
      expect(repair.sendingAt).toBeUndefined();
      expect(repair.outcome?.status).toBe("rejected");
      expect(repair.settledAt).toBeDefined();
      savePipelines([stored]);
      const result = await rawPatchPipeline(stored.id, { action,
        ...(action === "resolve-decision" ? { clientRequestId: "legacy-repair-answer", answer: "Continue the accepted work.",
          expectedStageId: "build", expectedAttempt: 1, expectedRevision: pipelineRevision(stored) } : {}),
      }, f.h.ports, OPERATOR_PAUSE_RESUME_ACTOR);
      expect(result.error).toBeUndefined();
      expect(current().state).toBe("running");
      expect(current().runs[0]!.attempts).toHaveLength(action === "resolve-decision" ? 2 : 1);
      expect(current().runs[0]!.attempts[0]!.publicationRepair!.delivery?.state).toBe("failed");
      expect(f.h.spawnInputs).toHaveLength(1);
    } finally { f.close(); }
  });

test("the next controller tick heals a stored orphaned repair before an answer", async () => {
  const f = await fixture();
  try {
    let clock = Date.parse("2026-10-16T10:00:00.000Z");
    let sends = 0;
    f.h.ports.now = () => new Date(clock).toISOString();
    f.h.ports.resumeSeveredTurn = async () => { sends++; return false; };
    f.h.ports.conversationAgentActive = async () => null;
    f.h.ports.conversationDeliveryOutstanding = () => false;
    await f.commit("implementation"); f.refuse(); await f.finish();
    clock += 21 * 60_000;
    await tickPipelines([], f.h.ports);
    const stored = current();
    const repair = stored.runs[0]!.attempts[0]!.publicationRepair!;
    delete repair.clientMessageId;
    delete repair.delivery;
    delete repair.settledAt;
    delete repair.outcome;
    savePipelines([stored]);
    f.h.ports.conversationAgentActive = async () => false;
    f.h.ports.durableTurnEvidence = async () => null;
    f.h.ports.stageRepairDelivery = async () => ({ operationId: "orphaned-delivery", state: "unavailable", safeToReplace: false });
    await tickPipelines([], f.h.ports);
    expect(current().state).toBe("needs_decision");
    expect(current().runs[0]!.attempts[0]!.publicationRepair).toMatchObject({
      settledAt: new Date(clock).toISOString(), outcome: { status: "rejected" }, delivery: { state: "unavailable" },
    });
    expect(current().lastPassedCommit).toBe(stored.lastPassedCommit);
    expect(sends).toBe(1);
  } finally { f.close(); }
});

test.each(["resolve-decision", "retry-stage"] as const)("a gone producer with unreadable delivery permits %s", async action => {
  const f = await fixture();
  try {
    let clock = Date.parse("2026-10-16T10:00:00.000Z");
    f.h.ports.now = () => new Date(clock).toISOString();
    f.h.ports.resumeSeveredTurn = async () => true;
    await f.commit("implementation"); f.refuse(); await f.finish();
    clock += 21 * 60_000;
    await tickPipelines([], f.h.ports);
    f.h.ports.conversationAgentActive = async () => false;
    f.h.ports.durableTurnEvidence = async () => null;
    f.h.ports.conversationDeliveryOutstanding = () => false;
    f.h.ports.stageRepairDelivery = async () => { throw new Error("delivery store unavailable"); };
    const parked = current();
    const result = await rawPatchPipeline(parked.id, { action,
      ...(action === "resolve-decision" ? { clientRequestId: "gone-producer-answer", answer: "Continue the accepted work.",
        expectedStageId: "build", expectedAttempt: 1, expectedRevision: pipelineRevision(parked) } : {}),
    }, f.h.ports, OPERATOR_PAUSE_RESUME_ACTOR);
    expect(result.error).toBeUndefined();
    expect(current().state).toBe("running");
    expect(current().lastPassedCommit).toBe(parked.lastPassedCommit);
    expect(current().runs[0]!.attempts).toHaveLength(action === "resolve-decision" ? 2 : 1);
  } finally { f.close(); }
});

test.each(["resolve-decision", "retry-stage"] as const)("live queued repair still refuses %s after settlement", async action => {
  const f = await fixture();
  try {
    let clock = Date.parse("2026-10-16T10:00:00.000Z");
    f.h.ports.now = () => new Date(clock).toISOString();
    f.h.ports.resumeSeveredTurn = async () => true;
    await f.commit("implementation"); f.refuse(); await f.finish();
    clock += 21 * 60_000;
    await tickPipelines([], f.h.ports);
    f.h.ports.conversationAgentActive = async () => null;
    f.h.ports.conversationDeliveryOutstanding = () => true;
    f.h.ports.stageRepairDelivery = async () => ({ operationId: "queued-repair", state: "in-flight", safeToReplace: false });
    const parked = current();
    expect(parked.runs[0]!.attempts[0]!.publicationRepair!.settledAt).toBeDefined();
    const result = await rawPatchPipeline(parked.id, { action,
      ...(action === "resolve-decision" ? { clientRequestId: "queued-producer-answer", answer: "Continue.",
        expectedStageId: "build", expectedAttempt: 1, expectedRevision: pipelineRevision(parked) } : {}),
    }, f.h.ports, OPERATOR_PAUSE_RESUME_ACTOR);
    expect(result.status).toBe(409);
    expect(result.error).toContain("operation queued-repair; delivery in-flight");
    expect(current().runs[0]!.attempts).toHaveLength(1);
  } finally { f.close(); }
});

test.each((["resolve-decision", "retry-stage"] as const).flatMap(action =>
  (["stale-turn", "failed-receipt", "unavailable-receipt", "different-operation"] as const).map(kind => ({ action, kind })),
))("repair terminal evidence for $kind ($action)", async ({ action, kind }) => {
  const f = await fixture();
  try {
    let clock = Date.parse("2026-10-16T10:00:00.000Z");
    f.h.ports.now = () => new Date(clock).toISOString();
    f.h.ports.resumeSeveredTurn = async () => true;
    await f.commit("implementation"); f.refuse(); await f.finish();
    clock += 21 * 60_000;
    await tickPipelines([], f.h.ports);
    const parked = current();
    if (kind !== "stale-turn") {
      parked.runs[0]!.attempts[0]!.publicationRepair!.delivery = {
        operationId: "failed-repair", state: "failed", safeToReplace: false,
      };
      savePipelines([parked]);
    }
    f.h.ports.conversationAgentActive = async () => kind === "stale-turn" ? false : null;
    f.h.ports.durableTurnEvidence = async () => kind === "stale-turn" ? { turn: "busy", message: null,
      backgroundTasks: [{ id: "stale-command", kind: "command", startedAt: clock - 60_000, expiresAt: null }] } : null;
    f.h.ports.conversationDeliveryOutstanding = () => kind === "stale-turn";
    f.h.ports.stageRepairDelivery = async () => {
      if (kind === "unavailable-receipt" || kind === "different-operation") return {
        operationId: kind === "different-operation" ? "replacement-send" : "failed-repair", state: "unavailable", safeToReplace: false,
      };
      throw new Error("delivery store unavailable");
    };
    const result = await rawPatchPipeline(parked.id, { action,
      ...(action === "resolve-decision" ? { clientRequestId: `terminal-${kind}`, answer: "Continue after the terminal repair.",
        expectedStageId: "build", expectedAttempt: 1, expectedRevision: pipelineRevision(parked) } : {}),
    }, f.h.ports, OPERATOR_PAUSE_RESUME_ACTOR);
    if (kind === "different-operation") {
      expect(result.status).toBe(409);
      expect(result.error).toContain("operation replacement-send; delivery unavailable");
      expect(current().runs[0]!.attempts).toHaveLength(1);
    } else {
      expect(result.error).toBeUndefined();
      expect(current().runs[0]!.attempts).toHaveLength(action === "resolve-decision" ? 2 : 1);
    }
  } finally { f.close(); }
});

test("retry rechecks repair identity after asynchronous delivery evidence", async () => {
  const f = await fixture();
  try {
    let clock = Date.parse("2026-10-16T10:00:00.000Z");
    f.h.ports.now = () => new Date(clock).toISOString();
    f.h.ports.resumeSeveredTurn = async () => true;
    await f.commit("implementation"); f.refuse(); await f.finish();
    clock += 21 * 60_000;
    await tickPipelines([], f.h.ports);
    f.h.ports.conversationAgentActive = async () => false;
    f.h.ports.stageRepairDelivery = async () => {
      const changed = current();
      changed.runs[0]!.attempts[0]!.publicationRepair!.operationId = "replacement-publication";
      savePipelines([changed]);
      return { operationId: "old-repair-delivery", state: "failed", safeToReplace: false };
    };
    const result = await rawPatchPipeline(current().id, { action: "retry-stage" }, f.h.ports);
    expect(result.status).toBe(409);
    expect(result.error).toContain("producer repair turn");
    expect(current().state).toBe("needs_decision");
  } finally { f.close(); }
});

test("a publication repair whose admitted delivery never starts permits a decision after its deadline", async () => {
  const f = await fixture();
  try {
    let clock = Date.parse("2026-10-16T10:00:00.000Z");
    f.h.ports.now = () => new Date(clock).toISOString();
    f.h.ports.resumeSeveredTurn = async () => true;
    f.h.ports.conversationAgentActive = async () => null;
    f.h.ports.conversationDeliveryOutstanding = () => false;
    Object.assign(f.h.ports, { stageRepairDelivery: async () => clock < Date.parse("2026-10-16T10:20:00.000Z")
      ? { operationId: "repair-delivery", state: "in-flight", safeToReplace: false }
      : { operationId: "repair-delivery", state: "failed", safeToReplace: true } });
    await f.commit("implementation"); f.refuse(); await f.finish();
    expect(current().runs[0]!.attempts[0]!.publicationRepair?.requestedAt).toBeDefined();
    clock += 21 * 60_000;
    await tickPipelines([], f.h.ports);
    const parked = current();
    expect(parked.runs[0]!.attempts[0]!.publicationRepair).toMatchObject({ outcome: { status: "rejected" } });
    const result = await rawPatchPipeline(parked.id, { action: "resolve-decision", clientRequestId: "expired-undelivered-repair",
      answer: "Continue after the undelivered repair expired.", expectedStageId: "build", expectedAttempt: 1,
      expectedRevision: pipelineRevision(parked) }, f.h.ports, OPERATOR_PAUSE_RESUME_ACTOR);
    expect(result.error).toBeUndefined();
    expect(current().runs[0]!.attempts).toHaveLength(2);
  } finally { f.close(); }
});

test("a completed producer repair survives a lost delivery acknowledgement after controller restart", async () => {
  const f = await fixture();
  try {
    let clock = Date.parse("2026-10-16T10:00:00.000Z");
    const keys: string[] = [];
    f.h.ports.now = () => new Date(clock).toISOString();
    f.h.ports.resumeSeveredTurn = async input => { keys.push(input.clientMessageId); input.onUncertain?.(); return false; };
    f.h.ports.conversationAgentActive = async () => null;
    f.h.ports.conversationDeliveryOutstanding = () => false;
    f.h.ports.stageRepairDelivery = async () => ({ operationId: "repair-delivery", state: "delivered", safeToReplace: false });
    await f.commit("implementation"); f.refuse(); await f.finish();
    const sendingAt = Date.parse(current().runs[0]!.attempts[0]!.publicationRepair!.sendingAt!);
    f.h.ports.durableTurnEvidence = async () => ({ turn: "terminal", message: { text: "repair finished", ts: sendingAt + 1 }, lastRecordAt: sendingAt + 1 });
    clock = sendingAt + 21 * 60_000;
    await tickPipelines([], f.h.ports);
    const parked = current();
    const result = await rawPatchPipeline(parked.id, { action: "resolve-decision", clientRequestId: "completed-lost-ack",
      answer: "Continue after the completed repair.", expectedStageId: "build", expectedAttempt: 1,
      expectedRevision: pipelineRevision(parked) }, f.h.ports, OPERATOR_PAUSE_RESUME_ACTOR);
    expect(result.error).toBeUndefined();
    expect(current().runs[0]!.attempts).toHaveLength(2);
    expect(keys).toHaveLength(1);
  } finally { f.close(); }
});

test.each(["undelivered", "legacy-failed", "gone"] as const)("a %s publication repair remains recoverable in a new controller process", async kind => {
  const f = await fixture();
  try {
    let clock = Date.parse("2026-10-16T10:00:00.000Z");
    f.h.ports.now = () => new Date(clock).toISOString();
    f.h.ports.resumeSeveredTurn = async () => true;
    await f.commit("implementation"); f.refuse(); await f.finish();
    clock += 21 * 60_000;
    await tickPipelines([], f.h.ports);
    const parked = current();
    if (kind !== "undelivered") {
      const repair = parked.runs[0]!.attempts[0]!.publicationRepair!;
      delete repair.requestedAt;
      delete repair.sendingAt;
      delete repair.clientMessageId;
      delete repair.delivery;
      savePipelines([parked]);
    }
    const request = { action: "resolve-decision", clientRequestId: "restarted-expired-repair",
      answer: "Continue after the repair expired.", expectedStageId: "build", expectedAttempt: 1,
      expectedRevision: pipelineRevision(parked) };
    const script = `
      const { patchPipeline, defaultPipelinePorts } = await import(${JSON.stringify(path.join(import.meta.dir, "engine.ts"))});
      const ports = {
        ...defaultPipelinePorts(), now: () => ${JSON.stringify(new Date(clock).toISOString())},
        conversationAgentActive: async () => ${kind === "gone" ? "false" : "null"}, conversationDeliveryOutstanding: () => false,
        durableTurnEvidence: async () => ({ turn: "terminal", message: null }),
        stageRepairDelivery: async () => ({ operationId: "repair-delivery", state: ${JSON.stringify(kind === "gone" ? "unavailable" : "failed")}, safeToReplace: ${kind === "undelivered"} }),
      };
      const result = await patchPipeline(${JSON.stringify(parked.id)}, ${JSON.stringify(request)}, ports, { kind: "operator" });
      const replay = await patchPipeline(${JSON.stringify(parked.id)}, ${JSON.stringify(request)}, ports, { kind: "operator" });
      console.log(JSON.stringify({ error: result.error ?? null, attempts: result.pipeline?.runs[0]?.attempts.length,
        replayed: replay.replayed, replayAttempts: replay.pipeline?.runs[0]?.attempts.length }));`;
    const result = await realExec(process.execPath, ["-e", script], process.cwd(), {
      ...process.env, LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1",
    }, { timeoutMs: 30_000 });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ error: null, attempts: 2, replayed: true, replayAttempts: 2 });
  } finally { f.close(); }
}, 40_000);

test.each([{ admitted: false, uncertain: false }, { admitted: false, uncertain: true }, { admitted: true, uncertain: false }])(
  "a publication repair settles when delivery fails or admission never starts (admitted: $admitted, uncertain: $uncertain)", async ({ admitted, uncertain }) => {
  const f = await fixture();
  try {
    let clock = Date.parse("2026-10-16T10:00:00.000Z"), failed = false;
    const keys: string[] = [];
    f.h.ports.now = () => new Date(clock).toISOString();
    f.h.ports.conversationAgentActive = async () => null;
    f.h.ports.conversationDeliveryOutstanding = () => false;
    f.h.ports.resumeSeveredTurn = async input => { keys.push(input.clientMessageId); if (uncertain) input.onUncertain?.(); return admitted; };
    f.h.ports.stageRepairDelivery = async () => ({ operationId: admitted ? "repair-delivery" : null,
      state: admitted ? failed ? "failed" : "in-flight" : "unreserved", safeToReplace: !admitted || failed });
    await f.commit("implementation"); f.refuse(); await f.finish();
    failed = true;
    clock += admitted ? 1_000 : 21 * 60_000;
    await tickPipelines([], f.h.ports);
    const parked = current();
    expect(parked.state).toBe("needs_decision");
    expect(parked.runs[0]!.attempts[0]!.publicationRepair).toMatchObject({ outcome: { status: "rejected" }, settledAt: new Date(clock).toISOString() });
    const result = await rawPatchPipeline(parked.id, { action: "resolve-decision", clientRequestId: `failed-admission-${admitted}`,
      answer: "Continue after the repair could not be delivered.", expectedStageId: "build", expectedAttempt: 1,
      expectedRevision: pipelineRevision(parked) }, f.h.ports, OPERATOR_PAUSE_RESUME_ACTOR);
    expect(result.error).toBeUndefined();
    expect(new Set(keys).size).toBe(1);
  } finally { f.close(); }
});

test("a delayed repair delivery preflight loses permission at the original deadline", async () => {
  const f = await fixture();
  try {
    let clock = Date.parse("2026-10-16T10:00:00.000Z"), checked = false;
    f.h.ports.now = () => new Date(clock).toISOString();
    f.h.ports.resumeSeveredTurn = async input => {
      expect(input.policy).toBe("queue");
      expect(await input.continuationAllowed!()).toBe(true);
      clock += 20 * 60_000;
      expect(await input.continuationAllowed!()).toBe(false);
      checked = true;
      return false;
    };
    await f.commit("implementation"); f.refuse(); await f.finish();
    expect(checked).toBe(true);
    await tickPipelines([], f.h.ports);
    expect(current().runs[0]!.attempts[0]!.publicationRepair).toMatchObject({ outcome: { status: "rejected" } });
    expect(f.h.spawnInputs).toHaveLength(1);
  } finally { f.close(); }
});

test("a still-running repair names its operation and delivery state before the deadline", async () => {
  const f = await fixture();
  try {
    f.h.ports.now = () => "2026-10-16T10:00:00.000Z";
    f.h.ports.resumeSeveredTurn = async () => true;
    f.h.ports.stageRepairDelivery = async () => ({ operationId: "repair-delivery", state: "in-flight", safeToReplace: false });
    await f.commit("implementation"); f.refuse(); await f.finish();
    const running = current();
    for (const action of ["resolve-decision", "retry-stage"] as const) {
      const result = await rawPatchPipeline(running.id, { action, expectedStageId: "build", expectedAttempt: 1,
        ...(action === "resolve-decision" ? { clientRequestId: `pending-${action}`, answer: "Continue.", expectedRevision: pipelineRevision(running) } : {}),
      }, f.h.ports, OPERATOR_PAUSE_RESUME_ACTOR);
      expect(result.status, result.error).toBe(409);
      expect(result.error).toContain("operation repair-delivery; delivery in-flight");
    }
  } finally { f.close(); }
});

test("infrastructure deadline exhaustion parks without asking the producer to repair capacity", async () => {
  const f = await fixture();
  try {
    let clock = Date.parse("2026-10-16T10:00:00.000Z"), requests = 0;
    f.h.ports.now = () => new Date(clock).toISOString();
    f.h.ports.resumeSeveredTurn = async () => { requests++; return true; };
    await f.commit("implementation");
    fs.writeFileSync(path.join(f.hooks, "pre-push"), "#!/bin/sh\necho 'pre-push: touched tests: failed (124)' >&2\necho 'owned runner: deadline expired' >&2\nexit 1\n", { mode: 0o700 });
    await f.finish();
    for (const delay of [60_000, 5 * 60_000, 15 * 60_000]) {
      clock += delay;
      for (let n = 0; n < 4; n++) await tickPipelines([], f.h.ports);
    }
    const parked = current();
    expect(parked.state).toBe("needs_decision");
    expect(parked.runs[0]!.attempts[0]!.publicationRepair).toBeUndefined();
    expect(requests).toBe(0);
    expect(parked.publicationRecovery?.[parked.lastPassedCommit]).toMatchObject({ failures: 4, totalAttempts: 4 });
    expect(parked.stateDetail).toContain("after 3 automatic retries");
  } finally { f.close(); }
});

test.each(["failed", "unreserved", "live", "uncertain", "background", "outstanding"] as const)(
  "publication repair recovery respects delivery and producer evidence: %s", async kind => {
    const f = await fixture();
    try {
      let clock = Date.parse("2026-10-16T10:00:00.000Z");
      f.h.ports.now = () => new Date(clock).toISOString();
      f.h.ports.resumeSeveredTurn = async () => true;
      f.h.ports.conversationAgentActive = async () => null;
      f.h.ports.conversationDeliveryOutstanding = () => false;
      Object.assign(f.h.ports, { stageRepairDelivery: async () => ({ operationId: "repair-delivery",
        state: kind === "unreserved" ? "unreserved" : "failed", safeToReplace: kind !== "uncertain" }) });
      await f.commit("implementation"); f.refuse(); await f.finish();
      if (kind === "live") f.h.ports.conversationAgentActive = async () => true;
      clock += 21 * 60_000;
      await tickPipelines([], f.h.ports);
      if (kind === "background") f.h.ports.durableTurnEvidence = async () => ({ turn: "terminal", message: null,
        backgroundTasks: [{ id: "repair-background", kind: "command", startedAt: clock, expiresAt: null }] });
      if (kind === "outstanding") f.h.ports.conversationDeliveryOutstanding = () => true;
      const parked = current();
      const result = await rawPatchPipeline(parked.id, { action: "resolve-decision", clientRequestId: `delivery-${kind}`,
        answer: "Continue after the repair settled.", expectedStageId: "build", expectedAttempt: 1,
        expectedRevision: pipelineRevision(parked) }, f.h.ports, OPERATOR_PAUSE_RESUME_ACTOR);
      if (kind === "failed" || kind === "unreserved" || kind === "uncertain") expect(result.error).toBeUndefined();
      else {
        expect(result.status).toBe(409);
        expect(result.error).toContain("repair-delivery");
        expect(result.error).toContain("failed");
        expect(current().runs[0]!.attempts).toHaveLength(1);
      }
    } finally { f.close(); }
  });

test.each([false, true])("retry-stage checks the publication repair producer before retrying (live: %s)", async live => {
  const f = await fixture();
  try {
    let clock = Date.parse("2026-10-16T10:00:00.000Z");
    f.h.ports.now = () => new Date(clock).toISOString();
    f.h.ports.resumeSeveredTurn = async () => true;
    f.h.ports.conversationAgentActive = async () => null;
    f.h.ports.conversationDeliveryOutstanding = () => false;
    Object.assign(f.h.ports, { stageRepairDelivery: async () => ({ operationId: "repair-delivery", state: "failed", safeToReplace: true }) });
    await f.commit("implementation"); f.refuse(); await f.finish();
    if (live) f.h.ports.conversationAgentActive = async () => true;
    clock += 21 * 60_000;
    await tickPipelines([], f.h.ports);
    const result = await rawPatchPipeline(current().id, { action: "retry-stage" }, f.h.ports);
    if (live) {
      expect(result.status).toBe(409);
      expect(result.error).toContain("repair-delivery");
    } else expect(result.error).toBeUndefined();
  } finally { f.close(); }
});

async function fixture(prelaunchPrefix?: "unrecorded" | "hooks-off" | "foreign", stageList = stages) {
  savePipelines([]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "publication-recovery-"));
  const repo = path.join(root, "repo"), remote = path.join(root, "remote.git"), hooks = path.join(root, "hooks");
  const clean: Partial<NodeJS.ProcessEnv> = Object.fromEntries(Object.keys(process.env)
    .filter(key => key.startsWith("GIT_") || key.startsWith("LLV_STAGE_GIT_")).map(key => [key, undefined]));
  Object.assign(clean, { HOME: root, XDG_CONFIG_HOME: path.join(root, "config"), GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(root, "absent"), GIT_CONFIG_COUNT: "0",
    GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "noreply@example.invalid", GIT_COMMITTER_EMAIL: "noreply@example.invalid",
    GIT_AUTHOR_DATE: "2026-10-16T08:00:00Z", GIT_COMMITTER_DATE: "2026-10-16T08:00:00Z" });
  let agentEnv: Partial<NodeJS.ProcessEnv> = clean;
  let lane = "";
  const execute: ExecPort = (command, args, cwd, env, options) => realExec(command, args, cwd, { ...clean, ...env }, options);
  const git = async (cwd: string, ...args: string[]) => {
    const result = await execute("git", args, cwd, cwd === lane ? agentEnv : clean);
    expect(result.code, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  fs.mkdirSync(repo); fs.mkdirSync(hooks);
  await git(root, "init", "--bare", "--initial-branch=main", remote);
  await git(repo, "init", "--initial-branch=main");
  await git(repo, "config", "core.hooksPath", hooks);
  fs.writeFileSync(path.join(repo, "file.txt"), "base\n");
  await git(repo, "add", "."); await git(repo, "commit", "-m", "base");
  await git(repo, "remote", "add", "origin", remote); await git(repo, "push", "origin", "main");
  const h = harness();
  h.ports.exec = execute;
  h.ports.provisionExec = async (command, args, cwd, signal) => await execute(command, args, cwd, undefined, { signal });
  h.ports.resumeSeveredTurn = undefined;
  h.ports.restartRecoveryBootId = () => "publication-recovery-boot";
  h.ports.restartRecoveryBootStartedAt = () => 0;
  const spawn = h.ports.spawnAgent;
  h.ports.spawnAgent = async (input, reserved) => {
    const launchId = `recovery-${input.clientAttemptId}`;
    const result = await spawn(input, async reservation => {
      await reserved({ ...reservation, launchId });
      lane = input.cwd;
      if (prelaunchPrefix && input.clientAttemptId.endsWith("_build_1")) {
        let prefix: string;
        if (prelaunchPrefix === "foreign") {
          const foreign = path.join(root, "prelaunch-foreign-prefix");
          await git(lane, "worktree", "add", "--detach", foreign, "HEAD");
          const made = await execute("git", ["-c", "core.hooksPath=", "commit", "--allow-empty", "-m", "prelaunch foreign prefix"], foreign, clean);
          expect(made.code, made.stderr).toBe(0);
          prefix = await git(foreign, "rev-parse", "HEAD");
          await git(lane, "merge", "--ff-only", prefix);
        } else {
          const args = ["commit", "--allow-empty", "-m", `prelaunch ${prelaunchPrefix} prefix`];
          const made = await execute("git", prelaunchPrefix === "hooks-off" ? ["-c", "core.hooksPath=", ...args] : args, lane, clean);
          expect(made.code, made.stderr).toBe(0);
          prefix = await git(lane, "rev-parse", "HEAD");
        }
        const pushed = await execute("git", ["-c", "core.hooksPath=", "push", "origin", `HEAD:${current().delivery!.target.branch}`], lane, clean);
        expect(pushed.code, pushed.stderr).toBe(0);
        expect(await git(remote, "rev-parse", current().delivery!.target.branch)).toBe(prefix);
      }
      const guard = await prepareStageGitGuard(launchId, lane, execute, h.ports.now(), async () => {});
      agentEnv = { ...clean, ...guard, ...agentPublicationIdentityEnv({ ...process.env, ...clean, ...guard }) };
    });
    return { ...result, launchId, paneId: null };
  };
  const created = await createPipelineFromRequest({ task: "Recover stage publication", repoDir: repo, baseRef: await git(repo, "rev-parse", "HEAD"),
    publication: "remote-branch", stages: stageList as never }, h.ports);
  expect(created.error).toBeUndefined();
  await tickPipelines([], h.ports); await tickPipelines([], h.ports);
  expect(current().cursor, current().stateDetail ?? "").toMatchObject({ stageId: "build", state: "running" });
  const commit = async (text: string) => {
    fs.writeFileSync(path.join(lane, "file.txt"), `${text}\n`);
    await git(lane, "add", "file.txt"); await git(lane, "commit", "-m", text);
    return git(lane, "rev-parse", "HEAD");
  };
  const refuse = () => fs.writeFileSync(path.join(hooks, "pre-push"), '#!/bin/sh\necho "pre-push: touched tests" >&2\necho "NEW file.test.ts: failing assertion" >&2\nexit 1\n', { mode: 0o700 });
  const finish = async (n = 1) => tickPipelines([h.finish(`/codex/stage-${n}.jsonl`, "pass", "implemented")], h.ports);
  return { root, repo, remote, hooks, h, git, commit, finish, refuse, lane: () => lane, execute,
    agentGit: async (cwd: string, ...args: string[]) => {
      const result = await execute("git", args, cwd, agentEnv);
      expect(result.code, result.stderr).toBe(0); return result.stdout.trim();
    },
    close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test.each(["unrecorded", "hooks-off", "foreign"] as const)(
  "ordinary retry refuses a %s inherited head before publishing its receipted output", async origin => {
    const twoWritableStages = [
      { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: "retry" },
      { id: "retry", kind: "run", role: { roleId: "builder" }, prompt: "Retry", next: "review" },
      { id: "review", kind: "run", role: { roleId: "reviewer" }, access: "read-only", prompt: "Review", next: null },
    ];
    const f = await fixture(undefined, twoWritableStages);
    try {
      const accepted = await f.commit("first stage accepted output");
      await f.finish(1);
      await tickPipelines([], f.h.ports);
      expect(current()).toMatchObject({ lastPassedCommit: accepted, publishedCommit: accepted,
        cursor: { stageId: "retry", state: "running" } });
      const active = current();
      active.runs!.find(run => run.stageId === "retry")!.attempts[0]!.paneId = "ordinary-retry-pane";
      savePipelines([active]);
      await f.git(f.lane(), "reset", "--hard", current().baseRef);

      let divergent: string;
      if (origin === "foreign") {
        const foreign = path.join(f.root, "ordinary-retry-foreign");
        await f.git(f.lane(), "worktree", "add", "--detach", foreign, current().baseRef);
        await f.git(foreign, "commit", "--allow-empty", "-m", "foreign retry starting commit");
        divergent = await f.git(foreign, "rev-parse", "HEAD");
        await f.git(f.lane(), "fetch", foreign, divergent);
        await f.git(f.lane(), "reset", "--hard", divergent);
      } else {
        const args = ["commit", "--allow-empty", "-m", `${origin} retry starting commit`];
        const result = await f.execute("git", origin === "hooks-off" ? ["-c", "core.hooksPath=", ...args] : args,
          f.lane(), undefined);
        expect(result.code, result.stderr).toBe(0);
        divergent = await f.git(f.lane(), "rev-parse", "HEAD");
        if (origin === "unrecorded") {
          const attempt = current().runs!.find(run => run.stageId === "retry")!.attempts[0]!;
          fs.rmSync(path.join(stageGitReceiptDirectory(attempt.launchId!), "commits", divergent), { force: true });
        }
      }
      expect(await f.git(f.remote, "rev-parse", current().delivery!.target.branch)).toBe(accepted);
      await tickPipelines([f.h.finish("/codex/stage-2.jsonl", "fail", "retry this stage")], f.h.ports);
      expect((await rawPatchPipeline(current().id, { action: "retry-stage" }, f.h.ports)).error).toBeUndefined();
      await tickPipelines([], f.h.ports);
      expect(current().runs!.find(run => run.stageId === "retry")!.attempts[1]!.restartContext).toBeUndefined();
      await f.git(f.lane(), "merge", "--no-ff", "-m", "restore the accepted boundary", accepted);
      const output = await f.commit("receipted retry output");
      await tickPipelines([f.h.finish("/codex/stage-3.jsonl", "pass", "implemented")], f.h.ports);

      expect(current().state).toBe("needs_decision");
      expect(current().stateDetail).toContain(divergent);
      expect(current().lastPassedCommit).toBe(accepted);
      expect(await f.git(f.remote, "rev-parse", current().delivery!.target.branch)).toBe(accepted);
      expect(await f.git(f.lane(), "merge-base", "--is-ancestor", output, "HEAD")).toBe("");
    } finally { f.close(); }
  });

test.each([false, true])("a real refused pre-push admits one fresh decision attempt on the current head with refusal output (moved: %s)", async moved => {
  const f = await fixture();
  try {
    let head = await f.commit("implementation"); f.refuse(); await f.finish();
    if (moved) head = await f.commit("producer repair before decision");
    const parked = current();
    expect(parked.state).toBe("needs_decision");
    expect(parked.stateDetail).toContain("NEW file.test.ts");
    const original = structuredClone(parked.runs[0]!.attempts[0]!);
    const request = { action: "resolve-decision" as const, clientRequestId: "repair-publication", answer: "Repair the failing test and run the checks again.",
      expectedStageId: "build", expectedAttempt: 1, expectedRevision: pipelineRevision(parked) };
    const actor = OPERATOR_PAUSE_RESUME_ACTOR;
    f.h.setConversationActive(false);
    const accepted = await rawPatchPipeline(parked.id, request, f.h.ports, actor);
    expect(accepted.error).toBeUndefined();
    expect((await rawPatchPipeline(parked.id, request, f.h.ports, actor)).replayed).toBe(true);
    expect(current().runs[0]!.attempts).toHaveLength(2);
    expect(current().runs[0]!.attempts[0]).toEqual(original);
    expect(await f.git(f.lane(), "rev-parse", "HEAD")).toBe(head);
    fs.unlinkSync(path.join(f.hooks, "pre-push"));
    await tickPipelines([], f.h.ports);
    expect(f.h.spawnInputs).toHaveLength(2);
    expect(f.h.spawnInputs[1]!.prompt).toContain("NEW file.test.ts");
    const repaired = await f.commit("repaired test"); await f.finish(2);
    expect(current()).toMatchObject({ state: "running", lastPassedCommit: repaired, publishedCommit: repaired,
      cursor: { stageId: "review", state: "pending" } });
  } finally { f.close(); }
});

test("a receipted producer commit after acceptance proceeds to review", async () => {
  const f = await fixture();
  try {
    await f.commit("implementation"); f.refuse(); await f.finish();
    expect(current().state).toBe("needs_decision");
    const repaired = await f.commit("producer repair");
    fs.unlinkSync(path.join(f.hooks, "pre-push"));
    expect((await rawPatchPipeline(current().id, { action: "retry-stage" }, f.h.ports)).error).toBeUndefined();
    await tickPipelines([], f.h.ports);
    expect(current()).toMatchObject({ state: "running", lastPassedCommit: repaired, publishedCommit: repaired,
      cursor: { stageId: "review", state: "pending" } });
    expect(f.h.spawnInputs).toHaveLength(1);
  } finally { f.close(); }
});

test("a fresh attempt can finish after the controller accepted and committed dirty producer output", async () => {
  const f = await fixture();
  try {
    fs.writeFileSync(path.join(f.lane(), "file.txt"), "implementation output\n");
    f.refuse(); await f.finish();
    const accepted = await f.git(f.lane(), "rev-parse", "HEAD");
    expect(fs.existsSync(path.join(stageGitReceiptDirectory(current().runs[0]!.attempts[0]!.launchId!), "commits", accepted))).toBe(false);
    expect(current().state).toBe("needs_decision");
    f.h.setConversationActive(false);
    await rawPatchPipeline(current().id, { action: "resolve-decision", clientRequestId: "dirty-output-retry",
      answer: "Run the stage again.", expectedStageId: "build", expectedAttempt: 1,
      expectedRevision: pipelineRevision(current()) }, f.h.ports, OPERATOR_PAUSE_RESUME_ACTOR);
    fs.unlinkSync(path.join(f.hooks, "pre-push"));
    await tickPipelines([], f.h.ports);
    const repaired = await f.commit("fresh attempt repair"); await f.finish(2);
    expect(current()).toMatchObject({ state: "running", lastPassedCommit: repaired, publishedCommit: repaired,
      cursor: { stageId: "review", state: "pending" } });
  } finally { f.close(); }
});

test.each([
  { proof: "proved", writes: true }, { proof: "proved", writes: false },
  { proof: "unrecorded", writes: true }, { proof: "hooks-off", writes: false }, { proof: "foreign", writes: false },
])("a replacement checks the lost attempt's $proof commits (replacement writes: $writes)", async ({ proof, writes }) => {
  const f = await fixture();
  try {
    let first: string;
    if (proof === "foreign") {
      const foreign = path.join(f.root, "foreign-output");
      await f.git(f.lane(), "worktree", "add", "--detach", foreign, "HEAD");
      await f.git(foreign, "commit", "--allow-empty", "-m", "foreign output");
      first = await f.git(foreign, "rev-parse", "HEAD");
      await f.git(f.lane(), "merge", "--ff-only", first);
    } else if (proof === "hooks-off") {
      const made = await f.execute("git", ["-c", "core.hooksPath=", "commit", "--allow-empty", "-m", "unproved output"], f.lane());
      expect(made.code, made.stderr).toBe(0);
      first = await f.git(f.lane(), "rev-parse", "HEAD");
    } else first = await f.commit("lost attempt output");
    const old = current().runs[0]!.attempts[0]!;
    if (proof === "unrecorded") fs.unlinkSync(path.join(stageGitReceiptDirectory(old.launchId!), "commits", first));
    expect(fs.existsSync(path.join(stageGitReceiptDirectory(old.launchId!), "commits", first))).toBe(proof === "proved");
    f.h.durableTurns.set(old.agentPath!, { turn: "busy", message: null, lastRecordAt: Date.parse(old.startedAt!) + 1 });
    f.h.advanceWallClock(600_000);
    f.h.ports.conversationTurnInterrupted = async () => "dead";
    await tickPipelines([entry(old.agentPath!)], f.h.ports);
    await tickPipelines([], f.h.ports);
    expect(current().runs[0]!.attempts).toHaveLength(2);
    expect(current().runs[0]!.attempts[1]!.restartContext).toMatchObject({ previousAttempt: 1, cause: "host-lost" });
    expect(current().worktreeDir).toBe(f.lane());
    const head = writes ? await f.commit("replacement output") : first;
    await f.finish(2);
    if (proof === "proved") {
      expect(current()).toMatchObject({ lastPassedCommit: head, publishedCommit: head, cursor: { stageId: "review", state: "pending" } });
    } else {
      expect(current().state).toBe("needs_decision");
      expect(current().stateDetail).toContain(first);
      expect(current().publishedCommit).toBeNull();
    }
  } finally { f.close(); }
});

for (const proof of ["proved", "unrecorded", "hooks-off", "foreign"] as const) {
  test(`a replacement validates the already-published ${proof} prefix against attempt custody`, async () => {
    const f = await fixture();
    try {
      let prefix: string;
      if (proof === "foreign") {
        const foreign = path.join(f.root, "published-foreign-prefix");
        await f.git(f.lane(), "worktree", "add", "--detach", foreign, "HEAD");
        await f.git(foreign, "commit", "--allow-empty", "-m", "published foreign prefix");
        prefix = await f.git(foreign, "rev-parse", "HEAD");
        await f.git(f.lane(), "merge", "--ff-only", prefix);
      } else if (proof === "hooks-off") {
        const made = await f.execute("git", ["-c", "core.hooksPath=", "commit", "--allow-empty", "-m", "published hooks-off prefix"], f.lane());
        expect(made.code, made.stderr).toBe(0);
        prefix = await f.git(f.lane(), "rev-parse", "HEAD");
      } else prefix = await f.commit(`published ${proof} prefix`);

      const old = current().runs[0]!.attempts[0]!;
      if (proof === "unrecorded") fs.unlinkSync(path.join(stageGitReceiptDirectory(old.launchId!), "commits", prefix));
      if (proof === "proved") await f.agentGit(f.lane(), "push", "origin", `HEAD:${current().delivery!.target.branch}`);
      else {
        const pushed = await f.execute("git", ["-c", "core.hooksPath=", "push", "origin", `HEAD:${current().delivery!.target.branch}`], f.lane());
        expect(pushed.code, pushed.stderr).toBe(0);
      }
      expect(await f.git(f.remote, "rev-parse", current().delivery!.target.branch)).toBe(prefix);

      f.h.durableTurns.set(old.agentPath!, { turn: "busy", message: null, lastRecordAt: Date.parse(old.startedAt!) + 1 });
      f.h.advanceWallClock(600_000);
      f.h.ports.conversationTurnInterrupted = async () => "dead";
      await tickPipelines([entry(old.agentPath!)], f.h.ports);
      await tickPipelines([], f.h.ports);
      expect(current().runs[0]!.attempts[1]!.restartContext).toMatchObject({ previousAttempt: 1, cause: "host-lost" });
      const head = await f.commit("replacement suffix after published prefix");
      await f.finish(2);
      if (proof === "proved") {
        expect(current()).toMatchObject({ lastPassedCommit: head, publishedCommit: head, cursor: { stageId: "review", state: "pending" } });
      } else {
        expect(current().state).toBe("needs_decision");
        expect(current().stateDetail).toContain(prefix);
        expect(current().publishedCommit).toBeNull();
      }
    } finally { f.close(); }
  });
}

for (const proof of ["unrecorded", "hooks-off", "foreign"] as const) {
  test(`a replacement refuses an unaccepted ${proof} prefix already in its predecessor's starting head`, async () => {
    const f = await fixture(proof);
    try {
      const old = current().runs[0]!.attempts[0]!;
      const prefix = await f.git(f.lane(), "rev-parse", "HEAD");
      expect(fs.existsSync(path.join(stageGitReceiptDirectory(old.launchId!), "commits", prefix))).toBe(false);
      f.h.durableTurns.set(old.agentPath!, { turn: "busy", message: null, lastRecordAt: Date.parse(old.startedAt!) + 1 });
      f.h.advanceWallClock(600_000);
      f.h.ports.conversationTurnInterrupted = async () => "dead";
      await tickPipelines([entry(old.agentPath!)], f.h.ports);
      await tickPipelines([], f.h.ports);
      expect(current().runs[0]!.attempts[1]!.restartContext).toMatchObject({ previousAttempt: 1, cause: "host-lost" });
      const suffix = await f.commit("replacement suffix after unaccepted starting prefix");
      await f.finish(2);
      expect(current().state).toBe("needs_decision");
      expect(current().stateDetail).toContain(prefix);
      expect(current().publishedCommit).toBeNull();
      expect(current().lastPassedCommit).not.toBe(suffix);
    } finally { f.close(); }
  });
}

test("a passed replacement's custody refusal can be answered without resetting its checkout", async () => {
  const f = await fixture();
  try {
    const head = await f.commit("lost attempt output");
    const old = current().runs[0]!.attempts[0]!;
    // Model a commit whose creation cannot be attributed to any launch.
    fs.unlinkSync(path.join(stageGitReceiptDirectory(old.launchId!), "commits", head));
    f.h.durableTurns.set(old.agentPath!, { turn: "busy", message: null, lastRecordAt: Date.parse(old.startedAt!) + 1 });
    f.h.advanceWallClock(600_000);
    f.h.ports.conversationTurnInterrupted = async () => "dead";
    await tickPipelines([entry(old.agentPath!)], f.h.ports);
    await tickPipelines([], f.h.ports);
    expect(current().runs[0]!.attempts[1]!.restartContext).toMatchObject({ previousAttempt: 1, cause: "host-lost" });
    await f.finish(2);
    const parked = current();
    expect(parked.state).toBe("needs_decision");
    expect(parked.stateDetail).toContain("not created in the attempt worktree");
    expect(parked.runs[0]!.attempts[1]!.verdict?.status).toBe("pass");
    f.h.setConversationActive(false);
    const request = { action: "resolve-decision" as const, clientRequestId: "answer-custody-refusal",
      answer: "Investigate the missing creation receipt while preserving the accepted history.",
      expectedStageId: "build", expectedAttempt: 2, expectedRevision: pipelineRevision(parked) };
    const result = await rawPatchPipeline(parked.id, request, f.h.ports, OPERATOR_PAUSE_RESUME_ACTOR);
    expect(result.error).toBeUndefined();
    expect(current().runs[0]!.attempts[1]!.report).toEqual(parked.runs[0]!.attempts[1]!.report);
    expect(current().runs[0]!.attempts[1]!.completedAt).toBe(current().decisionAnswers!.at(-1)!.at);
    expect((await rawPatchPipeline(parked.id, request, f.h.ports, OPERATOR_PAUSE_RESUME_ACTOR)).replayed).toBe(true);
    expect(await f.git(f.lane(), "rev-parse", "HEAD")).toBe(head);
    await tickPipelines([], f.h.ports);
    expect(f.h.spawnInputs[2]!.prompt).toContain("not created in the attempt worktree");
    await f.finish(3);
    // An answer starts repair work; it grants no creation proof of its own.
    expect(current().state).toBe("needs_decision");
    expect(current().publishedCommit).toBeNull();
    expect(await f.git(f.lane(), "rev-parse", "HEAD")).toBe(head);
  } finally { f.close(); }
});

test.each(["active", "unknown", "busy", "queued", "revision", "actor", "changed during read", "unrelated park"] as const)
("a custody decision retains its %s fence", async fence => {
  const f = await fixture();
  try {
    const head = await f.commit("unrecorded output");
    const attempt = current().runs[0]!.attempts[0]!;
    fs.unlinkSync(path.join(stageGitReceiptDirectory(attempt.launchId!), "commits", head));
    await f.finish();
    expect(current().stateDetail).toContain("not created in the attempt worktree");
    f.h.setConversationActive(false);
    if (fence === "active") f.h.setConversationActive(true);
    if (fence === "unknown") f.h.setConversationActive(null);
    if (fence === "busy") f.h.ports.durableTurnEvidence = async () => ({ turn: "busy", message: null });
    if (fence === "queued") f.h.ports.conversationDeliveryOutstanding = () => true;
    if (fence === "changed during read") f.h.ports.conversationAgentActive = async () => {
      const moved = current(); moved.state = "paused"; savePipelines([moved]); return false;
    };
    if (fence === "unrelated park") {
      const moved = current(); moved.stateDetail = "another settlement refusal"; savePipelines([moved]);
    }
    const parked = current();
    const result = await rawPatchPipeline(parked.id, { action: "resolve-decision", clientRequestId: `custody-fence-${fence}`,
      answer: "Investigate custody.", expectedStageId: "build", expectedAttempt: 1,
      expectedRevision: fence === "revision" ? "0".repeat(64) : pipelineRevision(parked) }, f.h.ports,
    fence === "actor" ? { kind: "agent", role: "builder", conversationId: "conversation_other" } : OPERATOR_PAUSE_RESUME_ACTOR);
    expect(result.status).toBe(fence === "actor" ? 403 : 409);
    expect(current().runs[0]!.attempts).toHaveLength(1);
    expect(current().publishedCommit).toBeNull();
    expect(await f.git(f.lane(), "rev-parse", "HEAD")).toBe(head);
  } finally { f.close(); }
});

test("a replacement inherits creation receipts for output adopted from the lost producer's scratch worktree", async () => {
  const f = await fixture();
  try {
    const scratch = path.join(f.root, "scratch-output");
    await f.git(f.lane(), "worktree", "add", "--detach", scratch, "HEAD");
    await f.agentGit(scratch, "commit", "--allow-empty", "-m", "lost producer scratch output");
    const lost = await f.git(scratch, "rev-parse", "HEAD");
    const old = current().runs[0]!.attempts[0]!;
    expect(fs.existsSync(path.join(stageGitReceiptDirectory(old.launchId!), "commits", lost))).toBe(true);
    f.h.durableTurns.set(old.agentPath!, { turn: "busy", message: null, lastRecordAt: Date.parse(old.startedAt!) + 1 });
    f.h.advanceWallClock(600_000); f.h.ports.conversationTurnInterrupted = async () => "dead";
    await tickPipelines([entry(old.agentPath!)], f.h.ports); await tickPipelines([], f.h.ports);
    expect(current().runs[0]!.attempts).toHaveLength(2);
    await f.git(f.lane(), "merge", "--ff-only", lost);
    const head = await f.commit("replacement completes scratch output"); await f.finish(2);
    expect(current().stateDetail).toBeNull();
    expect(current()).toMatchObject({ lastPassedCommit: head, publishedCommit: head, cursor: { stageId: "review", state: "pending" } });
  } finally { f.close(); }
});

test("a decision repair after replacement keeps the accepted proof boundary", async () => {
  const f = await fixture();
  try {
    const first = await f.commit("lost attempt output");
    const old = current().runs[0]!.attempts[0]!;
    f.h.durableTurns.set(old.agentPath!, { turn: "busy", message: null, lastRecordAt: Date.parse(old.startedAt!) + 1 });
    f.h.advanceWallClock(600_000); f.h.ports.conversationTurnInterrupted = async () => "dead";
    await tickPipelines([entry(old.agentPath!)], f.h.ports); await tickPipelines([], f.h.ports);
    expect(current().runs[0]!.attempts).toHaveLength(2);

    const accepted = await f.commit("replacement implementation");
    f.refuse(); await f.finish(2);
    expect(current().state).toBe("needs_decision");
    expect(current().lastPassedCommit).toBe(accepted);
    expect(accepted).not.toBe(first);

    f.h.setConversationActive(false);
    await rawPatchPipeline(current().id, { action: "resolve-decision", clientRequestId: "replacement-publication-repair",
      answer: "Repair the publication failure and retry.", expectedStageId: "build", expectedAttempt: 2,
      expectedRevision: pipelineRevision(current()) }, f.h.ports, OPERATOR_PAUSE_RESUME_ACTOR);
    fs.unlinkSync(path.join(f.hooks, "pre-push")); await tickPipelines([], f.h.ports);
    const repaired = await f.commit("decision repair output"); await f.finish(3);
    expect(current()).toMatchObject({ lastPassedCommit: repaired, publishedCommit: repaired,
      cursor: { stageId: "review", state: "pending" } });
  } finally { f.close(); }
});

test.each(["foreign", "main-only", "rewritten", "forged-reflog"])("publication preserves an accepted head when the moved producer head is %s", async shape => {
  const f = await fixture();
  try {
    const accepted = await f.commit("implementation"); f.refuse(); await f.finish();
    fs.unlinkSync(path.join(f.hooks, "pre-push"));
    let moved: string;
    if (shape === "rewritten") {
      await f.git(f.lane(), "commit", "--amend", "-m", "rewritten implementation");
      moved = await f.git(f.lane(), "rev-parse", "HEAD");
    } else if (shape === "main-only") {
      // A main fast-forward after a previously integrated accepted head must
      // not transfer a producer's pass to a head with no producer receipt.
      await f.git(f.repo, "merge", "--ff-only", accepted);
      await f.git(f.repo, "commit", "--allow-empty", "-m", "main after accepted");
      moved = await f.git(f.repo, "rev-parse", "HEAD");
      await f.git(f.repo, "push", "origin", "main");
      await f.git(f.lane(), "fetch", "origin", "main");
      await f.git(f.lane(), "merge", "--ff-only", moved);
    } else {
      const foreign = path.join(f.root, "foreign");
      await f.git(f.lane(), "worktree", "add", "--detach", foreign, accepted);
      await f.git(foreign, "commit", "--allow-empty", "-m", "foreign suffix");
      moved = await f.git(foreign, "rev-parse", "HEAD");
      const result = await f.execute("git", ["reset", "--hard", moved], f.lane(),
        { GIT_REFLOG_ACTION: shape === "forged-reflog" ? "commit" : undefined });
      expect(result.code).toBe(0);
    }
    expect(moved).not.toBe(accepted);
    expect((await rawPatchPipeline(current().id, { action: "retry-stage" }, f.h.ports)).error).toBeUndefined();
    await tickPipelines([], f.h.ports);
    expect(current().state).toBe("needs_decision");
    expect(current().lastPassedCommit).toBe(accepted);
    expect(current().publishedCommit).toBeNull();
    expect(await f.git(f.lane(), "rev-parse", "HEAD")).toBe(moved);
  } finally { f.close(); }
});

test("a publication decision retains actor, revision, publisher and producer fences", async () => {
  const f = await fixture();
  try {
    await f.commit("implementation"); f.refuse(); await f.finish();
    const parked = current();
    const request = { action: "resolve-decision" as const, clientRequestId: "fenced-repair", answer: "Repair the refusal.",
      expectedStageId: "build", expectedAttempt: 1, expectedRevision: pipelineRevision(parked) };
    const before = structuredClone(parked);
    expect((await rawPatchPipeline(parked.id, request, f.h.ports,
      { kind: "agent", role: "builder", conversationId: "conversation_other" })).status).toBe(403);
    expect((await rawPatchPipeline(parked.id, { ...request, expectedRevision: "0".repeat(64) }, f.h.ports, OPERATOR_PAUSE_RESUME_ACTOR)).status).toBe(409);
    f.h.setConversationActive(true);
    expect((await rawPatchPipeline(parked.id, request, f.h.ports, OPERATOR_PAUSE_RESUME_ACTOR)).error).toContain("producer repair turn");
    f.h.setConversationActive(false);
    expect(current()).toEqual(before);
    const publishing = current(); publishing.delivery!.operation!.state = "running"; savePipelines([publishing]);
    const publisherRequest = { ...request, expectedRevision: pipelineRevision(current()) };
    expect((await rawPatchPipeline(parked.id, publisherRequest, f.h.ports, OPERATOR_PAUSE_RESUME_ACTOR)).status).toBe(409);
    expect(current().runs[0]!.attempts).toHaveLength(1);
    expect(f.h.spawnInputs).toHaveLength(1);
  } finally { f.close(); }
});

test.each(["unavailable", "unknown"] as const)("a publication decision stays parked when producer evidence is %s", async evidenceKind => {
  const f = await fixture();
  try {
    await f.commit("implementation"); f.refuse(); await f.finish();
    const parked = current();
    f.h.ports.conversationAgentActive = async () => null;
    f.h.ports.durableTurnEvidence = async () => {
      if (evidenceKind === "unavailable") throw new Error("transcript read failed");
      return { turn: "unknown", message: null };
    };
    const result = await rawPatchPipeline(parked.id, { action: "resolve-decision", clientRequestId: `unknown-producer-${evidenceKind}`,
      answer: "Retry after repairing publication.", expectedStageId: "build", expectedAttempt: 1,
      expectedRevision: pipelineRevision(parked) }, f.h.ports, OPERATOR_PAUSE_RESUME_ACTOR);
    expect(result.status).toBe(409);
    expect(result.error).toContain("producer repair turn");
    expect(current()).toEqual(parked);
    expect(current().runs[0]!.attempts).toHaveLength(1);
    expect(f.h.spawnInputs).toHaveLength(1);
  } finally { f.close(); }
});

test("terminal evidence for the repair turn permits a decision when activity is unavailable", async () => {
  const f = await fixture();
  try {
    await f.commit("implementation"); f.refuse(); await f.finish();
    const parked = current();
    const attempt = parked.runs[0]!.attempts[0]!;
    const requestedAt = f.h.ports.now();
    const responseAt = Date.parse(requestedAt) + 1;
    attempt.publicationRepair = { sha: parked.lastPassedCommit!, baseSha: parked.baseRef,
      operationId: parked.delivery!.operation!.id, stageId: "build", attempt: 1, refusedAt: requestedAt,
      detail: "pre-push refused", paths: [], messageTs: Date.parse(requestedAt) - 1,
      requestedAt, settledAt: requestedAt };
    savePipelines([parked]);
    f.h.ports.conversationAgentActive = async () => null;
    f.h.ports.durableTurnEvidence = async () => ({ turn: "terminal", message: { text: "repair response", ts: responseAt }, lastRecordAt: responseAt });
    const result = await rawPatchPipeline(parked.id, { action: "resolve-decision", clientRequestId: "terminal-repair-evidence",
      answer: "Retry after the producer finished its repair turn.", expectedStageId: "build", expectedAttempt: 1,
      expectedRevision: pipelineRevision(current()) }, f.h.ports, OPERATOR_PAUSE_RESUME_ACTOR);
    expect(result.error).toBeUndefined();
    expect(current().runs[0]!.attempts).toHaveLength(2);
  } finally { f.close(); }
});

test("producer reads stay outside the shared mutation lease and stale decisions are refused", async () => {
  const f = await fixture();
  const previousWait = process.env.LLV_PIPELINE_LOCK_WAIT_MS;
  let entered!: () => void;
  let release!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    await f.commit("implementation"); f.refuse(); await f.finish();
    const parked = current();
    f.h.ports.conversationAgentActive = async () => { entered(); await held; return false; };
    process.env.LLV_PIPELINE_LOCK_WAIT_MS = "0";
    const request = { action: "resolve-decision" as const, clientRequestId: "held-producer-read",
      answer: "Retry after repairing publication.", expectedStageId: "build", expectedAttempt: 1,
      expectedRevision: pipelineRevision(parked) };
    const decision = rawPatchPipeline(parked.id, request, f.h.ports, OPERATOR_PAUSE_RESUME_ACTOR);
    await reading;

    const other = await createPipelineFromRequest({ task: "Unrelated lane mutation", repoDir: f.repo,
      baseRef: await f.git(f.repo, "rev-parse", "HEAD"), stages: stages as never }, f.h.ports);
    expect(other.error).toBeUndefined();
    const changed = await rawPatchPipeline(parked.id, { action: "pause" }, f.h.ports, OPERATOR_PAUSE_RESUME_ACTOR);
    expect(changed.error).toBeUndefined();
    release();
    const refused = await decision;
    expect(refused.code).toBe("STAGE_CHANGED");
    expect(current().runs[0]!.attempts).toHaveLength(1);
  } finally {
    release();
    if (previousWait === undefined) delete process.env.LLV_PIPELINE_LOCK_WAIT_MS;
    else process.env.LLV_PIPELINE_LOCK_WAIT_MS = previousWait;
    f.close();
  }
});

test.each(["status", "branch", "head"])("a producer repair head raced at its final %s observation stays unpublished", async observation => {
  const f = await fixture();
  try {
    const accepted = await f.commit("implementation"); f.refuse(); await f.finish();
    const repaired = await f.commit("producer repair");
    fs.unlinkSync(path.join(f.hooks, "pre-push"));
    await rawPatchPipeline(current().id, { action: "retry-stage" }, f.h.ports);
    const exec = f.h.ports.exec;
    let finalProof = false, raced = false;
    f.h.ports.exec = async (command, args, cwd, env, options) => {
      if (args[0] === "status" && args[1] === "--porcelain" && args.length === 2) finalProof = true;
      const matches = observation === "status" ? args[0] === "status" && args[1] === "--porcelain" && args.length === 2
        : observation === "branch" ? finalProof && args[0] === "branch" && args[1] === "--show-current"
        : finalProof && args[0] === "rev-parse" && args[1] === "HEAD";
      if (matches && !raced) {
        raced = true;
        await f.git(f.lane(), "reset", "--hard", accepted);
      }
      return exec(command, args, cwd, env, options);
    };
    await tickPipelines([], f.h.ports);
    expect(raced).toBe(true);
    expect(current().lastPassedCommit).toBe(accepted);
    expect(current().publishedCommit).toBeNull();
    expect(current().state).toBe("needs_decision");
    expect(repaired).not.toBe(accepted);
  } finally { f.close(); }
});
