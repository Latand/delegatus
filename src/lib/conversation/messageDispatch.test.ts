import { expect, test } from "bun:test";
import { dispatchConversationMessage } from "./messageDispatch";

for (const result of [{ ok: true }, { ok: false }, { ok: false, operationId: "uncertain" }]) {
  test(`non-null structured result is terminal: ${JSON.stringify(result)}`, async () => {
    let legacyCalls = 0;
    const request = { text: "prepared" };
    expect(await dispatchConversationMessage(request, request, {
      structured: async value => { expect(value).toBe(request); return result; },
      legacy: async () => { legacyCalls++; return "legacy"; },
    })).toEqual({ transport: "structured", result });
    expect(legacyCalls).toBe(0);
  });
}

test("null selects legacy exactly once with its independently prepared request", async () => {
  let legacyCalls = 0;
  const legacyRequest = { text: " untrimmed " };
  expect(await dispatchConversationMessage({ text: "trimmed" }, legacyRequest, {
    structured: async () => null,
    legacy: async value => { expect(value).toBe(legacyRequest); legacyCalls++; return "sent"; },
  })).toEqual({ transport: "legacy", result: "sent" });
  expect(legacyCalls).toBe(1);
});

test("structured exception propagates without a legacy send", async () => {
  let legacyCalls = 0;
  const failure = new Error("uncertain dispatch");
  await expect(dispatchConversationMessage({}, {}, {
    structured: async () => { throw failure; },
    legacy: async () => { legacyCalls++; },
  })).rejects.toBe(failure);
  expect(legacyCalls).toBe(0);
});
