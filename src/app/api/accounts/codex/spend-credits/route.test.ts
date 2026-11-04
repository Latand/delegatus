import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { PATCH } from "./route";
import { closeAgentRegistryForTests } from "@/lib/agent/registry";
import { codexAccountSpendsCredits, createManagedCodexAccount } from "@/lib/accounts/codex";
import { setCallerConversationResolverForTests } from "@/lib/agent/operatorAuthority";
import { internalServiceHeaders } from "@/lib/agent/callerClaims";
import { OPERATOR_COOKIE, soloBrowserSession } from "@/lib/agent/operatorSession";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "credit-route-"));
const previous = { state: process.env.LLV_STATE_DIR, operator: process.env.DELEGATUS_OPERATOR_TOKEN };
process.env.LLV_STATE_DIR = path.join(root, "state");
// Composed fixture proof, held in-process and absent from published text.
const proof = ["operator", "fixture", "proof"].join("-");
process.env.DELEGATUS_OPERATOR_TOKEN = proof;
afterAll(() => {
  closeAgentRegistryForTests();
  setCallerConversationResolverForTests(null);
  if (previous.state === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous.state;
  if (previous.operator === undefined) delete process.env.DELEGATUS_OPERATOR_TOKEN; else process.env.DELEGATUS_OPERATOR_TOKEN = previous.operator;
  fs.rmSync(root, { recursive: true, force: true });
});
const request = (body: unknown, headers: Record<string, string> = {}) => new NextRequest("http://localhost/api/accounts/codex/spend-credits", {
  method: "PATCH", headers: { host: "localhost", "content-type": "application/json", ...headers }, body: JSON.stringify(body),
});

test("only a verified operator changes paid spending; agents and MCP cannot approve it", async () => {
  const account = createManagedCodexAccount("Credit route fixture");
  const body = { accountId: account.id, spendCredits: true };
  expect((await PATCH(request(body))).status).toBe(403);
  expect((await PATCH(request(body, { ...internalServiceHeaders("mcp") }))).status).toBe(403);
  setCallerConversationResolverForTests(() => "conversation_credit-fixture");
  expect((await PATCH(request(body, { "x-llv-operator-token": proof, "x-llv-spawn-capability": "a".repeat(43) }))).status).toBe(403);
  setCallerConversationResolverForTests(null);
  expect(codexAccountSpendsCredits(account.id)).toBe(false);
  expect((await PATCH(request(body, { "x-llv-operator-token": proof, origin: "https://elsewhere.invalid" }))).status).toBe(403);
  expect((await PATCH(request({ ...body, spendCredits: "true" }, { "x-llv-operator-token": proof }))).status).toBe(400);
  expect((await PATCH(request(body, { "x-llv-operator-token": proof }))).status).toBe(200);
  expect(codexAccountSpendsCredits(account.id)).toBe(true);
  expect((await PATCH(request({ accountId: "unknown", spendCredits: true }, { "x-llv-operator-token": proof }))).status).toBe(404);
  expect((await PATCH(request({ ...body, spendCredits: false }, { cookie: `${OPERATOR_COOKIE}=${soloBrowserSession()}` }))).status).toBe(200);
  expect(codexAccountSpendsCredits(account.id)).toBe(false);
});

test("operator proof revoked while the body is read cannot authorize the write", async () => {
  const account = createManagedCodexAccount("Revoked approval fixture");
  const req = request({ accountId: account.id, spendCredits: true }, { "x-llv-operator-token": proof });
  const json = req.json.bind(req);
  req.json = async () => {
    const body = await json();
    delete process.env.DELEGATUS_OPERATOR_TOKEN;
    return body;
  };
  try {
    expect((await PATCH(req)).status).toBe(403);
    expect(codexAccountSpendsCredits(account.id)).toBe(false);
  } finally { process.env.DELEGATUS_OPERATOR_TOKEN = proof; }
});
