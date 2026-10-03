import { ROLE_DEFAULTS } from "@/lib/roles/defaults";
import { orchestratorMandateForDelivery } from "@/lib/orchestrator/prompt";
import { messageTextDigest } from "@/lib/runtime/messageTextDigest";
/*
 * The page `issue1671Evidence.browser.test.tsx` drives: the real Viewer over an
 * invented phone board — ten lanes waiting on a decision, one running
 * conversation, thirty finished ones and a 46-entry stored catalog — answered
 * by an in-page fetch double. Board writes go through the product's own
 * reducer, and every write is recorded on `window.evidence`, so the driver
 * reads what a gesture really sent. All data is invented.
 */
import { createRoot } from "react-dom/client";

import { asksYouFixtureLines, asksYouFixtureSetting, reportLogFixturePage } from "@/components/orchestrator/reportLog/reportLogEvidence.fixture";
import { writeProfile } from "@/components/runtimeProfile";
import { Viewer } from "@/components/Viewer";
import { getRuntimeBus } from "@/hooks/runtimeBus";
import { applyBoardMutations, type BoardMutationV1 } from "@/lib/board/mutations";
import type { Pipeline } from "@/lib/pipelines/types";
import { deliveryDedupToken } from "@/lib/runtime/deliveryDedup";
import { RUNTIME_PLANE_ABSENT } from "@/lib/runtime/flags";
import type { FileEntry } from "@/lib/types";
import type { BoardProjectStateV1 } from "@/lib/view/types";

/* `?synced=1` (docs/design/synced-task-card.md §8): the kanban scene's project is a linked one
   (a repository key), and four of its tasks run on the linked stage install. The driver serves
   `/api/links/agents` with this install's id, the host and the lanes the stage publishes. */
const SYNCED = new URLSearchParams(location.search).has("synced");
const PROJECT = SYNCED ? `repo-${"a".repeat(32)}` : "atlas";
const STAGE_INSTALL = ["22222222", "2222", "4222", "8222", "222222222222"].join("-");
const SELF_UPDATE_RELOAD = new URLSearchParams(location.search).has("self-update-reload");
let presenceAnswers = 0;
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
/* `?seatnoise=<i..v>` (docs/design/seat-panel-noise.md): the running conversation is an orchestrator seat, on a
   structured host, in the state the case names; the driver opens it in the focus view. */
const SEAT_NOISE = new URLSearchParams(location.search).get("seatnoise");
/* Composer context mode (docs/design/composer-context-mode.md, `?context-mode=1`): the running conversation is a
   Codex conversation on a structured host that can inject. `noinject` serves the same session without the
   capability. The driver flips the turn and publishes receipts through `evidence`. */
const CONTEXT_MODE = new URLSearchParams(location.search).get("context-mode");
/* `?firstmessage=<p|s|f>`: a new conversation's first message from the first paint to the transcript. p is a plain
   spawn's prompt and f a failed launch (the running conversation, opened in the focus view); s is a seat created from
   the sheet's draft with Confirm actually pressed (`&kanban=1&seatless=donly`). */
const FIRST_MESSAGE = new URLSearchParams(location.search).get("firstmessage");
const RUNTIME_PERF = new URLSearchParams(location.search).get("runtime") === "perf";
const STRUCTURED = RUNTIME_PERF || new URLSearchParams(location.search).get("runtime") === "structured" || SEAT_NOISE !== null || CONTEXT_MODE !== null || FIRST_MESSAGE !== null;
const NEXT_ACCOUNT = new URLSearchParams(location.search).get("next") || "relief";

/* With the deck asked for (#1795 below), the running conversation is the round
   under review, and says so the way a reviewer transcript does. */
const deckRequested = new URLSearchParams(location.search).has("deck");
const reviewerLineage = deckRequested
  ? { durableLineage: { kind: "review", role: "reviewer", parentConversationId: "conversation_done-0", reviewsConversationId: "conversation_done-0", memberships: [] } }
  : {};
const AGENT_LABEL = new URLSearchParams(location.search).has("agent-label");
/* `?chrome=<n>`: the phone conversation with `n` background shell tasks behind its ⋯ menu and, unless `nopin`,
   a pinned message (a board task assigned to it). Used with `seatnoise=ii&runtime=structured` for the seat's
   report button. */
const CHROME_PARAM = new URLSearchParams(location.search).get("chrome");
const CHROME = CHROME_PARAM === null ? null : Number(CHROME_PARAM);
const CHROME_PIN = CHROME !== null && !new URLSearchParams(location.search).has("nopin");

