import { expect, test } from "bun:test";
import { answeredElsewhereResponse } from "./targetOwnership";

test("ownership refusal accepts the proposed error and target field without trusting a different target or an unrelated error", () => {
  for (const body of [
    { error: "answered_elsewhere", target_id: "clone", message: "Release it there first" },
    { error: { code: "answered_elsewhere" }, target_id: "clone" },
    { target_id: "clone", answered_elsewhere: true },
    { target: { target_id: "clone", answered_elsewhere: true } },
  ]) expect(answeredElsewhereResponse(409, body, "clone")).toBe(true);
  for (const body of [null, [], "answered_elsewhere", { error: "unreachable" }, { message: "answered_elsewhere" },
    { answered_elsewhere: "true" }, { error: "answered_elsewhere", target_id: "other" },
    { target_id: "clone", target: { target_id: "other", answered_elsewhere: true } }]) {
    expect(answeredElsewhereResponse(409, body, "clone")).toBe(false);
  }
  for (const status of [200, 400, 401, 403, 429, 503]) expect(answeredElsewhereResponse(status, { error: "answered_elsewhere" }, "clone")).toBe(false);
});
