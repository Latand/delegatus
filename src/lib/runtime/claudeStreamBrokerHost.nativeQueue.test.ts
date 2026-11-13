import { execFileSync, spawn } from "node:child_process";
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
const installedVersion = binary ? execFileSync(binary, ["--version"], { cwd: os.tmpdir(),
  env: { NODE_ENV: "test", PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
}).toString().match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? null : null;
test.skipIf(!binary).each([
  "combined-replay", "guarded-delivery", "serialized-delivery", "seat-inbox", "seat-inbox-native",
  "native-evidence-review-omitted", "native-evidence-review-invalid", "native-evidence-review-legacy",
  "native-evidence", "native-evidence-restart", "native-evidence-error", "native-evidence-interruption",
  "native-evidence-permission-allow", "native-evidence-permission-deny", "native-evidence-permission-cancel",
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
    let upgraded = false;
    const originalResults: Array<Record<string, unknown>> = [];
    const rawKinds: string[] = [];
    const replays: Array<Array<{ type: string; text?: string }>> = [];
    const replayUuids: unknown[] = [];
    const resultUuids: unknown[] = [];
    const resultFrames: Array<Record<string, unknown>> = [];
    const wireInputs: Array<Record<string, unknown>> = [];
    const requests: Array<{ messages: unknown[] }> = [];
    const lifecycle = mode.startsWith("native-evidence") || ["images", "restart", "interruption", "permission-allow", "permission-deny", "permission-cancel"].includes(mode);
    const permission = mode.includes("permission-");
    const nativeEvidence = mode.startsWith("native-evidence") || mode === "seat-inbox-native";
    const permissionFile = path.join(directory, "permission.txt");
    // Valid 1px PNG; both the original bytes and references survive delivery.
    const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64");
    const image = { sha256: crypto.createHash("sha256").update(imageBytes).digest("hex"), mime: "image/png" as const, bytes: imageBytes.length };
    const inputUuid = (ordinal: number) => `00000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
    let apiCalls = 0;
    let releaseFirst!: () => void;
    const firstResponse = new Promise<void>(resolve => { releaseFirst = resolve; });
    const delayedWrites = new Set<Promise<void>>();

    const event = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    const api = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      if (new URL(request.url).pathname !== "/v1/messages") return new Response("{}", { status: 404 });
      const body = await request.json() as { messages: unknown[]; tools?: unknown };
      if (body.tools === undefined) return new Response("{}", { status: 404 });
      requests.push(body);
      const call = ++apiCalls;
      if ((mode.startsWith("seat-inbox") || lifecycle) && call === 1) await firstResponse;
      if (mode === "native-evidence-error") return Response.json({ type: "error",
        error: { type: "invalid_request_error", message: "fixture rejection" } }, { status: 400 });

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
    const driveUntilReceipt = async (deliveryQueue: StructuredDeliveryQueue, operationId: string,
      expected: "delivered" | "interrupted" | "answered") => {
      for (let attempt = 0; attempt < 1200; attempt++) {
        await deliveryQueue.drain();
        if (journal.operationResult(operationId)?.receipt.status === expected) {
          // Join one more controller pass before teardown. That pass may make
          // progress on a later queued message; callers assert by receipt and
          // order instead of assuming the host remains idle here.
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
        model: "fixture-model", requestTimeoutMs: nativeEvidence ? 30_000 : 20_000, deliveryLedger: ledger,
        claudeProjectsDir: path.join(config, "projects"), readImage: () => imageBytes,
        readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max",
          ...(nativeEvidence && (mode !== "native-evidence-review-legacy" || upgraded) ? { version: installedVersion } : {}) }),
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
          if (mode.includes("review-")) {
            const emit = child.stdout.emit.bind(child.stdout);
            let transformed = "";
            child.stdout.emit = ((name: string, ...args: unknown[]) => {
              if (name !== "data") return Reflect.apply(emit, child.stdout, [name, ...args]);
              transformed += String(args[0]);
              let newline: number;
              while ((newline = transformed.indexOf("\n")) >= 0) {
                const line = transformed.slice(0, newline); transformed = transformed.slice(newline + 1);
                if (!line) continue;
                const frame = JSON.parse(line);
                if (frame.type === "result") {
                  originalResults.push(structuredClone(frame));
                  if (mode === "native-evidence-review-omitted") delete frame.user_message_uuids;
                  if (mode === "native-evidence-review-invalid") frame.user_message_uuids = [frame.user_message_uuid, frame.user_message_uuid];
                }
                emit("data", Buffer.from(JSON.stringify(frame) + "\n"));
              }
              return true;
            }) as typeof child.stdout.emit;
          }

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
                if (frame.type === "result") { resultUuids.push(frame.user_message_uuids); resultFrames.push(frame); }
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
            if (mode === "interruption" && frame.type === "control_request"
              && (frame as { request?: { subtype?: string } }).request?.subtype === "interrupt") {
              let finish!: () => void;
              const pending = new Promise<void>(resolve => { finish = resolve; });
              delayedWrites.add(pending);
              setTimeout(() => {
                try { Reflect.apply(write, child.stdin, [chunk, ...rest]); }
                finally { delayedWrites.delete(pending); finish(); }
              }, 60);
              return true;
            }
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
        ...{ coalescesConversation: () => mode.startsWith("seat-inbox"), bindDeliveryBatch: async () => true },
        transition: async (...args) => { journal.transitionOperation(...args); },
      }, () => host, undefined, undefined, undefined, undefined, undefined, undefined, { passBudgetMs: 20 });
      let queue = newQueue();
      if (mode.includes("review-")) {
        const command = (id: string) => ({ kind: "send" as const, operationId: id, idempotencyKey: id,
          conversationId, text: `fixture ${id}`, policy: "queue" as const });
        const seed = command("review-seed");
        journal.executeOperation(seed);
        await queue.drain();
        await wait(() => apiCalls === 1);
        const next = command("review-next");
        if (mode !== "native-evidence-review-legacy") {
          journal.executeOperation(next);
          await queue.drain();
          expect(journal.operationResult(next.operationId)?.receipt.status).toBe("queued");
          expect(wireInputs.filter(frame => frame.type === "user")).toHaveLength(1);
        }
        releaseFirst();
        await wait(() => originalResults.length === 1);
        await wait(() => store.load(host!.identity.sessionId).some(frame => frame.kind === "turn-ended" && frame.turnId === seed.operationId));
        await driveUntilReceipt(queue, seed.operationId, "delivered");
        if (mode === "native-evidence-review-legacy") {
          const sessionId = host.identity.sessionId;
          await host.release();
          ledger.recordQueued(sessionId, { id: next.operationId, text: next.text, expectedTurnId: null }, "turn-started");
          upgraded = true;
          host = await openHost(sessionId);
          queue = newQueue();
          journal.executeOperation(next);
        }
        await driveUntilReceipt(queue, next.operationId, "delivered");
        await wait(() => store.load(host!.identity.sessionId).some(frame => frame.kind === "turn-ended" && frame.turnId === next.operationId));
        expect(await host.health()).toMatchObject({ status: "idle", activeTurnRef: null });
        expect(journal.snapshot().sessions.find(session => session.conversationId === conversationId)).toMatchObject({ turn: "idle", activeTurnId: null });
        expect(originalResults).toHaveLength(2);
        expect(wireInputs.filter(frame => frame.type === "user")).toHaveLength(2);
        const rows = ledger.load(host.identity.sessionId);
        expect(rows.map(row => [row.entry.id, row.delivered])).toEqual([[seed.operationId, true], [next.operationId, true]]);
        if (mode !== "native-evidence-review-legacy") {
          expect(rows.every(row => row.nativeTurnBoundary && !row.nativeResult)).toBe(true);
          expect(originalResults.every(frame => Array.isArray(frame.user_message_uuids))).toBe(true);
        } else {
          expect(rows.every(row => !row.native)).toBe(true);
          expect(journal.operationResult(next.operationId)?.receipt).toMatchObject({ operationId: next.operationId, status: "delivered" });
        }
        journal.executeOperation(next);
        await queue.drain();
        expect(wireInputs.filter(frame => frame.type === "user")).toHaveLength(2);
        return;
      }
      if (lifecycle) {
        expect(host.supportsQueuedSend).toBe(false);
        const command = (id: string, withImage = false) => ({ kind: "send" as const, operationId: id,
          idempotencyKey: id, conversationId, text: withImage && mode === "native-evidence" ? "" : `fixture ${id}`, images: withImage ? [image] : [], policy: "queue" as const });
        const incumbent = command("lifecycle-incumbent");
        journal.executeOperation(incumbent);
        await queue.drain();
        await wait(() => apiCalls === 1);
        const pending = [0, 1, 2].map(i => command(`lifecycle-pending-${i}`, i === 1));
        pending.forEach(input => journal.executeOperation(input));
        await queue.drain();
        expect(wireInputs.filter(frame => frame.type === "user")).toHaveLength(1);
        expect(pending.map(input => journal.operationResult(input.operationId)?.receipt.status)).toEqual(["queued", "queued", "queued"]);
        if (mode.endsWith("interruption")) {
          journal.executeOperation({ kind: "interrupt", operationId: "stop-incumbent", idempotencyKey: "stop-incumbent",
            conversationId, turnId: incumbent.operationId });
          // The CLI control write is deliberately delayed beyond the queue's
          // pass budget. Keep driving until its durable terminal receipt; it
          // may be pending or delivering while that write is in flight.
          await driveUntilReceipt(queue, "stop-incumbent", "interrupted");
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
          if (mode.endsWith("permission-cancel")) {
            journal.executeOperation({ kind: "interrupt", operationId: "cancel-permission", idempotencyKey: "cancel-permission",
              conversationId, turnId: incumbent.operationId });
            await driveUntilReceipt(queue, "cancel-permission", "interrupted");
          } else {
            journal.executeOperation({ kind: "answer", operationId: "answer-permission", idempotencyKey: "answer-permission",
              conversationId, attentionId: attention!, resolution: mode.endsWith("permission-allow") ? { behavior: "allow" } : { behavior: "deny" } });
            await driveUntilReceipt(queue, "answer-permission", "answered");
          }
        }
        await wait(() => rawKinds.filter(kind => kind === "result").length >= 1);
        await wait(() => store.load(host!.identity.sessionId).some(frame => frame.kind === "turn-ended" && frame.turnId === incumbent.operationId));
        const initialEnd = store.load(host.identity.sessionId).filter(frame => frame.kind === "turn-ended");
        expect(initialEnd).toContainEqual(expect.objectContaining({ turnId: incumbent.operationId,
          status: mode.endsWith("interruption") || mode.endsWith("permission-cancel") ? "interrupted" : mode === "native-evidence-error" ? "error" : "completed" }));
        if (permission) {
          expect(fs.existsSync(permissionFile)).toBe(mode.endsWith("permission-allow"));
          if (mode.endsWith("permission-allow")) expect(fs.readFileSync(permissionFile, "utf8")).toBe("fixture permission content");
        }
        if (mode.endsWith("restart")) {
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
        for (const input of commands) {
          await driveUntilReceipt(queue, input.operationId, "delivered");
          expect(journal.operationResult(input.operationId)?.receipt).toMatchObject({ status: "delivered", turnId: input.operationId });
          queue = newQueue();
        }
        await wait(() => rawKinds.filter(kind => kind === "result").length >= 7);
        let finalHealth: Awaited<ReturnType<ClaudeStreamBrokerHost["health"]>> | undefined;
        for (let attempt = 0; attempt < 1200; attempt++) {
          finalHealth = await host.health();
          if (finalHealth.status === "idle") break;
          await Bun.sleep(25);
        }
        expect(finalHealth).toMatchObject({ status: "idle", activeTurnRef: null });
        const rows = new FileClaudeDeliveryLedger(path.join(directory, "deliveries")).load(host.identity.sessionId);
        expect(rows.map(row => row.entry.id)).toEqual([incumbent, ...commands].map(input => input.operationId));
        expect(rows.every(row => row.delivered && (row.engineMessageId || row.nativeResult))).toBe(true);
        if (mode.startsWith("native-evidence")) {
          expect(installedVersion).toBe("2.1.323");
          expect(rows.every(row => row.native && (row.nativeResult || row.nativeTerminal))).toBe(true);
          expect(rows.map(row => row.native!.inputUuid)).toEqual(wireInputs.filter(frame => frame.type === "user").map(frame => String(frame.uuid)));
          expect(rows.map(row => (row.nativeResult ?? row.nativeTerminal)!.turnId)).toEqual(rows.map(row => row.entry.id));
        }
        const canonical = rows.map(row => row.engineMessageId).filter(Boolean);
        expect(new Set(canonical).size).toBe(canonical.length);
        if (!nativeEvidence) expect(canonical).toHaveLength(7);
        const users = wireInputs.filter(frame => frame.type === "user");
        expect(users).toHaveLength(7);
        expect(users.map(frame => (frame.message as { content: Array<{ text?: string }> }).content.filter(block => block.text).map(block => block.text).join("")))
          .toEqual([incumbent, ...commands].map(input => input.text));
        for (const input of commands.filter(input => input.images.length)) {
          const row = rows.find(row => row.entry.id === input.operationId)!;
          expect(row.entry.content.images).toEqual([image]);
          const user = (row.native ? users.find(frame => frame.uuid === row.native!.inputUuid) : users.find(frame => JSON.stringify(frame).includes(input.text)))!;
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
      if (mode.startsWith("seat-inbox")) {
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
        await driveUntilReceipt(queue, answers[0]!.operationId, "delivered");
        await wait(() => rawKinds.filter(k => k === "result").length === 2);
        if (nativeEvidence) await wait(() => Boolean(ledger.load(host!.identity.sessionId)[1]?.nativeResult));
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
      if (nativeEvidence && host && process.env.LLV_EVIDENCE_DIR) {
        const evidence = path.join(process.env.LLV_EVIDENCE_DIR, "build");
        fs.mkdirSync(evidence, { recursive: true });
        const rows = ledger.load(host.identity.sessionId);
        fs.writeFileSync(path.join(evidence, `${process.env.LLV_NATIVE_EVIDENCE_RUN ?? "run"}-${mode}.json`), JSON.stringify({
          version: installedVersion, mode, originalResults, wireInputs, resultFrames, requests, rows,
          receipts: rows.map(row => journal.operationResult(row.entry.id)?.receipt ?? null),
          events: store.load(host.identity.sessionId),
        }, null, 2));
      }
      await Promise.all(delayedWrites);
      releaseFirst(); await host?.release(); api.stop(true); journal.close(); fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000,
);

/* The installed CLI answers an interrupt during a tool call with a rejected
   tool result ("The user doesn't want to proceed with this tool use ...") and
   "[Request interrupted by user for tool use]" ahead of the next message. An
   ordinary operator send to that running turn must leave the call alone and
   reach the model as the next user message. */
test.skipIf(!binary).each([false, true])("installed Claude keeps a running tool call when the operator sends to the busy turn (native evidence: %s)", async (nativeEvidence) => {
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
      readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max",
        ...(nativeEvidence ? { version: installedVersion } : {}) }),
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
    const quick = nativeEvidence ? send("native-second-quick-context") : null;
    const delivery = queue.drain();
    await wait(() => wireInputs.filter(frame => frame.type === "user").length === 2);
    fs.writeFileSync(path.join(directory, "tool-release"), "");
    await delivery;
    await wait(() => journal.operationResult(extra.operationId)?.receipt.status === "delivered");
    await wait(() => results.length >= 1);
    if (quick) {
      for (let attempt = 0; attempt < 1200 && journal.operationResult(quick.operationId)?.receipt.status !== "delivered"; attempt++) {
        await queue.drain(); await Bun.sleep(25);
      }
      await wait(() => results.length === 2);
      await wait(() => ledger.load(host!.identity.sessionId).every(row => row.nativeResult));
      await wait(() => store.load(host!.identity.sessionId).some(event => event.kind === "turn-ended" && event.turnId === quick.operationId));
      await queue.drain();
      expect(journal.operationResult(quick.operationId)?.receipt).toMatchObject({ status: "delivered", turnId: quick.operationId });
    }

    expect(wireInputs.filter(frame => frame.type === "control_request")).toEqual([]);
    expect(results).toEqual(quick ? ["success", "success"] : ["success"]);
    const wire = JSON.stringify(requests);
    expect(wire).not.toContain("doesn't want to proceed");
    expect(wire).not.toContain("Request interrupted by user");
    // Claude reads the follow-up alongside the completed tool at its boundary.
    expect(requests).toHaveLength(quick ? 3 : 2);
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
      .toEqual([[incumbent.operationId, true], [extra.operationId, true], ...(quick ? [[quick.operationId, true]] : [])]);
    if (nativeEvidence) {
      expect(installedVersion).toBe("2.1.323");
      expect(host.supportsQueuedSend).toBe(false);
      const rows = ledger.load(host.identity.sessionId);
      expect(rows.every(row => row.native && row.nativeResult)).toBe(true);
      expect(rows.map(row => row.nativeResult!.inputUuids)).toEqual([
        rows.slice(0, 2).map(row => row.native!.inputUuid), rows.slice(0, 2).map(row => row.native!.inputUuid), [rows[2]!.native!.inputUuid],
      ]);
      expect(JSON.stringify(requests[1]!.messages)).not.toContain(quick!.text);
    }
    await queue.drain();
    expect(wireInputs.filter(frame => frame.type === "user")).toHaveLength(quick ? 3 : 2);
    expect(await host.health()).toMatchObject({ status: "idle", activeTurnRef: null });
    expect(journal.snapshot().sessions.find(session => session.conversationId === conversationId))
      .toMatchObject({ turn: "idle", activeTurnId: null });
    expect(store.load(host.identity.sessionId).filter(frame => frame.kind === "turn-ended"))
      .toEqual([
        expect.objectContaining({ turnId: incumbent.operationId, status: "completed" }),
        ...(quick ? [expect.objectContaining({ turnId: quick.operationId, status: "completed" })] : []),
      ]);
  } finally {
    fs.writeFileSync(path.join(directory, "tool-release"), "");
    await host?.release(); api.stop(true); journal.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);

// Prospective batch contract. Admission remains contained in this slice; the
// ledger is exercised with exactly the identities its broker producer stores.
test("decision then two quick messages retain original receipts across two result boundaries", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-native-proof-"));
  try {
    const ledger = new FileClaudeDeliveryLedger(directory);
    const session = nativeUuid(20);
    const ids = ["decision", "follow-up-one", "follow-up-two"];
    const inputs = ids.map((id, index) => ({ entry: { id, text: `fixture ${id}` },
      native: { version: 1 as const, sessionId: session, writerId: nativeUuid(21),
        process: { pid: 4100, startIdentity: "4100:fixture" }, inputUuid: nativeUuid(index + 1),
        intent: "may-have-written" as const } }));
    for (const [index, input] of inputs.entries()) {
      await ledger.recordNativeIntent(session, input.entry, index ? "queued-next-turn" : "turn-started", input.native);
    }
    const seed = nativeResult(session, inputs[0]!.native.writerId, [nativeUuid(1)], ids[0]!, nativeUuid(30));
    expect(await ledger.confirmNativeResult(session, seed)).toBe("accepted");
    // Early B replay is deliberately absent from receipt authority.
    let restored = new FileClaudeDeliveryLedger(directory).load(session);
    expect(restored.map(row => row.delivered)).toEqual([true, false, false]);
    const combined = nativeResult(session, inputs[0]!.native.writerId, [nativeUuid(2), nativeUuid(3)], ids[1]!, nativeUuid(31));
    expect(await ledger.confirmNativeResult(session, combined)).toBe("accepted");
    expect(await ledger.confirmNativeResult(session, combined)).toBe("already-confirmed");
    restored = new FileClaudeDeliveryLedger(directory).load(session);
    expect(restored.map(row => [row.entry.id, row.nativeResult?.turnId, row.engineMessageId ?? null]))
      .toEqual([[ids[0], ids[0], null], [ids[1], ids[1], null], [ids[2], ids[1], null]]);
    expect(restored.every(row => row.delivered)).toBe(true);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("combined replay preserves explicit merged identities without allocating one canonical UUID twice", async () => {
  const { readClaudeTranscriptUsers } = await import("./claudeStreamBrokerHost");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-native-merged-"));
  try {
    const filename = path.join(directory, "fixture.jsonl");
    fs.writeFileSync(filename, JSON.stringify({ type: "user", sessionId: nativeUuid(20), uuid: nativeUuid(3),
      mergedSendUuids: [nativeUuid(2)], message: { role: "user", content: [
        { type: "text", text: "fixture follow-up one\n" }, { type: "text", text: "fixture follow-up two" },
      ] } }) + "\n");
    expect(readClaudeTranscriptUsers(filename)).toEqual([expect.objectContaining({
      uuid: nativeUuid(3), sessionId: nativeUuid(20), mergedSendUuids: [nativeUuid(2)], prompt: true,
    })]);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

function nativeUuid(ordinal: number): string {
  return `00000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
}

test("native working cache retires 128 batches and recovers old identities on demand", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-native-cache-"));
  try {
    const sessionId = nativeUuid(20), writerId = nativeUuid(21);
    const ledger = new FileClaudeDeliveryLedger(directory);
    const entry = (n: number) => ({ id: `batch-${n}`, text: `fixture ${n}` });
    const input = (n: number) => ({ version: 1 as const, sessionId, writerId,
      process: { pid: 4100, startIdentity: "4100:fixture" }, inputUuid: nativeUuid(100 + n), intent: "may-have-written" as const });
    const proof = (n: number) => nativeResult(sessionId, writerId, [input(n).inputUuid], entry(n).id, nativeUuid(1000 + n));
    const cacheRows = (owner: FileClaudeDeliveryLedger) => [...(owner as unknown as { nativeSessions: Map<string, unknown[]> }).nativeSessions.values()].flat();
    const retained: number[] = [];
    for (let n = 1; n <= 128; n++) {
      await ledger.recordNativeIntent(sessionId, entry(n), "turn-started", input(n));
      expect(await ledger.confirmNativeResult(sessionId, proof(n))).toBe("accepted");
      retained.push(cacheRows(ledger).length);
    }
    expect(retained).toEqual(Array(128).fill(0));
    const size = fs.statSync(path.join(directory, `${sessionId}.jsonl`)).size;
    for (const owner of [ledger, new FileClaudeDeliveryLedger(directory)]) {
      await owner.loadDurable(sessionId, true);
      expect(cacheRows(owner)).toHaveLength(0);
      await owner.recordNativeIntent(sessionId, entry(1), "turn-started", input(1));
      expect(await owner.confirmNativeResult(sessionId, proof(1))).toBe("already-confirmed");
      expect(await owner.confirmNativeResult(sessionId, { ...proof(1), turnId: "other" })).toBe("refused");
      await expect(owner.recordNativeIntent(sessionId, { ...entry(1), text: "different" }, "turn-started", input(1))).rejects.toThrow("conflicts");
      await expect(owner.recordNativeIntent(sessionId, entry(129), "turn-started", input(1))).rejects.toThrow("already allocated");
      expect(cacheRows(owner)).toHaveLength(0);
    }
    expect(ledger.load(sessionId)).toHaveLength(128);
    const child = Bun.spawnSync([process.execPath, "-e", `
      const { FileClaudeDeliveryLedger } = await import(${JSON.stringify(new URL("./claudeStreamBrokerHost.ts", import.meta.url).href)});
      const ledger = new FileClaudeDeliveryLedger(process.argv[1]);
      await ledger.recordNativeIntent(process.argv[2], JSON.parse(process.argv[3]), "turn-started", JSON.parse(process.argv[4]));
      console.log(await ledger.confirmNativeResult(process.argv[2], JSON.parse(process.argv[5])));
    `, directory, sessionId, JSON.stringify(entry(1)), JSON.stringify(input(1)), JSON.stringify(proof(1))], { env: { ...process.env }, cwd: process.cwd() });
    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString().trim()).toBe("already-confirmed");
    expect(fs.statSync(path.join(directory, `${sessionId}.jsonl`)).size).toBe(size);
    // Even a saturated negative filter supplies no receipt/allocation authority.
    for (const bits of (ledger as unknown as { nativeHistory: Map<string, Uint8Array> }).nativeHistory.values()) bits.fill(255);
    await ledger.recordNativeIntent(sessionId, entry(129), "turn-started", input(129));
    expect(await ledger.confirmNativeResult(sessionId, proof(129))).toBe("accepted");
    expect(cacheRows(ledger)).toHaveLength(0);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

function nativeResult(sessionId: string, writerId: string, inputUuids: string[], turnId: string, resultUuid: string) {
  return { version: 1 as const, sessionId, writerId, process: { pid: 4100, startIdentity: "4100:fixture" },
    resultUuid, inputUuids, turnId, status: "completed" as const };
}

test.each(["completed", "interrupted", "error"] as const)("independent %s boundary round-trips without confirming consumption", async status => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-native-boundary-record-"));
  try {
    const sessionId = nativeUuid(20), writerId = nativeUuid(21);
    const ledger = new FileClaudeDeliveryLedger(directory);
    const input = { version: 1 as const, sessionId, writerId, process: { pid: 4100, startIdentity: "4100:fixture" }, inputUuid: nativeUuid(1), intent: "may-have-written" as const };
    await ledger.recordNativeIntent(sessionId, { id: "incumbent", text: "fixture" }, "turn-started", input);
    const boundary = { ...input, resultUuid: nativeUuid(30), turnId: "incumbent", status };
    expect(await ledger.recordNativeTurnBoundary(sessionId, boundary)).toBe("accepted");
    const restored = new FileClaudeDeliveryLedger(directory);
    expect(restored.load(sessionId)[0]).toMatchObject({ delivered: false, nativeTurnBoundary: { status, resultUuid: nativeUuid(30) } });
    expect(await restored.recordNativeTurnBoundary(sessionId, boundary)).toBe("already-confirmed");
    expect(await restored.recordNativeTurnBoundary(sessionId, { ...boundary, turnId: "other" })).toBe("refused");
    expect(await restored.confirmNativeResult(sessionId, nativeResult(sessionId, writerId, [input.inputUuid], "incumbent", boundary.resultUuid))).toBe("refused");
    expect(restored.load(sessionId)[0]?.delivered).toBe(false);
    await expect(restored.recordNativeNoWrite(sessionId, "incumbent", input.inputUuid)).rejects.toThrow("conflicts");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("native active capacity survives process restart and frees only after a durable boundary", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-native-capacity-"));
  try {
    const sessionId = nativeUuid(20), writerId = nativeUuid(21);
    const ledger = new FileClaudeDeliveryLedger(directory);
    const input = (n: number) => ({ version: 1 as const, sessionId, writerId,
      process: { pid: 4100, startIdentity: "4100:fixture" }, inputUuid: nativeUuid(n), intent: "may-have-written" as const });
    for (const n of [1, 2, 3]) await ledger.recordNativeIntent(sessionId, { id: `input-${n}`, text: "fixture" }, n === 1 ? "turn-started" : "queued-next-turn", input(n));
    const fourth = { id: "input-4", text: "fixture" };
    await expect(ledger.recordNativeIntent(sessionId, fourth, "queued-next-turn", input(4))).rejects.toThrow("capacity");
    const child = Bun.spawnSync([process.execPath, "-e", `
      const { FileClaudeDeliveryLedger } = await import(${JSON.stringify(new URL("./claudeStreamBrokerHost.ts", import.meta.url).href)});
      try {
        await new FileClaudeDeliveryLedger(process.argv[1]).recordNativeIntent(process.argv[2], JSON.parse(process.argv[3]), "queued-next-turn", JSON.parse(process.argv[4]));
        process.exitCode = 1;
      } catch (error) { console.log(error instanceof Error && error.message === "Claude native active input capacity is exhausted" ? "refused" : "unexpected"); }
    `, directory, sessionId, JSON.stringify(fourth), JSON.stringify(input(4))], { env: { ...process.env }, cwd: process.cwd() });
    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString().trim()).toBe("refused");
    expect(ledger.load(sessionId)).toHaveLength(3);
    expect(await ledger.confirmNativeResult(sessionId, nativeResult(sessionId, writerId, [input(1).inputUuid], "input-1", nativeUuid(30)))).toBe("accepted");
    await ledger.recordNativeIntent(sessionId, fourth, "queued-next-turn", input(4));
    expect(ledger.load(sessionId).map(row => row.entry.id)).toEqual(["input-1", "input-2", "input-3", "input-4"]);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});


test.each([
  ["session", { sessionId: nativeUuid(99) }], ["writer", { writerId: nativeUuid(99) }],
  ["process", { process: { pid: 4101, startIdentity: "4101:fixture" } }],
  ["process start", { process: { pid: 4100, startIdentity: "4100:changed" } }],
  ["empty", { inputUuids: [] }], ["duplicate", { inputUuids: [nativeUuid(1), nativeUuid(1)] }],
  ["unknown", { inputUuids: [nativeUuid(99)] }], ["order", { inputUuids: [nativeUuid(2), nativeUuid(1)] }],
  ["overflow", { inputUuids: [1, 2, 3, 4].map(nativeUuid) }],
  ["owner", { turnId: "other-operation" }], ["version", { version: 2 }], ["error", { status: "error" }],
] as const)("native boundary refuses %s without confirming or consuming any input", async (_kind, mutation) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-native-hostile-"));
  try {
    const ledger = new FileClaudeDeliveryLedger(directory);
    const session = nativeUuid(20), writer = nativeUuid(21);
    for (const ordinal of [1, 2]) await ledger.recordNativeIntent(session, { id: `input-${ordinal}`, text: "identical fixture text" },
      ordinal === 1 ? "turn-started" : "queued-next-turn", { version: 1, sessionId: session, writerId: writer,
        process: { pid: 4100, startIdentity: "4100:fixture" }, inputUuid: nativeUuid(ordinal), intent: "may-have-written" });
    const proof = { ...nativeResult(session, writer, [nativeUuid(1), nativeUuid(2)], "input-1", nativeUuid(30)), ...mutation };
    expect(await ledger.confirmNativeResult(session, proof as Parameters<typeof ledger.confirmNativeResult>[1])).toBe("refused");
    expect(new FileClaudeDeliveryLedger(directory).load(session).map(row => row.delivered)).toEqual([false, false]);
    expect(ledger.confirmDelivered(session, "input-1", nativeUuid(1))).toBe("refused");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("native result recovery reads a whole batch in a new process", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-native-process-"));
  try {
    const ledger = new FileClaudeDeliveryLedger(directory);
    const session = nativeUuid(20), writer = nativeUuid(21);
    for (const ordinal of [1, 2, 3]) await ledger.recordNativeIntent(session, { id: `input-${ordinal}`, text: `fixture ${ordinal}` },
      ordinal === 1 ? "turn-started" : "queued-next-turn", { version: 1, sessionId: session, writerId: writer,
        process: { pid: 4100, startIdentity: "4100:fixture" }, inputUuid: nativeUuid(ordinal), intent: "may-have-written" });
    await ledger.confirmNativeResult(session, nativeResult(session, writer, [1, 2, 3].map(nativeUuid), "input-1", nativeUuid(30)));
    const child = Bun.spawnSync([process.execPath, "-e", `
      const { FileClaudeDeliveryLedger } = await import(${JSON.stringify(new URL("./claudeStreamBrokerHost.ts", import.meta.url).href)});
      console.log(JSON.stringify(new FileClaudeDeliveryLedger(process.argv[1]).load(process.argv[2]).map(s => [s.entry.id, s.delivered, s.nativeResult.turnId])));
    `, directory, session], { env: { ...process.env }, cwd: process.cwd() });
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(child.stdout.toString())).toEqual([1, 2, 3].map(i => [`input-${i}`, true, "input-1"]));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});


test.each([
  { session_id: "other-session" }, { session_id: undefined }, { parent_tool_use_id: "other-tool" }, { agent_id: "other-agent" },
  { uuid: "invalid" }, { user_message_uuid: "other-input" }, { user_message_uuids: [] },
  { user_message_uuids: [1, 1].map(nativeUuid) }, { user_message_uuids: [2, 1].map(nativeUuid) },
  { user_message_uuids: [1, 2, 3, 4].map(nativeUuid) }, { subtype: "interrupted" }, { is_error: true }, { aborted: true },
])("raw native success evidence refuses hostile envelope %j", async (mutation) => {
  const { nativeBoundary } = await import("./claudeNativeDelivery");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-native-envelope-"));
  try {
    const ledger = new FileClaudeDeliveryLedger(directory);
    const sessionId = nativeUuid(20), writerId = nativeUuid(21), process = { pid: 4100, startIdentity: "4100:fixture" };
    for (const ordinal of [1, 2]) await ledger.recordNativeIntent(sessionId, { id: `input-${ordinal}`, text: "identical text" },
      ordinal === 1 ? "turn-started" : "queued-next-turn", { version: 1, sessionId, writerId, process,
        inputUuid: nativeUuid(ordinal), intent: "may-have-written" });
    const frame = { type: "result", session_id: sessionId, uuid: nativeUuid(30), subtype: "success",
      user_message_uuid: nativeUuid(2), user_message_uuids: [1, 2].map(nativeUuid) };
    expect(nativeBoundary(frame, { sessionId, writerId, process }, "input-1", ledger.load(sessionId))).not.toBeNull();
    expect(nativeBoundary({ ...frame, ...mutation }, { sessionId, writerId, process }, "input-1", ledger.load(sessionId))).toBeNull();
    expect(ledger.load(sessionId).some(row => row.delivered)).toBe(false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});


test("a torn native proof is unconfirmed and cannot authorize a fresh append", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-native-torn-"));
  try {
    const sessionId = nativeUuid(20), writerId = nativeUuid(21);
    const ledger = new FileClaudeDeliveryLedger(directory);
    const input = { version: 1 as const, sessionId, writerId, process: { pid: 4100, startIdentity: "4100:fixture" },
      inputUuid: nativeUuid(1), intent: "may-have-written" as const };
    await ledger.recordNativeIntent(sessionId, { id: "original", text: "fixture instruction" }, "turn-started", input);
    const filename = path.join(directory, `${sessionId}.jsonl`);
    fs.appendFileSync(filename, JSON.stringify({ kind: "native-result", proof: nativeResult(sessionId, writerId, [input.inputUuid], "original", nativeUuid(30)) }));
    const restored = new FileClaudeDeliveryLedger(directory);
    expect(restored.load(sessionId)[0]?.delivered).toBe(false);
    await expect(restored.recordNativeIntent(sessionId, { id: "later", text: "fixture later" }, "turn-started",
      { ...input, inputUuid: nativeUuid(2) })).rejects.toThrow("partial record");
    expect(restored.load(sessionId).map(row => row.entry.id)).toEqual(["original"]);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});


test("a proven no-write retry follows actual write order and preserves its UUID across writers", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-native-no-write-order-"));
  try {
    const ledger = new FileClaudeDeliveryLedger(directory);
    const sessionId = nativeUuid(20), process = { pid: 4100, startIdentity: "4100:fixture" };
    const original = { id: "original", text: "fixture original" };
    const input = { version: 1 as const, sessionId, writerId: nativeUuid(21), process, inputUuid: nativeUuid(1), intent: "may-have-written" as const };
    await ledger.recordNativeIntent(sessionId, original, "turn-started", input);
    await ledger.recordNativeNoWrite(sessionId, original.id, input.inputUuid);
    const replacement = { ...input, writerId: nativeUuid(22), process: { pid: 4101, startIdentity: "4101:fixture" } };
    const restored = new FileClaudeDeliveryLedger(directory);
    await restored.recordNativeIntent(sessionId, { id: "incumbent", text: "fixture incumbent" }, "turn-started", { ...replacement, inputUuid: nativeUuid(2) });
    await restored.recordNativeIntent(sessionId, original, "queued-next-turn", replacement);
    expect(new FileClaudeDeliveryLedger(directory).load(sessionId).map(row => [row.entry.id, row.native?.inputUuid, row.disposition])).toEqual([
      ["incumbent", nativeUuid(2), "turn-started"], ["original", nativeUuid(1), "queued-next-turn"],
    ]);
    expect(await restored.confirmNativeResult(sessionId, { ...replacement, version: 1, resultUuid: nativeUuid(30),
      inputUuids: [nativeUuid(2), nativeUuid(1)], turnId: "incumbent", status: "completed" })).toBe("accepted");
    expect(new FileClaudeDeliveryLedger(directory).load(sessionId).map(row => row.nativeResult?.turnId)).toEqual(["incumbent", "incumbent"]);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
