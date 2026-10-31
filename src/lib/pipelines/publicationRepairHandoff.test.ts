import { expect, test, fs, os, path, tickPipelines, savePipelines, rawPatchPipeline } from "./engine.fixture";
import { current, fixture, isolatePublicationGit } from "./publicationRecovery.fixture";
import { realExec } from "@/lib/workflows/provision";
import { stageGitReceiptDirectory } from "@/lib/git/stageAttemptGuard";
import { RuntimeJournal } from "@/runtime-host/journal";
import { RuntimeHost } from "@/runtime-host/host";
import { serveRuntimeHost } from "@/runtime-host/socket";
import { once } from "node:events";
import { defaultPipelinePorts } from "./engine";

isolatePublicationGit();

test.each(["clean", "staged", "staged-unstaged", "saved-intent"] as const)(
  "a dead repair retains accepted history after rollback (%s)", async shape => {
    const f = await fixture();
    try {
      const clock = f.h.ports.now(); f.h.ports.now = () => clock;
      f.h.ports.resumeSeveredTurn = async () => true;
      const older = await f.commit("earlier implementation");
      const accepted = await f.commit("accepted implementation");
      f.refuse(); await f.finish();
      const original = structuredClone(current().runs[0]!.attempts[0]!);
      expect(original.publicationRepair?.sha).toBe(accepted);
      const receipts = path.join(stageGitReceiptDirectory(original.launchId!), "commits");
      const recorded = fs.readdirSync(receipts).sort().map(name => [name, fs.readFileSync(path.join(receipts, name), "utf8")]);
      expect(recorded.map(([name]) => name)).toEqual(expect.arrayContaining([older, accepted]));
      f.h.durableTurns.set(original.agentPath!, { turn: "busy", message: null, lastRecordAt: Date.parse(clock) });
      if (shape === "saved-intent") {
        const stopped = await repairController(f, "intent");
        expect(stopped.code, stopped.stderr).toBe(0);
        expect(current().runs[0]!.attempts[0]!.publicationRepair?.commitStartedHead).toBe(accepted);
      }
      // Move only this fixture's checkout to an older, genuinely receipted
      // commit. Both accepted commits retain their creation receipts.
      await f.git(f.lane(), "update-ref", "HEAD", older, accepted);
      await f.git(f.lane(), "restore", "--source=HEAD", "--staged", "--worktree", "--", "file.txt");
      if (shape === "staged" || shape === "staged-unstaged") {
        fs.writeFileSync(path.join(f.lane(), "file.txt"), "staged repair\n");
        await f.agentGit(f.lane(), "add", "file.txt");
      }
      if (shape === "staged-unstaged") fs.writeFileSync(path.join(f.lane(), "file.txt"), "unstaged remainder\n");
      const tree = await f.git(f.lane(), "write-tree");
      const contents = fs.readFileSync(path.join(f.lane(), "file.txt"), "utf8");
      fs.unlinkSync(path.join(f.hooks, "pre-push"));
      f.h.setConversationActive(false);
      f.h.ports.conversationTurnInterrupted = async () => "dead";
      const execute = f.h.ports.exec;
      const mutations: string[] = [];
      f.h.ports.exec = async (command, args, ...rest) => {
        if (command === "git" && ["restore", "add", "commit", "push"].includes(args[0]!)) mutations.push(args[0]!);
        return execute(command, args, ...rest);
      };
      await tickPipelines([], f.h.ports);
      const result = current(), attempt = result.runs[0]!.attempts[0]!;
      expect(result.state).toBe("needs_decision");
      expect(result.lastPassedCommit).toBe(accepted);
      expect(result.publishedCommit).toBeNull();
      expect(result.cursor?.stageId).toBe("build");
      expect(attempt.report).toEqual(original.report);
      expect(attempt.verdict).toEqual(original.verdict);
      expect(attempt.publicationRepair?.sha).toBe(accepted);
      expect(attempt.publicationRepair?.committedSha).toBeUndefined();
      expect(result.runs[0]!.attempts).toHaveLength(1);
      expect(mutations).toEqual([]);
      expect(await f.git(f.lane(), "rev-parse", "HEAD")).toBe(older);
      expect(await f.git(f.lane(), "write-tree")).toBe(tree);
      expect(fs.readFileSync(path.join(f.lane(), "file.txt"), "utf8")).toBe(contents);
      expect(fs.readdirSync(receipts).sort().map(name => [name, fs.readFileSync(path.join(receipts, name), "utf8")])).toEqual(recorded);
      expect(await f.git(f.repo, "ls-remote", "--heads", "origin", result.delivery!.target.branch)).toBe("");
    } finally { f.close(); }
  });

