import { expect, test, fs, path, tickPipelines, savePipelines, pipelineRevision, rawPatchPipeline } from "./engine.fixture";
import { realExec } from "@/lib/workflows/provision";
import { OPERATOR_PAUSE_RESUME_ACTOR } from "@/lib/pauseResumeActor";
import { pipelinePublicationFence } from "./git";
import { FORGE_PUSH_MINT_MARKER } from "../../../bin/forge-app-token.mjs";
import { current, fixture, isolatePublicationGit } from "./publicationRecovery.fixture";

isolatePublicationGit();

test.each(["takeover", "explicit publish"])("%s records an unconsumed native remote refusal and reopens its history", async consumer => {
  const f = await fixture();
  try {
    const { publishPipelineBranch } = await import("./git");
    const { buildPipeline, createPipelineWithDelivery, takeoverPipelineDelivery, findPipelineRecord } = await import("./store");
    const accepted = await f.commit("accepted implementation");
    const owner = current();
    owner.lastPassedCommit = accepted;
    savePipelines([owner]);
    fs.writeFileSync(path.join(f.hooks, "pre-push"), "#!/bin/sh\necho 'pre-push: privacy' >&2\necho 'PRIVACY GATE: PASS' >&2\necho 'pre-push: verified completed checks for this publication; transport admitted' >&2\n", { mode: 0o700 });
    fs.writeFileSync(path.join(f.remote, "hooks", "pre-receive"), `#!/bin/sh\necho '${"diagnostic ".repeat(500)}' >&2\necho 'fatal error in commit_refs_rules' >&2\nexit 1\n`, { mode: 0o700 });
    const result = await publishPipelineBranch(owner, f.h.ports.exec, { acceptedSha: accepted });
    expect(result.ok).toBe(false);
    expect(current().publicationRecovery).toBeUndefined();
    let recordId = owner.id;
    if (consumer === "takeover") {
      const successor = await createPipelineWithDelivery(buildPipeline({ id: "refusal-successor", task: "Continue publication",
        project: owner.project, repoDir: f.repo, stages: owner.stages, srcPath: null, srcConversationId: null,
        now: "2026-11-06T10:00:00.000Z", state: "draft" }), owner.delivery!.target);
      const taken = await takeoverPipelineDelivery(successor.id, owner.id, owner.delivery!.epoch, "continue publication", null);
      expect(taken.error).toBeUndefined();
      recordId = successor.id;
    } else {
      // Explicit recovery records the old refusal before reserving another
      // operation. Do not execute that new reservation in this probe.
      const reserved = await rawPatchPipeline(owner.id, { action: "publish" }, f.h.ports, OPERATOR_PAUSE_RESUME_ACTOR);
      expect(reserved.error).toBeUndefined();
      expect(findPipelineRecord(owner.id)!.delivery!.operation!.state).toBe("pending");
    }
    const recovery = findPipelineRecord(recordId)!.publicationRecovery![accepted]!;
    expect(recovery).toMatchObject({ failures: 0, totalAttempts: 1, history: [{ cause: "remote-refusal", retryAt: null }] });
    expect(recovery.history[0]!.detail).toContain("remote: fatal error in commit_refs_rules");
    expect(findPipelineRecord(owner.id)!.publicationRecovery?.[accepted]).toEqual(recovery);
    const reopened = await realExec(process.execPath, ["-e", `
      const { findPipelineRecord } = await import("./src/lib/pipelines/store.ts");
      console.log(JSON.stringify(findPipelineRecord(${JSON.stringify(recordId)}).publicationRecovery));
    `], process.cwd(), { ...process.env }, { timeoutMs: 30_000 });
    expect(reopened.code, reopened.stderr).toBe(0);
    expect(JSON.parse(reopened.stdout)).toEqual({ [accepted]: recovery });
    expect(await f.git(f.lane(), "rev-parse", "HEAD")).toBe(accepted);
  } finally { f.close(); }
});


