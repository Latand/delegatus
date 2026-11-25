import { cleanupRoleMemoryDispatch, fixture, holdRegistryWriter } from "./engine.roleMemoryDispatch.fixture";
import { afterEach, expect, setSystemTime, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { RoleMemoryChanged } from "@/lib/memory/privacy";
import { supervisedRuntimeHostUnavailableReason } from "@/lib/runtime/flags";
import { loadPipelines, savePipelines, tickPipelines } from "./engine.fixture";

afterEach(cleanupRoleMemoryDispatch);

test.each(["neverBegan", "roleMemoryRetrySafe"] as const)("a role-memory conflict waits before retiring its %s receipt once", async proof => {
    const { h, registry, production, normalSpawn, launches, replacements, stage, attempt: current } = await fixture(`retry-${proof}`);
    const waiting = loadPipelines()[0]!;
    expect(waiting.state, waiting.stateDetail ?? "").toBe("running");
    expect(waiting.runs[0]!.attempts[0]!).toMatchObject({ state: "spawning", launchId: launches[0] });
    expect(waiting.stateDetail).toContain("role-memory");
    expect(waiting.runs[0]!.attempts[0]!.controllerWait).toBeDefined();
    await tickPipelines([], h.ports);
    expect(launches).toHaveLength(1);
    expect(loadPipelines()[0]!.state).toBe("running");
    if (proof === "roleMemoryRetrySafe") stage();
    registry.failSpawn(launches[0]!, proof === "roleMemoryRetrySafe" ? new RoleMemoryChanged().message
      : supervisedRuntimeHostUnavailableReason("pipeline structured runtime host"));
    expect(production.spawnReceipt(launches[0]!)?.[proof]).toBe(true);
    h.ports.spawnAgent = normalSpawn;
    for (let i = 0; i < 5; i++) { h.advanceWallClock(1_000); await tickPipelines([], h.ports); }
    const attempt = current();
    expect(attempt.state).toBe("running");
    expect(attempt.retiredLaunches?.map(row => row.launchId)).toEqual(launches);
    expect(replacements).toHaveLength(1);
    expect(registry.spawnReceipt(launches[0]!)?.retryClaim?.claimId).toBe(`${waiting.id}:plan:${launches[0]}`);
});

for (const engine of ["codex", "claude"] as const) test.each(["absent", "metadata", "missing-parent", "missing-root", "missing-home"] as const)(
  `a confirmed unstarted ${engine} original with %s artifact launches exactly one replacement`, async artifact => {
  const f = await fixture(`${engine}-unstarted-${artifact}`, undefined, engine);
  const home = engine === "codex" ? process.env.LLV_CODEX_HOME! : process.env.LLV_CLAUDE_HOME!;
  const root = path.join(home, engine === "codex" ? "sessions" : "projects");
  const missingDirectory = artifact.startsWith("missing-");
  if (artifact === "missing-parent") fs.mkdirSync(root, { recursive: true });
  if (artifact === "missing-root") fs.mkdirSync(home, { recursive: true });
  const entry = f.stage("unhosted", f.launches[0]!, artifact === "metadata" ? "metadata" : "absent",
    path.join(root, engine === "codex" ? "2026/11/03" : "worktree-slug"), !missingDirectory);
  if (missingDirectory) expect(fs.existsSync(path.dirname(entry.artifactPath))).toBe(false);
  if (artifact === "missing-root" || artifact === "missing-home") expect(fs.existsSync(root)).toBe(false);
  if (artifact === "missing-home") expect(fs.existsSync(home)).toBe(false);
  expect(fs.existsSync(entry.artifactPath)).toBe(artifact === "metadata");
  expect(f.h.ports.sourcePathAllowed).toBe(f.production.sourcePathAllowed);
  expect(f.production.sourcePathAllowed(entry.artifactPath)).toBe(artifact === "metadata");
  f.registry.failSpawn(f.launches[0]!, new RoleMemoryChanged().message);
  f.h.ports.spawnAgent = f.normalSpawn;
  for (let i = 0; i < 6; i++) { await tickPipelines([], f.h.ports); f.h.advanceWallClock(1_000); }
  expect(f.replacements).toHaveLength(1);
  expect(f.attempt().state).toBe("running");
  expect(loadPipelines()[0]!.state).toBe("running");
  expect(f.attempt().retiredLaunches?.map(row => row.launchId)).toEqual(f.launches);
});

for (const engine of ["codex", "claude"] as const) test.each([
  "outside-root", "missing-outside-root", "escaped-parent", "missing-escaped-parent", "dangling-link", "dangling-parent",
  "dangling-root", "file-parent", "parent-changed-during-read", "missing-parent-changed-during-read",
  "missing-parent-changed-during-claim", "existing-file-refused",
] as const)(`${engine} retains an unstarted launch with %s transcript proof`, async mode => {
  const f = await fixture(`${engine}-path-${mode}`, undefined, engine);
  const outside = path.join(process.env.LLV_STATE_DIR!, "outside-transcripts");
  fs.mkdirSync(outside, { recursive: true });
  const escapedMissing = mode === "missing-escaped-parent" ? path.join(
    engine === "codex" ? process.env.LLV_CODEX_HOME! : process.env.LLV_CLAUDE_HOME!,
    engine === "codex" ? "sessions" : "projects", "escape", "missing") : undefined;
  const entry = f.stage("unhosted", f.launches[0]!, "absent",
    mode === "outside-root" ? outside : mode === "missing-outside-root" ? path.join(outside, "missing") : escapedMissing,
    mode !== "missing-outside-root");
  const parent = path.dirname(entry.artifactPath);
  const escapeParent = () => {
    if (fs.existsSync(parent)) fs.rmdirSync(parent);
    fs.symlinkSync(outside, parent, "dir");
  };
  if (mode === "escaped-parent") escapeParent();
  else if (mode === "missing-escaped-parent") {
    fs.rmdirSync(parent);
    fs.rmdirSync(path.dirname(parent));
    fs.symlinkSync(outside, path.dirname(parent), "dir");
  }
  else if (mode === "dangling-link") fs.symlinkSync(path.join(outside, "absent.jsonl"), entry.artifactPath);
  else if (mode === "dangling-parent" || mode === "dangling-root") {
    fs.rmdirSync(parent);
    const link = mode === "dangling-root" ? path.dirname(parent) : parent;
    if (mode === "dangling-root") fs.rmdirSync(link);
    fs.symlinkSync(path.join(outside, "absent-directory"), link, "dir");
  } else if (mode === "file-parent") {
    fs.rmdirSync(parent);
    fs.writeFileSync(parent, "");
  }
  else if (mode === "existing-file-refused") {
    fs.writeFileSync(entry.artifactPath, "");
    const allowed = f.h.ports.sourcePathAllowed;
    f.h.ports.sourcePathAllowed = candidate => candidate !== entry.artifactPath && allowed(candidate);
  } else if (mode === "parent-changed-during-read" || mode === "missing-parent-changed-during-read") {
    if (mode === "missing-parent-changed-during-read") fs.rmdirSync(parent);
    const evidence = f.h.ports.durableTurnEvidence;
    f.h.ports.durableTurnEvidence = async (...args) => {
      const result = await evidence(...args);
      escapeParent();
      return result;
    };
  } else if (mode === "missing-parent-changed-during-claim") {
    fs.rmdirSync(parent);
    const claim = f.h.ports.claimSpawnRetry;
    f.h.ports.claimSpawnRetry = async (...args) => {
      const result = await claim(...args);
      escapeParent();
      return result;
    };
  }
  f.registry.failSpawn(f.launches[0]!, new RoleMemoryChanged().message);
  f.h.ports.spawnAgent = f.normalSpawn;
  for (let i = 0; i < 6; i++) { await tickPipelines([], f.h.ports); f.h.advanceWallClock(1_000); }
  expect(f.replacements).toHaveLength(0);
  expect(f.attempt()).toMatchObject({ state: "spawning", launchId: f.launches[0] });
  expect(f.attempt().retiredLaunches).toBeUndefined();
  if (mode === "missing-parent-changed-during-claim") expect(f.registry.spawnReceipt(f.launches[0]!)?.retryClaim).toBeDefined();
  else expect(f.registry.spawnReceipt(f.launches[0]!)?.retryClaim).toBeUndefined();
});

test("registry writer contention before the role-memory deadline waits, then releases one replacement", async () => {
  const f = await fixture("writer-before-deadline", 20);
  f.stage();
  f.registry.failSpawn(f.launches[0]!, new RoleMemoryChanged().message);
  const wait = f.attempt().roleMemoryDispatchWait!;
  const holder = holdRegistryWriter(f);
  try {
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]).toMatchObject({ state: "running" });
    expect(loadPipelines()[0]!.stateDetail).toContain("receipt failed");
    expect(f.attempt()).toMatchObject({ state: "spawning", launchId: f.launches[0], roleMemoryDispatchWait: wait });
    expect(f.attempt().controllerWait?.retryAfter).toBeDefined();
    expect(f.replacements).toHaveLength(0);
  } finally { holder.exec("ROLLBACK"); holder.close(); }
  f.h.advanceWallClock(2_000);
  f.h.ports.spawnAgent = f.normalSpawn;
  await tickPipelines([], f.h.ports);
  expect(f.replacements).toHaveLength(0);
  expect(f.attempt()).toMatchObject({ state: "pending", launchId: null });
  for (let i = 0; i < 5; i++) { f.h.advanceWallClock(1_000); await tickPipelines([], f.h.ports); }
  expect(f.attempt().retiredLaunches?.map(row => row.launchId)).toEqual(f.launches);
  expect(f.replacements).toHaveLength(1);
  expect(f.registry.spawnReceipt(f.launches[0]!)?.retryClaim?.claimId).toBe(`${loadPipelines()[0]!.id}:plan:${f.launches[0]}`);
  await tickPipelines([], f.h.ports);
  expect(f.replacements).toHaveLength(1);
});