test.each(["committed", "staged", "parked-staged", "committed-staged", "staged-unstaged", "unstaged", "live"] as const)(
  "a requested publication repair hands a %s dead producer head to review", async shape => {
    const f = await fixture();
    try {
      let clock = f.h.ports.now();
      f.h.ports.now = () => clock;
      let sends = 0;
      f.h.ports.resumeSeveredTurn = async () => { sends++; return true; };
      const accepted = await f.commit("implementation");
      f.refuse(); await f.finish();
      const original = structuredClone(current().runs[0]!.attempts[0]!);
      expect(original.publicationRepair?.requestedAt).toBeDefined();
      expect(sends).toBe(1);
      f.h.durableTurns.set(original.agentPath!, { turn: "busy", message: null,
        lastRecordAt: Date.parse(f.h.ports.now()) });
      let repaired = accepted;
      if (shape === "committed" || shape === "committed-staged" || shape === "live") repaired = await f.commit("producer repair");
      const parent = repaired;
      if (shape === "staged" || shape === "parked-staged" || shape === "staged-unstaged" || shape === "unstaged" || shape === "committed-staged") {
        fs.writeFileSync(path.join(f.lane(), "file.txt"), "staged producer repair\n");
        if (shape !== "unstaged") await f.agentGit(f.lane(), "add", "file.txt");
        if (shape === "staged-unstaged") fs.writeFileSync(path.join(f.lane(), "file.txt"), "unstaged remainder\n");
      }
      fs.unlinkSync(path.join(f.hooks, "pre-push"));
      if (shape === "parked-staged") {
        clock = new Date(Date.parse(clock) + 21 * 60_000).toISOString();
        f.h.advanceWallClock(21 * 60_000);
        await tickPipelines([], f.h.ports);
        expect(current().state).toBe("needs_decision");
      }
      f.h.setConversationActive(shape === "live");
      f.h.ports.conversationTurnInterrupted = async () => shape === "live" ? null : "dead";
      if (shape === "parked-staged") expect((await rawPatchPipeline(current().id, { action: "retry-stage" }, f.h.ports)).error).toBeUndefined();
      await tickPipelines([], f.h.ports);
      const result = current();
      const attempt = result.runs[0]!.attempts[0]!;
      expect(attempt.report).toEqual(original.report);
      expect(attempt.verdict).toEqual(original.verdict);
      expect(result.runs[0]!.attempts).toHaveLength(1);
      expect(sends).toBe(1);
      if (shape === "live") {
        expect(result.lastPassedCommit).toBe(accepted);
        expect(result.cursor?.stageId).toBe("build");
        expect(attempt.publicationRepair?.committedSha).toBeUndefined();
        expect(await f.git(f.lane(), "rev-parse", "HEAD")).toBe(repaired);
        return;
      }
      if (shape === "staged" || shape === "parked-staged" || shape === "staged-unstaged" || shape === "committed-staged") {
        repaired = await f.git(f.lane(), "rev-parse", "HEAD");
        expect(repaired).not.toBe(accepted);
        expect(await f.git(f.lane(), "show", "HEAD:file.txt")).toBe("staged producer repair");
        expect(await f.git(f.lane(), "rev-parse", "HEAD^")).toBe(parent);
      }
      if (shape === "unstaged") {
        expect(fs.readFileSync(path.join(f.lane(), "file.txt"), "utf8")).toBe("implementation\n");
        expect(attempt.publicationRepairAbandonment?.reason).toContain("discarded unstaged");
      }
      expect(result).toMatchObject({ state: "running", lastPassedCommit: repaired, publishedCommit: repaired,
        cursor: { stageId: "review", state: "pending" } });
      expect(await f.git(f.remote, "rev-parse", result.delivery!.target.branch)).toBe(repaired);
      expect(attempt.publicationRepair?.committedSha).toBe(repaired);
      expect(attempt.publicationRepairAbandonment?.reason).toContain("host is gone");
      expect(await f.git(f.lane(), "status", "--porcelain")).toBe("");
      await tickPipelines([], f.h.ports);
      const reviewer = current().runs.find(run => run.stageId === "review")?.attempts[0];
      expect(reviewer?.effectiveRole.roleId).toBe("reviewer");
      const start = JSON.parse(fs.readFileSync(path.join(stageGitReceiptDirectory(reviewer!.launchId!), "start.json"), "utf8"));
      expect(start.head).toBe(repaired);
      expect(start.worktree).toBe(f.lane());
    } finally { f.close(); }
  });

