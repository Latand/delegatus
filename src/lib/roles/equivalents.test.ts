import { expect, test } from "bun:test";

import { equivalentConfig } from "./equivalents";

test("moving a role between engines picks the equivalent model and keeps or clamps the effort", () => {
  expect(equivalentConfig({ engine: "codex", model: "gpt-6-astra", effort: "xhigh" }, "claude")).toEqual({ engine: "claude", model: "opus", effort: "xhigh" });
  expect(equivalentConfig({ engine: "codex", model: "gpt-5.6-terra", effort: "ultra" }, "claude")).toEqual({ engine: "claude", model: "sonnet", effort: "max" });
  expect(equivalentConfig({ engine: "codex", model: "gpt-5.6-luna", effort: "low" }, "claude")).toEqual({ engine: "claude", model: "haiku", effort: "low" });
  expect(equivalentConfig({ engine: "claude", model: "fable", effort: "max" }, "codex")).toEqual({ engine: "codex", model: "gpt-6-astra", effort: "max" });
  expect(equivalentConfig({ engine: "claude", model: "haiku", effort: "max" }, "codex")).toEqual({ engine: "codex", model: "gpt-5.6-luna", effort: "max" });
  const same = { engine: "claude" as const, model: "opus", effort: "high" };
  expect(equivalentConfig(same, "claude")).toBe(same);
});
