import { afterAll, expect, test } from "bun:test";
import { controllerCommitIdentityEnv } from "@/lib/git/controllerCommitIdentity";
import { laneChangeSummary, laneFileDiff } from "./laneChanges";
import { realProvisionExec } from "./git";
import {
  fs, os, path, realExec, defaultPipelinePorts, harness, createPipelineFromRequest,
  tickPipelines, loadPipelines, savePipelines, finishReported, entry,
} from "./engine.fixture";

// G0 observes the existing entry points. G1, G4 and G5 replace the recorded
// stops and remove .failing from the clauses they make work.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ordinary-folder-"));
const folder = path.join(root, "documents");
const names = Array.from({ length: 200 }, (_, i) => String(i).padStart(26, "d") + ".txt");
const admitted = [...names, "drawing.pdf", "archive.bin", "out/letter.txt"];
const refusedCommands: string[] = [];
const observed = {
  completedStages: [] as string[],
  visibleFiles: [] as string[][],
  leftOut: [] as string[],
  completed: false,
  admission: "unobserved",
  changes: false,
  apply: "absent (G4)",
  undo: "absent (G5)",
  resultInFolder: false,
  restored: false,
};

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function remoteCommand(command: string, args: string[]): boolean {
  return command === "gh" || command === "git" && (
    args.some(arg => ["fetch", "push", "pull", "ls-remote", "clone"].includes(arg))
    || args.includes("remote") && args.includes("update"));
}

const gitEnvironment = {
  ...Object.fromEntries(Object.keys(process.env).filter(key => key.startsWith("GIT_")).map(key => [key, undefined])),
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  ...controllerCommitIdentityEnv(),
  GIT_AUTHOR_DATE: "2026-11-10T00:00:00Z", GIT_COMMITTER_DATE: "2026-11-10T00:00:00Z",
};

const exec: typeof realExec = async (command, args, cwd, env, options) => {
  if (remoteCommand(command, args)) {
    refusedCommands.push([command, ...args].join(" "));
    return { code: 1, stdout: "", stderr: "network command refused by office-folder fixture" };
  }
  return realExec(command, args, cwd, { ...env, ...gitEnvironment }, options);
};

const provisionExec: typeof realProvisionExec = async (command, args, cwd, signal, options) => {
  if (remoteCommand(command, args)) {
    refusedCommands.push([command, ...args].join(" "));
    return { code: 1, stdout: "", stderr: "network command refused by office-folder fixture" };
  }
  return exec(command, args, cwd, undefined, { ...options, signal });
};

