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
import { assertStructuredTextEnvelope, MAX_STRUCTURED_TEXT_BYTES } from "@/lib/runtime/structuredContent";
import type { OwnerRunPorts } from "./ownerRun";

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

test("a reply below a long bot answer resumes the same owner conversation with only the new message", async () => {
  let launches = 0, continuations = 0;
  const delivered: string[] = [];
  const service = await startTestRelay((req, body) => {
    if (req.url!.endsWith("/complete")) delivered.push((body as { answer: { text: string } }).answer.text);
    return { body: { status: "ok" } };
  });
  const relay = clonePairing(service.origin);
  relay.targets[0] = { ...relay.targets[0]!, id: "target_1", enabled: true, ownerTier: true, engine: "codex", model: "auto", hardCapMinutes: 30 };
  updateRelayStore(store => ({ ...store, relays: [relay] }));
  setRelaySwitch("chain_conversations", true);
  const selected = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "available", account: {
    engine: "codex", accountId: "fixture", kind: "managed", home: process.env.HOME!, transcriptRoot: process.env.HOME!, env: { ...process.env } } });
  setSystemTime(new Date("2026-11-04T00:00:00Z"));
  const root = { ...contextRequest.input.conversation[0]!, id: "chain-root", text: "Підготуй огляд" };
  const first = { ...contextRequest, request_id: "bounded_chain_first", chat: { key: "bounded-chain-fixture" },
    answer: { ...contextRequest.answer, max_chars: 4000 }, input: { ...contextRequest.input, tools: [], instructions: "Service style. ".repeat(200),
      short_term_memory: "Context. ".repeat(700), owner_instructions: "Style. ".repeat(700),
      respond_to: root.id, conversation: [root], requester: { ...contextRequest.input.requester, is_owner: true } } };
  const parent = { ...root, id: "chain-bot-answer", reply_to: root.id, text: "Sources: https://example.test/report\n" + "Earlier answer. ".repeat(200).trimEnd(),
    author: { ...root.author, self: true } };
  const next = { ...root, id: "chain-next", reply_to: parent.id, text: "Поясни висновок" };
  const followup = { ...first, request_id: "bounded_chain_reply", input: { ...first.input, respond_to: next.id,
    owner_instructions: "Updated style. ".repeat(1000), conversation: [root, parent, next] } };
  const ports: OwnerRunPorts = {
    launch: async (body: Record<string, unknown>) => {
      launches++; assertStructuredTextEnvelope(String(body.prompt));
      return { status: 202, body: { conversationId: "conversation_bounded_chain", launchId: "bounded-chain-launch", initialMessage: "delivered" } };
    },
    continue: async (turn, prompt) => {
      continuations++; expect(turn.conversationId).toBe("conversation_bounded_chain");
      assertStructuredTextEnvelope(prompt);
      expect(JSON.parse(prompt.match(/<conversation>\n([\s\S]*?)\n<\/conversation>/)![1]!))
        .toEqual([{ ...next, text: undefined, text_reference: "owner_request.text" }]);
      expect(JSON.parse(prompt.match(/<owner_request>\n([\s\S]*?)\n<\/owner_request>/)![1]!))
        .toEqual({ message_id: next.id, text: next.text, request_text: followup.input.request_text });
      expect(JSON.parse(prompt.match(/<owner_instructions>\n([\s\S]*?)\n<\/owner_instructions>/)![1]!))
        .toBe(followup.input.owner_instructions);
      return { ok: true, structured: true, target: turn.conversationId!, outcome: "delivered", operationId: "bounded-chain-reply",
        receipt: { operationId: "bounded-chain-reply", idempotencyKey: "bounded-chain-reply", conversationId: turn.conversationId!,
          kind: "send", status: "delivered", at: "2026-11-04T00:00:00Z", revision: 1 } };
    },
    observe: async () => ({ state: "ended" as const, finalText: continuations ? "Висновок пояснено" : parent.text }),
    stop: async () => { throw new Error("a completed chain must not be stopped"); },
  };
  try {
    expect(await runClaimedRequest(relay, first, undefined, { leaseWorker: false, ownerPorts: ports })).toMatchObject({ outcome: "answered" });
    const { readConversations } = await import("./conversations");
    expect(readConversations().find(row => row.chatKey === "bounded-chain-fixture")).toMatchObject({
      conversationId: "conversation_bounded_chain", state: "idle", authority: "owner-tier", seen: [root.id],
    });
    expect(await runClaimedRequest(relay, followup, undefined, { leaseWorker: false, ownerPorts: ports }))
      .toMatchObject({ outcome: "answered", answer: { text: "Висновок пояснено" } });
    expect({ launches, continuations }).toEqual({ launches: 1, continuations: 1 });
    expect(delivered).toEqual([parent.text, "Висновок пояснено"]);
    expect(readConversations().find(row => row.chatKey === "bounded-chain-fixture")).toMatchObject({
      conversationId: "conversation_bounded_chain", state: "idle", seen: [root.id, parent.id, next.id],
    });
  } finally { selected.mockRestore(); setSystemTime(); await service.close(); }
});

for (const language of ["en", "uk"] as const) test(`an oversized mandatory ${language} request sends one human failure and no oversized agent message`, async () => {
  let launches = 0;
  const delivered: string[] = [];
  const service = await startTestRelay((req, body) => {
    if (req.url!.endsWith("/complete")) delivered.push((body as { answer: { text: string } }).answer.text);
    return { body: { status: "ok" } };
  });
  const relay = clonePairing(service.origin);
  relay.targets[0] = { ...relay.targets[0]!, id: "target_1", enabled: true, ownerTier: true, engine: "codex", model: "auto", hardCapMinutes: 30 };
  updateRelayStore(store => ({ ...store, relays: [relay] }));
  setRelaySwitch("chain_conversations", false);
  const selected = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "available", account: {
    engine: "codex", accountId: "fixture", kind: "managed", home: process.env.HOME!, transcriptRoot: process.env.HOME!, env: { ...process.env } } });
  const text = (language === "uk" ? "Поясни " : "Explain ") + "😀".repeat(10000);
  const request = { ...contextRequest, request_id: `mandatory_large_${language}`, answer: { ...contextRequest.answer, max_chars: 4000 },
    input: { ...contextRequest.input, tools: [], conversation: [{ ...contextRequest.input.conversation[0]!, text }],
      requester: { ...contextRequest.input.requester, is_owner: true } } };
  try {
    const result = await runClaimedRequest(relay, request, undefined, { leaseWorker: false, ownerPorts: {
      launch: async () => { launches++; return { status: 202, body: { conversationId: "conversation_must_not_launch" } }; },
      observe: async () => ({ state: "ended", finalText: "must not run" }), stop: async () => {},
    } });
    const human = language === "uk" ? "Обов’язковий контекст запиту завеликий. Скоротіть або розділіть запит і потрібні цитати."
      : "The required request context is too large. Shorten or split the request and its required quotations.";
    expect(result).toMatchObject({ outcome: "answered", answer: { text: human, reply_to: request.input.respond_to } });
    expect(launches).toBe(0); expect(delivered).toEqual([human]);
    expect(Buffer.byteLength(human)).toBeLessThan(MAX_STRUCTURED_TEXT_BYTES);
  } finally { selected.mockRestore(); await service.close(); }
});

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
