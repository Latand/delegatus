import { expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { realExec } from "@/lib/workflows/provision";
import { agentPublicationIdentityEnv } from "@/lib/git/agentPublicationIdentity";
import { prepareStageGitGuard, stageGitReceiptDirectory } from "@/lib/git/stageAttemptGuard";
import { releaseStages } from "@/lib/release/stages";
import { assignPipelineDelivery, buildPipeline, savePipelines } from "./store";
import { pipelineRoleLookup } from "./roles";
import { buildReleaseTagPolicy } from "./releaseTagPolicy";
import type { PipelineRoleId, PipelineStageAttempt } from "./types";
import { accountManager } from "@/lib/accounts/manager";
import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { OPERATOR_PAUSE_RESUME_ACTOR } from "@/lib/pauseResumeActor";
import { statePath } from "@/lib/configDir";
import { FORGE_APP_REPOSITORIES_FILE } from "@/lib/git/agentForgeCredentials";
import { FORGE_PUSH_BASE } from "../../../bin/forge-app-token.mjs";

const NOW = "2026-10-20T10:00:00.000Z";
let next = 0;
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "release-tag-"));
  const id = `release-tag-${++next}`;
  const lane = path.join(root, `repo-pipeline-${id}`), remote = path.join(root, "origin.git");
  const source: NodeJS.ProcessEnv = { ...process.env, HOME: root,
    GIT_CONFIG_COUNT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "no-config"),
    GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: ["noreply", "example.invalid"].join("@"), GIT_COMMITTER_EMAIL: ["noreply", "example.invalid"].join("@"),
    GIT_AUTHOR_DATE: NOW, GIT_COMMITTER_DATE: NOW };
  for (const key of Object.keys(source)) if (key.startsWith("LLV_STAGE_GIT_") || /^GIT_CONFIG_(KEY|VALUE)_/.test(key)) delete source[key];
  let env = source;
  const run = async (cwd: string, args: string[], environment = env) => realExec("git", args, cwd, environment);
  const git = async (...args: string[]) => { const r = await run(lane, args); expect(r.code, r.stderr).toBe(0); return r.stdout.trim(); };
  await fs.mkdir(lane);
  const bare = await run(root, ["init", "--bare", "--initial-branch=main", remote]);
  expect(bare.code, bare.stderr).toBe(0);
  await git("init", "--initial-branch=main");
  await git("config", "commit.gpgSign", "false");
  await git("commit", "--allow-empty", "-m", "base");
  const ancestor = await git("rev-parse", "HEAD");
  await fs.writeFile(path.join(lane, "package.json"), JSON.stringify({ version: "1.2.3" }));
  await git("add", "package.json");
  await git("commit", "-m", "release version");
  const head = await git("rev-parse", "HEAD");
  await git("remote", "add", "origin", remote);
  await git("push", "origin", "HEAD:refs/heads/main");
  const { normalizeStages } = await import("./engine");
  const normalized = normalizeStages(releaseStages({ cut: ancestor, lastTag: "v1.2.2", changes: [], askBeforePublish: true }), pipelineRoleLookup);
  expect(normalized.error).toBeUndefined();
  const stages = normalized.stages!;
  const pipeline = buildPipeline({ id, task: "Release", project: "fixture", repoDir: path.join(root, "repo"),
    stages, srcPath: null, srcConversationId: null, now: NOW });
  pipeline.lastPassedCommit = head;
  pipeline.publishedCommit = head;
  const review = pipeline.stages.find(item => item.id === "review")!;
  const reviewedAttempt: PipelineStageAttempt = { n: 1, state: "passed", effectiveRole: review.effectiveRole,
    launchId: null, conversationId: null, sessionId: null, agentPath: null, paneId: null, flowId: null,
    startedAt: NOW, completedAt: NOW, input: null, activatedBy: null, output: null, verdict: null, error: null,
    outputBaseHead: head };
  pipeline.runs.find(run => run.stageId === review.id)!.attempts.push(reviewedAttempt);
  assignPipelineDelivery(pipeline, { repository: "fixture", remote, branch: "refs/heads/main" }, false, () => null);
  const stage = pipeline.stages.at(-1)!;
  const acceptFix = () => {
    reviewedAttempt.state = "failed"; reviewedAttempt.budgetSpent = true;
    const fix = structuredClone(reviewedAttempt);
    fix.state = "passed"; delete fix.budgetSpent; delete fix.outputBaseHead;
    fix.effectiveRole = pipeline.stages.find(item => item.id === "fix")!.effectiveRole;
    fix.activatedBy = { stageId: "review", attempt: 1, edge: "fail", budgetSpent: true };
    pipeline.runs.find(run => run.stageId === "fix")!.attempts.push(fix);
    pipeline.cursor = { stageId: "publish", state: "pending", input: null, activatedBy: { stageId: "fix", attempt: 1, edge: "pass" } };
    pipeline.publishedCommit = null;
    return fix;
  };
  const receipts: string[] = [];
  const bind = async (restart = false) => {
    const launch = `${pipeline.id}-attempt-${receipts.length + 1}`;
    receipts.push(stageGitReceiptDirectory(launch));
    if (restart) {
      // Rebuild the policy in a fresh process, as a restarted controller does.
      const child = Bun.spawn([process.execPath, "--eval", `
        const {prepareStageGitGuard}=await import("./src/lib/git/stageAttemptGuard.ts");
        const {buildReleaseTagPolicy}=await import("./src/lib/pipelines/releaseTagPolicy.ts");
        const {realExec}=await import("./src/lib/workflows/provision.ts");
        const p=JSON.parse(process.env.RELEASE_PIPELINE);
        await prepareStageGitGuard(process.env.RELEASE_LAUNCH,p.worktreeDir,realExec,${JSON.stringify(NOW)},async()=>{},buildReleaseTagPolicy(p,p.stages.at(-1)));
      `], { cwd: process.cwd(), env: { ...source, RELEASE_PIPELINE: JSON.stringify(pipeline), RELEASE_LAUNCH: launch }, stdout: "pipe", stderr: "pipe" });
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
      expect(code, stderr).toBe(0);
    } else await prepareStageGitGuard(launch, lane, realExec, NOW, async () => {}, buildReleaseTagPolicy(pipeline, stage));
    env = { ...source, LLV_STAGE_GIT_RECEIPT: receipts.at(-1)!, LLV_STAGE_GIT_WORKTREE: lane };
    env = { ...env, ...agentPublicationIdentityEnv(env) };
  };
  const tag = (target = head, name = "v1.2.3") => git("tag", "-a", name, target, "-m", `Release ${name}`);
  const push = (...args: string[]) => run(lane, ["push", ...args]);
  const close = async () => { for (const receipt of receipts) await fs.rm(receipt, { recursive: true, force: true }); await fs.rm(root, { recursive: true, force: true }); };
  return { root, lane, remote, source, pipeline, stage, reviewedAttempt, acceptFix, ancestor, head, bind, git, run, tag, push, close, environment: () => env };
}

