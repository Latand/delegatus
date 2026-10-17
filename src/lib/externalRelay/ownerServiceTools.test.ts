import { afterAll, expect, spyOn, test } from "bun:test";
import dns from "node:dns/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accountManager } from "@/lib/accounts/manager";
import { productionDomainDependencies, viewerMcpBindings } from "@/lib/mcp/bindings";
import { requestSchema } from "./protocol";
import { runClaimedRequest } from "./runner";
import { contextRequest } from "./request.fixture";
import { ownerRequest, x1Results, x1Dir } from "./toolLoop.fixture";
import { callBody } from "./toolLoop";
import { destinationRelay, destinationTarget } from "./ownerDestination.fixture";
import { updateRelayStore } from "./store";
import { readAnswerRecord } from "./answers";
import { startTestRelay } from "./testRelay";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "owner-tools-test-"));
const home = path.join(root, "account");
fs.mkdirSync(home); fs.writeFileSync(path.join(home, "auth.json"), "{}");
fs.writeFileSync(path.join(home, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-6-sol" }] }));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function binding(conversationId = "conversation_owner_tools", via?: { deputy: string }) {
  return viewerMcpBindings(undefined, { get: async () => ({}), post: async () => ({}) }, {
    ...productionDomainDependencies, callerAttribution: () => ({ kind: "agent", conversationId, role: null, ...(via ? { via } : {}) }),
  });
}

test.each(["inline", "on_demand"])("owner describes and calls reactions and polls through its request lease, records results and expires (%s)", async mode => {
  const posts: unknown[] = [], lookups: unknown[] = [], prompts: string[] = [];
  const lookupResults = JSON.parse(fs.readFileSync(path.join(x1Dir, "lookup_results.json"), "utf8"));
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/tool-calls")) {
      const call = body as { call_id: string; tool: string };
      if ("describe" in (body as object)) {
        lookups.push(body);
        return { body: { ...lookupResults[lookups.length === 1 ? "truncated" : "continuation"], call_id: call.call_id } };
      }
      posts.push(body);
      return { body: { ...x1Results.action_ok, call_id: call.call_id, tool: call.tool } };
    }
    return { body: { status: "ok" } };
  });
  const target = { ...destinationTarget("target_1", true), model: "gpt-6-sol", project: null };
  const relay = { ...destinationRelay([target]), api_base: `${server.origin}/v1` };
  const request = requestSchema.parse(contextRequest);
  request.request_id = `owner_tools_${mode}`; request.answer.max_chars = 4000;
  request.input.requester!.is_owner = true;
  request.input.tools = mode === "on_demand" ? JSON.parse(fs.readFileSync(path.join(x1Dir, "claimed_tools_on_demand_owner.json"), "utf8")).request.input.tools : ownerRequest().input.tools;
  request.input.tool_guidance = "Describe the target before the action.";
  updateRelayStore(s => ({ ...s, relays: [relay] }));
  const selected = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "available", account: {
    engine: "codex", accountId: "answer", kind: "managed", home, transcriptRoot: home, env: { ...process.env },
  } });
  const own = binding();
  const replies: string[] = [];
  let observedError: unknown;
  try {
    const result = await runClaimedRequest(relay, request, undefined, { command: "/missing-owner-cli", timeoutMs: 10000,
      ownerPorts: { launch: async body => { prompts.push(body.prompt as string); return { status: 202, body: { conversationId: "conversation_owner_tools" } }; },
        observe: async () => {
          try {
          if (mode === "on_demand") expect(await own.relay_service_tools({ op: "describe", names: ["get_media"] })).toMatchObject({ tools: [{ name: "get_media", parameters: expect.any(Object) }] });
          for (const tool of ["react_to_message", "create_poll"]) {
            const description = await own.relay_service_tools({ op: "describe", names: [tool] }) as { tools: { parameters: object }[] };
            expect(description.tools[0]!.parameters).toBeDefined();
            const called = await own.relay_service_tools({ op: "call", calls: [{ tool, arguments: {} }] }) as { results: { status: string; output: string }[] };
            expect(called.results[0]).toMatchObject({ status: "ok", output: x1Results.action_ok!.output });
            replies.push(`${tool}: ${called.results[0]!.status}`);
          }
          return { state: "ended", finalText: replies.join("; ") };
          } catch (error) { observedError = error; return { state: "ended", finalText: "Tool failed" }; }
        }, stop: async () => {}, pollMs: 1 },
    });
    if (observedError) throw observedError;
    expect(result).toMatchObject({ outcome: "answered", answer: { text: replies.join("; ") } });
    expect(posts).toEqual(["react_to_message", "create_poll"].map(tool => callBody(request, { tool, arguments: {} })));
    expect(readAnswerRecord(relay.id, target.id, request.request_id)!.toolCalls).toHaveLength(2);
    await expect(own.relay_service_tools({ op: "call", calls: [{ tool: "create_poll", arguments: {} }] })).rejects.toMatchObject({ details: { code: "relay_tools_unavailable" } });
    expect(posts).toHaveLength(2);
    expect(prompts[0]).not.toContain('"parameters"');
    expect(lookups.length).toBe(mode === "on_demand" ? 2 : 0);
    if (mode === "on_demand") {
      const bodies = JSON.parse(fs.readFileSync(path.join(x1Dir, "lookup_bodies.json"), "utf8"));
      expect(lookups.map(body => (body as { describe: string[] }).describe)).toEqual([bodies.truncated.describe, bodies.continuation.describe]);
    }
  } finally { selected.mockRestore(); await server.close(); }
});


