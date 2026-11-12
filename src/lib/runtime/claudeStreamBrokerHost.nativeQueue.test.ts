import { spawn } from "node:child_process";
import crypto from "node:crypto";
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
test.skipIf(!binary).each([
  "combined-replay", "guarded-delivery", "serialized-delivery", "seat-inbox",
  "images", "restart", "interruption", "permission-allow", "permission-deny", "permission-cancel",
] as const)(
  "installed Claude queue protocol with loopback API: %s", async (mode) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-claude-native-queue-"));
    const config = path.join(directory, ".claude");
    fs.mkdirSync(config);
    fs.writeFileSync(path.join(directory, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }));
    let journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
    const store = new FileRuntimeEventStore(path.join(directory, "events"));
    const ledger = new FileClaudeDeliveryLedger(path.join(directory, "deliveries"));
    const conversationId = "native-queue-fixture";
    const rawKinds: string[] = [];
    const replays: Array<Array<{ type: string; text?: string }>> = [];
    const replayUuids: unknown[] = [];
    const resultUuids: unknown[] = [];
    const wireInputs: Array<Record<string, unknown>> = [];
    const requests: Array<{ messages: unknown[] }> = [];
    const lifecycle = ["images", "restart", "interruption", "permission-allow", "permission-deny", "permission-cancel"].includes(mode);
    const permission = mode.startsWith("permission-");
    const permissionFile = path.join(directory, "permission.txt");
    // Valid 1px PNG; both the original bytes and references survive delivery.
    const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64");
    const image = { sha256: crypto.createHash("sha256").update(imageBytes).digest("hex"), mime: "image/png" as const, bytes: imageBytes.length };
    const inputUuid = (ordinal: number) => `00000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
    let apiCalls = 0;
    let releaseFirst!: () => void;
    const firstResponse = new Promise<void>(resolve => { releaseFirst = resolve; });

    const event = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    const api = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      if (new URL(request.url).pathname !== "/v1/messages") return new Response("{}", { status: 404 });
      const body = await request.json() as { messages: unknown[]; tools?: unknown };
      if (permission && body.tools === undefined) return new Response("{}", { status: 404 });
      requests.push(body);
      const call = ++apiCalls;
      if ((mode === "seat-inbox" || lifecycle) && call === 1) await firstResponse;

      const tool = permission && call === 1;
      const message = { id: `msg_fixture_${call}`, type: "message", role: "assistant", model: "fixture-model",
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
      return new Response([
        event("message_start", { type: "message_start", message }),
        event("content_block_start", { type: "content_block_start", index: 0, content_block: tool
          ? { type: "tool_use", id: "toolu_permission_fixture", name: "Write", input: {} } : { type: "text", text: "" } }),
        event("content_block_delta", { type: "content_block_delta", index: 0, delta: tool
          ? { type: "input_json_delta", partial_json: JSON.stringify({ file_path: permissionFile, content: "fixture permission content" }) }
          : { type: "text_delta", text: "fixture response" } }),
        event("content_block_stop", { type: "content_block_stop", index: 0 }),
        event("message_delta", { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }),
        event("message_stop", { type: "message_stop" }),
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    } });
    let host: ClaudeStreamBrokerHost | null = null;
    const wait = async (done: () => boolean) => {
      for (let i = 0; i < 1200 && !done(); i++) await Bun.sleep(25);
      expect(done()).toBe(true);
    };
    const driveUntilReceipt = async (deliveryQueue: StructuredDeliveryQueue, operationId: string, expected: "interrupted" | "answered") => {
      for (let attempt = 0; attempt < 1200; attempt++) {
        await deliveryQueue.drain();
        if (journal.operationResult(operationId)?.receipt.status === expected) {
          // Join one more controller pass before teardown so a lane that
          // outlived its pass budget cannot still be using the journal.
          await deliveryQueue.drain();
          return;
        }
        await Bun.sleep(25);
      }
      expect(journal.operationResult(operationId)?.receipt.status).toBe(expected);
    };
    const openHost = (sessionId?: string) => {
      const options = { binary, cwd: directory,
        env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory, XDG_CONFIG_HOME: path.join(directory, "config"),
          LLV_STATE_DIR: path.join(directory, "state"), NODE_ENV: "test" },
        tools: permission ? ["Write"] : [], permissionMode: permission ? "default" : "bypassPermissions",
        model: "fixture-model", requestTimeoutMs: 20_000, deliveryLedger: ledger,
        claudeProjectsDir: path.join(config, "projects"), readImage: () => imageBytes,
        readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
        eventStore: {
          load: id => store.load(id),
          append: (id, frame) => {
            store.append(id, frame);
            const projected = projectEngineHostEvent(conversationId, `claude:${id}`, frame);
            if (projected) journal.append(projected);
          },
        },
        spawnProcess: (command: string, args: string[], options: import("node:child_process").SpawnOptionsWithoutStdio) => {
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
                if (frame.type === "user" && frame.isReplay === true) {
                  replays.push(frame.message.content);
                  replayUuids.push(frame.uuid);
                }
                if (frame.type === "result") resultUuids.push(frame.user_message_uuids);
              }
            }
          });
          const write = child.stdin.write.bind(child.stdin);
          child.stdin.write = ((chunk: string, ...rest: unknown[]) => {
            const frame = JSON.parse(String(chunk));
            if (mode === "combined-replay" && frame.type === "user") {
              // Protocol observation only: the broker owns the seed. Inject two
              // native inputs at the transport seam, without changing admission
              // or inventing broker receipts for inputs it never submitted.
              const inputs = ["native-a", "native-b", "native-c"].map((id, index) => ({
                ...frame, uuid: inputUuid(index + 1),
                message: { role: "user", content: [{ type: "text", text: `fixture ${id}` }] },
              }));
              wireInputs.push(...inputs);
              return Reflect.apply(write, child.stdin, [inputs.map(input => JSON.stringify(input) + "\n").join(""), ...rest]);
            }
            wireInputs.push(frame);
            if (permission && frame.type === "control_response") {
              // Keep the permission-control lane active beyond its 20 ms
              // pass budget while still sending the real frame to the CLI.
              setTimeout(() => Reflect.apply(write, child.stdin, [chunk, ...rest]), 60);
              return true;
            }
            return Reflect.apply(write, child.stdin, [chunk, ...rest]);
          }) as typeof child.stdin.write;
          return child;
        },
      } satisfies Parameters<typeof ClaudeStreamBrokerHost.start>[0];
      return sessionId ? ClaudeStreamBrokerHost.adopt(sessionId, options) : ClaudeStreamBrokerHost.start(options);
    };
    try {
      host = await openHost();
      journal.append({ scope: `session:${conversationId}`, kind: "session-status", payload: {
        conversationId, sessionKey: { engine: "claude", sessionId: host.identity.sessionId }, hostKind: "claude-broker",
        host: "hosted", turn: "idle", activeTurnId: null, capabilities: { steer: false, structuredAttention: true },
      } });
      const newQueue = () => new StructuredDeliveryQueue({
        effects: async (kinds, after) => journal.effectBatch(100, kinds, after),
        status: async id => journal.operationResult(id)?.receipt ?? null,
        hostClaim: async () => "fixture-owner",
        ...{ coalescesConversation: () => mode === "seat-inbox", bindDeliveryBatch: async () => true },
        transition: async (...args) => { journal.transitionOperation(...args); },
      }, () => host, undefined, undefined, undefined, undefined, undefined, undefined, { passBudgetMs: 20 });
      let queue = newQueue();
      if (lifecycle) {
        expect(host.supportsQueuedSend).toBe(false);
        const command = (id: string, withImage = false) => ({ kind: "send" as const, operationId: id,
          idempotencyKey: id, conversationId, text: `fixture ${id}`, images: withImage ? [image] : [], policy: "queue" as const });
        const incumbent = command("lifecycle-incumbent");
        journal.executeOperation(incumbent);
        await queue.drain();
        await wait(() => apiCalls === 1);
        const pending = [0, 1, 2].map(i => command(`lifecycle-pending-${i}`, i === 1));
        pending.forEach(input => journal.executeOperation(input));
        await queue.drain();
        expect(wireInputs.filter(frame => frame.type === "user")).toHaveLength(1);
        expect(pending.map(input => journal.operationResult(input.operationId)?.receipt.status)).toEqual(["queued", "queued", "queued"]);
        if (mode === "interruption") {
          journal.executeOperation({ kind: "interrupt", operationId: "stop-incumbent", idempotencyKey: "stop-incumbent",
            conversationId, turnId: incumbent.operationId });
          // The preceding queued effects can spend this pass's budget before
          // its control lane runs; drive the next passes as the controller does.
          for (let attempt = 0; attempt < 1200 && journal.operationResult("stop-incumbent")?.receipt.status === "pending"; attempt++) {
            await queue.drain(); await Bun.sleep(25);
          }
          expect(journal.operationResult("stop-incumbent")?.receipt.status).toBe("interrupted");
        }
        releaseFirst();
        if (permission) {
          // Observe the actual CLI permission request, without timing a sleep.
          let attention: string | undefined;
          for (let attempt = 0; attempt < 1200 && !attention; attempt++) {
            attention = (await host.health()).pendingAttention[0];
            if (!attention) await Bun.sleep(25);
          }
          expect(attention).toBeString();
          expect(fs.existsSync(permissionFile)).toBe(false);
          await queue.drain();
          expect(wireInputs.filter(frame => frame.type === "user")).toHaveLength(1);
          if (mode === "permission-cancel") {
            journal.executeOperation({ kind: "interrupt", operationId: "cancel-permission", idempotencyKey: "cancel-permission",
              conversationId, turnId: incumbent.operationId });
            await driveUntilReceipt(queue, "cancel-permission", "interrupted");
          } else {
            journal.executeOperation({ kind: "answer", operationId: "answer-permission", idempotencyKey: "answer-permission",
              conversationId, attentionId: attention!, resolution: mode === "permission-allow" ? { behavior: "allow" } : { behavior: "deny" } });
            await driveUntilReceipt(queue, "answer-permission", "answered");
          }
        }
        await wait(() => rawKinds.filter(kind => kind === "result").length === 1);
        expect(await host.health()).toMatchObject({ status: "idle", activeTurnRef: null, pendingAttention: [] });
        const initialEnd = store.load(host.identity.sessionId).filter(frame => frame.kind === "turn-ended");
        expect(initialEnd).toEqual([expect.objectContaining({ turnId: incumbent.operationId,
          status: mode === "interruption" || mode === "permission-cancel" ? "interrupted" : "completed" })]);
        if (permission) {
          expect(fs.existsSync(permissionFile)).toBe(mode === "permission-allow");
          if (mode === "permission-allow") expect(fs.readFileSync(permissionFile, "utf8")).toBe("fixture permission content");
        }
        if (mode === "restart") {
          const sessionId = host.identity.sessionId;
          const originalReceipts = pending.map(input => journal.operationResult(input.operationId)?.receipt);
          await host.release();
          journal.close();
          journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
          host = await openHost(sessionId); // real CLI process, same transcript and durable files
          queue = newQueue();
          expect(host.identity.sessionId).toBe(sessionId);
          expect(pending.map(input => journal.operationResult(input.operationId)?.receipt)).toEqual(originalReceipts);
          expect(ledger.load(sessionId).map(row => row.entry.id)).toEqual([incumbent.operationId]);
        }
        // Two batches and a replacement executor consume the persisted queue in
        // order. Each wait follows an actual result, not one slot per echo.
        const commands = [...pending, ...[0, 1, 2].map(i => command(`lifecycle-second-${i}`, i === 1))];
        commands.slice(3).forEach(input => journal.executeOperation(input));
        for (const [index, input] of commands.entries()) {
          await queue.drain();
          await wait(() => rawKinds.filter(kind => kind === "result").length === index + 2);
          expect(journal.operationResult(input.operationId)?.receipt).toMatchObject({ status: "delivered", turnId: input.operationId });
          expect(await host.health()).toMatchObject({ status: "idle", activeTurnRef: null });
          queue = newQueue();
        }
        const rows = new FileClaudeDeliveryLedger(path.join(directory, "deliveries")).load(host.identity.sessionId);
        expect(rows.map(row => row.entry.id)).toEqual([incumbent, ...commands].map(input => input.operationId));
        expect(rows.every(row => row.delivered && row.engineMessageId)).toBe(true);
        expect(new Set(rows.map(row => row.engineMessageId)).size).toBe(7);
        const users = wireInputs.filter(frame => frame.type === "user");
        expect(users).toHaveLength(7);
        expect(users.map(frame => (frame.message as { content: Array<{ text?: string }> }).content.filter(block => block.text).map(block => block.text).join("")))
          .toEqual([incumbent, ...commands].map(input => input.text));
        for (const input of commands.filter(input => input.images.length)) {
          const row = rows.find(row => row.entry.id === input.operationId)!;
          expect(row.entry.content.images).toEqual([image]);
          const user = users.find(frame => JSON.stringify(frame).includes(input.text))!;
          expect((user.message as { content: unknown[] }).content[0])
            .toEqual({ type: "image", source: { type: "base64", media_type: image.mime, data: imageBytes.toString("base64") } });
          expect(JSON.stringify(requests)).toContain(imageBytes.toString("base64"));
        }
        for (const input of [incumbent, ...commands]) expect(journal.executeOperation(input).replayed).toBe(true);
        await queue.drain();
        expect(wireInputs.filter(frame => frame.type === "user")).toHaveLength(7);
        expect(journal.snapshot().sessions.find(session => session.conversationId === conversationId))
          .toMatchObject({ turn: "idle", activeTurnId: null, attentionIds: [] });
        return;
      }
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
        const seed = host.send({ id: "native-a", text: "fixture native-a" });
        void seed.catch(() => {});
        await wait(() => rawKinds.filter(kind => kind === "result").length === 2);
        // Current CLI echoes b separately before replaying b+c together. Assert
        // the complete shape, contents, order and identity of both results.
        expect(replays).toEqual([
          [{ type: "text", text: "fixture native-a" }],
          [{ type: "text", text: "fixture native-b" }],
          [{ type: "text", text: "fixture native-b\n" }, { type: "text", text: "fixture native-c" }],
        ]);
        expect(replayUuids).toEqual([inputUuid(1), inputUuid(2), inputUuid(3)]);
        expect(resultUuids).toEqual([[inputUuid(1)], [inputUuid(2), inputUuid(3)]]);
        expect(await seed).toEqual({ outcome: "turn-started", turnId: "native-a" });
        expect(ledger.load(host.identity.sessionId)).toEqual([
          expect.objectContaining({ entry: expect.objectContaining({ id: "native-a" }), delivered: true, engineMessageId: inputUuid(1) }),
        ]);
        expect(wireInputs.filter(frame => frame.type === "user")).toHaveLength(3);
        expect(wireInputs.filter(frame => frame.type === "control_request")).toEqual([]);
        expect(apiCalls).toBe(2);
        expect(await host.health()).toMatchObject({ status: "idle", activeTurnRef: null });
        return;
      }
      if (mode === "guarded-delivery") {
        const first = host.send({ id: "native-a", text: "fixture native-a" });
        const second = host.send({ id: "native-b", text: "fixture native-b" });
        void first.catch(() => {}); void second.catch(() => {});
        await expect(host.send({ id: "native-c", text: "fixture native-c" }))
          .resolves.toEqual({ outcome: "rejected", reason: "stale-turn" });
        expect(wireInputs.filter(frame => frame.type === "user")).toHaveLength(2);
        expect(ledger.load(host.identity.sessionId).map(row => row.entry.id)).toEqual(["native-a", "native-b"]);
        await Promise.all([first, second]);
        await wait(() => rawKinds.filter(kind => kind === "result").length === 2);
        expect(await host.health()).toMatchObject({ status: "idle", activeTurnRef: null });
        await host.send({ id: "native-c", text: "fixture native-c" });
        await wait(() => rawKinds.filter(kind => kind === "result").length === 3);
        expect(wireInputs.filter(frame => frame.type === "user")).toHaveLength(3);
        expect(ledger.load(host.identity.sessionId).map(row => [row.entry.id, row.delivered]))
          .toEqual([["native-a", true], ["native-b", true], ["native-c", true]]);
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
      ? { type: "input_json_delta", partial_json: JSON.stringify({
        command: "touch tool-started; for attempt in {1..400}; do if [ -f tool-release ]; then echo tool finished; exit 0; fi; sleep 0.05; done; exit 1",
        description: "fixture wait",
      }) }
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
    await wait(() => fs.existsSync(path.join(directory, "tool-started")));
    const extra = send("native-extra-context");
    const delivery = queue.drain();
    await wait(() => wireInputs.filter(frame => frame.type === "user").length === 2);
    fs.writeFileSync(path.join(directory, "tool-release"), "");
    await delivery;
    await wait(() => journal.operationResult(extra.operationId)?.receipt.status === "delivered");
    await wait(() => results.length === 1);

    expect(wireInputs.filter(frame => frame.type === "control_request")).toEqual([]);
    expect(results).toEqual(["success"]);
    const wire = JSON.stringify(requests);
    expect(wire).not.toContain("doesn't want to proceed");
    expect(wire).not.toContain("Request interrupted by user");
    // Claude reads the follow-up alongside the completed tool at its boundary.
    expect(requests).toHaveLength(2);
    const toolResults = requests[1]!.messages.flatMap(message => {
      const content = (message as { content?: unknown }).content;
      return Array.isArray(content) ? content.filter(block => (block as { type?: string }).type === "tool_result") : [];
    });
    expect(toolResults).toEqual([expect.objectContaining({ tool_use_id: toolUseId, is_error: false })]);
    expect(JSON.stringify(toolResults)).toContain("tool finished");
    expect(JSON.stringify(requests[0]!.messages)).not.toContain(extra.text);
    expect(JSON.stringify(requests[1]!.messages)).toContain(extra.text);
    expect(journal.operationResult(extra.operationId)?.receipt.turnId).toBe(incumbent.operationId);
    expect(ledger.load(host.identity.sessionId).map(row => [row.entry.id, row.delivered]))
      .toEqual([[incumbent.operationId, true], [extra.operationId, true]]);
    await queue.drain();
    expect(wireInputs.filter(frame => frame.type === "user")).toHaveLength(2);
    expect(await host.health()).toMatchObject({ status: "idle", activeTurnRef: null });
    expect(journal.snapshot().sessions.find(session => session.conversationId === conversationId))
      .toMatchObject({ turn: "idle", activeTurnId: null });
    expect(store.load(host.identity.sessionId).filter(frame => frame.kind === "turn-ended"))
      .toEqual([
        expect.objectContaining({ turnId: incumbent.operationId, status: "completed" }),
      ]);
  } finally {
    fs.writeFileSync(path.join(directory, "tool-release"), "");
    await host?.release(); api.stop(true); journal.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
