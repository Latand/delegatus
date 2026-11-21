import { expect } from "bun:test";
import { engineForgeWriteEnv } from "@/lib/git/agentForgeCredentials";
import type { ExecPort } from "@/lib/workflows/provision";
import { fs, path, realExec, engineModule, tickPipelines, loadPipelines, savePipelines, finishReported, realWorktreeLane } from "./engine.fixture";


const REMOTE = "https://github.com/example/widgets.git";

const isBodyPatch = (args: string[]) => args[0] === "api" && args[1] === "-X" && args[2] === "PATCH";


async function fixture(task?: string, reviewBudget = false) {
  const f = await realWorktreeLane("stage-pr", [
    { id: "build", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Build", next: "review" },
    { id: "review", kind: "run", role: { roleId: "reviewer" }, access: "read-only", prompt: "Review", next: null,
      ...(reviewBudget ? { onFail: { to: "build", maxRounds: 1 } } : {}) },
  ], "remote-branch", false, false, { task: task ?? "stage-pr" });
  const p = loadPipelines().find(p => p.id === f.id)!;
  p.delivery!.target.remote = REMOTE; savePipelines([p]);
  const calls: string[][] = [];
  let exists = false, refuse = false, loseResponse = false;
  let expectedBody = "Stage implementation summary.";
  let body = "", prBase = "main";
  let prShape: "fork" | "head" | "ambiguous" | "closed" | "merged" | "branch" | "number" | undefined;
  let race: { call: number; kind: "pause" | "release" } | undefined;
  f.h.ports.exec = async (command, args, cwd, env, options) => {
    // The fake forge's delivery repository is the native fixture origin.
    if (command === "git" && args[0] === "remote" && args[1] === "get-url" && args.at(-1) === REMOTE)
      return { code: 0, stdout: `${f.origin}\n`, stderr: "" };
    if (command === "gh") {
      // Provenance observations are independent of the delivery guarantee.
      // Only count the controller's exact PR lookup/create/patch awaits here.
      if (args[1] !== "create" && args[1] !== "edit" && !isBodyPatch(args) && !args.some(arg => arg.includes("isCrossRepository")))
        return { code: 1, stdout: "", stderr: "fixture has no observed pull request" };
      calls.push(args);
      if (race?.call === calls.length) {
        const current = loadPipelines().find(p => p.id === f.id)!;
        if (race.kind === "pause") { current.state = "paused"; current.pausedState = "running"; }
        else current.delivery!.active = false;
        savePipelines([current]);
      }
      if (args[0] === "pr" && (args[1] === "list" || args[1] === "view")) {
        const row = { body, title: p.task, number: prShape === "number" ? 18 : 17, headRefName: prShape === "branch" ? "other-head" : p.branch, baseRefName: prBase, state: prShape === "closed" ? "CLOSED" : prShape === "merged" ? "MERGED" : "OPEN", isCrossRepository: prShape === "fork",
          headRefOid: prShape === "head" ? "f".repeat(40) : await f.git(f.origin, "rev-parse", `refs/heads/${p.branch}`) };
        if (args[1] === "view") return { code: exists ? 0 : 1, stdout: exists ? JSON.stringify(row) : "", stderr: "" };
        const base = args.indexOf("--base");
        return { code: 0, stdout: JSON.stringify(exists && (base < 0 || args[base + 1] === row.baseRefName) && row.state === "OPEN"
          ? (prShape === "ambiguous" ? [row, { ...row, number: 18 }] : [row]) : []), stderr: "" };
      }
      if (args[0] === "pr" && args[1] === "create") {
        if (refuse) return { code: 1, stdout: "", stderr: "forge refused" };
        expect(fs.readFileSync(args[args.indexOf("--body-file") + 1]!, "utf8")).toBe(expectedBody);
        body = expectedBody;
        exists = true;
        return loseResponse ? { code: null, stdout: "", stderr: "response lost" } : { code: 0, stdout: "https://github.com/example/widgets/pull/17\n", stderr: "" };
      }
      if (args[0] === "pr" && args[1] === "edit")
        return { code: 1, stdout: "", stderr: "GraphQL: Projects (classic) is being deprecated (repository.pullRequest.projectCards)" };
      if (isBodyPatch(args)) {
        expect(args[3]).toBe("repos/example/widgets/pulls/17");
        expect(env).toEqual(engineForgeWriteEnv());
        const field = args[args.indexOf("-F") + 1]!;
        expect(field.startsWith("body=@")).toBe(true);
        if (refuse) return { code: 1, stdout: "", stderr: "forge refused" };
        body = fs.readFileSync(field.slice("body=@".length), "utf8");
        return { code: loseResponse ? null : 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected forge call: ${args.join(" ")}`);
    }
    return realExec(command, args.map(a => a === REMOTE ? f.origin : a), cwd, env, options);
  };
  const finish = async (summary = "Stage implementation summary.", n = 1, verdict: "pass" | "fail" = "pass") => {
    f.h.setConversationActive(false);
    await engineModule.reportStageCompletion({ verdict, summary,
      ...(verdict === "fail" ? { findings: [{ severity: "P2" as const, text: "Update the checks." }] } : {}) },
    { kind: "agent", role: n === 2 ? "reviewer" : "builder", conversationId: `conversation_stage_${n}` }, f.h.ports);
    await tickPipelines([finishReported(f.h, `/codex/stage-${n}.jsonl`, verdict, summary)], f.h.ports);
    return loadPipelines().find(p => p.id === f.id)!;
  };
  const commit = async () => {
    await f.git(f.worktree, "commit", "--allow-empty", "-m", "stage output");
  };
  return { ...f, calls, finish, commit, body: () => body, setBody: (value: string) => { body = value; }, setExpectedBody: (body: string) => { expectedBody = body; }, setPrShape: (shape: typeof prShape) => { exists = true; prShape = shape; }, setRace: (call: number, kind: "pause" | "release") => { race = { call, kind }; }, setMissing: () => { exists = false; }, setExisting: () => { exists = true; }, setRefused: (value = true) => { refuse = value; }, setLost: () => { loseResponse = true; },
    setPrBase: (base: string) => { prBase = base; },
    link: () => {
      const current = loadPipelines().find(lane => lane.id === f.id)!;
      current.delivery!.target.pr = 17;
      savePipelines([current]); exists = true;
    },
    close: () => { savePipelines([]); fs.rmSync(f.root, { recursive: true, force: true }); } };
}


const originalBudgetBody = "Producer implementation notes. 7 tests passed; independent review to come.\n\n---\nGenerated with Delegatus.";

const fixSummary = "Fixed the checks. 9 tests passed; typecheck passed.";


async function finalBudgetFixFixture() {
  const f = await fixture(undefined, true);
  try {
    f.setExpectedBody(originalBudgetBody);
    await f.commit();
    expect((await f.finish(originalBudgetBody)).cursor?.stageId).toBe("review");
    await tickPipelines([], f.h.ports);
    expect((await f.finish("Checks need updating.", 2, "fail")).cursor?.stageId).toBe("build");
    await tickPipelines([], f.h.ports);
    await f.commit();
    return f;
  } catch (error) { f.close(); throw error; }
}


// Synthetic head-only fixtures have no corresponding remote publication.
const withoutGitProof = (exec: ExecPort): ExecPort => (command, ...args) => command === "git"
  ? Promise.resolve({ code: 1, stdout: "", stderr: "fixture has no Git publication proof" }) : exec(command, ...args);


async function publishedHeadFixture(linked = true) {
  const f = await fixture();
  const pipeline = loadPipelines().find(p => p.id === f.id)!;
  const attempt = pipeline.runs[0]!.attempts[0]!;
  const head = "1".repeat(40);
  pipeline.lastPassedCommit = pipeline.publishedCommit = head;
  pipeline.delivery!.operation = { id: "published-stage", epoch: pipeline.delivery!.epoch, sha: head,
    requestKey: `pass:${pipeline.cursor!.stageId}:${attempt.n}`, passedStage: true,
    state: "settled", result: { ok: true, sha: head, remote: "published" } };
  if (linked) pipeline.delivery!.target.pr = 17;
  const row = { number: 17, headRefName: pipeline.branch, baseRefName: pipeline.baseBranch,
    state: "OPEN", isCrossRepository: false, headRefOid: head };
  let clock = 0;
  const waits: number[] = [];
  const timing = { now: () => clock, sleep: async (ms: number) => { waits.push(ms); clock += ms; } };
  return { ...f, pipeline, attempt, row, timing, waits, advance: (ms: number) => { clock += ms; }, elapsed: () => clock };
}


/* A fork PR (docs/research/competitors-2026-10.md rank 4): the lane pushes to
   the fork, and the PR it settles on lives in the upstream `prRepository`. */
async function forkFixture() {
  const f = await publishedHeadFixture();
  f.pipeline.delivery!.target.remote = "https://github.com/contributor/widgets.git";
  f.pipeline.delivery!.target.prRepository = "example/widgets";
  const row = { ...f.row, isCrossRepository: true, headRepository: { name: "Widgets" }, headRepositoryOwner: { login: "Contributor" } };
  return { ...f, row };
}


const unsafeSummary = "Evidence: /home/" + "private-user/evidence";

const publicSummary = "Verified ORM write_uid/create_uid/calculated_by_id fields. 42 tests passed. Revision " + "ab12".repeat(10) + ".";


async function rewritingFixture() {
  const f = await fixture();
  const sends: Array<Parameters<NonNullable<typeof f.h.ports.resumeSeveredTurn>>[0]> = [];
  f.h.ports.resumeSeveredTurn = async input => { sends.push(input); f.h.setConversationActive(true); return true; };
  await f.commit();
  const before = loadPipelines().find(p => p.id === f.id)!;
  before.runs[0]!.attempts[0]!.paneId = null;
  savePipelines([before]);
  const initial = await f.finish(unsafeSummary);
  const read = () => loadPipelines().find(p => p.id === f.id)!;
  const answer = async (summary: string) => {
    const report = await engineModule.reportStageCompletion({ verdict: "pass", summary },
      { kind: "agent", role: "builder", conversationId: "conversation_stage_1" }, f.h.ports);
    expect(report.error).toBeUndefined();
    f.h.setConversationActive(false);
    await tickPipelines([finishReported(f.h, "/codex/stage-1.jsonl", "pass", summary)], f.h.ports);
    return read();
  };
  return { ...f, sends, initial, read, answer };
}



async function inspectionFixture(mode: "timeout" | "empty" | "signal" | "spawn" | "spawn-zero" | "finding" | "missing") {
  const f = await fixture();
  let clock = Date.parse(f.h.ports.now());
  f.h.ports.now = () => new Date(clock).toISOString();
  const scripts = path.join(f.worktree, "scripts"); fs.mkdirSync(scripts);
  fs.writeFileSync(path.join(scripts, "privacy-publication-gate.ts"), "// Controlled gate process.\n");
  if (mode !== "missing") fs.copyFileSync(path.join(process.cwd(), "scripts/privacy-known-value-fingerprints.json"),
    path.join(scripts, "privacy-known-value-fingerprints.json"));
  await f.git(f.worktree, "add", "scripts");
  const exec = f.h.ports.exec;
  let checks = 0, recover = false, adopt = false;
  const sends: string[] = [];
  f.h.ports.resumeSeveredTurn = async input => { sends.push(input.text); return true; };
  f.h.ports.exec = async (command, args, cwd, env, options) => {
    if (command === "bun" && args[0]?.endsWith("privacy-publication-gate.ts")) {
      expect(options?.timeoutMs).toBe(60_000);
      if (recover || args.at(-1)?.endsWith("title.txt")) return { code: 0, stdout: "", stderr: "" };
      checks++;
      if (adopt) f.setExisting();
      if (mode === "spawn" || mode === "spawn-zero") throw Object.assign(new Error(unsafeSummary), { code: mode === "spawn" ? "EAGAIN" : 0 });
      return mode === "timeout" ? { code: null, signal: "SIGKILL", stdout: "", stderr: "command timed out after 60000ms" }
        : mode === "signal" ? { code: null, signal: "SIGTERM", stdout: "", stderr: unsafeSummary }
        : mode === "finding" ? { code: 1, stdout: "known_value: 1\ninspection_error: 1\n", stderr: unsafeSummary }
        : { code: 1, stdout: "", stderr: "gate could not load its input" };
    }
    return exec(command, args, cwd, env, options);
  };
  await f.commit();
  return { ...f, checks: () => checks, sends, advance: (ms: number) => { clock += ms; }, recover: () => { recover = true; }, adopt: () => { adopt = true; } };
}

export { REMOTE, isBodyPatch, fixture, originalBudgetBody, fixSummary, finalBudgetFixFixture, withoutGitProof, publishedHeadFixture, forkFixture, unsafeSummary, publicSummary, rewritingFixture, inspectionFixture };
