import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import { Database } from "bun:sqlite";
import { createInterface } from "node:readline";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { NextRequest } from "next/server";
import { sqliteRegistryFixture, registryLockHolder } from "@/lib/agent/registryLockHolderFixture";
import { REGISTRY_WRITER_BUSY, setAgentRegistryForTests } from "@/lib/agent/registry";
import { claudeTranscriptPath } from "@/lib/agent/transcript";
import { captureProcessIdentity, processIdentityStatus } from "@/lib/processIdentity";
import { executeSpawnRequest, productionSpawnCommandDependencies } from "@/lib/agent/spawnCommand";
import { ensureOperatorSpawnCapability } from "@/lib/agent/operatorCapability";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { reportSpawnHeaders } from "@/lib/telegram/reportSpawn";
import { accountManager } from "@/lib/accounts/manager";
import { projectForCwd } from "@/lib/scanner/describe";
import { runClaimedRequest } from "@/lib/externalRelay/runner";
import { contextRequest } from "@/lib/externalRelay/request.fixture";
import { clonePairing, cloneReceipt } from "@/lib/externalRelay/clone.fixture";
import { startTestRelay } from "@/lib/externalRelay/testRelay";
import { updateRelayStore } from "@/lib/externalRelay/store";
import { setRelaySwitch } from "@/lib/externalRelay/switches";
import { productionDomainDependencies, viewerMcpBindings, viewerMcpToolPolicy } from "@/lib/mcp/bindings";
import { createMcpToolService, MemoryMcpReceiptStore } from "@/lib/mcp/server";
import { setMcpHttpDependenciesForTests } from "@/lib/mcp/http";
import { POST as mcpPost } from "@/app/api/mcp/route";
import { RuntimeJournal } from "@/runtime-host/journal";
import type { RuntimeHostClient } from "./client";
import { CodexSocketTransport } from "./codexSocketTransport";
import { spawnManagedEngine } from "./agentSignalSandbox";
import { spawnStructuredConversation, type SpawnedStructuredHost } from "./structuredSpawn";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const FAILURE = `${REGISTRY_WRITER_BUSY} (spawn.setup-custody)`;

type PreHostWriter = "registry.rotateSpawnCapabilityForReceipt" | "registry.setReceiptViewerMcpTransport";

interface CustodyControl {
  queued: (filename: string) => Promise<void>;
  hold: (filename: string) => Promise<void>;
  release: () => Promise<void>;
  sleep: (ms: number, now: number) => Promise<number>;
}

