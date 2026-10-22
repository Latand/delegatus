import { afterEach, expect, test } from "bun:test";
import { kickTurbo } from "./turboRuntime";

const previousOwner = process.env.LLV_STATE_OWNER;
afterEach(() => {
  if (previousOwner === undefined) delete process.env.LLV_STATE_OWNER;
  else process.env.LLV_STATE_OWNER = previousOwner;
});

test("MCP-owned process without PORT cannot run the Viewer Turbo host sweep", async () => {
  process.env.LLV_STATE_OWNER = "mcp";
  delete process.env.PORT;
  await expect(kickTurbo("turbo-owner-fixture")).resolves.toBeUndefined();
});

test("the answer names the conversations of reasoned switch rows only when the registry knows them", async () => {
  process.env.LLV_STATE_OWNER = "tool";
  const { turboAnswer } = await import("./turboRuntime");
  const at = new Date().toISOString();
  const episode = { enabled: true, startedAt: at, until: new Date(Date.now() + 3_600_000).toISOString(), endedAt: null, endReason: null, updatedAt: at,
    setBy: { kind: "gateway" as const, conversationId: null, project: null, seatEpoch: null }, why: null, plan: [],
    credits: { approved: false, accounts: [], approvedAt: null, withdrawnAt: null, withdrawnBy: null, withdrawnWhy: null },
    switches: [{ conversationId: "conversation_unregistered", accountId: "acct-a", model: "gpt-6.1-sol", from: null, to: "ultrafast" as const, state: "failed" as const, reason: "refused", at }] };
  const answer = await turboAnswer("turbo-titles-fixture", { turbo: episode }, Date.now());
  expect(answer.titles).toEqual({});
});
