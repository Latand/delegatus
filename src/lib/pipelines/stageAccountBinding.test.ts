import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";

/* Everything here runs against a throwaway state directory: pipelines, the
   binding record and the role registry all resolve inside this sandbox, and
   nothing in the suite launches a process or reaches a runtime host. */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stage-account-binding-"));
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
process.env.LLV_STRUCTURED_HOSTS = "0";
/* The account catalog the real resolution reads is derived from HOME, so
   every selector in this file must read this sandbox. */
process.env.HOME = path.join(sandbox, "home");
fs.mkdirSync(process.env.LLV_STATE_DIR, { recursive: true });
fs.mkdirSync(process.env.HOME, { recursive: true });
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

const { accountManager, ProjectAccountRefusedError } = await import("@/lib/accounts/manager");
const { createPipelineFromRequest, defaultPipelinePorts, patchPipeline } = await import("./engine");
const { loadPipelines, savePipelines } = await import("./store");
const { stageDigest } = await import("./stageDigest");
const { registerPipelineTick } = await import("./controllerSignal");
const { BINDINGS_SOURCE } = await import("@/lib/accounts/accountsStore");
const { clearAccountFixture, seedAccountSource } = await import("@/lib/accounts/accountsStoreFixture");
type PipelinePorts = import("./engine").PipelinePorts;

// Accepted live overrides must not start a controller with production ports.
const unregisterTick = registerPipelineTick(async () => {});
afterAll(unregisterTick);