async function withAdapter(id: string, handler: Parameters<typeof startTestRelay>[0],
  work: (ctx: { own: ReturnType<typeof binding>; request: ReturnType<typeof ownerRequest>; relay: ReturnType<typeof destinationRelay>;
    abort: AbortController; adapter: Awaited<ReturnType<typeof import("./ownerServiceTools")["openOwnerServiceTools"]>>;
    op: (args: unknown, wait?: number) => Promise<unknown> }) => Promise<void>, runtime: import("./toolLoop").ToolLoopRuntime = {}, ack = async () => true) {
  const { openOwnerServiceTools, relayServiceToolsOp } = await import("./ownerServiceTools");
  const { externalRelayFile } = await import("./store");
  const { procBackend } = await import("@/lib/proc");
  const { ownerRelayAuthorizedAsync } = await import("./ownerAuthority");
  const saved = ["runs", "relays"].map(kind => {
    const file = externalRelayFile(kind as "runs" | "relays");
    return { file, bytes: fs.existsSync(file) ? fs.readFileSync(file) : null };
  });
  const server = await startTestRelay(handler);
  const request = ownerRequest(id); request.input.tool_guidance = "Check the requested target before acting.";
  const relay = { ...destinationRelay([destinationTarget(request.target_id, true)]), api_base: `${server.origin}/v1` };
  const abort = new AbortController();
  updateRelayStore(store => ({ ...store, relays: [relay] }));
  fs.writeFileSync(externalRelayFile("runs"), JSON.stringify({ v: 1, runs: [{ requestId: id, relayId: relay.id, targetId: request.target_id,
    conversationId: "conversation_owner_tools", ownerPid: process.pid, ownerIdentity: procBackend.processIdentity(process.pid), ownerTurn: {} }] }));
  const adapter = openOwnerServiceTools(relay, relay.targets[0]!, request, [],
    { signal: abort.signal, ack, lose: () => abort.abort() }, runtime,
    () => ownerRelayAuthorizedAsync(relay.id, request.target_id, id));
  adapter.bindConversation("conversation_owner_tools");
  try { await work({ own: binding(), request, relay, abort, adapter, op: (args, wait) => relayServiceToolsOp("conversation_owner_tools", args, wait) }); }
  finally {
    await adapter.dispose(); await server.close();
    for (const { file, bytes } of saved) if (bytes) fs.writeFileSync(file, bytes); else fs.rmSync(file, { force: true });
  }
}
const args = (tool: string, value: Record<string, unknown> = {}) => ({ op: "call", calls: [{ tool, arguments: value }] });
const unavailable = { details: { code: "relay_tools_unavailable" } };
const okResult = (body: unknown, fixture = x1Results.action_ok!) => {
  const call = body as { tool: string; call_id: string };
  return { ...fixture, tool: call.tool, call_id: call.call_id };
};

