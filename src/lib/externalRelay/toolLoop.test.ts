import { expect, test } from "bun:test";
import { callBody, callableReads, callableTools, canonical, createToolLoop, mayQuote } from "./toolLoop";
import { x1Bodies, x1Errors, x1Request, x1Results } from "./toolLoop.fixture";
import { startTestRelay } from "./testRelay";
import type { PairedRelay } from "./store";

test("X1 role indexes admit exactly the direct reads for their audience", () => {
  for (const [role, count] of Object.entries({ member: 6, admin: 18, owner: 22, anonymous_admin: 18, admin_owner_member: 6, actions_admin: 18 }))
    expect(callableReads(x1Request(role))).toHaveLength(count);
});
test("canonical call identity survives argument ordering and a new lease", () => {
  const request = x1Request("member");
  const logical = { tool: "search_docs", arguments: { query: "meetup", nested: { z: 1, a: 2 } } };
  const body = callBody(request, logical);
  expect(body.call_id).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(callBody({ ...request, lease_id: "b".repeat(64) }, { tool: logical.tool, arguments: { nested: { a: 2, z: 1 }, query: "meetup" } }).call_id).toBe(body.call_id);
  expect(callBody({ ...request, request_id: "another" }, logical).call_id).not.toBe(body.call_id);
  expect(callBody(request, { cursor: "c".repeat(32) }).call_id).not.toBe(body.call_id);
  expect(Object.keys(body)).toEqual(Object.keys(x1Bodies.read));
  expect(Object.keys(callBody(request, { tool: "get_media", arguments: x1Bodies.references.arguments }))).toEqual(Object.keys(x1Bodies.references));
  expect(Object.keys(callBody(request, { cursor: "c".repeat(32) }))).toEqual(Object.keys(x1Bodies.page));
  expect(canonical(JSON.parse('{"__proto__":{"z":1,"a":2}}'))).toBe('{"__proto__":{"a":2,"z":1}}');
});
test("X1 audience gates pending, timeout and replay alike, including anonymous admin", () => {
  for (const role of ["member", "admin", "anonymous_admin", "owner"])
    for (const name of ["admin", "admin_pending", "admin_timeout", "owner", "owner_pending", "owner_timeout"]) {
      const requester = x1Request(role).input.requester;
      expect(mayQuote(x1Results[name]!.audience, requester)).toBe(name.startsWith("owner") ? role === "owner" : role !== "member");
    }
  expect(mayQuote(undefined, null)).toBe(true);
  expect(mayQuote("unknown", x1Request("owner").input.requester)).toBe(false);
});

for (const rejection of ["unauthorized", "unsupported_version"])
  for (const retry of ["pending", "unavailable", "rate_limited", "transport"])
    test(`${rejection} suppresses a sibling ${retry} retry without losing the lease`, async () => {
      const controller = new AbortController();
      let lost = false;
      let waiting!: () => void;
      const siblingWaiting = new Promise<void>((resolve) => { waiting = resolve; });
      const posts: ReturnType<typeof callBody>[] = [];
      const server = await startTestRelay(async (_req, body) => {
        const call = body as ReturnType<typeof callBody>;
        posts.push(call);
        if ("arguments" in call && call.arguments?.query === "reject") {
          await siblingWaiting;
          return x1Errors[rejection]!;
        }
        if (posts.filter((post) => post.call_id === call.call_id).length > 1)
          return { body: { ...x1Results.ok, call_id: call.call_id } };
        if (retry === "transport") return { drop: true };
        if (retry === "rate_limited") return x1Errors.rate_limited!;
        return { body: { ...x1Results[retry]!, tool: "search_docs", call_id: call.call_id } };
      });
      const loop = createToolLoop({ api_base: `${server.origin}/v1`, credential: "x".repeat(43) } as PairedRelay,
        x1Request("member"), { signal: controller.signal, ack: async () => true, lose: () => { lost = true; controller.abort(); } },
        { sleep: async () => {
          waiting();
          const deadline = Date.now() + 2000;
          while (loop.callsLeft() > 0 && Date.now() < deadline) await Bun.sleep(1);
          expect(loop.callsLeft()).toBe(0);
        } });
      try {
        await loop.runCalls(["reject", "sibling"].map((query) => ({ tool: "search_docs", arguments: JSON.stringify({ query }), cursor: null })), 1);
        expect(posts).toHaveLength(2);
        expect(loop.results.map((result) => result.code)).toEqual([rejection, rejection]);
        expect(loop.records.every((record) => record.local)).toBe(true);
        expect(lost).toBe(false);
        expect(controller.signal.aborted).toBe(false);
      } finally { await server.close(); }
    });