async function fixture(held: "released" | "late-release" | "expired" | "revoked" | "owner-released" | "pipeline" | "stalled" | "repeat" | "retained" | "retained-concurrent" | "retained-expired" | "retained-revoked" | "retained-owner-released" | "native-retained" | "native-retained-expired" | "native-retained-concurrent" | "socket-retained" | "socket-retained-expired" | "native-retained-fence" | "native-retained-fence-expired" | "socket-retained-fence" | "socket-retained-fence-expired" = "released", retryMs?: number, queuedDeadlineMs?: number, control?: CustodyControl, preHostWriter?: PreHostWriter) {
  const retainingFence = held.includes("-fence");
  const retainingSocket = held.startsWith("socket-retained");
  const retainingNative = held.startsWith("native-retained") || retainingSocket;
  const retaining = held.startsWith("retained") || retainingNative;
  const nativeProcesses: ReturnType<typeof captureProcessIdentity>[] = [];
  const bothReady = Promise.withResolvers<void>();
  const custodyResolved = Promise.withResolvers<void>();
  let readyHosts = 0;
  let stopFirstNative: (() => Promise<void>) | undefined;
  let sequence = 0;
  const ids = spyOn(crypto, "randomUUID").mockImplementation(() =>
    `00008000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`);
  cleanups.push(() => ids.mockRestore());
  const saved = { ...process.env };
  cleanups.push(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  let writerClockMs = 0;
  let preHostWriterHeld = false;
  const storage = sqliteRegistryFixture("launch-custody", preHostWriter ? {
    // Give initial SDK admission its normal deadline. Expire the SQLite
    // clock only while the intended writer owns the lock.
    sqliteWriterDeadlineMs: 5_000,
    writerClock: () => (writerClockMs += preHostWriterHeld ? 5_000 : 5),
  } : {});
  cleanups.push(storage.cleanup);
  const { registry, root } = storage;
  // TASKS_FILE is captured when the module loads. Each registry fixture uses
  // fresh deterministic launch ids, so its task rows must start fresh too.
  const { saveTasks } = await import("@/lib/tasks/store");
  saveTasks([]);
  setAgentRegistryForTests(registry);
  cleanups.push(() => { setAgentRegistryForTests(null); registry.close(); });
  Object.assign(process.env, { LLV_SPAWN_TRANSPORT: "structured", LLV_STRUCTURED_HOSTS: "1",
    LLV_RUNTIME_EVENTS: "1", NEXT_PUBLIC_RUNTIME_UI: "1", LLV_STATE_DIR: path.join(root, "state"),
    LLV_RUNTIME_HOST_SOCKET: path.join(root, "unused.sock") });
  const holder = control
    ? { hold: () => control.hold(storage.sqliteFilename), release: control.release }
    : registryLockHolder(storage.sqliteFilename, preHostWriter ? "migration.stop.sweep" : "");
  if ("close" in holder) cleanups.push(() => holder.close());
  let nativeWriter: Database | undefined;
  const releaseNativeWriter = () => {
    if (!nativeWriter) return;
    try { nativeWriter.exec("ROLLBACK"); } finally { nativeWriter.close(); nativeWriter = undefined; }
  };
  cleanups.push(releaseNativeWriter);
  if (retainingNative) {
    const record = registry.recordStructuredHostSetup.bind(registry);
    let collided = false, waiterSeen = false;
    const records = spyOn(registry, "recordStructuredHostSetup").mockImplementation((launchId, owner, native) => {
      if (native && !waiterSeen) {
        nativeProcesses.push(native); waiterSeen = true;
        cleanups.push(() => { if (processIdentityStatus(native) === "alive") process.kill(native.pid, "SIGKILL"); });
      }
      if (!collided && (retainingFence ? !native && waiterSeen : native)) {
        collided = true;
        // Contend exactly at the production waiter's first PID write, after
        // the outer pre-exec fence has passed. No engine permit exists yet.
        nativeWriter = new Database(storage.sqliteFilename);
        nativeWriter.exec("BEGIN IMMEDIATE");
      }
      return record(launchId, owner, native);
    });
    cleanups.push(() => records.mockRestore());
  }

  const journal = new RuntimeJournal(path.join(root, "runtime.sqlite"), { structuredHosts: true });
  cleanups.push(() => journal.close());
  const runtime = {
    command: async (command: Parameters<RuntimeHostClient["command"]>[0]) => journal.executeOperation(command),
    transitionOperation: async (...args: Parameters<RuntimeHostClient["transitionOperation"]>) => journal.transitionOperation(...args),
    filesRevision: async () => journal.snapshot().filesRevision,
    append: async (event: Parameters<RuntimeHostClient["append"]>[0]) => journal.append(event),
  } as RuntimeHostClient;
  const account = { engine: "claude" as const, accountId: "fixture", kind: "managed" as const,
    home: root, transcriptRoot: root, env: { ...process.env } };
  const selected = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "available", account });
  cleanups.push(() => selected.mockRestore());
  let attempts = 0, starts = 0, sends = 0, waits = 0,
    clock = control || queuedDeadlineMs === undefined ? Date.parse("2026-11-13T12:00:00Z") : Date.now();
  let authorized = true;
  const launchIds: string[] = [];
  const pending: Array<() => Promise<void>> = [];
  const delays: number[] = [];
  let submitted: Record<string, unknown> = {};
  const submissions = new Map<string, Record<string, unknown>>();
  const spec = { engine: "claude", model: "opus", cwd: root, title: "Inspect fixture", prompt: "Inspect fixture", mcpServers: [] };
  let preHostRefusals = 0;
  if (preHostWriter) {
    const write = registry.deliveryWriteOrBusy.bind(registry);
    const admission = spyOn(registry, "deliveryWriteOrBusy").mockImplementation(async (correlation, action) => {
      if (correlation.label !== preHostWriter || preHostRefusals) return write(correlation, action);
      await holder.hold();
      preHostWriterHeld = true;
      try { return await write(correlation, action); }
      catch (error) {
        expect((error as Error).message).toContain(`${REGISTRY_WRITER_BUSY} (${preHostWriter}); holder=migration.stop.sweep`);
        preHostRefusals++;
        if (held === "revoked") authorized = false;
        throw error;
      } finally {
        preHostWriterHeld = false;
        await holder.release();
      }
    });
    cleanups.push(() => admission.mockRestore());
  }
  const launch = async (body: Record<string, unknown>, authorize?: () => void) => {
    submitted = body;
    submissions.set(String(body.clientAttemptId), body);
    const request = { headers: reportSpawnHeaders(ensureOperatorSpawnCapability(), VIEWER_SPAWN_CAPABILITY_HEADER),
      json: async () => body } as unknown as NextRequest;
    const response = await executeSpawnRequest(request, { ...productionSpawnCommandDependencies,
      registry: () => registry, assertStructuredRuntime: () => {}, engineReadiness: () => "connected",
      autonomousStructured: true, authorizeAutonomousLaunch: () => { authorize?.(); if (!authorized) throw new Error("fixture authority revoked"); },
      resolveHealthySpawnAccount: async () => account, resolveSpawnAccount: () => account,
      preflightProtocol: async () => {}, runtimeHostClient: () => runtime,
      storeImages: () => [], defer: callback => { pending.push(callback); },
      spawnStructuredConversation: async input => {
        if (held === "pipeline") registry.rememberMembership(input.receipt.conversationId, {
          kind: "pipeline", containerId: "fixture-lane", stageId: "build", slot: "build:1", role: "builder",
          round: 1, stageOrder: 0, parentConversationId: null,
        });
        const queued = queuedDeadlineMs === undefined ? input : {
          ...input,
          receipt: { ...input.receipt, queuedPinnedSpawn: {
            version: 1 as const, admissionDeadlineAt: new Date(clock + queuedDeadlineMs).toISOString(),
            retryAt: new Date(clock).toISOString(), accountId: account.accountId, locale: "en" as const,
            spec: { ...input.spec, launchProfile: input.receipt.launchProfile }, prompt: input.prompt,
            imageRefs: input.imageRefs ?? [], parentArtifactPath: null, pipelineSourceConversationId: null,
          } },
        };
        if (queuedDeadlineMs !== undefined) {
          registry.queuePinnedSpawn(input.receipt.launchId, queued.receipt.queuedPinnedSpawn!, "Queued fixture");
          await control?.queued(storage.sqliteFilename);
        }
        return spawnStructuredConversation({ ...input,
          ...(queuedDeadlineMs === undefined && retryMs !== undefined ? { setupCustodyRetryMs: retryMs } : {}),
          ...(queuedDeadlineMs === undefined ? {} : { admissionRetryMs: 0 }),
        }, {
          now: () => clock,
          sleep: async ms => {
            if (!retaining) {
              expect(starts).toBe(0);
              expect(sends).toBe(0);
              expect(registry.spawnReceipt(input.receipt.launchId)).toMatchObject({ state: "starting",
                hostSetup: { phase: "preparing", processes: [] } });
            } else {
              expect(registry.spawnReceipt(input.receipt.launchId)).toMatchObject({ state: "starting",
                hostSetup: retainingNative && !retainingFence ? { phase: "preparing", processes: [] } : { phase: "executing", processes: [{}] } });
            }
            delays.push(ms); waits++;
            if (control) {
              // Hand the initial collision to the independent parent's writer
              // while the launch is suspended; it alone chooses the wake.
              if (retainingNative) releaseNativeWriter();
              clock = await control.sleep(ms, clock);
              return;
            }
            clock += ms;
            if (held === "stalled") clock += 5_000;
            if (held === "revoked" || held === "retained-revoked") authorized = false;
            if (retainingNative) {
              if (!held.endsWith("expired") || clock >= Date.parse("2026-11-13T12:00:02Z")) releaseNativeWriter();
            } else if (held === "late-release" ? clock >= Date.parse("2026-11-13T12:00:02.250Z")
              : held !== "expired" && held !== "retained-expired"
                || retaining && clock >= Date.parse("2026-11-13T12:00:02Z")) await holder.release();
            if (held === "retained-concurrent") custodyResolved.resolve();
            if (held === "retained-owner-released") {
              await stopFirstNative!();
              registry.confirmStructuredHostSetupCleanup(input.receipt.launchId, input.receipt.admissionOwner!);
              expect(registry.releaseStartingStructuredSpawn(input.receipt.launchId, input.receipt.admissionOwner!).released).toBe(true);
            }
            if (held === "owner-released") registry.releaseStartingStructuredSpawn(input.receipt.launchId, input.receipt.admissionOwner!);
          },
          startHost: async current => {
            launchIds.push(current.receipt.launchId);
            const ordinal = ++attempts;
            if (!retaining && !preHostWriter) await holder.hold();
            let child: ChildProcessWithoutNullStreams | undefined;
            let close: (() => Promise<void>) | undefined;
            try {
              if (held === "repeat") {
                await spawnManagedEngine("fixture-permit", [], { env: account.env }, null,
                  () => ({} as ChildProcessWithoutNullStreams));
                clock += 5_000;
              }
              if (retainingNative) {
                if (retainingSocket) {
                  const directory = fs.openSync(root, "r");
                  cleanups.push(() => fs.closeSync(directory));
                  // The real socket adapter needs a short Unix socket name.
                  process.env.HOME = `/proc/${process.pid}/fd/${directory}`;
                  const transport = await CodexSocketTransport.launch(process.execPath, ["--no-env-file", "-e", `
                    const fs = require("node:fs");
                    const file = process.argv.at(-1).slice("unix://".length);
                    Bun.serve({ unix: file, fetch(req, server) { if (server.upgrade(req)) return; return new Response(); },
                      websocket: { message() {} } });
                    fs.chmodSync(file, 0o600);
                    fs.appendFileSync(process.env.CUSTODY_MARKER, process.env.CUSTODY_LAUNCH + "\\n");
                  `], { env: { ...account.env, CUSTODY_MARKER: path.join(root, "native-starts"), CUSTODY_LAUNCH: current.receipt.launchId } });
                  child = transport as unknown as ChildProcessWithoutNullStreams;
                  const identity = captureProcessIdentity(transport.pid);
                  close = async () => {
                    if (processIdentityStatus(identity) === "alive") {
                      const ended = new Promise<void>(resolve => transport.once("exit", () => resolve()));
                      transport.kill("SIGKILL"); await ended;
                    }
                    transport.disconnect();
                    // The native exit event can precede its independent wait
                    // owner and stderr drain. Reap both before fixture teardown.
                    await transport.stderrDrained;
                    const deadline = performance.now() + 3_000;
                    while (nativeProcesses.some(process => processIdentityStatus(process) === "alive")
                      && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
                    expect(nativeProcesses.every(process => processIdentityStatus(process) === "dead")).toBe(true);
                  };
                } else {
                  child = await spawnManagedEngine(process.execPath, ["--no-env-file", "-e",
                    "require('node:fs').appendFileSync(process.argv.at(-2), process.argv.at(-1)+'\\n'); setInterval(() => {}, 1000)",
                    "--", path.join(root, "native-starts"), current.receipt.launchId], { env: account.env }, null);
                  const owned = child;
                  const closed = new Promise<void>(resolve => owned.once("close", () => resolve()));
                  close = async () => { if (owned.exitCode === null && owned.signalCode === null) owned.kill("SIGKILL"); await closed; };
                }
                starts++;
                cleanups.push(close!);
                nativeProcesses.push(captureProcessIdentity(child.pid!));
              } else await spawnManagedEngine("fixture-engine", [], { env: account.env }, null, () => {
                starts++;
                if (control) fs.appendFileSync(path.join(root, "native-starts"), `${current.receipt.launchId}\n`);
                child = spawn(process.execPath, ["--no-env-file", "-e", "setInterval(() => {}, 1000)"], {
                  env: { NODE_ENV: "test", PATH: process.env.PATH }, stdio: ["pipe", "pipe", "pipe"],
                });
                const closed = new Promise<void>(resolve => child!.once("close", () => resolve()));
                const owned = child;
                close = async () => { if (owned.exitCode === null && owned.signalCode === null) owned.kill("SIGKILL"); await closed; };
                cleanups.push(close);
                if (ordinal === 1) stopFirstNative = close;
                nativeProcesses.push(captureProcessIdentity(child.pid!));
                return child;
              });
            }
            catch (error) {
              releaseNativeWriter();
              if (close) await close();
              if (!control) await holder.release();
              throw error;
            }
            await holder.release();
            const artifact = current.spec.transcript ?? claudeTranscriptPath(root, crypto.randomUUID(), root);
            const sessionId = path.basename(artifact, ".jsonl");
            fs.mkdirSync(path.dirname(artifact), { recursive: true });
            fs.writeFileSync(artifact, JSON.stringify({ type: "user", message: { role: "user", content: "Fixture" } }) + "\n");
            if (held === "retained-concurrent") {
              if (++readyHosts === 2) bothReady.resolve();
              await bothReady.promise;
            }
            let healthRead = false;
            return { engine: "claude", identity: { sessionId },
              health: async () => {
                if (retaining && !retainingNative && ordinal === 1 && !healthRead) {
                  await holder.hold();
                }
                if (held === "retained-concurrent" && ordinal === 2) await custodyResolved.promise;
                healthRead = true;
                return { status: "idle", pid: child!.pid, endpoint: "fixture:stdio", eventCursor: 0,
                  processStartIdentity: captureProcessIdentity(child!.pid!).startIdentity,
                  protocolVersion: "fixture", activeTurnRef: null, pendingAttention: [], activeFlags: [] };
              },
              release: async () => {
                if (retaining && ordinal === 1) { await holder.release(); custodyResolved.resolve(); }
                await close!();
              }, onStateChange: () => () => {},
            } as unknown as SpawnedStructuredHost;
          },
          bindHost: async (store, key, host, claimOwner, claimEpoch) => {
            const state = await host.health();
            store.setStructuredHostClaimed(key, { kind: "claude-broker", endpoint: state.endpoint,
              process: captureProcessIdentity(state.pid!), eventCursor: 0, protocolVersion: "fixture",
              writerClaimEpoch: claimEpoch, activeTurnRef: null, pendingAttention: [], activeFlags: [] }, "idle", claimOwner, claimEpoch);
            return () => {};
          }, publishHost: async () => async () => {},
          deliverFirst: async () => { sends++; },
        }).finally(() => {
          // The sibling must not release the lock held across health(). That
          // lock belongs to the retry wake or the failing host's cleanup.
          if (!retaining) return holder.release();
        });
      },
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { root, registry, launch, spec, launchIds, journal, delays, nativeProcesses, submitted: () => submitted,
    submission: (clientAttemptId: string) => submissions.get(clientAttemptId)!,
    drain: async () => { for (const work of pending.splice(0)) await work(); },
    drainConcurrent: async () => { await Promise.all(pending.splice(0).map(work => work())); },
    preHostRefusals: () => preHostRefusals,
    counts: () => ({ attempts, starts, sends, waits }),
  };
}

for (const [held, preHostWriter] of [
  ["released", undefined], ["expired", undefined], ["released", "registry.rotateSpawnCapabilityForReceipt"],
] as const) test(`owner relay launch with writer ${preHostWriter ?? "spawn.setup-custody"} ${held}`, async () => {
  const f = await fixture(held, undefined, undefined, undefined, preHostWriter);
  const delivered: string[] = [];
  const service = await startTestRelay((req, body) => {
    if (req.url!.endsWith("/send")) { delivered.push((body as { text: string }).text); return { body: cloneReceipt() }; }
    if (req.url!.endsWith("/complete")) {
      const answer = (body as { answer?: { text: string } }).answer;
      if (answer) delivered.push(answer.text);
      return { body: { status: "accepted", duplicate: false } };
    }
    return { body: { status: "ok" } };
  });
  cleanups.push(() => service.close());
  const relay = clonePairing(service.origin);
  relay.targets[0] = { ...relay.targets[0]!, id: "target_1", enabled: true, ownerTier: true,
    engine: "claude", model: "opus", hardCapMinutes: 30 };
  updateRelayStore(store => ({ ...store, relays: [relay] }));
  setRelaySwitch("chain_conversations", false);
  const request = { ...contextRequest, request_id: `custody_${held}`, input: { ...contextRequest.input,
    tools: [], requester: { ...contextRequest.input.requester, is_owner: true },
    conversation: contextRequest.input.conversation.map(message => ({ ...message, text: "Inspect fixture" })) } };
  const result = await runClaimedRequest(relay, request, undefined, { leaseWorker: false, ownerPorts: {
    launch: async (body, authorize) => {
      const result = await f.launch({ ...body, cwd: f.root }, authorize);
      await f.drain();
      return result;
    },
    observe: async () => {
      const receipt = Object.values(f.registry.readOnlySnapshot().receipts)[0]!;
      return receipt.state === "failed"
        ? { state: "failed", failure: { kind: "launch-failed", detail: receipt.error! } }
        : { state: "ended", finalText: "Fixture answer" };
    },
    stop: async () => {},
  } });
  expect(f.preHostRefusals()).toBe(preHostWriter ? 1 : 0);
  expect(result?.outcome).toBe("answered");
  expect(delivered).toEqual([held === "released" ? "Fixture answer" : "Please try again."]);
  expect(f.counts().starts).toBe(held === "released" ? 1 : 0);
  expect(f.counts().sends).toBe(held === "released" ? 1 : 0);
  expect(Object.values(f.registry.readOnlySnapshot().receipts)).toHaveLength(1);
  expect(new Set(f.launchIds).size).toBe(1);
  const original = Object.values(f.registry.readOnlySnapshot().receipts)[0]!;
  expect(original).toMatchObject(held === "released" ? { state: "completed" } : { state: "failed", error: FAILURE });
  // Replaying the relay claim cannot acquire another launch or send a reply twice.
  expect(await runClaimedRequest(relay, request, undefined, { leaseWorker: false })).toEqual(result);
  expect(f.counts().starts).toBe(held === "released" ? 1 : 0);
  expect(Object.values(f.registry.readOnlySnapshot().receipts)).toHaveLength(1);
  expect(delivered).toHaveLength(1);
  if (held === "released") {
    expect(Object.values(f.registry.readOnlySnapshot().entries)).toHaveLength(1);
    expect(Object.values(f.registry.readOnlySnapshot().receipts)[0]!.hostSetup!.processes).toHaveLength(1);
  }
}, 30_000);

async function connect(f: Awaited<ReturnType<typeof fixture>>) {
  let dispatches = 0;
  const dependencies = { ...productionDomainDependencies,
    callerAttribution: () => ({ kind: "gateway" as const, conversationId: "conversation_fixture", role: null }),
    callerProject: () => projectForCwd(f.root), registrySnapshot: () => f.registry.readOnlySnapshot(),
    attentionAuthority: () => ({ kind: "root" as const, conversationId: "conversation_fixture", role: null }),
    noticeCapableViewOpen: () => true, adoptRootSession: () => {},
    completedFileScan: async () => ({ snapshot: { files: [] } }) as never,
  };
  const service = createMcpToolService(viewerMcpBindings(undefined, {
    post: async (pathname, body) => { expect(pathname).toBe("/api/spawn"); dispatches++; return (await f.launch(body)).body; },
  }, dependencies), new MemoryMcpReceiptStore(), viewerMcpToolPolicy(dependencies));
  const capability = "c".repeat(43);
  setMcpHttpDependenciesForTests({ service: async () => service,
    conversationForCapability: value => value === capability ? "conversation_fixture" : null });
  cleanups.push(() => setMcpHttpDependenciesForTests(null));
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => mcpPost(new NextRequest(request)) });
  cleanups.push(() => { listener.stop(true); });
  const client = new Client({ name: "launch-custody", version: "1" });
  cleanups.push(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL("/api/mcp", listener.url), {
    requestInit: { headers: { "x-llv-spawn-capability": capability } },
  }));
  return { call: (arguments_: Record<string, unknown> = {}) => client.callTool({ name: "spawn_agent", arguments: { ...f.spec, clientRequestId: "custody-spawn", ...arguments_ } }),
    dispatches: () => dispatches };
}

