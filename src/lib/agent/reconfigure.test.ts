import { describe, expect, test } from "bun:test";

import { reconfigurationFromBody } from "./reconfigure";

describe("reconfigurationFromBody", () => {
  test("accepts a known codex model with its extended effort scale and speed", () => {
    expect(reconfigurationFromBody("codex", { model: "gpt-5.6-sol", effort: "ultra", fast: true, accountId: "work" })).toEqual({
      value: { model: "gpt-5.6-sol", effort: "ultra", fast: true, accountId: "work" },
    });
  });

  test("accepts gpt-6-astra at ultra, the tier its account reports", () => {
    expect(reconfigurationFromBody("codex", { model: "gpt-6-astra", effort: "ultra", fast: false })).toEqual({
      value: { model: "gpt-6-astra", effort: "ultra", fast: false },
    });
    expect(reconfigurationFromBody("codex", { model: "gpt-6-astra", effort: "max", fast: false })).toEqual({
      value: { model: "gpt-6-astra", effort: "max", fast: false },
    });
  });

  test("rejects malformed account identifiers before any switch is queued", () => {
    expect(reconfigurationFromBody("codex", {
      model: "gpt-5.6-sol",
      effort: "high",
      fast: false,
      accountId: "../other-engine",
    }).error).toContain("account");
  });

  test("accepts claude family aliases and omits speed", () => {
    expect(reconfigurationFromBody("claude", { model: "sonnet", effort: "high" })).toEqual({
      value: { model: "sonnet", effort: "high", fast: null },
    });
  });

  test("keeps the pinned Sonnet 5.5 id so the pill can confirm the applied model", () => {
    expect(reconfigurationFromBody("claude", { model: "claude-sonnet-5-5", effort: "high" })).toEqual({
      value: { model: "claude-sonnet-5-5", effort: "high", fast: null },
    });
    expect(reconfigurationFromBody("claude", { model: "claude-sonnet-5", effort: "high" })).toEqual({
      value: { model: "sonnet", effort: "high", fast: null },
    });
  });

  test("rejects cross-engine and invalid combinations", () => {
    expect(reconfigurationFromBody("claude", { model: "gpt-5.6-sol", effort: "high" }).error).toContain("model");
    expect(reconfigurationFromBody("codex", { model: "gpt-5.6-terra", effort: "minimal", fast: false }).error).toContain("effort");
    expect(reconfigurationFromBody("claude", { model: "opus", effort: "max", fast: true }).error).toContain("speed");
  });
});
