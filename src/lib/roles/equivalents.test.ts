import { expect, test } from "bun:test";

import { equivalentConfig, equivalentModel } from "./equivalents";

test("moving a role between engines picks the equivalent model and keeps or clamps the effort", () => {
  expect(equivalentConfig({ engine: "codex", model: "gpt-6-astra", effort: "xhigh" }, "claude")).toEqual({ engine: "claude", model: "opus", effort: "xhigh" });
  expect(equivalentConfig({ engine: "codex", model: "gpt-5.6-terra", effort: "ultra" }, "claude")).toEqual({ engine: "claude", model: "sonnet", effort: "max" });
  expect(equivalentConfig({ engine: "codex", model: "gpt-5.6-luna", effort: "low" }, "claude")).toEqual({ engine: "claude", model: "haiku", effort: "low" });
  expect(equivalentConfig({ engine: "claude", model: "fable", effort: "max" }, "codex")).toEqual({ engine: "codex", model: "gpt-6-astra", effort: "max" });
  expect(equivalentConfig({ engine: "claude", model: "haiku", effort: "max" }, "codex")).toEqual({ engine: "codex", model: "gpt-6-luna", effort: "max" });
  const same = { engine: "claude" as const, model: "opus", effort: "high" };
  expect(equivalentConfig(same, "claude")).toBe(same);
});

test("the GPT-6 models have Claude equivalents, and Sonnet no longer lands on a Terra the GPT-6 line lacks", () => {
  expect(equivalentModel("gpt-6-sol", "claude")).toBe("opus");
  expect(equivalentModel("gpt-6-astra", "claude")).toBe("opus");
  expect(equivalentModel("gpt-6-luna", "claude")).toBe("sonnet");
  expect(equivalentModel("sonnet", "codex")).toBe("gpt-6-sol");
  expect(equivalentModel("opus", "codex")).toBe("gpt-6-astra");
  expect(equivalentModel("haiku", "codex")).toBe("gpt-6-luna");
});

/* The live mapping of 2026-09-25 with the two approved changes applied, and the
   table the operator approved for the hours one vendor is out of quota. */
test("with Codex out, every mapping row lands on its approved Claude runtime", () => {
  const rows = [
    [{ roleId: "reviewer" }, { engine: "codex", model: "gpt-6-astra", effort: "medium" }, { engine: "claude", model: "opus", effort: "high" }],
    [{ roleId: "verifier" }, { engine: "codex", model: "gpt-6-astra", effort: "high" }, { engine: "claude", model: "opus", effort: "high" }],
    [{ roleId: "builder" }, { engine: "codex", model: "gpt-6-sol", effort: "high" }, { engine: "claude", model: "opus", effort: "high" }],
    [{ roleId: "builder", variant: "apply-fixes" }, { engine: "codex", model: "gpt-6-luna", effort: "high" }, { engine: "claude", model: "opus", effort: "medium" }],
    [{ roleId: "cleaner" }, { engine: "codex", model: "gpt-6-luna", effort: "medium" }, { engine: "claude", model: "sonnet", effort: "high" }],
    [{ roleId: "prod-auditor" }, { engine: "codex", model: "gpt-6-astra", effort: "high" }, { engine: "claude", model: "opus", effort: "high" }],
    [{ roleId: "deployer" }, { engine: "codex", model: "gpt-6-sol", effort: "medium" }, { engine: "claude", model: "opus", effort: "high" }],
  ] as const;
  for (const [row, from, to] of rows) expect({ row, config: equivalentConfig(from, "claude", row) }).toEqual({ row, config: to });
});

test("with Claude out, the orchestrator, the architect and the frontend builder land on their approved Codex runtime", () => {
  const opusHigh = { engine: "claude" as const, model: "opus", effort: "high" };
  expect(equivalentConfig(opusHigh, "codex", { roleId: "orchestrator" })).toEqual({ engine: "codex", model: "gpt-6-astra", effort: "medium" });
  expect(equivalentConfig(opusHigh, "codex", { roleId: "architect" })).toEqual({ engine: "codex", model: "gpt-6-astra", effort: "high" });
  expect(equivalentConfig({ ...opusHigh, effort: "xhigh" }, "codex", { roleId: "builder", variant: "frontend" })).toEqual({ engine: "codex", model: "gpt-6-astra", effort: "high" });
  /* A row with no approved target keeps the model-to-model mapping. */
  expect(equivalentConfig({ engine: "claude", model: "sonnet", effort: "xhigh" }, "codex", { roleId: "reviewer" })).toEqual({ engine: "codex", model: "gpt-6-sol", effort: "xhigh" });
});
