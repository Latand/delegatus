import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveRole } from "@/lib/roles/registry";
import { MAX_SCAFFOLD_LENGTH, saveRoleOverrides } from "@/lib/roles/store";

import { pipelineRoleLookup, resolvePipelineRole, validatePipelineRoleParams } from "./roles";

const REGISTRY_LOOKUP = (roleId: string) => {
  if (roleId === "builder") return { engine: "codex" as const, model: "gpt-5.6-sol", effort: "medium", access: "read-write" as const, promptScaffold: "Builder guidance" };
  if (roleId === "reviewer") return { engine: "codex" as const, model: "gpt-5.6-sol", effort: "xhigh", access: "read-only" as const, promptScaffold: "Reviewer guidance" };
  return null;
};

test("role references resolve registry defaults and stage overrides", () => {
  const lookup = () => ({
    engine: "codex" as const,
    model: "terra",
    effort: "high",
    access: "read-write" as const,
    promptScaffold: "Builder guidance",
  });
  expect(resolvePipelineRole({
    role: { roleId: "builder" },
    engine: "claude",
    model: "opus",
    effort: "low",
    access: "read-only",
  }, "run", lookup).role).toEqual({
    roleId: "builder",
    engine: "claude",
    model: "opus",
    effort: "low",
    access: "read-only",
    promptScaffold: "Builder guidance",
  });
});

test("role-less stages inherit Builder runtime defaults and receive no scaffold", () => {
  const lookup = (roleId: string) => roleId === "builder"
    ? { engine: "codex" as const, model: "gpt-5.6-sol", effort: "medium", access: "read-write" as const, promptScaffold: "Builder guidance" }
    : null;
  expect(resolvePipelineRole({}, "run", lookup).role).toEqual({
    roleId: null,
    engine: "codex",
    model: "gpt-5.6-sol",
    effort: "medium",
    access: "read-write",
    promptScaffold: null,
  });
});

test("role resolution fails closed when the Builder preset is unavailable", () => {
  expect(resolvePipelineRole({ engine: "claude", model: "opus", effort: "high", access: "read-only" }, "run", null).error)
    .toBe("Builder role is unavailable in the role registry");
});

test("production role lookup reads the current Sol Builder preset", () => {
  expect(resolvePipelineRole({}, "run", pipelineRoleLookup).role).toMatchObject({
    roleId: null,
    engine: "codex",
    model: "gpt-6.1-sol",
    effort: "high",
    access: "read-write",
    promptScaffold: null,
  });
});

test("stage runtime fields override registry and global defaults", () => {
  expect(resolvePipelineRole({ engine: "claude", model: "opus", effort: "xhigh", access: "read-only" }, "run", REGISTRY_LOOKUP).role).toEqual({
    roleId: null,
    engine: "claude",
    model: "opus",
    effort: "xhigh",
    access: "read-only",
    promptScaffold: null,
  });
  expect(resolvePipelineRole({ role: { roleId: "builder" } }, "run", REGISTRY_LOOKUP).role).toMatchObject({
    roleId: "builder",
    engine: "codex",
    model: "gpt-5.6-sol",
    effort: "medium",
  });
});

test("cross-engine overrides require a compatible model", () => {
  expect(resolvePipelineRole({ role: { roleId: "reviewer" }, engine: "claude" }, "review-loop", REGISTRY_LOOKUP).error)
    .toContain("valid claude model ids: opus, fable, sonnet, claude-sonnet-5-5, haiku");
  expect(resolvePipelineRole({ engine: "claude" }, "run", REGISTRY_LOOKUP).error)
    .toContain("valid claude model ids: opus, fable, sonnet, claude-sonnet-5-5, haiku");
  expect(resolvePipelineRole({ engine: "claude", model: "opus", effort: "high" }, "run", REGISTRY_LOOKUP).role)
    .toMatchObject({ engine: "claude", model: "opus", effort: "high" });
});

test("stage model overrides enumerate the selected engine catalog when invalid", () => {
  expect(resolvePipelineRole({ engine: "codex", model: "gpt-5.6-codex" }, "run", REGISTRY_LOOKUP).error)
    .toBe("invalid codex model id \"gpt-5.6-codex\"; valid codex model ids: gpt-6-astra, gpt-6.1-sol, gpt-6-sol, gpt-6-luna, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna");
  expect(resolvePipelineRole({ engine: "claude", model: "claude-fable-5" }, "run", REGISTRY_LOOKUP).error)
    .toBe("invalid claude model id \"claude-fable-5\"; valid claude model ids: opus, fable, sonnet, claude-sonnet-5-5, haiku");
});

