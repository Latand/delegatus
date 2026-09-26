"use client";

/**
 * The rendered subject of the seat deputy's evidence (docs/design/ghost-seat.md
 * §6, §7): the PRODUCTION `LogFeed` of an orchestrator seat, with the seat's
 * own transcript, the seat's live turn, and the deputies' blocks drawn from
 * their records — over a runtime bus that carries the seat's and each
 * deputy's session, so the live rows are the real `LiveTurnRows`.
 *
 *   ?scenario=running      a deputy streaming beside the seat's own live turn
 *   ?scenario=interleaved  two deputies' blocks with seat rows between them
 *   ?scenario=collapsed    finished blocks collapsed to one line, one timed out
 *
 * The language comes from `llv_lang`. The drivers are the kanban board's
 * («the orchestrator's parallel self», 1440 px) and the phone's (390 px).
 */

import { createRoot } from "react-dom/client";

import { setLocale } from "@/lib/i18n";
import type { SeatDeputyView } from "@/lib/orchestrator/deputyView";
import type { RuntimeLiveTurnItem } from "@/lib/runtime/liveTurn";
import type { RuntimeSession } from "@/lib/runtime/contracts";
import type { FileEntry } from "@/lib/types";

import { LogFeed } from "@/components/LogFeed";
import { setLogFeedDependenciesForTests } from "@/components/logFeedDependencies";
import { emptyStore } from "@/components/runtime/runtimeModel";
import { setRuntimeBusForTests, type RuntimeBusState } from "@/hooks/runtimeBus";

import { setDeputyRecordsFetchForTests } from "./DeputyBlock";

const lang = localStorage.getItem("llv_lang") === "uk" ? "uk" : "en";
setLocale(lang);
const uk = lang === "uk";
const scenario = new URLSearchParams(window.location.search).get("scenario") ?? "running";

const SESSION = "5c2d7e1a-3b4f-\x34c6d-9e8f-1a2b3c4d5e6f";
const at = (minute: number, second = 0) => `2026-09-26T09:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`;
const record = (type: "user" | "assistant", uuid: string, timestamp: string, content: unknown) => JSON.stringify({
  type, uuid, timestamp, sessionId: SESSION,
  message: type === "assistant" ? { id: `msg_${uuid}`, role: "assistant", content } : { role: "user", content },
});
const text = (value: string) => [{ type: "text", text: value }];
const toolUse = (id: string, name: string, input: Record<string, unknown>) => [{ type: "tool_use", id, name, input }];
const toolResult = (uuid: string, timestamp: string, id: string, result: Record<string, unknown>) => JSON.stringify({
  type: "user", uuid, timestamp, sessionId: SESSION,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: JSON.stringify(result) }] }] },
});

/* The seat's own conversation. */
const seatLines = [
  record("user", "s1", at(30), uk ? "Проглянь чергу рев'ю і скажи, що блокує реліз." : "Go through the review queue and tell me what blocks the release."),
  record("assistant", "s2", at(30, 20), text(uk ? "Дивлюся чергу: три лейни на рев'ю, один чекає рішення." : "Reading the queue: three lanes in review, one waiting on a decision.")),
  record("assistant", "s3", at(31), toolUse("seat_call_1", "mcp__viewer__list_pipelines", { state: "open", compact: true })),
  toolResult("s4", at(31, 2), "seat_call_1", { pipelines: [] }),
  record("assistant", "s5", at(33), text(uk ? "Лейн «Вхід через GitHub» чекає на рішення щодо назви гілки." : "The GitHub sign-in lane is waiting on a branch-name decision.")),
  record("assistant", "s6", at(36), text(uk ? "Перевіряю другий лейн: рев'ю ще йде, три зауваження відкриті." : "Checking the second lane: review still running, three findings open.")),
  record("assistant", "s7", at(38), text(uk ? "Третій лейн чистий, його можна мерджити після CI." : "The third lane is clean and can merge once CI is green.")),
];

const ASK_A = uk ? "Додай задачу: рев'юер для #2244, і прив'яжи до лейна" : "Add a task: a reviewer for #2244, and link it to the lane";
const ASK_B = uk ? "Скільки ще лишилось ліміту на акаунті B?" : "How much of account B's limit is left?";

