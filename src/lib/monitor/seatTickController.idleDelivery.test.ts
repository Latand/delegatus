import nodeCrypto from "node:crypto";
import { spyOn } from "bun:test";
import { expect, test, fs, path, childFixture, setAgentRegistryForTests, ago, hostedSeat, createFakeDeliveryLedger, StructuredDeliveryQueue, FakeEngineHost, childRig, realTransport, runSeatTickCheck, NOW, deliverConversationMessage, enqueueStructuredMessage, emptyLaunchProfile } from "./seatTickController.fixture";
import type { HostState } from "@/lib/runtime/engineHost";
import { recoverDeadStructuredConversation } from "@/lib/runtime/structuredRecovery";
import { captureProcessIdentity } from "@/lib/processIdentity";
import type { ConversationMessage, DeliveryOutcome } from "@/lib/delivery";
import { loadPipelines, savePipelines } from "@/lib/pipelines/store";
import { pipelineCorpus } from "@/lib/pipelines/fixtures/corpus";
import { AgentRegistry } from "@/lib/agent/registry";
import { RuntimeJournal } from "@/runtime-host/journal";

/** Each invocation owns a fresh queue and SQLite connections. The engine seam
 * records fixture input, then can exit before acknowledging the effect. */
async function drainInProcess(directory: string, registryFile: string, operationId: string, phase: "deliver" | "crash" | "confirm" | "unverified") {
  const script = `
    import fs from "node:fs";
    import path from "node:path";
    import { AgentRegistry } from "./src/lib/agent/registry";
    import { RuntimeJournal } from "./src/runtime-host/journal";
    import { StructuredDeliveryQueue } from "./src/lib/runtime/structuredDeliveryQueue";
    import { FakeEngineHost, createFakeDeliveryLedger } from "./src/lib/runtime/fixtures/fakeEngineHost";
    const [directory, registryFile, operationId, phase] = process.argv.slice(1);
    const clock = Date;
    globalThis.Date = new Proxy(clock, {
      construct(target, args) { return Reflect.construct(target, args.length ? args : [${NOW}]); },
      get(target, key, receiver) { return key === "now" ? () => ${NOW} : Reflect.get(target, key, receiver); },
    });
    const registry = new AgentRegistry(registryFile, () => false, undefined, { sqliteMode: "sqlite" });
    const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
    const destination = path.join(directory, "destination.jsonl");
    const host = new FakeEngineHost(createFakeDeliveryLedger());
    const send = host.send.bind(host);
    host.send = async entry => {
      const receipt = await send(entry);
      fs.appendFileSync(destination, JSON.stringify({ type: "user", operationId: entry.id,
        turnId: receipt.turnId, text: entry.text }) + "\\n");
      if (phase === "crash") process.exit(23);
      return receipt;
    };
    const queue = new StructuredDeliveryQueue({
      effects: async (kinds, after) => journal.effectBatch(100, kinds, after),
      transition: async (id, status, details, options) => { journal.transitionOperation(id, status, details, options); },
      status: async id => journal.operationResult(id)?.receipt ?? null,
      hostClaim: () => phase === "crash" ? "fixture-before-exit" : "fixture-after-exit",
      confirmedDelivery: async id => phase === "confirm" && fs.readFileSync(destination, "utf8").trim().split("\\n")
        .some(line => JSON.parse(line).operationId === id),
      settled: () => false,
    }, () => host);
    try {
      await queue.drain(); await queue.drain();
      const held = Object.values(registry.snapshot().heldDeliveries);
      process.stdout.write(JSON.stringify({ pid: process.pid, status: journal.operationResult(operationId)?.receipt.status,
        held: held.map(row => ({ id: row.id, clientMessageId: row.clientMessageId, operationId: row.command.operationId,
          generationId: row.generationId })) }));
    } finally { journal.close(); registry.close(); }
  `;
  const child = Bun.spawn([process.execPath, "-e", script, directory, registryFile, operationId, phase],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, LLV_STAGING: "1" } });
  const deadline = setTimeout(() => child.kill(), 10_000);
  try {
    const [exit, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exit, error }).toEqual({ exit: phase === "crash" ? 23 : 0, error: "" });
    return output ? JSON.parse(output) as { pid: number; status: string; held: { id: string; clientMessageId: string; operationId: string; generationId: string }[] } : null;
  } finally { clearTimeout(deadline); }
}

