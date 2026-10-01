import { describe, expect, test } from "bun:test";

import {
  contextTokenBand,
  contextTokensTitle,
  createContextLedger,
  estimateContextTokens,
  formatContextTokens,
  splitRound,
  sumContextTokens,
  type ContextTokens,
} from "./contextTokens";

const measured = (n: number): ContextTokens => ({ n, basis: "measured" });

describe("formatContextTokens", () => {
  test.each([
    [1, "1"],
    [352, "352"],
    [999, "999"],
    [1_000, "1k"],
    [1_049, "1k"],
    [1_100, "1.1k"],
    [9_808, "9.8k"],
    [9_999, "9.9k"],
    [10_000, "10k"],
    [12_449, "12.4k"],
    [16_451, "16.4k"],
    [99_999, "99.9k"],
    [100_000, "100k"],
    [123_456, "123k"],
    [999_999, "999k"],
    [1_000_000, "1M"],
    [1_234_567, "1.2M"],
  ])("%d reads %s", (n, label) => {
    expect(formatContextTokens(measured(n))).toBe(label);
  });

  test("shared and estimated values carry a ~ prefix, measured ones do not", () => {
    expect(formatContextTokens({ n: 12_449, basis: "shared" })).toBe("~12.4k");
    expect(formatContextTokens({ n: 352, basis: "estimate" })).toBe("~352");
    expect(formatContextTokens({ n: 352, basis: "measured" })).toBe("352");
  });
});

describe("contextTokenBand", () => {
  test.each([
    [1, 0],
    [999, 0],
    [1_000, 1],
    [9_999, 1],
    [10_000, 2],
    [19_999, 2],
    [20_000, 3],
    [1_500_000, 3],
  ])("%d is band %d", (n, band) => {
    expect(contextTokenBand(n)).toBe(band as 0 | 1 | 2 | 3);
  });

  test("a label never claims a higher band than the count", () => {
    for (const n of [999, 9_999, 19_999, 99_999]) {
      const label = formatContextTokens(measured(n));
      const shown = label.endsWith("k") ? Number(label.slice(0, -1)) * 1_000 : Number(label);
      expect(contextTokenBand(shown)).toBeLessThanOrEqual(contextTokenBand(n));
    }
  });
});

