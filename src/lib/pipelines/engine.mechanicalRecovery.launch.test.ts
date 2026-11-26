import { expect, test, harness, tickPipelines, reserveActivationOnly, loadPipelines, savePipelines, create, BUILD_ONLY, path, engineModule } from "./engine.fixture";
import type { Pipeline } from "./types";

import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { beginLegacySpawnFixture } from "@/lib/agent/registryTestFixtures";
import { SqliteStateCollection } from "@/lib/state/sqliteStateStore";

import { restartedTick } from "./engine.mechanicalRecovery.fixture";

async function interruptedBeforeReservation() {
  await reserveActivationOnly();
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  // The historical writer checkpointed spawning before it counted any call.
  attempt.state = "spawning";
  attempt.startedAt = "2026-10-29T08:47:16.000Z";
  delete attempt.activation;
  delete attempt.spawnCalls;
  lane.cursor!.state = "spawning";
  savePipelines([lane]);
  return lane;
}

test("a launch interrupted before reservation retries after restart without another attempt", async () => {
  const lane = await interruptedBeforeReservation();
  const waited = await restartedTick("2026-10-29T08:48:00.000Z");
  expect(waited.lane.state).toBe("running");
  expect(waited.spawns).toHaveLength(0);
  expect(waited.lane.stateDetail).toContain("retry");
  const early = await restartedTick("2026-10-29T08:48:59.999Z");
  expect(early.spawns).toHaveLength(0);
  const recovered = await restartedTick("2026-10-29T08:49:00.000Z");
  expect(recovered.spawns).toHaveLength(1);
  expect(recovered.lane.runs[0]!.attempts).toHaveLength(1);
  expect(recovered.lane.runs[0]!.attempts[0]!.state).toBe("running");
  expect(recovered.lane.lastPassedCommit).toBe(lane.lastPassedCommit);
}, 240_000);

test("three interrupted launch retries retain their cap through real process restarts", async () => {
  await interruptedBeforeReservation();
  let now = Date.parse("2026-10-29T08:48:00.000Z");
  for (const delay of [60_000, 5 * 60_000, 15 * 60_000]) {
    const waiting = await restartedTick(new Date(now).toISOString());
    expect(waiting.lane.state).toBe("running");
    expect(waiting.spawns).toHaveLength(0);
    now += delay;
    const lane = loadPipelines()[0]!;
    lane.runs[0]!.attempts[0]!.state = "spawning";
    lane.runs[0]!.attempts[0]!.startedAt = new Date(now).toISOString();
    lane.cursor!.state = "spawning";
    savePipelines([lane]);
  }
  const parked = await restartedTick(new Date(now).toISOString());
  expect(parked.lane.state).toBe("needs_decision");
  expect(parked.lane.stateDetail).toContain("after 3 automatic retries");
  expect(parked.spawns).toHaveLength(0);
  const after = await restartedTick(new Date(now + 24 * 60 * 60_000).toISOString());
  expect(after.lane.state).toBe("needs_decision");
  expect(after.spawns).toHaveLength(0);
}, 240_000);

test("a counted launch without its receipt remains an uncertain stop", async () => {
  await interruptedBeforeReservation();
  const lane = loadPipelines()[0]!;
  lane.runs[0]!.attempts[0]!.spawnCalls = 1;
  savePipelines([lane]);
  const result = await restartedTick("2026-10-29T08:48:00.000Z");
  expect(result.lane.state).toBe("needs_decision");
  expect(result.spawns).toHaveLength(0);
});

test.each(["report", "verdict", "output", "empty-output", "completed", "refusal"] as const)("preserved stage evidence prevents an interrupted launch retry: %s", async evidence => {
  const h = harness();
  const now = "2026-10-29T08:48:00.000Z";
  h.ports.now = () => now;
  await create(h.ports, BUILD_ONLY as never);
  await tickPipelines([], h.ports); await tickPipelines([], h.ports);
  const launched = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  expect((await engineModule.reportStageCompletion({ verdict: "pass", summary: "Preserved work" },
    { kind: "agent", role: "builder", conversationId: launched.conversationId }, h.ports)).error).toBeUndefined();
  const lane = loadPipelines()[0]!, attempt = lane.runs[0]!.attempts[0]!;
  const report = attempt.report!;
  if (evidence !== "report") delete attempt.report;
  attempt.verdict = evidence === "verdict" ? report.verdict : null;
  attempt.output = evidence === "output" ? report.summary! : evidence === "empty-output" ? "" : null;
  attempt.completedAt = evidence === "completed" ? now : null;
  attempt.error = evidence === "refusal" ? "privacy refused result.txt" : null;
  attempt.state = "spawning"; attempt.startedAt = now;
  attempt.launchId = null; attempt.conversationId = null; attempt.sessionId = null;
  attempt.agentPath = null; attempt.paneId = null;
  delete attempt.activation; delete attempt.spawnCalls;
  lane.cursor!.state = "spawning";
  savePipelines([lane]);
  const stopped = await restartedTick(now);
  expect(stopped.lane.state).toBe("needs_decision");
  expect(stopped.lane.runs[0]!.attempts[0]!.spawnInterruptionRetry).toBeUndefined();
  expect(stopped.spawns).toHaveLength(0);
  expect(stopped.lane.runs[0]!.attempts).toHaveLength(1);
  expect(stopped.lane.lastPassedCommit).toBe(lane.lastPassedCommit);
  if (evidence === "report") expect(stopped.lane.runs[0]!.attempts[0]!.report?.summary).toBe(report.summary);
  if (evidence === "verdict") expect(stopped.lane.runs[0]!.attempts[0]!.verdict?.status).toBe("pass");
  if (evidence === "output" || evidence === "empty-output") expect(stopped.lane.runs[0]!.attempts[0]!.output).toBe(attempt.output);
  if (evidence === "refusal") expect(stopped.lane.stateDetail).toContain("privacy refused result.txt");
}, 120_000);

