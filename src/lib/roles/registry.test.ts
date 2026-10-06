import { expect, test } from "bun:test";

import { BUILDER_FINISH_LINE, FIX_ROUND_FINISH_LINE, ISSUE_REPORT_SCRUB_RULE, PROCESS_CLEANUP_MARKER, VISUAL_CRITIC_CLASSES } from "./defaults";
import { defaultRoleParameterValue } from "./parameters";
import { variantForParams } from "./paramConfig";
import { ORCHESTRATOR_TASK_OWNERSHIP_HEADING } from "@/lib/orchestrator/prompt";

import { APPLY_FIXES_GUIDANCE, listRoles, resolveRole, resolveSpawnRole, roleFenceBlock, roleScaffoldBody, roleSpawnPrompt, SPAWN_COMPLETION } from "./registry";

test("merger resolves a required reviewed-PR list with a read-write, non-nesting profile", () => {
  expect(resolveRole("merger", {})).toMatchObject({ ok: false, error: "missing required role parameter: prs" });
  const resolved = resolveSpawnRole({ role: "merger", roleParams: { prs: "12@abcdef1,13@1234567" } });
  expect(resolved).toMatchObject({ ok: true });
  const role = resolveRole("merger", { prs: "12@abcdef1,13@1234567" });
  if (!role.ok) throw new Error(role.error);
  expect(role.value.config).toEqual({ engine: "codex", model: "gpt-6.1-sol", effort: "high" });
  expect(role.value.definition.capabilities).toEqual([]);
  expect(role.value.prompt).toContain("12@abcdef1,13@1234567");
  expect(role.value.prompt).toContain("Never judge your own resolution");
});

test("maintainer preserves review and release ownership and treats retired seats as history", () => {
  const resolved = resolveRole("maintainer");
  if (!resolved.ok) throw new Error(resolved.error);
  expect(resolved.value.prompt).toContain("A task with an open pull request stays assigned");
  expect(resolved.value.prompt).toContain("A release or deployment the orchestrator seat is carrying stays assigned");
  expect(resolved.value.prompt).toContain('status: "done", hide: true, board: "hidden"');
  expect(resolved.value.prompt).toContain("neither the current nor pending seat");
  expect(resolved.value.prompt).toContain("Never move a retired seat card to inbox");
  expect(resolved.value.prompt).toContain("Hide only a confirmed retired orchestrator seat card");
});

test("role registry exposes the twelve role ids and campaign-ready orchestrator config", () => {
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
  expect(orchestrator.ok && orchestrator.value.prompt).not.toMatch(/(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\]):\d+/);
  expect(orchestrator.ok && orchestrator.value.prompt).toContain("Repository: Latand/delegatus");
  expect(orchestrator.ok && orchestrator.value.prompt).toContain("Issue query: is:open");
  expect(orchestrator.ok && orchestrator.value.prompt).toContain("Urgent list: #35");

  expect(orchestrator.ok && orchestrator.value.prompt).toContain("Merge policy: pr\nCompletion policy: released");
  /* The merge policy yields to the project's merge setting, as the mandate's merge bar says. */
  expect(orchestrator.ok && orchestrator.value.prompt).toContain("The merge policy applies only where the project's merge setting allows a merge");

  /* The backlog-campaign lines render only in that mode, even with values, so
     none of them reads as a standing rule elsewhere (agent-prompt-contract.md
     N6); the worker cap holds in every mode. */
  for (const params of [{}, { mode: "standard", repo: "owner/repo", mergePolicy: "merge" }]) {
    const standard = resolveRole("orchestrator", params);
    if (!standard.ok) throw new Error(standard.error);
    for (const label of ["Repository:", "Issue query:", "Urgent list:", "Merge policy:", "Completion policy:"]) expect(standard.value.prompt).not.toContain(label);
    expect(standard.value.prompt).toContain("In every mode, keep at most 3 workers running at once");
    expect(standard.value.prompt).not.toContain("Backlog campaign:");
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
  expect(frontend.ok && frontend.value.prompt).toContain("UI/frontend implementation guidance");
  expect(frontend.ok && frontend.value.prompt).toContain("add no new colour, font, pill or card shape");
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
    error: "unknown role: no-such-role (allowed: orchestrator, reviewer, verifier, builder, architect, cleaner, prod-auditor, deployer, merger, maintainer, issue-reporter, visual-critic)",
  });
});