test("discovery, describe-before-action, unknown and handoff tools never dispatch", async () => {
  let posts = 0;
  await withAdapter("discovery", () => { posts++; return { body: {} }; }, async ({ own }) => {
    const listed = await own.relay_service_tools({ op: "list", query: "poll" }) as { tools: { name: string; parameters?: object }[] };
    expect(listed.tools.some(tool => tool.name === "create_poll")).toBe(true);
    expect(listed.tools.every(tool => !tool.parameters)).toBe(true);
    expect(await own.relay_service_tools(args("create_poll"))).toMatchObject({ status: "describe_first" });
    const described = await own.relay_service_tools({ op: "describe", names: ["create_poll", "absent_tool"] }) as { tools: { parameters: object }[] };
    expect(described).toMatchObject({ missing: ["absent_tool"], guidance: [{ text: "Check the requested target before acting." }] });
    expect(described.tools[0]!.parameters).toBeDefined();
    for (const tool of ["absent_tool", "preview_purge"])
      expect(await own.relay_service_tools(args(tool))).toMatchObject({ results: [{ status: "denied", code: "not_permitted" }] });
    expect(posts).toBe(0);
  });
});

test("list, describe and call avoid synchronous authority file and process probes", async () => {
  const { procBackend } = await import("@/lib/proc");
  await withAdapter("async-authority", (_req, body) => ({ body: okResult(body, { ...x1Results.action_ok!, effect: "read" }) }), async ({ own }) => {
    const fileRead = spyOn(fs, "readFileSync");
    const identity = spyOn(procBackend, "processIdentity");
    try {
      await own.relay_service_tools({ op: "list", query: "media" });
      await own.relay_service_tools({ op: "describe", names: ["get_media"] });
      await own.relay_service_tools(args("get_media"));
      expect(fileRead.mock.calls.filter(([file]) => String(file).endsWith("/external-relay/runs.json") || String(file).endsWith("/external-relay/relays.json"))).toHaveLength(0);
      expect(identity).not.toHaveBeenCalled();
    } finally { fileRead.mockRestore(); identity.mockRestore(); }
  });
});

test.each(["initial", "retry"] as const)("pause during DNS resolution refuses the %s action send", async phase => {
  let posts = 0, lookupStarted!: () => void, release!: (addresses: Array<{ address: string; family: number }>) => void;
  let lookups = 0;
  const started = new Promise<void>(resolve => { lookupStarted = resolve; });
  const held = new Promise<Array<{ address: string; family: number }>>(resolve => { release = resolve; });
  const lookup = spyOn(dns, "lookup").mockImplementation((() => {
    lookups++;
    if (phase === "retry" && lookups === 1) return Promise.resolve([{ address: "127.0.0.1", family: 4 }]);
    lookupStarted(); return held;
  }) as unknown as typeof dns.lookup);
  try { await withAdapter(`pause-during-dns-${phase}`, (_req, body) => {
    posts++;
    return phase === "retry" && posts === 1 ? { status: 503, body: { error: { code: "temporary" } } } : { body: okResult(body) };
  }, async ({ own, relay }) => {
    const port = new URL(relay.api_base).port;
    relay.api_base = `http://relay-fixture.invalid:${port}/v1`;
    await own.relay_service_tools({ op: "describe", names: ["create_poll"] });
    const pending = own.relay_service_tools(args("create_poll"));
    await started;
    updateRelayStore(store => ({ ...store, relays: store.relays.map(row => ({ ...row, paused: true })) }));
    release([{ address: "127.0.0.1", family: 4 }]);
    expect(await pending).toMatchObject({ status: "relay_tools_unavailable" });
    expect(posts).toBe(phase === "retry" ? 1 : 0);
  }, phase === "retry" ? { sleep: async () => {} } : {}); } finally { lookup.mockRestore(); release([]); }
});

