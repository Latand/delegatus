import { afterAll, afterEach, expect, setSystemTime, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cancelSeatQuotaOnControl, defaultSeatQuotaRecoveryPorts, recoverSeatQuota, readSeatQuotaObligation, seatQuotaDispatchGuard, type SeatQuotaObservation, type SeatQuotaRecoveryPorts } from "./seatQuotaRecovery";
import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } from "@/lib/orchestrator/seats";
import { dispatchStructuredControl } from "@/lib/runtime/structuredControls";
import { StructuredDispatchDeferredError, StructuredSendRefusedError } from "@/lib/runtime/engineHost";
import type { StructuredMessageRequest } from "@/lib/runtime/structuredMessageDelivery";
import { SEAT_QUOTA_RECOVERY_ROLE } from "@/lib/runtime/recoveryNotices";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "seat-quota-check-"));
const previous = process.env.LLV_STATE_DIR;
const CUT = Date.parse("2026-10-26T10:00:00.000Z");
const RESET = CUT + 600_000;
let ordinal = 0;
afterEach(() => { setSystemTime(); setAgentRegistryForTests(null); if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous; });
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function harness() {
  process.env.LLV_STATE_DIR = path.join(root, `case-${++ordinal}`);
  const seat = { conversationId: "conversation_seat", seatEpoch: 7, designatedAt: new Date(CUT - 60_000).toISOString() };
  const observation: SeatQuotaObservation = { accountId: "account-a", path: "seat.jsonl",
    evidence: { turn: "terminal", message: null, promptHistoryComplete: true, requestedCutOpen: true,
      terminalProviderMessage: { ts: CUT, text: "You've hit your session limit", errorClass: "rate_limit", usageLimit: { resetsAt: RESET / 1000 } } },
    request: { operationId: "original-operation", clientMessageId: "original-submission", createdAt: new Date(CUT - 1000).toISOString() },
    capacity: "exhausted", observedAt: CUT, resetsAt: RESET / 1000 };
  const sent: StructuredMessageRequest[] = [];
  const h = { seat: seat as typeof seat | null, observation, now: CUT + 1, stopped: false, held: false, current: true, sent,
    observeHook: undefined as (() => void) | undefined, controlHook: undefined as (() => void) | undefined };
  const ports: SeatQuotaRecoveryPorts = {
    now: () => h.now, seat: () => h.seat, held: () => h.held, current: () => h.current,
    observe: async () => { h.observeHook?.(); return h.observation; },
    stopped: async () => { h.controlHook?.(); return h.stopped; },
    send: async (request, eligible) => { if (await eligible()) sent.push(request); },
  };
  return { h, ports, recover: () => recoverSeatQuota("fixture", ports), read: () => readSeatQuotaObligation("fixture"),
    guard: () => seatQuotaDispatchGuard("fixture", ports) };
}

test("retains the ask before reset, then submits its stable recovery identity with Viewer authorship", async () => {
  const f = harness();
  expect(await f.recover()).toBe(true);
  const owed = f.read()!;
  expect(owed.state).toBe("owed");
  expect(f.h.sent).toEqual([]);
  f.h.now = RESET - 1; f.h.observation.capacity = "unknown";
  await f.recover(); expect(f.h.sent).toEqual([]);
  f.h.now = RESET;
  await f.recover(); await f.recover();
  expect(f.h.sent).toHaveLength(2);
  expect(new Set(f.h.sent.map(row => row.clientMessageId))).toEqual(new Set([owed.id]));
  expect(f.h.sent[0]).toMatchObject({ operationId: owed.id, conversationId: "conversation_seat", policy: "queue", turnId: null,
    origin: { kind: "agent", role: SEAT_QUOTA_RECOVERY_ROLE, project: "fixture" }, cohortAt: owed.original.createdAt });
  expect(f.read()?.original).toEqual(owed.original);
});

test.each(["exhausted", "old-sample", "unknown-reset", "drain"])("withholds recovery on %s", async condition => {
  const f = harness();
  if (condition === "unknown-reset") f.h.observation.evidence.terminalProviderMessage!.usageLimit = { resetsAt: null };
  if (condition === "unknown-reset") f.h.observation.resetsAt = null;
  await f.recover();
  f.h.now = condition === "old-sample" ? RESET - 1 : RESET + 1;
  if (condition === "exhausted") f.h.observation.observedAt = RESET;
  if (condition === "old-sample") f.h.observation.capacity = "available";
  if (condition === "unknown-reset") f.h.observation.capacity = "unknown";
  if (condition === "drain") { f.h.observation.capacity = "unknown"; f.h.held = true; }
  await f.recover();
  expect(f.h.sent).toEqual([]);
  expect(f.read()?.state).toBe("owed");
});

