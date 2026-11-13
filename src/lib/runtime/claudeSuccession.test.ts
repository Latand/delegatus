import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { fixtureRegistry, FIXTURE_SESSION, FIXTURE_NOW, FIXTURE_CONVERSATION } from "@/lib/agentState/testFixture";
import { AgentStateService } from "@/lib/agentState/service";
import { readAgentStateMetrics } from "@/lib/agentState/store";
import { AgentTranscriptCache } from "@/lib/agentState/transcript";
import { verifiedBackgroundWork } from "@/lib/pipelines/backgroundTasks";
import { captureProcessIdentity, processIdentityStatus } from "@/lib/processIdentity";
import { ClaudeStreamBrokerHost, FileClaudeDeliveryLedger } from "./claudeStreamBrokerHost";
import { FileRuntimeEventStore } from "./eventStore";
import { interruptionObligationDirectory, interruptionObligationStore } from "./interruptionObligations";
import { adoptClaudeRegistryHosts, bindClaudeHostPersistence, claudeHostColumns, demoteSkippedStructuredRegistryHosts, stopTerminalStructuredOrphan } from "./registry";
import { releaseStructuredDeliveryHostsForDemotion, retainUnpublishedStructuredLaunchHost } from "./structuredDeliveryController";

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 7000;
  while (!await check()) {
    if (performance.now() > deadline) throw new Error("fixture handshake expired");
    await Bun.sleep(5);
  }
}
async function fixture(mode: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-succession-"));
  const file = (name: string) => path.join(root, name);
  const gate = (name: string) => fs.writeFileSync(file(name), "go");
  const priorState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = file("state");
  const eventStore = new FileRuntimeEventStore();
  const host = await ClaudeStreamBrokerHost.start({
    cwd: root, sessionId: FIXTURE_SESSION, eventStore, deliveryLedger: new FileClaudeDeliveryLedger(file("deliveries")),
    readTranscript: () => [], readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
    spawnProcess: (_command, _args, options) => spawn(process.execPath,
      [path.join(import.meta.dir, "fixtures/claudeBackgroundSuccessionChild.ts"), root, FIXTURE_SESSION, mode],
      { ...options, stdio: ["pipe", "pipe", "pipe"], detached: true }),
  });
  await host.send({ id: "local-prompt-ref", text: "fixture work" });
  await until(() => fs.existsSync(file(mode === "anchor" ? "native.jsonl" : "tool.pid")));
  if (mode === "idle") await until(async () => (await host.health()).status === "idle");
  const health = await host.health();
  const engine = captureProcessIdentity(health.pid!);
  const tool = mode === "anchor" ? null : captureProcessIdentity(Number(fs.readFileSync(file("tool.pid"), "utf8")));
  let registry = new AgentRegistry(file("registry.json"), undefined, undefined, { sqliteMode: "sqlite" });
  const initial = fixtureRegistry(root, "claude", engine, captureProcessIdentity(process.pid));
  initial.entries[`claude:${FIXTURE_SESSION}`]!.structuredHost = claudeHostColumns(health, 1);
  await registry.deliveryWriteOrBusy({ label: "fixture.succession" }, () => registry.agentStateWrite(rows => Object.assign(rows, initial)));
  setAgentRegistryForTests(registry);
  const unbind = await bindClaudeHostPersistence(registry, { engine: "claude", sessionId: FIXTURE_SESSION }, host,
    initial.entries[`claude:${FIXTURE_SESSION}`]!.claimOwner!, 1);
  const forget = retainUnpublishedStructuredLaunchHost({ key: { engine: "claude", sessionId: FIXTURE_SESSION }, host, registry, release: () => host.release() });
  return { root, file, gate, host, engine, tool, eventStore, registry: () => registry,
    restart: async () => { await unbind(); registry.close(); registry = new AgentRegistry(file("registry.json"), undefined, undefined, { sqliteMode: "sqlite" }); setAgentRegistryForTests(registry); },
    cleanup: async () => {
      forget(); await host.release().catch(() => {}); await unbind();
      for (const identity of [engine, tool]) if (identity && processIdentityStatus(identity) === "alive") {
        process.kill(identity.pid, "SIGKILL"); await until(() => processIdentityStatus(identity) !== "alive");
      }
      setAgentRegistryForTests(null); registry.close(); fs.rmSync(root, { recursive: true, force: true });
      if (priorState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = priorState;
    } };
}

// Retained idle-background reproduction, extended to the two health-read race
// and a native notice that precedes delivery on the broker's event stream.
test.each(["idle", "between-health", "result-delayed"])("planned Claude succession retains background custody: %s", async mode => {
  const f = await fixture(mode === "idle" || mode === "result-delayed" ? "idle" : "gated");
  const backgroundAnchors: Array<string | null | undefined> = [];
  const stopObserving = f.host.onStateChange(state => {
    if (state.activeTurnRef?.startsWith("claude-background:")) backgroundAnchors.push(state.agentStateNativeTurnId);
  });
  let demotion: Promise<void> | undefined;
  try {
    if (mode === "result-delayed") f.gate("hold-result");
    const originalHealth = f.host.health.bind(f.host);
    let reads = 0;
    f.host.health = async () => {
      const state = await originalHealth();
      if (mode === "between-health" && ++reads === 1) {
        f.gate("allow-foreground-completion");
        await until(async () => (await originalHealth()).status === "idle");
      }
      return state;
    };
    let settled = false;
    demotion = releaseStructuredDeliveryHostsForDemotion({ boundary: "fixture-succession" }).then(() => { settled = true; });
    // Wait until the real custody reader has observed pending work. The child
    // cannot finish before this independent handshake.
    await until(() => fs.existsSync(f.file("foreground-ended")));
    expect(settled).toBeFalse();
    expect(processIdentityStatus(f.engine)).toBe("alive");
    expect(processIdentityStatus(f.tool!)).toBe("alive");
    // Two complete polls ensure that idle custody has actually been exercised.
    await Bun.sleep(550);
    expect(settled).toBeFalse();
    f.gate("allow-tool-completion");
    if (mode === "result-delayed") {
      await until(() => fs.existsSync(f.file("notice-written")));
      await Bun.sleep(300);
      expect(settled).toBeFalse();
      expect(processIdentityStatus(f.engine)).toBe("alive");
      f.gate("allow-result");
    }
    await demotion;
    const events = f.eventStore.load(FIXTURE_SESSION);
    expect(events.filter(event => event.kind === "delta" && event.text === "background result")).toHaveLength(1);
    const terminals = events.filter(event => event.kind === "turn-ended");
    expect(terminals.filter(event => event.turnId === "local-prompt-ref")).toHaveLength(1);
    expect(terminals.filter(event => event.turnId?.startsWith("claude-background:") && event.status === "completed")).toHaveLength(1);
    expect(fs.readFileSync(f.file("tool-starts"), "utf8")).toBe("start\n");
    expect(fs.readFileSync(f.file("tool-done"), "utf8")).toBe("done");
    expect(backgroundAnchors).toContain("fixture-notice");
    expect(backgroundAnchors.every(anchor => anchor === "fixture-notice")).toBeTrue();
    expect(interruptionObligationStore(interruptionObligationDirectory(f.registry().filename)).list()).toHaveLength(0);
  } finally { stopObserving(); f.gate("allow-foreground-completion"); f.gate("allow-tool-completion"); f.gate("allow-result"); await demotion?.catch(() => {}); await f.cleanup(); }
}, 15000);

test.each(["owner", "artifact"])("replacement during a background read refuses demotion and preserves both processes: %s", async replacement => {
  const f = await fixture("idle");
  const originalOpen = fs.promises.open;
  let replaced = false;
  fs.promises.open = async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args);
    if (!replaced && String(args[0]) === f.file("native.jsonl")) {
      replaced = true;
      await f.registry().deliveryWriteOrBusy({ label: "fixture.replace-owner" }, () => f.registry().agentStateWrite(rows => {
        if (replacement === "owner") rows.entries[`claude:${FIXTURE_SESSION}`]!.claimEpoch++;
        else {
          fs.writeFileSync(f.file("replacement.jsonl"), fs.readFileSync(f.file("native.jsonl")));
          fs.renameSync(f.file("replacement.jsonl"), f.file("native.jsonl"));
        }
      }));
    }
    return handle;
  };
  try {
    await expect(releaseStructuredDeliveryHostsForDemotion()).rejects.toThrow("failed to release");
    expect(replaced).toBeTrue();
    expect(processIdentityStatus(f.engine)).toBe("alive");
    expect(processIdentityStatus(f.tool!)).toBe("alive");
  } finally { fs.promises.open = originalOpen; await f.cleanup(); }
}, 15000);