test.each([false, true])("publishes exactly the annotated release tag; prior-attempt tag=%s", async retry => {
  const f = await fixture();
  try {
    await f.bind();
    await f.tag();
    const object = await f.git("rev-parse", "refs/tags/v1.2.3");
    if (retry) { f.pipeline.publishedCommit = null; await f.bind(true); }
    // Preserve argv and stdin for the repository's own publication hook.
    await fs.mkdir(path.join(f.lane, ".git/hooks"), { recursive: true });
    await fs.writeFile(path.join(f.lane, ".git/hooks/pre-push"), '#!/bin/sh\nprintf "%s\\n" "$@" > .git/forwarded-args\ncat > .git/forwarded-input\n', { mode: 0o700 });
    const pushed = await f.push("origin", "refs/tags/v1.2.3");
    expect(pushed.code, pushed.stderr).toBe(0);
    expect((await f.run(f.remote, ["rev-parse", "refs/tags/v1.2.3"])).stdout.trim()).toBe(object);
    expect((await f.run(f.remote, ["rev-parse", "refs/heads/main"])).stdout.trim()).toBe(f.head);
    expect(await fs.readFile(path.join(f.lane, ".git/forwarded-args"), "utf8")).toBe(`origin\n${f.remote}\n`);
    expect(await fs.readFile(path.join(f.lane, ".git/forwarded-input"), "utf8")).toBe(`refs/tags/v1.2.3 ${object} refs/tags/v1.2.3 ${"0".repeat(40)}\n`);
  } finally { await f.close(); }
});

