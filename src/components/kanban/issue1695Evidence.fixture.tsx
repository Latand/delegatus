import { createRoot } from "react-dom/client";

import { focusHandoffBus } from "@/components/attention/focusHandoffBus";
import { runFocusTransaction } from "@/components/attention/navigate";
import { Viewer } from "@/components/Viewer";
import { applyBoardMutations, type BoardMutationV1 } from "@/lib/board/mutations";
import type { Pipeline } from "@/lib/pipelines/types";
import { admissionSnapshot } from "@/lib/tasks/groupHide";
import { RUNTIME_PLANE_ABSENT } from "@/lib/runtime/flags";
import type { BoardTask, TaskStatus } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import type { BoardProjectStateV1 } from "@/lib/view/types";

/*
 * The real Viewer on the kanban face (#1695), over invented content equivalent
 * to the approved prototype's fixture (`prototypes/kanban-board/fixture.js`):
 * the same tasks in the same columns, the branch-retry-review pipeline, the
 * eight-stage chain, the simple chain parked on a decision, a forward fail
 * branch, and plain conversation members; the project's orchestrator seat and
 * short transcripts for its conversations, one of them empty (K3). With
 * `?scenario=editing` (K4b) three groups start hidden, as in the prototype's
 * hidden-tray frame, a conversation is closed on the board, and the
 * orchestrator's conversation sits on a task an agent hid before the seat was
 * designated. Every
 * request the Viewer makes is answered here; nothing reaches a server, a store
 * or a state directory. Driven by the `issue1695*.browser.test.tsx` files.
 */

