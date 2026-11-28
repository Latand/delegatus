import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { realExec } from "@/lib/workflows/provision";
import { projectIdentityFromRemote } from "@/lib/projects/identity";
import { settleStageAttemptPush } from "./stageAttemptPush";
import { commitAndAdoptStageBranch } from "./stageBranch";
import type { PipelineStageAttempt } from "./types";
import { NOW, fixture } from "./stageAttemptPush.fixture";

// A refresh starts from reviewed lane work; the remote merge has no stage receipt.
async function foreignIntegration(local: boolean) {
  const f = await fixture();
  f.pipeline.delivery!.target.repository = projectIdentityFromRemote("https://github.com/example/project.git", f.lane)!.project;
  await fs.writeFile(path.join(f.lane, "lane.txt"), "reviewed content\n");
  await f.own("add", "lane.txt");
  const reviewed = await f.commit("reviewed lane work"); await f.push();
  f.pipeline.lastPassedCommit = reviewed;
  const startFile = path.join(f.receipt, "start.json");
  await fs.writeFile(startFile, JSON.stringify({ ...JSON.parse(await fs.readFile(startFile, "utf8")), head: reviewed }));
  await fs.rm(path.join(f.receipt, "commits", reviewed));
  await fs.rm(path.join(f.receipt, "pushes", reviewed));
  await fs.writeFile(path.join(f.foreign, "main.txt"), "main content\n");
  await f.git(f.foreign, "add", "main.txt");
  await f.git(f.foreign, "commit", "-m", "advance main");
  await f.git(f.foreign, "push", "origin", "main");
  await f.git(f.foreign, "fetch", "origin", "pipeline/proof");
  await f.git(f.foreign, "checkout", "-b", "pipeline/proof", reviewed);
  await f.git(f.foreign, "merge", "--no-ff", "-m", "foreign clean integration", "main");
  const head = await f.git(f.foreign, "rev-parse", "HEAD");
  await f.git(f.foreign, "push", "origin", "HEAD:refs/heads/pipeline/proof");
  if (local) {
    await f.own("fetch", "origin", "pipeline/proof");
    await f.own("merge", "--ff-only", "FETCH_HEAD");
  }
  const checks: { headRefOid: string; baseRefName: string; state: string; isDraft: boolean;
    statusCheckRollup: Array<Record<string, unknown>> } = { headRefOid: head, baseRefName: "main", state: "OPEN", isDraft: false,
    statusCheckRollup: [{ __typename: "StatusContext", context: "ci", state: "SUCCESS" }] };
  let required: unknown = { protected: true, protection: { required_status_checks: { contexts: ["ci"] } } };
  let checkPages: { nodes: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }[] = [
    { nodes: [{ __typename: "StatusContext", context: "ci", state: "SUCCESS", createdAt: "2026-10-16T10:01:00Z" }],
      pageInfo: { hasNextPage: false, endCursor: null } },
  ];
  let checksCode = 0;
  const commands: string[][] = [];
  const exec: typeof realExec = async (command, args, cwd, env, options) => {
    commands.push([command, ...args]);
    if (command === "git" && args.slice(0, 3).join(" ") === "remote get-url --push"
      && args[3] === f.pipeline.delivery?.target.remote) {
      return { code: 0, stdout: "https://github.com/example/project.git\n", stderr: "" };
    }
    if (command === "git" && args[0] === "remote" && args[1] === "get-url") {
      return { code: 0, stdout: "https://github.com/example/project.git\n", stderr: "" };
    }
    if (command === "gh") {
      if (args[0] === "api" && args.includes("graphql")) {
        const after = args.find(part => part.startsWith("endCursor="))?.slice("endCursor=".length);
        const index = after === undefined ? 0 : checkPages.findIndex(page => page.pageInfo.endCursor === after) + 1;
        const page = checkPages[index];
        return { code: checksCode, stdout: JSON.stringify(page ?? { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }) + "\n", stderr: "" };
      }
      return { code: checksCode, stdout: JSON.stringify(args[0] === "api" ? required : checks), stderr: "" };
    }
    if (command === "git" && args[0] === "ls-remote" && args[2] === "https://github.com/example/project.git") {
      return realExec(command, [args[0]!, args[1]!, f.remote, ...args.slice(3)], cwd, env, options);
    }
    if (command === "git" && args[0] === "fetch" && args[2] === "https://github.com/example/project.git") {
      return realExec(command, [args[0]!, args[1]!, f.remote, ...args.slice(3)], cwd, env, options);
    }
    return realExec(command, args, cwd, env, options);
  };
  return { ...f, head, reviewed, checks, exec, commands,
    setRequired(value: unknown) { required = value; },
    setCheckRuns(value: unknown[]) { checkPages = [{ nodes: value, pageInfo: { hasNextPage: false, endCursor: null } }]; },
    setCheckPages(value: typeof checkPages) { checkPages = value; }, setChecksCode(code: number) { checksCode = code; } };
}

