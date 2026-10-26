import { expect, test, fs, path, loadPipelines, savePipelines, pipelineIdentity, providerRecoveryHarness, stageTranscript, readFixtures, tickPipelines } from "./engine.fixture";
import { recoverPipelineProviderTurn } from "./engine";
import { scheduleProviderRecovery, settleProviderRecoveries, PROVIDER_RECOVERY_PAGE, PROVIDER_RECOVERY_DEADLINE_MS } from "./providerRecovery";
import { FlowPipelineController, startFlowPipelineControllerRuntime } from "./controller";
import { pipelineRecoveryWindow } from "./store";
import { StateSnapshotChangedError } from "@/lib/state/sqliteStateStore";
import { spyOn } from "bun:test";
import { once } from "node:events";
import { Database } from "bun:sqlite";
import { RuntimeJournal } from "@/runtime-host/journal";
import { RuntimeHost } from "@/runtime-host/host";
import { serveRuntimeHost } from "@/runtime-host/socket";

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(promise: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("recovery boundary did not settle")), 5000); })]); }
  finally { clearTimeout(timer); }
}
async function capacity() {
  const f = await providerRecoveryHarness("codex", "server_overloaded", "Selected model is at capacity. Please try again later.", null, true);
  const file = stageTranscript("capacity-terminal", [
    { type: "event_msg", timestamp: new Date(f.now() - 1000).toISOString(), payload: { type: "task_started" } },
    { type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "task_complete", last_agent_message: null,
      error: { codex_error_info: "server_overloaded", message: "Selected model is at capacity. Please try again later." } } },
  ]);
  readFixtures(f.h, { "/codex/stage-1.jsonl": file });
  f.h.ports.conversationAgentActive = async () => null; // hosted idle, as on the serving host
  f.h.ports.monotonicNow = () => 1_000_000;
  const sends: string[] = [];
  f.h.ports.resumeSeveredTurn = async input => {
    if (!await input.continuationAllowed!()) return false;
    sends.push(input.clientMessageId);
    return true;
  };
  return { ...f, sends, file, id: loadPipelines()[0]!.id };
}

test.each([true, null])("exact null-message capacity completion is shown and continued at its next-try time without a catalog (activity=%p)", async active => {
  const f = await capacity();
  f.h.ports.conversationAgentActive = async () => active;
  await recoverPipelineProviderTurn(f.id, f.h.ports);
  let lane = loadPipelines()[0]!;
  expect(lane.stateDetail).toContain("waiting for model at capacity");
  expect(lane.runs[0]!.attempts[0]!.providerWait).toMatchObject({ condition: { kind: "transient" }, tries: 0,
    resumeAt: new Date(f.now() + 60_000).toISOString() });
  f.advance(59_999);
  await recoverPipelineProviderTurn(f.id, f.h.ports);
  expect(f.sends).toHaveLength(0);
  f.advance(1);
  await recoverPipelineProviderTurn(f.id, f.h.ports);
  await recoverPipelineProviderTurn(f.id, f.h.ports);
  expect(f.sends).toHaveLength(1);
  lane = loadPipelines()[0]!;
  expect(lane.runs[0]!.attempts).toHaveLength(1);
  expect(lane.runs[0]!.attempts[0]!.providerRecoveryBudget?.tries).toBe(1);
  expect(lane.stateDetail).toContain("continuing the same conversation");
});

test("ordinary recovery-budget exhaustion cannot skip the independent terminal observation", async () => {
  const f = await capacity();
  let clock = 0;
  f.h.ports.monotonicNow = () => { clock += 20_000; return clock; };
  await recoverPipelineProviderTurn(f.id, f.h.ports);
  expect(loadPipelines()[0]!.stateDetail).toContain("waiting for model at capacity");
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.condition.kind).toBe("transient");
});