const PROJECT = "atlas";
const SCENARIO = new URLSearchParams(location.search).get("scenario");
const EDITING = SCENARIO === "editing";
/* K5a: the pipelines' review stages are bound to review flows with rounds. */
const PIPELINES = SCENARIO === "pipelines";
const flowOf = (id: string) => (PIPELINES ? { flowId: id } : {});
const now = Math.floor(Date.now() / 1000);
const iso = (secondsAgo: number) => new Date((now - secondsAgo) * 1_000).toISOString();
const MIN = 60;
const REV = (n: number) => `task-v1:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function conversation(id: string, title: string, over: Record<string, unknown> = {}): FileEntry {
  return {
    path: `/repo/${id}.jsonl`, root: "claude-projects", name: `${id}.jsonl`, project: PROJECT, title, engine: "claude", kind: "session",
    fmt: "claude", parent: null, mtime: now - 15 * MIN, size: 2_048, activity: "idle", proc: null, pid: null, model: "opus",
    pendingQuestion: null, waitingInput: null, conversationId: `conversation_${id}`,
    ...over,
  } as unknown as FileEntry;
}
const working = (over: Record<string, unknown> = {}) => ({
  activity: "live", proc: "running", pid: 4_401, mtime: now - 30,
  authoritativeTurn: { state: "busy", source: "lifecycle", terminalAt: null },
  lastTurn: { startedAt: (now - 400) * 1_000, endedAt: null },
  ...over,
});

const role = (roleId: string, engine = "claude") => ({ roleId, engine, model: engine === "claude" ? "opus" : "gpt-5.6", effort: "high", access: "read-write", promptScaffold: null });
function stage(id: string, roleId: string, next: string | null, over: Record<string, unknown> = {}) {
  return { id, kind: roleId === "reviewer" ? "review-loop" : "run", role: { roleId }, prompt: `Stage ${id}.`, next, onFail: null, effectiveRole: role(roleId), ...over };
}
function attempt(n: number, state: string, file: FileEntry | null, over: Record<string, unknown> = {}) {
  return {
    n, state, effectiveRole: role("builder"), launchId: file ? `launch-${file.name}` : null, conversationId: file?.conversationId ?? null,
    sessionId: null, agentPath: file?.path ?? null, paneId: null, flowId: null, startedAt: iso(60 * MIN), completedAt: null,
    input: null, activatedBy: null, output: null, verdict: null, error: null, ...over,
  };
}
function pipeline(id: string, task: string, taskId: string, state: string, stages: unknown[], runs: unknown[], cursor: unknown, over: Record<string, unknown> = {}): Pipeline {
  return {
    id, task, taskIds: [taskId], project: PROJECT, repoDir: "/repo", worktreeDir: `/repo-${id}`, branch: `pipeline/${id}`,
    baseBranch: "main", baseRef: "main", lastPassedCommit: "", stages, runs, cursor, state, pausedState: null, stateDetail: null,
    srcPath: null, srcConversationId: null, createdAt: iso(8 * 60 * MIN), closedAt: null, ...over,
  } as unknown as Pipeline;
}

const files: FileEntry[] = [];
const add = (file: FileEntry) => { files.push(file); return file; };

/* t-search: implement → review (review loop) → verify → merge, with verify's fail edge back to implement. */
const searchImpl1 = add(conversation("search-impl-1", "Keep the old index serving until the new one answers", { mtime: now - 180 * MIN }));
const searchImpl2 = add(conversation("search-impl-2", "Swap the alias only after the warm-up query returns", { mtime: now - 70 * MIN, engine: "claude" }));
const searchRev = add(conversation("search-rev", "Review the warm-up gate", { mtime: now - 41 * MIN, engine: "codex", model: "gpt-5.6" }));
const searchVer1 = add(conversation("search-ver-1", "Results empty for 40 s after the swap", { mtime: now - 90 * MIN }));
const searchVer2 = add(conversation("search-ver-2", "Re-running the rebuild with traffic", working({ plan: { current: "Re-running the rebuild with traffic" } })));
/* t-upload: an eight-stage chain, the UI builder working. */
const uploadPlan = add(conversation("upload-plan", "Plan: 8 MB chunks, resume token per file", { mtime: now - 8 * 60 * MIN }));
const uploadApi = add(conversation("upload-api", "Endpoint and resume token in place", { mtime: now - 6 * 60 * MIN, engine: "codex", model: "gpt-5.6" }));
const uploadRevApi = add(conversation("upload-rev-api", "Round 2 approved", { mtime: now - 4 * 60 * MIN, engine: "codex", model: "gpt-5.6" }));
const uploadUi = add(conversation("upload-ui", "Wiring the resume banner", working({ plan: { current: "Wiring the resume banner" } })));
/* t-export: two plain conversations. */
const exportImpl = add(conversation("export-impl", "Implementer: simplify the export settings", working({ plan: { current: "Writing the preset model" } })));
const exportExplore = add(conversation("export-explore", "Explorer: list every export toggle", { mtime: now - 120 * MIN, engine: "codex", model: "gpt-5.6" }));
/* t-links: a simple chain parked on a decision. */
const linksImpl = add(conversation("links-impl", "Which of the two anchors should win?", { mtime: now - 17 * MIN, engine: "codex", model: "gpt-5.6", waitingInput: { since: now - 17 * MIN } }));
/* t-limits: build failed, the fail edge started diagnose, which needs a decision. */
const limitsBuild = add(conversation("limits-build", "Rate limited before the verdict", { mtime: now - 3 * 24 * 60 * MIN, engine: "codex", model: "gpt-5.6" }));
const limitsDiag = add(conversation("limits-diag", "Retry on another account, or wait for the reset?", { mtime: now - 3 * 24 * 60 * MIN + 20 * MIN }));
/* t-auth and t-pending: one conversation each. */
const authImpl = add(conversation("auth-impl", "Implementer: passkey sign-in", { mtime: now - 20 * 60 * MIN, engine: "codex", model: "gpt-5.6" }));
/* A transcript with nothing in it yet: its reader settles on the empty state. */
const pendingWorker = add(conversation("pending-worker", "Worker waiting for a seat", { mtime: now - 6 * MIN, size: 0 }));
/* t-attach: done by decision while its verify stage still runs; t-compact: completed. */
const attachBuild = add(conversation("attach-build", "Streams attachments in 256 KB chunks", { mtime: now - 13 * 60 * MIN, engine: "codex", model: "gpt-5.6" }));
const attachVerify = add(conversation("attach-verify", "Re-running the phone matrix", working({ plan: { current: "Re-running the phone matrix" } })));
/* Aged out of the scheme window: its stage chip must still open it, by identity. */
const compactBuild = conversation("compact-build", "Folded finished stages into one row", { mtime: now - 3 * 24 * 60 * MIN });
const compactRev = add(conversation("compact-rev", "Approved", { mtime: now - 2 * 24 * 60 * MIN - 90 * MIN, engine: "codex", model: "gpt-5.6" }));
const compactVer = add(conversation("compact-ver", "Board frames match at five widths", { mtime: now - 2 * 24 * 60 * MIN }));
/* The project's orchestrator: seated above the board, and, as in production,
   also a conversation on it ("Not on a task" here). Its one composer is the
   seat's. */
const orchestrator = add(conversation("orchestrator", "Orchestrator for atlas", working({ plan: { current: "Watching the search fix" } })));
/* K4b: the merge task's implementer, and a spike closed on the board. */
const mergeImpl = EDITING ? add(conversation("merge-impl", "Implementer: merge the queue adapter", { mtime: now - 26 * 60 * MIN })) : null;
const oldSpike = EDITING ? add(conversation("old-spike", "Spike: a virtualized Done column", { mtime: now - 5 * 24 * 60 * MIN })) : null;

const pipelines: Pipeline[] = [
  pipeline("p-search", "Restore search results after the index rebuild", "t-search", "running",
    [stage("implement", "builder", "review"), stage("review", "reviewer", "verify"), stage("verify", "verifier", "merge", { onFail: { to: "implement", maxRounds: 2 } }), stage("merge", "cleaner", null)],
    [
      { stageId: "implement", attempts: [attempt(1, "passed", searchImpl1), attempt(2, "passed", searchImpl2, { activatedBy: { stageId: "verify", attempt: 1, edge: "fail" } })] },
      { stageId: "review", attempts: [attempt(1, "passed", searchRev, { ...flowOf("flow-search-review"), reviewFlowSync: { generation: "g1", roundCount: 2, implementerHeadSha: null, reviewerHeadSha: null, verdict: null, relayState: "approved", terminalState: null } })] },
      { stageId: "verify", attempts: [attempt(1, "failed", searchVer1), attempt(2, "running", searchVer2, { activatedBy: { stageId: "review", attempt: 1, edge: "pass" } })] },
    ],
    { stageId: "verify", state: "running", input: null, activatedBy: null }),
  pipeline("p-upload", "Redesign attachment upload for large files", "t-upload", "running",
    [stage("plan", "architect", "build-api"), stage("build-api", "builder", "review-api"), stage("review-api", "reviewer", "build-ui"), stage("build-ui", "builder", "review-ui"), stage("review-ui", "reviewer", "verify"), stage("verify", "verifier", "docs", { onFail: { to: "build-ui", maxRounds: 2 } }), stage("docs", "builder", "merge"), stage("merge", "cleaner", null)],
    [
      { stageId: "plan", attempts: [attempt(1, "passed", uploadPlan)] },
      { stageId: "build-api", attempts: [attempt(1, "passed", uploadApi)] },
      { stageId: "review-api", attempts: [attempt(1, "passed", uploadRevApi, { ...flowOf("flow-upload-review-api"), reviewFlowSync: { generation: "g2", roundCount: 2, implementerHeadSha: null, reviewerHeadSha: null, verdict: null, relayState: "approved", terminalState: null } })] },
      { stageId: "build-ui", attempts: [attempt(1, "running", uploadUi)] },
    ],
    { stageId: "build-ui", state: "running", input: null, activatedBy: null }),
  pipeline("p-links", "Repair old links in the release notes", "t-links", "needs_decision",
    [stage("implement", "builder", "review"), stage("review", "reviewer", null)],
    [{ stageId: "implement", attempts: [attempt(1, "needs_decision", linksImpl)] }],
    { stageId: "implement", state: "running", input: null, activatedBy: null }),
  pipeline("p-limits", "Show the account limit reset time on the card", "t-limits", "needs_decision",
    [stage("build", "builder", "review", { onFail: { to: "diagnose", maxRounds: 1 } }), stage("review", "reviewer", null), stage("diagnose", "architect", null)],
    [
      { stageId: "build", attempts: [attempt(1, "failed", limitsBuild)] },
      { stageId: "diagnose", attempts: [attempt(1, "needs_decision", limitsDiag, { activatedBy: { stageId: "build", attempt: 1, edge: "fail" } })] },
    ],
    { stageId: "diagnose", state: "running", input: null, activatedBy: null }),
  pipeline("p-attach", "Finish responsive native attachment delivery", "t-attach", "running",
    [stage("build", "builder", "verify"), stage("verify", "verifier", null)],
    [{ stageId: "build", attempts: [attempt(1, "passed", attachBuild)] }, { stageId: "verify", attempts: [attempt(1, "running", attachVerify)] }],
    { stageId: "verify", state: "running", input: null, activatedBy: null }),
  pipeline("p-compact", "Compact board stages and separate history from live work", "t-compact", "completed",
    [stage("build", "builder", "review"), stage("review", "reviewer", "verify"), stage("verify", "verifier", null)],
    [
      { stageId: "build", attempts: [attempt(1, "passed", compactBuild)] },
      { stageId: "review", attempts: [attempt(1, "passed", compactRev, { ...flowOf("flow-compact-review"), reviewFlowSync: { generation: "g3", roundCount: 1, implementerHeadSha: null, reviewerHeadSha: null, verdict: null, relayState: "approved", terminalState: null } })] },
      { stageId: "verify", attempts: [attempt(1, "passed", compactVer)] },
    ],
    null),
];

/* Review flows as the store keeps them: one per bound review stage, with its rounds. */
const reviewRole = { engine: "codex", model: "gpt-5.6", effort: "high" };
function reviewFlow(id: string, implementer: FileEntry, reviewer: FileEntry, verdicts: Array<"APPROVE" | "REQUEST_CHANGES">, startedAgo: number) {
  return {
    id, template: "implement-review-loop", project: PROJECT, cwd: "/repo", implementerPath: implementer.path, implementerConversationId: implementer.conversationId,
    roles: { implementer: { engine: "claude", model: "opus", effort: "high" }, reviewer: reviewRole }, baseRef: "0000000", baseMode: "merge-base", mode: "auto",
    reviewerMode: "headless", roundLimit: 5, state: "approved", stateDetail: null, createdAt: iso(startedAgo + 10 * MIN), closedAt: null,
    rounds: verdicts.map((verdict, index) => ({
      n: index + 1, reviewerPath: index === verdicts.length - 1 ? reviewer.path : null, reviewerConversationId: index === verdicts.length - 1 ? reviewer.conversationId : null,
      findingsPath: null, triggeredBy: "marker", readyNote: null, verdict, findingsCount: verdict === "APPROVE" ? 0 : 2, startedAt: iso(startedAgo - index * 20 * MIN),
    })),
  };
}
const flows = PIPELINES ? [
  reviewFlow("flow-search-review", searchImpl2, searchRev, ["APPROVE"], 45 * MIN),
  reviewFlow("flow-upload-review-api", uploadApi, uploadRevApi, ["REQUEST_CHANGES", "APPROVE"], 5 * 60 * MIN),
  reviewFlow("flow-compact-review", compactBuild, compactRev, ["APPROVE"], 2 * 24 * 60 * MIN),
] : [];

let revision = 1;
function task(id: string, status: TaskStatus, title: string, description: string, updatedAgo: number, members: FileEntry[] = [], over: Partial<BoardTask> = {}): BoardTask {
  return {
    id, project: PROJECT, text: description ? `${title}\n${description}` : title, status, placement: "unplaced",
    assignments: members.map((member) => ({ path: member.path, conversationId: member.conversationId, panePid: null, state: "delivered", error: null, at: iso(updatedAgo) })),
    createdAt: iso(updatedAgo + 60 * MIN), updatedAt: iso(updatedAgo), revision: REV(revision++), ...over,
  } as BoardTask;
}

const tasks: BoardTask[] = [
  task("t-search", "assigned", "Restore search results after the index rebuild", "Results vanish for ten minutes after a rebuild. Keep the old index live until the new one answers.", 4 * MIN),
  task("t-upload", "assigned", "Redesign attachment upload for large files", "Resumable uploads for files over 100 MB: chunked API, a progress UI that survives a reload, and docs.", 2 * MIN),
  task("t-export", "assigned", "Simplify the export settings sheet", "Fold the eleven toggles into three sensible presets and one advanced disclosure.", 9 * MIN, [exportImpl, exportExplore]),
  task("t-links", "assigned", "Repair old links in the release notes", "", 17 * MIN),
  task("t-merge-a", "assigned", "Merge the approved queue adapter release · merge", "", 26 * 60 * MIN),
  task("t-verify-a", "assigned", "Verify delivery recovery across transcript boundaries · verify", "", 30 * 60 * MIN),
  task("t-disk", "assigned", "Disk space: find what Docker, worktrees and temp storage hold", "", 41 * 60 * MIN),
  task("t-longtitle", "inbox", "You are the reviewer in an implement-review loop. Working directory is the lane worktree. Read the diff against the merge base, run the touched tests by path, and answer with one verdict block; do not change product source in this stage.", "", 3 * 60 * MIN),
  task("t-pending", "inbox", "", "", 6 * MIN, [pendingWorker], { origin: { kind: "launch", key: "launch-pending", refinement: "pending" } } as Partial<BoardTask>),
  task("t-onboarding", "inbox", "Write the first-run walkthrough", "Three screens, one action each. No tour bubbles.", 2 * 24 * 60 * MIN),
  /* One earlier conversation of this task is outside the scheme window. */
  task("t-auth", "blocked", "Passkey sign-in for the shared board", "Waiting on the domain decision before the relying-party id can be fixed.", 20 * 60 * MIN, [authImpl, conversation("auth-earlier", "Implementer: first passkey attempt")]),
  task("t-limits", "blocked", "Show the account limit reset time on the card", "", 3 * 24 * 60 * MIN),
  task("t-interrupt", "done", "Universal interrupt and stop for every engine", "", 8 * 60 * MIN),
  task("t-attach", "done", "Finish responsive native attachment delivery", "", 12 * 60 * MIN),
  task("t-compact", "done", "Compact board stages and separate history from live work", "", 2 * 24 * 60 * MIN),
  task("t-voice", "done", "Keep the orchestrator role when voice is enabled", "", 3 * 24 * 60 * MIN),
  task("t-queue", "done", "Preserve native queue recovery through journal compaction", "", 4 * 24 * 60 * MIN),
  task("t-old", "done", "An empty task someone took off the board", "", 9 * 24 * 60 * MIN, [], { board: "hidden" }),
];
if (EDITING) {
  const at = (id: string) => tasks.findIndex((entry) => entry.id === id);
  const hide = (id: string, by: "operator" | "agent", secondsAgo: number) => {
    const row = tasks[at(id)]!;
    tasks[at(id)] = { ...row, groupHidden: { at: iso(secondsAgo), by, admitted: admissionSnapshot(row.assignments) } } as BoardTask;
  };
  const merge = tasks[at("t-merge-a")]!;
  tasks[at("t-merge-a")] = { ...merge, assignments: [{ path: mergeImpl!.path, conversationId: mergeImpl!.conversationId, panePid: null, state: "delivered", error: null, at: iso(26 * 60 * MIN) }] } as BoardTask;
  hide("t-merge-a", "operator", 3 * 60 * MIN);
  hide("t-verify-a", "agent", 5 * 60 * MIN);
  hide("t-compact", "operator", 20 * 60 * MIN);
  /* Hidden by an agent before this conversation took the seat: the seat keeps it on the board. */
  tasks.push(task("t-seat", "assigned", "Coordinate the atlas release", "What the orchestrator is steering this week.", 30 * MIN, [orchestrator]));
  hide("t-seat", "agent", 10 * 60 * MIN);
}

/* Short transcripts in the Claude line format, so every reader has a feed. */
const line = (secondsAgo: number, body: Record<string, unknown>) => JSON.stringify({ timestamp: iso(secondsAgo), ...body });
const said = (secondsAgo: number, text: string) => line(secondsAgo, { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const asked = (secondsAgo: number, text: string) => line(secondsAgo, { type: "user", message: { role: "user", content: text }, promptSource: "typed", origin: { kind: "human" } });
const tool = (secondsAgo: number, id: string, name: string, input: Record<string, unknown>) => [
  line(secondsAgo, { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } }),
  line(secondsAgo - 2, { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } }),
];
function transcriptOf(pathname: string): string {
  const file = files.find((entry) => entry.path === pathname);
  if (!file || file === pendingWorker) return "";
  /* The running verifier has a long transcript: its reader scrolls. */
  if (file === searchVer2) {
    const long = [asked(90 * MIN, `${file.title} — pick it up from the task text.`)];
    for (let step = 0; step < 24; step += 1) long.push(said((88 - step * 3) * MIN, `Step ${step + 1}: re-ran the rebuild against live traffic and checked the alias swap window.`));
    return `${long.join("\n")}\n`;
  }
  const lines = file === orchestrator
    ? [
      asked(8 * MIN, "Keep the search fix moving. When the passkey domain is settled, set up a pipeline for the fallback."),
      said(7 * MIN, "Search: the verifier failed once (results were empty for 40 s after the swap). The fail edge sent it back to Implement; attempt 2 passed review and Verify is running again."),
      ...tool(6 * MIN, "toolu_seat_1", "mcp__viewer__list_pipelines", { project: PROJECT }),
      said(2 * MIN, "The release-notes implementer is waiting on you: two anchors match and it needs to know which one wins."),
    ]
    : [
      asked(40 * MIN, `${file.title} — pick it up from the task text.`),
      said(38 * MIN, "Starting on it."),
      ...tool(36 * MIN, `toolu_${file.name}_1`, "Read", { file_path: "src/export/presets.ts" }),
      ...tool(34 * MIN, `toolu_${file.name}_2`, "Bash", { command: "rg --files src/components" }),
      said(30 * MIN, "Checking the fallback path next; nothing to decide yet."),
    ];
  return `${lines.join("\n")}\n`;
}

const params = new URLSearchParams(location.search);
let board = {
  schemaVersion: 1, revision: 1, updatedAt: new Date(0).toISOString(), pathAliases: {},
  prefs: {
    manual: [], hidden: oldSpike ? [oldSpike.path] : [], expanded: [], favorites: [], foldedEngineChildIds: [], expandedEngineTrayParentIds: [],
    viewMode: "scheme", desktopBoard: params.get("face") === "scheme" ? null : "kanban", taskPanelOpen: false,
  },
} as unknown as BoardProjectStateV1;

const evidence = {
  taskPatches: [] as Array<{ id: string; body: Record<string, unknown> }>,
  presence: [] as Array<{ mode: string; visiblePaths: string[]; focusedPath: string | null }>,
  assignments: [] as Array<{ method: string; id: string; body: Record<string, unknown> }>,
  /* The focus handoff this page's Viewer runs, for driving an attention
     arrival without a server behind the offer. */
  focus: { bus: focusHandoffBus, runFocusTransaction },
  /* Transcript reads for this path fail, as a broken route would. */
  failLogsFor: null as string | null,
  /* A write another client made to a task, arriving on the next task read:
     the card re-ranks within its column. */
  touchTask(id: string) {
    const index = tasks.findIndex((entry) => entry.id === id);
    if (index >= 0) tasks[index] = { ...tasks[index]!, updatedAt: new Date().toISOString(), revision: REV(revision++) } as BoardTask;
    window.dispatchEvent(new Event("llv:tasks-changed"));
  },
  /* A status another client wrote, arriving on the next task read. */
  setTaskStatus(id: string, status: TaskStatus) {
    const index = tasks.findIndex((entry) => entry.id === id);
    if (index >= 0) tasks[index] = { ...tasks[index]!, status, updatedAt: new Date().toISOString(), revision: REV(revision++) } as BoardTask;
    window.dispatchEvent(new Event("llv:tasks-changed"));
  },
  boardMutations: [] as BoardMutationV1[],
  refuseNextTaskPatch: false,
  taskAnswerDelayMs: 400,
  /* When each task write reached the fixture and when it was answered. */
  taskWrites: [] as Array<{ id: string; startedAt: number; answeredAt: number }>,
  /* An agent renames a task: the new title arrives on the next task read. */
  agentWritesTitle(id: string, title: string) {
    const index = tasks.findIndex((entry) => entry.id === id);
    if (index < 0) return;
    const row = tasks[index]!;
    const newline = row.text.search(/\r?\n/);
    tasks[index] = { ...row, text: newline < 0 ? title : title + row.text.slice(newline), updatedAt: new Date().toISOString(), revision: REV(revision++) } as BoardTask;
    window.dispatchEvent(new Event("llv:tasks-changed"));
  },
  /* An agent rewrites a task's description where this page cannot see it
     yet: the board's next guarded write meets the newer revision. */
  agentWritesDescriptionQuietly(id: string, description: string) {
    const index = tasks.findIndex((entry) => entry.id === id);
    if (index < 0) return;
    const row = tasks[index]!;
    const title = row.text.split(/\r?\n/, 1)[0] ?? "";
    tasks[index] = { ...row, text: `${title}\n${description}`, updatedAt: new Date().toISOString(), revision: REV(revision++) } as BoardTask;
  },
  /* How long each catalog read takes to answer. The answer is what the store
     held when the read began, as a slow poll would carry. */
  filesDelayMs: 0,
  /* Reads of the orchestrator seat route. */
  seatReads: 0,
  /* A conversation starts waiting on the operator, arriving on the next read. */
  askDecision(pathname: string) {
    const index = files.findIndex((entry) => entry.path === pathname);
    if (index < 0) return;
    files[index] = { ...files[index]!, mtime: Math.floor(Date.now() / 1000), waitingInput: { since: Math.floor(Date.now() / 1000) } } as FileEntry;
    window.dispatchEvent(new Event("llv:tasks-changed"));
  },
  /* A new attempt of a pipeline stage, as the engine records it, arriving on
     the next catalog read. */
  addStageAttempt(pipelineId: string, stageId: string, over: Record<string, unknown>) {
    const record = pipelines.find((entry) => entry.id === pipelineId) as unknown as { runs: Array<{ stageId: string; attempts: Array<Record<string, unknown>> }>; cursor: unknown } | undefined;
    if (!record) return;
    let run = record.runs.find((entry) => entry.stageId === stageId);
    if (!run) record.runs.push(run = { stageId, attempts: [] });
    run.attempts.push(attempt(run.attempts.length + 1, "running", null, over));
    record.cursor = { stageId, state: "running", input: null, activatedBy: over.activatedBy ?? null };
    window.dispatchEvent(new Event("llv:pipelines-changed"));
  },
  /* The stored row, as the fixture's server holds it. */
  storedTask(id: string) {
    return tasks.find((entry) => entry.id === id) ?? null;
  },
};
Object.assign(window, { evidence });

/* Streams stay silent, except the log stream, which reports it cannot connect
   so the feeds read their transcripts through the polled route below. */
class QuietEventSource {
  onerror: ((event: Event) => void) | null = null;
  constructor(url: string | URL) {
    if (String(url).startsWith("/api/logs/stream")) setTimeout(() => this.onerror?.(new Event("error")), 0);
  }
  addEventListener() {}
  removeEventListener() {}
  close() {}
}
Object.assign(window, { EventSource: QuietEventSource });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), location.origin);
  const method = (init?.method ?? "GET").toUpperCase();
  if (url.pathname === "/api/files") {
    const body = JSON.stringify({ files, projectCatalog: [{ project: PROJECT, conversations: files.length }], flows, pipelines, workflows: [], tasks, systemHealth: { tmux: { status: "healthy" } } });
    if (evidence.filesDelayMs) await new Promise((resolve) => setTimeout(resolve, evidence.filesDelayMs));
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.pathname === "/api/runtime/snapshot") return json({ code: RUNTIME_PLANE_ABSENT }, 503);
  if (url.pathname === "/api/board") {
    if (method === "PATCH") {
      const body = JSON.parse(String(init?.body)) as { mutations?: BoardMutationV1[] };
      evidence.boardMutations.push(...(body.mutations ?? []));
      const reduced = applyBoardMutations(board, body.mutations ?? []);
      board = { ...reduced, schemaVersion: 1, revision: board.revision + 1, pathAliases: reduced.pathAliases ?? {} };
      return json({ ok: true, applied: true, board });
    }
    return json({ ok: true, board });
  }
  if (url.pathname === "/api/view/presence" && method === "POST") {
    const body = JSON.parse(String(init?.body)) as { mode: string; visiblePaths: string[]; focusedPath?: string | null };
    evidence.presence.push({ mode: body.mode, visiblePaths: body.visiblePaths, focusedPath: body.focusedPath ?? null });
    return json({ ok: true });
  }
  if (url.pathname === "/api/tasks" && method === "GET") return json({ tasks });
  if (url.pathname.startsWith("/api/tasks/") && method === "PATCH") {
    const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    evidence.taskPatches.push({ id, body });
    const write = { id, startedAt: performance.now(), answeredAt: 0 };
    evidence.taskWrites.push(write);
    await new Promise((resolve) => setTimeout(resolve, evidence.taskAnswerDelayMs));
    write.answeredAt = performance.now();
    if (evidence.refuseNextTaskPatch) {
      evidence.refuseNextTaskPatch = false;
      return json({ error: "refused by the evidence fixture" }, 500);
    }
    const index = tasks.findIndex((entry) => entry.id === id);
    if (index < 0) return json({ error: "task not found" }, 404);
    const current = tasks[index] as BoardTask & { revision: string };
    if (body.expectedRevision !== undefined && body.expectedRevision !== current.revision) return json({ error: "expectedRevision is stale", code: "TASK_REVISION_MISMATCH", field: "expectedRevision" }, 409);
    /* The route's rules for the fields the board writes (#1695 K4a). */
    const next = { ...current } as BoardTask & Record<string, unknown>;
    if (body.status) next.status = body.status as TaskStatus;
    if (body.board) next.board = body.board as BoardTask["board"];
    if (typeof body.text === "string") {
      next.text = body.text;
      if (current.origin?.refinement === "pending") next.origin = { ...current.origin, refinement: "titled" };
    }
    if (body.color !== undefined) {
      if (body.color === "none") delete next.color;
      else next.color = body.color as BoardTask["color"];
    }
    if (body.hide === true) {
      if (current.assignments.some((row) => row.conversationId === orchestrator.conversationId)) {
        return json({ error: "this task holds the project's orchestrator seat conversation, which stays on the board; it cannot be hidden", code: "TASK_HIDE_PROTECTED", field: "hide" }, 409);
      }
      next.groupHidden = { at: new Date().toISOString(), by: "operator", admitted: admissionSnapshot(current.assignments) };
    } else if (body.hide === false) {
      delete next.groupHidden;
    }
    const presentationOnly = Object.keys(body).every((key) => key === "color" || key === "hide" || key === "expectedProject" || key === "expectedRevision");
    next.updatedAt = presentationOnly ? current.updatedAt : new Date().toISOString();
    next.revision = REV(revision++);
    tasks[index] = next;
    return json({ ok: true, task: next });
  }
  if (url.pathname.startsWith("/api/tasks/") && url.pathname.endsWith("/assignment")) {
    const id = decodeURIComponent(url.pathname.split("/")[3] ?? "");
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    evidence.assignments.push({ method, id, body });
    const index = tasks.findIndex((entry) => entry.id === id);
    if (index < 0) return json({ error: "task not found" }, 404);
    const current = tasks[index]!;
    if (method === "POST") {
      const next = { ...current, assignments: [...current.assignments, { path: String(body.path), panePid: null, state: "handoff", error: null, at: new Date().toISOString() }], revision: REV(revision++) } as BoardTask;
      tasks[index] = next;
      return json({ ok: true, task: next });
    }
    const matches = (assignment: BoardTask["assignments"][number]) => (body.conversationId ? assignment.conversationId === body.conversationId : assignment.path === body.path);
    /* A conversation whose only task this is has nowhere to go: the route's refusal. */
    if (current.assignments.filter(matches).length && !tasks.some((other) => other.id !== id && other.assignments.some(matches))) {
      return json({ error: "this task is the conversation's own membership; link the conversation to another task first or delete the task" }, 409);
    }
    const next = { ...current, assignments: current.assignments.filter((assignment) => !matches(assignment)), revision: REV(revision++) } as BoardTask;
    tasks[index] = next;
    return json({ ok: true, task: next });
  }
  if (url.pathname === "/api/logs" && method === "POST") {
    const { reqs } = JSON.parse(String(init?.body)) as { reqs: Array<{ id: string; path: string; offset: number }> };
    return json({ chunks: Object.fromEntries(reqs.map((req) => {
      if (req.path === evidence.failLogsFor) return [req.id, { error: "transcript read failed in the evidence fixture" }];
      const data = transcriptOf(req.path);
      const size = new TextEncoder().encode(data).length;
      return [req.id, { data: req.offset >= size ? "" : data, start: 0, offset: size, size }];
    })) });
  }
  if (url.pathname === "/api/log") return json({ data: "", start: 0, offset: 0, size: 0 });
  if (url.pathname === "/api/conversations") return json({ items: files, total: files.length, nextCursor: null });
  if (url.pathname === "/api/orchestrator/seat") {
    evidence.seatReads += 1;
    return json({
      seat: {
        project: PROJECT, seatEpoch: 3, conversationId: orchestrator.conversationId, path: orchestrator.path, mandate: "Keep the project moving.",
        promptVersion: null, predecessorConversationId: null, state: "active",
        intent: { clientRequestId: "seat-atlas", mode: "spawn", launchId: null, error: null }, designatedAt: iso(9 * 60 * MIN), activatedAt: iso(9 * 60 * MIN),
      },
      pending: null,
      exists: true,
      viewerMcpRegistered: true,
    });
  }
  return json({}, 404);
}) as typeof fetch;

localStorage.setItem("llvProject", PROJECT);
localStorage.setItem("llv_lang", "en");
if (!location.hash) location.hash = `#p=${PROJECT}`;
createRoot(document.getElementById("root")!).render(<Viewer />);