test.each([false, true])("publishes a controller-accepted review/fix checkpoint; retry=%s", async retry => {
  const f = await fixture();
  try {
    f.acceptFix();
    await f.bind(); await f.tag();
    if (retry) await f.bind(true);
    const result = await f.push("origin", "refs/tags/v1.2.3");
    expect(result.code, result.stderr).toBe(0);
    expect((await f.run(f.remote, ["rev-parse", "refs/tags/v1.2.3^{}"])).stdout.trim()).toBe(f.head);
  } finally { await f.close(); }
});

// The production App shell adapter is disabled on Windows.
test.skipIf(process.platform === "win32").each(["bound", "other repository", "undeclared"])("release App transport: %s", async scenario => {
  const f = await fixture();
  const declaration = statePath(FORGE_APP_REPOSITORIES_FILE);
  const prior = await fs.readFile(declaration).catch(error => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  try {
    await fs.writeFile(declaration, JSON.stringify(scenario === "undeclared" ? [] : ["fixture/release"]));
    const canonical = "https://github.com/fixture/release.git";
    f.pipeline.delivery!.target.remote = canonical;
    await f.git("remote", "set-url", "origin", canonical);
    const nativeExecPath = await f.git("--exec-path");
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const shim = path.join(f.root, "transport");
    await fs.mkdir(shim);
    // The real Git client and production App wrapper retain the actual hook
    // URL. Only the wire peer is replaced by this fixture's receive/upload pack.
    await fs.writeFile(path.join(shim, "git-remote-https"), `#!/bin/sh
exec ${quote(path.join(nativeExecPath, "git-remote-ext"))} "$1" ${quote(`ext::${nativeExecPath}/%S ${f.remote}`)}
`, { mode: 0o700 });
    f.source.GIT_EXEC_PATH = shim;
    await f.bind(); await f.tag();
    await fs.mkdir(path.join(f.lane, ".git/hooks"), { recursive: true });
    await fs.writeFile(path.join(f.lane, ".git/hooks/pre-push"), '#!/bin/sh\nprintf "%s\\n" "$@" > .git/app-hook-args\ncat > /dev/null\n', { mode: 0o700 });
    const destination = scenario === "bound" ? "origin"
      : `${FORGE_PUSH_BASE}/fixture/${scenario === "undeclared" ? "release" : "elsewhere"}.git`;
    const result = await f.push(destination, "refs/tags/v1.2.3");
    if (scenario === "bound") {
      expect(result.code, result.stderr).toBe(0);
      expect(await fs.readFile(path.join(f.lane, ".git/app-hook-args"), "utf8")).toBe(`origin\n${FORGE_PUSH_BASE}/fixture/release.git\n`);
      expect((await f.run(f.remote, ["rev-parse", "refs/tags/v1.2.3^{}"], f.source)).stdout.trim()).toBe(f.head);
    } else {
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("destination differs from the delivery remote");
      expect((await f.run(f.remote, ["show-ref", "--tags"], f.source)).stdout).toBe("");
      expect(await fs.access(path.join(f.lane, ".git/app-hook-args")).then(() => true, () => false)).toBe(false);
    }
  } finally {
    if (prior) await fs.writeFile(declaration, prior); else await fs.rm(declaration, { force: true });
    await f.close();
  }
});

test.each(["failed", "activation mismatch", "cursor mismatch", "parked", "historical"])("refuses an unaccepted review/fix checkpoint: %s", async scenario => {
  const f = await fixture();
  try {
    const fix = f.acceptFix();
    if (scenario === "failed") fix.state = "failed";
    if (scenario === "activation mismatch") fix.activatedBy!.attempt = 2;
    if (scenario === "cursor mismatch") f.pipeline.cursor!.activatedBy!.attempt = 2;
    if (scenario === "parked") f.pipeline.stages.find(item => item.id === "review")!.onFail!.onExhausted = "park";
    if (scenario === "historical") fix.historical = true;
    await f.bind(); await f.tag();
    const denied = await f.push("origin", "refs/tags/v1.2.3");
    expect(denied.code).not.toBe(0);
    expect(denied.stderr).toContain("accepted review checkpoint");
    expect((await f.run(f.remote, ["show-ref", "--tags"])).stdout).toBe("");
  } finally { await f.close(); }
});

test("a retained successful review uses its controller checkpoint when it has no head envelope", async () => {
  const f = await fixture();
  try {
    delete f.reviewedAttempt.outputBaseHead;
    f.pipeline.cursor = { stageId: "publish", state: "pending", input: null, activatedBy: { stageId: "review", attempt: 1, edge: "pass" } };
    f.pipeline.publishedCommit = null;
    await f.bind(); await f.tag();
    const pushed = await f.push("origin", "refs/tags/v1.2.3");
    expect(pushed.code, pushed.stderr).toBe(0);
  } finally { await f.close(); }
});

test.each(["matching", "stale head", "other review", "other attempt"])("explicit controller head acceptance is bound to the release: %s", async scenario => {
  const f = await fixture();
  try {
    f.acceptFix();
    f.pipeline.stages.find(item => item.id === "review")!.onFail!.onExhausted = "park";
    f.pipeline.reviewAcceptances = [{ clientRequestId: "fixture-head-acceptance", expectedRevision: "fixture-revision",
      stageId: scenario === "other review" ? "another-review" : "review", attempt: scenario === "other attempt" ? 2 : 1,
      fixStageId: "fix", fixAttempt: 1, reviewedHead: f.ancestor, currentHead: scenario === "stale head" ? f.ancestor : f.head,
      actor: OPERATOR_PAUSE_RESUME_ACTOR, at: NOW }];
    await f.bind(); await f.tag();
    const result = await f.push("origin", "refs/tags/v1.2.3");
    if (scenario === "matching") expect(result.code, result.stderr).toBe(0);
    else { expect(result.code).not.toBe(0); expect(result.stderr).toContain("accepted review checkpoint"); }
  } finally { await f.close(); }
});

test.each(["deployer", "builder", "read-only"])("the production spawn adapter binds the actual host role before native dispatch: %s", async kind => {
  const f = await fixture();
  const registry = new AgentRegistry(path.join(f.root, "registry.json"));
  const clientModule = await import("@/lib/runtime/client");
  const spawnModule = await import("@/lib/runtime/structuredSpawn");
  const { defaultPipelinePorts } = await import("./engine");
  const resolve = spyOn(accountManager, "resolveProjectSpawn").mockReturnValue({ kind: "available", account: {
    engine: "codex", accountId: "fixture", kind: "managed", home: f.root, transcriptRoot: f.root, env: f.source,
  }});
  const client = spyOn(clientModule, "runtimeHostClient").mockReturnValue({} as never);
  let dispatched = false;
  const role = structuredClone(f.stage.effectiveRole);
  if (kind === "builder") role.roleId = "builder";
  if (kind === "read-only") role.access = "read-only";
  let receipt: string | undefined;
  const spawn = spyOn(spawnModule, "spawnStructuredConversation").mockImplementation(async input => {
    receipt = input.account.env.LLV_STAGE_GIT_RECEIPT;
    expect(receipt).toBeDefined();
    const env = { ...input.account.env, ...agentPublicationIdentityEnv(input.account.env) };
    const pushed = await f.run(f.lane, ["push", "origin", "refs/tags/v1.2.3"], env);
    if (kind === "deployer") expect(pushed.code, pushed.stderr).toBe(0);
    else { expect(pushed.code).not.toBe(0); expect(pushed.stderr).toContain("tag publication requires a release-mode deployer stage"); }
    dispatched = true;
    return { path: null } as never;
  });
  setAgentRegistryForTests(registry);
  try {
    await f.tag();
    savePipelines([f.pipeline]);
    await defaultPipelinePorts().spawnAgent({
      role, runtimeProfile: { access: role.access, sandbox: "full" }, cwd: f.lane,
      project: f.pipeline.project, requestedAccountId: null, title: "Release", prompt: "Release", parentPath: null,
      clientAttemptId: "release-native-dispatch", creatorConversationId: null,
      membership: { kind: "pipeline", containerId: f.pipeline.id, role: role.roleId!, slot: "publish:1", stageId: "publish", stageOrder: 6, round: 1, parentConversationId: null },
    }, async () => {});
    expect(dispatched).toBe(true);
    if (kind === "deployer") expect((await f.run(f.remote, ["rev-parse", "refs/tags/v1.2.3^{}"])).stdout.trim()).toBe(f.head);
    else expect((await f.run(f.remote, ["show-ref", "--tags"])).stdout).toBe("");
  } finally {
    resolve.mockRestore(); client.mockRestore(); spawn.mockRestore(); setAgentRegistryForTests(null); registry.close();
    savePipelines([]);
    if (receipt) await fs.rm(receipt, { recursive: true, force: true });
    await f.close();
  }
});

test.each(["unchanged", "head", "owner"] as const)("rechecks custody after the remote read: %s", async change => {
  const f = await fixture();
  let ready!: () => void, release!: () => void;
  const arrived = new Promise<void>(resolve => { ready = resolve; });
  const held = new Promise<Response>(resolve => { release = () => resolve(new Response("ready")); });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { ready(); return held; } });
  let pending: ReturnType<typeof f.push> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await f.bind(); await f.tag();
    await fs.mkdir(path.join(f.lane, ".git/hooks"), { recursive: true });
    const forwarded = path.join(f.lane, ".git/release-hook-observed");
    await fs.writeFile(path.join(f.lane, ".git/hooks/pre-push"), '#!/bin/sh\n: > .git/release-hook-observed\ncat > /dev/null\n', { mode: 0o700 });
    const shim = path.join(f.root, "shim");
    await fs.mkdir(shim);
    const nativeGit = Bun.which("git")!;
    await fs.writeFile(path.join(shim, "git"), `#!${process.execPath}
if (process.argv.includes("ls-remote")) await fetch(${JSON.stringify(server.url.href)});
const child=Bun.spawn([${JSON.stringify(nativeGit)},...process.argv.slice(2)],{stdin:"inherit",stdout:"inherit",stderr:"inherit"});
process.exit(await child.exited);
`, { mode: 0o700 });
    pending = f.run(f.lane, ["push", "origin", "refs/tags/v1.2.3"], { ...f.environment(), GIT_EXEC_PATH: shim,
      PATH: `${shim}${path.delimiter}${process.env.PATH}` });
    await Promise.race([arrived, pending.then(result => { throw new Error(`push ended before remote verification: ${result.stderr}`); }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("remote verification barrier not reached")), 15_000); })]);
    if (change === "head") await f.git("commit", "--allow-empty", "-m", "head moved during verification");
    if (change === "owner") await f.bind(true);
    release();
    const result = await pending;
    if (change === "unchanged") {
      expect(result.code, result.stderr).toBe(0);
      expect((await fs.stat(forwarded)).isFile()).toBe(true);
    }
    else {
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(change === "head" ? "HEAD changed during release publication verification" : "a successor owns this worktree");
      expect((await f.run(f.remote, ["show-ref", "--tags"], f.source)).stdout).toBe("");
      expect(await fs.access(forwarded).then(() => true, () => false)).toBe(false);
    }
  } finally {
    if (timer) clearTimeout(timer);
    release(); await pending; await server.stop(true); await f.close();
  }
});