const deputyA: SeatDeputyView = {
  askId: "deputy_a",
  seatConversationId: "conversation_seat",
  deputyConversationId: "conversation_deputy_a",
  ask: { text: ASK_A, images: 0, sender: null, origin: { kind: "operator" } },
  artifactPath: "/workspace/demo/projects/-repo/deputy-a.jsonl",
  forkRecordCount: seatLines.length,
  forkBytes: 8192,
  state: "active",
  startedAt: at(32),
  activatedAt: at(32, 3),
  endedAt: null,
  outcome: null,
  touched: { taskIds: [], pipelineIds: [], conversationIds: [] },
  result: null,
};

const deputyALines = [
  record("user", "a0", at(32, 3), ASK_A),
  record("assistant", "a1", at(32, 12), toolUse("call_a1", "mcp__viewer__create_task", { text: uk ? "Рев'юер для #2244" : "Reviewer for #2244", project: "delegatus" })),
  toolResult("a2", at(32, 14), "call_a1", { taskId: "task_7f3a" }),
];

const deputyAFinished = [
  ...deputyALines,
  record("assistant", "a3", at(32, 20), toolUse("call_a2", "mcp__viewer__link_task_to_pipeline", { taskId: "task_7f3a", pipelineId: "pipeline_2244" })),
  toolResult("a4", at(32, 22), "call_a2", { taskId: "task_7f3a", pipelineId: "pipeline_2244" }),
  record("assistant", "a5", at(32, 30), text(uk ? "Створив задачу «Рев'юер для #2244» і прив'язав її до лейна #2244." : "Created the task «Reviewer for #2244» and linked it to lane #2244.")),
];

const deputyB: SeatDeputyView = {
  ...deputyA,
  askId: "deputy_b",
  deputyConversationId: "conversation_deputy_b",
  ask: { text: ASK_B, images: 0, sender: null, origin: { kind: "operator" } },
  artifactPath: "/workspace/demo/projects/-repo/deputy-b.jsonl",
  startedAt: at(37),
  activatedAt: at(37, 2),
};
const deputyBLines = [
  record("user", "b0", at(37, 2), ASK_B),
  record("assistant", "b1", at(37, 9), toolUse("call_b1", "mcp__viewer__account_limits", {})),
  toolResult("b2", at(37, 11), "call_b1", {}),
];

const done = (deputy: SeatDeputyView, overrides: Partial<SeatDeputyView>): SeatDeputyView => ({ ...deputy, state: "ended", endedAt: at(40), outcome: "done", ...overrides });

const scenarios: Record<string, { deputies: SeatDeputyView[]; records: Record<string, string[]>; live: Record<string, RuntimeLiveTurnItem[]> }> = {
  running: {
    deputies: [deputyA],
    records: { deputy_a: deputyALines },
    live: {
      conversation_deputy_a: [
        { itemId: "live_a_tool", text: "", phase: "awaiting-echo", startedAt: at(32, 20), completedAt: null, tool: { name: "mcp__viewer__link_task_to_pipeline", engine: "claude", status: "run", args: { taskId: "task_7f3a", pipelineId: "pipeline_2244" } } },
        { itemId: "live_a_text", text: uk ? "Створив задачу і прив'язую її до лейна #2244" : "Created the task and I am linking it to lane #2244", phase: "streaming", startedAt: at(32, 25), completedAt: null },
      ],
      conversation_seat: [
        { itemId: "live_seat_text", text: uk ? "Підсумок по черзі: реліз блокує рішення щодо назви гілки" : "Queue summary: the release is blocked on the branch-name decision", phase: "streaming", startedAt: at(39), completedAt: null },
      ],
    },
  },
  interleaved: {
    deputies: [deputyB, done(deputyA, { endedAt: at(33), touched: { taskIds: ["task_7f3a"], pipelineIds: ["pipeline_2244"], conversationIds: [] }, result: { line: uk ? "Створив задачу «Рев'юер для #2244» і прив'язав її до лейна #2244." : "Created the task «Reviewer for #2244» and linked it to lane #2244.", finalText: "" } })],
    records: { deputy_a: deputyAFinished, deputy_b: deputyBLines },
    live: {
      conversation_deputy_b: [
        { itemId: "live_b_text", text: uk ? "Акаунт B: 62 % тижневого вікна використано, скидання в понеділок" : "Account B: 62 % of the weekly window used, it resets on Monday", phase: "streaming", startedAt: at(37, 20), completedAt: null },
      ],
      conversation_seat: [
        { itemId: "live_seat_text", text: uk ? "Підсумок по черзі: реліз блокує рішення щодо назви гілки" : "Queue summary: the release is blocked on the branch-name decision", phase: "streaming", startedAt: at(39), completedAt: null },
      ],
    },
  },
  collapsed: {
    deputies: [
      done(deputyB, { outcome: "timeout", endedAt: at(52), result: { line: uk ? "Читаю ліміти акаунтів…" : "Reading the account limits…", finalText: "" } }),
      done(deputyA, { endedAt: at(33), touched: { taskIds: ["task_7f3a"], pipelineIds: ["pipeline_2244"], conversationIds: [] }, result: { line: uk ? "Створив задачу «Рев'юер для #2244» і прив'язав її до лейна #2244." : "Created the task «Reviewer for #2244» and linked it to lane #2244.", finalText: "" } }),
    ],
    records: { deputy_a: deputyAFinished, deputy_b: deputyBLines },
    live: {},
  },
};

