import { expect, test, aliveStagedLaunch, stagedRecoveryHarness, stageHostChild, productionHostSeams, defaultPipelinePorts, loadPipelines, setAgentRegistryForTests, tickPipelines, patchPipeline, savePipelines, fs, path, harness, durableStageTurnEvidence } from "./engine.fixture";

const BUDGET = 10 * 60_000;

async function silentLaunch(unpublished = false) {
  const host = await stageHostChild();
  const f = unpublished
    ? await stagedRecoveryHarness("timeout", { hostProcess: host.process, nativeTranscript: true, startedAt: Date.parse("2026-10-19T12:00:00Z") })
    : await aliveStagedLaunch({ hostProcess: host.process, nativeTranscript: true, startedAt: Date.parse("2026-10-19T12:00:00Z") });
  productionHostSeams(f);
  f.h.ports.stopStageAgent = (target, options) => defaultPipelinePorts().stopStageAgent(target, options);
  return { ...f, host };
}

test.each([false, true])("unanswered first message is replaced after real checks (unpublished: %s)", async unpublished => {
  const f = await silentLaunch(unpublished);
  let liveLaunch: string | null = null;
  try {
    if (unpublished) { await f.wake(); await f.wake(); }
    const original = f.attempt().launchId;
    const continuations = (process as typeof process & { __llvStagedContinuations?: Map<string, unknown> }).__llvStagedContinuations!;
    expect(continuations.has(original!)).toBe(true);
    const launchMarker = `live-${original}`;
    liveLaunch = launchMarker;
    continuations.set(launchMarker, {});
    expect(f.h.ports.releaseFailedStageLaunchContinuation!(original!, "another-conversation")).toBe(false);
    f.advance(BUDGET);
    await f.wake();
    const lane = loadPipelines()[0]!;
    expect(lane.runs[0]!.attempts).toHaveLength(2);
    expect(lane.runs[0]!.attempts[0]).toMatchObject({ state: "failed", launchId: original });
    expect(lane.runs[0]!.attempts[1]!.restartContext).toMatchObject({ previousAttempt: 1 });
    expect(f.registry.readOnlySnapshot().receipts[original!]?.state).toBe("failed");
    expect(continuations.has(original!)).toBe(false);
    expect(continuations.has(launchMarker)).toBe(true);
    // The recorded incarnation was stopped; a replacement never overlaps it.
    const { processIdentityStatus } = await import("@/lib/processIdentity");
    expect(processIdentityStatus(f.host.process)).toBe("dead");
  } finally {
    if (liveLaunch) (process as typeof process & { __llvStagedContinuations?: Map<string, unknown> }).__llvStagedContinuations?.delete(liveLaunch);
    setAgentRegistryForTests(null); await f.host.end();
  }
});

test("a failed receipt releases its continuation after the settlement acknowledgement is lost", async () => {
  const f = await silentLaunch();
  try {
    const original = f.attempt().launchId!;
    const fail = f.h.ports.failStoppedStageLaunch!;
    let loseAcknowledgement = true;
    f.h.ports.failStoppedStageLaunch = async (...args) => {
      const settled = await fail(...args);
      if (loseAcknowledgement) { loseAcknowledgement = false; return false; }
      return settled;
    };
    f.advance(BUDGET); await f.wake();
    expect(f.registry.spawnReceipt(original)?.state).toBe("failed");
    expect((process as typeof process & { __llvStagedContinuations?: Map<string, unknown> })
      .__llvStagedContinuations?.has(original)).toBe(false);
    await f.wake();
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(2);
  } finally { setAgentRegistryForTests(null); await f.host.end(); }
});

test.each([false, true])("retry-stage accepts an exhausted spawning attempt with its expected identity (paused: %s)", async paused => {
  const f = await silentLaunch();
  try {
    f.advance(BUDGET);
    if (paused) {
      const rows = loadPipelines(); rows[0]!.state = "paused"; rows[0]!.pausedState = "running"; savePipelines(rows);
    }
    const result = await patchPipeline(loadPipelines()[0]!.id, {
      action: "retry-stage", expectedStageId: "build", expectedAttempt: 1,
    }, f.h.ports);
    expect(result.error).toBeUndefined();
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(2);
  } finally { setAgentRegistryForTests(null); await f.host.end(); }
});