describe("splitRound", () => {
  test("reproduces the three parallel Claude calls of the brief (example 2)", () => {
    expect(splitRound(21_902, [6_411, 36_232, 5_593])).toEqual([2_911, 16_451, 2_540]);
  });

  test("reproduces the four parallel Codex calls of the brief (example 3)", () => {
    expect(splitRound(31_996, [5_710, 33_970, 15_584, 40_170])).toEqual([1_914, 11_389, 5_225, 13_468]);
  });

  test("shares add up to the total when nothing is floored", () => {
    const shares = splitRound(1_000, [1, 1, 1]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(1_000);
  });

  test("floors every share at 1 and splits evenly when no result has a size", () => {
    expect(splitRound(10, [1_000_000, 1, 1])).toEqual([10, 1, 1]);
    expect(splitRound(3, [0, 0, 0])).toEqual([1, 1, 1]);
    expect(splitRound(2, [1, 1_000_000])).toEqual([1, 2]);
  });
});

describe("estimateContextTokens", () => {
  test("divides characters by the engine's ratio", () => {
    expect(estimateContextTokens("claude", 26_024, 0)).toEqual({ n: 10_843, basis: "estimate" });
    expect(estimateContextTokens("codex", 3_600, 0)).toEqual({ n: 1_000, basis: "estimate" });
  });

  test("gives nothing for an empty result, a picture or an engine without a ratio", () => {
    expect(estimateContextTokens("claude", 0, 0)).toBeUndefined();
    expect(estimateContextTokens("claude", 5_000, 1)).toBeUndefined();
    expect(estimateContextTokens("openclaw", 5_000, 0)).toBeUndefined();
    expect(estimateContextTokens("copilot", 5_000, 0)).toBeUndefined();
  });

  test("never returns zero", () => {
    expect(estimateContextTokens("codex", 1, 0)?.n).toBe(1);
  });
});

describe("sumContextTokens", () => {
  test("adds the settled calls and skips the running one", () => {
    const sum = sumContextTokens([
      { status: "ok", contextTokens: measured(1_000) },
      { status: "err", contextTokens: measured(500) },
      { status: "run" },
    ]);
    expect(sum).toEqual({ n: 1_500, basis: "measured" });
  });

  test("any estimate, share or call without a number makes the sum approximate", () => {
    expect(sumContextTokens([{ status: "ok", contextTokens: measured(1_000) }, { status: "ok", contextTokens: { n: 5, basis: "estimate" } }])?.basis).toBe("estimate");
    expect(sumContextTokens([{ status: "ok", contextTokens: measured(1_000) }, { status: "ok", contextTokens: { n: 5, basis: "shared" } }])?.basis).toBe("estimate");
    expect(sumContextTokens([{ status: "ok", contextTokens: measured(1_000) }, { status: "ok" }])?.basis).toBe("estimate");
  });

  test("is undefined when no call has a number", () => {
    expect(sumContextTokens([{ status: "ok" }, { status: "run" }])).toBeUndefined();
    expect(sumContextTokens([])).toBeUndefined();
  });
});

describe("contextTokensTitle", () => {
  test("says what the number is, in both languages, with the basis worded apart", () => {
    expect(contextTokensTitle(measured(9_808), "call", "en")).toBe("9,808 tokens added to the context by this call");
    expect(contextTokensTitle(measured(1), "call", "en")).toBe("1 token added to the context by this call");
    expect(contextTokensTitle({ n: 352, basis: "estimate" }, "call", "en")).toContain("Approximately 352 tokens");
    expect(contextTokensTitle({ n: 16_451, basis: "shared", round: { total: 21_902, calls: 3 } }, "call", "en")).toBe(
      "Approximately 16,451 tokens added to the context by this call: its share, by result size, of 21,902 measured for 3 parallel calls",
    );
    expect(contextTokensTitle(measured(9_808), "calls", "en")).toBe("9,808 tokens added to the context by these calls");
    expect(contextTokensTitle({ n: 9_808, basis: "estimate" }, "calls", "en")).toBe("Approximately 9,808 tokens added to the context by these calls");
  });

  test("Ukrainian declines the count", () => {
    expect(contextTokensTitle(measured(1), "call", "uk")).toContain("1 токен");
    expect(contextTokensTitle(measured(2), "call", "uk")).toContain("2 токени");
    expect(contextTokensTitle(measured(5), "call", "uk")).toContain("5 токенів");
    expect(contextTokensTitle({ n: 22, basis: "estimate" }, "call", "uk")).toContain("приблизно 22 токени");
    expect(contextTokensTitle({ n: 352, basis: "estimate" }, "call", "uk")).toContain("приблизно 352 токени");
    expect(contextTokensTitle({ n: 11, basis: "estimate" }, "call", "uk")).toContain("приблизно 11 токенів");
  });
});

describe("createContextLedger", () => {
  function harness(engine: "claude" | "codex") {
    const applied = new Map<string, ContextTokens>();
    const ledger = createContextLedger(engine, (id, value) => applied.set(id, value));
    return { ledger, applied };
  }

  test("a clean one-call round is measured from the next response's prompt", () => {
    const { ledger, applied } = harness("claude");
    ledger.claudeResponse("r1", 50_485, 286);
    ledger.member("a");
    ledger.result("a", 26_024, 0);
    expect(applied.get("a")).toEqual({ n: 10_843, basis: "estimate" });
    ledger.claudeResponse("r2", 60_579, 10);
    expect(applied.get("a")).toEqual({ n: 9_808, basis: "measured" });
  });

  test("output_tokens repeats across the lines of one response and the maximum counts", () => {
    const { ledger, applied } = harness("claude");
    ledger.claudeResponse("r1", 1_000, 100);
    ledger.claudeResponse("r1", 1_000, 300);
    ledger.member("a");
    ledger.result("a", 10, 0);
    ledger.claudeResponse("r2", 2_000, 0);
    expect(applied.get("a")).toEqual({ n: 700, basis: "measured" });
  });

  test("contamination before the next response keeps the estimate", () => {
    const { ledger, applied } = harness("claude");
    ledger.claudeResponse("r1", 1_000, 100);
    ledger.member("a");
    ledger.result("a", 2_400, 0);
    ledger.contaminate();
    ledger.claudeResponse("r2", 9_000, 0);
    expect(applied.get("a")).toEqual({ n: 1_000, basis: "estimate" });
  });

  test("a member with no result makes the whole round fall back", () => {
    const { ledger, applied } = harness("claude");
    ledger.claudeResponse("r1", 1_000, 100);
    ledger.member("hidden");
    ledger.member("b");
    ledger.result("b", 2_400, 0);
    ledger.claudeResponse("r2", 9_000, 0);
    expect(applied.get("b")).toEqual({ n: 1_000, basis: "estimate" });
  });

  test("the first round after a partial reset is never measured", () => {
    const { ledger, applied } = harness("claude");
    ledger.reset(true);
    ledger.claudeResponse("r1", 1_000, 100);
    ledger.member("a");
    ledger.result("a", 2_400, 0);
    ledger.claudeResponse("r2", 9_000, 100);
    ledger.member("b");
    ledger.result("b", 2_400, 0);
    ledger.claudeResponse("r3", 19_000, 0);
    expect(applied.get("a")).toEqual({ n: 1_000, basis: "estimate" });
    expect(applied.get("b")).toEqual({ n: 9_900, basis: "measured" });
  });

  test("Codex: a repeated token_count is ignored and calls before it belong to it", () => {
    const { ledger, applied } = harness("codex");
    ledger.member("a");
    ledger.result("a", 3_600, 0);
    ledger.codexUsage(1_000, 50, 1_050);
    ledger.codexUsage(1_000, 50, 1_050);
    ledger.codexUsage(3_050, 10, 4_060);
    expect(applied.get("a")).toEqual({ n: 2_000, basis: "measured" });
  });

  test("Codex: contamination that lands before the late token_count travels with the group", () => {
    const { ledger, applied } = harness("codex");
    ledger.member("a");
    ledger.result("a", 3_600, 0);
    ledger.contaminate();
    ledger.codexUsage(1_000, 50, 1_050);
    ledger.codexUsage(3_050, 10, 4_060);
    expect(applied.get("a")?.basis).toBe("estimate");
  });

  test("a represented exec splits its value over the nested items it stands for", () => {
    const { ledger, applied } = harness("codex");
    ledger.member("outer");
    ledger.result("n1", 100, 0, true);
    ledger.result("n2", 300, 0, true);
    ledger.represent("outer", ["n1", "n2"]);
    ledger.result("outer", 36, 0);
    expect(applied.has("outer")).toBe(false);
    expect(applied.get("n1")?.basis).toBe("estimate");
    ledger.codexUsage(1_000, 0, 1);
    ledger.codexUsage(2_000, 0, 2);
    expect(applied.get("n1")).toEqual({ n: 250, basis: "shared", round: { total: 1_000, calls: 2 } });
    expect(applied.get("n2")).toEqual({ n: 750, basis: "shared", round: { total: 1_000, calls: 2 } });
  });

  test("a quiet result records its size and shows no estimate", () => {
    const { ledger, applied } = harness("codex");
    ledger.result("n1", 3_600, 0, true);
    expect(applied.size).toBe(0);
  });
});