const ATLAS = "project-atlas";
const RESERVED = "acct-reserved";
const SPARE = "acct-spare";
const REPO = path.join(sandbox, "repo");
fs.mkdirSync(REPO, { recursive: true });
const initRepository = (dir: string) => { fs.mkdirSync(dir, { recursive: true }); execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-q", "-m", "initial"], { cwd: dir }); };
initRepository(REPO);

const fixtureExec: PipelinePorts["exec"] = (command, args, cwd, env, options) => {
  if (command === "git" && args[0] === "remote" && args[1] === "get-url") {
    return { code: 2, stdout: "", stderr: "No such remote" };
  }
  /* The checkouts below are empty repositories with no remotes: every other
     read the engine makes of them is answered by git itself. */
  if (command === "git") return defaultPipelinePorts().exec(command, args, cwd, env, options);
  throw new Error(`unexpected fixture command: ${command} ${args.join(" ")}`);
};

function portsAllowing(allowed: string[] | null): PipelinePorts {
  return {
    ...defaultPipelinePorts(),
    exec: fixtureExec,
    preflightRepo: () => ({ ok: true, repoDir: REPO, gitCommonDir: path.join(REPO, ".git"), worktreeParent: sandbox }),
    projectForCwd: () => ATLAS,
    allowedAccountIds: () => allowed,
  };
}

/* Two projects with different allowed sets, so a draft can be moved between
   them: ATLAS reserves one account, NEBULA reserves the other. */
const NEBULA = "project-nebula";
const VEGA = "project-vega";
const OTHER_REPO = path.join(sandbox, "repo-other");
const SHARED_REPO = path.join(sandbox, "repo-shared");
for (const dir of [OTHER_REPO, SHARED_REPO]) initRepository(dir);
const PROJECT_BY_REPO: Record<string, string> = { [REPO]: ATLAS, [OTHER_REPO]: NEBULA, [SHARED_REPO]: VEGA };
const ALLOWED_BY_PROJECT: Record<string, string[]> = { [ATLAS]: [RESERVED], [NEBULA]: [SPARE], [VEGA]: [RESERVED, SPARE] };

function portsAcross(): PipelinePorts {
  return {
    ...defaultPipelinePorts(),
    exec: fixtureExec,
    preflightRepo: (repoDir: string) => ({ ok: true, repoDir, gitCommonDir: path.join(repoDir, ".git"), worktreeParent: sandbox }),
    projectForCwd: (cwd: string) => PROJECT_BY_REPO[cwd] ?? ATLAS,
    allowedAccountIds: (project: string) => ALLOWED_BY_PROJECT[project] ?? null,
  };
}

function draft(account?: string | null) {
  return {
    task: "Bind accounts to projects",
    repoDir: REPO,
    autoStart: false as const,
    stages: [{
      id: "build",
      kind: "run" as const,
      ["prompt"]: "Implement the scoped change",
      next: null,
      ...(account === undefined ? {} : { account }),
    }],
  };
}

beforeEach(() => {
  savePipelines([]);
  clearAccountFixture(BINDINGS_SOURCE);
});

test("a stage may name an account the project allows", async () => {
  const result = await createPipelineFromRequest(draft(RESERVED), portsAllowing([RESERVED, SPARE]), {
    allowOperatorDraftWithoutLineage: true,
  });
  expect(result.error).toBeUndefined();
  expect(result.pipeline?.project).toBe(ATLAS);
  expect(result.pipeline?.stages[0]?.account).toBe(RESERVED);
});

test("a stage naming an account outside the project's allowed set is refused, and names the allowed ones", async () => {
  const result = await createPipelineFromRequest(draft(SPARE), portsAllowing([RESERVED]), {
    allowOperatorDraftWithoutLineage: true,
  });
  expect(result.status).toBe(400);
  expect(result.error).toContain(SPARE);
  expect(result.error).toContain(RESERVED);
  expect(result.error).toContain(ATLAS);
  expect(result.violations?.[0]?.field).toBe("stages[0].account");
  /* Refused means nothing was stored: a plan that could never launch does not
     become a draft the operator has to clean up. */
  expect(result.pipeline).toBeUndefined();
});

test("an unbound project accepts any named account, exactly as before", async () => {
  const result = await createPipelineFromRequest(draft(SPARE), portsAllowing(null), {
    allowOperatorDraftWithoutLineage: true,
  });
  expect(result.error).toBeUndefined();
  expect(result.pipeline?.stages[0]?.account).toBe(SPARE);
});

test("a stage that names no account is untouched by the binding", async () => {
  const result = await createPipelineFromRequest(draft(), portsAllowing([RESERVED]), {
    allowOperatorDraftWithoutLineage: true,
  });
  expect(result.error).toBeUndefined();
  expect(result.pipeline?.stages[0]?.account).toBeUndefined();
});

test("override-stage pins an allowed account, refuses a forbidden one and clears the pin", async () => {
  const created = await createPipelineFromRequest(draft(), portsAllowing([RESERVED]), {
    allowOperatorDraftWithoutLineage: true,
  });
  const id = created.pipeline?.id;
  if (!id) throw new Error(`draft was not created: ${created.error}`);

  const pinned = await patchPipeline(id, { action: "override-stage", stageId: "build", account: RESERVED }, portsAllowing([RESERVED]));
  expect(pinned.error).toBeUndefined();
  expect(pinned.pipeline?.stages[0]?.account).toBe(RESERVED);

  const refused = await patchPipeline(id, { action: "override-stage", stageId: "build", account: SPARE }, portsAllowing([RESERVED]));
  expect(refused.status).toBe(409);
  expect(refused.error).toContain(SPARE);

  /* The refusal left the earlier pin standing rather than half-applying. */
  const afterRefusal = await patchPipeline(id, { action: "override-stage", stageId: "build", prompt: "unchanged pin probe" }, portsAllowing([RESERVED]));
  expect(afterRefusal.pipeline?.stages[0]?.account).toBe(RESERVED);

  const cleared = await patchPipeline(id, { action: "override-stage", stageId: "build", account: null }, portsAllowing([RESERVED]));
  expect(cleared.error).toBeUndefined();
  expect(cleared.pipeline?.stages[0]?.account).toBeUndefined();
});

async function tierOverrideFixture() {
  const { createManagedCodexAccount } = await import("@/lib/accounts/codex");
  const accountA = createManagedCodexAccount("account A");
  const accountB = createManagedCodexAccount("account B");
  for (const account of [accountA, accountB]) {
    fs.writeFileSync(path.join(account.home, "auth.json"), "{}");
    fs.writeFileSync(path.join(account.home, "models_cache.json"), JSON.stringify({
      models: [{ slug: "gpt-6.1-sol", service_tiers: [{ id: "priority" }, ...(account.id === accountB.id ? [{ id: "ultrafast" }] : [])] }, { slug: "gpt-6-luna", service_tiers: [{ id: "priority" }] }],
    }));
  }
  const ports = portsAllowing([accountA.id, accountB.id]);
  ports.engineReadiness = () => "connected";
  ports.conversationGeneration = () => null;
  seedAccountSource(BINDINGS_SOURCE, {
    schemaVersion: 1,
    bindings: [accountA, accountB].map(account => ({ engine: "codex", accountId: account.id, project: ATLAS, createdAt: ports.now() })),
  });
  const created = await createPipelineFromRequest({
    ...draft(accountA.id),
    stages: [{ ...draft(accountA.id).stages[0]!, engine: "codex", model: "gpt-6.1-sol", effort: "high", serviceTier: "priority" }],
  }, ports, { allowOperatorDraftWithoutLineage: true });
  if (!created.pipeline) throw new Error(`draft was not created: ${created.error}`);
  const pipeline = created.pipeline;
  const stage = pipeline.stages[0]!;
  const now = ports.now();
  // Seed a bound structured attempt without launching an agent or runtime host.
  pipeline.state = "running";
  pipeline.cursor = { stageId: stage.id, state: "running", input: null, activatedBy: null };
  pipeline.runs[0]!.attempts = [{
    n: 1, state: "running", effectiveRole: structuredClone(stage.effectiveRole),
    definition: { boundAt: now, stageDigest: stageDigest(stage), prompt: stage.prompt, account: accountA.id, role: null, sandbox: null, outputs: null },
    launchId: "tier-override-launch", conversationId: "tier-override-conversation", sessionId: "tier-override-session",
    agentPath: path.join(sandbox, "tier-override.jsonl"), paneId: null, accountId: accountA.id,
    usageLimitedAccounts: [], flowId: null, expectedReviewHeadSha: null, reviewHeadSha: null,
    startedAt: now, completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: null,
  }];
  savePipelines([pipeline]);
  return { id: pipeline.id, ports, accountA, accountB };
}


test("create names every evaluated account and alternative models when the stage model lacks the tier", async () => {
  const { ports, accountA, accountB } = await tierOverrideFixture();
  const stages = [{ ...draft().stages[0]!, engine: "codex" as const, model: "gpt-6-luna", effort: "high", serviceTier: "ultrafast" }];
  const result = await createPipelineFromRequest({ ...draft(), stages }, ports, { allowOperatorDraftWithoutLineage: true });
  expect(result.status).toBe(400);
  expect(result.error).toContain("serviceTier ultrafast for model gpt-6-luna");
  expect(result.error).toContain(`account "account A" (${accountA.id}): gpt-6-luna offered: priority`);
  expect(result.error).toContain(`account "account B" (${accountB.id}): gpt-6-luna offered: priority; ultrafast offered for other models on this account: gpt-6.1-sol`);
  const inherited = await createPipelineFromRequest({ ...draft(), stages: [{ ...draft().stages[0]!,
    role: { roleId: "builder", params: { mode: "apply-fixes" } }, serviceTier: "ultrafast",
  }] }, ports, { allowOperatorDraftWithoutLineage: true });
  expect(inherited.error).toBe(result.error);
  const accepted = await createPipelineFromRequest({ ...draft(), stages: [{ ...stages[0]!, model: "gpt-6.1-sol" }] }, ports, { allowOperatorDraftWithoutLineage: true });
  expect(accepted.error).toBeUndefined();
  expect(accepted.pipeline).toBeDefined();
});

test.each([["next attempt", undefined], ["apply now", true]] as const)("override-stage validates the tier against the requested account (%s)", async (_mode, applyNow) => {
  const { id, ports, accountA, accountB } = await tierOverrideFixture();
  const result = await patchPipeline(id, {
    action: "override-stage", stageId: "build", account: accountB.id, serviceTier: "ultrafast", applyNow,
  }, ports);
  expect(result.error).toBeUndefined();
  const stored = loadPipelines()[0]!;
  expect(stored.stages[0]).toMatchObject({ account: accountB.id, serviceTier: "ultrafast", effectiveRole: { serviceTier: "ultrafast" } });
  expect(stored.runs[0]!.attempts[0]).toMatchObject({ accountId: accountA.id, effectiveRole: { serviceTier: "priority" } });
  if (applyNow) expect(result.runtimeSwitch).toMatchObject({ phase: "requested", to: { accountId: accountB.id, accountPinned: true, serviceTier: "ultrafast" } });
  else expect(result.runtimeSwitch).toBeUndefined();
});

test.each([["next attempt", undefined], ["apply now", true]] as const)("override-stage tier-only changes keep the existing account pin (%s)", async (_mode, applyNow) => {
  const { id, ports, accountA, accountB } = await tierOverrideFixture();
  const before = structuredClone(loadPipelines()[0]);
  const result = await patchPipeline(id, {
    action: "override-stage", stageId: "build", serviceTier: "ultrafast", applyNow,
  }, ports);
  expect(result.status).toBe(400);
  expect(result.error).toContain(`pinned account "${accountA.id}"`);
  expect(result.error).toContain('account "account A"');
  expect(result.error).toContain("gpt-6.1-sol offered: priority");
  expect(result.error).not.toContain(accountB.id);
  expect(result.error).not.toContain("pool");
  expect(loadPipelines()[0]).toEqual(before);
});

test.each([["next attempt", undefined], ["apply now", true]] as const)("override-stage clearing the pin validates the tier against the project pool (%s)", async (_mode, applyNow) => {
  const { id, ports, accountA, accountB } = await tierOverrideFixture();
  const request = { action: "override-stage" as const, stageId: "build", account: null, serviceTier: "ultrafast", applyNow };
  const before = structuredClone(loadPipelines()[0]);
  ports.allowedAccountIds = () => [accountA.id];
  const refused = await patchPipeline(id, request, ports);
  expect(refused.status).toBe(400);
  expect(refused.error).toContain("offered: priority");
  expect(loadPipelines()[0]).toEqual(before);

  ports.allowedAccountIds = () => [accountA.id, accountB.id];
  const accepted = await patchPipeline(id, request, ports);
  expect(accepted.error).toBeUndefined();
  const stored = loadPipelines()[0]!;
  expect(stored.stages[0]?.account).toBeUndefined();
  expect(stored.stages[0]).toMatchObject({ serviceTier: "ultrafast", effectiveRole: { serviceTier: "ultrafast" } });
  if (applyNow) expect(accepted.runtimeSwitch).toMatchObject({ phase: "requested", to: { accountId: accountB.id, accountPinned: false, serviceTier: "ultrafast" } });
  else expect(accepted.runtimeSwitch).toBeUndefined();
});

test("clearing a live pin selects an account offering the requested tier through the real selector", async () => {
  const { id, ports, accountA, accountB } = await tierOverrideFixture();
  const preferred = ports.resolveProjectSpawn!("codex", { project: ATLAS, model: "gpt-6.1-sol", preferredId: accountA.id });
  expect(preferred.kind === "available" && preferred.account.accountId).toBe(accountA.id);

  const result = await patchPipeline(id, {
    action: "override-stage", stageId: "build", account: null, serviceTier: "ultrafast", applyNow: true,
  }, ports);
  expect(result.error).toBeUndefined();
  expect(result.runtimeSwitch?.to).toMatchObject({ accountId: accountB.id, accountPinned: false, serviceTier: "ultrafast" });
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.runtimeSwitches?.[0]?.to).toEqual(result.runtimeSwitch!.to);
});

