import os from "node:os";
import { spawn } from "node:child_process";
import { expect, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { NextRequest } from "next/server";
import { ownFixtureTree, stopFixtureTree } from "@/lib/testing/fixtureProcess";
import { captureProcessIdentity } from "@/lib/processIdentity";
import * as startupActivity from "@/lib/scanner/activity";
import * as pipelineState from "@/lib/state/sqliteStateStore";
import { bindStructuredDeliveryQueue, publishStructuredDeliveryHost } from "./structuredDeliveryController";
import { kickStructuredDeliveryQueue } from "./structuredDeliverySignal";
import { enqueueStructuredMessage } from "./structuredMessageDelivery";
import { adoptStructuredHostsAtStartup } from "./startup";
import * as startupRecipient from "./startup";
import { interruptionObligationDirectory, interruptionObligationStore } from "./interruptionObligations";
import { CodexAppServerHost } from "./codexAppServerHost";
import fs from "node:fs";
import path from "node:path";
import { AgentRegistry } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { buildPipeline, savePipelines } from "@/lib/pipelines/store";
import type { OrchestratorSeat } from "@/lib/orchestrator/seats";
import { RuntimeJournal } from "@/runtime-host/journal";
import type { RuntimeHostClient } from "./client";

export function runtimeJournalClient(journal: RuntimeJournal): RuntimeHostClient {
  return {
    readSession: async (identity) => journal.readSession(identity),
    snapshot: async () => journal.snapshot(),
    append: async (event) => journal.append(event),
    command: async (command) => journal.executeOperation(command),
    operationStatus: async (operationId, options) => options?.currentRetryLeaf
      ? journal.currentRetryResult(operationId)
      : journal.operationResult(operationId),
    retryOperation: async (operationId, nextIdempotencyKey, options) =>
      journal.retryOperation(operationId, nextIdempotencyKey, options),
    effectBatch: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
    transitionOperation: async (operationId, status, details) => journal.transitionOperation(operationId, status, details),
  } as RuntimeHostClient;
}

export function structuredRestartFixture(
  directory: string,
  engine: "codex" | "claude",
  status: "dead" | "unhosted" = "dead",
  structured = true,
) {
  const sessionId = engine === "codex"
    ? "aaaaaaaa-aaaa-0aaa-0aaa-aaaaaaaaaaaa"
    : "bbbbbbbb-bbbb-0bbb-0bbb-bbbbbbbbbbbb";
  const artifactPath = path.join(directory, `${sessionId}.jsonl`);
  fs.writeFileSync(artifactPath, "");
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const conversation = registry.ensureConversation(engine, artifactPath, null);
  registry.upsert({
    key: { engine, sessionId },
    artifactPath,
    cwd: directory,
    accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: directory }),
    status,
    host: null,
    structuredHost: structured ? {
      kind: engine === "codex" ? "codex-app-server" : "claude-broker",
      endpoint: "stdio:released",
      process: null,
      eventCursor: 4,
      protocolVersion: "test",
      writerClaimEpoch: 2,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    } : null,
    claimEpoch: 2,
    claimOwner: null,
    pendingAction: null,
  });
  return { artifactPath, conversation, registry, sessionId };
}

export function projectHostedRestart(
  journal: RuntimeJournal,
  engine: "codex" | "claude",
  conversationId: string,
  sessionId: string,
  directory: string,
  artifactPath: string,
  turn: "idle" | "running" = "idle",
): void {
  journal.append({
    scope: { type: "session", id: conversationId },
    kind: "session-status",
    producer: {
      kind: engine === "codex" ? "codex-app-server" : "claude-broker",
      eventKey: `recovered-${engine}-restart`,
    },
    payload: {
      conversationId,
      sessionKey: { engine, sessionId },
      hostKind: engine === "codex" ? "codex-app-server" : "claude-broker",
      host: "hosted",
      turn,
      provenance: "structured",
      accountId: null,
      parentConversationId: null,
      cwd: directory,
      artifactPath,
      capabilities: { steer: engine === "codex", structuredAttention: true },
      activeTurnId: turn === "running" ? "runtime-running-turn" : null,
    },
  });
}

