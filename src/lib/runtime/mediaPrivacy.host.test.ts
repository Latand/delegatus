import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { runtimeHostKindForEngine } from "./contracts";
import { RuntimeJournal } from "@/runtime-host/journal";
import { ClaudeStreamBrokerHost } from "./claudeStreamBrokerHost";
import { CodexAppServerHost } from "./codexAppServerHost";
import type { RuntimeEvent } from "./engineHost";
import { createEngineHostLedgerProjection, projectEngineHostEvent } from "./engineHostEvents";
import { FileRuntimeEventStore } from "./eventStore";
import { streamingVoiceDelivery } from "./voiceDelivery";

// Only the CLI transport is fake. Both hosts, their first durable append,
// live attach, journal projections and disk replay are production code.
class MediaChild extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  pid = 2147483640;
  constructor(engine: string) {
    super();
    if (engine !== "codex") return;
    let input = "";
    this.stdin.on("data", chunk => {
      input += chunk.toString();
      for (let newline; (newline = input.indexOf("\n")) >= 0;) {
        const message = JSON.parse(input.slice(0, newline)); input = input.slice(newline + 1);
        if (message.id === undefined) continue;
        const result = message.method === "initialize" ? { userAgent: "synthetic/0.162.1" }
          : message.method === "account/read" ? { account: { type: "chatgpt", planType: "pro" }, requiresOpenaiAuth: false }
          : message.method === "config/read" ? { config: { mcp_servers: {}, features: {}, shell_environment_policy: {} } }
          : message.method === "mcpServerStatus/list" ? { data: [{ name: "viewer", tools: { stage_report: {} } }], nextCursor: null }
          : message.method === "thread/start" ? { thread: { id: "media-thread", turns: [] }, model: "synthetic", approvalPolicy: "never", sandbox: { type: "dangerFullAccess" } }
          : { data: [], nextCursor: null };
        this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
      }
    });
  }
  kill(signal = "SIGTERM") { queueMicrotask(() => this.emit("close", 0, signal)); return true; }
}

const ref = `media_${"b".repeat(32)}`;
const pixels = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWP4z8DwnwGMERQARNAF+661WskAAAAASUVORK5CYII=";
const phrases = ["Add image metadata to the card.", "Explain image data flow.", "Image data and metadata remain ordinary text.", "I am"];
type Branch = "delta" | "voice" | "voice-chunk" | "assistant";

