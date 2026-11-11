import { expect, test } from "bun:test";
import { AccountMutationBusyError } from "./accountMutation";
import { withRemovalContentionRetry } from "./removalRetry";

test("account removal retries only a refused admission or a fully restored removal", async () => {
  let attempts = 0;
  const result = await withRemovalContentionRetry(() => {
    if (++attempts === 1) throw new AccountMutationBusyError();
    if (attempts === 2) throw new Error("the agent registry is busy; nothing was removed, try the removal again");
    return "removed";
  });
  expect(result).toBe("removed");
  expect(attempts).toBe(3);
});

test("account removal never retries an uncertain commit", async () => {
  let attempts = 0;
  const failure = new Error("the accounts commit failed and the agent registry is busy; the journaled retirement awaits recovery");
  await expect(withRemovalContentionRetry(() => { attempts++; throw failure; })).rejects.toBe(failure);
  expect(attempts).toBe(1);
});

test("account removal bounds repeated admission refusal", async () => {
  let attempts = 0;
  await expect(withRemovalContentionRetry(() => { attempts++; throw new AccountMutationBusyError(); })).rejects.toBeInstanceOf(AccountMutationBusyError);
  expect(attempts).toBe(4);
});
