import { expect, test, fs, path, savePipelines } from "./engine.fixture";
import { current, fixture, isolatePublicationGit } from "./publicationRecovery.fixture";
import { settlePendingStageGit } from "./engine";
import { realExec } from "@/lib/workflows/provision";

isolatePublicationGit();

const variants = [
  { shape: "unchanged", stop: "none" },
  ...["staged", "committed"].flatMap(shape => ["none", "before restore", "after worktree", "after index"].map(stop => ({ shape, stop }))),
  ...["forced staged", "forced committed"].flatMap(shape => ["none", "after worktree", "after index"].map(stop => ({ shape, stop }))),
  { shape: "directory", stop: "after worktree" },
  { shape: "untracked", stop: "after worktree" },
  { shape: "legacy", stop: "none" },
  { shape: "raced index", stop: "none" },
  { shape: "raced worktree", stop: "none" },
];

test.each(variants)("refused repair preserves handoff-ignored bytes ($shape, $stop)", async ({ shape, stop }) => {
  const f = await fixture();
  try {
    let clock = f.h.ports.now(); f.h.ports.now = () => clock;
    f.h.ports.resumeSeveredTurn = async () => true;
    f.h.ports.publicationRepairProducerState = async () => "idle";
    const ignoredPath = shape === "directory" ? "local-context/nested.txt" : "local-context.txt";
    const policy = shape === "directory" ? "local-context/\n" : "local-context.txt\n";
    const contents = Buffer.from("context present before repair\n\0retained bytes\n");
    fs.writeFileSync(path.join(f.lane(), ".gitignore"), policy);
    await f.agentGit(f.lane(), "add", ".gitignore");
    const accepted = await f.commit("accepted implementation");
    fs.mkdirSync(path.dirname(path.join(f.lane(), ignoredPath)), { recursive: true });
    fs.writeFileSync(path.join(f.lane(), ignoredPath), contents);
    f.refuse(); await f.finish();
    const original = structuredClone(current().runs[0]!.attempts[0]!);
    expect(original.publicationRepair?.sha).toBe(accepted);
    if (shape === "legacy") {
      const lane = current();
      delete lane.runs[0]!.attempts[0]!.publicationRepair!.cleanHead!.ignoredPaths;
      savePipelines([lane]);
    }
    if (shape !== "unchanged" && !shape.startsWith("forced")) fs.writeFileSync(path.join(f.lane(), ".gitignore"), "# repaired ignore policy\n");
    fs.writeFileSync(path.join(f.lane(), "created.txt"), "ordinary new repair output\n");
    if (shape === "untracked") await f.agentGit(f.lane(), "add", ".gitignore", "created.txt");
    else await f.agentGit(f.lane(), "add", "--all");
    if (shape.startsWith("forced")) await f.agentGit(f.lane(), "add", "--force", ignoredPath);
    if (shape !== "staged" && shape !== "forced staged") await f.commit("partial producer repair");
    const repaired = await f.git(f.lane(), "rev-parse", "HEAD");
    const index = await f.git(f.lane(), "write-tree");
    fs.writeFileSync(path.join(f.lane(), "file.txt"), "unfinished repair remainder\n");
    fs.writeFileSync(path.join(f.lane(), "leftover.txt"), "new untracked repair output\n");
    clock = new Date(Date.parse(clock) + 1_000).toISOString();
    f.h.durableTurns.set(original.agentPath!, { turn: "terminal", message: {
      text: '```json\n{"status":"fail","blocked":true,"blockedReason":"cannot complete repair"}\n```', ts: Date.parse(clock),
    }, lastRecordAt: Date.parse(clock) });
    const execute = f.h.ports.exec;
    let interrupted = false;
    let foreignIndex: string | undefined;
    const foreignContents = Buffer.from("concurrent content after first restore\n");
    f.h.ports.exec = async (...args) => {
      if (!interrupted && shape.startsWith("raced") && args[0] === process.execPath) {
        const intent = JSON.parse(fs.readFileSync(args[1][2]!, "utf8"));
        if (intent.args[0] === "restore" && intent.args.includes("--worktree")) {
          interrupted = true;
          const written = await execute(...args);
          expect(written.code, written.stderr).toBe(0);
          fs.writeFileSync(path.join(f.lane(), shape === "raced index" ? ignoredPath : "file.txt"), foreignContents);
          if (shape === "raced index") await f.agentGit(f.lane(), "add", "--force", ignoredPath);
          foreignIndex = await f.git(f.lane(), "write-tree");
          return written;
        }
      }
      if (!interrupted && stop !== "none" && args[0] === process.execPath) {
        const intent = JSON.parse(fs.readFileSync(args[1][2]!, "utf8"));
        if (intent.args[0] === "restore") {
          const indexOnly = !intent.args.includes("--worktree");
          if (stop === "before restore" || (stop === "after worktree" && !indexOnly) || (stop === "after index" && indexOnly)) {
            interrupted = true;
            if (stop !== "before restore") {
              const written = await execute(...args);
              expect(written.code, written.stderr).toBe(0);
            }
            return { code: 1, stdout: "", stderr: "fixture cleanup interrupted" };
          }
        }
      }
      return execute(...args);
    };
    await settlePendingStageGit(f.h.ports);
    if (stop !== "none") {
      expect(interrupted).toBe(true);
      expect(current().state).toBe("running");
      const restarted = await realExec(process.execPath, ["-e", `
        const { defaultPipelinePorts, settlePendingStageGit } = await import("./src/lib/pipelines/engine");
        const { loadPipelines } = await import("./src/lib/pipelines/store");
        const ports = { ...defaultPipelinePorts(), now: () => ${JSON.stringify(clock)}, scheduleTick: () => {},
          conversationAgentActive: async () => false, publicationRepairProducerState: async () => "idle",
          conversationDeliveryOutstanding: () => false };
        await settlePendingStageGit(ports);
        console.log(JSON.stringify(loadPipelines()[0].runs[0].attempts[0].publicationRepair));
      `], process.cwd(), { ...process.env }, { timeoutMs: 30_000 });
      expect(restarted.code, restarted.stderr).toBe(0);
      expect(JSON.parse(restarted.stdout)).toMatchObject({ rollback: { phase: "done" },
        cleanHead: { ignoredPaths: [shape === "directory" ? "local-context/" : ignoredPath] },
        outcome: { status: "rejected", reason: expect.stringContaining("cannot complete repair") } });
    }
    expect(current().state).toBe("needs_decision");
    expect(current().stateDetail).toContain("cannot complete repair");
    expect(current().lastPassedCommit).toBe(accepted);
    expect(fs.readFileSync(path.join(f.lane(), ignoredPath))).toEqual(shape === "raced index" ? foreignContents : contents);
    expect(current().publishedCommit).toBeNull();
    expect(await f.git(f.repo, "ls-remote", "--heads", "origin", current().delivery!.target.branch)).toBe("");
    if (shape === "legacy") {
      expect(await f.git(f.lane(), "rev-parse", "HEAD")).toBe(repaired);
      expect(await f.git(f.lane(), "write-tree")).toBe(index);
      expect(current().runs[0]!.attempts[0]!.publicationRepair?.rollback?.phase).toBe("restore");
    } else if (shape.startsWith("raced")) {
      expect(interrupted).toBe(true);
      expect(await f.git(f.lane(), "rev-parse", "HEAD")).toBe(accepted);
      expect(await f.git(f.lane(), "write-tree")).toBe(foreignIndex!);
      expect(current().runs[0]!.attempts[0]!.publicationRepair?.rollback?.phase).toBe("restore");
      if (shape === "raced index") expect(await f.git(f.lane(), "show", `:${ignoredPath}`)).toBe(foreignContents.toString().trim());
      else expect(fs.readFileSync(path.join(f.lane(), "file.txt"))).toEqual(foreignContents);
    } else {
      expect(await f.git(f.lane(), "rev-parse", "HEAD")).toBe(accepted);
      expect(await f.git(f.lane(), "write-tree")).toBe(await f.git(f.lane(), "rev-parse", `${accepted}^{tree}`));
      expect(await f.git(f.lane(), "status", "--porcelain")).toBe("");
      expect(fs.readFileSync(path.join(f.lane(), ".gitignore"), "utf8")).toBe(policy);
      expect(fs.readFileSync(path.join(f.lane(), "file.txt"), "utf8")).toBe("accepted implementation\n");
      expect(fs.existsSync(path.join(f.lane(), "created.txt"))).toBe(false);
      expect(fs.existsSync(path.join(f.lane(), "leftover.txt"))).toBe(false);
    }
  } finally { f.close(); }
});