test.each([false, true])("published clean main integration is adopted without creation receipts (local=%s)", async local => {
  const f = await foreignIntegration(local);
  try {
    f.pipeline.repoDir = f.lane;
    f.attempt.report = { provenance: { head: f.reviewed } } as PipelineStageAttempt["report"];
    expect(await commitAndAdoptStageBranch(f.pipeline, "refresh", f.exec, () => [f.pipeline], undefined,
      () => {}, null, undefined, undefined, f.attempt, NOW)).toEqual({ ok: true, sha: f.head });
    expect(f.attempt.report?.provenance.head).toBe(f.head);
    expect(await f.own("rev-parse", "HEAD")).toBe(f.head);
    expect(await fs.readFile(path.join(f.lane, "lane.txt"), "utf8")).toBe("reviewed content\n");
    expect(await fs.readFile(path.join(f.lane, "main.txt"), "utf8")).toBe("main content\n");
    expect(f.commands.some(([command]) => command === "gh")).toBe(true);
    expect(f.commands.some(([command, action]) => command === "git" && action === "push")).toBe(false);
    // Replaying settlement after the fast-forward needs no remembered in-process proof.
    expect(await settleStageAttemptPush(f.pipeline, f.attempt, f.exec, NOW)).toEqual({ ok: true, sha: f.head });
    if (!local) {
      const replay = await realExec(process.execPath, ["-e", `
        const { commitAndAdoptStageBranch } = await import("./src/lib/pipelines/stageBranch");
        const { realExec } = await import("./src/lib/workflows/provision");
        const { pipeline, attempt, checks, now } = JSON.parse(process.env.INTEGRATION_FIXTURE);
        const exec = async (command, args, cwd, env, options) => {
          if (command === "git" && args[0] === "remote" && args[1] === "get-url")
            return { code: 0, stdout: "https://github.com/example/project.git", stderr: "" };
          if (command === "git" && (args[0] === "ls-remote" || args[0] === "fetch")
            && args[2] === "https://github.com/example/project.git") {
            return realExec(command, [args[0], args[1], pipeline.delivery.target.remote, ...args.slice(3)], cwd, env, options);
          }
          if (command === "gh") return { code: 0, stdout: JSON.stringify(args[0] === "api"
            ? args.includes("graphql") ? { nodes: [{ __typename: "StatusContext", context: "ci", state: "SUCCESS", createdAt: "2026-10-16T10:01:00Z" }], pageInfo: { hasNextPage: false, endCursor: null } }
              : { protected: true, protection: { required_status_checks: { contexts: ["ci"] } } } : checks), stderr: "" };
          return realExec(command, args, cwd, env, options);
        };
        const result = await commitAndAdoptStageBranch(pipeline, "refresh", exec, () => [pipeline], undefined,
          () => {}, null, undefined, undefined, attempt, now);
        process.stdout.write(JSON.stringify({ result, head: attempt.report.provenance.head }));
      `], process.cwd(), { ...f.env, INTEGRATION_FIXTURE: JSON.stringify({ pipeline: f.pipeline, attempt: f.attempt, checks: f.checks, now: NOW }) }, { timeoutMs: 30000 });
      expect(replay.code, replay.stderr).toBe(0);
      expect(JSON.parse(replay.stdout)).toEqual({ result: { ok: true, sha: f.head }, head: f.head });
    }
    expect(await fs.access(path.join(f.receipt, "commits", f.head)).then(() => true, () => false)).toBe(false);
  } finally { await f.close(); }
});

