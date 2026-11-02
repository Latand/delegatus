import { afterAll, expect, test, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import crypto from "node:crypto";
import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { accountManager } from "@/lib/accounts/manager";
import { RuntimeJournal } from "@/runtime-host/journal";
import * as runtimeModule from "@/lib/runtime/client";
import * as spawnModule from "@/lib/runtime/structuredSpawn";
import * as guardModule from "@/lib/git/stageAttemptGuard";
import { bindStructuredDeliveryQueue, releaseStructuredDeliveryHost } from "@/lib/runtime/structuredDeliveryController";
import { defaultPipelinePorts, getPipeline } from "./engine";
import { viewerMcpBindings, viewerMcpToolPolicy, type CallerAttribution } from "@/lib/mcp/bindings";
import { createMcpToolService, createViewerMcpServer, MemoryMcpReceiptStore } from "@/lib/mcp/server";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import type { SpawnedStructuredHost } from "@/lib/runtime/structuredSpawn";
import type { HostState, QueueEntry, RuntimeEvent, DeliveryReceipt } from "@/lib/runtime/engineHost";

import type { FileEntry } from "@/lib/types";

/* Real next-attempt spawn and delivery with a private registry and runtime journal. */
const previousStateDir = process.env.LLV_STATE_DIR;
const stateRoot = process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stage-prompt-launch-"));
const { createPipelineFromRequest, patchPipeline, tickPipelines } = await import("./engine");
const { registerPipelineTick } = await import("./controllerSignal");
const { loadPipelines, savePipelines } = await import("./store");
type PipelinePorts = import("./engine").PipelinePorts;
type SpawnInput = Parameters<PipelinePorts["spawnAgent"]>[0];

registerPipelineTick(async () => {});
afterAll(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(stateRoot, { recursive: true, force: true });
});

const HEAD = "48c739bbcc87b3244aee7fb0e2d1b3f8e312548f";

function entry(pathname: string): FileEntry {
  return {
    path: pathname, root: "codex-sessions", name: path.basename(pathname), project: "viewer", title: "stage", engine: "codex",
    kind: "session", fmt: "codex", parent: null, mtime: 2_000, size: 10, activity: "idle", proc: null, pid: null,
    model: null, pendingQuestion: null, waitingInput: null,
  };
}