test("2b callable indexes require requester and the index audience", () => {
  for (const [role, count] of Object.entries({ member: 6, admin: 18, owner: 22, anonymous_admin: 18, admin_owner_member: 6, actions_admin: 57 }))
    expect(callableTools(x1Request(role))).toHaveLength(count);
  const request = x1Request("actions_admin");
  request.input.requester = x1Request("member").input.requester;
  expect(callableTools(request)).toHaveLength(12);
  request.input.requester = null;
  expect(callableTools(request).every((tool) => tool.effect === "read")).toBe(true);
  for (const role of ["admin", "anonymous_admin", "owner"]) {
    request.input.requester = x1Request(role).input.requester;
    request.input.tools = [{ name: "synthetic_owner_action", summary: "Synthetic action", mode: "direct", effect: "action", audience: "owner", parameters: { type: "object" } }];
    expect(callableTools(request)).toHaveLength(role === "owner" ? 1 : 0);
  }
});

async function actionLoopCase(handler: Parameters<typeof startTestRelay>[0], requester = x1Request("member").input.requester,
  runtime: Parameters<typeof createToolLoop>[3] = {}) {
  const request = x1Request("actions_admin"); request.input.requester = requester;
  const controller = new AbortController();
  const server = await startTestRelay(handler);
  const progress: string[] = [];
  const loop = createToolLoop({ api_base: `${server.origin}/v1`, credential: "x".repeat(43) } as PairedRelay, request,
    { signal: controller.signal, ack: async () => !controller.signal.aborted, lose: () => controller.abort() },
    { sleep: async () => {}, ...runtime }, (tool) => progress.push(tool));
  return { loop, controller, server, progress };
}
const actionCall = (tool = "react_to_message", args = {}) => ({ tool, arguments: JSON.stringify(args), cursor: null });

for (const replayed of [false, true])
  test(`exhausted action unavailable closes new calls even with replayed ${replayed}`, async () => {
    const posts: ReturnType<typeof callBody>[] = [];
    const { loop, server } = await actionLoopCase((_req, body) => {
      const call = body as ReturnType<typeof callBody>; posts.push(call);
      return { body: { ...x1Results.unavailable, call_id: call.call_id, tool: "react_to_message",
        effect: "action", replayed, calls_remaining: 15 } };
    });
    try {
      await loop.runCalls([actionCall()], 1);
      expect(loop.callsLeft()).toBe(0);
      expect(loop.sawUnknown).toBe(true);
      expect(loop.results[0]).toMatchObject({ status: "denied", code: "unavailable", execution_unknown: true });
      await loop.runCalls([actionCall("react_to_message", { emoji: "👍" })], 2);
      expect(posts).toHaveLength(3);
      expect(posts.every((post) => JSON.stringify(post) === JSON.stringify(posts[0]))).toBe(true);
      expect(loop.records[1]).toMatchObject({ local: true, code: "too_many_calls" });
    } finally { await server.close(); }
  });

test("unavailable action retries can recover the same identity without closing new calls", async () => {
  const posts: ReturnType<typeof callBody>[] = [];
  const { loop, server } = await actionLoopCase((_req, body) => {
    const call = body as ReturnType<typeof callBody>; posts.push(call);
    return { body: { ...(posts.length < 3 ? x1Results.unavailable : x1Results.action_ok),
      call_id: call.call_id, tool: "react_to_message", effect: "action" } };
  });
  try {
    await loop.runCalls([actionCall()], 1);
    expect(posts).toHaveLength(3);
    expect(posts.every((post) => JSON.stringify(post) === JSON.stringify(posts[0]))).toBe(true);
    expect(loop.callsLeft()).toBeGreaterThan(0);
    expect(loop.sawUnknown).toBe(false);
    expect(loop.results[0]).toMatchObject({ status: "ok" });
    expect(loop.results[0]).not.toHaveProperty("execution_unknown");
  } finally { await server.close(); }
});

