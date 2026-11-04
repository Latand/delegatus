import { expect, test, fs, path, realWorktreeLane, tickPipelines, loadPipelines, savePipelines, patchPipeline } from "./engine.fixture";

test.each(["deleted", "removed", "resume", "retry", "missing-ref", "held-branch", "locked", "reappeared", "present-dirty"] as const)(
  "activation handles a %s lane checkout before dependency setup", async shape => {
    const f = await realWorktreeLane("missing-checkout", [
      { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null },
    ]);
    try {
      const lane = loadPipelines()[0]!;
      // An unpublished commit is newer than the last accepted stage head.
      fs.writeFileSync(path.join(f.worktree, "retained.txt"), "unpublished work\n");
      await f.git(f.worktree, "add", "retained.txt");
      await f.git(f.worktree, "commit", "-m", "unpublished work");
      const head = await f.git(f.repo, "rev-parse", `refs/heads/${lane.branch}`);
      // Model a persisted lane awaiting activation, after provisioning.
      const previous = lane.runs[0]!.attempts[0]!;
      previous.state = "failed";
      previous.completedAt = f.h.ports.now();
      previous.error = "setup interrupted";
      // A setup failure has not reserved a host or a launch receipt.
      previous.launchId = previous.conversationId = previous.sessionId = previous.agentPath = previous.paneId = null;
      delete previous.activation;
      lane.cursor = { stageId: "build", state: "pending", input: null, activatedBy: null };
      lane.state = "running";
      savePipelines([lane]);
      fs.appendFileSync(path.join(f.repo, ".gitignore"), "node_modules/\n");
      fs.mkdirSync(path.join(f.repo, "node_modules"));
      if (shape === "present-dirty") {
        fs.writeFileSync(path.join(f.worktree, "retained.txt"), "dirty work\n");
      } else if (shape === "removed" || shape === "held-branch" || shape === "missing-ref") {
        await f.git(f.repo, "worktree", "remove", f.worktree);
      } else {
        fs.rmSync(f.worktree, { recursive: true });
      }
      const holder = path.join(f.root, "holder");
      if (shape === "missing-ref") await f.git(f.repo, "branch", "-D", lane.branch);
      if (shape === "held-branch") await f.git(f.repo, "worktree", "add", holder, lane.branch);
      if (shape === "locked") await f.git(f.repo, "worktree", "lock", f.worktree);
      f.h.ports.worktreePresent = dir => fs.existsSync(dir);
      if (shape === "reappeared") {
        const exec = f.h.ports.exec;
        let restored = false;
        f.h.ports.exec = async (...input) => {
          const result = await exec(...input);
          if (!restored && input[1][0] === "worktree" && input[1][1] === "list") {
            restored = true;
            await f.git(f.repo, "worktree", "remove", f.worktree);
            await f.git(f.repo, "worktree", "add", f.worktree, lane.branch);
            fs.writeFileSync(path.join(f.worktree, "retained.txt"), "dirty work\n");
          }
          return result;
        };
      }
      const before = f.h.spawnInputs.length;
      if (shape === "resume" || shape === "retry") {
        lane.state = shape === "resume" ? "paused" : "needs_decision";
        lane.pausedState = shape === "resume" ? "running" : null;
        savePipelines([lane]);
        const result = await patchPipeline(lane.id, { action: shape === "resume" ? "resume" : "retry-stage" }, f.h.ports);
        expect(result.error).toBeUndefined();
      }
      await tickPipelines([], f.h.ports);
      const current = loadPipelines()[0]!;
      if (shape === "missing-ref" || shape === "held-branch" || shape === "locked") {
        expect(current.state).toBe("needs_decision");
        expect(current.stateDetail).toContain(`lane worktree is missing at ${f.worktree}`);
        expect(current.stateDetail).toContain(shape === "missing-ref" ? "restore the local branch"
          : shape === "locked" ? "resolve the lock" : "release the branch");
        expect(current.stateDetail).not.toContain("check ignored");
        expect(f.h.spawnInputs).toHaveLength(before);
        expect(fs.existsSync(f.worktree)).toBe(false);
        if (shape === "held-branch") expect(await f.git(holder, "rev-parse", "HEAD")).toBe(head);
      } else {
        expect(current.stateDetail).toBe(shape === "resume" ? "resumed by operator" : null);
        expect(current.runs[0]!.attempts.at(-1)!.state).toBe("running");
        expect(f.h.spawnInputs).toHaveLength(before + 1);
        expect(await f.git(f.worktree, "branch", "--show-current")).toBe(lane.branch);
        expect(await f.git(f.worktree, "rev-parse", "HEAD")).toBe(head);
        expect(fs.readFileSync(path.join(f.worktree, "retained.txt"), "utf8"))
          .toBe(shape === "present-dirty" || shape === "reappeared" ? "dirty work\n" : "unpublished work\n");
        await tickPipelines([], f.h.ports);
        expect(f.h.spawnInputs).toHaveLength(before + 1);
      }
    } finally {
      savePipelines([]);
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  }, 30_000,
);

test.each(["ref", "listing", "remove", "add"] as const)(
  "pausing activation after recovery %s retains custody without dispatch", async boundary => {
    const f = await realWorktreeLane("recovery-paused", [
      { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null },
    ]);
    try {
      const lane = loadPipelines()[0]!;
      const previous = lane.runs[0]!.attempts[0]!;
      previous.state = "failed";
      previous.completedAt = f.h.ports.now();
      previous.paneId = null;
      delete previous.activation;
      lane.cursor = { stageId: "build", state: "pending", input: null, activatedBy: null };
      savePipelines([lane]);
      fs.rmSync(f.worktree, { recursive: true });
      f.h.ports.worktreePresent = dir => fs.existsSync(dir);
      const exec = f.h.ports.exec;
      const before = f.h.spawnInputs.length;
      let paused = false;
      f.h.ports.exec = async (...input) => {
        const result = await exec(...input);
        const args = input[1];
        const matches = boundary === "ref" ? args[0] === "rev-parse" && args[1] === "--verify"
          : args[0] === "worktree" && args[1] === (boundary === "listing" ? "list" : boundary);
        if (!paused && matches) {
          paused = true;
          const current = loadPipelines()[0]!;
          current.state = "paused";
          current.pausedState = "running";
          savePipelines([current]);
        }
        return result;
      };
      await tickPipelines([], f.h.ports);
      expect(paused).toBe(true);
      expect(loadPipelines()[0]!.state).toBe("paused");
      expect(f.h.spawnInputs).toHaveLength(before);
      expect(fs.existsSync(f.worktree)).toBe(boundary === "add");
      expect(await f.git(f.repo, "rev-parse", `refs/heads/${lane.branch}`)).toBe(lane.baseRef);
    } finally {
      savePipelines([]);
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  }, 30_000,
);