async function restartedAppController(clock: string, mode: "tick" | "reserve" | "expire after read" = "tick") {
  return realExec("bun", ["-e", `
    const { spyOn } = await import("bun:test");
    const git = await import("./src/lib/pipelines/git.ts");
    if (${JSON.stringify(mode)} === "reserve") spyOn(git, "publishPipelineBranch").mockImplementation(async () => process.exit(0));
    const { defaultPipelinePorts, tickPipelines } = await import("./src/lib/pipelines/engine.ts");
    const { loadPipelines } = await import("./src/lib/pipelines/store.ts");
    const { realExec } = await import("./src/lib/workflows/provision.ts");
    const ports = defaultPipelinePorts();
    let pushes = 0;
    let clock = ${JSON.stringify(clock)}, reads = 0;
    ports.now = () => clock;
    ports.structuredDeliveryPublication = () => "ready";
    ports.cpuAdmissionReconcile = async () => {};
    ports.drainHold = () => null;
    ports.deferStageGit = false;
    ports.scheduleTick = () => {};
    ports.conversationAgentActive = async () => false;
    ports.resumeSeveredTurn = async () => false;
    ports.exec = async (command, args, cwd, env, options) => {
      if (args.includes("push")) { pushes++; return { code: 1, stdout: "", stderr: ${JSON.stringify(`${FORGE_PUSH_MINT_MARKER}\nfatal: HTTP 403`)} }; }
      const result = await realExec(command, args, cwd, env, options);
      if (${JSON.stringify(mode)} === "expire after read" && args.includes("ls-remote")) {
        reads++;
        clock = "2026-10-27T09:20:00.000Z";
      }
      return result;
    };
    await tickPipelines([], ports);
    // Cross the reset window's first due time too: a recovered 08:00
    // refusal must never reserve a 09:21 push after a 09:20 restart.
    if (Date.parse(clock) >= Date.parse("2026-10-27T09:20:00.000Z")) {
      clock = "2026-10-27T09:21:00.000Z";
      await tickPipelines([], ports);
    }
    const pipeline = loadPipelines()[0];
    console.log(JSON.stringify({ state: pipeline.state, detail: pipeline.stateDetail, pushes, reads,
      since: pipeline.publicationRecovery?.[pipeline.lastPassedCommit]?.app403Since,
      operationId: pipeline.delivery?.operation?.id, accepted: pipeline.lastPassedCommit, repair: pipeline.runs[0].attempts[0].publicationRepair }));
  `], process.cwd(), { ...process.env }, { timeoutMs: 30_000 });
}