test.each(["adoption", "terminal", "skipped"])("shared recovery stop preserves unfinished background children: %s", async mode => {
  const f = await fixture("idle");
  const originalNow = Date.now;
  Date.now = () => FIXTURE_NOW + 2000;
  try {
    await f.restart();
    const registry = f.registry();
    await registry.deliveryWriteOrBusy({ label: "fixture.release-and-accept" }, () => {
      registry.agentStateWrite(rows => {
        const entry = rows.entries[`claude:${FIXTURE_SESSION}`]!;
        entry.claimOwner = null;
        if (mode === "terminal") entry.status = "dead";
      });
      registry.holdDelivery(FIXTURE_CONVERSATION, "accepted follow-up", "fixture-follow-up");
    });
    const service = new AgentStateService({ registry, now: () => FIXTURE_NOW + 2000, owns: () => true,
      process: processIdentityStatus, memory: () => null, publish: async () => true, release: "fixture-successor" });
    service.start(); await service.request(); service.stop();
    let replacements = 0;
    if (mode === "adoption") expect(await adoptClaudeRegistryHosts(registry, () => { replacements++; throw new Error("competing engine refused"); },
      { NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "1" })).toHaveLength(0);
    else if (mode === "terminal") {
      expect(registry.hostEntry({ engine: "claude", sessionId: FIXTURE_SESSION })?.status).toBe("dead");
      expect(await stopTerminalStructuredOrphan(registry, { engine: "claude", sessionId: FIXTURE_SESSION })).toBeFalse();
    }
    else await demoteSkippedStructuredRegistryHosts(registry, () => false);
    expect(replacements).toBe(0);
    expect(processIdentityStatus(f.engine)).toBe("alive");
    expect(processIdentityStatus(f.tool!)).toBe("alive");
  } finally { Date.now = originalNow; await f.cleanup(); }
}, 15000);

