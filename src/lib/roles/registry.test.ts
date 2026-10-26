import { expect, test } from "bun:test";

import { OPERATOR_CORRECTION_RULE, BUILDER_FINISH_LINE, FIX_ROUND_FINISH_LINE, RENDERED_RULES, WORKING_RULES } from "./defaults";
import { defaultRoleParameterValue } from "./parameters";
import { variantForParams } from "./paramConfig";
import type { RoleParamValues } from "./types";
import { ORCHESTRATOR_TASK_OWNERSHIP_HEADING } from "@/lib/orchestrator/prompt";

import { APPLY_FIXES_GUIDANCE, FRONTEND_GUIDANCE, listRoles, resolveRole, resolveSpawnRole, roleFenceBlock, roleScaffoldBody, roleSpawnPrompt, SPAWN_COMPLETION } from "./registry";

test("merger resolves a required reviewed-PR list with a read-write, non-nesting profile", () => {
  expect(resolveRole("merger", {})).toMatchObject({ ok: false, error: "missing required role parameter: prs" });
  const resolved = resolveSpawnRole({ role: "merger", roleParams: { prs: "12@abcdef1,13@1234567" } });
  expect(resolved).toMatchObject({ ok: true });
  const role = resolveRole("merger", { prs: "12@abcdef1,13@1234567" });
  if (!role.ok) throw new Error(role.error);
  expect(role.value.config).toEqual({ engine: "codex", model: "gpt-6.1-sol", effort: "high" });
  expect(role.value.definition.capabilities).toEqual([]);
  expect(role.value.prompt).toContain("12@abcdef1,13@1234567");
});

test("role registry exposes the thirteen role ids and campaign-ready orchestrator config", () => {
  const roles = listRoles();

  expect(roles.map((role) => role.id)).toEqual([
    "orchestrator",
    "reviewer",
    "verifier",
    "builder",
    "architect",
    "cleaner",
    "prod-auditor",
    "deployer",
    "merger",
    "maintainer",
    "curator",
    "issue-reporter",
    "visual-critic",
  ]);
  expect(Object.fromEntries(roles.map((role) => [role.id, role.config]))).toEqual({
    orchestrator: { engine: "claude", model: "opus", effort: "high" },
    reviewer: { engine: "codex", model: "gpt-6.1-sol", effort: "xhigh" },
    verifier: { engine: "codex", model: "gpt-6.1-sol", effort: "high" },
    builder: { engine: "codex", model: "gpt-6.1-sol", effort: "high" },
    architect: { engine: "claude", model: "opus", effort: "xhigh" },
    cleaner: { engine: "codex", model: "gpt-6-luna", effort: "medium" },
    "prod-auditor": { engine: "codex", model: "gpt-6.1-sol", effort: "xhigh" },
    maintainer: { engine: "codex", model: "gpt-6.1-sol", effort: "medium" },
    curator: { engine: "codex", model: "gpt-6.1-sol", effort: "high" },
    merger: { engine: "codex", model: "gpt-6.1-sol", effort: "high" },
    deployer: { engine: "codex", model: "gpt-6.1-sol", effort: "medium" },
    "issue-reporter": { engine: "claude", model: "claude-sonnet-5-5", effort: "high" },
    "visual-critic": { engine: "claude", model: "opus", effort: "high" },
  });

  const orchestrator = resolveRole("orchestrator", {
    mode: "backlog-campaign",
    repo: "Latand/delegatus",
    issueQuery: "is:open",
    urgent: "#35",
    maxWorkers: 2,
    mergePolicy: "pr",
    completionPolicy: "released",
  });
  expect(orchestrator.ok && orchestrator.value.config).toEqual({ engine: "claude", model: "opus", effort: "high" });
  expect(orchestrator.ok && orchestrator.value.prompt).toContain("Repository: Latand/delegatus");
  expect(orchestrator.ok && orchestrator.value.prompt).toContain("Issue query: is:open");
  expect(orchestrator.ok && orchestrator.value.prompt).toContain("Urgent list: #35");

  expect(orchestrator.ok && orchestrator.value.prompt).toContain("Merge policy: pr\nCompletion policy: released");
  /* The backlog-campaign lines render only in that mode, even with values, so
     none of them reads as a standing rule elsewhere (agent-prompt-contract.md
     N6); the worker cap holds in every mode. */
  for (const params of [{}, { mode: "standard", repo: "owner/repo", mergePolicy: "merge" }]) {
    const standard = resolveRole("orchestrator", params);
    if (!standard.ok) throw new Error(standard.error);
    for (const label of ["Repository:", "Issue query:", "Urgent list:", "Merge policy:", "Completion policy:"]) expect(standard.value.prompt).not.toContain(label);
    expect(standard.value.prompt).not.toContain("\n\n\n");
  }

  expect(resolveRole("builder", { mode: "plain", domain: "general" })).toMatchObject({
    ok: true,
    value: { config: { engine: "codex", model: "gpt-6.1-sol", effort: "high" } },
  });
  expect(resolveRole("verifier", { claims: "the regression is fixed" })).toMatchObject({
    ok: true,
    value: { config: { engine: "codex", model: "gpt-6.1-sol", effort: "high" } },
  });
  expect(resolveRole("cleaner")).toMatchObject({ ok: true, value: { config: { engine: "codex", model: "gpt-6-luna", effort: "medium" } } });
  expect(resolveRole("deployer", { sha: "abc123" })).toMatchObject({ ok: true, value: { config: { engine: "codex", model: "gpt-6.1-sol", effort: "medium" } } });
});