for (const engine of ["claude", "codex"] as const) {
  const replay = async (run: (emit: (turn: string, text: string, branch?: Branch) => Promise<void>, end: (turn: string, status?: "completed" | "interrupted") => Promise<void>, read: (turn: string, branch?: Branch) => string[]) => Promise<void>) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "media-host-replay-"));
    const eventsDir = path.join(root, "events");
    const store = new FileRuntimeEventStore(eventsDir);
    const child = new MediaChild(engine);
    const options = { cwd: root, eventStore: store, readTranscript: () => [], readProtocolVersion: () => "0.162.1",
      readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams };
    const host = engine === "claude" ? await ClaudeStreamBrokerHost.start(options) : await CodexAppServerHost.start(options);
    const session = engine === "claude" ? (host as ClaudeStreamBrokerHost).identity.sessionId : (host as CodexAppServerHost).identity.threadId;
    const filename = path.join(root, "journal.sqlite");
    let journal = new RuntimeJournal(filename, { structuredHosts: true });
    const stream = host.attach((await host.health()).eventCursor)[Symbol.asyncIterator]();
    const project = createEngineHostLedgerProjection();
    const send = async (event: { kind: string; [key: string]: unknown }) => {
      const next = stream.next();
      (host as unknown as { emit(event: object): void }).emit(event);
      let entry = await next;
      while (!entry.done) {
        const raw = entry.value;
        const safe = project(raw);
        if (raw.kind === "turn-ended") {
          // Use the pump's current drain API; the reviewed version exposed
          // only its delta tail. This keeps the same regression runnable on it.
          const drain = project as typeof project & { flushPendingEvents?: (turnId: string) => RuntimeEvent[] };
          if (drain.flushPendingEvents) {
            for (const [index, tail] of drain.flushPendingEvents(raw.turnId).entries()) {
              const row = projectEngineHostEvent("conversation_media", `${engine}:${session}`, tail);
              if (row) journal.append({ ...row, producer: { kind: runtimeHostKindForEngine(engine), eventKey: `engine-host:${engine}:${session}:${raw.seq}:tail:${index}` } });
            }
          } else {
            const tail = project.flushPendingText(raw.turnId, "delta");
            if (tail) journal.append({ scope: { type: "session", id: "conversation_media" }, kind: "delta", payload: { conversationId: "conversation_media", turnId: raw.turnId, text: tail } });
            project.flushPendingText(raw.turnId);
          }
        }
        const row = projectEngineHostEvent("conversation_media", `${engine}:${session}`, safe);
        if (row) journal.append(row);
        if (event.kind !== "turn-ended" || raw.kind === "turn-ended") break;
        entry = await stream.next();
      }
      expect(entry.done).toBe(false);
    };
    const read = (turn: string, branch: Branch = "delta") => {
      // Reopen both sinks, and concatenate actual text fields, never JSON
      // framing (which can conceal a ref split between two persisted rows).
      const disk = fs.readFileSync(path.join(eventsDir, `${encodeURIComponent(session)}.jsonl`), "utf8").trim().split("\n").map(line => JSON.parse(line) as RuntimeEvent);
      const reopened = new FileRuntimeEventStore(eventsDir).load(session);
      expect(reopened).toEqual(disk);
      journal.close(); journal = new RuntimeJournal(filename, { structuredHosts: true });
      const rows: { kind: string; [key: string]: unknown }[] = [];
      let after = 0;
      for (;;) {
        const page = journal.replay(after);
        expect(page.reset).toBe(false);
        if (!page.events.length) break;
        rows.push(...page.events.map(row => ({ kind: row.kind, ...row.payload })));
        after = page.events.at(-1)!.seq;
      }
      expect(disk.some(row => "turnId" in row && row.turnId === turn)).toBe(true);
      expect(rows.some(row => row.turnId === turn)).toBe(true);
      const text = (events: unknown[]) => (events as RuntimeEvent[]).filter(row => "turnId" in row && row.turnId === turn).map(row =>
        branch === "assistant" && row.kind === "item" ? (row.item as { message?: { content?: { text: string }[] } }).message?.content?.map(part => part.text).join("") ?? ""
          : branch === "delta" && row.kind === "delta" ? row.text
          : branch === "voice" && row.kind === "item" ? row.voiceResponse?.text ?? ""
          : branch === "voice-chunk" && row.kind === "voice-chunk" ? ("delivery" in row ? row.delivery : (row as unknown as { voiceDelivery: { responses: { text: string }[] } }).voiceDelivery).responses.map(response => response.text).join("") : "").join("");
      return [text(disk), text(rows)];
    };
    let chunkIndex = 0;
    try {
      await run(async (turnId, text, branch = "delta") => {
        await send(branch === "delta" ? { kind: "delta", turnId, text }
          : branch === "assistant" ? { kind: "item", turnId, phase: "completed", item: { type: "assistant", message: { content: [{ type: "text", text }] } } }
          : branch === "voice" ? { kind: "item", turnId, phase: "completed", item: { type: "assistant", message: { content: [{ type: "text", text: "safe" }] } }, voiceResponse: { responseId: `voice-${turnId}`, text } }
          : { kind: "voice-chunk", turnId, delivery: streamingVoiceDelivery({ sourceTurnId: turnId, chunkIndex: chunkIndex++, startOffset: 0, endOffset: Math.max(1, text.length), text }) });
        if (text.includes(pixels)) expect(JSON.stringify((host as unknown as { events: RuntimeEvent[] }).events)).toContain(pixels);
      }, (turnId, status = "completed") => send({ kind: "turn-ended", turnId, status }), read);
    } finally { await stream.return?.(); journal.close(); await host.release(); fs.rmSync(root, { recursive: true, force: true }); }
  };

  test.each(Array.from({ length: ref.length - 1 }, (_, i) => i + 1))(`${engine} reopened host sinks redact ref split %i`, async split => {
    await replay(async (emit, end, read) => {
      const turn = `ref-${split}`;
      await emit(turn, `before ${ref.slice(0, split)}`); await emit(turn, `${ref.slice(split)} after.`); await end(turn);
      for (const text of read(turn)) { expect(text).not.toContain(ref); expect(text).toBe("before [private media] after."); }
    });
  });

  test(`${engine} reopened host sinks retain image payload context through completion and cancellation`, async () => {
    await replay(async (emit, end, read) => {
      for (const branch of ["delta", "voice", "voice-chunk"] as const) for (const status of ["completed", "interrupted"] as const) {
        const envelopes = [
          ['{"type":"image","mimeType":"image/png","data":"', pixels, '"}'],
          ['{"type":"image","source":{"type":"base64","media_type":"image/png","data":"', pixels, '"}}'],
          ['data:image/png;base64,', pixels, ' end.'],
          ['data:im', `age/png;base64,${pixels}`, ' end.'],
          ['{"type":"image"]', pixels, '}'],
          ['{\"type\":\"image\",\"data\":\"', pixels.repeat(100), '\"}'],
          ['{"content":"{\\"type\\":\\"image\\",\\"data\\":\\"', pixels, '\\"}"}'],
        ];
        for (const [index, parts] of envelopes.entries()) {
          const turn = `${branch}-${status}-${index}`;
          await emit(turn, parts[0], branch); await emit(turn, parts[1], branch);
          for (const text of read(turn, branch)) expect(text).not.toContain(pixels);
          if (status === "completed") await emit(turn, parts[2], branch);
          await end(turn, status);
          for (const text of read(turn, branch)) expect(text).not.toContain(pixels);
        }
      }
    });
  });

  test(`${engine} ordinary image/data phrases and prefix mismatches survive exact host disk replay`, async () => {
    await replay(async (emit, end, read) => {
      for (const branch of ["delta", "voice", "voice-chunk", "assistant"] as const) for (const [index, phrase] of phrases.entries()) {
        const turn = `phrase-${branch}-${index}`;
        await emit(turn, phrase, branch); await end(turn);
        for (const text of read(turn, branch)) expect(text).toBe(phrase);
      }
      for (const [index, phrase] of ["I am", "medial", "data", "data:image", "media", "media_", "media_kit", "m", "Медіа й дані лишаються текстом.", '{ "image description": "ordinary data" }'].entries()) {
        const turn = `text-${index}`;
        for (const char of phrase) await emit(turn, char);
        await end(turn);
        for (const text of read(turn)) expect(text).toBe(phrase);
      }
    });
  });
}