test("release receipts replay unchanged and refuse a different policy for the same launch", async () => {
  const f = await fixture();
  try {
    await f.bind();
    const launch = `${f.pipeline.id}-attempt-1`;
    const file = path.join(stageGitReceiptDirectory(launch), "start.json");
    const before = await fs.readFile(file, "utf8");
    await prepareStageGitGuard(launch, f.lane, realExec, NOW, async () => {}, buildReleaseTagPolicy(f.pipeline, f.stage));
    expect(await fs.readFile(file, "utf8")).toBe(before);
    f.pipeline.publishedCommit = null;
    await prepareStageGitGuard(launch, f.lane, realExec, NOW, async () => {}, buildReleaseTagPolicy(f.pipeline, f.stage));
    expect(await fs.readFile(file, "utf8")).toBe(before);
    f.pipeline.delivery!.target.branch = "refs/heads/another-release";
    await expect(prepareStageGitGuard(launch, f.lane, realExec, NOW, async () => {}, buildReleaseTagPolicy(f.pipeline, f.stage)))
      .rejects.toThrow("release binding changed before dispatch");
    expect(await fs.readFile(file, "utf8")).toBe(before);
  } finally { await f.close(); }
});

test.each(["approved", "refused", "changed head", "successor"])("a rehost preserves the release binding after restart: %s", async scenario => {
  const f = await fixture();
  try {
    if (scenario === "refused") f.pipeline.delivery!.active = false;
    await f.bind(); await f.tag();
    const launch = `${f.pipeline.id}-attempt-1`;
    const file = path.join(stageGitReceiptDirectory(launch), "start.json");
    const before = await fs.readFile(file, "utf8");
    if (scenario === "changed head") await f.git("commit", "--allow-empty", "-m", "unreviewed rehost head");
    if (scenario === "successor") await f.bind(true);
    const child = Bun.spawn([process.execPath, "--eval", `
      const {restoreStageGitGuard}=await import("./src/lib/git/stageAttemptGuard.ts");
      const {realExec}=await import("./src/lib/workflows/provision.ts");
      process.stdout.write(JSON.stringify(await restoreStageGitGuard(process.env.RELEASE_LAUNCH,process.env.RELEASE_WORKTREE,realExec)));
    `], { cwd: process.cwd(), env: { ...f.source, RELEASE_LAUNCH: launch, RELEASE_WORKTREE: f.lane }, stdout: "pipe", stderr: "pipe" });
    const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(await fs.readFile(file, "utf8")).toBe(before);
    if (scenario === "successor") {
      expect(code).not.toBe(0);
      expect(error).toContain("superseded by another attempt");
    } else {
      expect(code, error).toBe(0);
      const restored = { ...f.source, ...JSON.parse(output) };
      const result = await f.run(f.lane, ["push", "origin", "refs/tags/v1.2.3"], { ...restored, ...agentPublicationIdentityEnv(restored) });
      if (scenario === "approved") {
        expect(result.code, result.stderr).toBe(0);
        expect((await f.run(f.remote, ["rev-parse", "refs/tags/v1.2.3^{}"], f.source)).stdout.trim()).toBe(f.head);
      } else {
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain(scenario === "refused" ? "active delivery owner" : "HEAD changed");
      }
    }
    if (scenario !== "approved") expect((await f.run(f.remote, ["show-ref", "--tags"], f.source)).stdout).toBe("");
  } finally { await f.close(); }
});