test("planned-succession custody expiry refuses release and keeps its cause", async () => {
  const f = await fixture("idle");
  const originalNow = Date.now;
  const health = f.host.health.bind(f.host);
  let now = FIXTURE_NOW;
  Date.now = () => now;
  f.host.health = async () => { const current = await health(); now += 3600001; return current; };
  try {
    let failure: AggregateError | undefined;
    try { await releaseStructuredDeliveryHostsForDemotion(); } catch (error) { failure = error as AggregateError; }
    expect(failure?.errors[0]?.message).toContain("planned-succession custody deadline expired");
    expect(processIdentityStatus(f.engine)).toBe("alive");
    expect(processIdentityStatus(f.tool!)).toBe("alive");
  } finally { Date.now = originalNow; await f.cleanup(); }
}, 15000);

test("an ended event stream preserves background custody and the owed interruption", async () => {
  const f = await fixture("idle");
  const originalNow = Date.now;
  Date.now = () => FIXTURE_NOW + 2000;
  f.host.attach = async function* () {};
  try {
    await expect(releaseStructuredDeliveryHostsForDemotion({ boundary: "fixture-ended-stream" })).rejects.toThrow("failed to release");
    expect(processIdentityStatus(f.engine)).toBe("alive");
    expect(processIdentityStatus(f.tool!)).toBe("alive");
    expect(interruptionObligationStore(interruptionObligationDirectory(f.registry().filename)).list()).toHaveLength(1);
  } finally { Date.now = originalNow; await f.cleanup(); }
}, 15000);

