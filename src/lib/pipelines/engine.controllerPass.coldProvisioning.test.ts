import { createServer } from "node:net";
import { spyOn } from "bun:test";
import { CpuAdmissionQueue, CPU_QUEUE_SPACING_MS } from "@/lib/runtime/cpuAdmission";
import { DEFAULT_CPU_PRESSURE_POLICY } from "@/lib/runtime/cpuPressure";
import { currentOperationLease } from "@/lib/operationLease";
import { FlowPipelineController } from "./controller";
import { settlePipelineControllerJobs } from "./controllerJobs";
import { tickPipelinesController } from "./controllerPass";
import { requestPipelineTick } from "./controllerSignal";
import { settlePipelineStopReadLanes } from "./controllerStopRead";
import { BUILD_ONLY, createPipelineFromRequest, defaultPipelinePorts, expect, fs, loadPipelines,
  path, pipelineIdentity, realWorktreeLane, registerPipelineTick, savePipelines, test } from "./engine.fixture";
import { latch, ownedStageControl, until, withControllerAuditState } from "./fixtures/ownedStageControl";
import { findControllerPipeline, withPipelineMutation } from "./store";

test.each([
  ["direct", "pinned"], ["direct", "followed"], ["queued", "pinned"], ["queued", "followed"],
] as const)("operator audit production-length deadline for cold provisioning: %s %s", (admission, base) => auditIsolatedColdProvisioning(admission, base, 1), 30_000);

test("the independent deadline holds for a cold lane beside three stalled stop reads",
  () => auditIsolatedColdProvisioning("direct", "pinned", 3), 30_000);

test.each([
  ["clear", 620], ["operator-stop", 620], ["clear-after-pause", 620],
  ["clear", 5_500], ["operator-stop", 5_500], ["clear-after-pause", 5_500],
] as const)(
  "a slow scoped RPC returns %s after %i ms while an unrelated cold lane starts before the deadline",
  (reply, responseMs) => auditIsolatedColdProvisioning("direct", "pinned", 1, { reply, responseMs }), 30_000);

test.each(["stop", "withdrawal", "close-withdrawal"] as const)(
  "an accepted peer %s remains pending while the controller starts an unrelated child",
  mutation => auditIsolatedColdProvisioning("direct", "pinned", 1, { mutation }), 30_000);

