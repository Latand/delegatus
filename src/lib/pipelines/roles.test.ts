import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ORCHESTRATOR_WITHOUT_MANDATE_RULES, ROLE_DEFAULTS, WORKING_RULES } from "@/lib/roles/defaults";
import { FRONTEND_GUIDANCE, resolveRole } from "@/lib/roles/registry";
import { ROLE_VARIANT_IDS } from "@/lib/roles/types";
import { VARIANT_PARAMS } from "@/lib/roles/paramConfig";
import { MAX_SCAFFOLD_LENGTH, saveRoleOverrides } from "@/lib/roles/store";
import { setMachineWorkerLimit, setProjectWorkerLimit } from "@/lib/operator/workerLimit";

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

test("pipeline role resolution defers legacy worker placeholders until stage launch", () => {
  const previous = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-worker-limit-"));
  process.env.LLV_STATE_DIR = sandbox;
  try {
    saveRoleOverrides({ orchestrator: { promptScaffold: "In every mode, keep at most {{maxWorkers}} workers running at once." } });
    setMachineWorkerLimit(8, { kind: "operator", via: "test" }, null);
    setProjectWorkerLimit("one", 10, { kind: "operator", via: "test" }, null);
    const stage = resolvePipelineRole({ role: { roleId: "orchestrator", params: { maxWorkers: 2 } } }, "run", pipelineRoleLookup, "one");
    expect(stage.role?.promptScaffold).toContain("at most {{maxWorkers}} workers");
    expect(pipelineRoleLookup("orchestrator", { maxWorkers: 2 }, "two")?.promptScaffold).toContain("at most {{maxWorkers}} workers");
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
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
    .toBe("invalid claude model id \"claude-fable-5\"; valid claude model ids: opus, fable, sonnet, claude-sonnet-5-5, haiku, claude-haiku-5-5, claude-haiku-4-5");
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
   orchestrator stage gets the worker rule the mandate would give it; the
   working rules are its scaffold's, and the stage wrapper names the tools. */
test("an orchestrator pipeline stage carries the working rules and the worker limit", () => {
  const scaffold = pipelineRoleLookup("orchestrator", { mode: "standard" })?.promptScaffold ?? "";
  expect(scaffold.split(WORKING_RULES)).toHaveLength(2);
  expect(scaffold).toBe(`You are the Orchestrator. Mode: standard.\n\n${ORCHESTRATOR_WITHOUT_MANDATE_RULES}\n\nSafety fences:\n- Act on Delegatus only through its MCP tools, launching with your own transcript as src lineage.\n- Workers start in fresh, empty sessions; never fork one.`);
});

/* A stage stores its scaffold at the store cap (MAX_SCAFFOLD_LENGTH), and an
   older release refuses to load a longer one, so every shipped role and
   variant fits whole, with room for the parameter values a seat passes; a
   cut would drop the end of the working rules. */
test("every shipped role and variant scaffold fits the stage cap untruncated", () => {
  const variants = Object.values(ROLE_VARIANT_IDS).flat().map((variant) => VARIANT_PARAMS[variant]);
  for (const definition of ROLE_DEFAULTS) {
    for (const params of [{}, { mode: "prototype" }, { mode: "apply-fixes", domain: "frontend" }, ...variants]) {
      const scaffold = pipelineRoleLookup(definition.id, params as Record<string, string>)?.promptScaffold ?? "";
      if (definition.id === "maintainer") continue; // not a pipeline role
      expect(scaffold).toContain("16. Leave the checkout as you found it");
      expect(MAX_SCAFFOLD_LENGTH - scaffold.length).toBeGreaterThan(200);
    }
  }
});

/* Parameter values the registry accepts (up to 2,000 characters of text) must
   not cut the rules: a stage either stores the whole scaffold or is refused
   before it is stored. */
test("accepted text parameter values keep every rule whole or refuse the stage", () => {
  const wholeEnd = "16. Leave the checkout as you found it";
  for (const definition of ROLE_DEFAULTS) {
    if (definition.id === "maintainer") continue; // not a pipeline role
    for (const parameter of definition.parameters.filter((candidate) => candidate.kind === "text")) {
      for (const length of [40, 250, 499, 2_000]) {
        const params = { [parameter.key]: "r".repeat(length) };
        expect(validatePipelineRoleParams(definition.id, params)).toBeNull();
        /* A deployer runs in a pipeline only as a release run; the
           orchestrator renders its text parameters only in backlog-campaign
           mode. */
        const stageParams = definition.id === "deployer" ? { ...params, mode: "release" }
          : definition.id === "orchestrator" ? { ...params, mode: "backlog-campaign" } : params;
        const resolved = resolvePipelineRole({ role: { roleId: definition.id, params: stageParams } } as never, "run", pipelineRoleLookup);
        if (resolved.error) {
          expect(resolved.error).toContain(`role ${definition.id} parameter ${parameter.key} makes its scaffold`);
          expect(resolved.error).toContain("which would cut the end of its rules");
          continue;
        }
        const scaffold = resolved.role?.promptScaffold ?? "";
        expect(scaffold.length).toBeLessThanOrEqual(MAX_SCAFFOLD_LENGTH);
        expect(scaffold).toContain("r".repeat(length));
        expect(scaffold).toContain(wholeEnd);
        /* The tail (the last rules, any role coda and the fences) is the one
           the role's defaults render. */
        const withoutText: Record<string, string> = { ...stageParams };
        delete withoutText[parameter.key];
        expect(scaffold).toEndWith(pipelineRoleLookup(definition.id, withoutText)!.promptScaffold!.slice(-1_500));
      }
    }
  }
});

test("a reviewer diff source past the stage cap is refused, a usual one keeps its suffix", () => {
  const range = `feature/${"a".repeat(240)}...feature/${"b".repeat(240)}`;
  for (const diffSource of [range, "x".repeat(2_000)]) {
    const params = { diffSource, lens: "correctness", parallelN: 1 };
    expect(validatePipelineRoleParams("reviewer", params)).toBeNull();
    const looked = pipelineRoleLookup("reviewer", params);
    expect(looked?.parameterOverflow?.keys).toEqual(["diffSource"]);
    const resolved = resolvePipelineRole({ role: { roleId: "reviewer", params } }, "review-loop", pipelineRoleLookup);
    expect(resolved.role).toBeUndefined();
    expect(resolved.error).toBe(`role reviewer parameter diffSource makes its scaffold ${looked!.parameterOverflow!.characters} characters longer than the ${MAX_SCAFFOLD_LENGTH} a stage stores, which would cut the end of its rules; shorten it by at least ${looked!.parameterOverflow!.characters} characters`);
  }
  const usual = "origin/main...pipeline/role-prompts-and-orchestrator-mandate-im-cf4db9bf";
  const resolved = resolvePipelineRole({ role: { roleId: "reviewer", params: { diffSource: usual } } }, "review-loop", pipelineRoleLookup);
  const scaffold = resolved.role?.promptScaffold ?? "";
  expect(scaffold).toContain(`Change under review: ${usual}`);
  expect(scaffold).toEndWith(pipelineRoleLookup("reviewer")!.promptScaffold!.slice(-2_000));
});

test("pipeline role lookup ignores the retired orchestrator maxWorkers parameter", () => {
  expect(pipelineRoleLookup("orchestrator", { maxWorkers: 1 })?.promptScaffold).toBe(pipelineRoleLookup("orchestrator")?.promptScaffold);
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
  expect(pipeline?.promptScaffold).toContain(FRONTEND_GUIDANCE);
  if (canonical.ok) expect(pipeline?.promptScaffold).toBe(canonical.value.prompt);
  /* Without domain=frontend the guidance is absent, so the two selections differ. */
  expect(pipelineRoleLookup("builder", {})?.promptScaffold).not.toContain(FRONTEND_GUIDANCE);
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
