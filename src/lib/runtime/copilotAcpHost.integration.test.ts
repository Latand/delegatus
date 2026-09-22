import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import type { AccountContext } from "@/lib/accounts/contracts";
import { freshSpecFor } from "@/lib/agent/cli";
import { AgentRegistry } from "@/lib/agent/registry";
import { beginLegacySpawnFixture } from "@/lib/agent/registryTestFixtures";
import { describe as describeTranscript } from "@/lib/scanner/describe";
import { buildFeed, type Item } from "@/components/feed/parse";
import type { FileEntry } from "@/lib/types";
import { RuntimeJournal } from "@/runtime-host/journal";

import type { RuntimeHostClient } from "./client";
import { CopilotAcpHost } from "./copilotAcpHost";
import type { RuntimeEvent } from "./engineHost";
import { bindStructuredDeliveryQueue } from "./structuredDeliveryController";
import { kickStructuredDeliveryQueue } from "./structuredDeliverySignal";
import { enqueueStructuredMessage } from "./structuredMessageDelivery";
import { recoverDeadStructuredConversation } from "./structuredRecovery";
import { spawnStructuredConversation, startCopilotStructuredHost, type StructuredSpawnInput } from "./structuredSpawn";

/*
 * The scripted end-to-end run of docs/design/copilot-engine.md slice 1: the
 * real GitHub Copilot CLI over ACP, launched through the Viewer's own
 * structured-spawn path, against a loopback chat-completions stub in BYOK
 * mode. No GitHub login, no credential, no network beyond 127.0.0.1.
 *
 * Gated on LLV_COPILOT_BIN, the way the browser drivers are gated on
 * CHROME_BIN: `LLV_COPILOT_BIN=<scratch>/node_modules/.bin/copilot bun test
 * src/lib/runtime/copilotAcpHost.integration.test.ts`. Run it under an
 * isolated HOME, XDG_CONFIG_HOME and LLV_STATE_DIR (#1905).
 */

const BIN = process.env.LLV_COPILOT_BIN?.trim() ?? "";
const MODEL = "gpt-5.4";
const EFFORT = "xhigh";
const SLOW_MS = 15_000;

type ProviderRequest = { model: unknown; effort: unknown; tools: string[]; text: string; at: number };

/** Loopback chat-completions stub. The last user message chooses the
    behaviour: SLOW holds the answer, TOOL calls `bash`, anything else answers. */