test.each(["stop", "withdrawal"] as const)(
  "a delayed %s cannot act on a replacement turn",
  mutation => withControllerAuditState(async () => {
    const fixture = await ownedStageControl(mutation, "2026-11-18T12:00:00.000Z", true);
    const { terminalIdleStopKey } = await import("./stageControlCustody");
    const { defaultPipelinePorts, invalidateProviderContinuation } = await import("./engine");
    const target = {
      conversationId: fixture.conversationId, launchId: fixture.launchId, agentPath: fixture.transcriptPath,
      stageId: "build", attempt: 1, paneId: null,
    };
    const stop = () => defaultPipelinePorts().stopStageAgent(target, { onlyIfIdle: true, operationId: terminalIdleStopKey(target) });
    const withdraw = () => invalidateProviderContinuation(target.conversationId, undefined, { key: "fixture-stale-withdrawal", artifactPath: target.agentPath });
    try {
      if (mutation === "withdrawal") {
        await expect(invalidateProviderContinuation(target.conversationId, undefined, {
          key: "fixture-other-generation", artifactPath: target.agentPath + ".old",
        })).rejects.toThrow("cannot prove session authority");
        expect(fixture.dispatches).toHaveLength(0);
      }
      const pending = (mutation === "stop" ? stop() : withdraw()).then(
        value => ({ value, error: null }), error => ({ value: null, error: String(error) }),
      );
      await until(fixture.mutationEntered);
      fixture.publish("running", "fixture-writer-two");
      const current = fixture.journal.readSession({ conversationId: fixture.conversationId });
      if (!current) throw new Error("the replacement turn has no session row");
      fixture.release();
      const result = await pending;
      const settled = fixture.journal.readSession({ conversationId: fixture.conversationId });
      // A refused kill publishes its receipt while leaving session authority intact.
      const rejected = fixture.stops[0]?.receipt;
      if (mutation === "stop" && !rejected) throw new Error("the refused stop has no journal receipt");
      expect(settled).toEqual({ ...current, recentReceipts: rejected ? [rejected] : current.recentReceipts });
      expect(current.activeTurnId).toBe("fixture-new-turn");
      expect(fixture.dispatches).toHaveLength(1);
      if (mutation === "withdrawal") {
        expect(result.error).toContain("session row changed");
        expect(fixture.withdrawals).toHaveLength(0);
        await expect(withdraw()).rejects.toThrow("awaits a confirmed receipt");
        expect(fixture.dispatches).toEqual(["append-session-fenced"]);
        return;
      }
      expect(result.value).toEqual({ outcome: "deferred" });
      expect(fixture.stops[0]?.receipt).toMatchObject({ status: "rejected", reason: "idle-retirement-deferred" });
      expect(await stop()).toEqual({ outcome: "deferred" });
      expect(fixture.dispatches).toHaveLength(1);

      fixture.publish("idle", "fixture-writer-two");
      const fresh = await stop();
      expect(fixture.stops).toHaveLength(2);
      expect(fixture.stops[1]?.receipt.status).toBe("queued");
      expect(fixture.stops[1]?.operationId).not.toBe(fixture.stops[0]?.operationId);
      expect(fresh).toMatchObject({ outcome: "unconfirmed", operationId: fixture.stops[1]?.operationId });
      expect(await stop()).toEqual(fresh);
      expect(fixture.dispatches).toHaveLength(2);
    } finally {
      await fixture.dispose();
    }
  }), 12_000);

test.each(["cancel", "settle"] as const)("an earlier stop receipt read shares the confirmation deadline (%s)",
  mode => withControllerAuditState(async () => {
    const { retirePipelineStageAgent } = await import("./engine");
    const { terminalIdleStopKey } = await import("./stageControlCustody");
    const { runtimeHostClient } = await import("@/lib/runtime/client");
    const fixture = await ownedStageControl("stop", "2026-11-18T12:00:00.000Z", true);
    const target = { conversationId: fixture.conversationId, launchId: fixture.launchId,
      agentPath: fixture.transcriptPath, stageId: "build", attempt: 1, paneId: null };
    const operationId = terminalIdleStopKey(target);
    const first = retirePipelineStageAgent(target, { operationId });
    const entered = latch(), hold = latch();
    const cancel = new AbortController();
    let pending: ReturnType<typeof retirePipelineStageAgent> | undefined;
    try {
      await until(fixture.mutationEntered);
      fixture.publish("running", "fixture-writer-two");
      fixture.release();
      expect(await first).toEqual({ outcome: "deferred" });
      expect(fixture.stops[0]?.receipt.reason).toBe("idle-retirement-deferred");
      fixture.publish("idle", "fixture-writer-two");
      const real = runtimeHostClient()!;
      const reads: Array<{ signal?: AbortSignal; timeoutMs?: number }> = [];
      let now = 0;
      const client = new Proxy(real, {
        get(subject, key, receiver) {
          if (key === "operationStatus") return async (id: string, options?: { signal?: AbortSignal; timeoutMs?: number }) => {
            reads.push(options ?? {});
            if (reads.length === 1) {
              entered.resolve();
              await hold.promise;
            }
            return subject.operationStatus(id, options);
          };
          const value = Reflect.get(subject, key, receiver);
          return typeof value === "function" ? value.bind(subject) : value;
        },
      });
      pending = retirePipelineStageAgent(target, { operationId, client, signal: cancel.signal,
        budgetMs: 1_500, now: () => now, sleep: async () => { now = 1_500; } });
      await until(entered.promise);
      if (mode === "cancel") cancel.abort(new Error("caller cancelled during receipt read"));
      else now = 1_100;
      hold.resolve();
      const result = await pending;
      if (mode === "cancel") {
        expect(reads[0]?.signal?.aborted).toBe(true);
        expect(reads.map(read => read.timeoutMs)).toEqual([1_500]);
        expect(fixture.dispatches).toHaveLength(1);
        expect(result).toMatchObject({ outcome: "unconfirmed", operationId: fixture.stops[0]?.operationId });
      } else {
        expect(reads.map(read => read.timeoutMs)).toEqual([1_500, 400]);
        expect(fixture.dispatches).toHaveLength(2);
        expect(result).toMatchObject({ outcome: "unconfirmed", operationId: fixture.stops[1]?.operationId });
      }
    } finally {
      cancel.abort();
      hold.resolve();
      fixture.release();
      await Promise.allSettled([first, pending]);
      await fixture.dispose();
    }
  }), 12_000);

