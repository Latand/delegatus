import { expect, test } from "bun:test";
import { isNonblockingCodexQuestion } from "./codexAttention";

test("only an explicit false on a valid native question permits continued work", () => {
  const request = { threadId: "thread", turnId: "turn", questions: [{ id: "choice", question: "Continue?", options: null }] };
  expect(isNonblockingCodexQuestion("item/tool/requestUserInput", { ...request, isBlocking: false })).toBe(true);
  for (const isBlocking of [true, undefined, null, "false"]) {
    expect(isNonblockingCodexQuestion("item/tool/requestUserInput", { ...request, isBlocking })).toBe(false);
  }
  expect(isNonblockingCodexQuestion("item/commandExecution/requestApproval", { ...request, isBlocking: false })).toBe(false);
});