test("the elapsed provider reset releases its older exhausted sample, while a later window still holds", async () => {
  const f = harness(); await f.recover(); f.h.now = RESET;
  f.h.observation.resetsAt = (RESET + 60_000) / 1000;
  await f.recover(); expect(f.h.sent).toEqual([]);
  f.h.observation.resetsAt = RESET / 1000;
  await f.recover(); expect(f.h.sent).toHaveLength(1);
});

test("a newer exhausted reading keeps its reset after that reading becomes stale", async () => {
  const f = harness(); await f.recover();
  const later = RESET + 3_600_000;
  f.h.now = RESET; f.h.observation.observedAt = RESET; f.h.observation.resetsAt = later / 1000;
  await f.recover(); expect(f.read()?.resetsAt).toBe(later / 1000);
  f.h.now = RESET + 600_000; f.h.observation.capacity = "unknown";
  await f.recover(); expect(f.h.sent).toEqual([]);
  f.h.now = later; await f.recover(); expect(f.h.sent).toHaveLength(1);
});

test("confirmed exhaustion after the recorded reset needs new evidence when no later reset is known", async () => {
  const f = harness(); await f.recover();
  f.h.now = RESET + 1; f.h.observation.observedAt = RESET + 1;
  await f.recover(); expect(f.read()?.resetsAt).toBeNull();
  f.h.now = RESET + 600_000; f.h.observation.capacity = "unknown";
  await f.recover(); expect(f.h.sent).toEqual([]);
  f.h.observation.capacity = "available"; f.h.observation.observedAt = f.h.now;
  await f.recover(); expect(f.h.sent).toHaveLength(1);
});

test("a fresh eligible sample can end an unknown-reset hold; its earlier sample cannot", async () => {
  const f = harness();
  f.h.observation.evidence.terminalProviderMessage!.usageLimit = { resetsAt: null }; f.h.observation.resetsAt = null;
  await f.recover();
  f.h.observation.capacity = "available";
  await f.recover(); expect(f.h.sent).toEqual([]);
  f.h.observation.observedAt = CUT + 1;
  await f.recover(); expect(f.h.sent).toHaveLength(1);
});

test.each(["rotation", "revoke", "reply", "prompt", "account", "control"])("%s cancels an owed ask across later checks", async condition => {
  const f = harness(); await f.recover();
  if (condition === "rotation") f.h.seat = { ...f.h.seat!, seatEpoch: 8, conversationId: "conversation_successor" };
  if (condition === "revoke") f.h.seat = null;
  if (condition === "reply") { f.h.observation.evidence.terminalProviderMessage = null; f.h.observation.evidence.message = { text: "answered", ts: CUT + 1 }; }
  if (condition === "prompt") f.h.observation.evidence.externalPromptAfterCut = true;
  if (condition === "account") f.h.observation.accountId = "account-b";
  if (condition === "control") f.h.stopped = true;
  f.h.now = RESET; f.h.observation.capacity = "unknown";
  await f.recover(); await f.recover();
  expect(f.h.sent).toEqual([]);
  expect(f.read()?.state).toBe("cancelled");
});

test.each(["observe", "control", "host-write"])("rotation at %s cannot send to the predecessor", async boundary => {
  const f = harness(); await f.recover();
  f.h.now = RESET; f.h.observation.capacity = "unknown";
  const rotate = () => { f.h.seat = { ...f.h.seat!, seatEpoch: 8 }; };
  if (boundary === "observe") f.h.observeHook = rotate;
  if (boundary === "control") f.h.controlHook = rotate;
  if (boundary === "host-write") { const guard = await f.guard(); rotate(); expect(guard).toThrow(StructuredSendRefusedError); }
  else await f.recover();
  expect(f.h.sent).toEqual([]);
});

test("a late transcript or quota change defers the claimed send without giving it another identity", async () => {
  const f = harness(); await f.recover();
  f.h.now = RESET; f.h.observation.capacity = "unknown";
  const guard = await f.guard();
  f.h.current = false;
  expect(guard).toThrow(StructuredDispatchDeferredError);
  const current = f.ports.current;
  f.ports.current = () => { throw new Error("authority read unavailable"); };
  expect(guard).toThrow(StructuredDispatchDeferredError);
  f.ports.current = current;
  const id = f.read()!.id;
  f.h.current = true; await f.recover();
  expect(f.h.sent[0]?.clientMessageId).toBe(id);
});