test.each(["automatic", "manual", "legacy-without-envelope"] as const)("a settled path-pending park is replaced (%s)", async mode => {
  const manual = mode !== "automatic";
  const f = await silentLaunch();
  try {
    const rows = loadPipelines();
    const lane = rows[0]!;
    const a = lane.runs[0]!.attempts[0]!;
    a.state = "needs_decision";
    a.error = "stage spawn recovery stopped: runtime host recovery exhausted after 11 checks; original launch operation is not visible; original launch retained";
    lane.state = "needs_decision"; lane.stateDetail = a.error;
    savePipelines(rows);
    if (mode === "legacy-without-envelope") {
      const read = f.h.ports.spawnReceipt;
      f.h.ports.spawnReceipt = id => { const receipt = read(id); return receipt ? { ...receipt, error: null } : null; };
    }
    f.advance(BUDGET);
    if (manual) {
      const result = await patchPipeline(lane.id, { action: "retry-stage", stageId: "build", launchId: a.launchId! }, f.h.ports);
      expect(result.error).toBeUndefined();
    } else await f.wake();
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(2);
    expect(f.registry.readOnlySnapshot().receipts[a.launchId!]?.state).toBe("failed");
  } finally { setAgentRegistryForTests(null); await f.host.end(); }
});

test("metadata alone cannot keep a silent host alive past recovery", async () => {
  const f = await silentLaunch();
  try {
    fs.writeFileSync(f.registry.spawnReceipt(f.attempt().launchId!)!.artifactPath!,
      JSON.stringify({ type: "session_meta", payload: { id: "silent-stage" } }) + "\n");
    f.h.ports.sourcePathAllowed = () => true;
    f.advance(BUDGET); await f.wake();
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(2);
  } finally { setAgentRegistryForTests(null); await f.host.end(); }
});

test("a complete empty transcript cannot keep a silent host alive past recovery", async () => {
  const f = await silentLaunch();
  try {
    const receipt = f.registry.spawnReceipt(f.attempt().launchId!)!;
    fs.writeFileSync(receipt.artifactPath!, "");
    f.h.ports.sourcePathAllowed = () => true;
    f.advance(BUDGET); await f.wake();
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(2);
  } finally { setAgentRegistryForTests(null); await f.host.end(); }
});

test("Claude init metadata is complete silence evidence without a Codex launchOnly marker", async () => {
  const f = await silentLaunch();
  try {
    const pathname = f.registry.spawnReceipt(f.attempt().launchId!)!.artifactPath!;
    fs.writeFileSync(pathname, JSON.stringify({ type: "system", subtype: "init", session_id: "silent-claude" }) + "\n");
    const evidence = await durableStageTurnEvidence("claude", pathname);
    expect(evidence).toMatchObject({ promptHistoryComplete: true, turn: "unknown", message: null,
      turnStartedAt: null, lastAgentEventAt: null, prompts: [] });
    expect(evidence?.launchOnly).not.toBe(true);
  } finally { setAgentRegistryForTests(null); await f.host.end(); }
});

test("a first turn arriving during host evidence withdraws the stop", async () => {
  const f = await silentLaunch();
  try {
    const readHost = f.h.ports.conversationHostProcess!;
    f.h.ports.conversationHostProcess = async id => {
      const result = await readHost(id);
      const receipt = f.registry.spawnReceipt(f.attempt().launchId!)!;
      await f.client.command({ operationId: `spawn_message_${receipt.launchId}`, conversationId: receipt.conversationId,
        kind: "send", text: "Build the change" } as Parameters<typeof f.client.command>[0]);
      const at = f.h.ports.now();
      fs.writeFileSync(receipt.artifactPath!, [
        { timestamp: at, type: "session_meta", payload: { id: "late-stage" } },
        { timestamp: at, type: "event_msg", payload: { type: "task_started" } },
      ].map(row => JSON.stringify(row)).join("\n") + "\n");
      return result;
    };
    f.advance(BUDGET); await f.wake();
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
    expect(f.attempt().state).toBe("running");
    expect((await readHost(f.attempt().conversationId!)).state).toBe("alive");
  } finally { setAgentRegistryForTests(null); await f.host.end(); }
});