test.each(["extra commit", "amended merge", "non-main parent", "unpublished"])("foreign integration refuses %s even with green checks", async mode => {
  const f = await foreignIntegration(false);
  try {
    if (mode === "extra commit") await f.git(f.foreign, "commit", "--allow-empty", "-m", "extra work");
    if (mode === "amended merge") {
      await fs.writeFile(path.join(f.foreign, "extra.txt"), "unreviewed\n"); await f.git(f.foreign, "add", "extra.txt");
      await f.git(f.foreign, "commit", "--amend", "--no-edit");
    }
    if (mode === "non-main parent") {
      await f.git(f.remote, "update-ref", "refs/heads/main", f.pipeline.baseRef);
    }
    const target = await f.git(f.foreign, "rev-parse", "HEAD");
    // Fixture refs model an already-published bad candidate without rewriting a real branch.
    await f.own("fetch", f.foreign, "HEAD");
    if (mode === "non-main parent") await f.own("update-ref", "refs/remotes/origin/main", f.head);
    if (mode === "unpublished") await f.git(f.remote, "update-ref", "refs/heads/pipeline/proof", f.reviewed);
    else {
      await f.git(f.remote, "fetch", f.foreign, target);
      await f.git(f.remote, "update-ref", "refs/heads/pipeline/proof", target);
    }
    await f.own("merge", "--ff-only", target);
    f.checks.headRefOid = target;
    const result = await settleStageAttemptPush(f.pipeline, f.attempt, f.exec, NOW);
    expect(result?.ok).toBe(false);
    expect(await f.own("rev-parse", "HEAD")).toBe(target);
  } finally { await f.close(); }
});

test.each(["pending", "red", "empty", "malformed rollup", "stale head", "wrong base", "missing required", "malformed protection", "malformed protection body", "malformed contexts", "unavailable"])("published clean integration waits or refuses when checks are %s", async mode => {
  const f = await foreignIntegration(true);
  try {
    if (mode === "pending") f.setCheckRuns([{ __typename: "StatusContext", context: "ci", state: "PENDING", createdAt: "2026-10-16T10:01:00Z" }]);
    if (mode === "red") f.setCheckRuns([{ __typename: "StatusContext", context: "ci", state: "FAILURE", createdAt: "2026-10-16T10:01:00Z" }]);
    if (mode === "empty") f.setCheckRuns([]);
    if (mode === "malformed rollup") f.checks.statusCheckRollup.push(null as never);
    if (mode === "stale head") f.checks.headRefOid = f.reviewed;
    if (mode === "wrong base") f.checks.baseRefName = "other";
    if (mode === "missing required") f.setRequired({ protected: true, protection: { required_status_checks: { contexts: ["ci", "missing"] } } });
    if (mode === "malformed protection") f.setRequired({});
    if (mode === "malformed protection body") f.setRequired({ protected: true, protection: true });
    if (mode === "malformed contexts") f.setRequired({ protected: true, protection: { required_status_checks: { contexts: null } } });
    if (mode === "unavailable") f.setChecksCode(1);
    const result = await settleStageAttemptPush(f.pipeline, f.attempt, f.exec, NOW);
    expect(result?.ok).toBe(false);
    expect(await f.own("rev-parse", "HEAD")).toBe(f.head);
    if (["pending", "empty", "missing required", "unavailable"].includes(mode)) {
      expect(result).toMatchObject({ deferred: true });
      f.setCheckRuns([{ __typename: "StatusContext", context: "ci", state: "SUCCESS", createdAt: "2026-10-16T10:01:00Z" }]);
      f.setRequired({ protected: true, protection: { required_status_checks: { contexts: ["ci"] } } });
      f.setChecksCode(0);
      expect(await settleStageAttemptPush(f.pipeline, f.attempt, f.exec, NOW)).toEqual({ ok: true, sha: f.head });
    }
  } finally { await f.close(); }
});

