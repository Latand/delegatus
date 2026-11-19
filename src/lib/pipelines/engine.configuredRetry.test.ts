import { expect, test, crypto, spyOn, harness, create, tickPipelines, patchPipeline, loadPipelines,
  savePipelines, IDLE_TURN_QUIET_MS, fs, path } from "./engine.fixture";
import { listCodexAccounts } from "@/lib/accounts/codex";
import { attemptAccountPin } from "./runtimeSwitch";
import { selectProjectAccount } from "@/lib/accounts/projectSelection";
import { accountQuotaVerdict, selectHeadlessAccount } from "@/lib/accounts/headlessSelection";
import type { DurableQuotaObservation } from "@/lib/accounts/migration/contracts";
import { ProjectAccountRefusedError } from "@/lib/accounts/manager";
import { MAX_PIPELINE_GRAPH_EDITS } from "./limits";

const cases = (["resume", "retry-stage", "host-lost", "capacity"] as const).flatMap(action =>
  (["engine", "same-engine", "unpin", "unchanged", "revoked", "retained"] as const)
    .filter(change => (change !== "retained" || action === "resume") && (action !== "capacity" || change === "same-engine"))
    .map(change => ({ action, change })));

test.each(cases)(
  "a configured runtime reaches the attempt reserved by $action ($change)", async ({ action, change }) => {
    let sequence = 0;
    const ids = spyOn(crypto, "randomUUID").mockImplementation(() =>
      `95000001-0000-4000-8000-${(++sequence).toString(16).padStart(12, "0")}`);
    try {
      for (const account of listCodexAccounts()) {
        fs.mkdirSync(account.home, { recursive: true });
        fs.writeFileSync(path.join(account.home, "models_cache.json"), JSON.stringify({
          models: [{ slug: "gpt-6-astra", service_tiers: [{ id: "ultrafast" }] }],
        }));
      }
      const h = harness();
      const sourceEngine = change === "same-engine" ? "codex" : "claude";
      const sourceModel = sourceEngine === "codex" ? "gpt-6.1-sol" : "opus";
      const account = change === "unpin" ? null : "default";
      h.ports.roleLookup = () => ({ engine: sourceEngine, model: sourceModel, effort: "high", promptScaffold: "Build" });
      let allowed = change === "retained" ? ["account-a", "account-b", "default"] : ["account-a", "default"];
      h.ports.allowedAccountIds = () => allowed;
      h.ports.accountExhausted = () => false;
      h.ports.resolveProjectSpawn = (engine, request) => ({ kind: "available", account: {
        engine, accountId: request.requestedId ?? request.preferredId ?? "default", kind: "managed",
        home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" },
      } });
      const spawn = h.ports.spawnAgent;
      h.ports.spawnAgent = async (input, reserved) => ({ ...await spawn(input, reserved),
        accountId: input.requestedAccountId ?? "default" });
      const lane = await create(h.ports, [{ id: "build", kind: "run", role: { roleId: "builder" },
        account: "account-a", prompt: "Build", next: null }] as never);
      await tickPipelines([], h.ports); await tickPipelines([], h.ports);
      const current = () => loadPipelines().find(row => row.id === lane.id)!;
      const original = current().runs[0]!.attempts[0]!;
      expect(original).toMatchObject({ effectiveRole: { engine: sourceEngine, model: sourceEngine === "codex" ? "gpt-6.2-sol" : sourceModel, effort: "high" },
        definition: { account: "account-a" } });
      h.durableTurns.set(original.agentPath!, { turn: "busy", message: null, lastRecordAt: Date.parse(h.ports.now()) });
      if (action === "resume" || action === "retry-stage") expect((await patchPipeline(lane.id, { action: "pause" }, h.ports)).error).toBeUndefined();
      if (change !== "unchanged") {
        const overridden = await patchPipeline(lane.id, { action: "override-stage", stageId: "build",
          engine: "codex", model: "gpt-6-astra", effort: "xhigh",
          ...(change === "retained" ? {} : { serviceTier: "ultrafast" }),
          account: change === "retained" ? "account-a" : account }, h.ports);
        expect(overridden).toMatchObject({ graphEdit: { effect: "pending-next-attempt", appliesFromAttempt: 2 } });
      }
      if (change === "retained") {
        expect((await patchPipeline(lane.id, { action: "override-stage", stageId: "build",
          ["prompt"]: "Updated while paused" }, h.ports)).error).toBeUndefined();
        for (let edit = 0; edit <= MAX_PIPELINE_GRAPH_EDITS; edit++) {
          expect((await patchPipeline(lane.id, { action: "set-edge", stageId: "build", edge: "pass", to: null }, h.ports)).error).toBeUndefined();
        }
        expect(current().graphEdits).toHaveLength(MAX_PIPELINE_GRAPH_EDITS);
        expect(current().graphEdits!.some(edit => edit.action === "override-stage")).toBe(true);
        expect(current().graphEdits!.find(edit => edit.action === "override-stage" && Object.hasOwn(edit, "accountOverride")))
          .toMatchObject({ accountOverride: "account-a", appliesFromAttempt: 2 });
      }
      if (change === "revoked") allowed = [];
      if (action === "host-lost" || action === "capacity") {
        const saved = current();
        saved.runs[0]!.attempts[0]!.paneId = null;
        savePipelines([saved]);
        if (action === "capacity") {
          const text = "Selected model is at capacity. Please try again later.";
          const ts = Date.parse(h.ports.now());
          h.durableTurns.set(original.agentPath!, { turn: "terminal", message: { text, ts },
            terminalProviderMessage: { text, ts, errorClass: "server_overloaded" } });
          h.ports.providerRecoveryRandom = () => 1;
          h.ports.resumeSeveredTurn = undefined;
          h.setConversationActive(false);
          await tickPipelines([], h.ports);
          h.advanceWallClock(120_000);
        } else {
          h.ports.conversationTurnInterrupted = async () => "dead";
          h.ports.restartRecoveryBootId = () => "fixture-boot";
          h.ports.restartRecoveryBootStartedAt = () => Date.parse(original.startedAt!) - 60_000;
          h.advanceWallClock(IDLE_TURN_QUIET_MS);
        }
      } else {
        expect((await patchPipeline(lane.id, { action: "resume" }, h.ports)).error).toBeUndefined();
        if (action === "retry-stage") expect((await patchPipeline(lane.id, {
          action: "retry-stage", expectedStageId: "build", expectedAttempt: 1,
        }, h.ports)).error).toBeUndefined();
      }
      if (change === "revoked") {
        await tickPipelines([], h.ports);
        expect(h.spawnInputs).toHaveLength(1);
        allowed = ["account-a", "default"];
        h.advanceWallClock(60_000);
      }
      for (let tick = 0; tick < 3; tick++) await tickPipelines([], h.ports);
      const attempts = current().runs[0]!.attempts;
      const configuredAccount = change === "retained" ? "account-a" : account;
      expect(attempts).toHaveLength(2);
      expect(attempts[0]!.effectiveRole.engine).toBe(sourceEngine);
      expect(attempts[0]!.definition!.account).toBe("account-a");
      if (change === "unchanged") {
        expect(attempts[1]!.effectiveRole).toEqual(original.effectiveRole);
        expect(attemptAccountPin(current().stages[0]!, attempts[1]!)).toBe("account-a");
        return;
      }
      expect(attempts[1]).toMatchObject({ state: "running", effectiveRole: { engine: "codex", model: "gpt-6-astra",
        effort: "xhigh", ...(change === "retained" ? {} : { serviceTier: "ultrafast" }) },
      definition: { account: configuredAccount,
        ...(change === "retained" ? { ["prompt"]: "Updated while paused" } : {}) }, accountId: configuredAccount ?? "default" });
      expect(attemptAccountPin(current().stages[0]!, attempts[1]!)).toBe(configuredAccount);
      expect(h.spawnInputs[1]).toMatchObject({ role: { engine: "codex", model: "gpt-6-astra", effort: "xhigh",
        ...(change === "retained" ? {} : { serviceTier: "ultrafast" }) }, requestedAccountId: configuredAccount, cwd: lane.worktreeDir });
      expect(current().worktreeDir).toBe(lane.worktreeDir);
      expect(h.calls.some(call => /reset --hard|clean -/.test(call))).toBe(false);
    } finally { ids.mockRestore(); }
  });