export async function waitFor(predicate: () => boolean, attempts = 100): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("startup delivery did not settle");
}

export function recipientDispatchPipeline(conversationId?: `conversation_${string}`) {
  const pipeline = buildPipeline({ id: "recipient-dispatch-pipeline", task: "synthetic dispatch authority", project: "synthetic", repoDir: "/repo",
    stages: [{ id: "build", kind: "run", prompt: "build", next: null, effectiveRole: { roleId: null, engine: "codex", model: "gpt-5.6-sol", effort: "medium", access: "read-write", promptScaffold: null } }],
    srcPath: null, srcConversationId: null, now: "2026-07-01T00:00:00.000Z" });
  if (conversationId) pipeline.runs[0]!.attempts.push({
    n: 1, state: "running", conversationId, flowId: null, launchId: null, sessionId: null, agentPath: null, paneId: null,
    startedAt: pipeline.createdAt, completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: null,
    effectiveRole: pipeline.stages[0]!.effectiveRole,
  });
  return pipeline;
}

/** The transcript a seat with a turn in flight leaves behind: an unanswered
    tool call. The registry's turn word is not evidence and no longer reaches
    the liveness decision (#1281), so a fixture that means "this turn was in
    flight when the restart cut it off" has to write the events that say so. */
export function openTurnRecords(engine: "codex" | "claude"): Record<string, unknown>[] {
  return engine === "codex"
    ? [
      { payload: { type: "user_message" }, timestamp: "2026-07-15T05:59:00.000Z" },
      { payload: { type: "function_call", call_id: "c1" }, timestamp: "2026-07-15T05:59:30.000Z" },
    ]
    : [
      { type: "user", timestamp: "2026-07-15T05:59:00.000Z", message: { content: "go" } },
      {
        type: "assistant",
        timestamp: "2026-07-15T05:59:30.000Z",
        message: { content: [{ type: "tool_use", id: "t1", name: "Bash" }] },
      },
    ];
}

export function recentTurnRecords(engine: "codex" | "claude"): Record<string, unknown>[] {
  return openTurnRecords(engine).map((record, index) => ({
    ...record, timestamp: new Date(Date.now() - 60_000 + index * 1_000).toISOString(),
  }));
}