async function git(cwd: string, ...args: string[]) {
  const result = await exec("git", ["-c", "commit.gpgsign=false", ...args], cwd);
  if (result.code !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

test("G0 fixture generates its office documents and proves both command ports refuse network access", async () => {
  expect(await git(root, "--version")).toStartWith("git version ");
  fs.mkdirSync(folder);
  for (const name of names) {
    expect(Buffer.byteLength(name)).toBe(30);
    fs.writeFileSync(path.join(folder, name), "Original document\n");
  }
  fs.writeFileSync(path.join(folder, "drawing.pdf"), Buffer.alloc(3 * 1024 * 1024));
  // Generated in bounded chunks in the test's temporary folder.
  const archive = fs.openSync(path.join(folder, "archive.bin"), "wx");
  try {
    for (let i = 0; i < 80; i++) fs.writeSync(archive, Buffer.alloc(1024 * 1024, i));
  } finally { fs.closeSync(archive); }
  fs.mkdirSync(path.join(folder, "out"));
  fs.writeFileSync(path.join(folder, "out/letter.txt"), "Original letter\n");
  fs.writeFileSync(path.join(folder, "secret-handling.pdf"), "Ordinary document about handling\n");
  expect(fs.statSync(path.join(folder, "archive.bin")).size).toBe(80 * 1024 * 1024);
  expect(fs.statSync(path.join(folder, "drawing.pdf")).size).toBe(3 * 1024 * 1024);
  expect(fs.readdirSync(folder)).toHaveLength(204);
  for (const command of [["gh", "pr", "list"], ...["fetch", "push", "pull", "ls-remote", "clone"].map(arg => ["git", arg]), ["git", "remote", "update"]]) {
    const [program, ...args] = command;
    expect((await exec(program!, args, folder)).code).toBe(1);
    expect((await provisionExec(program!, args, folder)).code).toBe(1);
  }
  expect(refusedCommands).toHaveLength(14);
  refusedCommands.length = 0;
  expect(fs.existsSync(path.join(folder, ".git"))).toBe(false);
});

test("G0 observes admission and the build, review, fix, second review through product entry points", async () => {
  savePipelines([]);
  const h = harness();
  h.ports.preflightRepo = defaultPipelinePorts().preflightRepo;
  h.ports.exec = exec;
  h.ports.provisionExec = provisionExec;
  const admission = await h.ports.preflightRepo(folder);
  observed.admission = admission.ok ? "admitted" : admission.detail ?? admission.code;
  if (admission.ok) observed.leftOut = admission.repositoryInitialization?.ignoredPaths ?? [];
  const created = await createPipelineFromRequest({ task: "Revise office documents", repoDir: folder, stages: [
    { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: "review" },
    { id: "review", kind: "run", role: { roleId: "reviewer" }, prompt: "Review", next: null,
      onFail: { to: "fix", maxRounds: 1, onExhausted: "park" } },
    { id: "fix", kind: "run", role: { roleId: "builder" }, prompt: "Fix", next: "second-review" },
    { id: "second-review", kind: "run", role: { roleId: "reviewer" }, prompt: "Review again", next: null },
  ] }, h.ports);
  if (created.pipeline) {
    const pipeline = created.pipeline;
    expect(await git(folder, "remote")).toBe("");
    for (const stageId of ["build", "review", "fix", "second-review"]) {
      for (let tick = 0; tick < 12; tick++) {
        const lane = loadPipelines()[0]!;
        if (lane.cursor?.stageId === stageId && lane.cursor.state === "running") break;
        await tickPipelines([], h.ports);
      }
      const lane = loadPipelines()[0]!;
      expect(lane.cursor).toMatchObject({ stageId, state: "running" });
      observed.visibleFiles.push(admitted.filter(name => fs.existsSync(path.join(pipeline.worktreeDir, name))));
      if (stageId === "build") {
        fs.writeFileSync(path.join(pipeline.worktreeDir, "result.txt"), "Draft result\n");
        fs.writeFileSync(path.join(pipeline.worktreeDir, "drawing.pdf"), Buffer.alloc(3 * 1024 * 1024, 1));
      }
      if (stageId === "fix") fs.writeFileSync(path.join(pipeline.worktreeDir, "result.txt"), "Reviewed result\n");
      if (stageId === "build" || stageId === "fix") {
        await git(pipeline.worktreeDir, "add", "--all");
        await git(pipeline.worktreeDir, "commit", "-m", stageId === "build" ? "Revise documents" : "Fix document result");
      }
      const run = lane.runs.find(run => run.stageId === stageId)!;
      const attempt = run.attempts.at(-1)!;
      const finished = finishReported(h, attempt.agentPath!, stageId === "review" ? "fail" : "pass",
        stageId === "review" ? "P2 — result.txt needs the reviewed wording." : "Document work complete");
      await tickPipelines([finished], h.ports);
      for (let tick = 0; tick < 12; tick++) {
        const current = loadPipelines()[0]!;
        if (current.cursor?.stageId !== stageId || current.state === "completed") break;
        await tickPipelines([entry(attempt.agentPath!)], h.ports);
      }
      observed.completedStages.push(stageId);
    }
    const lane = loadPipelines()[0]!;
    observed.completed = lane.state === "completed";
    const summary = await laneChangeSummary(lane, exec);
    if (!("error" in summary)) {
      const diffs = await Promise.all(summary.files.map(file => laneFileDiff(lane, summary.base, summary.head, file.path, exec)));
      observed.changes = summary.total === 2 && !summary.truncated
        && diffs.every(diff => !("error" in diff) && !diff.binary);
    }
    observed.resultInFolder = fs.existsSync(path.join(folder, "result.txt"))
      && fs.readFileSync(path.join(folder, "result.txt"), "utf8") === "Reviewed result\n";
    expect(await git(folder, "remote")).toBe("");
  } else {
    expect(created.error).toContain(observed.admission);
  }
  // Advance this stop when G1 supplies admission. Apply and undo remain absent
  // until G4/G5 supply their product operations.
  expect(observed.admission).toBe("project exceeds the initial commit path-list bound");
  expect(fs.existsSync(path.join(folder, ".git"))).toBe(false);
  expect(h.spawnInputs).toHaveLength(0);
  expect(refusedCommands).toEqual([]);
});

test.failing("G0 completes build → review → fix → second review without remote — gap 1 path-list bound (G1)", () => {
  expect(observed.completedStages).toEqual(["build", "review", "fix", "second-review"]);
  expect(observed.completed).toBe(true);
});

test.failing("G0 every stage sees every admitted office file — gaps 1, 2, 3 bounds, large files and omissions (G1)", () => {
  expect(observed.visibleFiles).toEqual(Array.from({ length: 4 }, () => admitted));
  expect(observed.leftOut).toContain("secret-handling.pdf");
});

test.failing("G0 reviewed result reaches the person's folder — gap 5 local landing absent (G4)", () => {
  expect(observed.apply).toBe("applied");
  expect(observed.resultInFolder).toBe(true);
});

test.failing("G0 what changed lists and opens every changed document — gap 6 binary versions absent (G5)", () => {
  expect(observed.changes).toBe(true);
});

test.failing("G0 undo restores the folder — gap 7 undo operation absent (G5)", () => {
  expect(observed.undo).toBe("restored");
  expect(observed.restored).toBe(true);
});
