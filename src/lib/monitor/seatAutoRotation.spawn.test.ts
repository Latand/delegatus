import "next/dist/server/node-environment-baseline";
import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkStore } from "next/dist/server/app-render/work-async-storage.external";
import type { WorkUnitStore } from "next/dist/server/app-render/work-unit-async-storage.external";
import type { SpawnResponse } from "@/lib/agent/spawnResponse";

const { AfterContext } = await import("next/dist/server/after/after-context");
const { workAsyncStorage } = await import("next/dist/server/app-render/work-async-storage.external");
const { workUnitAsyncStorage } = await import("next/dist/server/app-render/work-unit-async-storage.external");
const spawnCommand = await import("@/lib/agent/spawnCommand");
const { startDeferredSpawnWork } = await import("@/lib/agent/spawnDeferral");
const { AgentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
const { executeOrchestratorRotation, productionSeatCommandDependencies, setSeatCommandDependenciesForTests } = await import("@/lib/orchestrator/seatCommand");
const { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent, orchestratorSeatFor } = await import("@/lib/orchestrator/seats");
const { POST: rotateRoute } = await import("@/app/api/orchestrator/rotate/route");
const { NextRequest, NextResponse } = await import("next/server");
const { setBridgeReports } = await import("@/lib/projects/settings");
const { runSeatAutoRotation } = await import("./seatAutoRotation");
const { defaultSeatTickSources } = await import("./seatTickSources");
const { defaultSeatTickSettings, effectiveSeatTickSettings } = await import("./seatTickSettings");
const { readSeatTickState, writeSeatTickState } = await import("./seatTickState");
const { DEFAULT_SEAT_TICK_POLICY, AUTO_ROTATE_COOLDOWN_MS } = await import("./seatTick");
const { emptySeatTickState } = await import("./types");
import type { SeatTickCheckInput } from "./types";

const AT = "2026-10-23T07:23:00.000Z";
const NOW = Date.parse(AT);
const PROJECT = "rotation-fixture";
const SUCCESSOR = "conversation_successor";
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

afterEach(() => { setSeatCommandDependenciesForTests(null); setAgentRegistryForTests(null); });

async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "seat-rotation-spawn-"));
  const previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = directory;
  setSystemTime(new Date(AT));
  let registry: InstanceType<typeof AgentRegistry> | undefined;
  try {
    registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "off" });
    await run(await setup(directory, registry));
  }
  finally {
    setSeatCommandDependenciesForTests(null);
    setAgentRegistryForTests(null);
    registry?.close();
    setSystemTime();
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function setup(directory: string, registry: InstanceType<typeof AgentRegistry>) {
  setAgentRegistryForTests(registry);
  const transcript = path.join(directory, "incumbent.jsonl");
  fs.writeFileSync(transcript, "");
  const uuid = spyOn(crypto, "randomUUID").mockReturnValue(["11111111", "1111", "4111", "8111", "111111111111"].join("-") as ReturnType<typeof crypto.randomUUID>);
  let incumbent;
  try { incumbent = registry.ensureConversation("claude", transcript, null); }
  finally { uuid.mockRestore(); }
  registry.reconcileConversations([{ engine: "claude", path: transcript, accountId: null, launchProfile: emptyLaunchProfile({ cwd: directory, model: "opus" }),
    turn: { state: "idle", source: "assistant", terminalAt: AT }, observedAt: AT }]);
  beginOrchestratorSeatIntent({ project: PROJECT, mandate: "Own the fixture board.", clientRequestId: "seed_rotation", mode: "spawn", engine: "claude", model: "opus", now: AT });
  completeOrchestratorSeatIntent({ project: PROJECT, clientRequestId: "seed_rotation", conversationId: incumbent.id, path: transcript, now: AT });
  expect(setBridgeReports(PROJECT, false, "fixture", AT)).not.toBeNull();
  const seat = orchestratorSeatFor(PROJECT).active!;
  const settings = effectiveSeatTickSettings({ ...defaultSeatTickSettings(PROJECT), autoRotate: {
    enabled: true, thresholdPercent: 77, updatedAt: AT, setBy: { kind: "gateway", conversationId: null, project: null, seatEpoch: null }, why: null,
  } }, NOW, AUTO_ROTATE_COOLDOWN_MS);
  const input: SeatTickCheckInput = {
    project: PROJECT, now: NOW, seat: { conversationId: incumbent.id, seatEpoch: seat.seatEpoch, path: transcript, designatedAt: AT,
      turn: "idle", activity: null, mandateCarriesTickContract: true },
    state: emptySeatTickState(), settings, policy: DEFAULT_SEAT_TICK_POLICY,
    pipelines: [], tasks: [], events: [], pullRequests: [], pullRequestsUnavailable: null, signals: [], ownLanes: [], children: [], childrenUnavailable: null, changeFingerprint: "fixture",
  };
  const command = { ...productionSeatCommandDependencies,
    resolveProject: () => ({ project: PROJECT, displayName: PROJECT }),
    conversationTarget: () => ({ kind: "eligible" as const, conversationId: incumbent.id, path: transcript, cwd: directory, project: PROJECT, engine: "claude" as const }),
    resolvedConversation: () => null,
    launchSettlement: () => ({ kind: "unknown" as const }),
    runtimeIdentity: () => ({ engine: null, model: null }),
    engineReadiness: () => "connected" as const,
    stampRegistryIdentity: () => {}, startBoardReport: () => {}, now: () => AT,
  };
  const sources = { ...defaultSeatTickSources(), registry: () => registry, seatFor: orchestratorSeatFor, now: () => NOW,
    seatContextUsage: () => ({ engine: "claude" as const, model: "opus", tokens: 790_000, windowTokens: 1_000_000, estimated: false }) };
  return { directory, incumbent, input, command, check: () => runSeatAutoRotation(input, sources, readSeatTickState, writeSeatTickState,
    () => true, async () => { throw new Error("unexpected delivery"); }, {
      rotate: (body, _dependencies, actor, admission) => executeOrchestratorRotation(body, command, actor, admission),
    }) };
}

// Replace only the spawn command boundary: invoke the adapter's real scheduler,
// without starting an engine, contacting a runtime host or rotating a live seat.
test.each(["accepted", "refused", "throws"] as const)("tick auto-rotation outside a request: %s", outcome => fixture(async f => {
  let launches = 0;
  const spawn = spyOn(spawnCommand, "executeSpawnRequest").mockImplementation(async (_request, dependencies) => {
    if (outcome === "throws") throw new Error("fixture admission unavailable");
    if (outcome === "refused") return NextResponse.json({ error: "fixture account unavailable" }, { status: 409 });
    dependencies!.defer(async () => { launches++; });
    expect(dependencies!.defer).toBe(startDeferredSpawnWork);
    return NextResponse.json<SpawnResponse>({ ok: true, state: "settled", conversationId: SUCCESSOR, path: path.join(f.directory, "successor.jsonl"), launchId: "fixture-launch",
      target: null, launched: true, retrySafe: false, initialMessage: "delivered" });
  });
  try {
    expect(workAsyncStorage.getStore()).toBeUndefined();
    const detail = await f.check();
    await turn();
    expect(spawn).toHaveBeenCalledTimes(1);
    const attempt = readSeatTickState(PROJECT).autoRotation!.lastAttempt!;
    if (outcome === "accepted") {
      expect(attempt).toMatchObject({ state: "rotated", successorConversationId: SUCCESSOR });
      expect(detail).toContain("auto-rotation: rotated");
      expect(launches).toBe(1);
      expect(orchestratorSeatFor(PROJECT).active?.predecessorConversationId).toBe(f.incumbent.id);
    } else {
      expect(attempt).toMatchObject({ state: "failed", error: outcome === "refused" ? "fixture account unavailable" : "fixture admission unavailable" });
      expect(orchestratorSeatFor(PROJECT).active?.conversationId).toBe(f.incumbent.id);
      expect(launches).toBe(0);
    }
  } finally { await turn(); spawn.mockRestore(); }
}));

test("operator rotation route keeps Next's response-close scheduling", () => fixture(async f => {
  let launches = 0;
  const spawn = spyOn(spawnCommand, "executeSpawnRequest").mockImplementation(async (_request, dependencies) => {
    dependencies!.defer(async () => { launches++; });
    return NextResponse.json<SpawnResponse>({ ok: true, state: "settled", conversationId: SUCCESSOR, path: path.join(f.directory, "successor.jsonl"), launchId: "fixture-launch",
      target: null, launched: true, retrySafe: false, initialMessage: "delivered" });
  });
  const closed: Array<() => void> = [];
  const pending: Promise<unknown>[] = [];
  const context = new AfterContext({ waitUntil: promise => { pending.push(promise); }, onClose: callback => { closed.push(callback); }, onTaskError: undefined });
  setSeatCommandDependenciesForTests(f.command);
  try {
    const response = await workAsyncStorage.run({ afterContext: context } as WorkStore,
      () => workUnitAsyncStorage.run({ type: "request", phase: "action" } as WorkUnitStore, () => rotateRoute(new NextRequest("http://localhost/api/orchestrator/rotate", {
        method: "POST", headers: { "content-type": "application/json", host: "localhost", origin: "http://localhost" },
        body: JSON.stringify({ project: PROJECT, clientRequestId: "operator_rotation" }),
      }))));
    expect(response.status).toBe(200);
    expect((await response.json()).ok).toBe(true);
    await turn();
    expect(launches).toBe(0);
    for (const callback of closed) callback();
    await Promise.all(pending);
    expect(launches).toBe(1);
  } finally {
    for (const callback of closed) callback();
    await Promise.all(pending);
    spawn.mockRestore();
  }
}));
