import { afterAll, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { internalServiceHeaders } from "@/lib/agent/callerClaims";
import { setCallerConversationResolverForTests } from "@/lib/agent/operatorAuthority";
import { GET } from "./route";

const previous = process.env.DELEGATUS_OPERATOR_TOKEN;
const proof = ["operator", "state", "fixture"].join("-");
process.env.DELEGATUS_OPERATOR_TOKEN = proof;
afterAll(() => { if (previous === undefined) delete process.env.DELEGATUS_OPERATOR_TOKEN; else process.env.DELEGATUS_OPERATOR_TOKEN = previous; setCallerConversationResolverForTests(null); });
const operator = { "x-llv-operator-token": proof };
const read = (query = "", headers: Record<string, string> = {}) => GET(new NextRequest(`http://localhost/api/operator/agent-state${query}`, { headers: { host: "localhost", ...headers } }));
test("each projection mode refuses unauthenticated, service, capability and cross-origin callers", async () => {
  for (const query of ["", "?mode=series", "?mode=journal", `?subject=${"a".repeat(48)}`, "?refresh=1"]) {
    expect((await read(query)).status).toBe(403);
    expect((await read(query, { ...operator, ...internalServiceHeaders("mcp") })).status).toBe(403);
    expect((await read(query, { ...operator, origin: "https://foreign.invalid" })).status).toBe(403);
    expect((await read(query, { ...operator, "sec-fetch-site": "cross-site" })).status).toBe(403);
    setCallerConversationResolverForTests(() => "conversation_state-fixture");
    expect((await read(query, { ...operator, "x-llv-spawn-capability": "a".repeat(43) })).status).toBe(403);
    setCallerConversationResolverForTests(null);
  }
});
test("operator reads are bounded committed projections and never accept filesystem selectors", async () => {
  for (const query of ["?mode=other", "?subject=../native", "?path=native.jsonl", "?limit=1000", "?after=../file", "?refresh=true"]) expect((await read(query, operator)).status).toBe(400);
  for (const query of ["", "?mode=series", "?mode=journal"]) {
    const response = await read(query, operator);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
  const response = await read("", operator);
  expect(await response.json()).toMatchObject({ mode: "summary", metrics: { subjectsObserved: 0, lastCompleteReconciliationAt: null } });
  expect((await read(`?subject=${"a".repeat(48)}`, operator)).status).toBe(404);
});
