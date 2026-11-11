import { expect, test, fs, os, path, tickPipelines, savePipelines, pipelineRevision, rawPatchPipeline } from "./engine.fixture";
import { realExec } from "@/lib/workflows/provision";
import { RuntimeJournal } from "@/runtime-host/journal";
import { RuntimeHost } from "@/runtime-host/host";
import { serveRuntimeHost } from "@/runtime-host/socket";
import { once } from "node:events";
import { defaultPipelinePorts } from "./engine";
import { OPERATOR_PAUSE_RESUME_ACTOR } from "@/lib/pauseResumeActor";
import { current, fixture, isolatePublicationGit } from "./publicationRecovery.fixture";

isolatePublicationGit();

test.each(["remote-ref", "remote-unchanged", "remote-long", "privacy-fail", "privacy-configuration",
  "privacy-configuration-long", "privacy-configuration-mixed", "privacy-configuration-input", "privacy-configuration-unreadable", "privacy-configuration-check",
  "comparator-budget", "comparator-budget-legacy", "check-fail", "success"] as const)(
  "remote-after-PASS consumer seam: %s", async shape => {
    const f = await fixture();
    try {
      f.h.ports.now = () => "2026-11-06T10:00:00.000Z";
      let repairs = 0, pushes = 0;
      f.h.ports.resumeSeveredTurn = async () => { repairs++; return true; };
      const execute = f.h.ports.exec;
      f.h.ports.exec = async (command, args, ...rest) => {
        if (command === "git" && args[0] === "push") pushes++;
        if (shape === "privacy-configuration-unreadable" && command === "git" && args[0] === "diff" && args.includes("--no-renames")) {
          return { code: 1, stdout: "", stderr: "comparison unavailable" };
        }
        return execute(command, args, ...rest);
      };
      let accepted = shape === "remote-unchanged" ? await f.git(f.lane(), "rev-parse", "HEAD") : await f.commit("accepted implementation");
      if (shape === "privacy-configuration-input") {
        fs.mkdirSync(path.join(f.lane(), "scripts"));
        fs.writeFileSync(path.join(f.lane(), "scripts/privacy-known-value-fingerprints.json"), "{}\n");
        await f.agentGit(f.lane(), "add", "scripts/privacy-known-value-fingerprints.json");
        await f.agentGit(f.lane(), "commit", "-m", "Change scanner input fixture");
        accepted = await f.git(f.lane(), "rev-parse", "HEAD");
      }
      const configuration = shape.startsWith("privacy-configuration");
      const capacity = shape.startsWith("comparator-budget");
      const retryable = capacity || shape === "privacy-configuration" || shape === "privacy-configuration-long";
      const localOutput = capacity
        ? `pre-push: privacy\nPRIVACY GATE: PASS\npre-push: touched tests\n${shape === "comparator-budget-legacy"
          ? "touched-tests: head: test run exceeded its 15 minute budget; gate error (blocking)"
          : "touched-tests: no verdict: head: test run exceeded its 15 minute budget; 58 of 70 files completed; nothing was judged"}\npre-push: touched tests: failed (${shape === "comparator-budget-legacy" ? 1 : 75})`
        : configuration
        ? `pre-push: privacy\nPRIVACY GATE: FAIL\nconfiguration_error: 1\n${shape === "privacy-configuration-mixed" ? "credential: 1\n" : ""}${shape === "privacy-configuration-check" ? "NEW file.test.ts: failing assertion\npre-push: touched tests: failed (1)\n" : ""}${shape === "privacy-configuration-long" ? "diagnostic ".repeat(500) + "\n" : ""}pre-push: bun failed (1); gate failed`
        : shape === "privacy-fail"
        ? "pre-push: privacy\nPRIVACY GATE: FAIL\npre-push: privacy: failed (1)"
        : shape === "check-fail"
          ? "pre-push: privacy\nPRIVACY GATE: PASS\npre-push: types\npre-push: types: failed (1)"
          : "pre-push: privacy\nPRIVACY GATE: PASS\npre-push: verified completed checks for this publication; transport admitted";
      const localFailure = capacity || configuration || shape === "privacy-fail" || shape === "check-fail";
      fs.writeFileSync(path.join(f.hooks, "pre-push"), `#!/bin/sh\ncat >&2 <<'OUTPUT'\n${localOutput}\nOUTPUT\nexit ${localFailure ? 1 : 0}\n`, { mode: 0o700 });
      if (shape.startsWith("remote-")) fs.writeFileSync(path.join(f.remote, "hooks", "pre-receive"),
        `#!/bin/sh\n${shape === "remote-long" ? `echo '${"diagnostic ".repeat(500)}' >&2\n` : ""}echo 'fatal error in commit_refs_rules' >&2\nexit 1\n`, { mode: 0o700 });
      await f.finish();
      const lane = current();
      const { publicationFailurePhase, publicationFailureCause } = await import("./git");
      const failure = lane.delivery?.operation?.result?.failure;
      const history = lane.publicationRecovery?.[accepted]?.history ?? [];
      expect(lane.lastPassedCommit).toBe(accepted);
      expect(await f.git(f.lane(), "rev-parse", "HEAD")).toBe(accepted);
      expect(await f.git(f.lane(), "status", "--porcelain")).toBe("");
      expect(pushes).toBe(1);
      if (shape === "success") {
        expect(lane.cursor?.stageId).toBe("review");
        expect(repairs).toBe(0);
        expect(history).toHaveLength(0);
        expect(await f.git(f.remote, "rev-parse", lane.delivery!.target.branch)).toBe(accepted);
      } else if (retryable) {
        expect(publicationFailurePhase(failure!)).toBe(capacity ? "touched tests" : "privacy");
        expect(history).toHaveLength(1);
        expect(history[0]).toMatchObject({ cause: capacity ? "infrastructure-deadline" : "interrupted", retryAt: "2026-11-06T10:01:00.000Z" });
        if (capacity) expect(failure?.retryableDeadline).toBe(true);
        else expect(failure?.privacyConfigurationFault).toBe(true);
        expect(history[0]!.detail).toContain(capacity ? "execution deadline without a verdict" : "privacy gate could not read its own configuration");
        expect(lane.runs[0]!.attempts[0]!.publicationRepair).toBeUndefined();
        expect(repairs).toBe(0);
        expect(lane.state).toBe("running");
        // A new process reads the writer's complete result, including proof
        // computed before output redaction and clipping.
        const reopened = await realExec(process.execPath, ["-e", `
          const { loadPipelines } = await import("./src/lib/pipelines/store.ts");
          console.log(JSON.stringify(loadPipelines()[0].delivery.operation.result));
        `], process.cwd(), { ...process.env }, { timeoutMs: 30_000 });
        expect(reopened.code, reopened.stderr).toBe(0);
        expect(JSON.parse(reopened.stdout)).toEqual(lane.delivery!.operation!.result);
        fs.writeFileSync(path.join(f.hooks, "pre-push"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
        f.h.ports.now = () => "2026-11-06T10:01:00.000Z";
        await tickPipelines([], f.h.ports);
        expect(await f.git(f.remote, "rev-parse", lane.delivery!.target.branch)).toBe(accepted);
        expect(current().cursor?.stageId).toBe("review");
        expect(repairs).toBe(0);
        expect(pushes).toBe(2);
      } else if (localFailure) {
        expect(publicationFailurePhase(failure!)).toBe(configuration || shape === "privacy-fail" ? "privacy" : "types");
        expect(failure?.privacyConfigurationFault).toBeUndefined();
        expect(lane.runs[0]!.attempts[0]!.publicationRepair).toBeDefined();
        expect(repairs).toBe(1);
        expect(history[0]!.cause).toBe("check-failure");
      } else {
        expect(publicationFailurePhase(failure!)).toBeNull();
        expect(publicationFailureCause(failure!)).toContain("remote: fatal error in commit_refs_rules");
        expect(failure!.outputTail.length).toBeLessThanOrEqual(4000);
        expect(history).toHaveLength(1);
        expect(history[0]).toMatchObject({ cause: "remote-refusal", retryAt: null });
        expect(lane.state).toBe("needs_decision");
        expect(lane.stateDetail).toContain("remote cause is unknown");
        expect(lane.runs[0]!.attempts[0]!.publicationRepair).toBeUndefined();
        expect(repairs).toBe(0);
        await tickPipelines([], f.h.ports);
        expect(current().publicationRecovery?.[accepted]?.history).toEqual(history);
        // A fresh controller reopens the persisted record beyond every retry
        // delay. Its effect ports count any unintended retry or repair.
        const reopened = await realExec(process.execPath, ["-e", `
          const { defaultPipelinePorts, tickPipelines } = await import("./src/lib/pipelines/engine.ts");
          const { loadPipelines } = await import("./src/lib/pipelines/store.ts");
          const ports = defaultPipelinePorts();
          let pushes = 0, repairs = 0;
          ports.now = () => "2026-11-07T10:00:00.000Z";
          ports.cpuAdmissionReconcile = async () => {};
          ports.drainHold = () => null;
          ports.scheduleTick = () => {};
          ports.conversationAgentActive = async () => false;
          ports.resumeSeveredTurn = async () => { repairs++; return false; };
          const exec = ports.exec;
          ports.exec = async (command, args, ...rest) => {
            if (command === "git" && args[0] === "push") { pushes++; return { code: 1, stdout: "", stderr: "unexpected push" }; }
            return exec(command, args, ...rest);
          };
          await tickPipelines([], ports);
          const lane = loadPipelines()[0];
          console.log(JSON.stringify({ pushes, repairs, accepted: lane.lastPassedCommit,
            state: lane.state, history: lane.publicationRecovery[lane.lastPassedCommit].history }));
        `], process.cwd(), { ...process.env }, { timeoutMs: 30_000 });
        expect(reopened.code, reopened.stderr).toBe(0);
        expect(JSON.parse(reopened.stdout)).toEqual({ pushes: 0, repairs: 0, accepted, state: "needs_decision", history });
        expect(pushes).toBe(1);
        expect(repairs).toBe(0);
      }
    } finally { f.close(); }
  }, 60_000);

test.each((["resolve-decision", "retry-stage"] as const).flatMap(action =>
  (["idle", "unknown", "running"] as const).map(activity => ({ action, activity })),
))("a passed replacement with only an older rejected repair ($action, $activity)", async ({ action, activity }) => {
  const f = await fixture();
  try {
    let clock = Date.parse(f.h.ports.now());
    f.h.ports.now = () => new Date(clock).toISOString();
    f.h.ports.resumeSeveredTurn = async () => false;
    await f.commit("first implementation"); f.refuse(); await f.finish();
    clock += 21 * 60_000;
    f.h.advanceWallClock(21 * 60_000);
    await tickPipelines([], f.h.ports);
    f.h.setConversationActive(false);
    const first = current();
    const continued = await rawPatchPipeline(first.id, { action: "resolve-decision", clientRequestId: "first-publication-answer",
      answer: "Repair publication.", expectedStageId: "build", expectedAttempt: 1,
      expectedRevision: pipelineRevision(first) }, f.h.ports, OPERATOR_PAUSE_RESUME_ACTOR);
    expect(continued.error).toBeUndefined();
    f.h.ports.resumeSeveredTurn = undefined;
    await tickPipelines([], f.h.ports);
    await f.commit("replacement implementation"); await f.finish(2);
    const stored = current();
    const oldRepair = stored.runs[0]!.attempts[0]!.publicationRepair!;
    // Observed legacy shape: a rejected send on attempt 1, followed by a
    // passed attempt 2 whose publication exhausted its check deadlines.
    delete oldRepair.clientMessageId; delete oldRepair.delivery;
    delete oldRepair.requestedAt; delete oldRepair.sendingAt;
    expect(oldRepair.outcome?.status).toBe("rejected");
    expect(oldRepair.settledAt).toBeDefined();
    expect(stored.runs[0]!.attempts[1]!.publicationRepair).toBeUndefined();
    expect(stored.runs[0]!.attempts[1]!.state).toBe("passed");
    // Reproduce the retained park after automatic deadline retries ran out.
    stored.state = "needs_decision";
    stored.stateDetail = "publishing the passed stage: publication check deadlines exhausted; retry-stage.";
    savePipelines([stored]);
    clock += 3 * 24 * 60 * 60_000;
    f.h.setConversationActive(activity === "unknown" ? null : activity === "running");
    f.h.ports.durableTurnEvidence = async () => null;
    const result = await rawPatchPipeline(stored.id, { action,
      ...(action === "resolve-decision" ? { clientRequestId: "replacement-publication-answer", answer: "Continue accepted work.",
        expectedStageId: "build", expectedAttempt: 2, expectedRevision: pipelineRevision(current()) } : {}),
    }, f.h.ports, OPERATOR_PAUSE_RESUME_ACTOR);
    if (activity === "running") {
      expect(result.status).toBe(409);
      expect(result.error).toContain("turn build/2");
      expect(result.error).toContain("age 259200s");
      expect(current().state).toBe("needs_decision");
    } else {
      expect(result.error).toBeUndefined();
      expect(current().state).toBe("running");
      expect(current().runs[0]!.attempts[1]!.publicationRepairAbandonment?.reason).toContain("abandoned");
      expect(current().lastPassedCommit).toBe(stored.lastPassedCommit);
    }
    expect(current().runs[0]!.attempts).toHaveLength(action === "resolve-decision" && activity !== "running" ? 3 : 2);
    expect(f.h.spawnInputs).toHaveLength(2);
  } finally { f.close(); }
});

test.each((["resolve-decision", "retry-stage"] as const).flatMap(action =>
  (["queued", "stale-busy", "fresh-busy", "stale-background", "different-operation", "unreadable", "unreadable-activity", "running"] as const).map(shape => ({ action, shape })),
))("a repair uses its persisted deadline ($action, $shape)", async ({ action, shape }) => {
  const f = await fixture();
  try {
    let clock = Date.parse(f.h.ports.now());
    f.h.ports.now = () => new Date(clock).toISOString();
    f.h.ports.resumeSeveredTurn = async () => true;
    await f.commit("implementation"); f.refuse(); await f.finish();
    const stored = current();
    stored.state = "needs_decision";
    stored.stateDetail = "publishing the passed stage: publication checks failed; retry-stage.";
    const repair = stored.runs[0]!.attempts[0]!.publicationRepair!;
    expect(repair.requestedAt).toBeDefined();
    delete repair.settledAt; delete repair.outcome;
    if (shape === "different-operation") repair.delivery = { operationId: "old-repair", state: "failed", safeToReplace: false };
    savePipelines([stored]);
    f.h.setConversationActive(shape === "running" ? true : null);
    if (shape === "unreadable-activity") f.h.ports.conversationAgentActive = async () => { throw new Error("activity unavailable"); };
    f.h.ports.conversationDeliveryOutstanding = () => shape === "queued";
    f.h.ports.stageRepairDelivery = async () => ({ operationId: "unsettled-repair",
      state: shape === "different-operation" ? "unavailable" : "in-flight", safeToReplace: false });
    f.h.ports.durableTurnEvidence = async () => {
      if (shape === "unreadable") throw new Error("transcript unavailable");
      if (shape === "stale-background") return { turn: "unknown", message: null,
        backgroundTasks: [{ id: "stale-repair-command", kind: "command", startedAt: Date.parse(repair.refusedAt), expiresAt: null }] };
      return shape === "stale-busy" || shape === "fresh-busy" ? { turn: "busy", message: null,
        lastRecordAt: shape === "fresh-busy" ? clock : Date.parse(repair.refusedAt) } : null;
    };
    const act = () => rawPatchPipeline(stored.id, { action,
      ...(action === "resolve-decision" ? { clientRequestId: "deadline-publication-answer", answer: "Continue after the repair.",
        expectedStageId: "build", expectedAttempt: 1, expectedRevision: pipelineRevision(current()) } : {}),
    }, f.h.ports, OPERATOR_PAUSE_RESUME_ACTOR);
    clock = Date.parse(repair.refusedAt) + 20 * 60_000 - 1;
    expect((await act()).status).toBe(409);
    clock++;
    const result = await act();
    if (shape === "running" || shape === "fresh-busy" || shape === "queued") {
      expect(result.status).toBe(409);
      expect(result.error).toContain("turn build/1");
      expect(result.error).toContain("age 1200s");
      if (shape === "queued") expect(result.error).toContain("delivery in-flight");
      expect(current().runs[0]!.attempts[0]!.publicationRepairAbandonment).toBeUndefined();
    } else {
      expect(result.error).toBeUndefined();
      const abandoned = current().runs[0]!.attempts[0]!;
      expect(abandoned.publicationRepair).toMatchObject({ settledAt: new Date(clock).toISOString(), outcome: { status: "rejected" } });
      expect(abandoned.publicationRepairAbandonment).toMatchObject({ at: new Date(clock).toISOString() });
      expect(abandoned.publicationRepairAbandonment?.reason).toContain("1200s");
      expect(current().lastPassedCommit).toBe(stored.lastPassedCommit);
    }
    expect(f.h.spawnInputs).toHaveLength(1);
  } finally { f.close(); }
});

test.each((["resolve-decision", "retry-stage"] as const).flatMap(action =>
  (["running", "idle"] as const).map(owner => ({ action, owner })),
))(
  "a $owner producer behind an idle runtime alias after failed delivery ($action)", async ({ action, owner }) => {
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
      await tickPipelines([], f.h.ports);
      clock += owner === "running" ? 21 * 60_000 : 60_000;
      const parked = current();
      const attempt = parked.runs[0]!.attempts[0]!;
      const conversationId = attempt.conversationId!;
      attempt.publicationRepair!.delivery = { operationId: "failed-alias-repair",
        state: owner === "running" ? "failed" : "unavailable", safeToReplace: false };
      savePipelines([parked]);
      if (owner === "idle") f.h.ports.stageRepairDelivery = async () => ({ operationId: "failed-alias-repair", state: "unavailable", safeToReplace: false });
      f.h.ports.durableTurnEvidence = async () => null;
      const production = defaultPipelinePorts();
      f.h.ports.conversationAgentActive = production.conversationAgentActive;
      f.h.ports.conversationTurnInterrupted = production.conversationTurnInterrupted;
      for (const [id, turn] of [["idle-alias", "idle"], ["repair-owner", owner]] as const) {
        journal.append({ scope: { type: "session", id }, kind: "session-status",
          payload: { conversationId, sessionKey: { engine: "codex", sessionId: id },
            hostKind: "codex-app-server", host: "hosted", turn, attentionIds: [] },
        });
      }
      expect(await f.h.ports.conversationAgentActive(conversationId)).toBe(owner === "running" ? true : null);
      await tickPipelines([], f.h.ports);
      expect(current().state).toBe("needs_decision");
      const ready = current();

      const result = await rawPatchPipeline(ready.id, { action,
        ...(action === "resolve-decision" ? { clientRequestId: "running-alias-answer", answer: "Continue the accepted work.",
          expectedStageId: "build", expectedAttempt: 1, expectedRevision: pipelineRevision(ready) } : {}),
      }, f.h.ports, OPERATOR_PAUSE_RESUME_ACTOR);
      if (owner === "running") {
        expect(result.status).toBe(409);
        expect(result.error).toContain("producer repair turn may still be running or queued");
        expect(current().state).toBe("needs_decision");
      } else {
        expect(result.error).toBeUndefined();
        expect(current().state).toBe("running");
        expect(current().runs[0]!.attempts[0]!.publicationRepairAbandonment?.reason).toContain("idle");
      }
      expect(current().runs[0]!.attempts).toHaveLength(owner === "idle" && action === "resolve-decision" ? 2 : 1);
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

test.each(["resolve-decision", "retry-stage"] as const)("a confirmed live producer with queued repair still refuses %s after settlement", async action => {
  const f = await fixture();
  try {
    let clock = Date.parse("2026-10-16T10:00:00.000Z");
    f.h.ports.now = () => new Date(clock).toISOString();
    f.h.ports.resumeSeveredTurn = async () => true;
    await f.commit("implementation"); f.refuse(); await f.finish();
    clock += 21 * 60_000;
    await tickPipelines([], f.h.ports);
    f.h.ports.conversationAgentActive = async () => true;
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
    if (kind === "stale-turn") {
      expect(result.status).toBe(409);
      expect(result.error).toContain("may still be running or queued");
      expect(current().runs[0]!.attempts).toHaveLength(1);
    } else {
      expect(result.error).toBeUndefined();
      expect(current().runs[0]!.attempts).toHaveLength(action === "resolve-decision" ? 2 : 1);
    }
  } finally { f.close(); }
});

test.each((["resolve-decision", "retry-stage"] as const).flatMap(action =>
  (["delivery", "host", "transcript", "activity"] as const).map(read => ({ action, read })),
))("$action rechecks repair identity after asynchronous $read evidence", async ({ action, read }) => {
  const f = await fixture();
  try {
    let clock = Date.parse("2026-10-16T10:00:00.000Z");
    f.h.ports.now = () => new Date(clock).toISOString();
    f.h.ports.resumeSeveredTurn = async () => true;
    await f.commit("implementation"); f.refuse(); await f.finish();
    clock += 21 * 60_000;
    await tickPipelines([], f.h.ports);
    f.h.ports.conversationAgentActive = async () => false;
    const change = () => {
      const changed = current();
      changed.runs[0]!.attempts[0]!.publicationRepair!.operationId = "replacement-publication";
      savePipelines([changed]);
    };
    f.h.ports.stageRepairDelivery = async () => {
      if (read === "delivery") change();
      return { operationId: "old-repair-delivery", state: "failed", safeToReplace: false };
    };
    f.h.ports.durableTurnEvidence = async () => { if (read === "transcript") change(); return null; };
    f.h.ports.conversationTurnInterrupted = async () => { if (read === "host") change(); return "idle"; };
    f.h.ports.conversationAgentActive = async () => { if (read === "activity") change(); return false; };
    const parked = current();
    const result = await rawPatchPipeline(parked.id, { action,
      ...(action === "resolve-decision" ? { clientRequestId: "raced-producer-answer", answer: "Continue.",
        expectedStageId: "build", expectedAttempt: 1, expectedRevision: pipelineRevision(parked) } : {}),
    }, f.h.ports, OPERATOR_PAUSE_RESUME_ACTOR);
    expect(result.status).toBe(409);
    if (action === "retry-stage") expect(result.error).toContain("producer repair turn");
    else expect(result.code).toBe("STAGE_CHANGED");
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
