import { expect, test, fs, path, spawn, stopFixtureProcess, realWorktreeLane, tickPipelines, loadPipelines, savePipelines, patchPipeline } from "./engine.fixture";

test.each(["deleted", "removed", "resume", "retry", "missing-ref", "held-branch", "locked", "held-at-refusal", "locked-at-refusal", "held-reappeared", "locked-reappeared", "reappeared", "reappeared-at-refusal", "symlink-reappeared", "present-dirty", "wrong-at-list", "wrong-at-first-ref", "wrong-at-second-ref", "foreign-at-refusal"] as const)(
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
      } else if (["removed", "resume", "retry", "held-branch", "missing-ref"].includes(shape)) {
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
      if (["held-at-refusal", "locked-at-refusal", "held-reappeared", "locked-reappeared", "reappeared", "reappeared-at-refusal", "symlink-reappeared", "wrong-at-list", "wrong-at-first-ref", "wrong-at-second-ref", "foreign-at-refusal"].includes(shape)) {
        const exec = f.h.ports.exec;
        let restored = false;
        let refReads = 0;
        f.h.ports.exec = async (...input) => {
          const args = input[1];
          // Change ownership at the last registration read before refusal.
          const atListing = args[0] === "worktree" && args[1] === "list";
          const result = atListing && ["held-at-refusal", "locked-at-refusal", "reappeared-at-refusal", "foreign-at-refusal"].includes(shape) ? null : await exec(...input);
          if (!restored && atListing && (shape === "held-at-refusal" || shape === "locked-at-refusal")) {
            restored = true;
            if (shape === "held-at-refusal") await f.git(f.repo, "worktree", "add", "--force", holder, lane.branch);
            else await f.git(f.repo, "worktree", "lock", f.worktree);
          }
          if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === `refs/heads/${lane.branch}^{commit}`)
            refReads++;
          const shouldReappear = !restored && (
            (["reappeared", "held-reappeared", "locked-reappeared", "symlink-reappeared"].includes(shape) && args[0] === "worktree" && args[1] === "list")
            || (shape === "wrong-at-list" && args[0] === "worktree" && args[1] === "list")
            || (shape === "wrong-at-first-ref" && refReads === 1 && args[0] === "rev-parse")
            || (shape === "wrong-at-second-ref" && refReads === 2 && args[0] === "rev-parse")
            || ((shape === "reappeared-at-refusal" || shape === "foreign-at-refusal") && atListing)
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
            } else if (shape === "foreign-at-refusal") {
              await f.git(f.repo, "clone", "--no-hardlinks", "--no-checkout", "--branch", lane.branch, f.repo, f.worktree);
              fs.writeFileSync(path.join(f.worktree, "sentinel.tmp"), "owned by the recreated checkout\n");
            } else {
              const ownerBranch = shape === "reappeared" || shape === "reappeared-at-refusal";
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
      if (["deleted", "removed", "resume", "retry", "missing-ref", "held-branch", "locked", "held-at-refusal", "locked-at-refusal", "held-reappeared", "locked-reappeared", "symlink-reappeared", "wrong-at-list", "wrong-at-first-ref", "wrong-at-second-ref", "foreign-at-refusal"].includes(shape)) {
        expect(current.state).toBe("needs_decision");
        expect(current.stateDetail).toContain(`lane worktree is missing at ${f.worktree}`);
        expect(current.stateDetail).toContain(shape === "deleted" ? "restore the registered checkout"
          : shape === "removed" || shape === "resume" || shape === "retry" ? "restore the checkout from that branch"
          : shape === "missing-ref" ? "restore the local branch"
          : shape === "locked" || shape === "locked-at-refusal" || shape === "locked-reappeared" ? "resolve the lock"
          : shape === "held-branch" || shape === "held-at-refusal" || shape === "held-reappeared" || shape === "symlink-reappeared" ? "release the branch"
          : "checkout appeared during recovery");
        expect(current.stateDetail).not.toContain("check ignored");
        expect(f.h.spawnInputs).toHaveLength(before);
        expect(fs.existsSync(f.worktree)).toBe(shape.startsWith("wrong-") || shape === "foreign-at-refusal" || shape === "held-reappeared" || shape === "locked-reappeared" || shape === "symlink-reappeared");
        if (shape === "symlink-reappeared") {
          expect(fs.lstatSync(f.worktree).isSymbolicLink()).toBe(true);
          expect(peerIndex).toEqual(fs.readFileSync(path.join(peerGitDir!, "index")));
          expect(await f.git(holder, "show", ":staged.txt")).toBe("indexed peer version");
          expect(fs.readFileSync(path.join(holder, "staged.txt"), "utf8")).toBe("peer working version\n");
          expect(fs.lstatSync(path.join(holder, "node_modules")).isSymbolicLink()).toBe(true);
          expect(fs.readFileSync(path.join(holder, "sentinel.tmp"), "utf8")).toBe("peer checkout remains owned\n");
        }
        if (shape.startsWith("wrong-") || shape === "foreign-at-refusal") {
          expect(fs.readFileSync(path.join(f.worktree, "sentinel.tmp"), "utf8")).toBe("owned by the recreated checkout\n");
          if (shape === "foreign-at-refusal") {
            expect(await f.git(f.worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"))
              .not.toBe(await f.git(f.repo, "rev-parse", "--path-format=absolute", "--git-common-dir"));
            expect(await f.git(f.worktree, "rev-parse", "HEAD")).toBe(head.trim());
          } else expect(await f.git(f.worktree, "rev-parse", "HEAD")).toBe(lane.baseRef);
        }
        if (shape === "held-branch" || shape === "held-at-refusal") expect(await f.git(holder, "rev-parse", "HEAD")).toBe(head);
      } else {
        expect(current.stateDetail || null).toBe(null);
        expect(current.runs[0]!.attempts.at(-1)!.state).toBe("running");
        expect(f.h.spawnInputs).toHaveLength(before + 1);
        expect(await f.git(f.worktree, "branch", "--show-current")).toBe(lane.branch);
        expect(await f.git(f.worktree, "rev-parse", "HEAD")).toBe(head);
        expect(fs.readFileSync(path.join(f.worktree, "retained.txt"), "utf8"))
          .toBe(shape === "present-dirty" || shape === "reappeared" ? "dirty work\n" : "unpublished work\n");
        if (shape === "reappeared-at-refusal")
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

test.each(["identity", "ref", "listing"] as const)(
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
      await f.git(f.repo, "worktree", "remove", f.worktree);
      f.h.ports.worktreePresent = dir => fs.existsSync(dir);
      const exec = f.h.ports.exec;
      const before = f.h.spawnInputs.length;
      let paused = false;
      f.h.ports.exec = async (...input) => {
        const result = await exec(...input);
        const args = input[1];
        const matches = boundary === "identity" ? args[0] === "-C" : boundary === "ref" ? args[0] === "rev-parse" && args[1] === "--verify"
          : args[0] === "worktree" && args[1] === "list";
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
      expect(fs.existsSync(f.worktree)).toBe(false);
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
      // A deleted directory retains its registration and must now refuse.
      // An absent lane refuses without disturbing unavailable peers; after an
      // external restore, retry resumes at the retained branch tip.
      if (shape === "deleted-tip") fs.rmSync(f.worktree, { recursive: true });
      else await f.git(f.repo, "worktree", "remove", f.worktree);
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
      if (shape === "deleted-tip") {
        expect(current.state).toBe("needs_decision");
        expect(current.stateDetail).toContain("restore the registered checkout");
        expect(f.h.spawnInputs).toHaveLength(before);
        expect(fs.existsSync(f.worktree)).toBe(false);
        expect(await f.git(f.repo, "rev-parse", `refs/heads/${lane.branch}`)).toBe(tip);
        return;
      }
      expect(current.state).toBe("needs_decision");
      expect(current.stateDetail).toContain("restore the checkout from that branch");
      expect(f.h.spawnInputs).toHaveLength(before);
      expect(fs.existsSync(f.worktree)).toBe(false);
      expect(await f.git(f.repo, "rev-parse", `refs/heads/${lane.branch}`)).toBe(tip);
      await f.git(f.repo, "worktree", "add", f.worktree, lane.branch);
      expect((await patchPipeline(lane.id, { action: "retry-stage" }, f.h.ports)).error).toBeUndefined();
      await tickPipelines([], f.h.ports);
      expect(loadPipelines()[0]!.state).toBe("running");
      expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)!.state).toBe("running");
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

test("independent recovery probe: registration changes owner after final ref read", async () => {
  const f = await realWorktreeLane("registration-race", [
    { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null },
  ]);
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
    fs.appendFileSync(path.join(f.repo, ".gitignore"), "node_modules/\n");
    fs.mkdirSync(path.join(f.repo, "node_modules"));
    fs.rmSync(f.worktree, { recursive: true });
    f.h.ports.worktreePresent = dir => fs.existsSync(dir);
    const offline = path.join(f.root, "peer-offline");
    let peerGitDir = "", peerIndex: Buffer | undefined, injected = false, reads = 0;
    const exec = f.h.ports.exec;
    f.h.ports.exec = async (...input) => {
      const args = input[1];
      const isRefRead = args[0] === "rev-parse" && args[1] === "--verify" && args[2] === `refs/heads/${lane.branch}^{commit}`;
      if (isRefRead) reads++;
      const boundary = (isRefRead && reads === 2) || args[0] === "check-ignore";
      if (!injected && boundary) {
        injected = true;
        await f.git(f.repo, "worktree", "add", "--force", "-b", "independent-peer", f.worktree, lane.branch);
        fs.writeFileSync(path.join(f.worktree, "staged.txt"), "unique peer staged version\n");
        await f.git(f.worktree, "add", "staged.txt");
        fs.writeFileSync(path.join(f.worktree, "staged.txt"), "peer working version\n");
        fs.writeFileSync(path.join(f.worktree, "sentinel.tmp"), "peer ignored version\n");
        peerGitDir = await f.git(f.worktree, "rev-parse", "--absolute-git-dir");
        peerIndex = fs.readFileSync(path.join(peerGitDir, "index"));
        fs.renameSync(f.worktree, offline);
      }
      return await exec(...input);
    };
    const before = f.h.spawnInputs.length;
    await tickPipelines([], f.h.ports);
    const current = loadPipelines()[0]!;
    const listing = await f.git(f.repo, "worktree", "list", "--porcelain");
    const indexPreserved = !!peerIndex && fs.existsSync(path.join(peerGitDir, "index")) && peerIndex.equals(fs.readFileSync(path.join(peerGitDir, "index")));
    const hasForeignRegistration = listing.includes("branch refs/heads/independent-peer");
    expect(current.state).toBe("needs_decision");
    expect(current.stateDetail).toContain("registration belongs to refs/heads/independent-peer");
    expect(injected).toBe(true);
    expect(indexPreserved).toBe(true);
    expect(hasForeignRegistration).toBe(true);
    expect(f.h.spawnInputs).toHaveLength(before);
    expect(fs.existsSync(f.worktree)).toBe(false);
    fs.renameSync(offline, f.worktree);
    expect(await f.git(f.worktree, "show", ":staged.txt")).toBe("unique peer staged version");
    expect(fs.readFileSync(path.join(f.worktree, "staged.txt"), "utf8")).toBe("peer working version\n");
    expect(fs.readFileSync(path.join(f.worktree, "sentinel.tmp"), "utf8")).toBe("peer ignored version\n");
  } finally {
    savePipelines([]);
    fs.rmSync(f.root, { recursive: true, force: true });
  }
}, 30_000);

// Recovery must never enter native add. Positive controls then drive real Git
// through the original lstat race and the later metadata mkdir race. The latter
// proves that ordinary add can destroy a peer's pointer and tracked work.
test.skipIf(process.platform !== "linux" || !Bun.which("cc")).each(["removed", "deleted", "foreign-branch", "detached", "late-peer"] as const)(
  "recovery refuses native writes with a real boundary control: %s", async shape => {
    const f = await realWorktreeLane("native-registration", [
      { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null },
    ]);
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
      fs.appendFileSync(path.join(f.repo, ".gitignore"), "node_modules/\n");
      fs.mkdirSync(path.join(f.repo, "node_modules"));
      const metadata = (directory: string): Record<string, Buffer> => Object.fromEntries(
        fs.readdirSync(directory).flatMap(name => {
          const file = path.join(directory, name);
          return fs.statSync(file).isDirectory()
            ? Object.entries(metadata(file)).map(([key, bytes]) => [`${name}/${key}`, bytes])
            : [[name, fs.readFileSync(file)]];
        }),
      );
      let gitDir = await f.git(f.worktree, "rev-parse", "--absolute-git-dir");
      let preserved = metadata(gitDir);
      if (shape === "removed" || shape === "late-peer") await f.git(f.repo, "worktree", "remove", f.worktree);
      else fs.rmSync(f.worktree, { recursive: true });
      f.h.ports.worktreePresent = dir => fs.existsSync(dir);

      const nativeGit = Bun.which("git", { PATH: "/usr/bin:/bin" });
      if (!nativeGit) throw new Error("native Git executable is unavailable outside the publication shim");
      const resolvedNativeGit = fs.realpathSync(nativeGit);
      expect(fs.readFileSync(resolvedNativeGit).subarray(0, 4)).toEqual(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
      const source = path.join(f.root, "barrier.c"), library = path.join(f.root, "barrier.so");
      fs.writeFileSync(source, `
#define _GNU_SOURCE
#define _LARGEFILE64_SOURCE
#include <dlfcn.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/stat.h>
static int stopped;
static void barrier(void) {
  stopped = 1;
  setenv("NATIVE_BARRIER_USED", "1", 1);
  char token = 'R';
  if (write(3, &token, 1) != 1 || read(4, &token, 1) != 1) _exit(91);
}
int mkdir(const char *p, mode_t mode) {
  int (*real)(const char *, mode_t) = dlsym(RTLD_NEXT, "mkdir");
  const char *target = getenv("NATIVE_METADATA_TARGET");
  if (!stopped && !getenv("NATIVE_BARRIER_USED") && target && !strcmp(p, target)) barrier();
  return real(p, mode);
}
int lstat64(const char *p, struct stat64 *buf) {
  int (*real)(const char *, struct stat64 *) = dlsym(RTLD_NEXT, "lstat64");
  const char *target = getenv("NATIVE_TARGET");
  if (!stopped && !getenv("NATIVE_BARRIER_USED") && target && !strcmp(p, target)) {
    barrier();
  }
  return real(p, buf);
}
`);
      const compiled = await f.h.ports.exec("cc", ["-shared", "-fPIC", "-o", library, source, "-ldl"], f.root);
      expect(compiled.code).toBe(0);
      const offline = path.join(f.root, "peer-offline");
      const exec = f.h.ports.exec;
      let reached = false;
      let pointer = "";
      f.h.ports.exec = async (...input) => {
        const args = input[1];
        if (args[0] !== "worktree" || args[1] !== "add") return exec(...input);
        const child = spawn(nativeGit, args, {
          cwd: input[2], env: { ...process.env, ...input[3], LD_PRELOAD: library,
            ...(shape === "late-peer" ? { NATIVE_METADATA_TARGET: path.join(".git", "worktrees", path.basename(f.worktree)) } : { NATIVE_TARGET: f.worktree }) },
          stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
          signal: AbortSignal.any([input[4]!.signal!, AbortSignal.timeout(10_000)]),
        });
        let stdout = "", stderr = "";
        child.stdout!.on("data", bytes => { stdout += bytes; });
        child.stderr!.on("data", bytes => { stderr += bytes; });
        const exited = new Promise<number>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", code => resolve(code ?? 1));
        });
        const ready = new Promise<void>(resolve => {
          (child.stdio[3] as import("node:stream").Readable).once("data", () => { reached = true; resolve(); });
        });
        try {
          await Promise.race([ready, exited.then(() => { throw new Error("native add exited before its barrier"); })]);
          if (shape === "foreign-branch" || shape === "detached" || shape === "late-peer") {
            await f.git(f.repo, "worktree", "add", ...(shape === "late-peer" ? [] : ["--force"]),
              ...(shape === "detached" ? ["--detach"] : ["-b", "independent-peer"]), f.worktree, lane.branch);
            fs.writeFileSync(path.join(f.worktree, "staged.txt"), "unique staged version\n");
            await f.git(f.worktree, "add", "staged.txt");
            fs.writeFileSync(path.join(f.worktree, "staged.txt"), "peer working version\n");
            fs.writeFileSync(path.join(f.worktree, "sentinel.tmp"), "peer ignored version\n");
            fs.writeFileSync(path.join(f.worktree, ".gitignore"), "sentinel.tmp\n# staged peer version\n");
            await f.git(f.worktree, "add", ".gitignore");
            fs.writeFileSync(path.join(f.worktree, ".gitignore"), "sentinel.tmp\n# working peer version\n");
            gitDir = await f.git(f.worktree, "rev-parse", "--absolute-git-dir");
            preserved = metadata(gitDir);
            pointer = fs.readFileSync(path.join(f.worktree, ".git"), "utf8");
            if (shape !== "late-peer") fs.renameSync(f.worktree, offline);
          }
          (child.stdio[4] as import("node:stream").Writable).end("C");
          return { code: await exited, stdout, stderr };
        } finally {
          await stopFixtureProcess(child);
          await exited.catch(() => {});
        }
      };
      const before = f.h.spawnInputs.length;
      await tickPipelines([], f.h.ports);
      expect(reached).toBe(false);
      expect(loadPipelines()[0]!.state).toBe("needs_decision");
      expect(loadPipelines()[0]!.stateDetail).toContain(shape === "removed" || shape === "late-peer"
        ? "restore the checkout from that branch" : "restore the registered checkout");
      expect(f.h.spawnInputs).toHaveLength(before);
      expect(fs.existsSync(f.worktree)).toBe(false);
      if (shape !== "removed" && shape !== "late-peer") expect(metadata(gitDir)).toEqual(preserved);
      // This control is deliberately outside activation and only in the fixture.
      const control = await f.h.ports.exec("git", ["worktree", "add", "--", f.worktree, lane.branch], f.repo,
        undefined, { signal: new AbortController().signal });
      expect(reached).toBe(true);
      expect(f.h.spawnInputs).toHaveLength(before);
      if (shape === "late-peer") {
        expect(control.code).toBe(0);
        expect(metadata(gitDir)).toEqual(preserved);
        expect(fs.readFileSync(path.join(f.worktree, ".git"), "utf8")).not.toBe(pointer);
        expect(fs.readFileSync(path.join(f.worktree, ".gitignore"), "utf8")).not.toBe("sentinel.tmp\n# working peer version\n");
        expect(fs.readFileSync(path.join(f.worktree, "staged.txt"), "utf8")).toBe("peer working version\n");
        expect(fs.readFileSync(path.join(f.worktree, "sentinel.tmp"), "utf8")).toBe("peer ignored version\n");
      } else if (shape === "removed") {
        expect(control.code).toBe(0);
        expect((await patchPipeline(lane.id, { action: "retry-stage" }, f.h.ports)).error).toBeUndefined();
        await tickPipelines([], f.h.ports);
        const current = loadPipelines()[0]!;
        expect(current.state).toBe("running");
        expect(f.h.spawnInputs).toHaveLength(before + 1);
        expect(await f.git(f.worktree, "symbolic-ref", "HEAD")).toBe(`refs/heads/${lane.branch}`);
        expect(await f.git(f.worktree, "rev-parse", "HEAD")).toBe(lane.baseRef);
      } else {
        expect(control.code).not.toBe(0);
        expect(metadata(gitDir)).toEqual(preserved);
        expect(loadPipelines()[0]!.state).toBe("needs_decision");
        expect(f.h.spawnInputs).toHaveLength(before);
        expect(fs.existsSync(f.worktree)).toBe(false);
        const listing = await f.git(f.repo, "worktree", "list", "--porcelain");
        expect(listing).toContain(`worktree ${f.worktree}`);
        if (shape !== "deleted") {
          expect(listing).toContain(shape === "detached" ? "detached" : "branch refs/heads/independent-peer");
          fs.renameSync(offline, f.worktree);
          expect(await f.git(f.worktree, "show", ":staged.txt")).toBe("unique staged version");
          expect(fs.readFileSync(path.join(f.worktree, "staged.txt"), "utf8")).toBe("peer working version\n");
          expect(fs.readFileSync(path.join(f.worktree, "sentinel.tmp"), "utf8")).toBe("peer ignored version\n");
        }
      }
    } finally {
      savePipelines([]);
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  }, 30_000,
);


test("a peer taking the absent destination after the final listing retains every byte", async () => {
  const f = await realWorktreeLane("late-destination-owner", [
    { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null },
  ]);
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
    f.h.ports.worktreePresent = dir => fs.existsSync(dir);
    const exec = f.h.ports.exec;
    let injected = false;
    let pointer: Buffer | undefined, index: Buffer | undefined, registration: Buffer | undefined;
    let peerGitDir = "";
    const writes: string[][] = [];
    f.h.ports.exec = async (...input) => {
      const args = input[1];
      if (args[0] === "worktree" && args[1] !== "list") writes.push(args);
      const result = await exec(...input);
      if (!injected && args[0] === "worktree" && args[1] === "list") {
        injected = true;
        await f.git(f.repo, "worktree", "add", "-b", "peer-work", f.worktree, lane.branch);
        fs.writeFileSync(path.join(f.worktree, ".gitignore"), "sentinel.tmp\n# peer staged version\n");
        await f.git(f.worktree, "add", ".gitignore");
        fs.writeFileSync(path.join(f.worktree, ".gitignore"), "sentinel.tmp\n# peer working version\n");
        fs.writeFileSync(path.join(f.worktree, "sentinel.tmp"), "peer ignored version\n");
        peerGitDir = await f.git(f.worktree, "rev-parse", "--absolute-git-dir");
        pointer = fs.readFileSync(path.join(f.worktree, ".git"));
        index = fs.readFileSync(path.join(peerGitDir, "index"));
        registration = fs.readFileSync(path.join(peerGitDir, "gitdir"));
      }
      return result;
    };
    const before = f.h.spawnInputs.length;
    await tickPipelines([], f.h.ports);
    expect(injected).toBe(true);
    expect(writes).toEqual([]);
    expect(loadPipelines()[0]!.state).toBe("needs_decision");
    expect(f.h.spawnInputs).toHaveLength(before);
    expect(pointer).toEqual(fs.readFileSync(path.join(f.worktree, ".git")));
    expect(index).toEqual(fs.readFileSync(path.join(peerGitDir, "index")));
    expect(registration).toEqual(fs.readFileSync(path.join(peerGitDir, "gitdir")));
    expect(await f.git(f.worktree, "show", ":.gitignore")).toBe("sentinel.tmp\n# peer staged version");
    expect(fs.readFileSync(path.join(f.worktree, ".gitignore"), "utf8")).toBe("sentinel.tmp\n# peer working version\n");
    expect(fs.readFileSync(path.join(f.worktree, "sentinel.tmp"), "utf8")).toBe("peer ignored version\n");
    expect(await f.git(f.worktree, "symbolic-ref", "HEAD")).toBe("refs/heads/peer-work");
  } finally {
    savePipelines([]);
    fs.rmSync(f.root, { recursive: true, force: true });
  }
}, 30_000);
