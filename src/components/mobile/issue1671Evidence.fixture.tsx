/*
 * The page `issue1671Evidence.browser.test.tsx` drives: the real Viewer over an
 * invented phone board — ten lanes waiting on a decision, one running
 * conversation, thirty finished ones and a 46-entry stored catalog — answered
 * by an in-page fetch double. Board writes go through the product's own
 * reducer, and every write is recorded on `window.evidence`, so the driver
 * reads what a gesture really sent. All data is invented.
 */
import { createRoot } from "react-dom/client";

import { Viewer } from "@/components/Viewer";
import { applyBoardMutations, type BoardMutationV1 } from "@/lib/board/mutations";
import type { Pipeline } from "@/lib/pipelines/types";
import { RUNTIME_PLANE_ABSENT } from "@/lib/runtime/flags";
import type { FileEntry } from "@/lib/types";
import type { BoardProjectStateV1 } from "@/lib/view/types";

const PROJECT = "atlas";
const queueRecovery = new URLSearchParams(location.search).has("queue-recovery");
const now = Math.floor(Date.now() / 1000);
const iso = (secondsAgo: number) => new Date((now - secondsAgo) * 1_000).toISOString();
/* A real close spends seconds stopping the lane's hosts before it answers. */
const CLOSE_ANSWER_MS = 2_500;

function conversation(path: string, title: string, over: Record<string, unknown> = {}): FileEntry {
  return {
    path, root: "claude-projects", name: path.split("/").pop(), project: PROJECT, title, engine: "claude", kind: "session",
    fmt: "claude", parent: null, mtime: now - 900, size: 2_048, activity: "idle", proc: null, pid: null, model: "opus",
    pendingQuestion: null, waitingInput: null, conversationId: `conversation_${(path.split("/").pop() ?? "").replace(".jsonl", "")}`,
    ...over,
  } as unknown as FileEntry;
}

const TASKS = [
  "Fast conversation switching", "Stage verdict recovery after a host restart", "Seat rotation keeps the mandate",
  "Queue drain on reconnect", "Archive TTL for closed lanes", "Deploy gate reads the pinned runtime",
  "Catalog pages stay in snapshot order", "Voice utterances render once", "Held deliveries heal themselves",
  "Board zoom keeps the focused card",
];

function lane(id: string, task: string, attempts: unknown[], over: Record<string, unknown> = {}): Pipeline {
  return {
    id, task, taskIds: [], project: PROJECT, repoDir: "/repo", worktreeDir: `/repo-${id}`, branch: `lane/${id}`,
    baseBranch: "main", baseRef: "main", lastPassedCommit: "",
    stages: [
      { id: "implement", kind: "run", effectiveRole: { roleId: "builder", access: "read-write", promptScaffold: null } },
      { id: "review", kind: "review-loop", effectiveRole: { roleId: "reviewer", access: "read-only", promptScaffold: null } },
    ],
    runs: [{ stageId: "review", attempts }],
    cursor: { stageId: "review", state: "reviewing", input: null, activatedBy: null },
    state: "needs_decision", pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null,
    createdAt: iso(7_200), closedAt: null,
    ...over,
  } as unknown as Pipeline;
}

const failedRound = (n: number, startedAgo: number, completedAgo: number, findings = 1) => ({
  n, state: "failed", startedAt: iso(startedAgo), completedAt: iso(completedAgo),
  /* Every recorded attempt carries the role it ran under; the desktop board's
     task projection reads it without a guard, and a round without one took the
     whole board down when this fixture was first opened at desktop width. */
  effectiveRole: { roleId: "reviewer", access: "read-only", promptScaffold: null },
  verdict: { status: "fail", findings: Array.from({ length: findings }, (_, i) => `finding ${i + 1}`) },
});

const pipelines = [
  ...TASKS.map((task, i) => lane(`lane-${i}`, task, [failedRound(1 + (i % 3), 3_600 * (i + 1) + 600, 3_600 * (i + 1), 1 + (i % 4))], { createdAt: iso(7_200 * (i + 1)) })),
  /* A Hide covers the decision it saw (#1671): this lane was hidden after the
     round that parked it and has not moved since, so it stays off the board. */
  lane("lane-hidden", "Seat tick accounting survives a restart", [failedRound(1, 6_000, 5_400)], { dismissedAt: iso(4_800) }),
  /* ...and this one was hidden, retried, and parked again on a round that
     started after the Hide: a decision nobody hid, back in Needs you. */
  lane("lane-parked-again", "Board bands keep their order", [failedRound(1, 9_000, 8_400), failedRound(2, 3_000, 2_400)], { dismissedAt: iso(7_800) }),
];

/* #1865, only when the page asks for it (`?stages=1`): a lane whose design and
   critique stages share the architect preset, parked on its second critique,
   so the queue row and the stage rows can be read for which stage is which. */
