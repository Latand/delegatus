import { expect, fs, os, path, harness, tickPipelines, createPipelineFromRequest, loadPipelines, savePipelines } from "./engine.fixture";
import { realExec, type ExecPort } from "@/lib/workflows/provision";
import { prepareStageGitGuard } from "@/lib/git/stageAttemptGuard";
import { agentPublicationIdentityEnv } from "@/lib/git/agentPublicationIdentity";
import { beforeEach, afterEach } from "bun:test";

// Install hooks for each consuming test file: imported modules are cached.
// Literal Git wrappers also read the parent's command configuration, so
// isolate that source and restore the caller exactly.
export function isolatePublicationGit() {
  let inheritedGit: Record<string, string | undefined>;
  const gitKey = (key: string) => key.startsWith("GIT_") || key.startsWith("LLV_STAGE_GIT_");
  beforeEach(() => {
    inheritedGit = Object.fromEntries(Object.entries(process.env).filter(([key]) => gitKey(key)));
    for (const key of Object.keys(process.env).filter(gitKey)) delete process.env[key];
  });
  afterEach(() => {
    for (const key of Object.keys(process.env).filter(gitKey)) delete process.env[key];
    Object.assign(process.env, inheritedGit);
  });
}

export const stages = [
  { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: "review" },
  { id: "review", kind: "run", role: { roleId: "reviewer" }, access: "read-only", prompt: "Review", next: null },
];
export const current = () => loadPipelines()[0]!;

export async function fixture(prelaunchPrefix?: "unrecorded" | "hooks-off" | "foreign", stageList = stages) {
  savePipelines([]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "publication-recovery-"));
  const repo = path.join(root, "repo"), remote = path.join(root, "remote.git"), hooks = path.join(root, "hooks");
  const clean: Partial<NodeJS.ProcessEnv> = Object.fromEntries(Object.keys(process.env)
    .filter(key => key.startsWith("GIT_") || key.startsWith("LLV_STAGE_GIT_")).map(key => [key, undefined]));
  Object.assign(clean, { HOME: root, XDG_CONFIG_HOME: path.join(root, "config"), GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(root, "absent"), GIT_CONFIG_COUNT: "0",
    GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "noreply@example.invalid", GIT_COMMITTER_EMAIL: "noreply@example.invalid",
    GIT_AUTHOR_DATE: "2026-10-16T08:00:00Z", GIT_COMMITTER_DATE: "2026-10-16T08:00:00Z" });
  let agentEnv: Partial<NodeJS.ProcessEnv> = clean;
  let lane = "";
  const execute: ExecPort = (command, args, cwd, env, options) => realExec(command, args, cwd, { ...clean, ...env }, options);
  const git = async (cwd: string, ...args: string[]) => {
    const result = await execute("git", args, cwd, cwd === lane ? agentEnv : clean);
    expect(result.code, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  fs.mkdirSync(repo); fs.mkdirSync(hooks);
  await git(root, "init", "--bare", "--initial-branch=main", remote);
  await git(repo, "init", "--initial-branch=main");
  await git(repo, "config", "core.hooksPath", hooks);
  fs.writeFileSync(path.join(repo, "file.txt"), "base\n");
  await git(repo, "add", "."); await git(repo, "commit", "-m", "base");
  await git(repo, "remote", "add", "origin", remote); await git(repo, "push", "origin", "main");
  const h = harness();
  // Publication follows a completed producer unless a case supplies live or
  // unknown activity explicitly, including retries without a repair record.
  h.setConversationActive(false);
  h.ports.exec = execute;
  h.ports.provisionExec = async (command, args, cwd, signal) => await execute(command, args, cwd, undefined, { signal });
  h.ports.resumeSeveredTurn = undefined;
  h.ports.restartRecoveryBootId = () => "publication-recovery-boot";
  h.ports.restartRecoveryBootStartedAt = () => 0;
  const spawn = h.ports.spawnAgent;
  h.ports.spawnAgent = async (input, reserved) => {
    const launchId = `recovery-${input.clientAttemptId}`;
    const result = await spawn(input, async reservation => {
      await reserved({ ...reservation, launchId });
      lane = input.cwd;
      if (prelaunchPrefix && input.clientAttemptId.endsWith("_build_1")) {
        let prefix: string;
        if (prelaunchPrefix === "foreign") {
          const foreign = path.join(root, "prelaunch-foreign-prefix");
          await git(lane, "worktree", "add", "--detach", foreign, "HEAD");
          const made = await execute("git", ["-c", "core.hooksPath=", "commit", "--allow-empty", "-m", "prelaunch foreign prefix"], foreign, clean);
          expect(made.code, made.stderr).toBe(0);
          prefix = await git(foreign, "rev-parse", "HEAD");
          await git(lane, "merge", "--ff-only", prefix);
        } else {
          const args = ["commit", "--allow-empty", "-m", `prelaunch ${prelaunchPrefix} prefix`];
          const made = await execute("git", prelaunchPrefix === "hooks-off" ? ["-c", "core.hooksPath=", ...args] : args, lane, clean);
          expect(made.code, made.stderr).toBe(0);
          prefix = await git(lane, "rev-parse", "HEAD");
        }
        const pushed = await execute("git", ["-c", "core.hooksPath=", "push", "origin", `HEAD:${current().delivery!.target.branch}`], lane, clean);
        expect(pushed.code, pushed.stderr).toBe(0);
        expect(await git(remote, "rev-parse", current().delivery!.target.branch)).toBe(prefix);
      }
      const guard = await prepareStageGitGuard(launchId, lane, execute, h.ports.now(), async () => {});
      agentEnv = { ...clean, ...guard, ...agentPublicationIdentityEnv({ ...process.env, ...clean, ...guard }) };
    });
    return { ...result, launchId, paneId: null };
  };
  const created = await createPipelineFromRequest({ task: "Recover stage publication", repoDir: repo, baseRef: await git(repo, "rev-parse", "HEAD"),
    publication: "remote-branch", stages: stageList as never }, h.ports);
  expect(created.error).toBeUndefined();
  await tickPipelines([], h.ports); await tickPipelines([], h.ports);
  expect(current().cursor, current().stateDetail ?? "").toMatchObject({ stageId: "build", state: "running" });
  const commit = async (text: string) => {
    fs.writeFileSync(path.join(lane, "file.txt"), `${text}\n`);
    await git(lane, "add", "file.txt"); await git(lane, "commit", "-m", text);
    return git(lane, "rev-parse", "HEAD");
  };
  const refuse = () => fs.writeFileSync(path.join(hooks, "pre-push"), '#!/bin/sh\necho "pre-push: touched tests" >&2\necho "NEW file.test.ts: failing assertion" >&2\nexit 1\n', { mode: 0o700 });
  const finish = async (n = 1) => tickPipelines([h.finish(`/codex/stage-${n}.jsonl`, "pass", "implemented")], h.ports);
  return { root, repo, remote, hooks, h, git, commit, finish, refuse, lane: () => lane, execute,
    agentGit: async (cwd: string, ...args: string[]) => {
      const result = await execute("git", args, cwd, agentEnv);
      expect(result.code, result.stderr).toBe(0); return result.stdout.trim();
    },
    close: () => fs.rmSync(root, { recursive: true, force: true }) };
}
