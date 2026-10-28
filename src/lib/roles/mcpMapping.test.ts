import { expect, test } from "bun:test";
import { roleLaunchChoices, roleMappingViolations } from "./mcpMapping";
import { resolveSpawnRole } from "./registry";
import { pipelineRoleLookup, resolvePipelineRole } from "@/lib/pipelines/roles";

test("reviewed Terra efforts pass role and variant admission alongside saved generations", () => {
  expect(roleLaunchChoices().codex["gpt-6.1-terra"]).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
  for (const model of ["gpt-6.1-terra", "gpt-6.1-sol", "gpt-6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-luna"]) {
    expect(roleMappingViolations({ builder: { config: { engine: "codex", model, effort: "max" } } })).toEqual([]);
  }
  expect(roleMappingViolations({ builder: { variants: { trivial: { engine: "codex", model: "gpt-6.1-terra", effort: "ultra" } } } })).toEqual([]);
  expect(roleMappingViolations({ builder: { config: { engine: "codex", model: "gpt-6.1-terra", effort: "invented" } } })[0]?.field).toBe("overrides.builder.config.effort");
  expect(roleMappingViolations({ builder: { config: { engine: "codex", model: "gpt-6.2-terra", effort: "high" } } })[0]?.field).toBe("overrides.builder.config.model");
});

test("fresh launches and pipeline overrides use the reviewed Terra wire id and effort", () => {
  const runtime = { engine: "codex" as const, model: "gpt-6.1-terra", effort: "ultra" };
  expect(resolveSpawnRole({ role: "builder", ...runtime })).toMatchObject({ ok: true, value: { config: runtime } });
  expect(resolvePipelineRole(runtime, "run", pipelineRoleLookup)).toMatchObject({ role: runtime });
  expect(resolvePipelineRole({ ...runtime, effort: "invented" }, "run", pipelineRoleLookup).error).toBeDefined();
});
