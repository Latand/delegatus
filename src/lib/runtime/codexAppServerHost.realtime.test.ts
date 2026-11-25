// destructive-code: head-only; fixture-owned paths and recording process doubles.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { CodexAppServerHost } from "./codexAppServerHost";
import { encodeCodexStructuredUserText } from "./codexStructuredUserText.server";
import { FileRuntimeEventStore } from "./eventStore";
import type { RuntimeEvent } from "./engineHost";
import { normalizeVoiceDeliveries, type RuntimeVoiceDelivery } from "./voiceDelivery";
import { projectVoiceDeliveryBodies } from "./voiceBodyProjection";
import { COORDINATOR_VOICE_PERSONA, VOICE_PERSONA_FILE, voiceSessionPersona } from "./voicePersona";
import { installCodexHostFixture, MemoryEventStore, FakeAppServer, fakeSpawn } from "./codexAppServerHost.fixture";

installCodexHostFixture();

describe("CodexAppServerHost", () => {
  test("starts a client-managed V3 WebRTC call on the hosted thread", async () => {
    const server = new FakeAppServer("voice-thread");
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });

    const started = await host.startRealtimeWebRtc("v=0\r\noffer");
    const persona = voiceSessionPersona("modality");
    expect(started).toMatchObject({
      sdp: "v=0\r\nanswer",
      realtimeSessionId: "realtime-1",
      persona: { variant: "modality", personaId: persona.personaId },
    });
    // SDP requires a terminal CRLF; a missing one is healed, never trimmed —
    // OpenAI rejects an unterminated offer with "unmarshal SDP: EOF".
    /* The live model is named explicitly (#664): letting the backend choose
       gave `gpt-live-1-boulder-alpha`, whose calls were cut at ~9s even on an
       account at 5% of its window. */
    expect(server.requests.find((request) => request.method === "thread/realtime/start")?.params).toEqual({
      threadId: "voice-thread",
      version: "v3",
      model: "gpt-live-1-codex",
      outputModality: "audio",
      transport: { type: "webrtc", sdp: "v=0\r\noffer\r\n" },
      clientManagedHandoffs: true,
      codexResponsesAsItems: true,
      includeStartupContext: true,
      /* THE SPOKEN MODEL'S INSTRUCTIONS (#1629). Omitting this is what left the
         operator's orchestrator speaking as Codex's stock realtime assistant,
         with no role and no idea what the thread behind it can reach. */
      "prompt": persona.prompt,
      realtimeStartInstructions: persona.startInstructions,
      realtimeEndInstructions: persona.endInstructions,
      flushTranscriptTailOnSessionEnd: true,
    });

    /* AND NOTHING IS WRITTEN TO THE THREAD. The persona used to be a
       `thread/inject_items` developer row, which reached the backing model
       permanently and the spoken model never. */
    expect(server.requests.filter((request) => request.method === "thread/inject_items")).toEqual([]);

    await host.appendRealtimeSpeech("Worker inspected package.json");
    expect(server.requests.find((request) => request.method === "thread/realtime/appendSpeech")?.params).toEqual({
      threadId: "voice-thread",
      text: "Worker inspected package.json",
    });
    await host.stopRealtime();
    expect(server.requests.find((request) => request.method === "thread/realtime/stop")?.params).toEqual({
      threadId: "voice-thread",
    });
    await host.release();
  });

  test("the canonical realtime transcript leaves the host as runtime events", async () => {
    /* #1629. Until now the app-server's own `thread/realtime/*` transcript went
       nowhere: the panel could show only what one WebRTC data channel delivered,
       so a call whose channel dropped showed nothing of what the backend had
       actually committed. These are the notifications an installed app-server
       sends, driven through the real process boundary. */
    const server = new FakeAppServer("voice-thread");
    const store = new MemoryEventStore();
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: store,
      spawnProcess: fakeSpawn(server),
    });
    await host.startRealtimeWebRtc("v=0\r\noffer");

    server.notify("thread/realtime/transcript/delta", { threadId: "voice-thread", role: "user", delta: "look at " });
    server.notify("thread/realtime/transcript/delta", { threadId: "voice-thread", role: "user", delta: "that card" });
    server.notify("thread/realtime/transcript/done", { threadId: "voice-thread", role: "user", text: "look at that card" });
    server.notify("thread/realtime/item/started", {
      threadId: "voice-thread",
      item: { id: "seg-9", realtimeSessionId: "realtime-1", type: "transcriptSegment", role: "assistant", text: "" },
    });
    server.notify("thread/realtime/item/completed", {
      threadId: "voice-thread",
      item: { id: "seg-9", realtimeSessionId: "realtime-1", type: "transcriptSegment", role: "assistant", text: "Reading it now." },
    });
    /* A notification for another thread must never enter this host's ledger. */
    server.notify("thread/realtime/transcript/done", { threadId: "other-thread", role: "user", text: "not ours" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const published = store.load("voice-thread")
      .filter((event): event is Extract<RuntimeEvent, { kind: "voice-transcript" }> => event.kind === "voice-transcript")
      .map(({ seq: _seq, ...event }) => event);
    expect(published).toEqual([
      { kind: "voice-transcript", realtimeSessionId: "realtime-1", segmentId: published[0]!.segmentId, role: "user", text: "look at ", final: false },
      { kind: "voice-transcript", realtimeSessionId: "realtime-1", segmentId: published[0]!.segmentId, role: "user", text: "look at that card", final: false },
      { kind: "voice-transcript", realtimeSessionId: "realtime-1", segmentId: published[0]!.segmentId, role: "user", text: "look at that card", final: true },
      /* The empty `item/started` publishes nothing (#1658): a segment with no
         words must not take a line ahead of the words it is for. */
      { kind: "voice-transcript", realtimeSessionId: "realtime-1", segmentId: "seg-9", role: "assistant", text: "Reading it now.", final: true },
    ]);
    /* One id for the whole spoken segment, so the browser updates one line. */
    expect(new Set(published.map((event) => event.segmentId)).size).toBe(2);
    await host.release();
  });

  test("an override edit reaches the next call, and no call writes to the thread", async () => {
    /* The persona is a session parameter now, so it is resolved per call rather
       than once per thread: an operator edit applies to the next call instead of
       waiting for a new thread, and repeated calls — including across a host
       restart — leave the canonical transcript exactly as they found it. */
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "llv-voice-session-persona-"));
    const transcriptPath = path.join(isolated, "voice-thread.jsonl");
    fs.writeFileSync(transcriptPath, "");
    const configDirectory = path.join(isolated, "config");
    const overridePath = path.join(configDirectory, "agent-log-viewer", ...VOICE_PERSONA_FILE.split("/"));
    fs.mkdirSync(path.dirname(overridePath), { recursive: true });
    fs.writeFileSync(overridePath, "First resolved call persona.\n");

    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = configDirectory;
    let firstHost: CodexAppServerHost | null = null;
    let resumedHost: CodexAppServerHost | null = null;
    const offers = [
      "v=0\r\no=- 101 2 IN IP4 127.0.0.1\r\na=ice-ufrag:first\r\na=ice-pwd:first-password\r\na=fingerprint:sha-256 11:22\r\n",
      "v=0\r\no=- 202 2 IN IP4 127.0.0.1\r\na=ice-ufrag:second\r\na=ice-pwd:second-password\r\na=fingerprint:sha-256 33:44\r\n",
      "v=0\r\no=- 303 2 IN IP4 127.0.0.1\r\na=ice-ufrag:third\r\na=ice-pwd:third-password\r\na=fingerprint:sha-256 55:66\r\n",
    ] as const;
    const sentPrompt = (server: FakeAppServer, occurrence: number): unknown =>
      (server.requests.filter((request) => request.method === "thread/realtime/start")[occurrence]
        ?.params as { prompt?: unknown })?.prompt;
    try {
      const firstServer = new FakeAppServer("voice-thread");
      firstServer.threadPath = transcriptPath;
      firstHost = await CodexAppServerHost.start({
        cwd: "/repo",
        eventStore: new MemoryEventStore(),
        spawnProcess: fakeSpawn(firstServer),
      });
      const first = await firstHost.startRealtimeWebRtc(offers[0], "coordinator");
      expect(sentPrompt(firstServer, 0)).toBe("First resolved call persona.");
      await firstHost.stopRealtime();

      fs.writeFileSync(overridePath, "Changed after the first call.\n");
      const second = await firstHost.startRealtimeWebRtc(offers[1], "coordinator");
      expect(sentPrompt(firstServer, 1)).toBe("Changed after the first call.");
      /* A different persona is a different identity, which is what makes the
         reported one evidence rather than decoration. */
      expect(second.persona.personaId).not.toBe(first.persona.personaId);
      await firstHost.stopRealtime();
      await firstHost.release();
      firstHost = null;

      fs.writeFileSync(overridePath, "Changed again after host restart.\n");
      const resumedServer = new FakeAppServer("voice-thread");
      resumedServer.threadPath = transcriptPath;
      resumedHost = await CodexAppServerHost.adopt("voice-thread", {
        cwd: "/repo",
        eventStore: new MemoryEventStore(),
        spawnProcess: fakeSpawn(resumedServer),
      });
      await resumedHost.startRealtimeWebRtc(offers[2], "coordinator");
      expect(sentPrompt(resumedServer, 0)).toBe("Changed again after host restart.");

      /* Three calls, two hosts, nothing appended. */
      for (const server of [firstServer, resumedServer]) {
        expect(server.requests.filter((request) => request.method === "thread/inject_items")).toEqual([]);
      }
      expect(fs.readFileSync(transcriptPath, "utf8")).toBe("");
    } finally {
      if (firstHost) await firstHost.release();
      if (resumedHost) await resumedHost.release();
      if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfigHome;
      fs.rmSync(isolated, { recursive: true, force: true });
    }
  });

  test("a thread already carrying a coordinator persona row still gets the modality correction", async () => {
    /* #1615, the half that cannot be undone. A thread demoted by a call taken
       before the persona moved out of the thread keeps that developer item
       forever — the transcript is append-only. What the correction can no longer
       do is append a rebuttal beside it; it now rides on the session's own
       start instructions, which are the most recent developer instruction the
       backing model receives and are withdrawn when the call ends. */
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "llv-voice-demoted-thread-"));
    const threadId = "demoted-voice-thread";
    const transcriptPath = path.join(isolated, "demoted.jsonl");
    const priorRow = `${JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        id: `msg_voice_persona_${"a".repeat(46)}`,
        role: "developer",
        content: [{ type: "input_text", text: COORDINATOR_VOICE_PERSONA }],
      },
    })}\n`;
    fs.writeFileSync(transcriptPath, priorRow);

    const server = new FakeAppServer(threadId);
    server.threadPath = transcriptPath;
    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });
    try {
      const started = await host.startRealtimeWebRtc("v=0\r\na=ice-ufrag:correct\r\n", "modality");
      expect(started.persona.variant).toBe("modality");

      const start = server.requests.find((request) => request.method === "thread/realtime/start")
        ?.params as { prompt?: string; realtimeStartInstructions?: string; realtimeEndInstructions?: string };
      /* The correction. A second copy of the demotion would be the defect. */
      expect(start.realtimeStartInstructions).not.toBe(COORDINATOR_VOICE_PERSONA);
      expect(start.prompt).not.toBe(COORDINATOR_VOICE_PERSONA);

      /* And the history the demotion lives in is left exactly as it was. */
      expect(server.requests.filter((request) => request.method === "thread/inject_items")).toEqual([]);
      expect(fs.readFileSync(transcriptPath, "utf8")).toBe(priorRow);
      await host.stopRealtime();
    } finally {
      await host.release();
      fs.rmSync(isolated, { recursive: true, force: true });
    }
  });

  test("seeds a resumed realtime call with the interrupted duplex tail in canonical order", async () => {
    const threadId = "voice-context-thread";
    const turnId = "turn-overlap";
    const firstUser = {
      type: "userMessage",
      id: "user-first",
      content: [{ type: "text", text: await encodeCodexStructuredUserText("Give the first status.") }],
    };
    const followUpText = `<realtime_delegation>
  <input>Repeat the previous status.</input>
  <transcript_delta>[redacted incomplete duplex delta]</transcript_delta>
</realtime_delegation>`;
    const followUp = {
      type: "userMessage",
      id: "user-follow-up",
      content: [{ type: "text", text: await encodeCodexStructuredUserText(followUpText) }],
    };
    const eventStore = new MemoryEventStore();
    eventStore.append(threadId, { kind: "turn-started", turnId, seq: 1 });
    eventStore.append(threadId, { kind: "item", turnId, item: firstUser, phase: "completed", seq: 2 });
    eventStore.append(threadId, { kind: "delta", turnId, text: "The first status is", seq: 3 });
    eventStore.append(threadId, { kind: "delta", turnId, text: " ready.", seq: 4 });
    eventStore.append(threadId, {
      kind: "item",
      turnId,
      item: { type: "contextCompaction", id: "compaction-one" },
      phase: "completed",
      seq: 5,
    });
    eventStore.append(threadId, { kind: "item", turnId, item: followUp, phase: "completed", seq: 6 });
    eventStore.append(threadId, { kind: "turn-ended", turnId, status: "interrupted", seq: 7 });
    eventStore.append(threadId, { kind: "session-status", status: "idle", seq: 8 });
    const server = new FakeAppServer(threadId, threadId, false, [{
      id: turnId,
      status: "interrupted",
      items: [firstUser, { type: "contextCompaction", id: "compaction-one" }, followUp],
    }], { type: "idle" });
    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore,
      initialEventCursor: 8,
      spawnProcess: fakeSpawn(server),
    });
    const diagnostics: unknown[][] = [];
    const originalInfo = console.info;
    console.info = (...values: unknown[]) => { diagnostics.push(values); };
    try {
      await host.startRealtimeWebRtc("v=0\r\noffer");
    } finally {
      console.info = originalInfo;
    }

    expect(server.requests.find((request) => request.method === "thread/realtime/start")?.params)
      .toMatchObject({
        initialItems: [
          { role: "assistant", text: "The first status is ready." },
          { role: "user", text: followUpText },
        ],
      });
    expect(diagnostics).toEqual([["[realtime context] selected", {
      providerStartupContext: true,
      personaVariant: "modality",
      durableTail: [
        { role: "assistant", source: "durable-delta", bytes: 26 },
        { role: "user", source: "durable-item", bytes: Buffer.byteLength(followUpText, "utf8") },
      ],
      truncated: false,
    }]]);
    expect(JSON.stringify(diagnostics)).not.toContain("The first status");
    expect(JSON.stringify(diagnostics)).not.toContain("realtime_delegation");
    await host.release();
  });

  test("leaves committed assistant context with the provider startup selector", async () => {
    const server = new FakeAppServer("voice-committed-thread");
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });
    server.notify("turn/started", {
      threadId: "voice-committed-thread",
      turn: { id: "turn-committed" },
    });
    server.notify("item/agentMessage/delta", {
      threadId: "voice-committed-thread",
      turnId: "turn-committed",
      delta: "Committed status.",
    });
    server.notify("item/completed", {
      threadId: "voice-committed-thread",
      turnId: "turn-committed",
      item: { type: "agentMessage", id: "assistant-committed", text: "Committed status." },
    });
    await Bun.sleep(0);

    await host.startRealtimeWebRtc("v=0\r\noffer");

    const params = server.requests.find((request) => request.method === "thread/realtime/start")?.params;
    expect(params).toMatchObject({ includeStartupContext: true });
    expect((params as { initialItems?: unknown[] }).initialItems).toBeUndefined();
    await host.release();
  });

  test("publishes a semantic voice chunk before the assistant response completes", async () => {
    const threadId = "voice-semantic-stream-thread";
    const turnId = "turn-semantic-stream";
    const eventDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-voice-semantic-stream-"));
    const eventStore = new FileRuntimeEventStore(eventDirectory);
    const server = new FakeAppServer(threadId);
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore,
      spawnProcess: fakeSpawn(server),
    });
    await host.startRealtimeWebRtc("v=0\r\noffer");
    server.notify("turn/started", {
      threadId,
      turn: { id: turnId },
    });
    server.notify("item/agentMessage/delta", {
      threadId,
      turnId,
      delta: "The first substantial part is ready and can be spoken while the remaining investigation continues, while enough related detail stays together to preserve the meaning and keep the spoken reply natural. ",
    });
    server.notify("item/agentMessage/delta", {
      threadId,
      turnId,
      delta: "This second sentence starts the next semantic batch.",
    });
    await Bun.sleep(0);

    const streamed = eventStore.load(threadId).filter((event) =>
      (event as { kind: string }).kind === "voice-chunk");
    expect(streamed).toHaveLength(1);
    expect(streamed[0]).toMatchObject({
      kind: "voice-chunk",
      turnId,
      delivery: {
        sourceTurnId: turnId,
        streamChunk: { index: 0 },
      },
    });
    expect(await host.health()).toMatchObject({ status: "active", activeTurnRef: turnId });
    expect(eventStore.load(threadId).some((event) => event.kind === "item")).toBeFalse();

    const terminalText = "The first substantial part is ready and can be spoken while the remaining investigation continues, while enough related detail stays together to preserve the meaning and keep the spoken reply natural. This second sentence starts the next semantic batch.";
    server.notify("item/completed", {
      threadId,
      turnId,
      item: { type: "agentMessage", id: "assistant-semantic-stream", text: terminalText },
    });
    await Bun.sleep(0);
    const completedEvents = eventStore.load(threadId);
    const finalItem = completedEvents.findLast((event) => event.kind === "item");
    const voiceResponse = finalItem && "voiceResponse" in finalItem
      ? finalItem.voiceResponse
      : undefined;
    const streamedText = completedEvents
      .filter((event) => event.kind === "voice-chunk")
      .map((event) => event.delivery.responses[0]!.text)
      .join("");
    expect(streamedText + (voiceResponse?.text ?? "")).toBe(terminalText);
    await host.release();
    fs.rmSync(eventDirectory, { recursive: true, force: true });
  });

  test("bounds unacknowledged semantic chunks instead of forwarding every delta", async () => {
    const threadId = "voice-semantic-backpressure-thread";
    const turnId = "turn-semantic-backpressure";
    const eventStore = new MemoryEventStore();
    const server = new FakeAppServer(threadId);
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore,
      spawnProcess: fakeSpawn(server),
    });
    await host.startRealtimeWebRtc("v=0\r\noffer");
    server.notify("turn/started", { threadId, turn: { id: turnId } });
    for (let index = 0; index < 10; index += 1) {
      server.notify("item/agentMessage/delta", {
        threadId,
        turnId,
        delta: `${index}: ${"One cohesive explanation remains in a single speech request to keep quota use bounded and delivery natural. ".repeat(2)}`,
      });
    }
    await Bun.sleep(0);

    expect(eventStore.load(threadId).filter((event) => event.kind === "voice-chunk")).toHaveLength(6);
    await host.release();
  });

  test("bounds the unresolved realtime tail by UTF-8 bytes and item count", async () => {
    const server = new FakeAppServer("voice-bounded-thread");
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });
    server.notify("turn/started", {
      threadId: "voice-bounded-thread",
      turn: { id: "turn-bounded" },
    });
    server.notify("item/agentMessage/delta", {
      threadId: "voice-bounded-thread",
      turnId: "turn-bounded",
      delta: "🙂".repeat(3_000),
    });
    for (let index = 0; index < 20; index += 1) {
      server.notify("item/completed", {
        threadId: "voice-bounded-thread",
        turnId: "turn-bounded",
        item: {
          type: "userMessage",
          id: `user-${index}`,
          content: [{
            type: "text",
            text: await encodeCodexStructuredUserText(`${"界".repeat(3_000)} follow-up-${index}`),
          }],
        },
      });
    }
    await Bun.sleep(0);
    const window = host as unknown as { events: RuntimeEvent[]; eventWindowReleased: boolean };
    window.events.length = 0;
    window.eventWindowReleased = true;
    const diagnostics: unknown[][] = [];
    const originalInfo = console.info;
    console.info = (...values: unknown[]) => { diagnostics.push(values); };
    try {
      await host.startRealtimeWebRtc("v=0\r\noffer");
    } finally {
      console.info = originalInfo;
    }

    const params = server.requests.find((request) => request.method === "thread/realtime/start")?.params;
    const items = (params as { initialItems: Array<{ role: string; text: string }> }).initialItems;
    expect(items).toHaveLength(3);
    expect(items[0]?.text).toBe("🙂".repeat(2048));
    expect(items.map((item) => item.role)).toEqual(["assistant", "user", "user"]);
    expect(items[1]?.text.endsWith("follow-up-18")).toBeTrue();
    expect(items[2]?.text.endsWith("follow-up-19")).toBeTrue();
    expect(items.every((item) => Buffer.byteLength(item.text, "utf8") <= 8 * 1024)).toBeTrue();
    expect(items.reduce((total, item) => total + Buffer.byteLength(item.text, "utf8"), 0))
      .toBeLessThanOrEqual(24 * 1024);
    expect(items.every((item) => !item.text.includes("�"))).toBeTrue();
    expect(diagnostics).toMatchObject([["[realtime context] selected", { truncated: true }]]);
    expect(JSON.stringify(diagnostics)).not.toContain("follow-up-19");
    await host.release();
  });

  test("hydrated growing response sets reach the receiver in full before durable acknowledgment", async () => {
    const eventStore = new MemoryEventStore();
    const server = new FakeAppServer("voice-hydrated-thread");
    const host = await CodexAppServerHost.start({ cwd: "/repo", eventStore, spawnProcess: fakeSpawn(server) });
    try {
      const responseA = { responseId: "response-a", text: "First canonical response. " };
      const responseB = { responseId: "response-b", text: "Second canonical response." };
      const recovered = normalizeVoiceDeliveries([{ turnId: "turn-hydrated", responses: [responseA], ready: false }]);
      const pending = normalizeVoiceDeliveries([{ turnId: "turn-hydrated", responses: [{ ...responseA, text: "" }, { ...responseB, text: "" }], ready: true }]);
      const unresolved = projectVoiceDeliveryBodies(pending, recovered, new Set());
      expect(unresolved.complete).toBe(false);
      for (const delivery of unresolved.deliveries) await host.deliverRealtimeWorkerResponse(delivery);
      expect(server.acceptedRealtimeSpeech).toEqual([]);
      expect(eventStore.load("voice-hydrated-thread").filter(event => event.kind === "realtime-delivery-acknowledged")).toHaveLength(0);

      const current = [{ ...pending[0]!, responses: [{ ...responseA, text: "" }, responseB] }];
      const complete = projectVoiceDeliveryBodies(current, recovered, new Set());
      expect(complete.complete).toBe(true);
      await expect(host.deliverRealtimeWorkerResponse(complete.deliveries[0]!)).resolves.toEqual({ deliveryId: current[0]!.deliveryId, acknowledged: true });
      expect(server.acceptedRealtimeSpeech.join("")).toBe(responseA.text + responseB.text);
      expect(eventStore.load("voice-hydrated-thread").at(-1)).toMatchObject({ kind: "realtime-delivery-acknowledged", deliveryId: current[0]!.deliveryId });
    } finally { await host.release(); }
  });

  test("delivers a large multi-item response exactly once and deduplicates after host recovery", async () => {
    const eventStore = new MemoryEventStore();
    const firstServer = new FakeAppServer("voice-delivery-thread");
    const firstHost = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore,
      spawnProcess: fakeSpawn(firstServer),
    });
    const firstText = `${"🙂界".repeat(20_000)}\n`;
    const secondText = `${"🫶🏽".repeat(5_000)}done`;
    const delivery: RuntimeVoiceDelivery = {
      deliveryId: 'voice:["turn-delivery",["response-one","response-two"]]',
      turnId: "turn-delivery",
      responses: [
        { responseId: "response-one", text: firstText },
        { responseId: "response-two", text: secondText },
      ],
      ready: true,
    };

    await expect(firstHost.deliverRealtimeWorkerResponse(delivery)).resolves.toEqual({
      deliveryId: delivery.deliveryId,
      acknowledged: true,
    });
    await firstHost.deliverRealtimeWorkerResponse(delivery);
    expect(firstServer.acceptedRealtimeSpeech.join("")).toBe(firstText + secondText);
    expect(firstServer.acceptedRealtimeSpeech.every((chunk) =>
      Buffer.byteLength(chunk, "utf8") <= 8 * 1024)).toBeTrue();
    expect(eventStore.load("voice-delivery-thread").at(-1)).toMatchObject({
      kind: "realtime-delivery-acknowledged",
      deliveryId: delivery.deliveryId,
    });
    await expect(firstHost.deliverRealtimeWorkerResponse({
      ...delivery,
      responses: [
        { responseId: "response-one", text: "different content" },
        { responseId: "response-two", text: secondText },
      ],
    })).rejects.toThrow("delivery id belongs to different content");
    await firstHost.release();

    const replacementServer = new FakeAppServer("voice-delivery-thread");
    const replacementHost = await CodexAppServerHost.adopt("voice-delivery-thread", {
      cwd: "/repo",
      eventStore,
      spawnProcess: fakeSpawn(replacementServer),
    });
    await replacementHost.deliverRealtimeWorkerResponse(delivery);
    expect(replacementServer.acceptedRealtimeSpeech).toEqual([]);
    await replacementHost.release();
  });

  test("resumes the exact Unicode suffix after a partial realtime send", async () => {
    const eventStore = new MemoryEventStore();
    const firstServer = new FakeAppServer("voice-partial-thread");
    firstServer.realtimeAppendErrorAt = 2;
    const firstHost = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore,
      spawnProcess: fakeSpawn(firstServer),
    });
    const text = `boundary:${"🙂🫶🏽界".repeat(8_000)}:end`;
    const delivery: RuntimeVoiceDelivery = {
      deliveryId: 'voice:["turn-partial",["response-partial"]]',
      turnId: "turn-partial",
      responses: [{ responseId: "response-partial", text }],
      ready: true,
    };

    await expect(firstHost.deliverRealtimeWorkerResponse(delivery))
      .rejects.toThrow("realtime channel replaced");
    const acceptedPrefix = firstServer.acceptedRealtimeSpeech.join("");
    expect(acceptedPrefix.length).toBeGreaterThan(0);
    expect(text.startsWith(acceptedPrefix)).toBeTrue();
    await firstHost.release();

    const replacementServer = new FakeAppServer("voice-partial-thread");
    const replacementHost = await CodexAppServerHost.adopt("voice-partial-thread", {
      cwd: "/repo",
      eventStore,
      spawnProcess: fakeSpawn(replacementServer),
    });
    await replacementHost.deliverRealtimeWorkerResponse(delivery);
    expect(acceptedPrefix + replacementServer.acceptedRealtimeSpeech.join("")).toBe(text);
    await replacementHost.release();
  });

  test("the operator's override is the text that reaches the call's spoken model", async () => {
    /* The call path has to resolve the persona the way production does, not
       just inject some persona. With no override file on disk the resolver and
       the built-in default are the same string, so a call that injected the
       default would satisfy any assertion written against the resolver. An
       isolated config dir holding a known override splits the two apart: this
       expected text exists nowhere in the source, so only a call that actually
       read the override can produce it. */
    const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-voice-persona-config-"));
    const overridePath = path.join(configDirectory, "agent-log-viewer", ...VOICE_PERSONA_FILE.split("/"));
    const override = "Isolated override persona for this call.";
    fs.mkdirSync(path.dirname(overridePath), { recursive: true });
    /* Written with surrounding whitespace, because the resolver trims and the
       injected item must carry the trimmed text. */
    fs.writeFileSync(overridePath, `  ${override}\n`);
    expect(override).not.toBe(COORDINATOR_VOICE_PERSONA);

    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = configDirectory;
    try {
      const server = new FakeAppServer("voice-thread");
      const host = await CodexAppServerHost.start({
        cwd: "/repo",
        eventStore: new MemoryEventStore(),
        spawnProcess: fakeSpawn(server),
      });
      /* The override file is the coordinator variant's, so this is a coordinator
         call — see `spokenVoicePersona`, where the modality variant deliberately
         keeps the built-in text. */
      await host.startRealtimeWebRtc("v=0\r\noffer", "coordinator");

      const start = server.requests.find((request) => request.method === "thread/realtime/start");
      expect((start?.params as { prompt?: string })?.prompt).toBe(override);
      await host.release();
    } finally {
      if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfigHome;
      fs.rmSync(configDirectory, { recursive: true, force: true });
    }
  });

  test("a browser offer with its terminal CRLF is forwarded byte-for-byte", async () => {
    const server = new FakeAppServer("voice-thread");
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });
    await host.startRealtimeWebRtc("v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n");
    const start = server.requests.find((request) => request.method === "thread/realtime/start");
    expect((start?.params as { transport?: { sdp?: string } })?.transport?.sdp)
      .toBe("v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n");
    await host.release();
  });

  test("the V3 realtime session inherits the hosted thread's MCP configuration", async () => {
    const server = new FakeAppServer("voice-mcp-thread");
    server.mcpServers = {
      viewer: { command: "agent-log-viewer-mcp", enabled: true, default_tools_approval_mode: "prompt" },
      "agent-browser": { command: "browser-mcp", enabled: true, default_tools_approval_mode: "writes" },
      "telegram-readonly": { command: "telegram-mcp", enabled: true, default_tools_approval_mode: "prompt" },
    };
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      mcpServers: ["viewer", "agent-browser"],
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });

    /* The hosted thread is the only place the MCP table lives: thread/start
       enables the granted servers and restates realtime_conversation. The grant
       bound ships empty of connectors, so Viewer is the whole surface (#739). */
    expect(server.requests.find((request) => request.method === "thread/start")?.params).toMatchObject({
      config: {
        mcp_servers: {
          viewer: { enabled: true, default_tools_approval_mode: "approve" },
          "agent-browser": { enabled: false, default_tools_approval_mode: "writes" },
          "telegram-readonly": { enabled: false },
        },
        features: { realtime_conversation: true },
      },
    });

    await host.startRealtimeWebRtc("v=0\r\noffer");
    const realtimeStart = server.requests.find((request) => request.method === "thread/realtime/start");
    const params = realtimeStart?.params as Record<string, unknown>;
    /* App-server contract (codex-cli 0.154.0, bundled app-server 0.153.4):
       thread/realtime/start carries the session's own instructions and nothing
       about tools — no MCP table, config, or tool list rides the call, so the
       backing model can only inherit the thread's servers above, and the spoken
       model holds no tool of its own at all. */
    expect(params.threadId).toBe("voice-mcp-thread");
    expect(Object.keys(params).sort()).toEqual([
      "clientManagedHandoffs",
      "codexResponsesAsItems",
      "flushTranscriptTailOnSessionEnd",
      "includeStartupContext",
      "model",
      "outputModality",
      "prompt",
      "realtimeEndInstructions",
      "realtimeStartInstructions",
      "threadId",
      "transport",
      "version",
    ]);
    expect(server.requests.filter((request) => request.method === "thread/start")).toHaveLength(1);
    await host.release();
  });

  test("surfaces the app-server realtime admission error", async () => {
    const server = new FakeAppServer("voice-error-thread");
    server.realtimeStartError = "AVAS route unavailable";
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });

    await expect(host.startRealtimeWebRtc("v=0\r\noffer")).rejects.toThrow("AVAS route unavailable");
    await host.release();
  });
});

