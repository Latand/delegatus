import { childTick, cleanupRoleMemoryDispatch, cleanups, fixture, nativeStart, ownedIdleChild } from "./engine.roleMemoryDispatch.fixture";
import { afterEach, expect, test } from "bun:test";
import path from "node:path";
import fs from "node:fs";
import { Database } from "bun:sqlite";
import { ROLE_MEMORY_PREPARATION_MESSAGE } from "@/lib/memory/roleStore";
import { RuntimeJournal } from "@/runtime-host/journal";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import { RoleMemoryChanged } from "@/lib/memory/privacy";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { defaultPipelinePorts, loadPipelines, savePipelines, tickPipelines } from "./engine.fixture";

afterEach(cleanupRoleMemoryDispatch);

for (const engine of ["codex", "claude"] as const) test.each([
  { native: false, survivor: false }, { native: true, survivor: false },
  { native: false, survivor: true }, { native: true, survivor: true },
])(`${engine} recovers a failed receipt without a saved role wait (native=$native, survivor=$survivor)`, async ({ native, survivor }) => {
  const f = await fixture(`${engine}-no-wait-${native}-${survivor}`, undefined, engine);
  const entry = f.stage();
  f.registry.failSpawn(f.launches[0]!, new RoleMemoryChanged().message);
  if (native) {
    nativeStart(engine, entry.artifactPath, f.h.ports.now());
    expect(f.production.spawnReceipt(f.launches[0]!)?.roleMemoryRetrySafe).toBe(true);
  }
  const child = survivor ? await ownedIdleChild() : null;
  if (child) f.registry.upsert({ ...entry, structuredTerminationSurvivors: [captureProcessIdentity(child.pid)] });
  const lane = loadPipelines()[0]!;
  delete lane.runs[0]!.attempts[0]!.roleMemoryDispatchWait;
  delete lane.runs[0]!.attempts[0]!.controllerWait;
  savePipelines([lane]);
  f.h.ports.originalLaunchOperations = async () => "unknown";
  f.h.ports.spawnAgent = f.normalSpawn;
  if (native || survivor) {
    expect(await childTick(f, f.h.ports.now(), entry.artifactPath, "unknown"))
      .toMatchObject({ state: "running", attemptState: "spawning", launchId: f.launches[0], spawns: 0 });
  }
  if (child) { child.stdin.end(); await child.exited; }
  for (let i = 0; i < 6; i++) { f.h.advanceWallClock(1_000); await tickPipelines([], f.h.ports); }
  expect(f.replacements).toHaveLength(native ? 0 : 1);
  if (native) expect(f.attempt().launchId).toBe(f.launches[0]!);
});

for (const engine of ["codex", "claude"] as const) test.each([false, true] as const)(
  `${engine} reconciles the parked second launch automatically without replacing native work (native=%s)`, async native => {
  const f = await fixture(`${engine}-manual-second-${native}`, undefined, engine);
  f.stage();
  f.registry.failSpawn(f.launches[0]!, new RoleMemoryChanged().message);
  for (let i = 0; i < 6 && f.launches.length < 2; i++) { f.h.advanceWallClock(1_000); await tickPipelines([], f.h.ports); }
  expect(f.launches).toHaveLength(2);
  const original = f.launches[1]!;
  const entry = f.stage("unhosted", original);
  f.registry.failSpawn(original, new RoleMemoryChanged().message);
  let survivor: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
  if (native) {
    nativeStart(engine, entry.artifactPath, f.h.ports.now());
    expect(f.h.ports.spawnReceipt(original)?.roleMemoryRetrySafe).toBe(true);
  } else {
    survivor = await ownedIdleChild();
    f.registry.upsert({ ...entry, structuredTerminationSurvivors: [captureProcessIdentity(survivor.pid)] });
  }
  f.h.ports.originalLaunchOperations = async () => "unknown";
  f.h.ports.spawnAgent = f.normalSpawn;
  f.h.advanceWallClock(11 * 60_000);
  await tickPipelines([], f.h.ports);
  const before = loadPipelines()[0]!;
  expect(before.state).toBe("needs_decision");
  const database = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"), { readonly: true });
  cleanups.push(() => database.close());
  const revision = () => database.query("SELECT row_revision FROM state_rows WHERE collection = 'pipelines' AND row_key = ?").get(before.id);
  const heldRevision = revision();
  for (let i = 0; i < 3; i++) {
    f.h.advanceWallClock(60_000);
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]).toEqual(before);
    expect(revision()).toEqual(heldRevision);
  }
  const { patchPipeline } = await import("./engine");
  for (let i = 0; i < 2; i++) {
    const held = await patchPipeline(before.id, { action: "retry-stage" }, f.h.ports);
    expect(held).toMatchObject({ status: 409 });
    expect(held.error).toContain("original launch retained");
    expect(loadPipelines()[0]).toEqual(before);
  }
  if (!native) {
    survivor!.stdin.end();
    await survivor!.exited;
    expect(await childTick(f, f.h.ports.now(), entry.artifactPath, "unknown"))
      .toMatchObject({ state: "running", launchId: null, spawns: 0 });
    for (let i = 0; i < 6; i++) { f.h.advanceWallClock(1_000); await tickPipelines([], f.h.ports); }
  }
  expect(f.replacements).toHaveLength(native ? 0 : 1);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
  if (native) expect(f.attempt().launchId).toBe(original);
});