test.each([
  ["role default", "one account"], ["role default", "both accounts"],
  ["retained explicit", "one account"], ["retained explicit", "both accounts"],
] as const)("apply now names the allowed tier scope after an unavailable real selection (%s, %s)", async (source, scope) => {
  const { id, ports, accountA, accountB } = await tierOverrideFixture();
  const catalogs = [accountA, accountB].map(account => ({ file: path.join(account.home, "models_cache.json"), content: fs.readFileSync(path.join(account.home, "models_cache.json")) }));
  try {
    ports.roleLookup = () => ({ engine: "codex", model: "gpt-6.1-sol", effort: "high", serviceTier: "ultrafast", promptScaffold: "Builder guidance" });
    const configured = await patchPipeline(id, {
      action: "override-stage", stageId: "build", account: null,
      ...(source === "role default" ? { role: { roleId: "builder", params: { mode: "apply-fixes" } } } : { serviceTier: "ultrafast" }),
    }, ports);
    expect(configured.error).toBeUndefined();
    expect(configured.pipeline!.stages[0]!.effectiveRole.serviceTierSource).toBe(source === "role default" ? "role-default" : "explicit");

    const accounts = scope === "one account" ? [accountA] : [accountA, accountB];
    ports.allowedAccountIds = () => accounts.map(account => account.id);
    seedAccountSource(BINDINGS_SOURCE, {
      schemaVersion: 1,
      bindings: accounts.map(account => ({ engine: "codex", accountId: account.id, project: ATLAS, createdAt: ports.now() })),
    });
    const catalog = (tiers: string[]) => JSON.stringify({ models: [
      { slug: "gpt-6.1-sol", service_tiers: tiers.map(tier => ({ id: tier })) },
      { slug: "gpt-6-astra", service_tiers: [{ id: "ultrafast" }] },
    ] });
    fs.writeFileSync(path.join(accountA.home, "models_cache.json"), catalog(["priority"]));
    if (scope === "both accounts") fs.writeFileSync(path.join(accountB.home, "models_cache.json"), catalog(["standard", "priority"]));
    const before = structuredClone(loadPipelines()[0]);
    const request = { action: "override-stage" as const, stageId: "build", ...(source === "role default" ? { effort: "xhigh" } : {}), applyNow: true };
    const refused = await patchPipeline(id, request, ports);
    expect(refused.status).toBe(409);
    expect(refused.error).toContain("serviceTier ultrafast for model gpt-6.1-sol; evaluated allowed accounts:");
    expect(refused.error).toContain(`account "account A" (${accountA.id}): gpt-6.1-sol offered: priority; ultrafast offered for other models on this account: gpt-6-astra`);
    if (scope === "both accounts") expect(refused.error).toContain(`account "account B" (${accountB.id}): gpt-6.1-sol offered: priority, standard; ultrafast offered for other models on this account: gpt-6-astra`);
    else expect(refused.error).not.toContain(accountB.id);
    expect(refused.runtimeSwitch).toBeUndefined();
    expect(loadPipelines()[0]).toEqual(before);

    fs.writeFileSync(path.join(accountA.home, "models_cache.json"), catalog(["priority", "ultrafast"]));
    const accepted = await patchPipeline(id, request, ports);
    expect(accepted.error).toBeUndefined();
    expect(accepted.runtimeSwitch?.to).toMatchObject({ accountId: accountA.id, accountPinned: false, model: "gpt-6.1-sol", effort: source === "role default" ? "xhigh" : "high", serviceTier: "ultrafast" });
  } finally {
    for (const { file, content } of catalogs) fs.writeFileSync(file, content);
  }
});

test.each(["unavailable", "exhausted"] as const)("apply now keeps the capacity refusal when an allowed account offers the tier (%s)", async kind => {
  const { id, ports, accountA, accountB } = await tierOverrideFixture();
  const configured = await patchPipeline(id, { action: "override-stage", stageId: "build", account: null, serviceTier: "ultrafast" }, ports);
  expect(configured.error).toBeUndefined();
  const before = structuredClone(loadPipelines()[0]);
  ports.resolveProjectSpawn = () => ({ kind, allowedAccountIds: [accountA.id, accountB.id], resetsAt: null });
  const result = await patchPipeline(id, { action: "override-stage", stageId: "build", effort: "xhigh", applyNow: true }, ports);
  expect(result.status).toBe(409);
  expect(result.error).toBe("no allowed target account is available");
  expect(result.runtimeSwitch).toBeUndefined();
  expect(loadPipelines()[0]).toEqual(before);
});

test.each(["unsupported", "unknown", "absent"] as const)("live tier validation refuses an unsafe selector result (%s)", async selection => {
  const { id, ports, accountA } = await tierOverrideFixture();
  const before = structuredClone(loadPipelines()[0]);
  const account = accountManager.resolveSpawn("codex", accountA.id);
  ports.resolveProjectSpawn = selection === "absent" ? undefined
    : () => ({ kind: "available", account: { ...account, accountId: selection === "unknown" ? "unknown-account" : accountA.id } });
  // The unknown result is allowed by the pool port but has no catalog evidence.
  if (selection === "unknown") ports.allowedAccountIds = () => null;
  const result = await patchPipeline(id, {
    action: "override-stage", stageId: "build", account: null, serviceTier: "ultrafast", applyNow: true,
  }, ports);
  expect(result.status).toBe(409);
  if (selection !== "unknown") {
    expect(result.error).toContain(`selected account "${accountA.id}"`);
    expect(result.error).toContain("gpt-6.1-sol offered: priority");
  }
  expect(result.runtimeSwitch).toBeUndefined();
  expect(loadPipelines()[0]).toEqual(before);
});

test.each([["next attempt", undefined], ["apply now", true]] as const)("account-only overrides validate the retained explicit tier (%s)", async (_mode, applyNow) => {
  const { id, ports, accountA, accountB } = await tierOverrideFixture();
  const configured = await patchPipeline(id, {
    action: "override-stage", stageId: "build", account: accountB.id, serviceTier: "ultrafast",
  }, ports);
  expect(configured.error).toBeUndefined();
  const before = structuredClone(loadPipelines()[0]);
  const result = await patchPipeline(id, {
    action: "override-stage", stageId: "build", account: accountA.id, applyNow,
  }, ports);
  expect(result.status).toBe(400);
  expect(result.error).toContain("offered: priority");
  expect(loadPipelines()[0]).toEqual(before);
});