const refusals = [
  "wrong commit", "lightweight", "other version", "forged tag name", "commit source", "nested tag", "moved tag", "deleted tag", "branch", "mixed refs",
  "changed head", "changed publication", "unpublished head", "comparison", "disabled publication", "foreign remote", "foreign owner", "inactive delivery", "missing delivery",
  "no review", "failed review", "stale review", "historical review",
] as const;
const reasons: Record<typeof refusals[number], string> = {
  "wrong commit": "directly target the reviewed head", lightweight: "must be annotated", "other version": "only the approved release tag ref",
  "forged tag name": "must name the approved release", "commit source": "source must be the approved local tag ref",
  "nested tag": "directly target the reviewed head", "moved tag": "moving or replacing", "deleted tag": "deleting a release tag",
  branch: "branch pushes are forbidden", "mixed refs": "branch pushes are forbidden", "changed head": "HEAD changed",
  "changed publication": "delivery branch no longer names", "unpublished head": "delivery branch no longer names",
  comparison: "active delivery owner", "disabled publication": "active delivery owner", "foreign remote": "destination differs",
  "foreign owner": "active delivery owner", "inactive delivery": "active delivery owner", "missing delivery": "active delivery owner",
  "no review": "accepted review checkpoint", "failed review": "accepted review checkpoint", "stale review": "accepted review checkpoint", "historical review": "accepted review checkpoint",
};
test.each([...refusals])("release tag refuses %s without a remote change", async scenario => {
  const f = await fixture();
  try {
    let args = ["origin", "refs/tags/v1.2.3"];
    if (scenario === "moved tag" || scenario === "deleted tag") {
      await f.tag();
      expect((await f.push(...args)).code).toBe(0);
      await f.git("tag", "-d", "v1.2.3");
      if (scenario === "moved tag") { await f.git("tag", "-a", "v1.2.3", "-m", "replacement"); args.unshift("--force"); }
      else args = ["origin", ":refs/tags/v1.2.3"];
    } else if (scenario === "forged tag name") {
      await f.tag(f.head, "v9.9.9");
      await f.git("update-ref", "refs/tags/v1.2.3", await f.git("rev-parse", "refs/tags/v9.9.9"));
    } else if (scenario === "lightweight") await f.git("tag", "v1.2.3");
    else if (scenario === "nested tag") { await f.tag(f.head, "inner"); await f.tag("inner"); }
    else await f.tag(scenario === "wrong commit" ? f.ancestor : f.head, scenario === "other version" ? "v9.9.9" : "v1.2.3");
    if (scenario === "other version") args = ["origin", "refs/tags/v9.9.9"];
    if (scenario === "commit source") args = ["origin", "HEAD:refs/tags/v1.2.3"];
    if (scenario === "branch") args = ["origin", "HEAD:refs/heads/other"];
    if (scenario === "mixed refs") args.push("HEAD:refs/heads/other");
    if (scenario === "unpublished head") {
      f.pipeline.publishedCommit = null;
      expect((await f.run(f.remote, ["update-ref", "-d", "refs/heads/main"], f.source)).code).toBe(0);
    }
    if (scenario === "comparison") f.pipeline.delivery!.disposition = "comparison";
    if (scenario === "disabled publication") f.pipeline.delivery!.publish = "disabled";
    if (scenario === "foreign owner") f.pipeline.delivery!.ownerId = "another-lane";
    if (scenario === "inactive delivery") f.pipeline.delivery!.active = false;
    if (scenario === "missing delivery") delete f.pipeline.delivery;
    if (scenario === "no review") f.pipeline.runs.find(run => run.stageId === "review")!.attempts = [];
    if (scenario === "failed review") f.reviewedAttempt.state = "failed";
    if (scenario === "stale review") f.reviewedAttempt.outputBaseHead = f.ancestor;
    if (scenario === "historical review") f.reviewedAttempt.historical = true;
    await f.bind();
    if (scenario === "changed head") await f.git("commit", "--allow-empty", "-m", "unreviewed");
    if (scenario === "changed publication") expect((await f.run(f.remote, ["update-ref", "refs/heads/main", f.ancestor], f.source)).code).toBe(0);
    if (scenario === "foreign remote") {
      const other = path.join(f.root, "other.git");
      expect((await f.run(f.root, ["init", "--bare", other], f.source)).code).toBe(0);
      expect((await f.run(f.lane, ["push", other, "HEAD:refs/heads/main"], f.source)).code).toBe(0);
      args[0] = other;
    }
    const before = (await f.run(f.remote, ["show-ref"], f.source)).stdout;
    const denied = await f.push(...args);
    expect(denied.code).not.toBe(0);
    expect(denied.stderr).toContain("stage tag push refused:");
    expect(denied.stderr).toContain(reasons[scenario]);
    expect((await f.run(f.remote, ["show-ref"], f.source)).stdout).toBe(before);
  } finally { await f.close(); }
});