for (const [held, preHostWriter] of [
  ["released", undefined], ["expired", undefined], ["revoked", undefined],
  ["released", "registry.setReceiptViewerMcpTransport"], ["revoked", "registry.setReceiptViewerMcpTransport"],
] as const) test(`SDK spawn_agent with writer ${preHostWriter ?? "spawn.setup-custody"} ${held}`, async () => {
  const f = await fixture(held, undefined, undefined, undefined, preHostWriter);
  const sdk = await connect(f);
  const answer = await sdk.call();
  expect(answer.isError, JSON.stringify(answer)).not.toBe(true);
  await f.drain();
  const receipts = Object.values(f.registry.readOnlySnapshot().receipts);
  expect(receipts).toHaveLength(1);
  expect(new Set(f.launchIds).size).toBe(preHostWriter && held === "revoked" ? 0 : 1);
  expect(f.counts().starts).toBe(held === "released" ? 1 : 0);
  expect(f.counts().sends).toBe(held === "released" ? 1 : 0);
  if (held === "released") {
    expect(receipts[0]!.state).toBe("completed");
    expect(receipts[0]!.hostSetup!.processes).toHaveLength(1);
    expect(Object.values(f.registry.readOnlySnapshot().entries)).toHaveLength(1);
  }
  else expect(receipts[0]).toMatchObject({ state: "failed", error: held === "expired" ? FAILURE : "fixture authority revoked" });
  expect(f.preHostRefusals()).toBe(preHostWriter ? 1 : 0);
  if (held !== "expired") expect(f.counts().waits).toBe(preHostWriter ? 0 : 1);
  else {
    expect(f.counts().waits).toBeGreaterThan(1);
    expect(f.delays.reduce((sum, ms) => sum + ms, 0)).toBe(5_000);
    expect(Math.max(...f.delays)).toBeLessThanOrEqual(250);
  }
  expect((await sdk.call()).isError).not.toBe(true);
  expect(sdk.dispatches()).toBe(1);
  expect(Object.values(f.registry.readOnlySnapshot().receipts)).toHaveLength(1);
}, 30_000);

