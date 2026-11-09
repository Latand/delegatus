import "./engineEnvironment.fixture";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";
import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { create, harness, tickPipelines, loadPipelines, savePipelines, defaultPipelinePorts, AgentRegistry, setAgentRegistryForTests, accountManager } from "./engine.fixture";
import { RoleMemoryChanged } from "@/lib/memory/privacy";
import { ROLE_MEMORY_PREPARATION_MESSAGE, ROLE_MEMORY_CHANGED_MESSAGE, recordLessonRequest, roleMemoryCollection, roleMemoryRevisionToken } from "@/lib/memory/roleStore";
import { TaskPageWorker, shutdownTaskPageWorker } from "@/lib/links/taskPageWorker";
import { sharedLinkState } from "@/lib/links/runtimeState";
import { RuntimeJournal } from "@/runtime-host/journal";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import { StructuredDeliveryQueue } from "@/lib/runtime/structuredDeliveryQueue";
import type { QueueEntry } from "@/lib/runtime/engineHost";
import { StructuredInitialMessageTimeoutError, type SpawnedStructuredHost } from "@/lib/runtime/structuredSpawn";
import { enqueueStructuredMessage } from "@/lib/runtime/structuredMessageDelivery";
import { runtimeHostKindForEngine, type RuntimeSendCommand } from "@/lib/runtime/contracts";
import { resolveSendReceipt } from "@/lib/runtime/sendSettlement";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { OperationLease, OperationLeaseExpiredError } from "@/lib/operationLease";
import { claudeTranscriptPath } from "@/lib/agent/transcript";
import type { PipelineStageAttempt } from "./types";

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