test("review-loop roles default to read-only access", () => {
  expect(resolvePipelineRole({ role: { roleId: "reviewer" } }, "review-loop", REGISTRY_LOOKUP).role?.access).toBe("read-only");
  expect(resolvePipelineRole({ role: { roleId: "reviewer" }, access: "read-write" }, "review-loop", REGISTRY_LOOKUP).error).toBe("review-loop stages require read-only access");
});

test("role references stay inside the eight-role registry", () => {
  expect(resolvePipelineRole({ role: { roleId: "implementer" } } as never, "run", null).error).toBe("unknown pipeline role: implementer");
});

test("a near-limit override scaffold composes with fences inside the store cap", () => {
  const previous = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-roles-cap-"));
  process.env.LLV_STATE_DIR = sandbox;
  try {
    saveRoleOverrides({ reviewer: { promptScaffold: "x".repeat(MAX_SCAFFOLD_LENGTH) } });
    const resolved = pipelineRoleLookup("reviewer");
    expect(resolved?.promptScaffold?.length).toBeLessThanOrEqual(MAX_SCAFFOLD_LENGTH);
    expect(resolved?.promptScaffold).toContain("Safety fences:");
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("a referenced role with an empty scaffold fails the create instead of persisting", () => {
  const lookup = (roleId: string) => roleId === "builder"
    ? { engine: "codex" as const, model: "gpt-5.6-sol", effort: "medium", access: "read-write" as const, promptScaffold: "   " }
    : null;
  expect(resolvePipelineRole({ role: { roleId: "builder" } }, "run", lookup).error)
    .toContain("empty prompt scaffold");
});

/* A UI lane ends with a visual-critic stage: the production lookup runs it
   read-only on the role's own Opus row, and a stage override still wins. */
test("a visual-critic stage resolves read-only on the role's Claude Opus runtime", () => {
  const resolved = resolvePipelineRole({ role: { roleId: "visual-critic" } }, "run", pipelineRoleLookup);
  expect(resolved.error).toBeUndefined();
  expect(resolved.role).toMatchObject({ roleId: "visual-critic", engine: "claude", model: "opus", effort: "high", access: "read-only" });
  expect(resolved.role?.promptScaffold).toStartWith("You are a Visual-critic.");
  expect(resolved.role?.promptScaffold).toContain("Safety fences:");
  expect(resolvePipelineRole({ role: { roleId: "visual-critic" }, effort: "xhigh" }, "run", pipelineRoleLookup).role).toMatchObject({ effort: "xhigh", access: "read-only" });
});

/* Visual judgement runs on Claude, never Codex, and the critic never writes:
   an edited Claude runtime launches, a Codex runtime or a read-write stage does
   not, and the other read-only roles still take the access a stage asks for. */
test("a visual-critic stage runs only on Claude and only read-only", () => {
  const critic = { roleId: "visual-critic" as const };
  expect(resolvePipelineRole({ role: critic, model: "fable", effort: "max" }, "run", pipelineRoleLookup).role)
    .toMatchObject({ engine: "claude", model: "fable", effort: "max", access: "read-only" });
  expect(resolvePipelineRole({ role: critic, access: "read-only" }, "run", pipelineRoleLookup).role).toMatchObject({ access: "read-only" });
  expect(resolvePipelineRole({ role: critic, engine: "codex", model: "gpt-6.1-sol", effort: "high" }, "run", pipelineRoleLookup))
    .toEqual({ error: "visual-critic runs on claude only" });
  expect(resolvePipelineRole({ role: critic, access: "read-write" }, "run", pipelineRoleLookup))
    .toEqual({ error: "role visual-critic is read-only; a stage cannot give it read-write access" });
  /* A lookup whose row claims read-write cannot widen the contract either. */
  const writable: typeof pipelineRoleLookup = (roleId, params) => {
    const row = pipelineRoleLookup(roleId, params);
    return row ? { ...row, access: "read-write" } : null;
  };
  expect(resolvePipelineRole({ role: critic }, "run", writable).role?.access).toBe("read-only");
  expect(resolvePipelineRole({ role: { roleId: "reviewer" }, access: "read-write" }, "run", pipelineRoleLookup).role?.access).toBe("read-write");
  expect(resolvePipelineRole({ role: { roleId: "architect" }, engine: "codex", model: "gpt-6.1-sol", effort: "high" }, "run", pipelineRoleLookup).role?.engine).toBe("codex");
});

test("the deployer role is refused in pipelines (no interactive confirm gate)", () => {
  expect(resolvePipelineRole({ role: { roleId: "deployer" } }, "run", pipelineRoleLookup).error)
    .toContain("not allowed in a pipeline");
});

test("Builder domain=frontend resolves to the Claude Sonnet 5.5 config", () => {
  const resolved = resolvePipelineRole({ role: { roleId: "builder", params: { domain: "frontend" } } }, "run", pipelineRoleLookup).role;
  expect(resolved).toMatchObject({ roleId: "builder", engine: "claude", model: "claude-sonnet-5-5", effort: "high" });
});

/* docs/design/agent-prompt-contract.md §3 (a): a fix round's runtime follows
   its lane's domain and size through the fix rows. */
test("a Builder fix round resolves to the fix row its domain and size select", () => {
  const fix = (params: Record<string, string>) => resolvePipelineRole({ role: { roleId: "builder", params: { mode: "apply-fixes", ...params } } }, "run", pipelineRoleLookup).role;
  expect(fix({})).toMatchObject({ roleId: "builder", engine: "codex", model: "gpt-6-luna", effort: "high" });
  expect(fix({ domain: "frontend" })).toMatchObject({ engine: "claude", model: "claude-sonnet-5-5", effort: "high" });
  expect(fix({ domain: "docs" })).toMatchObject({ engine: "claude", model: "claude-sonnet-5-5", effort: "high" });
  expect(fix({ domain: "frontend", size: "trivial" })).toMatchObject({ engine: "claude", model: "claude-sonnet-5-5", effort: "high" });
  expect(fix({})?.promptScaffold).toContain("You are a Builder in apply-fixes mode.");
});

test("validatePipelineRoleParams enforces canonical value rules and skips required-when-absent", () => {
  /* Absent required params are fine — a pipeline reviewer reviews its branch. */
  expect(validatePipelineRoleParams("reviewer", {})).toBeNull();
  expect(validatePipelineRoleParams("reviewer", { diffSource: "PR#1", lens: "scope" })).toBeNull();
  /* Supplied invalid values are rejected exactly as the shared registry would. */
  expect(validatePipelineRoleParams("reviewer", { lens: "bogus" })).toContain("invalid role parameter: lens");
  expect(validatePipelineRoleParams("reviewer", { parallelN: 999 })).toContain("invalid role parameter: parallelN");
  expect(validatePipelineRoleParams("reviewer", { unknownKey: "x" })).toContain("unknown role parameter: unknownKey");
});

test("operator role params substitute into the resolved prompt scaffold", () => {
  const resolved = resolvePipelineRole(
    { role: { roleId: "reviewer", params: { diffSource: "PR#100", lens: "scope" } } },
    "review-loop",
    pipelineRoleLookup,
  );
  expect(resolved.role?.promptScaffold).toContain("Change under review: PR#100");
  expect(resolved.role?.promptScaffold).toContain("Lens: scope.");
});

/* Review of #2301: a pipeline stage never carries the seat mandate, so an
   orchestrator stage gets the shared rules its scaffold leaves to it. */
test("an orchestrator pipeline stage carries the shared rules", () => {
  const scaffold = pipelineRoleLookup("orchestrator", { mode: "standard" })?.promptScaffold ?? "";
  expect(scaffold).toContain("search_transcripts");
  expect(scaffold).toContain("finish with needs_decision");
  expect(scaffold).toContain("The project's own rules govern the work");
});

test("pipeline role lookup defaults omitted orchestrator maxWorkers to three", () => {
  expect(pipelineRoleLookup("orchestrator")?.promptScaffold).toContain("keep at most 3 workers running at once");
  expect(pipelineRoleLookup("orchestrator", { maxWorkers: 1 })?.promptScaffold).toContain("keep at most 1 workers running at once");
  expect(pipelineRoleLookup("reviewer")?.promptScaffold).toContain("Run 1 independent pass(es)");
});

test("blank role params fall back to the registry default token value", () => {
  const resolved = resolvePipelineRole(
    { role: { roleId: "reviewer", params: { diffSource: "", lens: "" } } },
    "review-loop",
    pipelineRoleLookup,
  );
  /* lens defaults to the first registry option, so no empty token is
     substituted, and an empty change drops its labelled line (C6). */
  expect(resolved.role?.promptScaffold).toContain("Lens: correctness.");
  expect(resolved.role?.promptScaffold).not.toContain("Lens: .");
  expect(resolved.role?.promptScaffold).not.toContain("Change under review:");
  expect(resolved.role?.promptScaffold).not.toMatch(/Inspect\s+with/);
});

test("Builder domain=frontend keeps the canonical frontend scaffold guidance (parity with resolveRole)", () => {
  const pipeline = pipelineRoleLookup("builder", { domain: "frontend" });
  const canonical = resolveRole("builder", { domain: "frontend" });
  expect(canonical.ok).toBe(true);
  /* The pipeline lookup must carry the same frontend guidance the spawn path
     emits; a hand-rolled substitution would silently drop it. */
  expect(pipeline?.promptScaffold).toContain("UI/frontend implementation guidance");
  if (canonical.ok) expect(pipeline?.promptScaffold).toBe(canonical.value.prompt);
  /* Without domain=frontend the guidance is absent, so the two selections differ. */
  expect(pipelineRoleLookup("builder", {})?.promptScaffold).not.toContain("UI/frontend implementation guidance");
});

test("codex model overrides use the curated launch catalog at create time", () => {
  expect(resolvePipelineRole({ model: `gpt-${"x".repeat(200)}` }, "run", REGISTRY_LOOKUP).error)
    .toContain("valid codex model ids: gpt-6-astra, gpt-6.1-sol, gpt-6-sol, gpt-6-luna, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna");
  expect(resolvePipelineRole({ model: "gpt-5.6\u0000sol" }, "run", REGISTRY_LOOKUP).error)
    .toContain("valid codex model ids: gpt-6-astra, gpt-6.1-sol, gpt-6-sol, gpt-6-luna, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna");
});

for (const effort of ["xhigh", "max", "ultra"]) {
  test(`production pipeline lookup accepts Astra at ${effort}`, () => {
    expect(resolvePipelineRole({ model: "gpt-6-astra", effort }, "run", pipelineRoleLookup).role)
      .toMatchObject({ model: "gpt-6-astra", effort });
  });
}

test("explicit Sol remains selectable through production pipeline lookup", () => {
  expect(resolvePipelineRole({ model: "gpt-5.6-sol", effort: "xhigh" }, "run", pipelineRoleLookup).role)
    .toMatchObject({ model: "gpt-5.6-sol", effort: "xhigh" });
});

for (const [engine, model] of [["codex", "gpt-5.6-luna"], ["claude", "opus"]] as const) {
  test(`production pipeline lookup refuses ${model}/ultra with model options`, () => {
    expect(resolvePipelineRole({ engine, model, effort: "ultra" }, "run", pipelineRoleLookup).error)
      .toBe(`stage effort for ${engine}/${model} must be one of: low, medium, high, xhigh, max`);
  });
}

test("null inherits the role tier, explicit priority overrides and default opts out", () => {
  const lookup = () => ({ engine: "codex" as const, model: "gpt-6-astra", effort: "high", serviceTier: "ultrafast", promptScaffold: "Reviewer guidance" });
  for (const serviceTier of [undefined, null]) expect(resolvePipelineRole({ role: { roleId: "reviewer" }, serviceTier }, "run", lookup).role).toMatchObject({ serviceTier: "ultrafast", serviceTierSource: "role-default" });
  for (const serviceTier of ["priority", "default", "standard"]) expect(resolvePipelineRole({ role: { roleId: "reviewer" }, serviceTier }, "run", lookup).role).toMatchObject({ serviceTier, serviceTierSource: "explicit" });
  expect(resolvePipelineRole({ model: "gpt-6-sol" }, "run", lookup).role?.serviceTier).toBeUndefined();
  expect(resolvePipelineRole({ engine: "claude", model: "opus", serviceTier: "ultrafast" }, "run", lookup).error).toContain("Codex only");
});
