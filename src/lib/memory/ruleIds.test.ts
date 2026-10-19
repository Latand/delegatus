import { expect, test } from "bun:test";
import { closestReadableRuleIds } from "./ruleIds";

const id = "r_0123456789abcdef";

test("typo hints handle missing, extra, substituted and transposed digits without changing ids", () => {
  for (const input of [id.slice(0, -1), id + "0", "r_0123456789abcdee", "r_0123456789abcdfe", id.toUpperCase(), "r-0123456789abcdef", "r_0123456789abcde?", `[${id}]`]) {
    expect(closestReadableRuleIds(input, [id])).toEqual([id]);
  }
});

test("hints include only equally close readable candidates in deterministic bounded order", () => {
  const candidates = ["r_0123456789abcde4", "r_0123456789abcde1", "r_0123456789abcde3", "r_0123456789abcde2"];
  expect(closestReadableRuleIds("r_0123456789abcde", candidates)).toEqual([...candidates].sort().slice(0, 3));
  expect(closestReadableRuleIds(id.slice(0, -1), [id, id, "r_0123456789abcd00"])).toEqual([id]);
});

test("unrelated and unbounded input provides no hint", () => {
  for (const input of ["r_ffffffffffffffff", "r_0123", "x".repeat(100000), ""]) expect(closestReadableRuleIds(input, [id])).toEqual([]);
  expect(closestReadableRuleIds(id.slice(0, -1), [])).toEqual([]);
});
