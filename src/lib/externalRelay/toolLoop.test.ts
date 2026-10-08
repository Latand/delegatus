import { expect, test } from "bun:test";
import { callBody, callableReads, canonical, createToolLoop, mayQuote } from "./toolLoop";
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