test("SDK spawn_agent keeps its original key when the setup writer outlasts the short wait", async () => {
  const f = await fixture("late-release");
  const sdk = await connect(f);
  expect((await sdk.call()).isError).not.toBe(true);
  const original = Object.values(f.registry.readOnlySnapshot().receipts)[0]!;
  await f.drain();
  expect(f.delays.reduce((sum, delay) => sum + delay, 0)).toBeGreaterThan(2_000);
  expect(f.counts()).toMatchObject({ attempts: 1, starts: 1, sends: 1 });
  expect(Object.values(f.registry.readOnlySnapshot().receipts)).toMatchObject([
    { launchId: original.launchId, conversationId: original.conversationId, state: "completed" },
  ]);
  expect((await sdk.call()).isError).not.toBe(true);
  expect(sdk.dispatches()).toBe(1);
}, 30_000);

for (const mode of ["retained-concurrent", "native-retained-concurrent"] as const)
test(`concurrent spawn_agent launches on one task retry custody without duplicate dispatch: ${mode}`, async () => {
  const f = await fixture(mode);
  const { createTask } = await import("@/lib/tasks/commands");
  const { loadTasks, saveTasks } = await import("@/lib/tasks/store");
  const created = createTask([], { project: projectForCwd(f.root)!, text: "Inspect concurrent launches", pos: { x: 0, y: 0 } }, [],
    { now: () => "2026-11-13T12:00:00Z", id: () => "custody-task" });
  if (!created.ok) throw new Error(created.error);
  saveTasks(created.tasks);
  const sdk = await connect(f);
  const requests = ["custody-concurrent-first", "custody-concurrent-second"].map(clientRequestId => ({ clientRequestId, taskId: created.task.id }));
  const answers = await Promise.all(requests.map(request => sdk.call(request)));
  expect(answers.every(answer => !answer.isError)).toBe(true);
  const reserved = Object.values(f.registry.readOnlySnapshot().receipts).map(row => ({ launchId: row.launchId, conversationId: row.conversationId }));
  expect(reserved).toHaveLength(2);
  await f.drainConcurrent();
  const receipts = Object.values(f.registry.readOnlySnapshot().receipts);
  expect(receipts.map(row => row.state), JSON.stringify(receipts.map(({ state, error }) => ({ state, error })))).toEqual(["completed", "completed"]);
  expect(receipts.map(row => ({ launchId: row.launchId, conversationId: row.conversationId }))).toEqual(reserved);
  expect(new Set(receipts.map(row => row.conversationId)).size).toBe(2);
  expect(f.counts()).toEqual({ attempts: 2, starts: 2, sends: 2, waits: 1 });
  expect(Object.values(f.registry.readOnlySnapshot().conversations)).toHaveLength(2);
  const task = loadTasks().find(row => row.id === created.task.id)!;
  expect(task.assignments).toHaveLength(2);
  expect(new Set(task.assignments.map(row => row.launchId))).toEqual(new Set(reserved.map(row => row.launchId)));
  for (const request of requests) expect((await sdk.call(request)).isError).not.toBe(true);
  expect(sdk.dispatches()).toBe(2);
  expect(f.counts().starts).toBe(2);
  for (const receipt of receipts) {
    const replay = await replayInNewProcess(f.submission(receipt.clientAttemptId!));
    expect(replay).toMatchObject({ starts: 0, deferred: 0, body: { launchId: receipt.launchId,
      conversationId: receipt.conversationId, state: "settled", initialMessage: "delivered" } });
    expect(replay.receipts).toHaveLength(2);
  }
}, 30_000);