test.each(["dead", "unhosted", "scoped-unhosted", "conflict", "idle", "running", "missing", "attention", "unavailable", "aborted"] as const)(
  "publication repair uses native host absence with a completed turn (%s)", async state => {
    const f = await fixture();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "repair-host-proof-"));
    const journal = new RuntimeJournal(path.join(root, "runtime.sqlite"));
    const host = new RuntimeHost(journal);
    const socketPath = path.join(root, "host.sock");
    const priorSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
    let server: ReturnType<typeof serveRuntimeHost> | undefined;
    process.env.LLV_RUNTIME_HOST_SOCKET = socketPath;
    try {
      const clock = f.h.ports.now(); f.h.ports.now = () => clock;
      f.h.ports.resumeSeveredTurn = async () => true;
      const accepted = await f.commit("implementation"); f.refuse(); await f.finish();
      const worker = current().runs[0]!.attempts[0]!;
      f.h.durableTurns.set(worker.agentPath!, { turn: "busy", message: null, lastRecordAt: Date.parse(clock) });
      const repaired = await f.commit("producer repair");
      fs.unlinkSync(path.join(f.hooks, "pre-push"));
      if (state !== "unavailable") {
        server = serveRuntimeHost(socketPath, { handle: request => host.handle(request) });
        await once(server, "listening");
      }
      if (state !== "missing" && state !== "unavailable") {
        journal.append({ scope: { type: "session", id: "repair-owner" }, kind: "session-status",
          payload: { conversationId: worker.conversationId!, sessionKey: { engine: "codex", sessionId: "repair-owner" },
            hostKind: "codex-app-server", host: state === "idle" || state === "running" ? "hosted" : state === "attention" ? "dead" : state === "scoped-unhosted" || state === "aborted" ? "unhosted" : state,
            turn: state === "running" ? "running" : "idle", attentionIds: state === "attention" ? ["repair-attention"] : [] },
        });
      }
      const abort = new AbortController();
      if (state === "aborted") abort.abort();
      const production = defaultPipelinePorts({ runtimeObservation: {
        ...(state === "scoped-unhosted" ? { conversationIds: ["other-runtime-session"] } : {}),
        ...(state === "aborted" ? { signal: abort.signal } : {}),
      } });
      const gone = state === "dead" || state === "unhosted" || state === "scoped-unhosted";
      if (production.publicationRepairProducerGone) expect(await production.publicationRepairProducerGone(worker.conversationId!)).toBe(gone ? true
        : state === "idle" || state === "running" ? false : null);
      f.h.ports.conversationAgentActive = production.conversationAgentActive;
      f.h.ports.publicationRepairProducerGone = production.publicationRepairProducerGone;
      // A completed host turn suppresses the interruption probe. Custody
      // still reads the native session's independent host-absence evidence.
      f.h.ports.conversationTurnInterrupted = async () => null;
      await tickPipelines([], f.h.ports);
      expect(current().lastPassedCommit).toBe(gone ? repaired : accepted);
      expect(current().cursor?.stageId).toBe(gone ? "review" : "build");
    } finally {
      if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
      if (priorSocket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET;
      else process.env.LLV_RUNTIME_HOST_SOCKET = priorSocket;
      journal.close(); fs.rmSync(root, { recursive: true, force: true }); f.close();
    }
  });