test("successive capacity cuts keep exponential backoff and park after three continuations", async () => {
  const f = await capacity();
  for (const tries of [0, 1, 2, 3]) {
    await recoverPipelineProviderTurn(f.id, f.h.ports);
    const lane = loadPipelines()[0]!;
    if (tries === 3) {
      expect(lane.state).toBe("needs_decision");
      expect(lane.stateDetail).toContain("after 3 tries");
      break;
    }
    const wait = lane.runs[0]!.attempts[0]!.providerWait!;
    expect(wait.tries).toBe(tries);
    const delay = 60_000 * 2 ** tries;
    expect(wait.resumeAt).toBe(new Date(f.now() + delay).toISOString());
    f.advance(delay - 1);
    await recoverPipelineProviderTurn(f.id, f.h.ports);
    expect(f.sends).toHaveLength(tries);
    f.advance(1);
    await recoverPipelineProviderTurn(f.id, f.h.ports);
    expect(f.sends).toHaveLength(tries + 1);
    f.advance(1_000);
    fs.appendFileSync(f.file, JSON.stringify({ type: "event_msg", timestamp: f.h.ports.now(),
      payload: { type: "task_complete", last_agent_message: null,
        error: { codex_error_info: "server_overloaded", message: "Selected model is at capacity. Please try again later." } } }) + "\n");
  }
  expect(f.sends).toHaveLength(3);
});

test("exhausted capacity recovery visibly parks with the original reason", async () => {
  const f = await capacity();
  const lane = loadPipelines()[0]!;
  lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now() };
  savePipelines([lane]);
  await recoverPipelineProviderTurn(f.id, f.h.ports);
  expect(loadPipelines()[0]!).toMatchObject({ state: "needs_decision", stateDetail: expect.stringContaining("model at capacity after 3 tries") });
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("needs_decision");
  expect(f.sends).toHaveLength(0);
});

test("agent output closes the spent capacity chain before a later capacity cut is checkpointed", async () => {
  const f = await capacity();
  await recoverPipelineProviderTurn(f.id, f.h.ports);
  const lane = loadPipelines()[0]!, attempt = lane.runs[0]!.attempts[0]!;
  attempt.providerRecoveryBudget!.tries = 3;
  attempt.providerWait!.tries = 3;
  savePipelines([lane]);
  f.advance(1_000);
  fs.appendFileSync(f.file, JSON.stringify({ type: "event_msg", timestamp: f.h.ports.now(),
    payload: { type: "agent_message", message: "Working on the stage" } }) + "\n");
  f.advance(1_000);
  fs.appendFileSync(f.file, JSON.stringify({ type: "event_msg", timestamp: f.h.ports.now(), payload: {
    type: "task_complete", last_agent_message: null,
    error: { codex_error_info: "server_overloaded", message: "Selected model is at capacity. Please try again later." },
  } }) + "\n");
  await recoverPipelineProviderTurn(f.id, f.h.ports);
  const saved = loadPipelines()[0]!;
  expect(saved.state).toBe("running");
  expect(saved.runs[0]!.attempts[0]!.providerWait?.tries).toBe(0);
  expect(saved.runs[0]!.attempts[0]!.providerRecoveryBudget?.tries).toBe(0);
  expect(saved.stateDetail).toContain("waiting for model at capacity");
  f.advance(60_000);
  await recoverPipelineProviderTurn(f.id, f.h.ports);
  expect(f.sends).toHaveLength(1);
});

