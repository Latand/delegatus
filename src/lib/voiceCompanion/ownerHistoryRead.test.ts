import { expect, test } from "bun:test";
import { ownerHistoryRead } from "./ownerHistoryRead";
import { OWNER_HISTORY_PRIVACY, readOwnerHistory } from "@/lib/externalRelay/ownerHistory";
import { historyDouble } from "@/lib/externalRelay/ownerHistory.fixture";

test("voice drops null arguments and speaks counts without private data", async () => {
  let got: unknown;
  const answer = await ownerHistoryRead({ action: "groups", chat: null, from: null, to: null, cursor: null, limit: null }, async args => {
    got = args; return { available: true, groups: [{ chat: "-101", title: "Synthetic title sentinel" }], privacy: OWNER_HISTORY_PRIVACY };
  });
  expect(got).toEqual({ action: "groups" });
  expect(answer).toMatchObject({ status: "done", speech: "1 groups listed." });
  expect(answer.speech).not.toContain("sentinel");
});
test("voice refusal keeps only the plain outcome", async () => {
  expect(await ownerHistoryRead({ action: "groups" }, async () => ({ available: false, reason: "switch_off", note: "History is disabled.", retryAfterSeconds: null })))
    .toEqual({ status: "refused", code: "switch_off", reason: "History is disabled.", speech: "History is disabled.", retryAfterSeconds: null });
});

test("voice identifies a gateway timeout without inventing an outage or hidden chat", async () => {
  const double = await historyDouble();
  try {
    double.relay.id = "voice-timeout";
    double.state.forced = { status: 504, body: { error: { code: "timeout" } } };
    const ports = { switches: () => ({ owner_tools: true }), relays: () => [double.relay], timeZone: () => "Europe/Kyiv", now: () => Date.parse("2026-10-11T12:00:00Z") };
    const answer = await ownerHistoryRead({ action: "messages", chat: "-101" }, args => readOwnerHistory(args, ports));
    expect(answer).toMatchObject({ status: "refused", code: "gateway_timeout",
      speech: "The Celestia gateway timed out waiting for group history. HTTP 504." });
    expect(answer.speech).not.toMatch(/unavailable|hidden|unreachable/i);
  } finally { await double.close(); }
});