test.each(["FAILURE", "PENDING"] as const)("a green check run cannot hide an independent %s status context", async state => {
  const f = await foreignIntegration(true);
  try {
    f.setCheckRuns([
      { __typename: "StatusContext", context: "ci", state, createdAt: "2026-10-16T10:00:00Z" },
      { __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-16T10:01:00Z",
        checkSuite: { app: { databaseId: 123 }, workflowRun: { workflow: { name: "tests" } } } },
    ]);
    const result = await settleStageAttemptPush(f.pipeline, f.attempt, f.exec, NOW);
    expect(result?.ok).toBe(false);
    if (state === "PENDING") expect(result).toMatchObject({ deferred: true });
    expect(await f.own("rev-parse", "HEAD")).toBe(f.head);
  } finally { await f.close(); }
});

test.each(["FAILURE", "IN_PROGRESS"] as const)("a namesake run in another workflow cannot hide required %s", async state => {
  const f = await foreignIntegration(true);
  try {
    f.setRequired({ protected: true, protection: { required_status_checks: { contexts: [], checks: [{ context: "ci", app_id: 123 }] } } });
    f.setCheckRuns([
      { __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-16T10:01:00Z",
        checkSuite: { app: { databaseId: 123 }, workflowRun: { workflow: { name: "optional-format" } } } },
      { __typename: "CheckRun", name: "ci", status: state === "FAILURE" ? "COMPLETED" : state,
        conclusion: state === "FAILURE" ? "FAILURE" : null, startedAt: "2026-10-16T10:00:00Z",
        checkSuite: { app: { databaseId: 123 }, workflowRun: { workflow: { name: "required-tests" } } } },
    ]);
    const result = await settleStageAttemptPush(f.pipeline, f.attempt, f.exec, NOW);
    expect(result?.ok).toBe(false);
    if (state === "IN_PROGRESS") expect(result).toMatchObject({ deferred: true });
    expect(await f.own("rev-parse", "HEAD")).toBe(f.head);
  } finally { await f.close(); }
});

test.each(["status only", "wrong app", "missing app identity", "required app", "unrestricted source", "legacy unrestricted source"] as const)("required check source app is enforced (%s)", async mode => {
  const f = await foreignIntegration(true);
  try {
    const appId = mode === "unrestricted source" ? null : mode === "legacy unrestricted source" ? -1 : 123;
    f.setRequired({ protected: true, protection: { required_status_checks: { contexts: [], checks: [{ context: "ci", app_id: appId }] } } });
    if (mode === "status only") {
      f.checks.statusCheckRollup = [{ __typename: "StatusContext", context: "ci", state: "SUCCESS" }];
    } else {
      f.setCheckRuns([{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-16T10:01:00Z",
        checkSuite: { ...(mode === "missing app identity" ? {} : { app: { databaseId: mode === "wrong app" || mode === "unrestricted source" ? 456 : 123 } }),
          workflowRun: { workflow: { name: "tests" } } } }]);
    }
    const result = await settleStageAttemptPush(f.pipeline, f.attempt, f.exec, NOW);
    if (mode === "required app" || mode === "unrestricted source" || mode === "legacy unrestricted source") expect(result).toEqual({ ok: true, sha: f.head });
    else {
      expect(result?.ok).toBe(false);
      expect(result).toMatchObject({ deferred: true });
    }
  } finally { await f.close(); }
});