async function repairController(f: Awaited<ReturnType<typeof fixture>>, crash: "intent" | "commit" | "accepted" | null, race?: "index" | "worktree", hosted = false) {
  return realExec("bun", ["-e", `
      const { spyOn } = await import("bun:test");
      const pullRequests = await import("./src/lib/pipelines/stagePullRequest.ts");
      spyOn(pullRequests, "ensureStagePullRequest").mockImplementation(async () => ({ ok: true }));
      const { defaultPipelinePorts, tickPipelines } = await import("./src/lib/pipelines/engine.ts");
      const { loadPipelines } = await import("./src/lib/pipelines/store.ts");
      const { realExec } = await import("./src/lib/workflows/provision.ts");
      const ports = defaultPipelinePorts();
      ports.now = () => ${JSON.stringify(f.h.ports.now())};
      ports.structuredDeliveryPublication = () => "ready";
      ports.cpuAdmissionReconcile = async () => {};
      ports.drainHold = () => null;
      ports.deferStageGit = false;
      ports.scheduleTick = () => {};
      ports.conversationAgentActive = async () => false;
      ports.publicationRepairProducerGone = undefined;
      ports.conversationTurnInterrupted = async () => ${hosted} ? "idle" : "dead";
      ports.conversationDeliveryOutstanding = () => false;
      ports.resumeSeveredTurn = async () => true;
      ports.durableTurnEvidence = async () => {
        const repair = loadPipelines()[0].runs[0].attempts[0].publicationRepair;
        const ts = Math.max(Date.parse(ports.now()), repair.messageTs ?? 0) + 1;
        return ${hosted} ? { turn: "terminal", message: { text: "Repaired", ts }, lastRecordAt: ts }
          : { turn: "busy", message: null };
      };
      ports.spawnAgent = async () => { throw new Error("unexpected producer launch"); };
      let raced = false, checkpointValidated = false;
      ports.exec = async (...args) => {
        const repair = loadPipelines()[0].runs[0].attempts[0].publicationRepair;
        if (${JSON.stringify(crash)} === "accepted" && repair.committedSha
          || ${JSON.stringify(crash)} === "intent" && repair.commitStartedHead && !repair.committedSha) process.exit(0);
        const result = await realExec(...args);
        if (args[0] === "git" && args[1].join(" ") === "diff --quiet --no-ext-diff --no-textconv" && result.code === 0) checkpointValidated = true;
        if (${JSON.stringify(race ?? null)} && checkpointValidated && !raced && repair.commitStartedHead && !repair.committedSha
          && args[0] === "git" && args[1][0] === "status") {
          raced = true;
          const fs = await import("node:fs"), path = await import("node:path");
          const lane = loadPipelines()[0].worktreeDir;
          fs.writeFileSync(path.join(lane, "file.txt"), "later staged work\\n");
          if (${JSON.stringify(race ?? null)} === "index") {
            const staged = await realExec("git", ["add", "file.txt"], lane);
            if (staged.code !== 0) throw new Error(staged.stderr);
          }
        }
        if (${JSON.stringify(crash)} === "commit" && args[0] === "git" && args[1][0] === "commit" && result.code === 0) process.exit(0);
        return result;
      };
      await tickPipelines([], ports);
    `], process.cwd(), { ...process.env }, { timeoutMs: 30_000 });
}

