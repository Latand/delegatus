import { expect, jest, setSystemTime, spyOn, test } from "bun:test";
import fs from "node:fs";
import { accountManager } from "@/lib/accounts/manager";
import { procBackend } from "@/lib/proc";
import { externalRelayFile, readRunLedger, updateRelayStore } from "./store";
import { runClaimedRequest } from "./runner";
import { contextRequest } from "./request.fixture";
import { clonePairing, cloneReceipt } from "./clone.fixture";
import { startTestRelay } from "./testRelay";
import { setRelaySwitch } from "./switches";

// Hold the real ledger lock under a live owner. Only the request clock and
// timer scheduler advance; contention does not depend on machine speed.
function holdLedger() {
  const lock = `${externalRelayFile("runs")}.lock`;
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, identity: procBackend.processIdentity(process.pid) }), { flag: "wx" });
  let released = false;
  const release = () => { if (!released) { released = true; fs.unlinkSync(lock); } };
  return release;
}

function requestClock() {
  let now = Date.parse("2026-11-04T00:00:00Z");
  let contended = false;
  const open = fs.openSync;
  const probe = spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof fs.openSync>) => {
    try { return open(...args); }
    catch (error) { if (args[0] === `${externalRelayFile("runs")}.lock`) contended = true; throw error; }
  });
  jest.useFakeTimers();
  setSystemTime(now);
  // A synchronous wait cannot let our real lock holder release. Advance its
  // clock too so the unfixed stop path expires instead of hanging the test.
  const blocking = spyOn(Atomics, "wait").mockImplementation((_array, _index, _value, timeout) => {
    now += timeout ?? 0; setSystemTime(now); return "timed-out";
  });
  const advance = (ms: number) => { now += ms; setSystemTime(now); jest.advanceTimersByTime(ms); };
  const drive = async (ready: () => boolean) => {
    for (let attempt = 0; attempt < 5000 && !ready(); attempt++) {
      advance(1);
      await fs.promises.stat(process.cwd());
    }
    expect(ready()).toBe(true);
  };
  return { advance, drive, contended: () => contended, now: () => now,
    close: () => { blocking.mockRestore(); jest.useRealTimers(); setSystemTime(); probe.mockRestore(); } };
}

for (const phase of ["renewal", "stop", "answer"] as const) test(`owner retains one answer through ledger contention during ${phase}`, async () => {
  let beats = 0, launches = 0, stops = 0;
  const delivered: string[] = [];
  const service = await startTestRelay((req, body) => {
    if (req.url!.endsWith("/heartbeat")) { beats++; return { body: { status: "ok" } }; }
    if (req.url!.endsWith("/complete")) {
      const completion = body as { answer?: { text: string } };
      if (completion.answer) delivered.push(completion.answer.text);
      return { body: { status: "accepted", duplicate: false } };
    }
    if (req.url!.endsWith("/send")) { delivered.push((body as { text: string }).text); return { body: cloneReceipt() }; }
    return { status: 404, body: {} };
  });
  const relay = clonePairing(service.origin);
  relay.targets[0] = { ...relay.targets[0]!, id: "target_1", enabled: true, ownerTier: true, engine: "codex", model: "auto", hardCapMinutes: 30 };
  updateRelayStore(store => ({ ...store, relays: [relay] }));
  setRelaySwitch("chain_conversations", false);
  const selected = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "available", account: {
    engine: "codex", accountId: "fixture", kind: "managed", home: process.env.HOME!, transcriptRoot: process.env.HOME!, env: { ...process.env } } });
  let release: (() => void) | undefined;
  const request = { ...contextRequest, request_id: `contention_${phase}`, answer: { ...contextRequest.answer, max_chars: 4000 }, owner_delivery: { chat_id: -1000000000101, reply_to_message_id: 51, message_thread_id: null },
    liveness: { ...contextRequest.liveness, heartbeat_interval_s: 2, stall_window_s: 30 },
    input: { ...contextRequest.input, conversation: contextRequest.input.conversation.map(message => ({ ...message, text: "Дай зведення новин" })), tools: [], requester: { ...contextRequest.input.requester, is_owner: true } } };
  const clock = requestClock();
  let settled = false;
  const pending = runClaimedRequest(relay, request, undefined, { leaseWorker: false, ownerPorts: {
      launch: async () => { launches++; if (phase === "renewal") release = holdLedger();
        return { status: 202, body: { conversationId: `conversation_contention_${phase}`, initialMessage: "delivered" } }; },
      observe: async () => {
        if (phase === "stop") return { state: "failed", turnError: "RelayStoreBusy: relay store is busy" };
        if (phase === "answer") release = holdLedger();
        return { state: "ended", finalText: "Готова відповідь" };
      },
      stop: async () => { stops++; if (!release) release = holdLedger(); }, stopRetryMs: 1,
    } }).then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
  try {
    await clock.drive(clock.contended);
    clock.advance(6100);
    await clock.drive(() => beats > 1);
    release?.();
    await clock.drive(() => settled);
    const outcome = await pending;
    expect(outcome).not.toHaveProperty("error");
    const result = "value" in outcome ? outcome.value : null;
    expect(result?.outcome).toBe("answered");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).not.toContain("RelayStoreBusy");
    expect(delivered[0]).not.toContain("relay store is busy");
    expect(delivered[0]).toBe(phase === "stop" ? "Не вдалося завершити запит. Спробуйте ще раз." : "Готова відповідь");
    expect(launches).toBe(1);
    expect(stops).toBe(phase === "stop" ? 1 : 0);
    expect(beats).toBeGreaterThan(1);
    expect(readRunLedger().runs.some(row => row.requestId === request.request_id)).toBe(false);
  } finally {
    try { release?.(); await clock.drive(() => settled); await pending; }
    finally { clock.close(); selected.mockRestore(); await service.close(); }
  }
}, 60000);

