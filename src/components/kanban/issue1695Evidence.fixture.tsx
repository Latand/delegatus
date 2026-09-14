import { createRoot } from "react-dom/client";

import { Viewer } from "@/components/Viewer";
import { applyBoardMutations, type BoardMutationV1 } from "@/lib/board/mutations";
import type { Pipeline } from "@/lib/pipelines/types";
import { RUNTIME_PLANE_ABSENT } from "@/lib/runtime/flags";
import type { BoardTask, TaskStatus } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import type { BoardProjectStateV1 } from "@/lib/view/types";

/*
 * The real Viewer on the kanban face (#1695), over invented content equivalent
 * to the approved prototype's fixture (`prototypes/kanban-board/fixture.js`):
 * the same tasks in the same columns, the branch-retry-review pipeline, the
 * eight-stage chain, the simple chain parked on a decision, a forward fail
 * branch, and plain conversation members. Every request the Viewer makes is
 * answered here; nothing reaches a server, a store or a state directory.
 * Driven by `issue1695Kanban.browser.test.tsx`.
 */

const PROJECT = "atlas";
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
const pendingWorker = add(conversation("pending-worker", "Worker waiting for a seat", { mtime: now - 6 * MIN }));
/* t-attach: done by decision while its verify stage still runs; t-compact: completed. */
const attachBuild = add(conversation("attach-build", "Streams attachments in 256 KB chunks", { mtime: now - 13 * 60 * MIN, engine: "codex", model: "gpt-5.6" }));
const attachVerify = add(conversation("attach-verify", "Re-running the phone matrix", working({ plan: { current: "Re-running the phone matrix" } })));
/* Aged out of the scheme window: its stage chip must still open it, by identity. */
const compactBuild = conversation("compact-build", "Folded finished stages into one row", { mtime: now - 3 * 24 * 60 * MIN });
const compactRev = add(conversation("compact-rev", "Approved", { mtime: now - 2 * 24 * 60 * MIN - 90 * MIN, engine: "codex", model: "gpt-5.6" }));
const compactVer = add(conversation("compact-ver", "Board frames match at five widths", { mtime: now - 2 * 24 * 60 * MIN }));

const pipelines: Pipeline[] = [
  pipeline("p-search", "Restore search results after the index rebuild", "t-search", "running",
    [stage("implement", "builder", "review"), stage("review", "reviewer", "verify"), stage("verify", "verifier", "merge", { onFail: { to: "implement", maxRounds: 2 } }), stage("merge", "cleaner", null)],
    [
      { stageId: "implement", attempts: [attempt(1, "passed", searchImpl1), attempt(2, "passed", searchImpl2, { activatedBy: { stageId: "verify", attempt: 1, edge: "fail" } })] },
      { stageId: "review", attempts: [attempt(1, "passed", searchRev, { reviewFlowSync: { generation: "g1", roundCount: 2, implementerHeadSha: null, reviewerHeadSha: null, verdict: null, relayState: "approved", terminalState: null } })] },
      { stageId: "verify", attempts: [attempt(1, "failed", searchVer1), attempt(2, "running", searchVer2, { activatedBy: { stageId: "review", attempt: 1, edge: "pass" } })] },
    ],
    { stageId: "verify", state: "running", input: null, activatedBy: null }),
  pipeline("p-upload", "Redesign attachment upload for large files", "t-upload", "running",
    [stage("plan", "architect", "build-api"), stage("build-api", "builder", "review-api"), stage("review-api", "reviewer", "build-ui"), stage("build-ui", "builder", "review-ui"), stage("review-ui", "reviewer", "verify"), stage("verify", "verifier", "docs", { onFail: { to: "build-ui", maxRounds: 2 } }), stage("docs", "builder", "merge"), stage("merge", "cleaner", null)],
    [
      { stageId: "plan", attempts: [attempt(1, "passed", uploadPlan)] },
      { stageId: "build-api", attempts: [attempt(1, "passed", uploadApi)] },
      { stageId: "review-api", attempts: [attempt(1, "passed", uploadRevApi, { reviewFlowSync: { generation: "g2", roundCount: 2, implementerHeadSha: null, reviewerHeadSha: null, verdict: null, relayState: "approved", terminalState: null } })] },
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
      { stageId: "review", attempts: [attempt(1, "passed", compactRev, { reviewFlowSync: { generation: "g3", roundCount: 1, implementerHeadSha: null, reviewerHeadSha: null, verdict: null, relayState: "approved", terminalState: null } })] },
      { stageId: "verify", attempts: [attempt(1, "passed", compactVer)] },
    ],
    null),
];

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