// Retained cost reproduction, using the same records and separate processes.
test("temporary background-cache saturation defers demotion until the same job delivers once", async () => {
  const f = await fixture("idle");
  const originalOpen = fs.promises.open;
  let releaseReads!: () => void;
  const held = new Promise<void>(resolve => { releaseReads = resolve; });
  let waiting = 0;
  let custodyContinued = false;
  const blockers: Array<Promise<unknown>> = [];
  let demotion: Promise<void> | undefined;
  let demotionFailure: unknown;
  fs.promises.open = async (...args: Parameters<typeof originalOpen>) => {
    if (String(args[0]).startsWith(f.file("capacity-"))) { waiting++; await held; }
    const handle = await originalOpen(...args);
    if (String(args[0]) === f.file("native.jsonl") && waiting === 64) {
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); custodyContinued = true; };
    }
    return handle;
  };
  try {
    for (let i = 0; i < 64; i++) {
      const pathname = f.file(`capacity-${i}.jsonl`);
      fs.writeFileSync(pathname, "");
      blockers.push(verifiedBackgroundWork(pathname, FIXTURE_NOW));
    }
    await until(() => waiting === 64);
    demotion = releaseStructuredDeliveryHostsForDemotion({ boundary: "fixture-capacity" }).catch(error => { demotionFailure = error; });
    // Observe progress through the real native reader while the background
    // reader is at capacity. A transient refusal must retain the broker.
    await until(() => custodyContinued || demotionFailure !== undefined);
    expect(demotionFailure).toBeUndefined();
    expect(processIdentityStatus(f.engine)).toBe("alive");
    expect(processIdentityStatus(f.tool!)).toBe("alive");
    releaseReads(); await Promise.all(blockers);
    f.gate("allow-tool-completion");
    await demotion;
    expect(f.eventStore.load(FIXTURE_SESSION).filter(event => event.kind === "delta" && event.text === "background result")).toHaveLength(1);
    expect(fs.readFileSync(f.file("tool-starts"), "utf8")).toBe("start\n");
  } finally {
    releaseReads(); await Promise.allSettled(blockers);
    fs.promises.open = originalOpen;
    f.gate("allow-tool-completion"); await demotion?.catch(() => {}); await f.cleanup();
  }
}, 15000);

test("background custody reads zero payload for unchanged versions and folds the terminal suffix", async () => {
  const f = await fixture("cost");
  const originalOpen = fs.promises.open;
  let bytes = 0;
  fs.promises.open = async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === f.file("native.jsonl")) {
      const read = handle.read.bind(handle);
      handle.read = (async (...values: Parameters<typeof read>) => {
        const result = await read(...values);
        bytes += result.bytesRead;
        return result;
      }) as typeof handle.read;
    }
    return handle;
  };
  let demotion: Promise<void> | undefined;
  try {
    const size = fs.statSync(f.file("native.jsonl")).size;
    for (let i = 0; i < 3; i++) {
      const work = await verifiedBackgroundWork(f.file("native.jsonl"), FIXTURE_NOW);
      if (work.state === "read") break;
    }
    const cold = bytes;
    for (let i = 0; i < 3; i++) expect(await verifiedBackgroundWork(f.file("native.jsonl"), FIXTURE_NOW)).toEqual({ state: "read", names: ["background task fixturebackground"] });
    expect(bytes - cold).toBe(0);
    demotion = releaseStructuredDeliveryHostsForDemotion({ boundary: "fixture-cost" });
    f.gate("allow-foreground-completion");
    await until(() => fs.existsSync(f.file("foreground-ended")));
    await Bun.sleep(550);
    f.gate("allow-tool-completion");
    await demotion;
    const before = bytes;
    expect(await verifiedBackgroundWork(f.file("native.jsonl"), FIXTURE_NOW)).toEqual({ state: "read", names: [] });
    expect(bytes - before).toBe(0);
    console.log(JSON.stringify({ size, coldPayloadBytes: cold, unchangedPayloadBytes: 0, totalPayloadBytes: bytes }));
    expect(f.eventStore.load(FIXTURE_SESSION).filter(event => event.kind === "delta" && event.text === "background result")).toHaveLength(1);
  } finally { fs.promises.open = originalOpen; f.gate("allow-foreground-completion"); f.gate("allow-tool-completion"); await demotion?.catch(() => {}); await f.cleanup(); }
}, 15000);