export function addStructuredRestartConversation(
  registry: AgentRegistry,
  directory: string,
  input: {
    engine?: "codex" | "claude";
    sessionId: string;
    status: "live" | "idle" | "dead" | "unhosted";
    turn: "busy" | "idle" | "terminal" | "unknown";
    activeTurnRef?: string | null;
    endpoint?: string;
    transcriptRecords?: Record<string, unknown>[];
    transcriptSuffix?: string;
    alignFirstRecordToTailBoundary?: boolean;
  },
) {
  const engine = input.engine ?? "codex";
  const artifactPath = path.join(directory, `${input.sessionId}.jsonl`);
  const transcript = (input.transcriptRecords ?? (input.turn === "busy" ? recentTurnRecords(engine) : [])).map((record) => JSON.stringify(record)).join("\n") + (input.transcriptSuffix ?? "");
  fs.writeFileSync(artifactPath, input.alignFirstRecordToTailBoundary
    ? `${JSON.stringify({ padding: "before-window" })}\n${transcript}${" ".repeat(128 * 1024 - Buffer.byteLength(transcript))}`
    : transcript);
  const launchProfile = emptyLaunchProfile({ cwd: directory });
  registry.reconcileConversations([{
    engine,
    path: artifactPath,
    accountId: null,
    launchProfile,
    turn: {
      state: input.turn,
      source: "lifecycle",
      terminalAt: input.turn === "terminal" ? "2026-07-15T06:00:00.000Z" : null,
    },
    observedAt: "2026-07-15T06:00:00.000Z",
  }]);
  const conversation = registry.conversationForPath(artifactPath)!;
  registry.upsert({
    key: { engine, sessionId: input.sessionId },
    artifactPath,
    cwd: directory,
    accountId: null,
    launchProfile,
    status: input.status,
    host: null,
    structuredHost: {
      kind: engine === "codex" ? "codex-app-server" : "claude-broker",
      endpoint: input.endpoint ?? "stdio:retained",
      process: null,
      eventCursor: 8,
      protocolVersion: "test",
      writerClaimEpoch: 3,
      activeTurnRef: input.activeTurnRef ?? null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 3,
    claimOwner: null,
    pendingAction: null,
  });
  return { artifactPath, conversation };
}

export function activeSeat(
  project: string,
  seatEpoch: number,
  conversationId: string,
  artifactPath: string,
  predecessorConversationId: string | null = null,
): OrchestratorSeat {
  return {
    project,
    seatEpoch,
    conversationId,
    path: artifactPath,
    mandate: "run the checkpoint loop",
    promptVersion: null,
    predecessorConversationId,
    state: "active",
    intent: { clientRequestId: `seat-${project}-${seatEpoch}`, mode: "existing", launchId: null, error: null },
    designatedAt: "2026-08-24T00:00:00.000Z",
    activatedAt: "2026-08-24T00:00:01.000Z",
  };
}

export async function addressedRecipientSocket(kind: "unhosted" | "live" | "stamped", phase: "census" | "restart-cut" | "pipeline evidence", race: string,
  custody?: { identity: "path" | "session"; archived: boolean; timing: "initial" | "publication" | "dispatch"; unrelated?: boolean; directReconnect?: boolean }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "recipient-wire-"));
  const oldState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = directory;
  savePipelines([]);
  const { registry, conversation, sessionId, artifactPath } = structuredRestartFixture(directory,"codex","unhosted");
  const key = { engine: "codex" as const, sessionId };
  const socketDirectory = path.join(directory,"socket"); fs.mkdirSync(socketDirectory,{mode:0o700});
  const socketPath = path.join(socketDirectory,"rpc.sock");
  const configFile=path.join(directory,"engine.json");
  fs.writeFileSync(configFile,JSON.stringify({socket:socketPath,threadId:sessionId,transcriptPath:artifactPath,recipient:true,
    completeRecipientTurns:kind === "stamped"}));
  const engine=ownFixtureTree(spawn(process.execPath,[path.join(import.meta.dir,"fixtures/codexCallbackProcess.ts"),"engine-socket",directory,
    path.join(directory,"writes.jsonl"),configFile],{env:process.env,stdio:["ignore","pipe","pipe"]}));
  const ready=Promise.withResolvers<{endpoint:string;process:ReturnType<typeof captureProcessIdentity>}>();
  let output="",errors="";
  engine.stdout!.on("data",chunk => { output+=String(chunk); if(output.includes("\n")) ready.resolve(JSON.parse(output.split("\n")[0]!)); });
  engine.stderr!.on("data",chunk => { errors+=String(chunk); });
  engine.once("exit",() => ready.reject(new Error(errors || "recipient engine exited before readiness")));
  const timeout=setTimeout(() => ready.reject(new Error("recipient engine readiness deadline exceeded")),5000);
  let socketOwner: Awaited<typeof ready.promise>;
  try { socketOwner=await ready.promise; }
  catch(error) { await stopFixtureTree(engine); throw error; }
  finally { clearTimeout(timeout); }
  const identity=socketOwner.process;
  const endpoint=socketOwner.endpoint;
  const owner=captureProcessIdentity(process.pid);
  const messages = () => fs.readFileSync(artifactPath,"utf8").trim().split("\n").filter(Boolean)
    .map(line => JSON.parse(line)).filter(row => row.payload?.type === "user_message");
  const writes = () => messages().length;
  const kick = () => kickStructuredDeliveryQueue(true, conversation.id);
  if (kind === "live") {
    const entry = registry.startupHostSnapshot(key).entries[`codex:${sessionId}`]!;
    registry.upsert({...entry,status:"idle",structuredHost:{...entry.structuredHost!,endpoint,process:identity,protocolVersion:"0.162.1"}});
  }
  const journal = new RuntimeJournal(path.join(directory,"runtime.sqlite"),{structuredHosts:true});
  const client = runtimeJournalClient(journal);
  let seats = kind === "stamped" ? [] : [activeSeat("recipient-wire",1,conversation.id,artifactPath)];
  if (kind === "stamped") {
    const retained = registry.startupHostSnapshot(key).entries[`codex:${sessionId}`]!;
    registry.upsert({...retained,status:"live"});
    fs.writeFileSync(artifactPath,JSON.stringify({type:"event_msg",timestamp:"2026-10-22T00:00:00Z",
      payload:{type:"task_complete",turn_id:"old-turn"}})+"\n");
  }
  let replacement: ReturnType<AgentRegistry["startupHostSnapshot"]>["entries"][string] | undefined;
  let raced = false;
  const raceReached = Promise.withResolvers<void>(), sendReturned = Promise.withResolvers<void>();
  const laterSendReturned = Promise.withResolvers<void>();
  let returnedSends = 0;
  let prepareError: string | null = null;
  let prepareCalls = 0, prepared = false, recoveries = 0, cursorReads = 0, sendCalls = 0;
  const preparationSettled = Promise.withResolvers<void>();
  // The parent covers preparation, a native attachment and any retry. The
  // product keeps its own five-second preparation deadline.
  const observe = async (signal: Promise<void>, phase: string) => {
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([signal, new Promise<never>((_resolve, reject) => {
      watchdog = setTimeout(() => reject(new Error(JSON.stringify({ phase, prepareError, prepareCalls, prepared, recoveries, cursorReads, sendCalls, raced, spawns,
        receipt: journal.operationResult("recipient-original")?.receipt.status, writes: writes() }))), 15_000);
    })]); } finally { clearTimeout(watchdog); }
  };
  const suspend = (incoming: boolean) => {
    const pipeline = recipientDispatchPipeline(conversation.id);
    Object.assign(pipeline.runs[0]!.attempts[0]!, { conversationId: null,
      agentPath: custody?.identity === "path" ? (incoming ? artifactPath : "unrelated.jsonl") : null,
      sessionId: custody?.identity === "session" ? (incoming ? sessionId : "unrelated-session") : null,
      suspension: { reason: "pause", detail: "retained pipeline custody", requestedAt: "2026-11-09T00:00:00.000Z" } });
    if (custody?.archived) {
      const db = new Database(path.join(directory, "state.sqlite"));
      try {
        if (db.query("UPDATE state_rows SET value_json=? WHERE collection='pipelines_archive' AND row_key=?")
          .run(JSON.stringify(pipeline), pipeline.id).changes) return;
      } finally { db.close(); }
    }
    savePipelines([pipeline]);
    if (custody?.archived) {
      const db = new Database(path.join(directory, "state.sqlite"));
      try { db.query("UPDATE state_rows SET collection='pipelines_archive' WHERE collection='pipelines' AND row_key=?").run(pipeline.id); }
      finally { db.close(); }
    }
  };
  if (custody) suspend(custody.timing === "initial" && !custody.unrelated);
  let replacementSequence = 0;
  const replace = () => {
    raced=true;
    replacementSequence++;
    const entry=registry.startupHostSnapshot(key).entries[`codex:${sessionId}`]!;
    if (race.endsWith("-pipeline")) {
      const pipeline = recipientDispatchPipeline(race === "dispatch-recipient-pipeline" ? conversation.id : undefined);
      savePipelines([pipeline]);
    }
    else if (race.endsWith("-seat")) seats=[activeSeat("recipient-wire", replacementSequence + 1, conversation.id, artifactPath)];
    else if (race.endsWith("-cut")) interruptionObligationStore(interruptionObligationDirectory(registry.filename)).record({
      conversationId: conversation.id, engine: "codex", hostKey: `codex:${sessionId}`, path: artifactPath,
      owner: null, claimEpoch: entry.claimEpoch, turnRef: `replacement-turn-${replacementSequence}`, boundary: `replacement-cut-${replacementSequence}`, reason: "viewer-release",
      checkpoint: { lastEventKind: "tool-call", lastEventAt: null }, seat: null,
    });
    else if (race.endsWith("-generation")) {
      const successor=registry.ensureConversation("codex",path.join(directory,"new-generation.jsonl"),null);
      registry.recordSupersedence(conversation.id,successor.id,"recovery-spawn");
    } else {
      replacement={...entry,claimOwner:race.endsWith("-owner") ? "replacement-owner" : entry.claimOwner,
        claimEpoch:entry.claimEpoch+(race.endsWith("-epoch") ? 1 : 0),
        structuredHost:{...entry.structuredHost!,writerClaimEpoch:entry.structuredHost!.writerClaimEpoch+(race.endsWith("-writer") ? 1 : 0)}};
      registry.upsert(replacement);
    }
    raceReached.resolve();
  };
  client.producerCursor = async () => {
    cursorReads++;
    await Promise.resolve();
    if (race.startsWith("publication")) replace();
    if (custody?.timing === "publication" && !raced) { suspend(true); raced = true; raceReached.resolve(); }
    return kind === "live" ? 4 : 0;
  };
  const nativeSend=CodexAppServerHost.prototype.send;
  const dispatch=spyOn(CodexAppServerHost.prototype,"send").mockImplementation(async function(this: CodexAppServerHost,...args) {
    sendCalls++;
    await Promise.resolve();
    if (race.startsWith("dispatch") && !raced) replace();
    if (custody?.timing === "dispatch" && !raced) { suspend(true); raced = true; raceReached.resolve(); }
    const result = await nativeSend.apply(this,args);
    if (++returnedSends === 1) sendReturned.resolve(); else laterSendReturned.resolve();
    return result;
  });
  projectHostedRestart(journal,"codex",conversation.id,sessionId,directory,artifactPath);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const prepare = registry.prepareReadOnlySnapshot.bind(registry);
  const census = spyOn(registry,"prepareReadOnlySnapshot").mockImplementation(async signal => {
    if (phase === "census") { entered.resolve(); await release.promise; }
    return prepare(signal);
  });
  const readEvidence = pipelineState.readCompactPipelineEvidence;
  let evidenceReads = 0;
  const pipelineRead = spyOn(pipelineState, "readCompactPipelineEvidence").mockImplementation(async (...args) => {
    const result = await readEvidence(...args);
    if (++evidenceReads === 1 && phase === "pipeline evidence") { entered.resolve(); await release.promise; }
    return result;
  });
  const unrelated = phase === "restart-cut" ? addStructuredRestartConversation(registry, directory, {
    sessionId: "cccccccc-cccc-0ccc-0ccc-cccccccccccc", status: "live", turn: "busy",
    transcriptRecords: [{ type: "event_msg", timestamp: "2026-10-22T00:00:00Z", payload: { type: "task_complete", turn_id: "unrelated-turn" } }],
  }) : undefined;
  const readTail = startupActivity.readStableTailRecords;
  const tail = spyOn(startupActivity, "readStableTailRecords").mockImplementation(async (file, ...args) => {
    if (file === unrelated?.artifactPath) { entered.resolve(); await release.promise; }
    return readTail(file, ...args);
  });
  const { recoverDeadStructuredConversation } = await import("./structuredRecovery");
  const { bindCodexHostPersistence } = await import("./registry");
  const { handleRuntimeCommand } = await import("./http");
  let host: CodexAppServerHost | undefined;
  let spawns = 0, finished = false;
  const recover: typeof recoverDeadStructuredConversation = (request,dependencies) => {
    recoveries++;
    return recoverDeadStructuredConversation(request,{
    ...dependencies,registry,client,transport:() => "structured",park:() => null,
    resolveAccount:() => ({engine:"codex",accountId:"default",kind:"legacy",home:directory,transcriptRoot:directory,env:{NODE_ENV:"test"}}),
    spawn:async input => {
      spawns++;
      await Promise.resolve();
      if (race === "claim-stamp") {
        raced = true;
        fs.appendFileSync(artifactPath,JSON.stringify({type:"event_msg",payload:{type:"task_started",turn_id:"racing-turn"}})+"\n");
        raceReached.resolve();
      }
      input.resumeAdmission?.beforeClaim();
      const claim = registry.claimStructuredHost(key,owner,{allowUnhosted:true});
      if (!claim?.claimOwner) throw new Error("fixture recovery claim is unavailable");
      input.resumeAdmission?.claimed(claim);
      host = await CodexAppServerHost.adopt(sessionId,{cwd:directory,codexHome:directory,
        socketOwner:{endpoint,process:identity},readProtocolVersion:() => "0.162.1",mcpServers:[]});
      await bindCodexHostPersistence(registry,key,host,claim.claimOwner,claim.claimEpoch);
      await publishStructuredDeliveryHost({key,host,writerEpoch:claim.claimEpoch},
        async () => { await input.authorize?.(); return registry.ownsStructuredHostClaim(key,claim.claimOwner!,claim.claimEpoch); });
      return {ok:true,target:null,path:artifactPath,launchId:input.receipt.launchId,conversationId:conversation.id,
        launched:true,retrySafe:false,initialMessage:"delivered",state:"settled"};
    },
  });
  };
  const originalPreparation = startupRecipient.prepareStructuredStartupRecipient;
  const preparation = spyOn(startupRecipient, "prepareStructuredStartupRecipient").mockImplementation(async (...args) => {
    prepareCalls++; prepared = false; prepareError = null;
    try { const result = await originalPreparation(...args); prepared = true; return result; }
    catch (error) { prepareError = error instanceof Error ? error.message : String(error); throw error; }
    finally { preparationSettled.resolve(); }
  });
  let startup: Promise<unknown> | undefined;
  try {
    await bindStructuredDeliveryQueue([],{registry,client,recover,deferStartupWork:true,
      watchdogIntervalMs:0,settlementSweepMs:0,hostlessSettleIntervalMs:0});
    startup = adoptStructuredHostsAtStartup({registry,client,orchestratorSeats:() => seats,
      refreshTranscriptState:async () => {},schedule:() => ({unref(){}}),adopt:async () => [],adoptClaude:async () => []})
      .then(() => {finished=true;});
    await entered.promise;
    expect(registry.conversationMemberships(conversation.id)).toEqual([]);
    if (custody?.directReconnect) {
      await expect(recover({ path: artifactPath, conversationId: conversation.id, reconnectLiveHost: true }))
        .rejects.toThrow(custody.timing === "initial" ? "recipient pipeline custody" : "recipient pipeline authority changed");
      if (custody.timing === "publication") expect(raced).toBe(true);
      expect(writes()).toBe(0); expect(spawns).toBe(0);
    }
    const response = await handleRuntimeCommand(new NextRequest("http://localhost/api/runtime/send",{method:"POST",
      headers:{host:"localhost","content-type":"application/json"},body:JSON.stringify({operationId:"recipient-original",
        idempotencyKey:"recipient-original",conversationId:conversation.id,text:"original addressed message",policy:"queue"})}),"send",{
      enabled:() => true,structuredEnabled:() => true,client:() => client,registry:() => registry,
      recordOperatorAdmission:() => false,
      enqueue:request => enqueueStructuredMessage(request,{enabled:() => true,client:() => client,registry:() => registry,recover}),
      kick:() => kickStructuredDeliveryQueue(),
    });
    expect(response.ok).toBe(true);
    const responseBody = await response.json();
    await kick();
    if ((custody && !custody.unrelated) || (race !== "none" && race !== "dispatch-unrelated-pipeline")) {
      if (!custody || custody.timing !== "initial") await observe(raceReached.promise, "retarget seam");
      else {
        await observe(preparationSettled.promise, "suspended recipient preparation");
        expect(prepareError).toBe("recipient pipeline authority is unavailable or held");
      }
      await kick();
      expect(finished).toBe(false);
      expect(writes()).toBe(0);
      if (replacement) expect(registry.startupHostSnapshot(key).entries[`codex:${sessionId}`]).toMatchObject({
        claimOwner:replacement.claimOwner,claimEpoch:replacement.claimEpoch,
        structuredHost:{writerClaimEpoch:replacement.structuredHost!.writerClaimEpoch}});
      const operation = journal.operationResult("recipient-original")!;
      expect(operation.receipt.status).not.toBe("delivered");
      expect(operation.receipt.operationId).toBe("recipient-original");
      if (custody) expect(operation.receipt).toMatchObject({ status: "queued", idempotencyKey: "recipient-original",
        conversationId: conversation.id, text: "original addressed message" });
      if (custody && (kind === "live" || custody.timing === "initial")) expect(spawns).toBe(0);
      return;
    }
    await observe(sendReturned.promise, "original native send acknowledgment");
    await kick();
    expect(journal.operationResult("recipient-original")?.receipt.status, JSON.stringify(responseBody)).toBe("delivered");
    expect(finished).toBe(false);
    if (race === "dispatch-unrelated-pipeline") expect(raced).toBe(true);
    expect(spawns).toBe(kind === "live" ? 0 : 1);
    expect(writes()).toBe(1);
    const transcript = messages();
    expect(transcript).toHaveLength(1);
    expect(transcript[0].payload).toMatchObject({id:"recipient-original"});
    expect(JSON.stringify(transcript[0].payload.input)).toContain("original addressed message");
    await kick();
    expect(writes()).toBe(1);
    if (kind === "stamped") {
      const later = await handleRuntimeCommand(new NextRequest("http://localhost/api/runtime/send",{method:"POST",
        headers:{host:"localhost","content-type":"application/json"},body:JSON.stringify({operationId:"recipient-later",
          idempotencyKey:"recipient-later",conversationId:conversation.id,text:"later addressed message",policy:"queue"})}),"send",{
        enabled:() => true,structuredEnabled:() => true,client:() => client,registry:() => registry,
        recordOperatorAdmission:() => false,
        enqueue:request => enqueueStructuredMessage(request,{enabled:() => true,client:() => client,registry:() => registry,recover}),
        kick:() => kickStructuredDeliveryQueue(),
      });
      expect(later.ok).toBe(true);
      await kick();
      await observe(laterSendReturned.promise, "later native send acknowledgment");
      await kick();
      expect(journal.operationResult("recipient-later")?.receipt.status).toBe("delivered");
      expect(finished).toBe(false);
      expect(messages().map(row => row.payload.id)).toEqual(["recipient-original","recipient-later"]);
      expect(spawns).toBe(1);
    }
  } finally {
    census.mockRestore(); pipelineRead.mockRestore(); tail.mockRestore(); dispatch.mockRestore(); preparation.mockRestore(); release.resolve(); await startup;
    const { structuredDeliveryHostForConversation } = await import("./structuredDeliveryController");
    const current = structuredDeliveryHostForConversation(conversation.id);
    await bindStructuredDeliveryQueue([],{registry,client:null});
    (current as CodexAppServerHost | null)?.detachForViewerRestart();
    host?.detachForViewerRestart();
    await stopFixtureTree(engine);
    journal.close();registry.close();
    if (oldState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR=oldState;
    fs.rmSync(directory,{recursive:true,force:true});
  }
}

export function addressedRecipientCases(kind: "unhosted" | "live" | "stamped") {
  return (["census", "restart-cut", "pipeline evidence"] as const).flatMap(phase =>
    (["none", "publication-owner", "publication-generation", "publication-writer", "publication-epoch", "publication-seat", "publication-cut",
      "dispatch-owner", "dispatch-generation", "dispatch-writer", "dispatch-epoch", "dispatch-seat", "dispatch-cut",
      "dispatch-unrelated-pipeline", "dispatch-recipient-pipeline", "claim-stamp"] as const)
      .filter(race => (phase === "census" || race === "none") && (race !== "claim-stamp" || kind === "stamped"))
      .map(race => ({ phase, race })));
}