test("the actual gh PR shape adopts an app-bound green check using exact-head GraphQL provenance", async () => {
  const f = await foreignIntegration(true);
  try {
    f.setRequired({ protected: true, protection: { required_status_checks: { contexts: [], checks: [{ context: "ci", app_id: 123 }] } } });
    // gh 2.45.0 statusCheckRollup exports workflowName but no app identity.
    f.checks.statusCheckRollup = [{ __typename: "CheckRun", name: "ci", workflowName: "tests",
      status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-16T10:01:00Z" }];
    f.setCheckRuns([{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-16T10:01:00Z",
      checkSuite: { app: { databaseId: 123 }, workflowRun: { workflow: { name: "tests" } } } }]);
    expect(await settleStageAttemptPush(f.pipeline, f.attempt, f.exec, NOW)).toEqual({ ok: true, sha: f.head });
    expect(f.commands.some(command => command[0] === "gh" && command.includes("graphql") && command.includes("--jq"))).toBe(true);
  } finally { await f.close(); }
});

test("exact-head check pagination retains pending evidence from the next page", async () => {
  const f = await foreignIntegration(true);
  try {
    f.setCheckPages([
      { nodes: [{ __typename: "StatusContext", context: "ci", state: "SUCCESS", createdAt: "2026-10-16T10:01:00Z" }],
        pageInfo: { hasNextPage: true, endCursor: "checks-page-one" } },
      { nodes: [{ __typename: "CheckRun", name: "other", status: "IN_PROGRESS", conclusion: null, startedAt: null,
        checkSuite: { app: { databaseId: 123 }, workflowRun: { workflow: { name: "tests" } } } }],
        pageInfo: { hasNextPage: false, endCursor: null } },
    ]);
    expect(await settleStageAttemptPush(f.pipeline, f.attempt, f.exec, NOW)).toMatchObject({ ok: false, deferred: true });
    expect(f.commands.some(command => command.includes("endCursor=checks-page-one"))).toBe(true);
  } finally { await f.close(); }
});

test("an unknown exact-head check kind cannot authorize a published integration", async () => {
  const f = await foreignIntegration(true);
  try {
    f.setCheckRuns([{ __typename: "FutureCheckContext" }]);
    expect(await settleStageAttemptPush(f.pipeline, f.attempt, f.exec, NOW)).toMatchObject({ ok: false, deferred: true });
    expect(await f.own("rev-parse", "HEAD")).toBe(f.head);
  } finally { await f.close(); }
});

test.each(["remote", "head", "dirty", "branch", "default race", "default branch", "origin", "refusal"])("published clean integration preserves the %s fence", async mode => {
  const f = await foreignIntegration(false);
  let raced = false;
  try {
    if (mode === "default branch") await f.git(f.remote, "symbolic-ref", "HEAD", "refs/heads/other");
    if (mode === "refusal") await fs.writeFile(path.join(f.receipt, "refused"), "stage push refused");
    const exec: typeof realExec = async (command, args, cwd, env, options) => {
      if (mode === "origin" && command === "git" && args.join(" ") === "remote get-url origin") {
        return { code: 0, stdout: "https://github.com/example/other.git\n", stderr: "" };
      }
      const result = await f.exec(command, args, cwd, env, options);
      if (!raced && command === "gh" && args[0] === "api") {
        raced = true;
        if (mode === "remote") await f.git(f.remote, "update-ref", "refs/heads/pipeline/proof", f.reviewed);
        if (mode === "head") await f.own("merge", "--ff-only", f.head);
        if (mode === "dirty") await fs.writeFile(path.join(f.lane, "unsaved.txt"), "preserve\n");
        if (mode === "branch") await f.own("checkout", "-b", "unowned");
        if (mode === "default race") await f.git(f.remote, "symbolic-ref", "HEAD", "refs/heads/other");
      }
      return result;
    };
    const result = await settleStageAttemptPush(f.pipeline, f.attempt, exec, NOW);
    expect(result?.ok).toBe(false);
    expect(await f.own("rev-parse", "HEAD")).toBe(mode === "head" ? f.head : f.reviewed);
    if (mode === "dirty") expect(await fs.readFile(path.join(f.lane, "unsaved.txt"), "utf8")).toBe("preserve\n");
  } finally { await f.close(); }
});