test("the reviewer scaffold runs the project's own checks, and a cross-engine inherited model is rejected", () => {
  const reviewer = resolveRole("reviewer", { diffSource: "origin/main...HEAD", lens: "all" });
  expect(reviewer.ok && reviewer.value.prompt).toContain("Run the project's own checks for what the change touches");
  expect(reviewer.ok && reviewer.value.prompt).toContain("Change under review: origin/main...HEAD");
  expect(reviewer.ok && reviewer.value.prompt).toContain("how to show it fails");

  expect(resolveSpawnRole({ role: "builder", roleParams: { mode: "plain" }, engine: "claude" })).toEqual({
    ok: false,
    error: "model is required when overriding a role engine",
  });
});

/* #1428 — pipeline stages inherit the role scaffold, so one sentence here reaches
   every builder, reviewer and architect stage without each spec restating it. */
test("builder, reviewer and architect scaffolds send the seat to search prior conversations first", () => {
  const resolved = [
    resolveRole("builder", { mode: "plain" }),
    resolveRole("reviewer", { diffSource: "origin/main...HEAD", lens: "all" }),
    resolveRole("architect", { mode: "design" }),
  ];
  for (const role of resolved) {
    if (!role.ok) throw new Error(role.error);
    expect(role.value.prompt).toContain("search_transcripts");
    expect(role.value.prompt).toContain("conversation_messages");
  }
});

/* #1770 — a stage cleaned up its probe servers by port and killed an unrelated
   local server. The standing rule reaches every seat and every pipeline stage
   only if every registry role renders it, so assert the whole registry. */
test("every registry role scaffold carries the process-cleanup rule", () => {
  const roles = listRoles();
  expect(roles.length).toBe(12);
  for (const definition of roles) {
    /* The renderer both the spawn path and the pipeline stage lookup call, so
       a role whose required params are unset (a stage resolves them to registry
       defaults) is covered the same way a spawn is. */
    const params = Object.fromEntries(definition.parameters.map((parameter) => [parameter.key, defaultRoleParameterValue(parameter)]));
    const rendered = roleScaffoldBody(definition, params);
    expect(rendered).toContain(PROCESS_CLEANUP_MARKER);
    expect(rendered).toContain("pkill");
    expect(rendered).toContain("port 0");
  }
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
    error: "invalid claude model id \"mythos-1\"; valid claude model ids: opus, fable, sonnet, claude-sonnet-5-5, haiku",
  });
});