test("owner keeps executing after an early lost service lease and sends one keyed answer", async () => {
  let beats = 0, stops = 0, observing = false;
  const keys: string[] = [];
  let lost!: () => void;
  const leaseLost = new Promise<void>(resolve => { lost = resolve; });
  const service = await startTestRelay((req, body) => {
    if (req.url!.endsWith("/heartbeat")) {
      if (++beats > 1) { return { status: 409, body: { error: { code: "lease_lost" } } }; }
      return { body: { status: "ok" } };
    }
    if (req.url!.endsWith("/send")) { keys.push((body as { client_key: string }).client_key); return { body: cloneReceipt() }; }
    throw new Error("a lost lease must use the keyed answer path");
  });
  const relay = clonePairing(service.origin);
  relay.targets[0] = { ...relay.targets[0]!, id: "target_1", enabled: true, ownerTier: true, engine: "codex", model: "auto", hardCapMinutes: 30 };
  updateRelayStore(store => ({ ...store, relays: [relay] }));
  setRelaySwitch("chain_conversations", false);
  const selected = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "available", account: {
    engine: "codex", accountId: "fixture", kind: "managed", home: process.env.HOME!, transcriptRoot: process.env.HOME!, env: { ...process.env } } });
  const info = console.info;
  const journal = spyOn(console, "info").mockImplementation((...args) => {
    info(...args);
    if (args[0] === "External relay heartbeat" && (args[1] as { code?: string })?.code === "lease_lost") lost();
  });
  const clock = requestClock();
  let settled = false;
  try {
    const request = { ...contextRequest, request_id: "contention_lease_lost", answer: { ...contextRequest.answer, max_chars: 4000 }, owner_delivery: { chat_id: -1000000000101, reply_to_message_id: 51, message_thread_id: null },
      liveness: { ...contextRequest.liveness, heartbeat_interval_s: 2, stall_window_s: 30 }, input: { ...contextRequest.input, conversation: contextRequest.input.conversation.map(message => ({ ...message, text: "Дай зведення новин" })), tools: [], requester: { ...contextRequest.input.requester, is_owner: true } } };
    const pending = runClaimedRequest(relay, request, undefined, { leaseWorker: false, ownerPorts: {
      launch: async () => ({ status: 202, body: { conversationId: "conversation_contention_lost", initialMessage: "delivered" } }),
      observe: async () => { observing = true; await leaseLost; return { state: "ended", finalText: "Збережена відповідь" }; },
      stop: async () => { stops++; },
    } }).then(value => { settled = true; return value; }, error => { settled = true; throw error; });
    await clock.drive(() => observing);
    clock.advance(2100);
    await clock.drive(() => settled);
    expect(await pending).toMatchObject({ outcome: "answered", answer: { text: "Збережена відповідь" } });
    expect(stops).toBe(0);
    expect(keys).toHaveLength(1);
    const replay = Bun.spawn([process.execPath, "-e", `
      Date.now = () => Number(process.env.FIXTURE_NOW);
      const { runClaimedRequest } = await import("./src/lib/externalRelay/runner");
      const result = await runClaimedRequest(JSON.parse(process.env.FIXTURE_RELAY), JSON.parse(process.env.FIXTURE_REQUEST));
      console.log(JSON.stringify({ outcome: result?.outcome }));
    `], { cwd: process.cwd(), env: { ...process.env, FIXTURE_NOW: String(clock.now()), FIXTURE_RELAY: JSON.stringify(relay), FIXTURE_REQUEST: JSON.stringify(request) },
      stdout: "pipe", stderr: "pipe" });
    const [output, errors, code] = await Promise.all([new Response(replay.stdout).text(), new Response(replay.stderr).text(), replay.exited]);
    expect({ code, errors }).toEqual({ code: 0, errors: "" });
    expect(output.trim().split("\n").at(-1)).toBe(JSON.stringify({ outcome: "answered" }));
    expect(keys).toHaveLength(1);
  } finally { clock.close(); journal.mockRestore(); selected.mockRestore(); await service.close(); }
}, 60000);