test.each(["automatic", "retry-stage", "foreign", "dirty", "missing-receipt"] as const)(
  "a live-origin repair intent survives later host loss (%s)", async shape => {
    const f = await fixture();
    try {
      const clock = f.h.ports.now(); f.h.ports.now = () => clock;
      f.h.ports.resumeSeveredTurn = async () => true;
      const accepted = await f.commit("implementation"); f.refuse(); await f.finish();
      const original = structuredClone(current().runs[0]!.attempts[0]!);
      const repaired = await f.commit("producer repair");
      fs.unlinkSync(path.join(f.hooks, "pre-push"));
      const stopped = await repairController(f, "intent", undefined, true);
      expect(stopped.code, stopped.stderr).toBe(0);
      const checkpoint = current().runs[0]!.attempts[0]!.publicationRepair!;
      expect(checkpoint.commitStartedHead).toBe(repaired);
      expect(checkpoint.commitCustody).toBeUndefined();
      expect(checkpoint.committedSha).toBeUndefined();
      const receipt = path.join(stageGitReceiptDirectory(original.launchId!), "commits", repaired);
      expect(fs.readFileSync(receipt, "utf8")).toBe("");
      let expectedHead = repaired;
      if (shape === "foreign") {
        const foreign = path.join(f.root, "foreign-live-replay");
        await f.git(f.repo, "worktree", "add", "--detach", foreign, repaired);
        await f.git(foreign, "commit", "--allow-empty", "-m", "foreign repair");
        expectedHead = await f.git(foreign, "rev-parse", "HEAD");
        await f.git(f.lane(), "update-ref", "HEAD", expectedHead, repaired);
      }
      if (shape === "dirty") {
        fs.writeFileSync(path.join(f.lane(), "file.txt"), "later staged work\n");
        await f.agentGit(f.lane(), "add", "file.txt");
      }
      if (shape === "missing-receipt") fs.unlinkSync(receipt);
      if (shape === "retry-stage") {
        const parked = current();
        parked.state = "needs_decision";
        expect(checkpoint.parkDetail).toBeDefined();
        parked.stateDetail = checkpoint.parkDetail!;
        savePipelines([parked]);
        f.h.ports.conversationTurnInterrupted = async () => "dead";
        expect((await rawPatchPipeline(parked.id, { action: "retry-stage" }, f.h.ports)).error).toBeUndefined();
      }
      const resumed = await repairController(f, null);
      expect(resumed.code, resumed.stderr).toBe(0);
      const result = current(), attempt = result.runs[0]!.attempts[0]!;
      expect(attempt.report).toEqual(original.report);
      expect(attempt.verdict).toEqual(original.verdict);
      expect(result.runs[0]!.attempts).toHaveLength(1);
      expect(await f.git(f.lane(), "rev-parse", "HEAD")).toBe(expectedHead);
      expect(await f.git(f.lane(), "merge-base", "--is-ancestor", accepted, expectedHead)).toBe("");
      if (shape === "automatic" || shape === "retry-stage") {
        expect(result).toMatchObject({ state: "running", lastPassedCommit: repaired, publishedCommit: repaired,
          cursor: { stageId: "review", state: "pending" } });
        expect(attempt.publicationRepair?.committedSha).toBe(repaired);
        expect(fs.readFileSync(receipt, "utf8")).toBe("");
        expect(await f.git(f.lane(), "status", "--porcelain")).toBe("");
      } else {
        expect(result.state).toBe("needs_decision");
        expect(result.lastPassedCommit).toBe(accepted);
        expect(attempt.publicationRepair?.committedSha).toBeUndefined();
        expect(await f.git(f.repo, "ls-remote", "--heads", "origin", result.delivery!.target.branch)).toBe("");
        if (shape === "dirty") {
          expect(await f.git(f.lane(), "show", ":file.txt")).toBe("later staged work");
          expect(fs.readFileSync(path.join(f.lane(), "file.txt"), "utf8")).toBe("later staged work\n");
        }
      }
    } finally { f.close(); }
  });

test("a controller restart adopts the dead producer repair checkpoint without another commit", async () => {
  const f = await fixture();
  try {
    const clock = f.h.ports.now();
    f.h.ports.now = () => clock;
    f.h.ports.resumeSeveredTurn = async () => true;
    const accepted = await f.commit("implementation"); f.refuse(); await f.finish();
    const original = structuredClone(current().runs[0]!.attempts[0]!);
    fs.writeFileSync(path.join(f.lane(), "file.txt"), "staged repair\n");
    await f.agentGit(f.lane(), "add", "file.txt");
    fs.unlinkSync(path.join(f.hooks, "pre-push"));
    const stopped = await repairController(f, "accepted");
    expect(stopped.code, stopped.stderr).toBe(0);
    const checkpoint = current().runs[0]!.attempts[0]!.publicationRepair!;
    expect(checkpoint.committedSha).toBeDefined();
    expect(checkpoint.republishQueued).toBeUndefined();
    const abandonment = current().runs[0]!.attempts[0]!.publicationRepairAbandonment;
    expect(abandonment?.at).toBe(clock);
    expect(abandonment?.reason).toContain("host is gone");
    expect(current().lastPassedCommit).toBe(accepted);
    const restarted = await repairController(f, null);
    expect(restarted.code, restarted.stderr).toBe(0);
    expect(current()).toMatchObject({ lastPassedCommit: checkpoint.committedSha,
      publishedCommit: checkpoint.committedSha, cursor: { stageId: "review", state: "pending" } });
    expect(current().runs[0]!.attempts[0]!.report).toEqual(original.report);
    expect(current().runs[0]!.attempts[0]!.publicationRepairAbandonment).toEqual(abandonment);
    expect(await f.git(f.lane(), "rev-parse", "HEAD^")).toBe(accepted);
  } finally { f.close(); }
});