function startProvider() {
  const requests: ProviderRequest[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const sse = (res: http.ServerResponse, delta: Record<string, unknown>, finish: string) => {
    if (res.writableEnded || res.destroyed) return;
    const chunk = (payload: Record<string, unknown>) => `data: ${JSON.stringify({ id: "stub", object: "chat.completion.chunk", created: 1, model: MODEL, ...payload })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(chunk({ choices: [{ index: 0, delta, finish_reason: null }] }));
    res.write(chunk({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    res.end("data: [DONE]\n\n");
  };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if ((req.url ?? "").includes("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: MODEL, object: "model" }] }));
        return;
      }
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* empty body */ }
      const messages = Array.isArray(body.messages) ? body.messages as Array<Record<string, unknown>> : [];
      const last = messages.at(-1);
      const lastUser = [...messages].reverse().find((message) => message.role === "user");
      const text = JSON.stringify(lastUser?.content ?? "");
      if (body.stream !== true) {
        /* The CLI's own title request. */
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "stub", object: "chat.completion", created: 1, model: MODEL, choices: [{ index: 0, message: { role: "assistant", content: "title" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
        return;
      }
      requests.push({
        model: body.model,
        effort: body.reasoning_effort,
        tools: (Array.isArray(body.tools) ? body.tools as Array<{ function?: { name?: string } }> : []).map((tool) => tool.function?.name ?? "").filter(Boolean),
        text,
        at: performance.now(),
      });
      const afterTool = last?.role === "tool";
      if (text.includes("SLOW") && !afterTool) {
        const timer = setTimeout(() => { timers.delete(timer); sse(res, { role: "assistant", content: "late answer" }, "stop"); }, SLOW_MS);
        timers.add(timer);
        return;
      }
      if (text.includes("TOOL") && !afterTool) {
        sse(res, { role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_stub_1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo stub-tool-output", description: "echo" }) } }] }, "tool_calls");
        return;
      }
      sse(res, { role: "assistant", content: afterTool ? "The tool ran." : "Hello from the stub." }, "stop");
    });
  });
  return {
    requests,
    listen: () => new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port))),
    close: () => {
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections?.();
      server.close();
    },
  };
}

/** A stdio MCP server standing in for the Viewer MCP: one tool, and a report of
    whether the spawn capability reached its env table. */
const MCP_STUB = `
const fs = require("node:fs");
fs.writeFileSync(process.env.STUB_REPORT, JSON.stringify({ capability: typeof process.env.LLV_SPAWN_CAPABILITY === "string" && process.env.LLV_SPAWN_CAPABILITY.length === 43 }));
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
    if (message.method === "initialize") reply({ protocolVersion: message.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "viewer-stub", version: "1" } });
    else if (message.method === "tools/list") reply({ tools: [{ name: "ping", description: "stub", inputSchema: { type: "object", properties: {} } }] });
    else if (message.method === "tools/call") reply({ content: [{ type: "text", text: "pong" }] });
    else if (message.id !== undefined) reply({});
  }
});
`;

function runtimeClient(journal: RuntimeJournal): RuntimeHostClient {
  return {
    readSession: async (identity) => journal.readSession(identity),
    snapshot: async () => journal.snapshot(),
    events: async (after) => journal.replay(after),
    waitEvents: async (after) => journal.replay(after),
    append: async (event) => journal.append(event),
    operation: async (event) => journal.append(event),
    command: async (command) => journal.executeOperation(command),
    operationStatus: async (operationId) => journal.operationResult(operationId),
    retryOperation: async (operationId) => journal.retryOperation(operationId),
    producerCursor: async (producerKind, eventKeyPrefix) => journal.producerCursor(producerKind, eventKeyPrefix),
    effectBatch: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
    transitionOperation: async (operationId, status, details) => journal.transitionOperation(operationId, status, details),
  } as RuntimeHostClient;
}

async function until<T>(read: () => T | Promise<T>, done: (value: T) => boolean, what: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

function transcriptRecords(file: string): Array<{ type: string; data: Record<string, unknown> }> {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as { type: string; data: Record<string, unknown> }]; } catch { return []; }
  });
}

describe.skipIf(!BIN)("Copilot CLI over ACP through the structured spawn path (BYOK stub)", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-copilot-e2e-"));
  const provider = startProvider();
  const hosts: CopilotAcpHost[] = [];
  afterAll(async () => {
    for (const host of hosts) await host.release().catch(() => {});
    await bindStructuredDeliveryQueue([]);
    provider.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  test("spawn, send, interrupt-and-resend, interrupt, resume, render and account isolation", async () => {
    const port = await provider.listen();
    const providerEnv = {
      COPILOT_PROVIDER_BASE_URL: `http://127.0.0.1:${port}/v1`,
      COPILOT_PROVIDER_TYPE: "openai",
      COPILOT_OFFLINE: "true",
    };
    const cwd = path.join(sandbox, "work");
    fs.mkdirSync(cwd, { recursive: true });
    const mcpStub = path.join(sandbox, "mcp-stub.cjs");
    fs.writeFileSync(mcpStub, MCP_STUB);
    const mcpReport = path.join(sandbox, "mcp-report.json");
    const viewerMcpServer = { command: process.execPath, args: [mcpStub], env: { STUB_REPORT: mcpReport } };

    const account = (id: string): AccountContext => {
      const home = path.join(sandbox, "accounts", id);
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      return { engine: "copilot", accountId: id, kind: "managed", home, transcriptRoot: path.join(home, "session-state"), env: { ...process.env, LLV_COPILOT_BIN: BIN } };
    };
    const accountA = account("copilot-a");
    const accountB = account("copilot-b");
    const registry = new AgentRegistry(path.join(sandbox, "registry.json"), undefined, undefined, { sqliteMode: "off" });
    const journal = new RuntimeJournal(path.join(sandbox, "runtime.sqlite"), { structuredHosts: true });
    const client = runtimeClient(journal);
    const started: CopilotAcpHost[] = [];
    const startHost = async (input: StructuredSpawnInput, capability: string) => {
      const host = await startCopilotStructuredHost(input, capability, { binary: BIN, providerEnv, viewerMcpServer });
      hosts.push(host);
      started.push(host);
      return host;
    };
    const spawn = async (engineAccount: AccountContext, text: string) => {
      const spec = freshSpecFor("copilot", cwd, { model: MODEL, effort: EFFORT, title: "Copilot slice one e2e", mcpServers: ["viewer"] });
      const begun = beginLegacySpawnFixture(registry, {
        engine: "copilot",
        cwd,
        transport: "structured",
        accountId: engineAccount.accountId,
        launchProfile: spec.launchProfile,
      });
      if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
      return await spawnStructuredConversation({
        engine: "copilot",
        receipt: begun.receipt,
        spec,
        account: engineAccount,
        "prompt": text,
        registry,
        client,
      }, { startHost });
    };
    const send = async (conversationId: string, artifactPath: string, text: string, mode: "queue" | "steer-if-active" | "interrupt-active" | "steer" = "interrupt-active") => {
      const operationId = `op-${crypto.randomUUID()}`;
      const shape = mode === "steer"
        ? { kind: "steer" as const, turnId: (await started.at(-1)!.health()).activeTurnRef }
        : { policy: mode };
      const admitted = await enqueueStructuredMessage({
        path: artifactPath, conversationId, clientMessageId: operationId, operationId, text, ...shape,
      }, { enabled: () => true, client: () => client, registry: () => registry, kick: kickStructuredDeliveryQueue });
      expect(admitted?.ok).toBe(true);
      return operationId;
    };
    const receipt = (operationId: string) => journal.operationResult(operationId)?.receipt;
    /* The delivery controller the Viewer runs, bound to this run's registry and
       journal; a dead host is resumed through the Viewer's own recovery. */
    const recover = (request: Parameters<typeof recoverDeadStructuredConversation>[0]) => recoverDeadStructuredConversation(request, {
      registry,
      client,
      transport: () => "structured",
      resolveAccount: () => accountA,
      spawn: (input) => spawnStructuredConversation(input, { startHost }),
      requestDeliveryDrain: () => kickStructuredDeliveryQueue(),
    });
    await bindStructuredDeliveryQueue([], { registry, client, recover });
    const settled = (operationId: string) => until(() => receipt(operationId), (value) => value?.status === "delivered" || value?.status === "failed" || value?.status === "uncertain", `receipt ${operationId}`);

    try {
      /* 1–3: spawn with cwd, model, effort and the Viewer MCP; first turn. */
      const spawned = await spawn(accountA, "hello PLAIN");
      expect(spawned).toMatchObject({ state: "settled" });
      const host = started[0]!;
      const artifactPath = host.identity.path;
      expect(artifactPath.startsWith(path.join(accountA.home, "session-state"))).toBe(true);
      const conversationId = registry.conversationForPath(artifactPath)!.id;
      await until(() => host.health(), (state) => state.status === "idle" && transcriptRecords(artifactPath).some((line) => line.type === "assistant.turn_end"), "the first turn");
      expect(provider.requests.length).toBeGreaterThan(0);
      for (const request of provider.requests) {
        expect(request.model).toBe(MODEL);
        expect(request.effort).toBe(EFFORT);
      }
      expect(provider.requests[0]!.tools.some((name) => name.startsWith("viewer-"))).toBe(true);
      expect(JSON.parse(fs.readFileSync(mcpReport, "utf8"))).toEqual({ capability: true });
      const start = transcriptRecords(artifactPath).find((line) => line.type === "session.start")!;
      expect((start.data.context as { cwd: string }).cwd).toBe(cwd);
      expect((await host.health()).protocolVersion).toMatch(/^\d+\.\d+\.\d+/);

      /* A tool turn: the stub asks for `bash`; bypass launches pass --allow-all. */
      const toolOp = await send(conversationId, artifactPath, "run TOOL please");
      expect(await settled(toolOp)).toMatchObject({ status: "delivered" });
      await until(() => host.health(), (state) => state.status === "idle", "the tool turn");
      expect(transcriptRecords(artifactPath).some((line) => line.type === "tool.execution_complete")).toBe(true);

      /* 4: interrupt-and-resend, 2.5 s into a 15 s turn, through every delivery
         mode the send path distinguishes: a steer, a steer-if-active send and
         the composer's default interrupt-active send. */
      const timings: Array<{ policy: string; cancelToReturnMs: number; cancelToResendDoneMs: number }> = [];
      const original = host.interrupt.bind(host);
      let interruptStartedAt = 0;
      let interruptReturnedAt = 0;
      host.interrupt = async (turnRef: string) => {
        interruptStartedAt = performance.now();
        await original(turnRef);
        interruptReturnedAt = performance.now();
      };
      for (const policy of ["steer", "steer-if-active", "interrupt-active"] as const) {
        const slowOp = await send(conversationId, artifactPath, `SLOW task for ${policy}`, "queue");
        expect(await settled(slowOp)).toMatchObject({ status: "delivered" });
        const slowTurn = receipt(slowOp)!.turnId!;
        await until(() => provider.requests.some((request) => request.text.includes(`SLOW task for ${policy}`)), Boolean, "the slow request");
        await Bun.sleep(2_500);
        expect((await host.health()).activeTurnRef).toBe(slowTurn);
        const events: Array<{ event: RuntimeEvent; at: number }> = [];
        const cursor = (await host.health()).eventCursor;
        const stream = host.attach(cursor)[Symbol.asyncIterator]();
        void (async () => {
          for (;;) {
            const next = await stream.next();
            if (next.done) return;
            events.push({ event: next.value, at: performance.now() });
          }
        })();
        const text = `new direction via ${policy}`;
        const resendOp = await send(conversationId, artifactPath, text, policy);
        const resent = await settled(resendOp);
        expect(resent).toMatchObject({ status: "delivered", delivery: "interrupt-then-turn-started", interruptedTurnId: slowTurn });
        expect(resent!.status).not.toBe("steered");
        const done = (await until(() => events.find(({ event }) => event.kind === "turn-ended" && event.turnId === resent!.turnId), Boolean, "the resent turn"))!;
        expect(events.find(({ event }) => event.kind === "turn-ended" && event.turnId === slowTurn)?.event).toMatchObject({ status: "interrupted" });
        expect(done.event).toMatchObject({ status: "completed" });
        void stream.return?.();
        timings.push({ policy, cancelToReturnMs: interruptReturnedAt - interruptStartedAt, cancelToResendDoneMs: done.at - interruptStartedAt });
        /* Nothing lost, nothing duplicated: each message reached the engine once. */
        const users = transcriptRecords(artifactPath).filter((line) => line.type === "user.message").map((line) => String(line.data.content));
        expect(users.filter((content) => content === text)).toHaveLength(1);
        expect(users.filter((content) => content === `SLOW task for ${policy}`)).toHaveLength(1);
        expect(provider.requests.filter((request) => request.text.includes(text))).toHaveLength(1);
        const types = transcriptRecords(artifactPath).map((line) => `${line.type}:${String(line.data.reason ?? line.data.content ?? "")}`);
        const abortAt = types.lastIndexOf("abort:user_initiated");
        expect(abortAt).toBeGreaterThan(types.indexOf(`user.message:SLOW task for ${policy}`));
        expect(types.indexOf(`user.message:${text}`)).toBeGreaterThan(abortAt);
      }
      console.info("[copilot e2e] interrupt-and-resend timings (ms)", JSON.stringify(timings));
      for (const timing of timings) {
        expect(timing.cancelToReturnMs).toBeLessThan(2_000);
        expect(timing.cancelToResendDoneMs).toBeLessThan(2_000);
      }
      host.interrupt = original;

      /* 5: interrupt alone ends the turn as interrupted. */
      const lonelyOp = await send(conversationId, artifactPath, "SLOW task to stop", "queue");
      expect(await settled(lonelyOp)).toMatchObject({ status: "delivered" });
      const lonelyTurn = receipt(lonelyOp)!.turnId!;
      await until(() => provider.requests.some((request) => request.text.includes("SLOW task to stop")), Boolean, "the slow request to stop");
      const interruptOp = `op-${crypto.randomUUID()}`;
      await client.command({ kind: "interrupt", operationId: interruptOp, idempotencyKey: interruptOp, conversationId, turnId: lonelyTurn });
      kickStructuredDeliveryQueue();
      expect(await until(() => receipt(interruptOp), (value) => value?.status === "interrupted" || value?.status === "failed", "the interrupt receipt")).toMatchObject({ status: "interrupted" });
      await until(() => host.health(), (state) => state.status === "idle", "idle after interrupt");

      /* 6: resume. The host is released, a new child adopts the same session
         id through the Viewer's recovery path, one more turn runs, and the
         stub sees the launch effort again. */
      await host.release();
      await until(() => registry.readOnlySnapshot().entries[`copilot:${host.identity.sessionId}`]?.status, (status) => status === "unhosted" || status === "dead", "the released row");
      const requestsBeforeResume = provider.requests.length;
      const recovered = await recover({ path: artifactPath, conversationId });
      expect(recovered).toMatchObject({ conversationId, path: artifactPath, spawned: true });
      const resumed = started.at(-1)!;
      expect(resumed).not.toBe(host);
      expect(resumed.identity.sessionId).toBe(host.identity.sessionId);
      const resumeOp = await send(conversationId, artifactPath, "after resume PLAIN");
      expect(await settled(resumeOp)).toMatchObject({ status: "delivered" });
      await until(() => resumed.health(), (state) => state.status === "idle", "the resumed turn");
      const afterResume = provider.requests.slice(requestsBeforeResume);
      expect(afterResume.length).toBeGreaterThan(0);
      for (const request of afterResume) expect(request.effort).toBe(EFFORT);
      const resumedTypes = transcriptRecords(artifactPath).map((line) => line.type);
      expect(resumedTypes).toContain("session.resume");
      expect(transcriptRecords(artifactPath).filter((line) => line.type === "user.message").at(-1)?.data.content).toBe("after resume PLAIN");

      /* 7: the transcript is scanned and rendered in the same run. */
      const root = path.join(accountA.home, "session-state");
      const described = describeTranscript("copilot-sessions", root, artifactPath, fs.statSync(artifactPath));
      expect(described).toMatchObject({ engine: "copilot", fmt: "copilot", kind: "session", cwd });
      const file = { path: artifactPath, engine: "copilot", fmt: "copilot", activity: "recent" } as FileEntry;
      const items = buildFeed(file, fs.readFileSync(artifactPath, "utf8").split("\n").filter(Boolean), false, "").items;
      const kinds = new Set(items.map((item: Item) => item.kind));
      expect(kinds.has("user")).toBe(true);
      expect(kinds.has("prose")).toBe(true);
      expect(kinds.has("note")).toBe(true);
      const tool = items.find((item): item is Extract<Item, { kind: "tool" }> => item.kind === "tool" && item.tool === "Bash");
      expect(tool?.status).toBe("ok");

      /* 8: account isolation. A second account's launch lands in its own home,
         and neither home holds the other's session. */
      await spawn(accountB, "hello from B PLAIN");
      const hostB = started.at(-1)!;
      await until(() => hostB.health(), (state) => state.status === "idle", "account B's turn");
      const sessionsIn = (home: string) => fs.readdirSync(path.join(home, "session-state"));
      expect(sessionsIn(accountA.home)).toEqual([host.identity.sessionId]);
      expect(sessionsIn(accountB.home)).toEqual([hostB.identity.sessionId]);
      expect(hostB.identity.sessionId).not.toBe(host.identity.sessionId);
      await hostB.release();
      await resumed.release();
      await bindStructuredDeliveryQueue([]);
    } finally {
      journal.close();
    }
  }, 180_000);
});