// Retained real-broker correlation reproduction. Restart both the registry and
// reconciliation service after owner loss; exercise the ledger fallback too.
test.each([false, true])("tool output preserves the native prompt through restart (legacy anchor: %s)", async legacy => {
  const f = await fixture("anchor");
  try {
    await until(async () => (await f.host.health()).eventCursor >= 3);
    expect((await f.host.health()).agentStateNativeTurnId).toBe("succession-native-prompt");
    await f.restart();
    const registry = f.registry();
    const key = { engine: "claude" as const, sessionId: FIXTURE_SESSION };
    await registry.deliveryWriteOrBusy({ label: "fixture.owner-loss" }, () => registry.agentStateWrite(rows => {
      rows.entries[`claude:${FIXTURE_SESSION}`]!.claimOwner = null;
      if (legacy) rows.entries[`claude:${FIXTURE_SESSION}`]!.structuredHost!.agentStateNativeTurnId = null;
    }));
    f.gate("allow-terminal");
    await until(() => fs.existsSync(f.file("terminal-written")));
    const native = await new AgentTranscriptCache().acquire({ engine: "claude", path: f.file("native.jsonl"), revision: "fixture", localRef: "local-prompt-ref", observedAt: FIXTURE_NOW });
    expect(native.turn).toMatchObject({ determined: true, value: { state: "closed", nativeId: "succession-native-prompt" } });
    const service = () => new AgentStateService({ registry, now: () => FIXTURE_NOW + 2000, owns: () => true,
      process: processIdentityStatus, memory: () => null, publish: async () => true, release: "fixture-successor" });
    const first = service(); first.start(); await first.request(); first.stop();
    expect(registry.hostEntry(key)?.structuredHost?.activeTurnRef).toBeNull();
    expect(readAgentStateMetrics(registry).registryTranscriptDivergencesTotal).toBe(1);
    expect(registry.agentStateRead(rows => Object.values(rows.agentStateJournal).filter(row => row.divergence === "native-terminal-cache-open").length)).toBe(1);
    const restarted = service(); restarted.start(); await restarted.request(); restarted.stop();
    expect(readAgentStateMetrics(registry).registryTranscriptDivergencesTotal).toBe(1);
    await registry.deliveryWriteOrBusy({ label: "fixture.newer-prompt" }, () => registry.agentStateWrite(rows => {
      const entry = rows.entries[`claude:${FIXTURE_SESSION}`]!;
      entry.structuredHost!.activeTurnRef = "newer-local-ref";
      entry.structuredHost!.agentStateNativeTurnId = "newer-native-prompt";
      entry.structuredHost!.eventCursor += 10;
      rows.conversations[FIXTURE_CONVERSATION]!.turn = { state: "busy", source: "lifecycle", terminalAt: null,
        observedAt: new Date(FIXTURE_NOW + 3000).toISOString() };
    }));
    fs.appendFileSync(f.file("native.jsonl"), [
      { type: "user", uuid: "newer-native-prompt", timestamp: new Date(FIXTURE_NOW + 3000).toISOString(), message: { role: "user", content: "newer work" } },
      { type: "assistant", uuid: "late-old-terminal", parentUuid: "native-tool-output", message: { role: "assistant", model: "fixture", stop_reason: "end_turn", content: [] } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    fs.utimesSync(f.file("native.jsonl"), new Date(FIXTURE_NOW + 3000), new Date(FIXTURE_NOW + 3000));
    const newer = service(); newer.start(); await newer.request(); newer.stop();
    expect(registry.hostEntry(key)?.structuredHost?.activeTurnRef).toBe("newer-local-ref");
    expect(readAgentStateMetrics(registry).registryTranscriptDivergencesTotal).toBe(1);
  } finally { await f.cleanup(); }
}, 15000);