test("a queued tick wake is written once when the queue drains an already-idle seat (#2695)", async () => {
  const Clock = Date;
  globalThis.Date = new Proxy(Clock, {
    construct(target, args) { return Reflect.construct(target, args.length ? args : [NOW]); },
    get(target, key, receiver) { return key === "now" ? () => NOW : Reflect.get(target, key, receiver); },
  });
  let nextId = 0;
  const nextUUID = (): ReturnType<typeof nodeCrypto.randomUUID> =>
    `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`;
  const nodeIds = spyOn(nodeCrypto, "randomUUID").mockImplementation(nextUUID);
  const webIds = spyOn(globalThis.crypto, "randomUUID").mockImplementation(nextUUID);
  try {
    const fixture = childFixture("idle-seat-tick-wake");
    setAgentRegistryForTests(fixture.registry);
    fixture.spawn({ title: "decision waiting", turn: "terminal", terminalAt: ago(fixture, 20) });
    fixture.seed();
    const { journal, client } = hostedSeat(fixture);
    const seatHost: HostState = {
      status: "idle", sessionKey: "seat-session", endpoint: "fixture:seat-host", pid: 1,
      processStartIdentity: "fixture:1", eventCursor: 0, protocolVersion: "fixture-v1",
      activeTurnRef: null, pendingAttention: [], activeFlags: [], account: null,
    };
    const ledger = createFakeDeliveryLedger();
    const queue = new StructuredDeliveryQueue({
      effects: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
      transition: async (id, status, details) => { journal.transitionOperation(id, status, details); },
      status: async (id) => journal.operationResult(id)?.receipt ?? null,
      settled: () => false,
    }, () => new FakeEngineHost(ledger, seatHost));
    try {
      const raised = childRig(fixture, { realWakeState: true, journal: { client }, settlementNow: () => NOW,
        deliverWith: realTransport(fixture, client) });
      expect(await runSeatTickCheck(fixture.project, raised.deps)).toMatchObject({
        verdict: "wake", delivery: { outcome: "queued" },
      });
      const wake = fixture.row().outstandingWake!;

      // No conversation event or operator send occurs between admission and delivery.
      await queue.drain();
      await queue.drain();
      expect(ledger.writes.map((entry) => entry.id)).toEqual([wake.operationId!]);
      expect(journal.operationResult(wake.operationId!)?.receipt.status).toBe("delivered");
    } finally {
      journal.close();
    }
  } finally {
    webIds.mockRestore();
    nodeIds.mockRestore();
  }
});