test("a fresh process honours the saved retry time", async () => {
  const f = await capacity();
  await recoverPipelineProviderTurn(f.id, f.h.ports);
  const source = `import { defaultPipelinePorts,recoverPipelineProviderTurn } from "./src/lib/pipelines/engine.ts";
    import { loadPipelines } from "./src/lib/pipelines/store.ts";
    import { durableStageTurnEvidence } from "./src/lib/pipelines/durableEvidence.ts";
    const lane=loadPipelines()[0], attempt=lane.runs[0].attempts[0];
    let sends=0;
    const ports={...defaultPipelinePorts(),now:()=>${JSON.stringify(f.h.ports.now())},
      conversationAgentActive:async()=>null,conversationTurnInterrupted:async()=>null,
      runtimeHostEpoch:async()=>null,conversationOutOfMemory:async()=>null,
      conversationHostUnavailableSince:async()=>null,sourcePathAllowed:()=>true,
      spawnReceipt:()=>null,paneAgentAlive:async()=>false,
      durableTurnEvidence:async(engine,_path,reportAt,startedAt,tail,afterCutAt)=>durableStageTurnEvidence(engine,${JSON.stringify(f.file)},reportAt,startedAt,tail,afterCutAt),
      resolveProjectSpawn:()=>({kind:"exhausted",resetsAt:null,allowedAccountIds:[]}),
      accountLabel:()=>"account A",allowedAccountIds:()=>null,
      resumeSeveredTurn:async()=>{sends++;return true;},scheduleTick:()=>{}};
    await recoverPipelineProviderTurn(lane.id,ports);
    console.log(JSON.stringify({sends,wait:loadPipelines()[0].runs[0].attempts[0].providerWait}));`;
  const child = Bun.spawn({ cmd: [process.execPath, "-e", source], env: process.env, stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text();
  const errors = await new Response(child.stderr).text();
  expect({ code: await child.exited, errors }).toMatchObject({ code: 0 });
  const observed = JSON.parse(output);
  expect(observed.sends).toBe(0);
  expect(observed.wait.resumeAt).toBe(new Date(f.now() + 60_000).toISOString());
});

test.each(["paused", "closed", "edited", "hidden", "aborted"] as const)("%s authority arriving during evidence prevents recovery", async change => {
  const f = await capacity();
  const read = f.h.ports.durableTurnEvidence;
  const abort = new AbortController();
  f.h.ports.durableTurnEvidence = async (...args) => {
    const result = await read(...args);
    if (change === "aborted") abort.abort();
    else {
      const lane = loadPipelines()[0]!;
      if (change === "paused") lane.state = "paused";
      if (change === "closed") { lane.state = "closed"; lane.closedAt = f.h.ports.now(); lane.cursor = null; }
      if (change === "hidden") lane.hiddenAt = f.h.ports.now();
      if (change === "edited") lane.stateDetail = "completion report arrived";
      savePipelines([lane]);
    }
    return result;
  };
  await expect(recoverPipelineProviderTurn(f.id, f.h.ports, abort.signal)).rejects.toBeInstanceOf(StateSnapshotChangedError);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait).toBeUndefined();
  expect(f.sends).toHaveLength(0);
});

test.each([2, 3])("a concurrent pause at evidence read %i fences continuation after earlier checkpoints", async boundary => {
  const f = await capacity();
  // First persist the wait, then reach both the stage read and final send guard.
  await recoverPipelineProviderTurn(f.id, f.h.ports);
  f.advance(60_000);
  const read = f.h.ports.durableTurnEvidence;
  let reads = 0;
  f.h.ports.durableTurnEvidence = async (...args) => {
    const result = await read(...args);
    if (++reads === boundary) {
      const lane = loadPipelines()[0]!; lane.state = "paused"; savePipelines([lane]);
    }
    return result;
  };
  await expect(recoverPipelineProviderTurn(f.id, f.h.ports)).rejects.toBeInstanceOf(StateSnapshotChangedError);
  expect(reads).toBe(boundary);
  expect(loadPipelines()[0]!.state).toBe("paused");
  expect(f.sends).toHaveLength(0);
});

test("transport refusal retains a visible bounded recovery wait", async () => {
  const f = await capacity();
  await recoverPipelineProviderTurn(f.id, f.h.ports);
  f.advance(60_000);
  f.h.ports.resumeSeveredTurn = async () => { throw new Error("fixture transport unavailable"); };
  await recoverPipelineProviderTurn(f.id, f.h.ports);
  const lane = loadPipelines()[0]!;
  expect(lane.stateDetail).toContain("fixture transport unavailable");
  expect(lane.runs[0]!.attempts[0]!.controllerWait?.retryAfter).toBeDefined();
  expect(lane.runs[0]!.attempts[0]!.providerRecoveryBudget?.tries).toBe(0);
  expect(f.sends).toHaveLength(0);
});

test.each(["busy", "unknown", "unreadable"] as const)("%s evidence never manufactures a provider continuation", async kind => {
  const f = await capacity();
  f.h.ports.durableTurnEvidence = async () => {
    if (kind === "unreadable") throw new Error("fixture read refused");
    return { turn: kind, message: null };
  };
  if (kind === "unreadable") await expect(recoverPipelineProviderTurn(f.id, f.h.ports)).rejects.toThrow("fixture read refused");
  else await recoverPipelineProviderTurn(f.id, f.h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait).toBeUndefined();
  expect(f.sends).toHaveLength(0);
});

test("watchdog recovery admits a later terminal lane while ordinary and first recovery reads remain held", async () => {
  const f = await capacity();
  const read = f.h.ports.durableTurnEvidence;
  const ordinaryEntered = latch(), recoveryEntered = latch(), release = latch(), peerShown = latch(), peerContinued = latch(), wakeScheduled = latch();
  const wakes: number[] = [];
  f.h.ports.scheduleTick = delay => { wakes.push(delay); if (delay === 60_000) wakeScheduled.resolve(); };
  let holds = 0;
  f.h.ports.durableTurnEvidence = async (...args) => {
    if (args[1] === "/codex/stage-1.jsonl" && holds++ < 2) {
      (holds === 1 ? ordinaryEntered : recoveryEntered).resolve();
      await release.promise;
    }
    return read(...args);
  };
  let scheduled = Promise.resolve();
  const controller = new FlowPipelineController({
    tickPipelines: () => ordinary,
    scan: async () => ({ files: [], complete: false }),
    sweepProviderRecovery: () => { scheduled = scheduleProviderRecovery(f.h.ports); },
    log: () => {},
  }, { maxPasses: 1 });
  // Hold the actual ordinary pass before asking the controller to observe it.
  const ordinary = tickPipelines([], f.h.ports);
  const control = controller.tick();
  try {
    await until(ordinaryEntered.promise);
    await until(recoveryEntered.promise);
    await scheduled;
    let watchdog!: () => void;
    startFlowPipelineControllerRuntime(controller, {}, {
      registerTick: () => () => {},
      scheduleInterval: callback => { watchdog = callback; return {}; },
      log: () => {},
    });
    // Leave the runtime's first poll pending before a peer becomes terminal.
    watchdog();
    await scheduled;
    const peer = structuredClone(loadPipelines()[0]!);
    peer.id = "later-capacity-peer";
    peer.delivery = undefined; peer.publication = "internal";
    Object.assign(peer, pipelineIdentity(peer.id, peer.task, peer.repoDir));
    peer.runs[0]!.attempts[0]!.agentPath = "/codex/peer.jsonl";
    peer.runs[0]!.attempts[0]!.conversationId = "later-peer-session";
    savePipelines([...loadPipelines(), peer]);
    f.h.ports.durableTurnEvidence = async (...args) => {
      if (args[1] === "/codex/peer.jsonl") { args[1] = "/codex/stage-1.jsonl"; return read(...args); }
      return read(...args);
    };
    watchdog();
    await scheduled;
    // Observe a durable checkpoint; the held readers cannot fulfil it.
    const check = setInterval(() => {
      if (loadPipelines().find(row => row.id === peer.id)?.stateDetail?.includes("waiting for model at capacity")) peerShown.resolve();
    }, 10);
    try { await until(peerShown.promise); } finally { clearInterval(check); }
    await until(wakeScheduled.promise);
    expect(holds).toBe(2);
    expect(f.sends).toHaveLength(0);
    expect(wakes).toContain(60_000);
    // The ordinary pass and the first recovery stay held through the due wake.
    f.advance(60_000);
    watchdog();
    await scheduled;
    const confirmation = setInterval(() => {
      if (loadPipelines().find(row => row.id === peer.id)?.runs[0]!.attempts[0]!.providerWait?.actionAt) peerContinued.resolve();
    }, 10);
    try { await until(peerContinued.promise); } finally { clearInterval(confirmation); }
    expect(holds).toBe(2);
    expect(f.sends).toHaveLength(1);
    expect(f.sends[0]).toContain(peer.id);
  } finally { release.resolve(); await ordinary; await control; await settleProviderRecoveries(); }
});

test.each([0, 3])("a known capacity cut checkpoints before held activity with %i spent tries", async tries => {
  const f = await capacity();
  const lane = loadPipelines()[0]!;
  lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries, startedAt: f.h.ports.now() };
  savePipelines([lane]);
  const entered = latch(), release = latch();
  let activityReads = 0, expire: (() => void) | undefined;
  f.h.ports.conversationAgentActive = async () => { activityReads++; entered.resolve(); await release.promise; return null; };
  const nativeTimeout = globalThis.setTimeout;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay?: number) => {
    if (delay === PROVIDER_RECOVERY_DEADLINE_MS) expire = callback;
    return nativeTimeout(callback, delay);
  }) as typeof setTimeout);
  let work: Promise<void> | undefined;
  try {
    work = recoverPipelineProviderTurn(f.id, f.h.ports);
    if (tries === 3) {
      await until(work);
      expect(activityReads).toBe(0);
      expect(loadPipelines()[0]!.stateDetail).toContain("model at capacity after 3 tries");
    } else {
      await until(entered.promise);
      expect(loadPipelines()[0]!.stateDetail).toContain("waiting for model at capacity");
      expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.tries).toBe(0);
      expire!();
      await until(work);
      expect(loadPipelines()[0]!.stateDetail).toContain("model at capacity");
    }
    expect(loadPipelines()[0]!.state).toBe("needs_decision");
    const parked = structuredClone(loadPipelines()[0]);
    for (let wake = 0; wake < 4; wake++) await recoverPipelineProviderTurn(f.id, f.h.ports);
    release.resolve();
    await work;
    expect(loadPipelines()[0]).toEqual(parked);
    expect(f.sends).toHaveLength(0);
  } finally { timer.mockRestore(); release.resolve(); await work; }
});