if (new URLSearchParams(location.search).has("stages")) {
  const architect = { roleId: "architect", engine: "claude", model: "opus", effort: "high", access: "read-only", promptScaffold: null };
  const ran = (n: number, state: string, startedAgo: number, over: Record<string, unknown> = {}) => ({
    n, state, startedAt: iso(startedAgo), completedAt: state === "running" ? null : iso(startedAgo - 300), effectiveRole: architect, ...over,
  });
  pipelines.unshift(lane("lane-labels", "Header lane reads which stage is which", [], {
    stages: [
      { id: "design", kind: "run", role: { roleId: "architect" }, effectiveRole: architect, next: "critique" },
      { id: "critique", kind: "run", role: { roleId: "architect" }, effectiveRole: architect, next: null, onFail: { to: "design", maxRounds: 3 } },
    ],
    runs: [
      { stageId: "design", attempts: [ran(1, "passed", 5_400), ran(2, "passed", 2_400)] },
      { stageId: "critique", attempts: [ran(1, "failed", 3_600), ran(2, "failed", 1_200, { verdict: { status: "fail", findings: ["finding 1", "finding 2"] } })] },
    ],
    cursor: { stageId: "critique", state: "running", input: null, activatedBy: null },
    createdAt: iso(600),
  }));
}

/* The running conversation lives under a managed account home/* The running conversation lives under a managed account home, the way a real
   transcript of a managed account does, so the surfaces that name the account
   (#1795) have a real one to name rather than the legacy default. The id is
   `?account=` so one page can be asked for a long one, which is what crowds a
   390 px meta line. */
const ACCOUNT = new URLSearchParams(location.search).get("account") || "spare";
const RUNNING_PATH = `/state/agent-log-viewer/shared/accounts/claude/${ACCOUNT}/projects/atlas/running.jsonl`;
/* #1846: `&runtime=structured` puts the running conversation on a structured host, mid-turn, so its runtime
   pill picks an account for the conversation itself; `&next=` names the account ready to take the next
   message, which with a long running id is what the title line has to hold as well. */
const STRUCTURED = new URLSearchParams(location.search).get("runtime") === "structured";
const NEXT_ACCOUNT = new URLSearchParams(location.search).get("next") || "relief";

/* With the deck asked for (#1795 below), the running conversation is the round
   under review, and says so the way a reviewer transcript does. */
const deckRequested = new URLSearchParams(location.search).has("deck");
const reviewerLineage = deckRequested
  ? { durableLineage: { kind: "review", role: "reviewer", parentConversationId: "conversation_done-0", reviewsConversationId: "conversation_done-0", memberships: [] } }
  : {};

const files: FileEntry[] = [
  conversation(RUNNING_PATH, "Rebuild the board status projection", {
    activity: "live", proc: "running", pid: 4_401, mtime: now - 20,
    /* A real launch model, not a one-word one: the bar line has to hold
       `fable-5-1 · high` beside the state phrase and the account (#1795). */
    model: "fable-5-1", effort: "high",
    ...reviewerLineage,
    lastTurn: { startedAt: (now - 400) * 1_000, endedAt: null },
    ...(queueRecovery ? {
      activity: "idle", lastTurn: { startedAt: (now - 400) * 1_000, endedAt: (now - 20) * 1_000 },
      authoritativeTurn: { state: "terminal", source: "lifecycle", terminalAt: iso(20), terminalKind: "completed" },
    } : {}),
  }),
  ...Array.from({ length: 30 }, (_, i) => conversation(
    `/repo/done-${i}.jsonl`,
    i === 0 ? "A long finished conversation title that has to stay inside the phone row while its tray opens" : `Finished conversation ${i + 1}`,
    { mtime: now - 900 - i * 600, activity: i < 2 ? "recent" : "idle", engine: i % 3 === 1 ? "codex" : "claude", model: i % 3 === 1 ? "gpt-5.6" : "opus" },
  )),
];
const catalog = Array.from({ length: 45 }, (_, i) => conversation(`/repo/history-${i}.jsonl`, `Stored conversation ${i + 1}`, { mtime: now - 90_000 - i * 3_600 }));
/* A superseded round only the stored catalog still lists, as the conversations
   route marks it (#1671): the board never shows it. */
catalog.splice(5, 0, conversation("/repo/superseded-round.jsonl", "Superseded review round", {
  mtime: now - 95_000,
  supersededBy: { conversationId: "conversation_history-5", path: "/repo/history-5.jsonl", at: iso(94_000), reason: "stage-retry" },
}));

/* #1795 asks for the surface the operator hit: a review round opened from the
   board, whose pane the round deck mounts on a perspective stage. It is added
   only when the page is asked for it (`?deck=1`), so every other case on this
   fixture keeps the board it has always had. */
const flows = deckRequested ? [{
  id: "flow-review", project: PROJECT, state: "reviewing",
  implementerPath: "/repo/done-0.jsonl", implementerConversationId: "conversation_done-0",
  rounds: [{ n: 1, reviewerPath: RUNNING_PATH, reviewerConversationId: "conversation_running", verdict: null, error: null, startedAt: iso(300) }],
}] : [];

let board = {
  schemaVersion: 1, revision: 1, updatedAt: new Date(0).toISOString(), pathAliases: {},
  prefs: { manual: [], hidden: [], expanded: [], favorites: [], foldedEngineChildIds: [], expandedEngineTrayParentIds: [], viewMode: null, taskPanelOpen: false },
} as unknown as BoardProjectStateV1;

