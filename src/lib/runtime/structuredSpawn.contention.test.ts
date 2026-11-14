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
import { captureProcessIdentity } from "@/lib/processIdentity";
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
import { spawnManagedEngine } from "./agentSignalSandbox";
import { spawnStructuredConversation, type SpawnedStructuredHost } from "./structuredSpawn";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const FAILURE = `${REGISTRY_WRITER_BUSY} (spawn.setup-custody)`;

interface CustodyControl {
  queued: (filename: string) => Promise<void>;
  hold: (filename: string) => Promise<void>;
  release: () => Promise<void>;
  sleep: (ms: number, now: number) => Promise<number>;
}

async function fixture(held: "released" | "expired" | "revoked" | "owner-released" | "pipeline" | "stalled" | "repeat" = "released", retryMs?: number, queuedDeadlineMs?: number, control?: CustodyControl) {
  let sequence = 0;
  const ids = spyOn(crypto, "randomUUID").mockImplementation(() =>
    `00008000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`);
  cleanups.push(() => ids.mockRestore());
  const saved = { ...process.env };
  cleanups.push(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  const storage = sqliteRegistryFixture("launch-custody");
  cleanups.push(storage.cleanup);
  const { registry, root } = storage;
  setAgentRegistryForTests(registry);
  cleanups.push(() => { setAgentRegistryForTests(null); registry.close(); });
  Object.assign(process.env, { LLV_SPAWN_TRANSPORT: "structured", LLV_STRUCTURED_HOSTS: "1",
    LLV_RUNTIME_EVENTS: "1", NEXT_PUBLIC_RUNTIME_UI: "1", LLV_STATE_DIR: path.join(root, "state"),
    LLV_RUNTIME_HOST_SOCKET: path.join(root, "unused.sock") });
  const holder = control
    ? { hold: () => control.hold(storage.sqliteFilename), release: control.release }
    : registryLockHolder(storage.sqliteFilename);
  if ("close" in holder) cleanups.push(() => holder.close());
  const journal = new RuntimeJournal(path.join(root, "runtime.sqlite"), { structuredHosts: true });
  cleanups.push(() => journal.close());
  const runtime = {
    command: async (command: Parameters<RuntimeHostClient["command"]>[0]) => journal.executeOperation(command),
    transitionOperation: async (...args: Parameters<RuntimeHostClient["transitionOperation"]>) => journal.transitionOperation(...args),
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
  const spec = { engine: "claude", model: "opus", cwd: root, title: "Inspect fixture", prompt: "Inspect fixture", mcpServers: [] };
  const launch = async (body: Record<string, unknown>, authorize?: () => void) => {
    submitted = body;
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
            expect(starts).toBe(0);
            expect(sends).toBe(0);
            expect(registry.spawnReceipt(input.receipt.launchId)).toMatchObject({ state: "starting",
              hostSetup: { phase: "preparing", processes: [] } });
            delays.push(ms); waits++;
            if (control) { clock = await control.sleep(ms, clock); return; }
            clock += ms;
            if (held === "stalled") clock += 5_000;
            if (held === "revoked") authorized = false;
            if (held !== "expired") await holder.release();
            if (held === "owner-released") registry.releaseStartingStructuredSpawn(input.receipt.launchId, input.receipt.admissionOwner!);
          },
          startHost: async current => {
            launchIds.push(current.receipt.launchId);
            attempts++;
            await holder.hold();
            let child: ChildProcessWithoutNullStreams | undefined;
            let close: (() => Promise<void>) | undefined;
            try {
              if (held === "repeat") {
                await spawnManagedEngine("fixture-permit", [], { env: account.env }, null,
                  () => ({} as ChildProcessWithoutNullStreams));
                clock += 5_000;
              }
              await spawnManagedEngine("fixture-engine", [], { env: account.env }, null, () => {
                starts++;
                if (control) fs.appendFileSync(path.join(root, "native-starts"), `${current.receipt.launchId}\n`);
                child = spawn(process.execPath, ["--no-env-file", "-e", "setInterval(() => {}, 1000)"], {
                  env: { NODE_ENV: "test", PATH: process.env.PATH }, stdio: ["pipe", "pipe", "pipe"],
                });
                const closed = new Promise<void>(resolve => child!.once("close", () => resolve()));
                const owned = child;
                close = async () => { if (owned.exitCode === null && owned.signalCode === null) owned.kill("SIGKILL"); await closed; };
                cleanups.push(close);
                return child;
              });
            }
            catch (error) {
              if (!control) await holder.release();
              throw error;
            }
            await holder.release();
            const artifact = current.spec.transcript ?? claudeTranscriptPath(root, crypto.randomUUID(), root);
            const sessionId = path.basename(artifact, ".jsonl");
            fs.mkdirSync(path.dirname(artifact), { recursive: true });
            fs.writeFileSync(artifact, JSON.stringify({ type: "user", message: { role: "user", content: "Fixture" } }) + "\n");
            return { engine: "claude", identity: { sessionId },
              health: async () => ({ status: "idle", pid: child!.pid, endpoint: "fixture:stdio", eventCursor: 0,
                processStartIdentity: captureProcessIdentity(child!.pid!).startIdentity,
                protocolVersion: "fixture", activeTurnRef: null, pendingAttention: [], activeFlags: [] }),
              release: async () => close!(), onStateChange: () => () => {},
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
        }).finally(() => holder.release());
      },
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { root, registry, launch, spec, launchIds, journal, delays, submitted: () => submitted,
    drain: async () => { for (const work of pending.splice(0)) await work(); },
    counts: () => ({ attempts, starts, sends, waits }),
  };
}

for (const held of ["released", "expired"] as const) test(`owner relay launch with custody writer ${held}`, async () => {
  const f = await fixture(held);
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
  expect(result?.outcome).toBe("answered");
  expect(delivered).toEqual([held === "released" ? "Fixture answer" : "Please try again."]);
  expect(f.counts().starts).toBe(held === "released" ? 1 : 0);
  expect(f.counts().sends).toBe(held === "released" ? 1 : 0);
  expect(Object.values(f.registry.readOnlySnapshot().receipts)).toHaveLength(1);
  expect(new Set(f.launchIds).size).toBe(1);
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
  return { call: () => client.callTool({ name: "spawn_agent", arguments: { ...f.spec, clientRequestId: "custody-spawn" } }),
    dispatches: () => dispatches };
}

for (const held of ["released", "expired", "revoked"] as const) test(`SDK spawn_agent with custody writer ${held}`, async () => {
  const f = await fixture(held);
  const sdk = await connect(f);
  const answer = await sdk.call();
  expect(answer.isError, JSON.stringify(answer)).not.toBe(true);
  await f.drain();
  const receipts = Object.values(f.registry.readOnlySnapshot().receipts);
  expect(receipts).toHaveLength(1);
  expect(new Set(f.launchIds).size).toBe(1);
  expect(f.counts().starts).toBe(held === "released" ? 1 : 0);
  expect(f.counts().sends).toBe(held === "released" ? 1 : 0);
  if (held === "released") {
    expect(receipts[0]!.state).toBe("completed");
    expect(receipts[0]!.hostSetup!.processes).toHaveLength(1);
    expect(Object.values(f.registry.readOnlySnapshot().entries)).toHaveLength(1);
  }
  else expect(receipts[0]).toMatchObject({ state: "failed", error: held === "expired" ? FAILURE : "fixture authority revoked" });
  if (held !== "expired") expect(f.counts().waits).toBe(1);
  else {
    expect(f.counts().waits).toBeGreaterThan(1);
    expect(f.delays.reduce((sum, ms) => sum + ms, 0)).toBe(2_000);
    expect(Math.max(...f.delays)).toBeLessThanOrEqual(250);
  }
  expect((await sdk.call()).isError).not.toBe(true);
  expect(sdk.dispatches()).toBe(1);
  expect(Object.values(f.registry.readOnlySnapshot().receipts)).toHaveLength(1);
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

for (const release of ["before", "after"] as const) test(`parent controls custody release ${release} the caller cutoff`, async () => {
  const childMode = process.env.LLV_CUSTODY_DEADLINE_CHILD;
  if (childMode && childMode !== release) return;
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
    const f = await fixture("released", undefined, 100, {
      queued: async filename => { await request("queued", { filename }); },
      hold: async filename => { await request("hold", { filename }); },
      // The parent owns the writer and releases it before acknowledging sleep.
      release: async () => {},
      sleep: (ms, now) => request("wait", { ms, now }),
    });
    const sdk = await connect(f);
    await sdk.call(); await f.drain();
    const replay = await replayInNewProcess(f.submitted());
    await sdk.call(); await f.drain();
    await request("done", { counts: f.counts(), delays: f.delays, dispatches: sdk.dispatches(), replay });
    return;
  }
  type Message = { action: string; filename?: string; ms?: number; now?: number };
  let received = Promise.withResolvers<Message>();
  const child = Bun.spawn([process.execPath, "test", import.meta.filename, "--test-name-pattern",
    `parent controls custody release ${release} the caller cutoff`], {
    env: { ...process.env, LLV_CUSTODY_DEADLINE_CHILD: release }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
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
  const queued = await next();
  expect(queued.action).toBe("queued");
  const filename = queued.filename!;
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
  const cutoff = Date.parse(pinned[0].queuedPinnedSpawn.admissionDeadlineAt);
  expect(cutoff).toBe(Date.parse("2026-11-13T12:00:00.100Z"));
  send(0);
  expect(await next()).toEqual({ action: "hold", filename });
  const holder = registryLockHolder(filename);
  cleanups.push(() => holder.close());
  await holder.hold();
  const initial = receipts();
  expect(initial).toHaveLength(1);
  expect(initial[0]).toMatchObject({ state: "starting", hostSetup: { phase: "preparing", processes: [] } });
  send(0);
  const waiting = await next();
  expect(waiting).toMatchObject({ action: "wait", ms: 25, now: cutoff - 100 });
  // The parent chooses the wake independently of the requested delay. Both
  // wakes leave the writer's 2000ms budget and durable setup bound unspent.
  const wake = cutoff + (release === "after" ? 1 : -1);
  expect(wake - waiting.now!).toBeLessThan(2_000);
  expect(wake >= cutoff).toBe(release === "after");
  expect(entries()).toBe(0);
  expect(fs.existsSync(path.join(root, "native-starts"))).toBe(false);
  expect(receipts()).toEqual(initial);
  await holder.release();
  send(wake);
  const result = await next();
  expect(result).toMatchObject({ action: "done", counts: { attempts: 1,
    starts: release === "before" ? 1 : 0, sends: release === "before" ? 1 : 0, waits: 1 },
    delays: [25], dispatches: 1, replay: { status: 200, starts: 0, deferred: 0 } });
  const final = receipts();
  expect(final).toHaveLength(1);
  expect(final[0].launchId).toBe(launchId);
  const expected = release === "after"
    ? { state: "failed", error: FAILURE, hostSetup: { processes: [] } }
    : { state: "completed", hostSetup: { processes: [{}] } };
  expect(final[0]).toMatchObject(expected);
  expect(result).toMatchObject({ replay: { receipts: [{ state: expected.state }] } });
  expect(entries()).toBe(release === "before" ? 1 : 0);
  expect(fs.existsSync(path.join(root, "native-starts"))).toBe(release === "before");
  if (release === "after") expect(result).toMatchObject({ replay: { receipts: [{ error: FAILURE }] } });
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
    env: { ...process.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => { if (child.exitCode === null) child.kill(); }, 15_000);
  cleanups.push(async () => { clearTimeout(timer); if (child.exitCode === null) child.kill(); await child.exited; });
  child.stdin.write(JSON.stringify(body));
  child.stdin.end();
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, err).toBe(0);
  return JSON.parse(out);
}