test("an expired held read parks visibly, releases observation and lets a peer recover before the read returns", async () => {
  const f = await capacity();
  const entered = latch(), release = latch(), lateRead = latch();
  const read = f.h.ports.durableTurnEvidence;
  let reads = 0, expire: (() => void) | undefined;
  f.h.ports.durableTurnEvidence = async (...args) => {
    reads++; entered.resolve(); await release.promise;
    try { return await read(...args); } finally { lateRead.resolve(); }
  };
  const nativeTimeout = globalThis.setTimeout;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay?: number) => {
    if (delay === PROVIDER_RECOVERY_DEADLINE_MS) expire = callback;
    return nativeTimeout(callback, delay);
  }) as typeof setTimeout);
  try {
    await scheduleProviderRecovery(f.h.ports);
    await until(entered.promise);
    await scheduleProviderRecovery(f.h.ports);
    expect(reads).toBe(1);
    expire!();
    await until(settleProviderRecoveries());
    const parked = structuredClone(loadPipelines()[0]!);
    expect(parked.state).toBe("needs_decision");
    expect(parked.runs[0]!.attempts[0]!.state).toBe("needs_decision");
    expect(parked.stateDetail).toContain("provider recovery observation exceeded 15 seconds");
    f.h.ports.durableTurnEvidence = read;
    for (let wake = 0; wake < 4; wake++) {
      await scheduleProviderRecovery(f.h.ports);
      await until(settleProviderRecoveries());
    }
    expect(reads).toBe(1);
    const source = `import { scheduleProviderRecovery, settleProviderRecoveries } from "./src/lib/pipelines/providerRecovery.ts";
      import { defaultPipelinePorts } from "./src/lib/pipelines/engine.ts";
      import { loadPipelines } from "./src/lib/pipelines/store.ts";
      let reads=0;
      const ports={...defaultPipelinePorts(),durableTurnEvidence:async()=>{reads++;return null;}};
      await scheduleProviderRecovery(ports); await settleProviderRecoveries();
      console.log(JSON.stringify({reads,state:loadPipelines()[0].state,detail:loadPipelines()[0].stateDetail}));`;
    const child = Bun.spawn({ cmd: [process.execPath, "-e", source], env: process.env, stdout: "pipe", stderr: "pipe" });
    const output = await new Response(child.stdout).text();
    const errors = await new Response(child.stderr).text();
    expect({ code: await child.exited, errors }).toMatchObject({ code: 0 });
    expect(JSON.parse(output)).toEqual({ reads: 0, state: "needs_decision", detail: parked.stateDetail });
    const peer = structuredClone(parked);
    peer.id = "deadline-peer";
    peer.delivery = undefined; peer.publication = "internal";
    peer.state = "running"; peer.stateDetail = null;
    peer.cursor!.state = "running"; peer.runs[0]!.attempts[0]!.state = "running";
    Object.assign(peer, pipelineIdentity(peer.id, peer.task, peer.repoDir));
    savePipelines([parked, peer]);
    await scheduleProviderRecovery(f.h.ports);
    await until(settleProviderRecoveries());
    expect(loadPipelines().find(row => row.id === peer.id)!.stateDetail).toContain("waiting for model at capacity");
    f.advance(60_000);
    await scheduleProviderRecovery(f.h.ports);
    await until(settleProviderRecoveries());
    expect(f.sends).toHaveLength(1);
    expect(f.sends[0]).toContain(peer.id);
    expect(loadPipelines().find(row => row.id === f.id)).toEqual(parked);
    release.resolve(); await until(lateRead.promise);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(loadPipelines().find(row => row.id === f.id)).toEqual(parked);
    expect(f.sends).toHaveLength(1);
  } finally { timer.mockRestore(); release.resolve(); await settleProviderRecoveries(); }
});