const params = new URLSearchParams(location.search);
let board = {
  schemaVersion: 1, revision: 1, updatedAt: new Date(0).toISOString(), pathAliases: {},
  prefs: {
    manual: [], hidden: [], expanded: [], favorites: [], foldedEngineChildIds: [], expandedEngineTrayParentIds: [],
    viewMode: "scheme", desktopBoard: params.get("face") === "scheme" ? null : "kanban", taskPanelOpen: false,
  },
} as unknown as BoardProjectStateV1;

const evidence = {
  taskPatches: [] as Array<{ id: string; body: Record<string, unknown> }>,
  presence: [] as Array<{ mode: string; visiblePaths: string[] }>,
  boardMutations: [] as BoardMutationV1[],
  refuseNextTaskPatch: false,
  taskAnswerDelayMs: 400,
};
Object.assign(window, { evidence });

class QuietEventSource { addEventListener() {} removeEventListener() {} close() {} }
Object.assign(window, { EventSource: QuietEventSource });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), location.origin);
  const method = (init?.method ?? "GET").toUpperCase();
  if (url.pathname === "/api/files") {
    return json({ files, projectCatalog: [{ project: PROJECT, conversations: files.length }], flows: [], pipelines, workflows: [], tasks, systemHealth: { tmux: { status: "healthy" } } });
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
    const body = JSON.parse(String(init?.body)) as { mode: string; visiblePaths: string[] };
    evidence.presence.push({ mode: body.mode, visiblePaths: body.visiblePaths });
    return json({ ok: true });
  }
  if (url.pathname === "/api/tasks" && method === "GET") return json({ tasks });
  if (url.pathname.startsWith("/api/tasks/") && method === "PATCH") {
    const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    evidence.taskPatches.push({ id, body });
    await new Promise((resolve) => setTimeout(resolve, evidence.taskAnswerDelayMs));
    if (evidence.refuseNextTaskPatch) {
      evidence.refuseNextTaskPatch = false;
      return json({ error: "refused by the evidence fixture" }, 500);
    }
    const index = tasks.findIndex((entry) => entry.id === id);
    if (index < 0) return json({ error: "task not found" }, 404);
    const current = tasks[index] as BoardTask & { revision: string };
    if (body.expectedRevision !== undefined && body.expectedRevision !== current.revision) return json({ error: "expectedRevision is stale" }, 409);
    const next = { ...current, ...(body.status ? { status: body.status } : {}), ...(body.board ? { board: body.board } : {}), updatedAt: new Date().toISOString(), revision: REV(revision++) } as unknown as BoardTask;
    tasks[index] = next;
    return json({ ok: true, task: next });
  }
  if (url.pathname === "/api/conversations") return json({ items: files, total: files.length, nextCursor: null });
  if (url.pathname === "/api/orchestrator/seat") return json({ seat: null, pending: null, exists: true });
  return json({}, 404);
}) as typeof fetch;

localStorage.setItem("llvProject", PROJECT);
localStorage.setItem("llv_lang", "en");
if (!location.hash) location.hash = `#p=${PROJECT}`;
createRoot(document.getElementById("root")!).render(<Viewer />);