test.each(["recovers", "expires", "restarts late", "reserved retry", "legacy reserved retry", "legacy retry before deadline", "expires after admission", "unrecorded refusal"])("App git 403 publication %s after waiting with its accepted content intact", async outcome => {
  const f = await fixture();
  try {
    const start = Date.parse("2026-10-27T08:00:00.000Z");
    let clock = start, repairs = 0;
    f.h.ports.now = () => new Date(clock).toISOString();
    f.h.ports.resumeSeveredTurn = async () => { repairs++; return true; };
    const accepted = await f.commit("implementation");
    // The fake push transport supplies the helper's verified fresh-mint
    // receipt and Git's denial. No GitHub credential or network is used.
    fs.writeFileSync(path.join(f.hooks, "pre-push"), `#!/bin/sh\necho '${FORGE_PUSH_MINT_MARKER}' >&2\necho 'fatal: HTTP 403' >&2\necho 'Everything up-to-date' >&2\nexit 1\n`, { mode: 0o700 });
    await f.finish();
    expect(current().state).toBe("running");
    expect(current().stateDetail).toContain("waiting for GitHub to accept the App push");
    expect(current().runs[0]!.attempts[0]!.publicationRetry?.retryAt).toBe(new Date(start + 60_000).toISOString());
    expect(current().delivery!.operation!.result?.failure).toMatchObject({ retryableApp403: true, changedFiles: 1 });
    const restarted = await realExec("bun", ["-e", `
      const { loadPipelines } = await import("./src/lib/pipelines/store.ts");
      const { recordPublicationFailure, PUBLICATION_RETRY_DELAYS_MS } = await import("./src/lib/pipelines/publicationHistory.ts");
      const pipeline = loadPipelines()[0];
      pipeline.delivery.operation.id = "restarted-app-probe";
      const record = recordPublicationFailure(pipeline, undefined, { operationId: "restarted-app-probe", epoch: pipeline.delivery.epoch,
        at: "2026-10-27T09:00:00.000Z", cause: "app-git-403", detail: "App git access unavailable", recoverable: true }, PUBLICATION_RETRY_DELAYS_MS);
      console.log(JSON.stringify({ since: pipeline.publicationRecovery[pipeline.lastPassedCommit].app403Since, retryAt: record.retryAt }));
    `], process.cwd(), { ...process.env });
    expect(restarted.code, restarted.stderr).toBe(0);
    expect(JSON.parse(restarted.stdout)).toEqual({ since: new Date(start).toISOString(), retryAt: null });
    if (["restarts late", "reserved retry", "legacy reserved retry", "legacy retry before deadline", "expires after admission", "unrecorded refusal"].includes(outcome)) {
      const refusalId = current().delivery!.operation!.id;
      if (outcome === "reserved retry" || outcome === "legacy reserved retry" || outcome === "legacy retry before deadline" || outcome === "expires after admission") {
        // Exit a real controller after it durably reserves the 08:01 retry,
        // before the publisher acquires that reservation.
        const reserved = await restartedAppController("2026-10-27T08:01:00.000Z", "reserve");
        expect(reserved.code, reserved.stderr).toBe(0);
        expect(current().delivery!.operation).toMatchObject({ state: "pending", app403Deadline: "2026-10-27T09:00:00.000Z" });
        if (outcome === "legacy reserved retry" || outcome === "legacy retry before deadline") {
          const stored = current();
          delete stored.delivery!.operation!.app403Deadline;
          stored.delivery!.operation!.fence = pipelinePublicationFence(stored);
          savePipelines([stored]);
        }
      } else if (outcome === "unrecorded refusal") {
        const stored = current();
        // Keep the publisher's real durable result, at the crash boundary
        // before a controller has written retry history or an attempt counter.
        expect(stored.delivery!.operation!.result!.failure!.observedAt).toBe(new Date(start).toISOString());
        delete stored.publicationRecovery;
        delete stored.runs[0]!.attempts[0]!.publicationRetry;
        savePipelines([stored]);
      }
      const recovered = outcome === "legacy retry before deadline"
        ? await restartedAppController("2026-10-27T08:02:00.000Z")
        : outcome === "expires after admission"
        ? await restartedAppController("2026-10-27T08:59:00.000Z", "expire after read")
        : await restartedAppController("2026-10-27T09:20:00.000Z");
      expect(recovered.code, recovered.stderr).toBe(0);
      const result = JSON.parse(recovered.stdout);
      if (outcome === "legacy retry before deadline") {
        expect(result.state).toBe("running");
        expect(result.detail).toContain("waiting for GitHub to accept the App push");
        expect(result.pushes).toBe(1);
      } else {
        expect(result.state).toBe("needs_decision");
        expect(result.detail).toContain("the one-hour automatic retry window ended");
        expect(result.pushes).toBe(0);
      }
      if (outcome === "restarts late" || outcome === "unrecorded refusal") expect(result.operationId).toBe(refusalId);
      if (outcome === "expires after admission") expect(result.reads).toBeGreaterThan(0);
      expect(result.since).toBe(new Date(start).toISOString());
      expect(result.accepted).toBe(accepted);
      expect(result.repair).toBeUndefined();
      return;
    }
    // Before its due time no new push is reserved, including after reload.
    const operationId = current().delivery!.operation!.id;
    clock += 59_999;
    await tickPipelines([], f.h.ports);
    expect(current().delivery!.operation!.id).toBe(operationId);
    if (outcome === "recovers") fs.rmSync(path.join(f.hooks, "pre-push"));
    const delays = outcome === "recovers" ? [1] : [1, 300_000, 900_000, 900_000, 900_000, 540_000];
    for (const delay of delays) {
      clock += delay;
      for (let n = 0; n < 4; n++) await tickPipelines([], f.h.ports);
    }
    const result = current();
    expect(result.lastPassedCommit).toBe(accepted);
    expect(repairs).toBe(0);
    expect(result.runs[0]!.attempts[0]!.publicationRepair).toBeUndefined();
    if (outcome === "recovers") {
      expect(result.cursor?.stageId).toBe("review");
      expect(result.publishedCommit).toBe(accepted);
    } else {
      expect(clock).toBe(start + 60 * 60_000);
      expect(result.state).toBe("needs_decision");
      expect(result.stateDetail).toContain("waiting for GitHub to accept the App push; the one-hour automatic retry window ended");
      expect(result.stateDetail).toContain("fatal: HTTP 403");
      expect(result.publicationRecovery![accepted]!.history).toHaveLength(6);
    }
  } finally { f.close(); }
}, 30_000);