const evidence = {
  catalogRequests: [] as string[],
  /* Every reconfigure the runtime pill sends, so a re-tap of the tier the
     conversation already runs on can be shown to send nothing (#1795). */
  runtimeRequests: [] as Array<Record<string, unknown>>,
  /* Every account select, the one path that moves the next message. */
  accountSelects: [] as Array<{ engine: string; body: unknown }>,
  pipelinePatches: [] as Array<{ id: string; action: string }>,
  closesAnswered: [] as string[],
  hidesAnswered: [] as Array<{ id: string; action: string; dismissedAt: string | null }>,
  boardMutations: [] as BoardMutationV1[],
  refuseNextPipelinePatch: false,
  /* Every task PATCH the phone's columns sent (#2072 slice 4). */
  taskPatches: [] as Array<{ id: string; body: Record<string, unknown> }>,
  /* Holds each pipeline answer this long, so a step can watch the frames
     painted while its requests are out. */
  pipelineAnswerDelayMs: 0,
};
Object.assign(window, { evidence });

/* No log stream in the fixture: the source fails at once, the way a Viewer
   behind a proxy that drops SSE does, and the bus falls back to the file poll
   the fixture answers below. Without the failure it waits on a stream that
   never opens and the feed behind the sheet stays empty. */
class QuietEventSource {
  onerror: ((event: unknown) => void) | null = null;
  constructor() {
    setTimeout(() => this.onerror?.(new Event("error")), 0);
  }
  addEventListener() {}
  removeEventListener() {}
  close() {}
}
Object.assign(window, { EventSource: QuietEventSource });

/** The account future launches use; a select moves it, as on the server. */
let activeAccount = ACCOUNT;

/* A transcript with something in it, so the feed behind the sheet is a real
   scrolled feed — its rows, and its own down button, are what floated over the
   sheet in the operator's screenshot. All invented. */
const BANDS = `${Array.from({ length: 24 }, (_, i) => (i % 2 === 0
  ? JSON.stringify({
    type: "user", uuid: `evidence-u-${i}`, timestamp: iso(2_400 - i * 60), sessionId: "conversation_running",
    message: { role: "user", content: `Replay band ${i + 1} and say what moved.` },
  })
  : JSON.stringify({
    type: "assistant", uuid: `evidence-a-${i}`, timestamp: iso(2_400 - i * 60), sessionId: "conversation_running",
    message: {
      role: "assistant", model: "claude-fable-5-1",
      content: [{ type: "text", text: `Band ${i} replayed from the snapshot: the projection matches, and nothing outside it moved.` }],
    },
  }))).join("\n")}\n`;

/* #1978, only when the page asks for it (`?toolcard=1`): the bands end on a
   run of three calls (the run the README's phone shot opens), the last a shell
   call whose one-line command and multi-line output each carry a copy
   control, then the answer, and a board task is assigned to the conversation,
   so its pane shows the task strip right above the feed's top edge. */
const TOOLCARD = new URLSearchParams(location.search).has("toolcard");
const record = (i: number, role: "user" | "assistant", content: unknown) => JSON.stringify({
  type: role, uuid: `evidence-tool-${i}`, timestamp: iso(900 - i * 30), sessionId: "conversation_running",
  message: role === "assistant" ? { role, model: "claude-fable-5-1", content } : { role, content },
});
/* A long result: its preview ends in «show all output», and opened it is a
   call far taller than the screen, whose lines and copy control meet the edge
   together. */
const LONG_READ = Array.from({ length: 60 }, (_, i) => `${i + 1}\t  band(${i}): replay the snapshot row and keep the projection in order;`).join("\n");
const TOOL_RUN = [
  record(0, "assistant", [{ type: "tool_use", id: "toolu_evidence_long", name: "Read", input: { file_path: "src/board/bands.ts", offset: 1, limit: 60 } }]),
  record(1, "user", [{ type: "tool_result", tool_use_id: "toolu_evidence_long", content: LONG_READ }]),
  record(2, "assistant", [{ type: "tool_use", id: "toolu_evidence_read", name: "Read", input: { file_path: "src/board/projection.ts", offset: 1, limit: 12 } }]),
  record(3, "user", [{ type: "tool_result", tool_use_id: "toolu_evidence_read", content: "1\texport { replay } from \"./replay\";" }]),
  record(4, "assistant", [{ type: "tool_use", id: "toolu_evidence_grep", name: "Grep", input: { pattern: "applyBand", path: "src/board", output_mode: "content" } }]),
  record(5, "user", [{ type: "tool_result", tool_use_id: "toolu_evidence_grep", content: "src/board/projection.ts:2:  return snapshot.bands.reduce(applyBand, emptyBoard());\nsrc/board/bands.ts:14:export function applyBand(board: Board, band: Band): Board {" }]),
  record(6, "assistant", [{ type: "tool_use", id: "toolu_evidence_run", name: "Bash", input: { command: "bun test src/board", description: "Run the board tests" } }]),
  record(7, "user", [{ type: "tool_result", tool_use_id: "toolu_evidence_run", content: "src/board/projection.test.ts:\n✓ replays a band from the snapshot [11.20ms]\n✓ keeps the band order after a reload [3.90ms]\n✓ answers a stale revision with the current board [2.40ms]\n\n 3 pass\n 0 fail\nRan 3 tests across 1 file. [141.00ms]" }]),
  record(8, "assistant", [{ type: "text", text: "The projection replays every band from the snapshot, and the three board tests pass." }]),
].join("\n");
const FEED = TOOLCARD ? `${BANDS}${TOOL_RUN}\n` : BANDS;
const tasks = TOOLCARD ? [{
  id: "task-projection", project: PROJECT, status: "assigned", placement: "unplaced", board: "shown",
  text: "Rebuild the board status projection\nReplay every band from the snapshot.",
  assignments: [{ path: RUNNING_PATH, conversationId: "conversation_running", panePid: null, state: "delivered", error: null, at: iso(1_800), engine: "claude" }],
  createdAt: iso(3_600), updatedAt: iso(1_800),
}] : [];