const files: FileEntry[] = [
  conversation(RUNNING_PATH, AGENT_LABEL ? "Orchestrator" : "Rebuild the board status projection", {
    activity: "live", proc: "running", pid: 4_401, mtime: now - 20,
    /* A real launch model, not a one-word one: the bar line has to hold
       `fable-5-1 · high` beside the state phrase and the account (#1795). */
    model: "fable-5-1", effort: "high",
    ...reviewerLineage,
    lastTurn: { startedAt: (now - 400) * 1_000, endedAt: null },
    /* `?launch=1`: the running conversation waits on an answer, so the focus
       view's own fallback (the most attention-worthy node) picks it over a
       freshly launched agent, the way a real operator's open question does. */
    ...(new URLSearchParams(location.search).has("launch") ? {
      pendingQuestion: {
        kind: "question", toolUseId: "toolu-launch-previous", transcriptPath: RUNNING_PATH, pid: 4_401, paneTarget: null, askedAt: iso(300),
        questions: [{ question: "Which format?", header: "Format", multiSelect: false, options: [] }],
      },
    } : {}),
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

if (CHROME !== null && CHROME > 0) {
  const CHROME_COMMANDS = ["gh run watch 18234519922 --exit-status", "bun test src/components/mobile/MobileChromeSheets.dom.test.tsx", "bun scripts/verify-runtime-host.ts --runtime /usr/local/bin/bun-1.4.0-candidate"];
  for (let index = 0; index < CHROME; index++) {
    const id = ["bbto8z3y0", "b4xq0m2lk7ns", "b9fz1rkp3w", "bk2m8q1d4x", "bq7v5n0c9z", "bw3j6t2h8y", "bz1a4s7e5u", "bd8f2g9k6m"][index % 8]!;
    files.push({
      path: `/tmp/claude-1000/atlas/session/tasks/${id}.output`, root: "claude-tasks", name: `${id}.output`, project: PROJECT,
      title: `Background task ${id}`, engine: "shell", kind: "bash", fmt: "text", parent: RUNNING_PATH,
      mtime: now - 40 - index * 95, size: 2_048, activity: "live", proc: "running", pid: 2_145_666 + index * 436,
      cmd: CHROME_COMMANDS[index % 3]!, cmdDesc: ["Watch the CI run", "Run the touched test file", "Rehearse the runtime host"][index % 3]!,
      pendingQuestion: null, waitingInput: null, conversationId: null,
    } as unknown as FileEntry);
  }
}
/* The launch facts are what the board's projection hands the pane: a launch the runtime is still recovering
   carries no reason, a stopped one carries it with `recoveryStopped`. The raw recovery envelope rides in
   `error` on the pending case on purpose: the chip must not print it whatever the projection did. */
const SEAT_MANDATE = "Keep the project moving. Read the board before every decision, keep every lane owned, and report what changed.";
const SEAT_LAUNCH_ID = "launch-seat-noise";
const SEAT_ENVELOPE = `structured launch recovery: ${JSON.stringify({ phase: "uncertain", startedAt: 1, checks: 2, nextTryAt: 2, reason: "the host has not answered yet" })}`;
function seatOn(engine: "claude" | "codex", model: string, effort: string, tag: string) {
  Object.assign(files[0]!, {
    engine, fmt: engine, root: engine === "codex" ? "codex-sessions" : "claude-projects", model, effort,
    conversationId: tag === "" ? "conversation_running" : `conversation_seat_${tag}`,
    path: tag === "" ? RUNNING_PATH : `/repo/seat-${tag}.jsonl`, name: tag === "" ? "running.jsonl" : `seat-${tag}.jsonl`,
    spawn: undefined, activityReason: undefined, size: 2_048,
  });
}
if (SEAT_NOISE !== null) {
  const launchWindow = (facts: Record<string, unknown>) => Object.assign(files[0]!, {
    path: `spawn:${SEAT_LAUNCH_ID}`, name: `spawn:${SEAT_LAUNCH_ID}`, size: 0, activityReason: "structured_spawn_reconciling",
    spawn: {
      launchId: SEAT_LAUNCH_ID, clientAttemptId: null, accountId: null, conversationId: "conversation_running", generation: 1,
      state: "reconciling", initialMessage: "queued", retrySafe: false, error: null,
      admittedAt: (now - 90) * 1_000, promptAt: (now - 90) * 1_000, promptImages: 0,
      mandate: { kind: "version", version: 1 }, prompt: SEAT_MANDATE, ...facts,
    },
  });
  files[0]!.title = "Orchestrator";
  if (SEAT_NOISE === "i") { seatOn("claude", "opus", "high", ""); launchWindow({ error: SEAT_ENVELOPE }); }
  else if (SEAT_NOISE === "ii") seatOn("claude", "opus", "high", "");
  else if (SEAT_NOISE === "iii") { seatOn("claude", "opus", "high", ""); launchWindow({ state: "failed", initialMessage: "failed", retrySafe: true, recoveryStopped: true, error: "the host has not answered yet" }); }
  else if (SEAT_NOISE === "iv") seatOn("codex", "gpt-5.6-sol", "low", "iv-old");
  else if (SEAT_NOISE === "v") seatOn("codex", "gpt-5.6-sol", "high", "v");
}
/* The first-message cases. The raw recovery envelope rides in `error` on every pending step on purpose: the window
   must not print it. */
const FM_PROMPT = "Fix the failing export test. The pinned task is in the card.";
// A hand-over case deliberately delivers the reply before its provenance.
const FM_HANDOVER = new URLSearchParams(location.search).get("handover");
const FM_ENGINE = new URLSearchParams(location.search).get("engine") === "codex" ? "codex" : "claude";
let releaseFirstMessageEvidence: () => void = () => undefined;
const fmEvidenceGate = new Promise<void>((resolve) => { releaseFirstMessageEvidence = resolve; });
const FM_LAUNCH_ID = "launch-first-message";
const FM_SEAT = FIRST_MESSAGE === "s";
const FM_CONVERSATION_ID = FM_SEAT ? "conversation_first_message" : "conversation_running";
const FM_SEAT_PATH = "/repo/first-message.jsonl";
const fmText = () => (FM_SEAT ? SEAT_MANDATE : FM_PROMPT);
// Include the runtime role prefix; the DOM suite composes its resolved role.
const fmDeliveredText = () => FM_HANDOVER
  ? `${ROLE_DEFAULTS.find((role) => role.id === "orchestrator")!.promptScaffold}\n\n${orchestratorMandateForDelivery(fmText())}`
  : fmText();
/* `&step=<n>` opens the page on that state: the phone's focus view re-resolves the conversation when its path
   flips, so each state of the plain cases is a first paint of its own. */
const fm = { step: Number(new URLSearchParams(location.search).get("step") ?? 0), confirmed: false, posts: [] as Array<Record<string, unknown>> };
/** The window the first message lives in: the running conversation, or the seat the Confirm created. */
let fmTarget: FileEntry | null = FIRST_MESSAGE !== null && !FM_SEAT ? files[0]! : null;
function fmApply() {
  const target = fmTarget as unknown as Record<string, unknown>;
  const launch = (over: Record<string, unknown>) => ({
    launchId: FM_LAUNCH_ID, clientAttemptId: null, accountId: null, conversationId: FM_CONVERSATION_ID, generation: 1,
    state: "reconciling", initialMessage: "queued", retrySafe: false, error: SEAT_ENVELOPE,
    admittedAt: (now - 90) * 1_000, promptAt: (now - 90) * 1_000, promptImages: 0, prompt: fmText(), promptEcho: fmText(),
    ...(FM_SEAT ? { mandate: { kind: "version", version: 1 } } : {}), ...over,
  });
  const window_ = (facts: Record<string, unknown>) => Object.assign(target, {
    engine: FM_ENGINE, fmt: FM_ENGINE, root: FM_ENGINE === "codex" ? "codex-sessions" : "claude-projects", model: FM_ENGINE === "codex" ? "gpt-6.1" : "opus", effort: "high", conversationId: FM_CONVERSATION_ID,
    generation: 1, spawnOrigin: "viewer", launch: undefined,
    path: `spawn:${FM_LAUNCH_ID}`, name: `spawn:${FM_LAUNCH_ID}`, size: 0, activityReason: "structured_spawn_reconciling", spawn: facts,
  });
  /* The scanned row: the server's live-adoption signal is `launch`, the spawn placeholder is gone. */
  const adopted = (facts: Record<string, unknown> | undefined) => Object.assign(target, {
    path: FM_SEAT ? FM_SEAT_PATH : RUNNING_PATH, name: FM_SEAT ? "first-message.jsonl" : "running.jsonl", size: 2_048,
    activityReason: undefined, spawn: undefined, launch: facts,
    lastAssistantMessageAt: fm.step >= (FM_HANDOVER ? 2 : 3) ? (now - 20) * 1_000 : null,
    sessionStartedAt: iso(60), lastTurn: { startedAt: (now - 60) * 1_000, endedAt: null },
  });
  if (FIRST_MESSAGE === "f") {
    window_(launch({ state: "failed", initialMessage: "failed", retrySafe: true, error: "runtime host unavailable" }));
    return;
  }
  const retired = { prompt: undefined, promptAt: undefined, promptImages: undefined, mandate: undefined };
  if (fm.step === 0) window_(launch({}));
  else if (fm.step === 1) window_(launch({ state: "recovered", initialMessage: "delivered", deliveredAt: Date.now() }));
  else if (fm.step === 2 && FM_HANDOVER === "answered") adopted(undefined);
  else if (fm.step === 2) adopted(launch({ state: "recovered", initialMessage: "delivered", deliveredAt: Date.now(), ...retired }));
  else adopted(undefined);
}
/* A Claude seat's mandate is journaled the way the SDK delivers it: `promptSource: "sdk"` with an engine uuid. */
const FM_SEAT_UUID = "engine_message_seat_mandate";
function fmTranscript(): string {
  const user = JSON.stringify(FM_SEAT
    ? { type: "user", uuid: FM_SEAT_UUID, timestamp: iso(60), message: { role: "user", content: fmDeliveredText() }, promptSource: "sdk" }
    : { type: "user", timestamp: iso(60), message: { role: "user", content: fmDeliveredText() }, promptSource: "typed", origin: { kind: "human" } });
  const answer = JSON.stringify({ type: "assistant", timestamp: iso(20), message: { role: "assistant", content: [{ type: "text", text: "Looking at the export test." }] } });
  const codexUser = JSON.stringify({ timestamp: iso(60), type: "response_item", payload: { type: "message", id: FM_SEAT_UUID, role: "user", content: [{ type: "input_text", text: fmDeliveredText() }] } });
  const codexAnswer = JSON.stringify({ timestamp: iso(20), type: "response_item", payload: { type: "message", id: "seat_answer", role: "assistant", content: [{ type: "output_text", text: "Looking at the export test." }] } });
  return `${[FM_ENGINE === "codex" ? codexUser : user, ...(fm.step >= (FM_HANDOVER ? 2 : 3) ? [FM_ENGINE === "codex" ? codexAnswer : answer] : [])].join("\n")}\n`;
}
if (FIRST_MESSAGE !== null && !FM_SEAT) {
  files[0]!.title = "Builder";
  fmApply();
}
if (CONTEXT_MODE !== null) seatOn("codex", "gpt-5.6-sol", "high", "");
const SEAT_CODEX_FEED = `${[
  JSON.stringify({ type: "event_msg", timestamp: iso(480), payload: { type: "user_message", message: "Keep the search fix moving." } }),
  JSON.stringify({ type: "event_msg", timestamp: iso(120), payload: { type: "agent_message", message: "Search: the verifier passed on the second attempt. Nothing needs you." } }),
].join("\n")}\n`;
/* The injected record, once the driver lets it land: the structured-user marker carries the digest of the operation
   the inject answer named, which is what joins it to the composer's own row. */
function contextModeFeed(): string {
  const lines = evidence.injects.slice(0, evidence.injectsEchoed).map((body, index) => {
    const marker = `<!-- llv:structured-user dedup=${deliveryDedupToken(`operation-inject-${index + 1}`)} -->`;
    return JSON.stringify({ type: "event_msg", timestamp: iso(0), payload: { type: "user_message", message: `${marker}\n${String(body.text)}` } });
  });
  return lines.length === 0 ? SEAT_CODEX_FEED : `${SEAT_CODEX_FEED}${lines.join("\n")}\n`;
}
const SEAT_FEED = `${[
  JSON.stringify({ type: "user", timestamp: iso(480), message: { role: "user", content: "Keep the search fix moving." }, promptSource: "typed", origin: { kind: "human" } }),
  JSON.stringify({ type: "assistant", timestamp: iso(420), message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_seat_search", name: "ToolSearch", input: { query: "select:mcp__viewer__list_pipelines", max_results: 1 } }] } }),
  JSON.stringify({ type: "user", timestamp: iso(418), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_seat_search", content: "ok" }] } }),
  ...([
    ["toolu_seat_get_task", "mcp__viewer__get_task", { taskId: "3f6b1c2e-8d4a-4e75-cf10-5c7d2b9e0f41" }, 300],
    ["toolu_seat_update_task", "mcp__viewer__update_task", { taskId: "3f6b1c2e-8d4a-4e75-cf10-5c7d2b9e0f41", status: "assigned" }, 260],
    ["toolu_seat_shell", "Bash", { command: "ls -d /workspace/demo/projects/atlas-pipeline-9c1d2e3f && git -C /workspace/demo/projects/atlas-pipeline-9c1d2e3f status --short --branch", description: "Check the worktree" }, 220],
  ] as const).flatMap(([id, name, input, ago]) => [
    JSON.stringify({ type: "assistant", timestamp: iso(ago), message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } }),
    JSON.stringify({ type: "user", timestamp: iso(ago - 2), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } }),
  ]),
  JSON.stringify({ type: "assistant", timestamp: iso(120), message: { role: "assistant", content: [{ type: "text", text: "Search: the verifier passed on the second attempt. Nothing needs you." }] } }),
].join("\n")}\n`;
let snapshotReads = 0;
/* #2215 (`?permission=1`): a Claude conversation whose structured host holds
   the tool request the engine's safety check raises under bypassPermissions,
   with the command and the full decision_reason the fake CLI of the host
   tests sends (`src/lib/runtime/fixtures/fakeClaudePermissionCli.ts`, which
   reads the filesystem and so cannot load here). */
const PERMISSION_SCENE = new URLSearchParams(location.search).has("permission");
const PERMISSION_COMMAND = "rm -rf $R/home $R/*.json";
const PERMISSION_REASON = "Dangerous rm operation on possibly-empty variable path: $R/*.json in `rm -rf $R/home $R/*.json` (rewrite it as \"${R:?}\"/*.json or use a literal path)";
if (PERMISSION_SCENE) {
  files.unshift(conversation("/repo/scratch-reset.jsonl", "Clear the scratch tree before the rerun", {
    activity: "live", proc: "running", pid: 4_402, mtime: now - 180, model: "claude-opus-5-5", effort: "high",
    lastTurn: { startedAt: (now - 600) * 1_000, endedAt: null },
    pendingPermission: { id: "request-safety-1", tool: "Bash", command: PERMISSION_COMMAND, reason: PERMISSION_REASON, reasonType: "safetyCheck", since: iso(180) },
  }));
}
const catalog = Array.from({ length: 45 }, (_, i) => conversation(`/repo/history-${i}.jsonl`, `Stored conversation ${i + 1}`, { mtime: now - 90_000 - i * 3_600 }));
/* A superseded round only the stored catalog still lists, as the conversations
   route marks it (#1671): the board never shows it. */
catalog.splice(5, 0, conversation("/repo/superseded-round.jsonl", "Superseded review round", {
  mtime: now - 95_000,
  supersededBy: { conversationId: "conversation_history-5", path: "/repo/history-5.jsonl", at: iso(94_000), reason: "stage-retry" },
}));
/* #2166 (`?seatless=…`): a project before its orchestrator exists, and just
   after. `empty` is a project created a moment ago, with nothing stored;
   `loose` has conversations and no seat; `donly` has no seat and one finished
   task, so its Inbox is empty; `seatonly` is the board right after the seat
   was created, whose one conversation is the seat's. With the Overview
   (`&overview=1`), no project has a seat, so the Overview leads with its band. */
const SEATLESS = new URLSearchParams(location.search).get("seatless");
if (SEATLESS === "empty") catalog.length = 0;

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
  presenceReplies: 0,
  /* `?launch=1`: the spawn bodies the phone sent, and the switch that makes the scan carry the transcript. */
  spawns: [] as Array<Record<string, unknown>>,
  launchMaterialized: false,
  materializeLaunch() { evidence.launchMaterialized = true; },
  /* docs/design/needs-attention.md: every dismissal the phone sent, and the
     switch that makes the agent's request arrive. */
  dismissals: [] as Array<Record<string, unknown>>,
  noticeOn: false,
  catalogRequests: [] as string[],
  /* Every reconfigure the runtime pill sends, so a re-tap of the tier the
     conversation already runs on can be shown to send nothing (#1795). */
  runtimeRequests: [] as Array<Record<string, unknown>>,
  /* Every chat save the Telegram bot panel sent. */
  botPosts: [] as Array<Record<string, unknown>>,
  reportWrites: [] as Array<Record<string, unknown>>,
  /* Every account select, the one path that moves the next message. */
  accountSelects: [] as Array<{ engine: string; body: unknown }>,
  pipelinePatches: [] as Array<{ id: string; action: string; taskId?: string; finishes?: boolean }>,
  closesAnswered: [] as string[],
  hidesAnswered: [] as Array<{ id: string; action: string; dismissedAt: string | null }>,
  boardMutations: [] as BoardMutationV1[],
  /* Case iv: the Codex seat's operator-chosen profile is stored, then the seat rotates to a Claude seat launched opus/high.
     The runtime stream is silent here, so the rotation asks the bus for the snapshot that carries the new seat's session. */
  storeSeatProfile() { writeProfile(files[0]!, { model: "gpt-5.6", effort: "low" }); },
  rotateSeat() { seatOn("claude", "opus", "high", "iv-new"); return getRuntimeBus().refresh(); },
  /* The first-message cases: move the same window Pending -> Delivered -> Transcript arrived -> Answered. */
  releaseFirstMessageEvidence,
  advanceFirstMessage() {
    fm.step += 1;
    fmApply();
    window.dispatchEvent(new Event("llv:files-changed"));
    return fm.step;
  },
  refuseNextPipelinePatch: false,
  /* Composer context mode: the turn the runtime reports, every inject and send the composer posted, the receipts the
     driver publishes for injections, and the switch that appends the injected record to the transcript. */
  contextTurn: "idle" as "idle" | "running",
  injects: [] as Array<Record<string, unknown>>,
  sends: [] as Array<Record<string, unknown>>,
  contextReceipts: [] as Array<Record<string, unknown>>,
  injectsEchoed: 0,
  echoInjects() { evidence.injectsEchoed = evidence.injects.length; },
  setContextTurn(turn: "idle" | "running") { evidence.contextTurn = turn; return getRuntimeBus().refresh(); },
  publishContextReceipt(status: string, reason?: string) {
    const body = evidence.injects.at(-1);
    if (!body) return Promise.resolve();
    evidence.contextReceipts = [{
      operationId: `operation-inject-${evidence.injects.length}`, idempotencyKey: body.idempotencyKey, conversationId: body.conversationId,
      kind: "inject", status, ...(reason ? { reason } : {}), at: new Date().toISOString(), revision: evidence.contextReceipts.length + 2,
    }];
    return getRuntimeBus().refresh();
  },
  /* Every task PATCH the phone's columns sent (#2072 slice 4). */
  taskPatches: [] as Array<{ id: string; body: Record<string, unknown> }>,
  /* Every Allow once / Deny a Needs-you row sent (#2215). */
  permissionAnswers: [] as Array<Record<string, unknown>>,
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
const NativeEventSource = window.EventSource;
Object.assign(window, { EventSource: RUNTIME_PERF ? class extends QuietEventSource {
  constructor(url: string) {
    super();
    if (new URL(url, location.origin).pathname === "/api/runtime/stream") return new NativeEventSource(url) as unknown as QuietEventSource;
  }
} : QuietEventSource });

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
const FAST_TTS = new URLSearchParams(location.search).has("fast-tts");
const FAST_TTS_FEED = JSON.stringify({ type: "assistant", timestamp: iso(10), message: { role: "assistant", content: [{ type: "text", text: "The first sentence should start speaking immediately. The next sentences should arrive while the first one plays. A single tap in the conversation header starts reading the answer. A second tap stops the voice immediately. Starting another answer cancels the previous read. Highlighting follows the sentence that is being spoken." }] } }) + "\n";
const FEED = FAST_TTS ? FAST_TTS_FEED : TOOLCARD ? `${BANDS}${TOOL_RUN}\n` : BANDS;
const CHROME_PINNED_TASK = {
  id: "task-pinned", project: PROJECT, status: "assigned", placement: "unplaced", board: "shown",
  text: "You are this project's orchestrator in Delegatus. Keep every lane owned, read the board before every decision, and report what changed to the operator in plain words. Never leave a lane without an owner.",
  assignments: [{ path: RUNNING_PATH, conversationId: "conversation_running", panePid: null, state: "delivered", error: null, at: iso(1_800), engine: "claude" }],
  createdAt: iso(3_600), updatedAt: iso(1_800),
};
const tasks = CHROME_PIN ? [CHROME_PINNED_TASK] : TOOLCARD ? [{
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
/* #2098 (`?overview=1`): the same board seen from the Overview on the phone,
   its tasks, lanes and conversations spread over three projects, each with a
   display name the cards must show instead of its key. */
const OVERVIEW_SCENE = new URLSearchParams(location.search).has("overview");
/* docs/design/needs-attention.md (`?needs=1`): the kanban scene with one card
   for each reason that still asks, one someone cleared, a loose conversation
   at its account's limit, and the running conversation with a feed, which the
   driver opens before an agent's request arrives. `&notice=1` answers the
   phone's rows-only read with that request once the driver switches it on. */
const NEEDS_SCENE = new URLSearchParams(location.search).has("needs");
const NOTICE = new URLSearchParams(location.search).has("notice");
/* #2190 (`?icons=1`): the kanban scene with its task cards dressed the way an
   operator dresses them: coloured with a chosen icon, coloured with the icon
   the title suggests, uncoloured with an icon, and with no icon at all, both
   coloured and not, under titles long enough to wrap. */
const ICONS_SCENE = new URLSearchParams(location.search).has("icons");
/* "Asks you" (`?asks=1`, docs/research/attention-classifier.md §7): the kanban
   scene with the switch on, two agents that ended their turn asking the
   operator (one in English, one in Ukrainian) and their lines in the seat's
   report log. Every other scene answers the switch off. */
const ASKS_SCENE = new URLSearchParams(location.search).has("asks");
const asksSetting = { enabled: ASKS_SCENE };
const asksLines: Array<{ conversationId: string; path: string; role: string | null; title: string; gist: string; minutesAgo: number }> = [];
const STAGE_AGENT = new URLSearchParams(location.search).get("stage-agent");
/* `?launch=1`: the phone launches an agent from a draft. The spawn route answers a
   structured receipt, and the scan swaps the launch window for the agent's
   transcript once the driver asks (`evidence.materializeLaunch()`). The running
   conversation stays live with a question pending, so it outranks the new agent,
   which is what the focus view's own fallback would pick. */
const LAUNCH_SCENE = new URLSearchParams(location.search).has("launch");
const LAUNCH_ID = "launch-focus-1";
const LAUNCH_CONVERSATION = "conversation_launched_agent";
const LAUNCH_PATH = "/repo/launched-agent.jsonl";
const KANBAN = new URLSearchParams(location.search).has("kanban") || OVERVIEW_SCENE || NEEDS_SCENE || ICONS_SCENE || ASKS_SCENE;
const kanbanFiles: FileEntry[] = [];
const kanbanLinks: { pipelines: Record<string, unknown>; tasks: Record<string, unknown> } = { pipelines: {}, tasks: {} };
/* A resolved role names its engine, as a stored one does. */
const kanbanRole = (roleId: string) => ({ roleId, engine: "claude", access: roleId === "reviewer" ? "read-only" : "read-write", promptScaffold: null });
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
interface KanbanStage { id: string; state?: "passed" | "running" | "failed" | "needs_decision"; ago?: number; role?: string; onFail?: { to: string; maxRounds: number; onExhausted?: string }; attempts?: unknown[] }
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
    /* Every stage carries a prompt, as a stored one does: the phone's stage
       settings (a stage not run yet) edit it (#2105's reload walk opens them). */
    stages: stages.map((spec, index) => ({ id: spec.id, kind: "run", prompt: "", effectiveRole: kanbanRole(spec.role ?? "builder"), next: stages[index + 1]?.id ?? null, ...(spec.onFail ? { onFail: spec.onFail } : {}) })),
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
  kanbanPipelines.push(kanbanLane("lane-decision", "Mobile data: stop repeated full-board downloads", ["t-data"], "needs_decision", [
    { id: "implement", state: "needs_decision", ago: 2_460 }, { id: "review", role: "reviewer" },
  ]));
  if (STAGE_AGENT) {
    const current = kanbanPipelines[0]!;
    const oldPath = kanbanConversation("Earlier design attempt", "settled", 3_600);
    const agentPath = current.runs[0]!.attempts[0]!.agentPath!;
    const state = STAGE_AGENT as "running" | "passed" | "failed" | "needs_decision";
    current.stages = [{ ...current.stages[0]!, id: "design", next: null }];
    current.state = state === "passed" ? "completed" : state === "running" ? "running" : "needs_decision";
    current.cursor = state === "passed" ? null : { stageId: "design", state: state === "running" ? "running" : "pending", input: null, activatedBy: null };
    current.runs = [{ stageId: "design", attempts: [
      { ...current.runs[0]!.attempts[0]!, n: 1, state: "failed", agentPath: oldPath, conversationId: idOf(oldPath) },
      { ...current.runs[0]!.attempts[0]!, n: 2, state, agentPath, conversationId: idOf(agentPath), verdict: { status: state === "failed" ? "fail" : state === "needs_decision" ? "needs_decision" : "pass", findings: [] },
        report: { seq: 1, at: iso(60), actor: { kind: "operator" }, calls: 1,
          verdict: { status: state === "needs_decision" ? "needs_decision" : state === "failed" ? "fail" : "pass", findings: [] },
          summary: ["Which layout should we use?", "Choose the compact layout or keep the expanded layout.", "Яке компонування обрати? Компактне чи розгорнуте?",
            ...Array.from({ length: 36 }, (_, index) => `Option ${index + 1}: explain the choice here.`),
            `/repo/${"unbroken-path-segment".repeat(8)}`, "End of the question. Кінець питання."].join("\n"), provenance: { head: null, branch: "fixture", uncommitted: [], pullRequest: null, outputs: [] } },
      },
    ] }];
  }
  kanbanPipelines.push(kanbanLane("lane-paused", "Finish mobile traffic acceptance", ["t-data"], "paused", [{ id: "accept", state: "passed", ago: 5_400 }, { id: "review", role: "reviewer" }]));
  kanbanLinks.pipelines["lane-decision"] = { links: [], noPr: true };
  const buildPath = kanbanConversation("GitHub Copilot as a third engine · build", "settled", 900);
  const critiquePath = kanbanConversation("GitHub Copilot as a third engine · critique", "settled", 720);
  kanbanPipelines.push(kanbanLane("lane-review", "GitHub Copilot as a third engine the Viewer can launch", ["t-copilot"], "needs_review", [
    { id: "build", attempts: [
      { n: 1, state: "passed", startedAt: iso(4_000), completedAt: iso(3_000), agentPath: buildPath, conversationId: idOf(buildPath), activatedBy: null, effectiveRole: kanbanRole("builder"), verdict: { status: "pass", findings: [] } },
      { n: 2, state: "passed", startedAt: iso(1_600), completedAt: iso(900), agentPath: buildPath, conversationId: idOf(buildPath), activatedBy: { stageId: "critique", attempt: 1, edge: "fail" }, effectiveRole: kanbanRole("builder"), verdict: { status: "pass", findings: [] } },
    ] },
    { id: "critique", role: "reviewer", onFail: { to: "build", maxRounds: 1 }, attempts: [
      { n: 1, state: "failed", startedAt: iso(2_800), completedAt: iso(2_000), agentPath: critiquePath, conversationId: idOf(critiquePath), activatedBy: null, effectiveRole: kanbanRole("reviewer"), verdict: { status: "fail", findings: ["one", "two"] } },
    ] },
  ], { reviewPending: { stageId: "critique", attempt: 1, fixStageId: "build", fixAttempt: 2, reviewedHead: "4be1c07a1d2e", currentHead: "9b2e7d4c5f60", verdict: "fail", findings: 2 } }));
  kanbanLinks.pipelines["lane-review"] = prLinks(2031);
  kanbanPipelines.push(kanbanLane("lane-favicon", "Restore /favicon.ico with the Delegatus emblem", ["t-favicon"], "running", [
    { id: "implement", state: "passed", ago: 900 }, { id: "review", state: "running", ago: 240, role: "reviewer" },
  ]));
  kanbanLinks.pipelines["lane-favicon"] = prLinks(2070);
  kanbanPipelines.push(kanbanLane("lane-kanban", "Phone kanban: a convenient board on mobile", ["t-kanban"], "running", [
    { id: "design", state: "passed", ago: 4_000 }, { id: "critique", state: "passed", ago: 2_000, role: "reviewer" }, { id: "revise", state: "running", ago: 1_080 },
  ]));
  kanbanLinks.pipelines["lane-kanban"] = { links: [], noPr: true };
  kanbanPipelines.push(kanbanLane("lane-upload", "Redesign attachment upload for large files", ["t-upload"], "running", [
    { id: "plan", state: "passed", ago: 6_000 }, { id: "build-api", state: "passed", ago: 4_000 }, { id: "review-api", state: "passed", ago: 2_000, role: "reviewer" },
    { id: "build-ui", state: "running", ago: 360 }, { id: "review-ui", role: "reviewer" }, { id: "verify" }, { id: "docs" }, { id: "merge" },
  ]));
  kanbanLinks.pipelines["lane-upload"] = prLinks(2201);
  kanbanPipelines.push(kanbanLane("lane-skeletons", "Skeletons and state transitions on phone and desktop", ["t-skeletons"], "running", [
    { id: "design", state: "passed", ago: 3_000 }, { id: "verify-the-phone-board-at-both-widths-in-uk", state: "running", ago: 1_265 },
  ]));
  kanbanPipelines.push(kanbanLane("lane-chips", "PR and issue chips on pipelines and task cards", ["t-chips"], "completed", [
    { id: "implement", state: "passed", ago: 2_400 }, { id: "review", state: "passed", ago: 1_200, role: "reviewer" },
  ]));
  kanbanLinks.pipelines["lane-chips"] = prLinks(2068, "merged");
  kanbanPipelines.push(kanbanLane("lane-seat", "Seat wakes after its own deploy and keeps its mandate", ["t-seat"], "completed", [
    { id: "implement", state: "passed", ago: 7_200 }, { id: "review", state: "passed", ago: 5_400, role: "reviewer" },
  ]));
  kanbanLinks.pipelines["lane-seat"] = prLinks(2044, "merged");
  /* #2072 slice 5: one task with seven pipelines — a spent review budget, a
     review in its second round, a fired fail edge, one provisioning and three
     completed — the task screen's `task-many` frame. */
  const reviewBuild = kanbanConversation("Name every pipeline row by its first prompt line · build", "settled", 900);
  const reviewCritique = kanbanConversation("Name every pipeline row by its first prompt line · critique", "settled", 720);
  kanbanPipelines.push(kanbanLane("lane-many-review", "Name every pipeline row by its first prompt line", ["t-many"], "needs_review", [
    { id: "build", attempts: [
      { n: 1, state: "passed", startedAt: iso(4_000), completedAt: iso(3_000), agentPath: reviewBuild, conversationId: idOf(reviewBuild), activatedBy: null, effectiveRole: kanbanRole("builder"), verdict: { status: "pass", findings: [] } },
      { n: 2, state: "passed", startedAt: iso(1_600), completedAt: iso(900), agentPath: reviewBuild, conversationId: idOf(reviewBuild), activatedBy: { stageId: "critique", attempt: 1, edge: "fail" }, effectiveRole: kanbanRole("builder"), verdict: { status: "pass", findings: [] } },
    ] },
    { id: "critique", role: "reviewer", onFail: { to: "build", maxRounds: 1 }, attempts: [
      { n: 1, state: "failed", startedAt: iso(2_800), completedAt: iso(2_000), agentPath: reviewCritique, conversationId: idOf(reviewCritique), activatedBy: null, effectiveRole: kanbanRole("reviewer"), verdict: { status: "fail", findings: ["one", "two"] } },
    ] },
  ], { reviewPending: { stageId: "critique", attempt: 1, fixStageId: "build", fixAttempt: 2, reviewedHead: "4f1c2a9d7e3b", currentHead: "9b2e7d4c5f60", verdict: "fail", findings: 2 } }));
  kanbanLinks.pipelines["lane-many-review"] = prLinks(2201);
  kanbanPipelines.push(kanbanLane("lane-many-drawer", "Remove the legacy drawer", ["t-many"], "running", [
    { id: "implement", state: "passed", ago: 1_800 }, { id: "review", state: "running", ago: 420, role: "reviewer" },
  ]));
  kanbanLinks.pipelines["lane-many-drawer"] = prLinks(2195);
  const foldImplement = kanbanConversation("Fold the completed pipelines of a task · implement", "working", 180);
  const foldVerify = kanbanConversation("Fold the completed pipelines of a task · verify", "settled", 600);
  kanbanPipelines.push(kanbanLane("lane-many-fold", "Fold the completed pipelines of a task", ["t-many"], "running", [
    { id: "implement", attempts: [
      { n: 1, state: "passed", startedAt: iso(2_400), completedAt: iso(1_500), agentPath: foldImplement, conversationId: idOf(foldImplement), activatedBy: null, effectiveRole: kanbanRole("builder"), verdict: { status: "pass", findings: [] } },
      { n: 2, state: "running", startedAt: iso(180), completedAt: null, agentPath: foldImplement, conversationId: idOf(foldImplement), activatedBy: { stageId: "verify", attempt: 1, edge: "fail" }, effectiveRole: kanbanRole("builder"), verdict: null },
    ] },
    { id: "verify", role: "reviewer", onFail: { to: "implement", maxRounds: 2 }, attempts: [
      { n: 1, state: "failed", startedAt: iso(1_400), completedAt: iso(600), agentPath: foldVerify, conversationId: idOf(foldVerify), activatedBy: null, effectiveRole: kanbanRole("reviewer"), verdict: { status: "fail", findings: ["The fold hides a lane that still runs."] } },
    ] },
  ], { cursor: { stageId: "implement", state: "running", input: null, activatedBy: { stageId: "verify", attempt: 1, edge: "fail" } } }));
  kanbanLinks.pipelines["lane-many-fold"] = prLinks(2188);
  kanbanPipelines.push(kanbanLane("lane-many-pill", "Take the floating waiting pill out of the feed", ["t-many"], "provisioning", [{ id: "critique" }, { id: "fix" }]));
  kanbanLinks.pipelines["lane-many-pill"] = { links: [], noPr: true };
  ([["lane-many-done-1", "Name the stage a conversation runs in its bar", 2170, 3_600], ["lane-many-done-2", "Count every lane of a task once", 2150, 7_200], ["lane-many-done-3", "Say which lane a finding belongs to", 2140, 10_800]] as const).forEach(([id, title, number, ago]) => {
    kanbanPipelines.push(kanbanLane(id, title, ["t-many"], "completed", [{ id: "implement", state: "passed", ago: ago + 1_200 }, { id: "review", state: "passed", ago, role: "reviewer" }]));
    kanbanLinks.pipelines[id] = prLinks(number, "merged");
  });
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
    kanbanTask("t-many", "assigned", "Kanban: say what each pipeline of a task does\nA task with several lanes names each one by its first prompt line, and the finished ones fold behind their PRs.", { details: "Agent context: the lane titles come from pipelineTitle; the fold is the task screen's." }),
  );
  /* Inbox */
  const asker = kanbanConversation("Retire the systemd install path", "asking", 540, { model: "claude-opus-5-5" });
  kanbanTasks.push(
    kanbanTask("t-systemd", "inbox", "Retire the systemd install path", { assignments: [kanbanAssign(asker)] }),
    kanbanTask("t-quota", "inbox", "Spend quota before its window resets", { updatedAt: iso(2 * 86_400) }),
    kanbanTask("t-attention", "inbox", "request_attention: the target blinks, intent open opens the conversation (#1696)", { updatedAt: iso(86_400) }),
    kanbanTask("t-tray", "inbox", "Hide the Hidden tray when it holds nothing", { color: "amber", updatedAt: iso(5 * 3_600) }),
  );
  if (SYNCED) {
    const uk = localStorage.getItem("llv_lang") === "uk";
    const L = (en: string, ua: string) => (uk ? ua : en);
    kanbanTasks.push(
      kanbanTask("t-rem-run", "assigned", L("Ship the synced task card\nShow the other machine's stages on the card and mark it as managed there.", "Випустити картку синхронізованої задачі\nПоказати етапи з іншої машини на картці й позначити, що нею керують там."), { machine: STAGE_INSTALL, updatedAt: iso(360) }),
      kanbanTask("t-rem-wait", "assigned", L("Answer the deploy question on the stage box", "Відповісти на питання про розгортання на стенді"), { machine: STAGE_INSTALL, updatedAt: iso(840) }),
      kanbanTask("t-rem-old", "assigned", L("A task from a peer that predates lane rows", "Задача від вузла, що ще не знає про рядки етапів"), { machine: STAGE_INSTALL, updatedAt: iso(1_860) }),
      kanbanTask("t-rem-done", "done", L("Publish the linked boards guide", "Опублікувати посібник зі зв’язаних дошок"), { machine: STAGE_INSTALL, updatedAt: iso(3 * 3_600) }),
    );
  }
  if (ASKS_SCENE) {
    const asked = (title: string, role: string, gist: string, minutesAgo: number) => {
      const path = kanbanConversation(title, "settled", minutesAgo * 60);
      const messageAt = (now - minutesAgo * 60) * 1_000;
      const conversationId = idOf(path);
      Object.assign(kanbanFiles.find((entry) => entry.path === path)!, {
        activity: "recent", proc: "running",
        lastTurn: { startedAt: messageAt - 14 * 60_000, endedAt: messageAt },
        lastAssistantMessageAt: messageAt,
        operatorAsk: { id: `ask:${conversationId}:fixture`, messageAt, gist },
        durableLineage: { kind: "spawn", role, parentConversationId: null, reviewsConversationId: null, memberships: [] },
      });
      asksLines.push({ conversationId, path, role, title, gist, minutesAgo });
      return path;
    };
    const cache = asked("Choose the cache eviction policy", "builder", "Evict by size or by age? Say which and I finish the migration.", 4);
    const logs = asked("Скоротити зберігання логів на стейджі", "architect", "Лишити 14 днів логів чи 30? Скажіть, і я допишу міграцію.", 38);
    kanbanTasks.push(
      kanbanTask("t-cache", "assigned", "Choose the cache eviction policy", { assignments: [kanbanAssign(cache)] }),
      kanbanTask("t-logs", "assigned", "Скоротити зберігання логів на стейджі", { assignments: [kanbanAssign(logs)] }),
    );
  }
  kanbanConversation("Audit the release notes for dead anchors", "stalled", 2_220);
  kanbanConversation("Measure the board's memory on a 390 px phone", "stalled", 2_230);
  kanbanConversation("Draft the Copilot engine login flow", "stalled", 2_280);
  kanbanConversation("Rename the MCP key in the setup docs", "stalled", 2_290);
  if (NEEDS_SCENE) {
    const reason = (title: string, over: Record<string, unknown>) => {
      const path = kanbanConversation(title, "working", 900);
      Object.assign(kanbanFiles.find((entry) => entry.path === path)!, over);
      return path;
    };
    const prompt = reason("Rotate the deploy key on the stage box", {
      waitingInput: { since: now - 420, screenTail: "Allow the write to ~/.ssh/config? ❯ 1. Yes", target: "stage:0.0", menu: null },
    });
    const owed = reason("Tell the reviewer the flake is fixed", {
      stuckDelivery: { since: iso(41 * 60), attempts: 2, state: "held" },
    });
    const cleared = reason("Pick the log retention for the stage box", {
      pendingQuestion: { kind: "question", toolUseId: "toolu-needs-cleared", transcriptPath: "", pid: 5_900, paneTarget: null, askedAt: iso(1_500),
        questions: [{ question: "Keep 14 days of logs or 30?", header: "Retention", multiSelect: false, options: [] }] },
      attentionDismissal: { at: iso(600), by: { kind: "manager", conversationId: "conversation_seat", role: "orchestrator" }, reasonId: "toolu-needs-cleared" },
    });
    kanbanTasks.push(
      kanbanTask("t-prompt", "assigned", "Rotate the deploy key on the stage box", { assignments: [kanbanAssign(prompt)] }),
      kanbanTask("t-owed", "assigned", "Tell the reviewer the flake is fixed", { assignments: [kanbanAssign(owed)] }),
      kanbanTask("t-cleared", "assigned", "Pick the log retention for the stage box", { assignments: [kanbanAssign(cleared)] }),
    );
    /* At its account's limit: it keeps its words and asks nothing. */
    const walled = kanbanConversation("Summarize the week's review findings", "working", 1_200);
    Object.assign(kanbanFiles.find((entry) => entry.path === walled)!, { rateLimit: { source: "account", accountId: "main", window: "session", resetAt: now + 40 * 60 } });
    /* The conversation the operator reads when the request arrives. */
    kanbanFiles.push({ ...files[0]! } as FileEntry);
  }
  /* #2187 §3.4 (`?review-stops=1`): one task per row of the table, each with
     one lane parked on a review, so the task screen's 44 px answers and the
     reason line above them are read at their longest, en and uk. */
  if (new URLSearchParams(location.search).has("review-stops")) {
    const uk = localStorage.getItem("llv_lang") === "uk";
    const L = (en: string, ua: string) => (uk ? ua : en);
    const reviewerRole = kanbanRole("reviewer");
    const pill = L("P2 — The Model pill cuts its name at 360 px when two accounts are on.", "P2 — Кнопка «Модель» обрізає назву на 360 px, коли увімкнено два акаунти.");
    const capture = L("P2 — capture --stage does not take the stage address from the project config.", "P2 — capture --stage не бере адресу стейджу з конфігу проєкту.");
    const run = (key: string, stageId: string, n: number, state: string, ago: number, over: Record<string, unknown> = {}) => {
      const path = kanbanConversation(`${key} · ${stageId} ${n}`, "settled", ago);
      return { n, state, startedAt: iso(ago + 600), completedAt: iso(ago), agentPath: path, conversationId: idOf(path), activatedBy: null,
        effectiveRole: stageId === "build" ? kanbanRole("builder") : reviewerRole, verdict: state === "passed" ? { status: "pass", findings: [] } : { status: "fail", findings: [over.finding ?? pill] }, ...over };
    };
    const head = (digit: string) => digit.repeat(40);
    const parkDetail = `fail-edge budget exhausted after 2 round(s) (onExhausted: park): ${capture}`;
    const onceDetail = `fail-edge budget exhausted after 1 round(s) (onExhausted: advance): ${pill}`;
    const lanes: Array<[string, string, Pipeline]> = [
      ["t-stop-fix", L("Composer model pills: one width at 390", "Кнопки моделі в композері однієї ширини"), kanbanLane("lane-stop-fix", "Composer model pills: one width at 390", ["t-stop-fix"], "needs_review", [
        { id: "build", attempts: [run("fix", "build", 1, "passed", 7_200), run("fix", "build", 2, "passed", 5_400, { activatedBy: { stageId: "review", attempt: 1, edge: "fail" } }), run("fix", "build", 3, "passed", 720, { activatedBy: { stageId: "review", attempt: 2, edge: "fail", budgetSpent: true } })] },
        { id: "review", role: "reviewer", onFail: { to: "build", maxRounds: 2, onExhausted: "stop-after-fix" }, attempts: [run("fix", "review", 1, "failed", 6_000), run("fix", "review", 2, "failed", 3_600, { budgetSpent: true, reviewedHead: head("4") })] },
      ], { lastPassedCommit: head("9"), reviewPending: { stageId: "review", attempt: 2, fixStageId: "build", fixAttempt: 3, reviewedHead: head("4"), currentHead: head("9"), verdict: "fail", findings: 1, at: iso(720) } })],
      ["t-stop-park", L("Per-feature screenshot catalog and one capture command", "Каталог скриншотів по фічах і одна команда зйомки"), kanbanLane("lane-stop-park", "Per-feature screenshot catalog and one capture command", ["t-stop-park"], "needs_decision", [
        { id: "build", attempts: [
          run("park", "build", 1, "passed", 9_000),
          run("park", "build", 2, "passed", 7_000, { activatedBy: { stageId: "review", attempt: 1, edge: "fail" } }),
          run("park", "build", 3, "passed", 5_000, { activatedBy: { stageId: "review", attempt: 2, edge: "fail" } }),
        ] },
        { id: "review", role: "reviewer", onFail: { to: "build", maxRounds: 2, onExhausted: "park" }, attempts: [
          run("park", "review", 1, "failed", 8_000, { finding: capture }), run("park", "review", 2, "failed", 6_000, { finding: capture }), run("park", "review", 3, "failed", 1_200, { finding: capture, error: parkDetail }),
        ] },
      ], { cursor: { stageId: "review", state: "running", input: null, activatedBy: null }, stateDetail: parkDetail })],
      ["t-stop-once", L("Deploy failure notifies the seat and the phone", "Сповіщення, коли деплой падає"), kanbanLane("lane-stop-once", "Deploy failure notifies the seat and the phone", ["t-stop-once"], "needs_decision", [
        { id: "build", attempts: [run("once", "build", 1, "passed", 9_000), run("once", "build", 2, "passed", 7_000, { activatedBy: { stageId: "review", attempt: 1, edge: "fail", budgetSpent: true } }), run("once", "build", 3, "passed", 4_000, { activatedBy: { stageId: "verify", attempt: 1, edge: "fail" } })] },
        { id: "review", role: "reviewer", onFail: { to: "build", maxRounds: 1 }, attempts: [run("once", "review", 1, "failed", 8_000, { budgetSpent: true }), run("once", "review", 2, "failed", 1_500, { error: onceDetail })] },
        { id: "verify", onFail: { to: "build", maxRounds: 1 }, attempts: [run("once", "verify", 1, "failed", 5_000)] },
      ], { cursor: { stageId: "review", state: "running", input: null, activatedBy: null }, stateDetail: onceDetail })],
      ["t-stop-legacy", L("Screenshot catalog: one capture command for every feature", "Каталог скриншотів: одна команда зйомки для кожної фічі"), kanbanLane("lane-stop-legacy", "Screenshot catalog: one capture command for every feature", ["t-stop-legacy"], "needs_decision", [
        { id: "build", attempts: [run("legacy", "build", 1, "passed", 9_000)] },
        { id: "review", role: "reviewer", attempts: [run("legacy", "review", 1, "failed", 900, { verdict: { status: "fail", findings: ["round limit reached", capture] }, error: "review loop ended in needs_decision: round limit reached" })] },
      ], { cursor: { stageId: "review", state: "reviewing", input: null, activatedBy: null }, stateDetail: "review loop ended in needs_decision: round limit reached" })],
    ];
    for (const [taskId, title, lane] of lanes) {
      /* The legacy lane's review is the older flow-backed kind. */
      if (taskId === "t-stop-legacy") lane.stages[1] = { ...lane.stages[1]!, kind: "review-loop" };
      kanbanPipelines.push(lane);
      kanbanLinks.pipelines[lane.id] = { links: [], noPr: true };
      kanbanTasks.push(kanbanTask(taskId, "assigned", title, { updatedAt: iso(300) }));
    }
  }
  /* The narrow card's stage chain (`?stage-chain=1`, docs/design/narrow-card-stage-chain.md):
     finished lanes, whose task screen draws the chain at 390 px — the lane is
     about 342 px, so it reads vertically. One lane is the operator's: Build,
     Review fired once of three, the branch Review fix. The other has a stage
     after its reviewer, so the rail passes beside the branch. */
  if (new URLSearchParams(location.search).has("stage-chain")) {
    const uk = localStorage.getItem("llv_lang") === "uk";
    const L = (en: string, ua: string) => (uk ? ua : en);
    const run = (key: string, stageId: string, n: number, state: string, ago: number, over: Record<string, unknown> = {}) => {
      const path = kanbanConversation(`${key} · ${stageId} ${n}`, "settled", ago);
      return { n, state, startedAt: iso(ago + 600), completedAt: iso(ago), agentPath: path, conversationId: idOf(path), activatedBy: null,
        effectiveRole: stageId === "build" || stageId.endsWith("-fix") ? kanbanRole("builder") : kanbanRole("reviewer"),
        verdict: state === "passed" ? { status: "pass", findings: [] } : { status: "fail", findings: ["P2 — the count hides behind the chip."] }, ...over };
    };
    const via = (stageId: string, edge: "pass" | "fail") => ({ activatedBy: { stageId, attempt: 1, edge } });
    const fix = kanbanLane("lane-chain-fix", L("Keep the review fix on the card", "Залишити виправлення рев’ю на картці"), ["t-chain-fix"], "completed", [
      { id: "build", attempts: [run("fix", "build", 1, "passed", 7_200)] },
      { id: "review", role: "reviewer", onFail: { to: "review-fix", maxRounds: 3 }, attempts: [run("fix", "review", 1, "failed", 6_000, via("build", "pass"))] },
      { id: "review-fix", attempts: [run("fix", "review-fix", 1, "passed", 5_000, via("review", "fail"))] },
    ]);
    fix.stages[1] = { ...fix.stages[1]!, next: null };
    const through = kanbanLane("lane-chain-through", L("Critique, then review, with a fix between", "Критика, потім рев’ю, з виправленням між ними"), ["t-chain-through"], "completed", [
      { id: "build", attempts: [run("through", "build", 1, "passed", 9_000)] },
      { id: "critique", role: "architect", onFail: { to: "critique-fix", maxRounds: 2 }, attempts: [run("through", "critique", 1, "failed", 7_000, via("build", "pass")), run("through", "critique", 2, "passed", 4_000, via("critique-fix", "pass"))] },
      { id: "critique-fix", attempts: [run("through", "critique-fix", 1, "passed", 5_500, via("critique", "fail"))] },
      { id: "review", role: "reviewer", attempts: [run("through", "review", 1, "passed", 3_000, via("critique", "pass"))] },
    ]);
    through.stages[1] = { ...through.stages[1]!, next: "review" };
    through.stages[2] = { ...through.stages[2]!, next: "critique" };
    through.stages[3] = { ...through.stages[3]!, next: null };
    kanbanPipelines.push(fix, through);
    kanbanLinks.pipelines[fix.id] = prLinks(2348, "merged");
    kanbanLinks.pipelines[through.id] = { links: [], noPr: true };
    kanbanTasks.push(
      kanbanTask("t-chain-fix", "assigned", L("Keep the review fix on the card", "Залишити виправлення рев’ю на картці"), { updatedAt: iso(300) }),
      kanbanTask("t-chain-through", "assigned", L("Critique, then review, with a fix between", "Критика, потім рев’ю, з виправленням між ними"), { updatedAt: iso(400) }),
    );
  }
  /* #2187 §4.6, §6 (`?merge-states=1`): one task per state of a completed
     lane's automatic merge — waiting for checks, updating from main, merge
     stopped with its two answers, merged by Delegatus — read on the task
     screen at 390, en and uk. The ⋯ sheet carries the merge setting row. */
  /* #2187 §5.3, §6 (mockups P3, P4, `?task-finish=1`): a task whose marked
     lane merged while a second lane still runs, so its move to Done waits;
     a Done task its marked lane finished; and a running lane marked to
     finish its task. Read on the task screen at 390, en and uk. */
  if (new URLSearchParams(location.search).has("task-finish")) {
    const uk = localStorage.getItem("llv_lang") === "uk";
    const L = (en: string, ua: string) => (uk ? ua : en);
    const reviewerRole = { ...kanbanRole("reviewer"), access: "read-only" };
    const HEAD = "5b2c9e1d7a3f4b6c8d0e2f4a6b8c0d2e4f6a8b0c";
    const run = (key: string, stageId: string, ago: number) => {
      const path = kanbanConversation(`${key} · ${stageId}`, "settled", ago);
      return { n: 1, state: "passed", startedAt: iso(ago + 600), completedAt: iso(ago), agentPath: path, conversationId: idOf(path), activatedBy: null,
        effectiveRole: stageId === "build" ? kanbanRole("builder") : reviewerRole, verdict: { status: "pass", findings: [] } };
    };
    const merged = (number: number, ago: number) => ({
      state: "merged", by: "auto-merge", repository: "example/atlas", prNumber: number, policyChangedAt: iso(86_400), reviewedHead: HEAD, chain: [HEAD], updates: [],
      seenChecks: ["privacy-publication"], head: HEAD, headSeenAt: iso(ago), lastChecks: [], readAt: iso(60), nextReadAt: null, readFailures: 0, requestedAt: iso(ago),
      mergedHead: HEAD, mergeCommit: null, method: "squash", mergedAt: iso(ago - 600), attempts: 0, reason: null, blockedAt: null, updatedAt: iso(60),
    });
    const finished = (id: string, title: string, taskId: string, ago: number, over: Record<string, unknown>) => kanbanLane(id, title, [taskId], "completed", [
      { id: "build", attempts: [run(id, "build", ago + 1_200)] },
      { id: "review", role: "reviewer", onFail: { to: "build", maxRounds: 2 }, attempts: [run(id, "review", ago)] },
    ], { lastPassedCommit: HEAD, closedAt: iso(ago), finishesTaskIds: [taskId], ...over });
    const hold = finished("lane-finish-hold", L("Slice 3: merge runner and the setting", "Зріз 3: мердж і налаштування"), "t-finish-hold", 3_600,
      { merge: merged(2240, 3_600), taskFinishWaits: [{ taskId: "t-finish-hold", since: iso(3_000), open: ["lane-finish-other"] }] });
    const other = kanbanLane("lane-finish-other", L("Docs for the merge setting", "Документація налаштування мерджу"), ["t-finish-hold"], "running", [
      { id: "build", state: "running", ago: 900 }, { id: "review", role: "reviewer" },
    ]);
    const done = finished("lane-finish-done", L("Conversation: wider agent replies", "Розмова: ширші відповіді агентів"), "t-finish-done", 5_400,
      { merge: merged(2236, 5_400), taskFinishes: [{ taskId: "t-finish-done", at: iso(4_500), outcome: "moved" }] });
    const marked = kanbanLane("lane-finish-marked", L("Slice 4: the pipeline that finishes its task", "Зріз 4: пайплайн, що завершує задачу"), ["t-finish-marked"], "running", [
      { id: "build", state: "running", ago: 1_500 }, { id: "review", role: "reviewer" },
    ], { finishesTaskIds: ["t-finish-marked"] });
    kanbanPipelines.push(hold, other, done, marked);
    kanbanLinks.pipelines[hold.id] = prLinks(2240, "merged");
    kanbanLinks.pipelines[other.id] = prLinks(2242);
    kanbanLinks.pipelines[done.id] = prLinks(2236, "merged");
    kanbanLinks.pipelines[marked.id] = prLinks(2231);
    kanbanTasks.push(
      kanbanTask("t-finish-hold", "assigned", L("Merge when the review passes", "Мердж, коли ревʼю пройдено"), { updatedAt: iso(3_000) }),
      kanbanTask("t-finish-done", "done", L("Conversation: wider agent replies", "Ширші відповіді агентів"), { updatedAt: iso(4_500) }),
      kanbanTask("t-finish-marked", "assigned", L("Pipelines that finish their task", "Пайплайни, що завершують задачу"), { updatedAt: iso(1_500) }),
    );
  }
  if (new URLSearchParams(location.search).has("merge-states")) {
    const uk = localStorage.getItem("llv_lang") === "uk";
    const L = (en: string, ua: string) => (uk ? ua : en);
    const reviewerRole = { ...kanbanRole("reviewer"), access: "read-only" };
    const HEAD = "7c1e4b2a9d3f6e5c8b0a1d2e3f4a5b6c7d8e9f0a";
    const run = (key: string, stageId: string, ago: number) => {
      const path = kanbanConversation(`${key} · ${stageId}`, "settled", ago);
      return { n: 1, state: "passed", startedAt: iso(ago + 600), completedAt: iso(ago), agentPath: path, conversationId: idOf(path), activatedBy: null,
        effectiveRole: stageId === "build" ? kanbanRole("builder") : reviewerRole, verdict: { status: "pass", findings: [] } };
    };
    const merge = (state: string, requestedAgo: number, over: Record<string, unknown> = {}) => ({
      state, by: null, repository: "example/atlas", prNumber: 2240, policyChangedAt: iso(86_400), reviewedHead: HEAD, chain: [HEAD], updates: [],
      seenChecks: ["privacy-publication", "bun-runtime"], head: HEAD, headSeenAt: iso(requestedAgo), lastChecks: [], readAt: iso(60), nextReadAt: null,
      readFailures: 0, requestedAt: iso(requestedAgo), mergedHead: null, mergeCommit: null, method: null, mergedAt: null, attempts: 0, reason: null,
      blockedAt: null, updatedAt: iso(60), ...over,
    });
    const lanes: Array<[string, string, string, Record<string, unknown>, number]> = [
      ["t-merge-wait", "assigned", L("Deploy failure notifies the seat and the phone", "Сповіщення, коли деплой падає"), merge("waiting-checks", 720), 720],
      ["t-merge-update", "assigned", L("Composer model pills: one width at 390", "Кнопки моделі в композері однієї ширини"), merge("updating", 1_200, { updates: [{ requestedAt: iso(120), head: null }] }), 1_200],
      ["t-merge-stop", "assigned", L("Per-feature screenshot catalog and one capture command", "Каталог скриншотів по фічах і одна команда зйомки"), merge("blocked", 2_700, { reason: 'check "privacy-publication" failed', blockedAt: iso(1_800) }), 2_700],
      ["t-merge-done", "done", L("Conversation: wider agent replies", "Ширші відповіді агентів"), merge("merged", 5_400, { by: "auto-merge", mergedHead: HEAD, method: "squash", mergedAt: iso(4_200) }), 5_400],
    ];
    for (const [taskId, status, title, mergeRecord, ago] of lanes) {
      const id = taskId.replace("t-", "lane-");
      const lane = kanbanLane(id, title, [taskId], "completed", [
        { id: "build", attempts: [run(taskId, "build", ago + 1_200)] },
        { id: "review", role: "reviewer", onFail: { to: "build", maxRounds: 2 }, attempts: [run(taskId, "review", ago)] },
      ], { lastPassedCommit: HEAD, closedAt: iso(ago), merge: mergeRecord });
      kanbanPipelines.push(lane);
      kanbanLinks.pipelines[lane.id] = prLinks(2240, mergeRecord.state === "merged" ? "merged" : "open");
      kanbanTasks.push(kanbanTask(taskId, status, title, { updatedAt: iso(ago) }));
    }
  }
  kanbanPipelines.push(kanbanLane("lane-flake", "Nightly: rerun the flake campaign on a quiet machine", [], "running", [
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
  const donePaths: string[] = [];
  doneTitles.forEach((title, index) => {
    const path = kanbanConversation(title, "settled", 3_600 * (index + 2));
    donePaths.push(path);
    kanbanTasks.push(kanbanTask(`t-done-${index}`, "done", title, { assignments: [kanbanAssign(path)], updatedAt: iso(3_600 * (index + 2)) }));
  });
  /* #2105 (`?rounds=1`): the asking conversation is the second round of a
     chain, so its ⋯ names the round before it and opens it. */
  if (new URLSearchParams(location.search).has("rounds")) {
    const tail = kanbanFiles.find((entry) => entry.path === asker) as unknown as { continues?: unknown };
    tail.continues = { conversationId: idOf(donePaths[0]!), path: donePaths[0]!, round: 2 };
  }
  /* The live seat: the card above the tabs, never a card in a column. */
  kanbanConversation("Orchestrator", "settled", 300);
}
if (ICONS_SCENE) {
  kanbanTasks.push(kanbanTask("t-wrap", "inbox", "Let the operator pin one conversation above the column so it stays in reach while the rest of the column scrolls under it", { updatedAt: iso(4 * 3_600) }));
  const dress: Record<string, { color?: string; icon?: string }> = {
    /* Inbox */
    "t-systemd": { color: "coral", icon: "server" },
    "t-quota": { icon: "hourglass" },
    "t-attention": { color: "violet" },
    "t-tray": { color: "amber" },
    /* Assigned */
    "t-data": { color: "sky", icon: "cloud-download" },
    "t-copilot": { color: "violet" },
    "t-favicon": { icon: "image" },
    "t-upload": { color: "lime", icon: "upload" },
    "t-long": { color: "pink" },
    /* Done */
    "t-done-0": { color: "slate" },
    "t-done-1": { color: "coral", icon: "columns-3" },
    "t-done-3": { icon: "rocket" },
  };
  for (const row of kanbanTasks as Array<Record<string, unknown>>) Object.assign(row, dress[row.id as string] ?? {});
}
if (SEATLESS) {
  kanbanTasks.length = 0;
  kanbanPipelines.length = 0;
  const keep = SEATLESS === "seatonly" ? kanbanFiles.filter((entry) => entry.title === "Orchestrator")
    : SEATLESS === "loose" ? kanbanFiles.filter((entry) => entry.title !== "Orchestrator") : [];
  kanbanFiles.length = 0;
  kanbanFiles.push(...keep);
  if (SEATLESS === "donly") kanbanTasks.push(kanbanTask("t-done-only", "done", "Add a --version flag", { updatedAt: iso(86_400) }));
}
const SEAT_PATH = kanbanFiles.find((entry) => entry.title === "Orchestrator")?.path ?? null;
const WALK_MARKER = new URLSearchParams(location.search).has("walk");

/* The Overview's projects: keys the way a repository resolves (opaque, read by
   nobody; assembled so no hex run sits in the source), and the names the rail
   shows. */
const opaqueKey = (seed: string) => `repo-${seed.repeat(4)}`;
const OVERVIEW_KEYS = { delegatus: opaqueKey("a1b2"), forge: opaqueKey("c3d4"), docs: opaqueKey("e5f6") };
const OVERVIEW_NAMES: Record<string, string> = { [OVERVIEW_KEYS.delegatus]: "delegatus", [OVERVIEW_KEYS.forge]: "forge-api", [OVERVIEW_KEYS.docs]: "atlas-docs" };
if (OVERVIEW_SCENE) {
  const byTask: Record<string, string> = {
    "t-data": OVERVIEW_KEYS.delegatus, "t-favicon": OVERVIEW_KEYS.delegatus, "t-kanban": OVERVIEW_KEYS.delegatus, "t-long": OVERVIEW_KEYS.delegatus, "t-systemd": OVERVIEW_KEYS.delegatus, "t-tray": OVERVIEW_KEYS.delegatus,
    "t-copilot": OVERVIEW_KEYS.forge, "t-upload": OVERVIEW_KEYS.forge, "t-uk": OVERVIEW_KEYS.forge, "t-quota": OVERVIEW_KEYS.forge, "t-many": OVERVIEW_KEYS.forge,
    "t-skeletons": OVERVIEW_KEYS.docs, "t-chips": OVERVIEW_KEYS.docs, "t-seat": OVERVIEW_KEYS.docs, "t-attention": OVERVIEW_KEYS.docs,
  };
  const keys = Object.values(OVERVIEW_KEYS);
  const fileProject = new Map<string, string>();
  kanbanTasks.forEach((row, index) => {
    const entry = row as { id: string; project: string; assignments: Array<{ path: string }> };
    entry.project = byTask[entry.id] ?? keys[index % keys.length]!;
    for (const assignment of entry.assignments) fileProject.set(assignment.path, entry.project);
  });
  for (const pipeline of kanbanPipelines) {
    pipeline.project = byTask[pipeline.taskIds?.[0] ?? ""] ?? OVERVIEW_KEYS.docs;
    for (const run of pipeline.runs) {
      for (const attempt of run.attempts as Array<{ agentPath?: string | null }>) if (attempt.agentPath) fileProject.set(attempt.agentPath, pipeline.project);
    }
  }
  /* The stalled conversations no task owns, split between two projects, and
     the running one with a feed, which the full-screen frame opens. */
  let loose = 0;
  for (const entry of kanbanFiles) {
    (entry as { project: string }).project = fileProject.get(entry.path) ?? (loose++ % 2 ? OVERVIEW_KEYS.forge : OVERVIEW_KEYS.delegatus);
  }
  kanbanFiles.push({ ...files[0]!, project: OVERVIEW_KEYS.forge } as FileEntry);
  /* What ⋯ › Hidden tasks lists: a finished group hidden an hour ago, and an
     empty task taken off the board. */
  for (const row of kanbanTasks as Array<Record<string, unknown>>) {
    if (row.id === "t-seat") row.groupHidden = { at: iso(3_600), by: "operator", admitted: { conversationIds: [], paths: [] } };
    if (row.id === "t-quota") row.board = "hidden";
  }
}

/* An invented bot and its invented chats. */
const BOT_SCENE = new URLSearchParams(location.search).get("bot");
/* The external relay's scene (docs/design/relay.md §B.9). */
const RELAY_SCENE = new URLSearchParams(location.search).get("relay");
const botChat = (over: Record<string, unknown>) => ({
  chatId: "-1000000000101", title: "Team Reports", type: "supergroup", username: null, isForum: false, member: true,
  alias: null, postAllowed: false, postable: false, seesAllMessages: false, readdToApply: false,
  lastMessageAt: iso(600), lastPostAt: null, lastPostBy: null, storedMessages: 12, ...over,
});
/* `typed`: one group whose title suggests no alias, so the field shows. */
const telegramBot = BOT_SCENE === "typed"
  ? {
    connected: true,
    bot: { name: "Atlas Reports", username: "atlas_reports_bot", canReadAllGroupMessages: false, canJoinGroups: true },
    receiving: "polling",
    lastUpdateAt: iso(120),
    lastCheckedAt: iso(60),
    chats: [botChat({ chatId: "-1000000000505", title: "Реліз", type: "group" })],
    limits: [],
  }
  : BOT_SCENE === "chats" || BOT_SCENE === "webhook" || BOT_SCENE === "refused"
  ? {
    connected: true,
    bot: { name: "Atlas Reports", username: "atlas_reports_bot", canReadAllGroupMessages: false, canJoinGroups: true },
    receiving: BOT_SCENE === "webhook" ? "webhook_elsewhere" : "polling",
    lastUpdateAt: iso(120),
    lastCheckedAt: iso(60),
    chats: [
      /* The one chat agents may post in, which the operator chose for the
         project's reports (orchestrator-reports §5.6). */
      botChat({ alias: "team-reports", postAllowed: true, postable: true, seesAllMessages: true, lastPostAt: iso(3_600), lastPostBy: { conversationId: "conversation_writer", title: "Weekly delivery report for the atlas team" }, reports: [{ name: "Atlas" }], ...(BOT_SCENE === "refused" ? {
        /* `refused`: the project chose this chat, then posting was switched
           off here; the Viewer still addresses it and its posts are refused. */
        postAllowed: false, postable: false, reports: [{ name: "Atlas", refused: true }],
      } : {}) }),
      botChat({ chatId: "-1000000000202", title: "Design review and release coordination", isForum: true }),
      botChat({ chatId: "700000303", title: "Person A", type: "private", seesAllMessages: true }),
      botChat({ chatId: "-1000000000404", title: "Old Project", member: false, alias: "old-project", postAllowed: true }),
    ],
    limits: [],
  }
  : BOT_SCENE === "postonly"
  ? {
    /* `postonly`: another program owns the bot's updates through a webhook,
       so no update ever names a group; the chats agents may post in were
       added by id earlier, and nothing has been read from them. The release
       group's 20-character alias shares its first fifteen with the one the
       case adds, so a chip that named chats by alias would draw both alike. */
    connected: true,
    bot: { name: "Atlas Reports", username: "atlas_reports_bot", canReadAllGroupMessages: false, canJoinGroups: true },
    receiving: "webhook_elsewhere",
    lastUpdateAt: null,
    lastCheckedAt: iso(60),
    chats: [
      botChat({ alias: "team-reports", postAllowed: true, postable: true, lastMessageAt: null, storedMessages: 0 }),
      botChat({ chatId: "-1000000000303", title: "Release notes", alias: "atlas-design-release", postAllowed: true, postable: true, lastMessageAt: null, storedMessages: 0 }),
    ],
    limits: [],
  }
  : { connected: false, bot: null, receiving: "stopped", lastUpdateAt: null, lastCheckedAt: null, chats: [], limits: [] };

/* Each project's report destination (orchestrator-reports §5.6.1), keyed by
   project: `atlas` never chose, and two invented projects with seats, one
   posting to the team group and one never chosen. */
const reportChoices: Record<string, { chat: string | null; name?: string } | null> = {
  [PROJECT]: null,
  "-projects-ledger": BOT_SCENE === "postonly" ? { chat: "team-reports", name: "Ledger" } : null,
  "-projects-mesh": null,
};
const REPORT_LABELS: Record<string, string> = { [PROJECT]: "atlas", "-projects-ledger": "ledger", "-projects-mesh": "mesh" };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/* The one request that leaves the page: the evidence server draws task icons from lucide (#2102). */
const serverFetch = window.fetch.bind(window);
let agentEvidence: Promise<{ feed: string; provenance: unknown }> | null = null;
const deliveredAgentEvidence = () => agentEvidence ??= serverFetch("/evidence/agent-message-label")
  .then((response) => response.json() as Promise<{ feed: string; provenance: unknown }>);
const mergeSetting = { enabled: true };
/* #2146: the project's Bridge reports switch, off with `?bridge=off`. */
const bridgeSetting = { enabled: new URLSearchParams(location.search).get("bridge") !== "off" };
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), location.origin);
  if (RUNTIME_PERF && url.pathname === "/api/runtime/snapshot") return serverFetch(input, init);
  const method = (init?.method ?? "GET").toUpperCase();
  if (url.pathname === "/api/view/presence" && method === "POST" && SELF_UPDATE_RELOAD) {
    evidence.presenceReplies += 1;
    return json({ ok: true, serving: ++presenceAnswers === 1 ? "aaaaaaa" : "bbbbbbb" });
  }
  if (url.pathname === "/api/links") {
    const linked = new URLSearchParams(location.search).get("linked");
    if (linked === "error") return json({ error: "forbidden" }, 403);
    return json({
    self: { v: 1, installId: "fixture-install", label: "Example server",
      publicUrl: linked === "lan-dns" ? "http://board.internal.test:8897" : "https://delegatus.example.com",
      check: { code: "ok", at: "2026-09-28T12:00:00.000Z" } },
    state: linked === "unsafe" ? "needs-remote-entry" : linked === "keyoff" ? "needs-access-key" : "ok",
    entry: { port: linked === "unsafe" ? 8898 : 8897, publishable: linked !== "unsafe" },
    keyOn: linked !== "keyoff", tailnetUrl: "https://example.tailnet.ts.net",
    });
  }
  /* The external relay's settings and pairing (docs/design/relay.md §B.9),
     over `?relay=`: `paired` holds one relay at work and one paused,
     `troubled` one whose credential the service refused and one it cannot
     reach, `code` a pairing waiting on the owner in the service, `confirm` one
     waiting on the operator here, `ended` one the service declined, and `none`
     nothing yet. The service and its owner are invented. */
  if (RELAY_SCENE && url.pathname.startsWith("/api/external-relay")) {
    const owner = { namespace: "example", id: "owner-1", display_name: "Person A", handle: "@person_a" };
    const target = (over: Record<string, unknown>) => ({ id: "bot-1", name: "Support bot", answered_by: "service", fallback: "service", enabled: true,
      engine: null, model: null, effort: null, project: null, concurrency: 1, hardCapMinutes: 30, ...over });
    const relayRow = (over: Record<string, unknown>) => ({ id: "relay-1", origin: "https://relay.example", name: "Example relay",
      description: "Answers questions in the example chats.", owner, pairedAt: iso(86_400), paused: false, targets: [], ...over });
    const pendingRow = { id: "pair-1", origin: "https://relay.example", name: "Example relay", description: "Answers questions in the example chats.",
      code: "K7QM-9XTD", verify_url: "https://relay.example/pair?code=K7QM-9XTD", expires_at: new Date(Date.now() + 540_000).toISOString(), poll_interval_s: 3 };
    if (url.pathname === "/api/external-relay") {
      if (RELAY_SCENE === "paired") return json({
        relays: [
          relayRow({ targets: [
            target({ engine: "claude", model: "opus", effort: "low", concurrency: 2, answered_by: "install" }),
            target({ id: "bot-2", name: "Sales assistant for the weekend shift", engine: "codex", model: "gpt-6-astra" }),
            target({ id: "bot-3", name: "New bot" }),
          ] }),
          relayRow({ id: "relay-2", origin: "https://second-relay.example", name: "Second relay", description: "", paused: true, targets: [target({ engine: "claude", model: "sonnet" })] }),
        ],
        pending: [],
        status: [
          { id: "relay-1", state: { state: "polling", lastOutcome: "answered", lastOutcomeAt: iso(240), lastProgress: { targetId: "bot-1", label: "Reading the last messages in the thread", at: iso(300) } }, running: { "bot-1": 1, "bot-2": 0, "bot-3": 0 } },
          { id: "relay-2", state: { state: "paused", lastOutcome: "declined:no_capacity", lastOutcomeAt: iso(7_200), lastProgress: null }, running: { "bot-1": 0 } },
        ],
      });
      if (RELAY_SCENE === "troubled") return json({
        relays: [
          relayRow({ targets: [target({ engine: "claude", model: "opus", answered_by: "install" })] }),
          relayRow({ id: "relay-2", origin: "https://second-relay.example", name: "Second relay", description: "", targets: [target({ engine: "claude", model: "sonnet", answered_by: "install" })] }),
        ],
        pending: [],
        status: [
          { id: "relay-1", state: { state: "credential_rejected", lastOutcome: "failed:agent_error", lastOutcomeAt: iso(3_600), lastProgress: null }, running: { "bot-1": 0 } },
          { id: "relay-2", state: { state: "unreachable", lastOutcome: "answered", lastOutcomeAt: iso(1_800), lastProgress: null }, running: { "bot-1": 0 } },
        ],
      });
      return json({ relays: [], pending: RELAY_SCENE === "code" || RELAY_SCENE === "confirm" || RELAY_SCENE === "ended" ? [pendingRow] : [], status: [] });
    }
    if (url.pathname === "/api/external-relay/pairings/pair-1" && method === "GET") {
      return json({ pairing: RELAY_SCENE === "confirm" ? { status: "awaiting_install", owner, targets: [] }
        : RELAY_SCENE === "ended" ? { status: "denied", reason: "The owner declined this install in the relay service." }
        : { status: "pending" } });
    }
    return json({ error: "not_found" }, 404);
  }
  if (url.pathname === "/api/task-icons") return serverFetch(url.pathname + url.search);
  /* The linked stage install's agents and lanes (`?synced=1`): the driver serves them. */
  if (SYNCED && url.pathname === "/api/links/agents") return serverFetch(url.pathname + url.search);
  if (url.pathname.startsWith("/api/tts")) return serverFetch(url.pathname + url.search, init);
  if (url.pathname === "/api/log/provenance" && AGENT_LABEL) return json((await deliveredAgentEvidence()).provenance);
  if (STAGE_AGENT && ["/api/conversation-host", "/api/tmux", "/api/runtime/send"].includes(url.pathname) && method === "POST") {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (typeof body.text === "string") evidence.sends.push(body);
    return json({ ok: true, outcome: "resumed", receipt: { operationId: "stage-agent-send", idempotencyKey: body.idempotencyKey, conversationId: body.conversationId, kind: "send", status: "delivered", text: body.text, at: new Date().toISOString(), revision: 1 } });
  }
  /* The seat's mandate is Delegatus's own delivery, so the server's provenance names it as such and the transcript's
     record of it renders as the mandate card, never as the operator's bubble. */
  if (url.pathname === "/api/log/provenance" && FM_SEAT) {
    if (FM_HANDOVER) await fmEvidenceGate;
    return json({ messages: { [FM_SEAT_UUID]: { origin: "agent", mandate: { kind: "version", version: 1 } } }, occurrences: [{ textDigest: messageTextDigest(fmDeliveredText()), deliveredAt: iso(60), origin: "agent", mandate: { kind: "version", version: 1 } }] });
  }
  if (url.pathname === "/api/conversation-host" && method === "POST") {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (body.action === "permission") {
      evidence.permissionAnswers.push(body);
      return json({ ok: true }, 202);
    }
  }
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
    if (typeof body.text === "string") row.text = body.text;
    if (typeof body.details === "string") row.details = body.details;
    if (typeof body.color === "string") row.color = body.color === "none" ? undefined : body.color;
    if (body.hide === true) row.groupHidden = { at: new Date().toISOString(), by: "operator", admitted: { conversationIds: [], paths: [] } };
    if (body.hide === false) delete row.groupHidden;
    row.revision = `${String(row.revision).replace(/-\d+$/, "")}-${Number(String(row.revision).split("-").pop()) + 1}`;
    row.updatedAt = new Date().toISOString();
    return json({ task: row });
  }
  /* #2187 §6: the project's merge setting, as the settings route answers it. */
  if (url.pathname === "/api/projects/settings") {
    let project = url.searchParams.get("project") ?? PROJECT;
    if (method === "PUT") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { project?: string; mergeOnReview?: unknown; bridgeReports?: unknown; reportTelegram?: { chat: string; name: string } | null };
      if (typeof body.mergeOnReview === "boolean") mergeSetting.enabled = body.mergeOnReview;
      if (typeof body.bridgeReports === "boolean") bridgeSetting.enabled = body.bridgeReports;
      project = body.project ?? PROJECT;
      if ("reportTelegram" in body) {
        evidence.reportWrites.push({ project, reportTelegram: body.reportTelegram });
        reportChoices[project] = body.reportTelegram ?? { chat: null };
      }
    }
    return json({
      ok: true,
      project: PROJECT,
      mergeOnReview: { enabled: mergeSetting.enabled, changedAt: iso(86_400), changedBy: "operator" },
      bridgeReports: { enabled: bridgeSetting.enabled, changedAt: iso(86_400), changedBy: "operator" },
      reportTelegram: reportChoices[project] ?? null,
      reportChatTitle: (telegramBot.chats as Array<{ alias: string | null; title: string }>).find((chat) => chat.alias !== null && chat.alias === reportChoices[project]?.chat)?.title ?? null,
      reportNameSuggestion: project === PROJECT ? "Atlas" : null,
      github: "example/atlas",
    });
  }
  if (url.pathname === "/api/projects/reports") {
    return json({ ok: true, projects: Object.keys(reportChoices).map((project) => ({
      project,
      label: REPORT_LABELS[project],
      reportTelegram: reportChoices[project],
      reportName: reportChoices[project]?.name ?? (project === PROJECT ? "Atlas" : null),
    })) });
  }
  if (url.pathname === "/api/orchestrator/reports") {
    const known = new Map<string, "task" | "pipeline">([
      ...(kanbanTasks as Array<{ id: string }>).map((task) => [task.id, "task"] as const),
      ...kanbanPipelines.map((pipeline) => [pipeline.id, "pipeline"] as const),
    ]);
    return json(reportLogFixturePage(url, { project: PROJECT, github: "example/atlas", enabled: bridgeSetting.enabled, knownCards: known, asks: asksYouFixtureLines(now * 1_000, asksLines) }));
  }
  /* "Asks you": the installation's switch and this month's spend. */
  if (url.pathname === "/api/asks-you") {
    if (method === "PUT") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { enabled?: unknown };
      if (typeof body.enabled === "boolean") asksSetting.enabled = body.enabled;
    }
    return json({ ok: true, ...asksYouFixtureSetting(asksSetting.enabled) });
  }
  if (KANBAN && url.pathname === "/api/tasks" && method === "GET") return json({ tasks: kanbanTasks });
  /* #2166 §3.8 (`&walk=1`): an install whose onboarding marker has never run
     the interface walk. What the walk writes is kept in sessionStorage, so a
     reload reads it back as the server would. */
  if (WALK_MARKER && url.pathname === "/api/onboarding") {
    const stored = sessionStorage.getItem("evidence-walk");
    const marker = { schemaVersion: 1, completedAt: iso(120), dismissedAt: null, reason: null, steps: {}, lastHealth: null, walk: stored === "done" || stored === "skipped" ? stored : null };
    if (method === "PUT") {
      const patch = JSON.parse(String(init?.body ?? "{}")) as { walk?: string };
      if (patch.walk) sessionStorage.setItem("evidence-walk", patch.walk);
      return json({ marker: { ...marker, walk: patch.walk ?? marker.walk } });
    }
    return json({ marker, seatTickCheckMinutes: 10 });
  }
  if (LAUNCH_SCENE && url.pathname === "/api/spawn") {
    if (method === "POST") {
      evidence.spawns.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return json({
        ok: true, state: "path-pending", transport: "structured", launched: true, path: null,
        launchId: LAUNCH_ID, conversationId: LAUNCH_CONVERSATION, initialMessage: "queued", target: null,
      }, 202);
    }
    const supported = { supported: true, reason: null, formats: ["image/png"], maxImages: 2, maxRawBytesPerImage: 3_000_000, maxEncodedBytesPerRequest: 8_000_000 };
    return json({ dirs: ["/repo"], cwd: "/repo", spawnTransport: "structured", imageInput: { claude: supported, codex: supported } });
  }
  if (LAUNCH_SCENE && url.pathname === "/api/accounts") return json({ claude: { active: "main", accounts: [] } });
  if (LAUNCH_SCENE && url.pathname === "/api/roles") return json({}, 404);
  if (url.pathname === "/api/files" && OVERVIEW_SCENE) {
    return json({
      files: kanbanFiles, projectCatalog: Object.values(OVERVIEW_KEYS).map((project) => ({ project, conversations: kanbanFiles.filter((entry) => entry.project === project).length, smt: now - 20 })),
      projectDisplayNames: OVERVIEW_NAMES, flows: [], pipelines: kanbanPipelines,
      workflows: [], tasks: kanbanTasks, workLinks: kanbanLinks, systemHealth: { tmux: { status: "healthy" }, ...(new URLSearchParams(location.search).has("state-disk-full") ? { storage: { incidents: [], writes: { state: "disk-full", freeBytes: 32 * 1024 * 1024, since: "2026-10-01T12:00:00Z" } } } : {}) },
    });
  }
  if (url.pathname === "/api/files" && KANBAN) {
    return json({
      files: kanbanFiles, projectCatalog: [{ project: PROJECT, conversations: kanbanFiles.length, smt: now - 20 }], flows: [], pipelines: kanbanPipelines,
      workflows: [], tasks: kanbanTasks, workLinks: kanbanLinks, systemHealth: { tmux: { status: "healthy" }, ...(new URLSearchParams(location.search).has("state-disk-full") ? { storage: { incidents: [], writes: { state: "disk-full", freeBytes: 32 * 1024 * 1024, since: "2026-10-01T12:00:00Z" } } } : {}) },
      ...(FIRST_MESSAGE !== null ? { launchRoutes: { [`spawn:${FM_LAUNCH_ID}`]: FM_CONVERSATION_ID } } : {}),
    });
  }
  if (url.pathname === "/api/files" && LAUNCH_SCENE && evidence.launchMaterialized) {
    const launched = conversation(LAUNCH_PATH, "Launched agent", {
      conversationId: LAUNCH_CONVERSATION, activity: "recent", mtime: now - 30, model: "haiku",
    });
    return json({
      files: [...files, launched], projectCatalog: [{ project: PROJECT, conversations: files.length + 1, smt: now - 20 }], flows, pipelines,
      workflows: [], tasks, systemHealth: { tmux: { status: "healthy" } },
    });
  }
  if (url.pathname === "/api/files") {
    return json({
      files, projectCatalog: [{ project: PROJECT, conversations: files.length, smt: now - 20 }], flows, pipelines,
      workflows: [], tasks, systemHealth: { tmux: { status: "healthy" }, ...(new URLSearchParams(location.search).has("state-disk-full") ? { storage: { incidents: [], writes: { state: "disk-full", freeBytes: 32 * 1024 * 1024, since: "2026-10-01T12:00:00Z" } } } : {}) },
      /* The durable route of the launch, as the server hands it, so the pane follows the conversation from `spawn:` to its transcript. */
      ...(FIRST_MESSAGE !== null ? { launchRoutes: { [`spawn:${FM_LAUNCH_ID}`]: FM_CONVERSATION_ID } } : {}),
    });
  }
  /* The fixture has no runtime plane, and says so the way a Viewer without one
     does. Left unanswered, the bus escalated to «Runtime degraded» part-way
     through a run, and the banner moved the list under a measured tap. */
  if (url.pathname === "/api/runtime/snapshot" && STRUCTURED) {
    return json({
      schemaVersion: 1, snapshotSeq: (snapshotReads += 1), retentionFloorSeq: 0, structuredHostsEnabled: true, runtime: { hostEpoch: 1, health: "ready" }, filesRevision: 1,
      sessions: [{
        conversationId: SEAT_NOISE !== null ? files[0]!.conversationId : "conversation_running", sessionKey: { engine: SEAT_NOISE !== null || CONTEXT_MODE !== null ? files[0]!.engine : "claude", sessionId: "running-session" }, hostKind: (SEAT_NOISE !== null || CONTEXT_MODE !== null) && files[0]!.engine === "codex" ? "codex-app-server" : "claude-broker", host: "hosted",
        turn: CONTEXT_MODE !== null ? evidence.contextTurn : queueRecovery ? "idle" : "running", provenance: "structured", revision: 1, attentionIds: [],
        recentReceipts: CONTEXT_MODE !== null ? evidence.contextReceipts : [], accountId: ACCOUNT,
        parentConversationId: null, flowId: null, workflowId: null, cwd: "/repo", artifactPath: SEAT_NOISE !== null ? files[0]!.path : RUNNING_PATH,
        capabilities: CONTEXT_MODE !== null
          ? { steer: true, structuredAttention: true, ...(CONTEXT_MODE === "noinject" ? {} : { inject: true }) }
          : { steer: false, structuredAttention: true },
        activeTurnId: CONTEXT_MODE !== null ? (evidence.contextTurn === "running" ? "turn-1" : null) : queueRecovery ? null : "turn-1", pendingReconfigure: null,
      }],
      attentions: [], recentOperations: [], edges: [], flows: [], workflows: [], tasks: [], deployments: [],
    });
  }
  if (url.pathname === "/api/runtime/snapshot") return json({ code: RUNTIME_PLANE_ABSENT }, 503);
  /* The phone's rows-only read; with `&notice=1`, the orchestrator's request
     for the operator arrives once the driver says so. */
  if (url.pathname === "/api/attention" && url.searchParams.get("records") === "only") {
    return json({
      ok: true,
      records: null,
      notices: NOTICE && evidence.noticeOn ? [{
        id: "attention_needs_notice",
        reason: "The review of the upload redesign finished with two findings.",
        target: { kind: "pipeline", pipelineId: "lane-upload" },
        contextLabel: null,
        raisedBy: { kind: "manager", role: "orchestrator" },
        createdAt: iso(40),
      }] : [],
    });
  }
  /* The dismissal route (docs/design/needs-attention.md §5), applied to the
     fixture's own rows the way the server applies it. */
  if (url.pathname === "/api/attention/dismissals" && method === "POST") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { target: { kind: string; taskId?: string; subjects?: Array<Record<string, string>>; pipelineId?: string; conversationId?: string; path?: string }; undo?: boolean };
    evidence.dismissals.push(body as unknown as Record<string, unknown>);
    const at = new Date().toISOString();
    const by = { kind: "operator", surface: "phone" };
    const subjects = body.target.subjects ?? [body.target as unknown as Record<string, string>];
    const dismissed: unknown[] = [];
    for (const subject of subjects) {
      if (subject.kind === "pipeline") {
        const lane = kanbanPipelines.find((entry) => entry.id === subject.pipelineId);
        if (!lane) continue;
        Object.assign(lane, body.undo ? { dismissedAt: null, dismissedBy: undefined } : { dismissedAt: at, dismissedBy: by });
        dismissed.push({ kind: "pipeline", pipelineId: lane.id });
        continue;
      }
      const file = kanbanFiles.find((entry) => entry.conversationId === subject.conversationId || entry.path === subject.path);
      if (!file) continue;
      if (body.undo) delete (file as { attentionDismissal?: unknown }).attentionDismissal;
      else Object.assign(file, { attentionDismissal: { at, by, reasonId: subject.reasonId ?? null } });
      dismissed.push({ kind: "conversation", conversationId: file.conversationId });
    }
    return json({ ok: true, dismissed, alreadyClear: [], at, by, undo: body.undo === true });
  }
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
    return json({ items: catalog.slice(offset, offset + limit), total: catalog.length ? 4_595 : 0, nextCursor: offset + limit < catalog.length ? String(offset + limit) : null });
  }
  if (FM_SEAT && url.pathname === "/api/orchestrator/seat" && method === "POST") {
    fm.posts.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    fm.confirmed = true;
    fmTarget = conversation(FM_SEAT_PATH, "Orchestrator", { activity: "live", proc: "running", pid: 4_402, mtime: now - 5, lastTurn: { startedAt: (now - 90) * 1_000, endedAt: null } });
    kanbanFiles.push(fmTarget);
    fmApply();
    return json({ ok: true, launched: true, transport: "structured", launchId: FM_LAUNCH_ID, conversationId: FM_CONVERSATION_ID, state: "path-pending", initialMessage: "queued", path: null });
  }
  if (FM_SEAT && fm.confirmed && url.pathname === "/api/orchestrator/seat") {
    const path = (fmTarget as { path: string }).path;
    if (url.searchParams.get("scope") === "all") return json({ all: { conversationIds: [FM_CONVERSATION_ID], paths: [path], previous: { conversationIds: [], paths: [] } } });
    return json({
      seat: { project: PROJECT, seatEpoch: 1, conversationId: FM_CONVERSATION_ID, path, mandate: "Run the atlas board.", state: "active", designatedAt: iso(30), intent: { clientRequestId: "seat-first-message", mode: "spawn", launchId: null, error: null } },
      pending: null, exists: true,
    });
  }
  if (FM_SEAT && fm.confirmed && url.pathname === "/api/orchestrator/seat/status") {
    return json({
      project: PROJECT, designated: true, conversationId: FM_CONVERSATION_ID, predecessorConversationId: null,
      engine: "claude", model: "opus", effort: "high", accountId: "primary", cwd: "/repo/atlas", transcriptPath: (fmTarget as { path: string }).path,
      liveness: { lifecycle: "running", hostState: "alive", silentForMs: 1_000 },
      context: { tokens: 12_000, limit: 1_000_000, percent: 1, estimated: false, basis: "" },
      transcriptFacts: null,
      rotation: { recommended: false, level: "none", reasons: [], thresholdUnknown: false },
    });
  }
  if (url.pathname === "/api/orchestrator/seat") {
    // A lost optional read must never strand the composer's local wire fence.
    if (queueRecovery) return new Promise<Response>(() => {});
    if ((FAST_TTS || CHROME !== null) && SEAT_NOISE) {
      const file = files[0]!;
      if (url.searchParams.get("scope") === "all") return json({ all: { conversationIds: [file.conversationId], paths: [file.path], previous: { conversationIds: [], paths: [] } } });
      return json({ seat: { project: PROJECT, seatEpoch: 1, conversationId: file.conversationId, path: file.path, mandate: "Run the atlas board.", state: "active", designatedAt: iso(86_400), intent: { clientRequestId: "seat-fast-tts", mode: "existing", launchId: null, error: null } }, pending: null, exists: true });
    }
    if (AGENT_LABEL) return json({ seat: {
      project: PROJECT, seatEpoch: 1, conversationId: "conversation_running", path: RUNNING_PATH,
      mandate: "Run the atlas board.", state: "active", designatedAt: iso(86_400),
      intent: { clientRequestId: "seat-agent-label", mode: "existing", launchId: null, error: null },
    }, pending: null, exists: true });
    /* The Overview's read of every project's seats (#1841). */
    if (url.searchParams.get("scope") === "all") {
      return json({ all: { conversationIds: SEAT_PATH ? [idOf(SEAT_PATH)] : [], paths: SEAT_PATH ? [SEAT_PATH] : [], previous: { conversationIds: [], paths: [] } } });
    }
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
  if (CONTEXT_MODE !== null && url.pathname === "/api/runtime/inject") {
    const body = JSON.parse(String(init?.body));
    evidence.injects.push(body);
    const operationId = `operation-inject-${evidence.injects.length}`;
    return json({ operationId, receipt: {
      operationId, idempotencyKey: body.idempotencyKey, conversationId: body.conversationId, kind: "inject",
      status: "delivering", at: new Date().toISOString(), revision: 1,
    } }, 202);
  }
  if (CONTEXT_MODE !== null && url.pathname === "/api/runtime/send") {
    evidence.sends.push(JSON.parse(String(init?.body)));
    return json({ error: "the context-mode fixture accepts no send" }, 409);
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
    const evidenceFeed = CONTEXT_MODE !== null ? contextModeFeed() : AGENT_LABEL ? (await deliveredAgentEvidence()).feed : FEED;
    const asked = JSON.parse(String(init?.body ?? "{}")) as { reqs?: Array<{ id: string; path: string; offset: number }> };
    const chunks: Record<string, { offset: number; start: number; size: number; data: string }> = {};
    (asked.reqs ?? []).forEach((request, index) => {
      const body = FAST_TTS ? FAST_TTS_FEED : FIRST_MESSAGE !== null ? (fmTarget && request.path === (fmTarget as { path: string }).path && !request.path.startsWith("spawn:") ? fmTranscript() : "") : SEAT_NOISE !== null ? (request.path === files[0]!.path && !files[0]!.spawn ? (files[0]!.engine === "codex" ? SEAT_CODEX_FEED : SEAT_FEED) : "") : request.path === RUNNING_PATH ? evidenceFeed : "";
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
    const body = JSON.parse(String(init?.body)) as { action: string; taskId?: string; finishes?: boolean };
    evidence.pipelinePatches.push({ id, action: body.action, ...(body.taskId !== undefined ? { taskId: body.taskId } : {}), ...(body.finishes !== undefined ? { finishes: body.finishes } : {}) });
    if (evidence.refuseNextPipelinePatch) {
      evidence.refuseNextPipelinePatch = false;
      await new Promise((resolve) => setTimeout(resolve, 500));
      return json({ error: "refused by the evidence fixture" }, 409);
    }
    const found = pipelines.find((pipeline) => pipeline.id === id) ?? kanbanPipelines.find((pipeline) => pipeline.id === id);
    if (!found) return json({ error: "pipeline not found" }, 404);
    if (evidence.pipelineAnswerDelayMs) await new Promise((resolve) => setTimeout(resolve, evidence.pipelineAnswerDelayMs));
    /* The engine's own rule: a dismissal stamps its own instant, and
       undismiss clears it. */
    if (body.action === "dismiss") found.dismissedAt = new Date().toISOString();
    if (body.action === "undismiss") found.dismissedAt = null;
    /* #2187 §5.1: link-task is an upsert; `finishes` sets or clears the flag. */
    if (body.action === "link-task" && body.taskId && body.finishes !== undefined) {
      const others = (found.finishesTaskIds ?? []).filter((entry) => entry !== body.taskId);
      found.finishesTaskIds = body.finishes ? [...others, body.taskId] : others;
    }
    if (body.action === "dismiss" || body.action === "undismiss") evidence.hidesAnswered.push({ id, action: body.action, dismissedAt: found.dismissedAt ?? null });
    if (body.action === "close") {
      await new Promise((resolve) => setTimeout(resolve, CLOSE_ANSWER_MS));
      Object.assign(found, { state: "closed", closedAt: new Date().toISOString(), hiddenAt: new Date().toISOString() });
      evidence.closesAnswered.push(id);
    }
    return json({ ok: true, pipeline: found });
  }
  /* The Telegram panel (docs/design/telegram-bot-account.md): the personal
     account not connected, and the bot in the state `?bot=` names. */
  if (url.pathname === "/api/telegram") {
    return json({ telegram: { phase: "disconnected", login: null, identity: null, credentialRef: null, lastHealthCheckAt: null, error: null, credentialsConfigured: true } });
  }
  if (url.pathname === "/api/telegram/bot" && method === "POST") {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    evidence.botPosts.push(body);
    const row = (telegramBot.chats as Array<Record<string, unknown>>).find((entry) => entry.chatId === body.chatId);
    if (body.action === "chat" && row) {
      const alias = typeof body.alias === "string" && body.alias !== "" ? body.alias : null;
      Object.assign(row, { alias, postAllowed: alias !== null && body.postAllowed === true, postable: alias !== null && body.postAllowed === true });
    }
    /* A chat added by id: Telegram's getChat named it, with no update read. */
    if (body.action === "add") {
      if (body.chat !== "-1000000000606") return json({ error: "no such chat", code: "chat_unknown" }, 404);
      (telegramBot.chats as Array<Record<string, unknown>>).push(botChat({ chatId: "-1000000000606", title: "Design review", alias: "atlas-design-reviews", postAllowed: true, postable: true, lastMessageAt: null, storedMessages: 0 }));
      return json({ bot: telegramBot, added: { chat: "atlas-design-reviews", chatId: "-1000000000606" } });
    }
    if (body.action === "test") return json({ bot: telegramBot, tested: { chat: body.chat, sentAt: new Date().toISOString() } });
    return json({ bot: telegramBot });
  }
  if (url.pathname === "/api/telegram/bot") return json({ bot: telegramBot });
  return json({}, 404);
}) as typeof fetch;

if (OVERVIEW_SCENE) {
  /* The Overview is the bare route with no project behind it. */
  localStorage.setItem("llvProject", "__overview__");
} else {
  localStorage.setItem("llvProject", PROJECT);
  if (!location.hash) location.hash = `#p=${PROJECT}`;
}
createRoot(document.getElementById("root")!).render(<Viewer />);