test("confirmation pending preserves summary and expiry, stops further calls locally", async () => {
  let posts = 0;
  await withAdapter("confirmation", (_req, body) => { posts++; return { body: okResult(body, { ...x1Results.action_ok!,
    status: "confirmation_pending", output: "", summary: "Confirm the requested change", expires_at: "2026-10-17T12:01:00Z" }) }; }, async ({ own }) => {
    await own.relay_service_tools({ op: "describe", names: ["request_kick_participant"] });
    expect(await own.relay_service_tools(args("request_kick_participant"))).toMatchObject({ callsLeft: 0,
      results: [{ status: "confirmation_pending", summary: "Confirm the requested change", expires_in_s: 60, note: expect.stringContaining("has not run") }] });
    expect(await own.relay_service_tools(args("get_media"))).toMatchObject({ results: [{ code: "too_many_calls" }] });
    expect(posts).toBe(1);
  }, { now: () => Date.parse("2026-10-17T12:00:00Z") });
});

test("other conversations, deputies and absent callers cannot borrow the owner's adapter", async () => {
  let posts = 0;
  await withAdapter("callers", (_req, body) => { posts++; return { body: okResult(body, { ...x1Results.action_ok!, effect: "read" }) }; }, async ({ own }) => {
    for (const other of [binding("conversation_other"), binding(""), binding("conversation_owner_tools", { deputy: "conversation_deputy" })])
      await expect(other.relay_service_tools({ op: "list" })).rejects.toMatchObject(unavailable);
    expect(posts).toBe(0);
    expect(await own.relay_service_tools(args("get_media"))).toMatchObject({ results: [{ status: "ok" }] });
    expect(posts).toBe(1);
  });
});

for (const kind of ["lease_lost", "revoked", "closed"] as const) test(`tools refuse after ${kind} without another POST`, async () => {
  let posts = 0;
  await withAdapter(kind, () => { posts++; return { status: 409, body: { error: { code: "lease_lost" } } }; }, async ({ own, adapter }) => {
    if (kind === "closed") await adapter.close();
    else if (kind === "revoked") updateRelayStore(store => ({ ...store, relays: store.relays.map(relay => ({ ...relay, targets: relay.targets.map(target => ({ ...target, ownerTier: false })) })) }));
    else expect(await own.relay_service_tools(args("get_media"))).toMatchObject({ status: "relay_tools_unavailable" });
    await expect(own.relay_service_tools(args("get_media"))).rejects.toMatchObject(unavailable);
    expect(posts).toBe(kind === "lease_lost" ? 1 : 0);
  });
});

