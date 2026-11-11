import { expect, test, fs, path, tickPipelines } from "./engine.fixture";
import { realExec } from "@/lib/workflows/provision";
import { current, fixture, isolatePublicationGit } from "./publicationRecovery.fixture";

isolatePublicationGit();

test.each(["remote-ref", "remote-unchanged", "remote-long", "privacy-fail", "privacy-configuration",
  "privacy-configuration-long", "privacy-configuration-mixed", "privacy-configuration-input", "privacy-configuration-unreadable", "privacy-configuration-check",
  "comparator-budget", "comparator-budget-legacy", "check-fail", "success"] as const)(
  "remote-after-PASS consumer seam: %s", async shape => {
    const f = await fixture();
    try {
      f.h.ports.now = () => "2026-11-06T10:00:00.000Z";
      let repairs = 0, pushes = 0;
      f.h.ports.resumeSeveredTurn = async () => { repairs++; return true; };
      const execute = f.h.ports.exec;
      f.h.ports.exec = async (command, args, ...rest) => {
        if (command === "git" && args[0] === "push") pushes++;
        if (shape === "privacy-configuration-unreadable" && command === "git" && args[0] === "diff" && args.includes("--no-renames")) {
          return { code: 1, stdout: "", stderr: "comparison unavailable" };
        }
        return execute(command, args, ...rest);
      };
      let accepted = shape === "remote-unchanged" ? await f.git(f.lane(), "rev-parse", "HEAD") : await f.commit("accepted implementation");
      if (shape === "privacy-configuration-input") {
        fs.mkdirSync(path.join(f.lane(), "scripts"));
        fs.writeFileSync(path.join(f.lane(), "scripts/privacy-known-value-fingerprints.json"), "{}\n");
        await f.agentGit(f.lane(), "add", "scripts/privacy-known-value-fingerprints.json");
        await f.agentGit(f.lane(), "commit", "-m", "Change scanner input fixture");
        accepted = await f.git(f.lane(), "rev-parse", "HEAD");
      }
      const configuration = shape.startsWith("privacy-configuration");
      const capacity = shape.startsWith("comparator-budget");
      const retryable = capacity || shape === "privacy-configuration" || shape === "privacy-configuration-long";
      const localOutput = capacity
        ? `pre-push: privacy\nPRIVACY GATE: PASS\npre-push: touched tests\n${shape === "comparator-budget-legacy"
          ? "touched-tests: head: test run exceeded its 15 minute budget; gate error (blocking)"
          : "touched-tests: no verdict: head: test run exceeded its 15 minute budget; 58 of 70 files completed; nothing was judged"}\npre-push: touched tests: failed (${shape === "comparator-budget-legacy" ? 1 : 75})`
        : configuration
        ? `pre-push: privacy\nPRIVACY GATE: FAIL\nconfiguration_error: 1\n${shape === "privacy-configuration-mixed" ? "credential: 1\n" : ""}${shape === "privacy-configuration-check" ? "NEW file.test.ts: failing assertion\npre-push: touched tests: failed (1)\n" : ""}${shape === "privacy-configuration-long" ? "diagnostic ".repeat(500) + "\n" : ""}pre-push: bun failed (1); gate failed`
        : shape === "privacy-fail"
        ? "pre-push: privacy\nPRIVACY GATE: FAIL\npre-push: privacy: failed (1)"
        : shape === "check-fail"
          ? "pre-push: privacy\nPRIVACY GATE: PASS\npre-push: types\npre-push: types: failed (1)"
          : "pre-push: privacy\nPRIVACY GATE: PASS\npre-push: verified completed checks for this publication; transport admitted";
      const localFailure = capacity || configuration || shape === "privacy-fail" || shape === "check-fail";
      fs.writeFileSync(path.join(f.hooks, "pre-push"), `#!/bin/sh\ncat >&2 <<'OUTPUT'\n${localOutput}\nOUTPUT\nexit ${localFailure ? 1 : 0}\n`, { mode: 0o700 });
      if (shape.startsWith("remote-")) fs.writeFileSync(path.join(f.remote, "hooks", "pre-receive"),
        `#!/bin/sh\n${shape === "remote-long" ? `echo '${"diagnostic ".repeat(500)}' >&2\n` : ""}echo 'fatal error in commit_refs_rules' >&2\nexit 1\n`, { mode: 0o700 });
      await f.finish();
      const lane = current();
      const { publicationFailurePhase, publicationFailureCause } = await import("./git");
      const failure = lane.delivery?.operation?.result?.failure;
      const history = lane.publicationRecovery?.[accepted]?.history ?? [];
      expect(lane.lastPassedCommit).toBe(accepted);
      expect(await f.git(f.lane(), "rev-parse", "HEAD")).toBe(accepted);
      expect(await f.git(f.lane(), "status", "--porcelain")).toBe("");
      expect(pushes).toBe(1);
      if (shape === "success") {
        expect(lane.cursor?.stageId).toBe("review");
        expect(repairs).toBe(0);
        expect(history).toHaveLength(0);
        expect(await f.git(f.remote, "rev-parse", lane.delivery!.target.branch)).toBe(accepted);
      } else if (retryable) {
        expect(publicationFailurePhase(failure!)).toBe(capacity ? "touched tests" : "privacy");
        expect(history).toHaveLength(1);
        expect(history[0]).toMatchObject({ cause: capacity ? "infrastructure-deadline" : "interrupted", retryAt: "2026-11-06T10:01:00.000Z" });
        if (capacity) expect(failure?.retryableDeadline).toBe(true);
        else expect(failure?.privacyConfigurationFault).toBe(true);
        expect(history[0]!.detail).toContain(capacity ? "execution deadline without a verdict" : "privacy gate could not read its own configuration");
        expect(lane.runs[0]!.attempts[0]!.publicationRepair).toBeUndefined();
        expect(repairs).toBe(0);
        expect(lane.state).toBe("running");
        // A new process reads the writer's complete result, including proof
        // computed before output redaction and clipping.
        const reopened = await realExec(process.execPath, ["-e", `
          const { loadPipelines } = await import("./src/lib/pipelines/store.ts");
          console.log(JSON.stringify(loadPipelines()[0].delivery.operation.result));
        `], process.cwd(), { ...process.env }, { timeoutMs: 30_000 });
        expect(reopened.code, reopened.stderr).toBe(0);
        expect(JSON.parse(reopened.stdout)).toEqual(lane.delivery!.operation!.result);
        fs.writeFileSync(path.join(f.hooks, "pre-push"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
        f.h.ports.now = () => "2026-11-06T10:01:00.000Z";
        await tickPipelines([], f.h.ports);
        expect(await f.git(f.remote, "rev-parse", lane.delivery!.target.branch)).toBe(accepted);
        expect(current().cursor?.stageId).toBe("review");
        expect(repairs).toBe(0);
        expect(pushes).toBe(2);
      } else if (localFailure) {
        expect(publicationFailurePhase(failure!)).toBe(configuration || shape === "privacy-fail" ? "privacy" : "types");
        expect(failure?.privacyConfigurationFault).toBeUndefined();
        expect(lane.runs[0]!.attempts[0]!.publicationRepair).toBeDefined();
        expect(repairs).toBe(1);
        expect(history[0]!.cause).toBe("check-failure");
      } else {
        expect(publicationFailurePhase(failure!)).toBeNull();
        expect(publicationFailureCause(failure!)).toContain("remote: fatal error in commit_refs_rules");
        expect(failure!.outputTail.length).toBeLessThanOrEqual(4000);
        expect(history).toHaveLength(1);
        expect(history[0]).toMatchObject({ cause: "remote-refusal", retryAt: null });
        expect(lane.state).toBe("needs_decision");
        expect(lane.stateDetail).toContain("remote cause is unknown");
        expect(lane.runs[0]!.attempts[0]!.publicationRepair).toBeUndefined();
        expect(repairs).toBe(0);
        await tickPipelines([], f.h.ports);
        expect(current().publicationRecovery?.[accepted]?.history).toEqual(history);
        // A fresh controller reopens the persisted record beyond every retry
        // delay. Its effect ports count any unintended retry or repair.
        const reopened = await realExec(process.execPath, ["-e", `
          const { defaultPipelinePorts, tickPipelines } = await import("./src/lib/pipelines/engine.ts");
          const { loadPipelines } = await import("./src/lib/pipelines/store.ts");
          const ports = defaultPipelinePorts();
          let pushes = 0, repairs = 0;
          ports.now = () => "2026-11-07T10:00:00.000Z";
          ports.cpuAdmissionReconcile = async () => {};
          ports.drainHold = () => null;
          ports.scheduleTick = () => {};
          ports.conversationAgentActive = async () => false;
          ports.resumeSeveredTurn = async () => { repairs++; return false; };
          const exec = ports.exec;
          ports.exec = async (command, args, ...rest) => {
            if (command === "git" && args[0] === "push") { pushes++; return { code: 1, stdout: "", stderr: "unexpected push" }; }
            return exec(command, args, ...rest);
          };
          await tickPipelines([], ports);
          const lane = loadPipelines()[0];
          console.log(JSON.stringify({ pushes, repairs, accepted: lane.lastPassedCommit,
            state: lane.state, history: lane.publicationRecovery[lane.lastPassedCommit].history }));
        `], process.cwd(), { ...process.env }, { timeoutMs: 30_000 });
        expect(reopened.code, reopened.stderr).toBe(0);
        expect(JSON.parse(reopened.stdout)).toEqual({ pushes: 0, repairs: 0, accepted, state: "needs_decision", history });
        expect(pushes).toBe(1);
        expect(repairs).toBe(0);
      }
    } finally { f.close(); }
  }, 60_000);