test.each(["undelivered", "legacy-failed", "gone", "unsettled", "stale-busy", "no-repair"] as const)("a %s publication repair remains recoverable in a new controller process", async kind => {
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
    if (kind === "no-repair") {
      delete parked.runs[0]!.attempts[0]!.publicationRepair;
    }
    delete parked.runs[0]!.attempts[0]!.publicationRepairAbandonment;
    savePipelines([parked]);
    const request = { action: "resolve-decision", clientRequestId: "restarted-expired-repair",
      answer: "Continue after the repair expired.", expectedStageId: "build", expectedAttempt: 1,
      expectedRevision: pipelineRevision(parked) };
    const script = `
      const { patchPipeline, defaultPipelinePorts } = await import(${JSON.stringify(path.join(import.meta.dir, "engine.ts"))});
      const ports = {
        ...defaultPipelinePorts(), now: () => ${JSON.stringify(new Date(clock).toISOString())},
        conversationAgentActive: async () => ${kind === "gone" ? "false" : "null"}, conversationDeliveryOutstanding: () => false,
        durableTurnEvidence: async () => ({ turn: ${JSON.stringify(kind === "stale-busy" ? "busy" : "terminal")}, message: null, lastRecordAt: ${clock - 21 * 60_000} }),
        stageRepairDelivery: async () => ({ operationId: "repair-delivery", state: ${JSON.stringify(kind === "unsettled" ? "in-flight" : kind === "gone" ? "unavailable" : "failed")}, safeToReplace: ${kind === "undelivered"} }),
      };
      const result = await patchPipeline(${JSON.stringify(parked.id)}, ${JSON.stringify(request)}, ports, { kind: "operator" });
      const replay = await patchPipeline(${JSON.stringify(parked.id)}, ${JSON.stringify(request)}, ports, { kind: "operator" });
      console.log(JSON.stringify({ error: result.error ?? null, attempts: result.pipeline?.runs[0]?.attempts.length,
        abandoned: !!result.pipeline?.runs[0]?.attempts[0]?.publicationRepairAbandonment,
        replayed: replay.replayed, replayAttempts: replay.pipeline?.runs[0]?.attempts.length }));`;
    const result = await realExec(process.execPath, ["-e", script], process.cwd(), {
      ...process.env, LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1",
    }, { timeoutMs: 30_000 });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ error: null, attempts: 2, abandoned: true, replayed: true, replayAttempts: 2 });
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
}, 15_000);

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