for (const engine of ["codex", "claude"] as const) test.skipIf(process.platform === "win32").each([false, true] as const)(
  `${engine} preserves a pending skip during parked retirement (remote failure=%s)`, async remoteFailure => {
  const f = await fixture(`${engine}-parked-skip-${remoteFailure}`, undefined, engine);
  const entry = f.stage();
  f.registry.failSpawn(f.launches[0]!, new RoleMemoryChanged().message);
  const survivor = await ownedIdleChild();
  f.registry.upsert({ ...entry, structuredTerminationSurvivors: [captureProcessIdentity(survivor.pid)] });
  f.h.ports.spawnAgent = f.normalSpawn;
  f.h.advanceWallClock(11 * 60_000);
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  survivor.stdin.end(); await survivor.exited;
  const { pipelineArtifactsDir } = await import("./store");
  const lock = path.join(pipelineArtifactsDir(loadPipelines()[0]!.id), "remote-action.lock");
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const holder = Bun.spawn([process.execPath, "-e", `
    import { acquirePublicationFileLock } from "./src/lib/pipelines/git";
    const descriptor = await acquirePublicationFileLock(process.env.LLV_TEST_ACTION_LOCK);
    if (descriptor === null) throw new Error("fixture lock was already held");
    process.stdin.resume(); console.log("ready");
  `], { env: { ...process.env, LLV_TEST_ACTION_LOCK: lock }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  cleanups.push(async () => {
    if (holder.exitCode === null) holder.stdin.end();
    await holder.exited;
    fs.rmSync(lock, { recursive: true, force: true });
  });
  const reader = holder.stdout.getReader();
  try { expect(new TextDecoder().decode((await reader.read()).value).trim()).toBe("ready"); }
  finally { reader.releaseLock(); }
  const { patchPipeline } = await import("./engine");
  expect((await patchPipeline(loadPipelines()[0]!.id, { action: "skip-stage" }, f.h.ports)).error).toBeUndefined();
  const pending = loadPipelines()[0]!;
  expect(pending.remoteAction?.state).toBe("pending");
  for (let tick = 0; tick < 3; tick++) {
    f.h.advanceWallClock(60_000);
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]).toEqual(pending);
    expect(f.replacements).toHaveLength(0);
  }
  holder.stdin.end(); await holder.exited;
  if (remoteFailure) {
    // A real lock-open error settles the action without superseding it.
    fs.rmSync(lock);
    fs.mkdirSync(lock);
  }
  for (let tick = 0; tick < 6; tick++) { f.h.advanceWallClock(1_000); await tickPipelines([], f.h.ports); }
  expect(loadPipelines()[0]!.remoteAction?.state).toBe("settled");
  if (remoteFailure) {
    expect(loadPipelines()[0]!.remoteAction?.error).toContain("EISDIR");
    expect(f.replacements).toHaveLength(1);
  } else {
    expect(f.attempt().state).toBe("skipped");
    expect(f.replacements).toHaveLength(0);
  }
});

for (const engine of ["codex", "claude"] as const) for (const operations of ["matched", "unknown"] as const) test.each([false, true] as const)(
  `${engine} retains a non-role-memory failed receipt with native evidence (${operations}, skip=%s)`, async skip => {
  const f = await fixture(`${engine}-other-failure-${operations}-${skip}`, undefined, engine);
  const entry = f.stage();
  f.registry.failSpawn(f.launches[0]!, "structured spawn runtime snapshot has no session after 300000ms");
  nativeStart(engine, entry.artifactPath, f.h.ports.now());
  f.h.ports.originalLaunchOperations = async () => operations;
  f.h.ports.spawnAgent = f.normalSpawn;
  f.h.advanceWallClock(11 * 60_000);
  await tickPipelines([], f.h.ports);
  const before = loadPipelines()[0]!;
  expect(before.state).toBe("needs_decision");
  const { patchPipeline } = await import("./engine");
  expect(await patchPipeline(before.id, { action: "retry-stage" }, f.h.ports)).toMatchObject({ status: 409 });
  if (skip) expect((await patchPipeline(before.id, { action: "skip-stage" }, f.h.ports)).error).toBeUndefined();
  for (let i = 0; i < 4; i++) { f.h.advanceWallClock(60_000); await tickPipelines([], f.h.ports); }
  expect(f.replacements).toHaveLength(0);
  if (skip) expect(f.attempt().state).toBe("skipped");
  else expect(loadPipelines()[0]).toEqual(before);
});