test.each(["paused", "closed", "edited", "hidden", "reported"] as const)("deadline parking preserves concurrent %s authority", async change => {
  const f = await capacity();
  const entered = latch(), release = latch();
  const read = f.h.ports.durableTurnEvidence;
  f.h.ports.durableTurnEvidence = async (...args) => { entered.resolve(); await release.promise; return read(...args); };
  let expire!: () => void;
  const nativeTimeout = globalThis.setTimeout;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay?: number) => {
    if (delay === PROVIDER_RECOVERY_DEADLINE_MS) expire = callback;
    return nativeTimeout(callback, delay);
  }) as typeof setTimeout);
  let work: Promise<void> | undefined;
  try {
    work = recoverPipelineProviderTurn(f.id, f.h.ports);
    await until(entered.promise);
    const lane = loadPipelines()[0]!;
    if (change === "paused") lane.state = "paused";
    if (change === "closed") { lane.state = "closed"; lane.closedAt = f.h.ports.now(); lane.cursor = null; }
    if (change === "hidden") lane.hiddenAt = f.h.ports.now();
    if (change === "edited") lane.stateDetail = "new controller checkpoint";
    if (change === "reported") lane.runs[0]!.attempts[0]!.report = {
      seq: 1, at: f.h.ports.now(), actor: { kind: "agent", role: "builder", conversationId: "conversation_stage_1" },
      verdict: { status: "pass", findings: [] }, summary: "done", calls: 1,
      provenance: { head: "fixture-head", branch: lane.branch, uncommitted: [], pullRequest: null, outputs: [] },
    };
    savePipelines([lane]);
    const changed = structuredClone(loadPipelines()[0]);
    expire(); await until(work);
    expect(loadPipelines()[0]).toEqual(changed);
    release.resolve(); await work;
    expect(f.sends).toHaveLength(0);
  } finally { timer.mockRestore(); release.resolve(); await work; }
});