test.each(["active", "unknown", "idle", "queued", "background", "revived", "revived-clean", "unrecorded", "rewritten", "untracked", "no-review", "discard-refused"] as const)(
  "a dead publication repair retains its %s fence", async fence => {
    const f = await fixture();
    try {
      const clock = f.h.ports.now();
      f.h.ports.now = () => clock;
      f.h.ports.resumeSeveredTurn = async () => true;
      const accepted = await f.commit("implementation"); f.refuse(); await f.finish();
      const original = current().runs[0]!.attempts[0]!;
      expect(original.publicationRepair?.requestedAt).toBeDefined();
      f.h.durableTurns.set(original.agentPath!, { turn: "busy", message: null,
        lastRecordAt: Date.parse(f.h.ports.now()) });
      const repaired = fence === "rewritten" ? accepted : await f.commit("producer repair");
      if (fence !== "revived-clean") {
        fs.writeFileSync(path.join(f.lane(), "file.txt"), "staged repair\n");
        await f.agentGit(f.lane(), "add", "file.txt");
      }
      fs.unlinkSync(path.join(f.hooks, "pre-push"));
      f.h.setConversationActive(fence === "active" ? true : fence === "unknown" ? null : false);
      f.h.ports.conversationTurnInterrupted = async () => fence === "idle" ? "idle" : "dead";
      if (fence === "queued") f.h.ports.conversationDeliveryOutstanding = () => true;
      if (fence === "background") f.h.durableTurns.set(original.agentPath!, { turn: "busy", message: null,
        backgroundTasks: [{ id: "repair-command", kind: "command", startedAt: Date.parse(clock), expiresAt: null }] });
      if (fence === "unrecorded") fs.unlinkSync(path.join(stageGitReceiptDirectory(original.launchId!), "commits", repaired));
      if (fence === "rewritten") await f.agentGit(f.lane(), "commit", "--amend", "-m", "rewritten repair");
      if (fence === "untracked") fs.writeFileSync(path.join(f.lane(), "untracked.txt"), "preserve this\n");
      if (fence === "no-review") {
        const stored = current(); stored.stages[0]!.next = null; savePipelines([stored]);
      }
      let restoreCalls = 0;
      if (fence === "discard-refused") {
        fs.writeFileSync(path.join(f.lane(), "file.txt"), "unstaged repair\n");
        const execute = f.h.ports.exec;
        f.h.ports.exec = async (command, args, ...rest) => {
          if (command === "git" && args[0] === "restore") { restoreCalls++; return { code: 1, stdout: "", stderr: "restore refused" }; }
          return execute(command, args, ...rest);
        };
      }
      if (fence === "revived" || fence === "revived-clean") {
        const execute = f.h.ports.exec;
        f.h.ports.exec = async (command, args, ...rest) => {
          if (command === "git" && (fence === "revived" && args[0] === "write-tree"
            || fence === "revived-clean" && args[0] === "diff" && args[1] === "--quiet" && args.includes(accepted))) f.h.setConversationActive(true);
          return execute(command, args, ...rest);
        };
      }
      const head = await f.git(f.lane(), "rev-parse", "HEAD");
      await tickPipelines([], f.h.ports);
      expect(current().lastPassedCommit).toBe(accepted);
      expect(current().publishedCommit).not.toBe(head);
      expect(current().cursor?.stageId).toBe("build");
      expect(current().runs[0]!.attempts[0]!.publicationRepair?.committedSha).toBeUndefined();
      expect(await f.git(f.lane(), "rev-parse", "HEAD")).toBe(head);
      expect(fs.readFileSync(path.join(f.lane(), "file.txt"), "utf8")).toBe(fence === "discard-refused" ? "unstaged repair\n"
        : fence === "revived-clean" ? "producer repair\n" : "staged repair\n");
      if (fence === "discard-refused") {
        expect(restoreCalls).toBe(1);
        const reason = current().runs[0]!.attempts[0]!.publicationRepairAbandonment?.reason;
        expect(reason).toContain("discarding unstaged repair");
        expect(reason).not.toContain("discarded unstaged repair");
        expect(await f.git(f.lane(), "show", ":file.txt")).toBe("staged repair");
      }
    } finally { f.close(); }
  });