test.each((["valid", "engine", "cwd", "member", "duplicate"] as const)
  .flatMap(kind => [0, 3, 127].map(call => ({ kind, call }))))
("an interrupted uncounted launch checks its admitted receipt before any retry: $kind, key $call", async ({ kind, call }) => {
  const h = await reserveActivationOnly();
  h.ports.now = () => "2026-10-29T08:48:00.000Z";
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  const input = attempt.activation!.input;
  const clientAttemptId = call === 0 ? input.clientAttemptId : `handshake_retry_${call}_${input.clientAttemptId}`.slice(0, 128);
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "mechanical-registry.json"));
  setAgentRegistryForTests(registry);
  h.ports.spawnReceipt = engineModule.defaultPipelinePorts().spawnReceipt;
  try {
    const begun = beginLegacySpawnFixture(registry, { engine: kind === "engine" ? "codex" : input.role.engine,
      cwd: kind === "cwd" ? input.cwd + "/foreign" : input.cwd,
      clientAttemptId, transport: "structured",
      memberships: [{ ...input.membership, ...(kind === "member" ? { containerId: "foreign-lane" } : {}) }] });
    if (begun.kind !== "created") throw new Error("receipt was not admitted");
    if (kind === "duplicate") {
      const second = beginLegacySpawnFixture(registry, { engine: input.role.engine, cwd: input.cwd,
        clientAttemptId: `handshake_retry_1_${input.clientAttemptId}`, transport: "structured", memberships: [input.membership] });
      expect(second.kind).toBe("created");
    }
    delete attempt.activation; delete attempt.spawnCalls;
    savePipelines([lane]);
    await tickPipelines([], h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.launchId).toBe(kind === "valid" ? begun.receipt.launchId : null);
    if (kind !== "valid") expect(loadPipelines()[0]!.stateDetail).toContain("conflicting launch evidence");
    h.ports.now = () => "2026-10-29T08:49:01.000Z";
    await tickPipelines([], h.ports);
    expect(h.spawnInputs).toHaveLength(0);
    // A bound starting receipt keeps the existing evidence-wait budget.
    // Even after that budget expires it must park without a replacement.
    h.ports.now = () => "2026-10-29T09:00:00.000Z";
    await tickPipelines([], h.ports);
    const held = loadPipelines()[0]!;
    expect(held.state).toBe("needs_decision");
    expect(held.runs[0]!.attempts).toHaveLength(1);
    expect(held.runs[0]!.attempts[0]!.spawnInterruptionRetry).toBeUndefined();
    expect(h.spawnInputs).toHaveLength(0);
    expect(registry.spawnReceiptForClientAttempt(clientAttemptId)).toMatchObject({ launchId: begun.receipt.launchId, state: "starting" });
  } finally { registry.close(); setAgentRegistryForTests(null); }
});

test("the first spawning checkpoint already contains the restartable activation", async () => {
  const h = harness();
  await create(h.ports, BUILD_ONLY as never);
  await tickPipelines([], h.ports);
  const prototype = SqliteStateCollection.prototype as InstanceType<typeof SqliteStateCollection<Pipeline>>;
  const original = prototype.reconcileSnapshot;
  let checkpoint: Pipeline | undefined;
  prototype.reconcileSnapshot = function<R>(operation: (records: Pipeline[], persist: (records?: readonly Pipeline[]) => Promise<void>, assertCurrent: (record: Pipeline) => void) => Promise<R> | R,
    ...args: [observeHold?: (heldMs: number) => void, explicitOnly?: boolean, keys?: readonly string[]]): Promise<R> {
    return original.call(this, (records, persist, assertCurrent) => operation(records, async changed => {
      await persist(changed);
      const row = loadPipelines()[0];
      if (!checkpoint && row?.cursor?.state === "spawning") {
        checkpoint = structuredClone(row);
        throw new Error("restart at the first spawning checkpoint");
      }
    }, assertCurrent), ...args) as Promise<R>;
  };
  try { await tickPipelines([], h.ports).catch(() => {}); }
  finally { prototype.reconcileSnapshot = original; }
  expect(checkpoint?.runs[0]!.attempts[0]!.activation?.phase).toBe("reserved");
  expect(h.spawnInputs).toHaveLength(0);
});