test("the realtime notification deadline poisons a writer after the start RPC succeeds", async () => {
  const server = new FakeAppServer("voice-thread");
  server.suppressRealtimeStartNotifications = true;
  const host = await CodexAppServerHost.start({
    cwd: "/repo",
    eventStore: new MemoryEventStore(),
    spawnProcess: fakeSpawn(server),
    realtimeStartTimeoutMs: 10,
  });
  try {
    await expect(host.startRealtimeWebRtc("v=0\r\no=- 913 2 IN IP4 127.0.0.1\r\n"))
      .rejects.toThrow("thread/realtime/start timed out; outcome is uncertain");
    expect((await host.health()).status).toBe("dead");
    expect(server.requests.filter((request) => request.method === "thread/realtime/start")).toHaveLength(1);
  } finally {
    await host.release();
  }
});

test("releasing the host hangs up a live call so the account's slot is freed", async () => {
  /* A realtime session the backend still believes is open holds the account's
     one concurrent slot, and every later call is refused with "You have
     reached your usage limit." — the same sentence an exhausted window
     produces. A deploy replacing the runtime host mid-call is exactly how that
     orphan gets created. */
  const server = new FakeAppServer("voice-thread");
  const host = await CodexAppServerHost.start({
    cwd: "/repo",
    eventStore: new MemoryEventStore(),
    spawnProcess: fakeSpawn(server),
  });
  await host.startRealtimeWebRtc("v=0\r\noffer");
  await host.release();
  expect(server.requests.some((request) => request.method === "thread/realtime/stop")).toBe(true);
});

test("a host with no live call releases without a stray hangup", async () => {
  const server = new FakeAppServer("voice-thread");
  const host = await CodexAppServerHost.start({
    cwd: "/repo",
    eventStore: new MemoryEventStore(),
    spawnProcess: fakeSpawn(server),
  });
  await host.release();
  expect(server.requests.some((request) => request.method === "thread/realtime/stop")).toBe(false);
});