test.each(["staged", "staged-unstaged"] as const)("dead repair custody refuses a head moved after its producer receipt was proved (%s)", async shape => {
  const unstaged = shape === "staged-unstaged";
  const f = await fixture();
  try {
    const clock = f.h.ports.now(); f.h.ports.now = () => clock;
    f.h.ports.resumeSeveredTurn = async () => true;
    const accepted = await f.commit("implementation"); f.refuse(); await f.finish();
    const worker = current().runs[0]!.attempts[0]!;
    f.h.durableTurns.set(worker.agentPath!, { turn: "busy", message: null, lastRecordAt: Date.parse(clock) });
    const repaired = await f.commit("producer repair");
    const foreign = path.join(f.root, "post-proof-repair");
    await f.git(f.repo, "worktree", "add", "--detach", foreign, repaired);
    await f.git(foreign, "commit", "--allow-empty", "-m", "unrecorded post-proof head");
    const moved = await f.git(foreign, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(f.lane(), "file.txt"), "staged repair\n");
    await f.agentGit(f.lane(), "add", "file.txt");
    if (unstaged) fs.writeFileSync(path.join(f.lane(), "file.txt"), "unstaged remainder\n");
    fs.unlinkSync(path.join(f.hooks, "pre-push"));
    f.h.setConversationActive(false);
    f.h.ports.conversationTurnInterrupted = async () => "dead";
    const execute = f.h.ports.exec;
    let moves = 0;
    f.h.ports.exec = async (command, args, ...rest) => {
      const result = await execute(command, args, ...rest);
      if (command === "git" && args.join(" ") === "ls-files --others --exclude-standard -z" && moves++ === 0) {
        const changed = await f.execute("git", ["update-ref", "HEAD", moved, repaired], f.lane());
        expect(changed.code, changed.stderr).toBe(0);
      }
      return result;
    };
    await tickPipelines([], f.h.ports);
    expect(moves).toBe(1);
    expect(current().lastPassedCommit).toBe(accepted);
    expect(current().stateDetail).toContain("repair head moved");
    expect(current().runs[0]!.attempts[0]!.publicationRepair?.committedSha).toBeUndefined();
    expect(await f.git(f.lane(), "rev-parse", "HEAD")).toBe(moved);
    expect(await f.git(f.lane(), "show", ":file.txt")).toBe("staged repair");
    expect(fs.readFileSync(path.join(f.lane(), "file.txt"), "utf8")).toBe(unstaged ? "unstaged remainder\n" : "staged repair\n");
  } finally { f.close(); }
});