test("orchestrator spawn defaults omitted maxWorkers to three and preserves explicit one", () => {
  const omitted = resolveSpawnRole({ role: "orchestrator" });
  if (!omitted.ok || !omitted.value) throw new Error("expected resolved orchestrator role");
  expect(omitted.value.scaffold).toContain("keep at most 3 workers running at once");

  const explicit = resolveSpawnRole({ role: "orchestrator", roleParams: { maxWorkers: 1 } });
  if (!explicit.ok || !explicit.value) throw new Error("expected resolved orchestrator role");
  expect(explicit.value.scaffold).toContain("keep at most 1 workers running at once");
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
  expect(trivialFrontend.ok && trivialFrontend.value.prompt).toContain("UI/frontend implementation guidance");
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

/* The contract every scaffold carries (§2.5, §2.6): the shared rules, no
   stack, no product-internal names, and no completion marker, since the
   stage wrapper or the spawn line states the one way to end. */
const STACK_SPECIFIC = [/\btsc\b/, /bunx/, /TypeScript/, /blue\/green/i, /external-worker/, /conveyor/i, /8898/, /Ukrainian/, /review flow/i, /file ownership/, /read wrapper/];

test("every role scaffold carries the shared rules and names no stack or retired marker", () => {
  for (const definition of listRoles()) {
    const body = roleScaffoldBody(definition, { mode: definition.id === "builder" ? "apply-fixes" : "", domain: "frontend" }) + roleFenceBlock(definition);
    for (const pattern of STACK_SPECIFIC) expect(body).not.toMatch(pattern);
    for (const marker of ["REVIEW_READY", "VERDICT", "NO FINDINGS", "APPROVE", "COMMENT"]) expect(body).not.toContain(marker);
    expect(body).toContain(PROCESS_CLEANUP_MARKER);
    if (definition.id === "orchestrator") continue;
    expect(body).toContain("search_transcripts");
    expect(body).toContain("finish with needs_decision");
    expect(body).toContain("When a check needs access this session lacks");
    /* Review of #2301 (C3): a criterion that cannot be judged is needs_decision
       whoever holds the access, as human in the loop says for a rate limit. */
    expect(body).toContain("cannot be judged without it, whoever could supply the access");
    expect(body).not.toContain("and the operator can supply it");
    expect(body).toContain("The project's own rules govern the work");
  }
});

/* Review of #2301: every combination of claim labels about finished work
   maps to one verdict. */
test("the verifier names a verdict for every combination of claim labels", () => {
  const verifier = resolveRole("verifier", { claims: "the export keeps every row" });
  if (!verifier.ok) throw new Error(verifier.error);
  expect(verifier.value.prompt).toContain("the verdict is fail when any claim is WRONG (each one a finding), needs_decision when none is WRONG and any is UNCONFIRMED, and pass only when every claim is CONFIRMED.");
});

/* Review of #2301: a deployer's stop for approval is needs_decision, so the ask
   sweep surfaces it, and a prod-auditor passes on a gap only when no access
   would close it (the missing-access rule). */
test("the deployer and the prod-auditor name their verdicts", () => {
  const deployer = resolveRole("deployer", { sha: "a".repeat(40) });
  const auditor = resolveRole("prod-auditor", { questions: "Which jobs failed last night?" });
  if (!deployer.ok || !auditor.ok) throw new Error("role did not resolve");
  expect(deployer.value.prompt).toContain("Verdict: needs_decision when you stop for approval");
  expect(auditor.value.prompt).toContain("a stated gap that no access would close; needs_decision when access you lack would answer one");
});

/* §3 (a): a fix round tells a light fixer to fix only what names its place
   and hand anything else back as fail. */
test("a builder fix round carries the apply-fixes guidance", () => {
  const fix = resolveRole("builder", { mode: "apply-fixes" });
  const plain = resolveRole("builder", { mode: "plain" });
  if (!fix.ok || !plain.ok) throw new Error("builder did not resolve");
  expect(fix.value.prompt).toContain(APPLY_FIXES_GUIDANCE);
  expect(plain.value.prompt).not.toContain("Apply-fixes guidance");
  /* Review of #2301: one finish line, scoped to the findings; the reviewer
     judges the lane against the pinned specification. */
  expect(fix.value.prompt.split("You are done when")).toHaveLength(2);
  expect(fix.value.prompt).toContain(FIX_ROUND_FINISH_LINE);
  expect(fix.value.prompt).not.toContain(BUILDER_FINISH_LINE);
  expect(plain.value.prompt).toContain(BUILDER_FINISH_LINE);
});

test.each(["general", "frontend", "docs"])("%s fixers repair their own discoveries and leave grading to reviewers", (domain) => {
  const fix = resolveRole("builder", { mode: "apply-fixes", domain });
  if (!fix.ok) throw new Error("builder did not resolve");
  expect(fix.value.prompt).toContain("Fix every handed finding and anything you notice yourself within the pinned specification");
  expect(fix.value.prompt).toContain("Do not grade your own work");
  expect(fix.value.prompt).toContain("Return fail only when you are blocked");
  expect(fix.value.prompt).toContain("Set blocked:true only when you cannot proceed");
  expect(fix.value.prompt).toContain("blockedReason");
  expect(fix.value.prompt).not.toContain("using Blocked: in the summary");
  expect(fix.value.prompt).toContain("Notes");
  expect(fix.value.prompt).not.toContain("Review your own diff before you finish");
  expect(fix.value.prompt).not.toContain("finish with fail so the orchestrator can re-plan");
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
  expect(child).toContain("finish with needs_decision");
  expect(child).not.toContain(SPAWN_COMPLETION);
  expect(roleSpawnPrompt(null, "Just this.")).toBe("Just this.");
  expect(SPAWN_COMPLETION).toContain("Verdict: pass, Verdict: fail or Verdict: needs_decision");
});

/* #2518: the reporter is read-only, cannot publish, and carries the scrub
   rules in the words the issue lists them. */
test("the issue-reporter preset is read-only, previews and never publishes, and states every scrub rule", () => {
  const resolved = resolveRole("issue-reporter", {});
  if (!resolved.ok) throw new Error(resolved.error);
  expect(resolved.value.definition.capabilities).toEqual(["read-only"]);
  const text = resolved.value.prompt;
  expect(text).toContain(ISSUE_REPORT_SCRUB_RULE);
  for (const rule of [
    "hostnames", "domains", "IP addresses", "ports", "local paths", "usernames", "account names", "emails",
    "project or repository names other than Delegatus", "conversation, task or pipeline ids", "people's names", "secrets",
    "usage or plan data", "quotes from the operator's conversations",
  ]) expect(ISSUE_REPORT_SCRUB_RULE).toContain(rule);
  expect(ISSUE_REPORT_SCRUB_RULE).toContain("a screenshot may follow once the operator has redacted it");
  for (const section of ["Symptom", "Observed evidence", "Impact", "Expected behaviour", "Suggested investigation"]) expect(text).toContain(section);
  expect(text).toContain("Search the open issues of Delegatus's own repository");
  expect(text).toContain('Call issue_report with action "hints"');
  expect(text).toContain('Call issue_report with action "preview"');
  for (const rule of ["Re-read the whole text yourself", "make your own privacy judgment", "a hint may be a false alarm", "a clean result proves nothing", "removed", "harmlessHints", "uncertainties", "compact list beside the text", "operator decides last"]) expect(text).toContain(rule);
  expect(text).not.toContain("until it answers a digest");
  expect(text).toContain("You never publish.");
  expect(text).toContain("no edits, staging, commits, pushes, service restarts, forge comments or issues");
  expect(text).toContain("the only write is issue_report with action preview");
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
  const text = resolved.value.prompt;
  expect(text).toStartWith("You are a Visual-critic.");
  expect(text).toContain("Do not review code, tests or architecture.");
  expect(text).toContain(VISUAL_CRITIC_CLASSES);
  for (const surface of [
    "src/components/kanban/kanbanBoard.browser.test.tsx",
    "src/components/conversation/conversationWindow.browser.test.tsx",
    "src/components/mobile/issue1671Evidence.browser.test.tsx",
    "scripts/capture-board-geometry.ts",
  ]) expect(text).toContain(surface);
  for (const frame of ["1440x900", "1000x700", "390 px", "en and uk", "light and dark", "an export of the head", "isolated state"]) expect(text).toContain(frame);
  for (const kind of ["misalignment", "clipping", "overlap", "cramped or uneven spacing", "wrong emphasis", "inconsistent colours or sizes", "visual noise", "ids", "paths", "counters", "debug detail"]) expect(VISUAL_CRITIC_CLASSES).toContain(kind);
  expect(text).toContain("each naming the frames it shows in");
  expect(text).toContain("Verdict: pass when you find nothing");
  expect(text).toContain("Close every browser you start, by the PID you recorded");
  expect(text).toContain("Every finding names the frames it shows in");
});