const recoveryChanges = ["none", "claim-owner", "writer-epoch", "seat-epoch", "conversation-generation", "retirement", "crash-confirmed", "crash-unverified"] as const;
for (const change of recoveryChanges) {
  test(`recovered idle seat reserves its first wake with nested authority reads: ${change}`, async () => {
    const clock = Date;
    globalThis.Date = new Proxy(clock, {
      construct(target, args) { return Reflect.construct(target, args.length ? args : [NOW]); },
      get(target, key, receiver) { return key === "now" ? () => NOW : Reflect.get(target, key, receiver); },
    });
    let nextId = 1000 * (1 + recoveryChanges.indexOf(change));
    const nextUUID = (): ReturnType<typeof nodeCrypto.randomUUID> =>
      `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`;
    const nodeIds = spyOn(nodeCrypto, "randomUUID").mockImplementation(nextUUID);
    const webIds = spyOn(globalThis.crypto, "randomUUID").mockImplementation(nextUUID);
    const fixture = childFixture(`nested-wake-${change}`);
    setAgentRegistryForTests(fixture.registry);
    fixture.spawn({ title: "completed work", turn: "terminal", terminalAt: ago(fixture, 20) });
    fixture.seed();
    const { journal, client, sessionId } = hostedSeat(fixture);
    const key = { engine: "claude" as const, sessionId };
    const profile = emptyLaunchProfile({ cwd: fixture.cwd });
    const deadProcess = { pid: 2_000_000_000, startIdentity: "dead-fixture" };
    fs.writeFileSync(fixture.seat.path!, "{}\n");
    fixture.registry.upsert({
      key, artifactPath: fixture.seat.path!, cwd: fixture.cwd, accountId: null, launchProfile: profile,
      status: "idle", host: null, claimEpoch: 4, claimOwner: `structured-host:${JSON.stringify(deadProcess)}`, pendingAction: null,
      structuredHost: { kind: "claude-broker", endpoint: "fixture:dead", process: deadProcess,
        eventCursor: 0, protocolVersion: "fixture-v1", writerClaimEpoch: 4,
        activeTurnRef: null, pendingAttention: [], activeFlags: [] },
    });
    let spawns = 0;
    const outcomes: DeliveryOutcome[] = [];
    const messages: ConversationMessage[] = [];
    const previousPipelines = loadPipelines();
    const hold = fixture.registry.holdDeliveryOffLoop.bind(fixture.registry);
    const reservation = spyOn(fixture.registry, "holdDeliveryOffLoop").mockImplementation((...args) => {
      const preflight = args[8];
      args[8] = async () => {
        await preflight?.();
        // Change authority after the last asynchronous preflight. The real
        // guard must read it again inside the reservation's mutation.
        if (change === "claim-owner" || change === "writer-epoch") {
          const entry = fixture.registry.structuredRecoveryFacts(key).entries[`claude:${sessionId}`]!;
          fixture.registry.upsert({ ...entry, ...(change === "claim-owner"
            ? { claimOwner: "replacement-owner" } : { claimEpoch: entry.claimEpoch + 1 }) });
        }
        if (change === "seat-epoch") fixture.seat.seatEpoch++;
        if (change === "conversation-generation") {
          const id = fixture.seat.conversationId as `conversation_${string}`;
          const receipt = { operationId: "fixture-generation-change", nativeId: "replacement-generation",
            path: path.join(fixture.dir, "replacement.jsonl"), continuityPaths: [], historyHash: "fixture-history",
            host: { kind: "claude-stream" as const, identity: "replacement-generation", epoch: 1, verifiedAt: new Date(NOW).toISOString() } };
          fixture.registry.setConversationMigration(id, { intentId: "fixture-migration", phase: "verifying",
            targetId: "fixture-target", revision: 1, error: null, operationId: receipt.operationId,
            providerReceipt: receipt, updatedAt: new Date(NOW).toISOString() });
          const successor = fixture.registry.commitSuccessor(id,
            { id: receipt.nativeId, path: receipt.path, accountId: "fixture-target" }, 1, receipt.operationId, receipt);
          expect(successor.generations.at(-1)?.id).toBe(receipt.nativeId);
          expect(successor.generations.at(-2)?.id).toBe(sessionId);
        }
        if (change === "retirement") {
          const lane = pipelineCorpus(1, 1)[0]!;
          lane.project = fixture.project;
          lane.stages = lane.stages.slice(0, 1);
          lane.stages[0]!.next = null;
          lane.runs = [{ stageId: "build", attempts: [{ ...lane.runs[0]!.attempts[0]!,
            conversationId: fixture.seat.conversationId, runtimeSwitches: [{ id: "fixture-switch", seq: 1,
              requestedAt: new Date(NOW).toISOString(), actor: { kind: "operator" }, mode: "fork", phase: "failed",
              from: { engine: "claude", model: null, effort: null, serviceTier: null, accountId: null,
                conversationId: fixture.seat.conversationId, launchId: null, sessionId, agentPath: fixture.seat.path },
              to: { engine: "claude", model: null, effort: null, serviceTier: null, accountId: "fixture-target", accountPinned: false },
              retry: { requestedAt: new Date(NOW).toISOString(), reason: "fixture retirement" },
            }] }] }];
          fixture.registry.rememberMembership(fixture.seat.conversationId as `conversation_${string}`,
            { kind: "pipeline", containerId: lane.id, role: "builder", slot: "build:1", stageId: "build",
              stageOrder: 0, round: 1, parentConversationId: null });
          savePipelines([...previousPipelines, lane]);
        }
      };
      return hold(...args);
    });
    const deliverWith = async (message: ConversationMessage) => {
      messages.push(message);
      const result = await deliverConversationMessage(message, {
        recover: request => recoverDeadStructuredConversation(request, {
          registry: fixture.registry, client, transport: () => "structured", park: () => null,
          resolveAccount: () => ({ engine: "claude", accountId: null, kind: "legacy",
            home: fixture.dir, transcriptRoot: fixture.dir, env: { NODE_ENV: "test" } }),
          spawn: async input => {
            spawns++;
            const process = captureProcessIdentity(globalThis.process.pid);
            const claim = await fixture.registry.deliveryWriteOrBusy({ label: "registry.resume-claim" }, () => {
              input.resumeAdmission!.beforeClaim();
              return fixture.registry.claimStructuredHost(key, process, { allowUnhosted: true,
                setupHost: { kind: "claude-broker", endpoint: "fixture:setup", process: null,
                  eventCursor: 0, protocolVersion: "fixture-v1", writerClaimEpoch: 4,
                  activeTurnRef: null, pendingAttention: [], activeFlags: [] },
                setupEntry: { artifactPath: fixture.seat.path!, cwd: fixture.cwd, accountId: null, launchProfile: profile },
              });
            });
            if (!claim?.claimOwner || !claim.structuredHost) throw new Error("fixture claim missing");
            input.resumeAdmission!.claimed(claim);
            expect(fixture.registry.stageStructuredSpawn(input.receipt.launchId, {
              key, artifactPath: fixture.seat.path!, cwd: fixture.cwd, accountId: null, launchProfile: profile,
              status: "idle", host: null, structuredHost: { ...claim.structuredHost,
                endpoint: "fixture:recovered", process, writerClaimEpoch: claim.claimEpoch },
              claimEpoch: claim.claimEpoch, claimOwner: claim.claimOwner, pendingAction: "spawn",
            }).kind).toBe("settled");
            expect(fixture.registry.finalizeStructuredSpawn(input.receipt.launchId).kind).toBe("settled");
            return { ok: true, target: null, path: fixture.seat.path!, launchId: input.receipt.launchId,
              conversationId: fixture.seat.conversationId as `conversation_${string}`, launched: true,
              retrySafe: false, initialMessage: "delivered", state: "settled" };
          },
          requestDeliveryDrain: () => {},
        }),
        enqueueStructured: request => enqueueStructuredMessage(request, {
          enabled: () => true, client: () => client, registry: () => fixture.registry,
          kick: () => {}, requestMigrationTick: () => {},
        }),
      });
      outcomes.push(result);
      return result;
    };
    try {
      const rig = childRig(fixture, { realWakeState: true, journal: { client }, settlementNow: () => NOW, deliverWith });
      const before = fixture.row().lastWakeAt;
      const first = await runSeatTickCheck(fixture.project, rig.deps);
      expect(spawns).toBe(1);
      expect(fixture.row().lastWakeAt).toBe(before);
      if (change !== "none" && change !== "crash-confirmed" && change !== "crash-unverified") {
        const refused = outcomes[0]!;
        expect(refused).toMatchObject({ ok: false });
        if (refused.ok) throw new Error("reservation unexpectedly admitted");
        expect(refused.error).toBe(change === "retirement"
          ? "runtime switch retry withdrew the old attempt's execution authority"
          : change === "seat-epoch" ? "seat-rotated" : "structured-recovery-superseded");
        expect(Object.values(fixture.registry.snapshot().heldDeliveries)).toHaveLength(0);
        if (change === "conversation-generation") {
          expect(refused.status).toBe(409);
          expect(fixture.row().outstandingWake?.clientMessageId).toBe(messages[0]!.clientMessageId!);
          expect(fixture.row().outstandingWake?.operationId).toBeNull();
        }
        journal.close();
        fixture.registry.close();
        expect((await drainInProcess(fixture.dir, fixture.registry.filename, "refused-original-wake", "deliver"))!.held).toEqual([]);
        expect(fs.existsSync(path.join(fixture.dir, "destination.jsonl"))).toBe(false);
        return;
      }
      expect(first).toMatchObject({ verdict: "wake", delivery: { outcome: "queued" } });
      expect(outcomes[0]).toMatchObject({ ok: true, outcome: "queued" });
      const wake = fixture.row().outstandingWake!;
      const destination = path.join(fixture.dir, "destination.jsonl");
      expect(await deliverWith(messages[0]!)).toMatchObject({ ok: false, status: 409, error: "wake-dispatch-fenced" });
      const held = Object.values(fixture.registry.snapshot().heldDeliveries);
      expect(held).toHaveLength(1);
      const registryFile = fixture.registry.filename;
      journal.close();
      fixture.registry.close();
      if (change !== "none") {
        expect(await drainInProcess(fixture.dir, registryFile, wake.operationId!, "crash")).toBeNull();
        const pending = new RuntimeJournal(path.join(fixture.dir, "runtime.sqlite"), { structuredHosts: true });
        try { expect(pending.operationResult(wake.operationId!)?.receipt.status).toBe("delivering"); }
        finally { pending.close(); }
        expect(fixture.row().lastWakeAt).toBe(before);
      }
      const phase = change === "none" ? "deliver" : change === "crash-confirmed" ? "confirm" : "unverified";
      const delivered = await drainInProcess(fixture.dir, registryFile, wake.operationId!, phase);
      const replay = await drainInProcess(fixture.dir, registryFile, wake.operationId!, phase);
      expect(delivered!.pid).not.toBe(replay!.pid);
      expect(delivered!.status).toBe(change === "crash-unverified" ? "uncertain" : "delivered");
      expect(replay!.status).toBe(delivered!.status);
      expect(replay!.held).toEqual(held.map(row => ({ id: row.id, clientMessageId: row.clientMessageId,
        operationId: row.command!.operationId, generationId: row.generationId })));
      const transcript = fs.readFileSync(destination, "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(transcript).toHaveLength(1);
      expect(transcript[0]).toMatchObject({ type: "user", operationId: wake.operationId, turnId: `turn:${wake.operationId}` });
      const reopened = new AgentRegistry(registryFile, () => false, undefined, { sqliteMode: "sqlite" });
      try { expect(Object.values(reopened.snapshot().heldDeliveries).map(row => row.id)).toEqual([held[0]!.id]); }
      finally { reopened.close(); }
      expect(fixture.row().outstandingWake?.clientMessageId).toBe(wake.clientMessageId);
      expect(fixture.row().lastWakeAt).toBe(before);
    } finally {
      if (change === "retirement") savePipelines(previousPipelines);
      reservation.mockRestore();
      journal.close();
      fixture.registry.close();
      webIds.mockRestore();
      nodeIds.mockRestore();
    }
  });
}