test("retry-stage never terminates a replacement after its first native answer arrives", async () => {
  const f = await silentLaunch();
  try {
    f.advance(BUDGET); await f.wake();
    const lane = loadPipelines()[0]!;
    const replacement = lane.runs[0]!.attempts[1]!;
    expect(replacement.restartRecovery).toBeDefined();
    expect(replacement.launchId).toBeDefined();
    const receipt = f.registry.spawnReceipt(replacement.launchId!)!;
    expect(receipt.artifactPath).toBeDefined();
    await f.client.command({ operationId: `spawn_message_${receipt.launchId}`, conversationId: receipt.conversationId,
      kind: "send", text: "Build the change" } as Parameters<typeof f.client.command>[0]);
    const at = f.h.ports.now();
    fs.writeFileSync(receipt.artifactPath!, [
      { timestamp: at, type: "session_meta", payload: { id: "replacement-stage" } },
      { timestamp: at, type: "event_msg", payload: { type: "task_started" } },
      { timestamp: at, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "I am working" }] } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    replacement.state = "needs_decision";
    replacement.completedAt = f.h.ports.now();
    replacement.error = "stage spawn first message remained unanswered in the automatic replacement; retry-stage to start another attempt";
    lane.state = "needs_decision"; lane.stateDetail = replacement.error;
    lane.cursor!.state = "spawning";
    savePipelines([lane]);
    let stopCalls = 0;
    const stop = f.h.ports.stopStageAgent;
    f.h.ports.stopStageAgent = async (...args) => { stopCalls++; return stop(...args); };

    const result = await patchPipeline(lane.id, {
      action: "retry-stage", stageId: "build", launchId: replacement.launchId!,
    }, f.h.ports);

    expect(stopCalls).toBe(0);
    expect(result.error).toContain("could not verify that the first message remains unanswered");
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(2);
    expect(loadPipelines()[0]!.runs[0]!.attempts[1]).toMatchObject({ state: "needs_decision", completedAt: expect.any(String) });
  } finally { setAgentRegistryForTests(null); await f.host.end(); }
});

test.each(["failed", "unconfirmed"] as const)("a %s stop keeps the original launch", async outcome => {
  const f = await silentLaunch();
  try {
    f.h.ports.stopStageAgent = async () => outcome === "failed"
      ? { outcome, error: "recorded identity changed" }
      : { outcome, operationId: null, detail: "termination not confirmed" };
    f.advance(BUDGET); await f.wake();
    const lane = loadPipelines()[0]!;
    expect(lane.runs[0]!.attempts).toHaveLength(1);
    expect(lane.stateDetail).toContain("termination was not confirmed");
    expect(f.registry.spawnReceipt(f.attempt().launchId!)?.state).toBe("path-pending");
  } finally { setAgentRegistryForTests(null); await f.host.end(); }
});

