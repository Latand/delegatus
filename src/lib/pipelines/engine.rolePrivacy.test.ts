import "./engineEnvironment.fixture";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { create, harness, tickPipelines, loadPipelines, savePipelines, defaultPipelinePorts, AgentRegistry, setAgentRegistryForTests, accountManager } from "./engine.fixture";
import { ROLE_MEMORY_CHANGED_MESSAGE, roleMemoryCollection, roleMemoryRevisionToken } from "@/lib/memory/roleStore";
import { TaskPageWorker, shutdownTaskPageWorker } from "@/lib/links/taskPageWorker";
import { sharedLinkState } from "@/lib/links/runtimeState";
import { RuntimeJournal } from "@/runtime-host/journal";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import { StructuredDeliveryQueue } from "@/lib/runtime/structuredDeliveryQueue";
import type { QueueEntry } from "@/lib/runtime/engineHost";
import type { SpawnedStructuredHost } from "@/lib/runtime/structuredSpawn";
import type { RuntimeSendCommand } from "@/lib/runtime/contracts";
import { resolveSendReceipt } from "@/lib/runtime/sendSettlement";

const oldRule = "Preserve fixtureword receipts until the owning operation completes";
const newRule = "Verify silver orchard evidence before the operation completes";
function write(rule: string) {
  roleMemoryCollection(true)!.boundedPatch(1, tx => tx.put({
    kind: "rule", id: "r_launch_race", scope: "machine", rule, why: "", state: "active", hints: [],
    source: { project: "fixture", pipelineId: "fixture", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "conversation_fixture" },
    createdAt: "2026-10-14T00:00:00Z", changedAt: "2026-10-14T00:00:00Z",
  }));
}
afterEach(shutdownTaskPageWorker);

