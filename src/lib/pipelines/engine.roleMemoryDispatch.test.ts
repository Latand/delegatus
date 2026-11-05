import "./engineEnvironment.fixture";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { Database } from "bun:sqlite";
import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { AgentRegistry, defaultPipelinePorts, loadPipelines, reserveActivationOnly,
  savePipelines, setAgentRegistryForTests, tickPipelines } from "./engine.fixture";
import { RoleMemoryChanged } from "@/lib/memory/privacy";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { supervisedRuntimeHostUnavailableReason } from "@/lib/runtime/flags";
import { captureProcessIdentity } from "@/lib/processIdentity";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); setSystemTime(); setAgentRegistryForTests(null); });

function nativeStart(engine: "codex" | "claude", pathname: string, now: string) {
  fs.appendFileSync(pathname, JSON.stringify(engine === "codex"
    ? { type: "event_msg", timestamp: now, payload: { type: "task_started" } }
    : { type: "assistant", timestamp: now, message: { role: "assistant", stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "native-start-tool", name: "Read", input: { file_path: "fixture.txt" } }] } }) + "\n");
}

async function ownedIdleChild() {
  const child = Bun.spawn([process.execPath, "-e", "process.stdin.resume(); console.log('ready')"], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  cleanups.push(async () => { if (child.exitCode === null) child.stdin.end(); await child.exited; });
  const reader = child.stdout.getReader();
  try { expect(new TextDecoder().decode((await reader.read()).value).trim()).toBe("ready"); }
  finally { reader.releaseLock(); }
  return child;
}

async function fixture(name: string, sqliteWriterDeadlineMs?: number, engine: "codex" | "claude" = "codex") {
  setSystemTime(new Date("2026-11-03T12:00:00Z"));
  let sequence = 0;
  const ids = spyOn(crypto, "randomUUID").mockImplementation(() => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`);
  cleanups.push(() => ids.mockRestore());
  const h = await reserveActivationOnly([{ id: "plan", kind: "run", role: { roleId: "builder" }, engine,
    ...(engine === "claude" ? { model: "fable" } : {}),
    access: "read-only", prompt: "Build safely", next: null }] as never);
  h.advanceWallClock(Date.parse("2026-11-03T12:00:00Z") - Date.parse(h.ports.now()));
  const registryFile = path.join(process.env.LLV_STATE_DIR!, `memory-dispatch-${name}.json`);
  const registry = new AgentRegistry(registryFile, undefined, undefined, sqliteWriterDeadlineMs === undefined ? {} : {
    sqliteMode: "sqlite", sqliteWriterDeadlineMs,
  });
  cleanups.push(() => registry.close());
  setAgentRegistryForTests(registry);
  const production = defaultPipelinePorts();
  // The fixture producer bypasses spawnAgent's production cache invalidation.
  // Each observation therefore uses a fresh production projection, including
  // reservations created after a previous launch's retirement.
  h.ports.spawnReceipt = launchId => defaultPipelinePorts().spawnReceipt(launchId);
  h.ports.claimSpawnRetry = production.claimSpawnRetry;
  h.ports.sourcePathAllowed = production.sourcePathAllowed;
  for (const key of ["LLV_CODEX_HOME", "LLV_CLAUDE_HOME"]) {
    const previous = process.env[key];
    process.env[key] = path.join(process.env.LLV_STATE_DIR!, key, name);
    cleanups.push(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  h.ports.durableTurnEvidence = (await import("./durableEvidence")).durableStageTurnEvidence;
  const launches: string[] = [];
  h.ports.spawnAgent = async (input, onReserved) => {
    const begun = registry.beginSpawnRequest({ engine: input.role.engine, cwd: input.cwd,
      transport: "structured", clientAttemptId: input.clientAttemptId, launchProfile: { title: input.title } });
    expect(begun.kind).toBe("created");
    launches.push(begun.receipt.launchId);
    await onReserved(begun.receipt);
    throw new RoleMemoryChanged();
  };
  await tickPipelines([], h.ports);
  const attempt = () => loadPipelines()[0]!.runs[0]!.attempts[0]!;
  const stage = (status: "unhosted" | "live" = "unhosted", launchId = launches[0]!, artifact: "absent" | "metadata" = "absent", directory?: string, createDirectory = true, artifactSessionId?: string) => {
    const key = { engine, sessionId: crypto.randomUUID() };
    const artifactPath = path.join(directory ?? path.join(engine === "codex" ? process.env.LLV_CODEX_HOME! : process.env.LLV_CLAUDE_HOME!,
      engine === "codex" ? "sessions" : "projects", name), `${artifactSessionId ?? key.sessionId}.jsonl`);
    if (createDirectory) fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    if (artifact === "metadata") fs.writeFileSync(artifactPath, JSON.stringify({ type: "session_meta", payload: { id: key.sessionId } }) + "\n");
    const entry = { key, artifactPath, cwd: loadPipelines()[0]!.worktreeDir!, accountId: null,
      launchProfile: emptyLaunchProfile(), status, host: null, pendingAction: null, claimEpoch: 0, claimOwner: null };
    expect(registry.stageStructuredSpawn(launchId, entry).kind).toBe("settled");
    return entry;
  };
  const replacements: string[] = [];
  const normalSpawn: typeof h.ports.spawnAgent = async (input, onReserved) => {
    const begun = registry.beginSpawnRequest({ engine: input.role.engine, cwd: input.cwd,
      transport: "structured", clientAttemptId: input.clientAttemptId, launchProfile: { title: input.title } });
    expect(begun.kind).toBe("created");
    replacements.push(begun.receipt.launchId);
    await onReserved(begun.receipt);
    const entry = stage("live", begun.receipt.launchId);
    registry.completeSpawn(begun.receipt.launchId, entry);
    return { launchId: begun.receipt.launchId, conversationId: begun.receipt.conversationId,
      sessionId: entry.key.sessionId, transcript: entry.artifactPath, paneId: null, accountId: null };
  };
  return { h, registry, registryFile, production, normalSpawn, launches, replacements, attempt, stage };
}

function holdRegistryWriter(f: Awaited<ReturnType<typeof fixture>>) {
  const holder = new Database(f.registryFile.replace(/\.json$/, ".sqlite"));
  holder.exec("PRAGMA busy_timeout = 0");
  holder.exec("BEGIN IMMEDIATE");
  return holder;
}

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

for (const timing of ["before-claim", "during-claim"] as const) test.each(["task_started", "user_message"] as const)(
  `a ${timing} %s receipt adopts the original launch through later controllers`, async event => {
  const f = await fixture(`late-${timing}-${event}`);
  const staged = f.stage();
  f.registry.failSpawn(f.launches[0]!, new RoleMemoryChanged().message);
  const pathname = staged.artifactPath;
  f.h.ports.durableTurnEvidence = (await import("./durableEvidence")).durableStageTurnEvidence;
  f.h.ports.originalLaunchOperations = async () => "matched";
  f.h.ports.conversationAgentActive = async () => true;
  const claim = f.h.ports.claimSpawnRetry;
  const start = async () => {
    fs.appendFileSync(pathname, JSON.stringify({ type: "event_msg", timestamp: f.h.ports.now(),
      payload: event === "task_started" ? { type: "task_started" } : { type: "user_message", message: "Build safely" } }) + "\n");
    const evidence = await f.h.ports.durableTurnEvidence("codex", pathname);
    expect(evidence).toMatchObject({ launchOnly: false, turn: "busy" });
  };
  if (timing === "before-claim") await start();
  else f.h.ports.claimSpawnRetry = async (...args) => {
    const result = await claim(...args);
    expect(result).toBe("claimed");
    await start();
    return result;
  };

  await tickPipelines([], f.h.ports);

  expect(f.attempt()).toMatchObject({ state: "running", launchId: f.launches[0], agentPath: pathname });
  expect(f.attempt().roleMemoryDispatchWait).toBeUndefined();
  expect(f.attempt().retiredLaunches).toBeUndefined();
  expect(f.replacements).toHaveLength(0);
  expect(f.launches).toHaveLength(1);
  for (let i = 0; i < 5; i++) {
    f.h.advanceWallClock(1_000);
    await tickPipelines([], f.h.ports);
    expect(f.attempt()).toMatchObject({ state: "running", launchId: f.launches[0], agentPath: pathname });
  }
  for (let i = 0; i < 2; i++) {
    expect(await childTick(f, f.h.ports.now(), pathname, "unknown")).toMatchObject({
      state: "running", attemptState: "running", launchId: f.launches[0], spawns: 0,
    });
  }
  const { reportStageCompletion } = await import("./engine");
  const reported = await reportStageCompletion({ verdict: "pass", findings: [], summary: "Original completed" },
    { kind: "agent", role: "builder", conversationId: f.attempt().conversationId! }, f.h.ports);
  expect(reported.error).toBeUndefined();
  fs.appendFileSync(pathname, JSON.stringify({ type: "event_msg", timestamp: f.h.ports.now(),
    payload: { type: "task_complete", last_agent_message: "Original completed" } }) + "\n");
  await tickPipelines([], f.h.ports);
  expect(f.attempt().verdict?.status).toBe("pass");
  expect(f.attempt().state).toBe("passed");
  expect(f.replacements).toHaveLength(0);
});

test.each(["before-claim", "during-claim"] as const)("unknown operations retain a native start %s", async timing => {
  const f = await fixture(`unknown-${timing}`);
  const entry = f.stage();
  f.registry.failSpawn(f.launches[0]!, new RoleMemoryChanged().message);
  f.h.ports.originalLaunchOperations = async () => "unknown";
  f.h.ports.spawnAgent = f.normalSpawn;
  const start = () => fs.appendFileSync(entry.artifactPath, JSON.stringify({ type: "event_msg", timestamp: f.h.ports.now(),
    payload: { type: "task_started" } }) + "\n");
  if (timing === "before-claim") start();
  else {
    const claim = f.h.ports.claimSpawnRetry;
    f.h.ports.claimSpawnRetry = async (...args) => {
      const result = await claim(...args);
      expect(result).toBe("claimed");
      start();
      return result;
    };
  }
  for (let i = 0; i < 6; i++) {
    await tickPipelines([], f.h.ports);
    f.h.advanceWallClock(1_000);
  }
  expect(f.replacements).toHaveLength(0);
  expect(f.attempt()).toMatchObject({ state: "spawning", launchId: f.launches[0] });
  expect(f.attempt().retiredLaunches).toBeUndefined();
  expect(f.registry.spawnReceipt(f.launches[0]!)?.retryClaim?.claimId).toBe(timing === "before-claim"
    ? undefined : `${loadPipelines()[0]!.id}:plan:${f.launches[0]}`);
  expect(await childTick(f, f.h.ports.now(), entry.artifactPath, "unknown")).toMatchObject({
    state: "running", attemptState: "spawning", launchId: f.launches[0], spawns: 0,
  });
  f.h.ports.originalLaunchOperations = async () => "matched";
  f.h.ports.conversationAgentActive = async () => true;
  await tickPipelines([], f.h.ports);
  expect(f.attempt()).toMatchObject({ state: "running", launchId: f.launches[0], agentPath: entry.artifactPath });
  expect(f.replacements).toHaveLength(0);
});

for (const engine of ["codex", "claude"] as const) test.each(["native", "partial", "unreadable"] as const)(
  `${engine} retains its original when an absent artifact becomes %s during the retry claim`, async artifact => {
  const f = await fixture(`${engine}-appearing-${artifact}`, undefined, engine);
  const entry = f.stage();
  expect(fs.existsSync(entry.artifactPath)).toBe(false);
  f.registry.failSpawn(f.launches[0]!, new RoleMemoryChanged().message);
  expect(f.production.spawnReceipt(f.launches[0]!)?.roleMemoryRetrySafe).toBe(true);
  f.h.ports.originalLaunchOperations = async () => "unknown";
  f.h.ports.spawnAgent = f.normalSpawn;
  let claims = 0;
  const claim = f.h.ports.claimSpawnRetry;
  f.h.ports.claimSpawnRetry = async (...args) => {
    const result = await claim(...args);
    expect(result).toBe("claimed");
    claims++;
    expect(fs.existsSync(entry.artifactPath)).toBe(false);
    if (artifact === "unreadable") fs.symlinkSync(path.basename(entry.artifactPath), entry.artifactPath);
    else fs.writeFileSync(entry.artifactPath, artifact === "partial" ? '{"type":"user"' : JSON.stringify(engine === "codex"
      ? { type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "task_started" } }
      : { type: "user", timestamp: f.h.ports.now(), message: { role: "user", content: "Build safely" } }) + "\n");
    return result;
  };
  for (let i = 0; i < 6; i++) { await tickPipelines([], f.h.ports); f.h.advanceWallClock(1_000); }
  expect(claims).toBe(1);
  expect(f.replacements).toHaveLength(0);
  expect(f.attempt()).toMatchObject({ state: "spawning", launchId: f.launches[0] });
  expect(f.attempt().retiredLaunches).toBeUndefined();
  expect(await childTick(f, f.h.ports.now(), entry.artifactPath, "unknown")).toMatchObject({
    state: "running", attemptState: "spawning", launchId: f.launches[0], spawns: 0,
  });
});

test.each(["unreadable", "partial", "unknown", "changed-during-read", "changed-during-claimed-read",
  "appeared-during-read", "appeared-during-claimed-read"] as const)(
  "role-memory retirement requires unchanged positive no-turn evidence: %s", async mode => {
  const f = await fixture(`no-turn-${mode}`);
  const entry = f.stage("unhosted", f.launches[0]!, "metadata");
  f.registry.failSpawn(f.launches[0]!, new RoleMemoryChanged().message);
  f.h.ports.originalLaunchOperations = async () => "unknown";
  f.h.ports.spawnAgent = f.normalSpawn;
  const evidence = f.h.ports.durableTurnEvidence;
  if (mode === "unreadable") {
    fs.unlinkSync(entry.artifactPath);
    fs.mkdirSync(entry.artifactPath);
  } else if (mode === "partial") fs.appendFileSync(entry.artifactPath, '{"type":"event_msg"');
  else if (mode === "unknown") fs.appendFileSync(entry.artifactPath, JSON.stringify({ type: "event_msg",
    payload: { type: "task_started" } }) + "\n");
  else {
    const absent = mode.startsWith("appeared-");
    if (absent) fs.unlinkSync(entry.artifactPath);
    let reads = 0;
    f.h.ports.durableTurnEvidence = async (...args) => {
      const result = await evidence(...args);
      if (++reads === (mode.endsWith("claimed-read") ? 2 : 1)) {
        if (absent) expect(result).toBeNull();
        else expect(result?.launchOnly).toBe(true);
        fs.appendFileSync(entry.artifactPath, JSON.stringify({ type: "event_msg", timestamp: f.h.ports.now(),
          payload: { type: "task_started" } }) + "\n");
      }
      return result;
    };
  }
  for (let i = 0; i < 6; i++) { await tickPipelines([], f.h.ports); f.h.advanceWallClock(1_000); }
  expect(f.replacements).toHaveLength(0);
  expect(f.attempt()).toMatchObject({ state: "spawning", launchId: f.launches[0] });
  expect(f.attempt().retiredLaunches).toBeUndefined();
});

test("late delivery with a mismatched claimed generation cannot adopt or retire the launch", async () => {
  const f = await fixture("mismatched-claimed-generation");
  const staged = f.stage();
  f.registry.failSpawn(f.launches[0]!, new RoleMemoryChanged().message);
  const pathname = staged.artifactPath;
  f.h.ports.durableTurnEvidence = (await import("./durableEvidence")).durableStageTurnEvidence;
  f.h.ports.originalLaunchOperations = async () => "matched";
  const claim = f.h.ports.claimSpawnRetry;
  f.h.ports.claimSpawnRetry = async (...args) => {
    const result = await claim(...args);
    f.registry.upsert({ ...staged, artifactPath: `${pathname}.other-generation` });
    fs.appendFileSync(pathname, JSON.stringify({ type: "event_msg", timestamp: f.h.ports.now(),
      payload: { type: "user_message", message: "Build safely" } }) + "\n");
    return result;
  };

  await tickPipelines([], f.h.ports);

  expect(f.production.spawnReceipt(f.launches[0]!)?.generationMatches).toBe(false);
  expect(f.attempt()).toMatchObject({ state: "spawning", launchId: f.launches[0] });
  expect(f.attempt().agentPath).toBeNull();
  expect(f.attempt().retiredLaunches).toBeUndefined();
  expect(f.replacements).toHaveLength(0);
});

async function childTick(f: Awaited<ReturnType<typeof fixture>>, now: string, transcriptPath?: string, operations = "matched", active = true) {
    const child = Bun.spawn([process.execPath, "-e", `
      const { setMachineCpuPressureForTests } = await import("./src/lib/runtime/cpuPressure");
      setMachineCpuPressureForTests(null);
      const { tickPipelines, defaultPipelinePorts } = await import("./src/lib/pipelines/engine");
      const { registerPipelineTick } = await import("./src/lib/pipelines/controllerSignal");
      const { loadPipelines } = await import("./src/lib/pipelines/store");
      const { AgentRegistry, setAgentRegistryForTests } = await import("./src/lib/agent/registry");
      const registry = new AgentRegistry(process.env.LLV_MEMORY_DISPATCH_REGISTRY);
      setAgentRegistryForTests(registry); registerPipelineTick(async () => {});
      let spawns = 0;
      await tickPipelines([], { ...defaultPipelinePorts(), now: () => process.env.LLV_MEMORY_DISPATCH_NOW,
        exec: async () => ({ code: 0, stdout: "", stderr: "" }), scheduleTick: () => {},
        cpuPressureHold: () => null, drainHold: () => null, worktreePresent: () => true,
        conversationAgentActive: async () => process.env.LLV_MEMORY_DISPATCH_ACTIVE === "true",
        ...(process.env.LLV_MEMORY_DISPATCH_TRANSCRIPT_PATH ? {
          originalLaunchOperations: async () => process.env.LLV_MEMORY_DISPATCH_OPERATIONS,
        } : {}),
        spawnAgent: async () => { spawns++; throw new Error("unexpected launch"); },
        recoverStagedLaunch: async () => { throw new Error("privacy wait must not replay its launch"); },
      });
      const lane = loadPipelines()[0];
      const attempt = lane.runs[0].attempts[0];
      console.log(JSON.stringify({ state: lane.state, attemptState: attempt.state, verdict: attempt.verdict, detail: lane.stateDetail, wait: attempt.roleMemoryDispatchWait,
        launchId: attempt.launchId, agentPath: attempt.agentPath, retiredLaunches: attempt.retiredLaunches, spawns }));
      registry.close();
    `], { env: { ...process.env, LLV_MEMORY_DISPATCH_REGISTRY: f.registryFile, LLV_MEMORY_DISPATCH_NOW: now,
      LLV_MEMORY_DISPATCH_OPERATIONS: operations,
      LLV_MEMORY_DISPATCH_ACTIVE: String(active),
      ...(transcriptPath ? { LLV_MEMORY_DISPATCH_TRANSCRIPT_PATH: transcriptPath } : {}) },
      stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, errors).toBe(0);
    return JSON.parse(output);
}

test.each(["starting", "failed"] as const)("a fresh controller retains the role-memory deadline for a %s receipt", async state => {
  const f = await fixture(`restart-${state}`);
  if (state === "failed") {
    const entry = f.stage();
    f.registry.failSpawn(f.launches[0]!, new RoleMemoryChanged().message);
    f.registry.upsert({ ...entry, structuredTerminationSurvivors: [{ pid: process.pid, startIdentity: null }] });
    expect(f.production.spawnReceipt(f.launches[0]!)?.roleMemoryRetrySafe).toBe(false);
  }
  const wait = f.attempt().roleMemoryDispatchWait!;
  expect(wait).toBeDefined();
  expect(await childTick(f, new Date(Date.parse(wait.deadline) - 1).toISOString())).toMatchObject({ state: "running", wait, spawns: 0 });
  const parked = await childTick(f, wait.deadline);
  expect(parked).toMatchObject({ state: "needs_decision", wait, spawns: 0 });
  expect(parked.detail).toContain(`receipt ${state}`);
  expect(parked.detail).toContain(wait.deadline);
});

test.each(["foreign-claim", "changed-generation"] as const)("a persisted role-memory delivery cannot excuse %s", async mode => {
  const f = await fixture(`delivery-${mode}`);
  const entry = f.stage();
  f.registry.failSpawn(f.launches[0]!, new RoleMemoryChanged().message);
  fs.appendFileSync(entry.artifactPath, JSON.stringify({ type: "event_msg", timestamp: f.h.ports.now(),
    payload: { type: "task_started" } }) + "\n");
  f.h.ports.originalLaunchOperations = async () => "matched";
  f.h.ports.conversationAgentActive = async () => true;
  await tickPipelines([], f.h.ports);
  expect(f.attempt().state).toBe("running");
  const delivery = f.attempt().roleMemoryDelivery!;
  expect(delivery).toEqual({ launchId: f.launches[0], conversationId: f.attempt().conversationId!,
    "transcript": entry.artifactPath, retryClaimId: null });
  const { savePipelines } = await import("./store");
  const lane = loadPipelines()[0]!;
  for (const invalid of [null, [], {}, { ...delivery, launchId: "" }, { ...delivery, retryClaimId: "" }]) {
    lane.runs[0]!.attempts[0]!.roleMemoryDelivery = invalid as never;
    expect(() => savePipelines([lane])).toThrow("malformed pipeline record");
    expect(f.attempt().roleMemoryDelivery).toEqual(delivery);
  }
  if (mode === "foreign-claim") expect(f.registry.claimFailedSpawnForRetry(f.launches[0]!, "foreign-recovery").kind).toBe("claimed");
  else f.registry.upsert({ ...entry, artifactPath: `${entry.artifactPath}.another-generation` });
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(f.attempt().launchId).toBe(f.launches[0]);
  expect(f.replacements).toHaveLength(0);
});

for (const engine of ["codex", "claude"] as const) test.each([false, true])(
  `${engine} keeps an adopted delivery through committed succession (foreign claim=%s)`, async foreignClaim => {
  const f = await fixture(`${engine}-committed-${foreignClaim}`, undefined, engine);
  const entry = f.stage("unhosted", f.launches[0]!, "absent", undefined, true, crypto.randomUUID());
  const conversationId = f.registry.spawnReceipt(f.launches[0]!)!.conversationId;
  expect(f.registry.conversation(conversationId)!.generations.at(-1)!.id).not.toBe(entry.key.sessionId);
  f.registry.failSpawn(f.launches[0]!, new RoleMemoryChanged().message);
  nativeStart(engine, entry.artifactPath, f.h.ports.now());
  f.h.ports.originalLaunchOperations = async () => "matched";
  f.h.ports.conversationAgentActive = async () => true;
  f.h.ports.pathForConversation = id => defaultPipelinePorts().pathForConversation(id);
  f.h.ports.spawnAgent = f.normalSpawn;
  await tickPipelines([], f.h.ports);
  expect(f.attempt().state).toBe("running");
  const successorId = crypto.randomUUID();
  const successor = { id: successorId, path: path.join(path.dirname(entry.artifactPath), `${successorId}.jsonl`), accountId: "account-b" };
  nativeStart(engine, successor.path, f.h.ports.now());
  f.registry.setConversationMigration(conversationId, { intentId: `${engine}-move`, phase: "verifying", targetId: "account-b",
    revision: 1, error: null, updatedAt: f.h.ports.now() });
  f.registry.recordConversationContinuityPath(conversationId, successor.path);
  const operationId = f.registry.conversation(conversationId)!.migration!.operationId;
  const receipt = { operationId, nativeId: successor.id, path: successor.path, continuityPaths: [], historyHash: "fixture-history",
    host: { kind: engine === "codex" ? "codex-app-server" as const : "claude-stream" as const,
      identity: successor.id, epoch: 1, verifiedAt: f.h.ports.now() } };
  f.registry.transitionConversationMigration(conversationId, 1, ["verifying"], { providerReceipt: receipt });
  f.registry.commitSuccessor(conversationId, successor, 1, operationId, receipt);
  if (foreignClaim) expect(f.registry.claimFailedSpawnForRetry(f.launches[0]!, "foreign-recovery").kind).toBe("claimed");
  for (let i = 0; i < 3; i++) { f.h.advanceWallClock(1_000); await tickPipelines([], f.h.ports); }
  expect(loadPipelines()[0]!.state).toBe(foreignClaim ? "needs_decision" : "running");
  expect(f.replacements).toHaveLength(0);
  expect(await childTick(f, f.h.ports.now(), successor.path)).toMatchObject({
    state: foreignClaim ? "needs_decision" : "running", launchId: f.launches[0], spawns: 0,
  });
  if (!foreignClaim) {
    const { reportStageCompletion } = await import("./engine");
    const result = await reportStageCompletion({ verdict: "pass", findings: [], summary: "Original completed" },
      { kind: "agent", role: "builder", conversationId }, f.h.ports);
    expect(result.error).toBeUndefined();
    expect(f.attempt().report?.verdict.status).toBe("pass");
    f.h.ports.conversationAgentActive = async () => false;
    await tickPipelines([], f.h.ports);
    expect(f.attempt().verdict?.status).toBe("pass");
    expect(f.replacements).toHaveLength(0);
  }
});

test("a fresh controller finishes a claimed role-memory retirement and launches one replacement", async () => {
  const f = await fixture("claimed-restart");
  const entry = f.stage();
  f.registry.failSpawn(f.launches[0]!, new RoleMemoryChanged().message);
  const claimId = `${loadPipelines()[0]!.id}:plan:${f.launches[0]}`;
  expect(await f.production.claimSpawnRetry(f.launches[0]!, claimId)).toBe("claimed");
  const recovered = await childTick(f, f.h.ports.now(), entry.artifactPath);
  expect(recovered).toMatchObject({ state: "running", launchId: null, spawns: 0 });
  expect(recovered.retiredLaunches.map((row: { launchId: string }) => row.launchId)).toEqual(f.launches);
  f.h.ports.spawnAgent = f.normalSpawn;
  for (let i = 0; i < 6; i++) { f.h.advanceWallClock(1_000); await tickPipelines([], f.h.ports); }
  expect(f.attempt().state).toBe("running");
  expect(f.replacements).toHaveLength(1);
  expect(f.attempt().retiredLaunches?.map(row => row.launchId)).toEqual(f.launches);
});

test("a fresh controller adopts a delivered original after its own retry claim", async () => {
  const f = await fixture("claimed-restart-delivered");
  const entry = f.stage();
  f.registry.failSpawn(f.launches[0]!, new RoleMemoryChanged().message);
  const claimId = `${loadPipelines()[0]!.id}:plan:${f.launches[0]}`;
  expect(await f.production.claimSpawnRetry(f.launches[0]!, claimId)).toBe("claimed");
  expect(f.production.spawnReceipt(f.launches[0]!)).toMatchObject({
    generationMatches: true, currentGeneration: false, retryClaimId: claimId,
  });
  f.h.ports.durableTurnEvidence = (await import("./durableEvidence")).durableStageTurnEvidence;
  fs.appendFileSync(entry.artifactPath, JSON.stringify({ type: "event_msg", timestamp: f.h.ports.now(),
    payload: { type: "user_message", message: "Build safely" } }) + "\n");
  expect(await f.h.ports.durableTurnEvidence("codex", entry.artifactPath)).toMatchObject({ launchOnly: false, turn: "busy" });

  const recovered = await childTick(f, f.h.ports.now(), entry.artifactPath);

  expect(recovered).toMatchObject({ state: "running", launchId: f.launches[0], agentPath: entry.artifactPath, spawns: 0 });
  expect(recovered.retiredLaunches).toBeUndefined();
  expect(f.registry.spawnReceipt(f.launches[0]!)?.retryClaim?.claimId).toBe(claimId);
  expect(f.launches).toHaveLength(1);
});

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