test("add-stage refuses a stage whose account the project forbids", async () => {
  const created = await createPipelineFromRequest(draft(), portsAllowing([RESERVED]), {
    allowOperatorDraftWithoutLineage: true,
  });
  const id = created.pipeline?.id;
  if (!id) throw new Error(`draft was not created: ${created.error}`);

  const refused = await patchPipeline(id, {
    action: "add-stage",
    stage: { id: "verify", kind: "run", prompt: "Verify the change", next: null, account: SPARE },
  }, portsAllowing([RESERVED]));
  expect(refused.status).toBe(400);
  expect(refused.error).toContain(SPARE);

  const accepted = await patchPipeline(id, {
    action: "add-stage",
    stage: { id: "verify", kind: "run", prompt: "Verify the change", next: null, account: RESERVED },
  }, portsAllowing([RESERVED]));
  expect(accepted.error).toBeUndefined();
  expect(accepted.pipeline?.stages.map((stage) => stage.account)).toEqual([undefined, RESERVED]);
});

/* Moving a draft to another repository moves it to another PROJECT, and the
   allowed set travels with the project rather than with the plan. A pin that
   was legal where the draft was written can be illegal where it lands, so the
   same reading that refuses it at create runs again here — otherwise a draft
   the launch will only ever park becomes the operator's to discover later. */
test("update-draft re-reads the binding when a draft moves to another project", async () => {
  const created = await createPipelineFromRequest(draft(RESERVED), portsAcross(), {
    allowOperatorDraftWithoutLineage: true,
  });
  // A legacy draft has no delivery ownership; current claimed lanes cannot move repositories.
  if (created.pipeline) { delete created.pipeline.delivery; savePipelines([created.pipeline]); }
  const id = created.pipeline?.id;
  if (!id) throw new Error(`draft was not created: ${created.error}`);

  const refused = await patchPipeline(id, { action: "update-draft", repoDir: OTHER_REPO }, portsAcross());
  expect(refused.status).toBe(400);
  expect(refused.error).toContain(RESERVED);
  expect(refused.error).toContain(NEBULA);
  expect(refused.violations?.[0]?.field).toBe("stages[0].account");

  /* Refused means the move did not half-apply: the draft is still the project
     and repository it was, with the pin the binding there still allows. */
  const unmoved = await patchPipeline(id, { action: "update-draft", task: "Bind accounts to projects" }, portsAcross());
  expect(unmoved.pipeline?.project).toBe(ATLAS);
  expect(unmoved.pipeline?.repoDir).toBe(REPO);
  expect(unmoved.pipeline?.stages[0]?.account).toBe(RESERVED);
});

test("update-draft moves a draft whose pin the destination project allows", async () => {
  const created = await createPipelineFromRequest(draft(RESERVED), portsAcross(), {
    allowOperatorDraftWithoutLineage: true,
  });
  // A legacy draft has no delivery ownership; current claimed lanes cannot move repositories.
  if (created.pipeline) { delete created.pipeline.delivery; savePipelines([created.pipeline]); }
  const id = created.pipeline?.id;
  if (!id) throw new Error(`draft was not created: ${created.error}`);

  const moved = await patchPipeline(id, { action: "update-draft", repoDir: SHARED_REPO }, portsAcross());
  expect(moved.error).toBeUndefined();
  expect(moved.pipeline?.project).toBe(VEGA);
  expect(moved.pipeline?.stages[0]?.account).toBe(RESERVED);
});

/* A member's lane runs on an automatically chosen account where its project has
   no account list: nothing a member names is stored. The project stays free for
   the owner and for installation lanes, as the earlier tests show. */