test("builder parameters select the cheap fixer and the frontend implementation profile", () => {
  const applyFixes = resolveRole("builder", { mode: "apply-fixes", domain: "general" });
  expect(applyFixes).toMatchObject({ ok: true, value: { config: { engine: "codex", model: "gpt-6-luna", effort: "high" } } });

  const frontend = resolveRole("builder", { mode: "plain", domain: "frontend" });
  expect(frontend).toMatchObject({ ok: true, value: { config: { engine: "claude", model: "claude-sonnet-5-5", effort: "high" } } });
  expect(frontend.ok && frontend.value.prompt).toContain(`${FRONTEND_GUIDANCE}\n${RENDERED_RULES}`);
});

test("role registry rejects unknown and missing required parameters with bounded errors", () => {
  /* #774: a rejection names the accepted alternatives, so the caller can
     self-correct instead of reading the registry source. */
  expect(resolveRole("reviewer", { lens: "all", unexpected: true })).toEqual({
    ok: false,
    error: "unknown role parameter: unexpected (reviewer accepts: diffSource, lens, mode, parallelN, size)",
  });
  expect(resolveRole("verifier", {})).toEqual({
    ok: false,
    error: "missing required role parameter: claims",
  });
  expect(resolveRole("no-such-role", {})).toEqual({
    ok: false,
    error: "unknown role: no-such-role (allowed: orchestrator, reviewer, verifier, builder, architect, cleaner, prod-auditor, deployer, merger, maintainer, curator, issue-reporter, visual-critic)",
  });
});

test("the reviewer scaffold runs the project's own checks, and a cross-engine inherited model is rejected", () => {
  const reviewer = resolveRole("reviewer", { diffSource: "origin/main...HEAD", lens: "all" });
  expect(reviewer.ok && reviewer.value.prompt).toContain("Change under review: origin/main...HEAD");

  expect(resolveSpawnRole({ role: "builder", roleParams: { mode: "plain" }, engine: "claude" })).toEqual({
    ok: false,
    error: "model is required when overriding a role engine",
  });
});

