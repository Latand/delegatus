import { expect, test, fs, path, realWorktreeLane, tickPipelines, loadPipelines, savePipelines, patchPipeline } from "./engine.fixture";

test.each(["deleted", "removed", "resume", "retry", "missing-ref", "held-branch", "locked", "reappeared", "reappeared-at-prune", "present-dirty", "wrong-at-list", "wrong-at-first-ref", "wrong-at-second-ref", "foreign-at-prune"] as const)(
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
      if (["reappeared", "reappeared-at-prune", "wrong-at-list", "wrong-at-first-ref", "wrong-at-second-ref", "foreign-at-prune"].includes(shape)) {
        const exec = f.h.ports.exec;
        let restored = false;
        let refReads = 0;
        f.h.ports.exec = async (...input) => {
          const args = input[1];
          const result = await exec(...input);
          if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === `refs/heads/${lane.branch}^{commit}`)
            refReads++;
          const shouldReappear = !restored && (
            (shape === "reappeared" && args[0] === "worktree" && args[1] === "list")
            || (shape === "wrong-at-list" && args[0] === "worktree" && args[1] === "list")
            || (shape === "wrong-at-first-ref" && refReads === 1 && args[0] === "rev-parse")
            || (shape === "wrong-at-second-ref" && refReads === 2 && args[0] === "rev-parse")
            || ((shape === "reappeared-at-prune" || shape === "foreign-at-prune") && args[0] === "worktree" && args[1] === "prune")
          );
          if (shouldReappear) {
            restored = true;
            if (shape === "foreign-at-prune") {
              await f.git(f.repo, "clone", "--no-hardlinks", "--no-checkout", "--branch", lane.branch, f.repo, f.worktree);
              fs.writeFileSync(path.join(f.worktree, "sentinel.tmp"), "owned by the recreated checkout\n");
            } else {
              await f.git(f.repo, "worktree", "prune", "--expire=now");
              const ownerBranch = shape === "reappeared" || shape === "reappeared-at-prune";
              const target = ownerBranch ? lane.branch : lane.baseRef;
              if (ownerBranch) await f.git(f.repo, "worktree", "add", f.worktree, target);
              else await f.git(f.repo, "worktree", "add", "--detach", f.worktree, target);
              if (shape === "reappeared") fs.writeFileSync(path.join(f.worktree, "retained.txt"), "dirty work\n");
              fs.writeFileSync(path.join(f.worktree, "sentinel.tmp"), "owned by the recreated checkout\n");
            }
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
      if (["missing-ref", "held-branch", "locked", "wrong-at-list", "wrong-at-first-ref", "wrong-at-second-ref", "foreign-at-prune"].includes(shape)) {
        expect(current.state).toBe("needs_decision");
        expect(current.stateDetail).toContain(`lane worktree is missing at ${f.worktree}`);
        expect(current.stateDetail).toContain(shape === "missing-ref" ? "restore the local branch"
          : shape === "locked" ? "resolve the lock"
          : shape === "held-branch" ? "release the branch"
          : "checkout appeared during recovery");
        expect(current.stateDetail).not.toContain("check ignored");
        expect(f.h.spawnInputs).toHaveLength(before);
        expect(fs.existsSync(f.worktree)).toBe(shape.startsWith("wrong-") || shape === "foreign-at-prune");
        if (shape.startsWith("wrong-") || shape === "foreign-at-prune") {
          expect(fs.readFileSync(path.join(f.worktree, "sentinel.tmp"), "utf8")).toBe("owned by the recreated checkout\n");
          if (shape === "foreign-at-prune") {
            expect(await f.git(f.worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"))
              .not.toBe(await f.git(f.repo, "rev-parse", "--path-format=absolute", "--git-common-dir"));
            expect(await f.git(f.worktree, "rev-parse", "HEAD")).toBe(head.trim());
          } else expect(await f.git(f.worktree, "rev-parse", "HEAD")).toBe(lane.baseRef);
        }
        if (shape === "held-branch") expect(await f.git(holder, "rev-parse", "HEAD")).toBe(head);
      } else {
        expect(current.stateDetail || null).toBe(shape === "resume" ? "resumed by operator" : null);
        expect(current.runs[0]!.attempts.at(-1)!.state).toBe("running");
        expect(f.h.spawnInputs).toHaveLength(before + 1);
        expect(await f.git(f.worktree, "branch", "--show-current")).toBe(lane.branch);
        expect(await f.git(f.worktree, "rev-parse", "HEAD")).toBe(head);
        expect(fs.readFileSync(path.join(f.worktree, "retained.txt"), "utf8"))
          .toBe(shape === "present-dirty" || shape === "reappeared" ? "dirty work\n" : "unpublished work\n");
        if (shape === "reappeared-at-prune")
          expect(fs.readFileSync(path.join(f.worktree, "sentinel.tmp"), "utf8")).toBe("owned by the recreated checkout\n");
        await tickPipelines([], f.h.ports);
        expect(f.h.spawnInputs).toHaveLength(before + 1);
      }
    } finally {
      savePipelines([]);
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  }, 30_000,
);

test.each(["ref", "listing", "prune", "add"] as const)(
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