for (const outcome of ["expired", "revoked", "owner-released"] as const)
test(`post-health custody retry preserves final refusal: ${outcome}`, async () => {
  const f = await fixture(`retained-${outcome}`);
  const sdk = await connect(f);
  await sdk.call();
  await f.drain();
  expect(f.counts().attempts).toBe(1);
  expect(f.counts().starts).toBe(1);
  expect(f.counts().sends).toBe(0);
  expect(f.counts().waits).toBeGreaterThan(0);
  const receipts = Object.values(f.registry.readOnlySnapshot().receipts);
  expect(receipts).toHaveLength(1);
  expect(receipts[0]!.hostSetup!.processes).toHaveLength(1);
  expect(receipts[0]!.hostSetup!.processes.every(process => processIdentityStatus(process) === "dead")).toBe(true);
  expect(f.journal.operationResult(`spawn_message_${receipts[0]!.launchId}`)).toBeNull();
  if (outcome === "expired") {
    expect(f.delays.reduce((sum, ms) => sum + ms, 0)).toBe(2_000);
    expect(receipts[0]).toMatchObject({ state: "failed", error: FAILURE });
    expect(await replayInNewProcess(f.submitted())).toMatchObject({ starts: 0, deferred: 0,
      body: { launchId: receipts[0]!.launchId, conversationId: receipts[0]!.conversationId, state: "failed", error: FAILURE },
      receipts: [{ state: "failed", error: FAILURE }] });
  } else if (outcome === "revoked") expect(receipts[0]).toMatchObject({ state: "failed", error: "fixture authority revoked" });
  else expect(receipts[0]).toMatchObject({ state: "starting", admissionOwner: null });
  expect((await sdk.call()).isError).not.toBe(true);
  expect(sdk.dispatches()).toBe(1);
  expect(f.counts().starts).toBe(1);
}, 30_000);

