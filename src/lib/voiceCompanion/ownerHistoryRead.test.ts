import { expect, test } from "bun:test";
import { ownerHistoryRead } from "./ownerHistoryRead";
import { OWNER_HISTORY_PRIVACY } from "@/lib/externalRelay/ownerHistory";

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