function harness() {
  const messages = new Map<string, { text: string; ts: number }>();
  const spawns: SpawnInput[] = [];
  let clock = 1_000_000;
  const ports: PipelinePorts = {
    exec: (rawCommand, rawArgs) => {
      const args = rawCommand === "timeout" ? rawArgs.slice(rawArgs.indexOf("git") + 1) : rawArgs;
      if (args[0] === "remote") return { code: 0, stdout: args[1] === "get-url" ? "https://example.invalid/project.git\n" : "origin\n", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--git-dir") return { code: 0, stdout: ".git\n", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { code: 0, stdout: "main\n", stderr: "" };
      if (args[0] === "branch" && args[1] === "--show-current") return { code: 0, stdout: `${loadPipelines()[0]?.branch ?? ""}\n`, stderr: "" };
      if (args[0] === "rev-parse") return { code: 0, stdout: `${HEAD}\n`, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    preflightRepo: (repoDir) => ({ ok: true, repoDir, gitCommonDir: path.join(repoDir, ".git"), worktreeParent: path.dirname(repoDir) }),
    roleLookup: (roleId) => roleId === "builder"
      ? { engine: "codex", model: "gpt-5.6-sol", effort: "medium", access: "read-write", promptScaffold: "Builder guidance" }
      : null,
    spawnReceipt: () => null,
    claimSpawnRetry: () => "claimed",
    spawnAgent: async (input, onReserved) => {
      spawns.push(structuredClone(input));
      const n = spawns.length;
      onReserved({ launchId: `launch-${n}`, conversationId: `conversation_stage_${n}`, accountId: "account-a" });
      return { launchId: `launch-${n}`, conversationId: `conversation_stage_${n}`, sessionId: `session-${n}`, transcript: `/codex/stage-${n}.jsonl`, paneId: `%${n}`, accountId: "account-a" };
    },
    paneAgentAlive: async () => true,
    stopStageAgent: async () => ({ outcome: "not-running" }),
    stopStagePane: async () => ({ outcome: "stopped" }),
    stageHostResident: async () => false,
    monotonicNow: () => 1_000,
    worktreePresent: () => true,
    conversationAgentActive: async () => null,
    durableTurnEvidence: async () => null,
    headCwd: () => loadPipelines()[0]?.worktreeDir ?? null,
    lastMessage: (item) => messages.get(item.path) ?? null,
    pathForConversation: (id) => {
      const n = /^conversation_stage_(\d+)$/.exec(id)?.[1];
      return n ? `/codex/stage-${n}.jsonl` : null;
    },
    sourcePathAllowed: (pathname) => pathname.startsWith("/codex/") && pathname.endsWith(".jsonl"),
    conversationIdForPath: (pathname) => {
      if (pathname === "/codex/creator.jsonl") return "conversation_creator";
      const n = /stage-(\d+)\.jsonl$/.exec(pathname)?.[1];
      return n ? `conversation_stage_${n}` : null;
    },
    pipelineAdoptionCandidates: () => [],
    createFlow: async () => ({ error: "no review flows in this suite" }),
    patchFlow: () => ({}),
    closeFlow: async () => ({}),
    getFlow: () => null,
    findFlow: () => null,
    projectForCwd: () => "viewer",
    now: () => new Date((clock += 1_000)).toISOString(),
  };
  /** Ends the turn of the stage spawned `n`th with a verdict. */
  const finish = (n: number, status: "pass" | "fail") => {
    const pathname = `/codex/stage-${n}.jsonl`;
    messages.set(pathname, { text: `done\n\n\`\`\`json\n${JSON.stringify({ status, findings: status === "fail" ? ["broken"] : [] })}\n\`\`\``, ts: clock + 100_000 });
    return entry(pathname);
  };
  return { ports, finish, spawnedStages: () => spawns.map((spawn) => spawn.membership.stageId) };
}

const stage = (id: string, next: string | null, extra: Record<string, unknown> = {}) =>
  ({ id, kind: "run", role: { roleId: "builder" }, prompt: `Do ${id}`, next, ...extra });

async function started(ports: PipelinePorts, stages: unknown[]): Promise<string> {
  savePipelines([]);
  const created = await createPipelineFromRequest({ task: "Stage prompt launch", spec: "AC", repoDir: path.join(process.env.LLV_STATE_DIR!, "repo"), stages: stages as never, src: "/codex/creator.jsonl", publication: "internal" }, ports);
  if (!created.pipeline) throw new Error(created.error);
  await tickPipelines([], ports); // provision
  await tickPipelines([], ports); // spawn the entry stage
  return created.pipeline.id;
}

const current = () => loadPipelines()[0]!;
const attemptsOf = (stageId: string) => current().runs.find((run) => run.stageId === stageId)!.attempts;


type UnsequencedEvent = RuntimeEvent extends infer Event ? Event extends RuntimeEvent ? Omit<Event,"seq"> : never : never;
function runtimeClient(journal: RuntimeJournal): RuntimeHostClient {
  return {
    readSession: async (identity) => journal.readSession(identity),
    snapshot: async () => journal.snapshot(),
    events: async (after) => journal.replay(after),
    waitEvents: async (after) => journal.replay(after),
    append: async (event) => journal.append(event),
    operation: async (event) => journal.append(event),
    command: async (command) => journal.executeOperation(command),
    operationStatus: async (operationId) => journal.operationResult(operationId),
    retryOperation: async (operationId) => journal.retryOperation(operationId),
    producerCursor: async (producerKind, eventKeyPrefix) => journal.producerCursor(producerKind, eventKeyPrefix),
    effectBatch: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
    transitionOperation: async (operationId, status, details) => journal.transitionOperation(operationId, status, details),
  } as RuntimeHostClient;
}

class RoundTripHost implements SpawnedStructuredHost {
  readonly sent: QueueEntry[] = [];
  readonly identity: { threadId: string; path: string } | { sessionId: string };
  private readonly listeners = new Set<(state: HostState) => void>();
  private readonly events: RuntimeEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private cursor = 0;
  private status: HostState["status"] = "idle";
  private activeTurnRef: string | null = null;
  private pendingAttention: string[] = [];
  private released = false;

  constructor(
    readonly engine: "codex" | "claude",
    readonly artifactPath: string,
    sessionId: string,
  ) {
    this.identity = engine === "codex" ? { threadId: sessionId, path: artifactPath } : { sessionId };
  }

  async sessionMaterializationEvidence(): Promise<{ state: "materialized" }> {
    return { state: "materialized" };
  }

  private materializeTranscript(): void {
    const transcriptHasContent = (() => {
      try { return fs.statSync(this.artifactPath).size > 0; }
      catch { return false; }
    })();
    if (transcriptHasContent) return;
    const sessionId = this.engine === "codex"
      ? (this.identity as { threadId: string }).threadId
      : (this.identity as { sessionId: string }).sessionId;
    const record = this.engine === "codex"
      ? { type: "session_meta", payload: { id: sessionId } }
      : { type: "user", message: { role: "user", content: "fixture prompt" } };
    fs.mkdirSync(path.dirname(this.artifactPath), { recursive: true });
    fs.writeFileSync(this.artifactPath, `${JSON.stringify(record)}\n`);
  }

  setWriterFence(fence: () => boolean): void {
    void fence;
  }

  onStateChange(listener: (state: HostState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  attach(afterSeq: number): AsyncIterable<RuntimeEvent> {
    const isReleased = () => this.released;
    const eventAfter = (cursor: number) => this.events.find((candidate) => candidate.seq > cursor);
    const waitForEvent = () => new Promise<void>((resolve) => this.waiters.add(resolve));
    return {
      async *[Symbol.asyncIterator]() {
        let cursor = afterSeq;
        while (!isReleased()) {
          const event = eventAfter(cursor);
          if (event) {
            cursor = event.seq;
            yield event;
            continue;
          }
          await waitForEvent();
        }
      },
    };
  }

  async send(entry: QueueEntry): Promise<DeliveryReceipt> {
    this.sent.push({ ...entry });
    const turnId = `turn-${this.sent.length}`;
    this.status = "active";
    this.activeTurnRef = turnId;
    this.emit({ kind: "turn-started", turnId });
    this.notify();
    return { outcome: "turn-started", turnId };
  }

  async answer(): Promise<void> { throw new Error("unexpected answer"); }
  async interrupt(): Promise<void> { throw new Error("unexpected interrupt"); }

  async health(): Promise<HostState> {
    this.materializeTranscript();
    return {
      status: this.status,
      sessionKey: this.engine === "codex" ? (this.identity as { threadId: string }).threadId : (this.identity as { sessionId: string }).sessionId,
      endpoint: "fake:stdio",
      pid: process.pid,
      processStartIdentity: "test-process",
      eventCursor: this.cursor,
      protocolVersion: "fake-v1",
      activeTurnRef: this.activeTurnRef,
      pendingAttention: [...this.pendingAttention],
      activeFlags: [],
      account: { type: this.engine === "codex" ? "chatgpt" : "claude.ai", planType: "subscription" },
    };
  }

  async release(): Promise<void> {
    this.released = true;
    this.status = "unhosted";
    this.activeTurnRef = null;
    this.pendingAttention = [];
    this.emit({ kind: "session-status", status: "unhosted" });
    const state = await this.health();
    for (const listener of this.listeners) listener(state);
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  private emit(event: UnsequencedEvent): void {
    this.cursor += 1;
    this.events.push({ ...event, seq: this.cursor } as RuntimeEvent);
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  private notify(): void {
    void this.health().then((state) => {
      for (const listener of this.listeners) listener(state);
    });
  }
}


const cases = (["unchanged", "seat", "operator"] as const).flatMap(editor => [false, true].map(expiry => ({ editor, expiry })));
test.each(cases)("next review launch: %j", async ({ editor, expiry }) => {
  const edit = editor !== "unchanged";
  const h = harness();
  const exec = h.ports.exec;
  h.ports.exec = async (command, args, ...rest) => args[0] === "rev-parse" && args[1] === "--show-toplevel"
    ? { code: 1, stdout: "", stderr: "plain fixture directory" } : exec(command, args, ...rest);
  const lookup = h.ports.roleLookup!;
  h.ports.roleLookup = roleId => roleId === "reviewer" ? { engine: "codex", model: "gpt-6.1-sol", effort: "high", access: "read-only", promptScaffold: "Reviewer fixture" } : lookup(roleId);
  const id = await started(h.ports, [stage("build", "review"), stage("review", null, { role: { roleId: "reviewer" }, onFail: { to: "build", maxRounds: 2 } })]);
  await tickPipelines([h.finish(1, "pass")], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish(2, "fail")], h.ports);
  await tickPipelines([], h.ports);
  expect(h.spawnedStages()).toEqual(["build", "review", "build"]);
  let caller: CallerAttribution = { kind: "agent", conversationId: "conversation_reporter", role: "issue-reporter" };
  const domain = {
    callerAttribution: () => caller,
    attentionAuthority: () => caller.conversationId
      ? { kind: "worker" as const, conversationId: caller.conversationId, role: caller.role ?? null }
      : { kind: "unidentified" as const },
    readPipelineRecord: getPipeline,
    patchPipeline: (pipelineId: string, request: Parameters<typeof patchPipeline>[1], _ports?: Parameters<typeof patchPipeline>[2], actor?: Parameters<typeof patchPipeline>[3]) => patchPipeline(pipelineId, request, h.ports, actor),
  };
  const bindings = viewerMcpBindings(undefined, undefined, domain as Parameters<typeof viewerMcpBindings>[2]);
  const sdkServer = createViewerMcpServer(createMcpToolService(bindings, new MemoryMcpReceiptStore(), viewerMcpToolPolicy(domain as Parameters<typeof viewerMcpToolPolicy>[0])));
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID(), enableJsonResponse: true });
  await sdkServer.connect(transport);
  const http = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => transport.handleRequest(req) });
  const sdk = new Client({ name: "stage-prompt-launch", version: "1" });
  const request = { pipelineId: id, action: "override-stage", stageId: "review", prompt: "Review the updated scope" };
  try {
    await sdk.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.port}/mcp`)));
    const before = structuredClone(current());
    const refused = await sdk.callTool({ name: "pipeline_action", arguments: { ...request, clientRequestId: "reporter-override" } });
    expect(refused.isError).toBe(true);
    expect(current()).toEqual(before);
    caller = { kind: "manager", conversationId: "conversation_orchestrator", role: "orchestrator" };
    if (editor === "seat") {
      const response = await sdk.callTool({ name: "pipeline_action", arguments: { ...request, clientRequestId: "seat-override" } });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
    } else if (editor === "operator") {
      expect((await patchPipeline(id, { ...request, action: "override-stage" }, h.ports, { kind: "operator" })).error).toBeUndefined();
    }
    if (edit) {
      expect(current().graphEdits?.at(-1)).toMatchObject({ appliesFromAttempt: 2, action: "override-stage",
        actor: editor === "operator" ? { kind: "operator" } : { kind: "agent", conversationId: "conversation_orchestrator", role: "orchestrator" } });
    }
  } finally {
    await sdk.close(); await sdkServer.close(); http.stop(true);
  }
  await tickPipelines([h.finish(3, "pass")], h.ports);
  const lane = current();
  fs.mkdirSync(lane.repoDir, { recursive: true }); fs.mkdirSync(lane.worktreeDir!, { recursive: true });
  const binary = path.join(process.env.LLV_STATE_DIR!, "codex-catalog-fixture");
  fs.writeFileSync(binary, "#!/bin/sh\nprintf '[]\\n'\n", { mode: 0o700 });
  const previousBinary = process.env.LLV_CODEX_BINARY;
  process.env.LLV_CODEX_BINARY = binary;
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, `registry-${editor}-${expiry}.json`));
  setAgentRegistryForTests(registry);
  const journal = new RuntimeJournal(path.join(process.env.LLV_STATE_DIR!, `runtime-${editor}-${expiry}.sqlite`), { structuredHosts: true });
  const client = runtimeClient(journal);
  let clock = 1_000;
  const time = spyOn(performance, "now").mockImplementation(() => clock);
  const resolve = spyOn(accountManager, "resolveProjectSpawn").mockReturnValue({ kind: "available", account: {
    engine: "codex", accountId: "fixture-account", kind: "managed", home: process.env.LLV_CODEX_HOME!, transcriptRoot: path.join(process.env.LLV_CODEX_HOME!, "sessions"), env: { NODE_ENV: "test" },
  } });
  const runtime = spyOn(runtimeModule, "runtimeHostClient").mockReturnValue(client);
  const guard = spyOn(guardModule, "prepareStageGitGuard").mockResolvedValue({});
  const originalSpawn = spawnModule.spawnStructuredConversation;
  const session = "11111111-1111-\x34111-8111-111111111111";
  const artifact = path.join(process.env.LLV_CODEX_HOME!, "sessions", `${editor}-${expiry}`, "2026", "10", "30", `rollout-2026-10-30T00-00-00-${session}.jsonl`);
  const host = new RoundTripHost("codex", artifact, session);
  const identity = { pid: process.pid, startIdentity: "test-process" };
  let underlying: string | null = null;
  const wrap = spyOn(spawnModule, "spawnStructuredConversation").mockImplementation(async input => {
    const authorize = input.authorize;
    return originalSpawn({ ...input, authorize: async () => { try { await authorize?.(); } catch (e) { underlying = String(e); throw e; } } }, {
      startHost: async () => host,
      bindHost: async (store,key,running,owner,epoch) => {
        const state = await running.health();
        if (!store.setStructuredHostClaimed(key, { kind: "codex-app-server", endpoint: state.endpoint, process: identity,
          eventCursor: state.eventCursor, protocolVersion: state.protocolVersion, writerClaimEpoch: epoch,
          activeTurnRef: state.activeTurnRef, pendingAttention: state.pendingAttention, activeFlags: state.activeFlags }, "idle",owner,epoch)) throw Error("bind failed");
        return () => {};
      }, processIdentity: () => identity,
    });
  });
  const claim = registry.beginDeliveryAttemptOffLoop.bind(registry);
  const claimSpy = spyOn(registry, "beginDeliveryAttemptOffLoop").mockImplementation(async (...args) => {
    const result = await claim(...args);
    if (expiry) clock += 20 * 60_000;
    return result;
  });
  try {
    await bindStructuredDeliveryQueue([], { registry, client, deferStartupWork: true });
    const defaults = defaultPipelinePorts();
    h.ports.spawnAgent = defaults.spawnAgent;
    h.ports.spawnReceipt = defaults.spawnReceipt;
    h.ports.claimSpawnRetry = defaults.claimSpawnRetry;
    await tickPipelines([], h.ports);
    const attempt = attemptsOf("review").at(-1)!;
    expect(attempt.n).toBe(2);
    expect(attempt.definition?.prompt).toBe(edit ? "Review the updated scope" : "Do review");
    if (expiry) {
      expect(host.sent).toHaveLength(0);
      expect(String(underlying)).toContain("lane deadline exhausted");
      expect(journal.operationResult(`spawn_message_${attempt.launchId}`)).toBeNull();
      expect([attempt.error, current().stateDetail].filter(Boolean).join("\n")).toContain("lane deadline exhausted");
      expect(Object.values(registry.snapshot().deliveryOperationOwners).map(o => o.terminalDisposition)).toEqual(["lost"]);
    } else {
      expect(attempt.error).toBeNull();
      expect(attempt.state).toBe("running");
      expect(host.sent).toHaveLength(1);
      expect(host.sent[0]!.content?.text ?? host.sent[0]!.text).toContain(edit ? "Review the updated scope" : "Do review");
    }
  } finally {
    if (previousBinary === undefined) delete process.env.LLV_CODEX_BINARY;
    else process.env.LLV_CODEX_BINARY = previousBinary;
    claimSpy.mockRestore(); wrap.mockRestore(); guard.mockRestore(); runtime.mockRestore(); resolve.mockRestore(); time.mockRestore();
    await releaseStructuredDeliveryHost({ engine: "codex", sessionId: session }); await bindStructuredDeliveryQueue([]); await host.release(); journal.close(); setAgentRegistryForTests(null); registry.close();
  }
}, 30_000);
