import { expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeJournal } from "@/runtime-host/journal";
import { CodexAppServerHost } from "./codexAppServerHost";
import { FileRuntimeEventStore } from "./eventStore";
import { parseRuntimeCommand } from "./commands";
import { StructuredDeliveryQueue } from "./structuredDeliveryQueue";
import { decodeCodexStructuredUserText } from "./codexStructuredUserText.server";

const binary = process.env.NATIVE_CODEX_QUEUE_TEST_BINARY;

for (const scenario of ["sampling", "busy-tool", "ended-before", "dropped-after", "idle", "compact"] as const) {
  test.skipIf(!binary)(`real Codex steer delivery: ${scenario}`, async () => {
    // Short private roots also keep Codex's own Unix socket paths within bounds.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "s-"));
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", NODE_ENV: "test" };
    for (const key of ["HOME", "CODEX_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "LLV_STATE_DIR", "TMPDIR"]) {
      env[key] = path.join(base, key.toLowerCase()); fs.mkdirSync(env[key]!);
    }
    const cwd = path.join(base, "workspace"); fs.mkdirSync(cwd);
    const provider: Array<{ body: string; response: ServerResponse }> = [];
    const backend = createServer((request, response) => {
      let body = "";
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write('event: response.created\ndata: {"type":"response.created","response":{"id":"fixture-response"}}\n\n');
        provider.push({ body, response });
      });
    });
    await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
    const address = backend.address(); if (!address || typeof address === "string") throw new Error("fixture bind failed");
    fs.writeFileSync(path.join(env.CODEX_HOME!, "config.toml"), `model = "fixture-model"
model_provider = "fixture"
approval_policy = "never"
sandbox_mode = "danger-full-access"
web_search = "disabled"
[model_providers.fixture]
name = "Steering integration fixture"
base_url = "http://127.0.0.1:${address.port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
[analytics]
enabled = false
[features]
apps = false
plugins = false
`);
    const requests: Array<{method: string; params: Record<string, unknown>}> = [];
    const errors: string[] = [];
    const diagnostics: string[] = [];
    let heldEnd: string | null = null;
    let holdEnd = scenario === "ended-before";
    const spawnProcess = (_command: string, args: string[]) => {
      const child = spawn(binary!, args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
      child.stderr.on("data", chunk => { diagnostics.push(String(chunk)); if (diagnostics.length > 30) diagnostics.shift(); });
      const input = new PassThrough(); const output = new PassThrough();
      const methods = new Map<number, string>();
      const inbound = createInterface({ input });
      inbound.on("line", line => {
        const message = JSON.parse(line);
        if (typeof message.id === "number") methods.set(message.id, message.method);
        if (message.method) requests.push({ method: message.method, params: message.params ?? {} });
        child.stdin.write(line + "\n");
      });
      input.on("finish", () => child.stdin.end());
      const outbound = createInterface({ input: child.stdout });
      outbound.on("line", line => {
        const message = JSON.parse(line); const method = methods.get(message.id);
        if (method === "account/read") message.result = { account: {type: "chatgpt", planType: "fixture"}, requiresOpenaiAuth: false };
        if (method === "model/list") message.result = { data: [{id: "fixture-model", model: "fixture-model", isDefault: true, inputModalities: ["text"]}] };
        const frame = JSON.stringify(message) + "\n";
        // The CLI really ends the turn; only the host's notification is held.
        if (holdEnd && message.method === "turn/completed") { heldEnd = frame; return; }
        if (method === "turn/steer" && message.error) errors.push(message.error.message);
        if (method === "turn/steer" && heldEnd) {
          // Preserve the real stream's order: completion, then refusal reply.
          output.write(heldEnd); heldEnd = null; holdEnd = false;
        }
        output.write(frame);
      });
      child.once("close", () => { inbound.close(); outbound.close(); output.end(); });
      return new Proxy(child, {get(target, property) {
        if (property === "stdin") return input;
        if (property === "stdout") return output;
        const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
      }}) as ChildProcessWithoutNullStreams;
    };
    let host: CodexAppServerHost | undefined;
    const journal = new RuntimeJournal(path.join(base, "journal.sqlite"), { structuredHosts: true });
    const states: Array<{id: string; status: string; reason?: string | null}> = [];
    async function until(predicate: () => boolean | Promise<boolean>) {
      const deadline = Date.now() + 30_000;
      while (!await predicate()) {
        if (Date.now() > deadline) throw new Error(`fixture deadline for ${predicate}\nstates=${JSON.stringify(states)}\nrequests=${JSON.stringify(requests.map(r => r.method))}\nhealth=${JSON.stringify(await host?.health())}\n${diagnostics.join("")}`);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    function complete(index: number) {
      const item = { id: `answer-${index}`, type: "message", role: "assistant", content: [{ type: "output_text", text: "done", annotations: [] }] };
      const response = provider[index]!.response;
      response.write(`event: response.output_item.done\ndata: ${JSON.stringify({type: "response.output_item.done", output_index: 0, item})}\n\n`);
      response.end(`event: response.completed\ndata: ${JSON.stringify({type: "response.completed", response: { id: "fixture-response", status: "completed", output: [item], usage: {input_tokens: 10, output_tokens: 1, total_tokens: 11} }})}\n\n`);
    }
    function startTool() {
      const tools = JSON.parse(provider[0]!.body).tools as Array<{ name?: string }>;
      expect(tools.some(tool => tool.name === "exec_command")).toBe(true);
      const item = { id: "tool-fixture", type: "function_call", call_id: "tool-fixture", name: "exec_command",
        arguments: JSON.stringify({ cmd: "touch tool-running; while [ ! -e tool-release ]; do sleep 0.02; done", yield_time_ms: 10000 }) };
      const response = provider[0]!.response;
      response.write(`event: response.output_item.done\ndata: ${JSON.stringify({type: "response.output_item.done", output_index: 0, item})}\n\n`);
      response.end(`event: response.completed\ndata: ${JSON.stringify({type: "response.completed", response: {id: "fixture-response", status: "completed", output: [item]}})}\n\n`);
    }
    try {
      host = await CodexAppServerHost.start({cwd, binary, env, codexHome: env.CODEX_HOME, model: "fixture-model",
        sandbox: "danger-full-access", eventStore: new FileRuntimeEventStore(path.join(base, "events")), spawnProcess});
      const conversationId = "conversation_fixture";
      const publish = async () => {
        const health = await host!.health();
        journal.append({scope: `session:${conversationId}`, kind: "session-status", payload: { conversationId,
          sessionKey: { engine: "codex", sessionId: host!.identity.threadId }, hostKind: "codex-app-server", host: "hosted",
          turn: health.activeTurnRef ? "running" : "idle", activeTurnId: health.activeTurnRef,
          capabilities: {steer: true, nativeQueue: true, structuredAttention: true} }});
      };
      const queue = new StructuredDeliveryQueue({
        effects: async (kinds, after) => journal.effectBatch(100, kinds, after),
        status: async id => journal.operationResult(id)?.receipt ?? null,
        hostClaim: async () => "fixture-owner",
        transition: async (id, status, details) => { states.push({id, status, reason: details?.reason}); journal.transitionOperation(id, status, details); },
      }, () => host!);
      const admit = async (id: string) => {
        await publish();
        // The route validates client content, then attaches trusted authorship.
        const command = parseRuntimeCommand("send", { conversationId, operationId: id, idempotencyKey: id,
          text: id === "opening" ? "begin work" : "agent supplementary note", policy: "steer-or-queue" });
        if (command.kind !== "send") throw new Error("fixture expected a send");
        journal.executeOperation({ ...command,
          origin: {kind: "agent", conversationId: "conversation_sender", role: "builder"} });
        await queue.drain();
      };
      if (scenario !== "idle") { await admit("opening"); await until(() => provider.length === 1); }
      let originalTurn = (await host.health()).activeTurnRef;
      if (scenario === "busy-tool") {
        startTool();
        await until(() => fs.existsSync(path.join(cwd, "tool-running")));
      }
      if (scenario === "ended-before") { complete(0); await until(() => heldEnd !== null); }
      if (scenario === "compact") {
        // End the opening turn, then use the actual engine compact control.
        complete(0); await until(async () => !(await host!.health()).activeTurnRef);
        const compact = host.compact({ operationId: "compact-fixture", threadId: host.identity.threadId });
        await until(() => provider.length === 2);
        await until(async () => Boolean((await host!.health()).activeTurnRef));
        originalTurn = (await host.health()).activeTurnRef;
        await admit("supplement"); await queue.drain();
        expect(errors).toEqual(["cannot steer a compact turn"]);
        expect(requests.filter(r => r.method === "turn/steer")).toHaveLength(1);
        complete(1); await compact;
      } else {
        await admit("supplement");
      }
      if (scenario === "sampling" || scenario === "busy-tool") {
        expect(journal.operationResult("supplement")!.receipt.status).toBe("delivering");
        expect(requests.filter(r => r.method === "turn/start")).toHaveLength(1);
        expect(requests.filter(r => r.method === "turn/interrupt")).toHaveLength(0);
        if (scenario === "busy-tool") fs.writeFileSync(path.join(cwd, "tool-release"), "release");
        else complete(0);
        await until(() => provider.length === 2);
        expect(provider[1]!.body).toContain("agent supplementary note");
        expect((await host.health()).activeTurnRef).toBe(originalTurn);
      }
      if (scenario === "dropped-after") {
        expect(journal.operationResult("supplement")!.receipt.status).toBe("delivering");
        await publish();
        journal.executeOperation(parseRuntimeCommand("interrupt", { conversationId, operationId: "interrupt-fixture", idempotencyKey: "interrupt-fixture", turnId: originalTurn }));
        await queue.drain();
        await until(() => states.some(s => s.id === "supplement" && s.status === "queued" && s.reason === "steer-dropped"));
      }
      await until(async () => { await queue.drain(); return journal.operationResult("supplement")!.receipt.status === "delivered"; });
      const receipt = journal.operationResult("supplement")!.receipt;
      if (scenario === "sampling" || scenario === "busy-tool") expect(receipt.turnId).toBe(originalTurn);
      if (scenario === "ended-before") expect(states).toContainEqual({id: "supplement", status: "queued", reason: expect.stringMatching(/steer-refused: .*no active turn/)});
      const supplementRequests = requests.filter(r => r.params.clientUserMessageId === "supplement");
      expect(supplementRequests.filter(r => r.method === "turn/steer")).toHaveLength(scenario === "idle" ? 0 : 1);
      expect(supplementRequests.filter(r => r.method === "turn/start")).toHaveLength(scenario === "sampling" || scenario === "busy-tool" ? 0 : 1);
      expect(journal.nativeQueueRead(conversationId)).toEqual([]);
      // Replay the original admitted identity: terminal receipt, no second write.
      await admit("supplement");
      expect(requests.filter(r => r.params.clientUserMessageId === "supplement")).toHaveLength(supplementRequests.length);
      const events = new FileRuntimeEventStore(path.join(base, "events")).load(host.identity.threadId);
      const items = events.filter(e => e.kind === "item" && e.phase === "completed" && (e.item as {clientId?: string}).clientId === "supplement");
      expect(items).toHaveLength(1);
      const item = (items[0] as {item: {content: Array<{type: string; text: string}>}}).item;
      const decoded = decodeCodexStructuredUserText(item.content.find(p => p.type === "text")!.text);
      expect(decoded).toMatchObject({text: "agent supplementary note", origin: {kind: "agent", conversationId: "conversation_sender"}});
    } finally {
      fs.writeFileSync(path.join(cwd, "tool-release"), "release");
      if (host) await host.release();
      backend.closeAllConnections(); await new Promise<void>(resolve => backend.close(() => resolve()));
      journal.close(); fs.rmSync(base, {recursive: true, force: true});
    }
  }, 90_000);
}