test("deployer requires confirmation while explicit spawn fields can override its profile", () => {
  const unresolved = resolveRole("deployer", { sha: "abc123" });
  expect(unresolved.ok && unresolved.value.requiresDeploymentConfirmation).toBe(true);

  const resolved = resolveRole("deployer", { sha: "abc123" }, {
    engine: "claude",
    model: "opus",
    effort: "high",
  });
  expect(resolved.ok && resolved.value.config).toEqual({ engine: "claude", model: "opus", effort: "high" });
});

test("spawn role resolution injects the scaffold and requires deploy confirmation", () => {
  const missingConfirmation = resolveSpawnRole({ role: "deployer", roleParams: { sha: "abc123" } });
  expect(missingConfirmation).toEqual({ ok: false, error: "deployer requires confirm: deploy" });

  const spawn = resolveSpawnRole({
    role: "builder",
    roleParams: { mode: "tdd" },
    engine: "claude",
    model: "opus",
    effort: "high",
  });
  if (!spawn.ok || !spawn.value) throw new Error("expected resolved builder role");
  expect(spawn.value.config).toEqual({ engine: "claude", model: "opus", effort: "high" });
  expect(spawn.value.scaffold).toContain("Builder in tdd mode");
});

test("explicit spawn fields accept GPT-6.1-Sol at ultra", () => {
  expect(resolveRole("builder", { mode: "plain" }, { engine: "codex", model: "gpt-6.1-sol", effort: "ultra" })).toMatchObject({
    ok: true,
    value: { config: { engine: "codex", model: "gpt-6.1-sol", effort: "ultra" } },
  });
});

test("explicit spawn fields accept GPT-6-Sol at ultra and GPT-6-Luna up to max", () => {
  expect(resolveRole("builder", { mode: "plain" }, { engine: "codex", model: "gpt-6-sol", effort: "ultra" })).toMatchObject({
    ok: true,
    value: { config: { engine: "codex", model: "gpt-6-sol", effort: "ultra" } },
  });
  expect(resolveRole("builder", { mode: "plain" }, { engine: "codex", model: "gpt-6-luna", effort: "max" })).toMatchObject({
    ok: true,
    value: { config: { engine: "codex", model: "gpt-6-luna", effort: "max" } },
  });
  expect(resolveRole("builder", { mode: "plain" }, { engine: "codex", model: "gpt-6-luna", effort: "ultra" })).toEqual({
    ok: false,
    error: "effort for codex must be one of: low, medium, high, xhigh, max",
  });
});

test("spawn role resolution enumerates the selected engine catalog for an invalid explicit model", () => {
  expect(resolveSpawnRole({
    role: "builder",
    roleParams: { mode: "plain" },
    engine: "claude",
    model: "mythos-1",
  })).toEqual({
    ok: false,
    error: "invalid claude model id \"mythos-1\"; valid claude model ids: opus, fable, sonnet, claude-sonnet-5-5, haiku, claude-haiku-5-5, claude-haiku-4-5",
  });
});

test("orchestrator spawn retires the launch-only worker number", () => {
  const omitted = resolveSpawnRole({ role: "orchestrator" });
  if (!omitted.ok || !omitted.value) throw new Error("expected resolved orchestrator role");

  const explicit = resolveSpawnRole({ role: "orchestrator", roleParams: { maxWorkers: 1 } });
  if (!explicit.ok || !explicit.value) throw new Error("expected resolved orchestrator role");
  expect(explicit.value.scaffold).toBe(omitted.value.scaffold);
});

/* docs/design/model-sizing-tiers.md §1 and agent-prompt-contract.md §3 (a):
   one precedence, trivial > frontend-fixes > docs-fixes > frontend > docs >
   apply-fixes, stated once and read by every caller. */
