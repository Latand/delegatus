import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { controllerCommitIdentityEnv } from "@/lib/git/controllerCommitIdentity";
import { laneChangeSummary, laneFileDiff, laneFileVersion } from "./laneChanges";
import { realProvisionExec } from "./git";
import type { Pipeline } from "./types";
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
  applyCompleted: false,
  undoCompleted: false,
  applyCapabilityAvailable: false,
  undoCapabilityAvailable: false,
  resultInFolder: false,
  restored: false,
  initialFiles: new Map<string, string>(),
  portRefusals: [] as string[],
  attemptedRemoteCommands: [] as string[],
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

beforeAll(async () => {
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
  for (const name of [...admitted, "secret-handling.pdf"]) observed.initialFiles.set(name, fileDigest(path.join(folder, name)));
  for (const command of [["gh", "pr", "list"], ...["fetch", "push", "pull", "ls-remote", "clone"].map(arg => ["git", arg]), ["git", "remote", "update"]]) {
    const [program, ...args] = command;
    const normalResult = await exec(program!, args, folder);
    const provisionResult = await provisionExec(program!, args, folder, undefined);
    if (normalResult.code === 1 && provisionResult.code === 1) observed.portRefusals.push([program, ...args].join(" "));
  }
  refusedCommands.length = 0;

  savePipelines([]);
  const h = harness();
  h.ports.preflightRepo = defaultPipelinePorts().preflightRepo;
  h.ports.exec = exec;
  h.ports.provisionExec = provisionExec;
  const lifecycle = h.ports as typeof h.ports & {
    applyReviewedResult?: (lane: Pipeline) => Promise<{ applied: boolean }>;
    undoAppliedResult?: (lane: Pipeline) => Promise<{ restored: boolean }>;
  };
  observed.applyCapabilityAvailable = typeof lifecycle.applyReviewedResult === "function";
  observed.undoCapabilityAvailable = typeof lifecycle.undoAppliedResult === "function";
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
      const drawing = summary.files.find(file => file.path === "drawing.pdf");
      const oldDrawing = drawing && await laneFileVersion(lane, summary.base, summary.head, summary.base, drawing.path, exec, summary.files);
      const newDrawing = drawing && await laneFileVersion(lane, summary.base, summary.head, summary.head, drawing.path, exec, summary.files);
      const textDiff = diffs.find((diff, index) => summary.files[index]?.path === "result.txt");
      observed.changes = summary.total === 2 && !summary.truncated
        && diffs.every(diff => !("error" in diff))
        && Boolean(textDiff && !("error" in textDiff) && textDiff.hunks.some(hunk => hunk.lines.some(line => line.t === "+" && line.text === "Reviewed result")))
        && Boolean(drawing?.binary && Buffer.isBuffer(oldDrawing) && oldDrawing.equals(Buffer.alloc(3 * 1024 * 1024))
          && Buffer.isBuffer(newDrawing) && newDrawing.equals(Buffer.alloc(3 * 1024 * 1024, 1)));
    }
    observed.resultInFolder = fs.existsSync(path.join(folder, "result.txt"))
      && fs.readFileSync(path.join(folder, "result.txt"), "utf8") === "Reviewed result\n";
    if (lifecycle.applyReviewedResult) {
      const applied = await lifecycle.applyReviewedResult(pipeline);
      observed.applyCompleted = applied.applied;
      observed.resultInFolder = applied.applied && fs.existsSync(path.join(folder, "result.txt"))
        && fs.readFileSync(path.join(folder, "result.txt"), "utf8") === "Reviewed result\n";
      if (lifecycle.undoAppliedResult) {
        const undone = await lifecycle.undoAppliedResult(pipeline);
        observed.undoCompleted = undone.restored;
        const restored = !fs.existsSync(path.join(folder, "result.txt")) && [...observed.initialFiles].every(([name, digest]) =>
          fs.existsSync(path.join(folder, name)) && fileDigest(path.join(folder, name)) === digest);
        observed.restored = undone.restored && restored;
      }
    }
    observed.attemptedRemoteCommands = [...refusedCommands];
    expect(await git(folder, "remote")).toBe("");
  }
});

function fileDigest(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

test("G0 fixture builds every office file and refuses forge commands on both command ports", () => {
  expect(fs.statSync(path.join(folder, "archive.bin")).size).toBe(80 * 1024 * 1024);
  expect(fs.statSync(path.join(folder, "drawing.pdf")).size).toBe(3 * 1024 * 1024);
  expect(fs.readdirSync(folder)).toHaveLength(204);
  expect(observed.initialFiles.size).toBe(admitted.length + 1);
  expect(observed.portRefusals).toHaveLength(7);
  expect(observed.attemptedRemoteCommands).toEqual([]);
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
  expect(observed.applyCapabilityAvailable).toBe(true);
  expect(observed.applyCompleted).toBe(true);
  expect(observed.resultInFolder).toBe(true);
});

test.failing("G0 what changed lists and opens every changed document — gap 6 binary versions absent (G5)", () => {
  expect(observed.changes).toBe(true);
});

test.failing("G0 undo restores the folder — gap 7 undo operation absent (G5)", () => {
  expect(observed.undoCapabilityAvailable).toBe(true);
  expect(observed.undoCompleted).toBe(true);
  expect(observed.restored).toBe(true);
});