test("an unreadable control source keeps the durable obligation and dispatches nothing", async () => {
  const f = harness(); f.h.now = RESET; f.h.observation.capacity = "unknown";
  f.ports.stopped = async () => { throw new Error("control unavailable"); };
  await expect(f.recover()).rejects.toThrow("control unavailable");
  expect(f.read()?.state).toBe("owed"); expect(f.h.sent).toEqual([]);
});

test.each(["unknown", "empty-terminal", "incomplete-history"])("%s evidence keeps the obligation retryable", async condition => {
  const f = harness(); await f.recover();
  const evidence = structuredClone(f.h.observation.evidence);
  f.h.now = RESET; f.h.observation.capacity = "unknown";
  if (condition === "incomplete-history") f.h.observation.evidence.promptHistoryComplete = false;
  else { f.h.observation.evidence.turn = condition === "unknown" ? "unknown" : "terminal"; f.h.observation.evidence.terminalProviderMessage = null; }
  await f.recover(); expect(f.read()?.state).toBe("owed"); expect(f.h.sent).toEqual([]);
  await expect(f.guard()).rejects.toBeInstanceOf(StructuredDispatchDeferredError);
  f.h.observation.evidence = evidence;
  await f.recover(); expect(f.h.sent).toHaveLength(1);
});

test("an ACK loss retains the exact submitted key and a second provider cut cannot create a second ask", async () => {
  const f = harness(); await f.recover(); f.h.now = RESET; f.h.observation.capacity = "unknown";
  f.ports.send = async request => { f.h.sent.push(request); throw new Error("ack lost"); };
  await expect(f.recover()).rejects.toThrow("ack lost");
  const id = f.read()!.id;
  f.ports.send = async request => { f.h.sent.push(request); };
  await f.recover(); expect(f.h.sent.map(row => row.clientMessageId)).toEqual([id, id]);
  f.h.observation.evidence.terminalProviderMessage!.ts = RESET + 1;
  await f.recover(); await f.recover();
  expect(f.h.sent).toHaveLength(2);
});