describe("a lane bound to a member", () => {
  const WS = `w_${"e".repeat(32)}`;
  const COMET = "project-comet";
  const COMET_REPO = path.join(sandbox, "repo-comet");
  initRepository(COMET_REPO);
  const memberId = "m_lane_member";
  let principal: { memberId: string; workspaceId: string };

  const memberPorts = (): PipelinePorts => ({
    ...portsAcross(),
    preflightRepo: (repoDir: string) => ({ ok: true, repoDir, gitCommonDir: path.join(repoDir, ".git"), worktreeParent: sandbox }),
    projectForCwd: (cwd: string) => (cwd === COMET_REPO ? COMET : PROJECT_BY_REPO[cwd] ?? ATLAS),
    allowedAccountIds: (project: string) => (project === COMET ? null : project === ATLAS ? null : ALLOWED_BY_PROJECT[project] ?? null),
  });

  beforeEach(async () => {
    const { teamStore, resetTeamStoreForTests } = await import("@/lib/team/store");
    resetTeamStoreForTests();
    fs.rmSync(path.join(process.env.LLV_STATE_DIR!, "team"), { recursive: true, force: true });
    const { claimInstall } = await import("@/lib/team/members");
    const { createWorkspace } = await import("@/lib/team/workspaces");
    const store = teamStore();
    const owner = claimInstall(store, "Owner", { surface: "desktop", browser: "chrome" }).member;
    store.insertMember({ id: memberId, name: "Member", role: "member", status: "active", color: "teal", telegram: null,
      createdAt: new Date().toISOString(), createdBy: owner.id, revokedAt: null });
    createWorkspace(store, owner, { id: WS, name: "Alpha", projects: [ATLAS, VEGA, COMET] });
    store.putWorkspaceMember(WS, memberId, "member", owner.id, new Date().toISOString());
    principal = { memberId, workspaceId: WS };
  });
  afterAll(async () => { (await import("@/lib/team/store")).resetTeamStoreForTests(); });

  const create = (account: string | undefined, ports = memberPorts()) => createPipelineFromRequest(draft(account), ports, { workspace: principal, allowOperatorDraftWithoutLineage: true });

  test("create refuses a stage that names an account where the project has no account list, and stores nothing", async () => {
    const refused = await create(RESERVED);
    expect(refused.status).toBe(400);
    expect(refused.violations?.[0]?.field).toBe("stages[0].account");
    expect(refused.error).toContain("no ");
    expect(refused.pipeline).toBeUndefined();
    expect(loadPipelines()).toEqual([]);
    /* The same answer for an account that exists and one that never did. */
    const unknown = await create("acct-never-existed");
    expect(unknown.status).toBe(400);
    expect(unknown.violations?.[0]?.field).toBe("stages[0].account");
    expect(unknown.error?.replaceAll("acct-never-existed", RESERVED)).toBe(refused.error);
    /* A stage that names none is stored; so is a pin inside a set pool. */
    expect((await create(undefined)).pipeline?.workspace).toEqual(principal);
    expect((await createPipelineFromRequest({ ...draft(RESERVED), repoDir: SHARED_REPO }, memberPorts(), { workspace: principal, allowOperatorDraftWithoutLineage: true })).error).toBeUndefined();
  });

  test("add-stage and override-stage refuse a named account without a list and leave the lane as it was", async () => {
    const created = await create(undefined);
    const id = created.pipeline!.id;
    const added = await patchPipeline(id, { action: "add-stage", stage: { id: "verify", kind: "run", prompt: "Verify", next: null, account: RESERVED } }, memberPorts());
    expect(added.status).toBe(400);
    expect(added.violations?.[0]?.field).toMatch(/^stages\[\d+\]\.account$/);
    const overridden = await patchPipeline(id, { action: "override-stage", stageId: "build", account: RESERVED }, memberPorts());
    expect(overridden.status).toBe(400);
    expect(overridden.violations?.[0]?.field).toBe("stages[0].account");
    const stored = loadPipelines().find(pipeline => pipeline.id === id)!;
    expect(stored.stages.map(stage => [stage.id, stage.account])).toEqual([["build", undefined]]);
    /* Clearing a pin, and any other override, still work. */
    expect((await patchPipeline(id, { action: "override-stage", stageId: "build", account: null }, memberPorts())).error).toBeUndefined();
  });

  test("a service tier refusal names no account the member is not shown, whatever account the stage names, and the owner's still does", async () => {
    const { createManagedCodexAccount } = await import("@/lib/accounts/codex");
    const hidden = createManagedCodexAccount("Hidden Account Label");
    fs.writeFileSync(path.join(hidden.home, "auth.json"), "{}");
    fs.writeFileSync(path.join(hidden.home, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-5.6-terra", service_tiers: [] }] }));
    const request = (account?: string) => ({ ...draft(account), stages: [{ ...draft(account).stages[0]!, engine: "codex" as const, model: "gpt-5.6-terra", effort: "high", serviceTier: "priority" }] });
    const ports = { ...memberPorts(), engineReadiness: () => "connected" as const };
    const answers: string[] = [];
    for (const account of [undefined, hidden.id, "acct-never-existed"]) {
      const refused = await createPipelineFromRequest(request(account), ports, { workspace: principal, allowOperatorDraftWithoutLineage: true });
      expect(refused.status).toBe(400);
      expect(refused.pipeline).toBeUndefined();
      answers.push(refused.error ?? "");
      expect(refused.error).not.toContain(hidden.label);
    }
    /* Only the id the caller typed comes back; the stage that names none learns of no account. */
    expect(answers[0]).not.toContain(hidden.id);
    expect(answers[0]).toContain("no account offers serviceTier priority for model gpt-5.6-terra");
    /* An account that exists and one that never did get the same answer. */
    expect(answers[2]!.replaceAll("acct-never-existed", hidden.id)).toBe(answers[1]);
    expect(loadPipelines()).toEqual([]);
    /* The installation's own lane keeps the full diagnosis. */
    const owner = await createPipelineFromRequest(request(), ports, { allowOperatorDraftWithoutLineage: true });
    expect(owner.status).toBe(400);
    expect(owner.error).toContain(hidden.label);
  });

  test("a member who first edits a lane of the owner's cannot pin an account where the project has no list, and nothing is stored", async () => {
    const created = await createPipelineFromRequest(draft(), memberPorts(), { allowOperatorDraftWithoutLineage: true });
    expect(created.error).toBeUndefined();
    const id = created.pipeline!.id;
    expect(created.pipeline?.workspace).toBeUndefined();
    const before = JSON.stringify(loadPipelines().find(pipeline => pipeline.id === id));
    const added = await patchPipeline(id, { action: "add-stage", stage: { id: "verify", kind: "run", prompt: "Verify", next: null, account: RESERVED } }, memberPorts(), undefined, undefined, memberId);
    expect(added.status).toBe(400);
    const overridden = await patchPipeline(id, { action: "override-stage", stageId: "build", account: RESERVED }, memberPorts(), undefined, undefined, memberId);
    expect(overridden.status).toBe(400);
    const moved = await patchPipeline(id, { action: "update-draft", repoDir: COMET_REPO, stages: [{ ...draft(RESERVED).stages[0]! }] } as never, memberPorts(), undefined, undefined, memberId);
    expect(moved.error).toBeDefined();
    /* No pin, no principal, no partial change. */
    expect(JSON.stringify(loadPipelines().find(pipeline => pipeline.id === id))).toBe(before);
    /* The owner's own edit and a member's edit that names none still go through. */
    expect((await patchPipeline(id, { action: "override-stage", stageId: "build", account: RESERVED }, memberPorts())).error).toBeUndefined();
    expect((await patchPipeline(id, { action: "override-stage", stageId: "build", account: null }, memberPorts(), undefined, undefined, memberId)).error).toBeUndefined();
    expect(loadPipelines().find(pipeline => pipeline.id === id)?.workspace).toEqual(principal);
  });

  test("a member's first edit of an owner's lane may pin an account the project's list allows", async () => {
    const created = await createPipelineFromRequest({ ...draft(), repoDir: SHARED_REPO }, memberPorts(), { allowOperatorDraftWithoutLineage: true });
    const id = created.pipeline!.id;
    const edited = await patchPipeline(id, { action: "override-stage", stageId: "build", account: RESERVED }, memberPorts(), undefined, undefined, memberId);
    expect(edited.error).toBeUndefined();
    expect(loadPipelines().find(pipeline => pipeline.id === id)).toMatchObject({ workspace: principal, stages: [{ account: RESERVED }] });
  });

  test("a member's lane that kept a named account after its project's list was removed is refused at launch before any account is read", async () => {
    clearAccountFixture(BINDINGS_SOURCE);
    const resolve = spyOn(accountManager, "resolveProjectSpawn").mockImplementation(() => { throw new Error("ACCOUNT_RESOLVER_REACHED"); });
    try {
      const message = await defaultPipelinePorts().spawnAgent({ ...spawnInput(RESERVED), workspace: principal }, () => {}).then(() => "launched", (error: Error) => error.message);
      expect(message).toContain("no claude account list");
      expect(resolve).not.toHaveBeenCalled();
    } finally { resolve.mockRestore(); }
  });

  test("a member's lane whose list is removed while its account is being selected is refused before a reservation", async () => {
    const reservations: unknown[] = [];
    seedAccountSource(BINDINGS_SOURCE, { schemaVersion: 1, bindings: [{ engine: "claude", accountId: RESERVED, project: ATLAS, createdAt: new Date().toISOString() }] });
    const resolve = spyOn(accountManager, "resolveProjectSpawn").mockImplementation(() => {
      /* The list is removed while the account is being selected. */
      clearAccountFixture(BINDINGS_SOURCE);
      return { kind: "available", account: { accountId: RESERVED } } as never;
    });
    try {
      const message = await defaultPipelinePorts().spawnAgent({ ...spawnInput(RESERVED), workspace: principal }, (reservation) => { reservations.push(reservation); })
        .then(() => "launched", (error: Error) => error.message);
      expect(resolve).toHaveBeenCalled();
      expect(message).toContain("no claude account list");
      expect(reservations).toEqual([]);
    } finally { resolve.mockRestore(); }
  });

  test("a launch whose account Delegatus chose, and the owner's launch, still reach selection without a list", async () => {
    clearAccountFixture(BINDINGS_SOURCE);
    const resolve = spyOn(accountManager, "resolveProjectSpawn").mockImplementation(() => { throw new Error("ACCOUNT_RESOLVER_REACHED"); });
    try {
      for (const input of [{ ...spawnInput(RESERVED), workspace: principal, accountChosenAutomatically: true }, spawnInput(RESERVED)]) {
        const message = await defaultPipelinePorts().spawnAgent(input, () => {}).then(() => "launched", (error: Error) => error.message);
        expect(message).toBe("ACCOUNT_RESOLVER_REACHED");
      }
    } finally { resolve.mockRestore(); }
  });

  test("a member's automatic launch refused for capacity names no account or reset time of the unlisted pool, and the owner's refusal does", async () => {
    clearAccountFixture(BINDINGS_SOURCE);
    for (const kind of ["exhausted", "unavailable"] as const) {
      const resolve = spyOn(accountManager, "resolveProjectSpawn").mockImplementation(() => (kind === "exhausted"
        ? { kind, resetsAt: 1_900_000_000, allowedAccountIds: ["hidden-account-a", "hidden-account-b"] }
        : { kind, allowedAccountIds: ["hidden-account-a", "hidden-account-b"] }));
      try {
        const member = await defaultPipelinePorts().spawnAgent({ ...spawnInput(null), workspace: principal }, () => {}).then(() => "launched", (error: Error) => error.message);
        expect(member).toBe(`no claude account can take work for project ${ATLAS} right now`);
        const owner = await defaultPipelinePorts().spawnAgent(spawnInput(null), () => {}).then(() => "launched", (error: Error) => error.message);
        expect(owner).toContain("hidden-account-a");
      } finally { resolve.mockRestore(); }
    }
  });

  test("a member's stage that cannot get its service tier is refused at launch without naming an account, and the owner's launch names them", async () => {
    const { createManagedCodexAccount } = await import("@/lib/accounts/codex");
    const hidden = createManagedCodexAccount("Hidden Launch Label");
    fs.writeFileSync(path.join(hidden.home, "auth.json"), "{}");
    fs.writeFileSync(path.join(hidden.home, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-5.6-terra", service_tiers: [] }] }));
    clearAccountFixture(BINDINGS_SOURCE);
    const base = spawnInput(null);
    const input = { ...base, role: { ...base.role, engine: "codex" as const, model: "gpt-5.6-terra", effort: "high", serviceTier: "priority", serviceTierSource: "explicit" as const } };
    const memberError = await defaultPipelinePorts().spawnAgent({ ...input, workspace: principal, clientAttemptId: "member-tier-launch" }, () => {}).then(() => "", (error: Error) => error.message);
    expect(memberError).toBe("no account offers serviceTier priority for model gpt-5.6-terra");
    const ownerError = await defaultPipelinePorts().spawnAgent({ ...input, clientAttemptId: "owner-tier-launch" }, () => {}).then(() => "", (error: Error) => error.message);
    expect(ownerError).toContain(hidden.label);
  });

  test("moving a draft with a pinned account to a project without a list is refused and the draft stays", async () => {
    const created = await createPipelineFromRequest({ ...draft(RESERVED), repoDir: SHARED_REPO }, memberPorts(), { workspace: principal, allowOperatorDraftWithoutLineage: true });
    const id = created.pipeline!.id;
    const saved = loadPipelines()[0]!;
    delete saved.delivery; savePipelines([saved]);
    const moved = await patchPipeline(id, { action: "update-draft", repoDir: COMET_REPO }, memberPorts());
    expect(moved.status).toBe(400);
    expect(moved.violations?.[0]?.field).toBe("stages[0].account");
    expect(loadPipelines()[0]!.project).toBe(VEGA);
  });
});

/* The launch seam itself. A refusal here is what parks the stage with the
   reason on the record — the spawn never reaches a reservation, so nothing is
   launched on an account the project forbids. */
function spawnInput(account: string | null) {
  return {
    role: {
      roleId: "builder" as const,
      engine: "claude" as const,
      model: "claude-opus-5",
      effort: "xhigh",
      access: "read-write" as const,
      promptScaffold: "Builder guidance",
    },
    runtimeProfile: { access: "read-write" as const, sandbox: "full" as const },
    cwd: sandbox,
    project: ATLAS,
    requestedAccountId: account,
    title: "Bind accounts to projects · build",
    ["prompt"]: "Implement the scoped change",
    parentPath: null,
    clientAttemptId: "stage_account_binding_attempt",
    membership: {
      kind: "pipeline" as const,
      containerId: "pipeline-stage-account",
      role: "builder",
      slot: "build:1",
      stageId: "build",
      stageOrder: 0,
      round: 1,
      parentConversationId: null,
    },
    creatorConversationId: null,
  };
}

test("the launch refuses an account the project forbids, before any launch is reserved", async () => {
  const reservations: unknown[] = [];
  const resolve = spyOn(accountManager, "resolveProjectSpawn").mockImplementation(() => ({
    kind: "not_allowed",
    accountId: SPARE,
    allowedAccountIds: [RESERVED],
  }));
  try {
    await expect(defaultPipelinePorts().spawnAgent(spawnInput(SPARE), (reservation) => { reservations.push(reservation); }))
      .rejects.toThrow(`claude account ${SPARE} is not allowed on project ${ATLAS} (allowed claude accounts: ${RESERVED})`);
    /* The stage's own model rides along (#1796): capacity is judged on the
       window that model's tier draws on, not on some other tier's. */
    expect(resolve.mock.calls[0]?.[1]).toEqual({ project: ATLAS, requestedId: SPARE, model: "claude-opus-5" });
    expect(reservations).toEqual([]);
  } finally {
    resolve.mockRestore();
  }
});

test("every allowed account out of capacity is reported as capacity, not solved by crossing the boundary", async () => {
  const resetsAt = Math.floor(Date.parse("2026-08-30T11:00:00.000Z") / 1_000);
  const resolve = spyOn(accountManager, "resolveProjectSpawn").mockImplementation(() => ({
    kind: "exhausted",
    resetsAt,
    allowedAccountIds: [RESERVED],
  }));
  try {
    await expect(defaultPipelinePorts().spawnAgent(spawnInput(null), () => {}))
      .rejects.toThrow(`no allowed claude account has capacity for project ${ATLAS} (allowed claude accounts: ${RESERVED}); resetsAt=2026-08-30T11:00:00.000Z`);
  } finally {
    resolve.mockRestore();
  }
});

test("a damaged binding record parks the stage instead of launching it on any account", async () => {
  /* The real project resolution reads the record on disk. An unreadable record
     must refuse the launch rather than answer "this project is unbound" and hand the stage
     whichever account the engine happens to be pointing at. */
  seedAccountSource(BINDINGS_SOURCE, { schemaVersion: 1, bindings: [{ engine: "claude" }] });
  const reservations: unknown[] = [];
  try {
    await expect(defaultPipelinePorts().spawnAgent(spawnInput(RESERVED), (reservation) => { reservations.push(reservation); }))
      .rejects.toThrow(/account-project-bindings\.json is unreadable/);
    /* Nothing was reserved, so the parked stage retries cleanly once the
       operator repairs or removes the record. */
    expect(reservations).toEqual([]);
    await expect(defaultPipelinePorts().spawnAgent(spawnInput(null), () => {}))
      .rejects.toThrow(/is unreadable/);
  } finally {
    clearAccountFixture(BINDINGS_SOURCE);
  }
});

test("a damaged binding record answers create and override with the same conflict the launch gives", async () => {
  /* The read throws so nothing can mistake a damaged record for an unbound
     project, and here that throw has to become an ANSWER. Propagated, it is a
     500 on a request nothing is wrong with; the state is what needs repair, so
     it is the same 409 — with the same wording — the launch, the reseat and the
     binding route give, and one repair clears all of them. */
  const realPorts: PipelinePorts = {
    ...defaultPipelinePorts(),
    exec: fixtureExec,
    preflightRepo: () => ({ ok: true, repoDir: REPO, gitCommonDir: path.join(REPO, ".git"), worktreeParent: sandbox }),
    projectForCwd: () => ATLAS,
  };

  /* Stored while the record is readable, so the override below has a draft. */
  const stored = await createPipelineFromRequest(draft(RESERVED), portsAllowing(null), {
    allowOperatorDraftWithoutLineage: true,
  });
  expect(stored.pipeline).toBeDefined();

  seedAccountSource(BINDINGS_SOURCE, { schemaVersion: 1, bindings: [{ engine: "claude" }] });
  try {
    const created = await createPipelineFromRequest(draft(RESERVED), realPorts, {
      allowOperatorDraftWithoutLineage: true,
    });
    expect(created.status).toBe(409);
    expect(created.error).toMatch(/account-project-bindings\.json is unreadable/);
    expect(created.pipeline).toBeUndefined();

    const overridden = await patchPipeline(stored.pipeline!.id, {
      action: "override-stage",
      stageId: "build",
      account: SPARE,
    }, realPorts);
    expect(overridden.status).toBe(409);
    expect(overridden.error).toMatch(/account-project-bindings\.json is unreadable/);
    /* Refused means unchanged: the pin the draft already carries is still the
       one on record. */
    expect(overridden.pipeline?.stages[0]?.account ?? stored.pipeline!.stages[0]?.account).toBe(RESERVED);

    /* A plan that names no account never reads the record at all, so a damaged
       one cannot block work that was never fenced by it. */
    const unpinned = await createPipelineFromRequest(draft(), realPorts, {
      allowOperatorDraftWithoutLineage: true,
    });
    expect(unpinned.error).toBeUndefined();
    expect(unpinned.pipeline).toBeDefined();
  } finally {
    clearAccountFixture(BINDINGS_SOURCE);
  }
});

test("stage tier narrows selection and the durable launch profile; role fallback is explicit", async () => {
  const { createManagedCodexAccount, listCodexAccounts } = await import("@/lib/accounts/codex");
  const { agentRegistry } = await import("@/lib/agent/registry");
  const accountA = createManagedCodexAccount("account A");
  const accountB = createManagedCodexAccount("account B");
  for (const account of [accountA, accountB]) {
    fs.writeFileSync(path.join(account.home, "auth.json"), "{}");
    fs.writeFileSync(path.join(account.home, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-6-astra", service_tiers: [{ id: "priority" }, ...(account.id === accountB.id ? [{ id: "ultrafast" }] : [])] }, { slug: "gpt-6-luna", service_tiers: [{ id: "priority" }] }] }));
  }
  const input = { ...spawnInput(null), role: { ...spawnInput(null).role, engine: "codex" as const, model: "gpt-6-astra", effort: "high", serviceTier: "ultrafast", serviceTierSource: "explicit" as "explicit" | "role-default" }, clientAttemptId: "tier-stage-required" };
  const reserved: string[] = [];
  const resolve = spyOn(accountManager, "resolveProjectSpawn").mockImplementation(() => ({ kind: "available", account: accountManager.resolveSpawn("codex", accountB.id) }));
  try {
    // Stop at the missing sandbox runtime after reservation; no host is started.
    await expect(defaultPipelinePorts().spawnAgent(input, reservation => { reserved.push(reservation.launchId); })).rejects.toThrow("runtime host");
    expect(resolve.mock.calls[0]?.[1]?.unavailableIds).toEqual(listCodexAccounts().filter(account => account.id !== accountB.id).map(account => account.id));
    expect(agentRegistry().readOnlySnapshot().receipts[reserved[0]!]!.launchProfile).toMatchObject({ serviceTier: "ultrafast", fast: true });
    const count = reserved.length;
    await expect(defaultPipelinePorts().spawnAgent({ ...input, requestedAccountId: accountA.id }, reservation => { reserved.push(reservation.launchId); })).rejects.toThrow(`pinned account "${accountA.id}": account "account A" (${accountA.id}): gpt-6-astra offered: priority`);
    await expect(defaultPipelinePorts().spawnAgent({ ...input, role: { ...input.role, model: "gpt-6-luna" }, requestedAccountId: accountB.id }, () => {})).rejects.toThrow("gpt-6-luna offered: priority; ultrafast offered for other models on this account: gpt-6-astra");
    expect(reserved).toHaveLength(count);
    // Exhausted preferred pool retries the same project without the tier exclusion.
    resolve.mockImplementationOnce(() => ({ kind: "unavailable", allowedAccountIds: [accountA.id, accountB.id] }))
      .mockImplementation(() => ({ kind: "available", account: accountManager.resolveSpawn("codex", accountA.id) }));
    await expect(defaultPipelinePorts().spawnAgent({ ...input, role: { ...input.role, serviceTierSource: "role-default" }, clientAttemptId: "tier-stage-preferred" }, reservation => { reserved.push(reservation.launchId); })).rejects.toThrow("runtime host");
    expect(agentRegistry().readOnlySnapshot().receipts[reserved.at(-1)!]!.launchProfile.serviceTier).toBeNull();
    expect(resolve.mock.calls.at(-1)?.[1]?.unavailableIds).toEqual([]);
    const ports = portsAllowing(null);
    ports.roleLookup = () => ({ engine: "codex", model: "gpt-6-astra", effort: "high", serviceTier: "ultrafast", promptScaffold: "Reviewer guidance" });
    const created = await createPipelineFromRequest({ ...draft(), stages: [{ ...draft().stages[0]!, engine: "codex", model: "gpt-6-astra", effort: "high", serviceTier: null, preferredServiceTier: "ultrafast" }] }, ports, { allowOperatorDraftWithoutLineage: true });
    expect(created.pipeline?.stages[0]).toMatchObject({ serviceTier: null, preferredServiceTier: "ultrafast", effectiveRole: { serviceTier: "ultrafast", serviceTierSource: "role-default", preferredServiceTier: "ultrafast" } });
    const priority = await patchPipeline(created.pipeline!.id, { action: "override-stage", stageId: "build", serviceTier: "priority" }, ports);
    expect(priority.error).toBeUndefined();
    expect(priority.pipeline?.stages[0]).toMatchObject({ serviceTier: "priority", preferredServiceTier: "ultrafast", effectiveRole: { serviceTier: "priority", serviceTierSource: "explicit", preferredServiceTier: "ultrafast" } });
    const model = await patchPipeline(created.pipeline!.id, { action: "override-stage", stageId: "build", model: "gpt-6-luna" }, ports);
    expect(model.error).toBeUndefined();
    const effort = await patchPipeline(created.pipeline!.id, { action: "override-stage", stageId: "build", effort: "xhigh" }, ports);
    expect(effort.error).toBeUndefined();
    expect(loadPipelines().find(pipeline => pipeline.id === created.pipeline!.id)?.stages[0]).toMatchObject({
      model: "gpt-6-luna", effort: "xhigh", preferredServiceTier: "ultrafast",
      effectiveRole: { model: "gpt-6-luna", effort: "xhigh", preferredServiceTier: "ultrafast" },
    });
  } finally { resolve.mockRestore(); }
});

test("create_pipeline accepts ultrafast from an allowed legacy model catalogue", async () => {
  const { accountA, accountB, ports } = await tierOverrideFixture();
  fs.writeFileSync(path.join(accountB.home, "models_cache.json"), JSON.stringify({ models: [
    { slug: "gpt-6.1-sol", additional_speed_tiers: ["fast", "ultrafast"] },
  ] }));
  const result = await createPipelineFromRequest({ ...draft(accountB.id), stages: [{
    ...draft(accountB.id).stages[0]!, engine: "codex", model: "gpt-6.1-sol", effort: "high", serviceTier: "ultrafast",
  }] }, ports, { allowOperatorDraftWithoutLineage: true });
  expect(result.error).toBeUndefined();
  expect(result.pipeline?.stages[0]?.effectiveRole.serviceTier).toBe("ultrafast");
  expect(result.pipeline?.stages[0]?.account).not.toBe(accountA.id);
});

test("automatic ultrafast launch falls back to available priority inside the allowed pool", async () => {
  const { createManagedCodexAccount, listCodexAccounts } = await import("@/lib/accounts/codex");
  const { agentRegistry } = await import("@/lib/agent/registry");
  const { selectProjectAccount } = await import("@/lib/accounts/projectSelection");
  const accountA = createManagedCodexAccount("priority account");
  const accountB = createManagedCodexAccount("exhausted ultrafast account");
  const excluded = createManagedCodexAccount("excluded ultrafast account");
  for (const [account, tiers] of [[accountA, ["priority"]], [accountB, ["ultrafast"]], [excluded, ["ultrafast"]]] as const) {
    fs.writeFileSync(path.join(account.home, "auth.json"), "{}");
    fs.writeFileSync(path.join(account.home, "models_cache.json"), JSON.stringify({ models: [{
      slug: "gpt-6.1-sol", service_tiers: tiers.map(id => ({ id })),
    }] }));
  }
  const ports = portsAllowing([accountA.id, accountB.id]);
  const now = Date.now();
  seedAccountSource(BINDINGS_SOURCE, { schemaVersion: 1, bindings: [accountA, accountB].map(account => ({
    engine: "codex", accountId: account.id, project: ATLAS, createdAt: new Date(now).toISOString(),
  })) });
  const accounts = listCodexAccounts().map(account => ({ id: account.id, authPresent: true }));
  const observations = [accountA, accountB, excluded].map(account => ({ engine: "codex" as const, accountId: account.id,
    authenticated: true, authCheckedAt: new Date(now).toISOString(), observedAt: new Date(now).toISOString(), bootId: "tier-fallback",
    provenance: { source: "live" as const, reason: null, staleSince: null },
    limits: { session: null, weekly: { usedPercent: account.id === accountB.id ? 100 : 25, resetsAt: now / 1000 + 86400 },
      plan: "pro", capturedAt: now / 1000, credits: { hasCredits: true, balance: "10", unlimited: false } },
  }));
  const resolve = spyOn(accountManager, "resolveProjectSpawn").mockImplementation((engine, request) => {
    const selected = selectProjectAccount({ ...request, engine, accounts, observations, now,
      bindings: [accountA, accountB].map(account => ({ engine: "codex" as const, accountId: account.id, project: ATLAS, createdAt: new Date(now).toISOString() })) });
    return selected.kind === "available"
      ? { kind: "available", account: accountManager.resolveSpawn("codex", selected.accountId) }
      : selected;
  });
  const reserved: string[] = [];
  const input = { ...spawnInput(null), role: { ...spawnInput(null).role, engine: "codex" as const, model: "gpt-6.1-sol",
    effort: "high", serviceTier: "ultrafast", serviceTierSource: "role-default" as const,
    preferredServiceTier: "ultrafast" }, requireAccountCapacity: true };
  try {
    await expect(defaultPipelinePorts().spawnAgent(input, reservation => { reserved.push(reservation.launchId); })).rejects.toThrow("runtime host");
    expect(resolve.mock.calls).toHaveLength(2);
    expect(resolve.mock.calls[0]?.[1]?.unavailableIds).toContain(accountA.id);
    expect(resolve.mock.calls[0]?.[1]?.unavailableIds).not.toContain(excluded.id);
    expect(resolve.mock.calls[1]?.[1]?.unavailableIds).toContain(accountB.id);
    expect(resolve.mock.calls[1]?.[1]?.unavailableIds).not.toContain(excluded.id);
    const receipt = agentRegistry().readOnlySnapshot().receipts[reserved[0]!]!;
    expect(receipt.accountId).toBe(accountA.id);
    expect(receipt.launchProfile).toMatchObject({ serviceTier: "priority", fast: true });
    expect(receipt.launchProfile).not.toMatchObject({ serviceTier: "ultrafast" });

    resolve.mockClear();
    await expect(defaultPipelinePorts().spawnAgent({ ...input, unavailableAccountIds: [accountB.id], clientAttemptId: "quota-excluded-ultrafast" }, reservation => { reserved.push(reservation.launchId); })).rejects.toThrow("runtime host");
    expect(resolve.mock.calls).toHaveLength(2);
    expect(resolve.mock.calls[0]?.[1]?.unavailableIds).toContain(accountB.id);
    const quotaFallbackReceipt = agentRegistry().readOnlySnapshot().receipts[reserved.at(-1)!]!;
    expect(quotaFallbackReceipt.accountId).toBe(accountA.id);
    expect(quotaFallbackReceipt.launchProfile.serviceTier).toBe("priority");

    resolve.mockClear();
    observations.find(item => item.accountId === accountA.id)!.limits!.weekly!.usedPercent = 100;
    const reservedCount = reserved.length;
    await expect(defaultPipelinePorts().spawnAgent({ ...input, clientAttemptId: "priority-exhausted" }, () => {}))
      .rejects.toThrow(ProjectAccountRefusedError);
    expect(resolve.mock.calls).toHaveLength(2);
    expect(resolve.mock.calls[1]?.[1]?.model).toBe("gpt-6.1-sol");
    expect(reserved).toHaveLength(reservedCount);

    resolve.mockClear();
    observations.find(item => item.accountId === accountA.id)!.limits!.weekly!.usedPercent = 25;
    fs.writeFileSync(path.join(accountA.home, "models_cache.json"), JSON.stringify({ models: [{
      slug: "gpt-6.1-sol", service_tiers: [],
    }] }));
    await expect(defaultPipelinePorts().spawnAgent({ ...input, clientAttemptId: "standard-fallback" }, reservation => { reserved.push(reservation.launchId); }))
      .rejects.toThrow("runtime host");
    expect(resolve.mock.calls).toHaveLength(2);
    expect(resolve.mock.calls[1]?.[1]?.unavailableIds).toEqual([]);
    const standardReceipt = agentRegistry().readOnlySnapshot().receipts[reserved.at(-1)!]!;
    expect(standardReceipt.accountId).toBe(accountA.id);
    expect(standardReceipt.launchProfile.serviceTier).toBe("standard");
  } finally { resolve.mockRestore(); clearAccountFixture(BINDINGS_SOURCE); }
});