test.each(["missing", "malformed", "prerelease", "numeric"])("refuses an unapproved package version: %s", async version => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.lane, "package.json"), version === "malformed" ? "{" : JSON.stringify({
      ...(version === "missing" ? {} : { version: version === "numeric" ? 123 : "1.2.3-rc.1" }),
    }));
    await f.git("add", "package.json"); await f.git("commit", "-m", "invalid release version");
    f.pipeline.lastPassedCommit = await f.git("rev-parse", "HEAD");
    f.pipeline.publishedCommit = f.pipeline.lastPassedCommit;
    f.reviewedAttempt.outputBaseHead = f.pipeline.lastPassedCommit;
    expect((await f.push("origin", "HEAD:refs/heads/main")).code).toBe(0);
    await f.tag(f.pipeline.lastPassedCommit); await f.bind();
    const denied = await f.push("origin", "refs/tags/v1.2.3");
    expect(denied.code).not.toBe(0);
    expect(denied.stderr).toContain("reviewed commit with a stable package version");
    expect((await f.run(f.remote, ["show-ref", "--tags"])).stdout).toBe("");
  } finally { await f.close(); }
});

test.each(["builder", "reviewer", "verifier", "architect", "cleaner", "prod-auditor", "merger", "visual-critic", "orchestrator", "deploy", "missing mode",
  "legacy kind", "read-only", "declared role mismatch", "effective role mismatch"])("tag exception is unavailable to %s", async other => {
  const f = await fixture();
  try {
    if (other === "legacy kind") f.stage.kind = "review-loop";
    else if (other === "read-only") f.stage.effectiveRole.access = "read-only";
    else if (other === "declared role mismatch") f.stage.role!.roleId = "builder";
    else if (other === "effective role mismatch") f.stage.effectiveRole.roleId = "builder";
    else if (other === "deploy" || other === "missing mode") f.stage.role!.params = other === "deploy" ? { mode: "deploy" } : {};
    else { f.stage.role!.roleId = other as PipelineRoleId; f.stage.effectiveRole.roleId = other as PipelineRoleId; }
    await f.bind();
    await f.tag();
    const denied = await f.push("origin", "refs/tags/v1.2.3");
    expect(denied.code).not.toBe(0);
    expect(denied.stderr).toContain("tag publication requires a release-mode deployer stage");
    await f.git("tag", "-d", "v1.2.3"); await f.git("tag", "v1.2.3");
    const lightweight = await f.push("origin", "refs/tags/v1.2.3");
    expect(lightweight.code).not.toBe(0);
    expect(lightweight.stderr).toContain("tag publication requires a release-mode deployer stage");
    expect((await f.run(f.remote, ["show-ref", "--tags"])).stdout).toBe("");
  } finally { await f.close(); }
});