test.each(["before-dispatch", "after-success"] as const)(
  "an explicit account override stays pinned when quota blocks recovery ($when)", async when => {
    let sequence = 0;
    const ids = spyOn(crypto, "randomUUID").mockImplementation(() =>
      `95000002-0000-4000-8000-${(++sequence).toString(16).padStart(12, "0")}`);
    try {
      for (const account of listCodexAccounts()) {
        fs.mkdirSync(account.home, { recursive: true });
        fs.writeFileSync(path.join(account.home, "models_cache.json"), JSON.stringify({
          models: [{ slug: "gpt-6-astra", service_tiers: [{ id: "ultrafast" }] }],
        }));
      }
      const h = harness();
      const lane = await create(h.ports, [{ id: "build", kind: "run", role: { roleId: "builder" },
        account: "account-a", prompt: "Build", next: null }] as never);
      const accounts = ["account-a", "account-b"].map(id => ({ id, authPresent: true }));
      let now = Date.parse(h.ports.now());
      const observations: DurableQuotaObservation[] = accounts.map(({ id }) => ({ engine: "codex", accountId: id,
        authenticated: true, authCheckedAt: new Date(now).toISOString(), observedAt: new Date(now).toISOString(), bootId: "fixture",
        provenance: { source: "live", reason: null, staleSince: null },
        limits: { session: null, weekly: { usedPercent: 20, resetsAt: Math.floor(now / 1000) + 3600 },
          plan: "pro", capturedAt: now / 1000 } }));
      const selectionRequests: Array<{ requestedId?: string | null; requireCapacity?: boolean; preferredId?: string | null }> = [];
      h.ports.accountExhausted = (engine, id, model) => selectHeadlessAccount(
        [{ id, authPresent: true }], observations, id, [], now, model).kind === "exhausted";
      h.ports.accountQuota = (engine, id, model) => accountQuotaVerdict(observations, id, now, model);
      h.ports.resolveProjectSpawn = (engine, request) => {
        selectionRequests.push(request);
        const selection = selectProjectAccount({ ...request, engine, accounts, observations, now,
          bindings: accounts.map(({ id }) => ({ project: lane.project!, engine, accountId: id, createdAt: new Date(now).toISOString() })) });
        return selection.kind === "available" ? { kind: "available", account: { engine, accountId: selection.accountId!, kind: "managed",
          home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" } } } : selection;
      };
      const originalSpawn = h.ports.spawnAgent;
      let refuseFirstPinnedAdmission = when === "before-dispatch";
      h.ports.spawnAgent = async (input, reserved) => {
        if (refuseFirstPinnedAdmission && input.requestedAccountId === "account-b") {
          refuseFirstPinnedAdmission = false;
          observations.find(item => item.accountId === "account-b")!.limits!.weekly!.usedPercent = 100;
          throw new ProjectAccountRefusedError({ kind: "exhausted", resetsAt: Math.floor(now / 1000) + 3600,
            allowedAccountIds: ["account-b"] }, "codex", lane.project!);
        }
        return { ...await originalSpawn(input, reserved), accountId: input.requestedAccountId ?? "account-a" };
      };

      await tickPipelines([], h.ports); await tickPipelines([], h.ports);
      const original = loadPipelines().find(row => row.id === lane.id)!.runs[0]!.attempts[0]!;
      h.durableTurns.set(original.agentPath!, { turn: "busy", message: null, lastRecordAt: Date.parse(h.ports.now()) });
      expect((await patchPipeline(lane.id, { action: "pause" }, h.ports)).error).toBeUndefined();
      expect(await patchPipeline(lane.id, { action: "override-stage", stageId: "build", account: "account-b" }, h.ports))
        .toMatchObject({ graphEdit: { accountOverride: "account-b", appliesFromAttempt: 2 } });
      if (when === "before-dispatch") {
        expect((await patchPipeline(lane.id, { action: "override-stage", stageId: "build", ["prompt"]: "Updated while paused" }, h.ports)).error)
          .toBeUndefined();
        for (let edit = 0; edit <= MAX_PIPELINE_GRAPH_EDITS; edit++) {
          expect((await patchPipeline(lane.id, { action: "set-edge", stageId: "build", edge: "pass", to: null }, h.ports)).error)
            .toBeUndefined();
        }
        const edits = loadPipelines().find(row => row.id === lane.id)!.graphEdits!;
        expect(edits).toHaveLength(MAX_PIPELINE_GRAPH_EDITS);
        expect(edits.find(edit => edit.action === "override-stage" && Object.hasOwn(edit, "accountOverride")))
          .toMatchObject({ accountOverride: "account-b", appliesFromAttempt: 2 });
      }
      expect((await patchPipeline(lane.id, { action: "resume" }, h.ports)).error).toBeUndefined();

      for (let tick = 0; tick < 4; tick++) { await tickPipelines([], h.ports); now = Date.parse(h.ports.now()); }
      let current = loadPipelines().find(row => row.id === lane.id)!;
      expect(current.runs[0]!.attempts).toHaveLength(2);
      let attempt = current.runs[0]!.attempts[1]!;
      expect(current.stages[0]!.account).toBe("account-b");
      expect(attempt.runtimeAccountPin).toBe("account-b");
      expect(attemptAccountPin(current.stages[0]!, attempt)).toBe("account-b");

      if (when === "after-success") {
        expect(attempt.state).toBe("running");
        expect(h.spawnInputs.at(-1)?.requestedAccountId).toBe("account-b");
        observations.find(item => item.accountId === "account-b")!.limits!.weekly!.usedPercent = 100;
      }
      for (let tick = 0; tick < 4; tick++) { await tickPipelines([], h.ports); now = Date.parse(h.ports.now()); }
      current = loadPipelines().find(row => row.id === lane.id)!;
      expect(current.runs[0]!.attempts).toHaveLength(2);
      attempt = current.runs[0]!.attempts[1]!;
      expect(attempt.accountId).toBe("account-b");
      expect(attemptAccountPin(current.stages[0]!, attempt)).toBe("account-b");
      expect(h.spawnInputs).toHaveLength(when === "before-dispatch" ? 1 : 2);
      expect(selectionRequests.at(-1)).toMatchObject({ requestedId: "account-b", requireCapacity: true });
      expect(h.spawnInputs.every(input => input.requestedAccountId !== "account-a" || input === h.spawnInputs[0])).toBe(true);
      expect(current.stateDetail).toContain("account-b");
      if (when === "before-dispatch") {
        expect((await patchPipeline(lane.id, { action: "retry-stage", expectedStageId: "build", expectedAttempt: 2 }, h.ports)).error)
          .toBeUndefined();
        current = loadPipelines().find(row => row.id === lane.id)!;
        expect(current.runs[0]!.attempts).toHaveLength(2);
        expect(current.runs[0]!.attempts[1]!.runtimeAccountPin).toBe("account-b");
        const recoveredQuota = observations.find(item => item.accountId === "account-b")!;
        h.advanceWallClock(120_000);
        now = Date.parse(h.ports.now());
        recoveredQuota.observedAt = recoveredQuota.authCheckedAt = new Date(now).toISOString();
        recoveredQuota.limits!.weekly!.usedPercent = 20;
        for (let tick = 0; tick < 5; tick++) { await tickPipelines([], h.ports); now = Date.parse(h.ports.now()); }
        current = loadPipelines().find(row => row.id === lane.id)!;
        expect(current.runs[0]!.attempts).toHaveLength(2);
        expect(current.runs[0]!.attempts[1]).toMatchObject({ accountId: "account-b", runtimeAccountPin: "account-b",
          definition: { account: "account-b" } });
        expect(h.spawnInputs.at(-1)?.requestedAccountId).toBe("account-b");
        recoveredQuota.observedAt = recoveredQuota.authCheckedAt = new Date(now).toISOString();
        recoveredQuota.limits!.weekly!.usedPercent = 100;
        for (let tick = 0; tick < 5; tick++) { await tickPipelines([], h.ports); now = Date.parse(h.ports.now()); }
        current = loadPipelines().find(row => row.id === lane.id)!;
        expect(current.runs[0]!.attempts).toHaveLength(2);
        expect(current.runs[0]!.attempts[1]!.runtimeAccountPin).toBe("account-b");
        expect(selectionRequests.at(-1)).toMatchObject({ requestedId: "account-b", requireCapacity: true });
        expect(h.spawnInputs.at(-1)?.requestedAccountId).toBe("account-b");
      }
      if (when === "after-success") {
        const recoveredQuota = observations.find(item => item.accountId === "account-b")!;
        h.advanceWallClock(120_000);
        now = Date.parse(h.ports.now());
        recoveredQuota.observedAt = recoveredQuota.authCheckedAt = new Date(now).toISOString();
        recoveredQuota.limits!.weekly!.usedPercent = 20;
        for (let tick = 0; tick < 4; tick++) { await tickPipelines([], h.ports); now = Date.parse(h.ports.now()); }
        current = loadPipelines().find(row => row.id === lane.id)!;
        expect(current.runs[0]!.attempts).toHaveLength(3);
        expect(current.runs[0]!.attempts[2]).toMatchObject({ accountId: "account-b", runtimeAccountPin: "account-b",
          definition: { account: "account-b" } });
        expect(h.spawnInputs.at(-1)?.requestedAccountId).toBe("account-b");

        recoveredQuota.observedAt = recoveredQuota.authCheckedAt = new Date(now).toISOString();
        recoveredQuota.limits!.weekly!.usedPercent = 100;
        for (let tick = 0; tick < 4; tick++) { await tickPipelines([], h.ports); now = Date.parse(h.ports.now()); }
        current = loadPipelines().find(row => row.id === lane.id)!;
        expect(current.runs[0]!.attempts).toHaveLength(3);
        expect(current.runs[0]!.attempts[2]!.runtimeAccountPin).toBe("account-b");
        expect(selectionRequests.at(-1)).toMatchObject({ requestedId: "account-b", requireCapacity: true });
      }
    } finally { ids.mockRestore(); }
  });