test("replacement budget survives a fresh controller process", async () => {
  const input = process.env.LLV_SPAWN_RESTART_CASE;
  if (input) {
    const lane = JSON.parse(fs.readFileSync(input, "utf8"));
    savePipelines([lane]);
    const h = harness();
    const a = lane.runs[0].attempts.at(-1);
    Object.assign(a, { state: "spawning", launchId: "launch-replacement", conversationId: "conversation_replacement",
      agentPath: null, sessionId: null, paneId: null, startedAt: "2026-10-19T12:00:00Z", completedAt: null });
    lane.state = "running"; lane.cursor.state = "spawning";
    savePipelines([lane]);
    h.ports.now = () => "2026-10-19T13:00:00Z";
    h.ports.spawnReceipt = id => ({ launchId: id, conversationId: a.conversationId, state: "path-pending",
      sessionId: null, transcript: null, paneId: null, currentGeneration: true,
      error: "structured launch recovery: " + JSON.stringify({ phase: "uncertain", checks: 16, startedAt: Date.parse(a.startedAt),
        nextTryAt: 0, stopped: true, reason: "runtime host recovery exhausted after 16 checks" }) });
    h.ports.transcriptPresent = () => false;
    h.ports.pathForConversation = () => null;
    h.ports.conversationHostProcess = async () => ({ state: "gone", pid: null });
    h.ports.stopStageAgent = async () => ({ outcome: "not-running" });
    h.ports.failStoppedStageLaunch = async () => true;
    const spawnAgent = h.ports.spawnAgent;
    h.ports.spawnAgent = async () => { throw new Error("replacement budget must park before launch"); };
    await tickPipelines([], h.ports);
    const parked = loadPipelines()[0]!;
    expect(parked.runs[0]!.attempts).toHaveLength(2);
    expect(parked.state).toBe("needs_decision");
    expect(parked.stateDetail).toContain("in the automatic replacement; retry-stage");
    const capped = parked.runs[0]!.attempts.at(-1)!;
    const retried = await patchPipeline(parked.id, {
      action: "retry-stage", stageId: "build", launchId: capped.launchId!,
    }, h.ports);
    expect(retried.error).toBeUndefined();
    const resumed = loadPipelines()[0]!;
    expect(resumed.runs[0]!.attempts).toHaveLength(3);
    expect(resumed.runs[0]!.attempts[2]!.restartContext).toMatchObject({ previousAttempt: 2 });
    expect(resumed.runs[0]!.attempts[2]!.restartRecovery?.replacedAttempt).toBeUndefined();
    const freshRoot = resumed.runs[0]!.attempts[2]!;
    const freshLaunchId = "launch-manual-retry";
    const freshConversationId = "conversation_manual_retry";
    const freshStartedAt = "2026-10-19T12:00:00Z";
    Object.assign(freshRoot, { state: "spawning", launchId: freshLaunchId, conversationId: freshConversationId,
      agentPath: null, sessionId: null, paneId: null, startedAt: freshStartedAt, completedAt: null });
    resumed.state = "running"; resumed.cursor!.state = "spawning";
    savePipelines([resumed]);
    h.ports.spawnReceipt = id => id === freshLaunchId ? ({ launchId: id, conversationId: freshConversationId, state: "path-pending",
      sessionId: null, transcript: null, paneId: null, currentGeneration: true,
      error: "structured launch recovery: " + JSON.stringify({ phase: "uncertain", checks: 16, startedAt: Date.parse(freshStartedAt),
        nextTryAt: 0, stopped: true, reason: "runtime host recovery exhausted after 16 checks" }) }) : null;
    h.ports.spawnAgent = spawnAgent;
    await tickPipelines([], h.ports);
    const chained = loadPipelines()[0]!;
    expect(chained.runs[0]!.attempts).toHaveLength(4);
    expect(chained.state).toBe("running");
    expect(chained.runs[0]!.attempts[3]!.restartContext).toMatchObject({ previousAttempt: 3 });
    console.log("replacement cap survived restart");
    return;
  }
  const f = await silentLaunch();
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR!, "spawn-controller-restart-"));
  try {
    f.advance(BUDGET); await f.wake();
    const lane = loadPipelines()[0]!;
    expect(lane.runs[0]!.attempts).toHaveLength(2);
    const filename = path.join(root, "lane.json"); fs.writeFileSync(filename, JSON.stringify(lane));
    const child = Bun.spawn([process.execPath, "test", import.meta.filename, "--test-name-pattern", "replacement budget survives a fresh controller process"], {
      env: { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, "config"), TMPDIR: root,
        LLV_STATE_DIR: path.join(root, "state"), LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1", LLV_SPAWN_RESTART_CASE: filename },
      stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(30_000),
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stderr }).toMatchObject({ code: 0 });
    expect(stdout).toContain("replacement cap survived restart");
  } finally { setAgentRegistryForTests(null); await f.host.end(); fs.rmSync(root, { recursive: true, force: true }); }
});


test("a pause arriving during host observation prevents termination", async () => {
  const f = await silentLaunch();
  try {
    const readHost = f.h.ports.conversationHostProcess!;
    f.h.ports.conversationHostProcess = async id => {
      const result = await readHost(id);
      const rows = loadPipelines(); rows[0]!.state = "paused"; rows[0]!.pausedState = "running";
      savePipelines(rows);
      return result;
    };
    f.advance(BUDGET); await f.wake();
    expect(loadPipelines()[0]!.state).toBe("paused");
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
    expect((await readHost(f.attempt().conversationId!)).state).toBe("alive");
  } finally { setAgentRegistryForTests(null); await f.host.end(); }
});

test("a controller resumes the receipt-failure handoff before reserving its replacement", async () => {
  const f = await silentLaunch();
  try {
    const fail = f.h.ports.failStoppedStageLaunch!;
    let interrupted = true;
    f.h.ports.failStoppedStageLaunch = async (...args) => {
      const result = await fail(...args);
      if (result && interrupted) { interrupted = false; throw new Error("controller exited after receipt failure"); }
      return result;
    };
    f.advance(BUDGET);
    await expect(f.wake()).rejects.toThrow("controller exited after receipt failure");
    expect(f.registry.spawnReceipt(f.attempt().launchId!)?.state).toBe("failed");
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
    await f.wake();
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(2);
  } finally { setAgentRegistryForTests(null); await f.host.end(); }
});