async function assignFixtureTask(root: string) {
  const { createTask } = await import("@/lib/tasks/commands");
  const { saveTasks } = await import("@/lib/tasks/store");
  const created = createTask([], { project: projectForCwd(root)!, text: "Inspect native launch", pos: { x: 0, y: 0 } }, [],
    { now: () => "2026-11-13T12:00:00Z", id: () => "native-custody-task" });
  if (!created.ok) throw new Error(created.error);
  saveTasks(created.tasks);
  return created.task.id;
}

for (const adapter of ["native", "socket"] as const)
for (const boundary of ["PID", "fence"] as const)
for (const expired of [false, true]) test.skipIf(adapter === "socket" && process.platform !== "linux")(`native PID custody retries only its write: ${adapter} ${boundary} expired=${expired}`, async () => {
  const f = await fixture(`${adapter}-retained${boundary === "fence" ? "-fence" : ""}${expired ? "-expired" : ""}`);
  const taskId = await assignFixtureTask(f.root);
  const sdk = await connect(f);
  expect((await sdk.call({ taskId })).isError).not.toBe(true);
  const original = Object.values(f.registry.readOnlySnapshot().receipts)[0]!;
  await f.drain();
  const receipts = Object.values(f.registry.readOnlySnapshot().receipts);
  expect(receipts).toHaveLength(1);
  expect(receipts[0]).toMatchObject({ launchId: original.launchId, conversationId: original.conversationId,
    state: expired ? "failed" : "completed", error: expired ? FAILURE : null });
  expect(f.counts().attempts).toBe(1);
  expect(f.counts().starts).toBe(expired ? 0 : 1);
  expect(f.counts().sends).toBe(expired ? 0 : 1);
  expect(f.counts().waits).toBeGreaterThan(0);
  if (expired) expect(fs.existsSync(path.join(f.root, "native-starts"))).toBe(false);
  else expect(fs.readFileSync(path.join(f.root, "native-starts"), "utf8")).toBe(`${original.launchId}\n`);
  if (expired) {
    expect(f.delays.reduce((sum, ms) => sum + ms, 0)).toBe(2_000);
    expect(f.nativeProcesses.every(process => processIdentityStatus(process) === "dead")).toBe(true);
  } else expect(receipts[0]!.hostSetup!.processes).toHaveLength(2);
  const replay = await replayInNewProcess(f.submitted());
  expect(replay).toMatchObject({ starts: 0, deferred: 0, body: { launchId: original.launchId,
    conversationId: original.conversationId, state: expired ? "failed" : "settled" } });
  expect(replay.receipts).toHaveLength(1);
  const { loadTasks } = await import("@/lib/tasks/store");
  const task = loadTasks().find(row => row.id === taskId)!;
  expect(task.assignments).toHaveLength(1);
  expect(task.assignments[0]!.launchId).toBe(original.launchId);
  expect((await sdk.call({ taskId })).isError).not.toBe(true);
  expect(sdk.dispatches()).toBe(1);
}, 30_000);

test("a pipeline launch leaves contention to its existing durable recovery without another wait", async () => {
  const f = await fixture("pipeline");
  const sdk = await connect(f);
  await sdk.call(); await f.drain();
  expect(f.counts()).toEqual({ attempts: 1, starts: 0, sends: 0, waits: 0 });
  expect(Object.values(f.registry.readOnlySnapshot().receipts)).toMatchObject([{ state: "failed", error: FAILURE }]);
});

test("custody retry keeps a shorter caller budget", async () => {
  const f = await fixture("expired", 40);
  const sdk = await connect(f);
  await sdk.call(); await f.drain();
  expect(f.delays).toEqual([25, 15]);
  expect(f.counts()).toEqual({ attempts: 1, starts: 0, sends: 0, waits: 2 });
  expect(Object.values(f.registry.readOnlySnapshot().receipts)).toMatchObject([{ state: "failed", error: FAILURE }]);
});

test("queued recovery retries custody independently from its single runtime admission attempt", async () => {
  const f = await fixture("released", undefined, 1_000);
  const sdk = await connect(f);
  const answer = await sdk.call();
  expect(answer.isError, JSON.stringify(answer)).not.toBe(true);
  await f.drain();
  expect(f.delays).toEqual([25]);
  expect(f.counts()).toEqual({ attempts: 1, starts: 1, sends: 1, waits: 1 });
  expect(Object.values(f.registry.readOnlySnapshot().receipts)).toHaveLength(1);
  expect(Object.values(f.registry.readOnlySnapshot().receipts)).toMatchObject([{ state: "completed", hostSetup: { processes: [{}] } }]);
});