const current = scenarios[scenario] ?? scenarios.running!;

function session(conversationId: string, items: RuntimeLiveTurnItem[]): RuntimeSession {
  return {
    conversationId,
    sessionKey: { engine: "claude", sessionId: conversationId },
    hostKind: "claude-stream-broker",
    host: "hosted",
    turn: "running",
    provenance: "structured",
    revision: 1,
    attentionIds: [],
    recentReceipts: [],
    accountId: null,
    parentConversationId: null,
    flowId: null,
    workflowId: null,
    cwd: "/workspace/demo",
    artifactPath: null,
    capabilities: { steer: false, structuredAttention: true },
    activeTurnId: `turn_${conversationId}`,
    liveTurn: { turnId: `turn_${conversationId}`, text: "", items },
  } as unknown as RuntimeSession;
}

const store = emptyStore();
for (const [conversationId, items] of Object.entries(current.live)) store.sessions[conversationId] = session(conversationId, items);
const state: RuntimeBusState = { store, connection: "live", resyncedAt: null, lastEventAt: null, enabled: true, structuredHostsEnabled: true };
setRuntimeBusForTests({
  getState: () => state,
  subscribe: () => () => undefined,
  subscribeFilesRevision: () => () => undefined,
  start: () => undefined,
  stop: () => undefined,
  refresh: async () => true,
});
setLogFeedDependenciesForTests({
  useLogTail: () => ({
    lines: seatLines, linesStart: 0, size: 1, loading: false, error: null, tickTime: null,
    paused: false, setPaused: () => undefined, clear: () => undefined,
    hasMore: false, loadingOlder: false, loadOlder: async () => 0, prependGen: 0,
  }),
});
setDeputyRecordsFetchForTests(async (askId) => ({ lines: current.records[askId] ?? [], missing: false }));

const seatFile = {
  path: `/workspace/demo/projects/-repo/${SESSION}.jsonl`,
  root: "claude-projects",
  name: `${SESSION}.jsonl`,
  project: "delegatus",
  title: "Orchestrator",
  engine: "claude",
  kind: "session",
  fmt: "claude",
  parent: null,
  mtime: Date.parse(at(39)),
  size: 1,
  activity: "live",
  proc: "running",
  pid: 7,
  model: null,
  pendingQuestion: null,
  waitingInput: null,
  conversationId: "conversation_seat",
} as FileEntry;

createRoot(document.getElementById("root")!).render(
  <main data-deputy-evidence={scenario} className="flex min-h-0 flex-1 flex-col bg-canvas text-primary">
    <LogFeed
      file={seatFile}
      showSvc={false}
      lineFilter=""
      onStatus={() => undefined}
      paused
      follow={false}
      setFollow={() => undefined}
      compact
      deputies={current.deputies}
    />
  </main>,
);