test.each(["writer", "generation", "transcript", "pause"] as const)("a newer %s at receipt settlement retains the launch", async change => {
  const f = await silentLaunch();
  try {
    const fail = f.h.ports.failStoppedStageLaunch!;
    f.h.ports.failStoppedStageLaunch = async (...args) => {
      const receipt = f.registry.spawnReceipt(args[0])!;
      if (change === "writer") {
        const { captureProcessIdentity } = await import("@/lib/processIdentity");
        const entry = f.registry.readOnlySnapshot().entries[`codex:${receipt.key!.sessionId}`]!;
        f.registry.upsert({ ...entry, claimOwner: `structured-host:${JSON.stringify(captureProcessIdentity(process.pid))}`, claimEpoch: entry.claimEpoch + 1 });
      } else if (change === "generation") {
        const { captureProcessIdentity } = await import("@/lib/processIdentity");
        const before = f.registry.readOnlySnapshot(); const next = structuredClone(before);
        const conversation = next.conversations[receipt.conversationId]!;
        const previous = conversation.generations.at(-1)!;
        conversation.generations.push({ ...previous, id: "replacement-generation" });
        const entry = next.entries[`codex:${receipt.key!.sessionId}`]!;
        next.entries["codex:replacement-generation"] = { ...entry, key: { engine: "codex", sessionId: "replacement-generation" },
          status: "live", structuredHost: { ...entry.structuredHost!, process: captureProcessIdentity(process.pid) } };
        f.registry.restoreSnapshot(before, next);
      } else if (change === "transcript") {
        fs.writeFileSync(receipt.artifactPath!, JSON.stringify({ timestamp: f.h.ports.now(), type: "event_msg", payload: { type: "task_started" } }) + "\n");
      } else {
        const rows = loadPipelines(); rows[0]!.state = "paused"; rows[0]!.pausedState = "running"; savePipelines(rows);
      }
      return fail(...args);
    };
    f.advance(BUDGET); await f.wake();
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
    expect(f.registry.spawnReceipt(f.attempt().launchId!)?.state).toBe("path-pending");
    if (change === "pause") expect(loadPipelines()[0]!.state).toBe("paused");
  } finally { setAgentRegistryForTests(null); await f.host.end(); }
});


test.each(["generation", "writer"] as const)("a newer %s during host observation prevents signalling either host", async change => {
  const f = await silentLaunch();
  const peer = await stageHostChild();
  try {
    const readHost = f.h.ports.conversationHostProcess!;
    let changed = false;
    f.h.ports.conversationHostProcess = async id => {
      const result = await readHost(id);
      if (changed) return result;
      changed = true;
      const before = f.registry.readOnlySnapshot();
      const next = structuredClone(before);
      const receipt = next.receipts[f.attempt().launchId!]!;
      const originalKey = `codex:${receipt.key!.sessionId}`;
      const entry = next.entries[originalKey]!;
      if (change === "writer") entry.claimEpoch++;
      else {
        const conversation = next.conversations[receipt.conversationId]!;
        const previous = conversation.generations.at(-1)!;
        const pathname = `${previous.path}.replacement`;
        conversation.generations.push({ ...previous, id: "replacement-generation", path: pathname });
        next.entries["codex:replacement-generation"] = { ...entry, key: { engine: "codex", sessionId: "replacement-generation" },
          artifactPath: pathname, structuredHostOperationId: "launch-replacement",
          structuredHost: { ...entry.structuredHost!, process: peer.process } };
      }
      f.registry.restoreSnapshot(before, next);
      return result;
    };
    f.advance(BUDGET); await f.wake();
    const { processIdentityStatus } = await import("@/lib/processIdentity");
    expect(processIdentityStatus(f.host.process)).toBe("alive");
    expect(processIdentityStatus(peer.process)).toBe("alive");
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
  } finally { setAgentRegistryForTests(null); await f.host.end(); await peer.end(); }
});


test("a previously adopted running turn never re-enters silent first-message replacement", async () => {
  const f = await silentLaunch();
  try {
    const receipt = f.registry.spawnReceipt(f.attempt().launchId!)!;
    await f.client.command({ operationId: `spawn_message_${receipt.launchId}`, conversationId: receipt.conversationId,
      kind: "send", text: "Build the change" } as Parameters<typeof f.client.command>[0]);
    const at = f.h.ports.now();
    fs.writeFileSync(receipt.artifactPath!, [
      { timestamp: at, type: "session_meta", payload: { id: "working-stage" } },
      { timestamp: at, type: "event_msg", payload: { type: "task_started" } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    await f.wake();
    expect(f.attempt().state).toBe("running");
    fs.unlinkSync(receipt.artifactPath!);
    let silentStops = 0;
    const stop = f.h.ports.stopStageAgent;
    f.h.ports.stopStageAgent = async (target, options) => {
      if (options?.recordedIdentity) silentStops++;
      return stop(target, options);
    };
    f.advance(BUDGET); await f.wake();
    expect(silentStops).toBe(0);
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
  } finally { setAgentRegistryForTests(null); await f.host.end(); }
});