test("registry writer contention past the role-memory deadline parks with the current receipt state", async () => {
  const f = await fixture("writer-after-deadline", 20);
  f.stage();
  f.registry.failSpawn(f.launches[0]!, new RoleMemoryChanged().message);
  const wait = f.attempt().roleMemoryDispatchWait!;
  const holder = holdRegistryWriter(f);
  try {
    const expired = new Date(Date.parse(wait.deadline) + 1);
    setSystemTime(expired);
    f.h.advanceWallClock(expired.getTime() - Date.parse(f.h.ports.now()));
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision" });
    expect(loadPipelines()[0]!.stateDetail).toContain("receipt failed");
    expect(loadPipelines()[0]!.stateDetail).toContain(wait.deadline);
    expect(f.attempt()).toMatchObject({ launchId: f.launches[0], roleMemoryDispatchWait: wait });
    expect(f.replacements).toHaveLength(0);
  } finally { holder.exec("ROLLBACK"); holder.close(); }
});

test.each(["completed", "first-message"] as const)("a role-memory wait adopts %s evidence without another launch", async mode => {
  const f = await fixture(mode);
  const entry = f.stage("live");
  if (mode === "completed") f.registry.completeSpawn(f.launches[0]!, entry);
  else {
    fs.appendFileSync(entry.artifactPath, JSON.stringify({ type: "event_msg", timestamp: f.h.ports.now(),
      payload: { type: "user_message", message: "Build safely" } }) + "\n");
    f.h.ports.durableTurnEvidence = (await import("./durableEvidence")).durableStageTurnEvidence;
    f.h.ports.originalLaunchOperations = async () => "matched";
  }
  f.h.ports.conversationAgentActive = async () => true;
  await tickPipelines([], f.h.ports);
  expect(f.attempt()).toMatchObject({ state: "running", launchId: f.launches[0], agentPath: entry.artifactPath });
  expect(f.attempt().roleMemoryDispatchWait).toBeUndefined();
  expect(f.attempt().retiredLaunches).toBeUndefined();
  expect(f.launches).toHaveLength(1);
  expect(f.registry.spawnReceipt(f.launches[0]!)!.retryClaim).toBeUndefined();
});

test.each(["foreign-claim", "changed-after-claim", "pause-after-claim"] as const)("a role-memory retry retains its launch on %s", async mode => {
  const f = await fixture(mode);
  const staged = f.stage();
  f.registry.failSpawn(f.launches[0]!, new RoleMemoryChanged().message);
  if (mode === "foreign-claim") f.registry.claimFailedSpawnForRetry(f.launches[0]!, "another-recovery");
  else {
    f.h.ports.claimSpawnRetry = async (...args) => {
      const claim = await f.production.claimSpawnRetry(...args);
      if (mode === "changed-after-claim") f.registry.upsert({ ...staged, status: "live", claimOwner: "retained-host" });
      else {
        const { savePipelines } = await import("./store");
        const lane = loadPipelines()[0]!;
        lane.state = "paused";
        savePipelines([lane]);
      }
      return claim;
    };
  }
  await tickPipelines([], f.h.ports);
  expect(f.attempt().launchId).toBe(f.launches[0]!);
  expect(f.attempt().retiredLaunches).toBeUndefined();
  expect(f.launches).toHaveLength(1);
  expect(loadPipelines()[0]!.state).toBe(mode === "pause-after-claim" ? "paused" : "running");
});