for (const engine of ["codex", "claude"] as const) test.each([false, true] as const)(
  `${engine} takes its original report during a role wait (fresh controller=%s)`, async restart => {
  const f = await fixture(`${engine}-report-wait-${restart}`, undefined, engine);
  const entry = f.stage();
  f.registry.failSpawn(f.launches[0]!, new RoleMemoryChanged().message);
  nativeStart(engine, entry.artifactPath, f.h.ports.now());
  f.h.ports.originalLaunchOperations = async () => "unknown";
  f.h.ports.conversationAgentActive = async () => false;
  const { reportStageCompletion } = await import("./engine");
  expect((await reportStageCompletion({ verdict: "pass", findings: [], summary: "Original completed" },
    { kind: "agent", role: "builder", conversationId: f.attempt().conversationId! }, f.h.ports)).error).toBeUndefined();
  if (restart) {
    expect(await childTick(f, f.h.ports.now(), entry.artifactPath, "unknown", false))
      .toMatchObject({ verdict: { status: "pass" }, spawns: 0 });
  } else await tickPipelines([], f.h.ports);
  expect(f.attempt().verdict?.status).toBe("pass");
  expect(f.attempt().roleMemoryDispatchWait).toBeUndefined();
  expect(f.replacements).toHaveLength(0);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
});

test("role-memory dispatch deadlines round-trip and malformed waits are refused", async () => {
  const f = await fixture("validation");
  const { savePipelines } = await import("./store");
  const lane = loadPipelines()[0]!;
  const wait = f.attempt().roleMemoryDispatchWait!;
  for (const invalid of [null, [], {}, { ...wait, launchId: "" }, { ...wait, deadline: "invalid" }]) {
    lane.runs[0]!.attempts[0]!.roleMemoryDispatchWait = invalid as never;
    expect(() => savePipelines([lane])).toThrow("malformed pipeline record");
    expect(f.attempt().roleMemoryDispatchWait).toEqual(wait);
  }
});


test.each(["absent", "queued", "uncertain", "delivered", "foreign", "read-failed", "live", "generation"] as const)(
  "preparation deferral retains original custody with %s evidence", async mode => {
  const f = await fixture(`preparation-${mode}`);
  const entry = f.stage(mode === "live" ? "live" : "unhosted");
  f.registry.failSpawn(f.launches[0]!, ROLE_MEMORY_PREPARATION_MESSAGE);
  const journal = new RuntimeJournal(path.join(process.env.LLV_STATE_DIR!, `preparation-${mode}.sqlite`), { structuredHosts: true });
  cleanups.push(() => journal.close());
  if (!["absent", "live", "generation", "read-failed"].includes(mode)) {
    const launchId = f.launches[0]!, conversationId = mode === "foreign" ? "conversation_foreign" : f.attempt().conversationId!;
    journal.executeOperation({ kind: "spawn", operationId: launchId, idempotencyKey: launchId,
      conversationId, engine: "codex", cwd: loadPipelines()[0]!.worktreeDir!, prompt: "Build safely" });
    journal.append({ scope: { type: "session", id: conversationId }, kind: "session-status", payload: {
      conversationId, sessionKey: entry.key, artifactPath: entry.artifactPath, cwd: loadPipelines()[0]!.worktreeDir!,
      hostKind: "codex-app-server", host: "hosted", turn: "idle", activeTurnId: null, provenance: "structured",
    } });
    const id = `spawn_message_${launchId}`;
    journal.executeOperation({ kind: "send", operationId: id, idempotencyKey: id, conversationId, text: "Build safely" });
    if (mode === "foreign" || mode === "uncertain" || mode === "delivered") journal.transitionOperation(id, mode === "foreign" ? "failed" : mode, { reason: ROLE_MEMORY_PREPARATION_MESSAGE });
  }
  const client = {
    operationStatus: async (id: string) => {
      if (mode === "read-failed") throw new Error("fixture journal refused");
      return journal.operationResult(id);
    },
  } as RuntimeHostClient;
  const production = defaultPipelinePorts({ spawnRecoveryClient: () => client });
  f.h.ports.failStoppedStageLaunch = production.failStoppedStageLaunch;
  f.h.ports.spawnAgent = f.normalSpawn;
  if (mode === "live") f.registry.upsert({ ...f.registry.readOnlySnapshot().entries[`codex:${entry.key.sessionId}`]!,
    structuredHost: { kind: "codex-app-server", endpoint: "fixture", process: captureProcessIdentity(process.pid),
      eventCursor: 0, protocolVersion: "fixture", writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] } });
  if (mode === "generation") {
    const original = f.h.ports.spawnReceipt;
    f.h.ports.spawnReceipt = id => { const receipt = original(id); return receipt ? { ...receipt, generationMatches: false } : receipt; };
  }
  for (let turn = 0; turn < 8; turn++) { f.h.advanceWallClock(1_000); await tickPipelines([], f.h.ports); }
  if (mode === "absent") {
    expect(f.replacements).toHaveLength(1);
    expect(f.attempt().retiredLaunches?.map(row => row.launchId)).toEqual(f.launches);
    expect(f.attempt().state).toBe("running");
  } else {
    expect(f.replacements).toHaveLength(0);
    expect(f.attempt().launchId).toBe(f.launches[0]);
    expect(f.attempt().roleMemoryDispatchWait).toBeDefined();
  }
});
