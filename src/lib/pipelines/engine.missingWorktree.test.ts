import { expect, test, fs, path, realWorktreeLane, tickPipelines, loadPipelines, savePipelines, patchPipeline } from "./engine.fixture";

test.each(["deleted", "removed", "resume", "retry", "missing-ref", "held-branch", "locked", "held-at-add", "locked-at-add", "held-reappeared", "locked-reappeared", "reappeared", "reappeared-at-add", "symlink-reappeared", "present-dirty", "wrong-at-list", "wrong-at-first-ref", "wrong-at-second-ref", "foreign-at-add"] as const)(
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
      let peerGitDir: string | undefined;
      let peerIndex: Buffer | undefined;
      if (shape === "missing-ref") await f.git(f.repo, "branch", "-D", lane.branch);
      if (shape === "held-branch") await f.git(f.repo, "worktree", "add", holder, lane.branch);
      if (shape === "symlink-reappeared") {
        await f.git(f.repo, "worktree", "add", "--force", holder, lane.branch);
        fs.writeFileSync(path.join(holder, "staged.txt"), "indexed peer version\n");
        await f.git(holder, "add", "staged.txt");
        fs.writeFileSync(path.join(holder, "staged.txt"), "peer working version\n");
        peerGitDir = await f.git(holder, "rev-parse", "--absolute-git-dir");
        peerIndex = fs.readFileSync(path.join(peerGitDir, "index"));
        fs.mkdirSync(path.join(f.root, "peer-dependencies"));
        fs.symlinkSync(path.join(f.root, "peer-dependencies"), path.join(holder, "node_modules"), "dir");
        fs.writeFileSync(path.join(holder, "sentinel.tmp"), "peer checkout remains owned\n");
      }
      if (shape === "locked") await f.git(f.repo, "worktree", "lock", f.worktree);
      f.h.ports.worktreePresent = dir => fs.existsSync(dir);
      if (["held-at-add", "locked-at-add", "held-reappeared", "locked-reappeared", "reappeared", "reappeared-at-add", "symlink-reappeared", "wrong-at-list", "wrong-at-first-ref", "wrong-at-second-ref", "foreign-at-add"].includes(shape)) {
        const exec = f.h.ports.exec;
        let restored = false;
        let refReads = 0;
        f.h.ports.exec = async (...input) => {
          const args = input[1];
          // Recreate at add dispatch, after recovery's final path check.
          const atAdd = args[0] === "worktree" && args[1] === "add";
          const result = atAdd ? null : await exec(...input);
          if (!restored && atAdd && (shape === "held-at-add" || shape === "locked-at-add")) {
            restored = true;
            if (shape === "held-at-add") await f.git(f.repo, "worktree", "add", "--force", holder, lane.branch);
            else await f.git(f.repo, "worktree", "lock", f.worktree);
          }
          if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === `refs/heads/${lane.branch}^{commit}`)
            refReads++;
          const shouldReappear = !restored && (
            (["reappeared", "held-reappeared", "locked-reappeared", "symlink-reappeared"].includes(shape) && args[0] === "worktree" && args[1] === "list")
            || (shape === "wrong-at-list" && args[0] === "worktree" && args[1] === "list")
            || (shape === "wrong-at-first-ref" && refReads === 1 && args[0] === "rev-parse")
            || (shape === "wrong-at-second-ref" && refReads === 2 && args[0] === "rev-parse")
            || ((shape === "reappeared-at-add" || shape === "foreign-at-add") && args[0] === "worktree" && args[1] === "add")
          );
          if (shouldReappear) {
            restored = true;
            if (shape === "symlink-reappeared") {
              fs.symlinkSync(holder, f.worktree, "dir");
            } else if (shape === "held-reappeared") {
              await f.git(f.repo, "worktree", "add", "--force", holder, lane.branch);
              await f.git(f.repo, "worktree", "add", "--force", f.worktree, lane.branch);
            } else if (shape === "locked-reappeared") {
              await f.git(f.repo, "worktree", "add", "--force", f.worktree, lane.branch);
              await f.git(f.repo, "worktree", "lock", f.worktree);
            } else if (shape === "foreign-at-add") {
              await f.git(f.repo, "clone", "--no-hardlinks", "--no-checkout", "--branch", lane.branch, f.repo, f.worktree);
              fs.writeFileSync(path.join(f.worktree, "sentinel.tmp"), "owned by the recreated checkout\n");
            } else {
              const ownerBranch = shape === "reappeared" || shape === "reappeared-at-add";
              const target = ownerBranch ? lane.branch : lane.baseRef;
              if (ownerBranch) await f.git(f.repo, "worktree", "add", "--force", f.worktree, target);
              else await f.git(f.repo, "worktree", "add", "--force", "--detach", f.worktree, target);
              if (shape === "reappeared") fs.writeFileSync(path.join(f.worktree, "retained.txt"), "dirty work\n");
              fs.writeFileSync(path.join(f.worktree, "sentinel.tmp"), "owned by the recreated checkout\n");
            }
          }
          return result ?? await exec(...input);
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
      if (["missing-ref", "held-branch", "locked", "held-at-add", "locked-at-add", "held-reappeared", "locked-reappeared", "symlink-reappeared", "wrong-at-list", "wrong-at-first-ref", "wrong-at-second-ref", "foreign-at-add"].includes(shape)) {
        expect(current.state).toBe("needs_decision");
        expect(current.stateDetail).toContain(`lane worktree is missing at ${f.worktree}`);
        expect(current.stateDetail).toContain(shape === "missing-ref" ? "restore the local branch"
          : shape === "locked" || shape === "locked-at-add" || shape === "locked-reappeared" ? "resolve the lock"
          : shape === "held-branch" || shape === "held-at-add" || shape === "held-reappeared" || shape === "symlink-reappeared" ? "release the branch"
          : "checkout appeared during recovery");
        expect(current.stateDetail).not.toContain("check ignored");
        expect(f.h.spawnInputs).toHaveLength(before);
        expect(fs.existsSync(f.worktree)).toBe(shape.startsWith("wrong-") || shape === "foreign-at-add" || shape === "held-at-add" || shape === "held-reappeared" || shape === "locked-reappeared" || shape === "symlink-reappeared");
        if (shape === "symlink-reappeared") {
          expect(fs.lstatSync(f.worktree).isSymbolicLink()).toBe(true);
          expect(peerIndex).toEqual(fs.readFileSync(path.join(peerGitDir!, "index")));
          expect(await f.git(holder, "show", ":staged.txt")).toBe("indexed peer version");
          expect(fs.readFileSync(path.join(holder, "staged.txt"), "utf8")).toBe("peer working version\n");
          expect(fs.lstatSync(path.join(holder, "node_modules")).isSymbolicLink()).toBe(true);
          expect(fs.readFileSync(path.join(holder, "sentinel.tmp"), "utf8")).toBe("peer checkout remains owned\n");
        }
        if (shape.startsWith("wrong-") || shape === "foreign-at-add") {
          expect(fs.readFileSync(path.join(f.worktree, "sentinel.tmp"), "utf8")).toBe("owned by the recreated checkout\n");
          if (shape === "foreign-at-add") {
            expect(await f.git(f.worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"))
              .not.toBe(await f.git(f.repo, "rev-parse", "--path-format=absolute", "--git-common-dir"));
            expect(await f.git(f.worktree, "rev-parse", "HEAD")).toBe(head.trim());
          } else expect(await f.git(f.worktree, "rev-parse", "HEAD")).toBe(lane.baseRef);
        }
        if (shape === "held-branch" || shape === "held-at-add") expect(await f.git(holder, "rev-parse", "HEAD")).toBe(head);
      } else {
        expect(current.stateDetail || null).toBe(shape === "resume" ? "resumed by operator" : null);
        expect(current.runs[0]!.attempts.at(-1)!.state).toBe("running");
        expect(f.h.spawnInputs).toHaveLength(before + 1);
        expect(await f.git(f.worktree, "branch", "--show-current")).toBe(lane.branch);
        expect(await f.git(f.worktree, "rev-parse", "HEAD")).toBe(head);
        expect(fs.readFileSync(path.join(f.worktree, "retained.txt"), "utf8"))
          .toBe(shape === "present-dirty" || shape === "reappeared" ? "dirty work\n" : "unpublished work\n");
        if (shape === "reappeared-at-add")
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

test.each(["ref", "listing", "add"] as const)(
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

// Retained review probe: temporarily unavailable worktrees keep their staged data.
for (const shape of ["deleted-tip", "other-stale-registration", "other-locked-registration", "other-present-registration"] as const) {
  test(`retained activation probe: ${shape}`, async () => {
    const f = await realWorktreeLane("preserve-other-checkout", [
      { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null },
    ]);
    try {
      const lane = loadPipelines()[0]!;
      fs.writeFileSync(path.join(f.worktree, "retained.txt"), "new unpublished tip\n");
      await f.git(f.worktree, "add", "retained.txt");
      await f.git(f.worktree, "commit", "-m", "Retain local work");
      const tip = await f.git(f.repo, "rev-parse", `refs/heads/${lane.branch}`);
      const previous = lane.runs[0]!.attempts[0]!;
      previous.state = "failed";
      previous.completedAt = f.h.ports.now();
      previous.error = "interrupted setup";
      previous.launchId = previous.conversationId = previous.sessionId = previous.agentPath = previous.paneId = null;
      delete previous.activation;
      lane.cursor = { stageId: "build", state: "pending", input: null, activatedBy: null };
      lane.state = "running";
      savePipelines([lane]);
      fs.appendFileSync(path.join(f.repo, ".gitignore"), "node_modules/\n");
      fs.mkdirSync(path.join(f.repo, "node_modules"));
      let other: string | undefined, parkedOther: string | undefined, otherGitDir: string | undefined;
      let otherIndex: Buffer | undefined, otherTip: string | undefined;
      if (shape !== "deleted-tip") {
        other = path.join(f.root, "other-checkout");
        parkedOther = path.join(f.root, "other-offline");
        await f.git(f.repo, "worktree", "add", "-b", "other-work", other, lane.baseRef);
        fs.writeFileSync(path.join(other, "staged.txt"), "unique staged version\n");
        await f.git(other, "add", "staged.txt");
        fs.writeFileSync(path.join(other, "staged.txt"), "working version differs\n");
        otherGitDir = await f.git(other, "rev-parse", "--absolute-git-dir");
        otherIndex = fs.readFileSync(path.join(otherGitDir, "index"));
        otherTip = await f.git(other, "rev-parse", "HEAD");
        fs.writeFileSync(path.join(other, "sentinel.tmp"), "unrelated ignored work\n");
        if (shape === "other-locked-registration") await f.git(f.repo, "worktree", "lock", other);
        if (shape !== "other-present-registration") fs.renameSync(other, parkedOther);
      }
      fs.rmSync(f.worktree, { recursive: true });
      f.h.ports.worktreePresent = dir => fs.existsSync(dir);
      const before = f.h.spawnInputs.length;
      await tickPipelines([], f.h.ports);
      const current = loadPipelines()[0]!;
      if (other && parkedOther && otherGitDir) {
        if (shape !== "other-present-registration") fs.renameSync(parkedOther, other);
        expect(fs.existsSync(otherGitDir)).toBe(true);
        expect(otherIndex).toEqual(fs.readFileSync(path.join(otherGitDir, "index")));
        expect(await f.git(other, "show", ":staged.txt")).toBe("unique staged version");
        expect(await f.git(other, "rev-parse", "HEAD")).toBe(otherTip!);
        expect(await f.git(other, "symbolic-ref", "HEAD")).toBe("refs/heads/other-work");
        expect(fs.readFileSync(path.join(other, "staged.txt"), "utf8")).toBe("working version differs\n");
        expect(fs.readFileSync(path.join(other, "sentinel.tmp"), "utf8")).toBe("unrelated ignored work\n");
        const registrations = await f.git(f.repo, "worktree", "list", "--porcelain");
        expect(registrations).toContain(`worktree ${other}`);
        if (shape === "other-locked-registration") expect(registrations).toContain("locked");
      }
      expect(current.state).toBe("running");
      expect(current.runs[0]!.attempts.at(-1)!.state).toBe("running");
      expect(f.h.spawnInputs).toHaveLength(before + 1);
      expect(await f.git(f.worktree, "rev-parse", "HEAD")).toBe(tip);
      expect(await f.git(f.worktree, "symbolic-ref", "HEAD")).toBe(`refs/heads/${lane.branch}`);
      expect(fs.readFileSync(path.join(f.worktree, "retained.txt"), "utf8")).toBe("new unpublished tip\n");
      await tickPipelines([], f.h.ports);
      expect(f.h.spawnInputs).toHaveLength(before + 1);
    } finally {
      savePipelines([]);
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  }, 30000);
}

for (const shape of ["foreign-branch", "detached"] as const) {
  test(`recovery parks when the reused lane path is registered to a ${shape} checkout`, async () => {
    const f = await realWorktreeLane("reused-path-registration", [
      { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null },
    ]);
    let peerOffline: string | undefined;
    try {
      const lane = loadPipelines()[0]!;
      const previous = lane.runs[0]!.attempts[0]!;
      previous.state = "failed";
      previous.completedAt = f.h.ports.now();
      previous.error = "interrupted setup";
      previous.launchId = previous.conversationId = previous.sessionId = previous.agentPath = previous.paneId = null;
      delete previous.activation;
      lane.cursor = { stageId: "build", state: "pending", input: null, activatedBy: null };
      lane.state = "running";
      savePipelines([lane]);

      await f.git(f.repo, "worktree", "remove", f.worktree);
      if (shape === "foreign-branch") {
        await f.git(f.repo, "worktree", "add", "-b", "independent-peer", f.worktree, lane.baseRef);
      } else {
        await f.git(f.repo, "worktree", "add", "--detach", f.worktree, lane.baseRef);
      }
      fs.writeFileSync(path.join(f.worktree, "staged.txt"), "peer staged version\n");
      await f.git(f.worktree, "add", "staged.txt");
      fs.writeFileSync(path.join(f.worktree, "staged.txt"), "peer working version\n");
      fs.writeFileSync(path.join(f.worktree, "sentinel.tmp"), "unrelated ignored work\n");
      const peerGitDir = await f.git(f.worktree, "rev-parse", "--absolute-git-dir");
      const peerIndex = fs.readFileSync(path.join(peerGitDir, "index"));
      peerOffline = path.join(f.root, "peer-offline");
      fs.renameSync(f.worktree, peerOffline);
      f.h.ports.worktreePresent = dir => fs.existsSync(dir);
      const before = f.h.spawnInputs.length;

      await tickPipelines([], f.h.ports);

      const current = loadPipelines()[0]!;
      expect(current.state).toBe("needs_decision");
      expect(current.stateDetail).toContain(`lane worktree is missing at ${f.worktree}`);
      expect(current.stateDetail).toContain(shape === "detached" ? "detached HEAD" : "independent-peer");
      expect(f.h.spawnInputs).toHaveLength(before);
      expect(fs.existsSync(f.worktree)).toBe(false);
      expect(await f.git(f.repo, "worktree", "list", "--porcelain")).toContain(`worktree ${f.worktree}`);

      fs.renameSync(peerOffline, f.worktree);
      peerOffline = undefined;
      expect(peerIndex).toEqual(fs.readFileSync(path.join(peerGitDir, "index")));
      expect(await f.git(f.worktree, "show", ":staged.txt")).toBe("peer staged version");
      expect(fs.readFileSync(path.join(f.worktree, "staged.txt"), "utf8")).toBe("peer working version\n");
      expect(fs.readFileSync(path.join(f.worktree, "sentinel.tmp"), "utf8")).toBe("unrelated ignored work\n");
      const registrations = await f.git(f.repo, "worktree", "list", "--porcelain");
      expect(registrations).toContain(`worktree ${f.worktree}`);
      if (shape === "foreign-branch") expect(registrations).toContain("branch refs/heads/independent-peer");
      else expect(registrations).toContain("detached");
    } finally {
      savePipelines([]);
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  }, 30_000);
}