test("reboot replays the owed and ACK-lost submission through the real journal exactly once", async () => {
  const directory = path.join(root, `process-${++ordinal}`);
  fs.mkdirSync(directory, { recursive: true });
  const fixture = path.join(import.meta.dir, "fixtures/seatQuotaReplay.ts");
  const run = async (phase: string) => {
    const child = Bun.spawn([process.execPath, fixture, phase], { env: { ...process.env, LLV_STATE_DIR: directory },
      stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [output, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, error).toBe(0);
    return JSON.parse(output.trim().split("\n").at(-1)!);
  };
  const owed = await run("before-reset");
  expect(owed.state).toBe("owed"); expect(owed.count).toBe(0);
  const lost = await run("ack-lost");
  const replay = await run("replay");
  expect(lost.id).toBe(owed.id); expect(replay.id).toBe(owed.id);
  expect(replay.count).toBe(1); expect(replay.replayed).toBe(true);
  const controlDirectory = path.join(root, `controls-${++ordinal}`);
  fs.mkdirSync(controlDirectory, { recursive: true });
  const control = async (phase: string) => {
    const child = Bun.spawn([process.execPath, fixture, phase], { env: { ...process.env, LLV_STATE_DIR: controlDirectory }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [output, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, error).toBe(0); return JSON.parse(output.trim().split("\n").at(-1)!);
  };
  const page = await control("control-page");
  expect(page.state).toBe("owed"); expect(page.cursor).toBeGreaterThan(0); expect(page.count).toBe(0);
  const cancelled = await control("control-replay");
  expect(cancelled.state).toBe("cancelled"); expect(cancelled.count).toBe(0);
});

test("operator control before detection fences the old request without granting a new obligation", async () => {
  const f = harness();
  const at = new Date(CUT - 60_000).toISOString();
  beginOrchestratorSeatIntent({ project: "fixture", mandate: "coordinate work", clientRequestId: "controlled-seat", mode: "existing", now: at });
  const activated = completeOrchestratorSeatIntent({ project: "fixture", clientRequestId: "controlled-seat", conversationId: "conversation_seat", path: "seat.jsonl", now: at });
  expect(activated.kind).toBe("activated");
  const { orchestratorSeatFor } = await import("@/lib/orchestrator/seats");
  f.h.seat!.seatEpoch = orchestratorSeatFor("fixture").active!.seatEpoch;
  setSystemTime(CUT + 1); await cancelSeatQuotaOnControl("conversation_seat");
  f.h.now = RESET; f.h.observation.capacity = "unknown";
  await f.recover(); expect(f.h.sent).toEqual([]); expect(f.read()).toBeNull();
});

test("native Claude quota evidence joins the request whose turn failed and invalidates on later output", async () => {
  const directory = path.join(root, `native-${++ordinal}`);
  fs.mkdirSync(directory, { recursive: true }); process.env.LLV_STATE_DIR = directory;
  const transcript = path.join(directory, "11111111-1111-\x34111-8111-111111111111.jsonl");
  const started = CUT - 500;
  const native = [
    { type: "user", timestamp: new Date(started).toISOString(), message: { role: "user", content: "check existing work" } },
    { type: "assistant", timestamp: new Date(CUT).toISOString(), isApiErrorMessage: true, error: "rate_limit",
      message: { role: "assistant", model: "<synthetic>", stop_reason: "stop_sequence", content: [{ type: "text", text: "You've hit your session limit · resets 10:10am (UTC)" }] } },
  ];
  fs.writeFileSync(transcript, native.map(row => JSON.stringify(row)).join("\n") + "\n");
  setSystemTime(CUT - 1000);
  const registry = new AgentRegistry(path.join(directory, "registry.json")); setAgentRegistryForTests(registry);
  try {
    registry.reconcileConversations([{ engine: "claude", path: transcript, accountId: "account-a",
      launchProfile: emptyLaunchProfile({ cwd: directory, project: "fixture", model: "opus" }),
      turn: { state: "idle", source: "empty", terminalAt: null }, observedAt: new Date(CUT - 1000).toISOString() }]);
    const conversation = registry.conversationForPath(transcript)!;
    const reservation = registry.holdDelivery(conversation.id, "check existing work", "native-submission", "text", [], null, { operationId: "native-operation" });
    setSystemTime(CUT + 1); registry.recordDeliveryOutcome(reservation.id, "delivered");
    const seat = { conversationId: conversation.id, seatEpoch: 7, designatedAt: new Date(CUT - 60_000).toISOString() };
    const ports = defaultSeatQuotaRecoveryPorts();
    const observation = await ports.observe("fixture", seat);
    expect(observation?.evidence.terminalProviderMessage).toMatchObject({ ts: CUT, usageLimit: { resetsAt: RESET / 1000 } });
    expect(observation?.request).toMatchObject({ operationId: "native-operation", clientMessageId: "native-submission" });
    expect(ports.current(observation!)).toBe(true);
    const again = await ports.observe("fixture", seat);
    expect(again?.evidence).toBe(observation?.evidence);
    fs.appendFileSync(transcript, JSON.stringify({ type: "user", timestamp: new Date(CUT + 1).toISOString(),
      interruptedByShutdown: true, message: { role: "user", content: "[Request interrupted by user]" } }) + "\n");
    const afterRestart = await ports.observe("fixture", seat, CUT);
    expect(afterRestart?.evidence.terminalProviderMessage?.ts).toBe(CUT);
    expect(afterRestart?.evidence.turnStartedAt).toBe(started);
    beginOrchestratorSeatIntent({ project: "fixture", mandate: "coordinate work", clientRequestId: "native-seat", mode: "existing", now: seat.designatedAt });
    completeOrchestratorSeatIntent({ project: "fixture", clientRequestId: "native-seat", conversationId: conversation.id,
      path: transcript, now: seat.designatedAt });
    const recoveryPorts = { ...ports, stopped: async () => false, send: async () => { throw new Error("must wait for reset"); } };
    await recoverSeatQuota("fixture", recoveryPorts);
    expect(readSeatQuotaObligation("fixture")?.state).toBe("owed");
    setSystemTime(RESET);
    const dispatchGuard = await seatQuotaDispatchGuard("fixture", recoveryPorts);
    await dispatchStructuredControl({ path: transcript, conversationId: conversation.id, action: "resume", controlOrigin: { kind: "operator" } },
      { registry, enabled: () => true, client: null });
    expect(readSeatQuotaObligation("fixture")?.state).toBe("cancelled");
    expect(dispatchGuard).toThrow(StructuredSendRefusedError);
    expect(await recoverSeatQuota("fixture", recoveryPorts)).toBe(false);
    fs.appendFileSync(transcript, JSON.stringify({ type: "assistant", timestamp: new Date(CUT + 2).toISOString(),
      message: { role: "assistant", model: "opus", stop_reason: "end_turn", content: [{ type: "text", text: "work checked" }] } }) + "\n");
    expect(ports.current(observation!)).toBe(false);
    expect((await ports.observe("fixture", seat, CUT))?.evidence.terminalProviderMessage).toBeNull();
    registry.rememberMembership(conversation.id, { kind: "pipeline", containerId: "fixture-pipeline", role: "builder", slot: "build",
      stageId: "build", stageOrder: 0, round: 1, parentConversationId: null });
    expect(await ports.observe("fixture", seat, CUT)).toBeNull();
  } finally { registry.close(); }
});