test.each(["unchanged", "foreign", "legacy-foreign", "changed-index", "reset-index", "raced-index", "raced-worktree", "index-lock", "after-commit", "after-commit-foreign"] as const)(
  "repair custody replay preserves exact ownership (%s)", async shape => {
    const f = await fixture();
    try {
      const clock = f.h.ports.now(); f.h.ports.now = () => clock;
      f.h.ports.resumeSeveredTurn = async () => true;
      const accepted = await f.commit("implementation"); f.refuse(); await f.finish();
      const original = structuredClone(current().runs[0]!.attempts[0]!);
      fs.writeFileSync(path.join(f.lane(), "file.txt"), "staged repair\n");
      await f.agentGit(f.lane(), "add", "file.txt");
      const tree = await f.git(f.lane(), "write-tree");
      fs.unlinkSync(path.join(f.hooks, "pre-push"));
      const stopped = await repairController(f, shape.startsWith("after-commit") ? "commit" : "intent");
      expect(stopped.code, stopped.stderr).toBe(0);
      const checkpoint = current().runs[0]!.attempts[0]!.publicationRepair!;
      expect(checkpoint.commitStartedHead).toBe(accepted);
      expect(checkpoint.committedSha).toBeUndefined();
      expect(current().lastPassedCommit).toBe(accepted);
      let foreignHead: string | undefined;
      if (shape === "foreign" || shape === "legacy-foreign" || shape === "after-commit-foreign") {
        const parent = await f.git(f.lane(), "rev-parse", "HEAD");
        const foreign = path.join(f.root, "foreign-replay");
        await f.git(f.repo, "worktree", "add", "--detach", foreign, parent);
        fs.writeFileSync(path.join(foreign, "file.txt"), "staged repair\n");
        await f.git(foreign, "add", "file.txt");
        await f.git(foreign, "commit", "--allow-empty", "-m", "foreign repair");
        foreignHead = await f.git(foreign, "rev-parse", "HEAD");
        // The checkpoint tree alone cannot prove ownership of this head.
        expect(await f.git(foreign, "rev-parse", "HEAD^{tree}")).toBe(tree);
        await f.git(f.lane(), "update-ref", "HEAD", foreignHead, parent);
      }
      if (shape === "legacy-foreign") {
        const stored = current();
        delete stored.runs[0]!.attempts[0]!.publicationRepair!.commitCustody;
        savePipelines([stored]);
      }
      if (shape === "reset-index") {
        await f.git(f.lane(), "restore", "--source=HEAD", "--staged", "--worktree", "--", "file.txt");
      }
      if (shape === "changed-index") {
        fs.writeFileSync(path.join(f.lane(), "file.txt"), "later staged work\n");
        await f.agentGit(f.lane(), "add", "file.txt");
      }
      if (shape === "index-lock") {
        const lock = `${await f.git(f.lane(), "rev-parse", "--path-format=absolute", "--git-path", "index")}.lock`;
        fs.writeFileSync(lock, "held\n");
        const refused = await repairController(f, null);
        expect(refused.code, refused.stderr).toBe(0);
        expect(current().state).toBe("needs_decision");
        expect(current().lastPassedCommit).toBe(accepted);
        expect(fs.readFileSync(lock, "utf8")).toBe("held\n");
        fs.unlinkSync(lock);
        expect(await f.git(f.lane(), "write-tree")).toBe(tree);
        expect((await rawPatchPipeline(current().id, { action: "retry-stage" }, f.h.ports)).error).toBeUndefined();
      }
      const resumed = await repairController(f, null, shape === "raced-index" ? "index" : shape === "raced-worktree" ? "worktree" : undefined);
      expect(resumed.code, resumed.stderr).toBe(0);
      const result = current();
      const attempt = result.runs[0]!.attempts[0]!;
      expect(attempt.report).toEqual(original.report);
      expect(attempt.verdict).toEqual(original.verdict);
      if (foreignHead || shape === "changed-index" || shape === "reset-index" || shape.startsWith("raced-")) {
        expect(result.state).toBe("needs_decision");
        expect(result.lastPassedCommit).toBe(accepted);
        expect(result.publishedCommit).not.toBe(foreignHead);
        expect(attempt.publicationRepair?.committedSha).toBeUndefined();
        expect(await f.git(f.lane(), "rev-parse", "HEAD")).toBe(foreignHead ?? accepted);
        const staged = foreignHead || shape === "raced-worktree" ? "staged repair" : shape === "reset-index" ? "implementation" : "later staged work";
        const worktree = foreignHead ? "staged repair" : shape === "reset-index" ? "implementation" : "later staged work";
        expect(await f.git(f.lane(), "show", ":file.txt")).toBe(staged);
        expect(fs.readFileSync(path.join(f.lane(), "file.txt"), "utf8")).toBe(`${worktree}\n`);
        expect(await f.git(f.repo, "ls-remote", "--heads", "origin", result.delivery!.target.branch)).toBe("");
      } else {
        const repaired = await f.git(f.lane(), "rev-parse", "HEAD");
        expect(repaired).not.toBe(accepted);
        expect(await f.git(f.lane(), "rev-parse", "HEAD^")).toBe(accepted);
        expect(await f.git(f.lane(), "rev-parse", "HEAD^{tree}")).toBe(tree);
        expect(result).toMatchObject({ lastPassedCommit: repaired, publishedCommit: repaired,
          cursor: { stageId: "review", state: "pending" } });
        expect(attempt.publicationRepair?.committedSha).toBe(repaired);
      }
    } finally { f.close(); }
  });
