import { expect, test } from "bun:test";
import { callBody, callableReads, canonical, mayQuote } from "./toolLoop";
import { x1Bodies, x1Request, x1Results } from "./toolLoop.fixture";

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
