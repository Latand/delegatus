import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";

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

const { accountManager } = await import("@/lib/accounts/manager");
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

const fixtureExec: PipelinePorts["exec"] = (command, args) => {
  if (command === "git" && args[0] === "remote" && args[1] === "get-url") {
    return { code: 2, stdout: "", stderr: "No such remote" };
  }
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
for (const dir of [OTHER_REPO, SHARED_REPO]) fs.mkdirSync(dir, { recursive: true });
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
    const created = await createPipelineFromRequest({ ...draft(), stages: [{ ...draft().stages[0]!, serviceTier: null }] }, ports, { allowOperatorDraftWithoutLineage: true });
    expect(created.pipeline?.stages[0]).toMatchObject({ serviceTier: null, effectiveRole: { serviceTier: "ultrafast", serviceTierSource: "role-default" } });
    const priority = await patchPipeline(created.pipeline!.id, { action: "override-stage", stageId: "build", serviceTier: "priority" }, ports);
    expect(priority.error).toBeUndefined();
    expect(priority.pipeline?.stages[0]).toMatchObject({ serviceTier: "priority", effectiveRole: { serviceTier: "priority", serviceTierSource: "explicit" } });
  } finally { resolve.mockRestore(); }
});