test("pending batch survives MCP waits, excludes other batches and replays a single identity", async () => {
  let posts = 0, notify!: () => void, release!: () => void;
  const sleeping = new Promise<void>(resolve => { notify = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const bodies: { call_id: string }[] = [];
  await withAdapter("pending", (_req, body) => {
    bodies.push(body as { call_id: string });
    return { body: okResult(body, { ...x1Results.action_ok!, effect: "read", status: ++posts === 1 ? "pending" : "ok", retry_after_s: 1 }) };
  }, async ({ op }) => {
    const call = args("get_media");
    const first = op(call, 0);
    await sleeping;
    expect(await first).toMatchObject({ status: "in_progress" });
    expect(await op(args("get_media", { other: true }), 0)).toMatchObject({ status: "busy" });
    release();
    const settled = await op(call);
    expect(settled).toMatchObject({ results: [{ status: "ok" }] });
    expect(await op(call)).toEqual(settled);
    expect(posts).toBe(2); expect(new Set(bodies.map(body => body.call_id)).size).toBe(1);
  }, { sleep: async () => { notify(); await held; } });
});

test("request rounds are shared across batches and retries do not replenish them", async () => {
  let posts = 0;
  await withAdapter("rounds", (_req, body) => { posts++; return { body: okResult(body, { ...x1Results.action_ok!, effect: "read" }) }; }, async ({ op }) => {
    for (let i = 0; i < 7; i++) {
      const call = args("get_media", { page: i });
      const result = await op(call); expect(result).toMatchObject({ results: [{ status: "ok" }] });
      expect(await op(call)).toEqual(result);
    }
    expect(await op(args("get_media", { page: 8 }))).toMatchObject({ status: "too_many_calls" });
    expect(posts).toBe(7);
  });
});


test("a fresh Viewer process refuses a live ledger row without a request adapter", async () => {
  let posts = 0;
  await withAdapter("restart", () => { posts++; return { body: {} }; }, async ({ own }) => {
    expect(await own.relay_service_tools({ op: "list" })).toHaveProperty("tools");
    const child = Bun.spawn([process.execPath, "-e", `const { relayServiceToolsOp } = await import("./src/lib/externalRelay/ownerServiceTools.ts"); process.stdout.write(JSON.stringify(await relayServiceToolsOp("conversation_owner_tools", { op: "list" })));`],
      { cwd: process.cwd(), env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, errors }).toEqual({ code: 0, errors: "" });
    expect(output).toBe("null"); expect(posts).toBe(0);
  });
});

test("mixed repeated and new calls report every requested result without another effect", async () => {
  let posts = 0;
  await withAdapter("mixed_replay", (_req, body) => { posts++; return { body: okResult(body, { ...x1Results.action_ok!, effect: "read" }) }; }, async ({ op }) => {
    await op(args("get_media", { page: 1 }));
    expect(await op({ op: "call", calls: [
      { tool: "get_media", arguments: { page: 1 } }, { tool: "get_media", arguments: { page: 2 } },
    ] })).toMatchObject({ results: [{ tool: "get_media", status: "ok" }, { tool: "get_media", status: "repeated" }] });
    expect(posts).toBe(2);
  });
});


test("owner revocation while a pending batch sleeps prevents its retry", async () => {
  let posts = 0, notify!: () => void, release!: () => void;
  const sleeping = new Promise<void>(resolve => { notify = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  await withAdapter("revoked_pending", (_req, body) => { posts++; return { body: okResult(body, { ...x1Results.action_ok!, effect: "read", status: posts === 1 ? "pending" : "ok", retry_after_s: 1 }) }; }, async ({ own, op }) => {
    const pending = op(args("get_media"));
    await sleeping;
    updateRelayStore(store => ({ ...store, relays: store.relays.map(relay => ({ ...relay, paused: true })) }));
    release();
    expect(await pending).toMatchObject({ status: "relay_tools_unavailable" });
    await expect(own.relay_service_tools({ op: "list" })).rejects.toMatchObject(unavailable);
    expect(posts).toBe(1);
  }, { sleep: async () => { notify(); await held; } });
});


test("authorization is rechecked after the asynchronous heartbeat acknowledgement", async () => {
  let posts = 0, notify!: () => void, release!: () => void;
  const acknowledging = new Promise<void>(resolve => { notify = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  await withAdapter("revoked_ack", () => { posts++; return { body: {} }; }, async ({ op }) => {
    const pending = op(args("get_media"));
    await acknowledging;
    updateRelayStore(store => ({ ...store, relays: store.relays.map(relay => ({ ...relay, paused: true })) }));
    release();
    expect(await pending).toMatchObject({ status: "relay_tools_unavailable" }); expect(posts).toBe(0);
  }, {}, async () => { notify(); await held; return true; });
});


test("terminal call limits preserve the loop's denial even for earlier logical calls", async () => {
  let posts = 0;
  await withAdapter("terminal_repeat", (_req, body) => {
    posts++;
    return { body: okResult(body, { ...x1Results.action_ok!, effect: "read", calls_remaining: 0 }) };
  }, async ({ op }) => {
    await op(args("get_media", { page: 1 }));
    expect(await op({ op: "call", calls: [{ tool: "get_media", arguments: { page: 1 } }, { tool: "get_media", arguments: { page: 2 } }] }))
      .toMatchObject({ results: [{ status: "denied", code: "too_many_calls" }, { status: "denied", code: "too_many_calls" }] });
    expect(posts).toBe(1);
  });
});