/* #2072 slice 4, only when the page asks for it (`?kanban=1`): a project whose
   phone board is the status columns, shaped like the approved round-2 frames
   (docs/design/phone-kanban.md §6). Assigned carries a lane parked on a
   decision beside a paused one, a spent review budget whose fail edge fired,
   running chains of two, three and eight stages, a 43-character stage name,
   the 687-character title and a Ukrainian one, and two finished lanes;
   Inbox a task whose agent asks, four stalled conversations and a running
   lane no task owns; Blocked is empty; Done holds more than its window. The
   orchestrator seat is live. Titles are public issue titles of this
   repository or invented; ages agree across the board. */
const KANBAN = new URLSearchParams(location.search).has("kanban");
const kanbanFiles: FileEntry[] = [];
const kanbanLinks: { pipelines: Record<string, unknown>; tasks: Record<string, unknown> } = { pipelines: {}, tasks: {} };
const kanbanRole = (roleId: string) => ({ roleId, access: roleId === "reviewer" ? "read-only" : "read-write", promptScaffold: null });
const idOf = (path: string) => `conversation_${(path.split("/").pop() ?? "").replace(".jsonl", "")}`;
let kanbanSeq = 0;
/** A conversation on the board: working for `ago` seconds, or settled `ago` seconds back. */
function kanbanConversation(title: string, state: "working" | "settled" | "asking" | "stalled", ago: number, over: Record<string, unknown> = {}): string {
  const path = `/repo/kanban-${++kanbanSeq}.jsonl`;
  const byState: Record<string, Record<string, unknown>> = {
    working: { activity: "live", proc: "running", pid: 5_000 + kanbanSeq, mtime: now - 20, lastTurn: { startedAt: (now - ago) * 1_000, endedAt: null }, lastAgentWorkAt: (now - 20) * 1_000 },
    settled: { mtime: now - ago, lastAgentWorkAt: (now - ago) * 1_000 },
    asking: {
      activity: "live", proc: "running", pid: 5_000 + kanbanSeq, mtime: now - ago, lastAgentWorkAt: (now - ago) * 1_000,
      pendingQuestion: { kind: "question", toolUseId: `toolu-kanban-${kanbanSeq}`, transcriptPath: path, pid: 5_000 + kanbanSeq, paneTarget: null, askedAt: iso(ago),
        questions: [{ question: "Which unit file stays, the user unit or the system one?", header: "Unit", multiSelect: false, options: [] }] },
    },
    stalled: { activity: "stalled", activityReason: "jsonl_turn_stalled", proc: "running", pid: 5_000 + kanbanSeq, mtime: now - ago, engine: "codex", model: "gpt-6-astra", lastTurn: { startedAt: (now - ago - 600) * 1_000, endedAt: null }, lastAgentWorkAt: (now - ago) * 1_000 },
  };
  kanbanFiles.push(conversation(path, title, { ...byState[state], ...over }));
  return path;
}
interface KanbanStage { id: string; state?: "passed" | "running" | "failed" | "needs_decision"; ago?: number; role?: string; onFail?: { to: string; maxRounds: number }; attempts?: unknown[] }
function kanbanLane(id: string, title: string, taskIds: string[], state: Pipeline["state"], stages: KanbanStage[], over: Record<string, unknown> = {}): Pipeline {
  const runs: unknown[] = [];
  let cursor: unknown = null;
  for (const spec of stages) {
    if (spec.attempts) { runs.push({ stageId: spec.id, attempts: spec.attempts }); continue; }
    if (!spec.state) continue;
    const ago = spec.ago ?? 900;
    const agentPath = kanbanConversation(`${title.split("\n")[0]} · ${spec.id}`, spec.state === "running" ? "working" : "settled", ago);
    const failing = spec.state === "failed" || spec.state === "needs_decision";
    runs.push({ stageId: spec.id, attempts: [{
      n: 1, state: spec.state, startedAt: iso(ago + 300), completedAt: spec.state === "running" ? null : iso(ago), agentPath, conversationId: idOf(agentPath),
      activatedBy: null, effectiveRole: kanbanRole(spec.role ?? "builder"),
      verdict: failing ? { status: "fail", findings: ["The delta chain is rebuilt on the request thread; the worker must own it."] } : spec.state === "passed" ? { status: "pass", findings: [] } : null,
    }] });
    if (spec.state === "running" || spec.state === "needs_decision") cursor = { stageId: spec.id, state: spec.state, input: null, activatedBy: null };
  }
  return {
    id, task: title, taskIds, project: PROJECT, repoDir: "/repo", worktreeDir: `/repo-${id}`, branch: `lane/${id}`, baseBranch: "main", baseRef: "main", lastPassedCommit: "",
    stages: stages.map((spec, index) => ({ id: spec.id, kind: "run", effectiveRole: kanbanRole(spec.role ?? "builder"), next: stages[index + 1]?.id ?? null, ...(spec.onFail ? { onFail: spec.onFail } : {}) })),
    runs, cursor, state, pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null, createdAt: iso(14_400), closedAt: state === "completed" ? iso(1_200) : null,
    ...over,
  } as unknown as Pipeline;
}
const prLinks = (number: number, state: "open" | "merged" = "open") => ({
  links: [{ key: `example/atlas#${number}`, kind: "pr", repository: "example/atlas", number, url: `https://github.com/example/atlas/pull/${number}`, source: "auto", via: ["delivery-pr"], state, checkedAt: iso(60) }],
  noPr: false,
});
const kanbanAssign = (path: string) => ({ path, conversationId: idOf(path), panePid: null, state: "delivered", error: null, at: iso(3_600), engine: "claude" });
const kanbanTask = (id: string, status: string, text: string, over: Record<string, unknown> = {}) => ({
  id, project: PROJECT, status, text, placement: "unplaced", board: "shown", assignments: [], createdAt: iso(3 * 86_400), updatedAt: iso(3_600), revision: `r-${id}-1`, ...over,
});
const LONG_TITLE = [
  "Board and phone: one definition of «working» everywhere a count is shown, so the bar, the tabs, the cards, the seat and the switcher never disagree about how many agents are running;",
  "today the bar counts open turns, the switcher counts live transcripts, the seat counts its own children and the cards count members whose row state is working or held,",
  "and on a busy afternoon the phone showed three different numbers for the same five agents within one screen, which made the operator open each conversation to find out which number was true;",
  "pick the row state as the one authority and have every surface read it",
].join(" ");
const kanbanPipelines: Pipeline[] = [];
const kanbanTasks: unknown[] = [];
if (KANBAN) {
  /* Assigned */
  kanbanPipelines.push(kanbanLane("k-decision", "Mobile data: stop repeated full-board downloads", ["t-data"], "needs_decision", [
    { id: "implement", state: "needs_decision", ago: 2_460 }, { id: "review", role: "reviewer" },
  ]));
  kanbanPipelines.push(kanbanLane("k-paused", "Finish mobile traffic acceptance", ["t-data"], "paused", [{ id: "accept", state: "passed", ago: 5_400 }, { id: "review", role: "reviewer" }]));
  kanbanLinks.pipelines["k-decision"] = { links: [], noPr: true };
  const buildPath = kanbanConversation("GitHub Copilot as a third engine · build", "settled", 900);
  const critiquePath = kanbanConversation("GitHub Copilot as a third engine · critique", "settled", 720);
  kanbanPipelines.push(kanbanLane("k-review", "GitHub Copilot as a third engine the Viewer can launch", ["t-copilot"], "needs_review", [
    { id: "build", attempts: [
      { n: 1, state: "passed", startedAt: iso(4_000), completedAt: iso(3_000), agentPath: buildPath, conversationId: idOf(buildPath), activatedBy: null, effectiveRole: kanbanRole("builder"), verdict: { status: "pass", findings: [] } },
      { n: 2, state: "passed", startedAt: iso(1_600), completedAt: iso(900), agentPath: buildPath, conversationId: idOf(buildPath), activatedBy: { stageId: "critique", attempt: 1, edge: "fail" }, effectiveRole: kanbanRole("builder"), verdict: { status: "pass", findings: [] } },
    ] },
    { id: "critique", role: "reviewer", onFail: { to: "build", maxRounds: 1 }, attempts: [
      { n: 1, state: "failed", startedAt: iso(2_800), completedAt: iso(2_000), agentPath: critiquePath, conversationId: idOf(critiquePath), activatedBy: null, effectiveRole: kanbanRole("reviewer"), verdict: { status: "fail", findings: ["one", "two"] } },
    ] },
  ], { reviewPending: { stageId: "critique", attempt: 1, fixStageId: "build", fixAttempt: 2, reviewedHead: "4be1c07a1d2e", currentHead: "9b2e7d4c5f60", verdict: "fail", findings: 2 } }));
  kanbanLinks.pipelines["k-review"] = prLinks(2031);
  kanbanPipelines.push(kanbanLane("k-favicon", "Restore /favicon.ico with the Delegatus emblem", ["t-favicon"], "running", [
    { id: "implement", state: "passed", ago: 900 }, { id: "review", state: "running", ago: 240, role: "reviewer" },
  ]));
  kanbanLinks.pipelines["k-favicon"] = prLinks(2070);
  kanbanPipelines.push(kanbanLane("k-kanban", "Phone kanban: a convenient board on mobile", ["t-kanban"], "running", [
    { id: "design", state: "passed", ago: 4_000 }, { id: "critique", state: "passed", ago: 2_000, role: "reviewer" }, { id: "revise", state: "running", ago: 1_080 },
  ]));
  kanbanLinks.pipelines["k-kanban"] = { links: [], noPr: true };
  kanbanPipelines.push(kanbanLane("k-upload", "Redesign attachment upload for large files", ["t-upload"], "running", [
    { id: "plan", state: "passed", ago: 6_000 }, { id: "build-api", state: "passed", ago: 4_000 }, { id: "review-api", state: "passed", ago: 2_000, role: "reviewer" },
    { id: "build-ui", state: "running", ago: 360 }, { id: "review-ui", role: "reviewer" }, { id: "verify" }, { id: "docs" }, { id: "merge" },
  ]));
  kanbanLinks.pipelines["k-upload"] = prLinks(2201);
  kanbanPipelines.push(kanbanLane("k-skeletons", "Skeletons and state transitions on phone and desktop", ["t-skeletons"], "running", [
    { id: "design", state: "passed", ago: 3_000 }, { id: "verify-the-phone-board-at-both-widths-in-uk", state: "running", ago: 1_265 },
  ]));
  kanbanPipelines.push(kanbanLane("k-chips", "PR and issue chips on pipelines and task cards", ["t-chips"], "completed", [
    { id: "implement", state: "passed", ago: 2_400 }, { id: "review", state: "passed", ago: 1_200, role: "reviewer" },
  ]));
  kanbanLinks.pipelines["k-chips"] = prLinks(2068, "merged");
  kanbanPipelines.push(kanbanLane("k-seat", "Seat wakes after its own deploy and keeps its mandate", ["t-seat"], "completed", [
    { id: "implement", state: "passed", ago: 7_200 }, { id: "review", state: "passed", ago: 5_400, role: "reviewer" },
  ]));
  kanbanLinks.pipelines["k-seat"] = prLinks(2044, "merged");
  const longWorker = kanbanConversation("Pick the row state as the one authority", "working", 780);
  const longReader = kanbanConversation("Read every surface that counts agents", "settled", 3_000);
  const ukWorker = kanbanConversation("Перевірити опитування мобільної дошки", "working", 420);
  kanbanTasks.push(
    kanbanTask("t-data", "assigned", "Mobile data: stop repeated full-board downloads and hidden-tab traffic"),
    kanbanTask("t-copilot", "assigned", "GitHub Copilot as a third engine the Viewer can launch"),
    kanbanTask("t-favicon", "assigned", "Restore /favicon.ico with the Delegatus emblem"),
    kanbanTask("t-kanban", "assigned", "Phone kanban: a convenient board on mobile, merged with today's phone view"),
    kanbanTask("t-upload", "assigned", "Redesign attachment upload for large files"),
    kanbanTask("t-skeletons", "assigned", "Skeletons and state transitions on phone and desktop"),
    kanbanTask("t-long", "assigned", LONG_TITLE, { assignments: [kanbanAssign(longWorker), kanbanAssign(longReader)] }),
    kanbanTask("t-uk", "assigned", "Перевірити, що мобільна дошка не завантажує весь проєкт при кожному опитуванні", { assignments: [kanbanAssign(ukWorker)], color: "teal" }),
    kanbanTask("t-chips", "assigned", "PR and issue chips on pipelines and task cards"),
    kanbanTask("t-seat", "assigned", "Seat wakes after its own deploy and keeps its mandate"),
  );
  /* Inbox */
  const asker = kanbanConversation("Retire the systemd install path", "asking", 540, { model: "claude-opus-5-5" });
  kanbanTasks.push(
    kanbanTask("t-systemd", "inbox", "Retire the systemd install path", { assignments: [kanbanAssign(asker)] }),
    kanbanTask("t-quota", "inbox", "Spend quota before its window resets", { updatedAt: iso(2 * 86_400) }),
    kanbanTask("t-attention", "inbox", "request_attention: the target blinks, intent open opens the conversation (#1696)", { updatedAt: iso(86_400) }),
    kanbanTask("t-tray", "inbox", "Hide the Hidden tray when it holds nothing", { color: "amber", updatedAt: iso(5 * 3_600) }),
  );
  kanbanConversation("Audit the release notes for dead anchors", "stalled", 2_220);
  kanbanConversation("Measure the board's memory on a 390 px phone", "stalled", 2_230);
  kanbanConversation("Draft the Copilot engine login flow", "stalled", 2_280);
  kanbanConversation("Rename the MCP key in the setup docs", "stalled", 2_290);
  kanbanPipelines.push(kanbanLane("k-flake", "Nightly: rerun the flake campaign on a quiet machine", [], "running", [
    { id: "measure", state: "running", ago: 1_500 }, { id: "report", role: "reviewer" },
  ]));
  /* Done: more than its window of twenty. */
  const doneTitles = [
    "The board only moves forward", "The jump strip takes its own room", "One pipeline block and one tone map", "Deploy gate reads the pinned runtime",
    "Queue drain on reconnect", "Archive TTL for closed lanes", "Catalog pages stay in snapshot order", "Voice utterances render once",
    "Held deliveries heal themselves", "Board zoom keeps the focused card", "Seat rotation keeps the mandate", "Stage verdict recovery after a host restart",
    "Fast conversation switching", "Reconnect note stays quiet", "Search lands on the message", "Composer keeps its draft across screens",
    "Accounts screen on the phone", "Host sheet names each PID", "Receipts carry their inverse", "Project sheet scrolls to the current project",
    "Hidden tray lists closed conversations", "Stage names are display names", "Review heads line on the card", "Findings ranked by severity",
    "Empty columns say where the work is",
  ];
  doneTitles.forEach((title, index) => {
    const path = kanbanConversation(title, "settled", 3_600 * (index + 2));
    kanbanTasks.push(kanbanTask(`t-done-${index}`, "done", title, { assignments: [kanbanAssign(path)], updatedAt: iso(3_600 * (index + 2)) }));
  });
  /* The live seat: the card above the tabs, never a card in a column. */
  kanbanConversation("Orchestrator", "settled", 300);
}
const SEAT_PATH = kanbanFiles.find((entry) => entry.title === "Orchestrator")?.path ?? null;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), location.origin);
  const method = (init?.method ?? "GET").toUpperCase();
  /* The phone's Move to and Hide (#2072 slice 4): the task store's guarded
     PATCH, applied to the fixture's own rows and recorded. */
  if (KANBAN && url.pathname.startsWith("/api/tasks/") && method === "PATCH") {
    const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    evidence.taskPatches.push({ id, body });
    const row = kanbanTasks.find((entry) => (entry as { id: string }).id === id) as Record<string, unknown> | undefined;
    if (!row) return json({ error: "task not found" }, 404);
    if (body.expectedRevision !== row.revision) return json({ error: "revision moved", code: "TASK_REVISION_CONFLICT" }, 409);
    if (typeof body.status === "string") row.status = body.status;
    if (body.hide === true) row.groupHidden = { at: new Date().toISOString(), by: "operator", admitted: { conversationIds: [], paths: [] } };
    if (body.hide === false) delete row.groupHidden;
    row.revision = `${String(row.revision).replace(/-\d+$/, "")}-${Number(String(row.revision).split("-").pop()) + 1}`;
    row.updatedAt = new Date().toISOString();
    return json({ task: row });
  }
  if (KANBAN && url.pathname === "/api/tasks" && method === "GET") return json({ tasks: kanbanTasks });
  if (url.pathname === "/api/files" && KANBAN) {
    return json({
      files: kanbanFiles, projectCatalog: [{ project: PROJECT, conversations: kanbanFiles.length }], flows: [], pipelines: kanbanPipelines,
      workflows: [], tasks: kanbanTasks, workLinks: kanbanLinks, systemHealth: { tmux: { status: "healthy" } },
    });
  }
  if (url.pathname === "/api/files") {
    return json({
      files, projectCatalog: [{ project: PROJECT, conversations: files.length }], flows, pipelines,
      workflows: [], tasks, systemHealth: { tmux: { status: "healthy" } },
    });
  }
  /* The fixture has no runtime plane, and says so the way a Viewer without one
     does. Left unanswered, the bus escalated to «Runtime degraded» part-way
     through a run, and the banner moved the list under a measured tap. */
  if (url.pathname === "/api/runtime/snapshot" && STRUCTURED) {
    return json({
      schemaVersion: 1, snapshotSeq: 1, retentionFloorSeq: 0, structuredHostsEnabled: true, runtime: { hostEpoch: 1, health: "ready" }, filesRevision: 1,
      sessions: [{
        conversationId: "conversation_running", sessionKey: { engine: "claude", sessionId: "running-session" }, hostKind: "claude-broker", host: "hosted",
        turn: queueRecovery ? "idle" : "running", provenance: "structured", revision: 1, attentionIds: [], recentReceipts: [], accountId: ACCOUNT,
        parentConversationId: null, flowId: null, workflowId: null, cwd: "/repo", artifactPath: RUNNING_PATH,
        capabilities: { steer: false, structuredAttention: true }, activeTurnId: queueRecovery ? null : "turn-1", pendingReconfigure: null,
      }],
      attentions: [], recentOperations: [], edges: [], flows: [], workflows: [], tasks: [], deployments: [],
    });
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
  if (url.pathname === "/api/conversations") {
    evidence.catalogRequests.push(url.search);
    const offset = Number(url.searchParams.get("cursor") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 20);
    return json({ items: catalog.slice(offset, offset + limit), total: 4_595, nextCursor: offset + limit < catalog.length ? String(offset + limit) : null });
  }
  if (url.pathname === "/api/orchestrator/seat") {
    // A lost optional read must never strand the composer's local wire fence.
    if (queueRecovery) return new Promise<Response>(() => {});
    if (KANBAN && SEAT_PATH) {
      return json({
        seat: {
          project: PROJECT, seatEpoch: 1, conversationId: idOf(SEAT_PATH), path: SEAT_PATH, mandate: "Run the atlas board.", state: "active", designatedAt: iso(86_400),
          intent: { clientRequestId: "seat-atlas-1", mode: "existing", launchId: null, error: null },
        },
        pending: null, exists: true,
      });
    }
    return json({ seat: null, pending: null, exists: true });
  }
  if (queueRecovery && url.pathname === "/api/runtime/send") {
    const body = JSON.parse(String(init?.body));
    const sends = JSON.parse(sessionStorage.getItem("evidence-queue-sends") ?? "[]");
    sends.push(body);
    sessionStorage.setItem("evidence-queue-sends", JSON.stringify(sends));
    return json({ receipt: {
      operationId: `operation-queue-recovery-${sends.length}`, idempotencyKey: body.idempotencyKey,
      conversationId: body.conversationId, kind: "send", status: "delivered",
      text: body.text, at: new Date().toISOString(), revision: 1,
    } });
  }
  /* The feed's poll transport (the fixture has no log stream). */
  if (url.pathname === "/api/logs" && method === "POST") {
    const asked = JSON.parse(String(init?.body ?? "{}")) as { reqs?: Array<{ id: string; path: string; offset: number }> };
    const chunks: Record<string, { offset: number; start: number; size: number; data: string }> = {};
    (asked.reqs ?? []).forEach((request, index) => {
      const body = request.path === RUNNING_PATH ? FEED : "";
      const from = Math.min(Math.max(request.offset, 0), body.length);
      chunks[String(index)] = { offset: body.length, start: from, size: body.length, data: body.slice(from) };
    });
    return json({ chunks });
  }
  /* Three invented Claude accounts: the one the running conversation is on,
     one ready to take the next message, one signed out. */
  if (url.pathname === "/api/accounts") {
    return json({
      claude: {
        active: activeAccount,
        accounts: [
          { id: ACCOUNT, label: ACCOUNT, kind: "managed", authPresent: true, authHealth: "authenticated", loginPending: false, loginState: "authenticated", deviceAuth: null },
          { id: NEXT_ACCOUNT, label: NEXT_ACCOUNT, kind: "managed", authPresent: true, authHealth: "authenticated", loginPending: false, loginState: "authenticated", deviceAuth: null },
          { id: "dormant", label: "dormant", kind: "managed", authPresent: false, authHealth: "signed_out", loginPending: false, loginState: "idle", deviceAuth: null },
        ],
        migration: null, autoBalance: null,
      },
      codex: { active: "", accounts: [], migration: null, autoBalance: null },
    });
  }
  if (url.pathname === "/api/accounts/claude/active" && method === "POST") {
    const body = JSON.parse(String(init?.body ?? "null")) as { id?: string; mode?: string } | null;
    evidence.accountSelects.push({ engine: "claude", body });
    /* The server answers every later read with the account that was picked. */
    if (body?.mode === "select" && typeof body.id === "string") activeAccount = body.id;
    return json({ ok: true });
  }
  if (url.pathname === "/api/tmux" && method === "POST") {
    evidence.runtimeRequests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return json(STRUCTURED ? { ok: true, structured: true } : { ok: true, outcome: "pending", operationId: "reconfigure-evidence" });
  }
  if (url.pathname.startsWith("/api/pipelines/") && method === "PATCH") {
    const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    const body = JSON.parse(String(init?.body)) as { action: string };
    evidence.pipelinePatches.push({ id, action: body.action });
    if (evidence.refuseNextPipelinePatch) {
      evidence.refuseNextPipelinePatch = false;
      await new Promise((resolve) => setTimeout(resolve, 500));
      return json({ error: "refused by the evidence fixture" }, 409);
    }
    const found = pipelines.find((pipeline) => pipeline.id === id);
    if (!found) return json({ error: "pipeline not found" }, 404);
    if (evidence.pipelineAnswerDelayMs) await new Promise((resolve) => setTimeout(resolve, evidence.pipelineAnswerDelayMs));
    /* The engine's own rule: a lane already hidden keeps its first Hide
       instant through a later dismiss, and undismiss clears it. */
    if (body.action === "dismiss") found.dismissedAt = found.dismissedAt ?? new Date().toISOString();
    if (body.action === "undismiss") found.dismissedAt = null;
    if (body.action === "dismiss" || body.action === "undismiss") evidence.hidesAnswered.push({ id, action: body.action, dismissedAt: found.dismissedAt ?? null });
    if (body.action === "close") {
      await new Promise((resolve) => setTimeout(resolve, CLOSE_ANSWER_MS));
      Object.assign(found, { state: "closed", closedAt: new Date().toISOString(), hiddenAt: new Date().toISOString() });
      evidence.closesAnswered.push(id);
    }
    return json({ ok: true, pipeline: found });
  }
  return json({}, 404);
}) as typeof fetch;

localStorage.setItem("llvProject", PROJECT);
if (!location.hash) location.hash = `#p=${PROJECT}`;
createRoot(document.getElementById("root")!).render(<Viewer />);