test("unavailable reauthorization followed by a pre-admission refusal keeps action uncertainty", async () => {
  let posts = 0;
  const { loop, server } = await actionLoopCase((_req, body) => {
    const call = body as ReturnType<typeof callBody>;
    if (++posts > 1) return { status: 400 };
    return { body: { ...x1Results.unavailable, call_id: call.call_id, tool: "react_to_message", effect: "action", replayed: true } };
  });
  try {
    await loop.runCalls([actionCall()], 1);
    expect(posts).toBe(2);
    expect(loop.callsLeft()).toBe(0);
    expect(loop.sawUnknown).toBe(true);
    expect(loop.results[0]).toMatchObject({ status: "outcome_unknown" });
  } finally { await server.close(); }
});

for (const status of ["ok", "denied", "confirmation_pending", "outcome_unknown"] as const)
  test(`an action's withheld ${status} keeps status and removes every content field`, async () => {
    let posts = 0;
    const { loop, server } = await actionLoopCase((_req, body) => {
      const call = body as ReturnType<typeof callBody>; posts++;
      return { body: { ...x1Results.action_ok, call_id: call.call_id, status: posts === 1 ? "pending" : status,
        audience: "admin", output: "synthetic restricted output", summary: "synthetic restricted summary",
        expires_at: "2026-10-07T12:10:00Z", cursor: "c".repeat(32), retry_after_s: 1 } };
    });
    try {
      await loop.runCalls([actionCall()], 1);
      expect(posts).toBe(2);
      expect(loop.results[0]).toMatchObject({ status, output: "", effect: "action" });
      for (const key of ["summary", "expires_in_s", "next_cursor"]) expect(loop.results[0]).not.toHaveProperty(key);
      expect(loop.callsLeft()).toBe(0);
      expect(loop.records[0]).toMatchObject({ withheld: true, effect: "action", status });
    } finally { await server.close(); }
  });

test("an action over the cumulative output budget keeps status and code", async () => {
  const { loop, server } = await actionLoopCase((_req, body) => {
    const call = body as ReturnType<typeof callBody>;
    const action = "tool" in call && call.tool === "react_to_message";
    return { body: { ...x1Results.ok, call_id: call.call_id, tool: "tool" in call ? call.tool : "search_docs",
      output: action ? "y".repeat(2000) : "😀".repeat(16000), code: action ? "not_permitted" : undefined } };
  });
  try {
    await loop.runCalls([actionCall("search_docs", { query: "meetup" })], 1);
    await loop.runCalls([actionCall()], 2);
    expect(loop.results[1]).toMatchObject({ effect: "action", status: "ok", code: "not_permitted", output: "", truncated: true });
    expect(loop.callsLeft()).toBe(0);
  } finally { await server.close(); }
});

for (const block of ["lease", "unauthorized", "unsupported_version", "terminal", "budget"])
  test(`a round's ${block} read prevents the queued action`, async () => {
    const tools: string[] = [];
    const { loop, server, controller } = await actionLoopCase(async (_req, body) => {
      const call = body as ReturnType<typeof callBody>;
      tools.push("tool" in call ? call.tool! : "page");
      if (block === "lease") { controller.abort(); return x1Errors.lease_lost!; }
      if (block === "unauthorized" || block === "unsupported_version") return x1Errors[block]!;
      return { body: { ...x1Results.ok, call_id: call.call_id, calls_remaining: block === "budget" ? 0 : 15,
        delivered: block === "terminal" } };
    });
    try {
      const run = loop.runCalls([actionCall(), actionCall("search_docs", { query: "meetup" })], 1);
      if (block === "lease") await expect(run).rejects.toBeDefined(); else await run;
      expect(tools).toEqual(["search_docs"]);
      expect(loop.actionSent).toBe(false);
    } finally { await server.close(); }
  });

test("purge handoff and a service-degraded action never reach the wire", async () => {
  const request = x1Request("actions_admin");
  request.input.tools = request.input.tools!.map((tool) => tool.name === "request_group_setting_toggle"
    ? { name: tool.name, summary: tool.summary, mode: "handoff" as const } : tool);
  let posts = 0;
  const server = await startTestRelay(() => { posts++; return { body: {} }; });
  const loop = createToolLoop({ api_base: `${server.origin}/v1`, credential: "x".repeat(43) } as PairedRelay, request,
    { signal: new AbortController().signal, ack: async () => true, lose: () => {} });
  try {
    await loop.runCalls([actionCall("preview_purge"), actionCall("request_group_setting_toggle")], 1);
    expect(posts).toBe(0); expect(loop.actionSent).toBe(false);
    expect(loop.results.map((result) => result.code)).toEqual(["not_permitted", "not_permitted"]);
  } finally { await server.close(); }
});