test.each([1, null])("repair handoff preserves the checkout when its ignored inventory is unavailable (exit %s)", async code => {
  const f = await fixture();
  try {
    const clock = f.h.ports.now(); f.h.ports.now = () => clock;
    let requests = 0;
    f.h.ports.resumeSeveredTurn = async () => { requests++; return true; };
    fs.writeFileSync(path.join(f.lane(), ".gitignore"), "local-context.txt\n");
    await f.agentGit(f.lane(), "add", ".gitignore");
    const accepted = await f.commit("accepted implementation");
    fs.writeFileSync(path.join(f.lane(), "local-context.txt"), "existing ignored context\n");
    const execute = f.h.ports.exec;
    f.h.ports.exec = async (...args) => args[0] === "git" && args[1][0] === "ls-files" && args[1].includes("--ignored")
      ? { code, stdout: "partial inventory", stderr: "fixture inventory unavailable" } : execute(...args);
    f.refuse(); await f.finish();
    expect(current().state).toBe("needs_decision");
    expect(current().runs[0]!.attempts[0]!.publicationRepair).toBeUndefined();
    expect(requests).toBe(0);
    expect(await f.git(f.lane(), "rev-parse", "HEAD")).toBe(accepted);
    expect(await f.git(f.lane(), "status", "--porcelain")).toBe("");
    expect(fs.readFileSync(path.join(f.lane(), "local-context.txt"), "utf8")).toBe("existing ignored context\n");
    expect(await f.git(f.repo, "ls-remote", "--heads", "origin", current().delivery!.target.branch)).toBe("");
  } finally { f.close(); }
});