type StopReadCase = { reply: "clear" | "operator-stop" | "clear-after-pause"; responseMs: number };
type ColdProvisionScenario = StopReadCase | { mutation: "stop" | "withdrawal" | "close-withdrawal" };

async function delayedScopedStopServer(conversationId: string, admittedAt: string, scenario: StopReadCase, pause: () => Promise<void>) {
  const { reply, responseMs } = scenario;
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR!, "stop-rpc-"));
  const socketPath = path.join(dir, "host.sock");
  const pending = new Set<Promise<void>>();
  const evidence = { requests: 0, responses: 0, closedBeforeResponse: 0 };
  const server = createServer(socket => {
    let input = "";
    socket.on("error", () => {});
    socket.on("data", function readRequest(chunk) {
      input += chunk.toString();
      const end = input.indexOf("\n");
      if (end === -1) return;
      socket.off("data", readRequest);
      const request = JSON.parse(input.slice(0, end));
      if (request.method !== "effect-batch" || request.params.conversationId !== conversationId || (request.params.afterEventSeq ?? 0) !== 0) {
        socket.end(JSON.stringify({ id: request.id, ok: false, error: "unexpected fixture RPC" }) + "\n");
        return;
      }
      evidence.requests++;
      const operation = (async () => {
        if (reply === "clear-after-pause") await pause();
        await Bun.sleep(responseMs);
        if (socket.destroyed || socket.readableEnded) { evidence.closedBeforeResponse++; return; }
        const result = reply === "operator-stop" ? [{
          id: "effect:fixture-stop", eventSeq: 1, kind: "runtime.stop-boundary",
          payload: { conversationId, operationId: "fixture-stop", admittedAt, origin: "operator", originAuthenticated: true },
        }] : [];
        socket.end(JSON.stringify({ id: request.id, ok: true, result }) + "\n");
        evidence.responses++;
      })();
      pending.add(operation);
      void operation.then(() => pending.delete(operation), error => socket.destroy(error));
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  const previous = process.env.LLV_RUNTIME_HOST_SOCKET;
  process.env.LLV_RUNTIME_HOST_SOCKET = socketPath;
  return { evidence, async close() {
    if (previous === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET;
    else process.env.LLV_RUNTIME_HOST_SOCKET = previous;
    await Promise.all(pending);
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  } };
}

function auditIsolatedColdProvisioning(admission: "direct" | "queued", base: "pinned" | "followed", blockerCount: number, scenario?: ColdProvisionScenario) {
  return withControllerAuditState(() => auditColdProvisioning(admission, base, blockerCount, scenario));
}

async function auditColdProvisioning(admission: "direct" | "queued", base: "pinned" | "followed", blockerCount: number, scenario?: ColdProvisionScenario) {
  const rpc = scenario && "reply" in scenario ? scenario : undefined;
  const mutation = scenario && "mutation" in scenario ? scenario.mutation : undefined;
  const reply = rpc?.reply;
  const f = await realWorktreeLane("cold-provision-audit", BUILD_ONLY as never);
  const h = f.h;
  const old = loadPipelines()[0]!;
  const attempt = old.runs[0]!.attempts[0]!;
  const requestedAt = h.ports.now();
  attempt.suspension = { reason: "account", detail: "suspended producer",
    requestedAt, stoppedAt: requestedAt, retryRequestedAt: requestedAt };
  const blockers = [old];
  for (let index = 1; index < blockerCount; index++) {
    const peer = structuredClone(old);
    peer.id = `cold-stalled-peer-${index}`;
    peer.delivery = undefined;
    Object.assign(peer, pipelineIdentity(peer.id, peer.task, peer.repoDir));
    Object.assign(peer.runs[0]!.attempts[0]!, { conversationId: `conversation_cold_peer_${index}`,
      launchId: `fixture-cold-peer-${index}`, agentPath: `/codex/cold-peer-${index}.jsonl`, paneId: `%cold-peer-${index}` });
    await f.git(f.repo, "worktree", "add", "-b", peer.branch, peer.worktreeDir, f.base);
    blockers.push(peer);
  }
  savePipelines(blockers);
  const blockedConversations = new Set(blockers.map(peer => peer.runs[0]!.attempts[0]!.conversationId));
  const blockedPanes = new Set(blockers.map(peer => peer.runs[0]!.attempts[0]!.paneId));
  const account = attempt.accountId!;
  h.ports.conversationAgentActive = async id => !blockedConversations.has(id);
  h.ports.paneAgentAlive = async pane => !blockedPanes.has(pane);
  h.ports.allowedAccountIds = () => [account];
  h.ports.resolveProjectSpawn = engine => ({ kind: "available", account: { engine, accountId: account,
    kind: "managed", home: f.root, transcriptRoot: f.root, env: { NODE_ENV: "test" } } });

  const blocked = latch(), release = latch(), launched = latch(), launchTickExited = latch();
  let stalled = true, stopReads = 0, cancelledReads = 0, childLaunched = false;
  const observerReady = latch(), observationComplete = latch();
  let observation: { children: number; callbacks: number; deadlineReached: boolean;
    callbackMs: number | null; childMs: number | null; tickExitMs: number | null } | undefined;
  const observer = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures", "coldLaunchDeadline.ts")], {
    stdin: "ignore", stdout: "ignore", stderr: "inherit",
    ipc(message) {
      if (message === "ready") observerReady.resolve();
      else {
        observation = message as typeof observation;
        observationComplete.resolve();
      }
    },
  });
  const observedBlockers = new Set<string>();
  let stopServer: Awaited<ReturnType<typeof delayedScopedStopServer>> | undefined;
  let heldControl: Awaited<ReturnType<typeof ownedStageControl>> | undefined;
  h.ports.conversationOperatorStopped = async (id, since, ignored) => {
    if (mutation || !blockedConversations.has(id)) return false;
    stopReads++;
    if (!stalled && !stopServer) return false;
    observedBlockers.add(id);
    blocked.resolve();
    if (stopServer) return defaultPipelinePorts().conversationOperatorStopped!(id, since, ignored);
    const signal = currentOperationLease()?.abort.signal;
    await new Promise<void>(resolve => {
      const cancel = () => { cancelledReads++; resolve(); };
      if (signal?.aborted) cancel();
      else signal?.addEventListener("abort", cancel, { once: true });
      void release.promise.then(() => {
        signal?.removeEventListener("abort", cancel);
        resolve();
      });
    });
    return false;
  };
  const logs: string[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const controller = new FlowPipelineController({
    tickPipelines: entries => tickPipelinesController(entries, h.ports),
    scan: async () => ({ files: [], complete: false }),
    scheduleTimeout: (callback, delay) => {
      const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
      timers.add(timer);
      return timer;
    },
    clearTimeout: handle => {
      const timer = handle as ReturnType<typeof setTimeout>;
      clearTimeout(timer);
      timers.delete(timer);
    },
    log: message => { logs.push(message); },
  }, { phaseDeadlineMs: 15_000, maxPasses: 1 });
  let tickExitReported = false;
  const runTick = async () => {
    await controller.tick();
    if (childLaunched && !tickExitReported) {
      tickExitReported = true;
      observer.send("tick-exit");
      launchTickExited.resolve();
    }
  };
  let wake: Promise<void> | undefined;
  const unregister = registerPipelineTick(() => (wake = runTick()));
  h.ports.scheduleTick = delay => { if (delay === 0) requestPipelineTick(); };
  let cpuNow = Date.parse(requestedAt);
  const queue = new CpuAdmissionQueue(path.join(f.root, "cold-cpu.sqlite"), () => cpuNow);
  const cpuKeys = new Set<string>();
  h.ports.cpuPressureHold = (key, priority) => {
    if (key === undefined) throw new Error("missing stage CPU admission key");
    cpuKeys.add(key);
    const allow = !reply || childLaunched || !key.includes(`:${old.id}:`);
    const wait = queue.check(key, allow, undefined, true, priority);
    return wait ? { since: wait.since, avg10: 90, deferred: false, policy: DEFAULT_CPU_PRESSURE_POLICY, queue: wait } : null;
  };
  let child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">> | undefined;
  let tick: Promise<void> | undefined;
  try {
    await until(observerReady.promise);
    if (rpc) stopServer = await delayedScopedStopServer(attempt.conversationId!, requestedAt, rpc, async () => {
      await withPipelineMutation(async (rows, persist) => {
        const paused = rows.find(row => row.id === old.id)!;
        paused.pausedState = "running";
        paused.pausedAt = h.ports.now();
        paused.state = "paused";
        await persist([paused]);
      });
    });
    if (mutation) {
      heldControl = await ownedStageControl(mutation === "stop" ? "stop" : "withdrawal", requestedAt);
      const { conversationId, launchId, transcriptPath } = heldControl;
      Object.assign(attempt, { conversationId, launchId, agentPath: transcriptPath, paneId: null });
      blockedConversations.clear();
      blockedConversations.add(conversationId);
      blockedPanes.clear();
      if (mutation === "stop") {
        old.state = "completed";
        old.cursor = null;
        Object.assign(attempt, { state: "passed", completedAt: requestedAt, verdict: { status: "pass" } });
        delete attempt.suspension;
        const real = defaultPipelinePorts();
        h.ports.stopStageAgent = real.stopStageAgent;
        h.ports.stageHostResident = real.stageHostResident;
      } else {
        h.ports.invalidateProviderContinuation = defaultPipelinePorts().invalidateProviderContinuation;
        if (mutation === "close-withdrawal") {
          old.state = "closed";
          old.closedAt = requestedAt;
          old.cursor = null;
          old.closeTeardown = { id: "fixture-close-withdrawal", phase: "pending", waitingForActivation: false,
            acknowledgeHosts: false, flow: null };
          old.closeReport = { status: "pending", pending: [], pendingContinuations: [{
            stageId: old.runs[0]!.stageId, attempt: attempt.n, conversationId, launchId, agentPath: transcriptPath, paneId: null,
          }], stopped: [], alreadyStopped: [], unconfirmed: [], reviewers: [], acknowledged: [], stillRunning: [], notes: [], worktree: null };
        }
      }
      savePipelines(blockers);
      void heldControl.mutationAccepted.then(() => { observedBlockers.add(conversationId); blocked.resolve(); });
    }
    if (process.env.LLV_COLD_CONTROLLER_LATE === "1") {
      const exec = h.ports.provisionExec!;
      h.ports.provisionExec = async (command, args, cwd, signal, options) => {
        if (args[0] === "worktree" && args[1] === "add") await Bun.sleep(15_100);
        return exec(command, args, cwd, signal, options);
      };
    }
    const store = await import("./store");
    const { StoreBusyBeforeAdmissionError } = await import("@/lib/state/fileTransaction");
    const busy = admission === "queued" ? spyOn(store, "createPipelineWithDelivery").mockRejectedValueOnce(
      new StoreBusyBeforeAdmissionError("fixture store busy before admission"),
    ) : undefined;
    const created = await createPipelineFromRequest({
      task: "Cold lane beside a suspended stage", repoDir: f.repo, publication: "internal",
      stages: BUILD_ONLY as never, ...(base === "pinned" ? { baseRef: f.base } : {}),
    }, h.ports, { queueWhenBusy: true, creationRequest: { key: "cold-provision-audit", digest: base } })
      .finally(() => busy?.mockRestore());
    observer.send("accepted");
    const cold = created.pipeline!;
    expect(cold.state).toBe("provisioning");
    expect(Boolean(created.queued)).toBe(admission === "queued");
    expect(fs.existsSync(cold.worktreeDir)).toBe(false);
    const spawnAgent = h.ports.spawnAgent;
    h.ports.spawnAgent = async (input, reserve) => {
      if (input.cwd !== cold.worktreeDir) return spawnAgent(input, reserve);
      observer.send("callback");
      const result = await spawnAgent(input, reserve);
      // The reservation must already be durable before the child can execute.
      expect((await findControllerPipeline(cold.id))?.runs[0]?.attempts).toMatchObject([{ n: 1, launchId: result.launchId }]);
      child = Bun.spawn([process.execPath, "-e", "console.log('fixture first launch')"],
        { cwd: input.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      observer.send("child");
      childLaunched = true;
      const [exit, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      expect({ exit, output: output.trim() }).toEqual({ exit: 0, output: "fixture first launch" });
      launched.resolve();
      return result;
    };
    tick = runTick();
    // The independent process owns the acceptance-to-child deadline. This
    // wait also lets a deliberately late child report its actual launch.
    await until(Promise.race([
      Promise.all([blocked.promise, launched.promise, launchTickExited.promise]),
      tick.then(() => new Promise<never>(() => {})),
    ]), 24_000);
    expect(logs.filter(line => line.includes("pending at deadline"))).toEqual([]);
    expect(observedBlockers.size).toBe(blockerCount);
    const retained = (await findControllerPipeline(old.id))!;
    if (!reply && mutation !== "stop" && mutation !== "close-withdrawal") {
      expect(retained.runs[0]?.attempts).toMatchObject([{ n: 1, suspension: { retryRequestedAt: requestedAt } }]);
    }
    expect(cpuKeys.size).toBeGreaterThan(0);
    expect(await f.git(cold.worktreeDir, "rev-parse", "HEAD")).toBe(f.base);
    const worktrees = (await f.git(f.repo, "worktree", "list", "--porcelain")).split("\n");
    expect(worktrees.filter(line => line === `worktree ${cold.worktreeDir}`)).toHaveLength(1);

    if (heldControl) {
      for (let pass = 0; pass < 4; pass++) await controller.tick();
      expect(heldControl.stops).toHaveLength(mutation === "stop" ? 1 : 0);
      expect(heldControl.withdrawals).toHaveLength(mutation === "stop" ? 0 : 1);
      if (mutation === "stop") {
        const operation = heldControl.stops[0]!;
        expect(operation.receipt.status).toBe("queued");
        heldControl.publish("running", "fixture-writer-two");
        const refused = heldControl.journal.transitionOperation(operation.operationId, "delivering");
        expect(refused.receipt).toMatchObject({ status: "failed", reason: "idle-retirement-deferred" });
        expect(heldControl.journal.readSession({ conversationId: heldControl.conversationId })?.activeTurnId).toBe("fixture-new-turn");
      }
      heldControl.release();
    }
    stalled = false;
    release.resolve();
    await settlePipelineStopReadLanes();
    for (let pass = 0; pass < 4; pass++) await controller.tick();
    const waitingForCpu = await findControllerPipeline(old.id);
    if (mutation === "stop") {
      expect(waitingForCpu?.state).toBe("completed");
      expect(heldControl?.stops).toHaveLength(1);
    } else if (mutation === "close-withdrawal") {
      expect(waitingForCpu).toMatchObject({ state: "closed", closeReport: { status: "settled", pendingContinuations: [] } });
    } else if (reply === "operator-stop") {
      expect(waitingForCpu?.stateDetail).toContain("stopped by operator");
      const stopped = waitingForCpu?.runs[0]?.attempts[0]?.suspension?.operatorStoppedAt;
      expect(typeof stopped).toBe("string");
      expect(Date.parse(stopped!)).toBeGreaterThanOrEqual(Date.parse(requestedAt));
    } else if (reply === "clear-after-pause") {
      expect(waitingForCpu?.state).toBe("paused");
      expect(waitingForCpu?.runs[0]?.attempts.map(item => item.n)).toEqual([1]);
    } else {
      expect(waitingForCpu?.stateDetail).toContain("CPU queue");
      expect(waitingForCpu?.runs[0]?.attempts.at(-1)).toMatchObject({ n: 2, state: "pending" });
    }
    for (let window = 0; window < blockerCount; window++) {
      cpuNow += CPU_QUEUE_SPACING_MS;
      for (let pass = 0; pass < 4; pass++) await controller.tick();
    }
    for (const peer of blockers) {
      const recovered = await findControllerPipeline(peer.id);
      if (mutation === "stop" || mutation === "close-withdrawal" || reply && reply !== "clear") {
        expect(recovered?.runs[0]?.attempts.map(item => item.n)).toEqual([1]);
        expect(h.spawnInputs.filter(input => input.cwd === old.worktreeDir)).toHaveLength(1);
        continue;
      }
      expect(recovered?.runs[0]?.attempts.map(({ n, state, accountId }) => ({ n, state, accountId })), recovered?.stateDetail ?? "").toEqual([
        { n: 1, state: "failed", accountId: account }, { n: 2, state: "running", accountId: account },
      ]);
    }
    expect((await findControllerPipeline(cold.id))?.runs[0]?.attempts).toMatchObject([{ n: 1, state: "running" }]);
    expect(h.spawnInputs.filter(input => input.cwd === cold.worktreeDir)).toHaveLength(1);
    if (stopServer) expect(stopServer.evidence).toEqual({ requests: 1, responses: 1, closedBeforeResponse: 0 });
    if (heldControl) {
      expect(heldControl.stops).toHaveLength(mutation === "stop" ? 1 : 0);
      expect(heldControl.withdrawals).toHaveLength(mutation === "stop" ? 0 : 1);
    }
    observer.send("finished");
    await until(observationComplete.promise);
    if (process.env.LLV_COLD_CONTROLLER_EVIDENCE) {
      console.log("cold-controller-audit", JSON.stringify({ admission, base, blockerCount, ...observation, stopReads, cancelledReads, scenario, rpc: stopServer?.evidence,
        dispatchedStops: heldControl?.stops.length, withdrawals: heldControl?.withdrawals.length }));
    }
    expect(observation).toMatchObject({ callbacks: 1, children: 1 });
    expect(observation?.deadlineReached, "independent acceptance-to-child deadline of 15000 ms").toBe(false);
  } finally {
    stalled = false;
    release.resolve();
    heldControl?.release();
    unregister();
    if (child?.exitCode === null) child.kill();
    await child?.exited;
    await Promise.allSettled([tick, wake]);
    await settlePipelineStopReadLanes();
    await stopServer?.close();
    await heldControl?.dispose();
    if (observer.exitCode === null) observer.kill();
    await observer.exited;
    for (const timer of timers) clearTimeout(timer);
    await settlePipelineControllerJobs();
    await (await import("@/lib/links/taskPageWorker")).shutdownTaskPageWorker();
    queue.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
}
