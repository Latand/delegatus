import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { RuntimeJournal } from "@/runtime-host/journal";
import { ClaudeStreamBrokerHost, FileClaudeDeliveryLedger } from "./claudeStreamBrokerHost";
import { FileRuntimeEventStore } from "./eventStore";
import { projectEngineHostEvent } from "./engineHostEvents";
import { StructuredDeliveryQueue } from "./structuredDeliveryQueue";

// Opt in with the installed CLI. A loopback Messages API owns every response;
// no account, credential store, external provider or Viewer is contacted.
const binary = process.env.LLV_CLAUDE_BINARY;
test.skipIf(!binary).each(["combined-replay", "serialized-delivery", "seat-inbox"] as const)(
  "installed Claude queue protocol with loopback API: %s", async (mode) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-claude-native-queue-"));
    const config = path.join(directory, ".claude");
    fs.mkdirSync(config);
    fs.writeFileSync(path.join(directory, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }));
    const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
    const store = new FileRuntimeEventStore(path.join(directory, "events"));
    const ledger = new FileClaudeDeliveryLedger(path.join(directory, "deliveries"));
    const conversationId = "native-queue-fixture";
    const rawKinds: string[] = [];
    const replays: Array<Array<{ type: string; text?: string }>> = [];
    const wireInputs: Array<Record<string, unknown>> = [];
    let apiCalls = 0;
    let releaseFirst!: () => void;
    const firstResponse = new Promise<void>(resolve => { releaseFirst = resolve; });

    const event = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    const api = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      if (new URL(request.url).pathname !== "/v1/messages") return new Response("{}", { status: 404 });
      apiCalls++;
      await request.json();
      if (mode === "seat-inbox" && apiCalls === 1) await firstResponse;

      const message = { id: `msg_fixture_${apiCalls}`, type: "message", role: "assistant", model: "fixture-model",
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
      return new Response([
        event("message_start", { type: "message_start", message }),
        event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fixture response" } }),
        event("content_block_stop", { type: "content_block_stop", index: 0 }),
        event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }),
        event("message_stop", { type: "message_stop" }),
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    } });
    let host: ClaudeStreamBrokerHost | null = null;
    const wait = async (done: () => boolean) => {
      for (let i = 0; i < 1200 && !done(); i++) await Bun.sleep(25);
      expect(done()).toBe(true);
    };
    try {
      host = await ClaudeStreamBrokerHost.start({ binary, cwd: directory,
        env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory, XDG_CONFIG_HOME: path.join(directory, "config"),
          LLV_STATE_DIR: path.join(directory, "state"), NODE_ENV: "test" },
        tools: [], model: "fixture-model", requestTimeoutMs: 20_000, deliveryLedger: ledger, readTranscript: () => [],
        readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
        eventStore: {
          load: id => store.load(id),
          append: (id, frame) => {
            store.append(id, frame);
            const projected = projectEngineHostEvent(conversationId, `claude:${id}`, frame);
            if (projected) journal.append(projected);
          },
        },
        spawnProcess: (command, args, options) => {
          const child = spawn(command, [...args, "--setting-sources", ""], { ...options, stdio: ["pipe", "pipe", "pipe"],
            env: { ...options.env, NODE_ENV: "test", CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.port}`,
              CLAUDE_CODE_OAUTH_TOKEN: "isolated-fixture-credential", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } });
          let buffer = "";

          child.stdout.on("data", chunk => {
            buffer += String(chunk);
            let newline: number;
            while ((newline = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
              if (line) {
                const frame = JSON.parse(line);
                rawKinds.push(String(frame.type));
                if (frame.type === "user" && frame.isReplay === true) replays.push(frame.message.content);
              }
            }
          });
          const write = child.stdin.write.bind(child.stdin);
          child.stdin.write = ((chunk: string, ...rest: unknown[]) => {
            wireInputs.push(JSON.parse(String(chunk)));
            return Reflect.apply(write, child.stdin, [chunk, ...rest]);
          }) as typeof child.stdin.write;
          return child;
        },
      });
      journal.append({ scope: `session:${conversationId}`, kind: "session-status", payload: {
        conversationId, sessionKey: { engine: "claude", sessionId: host.identity.sessionId }, hostKind: "claude-broker",
        host: "hosted", turn: "idle", activeTurnId: null, capabilities: { steer: false, structuredAttention: true },
      } });
      const queue = new StructuredDeliveryQueue({
        effects: async (kinds, after) => journal.effectBatch(100, kinds, after),
        status: async id => journal.operationResult(id)?.receipt ?? null,
        hostClaim: async () => "fixture-owner",
        ...{ coalescesConversation: () => mode === "seat-inbox", bindDeliveryBatch: async () => true },
        transition: async (...args) => { journal.transitionOperation(...args); },
      }, () => host, undefined, undefined, undefined, undefined, undefined, undefined, { passBudgetMs: 20 });
      if (mode === "seat-inbox") {
        const incumbent = { kind: "send" as const, operationId: "incumbent", idempotencyKey: "incumbent", conversationId, text: "initial turn", policy: "queue" as const };
        journal.executeOperation(incumbent);
        await queue.drain();
        await wait(() => apiCalls === 1);
        const answers = Array.from({ length: 6 }, (_, i) => ({ ...incumbent, operationId: `answer-${i}`, idempotencyKey: `answer-${i}`, text: `verbatim answer ${i}` }));
        answers.forEach(input => journal.executeOperation(input));
        await queue.drain();
        expect(wireInputs.filter(f => f.type === "user")).toHaveLength(1);
        releaseFirst();
        await wait(() => rawKinds.filter(k => k === "result").length === 1);
        await queue.drain();
        await wait(() => rawKinds.filter(k => k === "result").length === 2);
        expect(rawKinds.filter(k => k === "user")).toHaveLength(2);
        const rows = ledger.load(host.identity.sessionId);
        expect(rows).toHaveLength(2);
        expect(rows[1]!.entry.parts?.map(p => p.operationId)).toEqual(answers.map(a => a.operationId));
        for (const a of answers) expect(journal.operationResult(a.operationId)?.receipt).toMatchObject({ status: "delivered", turnId: rows[1]!.entry.id });
        expect(wireInputs.filter(f => f.type === "control_request")).toHaveLength(0);
        expect(replays).toHaveLength(2);
        expect(rows[1]!.delivered).toBe(true);
        return;
      }
      if (mode === "combined-replay") {
        // Deliberately bypass the queue only to observe the native protocol. Each
        // promise handles release rejection; the probe claims no receipt for a
        // combined frame and never recovers or retries those unconfirmed inputs.
        const initial = ["native-a", "native-b", "native-c"].map(id =>
          host!.send({ id, text: `fixture ${id}` }).catch(() => null));
        await wait(() => rawKinds.filter(kind => kind === "result").length === 2);
        expect(replays.map(blocks => blocks.filter(block => block.type === "text").length)).toEqual([1, 2]);
        expect(ledger.load(host.identity.sessionId).map(row => row.delivered)).toEqual([true, false, false]);
        expect(wireInputs.filter(frame => frame.type === "user")).toHaveLength(3);
        await host.release();
        await Promise.all(initial);
        return;
      }
      expect(host.supportsQueuedSend).toBe(false);
      const command = (id: string, policy: "queue" | "interrupt-active" = "queue") => ({
        kind: "send" as const, operationId: id, idempotencyKey: id, conversationId, text: `fixture ${id}`, policy,
      });
      const commands = [command("native-a"), command("native-b"), command("native-c")];
      for (const input of commands) journal.executeOperation(input);
      for (const input of commands) {
        await queue.drain();
        await wait(() => journal.operationResult(input.operationId)?.receipt.status === "delivered");
        await wait(() => store.load(host!.identity.sessionId).filter(frame => frame.kind === "turn-ended").length
          === commands.indexOf(input) + 1);
        expect(await host.health()).toMatchObject({ status: "idle", activeTurnRef: null });
      }
      expect(rawKinds.filter(kind => kind === "result")).toHaveLength(3);
      const subsequent = command("native-subsequent", "interrupt-active");
      journal.executeOperation(subsequent);
      await queue.drain();
      await wait(() => journal.operationResult(subsequent.operationId)?.receipt.status === "delivered");
      await wait(() => rawKinds.filter(kind => kind === "result").length === 4);
      for (const input of [...commands, subsequent]) {
        expect(journal.executeOperation(input).replayed).toBe(true);
        expect(journal.operationResult(input.operationId)?.receipt.turnId).toBe(input.operationId);
      }
      await queue.drain();
      expect(wireInputs.filter(frame => frame.type === "user")).toHaveLength(4);
      expect(wireInputs.filter(frame => frame.type === "control_request")).toHaveLength(0);
      expect(apiCalls).toBe(4);
      expect(await host.health()).toMatchObject({ status: "idle", activeTurnRef: null });
      expect(journal.snapshot().sessions.find(session => session.conversationId === conversationId))
        .toMatchObject({ turn: "idle", activeTurnId: null });
      const rows = ledger.load(host.identity.sessionId);
      expect(rows).toHaveLength(4);
      expect(rows.every(row => row.delivered && row.engineMessageId)).toBe(true);
      expect(new Set(rows.map(row => row.engineMessageId)).size).toBe(4);
      expect(replays.every(blocks => blocks.filter(block => block.type === "text").length === 1)).toBe(true);
    } finally {
      releaseFirst(); await host?.release(); api.stop(true); journal.close(); fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000,
);

/* The installed CLI answers an interrupt during a tool call with a rejected
   tool result ("The user doesn't want to proceed with this tool use ...") and
   "[Request interrupted by user for tool use]" ahead of the next message. An
   ordinary operator send to that running turn must leave the call alone and
   reach the model as the next user message. */
test.skipIf(!binary)("installed Claude keeps a running tool call when the operator sends to the busy turn", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-claude-busy-send-"));
  const config = path.join(directory, ".claude");
  fs.mkdirSync(config);
  fs.writeFileSync(path.join(directory, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }));
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  const store = new FileRuntimeEventStore(path.join(directory, "events"));
  const ledger = new FileClaudeDeliveryLedger(path.join(directory, "deliveries"));
  const conversationId = "native-busy-send-fixture";
  const results: string[] = [];
  const wireInputs: Array<Record<string, unknown>> = [];
  const requests: Array<{ messages: unknown[] }> = [];
  const toolUseId = "toolu_fixture_running";

  const event = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  const api = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname !== "/v1/messages") return new Response("{}", { status: 404 });
    const body = await request.json() as { messages?: unknown[]; tools?: unknown };
    // Side requests (titles, classifiers) carry no tools; only the turn is scripted.
    if (body.tools === undefined || !body.messages?.length) return new Response("{}", { status: 404 });
    requests.push({ messages: body.messages });
    const first = requests.length === 1;
    const message = { id: `msg_fixture_${requests.length}`, type: "message", role: "assistant", model: "fixture-model",
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
    const block = first ? { type: "tool_use", id: toolUseId, name: "Bash", input: {} } : { type: "text", text: "" };
    const delta = first
      ? { type: "input_json_delta", partial_json: JSON.stringify({ command: "sleep 3; echo tool finished", description: "fixture wait" }) }
      : { type: "text_delta", text: "fixture response" };
    return new Response([
      event("message_start", { type: "message_start", message }),
      event("content_block_start", { type: "content_block_start", index: 0, content_block: block }),
      event("content_block_delta", { type: "content_block_delta", index: 0, delta }),
      event("content_block_stop", { type: "content_block_stop", index: 0 }),
      event("message_delta", { type: "message_delta", delta: { stop_reason: first ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }),
      event("message_stop", { type: "message_stop" }),
    ].join(""), { headers: { "content-type": "text/event-stream" } });
  } });
  let host: ClaudeStreamBrokerHost | null = null;
  const wait = async (done: () => boolean) => {
    for (let i = 0; i < 1200 && !done(); i++) await Bun.sleep(25);
    expect(done()).toBe(true);
  };
  try {
    host = await ClaudeStreamBrokerHost.start({ binary, cwd: directory,
      env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory, XDG_CONFIG_HOME: path.join(directory, "config"),
        LLV_STATE_DIR: path.join(directory, "state"), NODE_ENV: "test" },
      tools: ["Bash"], model: "fixture-model", requestTimeoutMs: 20_000, deliveryLedger: ledger, readTranscript: () => [],
      readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      eventStore: {
        load: id => store.load(id),
        append: (id, frame) => {
          store.append(id, frame);
          const projected = projectEngineHostEvent(conversationId, `claude:${id}`, frame);
          if (projected) journal.append(projected);
        },
      },
      spawnProcess: (command, args, options) => {
        const child = spawn(command, [...args, "--setting-sources", ""], { ...options, stdio: ["pipe", "pipe", "pipe"],
          env: { ...options.env, NODE_ENV: "test", CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.port}`,
            CLAUDE_CODE_OAUTH_TOKEN: "isolated-fixture-credential", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } });
        let buffer = "";
        child.stdout.on("data", chunk => {
          buffer += String(chunk);
          let newline: number;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
            if (line) {
              const frame = JSON.parse(line);
              if (frame.type === "result") results.push(String(frame.subtype));
            }
          }
        });
        const write = child.stdin.write.bind(child.stdin);
        child.stdin.write = ((chunk: string, ...rest: unknown[]) => {
          wireInputs.push(JSON.parse(String(chunk)));
          return Reflect.apply(write, child.stdin, [chunk, ...rest]);
        }) as typeof child.stdin.write;
        return child;
      },
    });
    journal.append({ scope: `session:${conversationId}`, kind: "session-status", payload: {
      conversationId, sessionKey: { engine: "claude", sessionId: host.identity.sessionId }, hostKind: "claude-broker",
      host: "hosted", turn: "idle", activeTurnId: null, capabilities: { steer: false, structuredAttention: true },
    } });
    const queue = new StructuredDeliveryQueue({
      effects: async (kinds, after) => journal.effectBatch(100, kinds, after),
      status: async id => journal.operationResult(id)?.receipt ?? null,
      hostClaim: async () => "fixture-owner",
      transition: async (...args) => { journal.transitionOperation(...args); },
    }, () => host, undefined, undefined, undefined, undefined, undefined, undefined, { passBudgetMs: 20 });
    // What the composer's Send posts when the operator picks no policy.
    const send = (id: string) => {
      const command = { kind: "send" as const, operationId: id, idempotencyKey: id, conversationId, text: `fixture ${id}`,
        policy: "interrupt-active" as const, origin: { kind: "operator" as const } };
      journal.executeOperation(command);
      return command;
    };
    const incumbent = send("native-incumbent");
    await queue.drain();
    await wait(() => journal.operationResult(incumbent.operationId)?.receipt.status === "delivered");
    await wait(() => requests.length === 1);
    await Bun.sleep(500); // the scripted tool call is running now
    const extra = send("native-extra-context");
    // No controller runs here, so the test drives the passes it would.
    for (let pass = 0; pass < 240 && journal.operationResult(extra.operationId)?.receipt.status !== "delivered"; pass++) {
      await queue.drain(); await Bun.sleep(100);
    }
    await wait(() => journal.operationResult(extra.operationId)?.receipt.status === "delivered");
    await wait(() => results.length === 2);

    expect(wireInputs.filter(frame => frame.type === "control_request")).toEqual([]);
    expect(results).toEqual(["success", "success"]);
    const wire = JSON.stringify(requests);
    expect(wire).not.toContain("doesn't want to proceed");
    expect(wire).not.toContain("Request interrupted by user");
    // The tool call finished, and its result went back before the message.
    expect(requests).toHaveLength(3);
    const toolResults = requests[1]!.messages.flatMap(message => {
      const content = (message as { content?: unknown }).content;
      return Array.isArray(content) ? content.filter(block => (block as { type?: string }).type === "tool_result") : [];
    });
    expect(toolResults).toEqual([expect.objectContaining({ tool_use_id: toolUseId, is_error: false })]);
    expect(JSON.stringify(toolResults)).toContain("tool finished");
    expect(JSON.stringify(requests[1]!.messages)).not.toContain(extra.text);
    expect(JSON.stringify(requests[2]!.messages)).toContain(extra.text);
    expect(journal.operationResult(extra.operationId)?.receipt.turnId).toBe(extra.operationId);
    expect(store.load(host.identity.sessionId).filter(frame => frame.kind === "turn-ended"))
      .toEqual([
        expect.objectContaining({ turnId: incumbent.operationId, status: "completed" }),
        expect.objectContaining({ turnId: extra.operationId, status: "completed" }),
      ]);
  } finally {
    await host?.release(); api.stop(true); journal.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