test("variantForParams orders trivial over the fix rows over the domains over apply-fixes, per role", () => {
  expect(variantForParams("builder", { size: "trivial", domain: "frontend", mode: "apply-fixes" })).toBe("trivial");
  expect(variantForParams("builder", { size: "normal", domain: "frontend", mode: "apply-fixes" })).toBe("frontend-fixes");
  expect(variantForParams("builder", { domain: "docs", mode: "apply-fixes" })).toBe("docs-fixes");
  expect(variantForParams("builder", { domain: "frontend", mode: "plain" })).toBe("frontend");
  expect(variantForParams("builder", { domain: "docs" })).toBe("docs");
  expect(variantForParams("builder", { domain: "general", mode: "apply-fixes" })).toBe("apply-fixes");
  expect(variantForParams("builder", { domain: "general", mode: "plain", size: "normal" })).toBeNull();
  expect(variantForParams("reviewer", { size: "trivial", lens: "all" })).toBe("trivial");
  expect(variantForParams("reviewer", { size: "normal" })).toBeNull();
  expect(variantForParams("architect", { size: "trivial" })).toBeNull();
});

test("the small-change and docs variants ship their runtime, and only builder and reviewer take size", () => {
  expect(resolveRole("builder", { size: "trivial", domain: "frontend" })).toMatchObject({ ok: true, value: { config: { engine: "claude", model: "claude-sonnet-5-5", effort: "high" } } });
  expect(resolveRole("builder", { domain: "docs" })).toMatchObject({ ok: true, value: { config: { engine: "claude", model: "claude-sonnet-5-5", effort: "high" } } });
  /* A fix round runs its lane's fix row: a writing or UI lane's on Sonnet 5.5, a
     general one on GPT-6 Luna (agent-prompt-contract.md §3 (a)). */
  expect(resolveRole("builder", { domain: "docs", mode: "apply-fixes" })).toMatchObject({ ok: true, value: { config: { engine: "claude", model: "claude-sonnet-5-5", effort: "high" } } });
  expect(resolveRole("builder", { domain: "frontend", mode: "apply-fixes" })).toMatchObject({ ok: true, value: { config: { engine: "claude", model: "claude-sonnet-5-5", effort: "high" } } });
  expect(resolveRole("builder", { mode: "apply-fixes" })).toMatchObject({ ok: true, value: { config: { engine: "codex", model: "gpt-6-luna", effort: "high" } } });
  expect(resolveRole("reviewer", { diffSource: "#1", size: "trivial" })).toMatchObject({ ok: true, value: { config: { engine: "codex", model: "gpt-6-luna", effort: "high" } } });
  expect(resolveRole("builder", { size: "normal" })).toMatchObject({ ok: true, value: { config: { engine: "codex", model: "gpt-6.1-sol", effort: "high" } } });
  /* A trivial UI tweak keeps the frontend scaffold guidance, which is keyed on domain. */
  const trivialFrontend = resolveRole("builder", { size: "trivial", domain: "frontend" });
  expect(trivialFrontend.ok && trivialFrontend.value.prompt).toContain(FRONTEND_GUIDANCE);
  for (const role of ["architect", "orchestrator", "verifier"]) {
    const resolved = resolveRole(role, { size: "trivial", claims: "x" });
    expect(resolved.ok).toBe(false);
    expect(!resolved.ok && resolved.error).toContain("unknown role parameter: size");
  }
  expect(resolveRole("builder", { size: "tiny" })).toEqual({ ok: false, error: "invalid role parameter: size" });
});

test("spawn role resolution says whether the request moved the runtime off the role's row", () => {
  const row = resolveSpawnRole({ role: "builder", roleParams: { size: "trivial" } });
  expect(row).toMatchObject({ ok: true, value: { role: "builder", explicitRuntime: false, params: { size: "trivial" }, config: { engine: "claude", model: "claude-sonnet-5-5" } } });
  const same = resolveSpawnRole({ role: "builder", roleParams: { size: "trivial" }, model: "claude-sonnet-5-5", effort: "low" });
  expect(same).toMatchObject({ ok: true, value: { explicitRuntime: false, config: { effort: "low" } } });
  const moved = resolveSpawnRole({ role: "builder", engine: "claude", model: "sonnet" });
  expect(moved).toMatchObject({ ok: true, value: { explicitRuntime: true, config: { engine: "claude", model: "sonnet" } } });
});