for (const phase of ["caller", "post-health", "native-PID", "socket-PID"] as const)
for (const release of ["before", "after"] as const) test.skipIf(phase === "socket-PID" && process.platform !== "linux")(`parent controls custody release ${release} the ${phase} cutoff`, async () => {
  const scenario = `${phase}-${release}`;
  const childMode = process.env.LLV_CUSTODY_DEADLINE_CHILD;
  if (childMode && childMode !== scenario) return;
  if (childMode) {
    // Standard streams survive the repository preload's owned-runner re-entry.
    const input = createInterface({ input: process.stdin });
    cleanups.push(() => input.close());
    const commands = input[Symbol.asyncIterator]();
    const request = async (action: string, detail = {}) => {
      process.stdout.write(`CUSTODY_CONTROL=${JSON.stringify({ action, ...detail })}\n`);
      const command = await commands.next();
      if (command.done) throw new Error("parent closed the custody control channel");
      return Number(command.value);
    };
    const f = await fixture(phase === "caller" ? "released" : phase === "post-health" ? "retained" : phase === "socket-PID" ? "socket-retained" : "native-retained",
      undefined, phase === "caller" ? 100 : undefined, {
      queued: async filename => { await request("queued", { filename }); },
      hold: async filename => { await request("hold", { filename }); },
      // The parent owns the writer and releases it before acknowledging sleep.
      release: async () => {},
      sleep: (ms, now) => request("wait", { ms, now, filename: path.join(f.root, "registry.sqlite") }),
    });
    const sdk = await connect(f);
    await sdk.call(); await f.drain();
    const replay = await replayInNewProcess(f.submitted());
    await sdk.call(); await f.drain();
    await request("done", { counts: f.counts(), delays: f.delays, dispatches: sdk.dispatches(), replay, nativeProcesses: f.nativeProcesses });
    return;
  }
  type Message = { action: string; filename?: string; ms?: number; now?: number };
  let received = Promise.withResolvers<Message>();
  const child = Bun.spawn([process.execPath, "test", import.meta.filename, "--test-name-pattern",
    `parent controls custody release ${release} the ${phase} cutoff`], {
    env: { ...process.env, LLV_CUSTODY_DEADLINE_CHILD: scenario }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const output = (async () => {
    let text = "", pending = "";
    const decoder = new TextDecoder(), reader = child.stdout.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const part = decoder.decode(value, { stream: true });
      text += part; pending += part;
      const lines = pending.split("\n"); pending = lines.pop()!;
      for (const line of lines) if (line.startsWith("CUSTODY_CONTROL="))
        received.resolve(JSON.parse(line.slice("CUSTODY_CONTROL=".length)) as Message);
    }
    return text;
  })();
  const errors = new Response(child.stderr).text();
  const send = (clock: number) => { child.stdin.write(`${clock}\n`); child.stdin.flush(); };
  const timer = setTimeout(() => { if (child.exitCode === null) child.kill(); }, 30_000);
  cleanups.push(async () => { clearTimeout(timer); if (child.exitCode === null) child.kill(); await child.exited; });
  const next = async () => {
    const message = await Promise.race([received.promise,
      child.exited.then(async code => { throw new Error(`launch child exited early (${code}): ${await errors}`); })]);
    received = Promise.withResolvers<Message>();
    return message;
  };
  const first = await next();
  expect(first.action).toBe(phase === "caller" ? "queued" : phase === "post-health" ? "hold" : "wait");
  const filename = first.filename!;
  const root = path.dirname(filename);
  const observer = new Database(filename, { readonly: true });
  cleanups.push(() => observer.close());
  const receipts = () => observer.query<{ value_json: string }, []>(
    "SELECT value_json FROM registry_rows WHERE collection='receipts' ORDER BY row_order",
  ).all().map(row => JSON.parse(row.value_json));
  const entries = () => observer.query<{ count: number }, []>(
    "SELECT count(*) AS count FROM registry_rows WHERE collection='entries'",
  ).get()!.count;
  const pinned = receipts();
  expect(pinned).toHaveLength(1);
  const launchId = pinned[0].launchId;
  const cutoff = phase === "caller" ? Date.parse(pinned[0].queuedPinnedSpawn.admissionDeadlineAt)
    : Date.parse("2026-11-13T12:00:02Z");
  if (phase === "caller") {
    expect(cutoff).toBe(Date.parse("2026-11-13T12:00:00.100Z"));
    send(0);
    expect(await next()).toEqual({ action: "hold", filename });
  }
  const holder = registryLockHolder(filename);
  cleanups.push(() => holder.close());
  await holder.hold();
  const initial = receipts();
  expect(initial).toHaveLength(1);
  expect(initial[0]).toMatchObject({ state: "starting", hostSetup: phase === "post-health"
    ? { phase: "executing", processes: [{}] } : { phase: "preparing", processes: [] } });
  if (phase === "caller" || phase === "post-health") send(0);
  const waiting = phase === "native-PID" || phase === "socket-PID" ? first : await next();
  expect(waiting).toMatchObject({ action: "wait", ms: 25, now: cutoff - (phase === "caller" ? 100 : 2_000) });
  // The parent owns the lock and clock independently of the launch process.
  // Its wake crosses the original writer deadline without another child loop.
  const wake = cutoff + (release === "after" ? 1 : -1);
  if (phase === "caller") expect(wake - waiting.now!).toBeLessThan(2_000);
  expect(wake >= cutoff).toBe(release === "after");
  expect(entries()).toBe(0);
  expect(fs.existsSync(path.join(root, "native-starts"))).toBe(phase === "post-health");
  expect(receipts()).toEqual(initial);
  await holder.release();
  send(wake);
  const result = await next();
  expect(result).toMatchObject({ action: "done", counts: { attempts: 1,
    starts: release === "before" || phase === "post-health" ? 1 : 0, sends: release === "before" ? 1 : 0, waits: 1 },
    delays: [25], dispatches: 1, replay: { status: 200, starts: 0, deferred: 0 } });
  const final = receipts();
  expect(final).toHaveLength(1);
  expect(final[0].launchId).toBe(launchId);
  const expected = release === "after"
    ? { state: "failed", error: FAILURE, hostSetup: { processes: phase === "post-health" ? [{}] : [] } }
    : { state: "completed", hostSetup: { processes: phase === "native-PID" || phase === "socket-PID" ? [{}, {}] : [{}] } };
  expect(final[0]).toMatchObject(expected);
  expect(result).toMatchObject({ replay: { receipts: [{ state: expected.state }] } });
  expect(entries()).toBe(release === "before" ? 1 : 0);
  expect(fs.existsSync(path.join(root, "native-starts"))).toBe(release === "before" || phase === "post-health");
  expect(final[0].conversationId).toBe(pinned[0].conversationId);
  if (release === "after") {
    expect(result).toMatchObject({ replay: { receipts: [{ error: FAILURE }] } });
    expect((result as unknown as { nativeProcesses: Parameters<typeof processIdentityStatus>[0][] })
      .nativeProcesses.every(identity => processIdentityStatus(identity) === "dead")).toBe(true);
    expect(final[0].hostSetup.cleanupConfirmed).toBe(true);
  }
  else expect(fs.readFileSync(path.join(root, "native-starts"), "utf8")).toBe(`${launchId}\n`);
  send(0);
  expect(await child.exited, `${await output}\n${await errors}`).toBe(0);
}, 35_000);

test("a custody wait cannot dispatch after its admission lease was released", async () => {
  const f = await fixture("owner-released");
  const sdk = await connect(f);
  await sdk.call(); await f.drain();
  expect(f.counts()).toEqual({ attempts: 1, starts: 0, sends: 0, waits: 1 });
  expect(Object.values(f.registry.readOnlySnapshot().receipts)).toMatchObject([{ state: "starting", admissionOwner: null }]);
});

test("matching error text without a typed no-write refusal gets no retry", async () => {
  const f = await fixture();
  const refusal = spyOn(f.registry, "recordStructuredHostSetup").mockImplementation(() => { throw new Error(FAILURE); });
  cleanups.push(() => refusal.mockRestore());
  const sdk = await connect(f);
  await sdk.call(); await f.drain();
  expect(f.counts()).toEqual({ attempts: 1, starts: 0, sends: 0, waits: 0 });
  expect(Object.values(f.registry.readOnlySnapshot().receipts)).toMatchObject([{ state: "failed", error: FAILURE }]);
});

test("a delayed wake spends the original custody deadline before another write", async () => {
  const f = await fixture("stalled");
  const sdk = await connect(f);
  await sdk.call(); await f.drain();
  expect(f.delays).toEqual([25]);
  expect(f.counts()).toEqual({ attempts: 1, starts: 0, sends: 0, waits: 1 });
  expect(Object.values(f.registry.readOnlySnapshot().receipts)).toMatchObject([{ state: "failed", error: FAILURE }]);
});

test("a completed writer wait permits a later uncontended exec check", async () => {
  const f = await fixture("repeat");
  const sdk = await connect(f);
  await sdk.call(); await f.drain();
  expect(f.delays).toEqual([25]);
  expect(f.counts()).toEqual({ attempts: 1, starts: 1, sends: 1, waits: 1 });
  expect(Object.values(f.registry.readOnlySnapshot().receipts)).toMatchObject([{ state: "completed" }]);
});

test("an expired launch keeps its terminal refusal when the same request returns in a new process", async () => {
  const f = await fixture("expired");
  const sdk = await connect(f);
  await sdk.call(); await f.drain();
  const replay = await replayInNewProcess(f.submitted());
  expect(replay).toMatchObject({ status: 200, starts: 0, deferred: 0, receipts: [{ state: "failed", error: FAILURE }] });
  expect(replay.receipts).toHaveLength(1);
  expect(f.counts().starts).toBe(0);
});

async function replayInNewProcess(body: Record<string, unknown>) {
  const { TASKS_FILE } = await import("@/lib/tasks/store");
  const source = (name: string) => JSON.stringify(new URL(name, import.meta.url).href);
  const program = `
    const { AgentRegistry } = await import(${source("../agent/registry.ts")});
    const { executeSpawnRequest, productionSpawnCommandDependencies } = await import(${source("../agent/spawnCommand.ts")});
    const { ensureOperatorSpawnCapability } = await import(${source("../agent/operatorCapability.ts")});
    const { VIEWER_SPAWN_CAPABILITY_HEADER } = await import(${source("../agent/spawnPolicy.ts")});
    const { reportSpawnHeaders } = await import(${source("../telegram/reportSpawn.ts")});
    const path = await import("node:path");
    const body = JSON.parse(await Bun.stdin.text());
    const root = body.cwd;
    const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined,
      { sqliteMode: "sqlite", sqliteFilename: path.join(root, "registry.sqlite") });
    const account = { engine: "claude", accountId: "fixture", kind: "managed", home: root,
      transcriptRoot: root, env: { NODE_ENV: "test" } };
    let starts = 0, deferred = 0;
    try {
      const response = await executeSpawnRequest({ json: async () => body,
        headers: reportSpawnHeaders(ensureOperatorSpawnCapability(), VIEWER_SPAWN_CAPABILITY_HEADER) }, {
        ...productionSpawnCommandDependencies, registry: () => registry, autonomousStructured: true,
        resolveHealthySpawnAccount: async () => account, resolveSpawnAccount: () => account,
        assertStructuredRuntime: () => {}, engineReadiness: () => "connected", preflightProtocol: async () => {},
        runtimeHostClient: () => ({}), storeImages: () => [], defer: () => { deferred++; },
        spawnStructuredConversation: async () => { starts++; throw Error("unexpected replay"); },
      });
      console.log(JSON.stringify({ status: response.status, body: await response.json(), starts, deferred,
        receipts: Object.values(registry.readOnlySnapshot().receipts).map(row => ({ state: row.state, error: row.error })) }));
    } finally { registry.close(); }
  `;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", program], {
    env: { ...process.env, LLV_STATE_DIR: path.dirname(TASKS_FILE) }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => { if (child.exitCode === null) child.kill(); }, 15_000);
  cleanups.push(async () => { clearTimeout(timer); if (child.exitCode === null) child.kill(); await child.exited; });
  child.stdin.write(JSON.stringify(body));
  child.stdin.end();
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, err).toBe(0);
  return JSON.parse(out);
}
