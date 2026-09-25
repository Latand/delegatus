import { expect, test } from "bun:test";

import { NoHealthyClaudeAccountError } from "@/lib/accounts/spawnHealth";

import { spawnAccountErrorResponse } from "./accountError";

test("the no-healthy-account path returns a retry-safe actionable 503", async () => {
  const response = spawnAccountErrorResponse(new NoHealthyClaudeAccountError(["account-b"]));

  expect(response?.status).toBe(503);
  expect(await response?.json()).toEqual({
    error: "No healthy Claude account is available. Re-login account-b in Accounts and retry.",
    retrySafe: true,
  });
});

/* #2170: the Accounts panel calls the legacy account «Main»; its id «default»
   is nothing the operator can find there. */
test("the message names each account by the label the Accounts panel shows", () => {
  const one = new NoHealthyClaudeAccountError([{ id: "default", label: "Main" }]);
  expect(one.message).toBe("No healthy Claude account is available. Re-login Main in Accounts and retry.");
  expect(one.accountIds).toEqual(["default"]);

  const two = new NoHealthyClaudeAccountError([{ id: "work", label: "Work" }, { id: "default", label: "Main" }]);
  expect(two.message).toBe("No healthy Claude account is available. Re-login Main or Work in Accounts and retry.");
  expect(two.message).not.toContain("default");
});