/* docs/design/agent-prompt-contract.md §2.10 B: an optional parameter left
   empty drops its labelled line, so a pipeline reviewer with no change named
   never reads "Inspect  with lens" or a dangling label (C6, N9). */
test("an empty optional parameter drops its labelled line", () => {
  const lookupStyle = roleScaffoldBody(listRoles().find((role) => role.id === "reviewer")!, { diffSource: "", lens: "correctness", parallelN: 1 });
  expect(lookupStyle).not.toContain("Change under review:");
  expect(lookupStyle).not.toMatch(/Inspect\s+with/);
  expect(lookupStyle).toContain("Lens: correctness.");
  const deployer = resolveRole("deployer", { sha: "a".repeat(40) });
  if (!deployer.ok) throw new Error(deployer.error);
  expect(deployer.value.prompt).toContain(`Merged commit: ${"a".repeat(40)}\n\nFollow the project's own release procedure`);
  expect(deployer.value.prompt).not.toContain("Pull request:");
});

test("every role scaffold carries the working rules once and names no stack, project file or retired marker", () => {
  for (const definition of listRoles()) {
    for (const params of [{ mode: definition.id === "builder" ? "apply-fixes" : "", domain: "frontend" }, { mode: definition.id === "builder" ? "prototype" : "" }] as RoleParamValues[]) {
      const scaffold = roleScaffoldBody(definition, params) + roleFenceBlock(definition);
      const body = definition.id === "orchestrator" ? roleSpawnPrompt({ role: "orchestrator", scaffold }, "Coordinate the lanes.") : scaffold;
      /* One core for every role and the seat: the shared rules it replaced
         used to be five sentences each role carried in its own words. */
      expect(body.split(WORKING_RULES)).toHaveLength(2);
    }
  }
});

/* §3 (a): a fix round tells a light fixer to fix only what names its place
   and hand anything else back as fail. */
test("a builder fix round carries the apply-fixes guidance", () => {
  const fix = resolveRole("builder", { mode: "apply-fixes" });
  const plain = resolveRole("builder", { mode: "plain" });
  if (!fix.ok || !plain.ok) throw new Error("builder did not resolve");
  expect(fix.value.prompt).toContain(APPLY_FIXES_GUIDANCE);
  expect(plain.value.prompt).not.toContain("Fix round:");
  /* Review of #2301: one finish line, scoped to the findings; the reviewer
     judges the lane against the pinned specification. */
  expect(fix.value.prompt).toContain(FIX_ROUND_FINISH_LINE);
  expect(fix.value.prompt).not.toContain(BUILDER_FINISH_LINE);
  expect(plain.value.prompt).toContain(BUILDER_FINISH_LINE);
});

/* A fixer spawned without a stage reads no stage wrapper, so its prompt as
   spawned states when it may fail and names no stage it lacks. */
test("a spawned fixer reads the blocked-only failure definition without stage fields", () => {
  const resolved = resolveSpawnRole({ role: "builder", roleParams: { mode: "apply-fixes", domain: "general" } });
  if (!resolved.ok || !resolved.value) throw new Error("builder did not resolve");
  const prompt = roleSpawnPrompt(resolved.value, "Fix the handed findings.");
  expect(prompt.endsWith(SPAWN_COMPLETION)).toBe(true);
});

/* §2.2: a spawned role agent has no stage to report to, so it ends in a
   Verdict line; the orchestrator reports outcomes and gets none. */
