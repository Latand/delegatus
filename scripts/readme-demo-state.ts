/**
 * The demo state the README shots render: which projects exist, what sits on
 * the board, and the pipeline whose stages the README shows.
 *
 * `fixtures/demo-home/` carries the transcripts. It predates directory-derived
 * project identity, so its own state files key projects by bare names
 * ("atlas", "kanban") that no longer name anything — the Viewer resolves those
 * to "Unresolved project" and the board comes up empty. This module retargets
 * the materialized copy onto the ids the scanner actually mints for the
 * fixture's working directories, and adds the pipeline record the fixture has
 * never had.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { directoryProjectId } from "@/lib/projects/identity";

/** Fixture project folders, in the order the transcripts use them. */
export const DEMO_PROJECTS = ["atlas", "beacon", "forge", "kanban", "orbit", "relay"] as const;
export type DemoProject = (typeof DEMO_PROJECTS)[number];

/** Where the fixture transcripts say their sessions ran. */
export const FIXTURE_CWD_PREFIX = "/demo/Projects/";

export function projectsRoot(home: string): string {
  return path.join(home, "Projects");
}

/**
 * Create the working directories the transcripts name and return the project
 * id the Viewer derives for each. The ids are a pure function of the resolved
 * path, so the same capture root always yields the same board.
 */
export function createProjectDirectories(home: string): Record<DemoProject, string> {
  const ids = {} as Record<DemoProject, string>;
  for (const project of DEMO_PROJECTS) {
    const directory = path.join(projectsRoot(home), project);
    fs.mkdirSync(directory, { recursive: true });
    ids[project] = directoryProjectId(fs.realpathSync.native(directory));
  }
  return ids;
}

/** Rewrite the fixture's placeholder working directories onto the seeded home,
    then move every state record off the legacy project names. */
export function retargetFixtureState(home: string, ids: Record<DemoProject, string>): void {
  const stateDir = path.join(home, ".config/agent-log-viewer/state");
  const replaceCwd = (value: string) => value.replaceAll(FIXTURE_CWD_PREFIX, `${projectsRoot(home)}/`);

  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const pathname = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(pathname);
        continue;
      }
      const bytes = fs.readFileSync(pathname);
      if (bytes.includes(0)) continue;
      const text = bytes.toString("utf8");
      const rewritten = replaceCwd(text);
      if (rewritten !== text) fs.writeFileSync(pathname, rewritten, "utf8");
    }
  };
  visit(home);

  for (const file of ["board.json", "tasks.json", "orchestrator-seats.json"]) {
    const pathname = path.join(stateDir, file);
    if (!fs.existsSync(pathname)) continue;
    let text = fs.readFileSync(pathname, "utf8");
    for (const project of DEMO_PROJECTS) {
      text = text.replaceAll(`"project": "${project}"`, `"project": "${ids[project]}"`);
      text = text.replaceAll(`"${project}": {`, `"${ids[project]}": {`);
    }
    fs.writeFileSync(pathname, text, "utf8");
  }

  /* Flows are being retired in favour of pipelines, so the demo does not show
     them. The file stays, emptied, because its absence is a different state. */
  const flows = path.join(stateDir, "flows.json");
  if (fs.existsSync(flows)) fs.writeFileSync(flows, `${JSON.stringify({ schemaVersion: 3, flows: [] }, null, 2)}\n`, "utf8");
}

/* ── the pipeline the README shows ──────────────────────────────────────── */

/* Each record has to pass the store's own validator (src/lib/pipelines/store.ts
   isPipeline), or the Viewer refuses to boot on it: a role-bound stage carries
   a non-empty scaffold, the worktree and branch derive from the id, and fail
   edges sit on run stages only. */
const STAGE_ROLES = {
  builder: { engine: "claude", model: "opus", effort: "high", access: "read-write" },
  reviewer: { engine: "codex", model: "gpt-5.6-sol", effort: "xhigh", access: "read-only" },
  verifier: { engine: "claude", model: "sonnet", effort: "medium", access: "read-only" },
} as const;

type RoleId = keyof typeof STAGE_ROLES;

const SCAFFOLDS: Record<RoleId, string> = {
  builder: "You are a Builder. Implement the pinned task with focused checks and report the evidence.",
  reviewer: "You are a Reviewer. Read the full diff against the acceptance criteria and report a verdict.",
  verifier: "You are a Verifier. Run the gates and confirm the change renders where it should.",
};

function effectiveRole(roleId: RoleId) {
  return { roleId, ...STAGE_ROLES[roleId], promptScaffold: SCAFFOLDS[roleId] };
}

function stage(id: string, roleId: RoleId, prompt: string, next: string | null, onFail: { to: string; maxRounds: number } | null = null) {
  return {
    id,
    kind: "run",
    role: { roleId },
    prompt,
    next,
    onFail,
    effectiveRole: effectiveRole(roleId),
  };
}