test("recovery pages use indexed headers and persist their fair position across a fresh process", async () => {
  const f = await capacity();
  const seed = loadPipelines()[0]!;
  const rows = Array.from({ length: PROVIDER_RECOVERY_PAGE + 2 }, (_, n) => {
    const lane = structuredClone(seed); lane.id = `recovery-page-${n.toString().padStart(2, "0")}`;
    lane.delivery = undefined; lane.publication = "internal";
    Object.assign(lane, pipelineIdentity(lane.id, lane.task, lane.repoDir)); return lane;
  });
  savePipelines(rows);
  fs.writeFileSync(path.join(process.env.LLV_STATE_DIR!, "provider-recovery-cursor.json"), JSON.stringify({ row_order: -1, row_key: "" }));
  f.h.ports.durableTurnEvidence = async () => null;
  await scheduleProviderRecovery(f.h.ports);
  await settleProviderRecoveries();
  const cursor = JSON.parse(fs.readFileSync(path.join(process.env.LLV_STATE_DIR!, "provider-recovery-cursor.json"), "utf8"));
  const next = await pipelineRecoveryWindow(cursor, PROVIDER_RECOVERY_PAGE);
  expect(next.map(row => row.row_key)).toEqual(rows.slice(PROVIDER_RECOVERY_PAGE).map(row => row.id));
  const source = `import fs from "node:fs";
    import { pipelineRecoveryWindow } from "./src/lib/pipelines/store.ts";
    const cursor=JSON.parse(fs.readFileSync(process.env.LLV_STATE_DIR+"/provider-recovery-cursor.json","utf8"));
    console.log(JSON.stringify(await pipelineRecoveryWindow(cursor,8)));`;
  const child = Bun.spawn({ cmd: [process.execPath, "-e", source], env: process.env, stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(JSON.parse(output)).toEqual(next);
});

test("a default eight-lane recovery page scopes fresh activity to its identities as host history grows", async () => {
  const f = await capacity();
  const seed = loadPipelines()[0]!;
  const lanes = Array.from({ length: PROVIDER_RECOVERY_PAGE }, (_, n) => {
    const lane = structuredClone(seed);
    lane.id = `scoped-recovery-${n}`;
    lane.delivery = undefined; lane.publication = "internal";
    Object.assign(lane, pipelineIdentity(lane.id, lane.task, lane.repoDir));
    const attempt = lane.runs[0]!.attempts[0]!;
    attempt.agentPath = f.file; attempt.conversationId = `conversation_scope_${n}`;
    return lane;
  });
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR!, "recovery-host-"));
  const database = path.join(root, "runtime.sqlite");
  const journal = new RuntimeJournal(database);
  const host = new RuntimeHost(journal);
  const requests: Array<{ ids: readonly string[] | undefined; rows: number }> = [];
  const socket = path.join(root, "host.sock");
  const server = serveRuntimeHost(socket, { handle: request => {
    if (request.method === "snapshot") {
      const read = request.params?.snapshotRead as { kind: string; conversationIds?: string[] } | undefined;
      if (read?.kind === "activity") {
        const result = journal.snapshotRead(read);
        requests.push({ ids: read.conversationIds, rows: result.sessions!.length });
      }
    }
    return host.handle(request);
  } });
  const previous = process.env.LLV_RUNTIME_HOST_SOCKET;
  process.env.LLV_RUNTIME_HOST_SOCKET = socket;
  const db = new Database(database);
  try {
    await once(server, "listening");
    const insert = db.prepare("INSERT INTO entities(kind,id,revision,state_json,checkpoint_seq) VALUES ('session',?,1,?,0)");
    const populate = db.transaction((from: number, to: number) => {
      for (let n = from; n < to; n++) {
        const id = n < PROVIDER_RECOVERY_PAGE ? `conversation_scope_${n}` : `conversation_history_${n}`;
        insert.run(id, JSON.stringify({ conversationId: id, host: "hosted", turn: "idle", attentionIds: [] }));
      }
    });
    let population = 0;
    const measurements: Array<{ population: number; requests: number; scoped: number; rows: number }> = [];
    for (const retained of [PROVIDER_RECOVERY_PAGE, 5_000, 50_000]) {
      populate(population, retained); population = retained;
      journal.append({ scope: { type: "system", id: "population-fixture" }, kind: "files.revision", payload: {} });
      for (let repetition = 0; repetition < 3; repetition++) {
        savePipelines(lanes);
        fs.writeFileSync(path.join(process.env.LLV_STATE_DIR!, "provider-recovery-cursor.json"), JSON.stringify({ row_order: -1, row_key: "" }));
        requests.length = 0;
        await scheduleProviderRecovery();
        await until(settleProviderRecoveries());
        measurements.push({ population: retained, requests: requests.length,
          scoped: requests.filter(request => request.ids?.length === 1).length,
          rows: requests.reduce((sum, request) => sum + request.rows, 0) });
        if (requests.every(request => request.ids?.length === 1)) {
          expect(requests.map(request => request.ids!.join())).toEqual(expect.arrayContaining(
            lanes.map(lane => lane.runs[0]!.attempts[0]!.conversationId!)));
        }
        expect(loadPipelines().every(lane => lane.stateDetail?.includes("waiting for model at capacity"))).toBe(true);
      }
    }
    console.log("provider activity page measurements", JSON.stringify(measurements));
    expect(measurements).toEqual([PROVIDER_RECOVERY_PAGE, 5_000, 50_000].flatMap(population =>
      Array.from({ length: 3 }, () => ({ population, requests: PROVIDER_RECOVERY_PAGE, scoped: PROVIDER_RECOVERY_PAGE, rows: PROVIDER_RECOVERY_PAGE }))));
  } finally {
    await settleProviderRecoveries();
    if (previous === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET; else process.env.LLV_RUNTIME_HOST_SOCKET = previous;
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close(); journal.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});