test.each(["before-dispatch", "before-handoff", "after-handoff"] as const)(
  "an immutable stale first-message effect preserves execution evidence: %s", async timing => {
  if (process.env.LLV_PRIVACY_TEST_CASE !== timing) {
    // Registry and membership caches are process-wide. Each production launch
    // scenario starts with its own handles, including when run by itself.
    const directory = fs.mkdtempSync(path.join(process.env.TMPDIR!, "privacy-launch-case-"));
    try {
      const child = Bun.spawn([process.execPath, "test", "--timeout=60000", import.meta.path,
        "-t", `^an immutable stale first-message effect preserves execution evidence: ${timing}$`], {
        env: { ...process.env, LLV_STATE_DIR: directory, LLV_PRIVACY_TEST_CASE: timing },
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, output + errors).toBe(0);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    return;
  }
  setSystemTime(new Date("2026-10-29T00:00:00Z"));
  savePipelines([]);
  write(oldRule);
  let nextId = 100 + ["before-dispatch", "before-handoff", "after-handoff"].indexOf(timing) * 1000;
  const ids = spyOn(crypto, "randomUUID").mockImplementation(() => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`);
  const root = path.join(process.env.LLV_STATE_DIR!, `persisted-privacy-launch-${timing}`);
  fs.mkdirSync(root, { recursive: true });
  const registry = new AgentRegistry(path.join(root, "registry.json"));
  setAgentRegistryForTests(registry);
  const journalFile = path.join(root, "runtime.sqlite");
  let journal = new RuntimeJournal(journalFile, { structuredHosts: true });
  const clientModule = await import("@/lib/runtime/client");
  const spawnModule = await import("@/lib/runtime/structuredSpawn");
  const guardModule = await import("@/lib/git/stageAttemptGuard");
  const realSpawn = spawnModule.spawnStructuredConversation;
  const sent: QueueEntry[] = [];
  const launches: string[] = [];
  const hosts = new Map<string, SpawnedStructuredHost>();
  let changed = false;
  let originalEffect: string | undefined;
  let originalCommand: RuntimeSendCommand | undefined;
  let held = false;
  const drain = async (holdAfterFence = false) => {
    const queue = new StructuredDeliveryQueue({
      handoffHeld: () => held,
      effects: async (kinds, after) => journal.effectBatch(100, kinds, after),
      status: async id => journal.operationResult(id)?.receipt ?? null,
      hostClaim: async () => "privacy-fixture-owner",
      transition: async (id, status, details, options) => {
        journal.transitionOperation(id, status, details, options);
        if (holdAfterFence && status === "delivering") held = true;
      },
    }, id => hosts.get(id) ?? null);
    await queue.drain();
  };
  const client = {
    readSession: async identity => journal.readSession(identity),
    snapshot: async () => journal.snapshot(),
    append: async event => journal.append(event),
    operation: async event => journal.append(event),
    operationStatus: async id => journal.operationResult(id),
    transitionOperation: async (id, status, details, options) => journal.transitionOperation(id, status, details, options),
    effectBatch: async (kinds, after) => journal.effectBatch(100, kinds, after),
    command: async command => {
      const result = journal.executeOperation(command);
      if (command.kind !== "send") return result;
      if (!changed) {
        changed = true;
        const effect = journal.effectBatch(100, ["runtime.send"])[0]!;
        originalEffect = JSON.stringify(effect);
        originalCommand = structuredClone(command);
        if (timing === "before-handoff") {
          await drain(true);
          expect(journal.operationResult(result.operationId)?.receipt).toMatchObject({ status: "queued", reason: "automatic-update-handoff" });
          expect(sent).toHaveLength(0);
          originalEffect = JSON.stringify(journal.effectBatch(100, ["runtime.send"])[0]!);
          held = false;
        }
        if (timing === "after-handoff") {
          // The host accepts the key once, but cannot confirm it. The next
          // drain acquires delivery before the update hold becomes visible.
          await drain();
          expect(journal.operationResult(result.operationId)?.receipt).toMatchObject({ status: "queued", reason: "delivery-auto-retry" });
          expect(sent).toHaveLength(1);
          await drain(true);
          expect(journal.operationResult(result.operationId)?.receipt).toMatchObject({ status: "queued", reason: "automatic-update-handoff" });
          const retained = journal.effectBatch(100, ["runtime.send"])[0]!;
          expect(retained.payload.text).toBe(command.text);
          expect(retained.payload.roleMemoryRevision).toBe(command.roleMemoryRevision);
          originalEffect = JSON.stringify(retained);
          held = false;
        }
        write(newRule);
        // A new consumer process gets only the unchanged, admitted payload.
        journal.close();
        const consumer = Bun.spawn([process.execPath, "-e", `
          import crypto from "node:crypto";
          import { RuntimeJournal } from "./src/runtime-host/journal";
          import { StructuredDeliveryQueue } from "./src/lib/runtime/structuredDeliveryQueue";
          const journal = new RuntimeJournal(process.env.LLV_PRIVACY_TEST_JOURNAL, { structuredHosts: true });
          const effects = journal.effectBatch(100, ["runtime.send"]);
          const digest = crypto.createHash("sha256").update(JSON.stringify(effects[0])).digest("hex");
          if (digest !== process.env.LLV_PRIVACY_TEST_EFFECT) throw new Error("persisted effect changed");
          let sends = 0;
          const queue = new StructuredDeliveryQueue({
            effects: async (kinds, after) => journal.effectBatch(100, kinds, after),
            status: async id => journal.operationResult(id)?.receipt ?? null,
            hostClaim: async () => "privacy-fixture-owner",
            transition: async (id, status, details, options) => { journal.transitionOperation(id, status, details, options); },
          }, () => ({
            supportsSteer: false,
            health: async () => ({ status: "idle", sessionKey: "privacy-consumer", endpoint: "fixture", pid: process.pid,
              processStartIdentity: "privacy-fixture", eventCursor: 0, protocolVersion: "fixture", activeTurnRef: null,
              pendingAttention: [], activeFlags: [], account: null }),
            send: async (_entry, _proof, authorize) => { authorize?.(); sends++; return { outcome: "turn-started", turnId: "forbidden-turn" }; },
          }));
          await queue.drain();
          await queue.drain();
          console.log(JSON.stringify({ sends, receipt: journal.operationResult(effects[0].payload.operationId).receipt }));
          journal.close();
        `], { cwd: process.cwd(), env: { ...process.env, LLV_PRIVACY_TEST_JOURNAL: journalFile,
          LLV_PRIVACY_TEST_EFFECT: crypto.createHash("sha256").update(originalEffect).digest("hex") },
          stdin: "ignore", stdout: "pipe", stderr: "pipe" });
        const [code, output, errors] = await Promise.all([consumer.exited, new Response(consumer.stdout).text(), new Response(consumer.stderr).text()]);
        journal = new RuntimeJournal(journalFile, { structuredHosts: true });
        expect(code, errors).toBe(0);
        const observed = JSON.parse(output);
        expect(observed.sends).toBe(0);
        expect(observed.receipt.status).toBe(timing === "after-handoff" ? "uncertain" : "failed");
        if (timing !== "after-handoff") expect(observed.receipt.reason).toBe(ROLE_MEMORY_CHANGED_MESSAGE);
      }
      await drain();
      if (result.operationId === `spawn_message_${launches[0]}`) {
        expect(journal.operationResult(result.operationId)?.receipt.status).toBe(timing === "after-handoff" ? "uncertain" : "failed");
      }
      // The admission ACK retains the receipt produced by that transaction;
      // dispatch settlement is observed through the subsequent status read.
      return result;
    },
  } as RuntimeHostClient;
  const runtime = spyOn(clientModule, "runtimeHostClient").mockReturnValue(client);
  const resolve = spyOn(accountManager, "resolveProjectSpawn").mockReturnValue({ kind: "available", account: {
    engine: "codex", accountId: "fixture-account", kind: "managed", home: root, transcriptRoot: root, env: { NODE_ENV: "test" },
  }});
  const guard = spyOn(guardModule, "prepareStageGitGuard").mockResolvedValue({});
  const spawn = spyOn(spawnModule, "spawnStructuredConversation").mockImplementation(async input => {
    launches.push(input.receipt.launchId);
    const sessionId = ["00000000", "0000", "4000", "8000", String(launches.length).padStart(12, "0")].join("-");
    const artifact = path.join(root, `${sessionId}.jsonl`);
    let dead = false;
    const host: SpawnedStructuredHost = {
      identity: { threadId: sessionId, path: artifact },
      supportsSteer: false,
      health: async () => ({ status: dead ? "dead" : "idle", sessionKey: sessionId, endpoint: "fixture", pid: process.pid,
        processStartIdentity: "privacy-fixture", eventCursor: 0, protocolVersion: "fixture", activeTurnRef: null,
        pendingAttention: [], activeFlags: [], account: null }),
      onStateChange: () => () => {},
      attach: () => ({ async *[Symbol.asyncIterator]() {} }),
      interrupt: async () => {}, answer: async () => {}, release: async () => { dead = true; },
      send: async (entry, _proof, authorize) => {
        authorize?.();
        if (!sent.some(previous => previous.id === entry.id)) sent.push(entry);
        fs.writeFileSync(artifact, JSON.stringify({ type: "session_meta", payload: { id: sessionId } }) + "\n"
          + JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: entry.text } }) + "\n");
        if (timing === "after-handoff") throw new Error("request timed out: thread/read");
        return { outcome: "turn-started", turnId: "privacy-current-turn" };
      },
    };
    hosts.set(input.receipt.conversationId, host);
    return await realSpawn(input, {
      startHost: async () => {
        fs.writeFileSync(artifact, JSON.stringify({ type: "session_meta", payload: { id: sessionId } }) + "\n");
        return host;
      },
      bindHost: async (target, key, _host, owner, epoch) => {
        target.setStructuredHostClaimed(key, { kind: "codex-app-server", endpoint: "fixture",
          process: { pid: process.pid, startIdentity: "privacy-fixture" }, eventCursor: 0, protocolVersion: "fixture",
          writerClaimEpoch: epoch, activeTurnRef: null, pendingAttention: [], activeFlags: [] }, "idle", owner, epoch);
        journal.append({ scope: { type: "session", id: input.receipt.conversationId }, kind: "session-status", payload: {
          conversationId: input.receipt.conversationId, sessionKey: key, artifactPath: artifact, cwd: input.spec.cwd,
          hostKind: "codex-app-server", host: "hosted", turn: "idle", activeTurnId: null, provenance: "structured",
        } });
        return () => {};
      },
      publishHost: async () => async () => {},
      processIdentity: () => ({ pid: process.pid, startIdentity: "privacy-fixture" }),
    });
  });
  try {
    const h = harness();
    const defaults = defaultPipelinePorts();
    h.ports.spawnAgent = defaults.spawnAgent;
    h.ports.spawnReceipt = defaults.spawnReceipt;
    h.ports.claimSpawnRetry = defaults.claimSpawnRetry;
    await create(h.ports, [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build safely", next: null }] as never, { repoDir: root });
    await tickPipelines([], h.ports);
    fs.mkdirSync(loadPipelines()[0]!.worktreeDir!, { recursive: true });
    await tickPipelines([], h.ports);
    expect(changed).toBe(true);
    expect(sent).toHaveLength(timing === "after-handoff" ? 1 : 0);
    expect(launches).toHaveLength(1);
    const originalId = `spawn_message_${launches[0]}`;
    if (timing === "after-handoff") {
      expect(journal.operationResult(originalId)?.receipt.status).toBe("uncertain");
      expect(defaults.spawnReceipt(launches[0]!)?.roleMemoryRetrySafe).not.toBe(true);
      journal.close();
      journal = new RuntimeJournal(journalFile, { structuredHosts: true });
      expect(journal.executeOperation(originalCommand!).receipt.status).toBe("uncertain");
      const receipt = await resolveSendReceipt(originalId, { registry, client });
      expect(receipt).toMatchObject({ resend: "verify-first", duplicateRisk: true });
      for (let pass = 0; pass < 3; pass++) {
        await drain();
        h.advanceWallClock(60_000);
        await tickPipelines([], h.ports);
      }
      expect(launches).toHaveLength(1);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.text).toBe(originalCommand!.text);
      expect(originalCommand!.roleMemoryRevision).not.toBe(roleMemoryRevisionToken());
      return;
    }
    expect(journal.operationResult(originalId)?.receipt).toMatchObject({ status: "failed", reason: ROLE_MEMORY_CHANGED_MESSAGE });
    expect(defaults.spawnReceipt(launches[0]!)).toMatchObject({ state: "failed", roleMemoryRetrySafe: true });
    // A fresh reader cannot revive the fenced effect or reset a retry counter.
    journal.close();
    journal = new RuntimeJournal(journalFile, { structuredHosts: true });
    expect(journal.executeOperation(originalCommand!).receipt).toMatchObject({ operationId: originalId, status: "failed" });
    await drain();
    expect(sent).toHaveLength(0);
    h.advanceWallClock(60_000);
    await tickPipelines([], h.ports);
    h.advanceWallClock(60_000);
    await tickPipelines([], h.ports);
    h.advanceWallClock(60_000);
    await tickPipelines([], h.ports);
    expect(launches).toHaveLength(2);
    expect(sent.map(entry => entry.id)).toEqual([`spawn_message_${launches[1]}`]);
    const successor = registry.readOnlySnapshot().receipts[launches[1]!]!;
    expect(successor.state).toBe("completed");
    expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)!.retiredLaunches?.map(launch => launch.launchId)).toEqual([launches[0]!]);
    expect(journal.operationResult(originalId)?.receipt).toMatchObject({ status: "failed", reason: ROLE_MEMORY_CHANGED_MESSAGE });
    await drain();
    expect(sent).toHaveLength(1);
    expect(roleMemoryRevisionToken()).not.toBe(JSON.parse(originalEffect!).payload.roleMemoryRevision);
  } finally {
    spawn.mockRestore(); guard.mockRestore(); resolve.mockRestore(); runtime.mockRestore();
    ids.mockRestore();
    setSystemTime();
    setAgentRegistryForTests(null);
    journal.close();
  }
}, 30_000);

test.each([
  { boundary: "composition", fileBacked: false }, { boundary: "worker", fileBacked: false },
  { boundary: "composition", fileBacked: true }, { boundary: "worker", fileBacked: true },
] as const)("launch re-reads a role-memory write during $boundary (file-backed=$fileBacked)", async ({ boundary, fileBacked }) => {
  savePipelines([]);
  write(oldRule);
  const h = harness();
  let changed = false;
  const change = () => { if (!changed) { changed = true; write(newRule); } };
  if (boundary === "composition") {
    const exec = h.ports.exec;
    h.ports.exec = async (...args) => {
      if (args[1][0] === "rev-parse" && args[1][1] === "--show-toplevel") { change(); return { code: 1, stdout: "", stderr: "plain fixture directory" }; }
      return await exec(...args);
    };
  } else {
    const pool = sharedLinkState("taskPages.worker", () => ({ directory: "", worker: null as TaskPageWorker | null }));
    pool.directory = process.env.LLV_STATE_DIR!;
    pool.worker = new TaskPageWorker({ onPhase: change });
  }
  await create(h.ports, [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: `Build. ${oldRule}. ${newRule}`, next: null }] as never, { repoDir: path.join(process.env.LLV_STATE_DIR!, "repo") });
  if (fileBacked) {
    const lane = loadPipelines()[0]!;
    lane.spec = `${oldRule}. ${newRule}. ` + "Context ".repeat(5_000);
    savePipelines([lane]);
  }
  await tickPipelines([], h.ports);
  const prepared = loadPipelines()[0]!;
  fs.mkdirSync(prepared.worktreeDir!, { recursive: true });
  await tickPipelines([], h.ports);
  const pipeline = loadPipelines()[0]!;
  expect(changed).toBe(true);
  expect(pipeline.stateDetail).toBeNull();
  expect(pipeline.state).toBe("running");
  expect(h.spawnInputs).toHaveLength(1);
  const sent = h.spawnInputs[0]!.prompt;
  const artifact = sent.match(/Full (?:stage prompt|specification) file: (.+)\n/)?.[1];
  expect(Boolean(artifact)).toBe(fileBacked);
  const full = artifact ? fs.readFileSync(artifact, "utf8") : sent;
  expect(full).not.toContain(newRule);
  expect(full).toContain(oldRule);
  expect(full).toContain("[learned rule]");
}, 30_000);


test.each(["reclassify", "file-reclassify", "churn", "corrupt", "pause"] as const)("admission rechecks privacy and activation before dispatch: %s", async mode => {
  savePipelines([]);
  write(oldRule);
  const h = harness();
  let preparePrompt: (() => Promise<string>) | undefined;
  const recordSpawn = h.ports.spawnAgent;
  h.ports.spawnAgent = (input, reserved, prepare) => {
    preparePrompt = prepare;
    return recordSpawn(input, reserved);
  };
  await create(h.ports, [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: `Build. ${newRule}`, next: null }] as never, { repoDir: path.join(process.env.LLV_STATE_DIR!, "admission-repo") });
  if (mode === "file-reclassify") {
    const lane = loadPipelines()[0]!;
    lane.spec = `${newRule}. ` + "Context ".repeat(5_000);
    savePipelines([lane]);
  }
  await tickPipelines([], h.ports);
  fs.mkdirSync(loadPipelines()[0]!.worktreeDir!, { recursive: true });
  await tickPipelines([], h.ports);
  const input = h.spawnInputs[0]!;
  expect(input.prompt).toContain(newRule);
  input.cwd = path.join(process.env.LLV_STATE_DIR!, `dispatch-cwd-${mode}`);
  fs.mkdirSync(input.cwd);
  const binary = path.join(process.env.LLV_STATE_DIR!, "codex-fixture");
  fs.writeFileSync(binary, "#!/bin/sh\nprintf '[]\\n'\n", { mode: 0o700 });
  const priorBinary = process.env.LLV_CODEX_BINARY;
  process.env.LLV_CODEX_BINARY = binary;
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, `dispatch-registry-${mode}.json`));
  setAgentRegistryForTests(registry);
  const clientModule = await import("@/lib/runtime/client");
  const spawnModule = await import("@/lib/runtime/structuredSpawn");
  const guardModule = await import("@/lib/git/stageAttemptGuard");
  const resolve = spyOn(accountManager, "resolveProjectSpawn").mockReturnValue({ kind: "available", account: {
    engine: "codex", accountId: "fixture-account", kind: "managed", home: process.env.LLV_STATE_DIR!,
    transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" },
  }});
  const client = spyOn(clientModule, "runtimeHostClient").mockReturnValue({} as never);
  const guard = spyOn(guardModule, "prepareStageGitGuard").mockResolvedValue({});
  const sent: string[] = [];
  const spawn = spyOn(spawnModule, "spawnStructuredConversation").mockImplementation(async input => {
    sent.push(input.prompt);
    return { path: null } as never;
  });
  let reservations = 0;
  try {
    const launch = defaultPipelinePorts().spawnAgent(input, () => {
      ++reservations;
      if (reservations < 2) return;
      if (mode === "pause") throw new Error("activation superseded in fixture");
      if (mode === "churn") write(`${newRule} revision ${reservations}`);
      if ((mode === "reclassify" || mode === "file-reclassify") && reservations === 2) write(newRule);
      if (mode === "corrupt") {
        roleMemoryCollection(true)!.boundedPatch(1, tx => tx.put({ kind: "rule", id: 7, rule: newRule } as never));
      }
    }, preparePrompt);
    if (mode === "reclassify" || mode === "file-reclassify") {
      await launch;
      expect(reservations).toBe(3);
      expect(sent).toHaveLength(1);
      expect(sent[0]).not.toContain(newRule);
      expect(sent[0]).toContain("[learned rule]");
      if (mode === "file-reclassify") {
        const file = sent[0]!.match(/Full (?:stage prompt|specification) file: (.+)\n/)?.[1];
        expect(file).toBeDefined();
        expect(fs.readFileSync(file!, "utf8").includes(newRule)).toBe(false);
      }
    } else {
      await expect(launch).rejects.toThrow(mode === "churn" ? "retrying before dispatch" : mode === "pause" ? "activation superseded" : "role memory could not be read");
      expect(sent).toHaveLength(0);
      expect(reservations).toBe(mode === "churn" ? 4 : 2);
      if (mode === "churn") {
        // Exercise the controller's retirement of its own failed reservation.
        const pending = harness();
        const defaults = defaultPipelinePorts();
        let changing = true;
        let changes = 0;
        pending.ports.spawnReceipt = defaults.spawnReceipt;
        pending.ports.claimSpawnRetry = defaults.claimSpawnRetry;
        pending.ports.spawnAgent = (request, onReserved) => defaults.spawnAgent({ ...request, cwd: input.cwd }, async reservation => {
          await onReserved(reservation);
          if (changing) write(`${newRule} controller revision ${++changes}`);
        });
        await create(pending.ports, [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build safely", next: null }] as never);
        await tickPipelines([], pending.ports);
        await tickPipelines([], pending.ports);
        const deferred = loadPipelines()[0]!;
        expect(deferred.state).toBe("needs_decision");
        expect(deferred.stateDetail).toContain("original host termination is unconfirmed");
        expect(deferred.runs[0]!.attempts.at(-1)?.retiredLaunches ?? []).toHaveLength(0);
        expect(sent).toHaveLength(0);
        changing = false;
      }
    }
  } finally {
    resolve.mockRestore(); client.mockRestore(); guard.mockRestore(); spawn.mockRestore(); setAgentRegistryForTests(null);
    if (priorBinary === undefined) delete process.env.LLV_CODEX_BINARY;
    else process.env.LLV_CODEX_BINARY = priorBinary;
    if (mode === "corrupt") roleMemoryCollection(true)!.boundedPatch(1, tx => tx.delete("r:7"));
  }
}, 30_000);

test.each([false, true] as const)("the real structured spawn refreshes role memory after runtime admission (file-backed=%s)", async fileBacked => {
  savePipelines([]);
  write(oldRule);
  const h = harness();
  let preparePrompt: (() => Promise<string>) | undefined;
  const fixtureSpawn = h.ports.spawnAgent;
  h.ports.spawnAgent = (request, reserved, prepare) => {
    preparePrompt = prepare;
    return fixtureSpawn(request, reserved, prepare);
  };
  await create(h.ports, [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: `Build. ${newRule}`, next: null }] as never,
    { repoDir: path.join(process.env.LLV_STATE_DIR!, "late-dispatch-repo") });
  if (fileBacked) {
    const lane = loadPipelines()[0]!;
    lane.spec = `${newRule}. ` + "Context ".repeat(5_000);
    savePipelines([lane]);
  }
  await tickPipelines([], h.ports);
  fs.mkdirSync(loadPipelines()[0]!.worktreeDir!, { recursive: true });
  await tickPipelines([], h.ports);
  const input = h.spawnInputs[0]!;
  input.cwd = path.join(process.env.LLV_STATE_DIR!, `late-dispatch-cwd-${fileBacked}`);
  fs.mkdirSync(input.cwd, { recursive: true });
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, `late-dispatch-registry-${fileBacked}.json`));
  setAgentRegistryForTests(registry);
  const clientModule = await import("@/lib/runtime/client");
  const spawnModule = await import("@/lib/runtime/structuredSpawn");
  const guardModule = await import("@/lib/git/stageAttemptGuard");
  const realSpawn = spawnModule.spawnStructuredConversation;
  const fixtureThreadId = ["00000000", "0000", "4000", "8000", "000000000001"].join("-");
  const resolve = spyOn(accountManager, "resolveProjectSpawn").mockReturnValue({ kind: "available", account: {
    engine: "codex", accountId: "fixture-account", kind: "managed", home: process.env.LLV_STATE_DIR!,
    transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" },
  }});
  const runtime = spyOn(clientModule, "runtimeHostClient").mockReturnValue({
    command: async () => { write(newRule); return undefined; },
    transitionOperation: async () => undefined,
  } as never);
  const guard = spyOn(guardModule, "prepareStageGitGuard").mockResolvedValue({});
  const sent: string[] = [];
  let handedToHost = false;
  const spawn = spyOn(spawnModule, "spawnStructuredConversation").mockImplementation(async launch => await realSpawn(launch, {
    startHost: async () => ({ identity: { threadId: fixtureThreadId, path: path.join(input.cwd, "session.jsonl") },
      health: async () => ({ status: "idle", sessionKey: fixtureThreadId, endpoint: "fixture", pid: process.pid,
        processStartIdentity: "fixture", eventCursor: 0, protocolVersion: "fixture", activeTurnRef: null,
        pendingAttention: [], activeFlags: [], account: { type: "chatgpt", planType: "subscription" } }),
      onStateChange: () => () => {}, release: async () => {} } as never),
    bindHost: async () => () => {},
    publishHost: async () => async () => {},
    deliverFirst: async delivered => {
      sent.push(delivered.prompt);
      expect(delivered.prompt).not.toContain(newRule);
      write(`${newRule} changed while first delivery was held`);
      let refused = false;
      try { await delivered.authorize?.(); }
      catch (error) { refused = error instanceof Error && error.message.includes("Role-memory privacy changed"); }
      expect(refused).toBe(true);
      if (!refused) handedToHost = true;
      return "held";
    },
    processIdentity: () => ({ pid: process.pid, startIdentity: "fixture" }),
    durableSetupTimeoutMs: 2_000,
  }));
  try {
    await defaultPipelinePorts().spawnAgent(input, () => {}, preparePrompt);
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain(newRule);
    expect(sent[0]).toContain("[learned rule]");
    const file = sent[0]!.match(/Full (?:stage prompt|specification) file: (.+)\n/)?.[1];
    expect(Boolean(file)).toBe(fileBacked);
    if (file) {
      const fullPrompt = fs.readFileSync(file, "utf8");
      expect(fullPrompt).not.toContain(newRule);
      expect(fullPrompt).toContain("[learned rule]");
    }
    expect(handedToHost).toBe(false);
  } finally {
    resolve.mockRestore(); runtime.mockRestore(); guard.mockRestore(); spawn.mockRestore(); setAgentRegistryForTests(null);
  }
}, 30_000);

test("continuous memory writes defer the launch and the next stable tick sends once", async () => {
  write(oldRule);
  const h = harness();
  const root = path.join(process.env.LLV_STATE_DIR!, "churn-repo");
  await create(h.ports, [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build with current privacy", next: null }] as never, { repoDir: root });
  await tickPipelines([], h.ports);
  fs.mkdirSync(loadPipelines()[0]!.worktreeDir!, { recursive: true });
  const exec = h.ports.exec;
  let writes = 0;
  let changing = true;
  h.ports.exec = async (...args) => {
    if (args[1][0] === "rev-parse" && args[1][1] === "--show-toplevel") {
      if (changing) write(`${newRule} version ${++writes}`);
      return { code: 1, stdout: "", stderr: "plain fixture directory" };
    }
    return await exec(...args);
  };
  await tickPipelines([], h.ports);
  expect(writes).toBe(3);
  expect(loadPipelines()[0]!.state).toBe("running");
  expect(loadPipelines()[0]!.cursor?.state).toBe("pending");
  expect(h.spawnInputs).toHaveLength(0);
  expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)?.roleMemoryFailures).toBe(1);
  changing = false;
  const restartWait = loadPipelines()[0]!;
  restartWait.runs[0]!.attempts.at(-1)!.roleMemoryWait!.retryAfter = "2099-01-01T00:00:00.000Z";
  savePipelines([restartWait]);
  const releaseControllerCustody = () => {
    const current = loadPipelines()[0]!;
    const attempt = current.runs[0]!.attempts.at(-1)!;
    if (attempt.activation) delete attempt.activation.owner;
    savePipelines([current]);
  };
  releaseControllerCustody();
  const resumed = spawnSync(process.execPath, ["test", import.meta.path, "-t", "resume deferred privacy"], {
    cwd: process.cwd(), encoding: "utf8", timeout: 20_000,
    env: { ...process.env, LLV_ROLE_PRIVACY_RESUME_STATE: process.env.LLV_STATE_DIR,
      LLV_ROLE_PRIVACY_CHURN: "1" },
  });
  expect(resumed.status, resumed.stderr).toBe(0);
  expect(resumed.stderr).toContain("1 pass");
  expect(loadPipelines()[0]!.cursor?.state).toBe("pending");
  expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)?.roleMemoryWait?.observations).toBe(0);
  expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)?.roleMemoryFailures).toBe(1);
  const retryAfter = loadPipelines()[0]!.runs[0]!.attempts.at(-1)!.roleMemoryWait!.retryAfter;
  write(`${newRule} changed between controller restarts`);
  releaseControllerCustody();
  const changedResume = spawnSync(process.execPath, ["test", import.meta.path, "-t", "resume deferred privacy"], {
    cwd: process.cwd(), encoding: "utf8", timeout: 20_000,
    env: { ...process.env, LLV_ROLE_PRIVACY_RESUME_STATE: process.env.LLV_STATE_DIR },
  });
  expect(changedResume.status, changedResume.stderr).toBe(0);
  expect(changedResume.stderr).toContain("1 pass");
  expect(loadPipelines()[0]!.cursor?.state).toBe("pending");
  expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)?.roleMemoryWait?.observations).toBe(0);
  expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)?.roleMemoryFailures).toBe(1);
  expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)?.roleMemoryWait?.retryAfter).toBe(retryAfter);
  const waiting = loadPipelines()[0]!;
  waiting.runs[0]!.attempts.at(-1)!.roleMemoryWait!.observations = "1" as never;
  waiting.runs[0]!.attempts.at(-1)!.roleMemoryWait!.retryAfter = "1970-01-01T00:00:00.000Z";
  savePipelines([waiting]);
  releaseControllerCustody();
  const malformedResume = spawnSync(process.execPath, ["test", import.meta.path, "-t", "resume deferred privacy"], {
    cwd: process.cwd(), encoding: "utf8", timeout: 20_000,
    env: { ...process.env, LLV_ROLE_PRIVACY_RESUME_STATE: process.env.LLV_STATE_DIR },
  });
  expect(malformedResume.status, malformedResume.stderr).toBe(0);
  expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)?.roleMemoryWait?.observations).toBe(0);
  const churnWait = loadPipelines()[0]!;
  churnWait.runs[0]!.attempts.at(-1)!.roleMemoryWait!.observations = 1;
  churnWait.runs[0]!.attempts.at(-1)!.roleMemoryWait!.retryAfter = "1970-01-01T00:00:00.000Z";
  savePipelines([churnWait]);
  releaseControllerCustody();
  const churnResume = spawnSync(process.execPath, ["test", import.meta.path, "-t", "resume deferred privacy"], {
    cwd: process.cwd(), encoding: "utf8", timeout: 20_000,
    env: { ...process.env, LLV_ROLE_PRIVACY_RESUME_STATE: process.env.LLV_STATE_DIR,
      LLV_ROLE_PRIVACY_CHURN: "1", LLV_ROLE_PRIVACY_RESUME_TICKS: "4",
      LLV_ROLE_PRIVACY_NOW_MS: "1000000" },
  });
  expect(churnResume.status, churnResume.stderr).toBe(0);
  expect(churnResume.stderr).toContain("1 pass");
  const resumedRule = roleMemoryCollection(true)?.get("r:r_launch_race");
  expect(resumedRule?.kind === "rule" ? resumedRule.rule : "").toContain("resumed version");
  expect(loadPipelines()[0]!.cursor?.state).toBe("pending");
  expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)?.roleMemoryFailures).toBe(2);
  for (let cycle = 0; cycle < 3; cycle++) {
    const before = loadPipelines()[0]!;
    const beforeAttempt = before.runs[0]!.attempts.at(-1)!;
    const wait = beforeAttempt.roleMemoryWait!;
    const now = Date.parse(wait.retryAfter) + 1;
    releaseControllerCustody();
    const restarted = spawnSync(process.execPath, ["test", import.meta.path, "-t", "resume deferred privacy"], {
      cwd: process.cwd(), encoding: "utf8", timeout: 20_000,
      env: { ...process.env, LLV_ROLE_PRIVACY_RESUME_STATE: process.env.LLV_STATE_DIR,
        LLV_ROLE_PRIVACY_CHURN: "1", LLV_ROLE_PRIVACY_RESUME_TICKS: "4", LLV_ROLE_PRIVACY_NOW_MS: String(now) },
    });
    expect(restarted.status, restarted.stderr).toBe(0);
    expect(restarted.stderr).toContain("1 pass");
    const after = loadPipelines()[0]!;
    const afterAttempt = after.runs[0]!.attempts.at(-1)!;
    expect(afterAttempt.roleMemoryFailures).toBe(3 + cycle);
    expect(Date.parse(afterAttempt.roleMemoryWait!.retryAfter) - now).toBe(Math.min(30_000, 250 * 2 ** (2 + cycle)));
    expect(after.cursor?.state).toBe("pending");
  }
  changing = false;
  const stableWait = loadPipelines()[0]!;
  stableWait.runs[0]!.attempts.at(-1)!.roleMemoryWait!.observations = 0;
  stableWait.runs[0]!.attempts.at(-1)!.roleMemoryWait!.retryAfter = "1970-01-01T00:00:00.000Z";
  delete stableWait.runs[0]!.attempts.at(-1)!.roleMemoryWait!.ready;
  savePipelines([stableWait]);
  for (let pass = 0; pass < 12 && h.spawnInputs.length === 0; pass++) await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.cursor?.state).toBe("running");
  expect(h.spawnInputs).toHaveLength(1);
  expect(h.spawnInputs[0]!.prompt).not.toContain(newRule);
  expect(h.spawnInputs[0]!.learnedRules).toEqual({ project: loadPipelines()[0]!.project, roleId: "builder" });
}, 30_000);

test.skipIf(!process.env.LLV_ROLE_PRIVACY_RESUME_STATE)("resume deferred privacy after a controller process restart", async () => {
  const ownState = process.env.LLV_STATE_DIR!;
  process.env.LLV_STATE_DIR = process.env.LLV_ROLE_PRIVACY_RESUME_STATE!;
  try {
    const h = harness();
    if (process.env.LLV_ROLE_PRIVACY_NOW_MS) {
      const now = Number(process.env.LLV_ROLE_PRIVACY_NOW_MS);
      h.ports.now = () => new Date(now).toISOString();
    }
    if (process.env.LLV_ROLE_PRIVACY_CHURN === "1" || process.env.LLV_ROLE_PRIVACY_RETRY_CHURN === "1") {
      const exec = h.ports.exec;
      let writes = 0;
      h.ports.exec = async (...args) => {
        if (args[1][0] === "rev-parse" && args[1][1] === "--show-toplevel") {
          write(`${newRule} resumed version ${++writes}`);
          return { code: 1, stdout: "", stderr: "plain fixture directory" };
        }
        return await exec(...args);
      };
    }
    const current = loadPipelines()[0]!;
    expect(current.cursor?.state, JSON.stringify({ stateDetail: current.stateDetail,
      attempt: current.runs[0]!.attempts.at(-1), spawnInputs: h.spawnInputs })).toBe("pending");
    const passes = Number(process.env.LLV_ROLE_PRIVACY_RESUME_TICKS ?? "1");
    for (let pass = 0; pass < passes; pass++) await tickPipelines([], h.ports);
    const resumed = loadPipelines()[0]!;
    if (resumed.cursor?.state === "pending") {
      expect(h.spawnInputs).toHaveLength(0);
    } else {
      expect(resumed.cursor?.state, JSON.stringify({ stateDetail: resumed.stateDetail,
        attempt: resumed.runs[0]!.attempts.at(-1), spawnInputs: h.spawnInputs })).toBe("spawning");
      expect(resumed.runs[0]!.attempts.at(-1)?.activation?.phase, JSON.stringify({ stateDetail: resumed.stateDetail,
        attempt: resumed.runs[0]!.attempts.at(-1), spawnInputs: h.spawnInputs })).toBe("reserved");
    }
  } finally { process.env.LLV_STATE_DIR = ownState; }
});

test("corrupt role memory remains a visible launch refusal", async () => {
  write(oldRule);
  const { Database } = await import("bun:sqlite");
  const db = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"));
  db.query("UPDATE state_rows SET value_json = ? WHERE collection = 'role_memory' AND row_key = 'r:r_launch_race'")
    .run(JSON.stringify({ kind: "rule", id: 7, rule: oldRule }));
  db.close();
  const h = harness();
  await create(h.ports, [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build with current privacy", next: null }] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("role memory could not be read");
  expect(loadPipelines()[0]!.stateDetail).not.toContain(oldRule);
  expect(h.spawnInputs).toHaveLength(0);
}, 30_000);