const instant = (hour: number, minute: number) =>
  `2100-01-02T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;

function attempt(
  roleId: RoleId,
  state: string,
  startedAt: string,
  completedAt: string | null,
  verdict: { status: string; findings: string[] } | null,
  output: string | null,
  activatedBy: { stageId: string; attempt: number; edge: string } | null = null,
) {
  return {
    n: 1,
    state,
    effectiveRole: effectiveRole(roleId),
    definition: null,
    launchId: null,
    conversationId: null,
    sessionId: null,
    agentPath: null,
    paneId: null,
    flowId: null,
    startedAt,
    completedAt,
    input: null,
    activatedBy,
    output,
    verdict,
    error: null,
  };
}

/** Same derivation as the store's pipelineIdentity. */
function identity(id: string, task: string, repoDir: string) {
  const slug = task.toLowerCase().replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "task";
  return {
    worktreeDir: path.join(path.dirname(repoDir), `${path.basename(repoDir)}-pipeline-${id}`),
    branch: `pipeline/${slug}-${id}`,
  };
}

/**
 * One lane mid-flight and one already landed, written the way the controller
 * writes them: an attempt carries its own verdict, and the cursor names the
 * stage running now.
 */
export function buildDemoPipelines(home: string, ids: Record<DemoProject, string>): unknown {
  const atlasDir = path.join(projectsRoot(home), "atlas");
  const forgeDir = path.join(projectsRoot(home), "forge");

  const stages = [
    stage("build", "builder", "Implement {{task}} and cover it with tests.", "review"),
    stage("review", "reviewer", "Review the full diff against the acceptance criteria.", "verify", { to: "build", maxRounds: 3 }),
    stage("verify", "verifier", "Run the gates and confirm the result at 390 px.", null),
  ];

  const runningTask = "Readiness strip in the dashboard footer";
  const running = {
    id: "4c9e21d7",
    task: runningTask,
    taskIds: ["task-demo-polish"],
    project: ids.atlas,
    repoDir: atlasDir,
    ...identity("4c9e21d7", runningTask, atlasDir),
    baseBranch: "main",
    baseRef: "",
    lastPassedCommit: "",
    publishedCommit: null,
    spec: "Show per-project readiness in the footer, driven by the counts the board already reads.",
    stages,
    runs: [
      {
        stageId: "build",
        attempts: [attempt("builder", "passed", instant(10, 20), instant(10, 46), { status: "pass", findings: [] }, "Readiness strip renders from the board counts; footer tests added.")],
      },
      { stageId: "review", attempts: [attempt("reviewer", "running", instant(10, 48), null, null, null, { stageId: "build", attempt: 1, edge: "pass" })] },
      { stageId: "verify", attempts: [] },
    ],
    cursor: { stageId: "review", state: "running", input: null, activatedBy: { stageId: "build", attempt: 1, edge: "pass" } },
    state: "running",
    pausedState: null,
    stateDetail: null,
    srcPath: null,
    srcConversationId: null,
    createdAt: instant(10, 18),
    closedAt: null,
    hiddenAt: null,
  };

  const landedTask = "Deterministic review evidence";
  const landed = {
    ...running,
    id: "8f30b6a2",
    task: landedTask,
    taskIds: ["task-demo-review-evidence"],
    project: ids.forge,
    repoDir: forgeDir,
    ...identity("8f30b6a2", landedTask, forgeDir),
    spec: "Compare both deterministic render passes and publish the difference.",
    runs: [
      { stageId: "build", attempts: [attempt("builder", "passed", instant(9, 10), instant(9, 24), { status: "pass", findings: [] }, "Both passes compared.")] },
      { stageId: "review", attempts: [attempt("reviewer", "passed", instant(9, 25), instant(9, 38), { status: "pass", findings: [] }, "No findings.", { stageId: "build", attempt: 1, edge: "pass" })] },
      { stageId: "verify", attempts: [attempt("verifier", "passed", instant(9, 39), instant(9, 52), { status: "pass", findings: [] }, "Gates green.", { stageId: "review", attempt: 1, edge: "pass" })] },
    ],
    cursor: null,
    state: "completed",
    createdAt: instant(9, 8),
    closedAt: instant(9, 52),
  };

  return { schemaVersion: 5, pipelines: [running, landed] };
}

export function writeDemoPipelines(home: string, ids: Record<DemoProject, string>): void {
  const stateDir = path.join(home, ".config/agent-log-viewer/state");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "pipelines.json"),
    `${JSON.stringify(buildDemoPipelines(home, ids), null, 2)}\n`,
    "utf8",
  );
}

/** The fixture projects are plain folders on purpose: a repository identity
    would carry this machine's checkout into the frame. */
export function assertNoRepositoryLeak(home: string): void {
  const result = spawnSync("git", ["-C", projectsRoot(home), "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (result.status === 0) throw new Error(`demo projects resolved into a repository: ${result.stdout.trim()}`);
}
