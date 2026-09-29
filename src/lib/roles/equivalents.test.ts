import { expect, test } from "bun:test";

import { equivalentConfig, equivalentModel } from "./equivalents";
import type { RoleConfig } from "./types";

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
  expect(equivalentModel("claude-sonnet-5-5", "codex")).toBe("gpt-6-sol");
  expect(equivalentModel("opus", "codex")).toBe("gpt-6-astra");
  expect(equivalentModel("haiku", "codex")).toBe("gpt-6-luna");
});

/* The Sonnet 5.5 / Opus 5.5 table (docs/design/model-sizing-tiers.md §7): with
   Codex out, Sonnet 5.5 runs the well-scoped rows and Opus the judgment rows. */
test("with Codex out, every mapping row lands on its Sonnet 5.5 or Opus runtime", () => {
  const sonnet = (effort: string): RoleConfig => ({ engine: "claude", model: "claude-sonnet-5-5", effort });
  const opus: RoleConfig = { engine: "claude", model: "opus", effort: "high" };
  const rows = [
    [{ roleId: "orchestrator" }, { engine: "codex", model: "gpt-6-astra", effort: "medium" }, opus],
    [{ roleId: "architect" }, { engine: "codex", model: "gpt-6-astra", effort: "high" }, opus],
    [{ roleId: "reviewer" }, { engine: "codex", model: "gpt-6-astra", effort: "medium" }, opus],
    [{ roleId: "reviewer", variant: "trivial" }, { engine: "codex", model: "gpt-6-luna", effort: "high" }, sonnet("medium")],
    [{ roleId: "verifier" }, { engine: "codex", model: "gpt-6-astra", effort: "high" }, sonnet("medium")],
    [{ roleId: "builder" }, { engine: "codex", model: "gpt-6-sol", effort: "high" }, sonnet("high")],
    [{ roleId: "builder", variant: "apply-fixes" }, { engine: "codex", model: "gpt-6-luna", effort: "high" }, sonnet("high")],
    [{ roleId: "builder", variant: "frontend" }, { engine: "codex", model: "gpt-6-astra", effort: "high" }, sonnet("high")],
    [{ roleId: "builder", variant: "docs" }, { engine: "codex", model: "gpt-6-astra", effort: "medium" }, sonnet("high")],
    [{ roleId: "builder", variant: "trivial" }, { engine: "codex", model: "gpt-6-luna", effort: "high" }, sonnet("high")],
    [{ roleId: "builder", variant: "frontend-fixes" }, { engine: "codex", model: "gpt-6-sol", effort: "high" }, sonnet("high")],
    [{ roleId: "builder", variant: "docs-fixes" }, { engine: "codex", model: "gpt-6-sol", effort: "high" }, sonnet("high")],
    [{ roleId: "cleaner" }, { engine: "codex", model: "gpt-6-luna", effort: "medium" }, sonnet("high")],
    [{ roleId: "prod-auditor" }, { engine: "codex", model: "gpt-6-astra", effort: "high" }, opus],
    [{ roleId: "deployer" }, { engine: "codex", model: "gpt-6-sol", effort: "medium" }, opus],
  ] as const;
  for (const [row, from, to] of rows) expect({ row, config: equivalentConfig(from, "claude", row) }).toEqual({ row, config: to });
});

test("with Claude out, the orchestrator, the architect and the frontend builder land on their approved Codex runtime", () => {
  const opusHigh = { engine: "claude" as const, model: "opus", effort: "high" };
  expect(equivalentConfig(opusHigh, "codex", { roleId: "orchestrator" })).toEqual({ engine: "codex", model: "gpt-6-astra", effort: "medium" });
  expect(equivalentConfig(opusHigh, "codex", { roleId: "architect" })).toEqual({ engine: "codex", model: "gpt-6-astra", effort: "high" });
  expect(equivalentConfig({ ...opusHigh, effort: "xhigh" }, "codex", { roleId: "builder", variant: "frontend" })).toEqual({ engine: "codex", model: "gpt-6-astra", effort: "high" });
  /* A row with no approved target keeps the model-to-model mapping, the pinned Sonnet 5.5 included. */
  expect(equivalentConfig({ engine: "claude", model: "sonnet", effort: "xhigh" }, "codex", { roleId: "reviewer" })).toEqual({ engine: "codex", model: "gpt-6-sol", effort: "xhigh" });
  expect(equivalentConfig({ engine: "claude", model: "claude-sonnet-5-5", effort: "medium" }, "codex", { roleId: "verifier" })).toEqual({ engine: "codex", model: "gpt-6-sol", effort: "medium" });
});

/* docs/design/model-sizing-tiers.md §6: the small-change and docs rows, and no
   row Sonnet may not run lands on it when it moves engine. */
test("the small-change and docs rows have approved targets, and no denied row lands on Sonnet", () => {
  const sonnetHigh: RoleConfig = { engine: "claude", model: "claude-sonnet-5-5", effort: "high" };
  expect(equivalentConfig({ engine: "codex", model: "gpt-6-luna", effort: "high" }, "claude", { roleId: "reviewer", variant: "trivial" })).toEqual({ ...sonnetHigh, effort: "medium" });
  expect(equivalentConfig({ engine: "claude", model: "claude-sonnet-5-5", effort: "medium" }, "codex", { roleId: "reviewer", variant: "trivial" })).toEqual({ engine: "codex", model: "gpt-6-luna", effort: "high" });
  expect(equivalentConfig({ engine: "claude", model: "claude-sonnet-5-5", effort: "high" }, "codex", { roleId: "builder", variant: "trivial" })).toEqual({ engine: "codex", model: "gpt-6-luna", effort: "high" });
  expect(equivalentConfig({ engine: "codex", model: "gpt-6-luna", effort: "high" }, "claude", { roleId: "builder", variant: "trivial" })).toEqual(sonnetHigh);
  expect(equivalentConfig({ engine: "claude", model: "claude-sonnet-5-5", effort: "high" }, "codex", { roleId: "builder", variant: "docs" })).toEqual({ engine: "codex", model: "gpt-6-astra", effort: "medium" });
  expect(equivalentConfig({ engine: "codex", model: "gpt-6-astra", effort: "medium" }, "claude", { roleId: "builder", variant: "docs" })).toEqual(sonnetHigh);
  for (const row of [{ roleId: "orchestrator" }, { roleId: "architect" }, { roleId: "reviewer" }] as const) {
    for (const model of ["gpt-6-luna", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-6-astra"]) {
      expect({ row, model: equivalentConfig({ engine: "codex", model, effort: "medium" }, "claude", row).model }).toEqual({ row, model: "opus" });
    }
  }
});

/* docs/design/agent-prompt-contract.md §3 (a): the two fix rows run Sonnet on
   Claude and land where Sonnet maps on Codex, GPT-6 Sol, in both directions. */
test("the frontend and docs fix rows have approved targets on both engines", () => {
  for (const variant of ["frontend-fixes", "docs-fixes"] as const) {
    const row = { roleId: "builder", variant } as const;
    expect(equivalentConfig({ engine: "claude", model: "claude-sonnet-5-5", effort: "high" }, "codex", row)).toEqual({ engine: "codex", model: "gpt-6-sol", effort: "high" });
    expect(equivalentConfig({ engine: "codex", model: "gpt-6-sol", effort: "high" }, "claude", row)).toEqual({ engine: "claude", model: "claude-sonnet-5-5", effort: "high" });
  }
});