test("a role spawn ends with the verdict line, and a seat or a role-less spawn does not", () => {
  expect(roleSpawnPrompt({ role: "verifier", scaffold: "Scaffold." }, "Check the claim.")).toBe(`Scaffold.\n\nCheck the claim.\n\n${SPAWN_COMPLETION}`);
  /* Review of #2301: a seat's brief carries the mandate, which holds longer
     versions of the shared rules; an orchestrator launched without it (a
     child spawn) gets them, and neither gets a completion line. */
  const mandate = `${ORCHESTRATOR_TASK_OWNERSHIP_HEADING}\nThe seat's mandate.`;
  expect(roleSpawnPrompt({ role: "orchestrator", scaffold: "Scaffold." }, mandate)).toBe(`Scaffold.\n\n${mandate}`);
  const child = roleSpawnPrompt({ role: "orchestrator", scaffold: "Scaffold." }, "Coordinate the migration lanes.");
  expect(child).toContain("search_transcripts");
  expect(child).toContain("the worker limit each wake and get_orchestrator state");
  expect(child).not.toContain(SPAWN_COMPLETION);
  expect(roleSpawnPrompt(null, "Just this.")).toBe("Just this.");
});

/* #2518: the reporter is read-only, cannot publish, and carries the scrub
   rules in the words the issue lists them. */
test("the issue-reporter preset is read-only, previews and never publishes, and states every scrub rule", () => {
  const resolved = resolveRole("issue-reporter", {});
  if (!resolved.ok) throw new Error(resolved.error);
  expect(resolved.value.definition.capabilities).toEqual(["read-only"]);
});

/* The operator, 2026-10-06: the last check of a UI lane looks only at the
   rendered screens. The critic is read-only, runs on Claude Opus, makes its
   own frames at every width, language and theme, and reports the two classes. */
test("the visual-critic preset is read-only on Opus and judges only rendered frames", () => {
  const resolved = resolveRole("visual-critic", {});
  if (!resolved.ok) throw new Error(resolved.error);
  expect(resolved.value.definition.capabilities).toEqual(["read-only"]);
  expect(resolved.value.definition.config).toEqual({ engine: "claude", model: "opus", effort: "high" });
  expect(resolved.value.definition.name).toBe("Visual critic");
});

/* Visual judgement runs on Claude, never Codex: spawn_agent takes an edited
   Claude runtime and refuses a Codex one. */
test("spawning a visual critic takes a Claude runtime and refuses Codex", () => {
  const plain = resolveSpawnRole({ role: "visual-critic" });
  if (!plain.ok) throw new Error(plain.error);
  expect(plain.value?.config).toEqual({ engine: "claude", model: "opus", effort: "high" });
  const edited = resolveSpawnRole({ role: "visual-critic", model: "fable", effort: "max" });
  if (!edited.ok) throw new Error(edited.error);
  expect(edited.value?.config).toEqual({ engine: "claude", model: "fable", effort: "max" });
  expect(resolveSpawnRole({ role: "visual-critic", engine: "codex", model: "gpt-6.1-sol", effort: "high" })).toEqual({ ok: false, error: "visual-critic runs on claude only" });
  expect(resolveRole("visual-critic", {}, { engine: "codex", model: "gpt-6.1-sol" })).toEqual({ ok: false, error: "visual-critic runs on claude only" });
  const architect = resolveSpawnRole({ role: "architect", engine: "codex", model: "gpt-6.1-sol" });
  expect(architect.ok && architect.value?.config.engine).toBe("codex");
});

const correctionInstruction = OPERATOR_CORRECTION_RULE;

test("every role receives the correction duty, including stored scaffold overrides", () => {
  for (const definition of listRoles()) {
    const params = Object.fromEntries(definition.parameters.map(parameter => [parameter.key, defaultRoleParameterValue(parameter)]));
    for (const source of [definition, { ...definition, promptScaffold: "A stored role scaffold." }]) {
      const scaffold = roleScaffoldBody(source, params);
      const prompt = roleSpawnPrompt({ role: source.id, scaffold }, "Handle the operator message.");
      expect(prompt.split(correctionInstruction)).toHaveLength(2);
    }
  }
});