test.each(["preparation-codex", "preparation-claude", "preparation-lost-transition-codex", "preparation-lost-dead-codex", "preparation-lost-receipt-codex", "before-authorization", "before-authorization-claude", "staged-codex", "staged-claude", "staged-native-codex", "staged-native-claude",
  "replay-codex", "replay-claude", "replay-native-codex", "replay-native-claude",
  "before-dispatch", "before-handoff", "after-handoff", "before-handoff-unknown", "before-handoff-live", "before-handoff-settling",
  ...["exact", "suffix", "exact-native", "suffix-native"].flatMap(mode =>
    ["codex", "claude"].map(engine => `later-failure-${mode}-${engine}`)),
  ...["absent", "unreadable", "native", "live", "late-journal"].flatMap(mode =>
    ["codex", "claude"].map(engine => `before-authorization-unknown-${mode}-${engine}`)),
  ...["refused-writer", "refused-unregister", "queued", "delivering", "uncertain", "unverified", "prehost", "writer", "unregister", "release", "native", "late-native", "unreadable", "reaper", "retry-twice", "retry-uncertain", "retry-twice-native", "retry-uncertain-native", "retry-twice-late-native"].flatMap(mode =>
    ["codex", "claude"].map(engine => `unsettled-${mode}-${engine}`))] as const)(
  "an immutable stale first-message effect preserves execution evidence: %s", async scenario => {
  const preparation = scenario.startsWith("preparation-");
  const laterFailure = scenario.startsWith("later-failure-");
  const laterNative = laterFailure && scenario.includes("-native-");
  const timing = laterFailure ? scenario.includes("-exact-") ? "before-dispatch" : "before-authorization" : scenario.startsWith("before-handoff") || scenario.startsWith("replay") ? "before-handoff" : scenario;
  const engine = scenario.endsWith("claude") ? "claude" : "codex";
  const unknown = scenario.startsWith("before-authorization-unknown-");
  const unknownMode = unknown ? scenario.slice("before-authorization-unknown-".length, -(engine.length + 1)) : null;
  const unsettled = scenario.startsWith("unsettled-");
  const mode = unsettled ? scenario.slice("unsettled-".length, -(engine.length + 1)) : null;
  const manual = mode?.startsWith("retry-") === true;
  const twice = mode?.startsWith("retry-twice") === true;
  const uncertain = mode?.startsWith("retry-uncertain") === true;
  if (process.env.LLV_PRIVACY_TEST_CASE !== scenario) {
    // Registry and membership caches are process-wide. Each production launch
    // scenario starts with its own handles, including when run by itself.
    const directory = fs.mkdtempSync(path.join(process.env.TMPDIR!, "privacy-launch-case-"));
    try {
      const child = Bun.spawn([process.execPath, "test", "--timeout=60000", import.meta.path,
        "-t", `^an immutable stale first-message effect preserves execution evidence: ${scenario}$`], {
        env: { ...process.env, LLV_STATE_DIR: directory, LLV_PRIVACY_TEST_CASE: scenario },
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
  let nextId = 100 + Math.max(0, ["before-dispatch", "before-handoff", "after-handoff"].indexOf(timing)) * 1000;
  const ids = spyOn(crypto, "randomUUID").mockImplementation(() => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`);
  const root = path.join(process.env.LLV_STATE_DIR!, `privacy-${crypto.createHash("sha256").update(scenario).digest("hex").slice(0, 8)}`);
  fs.mkdirSync(root, { recursive: true });
  const homeName = engine === "codex" ? "LLV_CODEX_HOME" : "LLV_CLAUDE_HOME";
  const previousHome = process.env[homeName];
  process.env[homeName] = path.join(root, engine);
  const transcriptRoot = path.join(process.env[homeName]!, engine === "codex" ? "sessions" : "projects");
  fs.mkdirSync(transcriptRoot, { recursive: true });
  const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined,
    unsettled ? { sqliteMode: "sqlite", sqliteWriterDeadlineMs: 1_000 } : {});
  setAgentRegistryForTests(registry);
  const journalFile = path.join(root, "runtime.sqlite");
  let journal = new RuntimeJournal(journalFile, { structuredHosts: true });
  const clientModule = await import("@/lib/runtime/client");
  const spawnModule = await import("@/lib/runtime/structuredSpawn");
  const guardModule = await import("@/lib/git/stageAttemptGuard");
  const realSpawn = spawnModule.spawnStructuredConversation;
  const sent: QueueEntry[] = [];
  const sendCommands: RuntimeSendCommand[] = [];
  const launches: string[] = [];
  const hostStarts: string[] = [];
  const hosts = new Map<string, SpawnedStructuredHost>();
  let termination: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
  let activation: PipelineStageAttempt["activation"];
  let changed = false;
  let churn = 0;
  let observing = false;
  let lateNative = false;
  let refusedWrites = 0;
  let journalReadFailed = false;
  const journalMode = manual || ["refused-writer", "refused-unregister", "queued", "delivering", "uncertain", "unverified"].includes(mode!);
  const failSpawn = registry.failStructuredSpawnOffLoop.bind(registry);
  const failure = spyOn(registry, "failStructuredSpawnOffLoop").mockImplementation(async (...args) => {
    if (mode === "late-native" && observing && !lateNative) {
      lateNative = true;
      const receipt = registry.spawnReceipt(args[0])!;
      fs.writeFileSync(receipt.artifactPath!, JSON.stringify(engine === "codex"
        ? { type: "event_msg", timestamp: new Date().toISOString(), payload: { type: "task_started" } }
        : { type: "assistant", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "Working" }] } }) + "\n");
    }
    if (!unsettled || refusedWrites || args[1] !== ROLE_MEMORY_CHANGED_MESSAGE
      || !(uncertain || ["refused-writer", "queued", "delivering", "uncertain", "unverified", "prehost", "writer", "reaper", "native", "late-native", "unreadable"].includes(mode!))) {
      const result = await failSpawn(...args);
      if (scenario === "preparation-lost-receipt-codex" && result.claimed && launches.length === 1) throw new Error("fixture receipt acknowledgement lost");
      return result;
    }
    const holder = new Database(path.join(root, "registry.sqlite"));
    holder.exec("PRAGMA busy_timeout = 0"); holder.exec("BEGIN IMMEDIATE");
    try {
      const result = await failSpawn(...args);
      expect(result.claimed).toBe(false);
      refusedWrites++;
      return result;
    } finally { holder.exec("ROLLBACK"); holder.close(); }
  });
  const beginDelivery = registry.beginDeliveryAttemptOffLoop.bind(registry);
  const deliveryClaim = spyOn(registry, "beginDeliveryAttemptOffLoop").mockImplementation(async (...args) => {
    const result = await beginDelivery(...args);
    if ((scenario.startsWith("before-authorization") || laterFailure && timing === "before-authorization") && !changed && result.acquired && result.value) {
      changed = true;
      write(newRule);
    }
    return result;
  });
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
    operationStatus: async id => {
      // A retained send can outlive its compacted launch operation. Native
      // work still prevents replacement while adoption cannot be attributed.
      if (manual && mode!.endsWith("-native") && id === launches[0]) return null;
      if ((unknown || laterFailure && timing === "before-authorization") && changed && launches.length === 1
        && (!journalReadFailed || unknownMode === "unreadable" && !observing)) {
        journalReadFailed = true;
        throw new Error("fixture journal read refused");
      }
      if (mode === "unreadable" && observing) throw new Error("fixture journal read refused");
      return journal.operationResult(id);
    },
    events: async after => journal.replay(after),
    transitionOperation: async (id, status, details, options) => {
      const result = journal.transitionOperation(id, status, details, options);
      if (scenario === "preparation-lost-transition-codex" && status === "failed" && launches.length === 1) throw new Error("fixture acknowledgement lost");
      return result;
    },
    effectBatch: async (kinds, after) => journal.effectBatch(100, kinds, after),
    command: async command => {
      const result = journal.executeOperation(command);
      if (command.kind !== "send") return result;
      sendCommands.push(structuredClone(command));
      if (journalMode && launches.length === 1 && !changed) {
        expect(result.receipt.status).toBe("queued");
        changed = true;
        write(newRule);
        if (mode === "refused-writer" || mode === "refused-unregister") {
          await drain();
          expect(journal.operationResult(result.operationId)?.receipt).toMatchObject({ status: "failed", reason: ROLE_MEMORY_CHANGED_MESSAGE });
        } else if (mode !== "queued") {
          journal.transitionOperation(result.operationId, "delivering", {});
          if (mode === "uncertain" || uncertain) journal.transitionOperation(result.operationId, "uncertain", { reason: "fixture unknown delivery" });
          if (mode === "unverified") journal.transitionOperation(result.operationId, "failed", { reason: ROLE_MEMORY_CHANGED_MESSAGE, deliveryUnverified: true });
        }
        throw new RoleMemoryChanged();
      }
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
    engine, accountId: "fixture-account", kind: "managed", home: process.env[homeName]!, transcriptRoot, env: { NODE_ENV: "test" },
  }});
  const guard = spyOn(guardModule, "prepareStageGitGuard").mockResolvedValue({});
  const spawn = spyOn(spawnModule, "spawnStructuredConversation").mockImplementation(async input => {
    activation ??= structuredClone(loadPipelines()[0]!.runs[0]!.attempts[0]!.activation);
    if (!launches.includes(input.receipt.launchId)) launches.push(input.receipt.launchId);
    const sessionId = engine === "claude" && input.spec.transcript ? path.basename(input.spec.transcript, ".jsonl")
      : ["00000000", "0000", "4000", "8000", String(launches.length).padStart(12, "0")].join("-");
    const artifact = engine === "codex" ? path.join(transcriptRoot, `${sessionId}.jsonl`)
      : input.spec.transcript ?? claudeTranscriptPath(input.spec.cwd, sessionId, transcriptRoot);
    fs.mkdirSync(path.dirname(artifact), { recursive: true });
    let dead = false;
    const host: SpawnedStructuredHost = {
      identity: { threadId: sessionId, sessionId, path: artifact },
      supportsSteer: false,
      health: async () => ({ status: dead ? "dead" : "idle", sessionKey: sessionId, endpoint: "fixture", pid: process.pid,
        processStartIdentity: "privacy-fixture", eventCursor: 0, protocolVersion: "fixture", activeTurnRef: null,
        pendingAttention: [], activeFlags: [], account: null }),
      onStateChange: () => () => {},
      attach: () => ({ async *[Symbol.asyncIterator]() {} }),
      interrupt: async () => {}, answer: async () => {}, release: async () => {
        if (mode === "release" && launches.length === 1) throw new Error("fixture release refused");
        dead = true;
      },
      send: async (entry, _proof, authorize) => {
        authorize?.();
        if (!sent.some(previous => previous.id === entry.id)) sent.push(entry);
        fs.writeFileSync(artifact, JSON.stringify({ type: "session_meta", payload: { id: sessionId } }) + "\n"
          + JSON.stringify(engine === "codex" ? { type: "event_msg", payload: { type: "user_message", message: entry.text } }
            : { type: "user", message: { role: "user", content: entry.text } }) + "\n");
        if (timing === "after-handoff") throw new Error("request timed out: thread/read");
        return { outcome: "turn-started", turnId: "privacy-current-turn" };
      },
    };
    hosts.set(input.receipt.conversationId, host);
    let preparationTime = 0;
    const preparationClock = preparation && launches.length === 1
      ? spyOn(performance, "now").mockImplementation(() => preparationTime) : undefined;
    try { return await realSpawn({ ...input, ...(preparation && launches.length === 1 ? {
      preparePrompt: async () => {
        changed = true;
        preparationTime += 180_000;
        return input.preparePrompt!();
      },
    } : {}), ...(unsettled && !journalMode && launches.length === 1 ? {
      preparePrompt: async () => {
        const prompt = await input.preparePrompt!();
        write(`${newRule} revision ${++churn}`); changed = true;
        return prompt;
      },
    } : {}) }, {
      startHost: async () => {
        hostStarts.push(input.receipt.launchId);
        expect(new Set(hostStarts).size).toBe(hostStarts.length);
        if (laterFailure && launches.length === 2 && !laterNative) throw new Error("fixture later host start refused");
        return host;
      },
      ...(twice && launches.length === 1 ? {
        deliverFirst: async (staged, artifactPath) => {
          const request = { path: artifactPath, conversationId: staged.receipt.conversationId,
            clientMessageId: `spawn_${staged.receipt.launchId}`, operationId: `spawn_message_${staged.receipt.launchId}`,
            launchId: staged.receipt.launchId, text: staged.prompt, roleMemoryRevision: staged.roleMemoryRevision };
          const lost = { ...staged.client, command: async () => { throw new Error("fixture transport lost"); } } as RuntimeHostClient;
          await enqueueStructuredMessage(request, { client: () => lost, registry: () => staged.registry, enabled: () => true, authorizeDispatch: staged.authorize });
          changed = true; write(newRule);
          const second = await enqueueStructuredMessage(request, { client: () => staged.client, registry: () => staged.registry, enabled: () => true, authorizeDispatch: staged.authorize });
          expect(second).toMatchObject({ ok: false, error: ROLE_MEMORY_CHANGED_MESSAGE });
          throw new RoleMemoryChanged();
        },
      } : {}),
      ...(laterNative && launches.length === 2 ? {
        deliverFirst: async (_staged, artifactPath) => {
          fs.writeFileSync(artifactPath, JSON.stringify(engine === "codex"
            ? { type: "event_msg", timestamp: new Date().toISOString(), payload: { type: "task_started" } }
            : { type: "assistant", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "Working" }] } }) + "\n");
          throw new Error("fixture later delivery refused");
        },
      } : {}),
      ...(scenario.startsWith("staged") && launches.length === 1 ? {
        deliverFirst: async (staged, artifactPath) => {
          await enqueueStructuredMessage({ path: artifactPath, conversationId: staged.receipt.conversationId,
            clientMessageId: `spawn_${staged.receipt.launchId}`, operationId: `spawn_message_${staged.receipt.launchId}`,
            launchId: staged.receipt.launchId, text: staged.prompt, roleMemoryRevision: staged.roleMemoryRevision }, {
            client: () => staged.client, registry: () => staged.registry, enabled: () => true,
            authorizeDispatch: staged.authorize,
          });
          if (scenario.includes("native")) fs.writeFileSync(artifactPath, JSON.stringify(engine === "codex"
            ? { type: "event_msg", timestamp: new Date().toISOString(), payload: { type: "task_started" } }
            : { type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: "Build safely" } }) + "\n");
          throw new StructuredInitialMessageTimeoutError("initial message observation timed out");
        },
      } : {}),
      bindHost: async (target, key, _host, owner, epoch) => {
        target.setStructuredHostClaimed(key, { kind: runtimeHostKindForEngine(engine), endpoint: "fixture",
          process: mode === "release" && launches.length === 1 ? captureProcessIdentity(termination!.pid)
            : { pid: process.pid, startIdentity: "privacy-fixture" }, eventCursor: 0, protocolVersion: "fixture",
          writerClaimEpoch: epoch, activeTurnRef: null, pendingAttention: [], activeFlags: [] }, "idle", owner, epoch);
        journal.append({ scope: { type: "session", id: input.receipt.conversationId }, kind: "session-status", payload: {
          conversationId: input.receipt.conversationId, sessionKey: key, artifactPath: artifact, cwd: input.spec.cwd,
          hostKind: runtimeHostKindForEngine(engine), host: "hosted", turn: "idle", activeTurnId: null, provenance: "structured",
        } });
        return () => {
          const current = target.readOnlySnapshot().entries[`${key.engine}:${key.sessionId}`]?.structuredHost;
          if (dead && current) {
            target.setStructuredHostClaimed(key, { ...current, process: null }, "dead", owner, epoch, true);
            if (scenario === "preparation-lost-dead-codex" && launches.length === 1) throw new Error("fixture dead projection acknowledgement lost");
          }
        };
      },
      publishHost: async () => async () => {
        if (["unregister", "refused-unregister"].includes(mode!) && launches.length === 1) throw new Error("fixture unregister refused");
      },
      processIdentity: () => ({ pid: process.pid, startIdentity: "privacy-fixture" }),
    }); } finally {
      preparationClock?.mockRestore();
      if (unknown && launches.length === 1) {
        const first = registry.spawnReceipt(input.receipt.launchId)!;
        if (unknownMode === "native") fs.writeFileSync(first.artifactPath!, JSON.stringify(engine === "codex"
          ? { type: "event_msg", timestamp: new Date().toISOString(), payload: { type: "task_started" } }
          : { type: "assistant", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "Working" }] } }) + "\n");
        if (unknownMode === "live") {
          const entry = registry.readOnlySnapshot().entries[`${engine}:${first.key!.sessionId}`]!;
          registry.upsert({ ...entry, structuredTerminationSurvivors: [captureProcessIdentity(termination!.pid)] });
        }
      }
      if ((scenario === "before-handoff-settling" || scenario.startsWith("replay")) && launches.length === 1) {
        const receipt = registry.spawnReceipt(input.receipt.launchId)!;
        const entry = registry.readOnlySnapshot().entries[`${engine}:${receipt.key!.sessionId}`]!;
        registry.upsert({ ...entry, structuredTerminationSurvivors: [captureProcessIdentity(termination!.pid)] });
      }
    }
  });
  try {
    if (scenario === "before-handoff-settling" || scenario.startsWith("replay") || mode === "release" || unknownMode === "live") {
      termination = Bun.spawn([process.execPath, "-e", "process.stdin.resume(); console.log('ready')"], {
        stdin: "pipe", stdout: "pipe", stderr: "pipe",
      });
      const reader = termination.stdout.getReader();
      try { expect(new TextDecoder().decode((await reader.read()).value).trim()).toBe("ready"); }
      finally { reader.releaseLock(); }
    }
    const h = harness();
    if (scenario.startsWith("staged") || unsettled) h.advanceWallClock(Date.now() - Date.parse(h.ports.now()));
    const defaults = defaultPipelinePorts();
    h.ports.spawnAgent = (input, reserved, prepare) => defaults.spawnAgent(input, async receipt => {
      await reserved(receipt);
      if (["prehost", "reaper"].includes(mode!) && !launches.includes(receipt.launchId)) launches.push(receipt.launchId);
    }, ["prehost", "reaper"].includes(mode!) && !changed ? async () => {
      const prompt = await prepare!();
      write(`${newRule} revision ${++churn}`);
      return prompt;
    } : prepare).catch(error => { if (["prehost", "reaper"].includes(mode!)) changed = true; throw error; });
    h.ports.spawnReceipt = defaults.spawnReceipt;
    h.ports.spawnReceiptState = defaults.spawnReceiptState;
    h.ports.claimSpawnRetry = defaults.claimSpawnRetry;
    h.ports.durableTurnEvidence = defaults.durableTurnEvidence;
    h.ports.recoverStagedLaunch = defaults.recoverStagedLaunch;
    h.ports.failStoppedStageLaunch = (...args) => unsettled && !observing && !manual
      ? Promise.resolve(false) : defaults.failStoppedStageLaunch!(...args);
    if (laterFailure || manual) {
      h.ports.stopStageAgent = defaults.stopStageAgent;
      h.ports.conversationHostProcess = defaults.conversationHostProcess;
      h.ports.originalLaunchOperations = defaults.originalLaunchOperations;
    }
    if (unknownMode === "late-journal") {
      const claimRetry = h.ports.claimSpawnRetry;
      h.ports.claimSpawnRetry = async (...args) => {
        const claimed = await claimRetry(...args);
        const first = registry.spawnReceipt(args[0])!;
        const originalId = `spawn_message_${first.launchId}`;
        const entry = registry.readOnlySnapshot().entries[`${engine}:${first.key!.sessionId}`]!;
        journal.append({ scope: { type: "session", id: first.conversationId }, kind: "session-status", payload: {
          conversationId: first.conversationId, sessionKey: first.key!, artifactPath: first.artifactPath!, cwd: entry.cwd,
          hostKind: runtimeHostKindForEngine(engine), host: "hosted", turn: "idle", activeTurnId: null, provenance: "structured",
        } });
        const queued = journal.executeOperation({ kind: "send", operationId: originalId, idempotencyKey: `spawn_${first.launchId}`,
          conversationId: first.conversationId, text: "Build safely" });
        expect(queued.receipt.status).toBe("queued");
        return claimed;
      };
    }
    await create(h.ports, [{ id: "build", kind: "run", role: { roleId: "builder" }, engine,
      ...(engine === "claude" ? { model: "fable" } : {}), prompt: "Build safely", next: null }] as never, { repoDir: root });
    h.ports.sourcePathAllowed = defaults.sourcePathAllowed;
    await tickPipelines([], h.ports);
    fs.mkdirSync(loadPipelines()[0]!.worktreeDir!, { recursive: true });
    await tickPipelines([], h.ports);
    expect(changed, loadPipelines()[0]!.stateDetail ?? "").toBe(true);
    expect(sent).toHaveLength(timing === "after-handoff" ? 1 : 0);
    expect(launches, loadPipelines()[0]!.stateDetail ?? "").toHaveLength(1);
    const originalId = `spawn_message_${launches[0]}`;
    if (preparation) {
      const first = registry.spawnReceipt(launches[0]!)!;
      if (scenario !== "preparation-lost-dead-codex") expect(first.error).toBe(ROLE_MEMORY_PREPARATION_MESSAGE);
      expect(journal.operationResult(originalId)).toBeNull();
      journal.close(); journal = new RuntimeJournal(journalFile, { structuredHosts: true });
      savePipelines(loadPipelines());
      for (let tick = 0; tick < 8; tick++) { h.advanceWallClock(31_000); await tickPipelines([], h.ports); }
      expect(launches).toHaveLength(2);
      expect(sent.map(entry => entry.id)).toEqual([`spawn_message_${launches[1]}`]);
      expect(registry.spawnReceipt(launches[0]!)!.error).toBe(ROLE_MEMORY_PREPARATION_MESSAGE);
      expect(journal.operationResult(originalId)).toBeNull();
      expect(loadPipelines()[0]!.state).toBe("running");
      expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
      return;
    }
    if (laterFailure || manual) {
      let claimedRetries = 0;
      const { patchPipeline } = await import("./engine");
      observing = true;
      if (manual) {
        const first = registry.spawnReceipt(launches[0]!)!;
        const native = mode!.endsWith("-native") && !mode!.endsWith("-late-native");
        const live = mode === "retry-twice" || mode === "retry-uncertain";
        const writeNative = () => fs.writeFileSync(first.artifactPath!, JSON.stringify(engine === "codex"
          ? { type: "event_msg", timestamp: h.ports.now(), payload: { type: "task_started" } }
          : { type: "assistant", timestamp: h.ports.now(), message: { role: "assistant", content: [{ type: "text", text: "Working" }] } }) + "\n");
        if (native) writeNative();
        if (live) {
          termination = Bun.spawn([process.execPath, "-e", "console.log('ready'); await Bun.stdin.text()"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
          const ready = termination.stdout.getReader();
          try { expect(new TextDecoder().decode((await ready.read()).value).trim()).toBe("ready"); }
          finally { ready.releaseLock(); }
          const entry = registry.readOnlySnapshot().entries[`${engine}:${first.key!.sessionId}`]!;
          registry.upsert({ ...entry, structuredTerminationSurvivors: [captureProcessIdentity(termination.pid)] });
        }
        if (twice) expect(Object.values(registry.readOnlySnapshot().heldDeliveries).find(row => row.command.operationId === originalId)?.attempts).toBe(2);
        else expect(journal.operationResult(originalId)?.receipt.status).toBe("uncertain");
        h.advanceWallClock(11 * 60_000);
        for (let tick = 0; tick < 3; tick++) { h.advanceWallClock(60_000); await tickPipelines([], h.ports); }
        expect(launches).toHaveLength(1);
        expect(loadPipelines()[0]!.state).toBe("needs_decision");
        if (mode!.endsWith("-late-native")) {
          const claim = h.ports.claimSpawnRetry;
          h.ports.claimSpawnRetry = async (...args) => { const result = await claim(...args); expect(result).toBe("claimed"); claimedRetries++; writeNative(); return result; };
        }
      } else {
        const error = registry.spawnReceipt(launches[0]!)!.error;
        if (timing === "before-dispatch") expect(error).toBe(ROLE_MEMORY_CHANGED_MESSAGE);
        else expect(error?.startsWith(`${ROLE_MEMORY_CHANGED_MESSAGE};`)).toBe(true);
        for (let tick = 0; tick < 12 && loadPipelines()[0]!.state !== "needs_decision"; tick++) {
          h.advanceWallClock(60_000); await tickPipelines([], h.ports);
        }
        expect(launches).toHaveLength(2);
        expect(loadPipelines()[0]!.state).toBe("needs_decision");
        expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.retiredLaunches?.map(row => row.launchId)).toEqual([launches[0]!]);
      }
      const held = laterNative || manual && mode!.endsWith("-native");
      const count = launches.length;
      if (manual && termination) {
        expect(await patchPipeline(loadPipelines()[0]!.id, { action: "retry-stage" }, h.ports)).toMatchObject({ status: 409 });
        expect(launches).toHaveLength(count);
        termination.stdin.end(); await termination.exited;
        h.advanceWallClock(60_000); await tickPipelines([], h.ports);
        expect(launches).toHaveLength(count);
      }
      const answer = await patchPipeline(loadPipelines()[0]!.id, { action: "retry-stage" }, h.ports);
      expect(answer.status ?? 200, answer.error).toBe(held ? 409 : 200);
      if (mode?.endsWith("-late-native")) expect(claimedRetries).toBe(1);
      for (let tick = 0; tick < 6; tick++) { h.advanceWallClock(60_000); await tickPipelines([], h.ports); }
      expect(launches).toHaveLength(count + (held ? 0 : 1));
      expect(new Set(launches).size).toBe(launches.length);
      if (!held) expect(sent).toHaveLength(1);
      return;
    }
    if (unknown) {
      const first = registry.spawnReceipt(launches[0]!)!;
      expect(first.state).toBe("failed");
      expect(first.error).toContain("journal outcome is unknown");
      expect(journalReadFailed).toBe(true);
      const held = unknownMode !== "absent";
      for (let tick = 0; tick < 6; tick++) { h.advanceWallClock(1_000); await tickPipelines([], h.ports); }
      expect(launches).toHaveLength(held ? 1 : 2);
      expect(sent).toHaveLength(held ? 0 : 1);
      if (unknownMode === "unreadable") {
        const { patchPipeline } = await import("./engine");
        const refused = await patchPipeline(loadPipelines()[0]!.id, { action: "retry-stage" }, h.ports);
        expect(refused.status).toBe(409);
        expect(refused.error).toContain("journal");
        observing = true;
        for (let tick = 0; tick < 6; tick++) { h.advanceWallClock(1_000); await tickPipelines([], h.ports); }
        expect(launches).toHaveLength(2);
        expect(sent).toHaveLength(1);
      }
      return;
    }
    if (unsettled) {
      observing = true;
      const first = registry.spawnReceipt(launches[0]!)!;
      expect(first.state).toBe(["prehost", "reaper"].includes(mode!) ? "starting" : "path-pending");
      expect(first.error).not.toBe(ROLE_MEMORY_CHANGED_MESSAGE);
      if (!journalMode) expect(journal.operationResult(originalId)).toBeNull();
      if (["refused-writer", "queued", "delivering", "uncertain", "unverified", "prehost", "writer", "reaper", "native", "late-native", "unreadable"].includes(mode!)) expect(refusedWrites).toBe(1);
      if (mode === "native") fs.writeFileSync(first.artifactPath!, JSON.stringify(engine === "codex"
        ? { type: "event_msg", timestamp: h.ports.now(), payload: { type: "task_started" } }
        : { type: "assistant", timestamp: h.ports.now(), message: { role: "assistant", content: [{ type: "text", text: "Working" }] } }) + "\n");
      if (mode === "reaper") {
        const { terminalizeStaleStructuredSpawns } = await import("@/lib/runtime/structuredSpawn");
        h.advanceWallClock(6 * 60_000); setSystemTime(new Date(h.ports.now()));
        const reaped = await terminalizeStaleStructuredSpawns(registry, client, {
          now: () => Date.parse(h.ports.now()), timeoutMs: 300_000, repairFailures: false, actuateQueuedSpawns: false,
        });
        expect(reaped.terminalized).toContain(first.launchId);
        expect(registry.spawnReceipt(first.launchId)?.error).toBe("structured spawn runtime snapshot has no session after 300000ms");
        const { patchPipeline } = await import("./engine");
        h.advanceWallClock(11 * 60_000);
        await tickPipelines([], h.ports);
        const lane = loadPipelines()[0]!;
        expect(lane.state).toBe("needs_decision");
        expect((await patchPipeline(lane.id, { action: "retry-stage" }, h.ports)).error).toBeUndefined();
      }
      if (mode === "release") {
        for (let tick = 0; tick < 3; tick++) { h.advanceWallClock(1_000); await tickPipelines([], h.ports); }
        expect(launches).toHaveLength(1);
        termination!.stdin.end(); await termination!.exited;
      }
      for (let tick = 0; tick < 6; tick++) { h.advanceWallClock(1_000); await tickPipelines([], h.ports); }
      const held = ["queued", "delivering", "uncertain", "unverified", "native", "late-native", "unreadable"].includes(mode!);
      expect(launches, loadPipelines()[0]!.stateDetail ?? "").toHaveLength(held ? 1 : 2);
      expect(hostStarts).toEqual(["prehost", "reaper"].includes(mode!) ? launches.slice(1) : launches);
      expect(sent).toHaveLength(held ? 0 : 1);
      if (mode === "late-native") expect(lateNative).toBe(true);
      if (!held) {
        if (mode !== "reaper") {
          expect(registry.spawnReceipt(first.launchId)?.error).toBe(ROLE_MEMORY_CHANGED_MESSAGE);
          expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.retiredLaunches?.map(row => row.launchId)).toEqual([first.launchId]);
        }
        expect(loadPipelines()[0]!.state).toBe("running");
      }
      return;
    }
    if (scenario.startsWith("replay")) {
      const lane = loadPipelines()[0]!;
      const attempt = lane.runs[0]!.attempts[0]!;
      expect(activation).toBeDefined();
      attempt.activation = { ...activation!, phase: "reserved", replay: true };
      delete attempt.activation.owner;
      delete attempt.roleMemoryDispatchWait;
      delete attempt.controllerWait;
      attempt.state = "spawning";
      lane.cursor!.state = "spawning";
      const receipt = registry.spawnReceipt(launches[0]!)!;
      if (scenario.includes("native")) fs.writeFileSync(receipt.artifactPath!, JSON.stringify(engine === "codex"
        ? { type: "event_msg", timestamp: h.ports.now(), payload: { type: "task_started" } }
        : { type: "user", timestamp: h.ports.now(), message: { role: "user", content: "Build safely" } }) + "\n");
      savePipelines([lane]);
      await tickPipelines([], h.ports);
      expect(loadPipelines()[0]!.state).toBe("running");
      expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.roleMemoryDispatchWait).toBeDefined();
      expect(launches).toHaveLength(1);
      termination!.stdin.end(); await termination!.exited;
      for (let tick = 0; tick < 6; tick++) { h.advanceWallClock(1_000); await tickPipelines([], h.ports); }
      expect(launches).toHaveLength(scenario.includes("native") ? 1 : 2);
      expect(sent).toHaveLength(scenario.includes("native") ? 0 : 1);
      expect(loadPipelines()[0]!.state).toBe("running");
      return;
    }
    if (scenario.startsWith("staged")) {
      expect(registry.spawnReceipt(launches[0]!)!.state).toBe("path-pending");
      expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.roleMemoryDispatchWait).toBeUndefined();
      for (let tick = 0; tick < 6; tick++) {
        h.advanceWallClock(1_000); setSystemTime(new Date(h.ports.now())); await tickPipelines([], h.ports);
      }
      expect(registry.spawnReceipt(launches[0]!)!.error).toBe(ROLE_MEMORY_CHANGED_MESSAGE);
      expect(launches).toHaveLength(scenario.includes("native") ? 1 : 2);
      expect(sent).toHaveLength(scenario.includes("native") ? 0 : 1);
      expect(loadPipelines()[0]!.state).toBe("running");
      return;
    }
    if (scenario.startsWith("before-authorization")) {
      expect(journal.operationResult(originalId)).toBeNull();
      expect(registry.spawnReceipt(launches[0]!)!.error).toBe(ROLE_MEMORY_CHANGED_MESSAGE);
      expect(Object.values(registry.snapshot().deliveryOperationOwners).map(owner => owner.terminalDisposition)).toEqual(["lost"]);
      expect(defaults.spawnReceipt(launches[0]!)?.roleMemoryRetrySafe).toBe(true);
      for (let tick = 0; tick < 6; tick++) { h.advanceWallClock(1_000); await tickPipelines([], h.ports); }
      expect(launches).toHaveLength(2);
      expect(sent.map(entry => entry.id)).toEqual([`spawn_message_${launches[1]}`]);
      expect(loadPipelines()[0]!.state).toBe("running");
      expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
      expect(journal.operationResult(originalId)).toBeNull();
      return;
    }
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
    expect(defaults.spawnReceipt(launches[0]!)).toMatchObject({ state: "failed", roleMemoryRetrySafe: scenario !== "before-handoff-settling" });
    if (scenario === "before-handoff-settling") {
      const waiting = loadPipelines()[0]!;
      expect(waiting.state).toBe("running");
      expect(waiting.runs[0]!.attempts[0]!).toMatchObject({ state: "spawning", launchId: launches[0] });
      expect(waiting.stateDetail).toContain("receipt failed");
      expect(waiting.runs[0]!.attempts[0]!.roleMemoryDispatchWait).toBeDefined();
      h.advanceWallClock(1_000);
      await tickPipelines([], h.ports);
      expect(launches).toHaveLength(1);
      termination!.stdin.end();
      expect(await termination!.exited).toBe(0);
      expect(defaults.spawnReceipt(launches[0]!)?.roleMemoryRetrySafe).toBe(true);
    }
    if (scenario === "before-handoff-unknown" || scenario === "before-handoff-live") {
      const launch = registry.spawnReceipt(launches[0]!)!;
      const entry = registry.readOnlySnapshot().entries[`codex:${launch.key!.sessionId}`]!;
      // A failed first-message receipt proves no dispatch, but host absence
      // still needs independent proof. A stop acknowledgement cannot clear
      // an unknown identity or a captured process that remains alive.
      const survivor = scenario === "before-handoff-unknown"
        ? { pid: process.pid, startIdentity: null } : captureProcessIdentity(process.pid);
      registry.upsert({ ...entry, status: "unhosted", claimOwner: null, pendingAction: "spawn",
        structuredTerminationSurvivors: [survivor] });
      const reloaded = new AgentRegistry(path.join(root, "registry.json"));
      setAgentRegistryForTests(reloaded);
      const recovery = defaultPipelinePorts();
      expect(recovery.spawnReceipt(launch.launchId)?.roleMemoryRetrySafe).toBe(false);
      expect(await recovery.failStoppedStageLaunch!(launch.launchId, launch.conversationId,
        ROLE_MEMORY_CHANGED_MESSAGE, () => true)).toBe(false);
      await drain();
      expect(launches).toHaveLength(1);
      expect(sent).toHaveLength(0);
      // Each survivor scenario owns its registry until teardown. The successful
      // recovery scenario starts separately without retained termination work.
      return;
    }
    // A fresh reader cannot revive the fenced effect or reset a retry counter.
    journal.close();
    journal = new RuntimeJournal(journalFile, { structuredHosts: true });
    expect(journal.executeOperation(originalCommand!).receipt).toMatchObject({ operationId: originalId, status: "failed" });
    await drain();
    expect(sent).toHaveLength(0);
    // Receipt retirement, activation reservation and the two stable memory
    // observations each retain their own controller turn.
    for (let tick = 0; tick < 8 && launches.length < 2; tick++) {
      h.advanceWallClock(60_000);
      await tickPipelines([], h.ports);
      if (scenario === "before-handoff-settling" && tick === 0) {
        expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.launchId).toBeNull();
        expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.retiredLaunches?.map(launch => launch.launchId)).toEqual([launches[0]!]);
      }
    }
    expect(launches).toHaveLength(2);
    expect(sent.map(entry => entry.id)).toEqual([`spawn_message_${launches[1]}`]);
    const successor = registry.readOnlySnapshot().receipts[launches[1]!]!;
    expect(successor.state).toBe("completed");
    expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)!.retiredLaunches?.map(launch => launch.launchId)).toEqual([launches[0]!]);
    expect(journal.operationResult(originalId)?.receipt).toMatchObject({ status: "failed", reason: ROLE_MEMORY_CHANGED_MESSAGE });
    await drain();
    expect(sent).toHaveLength(1);
    expect(sendCommands.at(-1)!.roleMemoryRevision).toBe(roleMemoryRevisionToken());
    expect(roleMemoryRevisionToken()).not.toBe(JSON.parse(originalEffect!).payload.roleMemoryRevision);
  } finally {
    if (termination) { if (termination.exitCode === null) termination.stdin.end(); await termination.exited; }
    failure.mockRestore(); deliveryClaim.mockRestore(); spawn.mockRestore(); guard.mockRestore(); resolve.mockRestore(); runtime.mockRestore();
    ids.mockRestore();
    setSystemTime();
    setAgentRegistryForTests(null);
    journal.close();
    if (previousHome === undefined) delete process.env[homeName];
    else process.env[homeName] = previousHome;
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
  expect(changed).toBe(true);
  if (h.spawnInputs.length === 0) {
    expect(loadPipelines()[0]!.state).toBe("running");
    expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)!.roleMemoryWait).toBeDefined();
    for (let tick = 0; tick < 8 && h.spawnInputs.length === 0; tick++) {
      h.advanceWallClock(31_000); await tickPipelines([], h.ports);
    }
  }
  const pipeline = loadPipelines()[0]!;
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


test.each(["reclassify", "file-reclassify", "request", "churn", "corrupt", "pause"] as const)("admission rechecks privacy and activation before dispatch: %s", async mode => {
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
      if (mode === "request") recordLessonRequest({ project: "fixture", pipelineId: "unrelated-reservation", stageId: "build", attempt: reservations,
        roleId: "builder", conversationId: "conversation_fixture", at: "2026-11-06T00:00:00Z" });
      if (mode === "churn") write(`${newRule} revision ${reservations}`);
      if ((mode === "reclassify" || mode === "file-reclassify") && reservations === 2) write(newRule);
      if (mode === "corrupt") {
        roleMemoryCollection(true)!.boundedPatch(1, tx => tx.put({ kind: "rule", id: 7, rule: newRule } as never));
      }
    }, preparePrompt);
    if (mode === "reclassify" || mode === "file-reclassify" || mode === "request") {
      await launch;
      expect(reservations).toBe(mode === "request" ? 2 : 3);
      expect(sent).toHaveLength(1);
      if (mode === "request") expect(sent[0]).toContain(newRule);
      else {
        expect(sent[0]).not.toContain(newRule);
        expect(sent[0]).toContain("[learned rule]");
      }
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
        expect(deferred.state).toBe("running");
        expect(deferred.stateDetail).toContain("original launch retired");
        expect(deferred.runs[0]!.attempts.at(-1)?.roleMemoryDispatchWait).toBeUndefined();
        expect(deferred.runs[0]!.attempts.at(-1)?.retiredLaunches ?? []).toHaveLength(1);
        expect(sent).toHaveLength(0);
        changing = false;
        for (let tick = 0; tick < 6; tick++) { pending.advanceWallClock(1_000); await tickPipelines([], pending.ports); }
        expect(sent).toHaveLength(1);
        expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
        expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.retiredLaunches).toHaveLength(1);
      }
    }
  } finally {
    resolve.mockRestore(); client.mockRestore(); guard.mockRestore(); spawn.mockRestore(); setAgentRegistryForTests(null);
    if (priorBinary === undefined) delete process.env.LLV_CODEX_BINARY;
    else process.env.LLV_CODEX_BINARY = priorBinary;
    if (mode === "corrupt") roleMemoryCollection(true)!.boundedPatch(1, tx => tx.delete("r:7"));
  }
}, 30_000);

test.each([false, true].flatMap(fileBacked => ["rule", "request", "none"].map(kind => ({ fileBacked, kind }))))("the real structured spawn refreshes role memory after runtime admission (file-backed=$fileBacked, change=$kind)", async ({ fileBacked, kind }) => {
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
  const preparedRevision = roleMemoryRevisionToken();
  let requestAttempt = 0;
  const change = (text: string) => {
    if (kind === "rule") write(text);
    if (kind === "request") recordLessonRequest({ project: "fixture", pipelineId: "unrelated", stageId: "build", attempt: ++requestAttempt,
      roleId: "builder", conversationId: "conversation_fixture", at: "2026-11-06T00:00:00Z" });
  };
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
    command: async () => { change(newRule); return undefined; },
    transitionOperation: async () => undefined,
  } as never);
  const guard = spyOn(guardModule, "prepareStageGitGuard").mockResolvedValue({});
  const sent: string[] = [];
  let handedToHost = false;
  const filter = TaskPageWorker.prototype.privacy;
  const worker = spyOn(TaskPageWorker.prototype, "privacy").mockImplementation(function(this: TaskPageWorker, request) {
    return filter.call(this, request);
  });
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
      if (kind === "rule") expect(delivered.prompt).not.toContain(newRule);
      else expect(delivered.prompt).toContain(newRule);
      change(`${newRule} changed while first delivery was held`);
      let refused = false;
      try { await delivered.authorize?.(); }
      catch (error) { refused = error instanceof Error && error.message.includes("Role-memory privacy changed"); }
      expect(refused).toBe(kind === "rule");
      if (!refused) handedToHost = true;
      return "held";
    },
    processIdentity: () => ({ pid: process.pid, startIdentity: "fixture" }),
    durableSetupTimeoutMs: 2_000,
  }));
  try {
    await defaultPipelinePorts().spawnAgent(input, () => {}, preparePrompt);
    expect(sent).toHaveLength(1);
    if (kind === "rule") {
      expect(sent[0]).not.toContain(newRule);
      expect(sent[0]).toContain("[learned rule]");
    } else expect(roleMemoryRevisionToken()).toBe(preparedRevision);
    const file = sent[0]!.match(/Full (?:stage prompt|specification) file: (.+)\n/)?.[1];
    expect(Boolean(file)).toBe(fileBacked);
    if (file) {
      const fullPrompt = fs.readFileSync(file, "utf8");
      if (kind === "rule") {
        expect(fullPrompt).not.toContain(newRule);
        expect(fullPrompt).toContain("[learned rule]");
      } else expect(fullPrompt).toContain(newRule);
    }
    expect(handedToHost).toBe(kind !== "rule");
    if (kind !== "rule") expect(worker).toHaveBeenCalledTimes(0);
  } finally {
    worker.mockRestore();
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
  expect(writes).toBe(1);
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
}, 60_000);

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
}, 15_000);

test.each(["reservation", "git-guard"] as const)("expired activation during %s settles its reserved production spawn receipt without dispatch", async boundary => {
  savePipelines([]);
  const h = harness();
  await create(h.ports, [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null }] as never,
    { repoDir: path.join(process.env.LLV_STATE_DIR!, "expired-activation-repo") });
  await tickPipelines([], h.ports);
  fs.mkdirSync(loadPipelines()[0]!.worktreeDir!, { recursive: true });
  await tickPipelines([], h.ports);
  const input = h.spawnInputs[0]!;
  input.cwd = path.join(process.env.LLV_STATE_DIR!, "expired-activation-cwd");
  fs.mkdirSync(input.cwd, { recursive: true });
  const binary = path.join(process.env.LLV_STATE_DIR!, "expired-activation-codex");
  fs.writeFileSync(binary, "#!/bin/sh\nprintf '[]\\n'\n", { mode: 0o700 });
  const previousBinary = process.env.LLV_CODEX_BINARY;
  process.env.LLV_CODEX_BINARY = binary;
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "expired-activation-registry.json"));
  setAgentRegistryForTests(registry);
  const clientModule = await import("@/lib/runtime/client");
  const spawnModule = await import("@/lib/runtime/structuredSpawn");
  const guardModule = await import("@/lib/git/stageAttemptGuard");
  const lease = new OperationLease();
  const resolve = spyOn(accountManager, "resolveProjectSpawn").mockReturnValue({ kind: "available", account: {
    engine: "codex", accountId: "fixture-account", kind: "managed", home: process.env.LLV_STATE_DIR!,
    transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" },
  } });
  const client = spyOn(clientModule, "runtimeHostClient").mockReturnValue({} as never);
  const guard = spyOn(guardModule, "prepareStageGitGuard").mockImplementation(async () => {
    if (boundary === "git-guard") lease.expire();
    return {};
  });
  const spawn = spyOn(spawnModule, "spawnStructuredConversation").mockImplementation(async () => {
    throw new Error("expired activation reached runtime dispatch");
  });
  try {
    const launch = lease.run(() => defaultPipelinePorts().spawnAgent(input, async () => {
      if (boundary === "reservation") lease.expire();
    }));
    await expect(launch).rejects.toBeInstanceOf(OperationLeaseExpiredError);
    const receipt = registry.spawnReceiptForClientAttempt(input.clientAttemptId);
    expect(receipt).toMatchObject({ state: "failed" });
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    resolve.mockRestore(); client.mockRestore(); guard.mockRestore(); spawn.mockRestore();
    if (previousBinary === undefined) delete process.env.LLV_CODEX_BINARY;
    else process.env.LLV_CODEX_BINARY = previousBinary;
  }
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
