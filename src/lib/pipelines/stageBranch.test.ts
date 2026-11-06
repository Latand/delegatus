import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { realExec, type ExecPort } from "../workflows/provision";
import { realProvisionExec, type ProvisionExecPort } from "./git";
import { commitAndAdoptStageBranch, observeStageBranchProtection } from "./stageBranch";
import type { Pipeline } from "./types";

test.each(["local", "no-remote", "unpublished", "unprotected", "protected", "malformed", "denied", "missing-helper", "transport", "expiry"] as const)(
  "portable stage protection uses real Git and fails closed: %s", async mode => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "stage-protection-"));
    try {
      const repo = path.join(root, "repo"), origin = path.join(root, "origin.git"), bin = path.join(root, "bin");
      fs.mkdirSync(bin);
      fs.symlinkSync(Bun.which("git")!, path.join(bin, "git"));
      expect(Bun.which("timeout", { PATH: bin })).toBeNull();
      expect(Bun.which("gtimeout", { PATH: bin })).toBeNull();
      const git = async (cwd: string, ...args: string[]) => {
        const result = await realExec("git", args, cwd);
        expect(result.code, result.stderr).toBe(0);
        return result.stdout.trim();
      };
      await git(root, "init", "--bare", "--initial-branch=main", origin);
      await git(root, "init", "--initial-branch=main", repo);
      await git(repo, "-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "--allow-empty", "-m", "base");
      await git(repo, "branch", "pipeline/owned");
      await git(repo, "checkout", "-b", "stage/topic");
      const head = await git(repo, "rev-parse", "HEAD");
      await git(repo, "push", origin, "stage/topic");
      // A local SSH transport serves the bare fixture; no network is contacted.
      await git(repo, "remote", "add", "origin", "ssh://github.com/fixture/project.git");
      if (mode === "unpublished") await git(origin, "update-ref", "-d", "refs/heads/stage/topic");
      const transport = path.join(root, "transport");
      fs.writeFileSync(transport, "#!/bin/sh\n" + (mode === "transport" ? "echo 'Connection refused' >&2\nexit 255\n"
        : `exec "${Bun.which("git")!}" upload-pack "$FIXTURE_REMOTE"\n`), { mode: 0o700 });
      const calls = path.join(root, "forge-calls");
      if (mode !== "missing-helper") fs.writeFileSync(path.join(bin, "gh"),
        `#!/bin/sh\nprintf '%s\n' "$*" >> "$FORGE_CALLS"\n` + (mode === "expiry" ? `exec "${Bun.which("sleep")!}" 30\n`
          : mode === "denied" ? "echo fixture-denied >&2\nexit 1\n"
          : `echo ${mode === "protected" ? "true" : mode === "malformed" ? "unexpected" : "false"}\n`), { mode: 0o700 });
      const subject = {
        id: "portable-stage", repoDir: repo, worktreeDir: repo, branch: "pipeline/owned", baseBranch: "main", baseRef: head, lastPassedCommit: head,
        state: "running", cursor: { stageId: "build", state: "running" },
        runs: [{ stageId: "build", attempts: [{ effectiveRole: { access: "read-write" } }] }],
      } as Pipeline;
      const observations: Array<{ command: string; timeoutMs?: number }> = [];
      const remote: ProvisionExecPort = async (command, args, cwd, signal, options) => {
        observations.push({ command, timeoutMs: options?.timeoutMs });
        return realProvisionExec(command, args, cwd, signal, {
          ...options, env: { ...options?.env, PATH: bin, FORGE_CALLS: calls, GIT_SSH_COMMAND: transport, GIT_SSH_VARIANT: "ssh", FIXTURE_REMOTE: origin },
          ...(mode === "expiry" && command === "gh" ? { timeoutMs: 100 } : {}),
        });
      };
      if (mode === "local") await git(repo, "remote", "set-url", "origin", origin);
      if (mode === "no-remote") await git(repo, "remote", "remove", "origin");
      const observation = await observeStageBranchProtection(subject, realExec, remote);
      expect(observation).toMatchObject({ branch: "stage/topic", head });
      if (mode === "local" || mode === "no-remote") {
        expect(observation?.error).toBeNull();
        expect(observations).toEqual([]);
        return;
      }
      expect(observations[0]).toEqual({ command: "git", timeoutMs: 5_000 });
      if (!["unpublished", "transport"].includes(mode)) expect(observations[1]).toEqual({ command: "gh", timeoutMs: 5_000 });
      const error = mode === "protected" ? "the stage is on a protected forge branch"
        : mode === "transport" ? "the stage branch's remote protection cannot be verified"
        : ["malformed", "denied", "missing-helper", "expiry"].includes(mode) ? "the stage branch's forge protection cannot be verified" : null;
      expect(observation?.error).toBe(error);
      if (mode === "unpublished" || mode === "transport" || mode === "missing-helper") expect(fs.existsSync(calls)).toBe(false);
      else expect(fs.readFileSync(calls, "utf8").trim()).toBe("api repos/fixture/project/branches/stage%2Ftopic --jq .protected");
      if (mode === "unprotected") {
        await git(repo, "-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "--allow-empty", "-m", "advanced stage");
        expect(await commitAndAdoptStageBranch(subject, "build", realExec, () => [subject], undefined, () => { throw new Error("stale observation must not record adoption"); }, observation))
          .toMatchObject({ ok: false, deferred: true, error: expect.stringContaining("missing or stale") });
        expect(await git(repo, "rev-parse", "pipeline/owned")).toBe(head);
      }
      if (error) {
        let recorded = false;
        const readOnly: ExecPort = (command, args, cwd, env, options) => {
          expect(["branch", "rev-parse", "symbolic-ref"]).toContain(args[0]);
          return realExec(command, args, cwd, env, options);
        };
        expect(await commitAndAdoptStageBranch(subject, "build", readOnly, () => [subject], undefined, () => { recorded = true; }, observation))
          .toEqual({ ok: false, error: `adopting the stage branch: ${error}` });
        expect(recorded).toBe(false);
        expect(await git(repo, "rev-parse", "pipeline/owned")).toBe(head);
        expect(await git(repo, "branch", "--show-current")).toBe("stage/topic");
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }, 15_000,
);
