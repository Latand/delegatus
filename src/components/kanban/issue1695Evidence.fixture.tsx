import { issueReportApprovalDrafts } from "@/lib/issueReports/approvalReply";
import { issueReportPreviewText } from "@/lib/issueReports/previewText";
import type { IssueReportFinding } from "@/lib/issueReports/scrub";
import { enqueueOutbox, OUTBOX_LIMIT, readOutbox, seedLaunchOutbox, updateOutbox } from "@/components/conversation/outbox";
import { DeputyBlock } from "@/components/conversation/DeputyBlock";
import { SeatDeputyChip } from "@/components/orchestrator/SeatDeputyChip";
import type { SeatDeputyView } from "@/lib/orchestrator/deputyView";
import { NativeQueuePanel } from "@/components/NativeQueuePanel";
import { translate } from "@/lib/i18n";
import { taskReferencePrelude } from "@/lib/selection/selectedContext";
import { messageTextDigest } from "@/lib/runtime/messageTextDigest";
import { AgentMappingTable } from "@/components/onboarding/AgentMappingTable";
import { ROLE_DEFAULTS } from "@/lib/roles/defaults";
import { ROLE_VARIANT_DEFAULTS } from "@/lib/roles/paramConfig";
import { RuntimePill } from "@/components/RuntimePill";
import { ResourcesFooter } from "@/components/ResourcesFooter";
import { createRoot } from "react-dom/client";

import { cancelArrivalPulse, startArrivalPulse } from "@/components/attention/arrivalPulse";
import { focusHandoffBus } from "@/components/attention/focusHandoffBus";
import { runFocusTransaction } from "@/components/attention/navigate";
import { asksYouFixtureLines, asksYouFixtureSetting, reportLogFixturePage } from "@/components/orchestrator/reportLog/reportLogEvidence.fixture";
import { writeProfile } from "@/components/runtimeProfile";
import { Viewer } from "@/components/Viewer";
import { orchestratorLinks } from "./orchestratorArrows";
import { orchestratorWireLayers } from "./SeatActionWires";
import { applyBoardMutations, type BoardMutationV1 } from "@/lib/board/mutations";
import { resolvePipelineLinks, resolveTaskLinks, type CachedPullRequest, type FilesWorkLinks, type ForgeCacheView, type ForgeRepositoryView, type ResolvedWorkLinks } from "@/lib/forge/workLinks";
import type { Pipeline } from "@/lib/pipelines/types";
import { ORCHESTRATOR_PROMPT_VERSION, orchestratorMandateForDelivery } from "@/lib/orchestrator/prompt";
import { readTaskHold, storedTaskHold } from "@/lib/tasks/hold";
import { withTaskCompletion } from "@/lib/tasks/completion";
import { admissionSnapshot } from "@/lib/tasks/groupHide";
import { getRuntimeBus } from "@/hooks/runtimeBus";
import { RUNTIME_PLANE_ABSENT } from "@/lib/runtime/flags";
import { prototypeReviewSummary, prototypeRoundsSuperseded } from "@/lib/prototypeReview/model";
import type { PrototypeDeliveryState, PrototypeMediaView, PrototypeReviewSummary, PrototypeRoundView } from "@/lib/prototypeReview/types";
import type { BoardTask, TaskStatus } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import type { BoardProjectStateV1 } from "@/lib/view/types";
import { refreshTeamView } from "@/components/team/teamClient";

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
 * designated. With `?scenario=stages` (K5b) the pipelines scenario also
 * answers the pipeline route: reads, stage prompt overrides and the pipeline
 * actions, with hooks for a refusal, a stage that starts during a save, and
 * a prompt another client saves. With `?scenario=accounts` (K6) the stages
 * scenario also answers the account routes: the accounts and their limits, the
 * project's accounts, a conversation's account switch and a stage's account,
 * with hooks for the migration record, a committed switch, a refusal and a lost
 * answer. With `&icons=1` (#2102) some tasks carry a stored lucide icon, so a
 * board shows stored, suggested and default icons side by side. Every
 * request the Viewer makes is answered here, except the task icons' drawings,
 * which the evidence server reads from lucide itself; nothing reaches a store
 * or a state directory. Driven by the `issue1695*.browser.test.tsx` files.
 */

const SCENARIO = new URLSearchParams(location.search).get("scenario");
/* A task another machine runs (docs/design/synced-task-card.md): four tasks owned by the linked stage
   install, one of them with no lane (an older peer), beside the board's own local ones. The page
   answers nothing about them; the driver serves `/api/links/agents` with this install's id, the host
   and the lanes it publishes. */
const SYNCED = SCENARIO === "synced-task";
const PROJECT = SCENARIO === "linked-agents" || SYNCED ? `repo-${"a".repeat(32)}` : "atlas";
const STAGE_INSTALL = ["22222222", "2222", "4222", "8222", "222222222222"].join("-");
const SELF_UPDATE_RELOAD = new URLSearchParams(location.search).has("self-update-reload");
let presenceAnswers = 0;
/* #2102: stored icons on some tasks; the others draw the title's suggestion or the quiet default. */
const ICONS = new URLSearchParams(location.search).get("icons") === "1";
const EDITING = SCENARIO === "editing";
/* K5a: the pipelines' review stages are bound to review flows with rounds. K5b's Stages build on them. */
/* #1839: the same tier scenario, with the windows arriving the way the provider
   actually files them — under codenamed buckets, one of them carrying the
   provider's own human label and one carrying none. */
const CODENAME_TIERS = SCENARIO === "tier-codename";
const TIER_LIMITS = SCENARIO === "tier-limits" || CODENAME_TIERS;
const ACCOUNTS = SCENARIO === "accounts" || TIER_LIMITS;
/* The orchestrator's long report (#2179): a status answer with a heading,
   lists, a code block and a table, the shape of reply the seat wrapped into a
   narrow ribbon, so its measure can be read beside the operator's bubble. It
   builds on the stages board, which carries the «Not on a task» divider and a
   conversation with no task, for the insets of #2185. */
const AGENT_REPORT = SCENARIO === "agent-report";
/* PR #2530: the seat read a bug report's preview back and offers the replies.
   `many` carries every kind of span a hint quotes, `none` no hint, `long` a
   text several screens tall and `legacy` a preview stored without a judgment. */
const REPORT_PREVIEW = AGENT_REPORT ? new URLSearchParams(location.search).get("report-preview") : null;
const REPORT_PREVIEW_DIGEST = "a".repeat(64);
const reportPreviewLanguage = () => (localStorage.getItem("llv_lang") === "uk" ? "uk" : "en");
const STAGES = SCENARIO === "stages" || ACCOUNTS || AGENT_REPORT;
/* The pipeline block in variant B (#2072 slice 3, docs/design/desktop-flat-cards.md §9):
   the variant renders' cards, with Ukrainian content when the page is uk. */
const FLAT = SCENARIO === "pipeline-block";
const UK = localStorage.getItem("llv_lang") === "uk";
const L = (en: string, uk: string) => (UK ? uk : en);
/* A drag on a full board (the whole-card drag, docs on the smoothness gate): 48 tasks with long
   titles and descriptions over the four columns, a lane with a running stage on every second one. */
const DRAG_BOARD = SCENARIO === "drag-board";
/* The orchestrator's wires (docs/design/orchestrator-arrows.md): the pipelines board, with the seat
   owning some of its lanes. */
const ARROWS = SCENARIO === "orchestrator-arrows";
const PIPELINES = SCENARIO === "pipelines" || STAGES || FLAT || SYNCED || DRAG_BOARD || ARROWS;
/* #1846: `&runtime=structured` answers the runtime snapshot with one structured session, for the running
   verify conversation, so its composer's runtime pill and the board's account chip both draw. */
/* The seat-noise scenario (docs/design/seat-panel-noise.md) seats the orchestrator on a structured host too,
   so the pill draws its structured face. */
const SEAT_NOISE = SCENARIO === "seat-noise";
const NOISE_CASE = new URLSearchParams(location.search).get("case") ?? "i";
/* #2218: `&streaming=1` hosts every working conversation on a structured session and lets the driver push runtime events down the stream (`window.runtimeEmit`), so the board can be measured while agents stream. */
const STREAMING = new URLSearchParams(location.search).get("streaming") === "1";
/* The first-message scenario: a new agent's or seat's first message from the first paint to the transcript. */
const FIRST_MESSAGE = SCENARIO === "first-message";
const FEED_CONTINUITY = SCENARIO === "feed-continuity";
const FEED_FAILURES = SCENARIO === "feed-failures";
/* `&reload=1`: a window opened fresh on a long conversation. The host still
   keeps the replies of the turns it ran, and this window watched none arrive. */
const FEED_RELOAD = FEED_CONTINUITY && new URLSearchParams(location.search).get("reload") === "1";
const reloadReply = (index: number) => L(`Earlier reply ${index + 1}, kept by the host.`, `Раніша відповідь ${index + 1}, яку зберіг хост.`);
let feedContinuityStep = 0;
const continuousAnswer = L("The answer stays here while the transcript catches up.", "Відповідь залишається тут, поки запис розмови наздоганяє її.");
if (FEED_FAILURES) {
  const parse = JSON.parse;
  JSON.parse = function (text, reviver) {
    const value = parse(text, reviver);
    if (value?.fixtureToolArgs) Object.defineProperty(value, "cmd", {
      enumerable: false,
      get() { throw new Error("Fixture record processing failure"); },
    });
    return value;
  };
}
const FEED_RECOVERY = SCENARIO === "feed-recovery";
let feedRecoveryEcho = false;
const delayedLaunchText = L("Keep this message until its transcript arrives.", "Збережи повідомлення до появи запису в розмові.");
const FM_CASE = new URLSearchParams(location.search).get("case") ?? "p";
const STRUCTURED = new URLSearchParams(location.search).get("runtime") === "structured" || SEAT_NOISE || STREAMING || FIRST_MESSAGE || FEED_CONTINUITY;
/* Review round 2 of #1712: a conversation no card holds, whose reader takes the window. */
const LOOSE = SCENARIO === "loose";
/* #1765: one task carrying five pipelines — two running, three completed — so
   a card's rows can be read for what each pipeline actually does. */
/* Columns balanced on large screens: every column holds a card whose
   pipelines name their stages in 5, 20 and 40 characters, on a one-stage
   chain and on Build → Review with a fail loop that fired, beside the task
   carrying five pipelines and a shelf of long-titled cards. */
const BALANCE = SCENARIO === "balance";
/* PR and issue chips: the five pipelines of t-many carry an open PR with two
   issues, a lane with no PR, a merged PR two lanes share, a closed attempt and
   a merged fix, so the card aggregates seven links behind "+N"; the longest
   Inbox title carries an attached draft, so chips are read under the longest
   titles in the narrowest column. */
const WORK_LINKS = SCENARIO === "work-links" || FLAT || SCENARIO === "task-finish";
const MANY = SCENARIO === "issue1765" || BALANCE || WORK_LINKS;
/* #1743: one task whose pipelines exercise the whole identity/edge vocabulary —
   a fail edge fired twice of three, one whose budget is spent, mixed engines,
   all five effort levels, a long uncatalogued model, a stage edited after its
   launch, and a stage that has never started. */
const MARKS = SCENARIO === "issue1743";
/* Model glyphs (docs/design/model-glyphs.md): nine lanes each running one
   model, a draft of the same nine waiting, and the settled states on a few;
   the ninth model is uncatalogued and keeps the dot. */
const GLYPHS = SCENARIO === "model-glyphs";
/* #1865: the header lane the operator read — design → build → critique, where
   design and critique share the architect preset and critique ran twice — so
   each stage's conversation can be read for which stage it is. */
const LABELS = SCENARIO === "issue1865";
/* Readable pipeline graph (docs/design/pipeline-graph-loops.md): lanes whose
   fail edges fold into their sources — two fix stages docked on their
   reviewers, completed with both budgets spent and cut back to Review running
   again; a return over two stages; a retry in place that fired; a completed
   lane whose passed Build conversation took more work; and stage names of 40
   characters. */
const LOOPS = SCENARIO === "graph-loops";
/* The narrow card's stage chain (docs/design/narrow-card-stage-chain.md): lanes
   on the Done and Blocked shelves, which draw the chain vertically, and the
   same operator's lane in the wide Assigned column, which keeps its row. */
const STAGE_CHAIN = SCENARIO === "stage-chain";
/* #1820: the Overview draws the SAME board over every project, filtered to the
   cards a worker is working on right now. Two invented projects join `atlas`
   so the shared columns can be read across three, each bringing one card with
   a worker on it and one with nobody. `issue1820-empty` answers every route
   with nothing, which is the Overview's first run. */
/* `issue1820-quiet` is the same installation with nobody working in it: the
   Overview's most common state, where the board is narrowed to nothing by its
   own permanent filter and no search was ever typed. */
/* #2166: the install before any orchestrator exists. `orchestrator-first` is a
   project created a moment ago (nothing stored, no task, no view chosen), whose
   Board carries the create draft above empty columns; `orchestrator-first-
   overview` is the quiet Overview, which leads with its band. No project has a
   seat in either. */
/* `seat-create-cls`: the same new project, and the seat created from its draft on a clock (the receipt, the
   `spawn:` projection, the scanned transcript), for the layout shifts of creating an orchestrator. */
const SEAT_CLS = SCENARIO === "seat-create-cls";
const ORCH_FIRST = SCENARIO === "orchestrator-first" || SEAT_CLS;
const ORCH_FIRST_OVERVIEW = SCENARIO === "orchestrator-first-overview";
/* The seat case opens as the create draft and leaves it when Confirm is pressed. */
const FM_SEAT = FIRST_MESSAGE && FM_CASE === "s";
const NO_SEAT = ORCH_FIRST || ORCH_FIRST_OVERVIEW || FM_SEAT;
/* #2166 §3.8: the same project a moment after its seat was created, the seat
   live and idle over empty columns, on an install whose onboarding marker has
   never run the interface walk (`&install=existing` marks it an upgrade
   instead). What the walk writes is kept in sessionStorage, so a reload reads
   it back as the server would. */
const ORCH_WALK = SCENARIO === "orchestrator-first-walk";
/* docs/design/orchestrator-reports.md §5.6: the setup guide's optional
   "Reports to Telegram" step over the bot panel's own routes. `bot=none` has
   no bot connected; `bot=fallback` a bot in one chat that accepts posts and
   one it may not post to yet, with the project never having chosen, so its
   reports go to the first; `bot=several` two chats that accept posts and no
   choice, so the step asks; `bot=chosen` one chat chosen in the step;
   `bot=refused` a chat chosen in the step whose posting was switched off
   since, beside another that accepts posts. The chats are invented. */
const TELEGRAM_STEP = SCENARIO === "telegram-reports";
const TELEGRAM_BOT = new URLSearchParams(location.search).get("bot") ?? "none";
const telegramChat = (over: Record<string, unknown>) => ({
  chatId: "-1000000000101", title: "Team Reports", type: "supergroup", username: null, isForum: false, member: true, alias: "team-reports",
  postAllowed: true, postable: true, seesAllMessages: false, readdToApply: false, lastMessageAt: null, lastPostAt: null, lastPostBy: null, storedMessages: 0, ...over,
});
const TELEGRAM_BOT_STATUS = TELEGRAM_BOT === "none"
  ? { connected: false, bot: null, receiving: "stopped", lastUpdateAt: null, lastCheckedAt: null, chats: [], limits: [] }
  : {
    connected: true, bot: { name: "Report Bot", username: "report_test_bot", canReadAllGroupMessages: false, canJoinGroups: true },
    receiving: "polling", lastUpdateAt: null, lastCheckedAt: null, limits: [],
    chats: TELEGRAM_BOT === "several"
      ? [telegramChat({}), telegramChat({ chatId: "-1000000000202", title: "Design Lounge", alias: "design-lounge" })]
      : TELEGRAM_BOT === "refused"
      ? [telegramChat({}), telegramChat({ chatId: "-1000000000202", title: "Design Lounge", alias: "design-lounge", postAllowed: false, postable: false, reports: [{ name: "Atlas", refused: true }] })]
      : [
        /* "unchosen": the bot's one allowed chat, which a project that never
           chose does not report to. */
        telegramChat(TELEGRAM_BOT === "chosen" ? { reports: [{ name: "Atlas" }] } : {}),
        telegramChat({ chatId: "-1000000000202", title: "Design Lounge", alias: null, postAllowed: false, postable: false }),
      ],
  };
const REPORT_TELEGRAM: { chat: string; name: string; changedAt: string; changedBy: string } | null = TELEGRAM_BOT === "chosen"
  ? { chat: "team-reports", name: "Atlas", changedAt: new Date().toISOString(), changedBy: "operator" }
  : TELEGRAM_BOT === "refused" ? { chat: "design-lounge", name: "Atlas", changedAt: new Date().toISOString(), changedBy: "operator" }
  : null;
/* Where the settings route says reports go now (§5.6). */
const REPORT_DESTINATION = TELEGRAM_BOT === "chosen"
  ? { chat: "team-reports", name: "Atlas", source: "chosen" }
  : TELEGRAM_BOT === "refused" ? { chat: "design-lounge", name: "Atlas", source: "chosen" } : null;
/* The «Needs you» filter (docs/design/needs-me-filter.md): one board holding a
   conversation that asks, a lane parked on a decision, a card whose only
   reason was dismissed, and cards that wait on no one. `&nothing=1` answers the
   same cards with nothing waiting, where the funnel is not offered. */
const NEEDS_FILTER = SCENARIO === "needs-filter";
const NEEDS_NOTHING = new URLSearchParams(location.search).get("nothing") === "1";
const OVERVIEW_QUIET = SCENARIO === "issue1820-quiet" || ORCH_FIRST_OVERVIEW;
const OVERVIEW_SCOPE = SCENARIO === "issue1820" || OVERVIEW_QUIET;
const OVERVIEW_EMPTY = SCENARIO === "issue1820-empty";
const LEDGER = "acme-ledger";
const MESH = "river-mesh";
/* #1798: one task carrying the lanes a return arc has to tell apart — a fail
   edge at rest, one that fired once and is carrying the work back right now,
   one whose budget is spent with the last return still in flight, one where
   the spent budget already stopped the lane, and a lane with two fail edges
   into the same stage. */
const ARCS = SCENARIO === "issue1798";
/* #1938: a lane whose review budget ran out and whose last fix wrote a head
   nobody reviewed — parked in needs_review, never completed. */
const REVIEW_SPENT = SCENARIO === "issue1938" || FLAT;
/* #2187 §3.4: one lane parked on a review for each row of the table — stopped
   after the last fix as the pipeline asked, a spent budget that stops before
   fixing, a reviewer that failed again after its last fix round, and an older
   review loop at its round limit — with the words at their longest. */
const REVIEW_STOPS = SCENARIO === "review-stops";
/* #2187 §4.6, §6: a completed lane in each state of its automatic merge —
   waiting for checks, updating from main, merge stopped with its two answers,
   merged by Delegatus — and the project's merge setting in the board's ⋯,
   on by default and off with `&merge=off`. */
const MERGE_STATES = SCENARIO === "merge-states";
/* #2187 §5.3, §6 (mockup D4): a lane marked as finishing its task, running;
   a task whose marked lane merged while a second lane still runs, so its move
   to Done waits; and a Done task its marked lane finished. */
const TASK_FINISH = SCENARIO === "task-finish";
const MERGE_SETTING = { enabled: new URLSearchParams(location.search).get("merge") !== "off" };
/* #2146: the project's Bridge reports switch, off with `?bridge=off`, and the
   report log beside the seat's chat, empty with `?reports=empty`. */
const BRIDGE_SETTING = { enabled: new URLSearchParams(location.search).get("bridge") !== "off" };
const REPORTS_EMPTY = new URLSearchParams(location.search).get("reports") === "empty";
/* "Asks you" (docs/research/attention-classifier.md §7): the switch on, the
   export explorer ended its turn asking the operator, and the seat's report
   log carries that ask and an older one. Every other scene answers the switch
   off. */
const ASKS_YOU = SCENARIO === "asks-you";
const ASKS_YOU_SETTING = { enabled: ASKS_YOU };
/* The seat's header at its fullest: a mandate a version behind the default,
   so the stale chip draws, a designated incumbent with its effort, account and
   a context past the rotation line, twenty previous seats and a running host
   with its Stop host control — every element the row has to keep readable. */
const SEAT_HEAD = SCENARIO === "seat-head";
/* The same seat with its agent not running and its context past the rotation
   line: the status read reports both causes, as data, beside the sentences it
   writes for an agent. */
const SEAT_GONE = SEAT_HEAD && new URLSearchParams(location.search).get("seat") === "gone";
/* The seat holds the Telegram tool and Telegram waits on the operator: the
   status read names the action: `sign_in`, `check` or `restart`. */
const SEAT_TELEGRAM = SEAT_HEAD ? new URLSearchParams(location.search).get("telegram") : null;
/* The seat tick switch in that header and in the phone's seat sheet
   (`&tick=driver`): the driver holds the tick's record and answers the
   settings route, so a drag reads back the way the real route answers. */
const SEAT_TICK_DRIVER = SEAT_HEAD && new URLSearchParams(location.search).get("tick") === "driver";
/* Ghost cards: placeholder tasks no agent will name. A conversation the
   backfill adopted months after it ended, a launch that never produced a
   transcript (the leaked fixture's), a young task whose agent is still at
   work, and a named task whose conversation this board did not load. */
const GHOSTS = SCENARIO === "ghost-tasks";
/* Old cards whose lanes ran for days: an assignment per stage attempt, review
   round and handshake retry, each with the conversation it minted and no path,
   none of them loaded on this board, two of their lanes still the task's own.
   Beside them, a card with launches of its own that did not start: three rows
   from before launches reserved a conversation, and one whose receipt failed. */
const UNSTARTED = SCENARIO === "unstarted-regression";
/* The wall of «conversation outside this board» rows (#2459): a finished task
   whose lanes left nine past attempts and whose orchestrator and helper agents
   linked two dozen more conversations by transcript path, none loaded here; and
   a finished task holding only such conversations. */
const WALL = SCENARIO === "elsewhere-wall";
/* Board order: working cards first, then recently worked, then idle. */
const BOARD_ORDER = SCENARIO === "board-order";
/* Task priority: an Inbox of high, normal and low tasks read in its order,
   one low task with a working agent, and an Assigned column whose priorities
   do not change its order. */
const PRIORITY = SCENARIO === "task-priority";
/** The seat tick's board cards: the standing tick notice and the maintenance
    run cards. Their TEXT is built by the driver with the production builders
    (`seatTickSettingsCardText`, `maintenanceCardText`) and handed over in the
    query, so the board draws what the server would have written. */
const TICK_CARDS = SCENARIO === "seat-tick-cards";
/* Launch layout shifts: the board of `atlas`, a draft opened from the bar, and a launch the page drives end
   to end on a clock — the receipt, the `spawn:` projection, the scanned transcript, tool rows and prose
   arriving while the turn runs, the turn's end. The driver reads every layout shift from the first click to
   the end of the turn. */
const LAUNCH_CLS = SCENARIO === "launch-cls";
/* Creating a new agent (docs/design/new-agent-redesign.md): the board of `atlas`, with what a draft reads
   answered in full — the accounts of each engine, a structured launch that takes images — and a launch
   that runs on the clock of `launch-cls`, held a little longer before its receipt so the frame between the
   press and the receipt can be read. */
const NEW_AGENT = SCENARIO === "new-agent";
/* Five states no single press reaches (`?naseed=`): a handoff draft, restored the way the product restores
   a tab's drafts, continuing the conversation «Worker waiting for a seat»; the same draft when the source's
   folder is on no record; the engine's active account signed out; a launch the server refuses by name; and
   two Copilot accounts to choose between. */
const NEW_AGENT_SEEDS = ["handoff", "handoff-lost", "signed-out", "refused", "copilot"] as const;
const NEW_AGENT_SEED = NEW_AGENT ? NEW_AGENT_SEEDS.find((seed) => seed === new URLSearchParams(location.search).get("naseed")) ?? null : null;
if (NEW_AGENT_SEED === "handoff" || NEW_AGENT_SEED === "handoff-lost") {
  sessionStorage.setItem("llvDrafts:atlas", JSON.stringify(["na-handoff"]));
  sessionStorage.setItem("llvDraftPane:na-handoff:src", "/repo/pending-worker.jsonl");
}
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
/* The approved prototype's stage prompts, behind the wiring token the engine substitutes. */
const PROMPTS: Record<string, string> = {
  "p-upload:plan": "{{task}}\n\nRead the upload path end to end and write the plan: chunk size, resume token, and what the UI must survive.",
  "p-upload:build-api": "{{prev.output}}\n\nImplement the chunked upload endpoint with a resume token. Keep the old endpoint working until the UI switches.",
  "p-upload:review-api": "{{prev.output}}\n\nReview the API diff against the plan. Block on anything that loses a chunk on retry.",
  "p-upload:build-ui": "{{prev.output}}\n\nBuild the progress UI on the new endpoint. A reload must pick the upload up where it stopped.",
  "p-upload:review-ui": "{{prev.output}}\n\nReview the UI diff. Check the reload path and the error states on a 390 px screen.",
  "p-upload:verify": "{{prev.output}}\n\nUpload a 1.2 GB file, kill the tab at 40 %, reopen, and confirm it resumes. Fail with the exact step that broke.",
  "p-upload:docs": "{{prev.output}}\n\nDocument the resume token and the new limits in the API guide.",
  "p-upload:merge": "{{prev.output}}\n\nRebase on main, run the touched tests by path, and merge.",
  "p-links:review": "{{prev.output}}\n\nCheck both anchors against the published notes before approving.",
  "p-search:merge": "{{prev.output}}\n\nMerge once the alias swap is verified under traffic.",
};
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

if (FEED_FAILURES) { searchVer2.engine = "codex"; searchVer2.fmt = "codex"; }
/* `&stage-switch`: the running verify conversation carries its stage membership, as a launched stage does,
   so its runtime pill moves the attempt through the pipeline. */
if (new URLSearchParams(location.search).has("stage-switch")) {
  searchVer2.durableLineage = { kind: "spawn", role: "verifier", parentConversationId: null, reviewsConversationId: null,
    memberships: [{ kind: "pipeline", containerId: "p-search", role: "verifier", slot: "verify", stageId: "verify", stageOrder: 2, round: null, parentConversationId: null }] };
}
/** The runtime snapshot `&runtime=structured` answers: the verify conversation on a structured host, mid-turn. */
let snapshotReads = 0;
function structuredSnapshot() {
  snapshotReads += 1;
  return {
    schemaVersion: 1, snapshotSeq: snapshotReads, retentionFloorSeq: 0, structuredHostsEnabled: true, runtime: { hostEpoch: 1, health: "ready" }, filesRevision: 1,
    sessions: [{
      conversationId: searchVer2.conversationId, sessionKey: { engine: "claude", sessionId: "search-ver-2-session" }, hostKind: "claude-broker", host: "hosted",
      turn: FEED_RELOAD ? "idle" : FEED_CONTINUITY && feedContinuityStep >= 2 ? "unknown" : "running", provenance: "structured", revision: snapshotReads, attentionIds: [], recentReceipts: [], accountId: "default",
      ...(FEED_RELOAD ? { liveTurn: { turnId: "reload-turn", text: "", items: Array.from({ length: 12 }, (_, index) => ({
        itemId: `reload-reply-${index}`, text: reloadReply(index), phase: "awaiting-echo" as const,
        startedAt: iso(7_200 - index * 60), completedAt: iso(7_200 - index * 60),
      })) } } : FEED_CONTINUITY ? { liveTurn: feedContinuityStep === 2 ? null : {
        turnId: "continuity-turn", text: continuousAnswer, items: [{ itemId: feedContinuityStep ? "continuity-answer" : null,
          text: continuousAnswer, phase: feedContinuityStep ? "awaiting-echo" : "streaming",
          startedAt: iso(60), completedAt: feedContinuityStep ? iso(59) : null },
          ...(feedContinuityStep ? Array.from({ length: 9 }, (_, index) => ({
            itemId: `continuity-tool-${index}`, text: "", phase: "awaiting-echo" as const, startedAt: iso(20 - index), completedAt: iso(20 - index),
            tool: { engine: "claude" as const, name: "Bash", args: { command: "pwd" }, status: "ok" as const },
          })) : [])],
      } } : {}),
      parentConversationId: null, flowId: null, workflowId: null, cwd: "/repo", artifactPath: searchVer2.path,
      capabilities: { steer: false, structuredAttention: true }, activeTurnId: "turn-1", pendingReconfigure: null,
    }, ...(SEAT_NOISE || FIRST_MESSAGE ? [{
      conversationId: orchestrator.conversationId, sessionKey: { engine: orchestrator.engine, sessionId: `${orchestrator.name}-session` }, hostKind: orchestrator.engine === "codex" ? "codex-app-server" : "claude-broker", host: "hosted",
      turn: "running", provenance: "structured", revision: 1, attentionIds: [], recentReceipts: [], accountId: "default",
      parentConversationId: null, flowId: null, workflowId: null, cwd: "/repo", artifactPath: orchestrator.path,
      capabilities: { steer: false, structuredAttention: true }, activeTurnId: "turn-1", pendingReconfigure: null,
    }] : []), ...(STREAMING ? files.filter((file) => file.activity === "live" && file.path !== searchVer2.path).map((file) => ({
      conversationId: file.conversationId, sessionKey: { engine: file.engine, sessionId: `${file.name}-session` }, hostKind: "claude-broker", host: "hosted",
      turn: "running", provenance: "structured", revision: 1, attentionIds: [], recentReceipts: [], accountId: "default",
      parentConversationId: null, flowId: null, workflowId: null, cwd: "/repo", artifactPath: file.path,
      capabilities: { steer: false, structuredAttention: true }, activeTurnId: "turn-1", pendingReconfigure: null,
    })) : [])],
    attentions: [], recentOperations: [], edges: [], flows: [], workflows: [], tasks: [], deployments: [],
  };
}
/* t-upload: an eight-stage chain, the UI builder working. */
const uploadPlan = add(conversation("upload-plan", "Plan: 8 MB chunks, resume token per file", { mtime: now - 8 * 60 * MIN }));
const uploadApi = add(conversation("upload-api", "Endpoint and resume token in place", { mtime: now - 6 * 60 * MIN, engine: "codex", model: "gpt-5.6" }));
const uploadRevApi = add(conversation("upload-rev-api", "Round 2 approved", { mtime: now - 4 * 60 * MIN, engine: "codex", model: "gpt-5.6" }));
const uploadUi = add(conversation("upload-ui", "Wiring the resume banner", working({ plan: { current: "Wiring the resume banner" } })));
/* t-export: two plain conversations. */
const exportImpl = add(conversation("export-impl", "Implementer: simplify the export settings", working({ plan: { current: "Writing the preset model" } })));
const exportExplore = add(conversation("export-explore", "Explorer: list every export toggle", { mtime: now - 120 * MIN, engine: "codex", model: "gpt-5.6" }));
const EXPORT_ASK_GIST = "Keep the per-format presets, or fold them into one «Export» button with an advanced drawer?";
if (ASKS_YOU) {
  Object.assign(exportExplore, {
    mtime: now - 7 * MIN,
    lastTurn: { startedAt: (now - 19 * MIN) * 1_000, endedAt: (now - 7 * MIN) * 1_000 },
    lastAssistantMessageAt: (now - 7 * MIN) * 1_000,
    operatorAsk: { id: `ask:${exportExplore.conversationId}:fixture`, messageAt: (now - 7 * MIN) * 1_000, gist: EXPORT_ASK_GIST },
    durableLineage: { kind: "spawn", role: "architect", parentConversationId: null, reviewsConversationId: null, memberships: [] },
  });
}
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
const orchestrator = add(conversation("orchestrator", "Orchestrator for atlas", working({
  plan: { current: "Watching the search fix" },
  ...(SEAT_HEAD ? { model: "claude-opus-4-5-1m", ctx: { usedTokens: 520_825, windowTokens: 1_000_000, pct: 52, confidence: "exact" } } : {}),
})));

/* The seat-panel noise cases (docs/design/seat-panel-noise.md). The launch facts are what the board's
   projection hands the panel: a launch the runtime is still recovering carries no reason, a stopped one
   carries it with `recoveryStopped`. The raw recovery envelope rides in `error` on the pending cases on
   purpose: the chip must not print it whatever the projection did. */
const SEAT_MANDATE = "Keep the project moving. Read the board before every decision, keep every lane owned, and report what changed.";
const SEAT_ENVELOPE = `structured launch recovery: ${JSON.stringify({ phase: "uncertain", startedAt: 1, checks: 2, nextTryAt: 2, reason: "the host has not answered yet" })}`;
const SEAT_LAUNCH_ID = "launch-seat-noise";
const SEAT_TASK_ID = "3f6b1c2e-8d4a-4e75-cf10-5c7d2b9e0f41";
const SEAT_SHELL = "ls -d /workspace/demo/projects/atlas-pipeline-9c1d2e3f && git -C /workspace/demo/projects/atlas-pipeline-9c1d2e3f status --short --branch";
function seatLaunch(over: Record<string, unknown>) {
  return {
    launchId: SEAT_LAUNCH_ID, clientAttemptId: null, accountId: null, conversationId: orchestrator.conversationId, generation: 1,
    state: "reconciling", initialMessage: "queued", retrySafe: false, error: null,
    admittedAt: (now - 90) * 1_000, promptAt: (now - 90) * 1_000, promptImages: 0,
    mandate: { kind: "version", version: 1 }, prompt: SEAT_MANDATE,
    ...over,
  };
}
function seatOn(engine: "claude" | "codex", model: string, effort: string, tag: string) {
  Object.assign(orchestrator, {
    engine, fmt: engine, root: engine === "codex" ? "codex-sessions" : "claude-projects", model, effort,
    conversationId: `conversation_seat_${tag}`, path: `/repo/seat-${tag}.jsonl`, name: `seat-${tag}.jsonl`,
    spawn: undefined, activityReason: undefined, size: 2_048,
  });
}
if (SEAT_NOISE) {
  const launchWindow = (facts: Record<string, unknown>) => Object.assign(orchestrator, {
    path: `spawn:${SEAT_LAUNCH_ID}`, name: `spawn:${SEAT_LAUNCH_ID}`, size: 0, activityReason: "structured_spawn_reconciling", spawn: facts,
  });
  if (NOISE_CASE === "i") { seatOn("claude", "opus", "high", "i"); launchWindow(seatLaunch({ error: SEAT_ENVELOPE })); }
  else if (NOISE_CASE === "ii") seatOn("claude", "opus", "high", "ii");
  else if (NOISE_CASE === "iii") {
    seatOn("claude", "opus", "high", "iii");
    launchWindow(seatLaunch({ state: "failed", initialMessage: "failed", retrySafe: true, recoveryStopped: true, error: "the host has not answered yet" }));
  }
  else if (NOISE_CASE === "iv") seatOn("codex", "gpt-5.6-sol", "low", "iv-old");
  else if (NOISE_CASE === "v") seatOn("codex", "gpt-5.6-sol", "high", "v");
}
/* The first-message cases (p: a plain spawn's prompt, s: a seat's mandate with Confirm pressed, f: a failed launch).
   The raw recovery envelope rides in `error` on every pending step on purpose: the window must not print it. The
   window is the orchestrator's, whose LogFeed is the one every conversation renders. */
const FM_PROMPT = "Fix the failing export test. The pinned task is in the card.";
// A hand-over case deliberately delivers the reply before its provenance.
const FM_HANDOVER = new URLSearchParams(location.search).get("handover");
const FM_ENGINE = new URLSearchParams(location.search).get("engine") === "codex" ? "codex" : "claude";
let releaseFirstMessageEvidence: () => void = () => undefined;
const fmEvidenceGate = new Promise<void>((resolve) => { releaseFirstMessageEvidence = resolve; });
const FM_LAUNCH_ID = "launch-first-message";
const FM_CONVERSATION_ID = "conversation_first_message";
const fmText = () => (FM_SEAT ? SEAT_MANDATE : FM_PROMPT);
// Include the runtime role prefix; the DOM suite composes its resolved role.
const fmDeliveredText = () => FM_HANDOVER
  ? `${ROLE_DEFAULTS.find((role) => role.id === "orchestrator")!.promptScaffold}\n\n${orchestratorMandateForDelivery(fmText())}`
  : fmText();
const fm = { step: 0, confirmed: false, posts: [] as Array<Record<string, unknown>> };
function fmApply() {
  const launch = (over: Record<string, unknown>) => seatLaunch({
    launchId: FM_LAUNCH_ID, conversationId: FM_CONVERSATION_ID, error: SEAT_ENVELOPE, prompt: fmText(), promptEcho: fmText(),
    ...(FM_SEAT ? {} : { mandate: undefined }), ...over,
  });
  const window_ = (facts: Record<string, unknown>) => Object.assign(orchestrator, {
    engine: FM_ENGINE, fmt: FM_ENGINE, root: FM_ENGINE === "codex" ? "codex-sessions" : "claude-projects", model: FM_ENGINE === "codex" ? "gpt-6.1" : "opus", effort: "high", conversationId: FM_CONVERSATION_ID, generation: 1, spawnOrigin: "viewer", launch: undefined,
    path: `spawn:${FM_LAUNCH_ID}`, name: `spawn:${FM_LAUNCH_ID}`, size: 0, activityReason: "structured_spawn_reconciling", spawn: facts,
  });
  /* The scanned row: the server's live-adoption signal is `launch`, the spawn placeholder is gone. */
  const adopted = (facts: Record<string, unknown> | undefined) => Object.assign(orchestrator, {
    path: "/repo/first-message.jsonl", name: "first-message.jsonl", size: 2_048, activityReason: undefined, spawn: undefined, launch: facts,
    lastAssistantMessageAt: fm.step >= (FM_HANDOVER ? 2 : 3) ? (now - 20) * 1_000 : null,
    sessionStartedAt: iso(60), lastTurn: { startedAt: (now - 60) * 1_000, endedAt: null },
  });
  if (FM_CASE === "f") {
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
if (FIRST_MESSAGE && !FM_SEAT) fmApply();
/* K4b: the merge task's implementer, and a spike closed on the board. */
const mergeImpl = EDITING ? add(conversation("merge-impl", "Implementer: merge the queue adapter", { mtime: now - 26 * 60 * MIN })) : null;
const oldSpike = EDITING ? add(conversation("old-spike", "Spike: a virtualized Done column", { mtime: now - 5 * 24 * 60 * MIN })) : null;
/* K4b: the release task's own worker beside the seat. Since #1841 a task that
   holds the seat and nothing else draws no card; this one keeps its card. */
const seatNotes = EDITING ? add(conversation("seat-notes", "Drafting the release notes", { mtime: now - 40 * MIN })) : null;
/* K5a: a helper conversation the search builder brought in, and a review that took five rounds. */
/* #1820's two other projects. Working evidence is the one the board's «N
   working» counter reads: a live transcript whose turn never closed. */
const ledgerBuild = OVERVIEW_SCOPE ? add(conversation("ledger-build", "Reconciling the ledger export", { project: LEDGER, ...working({ plan: { current: "Reconciling the ledger export" } }) })) : null;
const ledgerQuiet = OVERVIEW_SCOPE ? add(conversation("ledger-quiet", "Archived last quarter", { project: LEDGER, mtime: now - 4 * 60 * MIN, lastTurn: { startedAt: (now - 5 * 60 * MIN) * 1_000, endedAt: (now - 4 * 60 * MIN) * 1_000 } })) : null;
const meshAsk = OVERVIEW_SCOPE ? add(conversation("mesh-ask", "Which of the two meshes keeps the old ids?", { project: MESH, engine: "codex", model: "gpt-5.6", mtime: now - 11 * MIN, waitingInput: { since: now - 11 * MIN } })) : null;
const meshQuiet = OVERVIEW_SCOPE ? add(conversation("mesh-quiet", "Wrote the migration notes", { project: MESH, mtime: now - 6 * 60 * MIN })) : null;
/* The left sidebar (docs/design/sidebar-redesign.md): `?rail=few|many` fills the project list with invented
   projects in every state a row has (waiting on the operator, working, quiet, known to the catalog only, crowned,
   archived, a name longer than the row). */
const RAIL = new URLSearchParams(location.search).get("rail");
/* The states a frame of the default list cannot show: `copilot` signs a Copilot account in, `stale` ages the memory
   and Claude readings and fails the Codex read, `empty`, `loading` and `unreachable` are the list's own three notices. */
const RAIL_STATE = RAIL ? new URLSearchParams(location.search).get("railstate") : null;
const railCatalog: { project: string; displayName: string; conversations: number; smt: number }[] = [];
const RAIL_LONG = "northwind-customer-data-platform-migration";
if (RAIL) {
  const named = (project: string, displayName: string, conversations: number, age: number) => railCatalog.push({ project, displayName, conversations, smt: now - age });
  const talk = (id: string, project: string, title: string, over: Record<string, unknown> = {}) => add(conversation(`rail-${id}`, title, { project, projectName: railCatalog.find((entry) => entry.project === project)?.displayName, ...over }));
  named(MESH, "River Mesh", 9, 11 * MIN);
  named(LEDGER, "Acme Ledger", 31, 30);
  named("harbor-docs", "Harbor Docs", 14, 3 * 60 * MIN);
  named(RAIL_LONG, L("Northwind customer data platform migration", "Міграція платформи клієнтських даних Northwind"), 58, 2 * MIN);
  named("paper-kite", "Paper Kite", 12, 6 * 24 * 60 * MIN);
  talk("mesh-ask", MESH, L("Which of the two meshes keeps the old ids?", "Яка з двох сіток зберігає старі ідентифікатори?"), { engine: "codex", model: "gpt-5.6", mtime: now - 11 * MIN, waitingInput: { since: now - 11 * MIN } });
  talk("mesh-quiet", MESH, "Wrote the migration notes", { mtime: now - 6 * 60 * MIN });
  talk("ledger-build", LEDGER, "Reconciling the ledger export", working({ pid: 4_511 }));
  talk("ledger-review", LEDGER, "Reviewing the bank file parser", working({ pid: 4_512, engine: "codex", model: "gpt-5.6" }));
  talk("ledger-ask", LEDGER, L("Ship the export with the rounding fix or without it?", "Випускати експорт з виправленням округлення чи без нього?"), { mtime: now - 4 * MIN, waitingInput: { since: now - 4 * MIN } });
  talk("harbor-quiet", "harbor-docs", "Indexed the handbook", { mtime: now - 3 * 60 * MIN });
  talk("northwind-build", RAIL_LONG, "Copying the customer tables", working({ pid: 4_513, mtime: now - 2 * MIN }));
  if (RAIL === "many") {
    const quiet: [string, string, number, number][] = [
      ["tidal-forecast", "Tidal Forecast", 22, 40 * MIN], ["lantern-api", "Lantern API", 47, 95 * MIN], ["copper-relay", "Copper Relay", 6, 5 * 60 * MIN],
      ["marble-index", "Marble Index", 19, 9 * 60 * MIN], ["delta-sync", "Delta Sync", 103, 26 * 60 * MIN], ["ember-cli", "Ember CLI", 8, 2 * 24 * 60 * MIN],
      ["juniper-mail", "Juniper Mail", 15, 3 * 24 * 60 * MIN], ["slate-board", "Slate Board", 4, 5 * 24 * 60 * MIN], ["willow-auth", "Willow Auth", 27, 8 * 24 * 60 * MIN],
      ["onyx-queue", "Onyx Queue", 11, 12 * 24 * 60 * MIN], ["quiet-orchard", "Quiet Orchard", 3, 20 * 24 * 60 * MIN], ["birch-notes", "Birch Notes", 7, 31 * 24 * 60 * MIN],
    ];
    for (const [project, displayName, conversations, age] of quiet) named(project, displayName, conversations, age);
    talk("tidal-build", "tidal-forecast", "Fitting the harbour gauge model", working({ pid: 4_514, mtime: now - 40 }));
    talk("lantern-ask", "lantern-api", L("Keep the v1 routes for another release?", "Залишити маршрути v1 ще на один випуск?"), { engine: "codex", model: "gpt-5.6", mtime: now - 95 * MIN, waitingInput: { since: now - 95 * MIN } });
    localStorage.setItem("llvArchivedProjects", JSON.stringify(["quiet-orchard", "birch-notes"]));
  } else if (new URLSearchParams(location.search).has("railarchive")) {
    /* `&railarchive`: the short list with two archived projects under it, so the archive fold is inside the frame. */
    named("quiet-orchard", "Quiet Orchard", 3, 20 * 24 * 60 * MIN);
    named("birch-notes", "Birch Notes", 7, 31 * 24 * 60 * MIN);
    localStorage.setItem("llvArchivedProjects", JSON.stringify(["quiet-orchard", "birch-notes"]));
  } else localStorage.removeItem("llvArchivedProjects");
}

const searchHelper = PIPELINES ? add(conversation("search-helper", "Helper: profile the index warm-up", { mtime: now - 50 * MIN })) : null;
const roundsBuild = PIPELINES ? add(conversation("rounds-build", "Builder: rework the retry banner", { mtime: now - 3 * 60 * MIN })) : null;
const roundsReview = PIPELINES ? add(conversation("rounds-review", "Reviewer: fifth pass on the retry banner", working({ plan: { current: "Reading the fifth revision" } }))) : null;
/* K5b: the conversation the release-notes Review gets when it starts during a save. */
const searchRevFirst = STAGES ? add(conversation("search-rev-1", "Round 2 approved", { mtime: now - 120 * MIN, engine: "codex", model: "gpt-5.6" })) : null;
const exportReview = LOOSE ? add(conversation("export-review", "Reviewer: two presets share a name", { mtime: now - 12 * MIN, engine: "codex", model: "gpt-5.6" })) : null;
const linksReview = STAGES ? add(conversation("links-review", "Reviewer: both anchors against the published notes", working({ engine: "codex", model: "gpt-5.6", plan: { current: "Reading the published notes" } }))) : null;

/* #1765: each of the five pipelines on t-many gets its own pair of stages and
   its own conversations, so no row borrows another's identity. */
const manyStages = (critique: string, fix: string) => [stage(critique, "reviewer", fix), stage(fix, "builder", null)];
/* The compact card menu: `&lanes=N` puts N more running pipelines on t-many,
   so the list of a card's pipelines is read past the one page it fits on. */
const MORE_LANES = MANY ? Number(new URLSearchParams(location.search).get("lanes") ?? 0) : 0;
const manyPipelines: Pipeline[] = MANY ? ([
  ["p-many-pills", "Name every pipeline row on a task card", "running", null, ["critique", "fix"]],
  ["p-many-drawers", "Remove the legacy drawers under the board columns", "running", null, ["diagnose", "cut"]],
  ["p-many-pill", "Take the floating waiting pill out of the corner", "completed", 40, ["critique", "fix"]],
  ["p-many-collapse", "Fold the completed pipelines of a task behind their count", "completed", 6 * 60, ["review-plan", "apply"]],
  ["p-many-report", "Read a stage report as role, outcome and age", "completed", 26 * 60, ["critique", "repair"]],
  ...Array.from({ length: MORE_LANES }, (_, index) => [`p-many-more-${index + 1}`, index % 2 ? "Fold the completed pipelines of a task behind their count" : "Remove the legacy drawers under the board columns", "running", null, ["critique", "fix"]] as const),
] as const).map(([id, task, state, closedAgo, [first, second]]) => {
  const opened = add(conversation(`${id}-1`, `Opened ${task}`, { mtime: now - 90 * MIN, engine: "codex", model: "gpt-5.6" }));
  const closing = add(conversation(`${id}-2`, `Finished ${task}`, state === "running"
    ? working({ plan: { current: task } })
    : { mtime: now - 30 * MIN }));
  return pipeline(id, task, "t-many", state, manyStages(first, second), [
    { stageId: first, attempts: [attempt(1, "passed", opened, { startedAt: iso(120 * MIN) })] },
    { stageId: second, attempts: [attempt(1, state === "running" ? "running" : "passed", closing, { startedAt: iso(80 * MIN), activatedBy: { stageId: first, attempt: 1, edge: "pass" } })] },
  ], state === "running" ? { stageId: second, state: "running", input: null, activatedBy: null } : null, {
    closedAt: closedAgo === null ? null : iso(closedAgo * MIN),
    /* The last completed pipeline carries a stage report: role, outcome, age —
       and no conversation id anywhere on the card. */
    /* Its PR (#2150 below) was opened while it ran: a settled lane keeps only
       the head's PRs from its own lifetime (#2059), so it starts before them. */
    ...(id === "p-many-report"
      ? { createdAt: iso(28 * 60 * MIN), stageReports: [{ seq: 1, at: iso(30 * MIN), actor: { kind: "agent", role: "builder", conversationId: closing.conversationId }, stageId: second, attempt: 1, status: "pass", findings: 0, replaces: null, summary: "Read the line as words." }] }
      : {}),
  });
}) : [];

/* #1743. `role()` gives every stage the engine default; these stages name their
   own engine, model and effort, and their attempts record what actually ran. */
const runRole = (roleId: string, engine: string, model: string, effort: string) =>
  ({ roleId, engine, model, effort, access: "read-write", promptScaffold: null });
const marksStage = (id: string, roleId: string, next: string | null, engine: string, model: string, effort: string, over: Record<string, unknown> = {}) =>
  stage(id, roleId, next, { effectiveRole: runRole(roleId, engine, model, effort), ...over });

const marksPipelines: Pipeline[] = MARKS ? (() => {
  const conv = (id: string, title: string, over: Record<string, unknown> = {}) => add(conversation(id, title, over));
  const plan = conv("marks-plan", "Plan the retry banner", { mtime: now - 300 * MIN, model: "fable" });
  const build1 = conv("marks-build-1", "First pass at the banner", { mtime: now - 260 * MIN, model: "sonnet" });
  const build2 = conv("marks-build-2", "Second pass after the first critique", { mtime: now - 180 * MIN, model: "sonnet" });
  const build3 = conv("marks-build-3", "Third pass after the second critique", working({ model: "sonnet", plan: { current: "Rewriting the banner copy" } }));
  const crit1 = conv("marks-crit-1", "Sent it back: the banner hides the retry", { mtime: now - 220 * MIN });
  const crit2 = conv("marks-crit-2", "Sent it back again: still no count", { mtime: now - 140 * MIN });
  const spentBuild = conv("marks-spent-build", "Reworked the limit notice", { mtime: now - 90 * MIN });
  const spentRev = conv("marks-spent-rev", "Out of returns", { mtime: now - 40 * MIN, engine: "codex", model: "gpt-6-astra" });
  return [
    /* The fail edge fired twice of three: a circled 2 on the arrow, one return left. */
    pipeline("p-marks", "Rework the retry banner until the critique passes", "t-marks", "running", [
      marksStage("plan", "architect", "build", "claude", "fable", "low"),
      /* Edited to Codex after it last ran on Claude: the node keeps the launched
         values and marks that the next attempt differs. */
      marksStage("build", "builder", "critique", "codex", "gpt-5.6-terra", "medium"),
      marksStage("critique", "architect", "verify", "claude", "opus", "high", { onFail: { to: "build", maxRounds: 3 } }),
      marksStage("verify", "verifier", "ship", "codex", "gpt-6-astra", "xhigh"),
      /* Never started: its configuration reads as configuration, muted. */
      marksStage("ship", "cleaner", null, "claude", "claude-opus-5-20260101-preview", "max"),
    ], [
      { stageId: "plan", attempts: [attempt(1, "passed", plan, { effectiveRole: runRole("architect", "claude", "fable", "low"), startedAt: iso(300 * MIN) })] },
      { stageId: "build", attempts: [
        attempt(1, "passed", build1, { effectiveRole: runRole("builder", "claude", "sonnet", "medium"), startedAt: iso(260 * MIN), activatedBy: { stageId: "plan", attempt: 1, edge: "pass" } }),
        attempt(2, "passed", build2, { effectiveRole: runRole("builder", "claude", "sonnet", "medium"), startedAt: iso(200 * MIN), activatedBy: { stageId: "critique", attempt: 1, edge: "fail" } }),
        attempt(3, "running", build3, { effectiveRole: runRole("builder", "claude", "sonnet", "medium"), startedAt: iso(120 * MIN), activatedBy: { stageId: "critique", attempt: 2, edge: "fail" } }),
      ] },
      { stageId: "critique", attempts: [
        attempt(1, "failed", crit1, { effectiveRole: runRole("architect", "claude", "opus", "high"), startedAt: iso(220 * MIN), activatedBy: { stageId: "build", attempt: 1, edge: "pass" } }),
        attempt(2, "failed", crit2, { effectiveRole: runRole("architect", "claude", "opus", "high"), startedAt: iso(140 * MIN), activatedBy: { stageId: "build", attempt: 2, edge: "pass" } }),
      ] },
    ], { stageId: "build", state: "running", input: null, activatedBy: null }),
    /* The same edge with nothing left: two of two used, drawn as exhausted. */
    pipeline("p-marks-spent", "Show the account limit reset on the card", "t-marks", "running", [
      marksStage("fix", "builder", "review", "claude", "opus", "max"),
      marksStage("review", "verifier", null, "codex", "gpt-6-astra", "xhigh", { onFail: { to: "fix", maxRounds: 2 } }),
    ], [
      { stageId: "fix", attempts: [
        attempt(1, "passed", spentBuild, { effectiveRole: runRole("builder", "claude", "opus", "max"), startedAt: iso(90 * MIN) }),
        attempt(2, "passed", spentBuild, { effectiveRole: runRole("builder", "claude", "opus", "max"), startedAt: iso(70 * MIN), activatedBy: { stageId: "review", attempt: 1, edge: "fail" } }),
        attempt(3, "running", spentBuild, { effectiveRole: runRole("builder", "claude", "opus", "max"), startedAt: iso(50 * MIN), activatedBy: { stageId: "review", attempt: 2, edge: "fail" } }),
      ] },
      { stageId: "review", attempts: [
        attempt(1, "failed", spentRev, { effectiveRole: runRole("verifier", "codex", "gpt-6-astra", "xhigh"), startedAt: iso(80 * MIN), activatedBy: { stageId: "fix", attempt: 1, edge: "pass" } }),
        attempt(2, "failed", spentRev, { effectiveRole: runRole("verifier", "codex", "gpt-6-astra", "xhigh"), startedAt: iso(60 * MIN), activatedBy: { stageId: "fix", attempt: 2, edge: "pass" } }),
      ] },
    ], { stageId: "fix", state: "running", input: null, activatedBy: null }),
  ];
})() : [];

/* One stage per model, each named by the role it plays, as a real lane names
   it ("Design", "Build"), so the glyph is the only thing on a pill that says
   which model runs it. Stage ids are unique across the nine, so one draft can
   hold them all. [stage id, model kind, role, engine, model, lane title]. */
const GLYPH_MODELS = [
  ["design", "opus", "architect", "claude", "opus", L("Lay out the export dialog", "Спроєктувати діалог експорту")],
  ["build", "fable", "builder", "claude", "fable", L("Build the export dialog", "Зібрати діалог експорту")],
  ["docs", "sonnet", "builder", "claude", "sonnet", L("Write the export guide", "Написати посібник з експорту")],
  ["tidy", "haiku", "cleaner", "claude", "haiku", L("Tidy the export module", "Прибрати модуль експорту")],
  ["verify", "sol", "verifier", "codex", "gpt-6-sol", L("Verify the export on a large board", "Перевірити експорт на великій дошці")],
  ["critique", "astra", "architect", "codex", "gpt-6-astra", L("Critique the export flow", "Покритикувати процес експорту")],
  ["migrate", "terra", "builder", "codex", "gpt-5.6-terra", L("Migrate the saved exports", "Перенести збережені експорти")],
  ["test", "luna", "verifier", "codex", "gpt-6-luna", L("Test the export on a phone", "Протестувати експорт на телефоні")],
  ["fix", "other-model", "builder", "codex", "gpt-5.5", L("Fix the export's file name", "Виправити назву файлу експорту")],
] as const;
const glyphPipelines: Pipeline[] = GLYPHS ? (() => {
  type Entry = (typeof GLYPH_MODELS)[number];
  const entry = (id: string) => GLYPH_MODELS.find(([stageId]) => stageId === id)!;
  const chain = (models: ReadonlyArray<Entry>) => models.map(([id, , roleId, engine, model], index) =>
    marksStage(id, roleId, models[index + 1]?.[0] ?? null, engine, model, "high"));
  const ran = (id: string, state: string, ago: number, over: Record<string, unknown> = {}, file: FileEntry | null = null) => {
    const [, , roleId, engine, model] = entry(id);
    return { stageId: id, attempts: [attempt(1, state, file, { effectiveRole: runRole(roleId, engine, model, "high"), startedAt: iso(ago * MIN), ...over })] };
  };
  const done = (ago: number) => ({ completedAt: iso((ago - 6) * MIN) });
  const lane = (ids: string[]) => chain(ids.map(entry));
  return [
    /* Every model at work: a lane runs one stage at a time, so one lane each. */
    ...GLYPH_MODELS.map((model, index) => {
      const [id, , , , , title] = model;
      return pipeline(`p-glyph-${model[1]}`, title, "t-glyphs-run", "running", chain([model]),
        [ran(id, "running", 30 - index)], { stageId: id, state: "running", input: null, activatedBy: null }, { createdAt: iso((40 - index) * MIN) });
    }),
    /* A draft: nine stages configured, none started, each waiting on its model. */
    pipeline("p-glyphs-wait", L("Plan the export release", "Спланувати випуск експорту"), "t-glyphs", "draft", chain(GLYPH_MODELS),
      [], { stageId: "design", state: "pending", input: null, activatedBy: null }, { createdAt: iso(20 * MIN) }),
    /* Passed, passed, failed, waiting on the operator, not yet run. */
    pipeline("p-glyphs-settled", L("Ship the export dialog", "Випустити діалог експорту"), "t-glyphs", "needs_decision", lane(["design", "build", "critique", "verify", "tidy"]),
      [ran("design", "passed", 90, done(90)), ran("build", "passed", 70, done(70)), ran("critique", "failed", 50, done(50)), ran("verify", "needs_decision", 30)],
      { stageId: "verify", state: "needs_decision", input: null, activatedBy: null }, { createdAt: iso(100 * MIN) }),
    /* The other four models settled, the round ones among them: passed, passed,
       passed, failed, and the uncatalogued model not yet run. The lane waits on
       the operator after the failure. */
    pipeline("p-glyphs-settled-more", L("Ship the export guide", "Випустити посібник з експорту"), "t-glyphs", "needs_decision", lane(["docs", "tidy", "migrate", "test", "fix"]),
      [ran("docs", "passed", 120, done(120)), ran("tidy", "passed", 100, done(100)), ran("migrate", "passed", 80, done(80)), ran("test", "failed", 60, done(60))],
      { stageId: "test", state: "needs_decision", input: null, activatedBy: null }, { createdAt: iso(130 * MIN) }),
    /* The live states the old dot told apart by colour: a review stage at work,
       a stage landing its commit, and a passed stage whose conversation works again. */
    pipeline("p-glyphs-review", L("Review the export dialog", "Переглянути діалог експорту"), "t-glyphs-live", "running", [
      marksStage("build", "builder", "review", "claude", "fable", "high"),
      marksStage("review", "reviewer", null, "codex", "gpt-6-astra", "high"),
    ], [
      ran("build", "passed", 40, done(40)),
      { stageId: "review", attempts: [attempt(1, "running", null, { effectiveRole: runRole("reviewer", "codex", "gpt-6-astra", "high"), startedAt: iso(20 * MIN) })] },
    ], { stageId: "review", state: "reviewing", input: null, activatedBy: null }, { createdAt: iso(50 * MIN) }),
    pipeline("p-glyphs-commit", L("Land the saved-export migration", "Завершити перенесення збережених експортів"), "t-glyphs-live", "running", lane(["migrate"]),
      [ran("migrate", "committing", 12)], { stageId: "migrate", state: "committing", input: null, activatedBy: null }, { createdAt: iso(30 * MIN) }),
    pipeline("p-glyphs-rework", L("Polish the export guide", "Відшліфувати посібник з експорту"), "t-glyphs-live", "running", lane(["design", "docs", "critique"]), [
      ran("design", "passed", 120, done(120)),
      /* Docs passed, and its conversation took more work after it did (#1744). */
      ran("docs", "passed", 100, done(100), add(conversation("glyphs-rework-docs", "Reworking the export guide", { model: "sonnet", ...working() }))),
      ran("critique", "running", 60),
    ], { stageId: "critique", state: "running", input: null, activatedBy: null }, { createdAt: iso(130 * MIN) }),
  ];
})() : [];

const loopsPipelines: Pipeline[] = LOOPS ? (() => {
  const conv = (id: string, title: string, ago: number, over: Record<string, unknown> = {}) => add(conversation(id, title, { mtime: now - ago * MIN, ...over }));
  const failVia = (stageId: string, n: number, budgetSpent = false) => ({ activatedBy: { stageId, attempt: n, edge: "fail", ...(budgetSpent ? { budgetSpent: true } : {}) } });
  const passVia = (stageId: string, n: number) => ({ activatedBy: { stageId, attempt: n, edge: "pass" } });
  const done = (at: number) => ({ startedAt: iso(at * MIN), completedAt: iso((at - 6) * MIN) });
  /* Design → Build → Critique → Review, each reviewer with its own fix stage. */
  const docks = (names: { design: string; build: string; critique: string; critiqueFix: string; review: string; reviewFix: string }) => [
    stage(names.design, "architect", names.build),
    stage(names.build, "builder", names.critique),
    stage(names.critique, "architect", names.review, { onFail: { to: names.critiqueFix, maxRounds: 2 } }),
    stage(names.critiqueFix, "builder", names.critique),
    stage(names.review, "reviewer", null, { kind: "run", onFail: { to: names.reviewFix, maxRounds: 3 } }),
    stage(names.reviewFix, "builder", names.review),
  ];
  const short = { design: "design", build: "build", critique: "critique", critiqueFix: "critique-fix", review: "review", reviewFix: "review-fix" };
  /* The first half every docked lane shares: Critique failed twice, and its
     second fix handed its findings on past the spent budget. */
  const firstHalf = (key: string, names: typeof short, from: number) => [
    { stageId: names.design, attempts: [attempt(1, "passed", conv(`${key}-design`, "Wrote the plan", from), done(from))] },
    { stageId: names.build, attempts: [attempt(1, "passed", conv(`${key}-build`, "Built the first pass", from - 10), { ...done(from - 10), ...passVia(names.design, 1) })] },
    { stageId: names.critique, attempts: [
      attempt(1, "failed", conv(`${key}-crit-1`, "Sent it back: the count hides", from - 20), { ...done(from - 20), ...passVia(names.build, 1) }),
      attempt(2, "failed", conv(`${key}-crit-2`, "Sent it back again", from - 40), { ...done(from - 40), ...passVia(names.critiqueFix, 1) }),
    ] },
    { stageId: names.critiqueFix, attempts: [
      attempt(1, "passed", conv(`${key}-cfix-1`, "Moved the count out", from - 30), { ...done(from - 30), ...failVia(names.critique, 1) }),
      attempt(2, "passed", conv(`${key}-cfix-2`, "Took the last findings", from - 50), { ...done(from - 50), ...failVia(names.critique, 2, true) }),
    ] },
  ];
  const reviews = (key: string, names: typeof short, from: number, count: number, lastRunning: boolean) => Array.from({ length: count }, (_, index) => {
    const running = lastRunning && index === count - 1;
    const file = conv(`${key}-rev-${index + 1}`, running ? "Reading the third revision" : "Sent it back", from - index * 20, running ? working() : {});
    return attempt(index + 1, running ? "running" : "failed", file, { ...(running ? { startedAt: iso((from - index * 20) * MIN) } : done(from - index * 20)), ...(index ? passVia(names.reviewFix, index) : passVia(names.critiqueFix, 2)) });
  });
  const fixes = (key: string, names: typeof short, from: number, count: number, spentLast: boolean) => Array.from({ length: count }, (_, index) =>
    attempt(index + 1, "passed", conv(`${key}-rfix-${index + 1}`, "Fixed the review's findings", from - index * 20), { ...done(from - index * 20), ...failVia(names.review, index + 1, spentLast && index === count - 1) }));
  const long = {
    design: "design-the-export-for-every-old-format",
    build: "build-the-export-writer-and-its-presets",
    critique: "critique-the-export-against-the-old-files",
    critiqueFix: "fix-what-the-export-critique-found-there",
    review: "review-the-export-writer-and-its-presets",
    reviewFix: "fix-what-the-export-review-found-in-there",
  };
  return [
    pipeline("p-loops-done", L("Show a spent review budget on the lane", "Показати вичерпаний бюджет рев’ю на лінії"), "t-loops-done", "completed", docks(short), [
      ...firstHalf("loops-done", short, 400),
      { stageId: "review", attempts: reviews("loops-done", short, 340, 3, false) },
      { stageId: "review-fix", attempts: fixes("loops-done", short, 330, 3, true) },
    ], null, { closedAt: iso(270 * MIN) }),
    pipeline("p-loops-review", L("Show a spent review budget on the lane, again", "Показати вичерпаний бюджет рев’ю, знову"), "t-loops-review", "running", docks(short), [
      ...firstHalf("loops-review", short, 200),
      { stageId: "review", attempts: reviews("loops-review", short, 140, 2, true) },
      { stageId: "review-fix", attempts: fixes("loops-review", short, 130, 1, false) },
    ], { stageId: "review", state: "running", input: null, ...passVia("review-fix", 1) }),
    pipeline("p-loops-return", L("Resume an upload after a reload", "Продовжити вивантаження після перезавантаження"), "t-loops-return", "running", [
      stage("plan", "architect", "build"),
      stage("build", "builder", "critique"),
      stage("critique", "architect", "review"),
      stage("review", "reviewer", null, { kind: "run", onFail: { to: "build", maxRounds: 2 } }),
    ], [
      { stageId: "plan", attempts: [attempt(1, "passed", conv("loops-return-plan", "Planned the resume token", 160), done(160))] },
      { stageId: "build", attempts: [
        attempt(1, "passed", conv("loops-return-build-1", "Built the resume token", 140), { ...done(140), ...passVia("plan", 1) }),
        attempt(2, "running", conv("loops-return-build-2", "Keeping the token across a reload", 20, working()), { startedAt: iso(20 * MIN), ...failVia("review", 1) }),
      ] },
      { stageId: "critique", attempts: [attempt(1, "passed", conv("loops-return-crit", "The plan holds", 110), { ...done(110), ...passVia("build", 1) })] },
      { stageId: "review", attempts: [attempt(1, "failed", conv("loops-return-rev", "A reload loses the token", 80), { ...done(80), ...passVia("critique", 1) })] },
    ], { stageId: "build", state: "running", input: null, ...failVia("review", 1) }),
    pipeline("p-loops-retry", L("Migrate the ledger to the new schema", "Перенести реєстр на нову схему"), "t-loops-retry", "running", [
      stage("prepare", "architect", "migrate"),
      stage("migrate", "builder", "verify", { onFail: { to: "migrate", maxRounds: 3 } }),
      stage("verify", "verifier", null),
    ], [
      { stageId: "prepare", attempts: [attempt(1, "passed", conv("loops-retry-prep", "Wrote the migration plan", 90), done(90))] },
      { stageId: "migrate", attempts: [
        attempt(1, "failed", conv("loops-retry-mig-1", "The lock timed out", 60), { ...done(60), ...passVia("prepare", 1) }),
        attempt(2, "running", conv("loops-retry-mig-2", "Migrating in batches", 10, working()), { startedAt: iso(10 * MIN), ...failVia("migrate", 1) }),
      ] },
    ], { stageId: "migrate", state: "running", input: null, ...failVia("migrate", 1) }),
    pipeline("p-loops-rework", L("Keep the draft when the tab closes", "Зберегти чернетку, коли вкладку закрито"), "t-loops-rework", "completed", [
      stage("build", "builder", "critique"),
      stage("critique", "architect", null, { onFail: { to: "critique-fix", maxRounds: 1 } }),
      stage("critique-fix", "builder", "critique"),
    ], [
      /* The Build conversation took more work after the lane completed (#1744). */
      { stageId: "build", attempts: [attempt(1, "passed", conv("loops-rework-build", "Reworking the draft store", 1, working()), done(120))] },
      { stageId: "critique", attempts: [
        attempt(1, "failed", conv("loops-rework-crit-1", "The draft is lost on close", 100), { ...done(100), ...passVia("build", 1) }),
        attempt(2, "passed", conv("loops-rework-crit-2", "Approved", 60), { ...done(60), ...passVia("critique-fix", 1) }),
      ] },
      { stageId: "critique-fix", attempts: [attempt(1, "passed", conv("loops-rework-fix", "Saved the draft on close", 80), { ...done(80), ...failVia("critique", 1) })] },
    ], null, { closedAt: iso(50 * MIN) }),
    pipeline("p-loops-long", L("Export every old format the importer reads", "Експортувати кожен старий формат, який читає імпорт"), "t-loops-long", "running", docks(long), [
      ...firstHalf("loops-long", long, 200),
      { stageId: long.review, attempts: reviews("loops-long", long, 140, 2, false) },
      { stageId: long.reviewFix, attempts: [
        attempt(1, "passed", conv("loops-long-rfix-1", "Fixed the review's findings", 130), { ...done(130), ...failVia(long.review, 1) }),
        attempt(2, "running", conv("loops-long-rfix-2", "Fixing the presets", 5, working()), { startedAt: iso(5 * MIN), ...failVia(long.review, 2) }),
      ] },
    ], { stageId: long.reviewFix, state: "running", input: null, ...failVia(long.review, 2) }),
  ];
})() : [];

/* #1798. Six lanes on one card, each with the fail edge in one state, so the
   arcs under the rows can be read side by side at any width: at rest, fired
   once with the returned stage running because of it, a spent budget, a lane
   the spent budget stopped, and two edges into one target. Their stages are
   short on purpose — the row of a real card is 220-264 px wide, and the
   one-line row with its arcs has to be readable in the same frame. The sixth
   is the length a real lane usually has, four stages, and wraps everywhere the
   board is not a 1920 px screen: that is the row the suffix is drawn on, and
   it is the common case rather than the narrow one. */
const REVIEWED_HEAD = "4f1c2a9d3b7e6f5a8c0d1e2f3a4b5c6d7e8f9a0b";
const UNREVIEWED_HEAD = "9b2e7d4c1a0f3e6d5c8b7a6f9e0d1c2b3a4f5e6d";
const reviewSpentPipelines: Pipeline[] = REVIEW_SPENT ? (() => {
  const build1 = add(conversation("review-build-1", "First pass at the retry count", { mtime: now - 90 * MIN }));
  const critique = add(conversation("review-crit-1", "Sent it back: the count hides behind the close button", { mtime: now - 60 * MIN, engine: "codex", model: "gpt-5.6" }));
  const build2 = add(conversation("review-build-2", "Moved the count out from under the close button", { mtime: now - 20 * MIN }));
  const findings = ["P1 — the count hides behind the close button", "P2 — the banner never says which attempt failed"];
  return [pipeline("p-review-spent", "Show the retry count in the banner", "t-review-spent", "needs_review",
    [stage("build", "builder", "critique"), stage("critique", "reviewer", null, { kind: "run", onFail: { to: "build", maxRounds: 1 } })],
    [
      { stageId: "build", attempts: [
        attempt(1, "passed", build1, { startedAt: iso(100 * MIN), completedAt: iso(90 * MIN) }),
        attempt(2, "passed", build2, { startedAt: iso(55 * MIN), completedAt: iso(20 * MIN), activatedBy: { stageId: "critique", attempt: 1, edge: "fail", budgetSpent: true } }),
      ] },
      { stageId: "critique", attempts: [
        attempt(1, "failed", critique, { startedAt: iso(85 * MIN), completedAt: iso(60 * MIN), activatedBy: { stageId: "build", attempt: 1, edge: "pass" }, verdict: { status: "fail", findings }, budgetSpent: true, reviewedHead: REVIEWED_HEAD }),
      ] },
    ], null, {
      lastPassedCommit: UNREVIEWED_HEAD,
      stateDetail: "review budget spent: last review failed (fail, 2 findings), head 9b2e7d4c1a0f unreviewed; reviewed 4f1c2a9d3b7e. continue-review adds rounds",
      reviewPending: { stageId: "critique", attempt: 1, fixStageId: "build", fixAttempt: 2, reviewedHead: REVIEWED_HEAD, currentHead: UNREVIEWED_HEAD, verdict: "fail", findings: findings.length, at: iso(20 * MIN) },
    })];
})() : [];

const reviewStopPipelines: Pipeline[] = REVIEW_STOPS ? (() => {
  const readOnly = { ...role("reviewer", "codex"), access: "read-only" };
  const reviewer = (next: string | null, onFail: Record<string, unknown> | null, over: Record<string, unknown> = {}) =>
    stage("review", "reviewer", next, { kind: "run", onFail, effectiveRole: readOnly, ...over });
  const conv = (id: string, title: string, ago: number, over: Record<string, unknown> = {}) => add(conversation(id, title, { mtime: now - ago, ...over }));
  const fail = (text: string) => ({ status: "fail", findings: [text] });
  const pass = { status: "pass", findings: [] };
  const builds = (key: string, count: number, activations: Array<Record<string, unknown> | null>, from: number) => Array.from({ length: count }, (_, index) => {
    const at = from - index * 30 * MIN;
    return attempt(index + 1, "passed", conv(`stop-${key}-build-${index + 1}`, `Build pass ${index + 1}`, at - 10 * MIN), { startedAt: iso(at), completedAt: iso(at - 10 * MIN), verdict: pass, activatedBy: activations[index] ?? null });
  });
  const reviews = (key: string, texts: string[], from: number, over: Record<string, unknown> = {}) => texts.map((text, index) => {
    const at = from - index * 30 * MIN;
    return attempt(index + 1, "failed", conv(`stop-${key}-review-${index + 1}`, `Review pass ${index + 1}`, at - 10 * MIN, { engine: "codex", model: "gpt-6-astra" }), {
      effectiveRole: readOnly, startedAt: iso(at), completedAt: iso(at - 10 * MIN), verdict: fail(text), activatedBy: { stageId: "build", attempt: index + 1, edge: "pass" }, ...over,
    });
  });
  const pillFinding = L("P2 — The Model pill cuts its name at 360 px when two accounts are on.", "P2 — Кнопка «Модель» обрізає назву на 360 px, коли увімкнено два акаунти.");
  const captureFinding = L("P2 — capture --stage does not take the stage address from the project config.", "P2 — capture --stage не бере адресу стейджу з конфігу проєкту.");
  const parkDetail = `fail-edge budget exhausted after 2 round(s) (onExhausted: park): ${captureFinding}`;
  const onceDetail = `fail-edge budget exhausted after 1 round(s) (onExhausted: advance): ${pillFinding}`;
  return [
    /* Row 1: stop-after-fix. The last fix landed and the pipeline asked to wait. */
    pipeline("p-stop-fix", L("Composer model pills: one width at 390", "Кнопки моделі в композері: одна ширина на 390"), "t-stop-fix", "needs_review",
      [stage("build", "builder", "review"), reviewer(null, { to: "build", maxRounds: 2, onExhausted: "stop-after-fix" })],
      [
        { stageId: "build", attempts: builds("fix", 3, [null, { stageId: "review", attempt: 1, edge: "fail" }, { stageId: "review", attempt: 2, edge: "fail", budgetSpent: true }], 110 * MIN) },
        { stageId: "review", attempts: reviews("fix", [pillFinding, pillFinding], 95 * MIN, { reviewedHead: REVIEWED_HEAD }).map((entry, index) => (index === 1 ? { ...entry, budgetSpent: true } : entry)) },
      ], null, {
        lastPassedCommit: UNREVIEWED_HEAD,
        stateDetail: "review budget spent (onExhausted: stop-after-fix): last review failed (fail, 1 finding), head 9b2e7d4c1a0f unreviewed; reviewed 4f1c2a9d3b7e. continue-review adds rounds",
        reviewPending: { stageId: "review", attempt: 2, fixStageId: "build", fixAttempt: 3, reviewedHead: REVIEWED_HEAD, currentHead: UNREVIEWED_HEAD, verdict: "fail", findings: 1, at: iso(12 * MIN) },
      }),
    /* Row 2: park. The last of three review rounds failed; the edge stops before fixing. */
    pipeline("p-stop-park", L("Per-feature screenshot catalog and one capture command", "Каталог скриншотів по фічах і одна команда зйомки"), "t-stop-park", "needs_decision",
      [stage("build", "builder", "review"), reviewer(null, { to: "build", maxRounds: 2, onExhausted: "park" })],
      [
        { stageId: "build", attempts: builds("park", 3, [null, { stageId: "review", attempt: 1, edge: "fail" }, { stageId: "review", attempt: 2, edge: "fail" }], 130 * MIN) },
        { stageId: "review", attempts: reviews("park", [captureFinding, captureFinding, captureFinding], 115 * MIN).map((entry, index) => (index === 2 ? { ...entry, error: parkDetail } : entry)) },
      ], { stageId: "review", state: "running", input: null, activatedBy: { stageId: "build", attempt: 3, edge: "pass" } }, { stateDetail: parkDetail }),
    /* Row 3: the once-per-stage rule. Verify sent the work back through the
       review, which had already handed its last findings on, and it failed again. */
    pipeline("p-stop-once", L("Deploy failure notifies the seat and the phone", "Невдалий деплой сповіщає сесію і телефон"), "t-stop-once", "needs_decision",
      [stage("build", "builder", "review"), reviewer("verify", { to: "build", maxRounds: 1 }), stage("verify", "verifier", null, { onFail: { to: "build", maxRounds: 1 } })],
      [
        { stageId: "build", attempts: builds("once", 3, [null, { stageId: "review", attempt: 1, edge: "fail", budgetSpent: true }, { stageId: "verify", attempt: 1, edge: "fail" }], 160 * MIN) },
        { stageId: "review", attempts: reviews("once", [pillFinding, pillFinding], 145 * MIN).map((entry, index) => (index === 0
          ? { ...entry, budgetSpent: true }
          : { ...entry, error: onceDetail, startedAt: iso(40 * MIN), completedAt: iso(30 * MIN), activatedBy: { stageId: "build", attempt: 3, edge: "pass" } })) },
        { stageId: "verify", attempts: [attempt(1, "failed", conv("stop-once-verify-1", "Verify pass 1", 80 * MIN), { startedAt: iso(90 * MIN), completedAt: iso(80 * MIN), verdict: fail(pillFinding), activatedBy: { stageId: "build", attempt: 2, edge: "pass" } })] },
      ], { stageId: "review", state: "running", input: null, activatedBy: { stageId: "build", attempt: 3, edge: "pass" } }, { stateDetail: onceDetail }),
    /* §3.5: a lane that completed under the default after its last fix,
       which no reviewer saw. */
    pipeline("p-stop-done", L("Conversation: wider agent replies", "Розмова: ширші відповіді агентів"), "t-stop-done", "completed",
      [stage("build", "builder", "review"), reviewer(null, { to: "build", maxRounds: 2 })],
      [
        { stageId: "build", attempts: builds("done", 3, [null, { stageId: "review", attempt: 1, edge: "fail" }, { stageId: "review", attempt: 2, edge: "fail", budgetSpent: true }], 240 * MIN) },
        { stageId: "review", attempts: reviews("done", [pillFinding, pillFinding], 225 * MIN, { reviewedHead: REVIEWED_HEAD }).map((entry, index) => (index === 1 ? { ...entry, budgetSpent: true } : entry)) },
      ], null, { lastPassedCommit: UNREVIEWED_HEAD, closedAt: iso(170 * MIN), stateDetail: "budget spent: last findings handed to the fix stage, not re-reviewed" }),
    /* Row 4: an older review loop at its round limit, whose flow stored its
       own detail as the first finding. */
    pipeline("p-stop-legacy", L("Screenshot catalog: one capture command for every feature", "Каталог скриншотів: одна команда зйомки для кожної фічі"), "t-stop-legacy", "needs_decision",
      [stage("build", "builder", "review"), stage("review", "reviewer", null, { effectiveRole: readOnly })],
      [
        { stageId: "build", attempts: builds("legacy", 1, [null], 200 * MIN) },
        { stageId: "review", attempts: [attempt(1, "failed", conv("stop-legacy-review-1", "Review loop", 20 * MIN, { engine: "codex", model: "gpt-6-astra" }), {
          effectiveRole: readOnly, startedAt: iso(180 * MIN), completedAt: iso(20 * MIN), activatedBy: { stageId: "build", attempt: 1, edge: "pass" },
          verdict: { status: "fail", findings: ["round limit reached", captureFinding] }, error: "review loop ended in needs_decision: round limit reached",
        })] },
      ], { stageId: "review", state: "reviewing", input: null, activatedBy: { stageId: "build", attempt: 1, edge: "pass" } }, { stateDetail: "review loop ended in needs_decision: round limit reached" }),
  ];
})() : [];

const mergeStatePipelines: Pipeline[] = MERGE_STATES ? (() => {
  const readOnly = { ...role("reviewer", "codex"), access: "read-only" };
  const pass = { status: "pass", findings: [] };
  const conv = (id: string, title: string, ago: number) => add(conversation(id, title, { mtime: now - ago }));
  const HEAD = "7c1e4b2a9d3f6e5c8b0a1d2e3f4a5b6c7d8e9f0a";
  const merge = (state: string, requestedAgo: number, over: Record<string, unknown> = {}) => ({
    state, by: null, repository: "acme/atlas", prNumber: 2240, policyChangedAt: iso(24 * 60 * MIN), reviewedHead: HEAD, chain: [HEAD], updates: [],
    seenChecks: ["privacy-publication", "privacy-tracker-audit", "bun-runtime"], head: HEAD, headSeenAt: iso(requestedAgo), lastChecks: [],
    readAt: iso(MIN), nextReadAt: null, readFailures: 0, requestedAt: iso(requestedAgo), mergedHead: null, mergeCommit: null, method: null,
    mergedAt: null, attempts: 0, reason: null, blockedAt: null, updatedAt: iso(MIN), ...over,
  });
  const lane = (key: string, title: string, taskId: string, from: number, mergeRecord: Record<string, unknown>) => pipeline(`p-merge-${key}`, title, taskId, "completed",
    [stage("build", "builder", "review"), stage("review", "reviewer", null, { kind: "run", onFail: { to: "build", maxRounds: 2 }, effectiveRole: readOnly })],
    [
      { stageId: "build", attempts: [attempt(1, "passed", conv(`merge-${key}-build`, "Build pass 1", from + 20 * MIN), { startedAt: iso(from + 40 * MIN), completedAt: iso(from + 20 * MIN), verdict: pass })] },
      { stageId: "review", attempts: [attempt(1, "passed", conv(`merge-${key}-review`, "Review pass 1", from), { effectiveRole: readOnly, startedAt: iso(from + 18 * MIN), completedAt: iso(from), verdict: pass, activatedBy: { stageId: "build", attempt: 1, edge: "pass" } })] },
    ], null, { lastPassedCommit: HEAD, closedAt: iso(from), stateDetail: "completed", merge: mergeRecord });
  return [
    lane("wait", L("Deploy failure notifies the seat and the phone", "Невдалий деплой сповіщає сесію і телефон"), "t-merge-wait", 12 * MIN, merge("waiting-checks", 12 * MIN)),
    lane("update", L("Composer model pills: one width at 390", "Кнопки моделі в композері: одна ширина на 390"), "t-merge-update", 20 * MIN,
      merge("updating", 20 * MIN, { updates: [{ requestedAt: iso(2 * MIN), head: null }] })),
    lane("stop", L("Per-feature screenshot catalog and one capture command", "Каталог скриншотів по фічах і одна команда зйомки"), "t-merge-stop", 45 * MIN,
      merge("blocked", 45 * MIN, { reason: 'check "privacy-publication" failed', blockedAt: iso(30 * MIN) })),
    lane("done", L("Conversation: wider agent replies", "Розмова: ширші відповіді агентів"), "t-merge-done", 90 * MIN,
      merge("merged", 90 * MIN, { by: "auto-merge", mergedHead: HEAD, mergeCommit: "e0d1c2b3a4f5e6d7c8b9a0f1e2d3c4b5a6f7e8d9", method: "squash", mergedAt: iso(70 * MIN) })),
  ];
})() : [];

const taskFinishPipelines: Pipeline[] = TASK_FINISH ? (() => {
  const readOnly = { ...role("reviewer", "codex"), access: "read-only" };
  const pass = { status: "pass", findings: [] };
  const conv = (id: string, title: string, ago: number) => add(conversation(id, title, { mtime: now - ago }));
  const HEAD = "5b2c9e1d7a3f4b6c8d0e2f4a6b8c0d2e4f6a8b0c";
  const stages = () => [stage("build", "builder", "review"), stage("review", "reviewer", null, { kind: "run", onFail: { to: "build", maxRounds: 2 }, effectiveRole: readOnly })];
  const finished = (key: string, from: number) => [
    { stageId: "build", attempts: [attempt(1, "passed", conv(`finish-${key}-build`, "Build pass 1", from + 20 * MIN), { startedAt: iso(from + 40 * MIN), completedAt: iso(from + 20 * MIN), verdict: pass })] },
    { stageId: "review", attempts: [attempt(1, "passed", conv(`finish-${key}-review`, "Review pass 1", from), { effectiveRole: readOnly, startedAt: iso(from + 18 * MIN), completedAt: iso(from), verdict: pass, activatedBy: { stageId: "build", attempt: 1, edge: "pass" } })] },
  ];
  const merged = (from: number) => ({
    state: "merged", by: "auto-merge", repository: "acme/atlas", prNumber: 2240, policyChangedAt: iso(24 * 60 * MIN), reviewedHead: HEAD, chain: [HEAD], updates: [],
    seenChecks: ["privacy-publication"], head: HEAD, headSeenAt: iso(from), lastChecks: [], readAt: iso(MIN), nextReadAt: null, readFailures: 0, requestedAt: iso(from),
    mergedHead: HEAD, mergeCommit: "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567", method: "squash", mergedAt: iso(from - 10 * MIN), attempts: 0, reason: null, blockedAt: null, updatedAt: iso(MIN),
  });
  const running = (key: string, from: number) => [
    { stageId: "build", attempts: [attempt(1, "running", conv(`finish-${key}-build`, "Build pass 1", from), { startedAt: iso(from) })] },
    { stageId: "review", attempts: [] },
  ];
  const cursor = { stageId: "build", state: "running", input: null, activatedBy: null };
  return [
    pipeline("p-finish-marked", L("Slice 4: the pipeline that finishes its task", "Зріз 4: пайплайн, що завершує задачу"), "t-finish-marked", "running", stages(), running("marked", 25 * MIN), cursor,
      { finishesTaskIds: ["t-finish-marked"] }),
    pipeline("p-finish-hold", L("Slice 3: merge runner and the setting", "Зріз 3: мердж і налаштування"), "t-finish-hold", "completed", stages(), finished("hold", 60 * MIN), null,
      { lastPassedCommit: HEAD, closedAt: iso(60 * MIN), stateDetail: "completed", merge: merged(60 * MIN), finishesTaskIds: ["t-finish-hold"],
        taskFinishWaits: [{ taskId: "t-finish-hold", since: iso(50 * MIN), open: ["p-finish-other"] }] }),
    pipeline("p-finish-other", L("Docs for the merge setting", "Документація налаштування мерджу"), "t-finish-hold", "running", stages(), running("other", 15 * MIN), cursor),
    pipeline("p-finish-done", L("Conversation: wider agent replies", "Розмова: ширші відповіді агентів"), "t-finish-done", "completed", stages(), finished("done", 90 * MIN), null,
      { lastPassedCommit: HEAD, closedAt: iso(90 * MIN), stateDetail: "completed", merge: { ...merged(90 * MIN), prNumber: 2236 }, finishesTaskIds: ["t-finish-done"],
        taskFinishes: [{ taskId: "t-finish-done", at: iso(75 * MIN), outcome: "moved" }] }),
  ];
})() : [];

const arcPipelines: Pipeline[] = ARCS ? (() => {
  const conv = (id: string, title: string, over: Record<string, unknown> = {}) => add(conversation(id, title, over));
  const restFix = conv("arc-rest-fix", "Draft the empty-state copy", { mtime: now - 70 * MIN });
  const restCrit = conv("arc-rest-crit", "Reading the draft", working({ plan: { current: "Reading the draft" } }));
  const firedFix = conv("arc-fired-fix", "Second pass after the review sent it back", working({ plan: { current: "Rewriting the summary row" } }));
  const firedRev = conv("arc-fired-rev", "Sent it back: the summary row still lies", { mtime: now - 55 * MIN, engine: "codex", model: "gpt-6-astra" });
  const spentFix = conv("arc-spent-fix", "Last return: the limit notice again", working({ plan: { current: "Rewriting the limit notice" } }));
  const spentRev = conv("arc-spent-rev", "Sent it back: the notice still rounds the reset", { mtime: now - 40 * MIN, engine: "codex", model: "gpt-6-astra" });
  const parkFix = conv("arc-park-fix", "Third pass on the reset time", { mtime: now - 50 * MIN });
  const parkRev = conv("arc-park-rev", "Out of returns: the reset time is still wrong", { mtime: now - 15 * MIN, engine: "codex", model: "gpt-6-astra" });
  const twoFix = conv("arc-two-fix", "Third pass on the picker", working({ plan: { current: "Reworking the picker" } }));
  const twoCrit = conv("arc-two-crit", "Sent it back: the picker hides the default", { mtime: now - 140 * MIN });
  const twoRev = conv("arc-two-rev", "Sent it back: the default is still not marked", { mtime: now - 90 * MIN, engine: "codex", model: "gpt-6-astra" });
  const longImpl = conv("arc-long-impl", "Second pass after the verifier sent it back", working({ plan: { current: "Re-reading the column widths" } }));
  const longRev = conv("arc-long-rev", "Read the first pass", { mtime: now - 120 * MIN });
  const longVer = conv("arc-long-ver", "Sent it back: two columns still clip", { mtime: now - 80 * MIN, engine: "codex", model: "gpt-6-astra" });
  return [
    /* At rest: three stages, one fail edge, nothing used. The arc is faint and
       wordless — the budget is in its tooltip only. */
    pipeline("p-arc-rest", "Write the empty state of the pipelines list", "t-arcs", "running", [
      stage("fix", "builder", "critique"),
      stage("critique", "architect", "review"),
      stage("review", "verifier", null, { onFail: { to: "fix", maxRounds: 3 } }),
    ], [
      { stageId: "fix", attempts: [attempt(1, "passed", restFix, { startedAt: iso(70 * MIN) })] },
      { stageId: "critique", attempts: [attempt(1, "running", restCrit, { startedAt: iso(20 * MIN), activatedBy: { stageId: "fix", attempt: 1, edge: "pass" } })] },
    ], { stageId: "critique", state: "running", input: null, activatedBy: null }),
    /* Fired once of three, and the stage it returned to is running BECAUSE of
       it: the arc is the live one. */
    pipeline("p-arc-fired", "Make the summary row say what actually ran", "t-arcs", "running", [
      stage("fix", "builder", "review"),
      stage("review", "verifier", null, { onFail: { to: "fix", maxRounds: 3 } }),
    ], [
      { stageId: "fix", attempts: [
        attempt(1, "passed", firedFix, { startedAt: iso(120 * MIN) }),
        attempt(2, "running", firedFix, { startedAt: iso(40 * MIN), activatedBy: { stageId: "review", attempt: 1, edge: "fail" } }),
      ] },
      { stageId: "review", attempts: [attempt(1, "failed", firedRev, { startedAt: iso(60 * MIN), activatedBy: { stageId: "fix", attempt: 1, edge: "pass" } })] },
    ], { stageId: "fix", state: "running", input: null, activatedBy: null }),
    /* Two of two used, and the lane is still alive: the last return is in
       flight, so the arc and its counter are danger while the work runs. The
       sentence is about what a FURTHER failure would cost. */
    pipeline("p-arc-spent", "Show the account limit reset on the card", "t-arcs", "running", [
      stage("fix", "builder", "review"),
      stage("review", "verifier", null, { onFail: { to: "fix", maxRounds: 2 } }),
    ], [
      { stageId: "fix", attempts: [
        attempt(1, "passed", spentFix, { startedAt: iso(150 * MIN) }),
        attempt(2, "passed", spentFix, { startedAt: iso(110 * MIN), activatedBy: { stageId: "review", attempt: 1, edge: "fail" } }),
        attempt(3, "running", spentFix, { startedAt: iso(30 * MIN), activatedBy: { stageId: "review", attempt: 2, edge: "fail" } }),
      ] },
      { stageId: "review", attempts: [
        attempt(1, "failed", spentRev, { startedAt: iso(130 * MIN), activatedBy: { stageId: "fix", attempt: 1, edge: "pass" } }),
        attempt(2, "failed", spentRev, { startedAt: iso(80 * MIN), activatedBy: { stageId: "fix", attempt: 2, edge: "pass" } }),
      ] },
    ], { stageId: "fix", state: "running", input: null, activatedBy: null }),
    /* The same budget, spent, with the source failed once more: the engine had
       nothing left to return and parked the lane on the failing stage. This is
       the state a red arc is most often read in, and the one whose sentence
       says what happened rather than what a further failure would cost. */
    pipeline("p-arc-parked", "Say when the account limit resets", "t-arcs", "needs_decision", [
      stage("fix", "builder", "review"),
      stage("review", "verifier", null, { onFail: { to: "fix", maxRounds: 2 } }),
    ], [
      { stageId: "fix", attempts: [
        attempt(1, "passed", parkFix, { startedAt: iso(220 * MIN) }),
        attempt(2, "passed", parkFix, { startedAt: iso(180 * MIN), activatedBy: { stageId: "review", attempt: 1, edge: "fail" } }),
        attempt(3, "passed", parkFix, { startedAt: iso(120 * MIN), activatedBy: { stageId: "review", attempt: 2, edge: "fail" } }),
      ] },
      { stageId: "review", attempts: [
        attempt(1, "failed", parkRev, { startedAt: iso(200 * MIN), activatedBy: { stageId: "fix", attempt: 1, edge: "pass" } }),
        attempt(2, "failed", parkRev, { startedAt: iso(150 * MIN), activatedBy: { stageId: "fix", attempt: 2, edge: "pass" } }),
        attempt(3, "needs_decision", parkRev, { startedAt: iso(90 * MIN), activatedBy: { stageId: "fix", attempt: 3, edge: "pass" } }),
      ] },
    ], { stageId: "review", state: "running", input: null, activatedBy: null }),
    /* Two fail edges into one target: two arcs at two depths, neither crossing
       a pill and neither crossing the other. */
    pipeline("p-arc-two", "Mark the default account in the picker", "t-arcs", "running", [
      stage("fix", "builder", "critique"),
      stage("critique", "architect", "review", { onFail: { to: "fix", maxRounds: 3 } }),
      stage("review", "verifier", null, { onFail: { to: "fix", maxRounds: 2 } }),
    ], [
      { stageId: "fix", attempts: [
        attempt(1, "passed", twoFix, { startedAt: iso(200 * MIN) }),
        attempt(2, "passed", twoFix, { startedAt: iso(150 * MIN), activatedBy: { stageId: "critique", attempt: 1, edge: "fail" } }),
        attempt(3, "running", twoFix, { startedAt: iso(70 * MIN), activatedBy: { stageId: "review", attempt: 1, edge: "fail" } }),
      ] },
      { stageId: "critique", attempts: [
        attempt(1, "failed", twoCrit, { startedAt: iso(170 * MIN), activatedBy: { stageId: "fix", attempt: 1, edge: "pass" } }),
        attempt(2, "passed", twoCrit, { startedAt: iso(130 * MIN), activatedBy: { stageId: "fix", attempt: 2, edge: "pass" } }),
      ] },
      { stageId: "review", attempts: [attempt(1, "failed", twoRev, { startedAt: iso(100 * MIN), activatedBy: { stageId: "critique", attempt: 2, edge: "pass" } })] },
    ], { stageId: "fix", state: "running", input: null, activatedBy: null }),
    /* Four stages, which is the ordinary length of a real lane. A row this long
       wraps in every column the board actually gives it short of a 1920 px
       screen, so the suffix on the failing pill — not the arc — is what most
       lanes draw, and the wide frames have to show it. Its edge fired once and
       the return is in flight, which is the reading the suffix has to keep
       apart from a return that is over. */
    pipeline("p-arc-long", "Keep every column legible while a lane runs", "t-arcs", "running", [
      stage("implement", "builder", "review"),
      stage("review", "reviewer", "verify"),
      stage("verify", "verifier", "merge", { onFail: { to: "implement", maxRounds: 3 } }),
      stage("merge", "cleaner", null),
    ], [
      { stageId: "implement", attempts: [
        attempt(1, "passed", longImpl, { startedAt: iso(160 * MIN) }),
        attempt(2, "running", longImpl, { startedAt: iso(35 * MIN), activatedBy: { stageId: "verify", attempt: 1, edge: "fail" } }),
      ] },
      { stageId: "review", attempts: [attempt(1, "passed", longRev, { startedAt: iso(120 * MIN), activatedBy: { stageId: "implement", attempt: 1, edge: "pass" } })] },
      { stageId: "verify", attempts: [attempt(1, "failed", longVer, { startedAt: iso(80 * MIN), activatedBy: { stageId: "review", attempt: 1, edge: "pass" } })] },
    ], { stageId: "implement", state: "running", input: null, activatedBy: null }),
  ];
})() : [];

const labelPipelines: Pipeline[] = LABELS ? (() => {
  const conv = (id: string, title: string, over: Record<string, unknown> = {}) => add(conversation(id, title, over));
  const design = conv("labels-design", "Lay out the header lane", { mtime: now - 240 * MIN });
  const build1 = conv("labels-build-1", "First build of the header lane", { mtime: now - 200 * MIN });
  const critique1 = conv("labels-critique-1", "Sent it back: the lane overlaps the search field", { mtime: now - 160 * MIN });
  const build2 = conv("labels-build-2", "Second build after the critique", { mtime: now - 90 * MIN });
  const critique2 = conv("labels-critique-2", "Reading the header render at 1280", working({ plan: { current: "Reading the header render at 1280" } }));
  return [pipeline("p-labels", "Build the board header lane", "t-labels", "running", [
    stage("design", "architect", "build", { effectiveRole: role("architect") }),
    stage("build", "builder", "critique"),
    stage("critique", "architect", null, { effectiveRole: role("architect"), onFail: { to: "build", maxRounds: 3 } }),
  ], [
    { stageId: "design", attempts: [attempt(1, "passed", design, { effectiveRole: role("architect"), startedAt: iso(240 * MIN) })] },
    { stageId: "build", attempts: [
      attempt(1, "passed", build1, { startedAt: iso(200 * MIN), activatedBy: { stageId: "design", attempt: 1, edge: "pass" } }),
      attempt(2, "passed", build2, { startedAt: iso(90 * MIN), activatedBy: { stageId: "critique", attempt: 1, edge: "fail" } }),
    ] },
    { stageId: "critique", attempts: [
      attempt(1, "failed", critique1, { effectiveRole: role("architect"), startedAt: iso(160 * MIN), activatedBy: { stageId: "build", attempt: 1, edge: "pass" } }),
      attempt(2, "running", critique2, { effectiveRole: role("architect"), startedAt: iso(60 * MIN), activatedBy: { stageId: "build", attempt: 2, edge: "pass" } }),
    ] },
  ], { stageId: "critique", state: "running", input: null, activatedBy: null })];
})() : [];

const BALANCE_COLUMNS: TaskStatus[] = ["inbox", "assigned", "blocked", "done"];
const BALANCE_NAMES = { short: "build", mid: "design-and-prototype", long: "check-every-stage-pill-at-a-narrow-width" } as const;
/* Each attempt ran on its stage's values, so the pill draws the model label beside the mark. */
const FABLE = { effectiveRole: runRole("builder", "claude", "fable", "high") };
const ASTRA = { effectiveRole: runRole("reviewer", "codex", "gpt-6-astra", "xhigh") };
const balancePipelines: Pipeline[] = BALANCE ? BALANCE_COLUMNS.flatMap((column) => {
  const conv = (id: string, title: string, over: Record<string, unknown> = {}) => add(conversation(`bal-${column}-${id}`, title, { model: "fable", ...over }));
  /* A one-stage chain: the stage running, or on Blocked parked on the operator. */
  const one = (key: keyof typeof BALANCE_NAMES) => {
    const id = BALANCE_NAMES[key];
    const parked = column === "blocked" && key === "long";
    const file = conv(`one-${key}`, `One stage: ${id}`, parked ? { waitingInput: { since: now - 5 * MIN } } : working({ model: "fable" }));
    return pipeline(`p-bal-${column}-one-${key}`, `Run the one ${key} stage in ${column}`, `t-bal-${column}`, parked ? "needs_decision" : "running",
      [marksStage(id, "builder", null, "claude", "fable", "high")],
      [{ stageId: id, attempts: [attempt(1, parked ? "needs_decision" : "running", file, { ...FABLE, startedAt: iso(30 * MIN) })] }],
      { stageId: id, state: "running", input: null, activatedBy: null });
  };
  /* Build → Review with a fail loop that fired once: Review sent the work back. */
  const loop = (key: "mid" | "long") => {
    const id = BALANCE_NAMES[key];
    const review = key === "mid" ? "review" : "review-the-pill-at-every-column-width-ok";
    const first = conv(`loop-${key}-1`, `First pass: ${id}`, { mtime: now - 90 * MIN });
    const critique = conv(`loop-${key}-rev`, `Sent back: ${review}`, { mtime: now - 60 * MIN, engine: "codex", model: "gpt-6-astra" });
    const second = conv(`loop-${key}-2`, `Second pass: ${id}`, working({ model: "fable" }));
    return pipeline(`p-bal-${column}-loop-${key}`, `Loop the ${key} stage names in ${column}`, `t-bal-${column}`, "running",
      [marksStage(id, "builder", review, "claude", "fable", "high"), marksStage(review, "reviewer", null, "codex", "gpt-6-astra", "xhigh", { onFail: { to: id, maxRounds: 3 } })],
      [
        { stageId: id, attempts: [attempt(1, "passed", first, { ...FABLE, startedAt: iso(100 * MIN) }), attempt(2, "running", second, { ...FABLE, startedAt: iso(50 * MIN), activatedBy: { stageId: review, attempt: 1, edge: "fail" } })] },
        { stageId: review, attempts: [attempt(1, "failed", critique, { ...ASTRA, startedAt: iso(70 * MIN), activatedBy: { stageId: id, attempt: 1, edge: "pass" } })] },
      ],
      { stageId: id, state: "running", input: null, activatedBy: null });
  };
  return [one("short"), one("long"), loop("mid"), loop("long")];
}) : [];

const flatPipelines: Pipeline[] = FLAT ? (() => {
  const mdImpl = add(conversation("md-impl", L("Builder: move the delta chain off the request thread", "Білдер: винести ланцюг дельт з потоку запиту"), { mtime: now - 41 * MIN }));
  const mdAccept = add(conversation("md-accept", L("Acceptor: hidden tabs stop polling", "Приймальник: приховані вкладки більше не опитують"), { mtime: now - 120 * MIN }));
  const loopBuild = add(conversation("many-loop-build", L("Builder: name rows by the prompt", "Білдер: назви рядків із промпту"), { mtime: now - 70 * MIN }));
  const loopRev = add(conversation("many-loop-rev", L("Reviewer: second round on row names", "Рецензент: другий раунд назв рядків"), working({ engine: "codex", model: "gpt-5.6", plan: { current: "Reading round 2" } })));
  const firedFix = add(conversation("many-fired-fix", L("Builder: second pass after verify", "Білдер: другий прохід після перевірки"), working({ plan: { current: "Re-measuring the fold" } })));
  const firedVer = add(conversation("many-fired-ver", L("Verifier: the fold hides a running lane", "Перевіряльник: згортка ховає робочий конвеєр"), { mtime: now - 30 * MIN, engine: "codex", model: "gpt-6-astra" }));
  const finding = L("The delta chain is rebuilt on the request thread; the worker must own it.", "Ланцюг дельт перебудовується в потоці запиту; ним має володіти воркер.");
  return [
    pipeline("p-md-decision", L("Stop repeated full-board downloads", "Припинити повторні завантаження всієї дошки"), "t-mobile", "needs_decision",
      [stage("implement", "builder", "review"), stage("review", "reviewer", null)],
      [{ stageId: "implement", attempts: [attempt(1, "needs_decision", mdImpl, { startedAt: iso(80 * MIN), completedAt: iso(41 * MIN), verdict: { status: "fail", findings: [finding], rankedFindings: [{ severity: "P1", text: finding }] } })] }],
      { stageId: "implement", state: "needs_decision", input: null, activatedBy: null },
      { createdAt: iso(90 * MIN), stageReports: [{ seq: 1, at: iso(41 * MIN), actor: { kind: "agent", role: "builder", conversationId: mdImpl.conversationId }, stageId: "implement", attempt: 1, status: "fail", findings: 1, replaces: null, summary: finding }] }),
    /* Paused while its acceptance stage ran: the engine keeps the cursor on the
       held stage, which the phone's pipeline screen draws hollow (§3.13). */
    pipeline("p-md-accept", L("Finish mobile traffic acceptance", "Завершити приймання мобільного трафіку"), "t-mobile", "paused",
      [stage("accept", "verifier", "review"), stage("review", "reviewer", null)],
      [{ stageId: "accept", attempts: [attempt(1, "running", mdAccept, { startedAt: iso(150 * MIN) })] }],
      { stageId: "accept", state: "running", input: null, activatedBy: null }, { pausedState: "running", createdAt: iso(160 * MIN) }),
    pipeline("p-many-loop", L("Name every pipeline row by its first prompt line", "Називати кожен рядок конвеєра першим рядком промпту"), "t-many", "running",
      [stage("build", "builder", "review"), stage("review", "reviewer", null)],
      [
        { stageId: "build", attempts: [attempt(1, "passed", loopBuild, { startedAt: iso(90 * MIN) })] },
        { stageId: "review", attempts: [attempt(1, "reviewing", loopRev, { flowId: "flow-rounds-review", startedAt: iso(60 * MIN), activatedBy: { stageId: "build", attempt: 1, edge: "pass" } })] },
      ],
      { stageId: "review", state: "reviewing", input: null, activatedBy: null }, { createdAt: iso(100 * MIN) }),
    pipeline("p-many-fired", L("Keep a running lane out of the completed fold", "Не ховати робочий конвеєр у згортку завершених"), "t-many", "running",
      [stage("fix", "builder", "verify"), stage("verify", "verifier", null, { onFail: { to: "fix", maxRounds: 2 } })],
      [
        { stageId: "fix", attempts: [attempt(1, "passed", firedFix, { startedAt: iso(100 * MIN) }), attempt(2, "running", firedFix, { startedAt: iso(20 * MIN), activatedBy: { stageId: "verify", attempt: 1, edge: "fail" } })] },
        { stageId: "verify", attempts: [attempt(1, "failed", firedVer, { startedAt: iso(60 * MIN), completedAt: iso(30 * MIN), activatedBy: { stageId: "fix", attempt: 1, edge: "pass" } })] },
      ],
      { stageId: "fix", state: "running", input: null, activatedBy: null }, { createdAt: iso(110 * MIN) }),
  ];
})() : [];

/* The pipeline block's case (#2072) runs the eight-stage chain with its
   current stage named in 44 characters: too long to keep "✓3" and "+4" beside
   it in a 390 px card, so the card's fold has to reach the stage alone. */
const UPLOAD_UI = FLAT ? "verify-backward-compatibility-and-migrations" : "build-ui";
/* And a two-stage lane whose current stage is named in 86 characters: too long
   for a 390 px card's line even alone, so its name wraps inside the pill. */
const ATTACH_VERIFY = FLAT ? "confirm-each-attachment-arrives-whole-on-the-phone-the-desktop-and-the-telegram-bridge" : "verify";

/* The assignments a task's lanes leave behind: one per stage attempt, three
   handshake retries after a lane's first review, and one per review round. */
function laneAssignments(prefix: string, daysAgo: number, lanes: ReadonlyArray<readonly [string, readonly string[]]>, rounds: number) {
  const rows: Array<Record<string, unknown>> = [];
  const add = (clientAttemptId: string) => {
    const n = rows.length + 1;
    rows.push({ launchId: `launch-${prefix}-${n}`, clientAttemptId, path: null, conversationId: `conversation_${prefix}-${n}`, panePid: null, state: "linked", error: null, at: iso(daysAgo * 24 * 60 * MIN - n * 25 * MIN), engine: n % 3 ? "claude" : "codex" });
  };
  lanes.forEach(([lane, stages], laneIndex) => stages.forEach((stageId, index) => {
    add(`pipeline_${lane}_${stageId}_${index + 1}`);
    if (laneIndex === 1 && index === 1) for (let retry = 1; retry <= 3; retry += 1) add(`handshake_retry_${retry}_pipeline_${lane}_${stageId}_${index + 1}`);
  }));
  for (let round = 1; round <= rounds; round += 1) add(`flow_${prefix}${round}_round${round}`);
  return rows;
}
const sqliteRows = UNSTARTED ? laneAssignments("sqlite", 5, [
  ["a1", ["design", "build", "review", "build", "review", "build", "review", "build", "review", "review"]],
  ["a2", ["build", "review", "build", "review"]],
  ["a3", ["build", "review", "build", "review"]],
  ["a4", ["fix", "review"]],
  ["a5", ["build", "review", "build"]],
  ["a6", ["build"]],
  ["a7", ["fix", "review", "fix", "review", "fix", "review", "fix", "review"]],
  ["a8", ["review"]],
  ["slice4", ["build"]],
  ["slice5", ["build"]],
], 5) : [];
const flowsRows = UNSTARTED ? laneAssignments("flows", 4, [
  ["b1", ["design"]],
  ["b2", ["build", "review"]],
  ["b4", ["build", "review", "build", "review", "build"]],
  ["b5", ["build", "review", "build", "build"]],
  ["b6", ["build", "review", "build", "review", "build"]],
  ["b7", ["review", "build"]],
  ["s4", ["build"]],
  ["s5", ["build"]],
], 3) : [];
const mixedRows = UNSTARTED ? laneAssignments("mixed", 3, [["c1", ["build", "review", "build", "review"]]], 0) : [];
/* A lane of the task's own: its one build attempt ran the assignment's conversation. */
function ownLane(id: string, title: string, taskId: string, state: string, rows: ReadonlyArray<Record<string, unknown>>, daysAgo: number): Pipeline {
  const row = rows.find((entry) => String(entry.clientAttemptId).startsWith(`pipeline_${id}_`))!;
  const at = daysAgo * 24 * 60 * MIN;
  return pipeline(`p-${id}`, title, taskId, state, [stage("build", "builder", null)],
    [{ stageId: "build", attempts: [attempt(1, "passed", null, { launchId: row.launchId, conversationId: row.conversationId, startedAt: iso(at), completedAt: iso(at - 40 * MIN), verdict: { status: "pass", findings: [] } })] }],
    null, { createdAt: iso(at + 10 * MIN), closedAt: iso(at - 45 * MIN) });
}
const unstartedPipelines: Pipeline[] = UNSTARTED ? [
  ownLane("slice4", L("State in SQLite, slice 4: the bridge stores", "Стан у SQLite, зріз 4: сховища мосту"), "t-lanes-sqlite", "completed", sqliteRows, 2),
  ownLane("slice5", L("State in SQLite, slice 5: the operator's small stores", "Стан у SQLite, зріз 5: дрібні сховища оператора"), "t-lanes-sqlite", "closed", sqliteRows, 2),
  ownLane("s4", L("Retire flows, slice 4: decode old definitions", "Прибрати флоу, зріз 4: декодувати старі визначення"), "t-lanes-flows", "completed", flowsRows, 2),
  ownLane("s5", L("Retire flows, slice 5: freeze flows", "Прибрати флоу, зріз 5: заморозити флоу"), "t-lanes-flows", "closed", flowsRows, 2),
] : [];

const wallRows = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => ({
  path: `/elsewhere/${prefix}-${index + 1}.jsonl`, conversationId: `conversation_${prefix}-${index + 1}`, panePid: null, state: "linked", error: null, at: iso((3 * 60 + (count - index) * 12) * MIN),
}));
const wallPipelines: Pipeline[] = WALL ? (() => {
  const run = (stageId: string, count: number, offset: number, via: string | null) => ({
    stageId,
    attempts: Array.from({ length: count }, (_, index) => attempt(index + 1, "passed", null, {
      startedAt: iso((offset + index * 30) * MIN), completedAt: iso((offset + index * 30 - 20) * MIN), verdict: { status: "pass", findings: [] },
      ...(via ? { activatedBy: { stageId: via, attempt: index + 1, edge: "pass" } } : {}),
    })),
  });
  return [pipeline("p-wall", L("The privacy gate admits the sanctioned relay address", "Шлюз приватності пропускає дозволену адресу ретранслятора"), "t-wall", "completed",
    [stage("build", "builder", "verify"), stage("verify", "verifier", "fix"), stage("fix", "builder", null)],
    [run("build", 3, 600, null), run("verify", 3, 580, "build"), run("fix", 3, 560, "verify")],
    null, { closedAt: iso(150 * MIN) })];
})() : [];

const stageChainPipelines: Pipeline[] = STAGE_CHAIN ? (() => {
  const done = (at: number) => ({ startedAt: iso(at * MIN), completedAt: iso((at - 6) * MIN) });
  const passVia = (stageId: string) => ({ activatedBy: { stageId, attempt: 1, edge: "pass" } });
  const failVia = (stageId: string) => ({ activatedBy: { stageId, attempt: 1, edge: "fail" } });
  /* The operator's lane: Build, Review fired once of three, the branch Review fix. */
  const operator = (id: string, taskId: string, state: string) => pipeline(id, L("Keep the review fix on the card", "Залишити виправлення рев’ю на картці"), taskId, state,
    [stage("build", "builder", "review"), stage("review", "reviewer", null, { kind: "run", onFail: { to: "review-fix", maxRounds: 3 } }), stage("review-fix", "builder", "review")],
    [
      { stageId: "build", attempts: [attempt(1, "passed", null, done(90))] },
      { stageId: "review", attempts: [attempt(1, "failed", null, { ...done(70), ...passVia("build") })] },
      { stageId: "review-fix", attempts: [attempt(1, "passed", null, { ...done(60), ...failVia("review") })] },
    ], null, { closedAt: iso(50 * MIN) });
  return [
    operator("p-chain-operator", "t-chain-operator", "completed"),
    operator("p-chain-wide", "t-chain-wide", "completed"),
    /* A stage after the reviewer: the rail passes beside the branch to it. */
    pipeline("p-chain-through", L("Critique, then review, with a fix between", "Критика, потім рев’ю, з виправленням між ними"), "t-chain-through", "completed",
      [stage("build", "builder", "critique"), stage("critique", "architect", "review", { onFail: { to: "critique-fix", maxRounds: 2 } }), stage("critique-fix", "builder", "critique"), stage("review", "reviewer", null, { kind: "run" })],
      [
        { stageId: "build", attempts: [attempt(1, "passed", null, done(90))] },
        { stageId: "critique", attempts: [attempt(1, "failed", null, { ...done(70), ...passVia("build") }), attempt(2, "passed", null, { ...done(50), ...passVia("critique-fix") })] },
        { stageId: "critique-fix", attempts: [attempt(1, "passed", null, { ...done(60), ...failVia("critique") })] },
        { stageId: "review", attempts: [attempt(1, "passed", null, { ...done(40), ...passVia("critique") })] },
      ], null, { closedAt: iso(30 * MIN) }),
    /* A running stage, a stage no attempt reached, and one name too long for the lane. */
    pipeline("p-chain-live", L("Build, review and merge the export", "Зібрати, переглянути і злити експорт"), "t-chain-live", "running",
      [stage("build", "builder", "review"), stage("review", "reviewer", "merge", { kind: "run" }), stage("merge", "cleaner", null)],
      [
        { stageId: "build", attempts: [attempt(1, "passed", null, done(30))] },
        { stageId: "review", attempts: [attempt(1, "running", null, { startedAt: iso(10 * MIN), ...passVia("build") })] },
      ], { stageId: "review", state: "running", input: null, activatedBy: null }),
    pipeline("p-chain-long", L("Confirm every attachment arrives whole", "Підтвердити, що кожне вкладення доходить цілим"), "t-chain-long", "running",
      [stage("build", "builder", "confirm-each-attachment-arrives-whole-on-the-phone-the-desktop-and-the-bridge"), stage("confirm-each-attachment-arrives-whole-on-the-phone-the-desktop-and-the-bridge", "verifier", null)],
      [
        { stageId: "build", attempts: [attempt(1, "passed", null, done(30))] },
        { stageId: "confirm-each-attachment-arrives-whole-on-the-phone-the-desktop-and-the-bridge", attempts: [attempt(1, "running", null, { startedAt: iso(8 * MIN), ...passVia("build") })] },
      ], { stageId: "confirm-each-attachment-arrives-whole-on-the-phone-the-desktop-and-the-bridge", state: "running", input: null, activatedBy: null }),
  ];
})() : [];

const pipelines: Pipeline[] = [
  ...wallPipelines,
  ...unstartedPipelines,
  ...stageChainPipelines,
  ...flatPipelines,
  ...reviewSpentPipelines,
  ...reviewStopPipelines,
  ...mergeStatePipelines,
  ...taskFinishPipelines,
  ...balancePipelines,
  ...arcPipelines,
  ...labelPipelines,
  ...marksPipelines,
  ...glyphPipelines,
  ...loopsPipelines,
  ...manyPipelines,
  pipeline("p-search", "Restore search results after the index rebuild", "t-search", "running",
    [stage("implement", "builder", "review"), stage("review", "reviewer", "verify"), stage("verify", "verifier", "merge", { onFail: { to: "implement", maxRounds: 2 } }), stage("merge", "cleaner", null)],
    [
      { stageId: "implement", attempts: [
        attempt(1, "passed", searchImpl1),
        attempt(2, "passed", searchImpl2, { activatedBy: { stageId: "verify", attempt: 1, edge: "fail" } }),
        /* Lineage-adopted: the engine copies the source attempt's provenance onto it. */
        ...(searchHelper ? [attempt(3, "passed", searchHelper, { historical: true, activatedBy: { stageId: "verify", attempt: 1, edge: "fail" }, startedAt: iso(55 * MIN) })] : []),
      ] },
      { stageId: "review", attempts: [attempt(1, "passed", searchRev, { ...flowOf("flow-search-review"), reviewFlowSync: { generation: "g1", roundCount: 2, implementerHeadSha: null, reviewerHeadSha: null, verdict: null, relayState: "approved", terminalState: null } })] },
      { stageId: "verify", attempts: [attempt(1, "failed", searchVer1), attempt(2, "running", searchVer2, { activatedBy: { stageId: "review", attempt: 1, edge: "pass" } })] },
    ],
    { stageId: "verify", state: "running", input: null, activatedBy: null }),
  pipeline("p-upload", "Redesign attachment upload for large files", "t-upload", "running",
    [stage("plan", "architect", "build-api"), stage("build-api", "builder", "review-api"), stage("review-api", "reviewer", UPLOAD_UI), stage(UPLOAD_UI, "builder", "review-ui"), stage("review-ui", "reviewer", "verify"), stage("verify", "verifier", "docs", { onFail: { to: UPLOAD_UI, maxRounds: 2 } }), stage("docs", "builder", "merge"), stage("merge", "cleaner", null)],
    [
      { stageId: "plan", attempts: [attempt(1, "passed", uploadPlan)] },
      { stageId: "build-api", attempts: [attempt(1, "passed", uploadApi)] },
      { stageId: "review-api", attempts: [attempt(1, "passed", uploadRevApi, { ...flowOf("flow-upload-review-api"), reviewFlowSync: { generation: "g2", roundCount: 2, implementerHeadSha: null, reviewerHeadSha: null, verdict: null, relayState: "approved", terminalState: null } })] },
      { stageId: UPLOAD_UI, attempts: [attempt(1, "running", uploadUi)] },
    ],
    { stageId: UPLOAD_UI, state: "running", input: null, activatedBy: null }),
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
    [stage("build", "builder", ATTACH_VERIFY), stage(ATTACH_VERIFY, "verifier", null)],
    [{ stageId: "build", attempts: [attempt(1, "passed", attachBuild)] }, { stageId: ATTACH_VERIFY, attempts: [attempt(1, "running", attachVerify)] }],
    { stageId: ATTACH_VERIFY, state: "running", input: null, activatedBy: null }),
  pipeline("p-compact", "Compact board stages and separate history from live work", "t-compact", "completed",
    [stage("build", "builder", "review"), stage("review", "reviewer", "verify"), stage("verify", "verifier", null)],
    [
      { stageId: "build", attempts: [attempt(1, "passed", compactBuild)] },
      { stageId: "review", attempts: [attempt(1, "passed", compactRev, { ...flowOf("flow-compact-review"), reviewFlowSync: { generation: "g3", roundCount: 1, implementerHeadSha: null, reviewerHeadSha: null, verdict: null, relayState: "approved", terminalState: null } })] },
      { stageId: "verify", attempts: [attempt(1, "passed", compactVer)] },
    ],
    null),
  ...(roundsBuild && roundsReview ? [pipeline("p-rounds", "Rework the retry banner until review passes", "t-rounds", "running",
    [stage("build", "builder", "review"), stage("review", "reviewer", null)],
    [
      { stageId: "build", attempts: [attempt(1, "passed", roundsBuild, { startedAt: iso(4 * 60 * MIN) })] },
      { stageId: "review", attempts: [attempt(1, "reviewing", roundsReview, { flowId: "flow-rounds-review", startedAt: iso(3 * 60 * MIN) })] },
    ],
    { stageId: "review", state: "reviewing", input: null, activatedBy: null })] : []),
];

if (STAGES) {
  for (const record of pipelines) {
    for (const entry of record.stages) {
      const prompt = PROMPTS[`${record.id}:${entry.id}`];
      if (prompt) entry.prompt = prompt;
    }
  }
  /* As the prototype's fixture has them: each attempt names the edge that
     started it, and Review ran once per Implement attempt. */
  type Run = { stageId: string; attempts: Array<Record<string, unknown>> };
  const runsOf = (id: string) => (pipelines.find((entry) => entry.id === id)!.runs as unknown as Run[]);
  const upload = runsOf("p-upload");
  const chain = ["plan", "build-api", "review-api", "build-ui"];
  for (const run of upload) {
    const previous = chain[chain.indexOf(run.stageId) - 1];
    if (previous) run.attempts[0]!.activatedBy = { stageId: previous, attempt: 1, edge: "pass" };
  }
  const search = runsOf("p-search");
  const review = search.find((run) => run.stageId === "review")!;
  review.attempts = [
    attempt(1, "passed", searchRevFirst, { startedAt: iso(120 * MIN), activatedBy: { stageId: "implement", attempt: 1, edge: "pass" } }),
    { ...review.attempts[0]!, n: 2, activatedBy: { stageId: "implement", attempt: 2, edge: "pass" } },
  ];
  const verify = search.find((run) => run.stageId === "verify")!;
  verify.attempts[0]!.activatedBy = { stageId: "review", attempt: 1, edge: "pass" };
  verify.attempts[1]!.activatedBy = { stageId: "review", attempt: 2, edge: "pass" };
}
if (ACCOUNTS) {
  /* K6: Docs names the account its first turn runs on; Merge leaves it to the project. The running Verify launched on account A. */
  const uploadDocs = pipelines.find((entry) => entry.id === "p-upload")!.stages.find((entry) => entry.id === "docs")!;
  uploadDocs.account = "account-c";
  const searchVerify = (pipelines.find((entry) => entry.id === "p-search")!.runs as unknown as Array<{ stageId: string; attempts: Array<Record<string, unknown>> }>).find((run) => run.stageId === "verify")!;
  searchVerify.attempts[1]!.accountId = "default";
}

/* K6: the accounts of each engine, as `GET /api/accounts` answers them, and the project's accounts (#1279). */
const resetIn = (minutes: number) => Math.floor(Date.now() / 1000) + minutes * 60;
const tierLimits = {
  session: { usedPercent: 12, resetsAt: resetIn(120), windowMinutes: 300 },
  weekly: { usedPercent: 30, resetsAt: resetIn(6000), windowMinutes: 10080 },
  tiers: CODENAME_TIERS ? [
    // The bucket key is a codename; the label is the provider's own, and the
    // label is what the operator must read (#1839).
    { tier: "nimbus_quill", label: "Fable", usedPercent: 88, resetsAt: resetIn(6000), windowMinutes: 10080 },
    // No label came with this one, so its bucket key is spelled out as words.
    { tier: "cedar_ember", usedPercent: 63, resetsAt: resetIn(6000), windowMinutes: 10080 },
  ] : [
    { tier: "fable", usedPercent: 88, resetsAt: resetIn(6000), windowMinutes: 10080 },
    { tier: "opus", usedPercent: 63, resetsAt: resetIn(6000), windowMinutes: 10080 },
  ],
  plan: "max", capturedAt: now,
};
const accountRow = (id: string, label: string, plan: string, usedPercent: number, resetsInMinutes: number) => ({
  id, label, kind: "managed", authPresent: true, loginPending: false, loginState: "authenticated", deviceAuth: null,
  auth: { state: "authenticated", plan },
  limits: { state: "fresh", session: { usedPercent, resetsAt: resetIn(resetsInMinutes), windowMinutes: 300 }, weekly: null },
});
const accountsBody = {
  claude: {
    active: "default",
    accounts: [accountRow("default", "Account A", "Max", 72, 140), accountRow("account-c", "Account C", "Max", 18, 170), accountRow("account-g", "Account G", "Pro", 41, 125), accountRow("account-e", "Account E", "Pro", 100, 80)],
    mutationLocked: false, migration: null, autoBalance: null,
  },
  codex: {
    active: "default",
    accounts: [accountRow("default", "Account B", "Pro", 35, 200), accountRow("account-d", "Account D", "Plus", 12, 230)],
    mutationLocked: false, migration: null, autoBalance: null,
  },
};
/* Claude work in this project may use accounts A, C and E; Codex is unbound. */
const CLAUDE_ALLOWED = ["default", "account-c", "account-e"];
const bindingsBody = {
  project: PROJECT, projectName: PROJECT, bindings: [],
  engines: {
    claude: { engine: "claude", restricted: true, allowed: CLAUDE_ALLOWED.map((accountId) => ({ accountId, label: accountId })), carrying: [], outsidePool: [] },
    codex: { engine: "codex", restricted: false, allowed: accountsBody.codex.accounts.map((row) => ({ accountId: row.id, label: row.label })), carrying: [], outsidePool: [] },
  },
};

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
  reviewFlow("flow-rounds-review", roundsBuild!, roundsReview!, ["REQUEST_CHANGES", "REQUEST_CHANGES", "REQUEST_CHANGES", "REQUEST_CHANGES", "APPROVE"], 3 * 60 * MIN),
] : LOOSE ? [reviewFlow("flow-export-review", exportImpl, exportReview!, ["APPROVE"], 30 * MIN)] : [];/* Ghost cards: the conversations behind them. */
const ghostOld = GHOSTS ? add(conversation("ghost-backfill", L("Migrate the invoice CSV importer to the new parser", "Перенести імпорт рахунків CSV на новий парсер"), { mtime: now - 3 * 24 * 60 * MIN, engine: "codex", model: "gpt-5.6" })) : null;
const ghostYoung = GHOSTS ? add(conversation("ghost-young", L("Starting on the settings audit", "Починаю аудит налаштувань"), working({ plan: { current: L("Reading the settings screen", "Читаю екран налаштувань") } }))) : null;
/* A launch whose receipt failed two minutes ago: no transcript, only its placeholder. */
const ghostFailed = GHOSTS ? add(conversation("ghost-failed", L("Rotate the webhook signing secret", "Замінити секрет підпису вебхуків"), {
  path: "spawn:launch-ghost-failed", size: 0, mtime: now - 2 * MIN, activityReason: "structured_spawn_failed",
  spawn: { launchId: "launch-ghost-failed", clientAttemptId: null, accountId: null, conversationId: "conversation_ghost-failed",
    state: "failed", initialMessage: "failed", retrySafe: true, error: "account limit reached: the weekly window resets in 3 days" },
})) : null;

/* The mixed card's launch whose receipt failed an hour ago: only its placeholder. */
const mixedFailed = UNSTARTED ? add(conversation("mixed-failed", L("Replay the missed webhook deliveries", "Повторити пропущені доставки вебхуків"), {
  path: "spawn:launch-mixed-failed", size: 0, mtime: now - 60 * MIN, activityReason: "structured_spawn_failed",
  spawn: { launchId: "launch-mixed-failed", clientAttemptId: null, accountId: null, conversationId: "conversation_mixed-failed",
    state: "failed", initialMessage: "failed", retrySafe: true, error: "account limit reached: the weekly window resets in 3 days" },
})) : null;

let revision = 1;
function task(id: string, status: TaskStatus, title: string, description: string, updatedAgo: number, members: FileEntry[] = [], over: Partial<BoardTask> = {}): BoardTask {
  return {
    id, project: PROJECT, text: description ? `${title}\n${description}` : title, status, placement: "unplaced",
    assignments: members.map((member) => ({ path: member.path, conversationId: member.conversationId, panePid: null, state: "delivered", error: null, at: iso(updatedAgo) })),
    createdAt: iso(updatedAgo + 60 * MIN), updatedAt: iso(updatedAgo), revision: REV(revision++), ...over,
  } as BoardTask;
}

const tasks: BoardTask[] = [
  ...(SCENARIO === "status-note" ? [task("t-note", "inbox", L("Review the route changes", "Перевірити зміни маршрутів"), L("Preserve the route contracts.", "Зберегти контракти маршрутів."), 2 * MIN, [], { note: {
    text: L("Waiting for the independent review of the changed routes and their persistence checks. The agent is verifying how updates survive concurrent writes, reloads and a restarted server before moving this task to the next stage.", "Очікує незалежного рев’ю змінених маршрутів і перевірок збереження даних. Агент перевіряє, як оновлення переживають одночасні записи, перезавантаження сторінки та перезапуск сервера, перш ніж перевести задачу до наступного етапу."),
    author: { kind: "orchestrator" }, updatedAt: iso(2 * MIN),
  } })] : []),
  /* The one task carrying agent-facing details (#1834): the long context an
     agent needs, which the card folds behind its Details row instead of
     printing where the human description belongs. */
  task("t-search", "assigned", "Restore search results after the index rebuild", "Results vanish for ten minutes after a rebuild. Keep the old index live until the new one answers.", 4 * MIN, [], {
    details: [
      "Stage: implement. Worktree /repo/atlas, branch lane/search-index-swap.",
      "Read the swap path in src/search/indexSwap.ts before changing anything: the old index must answer every read until the new one reports ready, and the swap is one atomic rename.",
      "Files another lane holds, do not edit: src/search/query.ts, src/search/ranking.ts, src/search/analyzers/*.",
      "Rules: no new dependency; no schema change; the rebuild stays resumable; every refusal names its field.",
      "Gates: the typecheck, the touched tests by path, the build.",
      "Known state: rebuild-12 left a half-written segment under var/index/next; the reader already skips it, the writer does not.",
      "Reads that reproduce it: GET /search?q=atlas during a rebuild, then again after the swap.",
      "Prior attempt: lane/search-index-lock held the whole index for the rebuild and timed out the reads; do not take that path again.",
      "Answer the operator with what the reads returned, never with what the code intends.",
      "Report through the stage tool; the verdict is the only completion channel.",
    ].join("\n"),
  } as Partial<BoardTask>),
  task("t-upload", "assigned", "Redesign attachment upload for large files", "Resumable uploads for files over 100 MB: chunked API, a progress UI that survives a reload, and docs.", 2 * MIN),
  task("t-export", "assigned", "Simplify the export settings sheet", "Fold the eleven toggles into three sensible presets and one advanced disclosure.", 9 * MIN, [exportImpl, exportExplore]),
  task("t-links", "assigned", "Repair old links in the release notes", "", 17 * MIN),
  ...(FLAT ? [task("t-mobile", "assigned", L("Mobile data: stop repeated full-board downloads and hidden-tab traffic", "Мобільні дані: припинити повторні завантаження всієї дошки й трафік прихованих вкладок"), L("A phone with the board open keeps downloading the whole board every few seconds, even in a hidden tab.", "Телефон із відкритою дошкою кожні кілька секунд завантажує її всю, навіть у прихованій вкладці."), 1 * MIN)] : []),
  ...(FLAT ? [] : [task("t-merge-a", "assigned", "Merge the approved queue adapter release · merge", "", 26 * 60 * MIN),
  task("t-verify-a", "assigned", "Verify delivery recovery across transcript boundaries · verify", "", 30 * 60 * MIN)]),
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
  /* Done three days ago leaves the board (8fcf1be0a): t-voice stays an hour
     inside that window, t-queue is past it. */
  task("t-voice", "done", "Keep the orchestrator role when voice is enabled", "", 3 * 24 * 60 * MIN - 60 * MIN),
  task("t-queue", "done", "Preserve native queue recovery through journal compaction", "", 4 * 24 * 60 * MIN),
  task("t-old", "done", "An empty task someone took off the board", "", 9 * 24 * 60 * MIN, [], { board: "hidden" }),
  ...(PIPELINES ? [task("t-rounds", "assigned", "Rework the retry banner until review passes", "", 12 * MIN)] : []),
  ...(SYNCED ? [
    task("t-rem-run", "assigned", L("Ship the synced task card", "Випустити картку синхронізованої задачі"), L("Show the other machine's stages on the card and mark it as managed there.", "Показати етапи з іншої машини на картці й позначити, що нею керують там."), 6 * MIN, [], { machine: STAGE_INSTALL } as Partial<BoardTask>),
    task("t-rem-wait", "assigned", L("Answer the deploy question on the stage box", "Відповісти на питання про розгортання на стенді"), "", 14 * MIN, [], { machine: STAGE_INSTALL } as Partial<BoardTask>),
    task("t-rem-old", "assigned", L("A task from a peer that predates lane rows", "Задача від вузла, що ще не знає про рядки етапів"), "", 31 * MIN, [], { machine: STAGE_INSTALL } as Partial<BoardTask>),
    task("t-rem-done", "done", L("Publish the linked boards guide", "Опублікувати посібник зі зв’язаних дошок"), "", 3 * 60 * MIN, [], { machine: STAGE_INSTALL } as Partial<BoardTask>),
  ] : []),
  ...(MANY ? [task("t-many", "assigned", "Kanban: say what each pipeline of a task does", "Five pipelines on one card: two running, three finished.", 5 * MIN)] : []),
  ...(MARKS ? [task("t-marks", "assigned", "Say who runs each stage, and how often an edge fired", "Two pipelines: one fail edge fired twice of three, one with its budget spent.", 4 * MIN)] : []),
  ...(GLYPHS ? [
    task("t-glyphs-run", "assigned", L("Every model at work", "Кожна модель у роботі"), L("Nine lanes, each running one model; the ninth has no glyph.", "Дев’ять конвеєрів, кожен запускає одну модель; дев’ята без гліфа."), 1 * MIN),
    task("t-glyphs", "assigned", L("Every model waiting, and the settled states", "Кожна модель чекає, і завершені стани"), L("A draft of nine stages, and two lanes that settled every model.", "Чернетка з дев’яти етапів і два конвеєри, де завершилася кожна модель."), 2 * MIN),
    task("t-glyphs-live", "assigned", L("Reviewing, committing, and working again", "Рев’ю, коміт і знову в роботі"), L("A review at work, a commit landing, and a passed stage whose conversation works again.", "Рев’ю в роботі, коміт, що завершується, і пройдений етап, чия розмова знову працює."), 3 * MIN),
  ] : []),
  ...(LOOPS ? [
    task("t-loops-done", "assigned", L("Show a spent review budget on the lane", "Показати вичерпаний бюджет рев’ю на лінії"), "", 4 * 60 * MIN),
    task("t-loops-review", "assigned", L("Show a spent review budget on the lane, again", "Показати вичерпаний бюджет рев’ю, знову"), "", 2 * MIN),
    task("t-loops-return", "assigned", L("Resume an upload after a reload", "Продовжити вивантаження після перезавантаження"), "", 3 * MIN),
    task("t-loops-retry", "assigned", L("Migrate the ledger to the new schema", "Перенести реєстр на нову схему"), "", 6 * MIN),
    task("t-loops-rework", "assigned", L("Keep the draft when the tab closes", "Зберегти чернетку, коли вкладку закрито"), "", 1 * MIN),
    task("t-loops-long", "assigned", L("Export every old format the importer reads", "Експортувати кожен старий формат, який читає імпорт"), "", 1 * MIN),
  ] : []),
  ...(STAGE_CHAIN ? [
    task("t-chain-operator", "done", L("Keep the review fix on the card", "Залишити виправлення рев’ю на картці"), "", 50 * MIN),
    task("t-chain-through", "done", L("Critique, then review, with a fix between", "Критика, потім рев’ю, з виправленням між ними"), "", 55 * MIN),
    task("t-chain-live", "blocked", L("Build, review and merge the export", "Зібрати, переглянути і злити експорт"), "", 10 * MIN),
    task("t-chain-long", "blocked", L("Confirm every attachment arrives whole", "Підтвердити, що кожне вкладення доходить цілим"), "", 8 * MIN),
    task("t-chain-wide", "assigned", L("Keep the review fix on the card, wide", "Залишити виправлення рев’ю на картці, широка"), "", 45 * MIN),
  ] : []),
  ...(LABELS ? [task("t-labels", "assigned", "Build the board header lane", "Design, build and critique; the critique sent the first build back.", 2 * MIN)] : []),
  ...(REVIEW_SPENT ? [task("t-review-spent", "assigned", "Show the retry count in the banner", "The last review failed, and the fix after it was never reviewed.", 3 * MIN)] : []),
  ...(GHOSTS ? [
    task("t-ghost-backfill", "assigned", L("Migrate the invoice CSV importer to the new parser", "Перенести імпорт рахунків CSV на новий парсер"), "", 3 * 24 * 60 * MIN, [ghostOld!], {
      origin: { kind: "conversation", key: "conversation_ghost-backfill", refinement: "pending" },
      assignments: [{ path: ghostOld!.path, conversationId: ghostOld!.conversationId, panePid: null, state: "linked", error: null, at: iso(3 * 24 * 60 * MIN) }],
    } as Partial<BoardTask>),
    task("t-ghost-fixture", "assigned", "Exercise legacy spawn fixture", "", 20 * 60 * MIN, [], {
      origin: { kind: "launch", key: "launch-ghost-fixture", refinement: "pending" },
      /* A row from before launches reserved a conversation: it never minted one. */
      assignments: [{ launchId: "launch-ghost-fixture", path: null, panePid: null, state: "linked", error: null, at: iso(20 * 60 * MIN), engine: "codex" }],
    } as Partial<BoardTask>),
    task("t-ghost-young", "assigned", L("Audit the settings screen", "Аудит екрана налаштувань"), "", 3 * MIN, [ghostYoung!], {
      origin: { kind: "launch", key: "launch-ghost-young", refinement: "pending" },
      createdAt: iso(3 * MIN),
    } as Partial<BoardTask>),
    task("t-ghost-failed", "assigned", L("Rotate the webhook signing secret", "Замінити секрет підпису вебхуків"), "", 2 * MIN, [], {
      origin: { kind: "launch", key: "launch-ghost-failed", refinement: "pending" },
      createdAt: iso(2 * MIN),
      assignments: [{ launchId: "launch-ghost-failed", conversationId: ghostFailed!.conversationId, path: ghostFailed!.path, panePid: null, state: "spawning", error: null, at: iso(2 * MIN), engine: "claude" }],
    } as Partial<BoardTask>),
    task("t-ghost-elsewhere", "assigned", L("Tune the upload retries", "Налаштувати повтори завантаження"), "", 26 * 60 * MIN, [], {
      assignments: [{ path: "/elsewhere/upload-retries.jsonl", conversationId: "conversation_upload-retries", panePid: null, state: "linked", error: null, at: iso(26 * 60 * MIN) }],
    } as Partial<BoardTask>),
  ] : []),
  ...(WALL ? [
    task("t-wall", "done", L("The privacy gate admits the sanctioned relay address", "Шлюз приватності пропускає дозволену адресу ретранслятора"), L("A narrow allowlist of public addresses, masked before the known-value match.", "Вузький список дозволених публічних адрес, що маскуються перед перевіркою відомих значень."), 150 * MIN, [], {
      assignments: wallRows("wall", 24) as unknown as BoardTask["assignments"],
    } as Partial<BoardTask>),
    task("t-wall-only", "done", L("Retire the old relay catalog entries", "Прибрати старі записи каталогу ретрансляторів"), "", 200 * MIN, [], {
      assignments: wallRows("only", 12) as unknown as BoardTask["assignments"],
    } as Partial<BoardTask>),
  ] : []),
  ...(UNSTARTED ? [
    task("t-lanes-sqlite", "inbox", L("Viewer state in SQLite: the remaining slices and dropping legacy JSON", "Стан Viewer у SQLite: решта зрізів і видалення legacy JSON"), L("Tasks, the agent registry, the board and accounts moved. Left: the remaining collections, one slice per lane.", "Переїхали задачі, реєстр агентів, дошка й акаунти. Лишилось: решта колекцій, по зрізу на лейн."), 2 * 24 * 60 * MIN, [], {
      assignments: sqliteRows as unknown as BoardTask["assignments"],
    } as Partial<BoardTask>),
    task("t-lanes-flows", "inbox", L("Retire flows: one mechanism, pipelines (continued)", "Прибрати флоу: один механізм — пайплайни (продовжити)"), L("The design is ready in nine slices. Next: freeze flows, then replace their UI with pipeline attempts.", "Дизайн готовий, девʼять зрізів. Далі: заморозити флоу, потім замінити їхній UI спробами пайплайна."), 2 * 24 * 60 * MIN, [], {
      assignments: flowsRows as unknown as BoardTask["assignments"],
    } as Partial<BoardTask>),
    task("t-lanes-mixed", "inbox", L("Replay the missed webhook deliveries", "Повторити пропущені доставки вебхуків"), "", 60 * MIN, [], {
      assignments: [
        ...mixedRows,
        ...["a", "b", "c"].map((id, index) => ({ launchId: `launch-mixed-legacy-${id}`, path: null, panePid: null, state: "linked", error: null, at: iso((2 * 24 + index) * 60 * MIN), engine: "codex" })),
        { launchId: "launch-mixed-failed", conversationId: mixedFailed!.conversationId, path: mixedFailed!.path, panePid: null, state: "spawning", error: null, at: iso(60 * MIN), engine: "claude" },
      ] as unknown as BoardTask["assignments"],
    } as Partial<BoardTask>),
  ] : []),
  ...(REVIEW_STOPS ? [
    task("t-stop-fix", "assigned", L("Composer model pills: one width at 390", "Кнопки моделі в композері однієї ширини"), L("At 390 px the model and effort pills drift apart. The operator wants to look before the merge.", "На 390 px кнопки моделі й зусилля розʼїжджаються. Оператор хоче подивитися перед мерджем."), 12 * MIN),
    task("t-stop-park", "assigned", L("Per-feature screenshot catalog and one capture command", "Каталог скриншотів по фічах і одна команда зйомки"), "", 6 * MIN),
    task("t-stop-once", "assigned", L("Deploy failure notifies the seat and the phone", "Сповіщення, коли деплой падає"), "", 4 * MIN),
    task("t-stop-done", "done", L("Conversation: wider agent replies", "Ширші відповіді агентів"), "", 170 * MIN),
    task("t-stop-legacy", "assigned", L("Screenshot catalog: one capture command for every feature", "Каталог скриншотів: одна команда зйомки для кожної фічі"), "", 2 * MIN),
  ] : []),
  ...(MERGE_STATES ? [
    task("t-merge-wait", "assigned", L("Deploy failure notifies the seat and the phone", "Сповіщення, коли деплой падає"), "", 12 * MIN),
    task("t-merge-update", "assigned", L("Composer model pills: one width at 390", "Кнопки моделі в композері однієї ширини"), "", 20 * MIN),
    task("t-merge-stop", "assigned", L("Per-feature screenshot catalog and one capture command", "Каталог скриншотів по фічах і одна команда зйомки"), "", 30 * MIN),
    task("t-merge-done", "done", L("Conversation: wider agent replies", "Ширші відповіді агентів"), "", 70 * MIN),
  ] : []),
  ...(TASK_FINISH ? [
    task("t-finish-marked", "assigned", L("Pipelines that finish their task", "Пайплайни, що завершують задачу"), "", 25 * MIN),
    task("t-finish-hold", "assigned", L("Merge when the review passes", "Мердж, коли ревʼю пройдено"), L("The setting, the runner, and its docs.", "Налаштування, мердж і документація."), 50 * MIN),
    task("t-finish-done", "done", L("Conversation: wider agent replies", "Ширші відповіді агентів"), "", 75 * MIN),
  ] : []),
  ...(ARCS ? [task("t-arcs", "assigned", "Draw a fail edge as a return arc under the row", "An edge at rest, one fired once, a spent budget in flight, a lane parked on a spent budget, and two edges into one stage.", 3 * MIN)] : []),
];

// Structured task motion, over the same real Viewer and existing fixture driver.
if (SCENARIO === "task-motion") {
  pipelines.splice(0, pipelines.length);
  tasks.splice(0, tasks.length,
    task("motion-inbox", "inbox", L("Plan the next audit", "Запланувати наступний аудит"), "", 30 * MIN),
    task("motion-working", "assigned", L("Finish the running work", "Завершити поточну роботу"), "", 5 * MIN, [exportImpl]),
    task("motion-stopped", "assigned", L("Finish the remaining work", "Завершити решту роботи"), "", 10 * MIN, [exportExplore]),
    task("motion-worker", "blocked", L("Wait for a free worker", "Дочекатися вільного агента"), "", 60 * MIN, [], { hold: { kind: "worker", note: L("After another task finishes", "Коли завершиться інша задача"), since: iso(60 * MIN), by: "agent" } }),
    task("motion-pr", "blocked", L("Wait for the release PR", "Дочекатися PR релізу"), "", 45 * MIN, [], { hold: { kind: "pr", ref: "2190", note: L("After merge", "Після злиття"), since: iso(45 * MIN), by: "agent" } }),
    task("motion-issue", "blocked", L("Wait for the issue", "Дочекатися issue"), "", 40 * MIN, [], { hold: { kind: "issue", ref: "2044", note: L("After closure", "Після закриття"), since: iso(40 * MIN), by: "agent" } }),
    task("motion-taskref", "blocked", L("Wait for the linked task", "Дочекатися повʼязаної задачі"), "", 35 * MIN, [], { hold: { kind: "task", ref: "motion-bare", note: L("After the audit review", "Після перевірки аудиту"), since: iso(35 * MIN), by: "agent" } }),
    task("motion-checklist", "blocked", L("Complete the audit causes", "Усунути причини аудиту"), "", 70 * MIN, [], { steps: [
      ...Array.from({ length: 5 }, (_, index) => ({ id: `fixed-${index + 1}`, text: L(`Fixed cause ${index + 1}`, `Усунена причина ${index + 1}`), state: "done" as const })),
      ...Array.from({ length: 3 }, (_, index) => ({ id: `open-${index + 1}`, text: L(`Remaining cause ${index + 1}`, `Невирішена причина ${index + 1}`), state: "open" as const, ...(index === 0 ? { ref: "p-motion-checklist" } : {}), hold: { kind: "worker" as const, note: L("After another task finishes", "Коли завершиться інша задача"), since: iso(70 * MIN), by: "agent" as const } })),
    ] }),
    task("motion-operator", "blocked", L("Choose the next release", "Обрати наступний реліз"), "", 20 * MIN, [], { steps: [{ id: "choose-release", text: L("Choose release", "Оберіть реліз"), state: "open", ref: "p-motion-operator", hold: { kind: "operator", note: L("Choose a release to publish", "Оберіть реліз для публікації"), since: iso(20 * MIN), by: "agent" } }] }),
    task("motion-long", "blocked", L("Migrate the legacy billing integration safely", "Безпечно перенести інтеграцію старих платежів"), "", 25 * MIN, [], { hold: { kind: "external", note: L("Waiting for the external audit team to finish its review of the migration plan and confirm that every legacy billing record has been reconciled before the cutover can proceed without risking customer invoices or payment history", "Очікуємо, поки зовнішня аудиторська команда завершить перевірку плану міграції та підтвердить звірку всіх старих платіжних записів, перш ніж продовжити перенесення без ризику для рахунків клієнтів та історії платежів").slice(0, 200), since: iso(25 * MIN), by: "agent" } }),
    task("motion-bare", "blocked", L("Review older work", "Переглянути давнішу роботу"), "", 120 * MIN),
    task("motion-due", "blocked", L("Run the postponed check", "Виконати відкладену перевірку"), "", 120 * MIN, [], { hold: { kind: "postponed", note: L("After green checks", "Після успішних перевірок"), since: iso(120 * MIN), until: iso(60 * MIN), by: "operator" } }),
    task("motion-done", "done", L("Completed review", "Завершене ревʼю"), "", 10 * MIN, [], { doneAt: iso(10 * MIN) }),
    task("motion-hidden", "blocked", L("Hidden older work", "Прихована давніша робота"), "", 120 * MIN, [], { groupHidden: { at: iso(60 * MIN), by: "operator", admitted: [] } }),
  );
  pipelines.push(pipeline("p-motion-checklist", L("Run one checklist cause", "Виконати одну причину аудиту"), "motion-checklist", "running",
    [stage("implement", "builder", null)],
    [{ stageId: "implement", attempts: [attempt(1, "running", null)] }],
    { stageId: "implement", state: "running", input: null, activatedBy: null }));
  pipelines.push(pipeline("p-motion-operator", L("Wait for release choice", "Дочекатися вибору релізу"), "motion-operator", "paused",
    [stage("implement", "builder", null)],
    [{ stageId: "implement", attempts: [attempt(1, "passed", null)] }],
    { stageId: "implement", state: "committing", input: null, activatedBy: null },
    { pausedAt: iso(10 * MIN), pausedState: "running" }));
}

/* Queued holds side by side: a worker slot wait with and without a note, and
   a resource hold with its note and without one. */
if (SCENARIO === "hold-kinds") {
  pipelines.splice(0, pipelines.length);
  tasks.splice(0, tasks.length,
    task("hold-slot", "blocked", L("Start the review lane", "Запустити лінію ревʼю"), "", 30 * MIN, [], { hold: { kind: "worker", note: "", since: iso(30 * MIN), by: "agent" } }),
    task("hold-slot-note", "blocked", L("Start the docs lane", "Запустити лінію документації"), "", 20 * MIN, [], { hold: { kind: "worker", note: L("Three of three workers busy", "Зайняті всі три агенти"), since: iso(20 * MIN), by: "agent" } }),
    task("hold-resource-note", "blocked", L("Run the full build", "Запустити повну збірку"), "", 15 * MIN, [], { hold: { kind: "resource", note: L("4 GB of memory available, 8 GB needed", "Доступно 4 ГБ памʼяті, потрібно 8 ГБ"), since: iso(15 * MIN), by: "agent" } }),
    task("hold-resource", "blocked", L("Older resource hold", "Давніша причина про ресурси"), "", 60 * MIN, [], { hold: { kind: "resource", note: "", since: iso(60 * MIN), by: "agent" } }),
  );
}

/* `&empty=<status>` empties one column: its tasks move to Done, so the
   column's strip can be read beside the others (an empty column folds). */
const EMPTY_COLUMN = new URLSearchParams(location.search).get("empty");
/* Completion expiry: one corpus used on desktop and phone, with an old
   staffed row, a recent done row and a legacy row. */
if (SCENARIO === "done-expiry") {
  tasks.splice(0, tasks.length,
    withTaskCompletion(task("t-expired", "done", "Retained completion history", "", 4 * 24 * 60 * MIN, [searchImpl1])),
    withTaskCompletion(task("t-recent", "done", "Recent completion", "", 60 * MIN)),
    task("t-legacy", "done", "Legacy completion history", "", 5 * 24 * 60 * MIN, [searchImpl2]),
    task("t-reopen", "assigned", "Reopened completion", "", 60 * MIN),
  );
}
if (EMPTY_COLUMN) for (const entry of tasks) if (entry.status === EMPTY_COLUMN) entry.status = "done";

if (FLAT) {
  const retitle: Record<string, [string, string, string, string]> = {
    "t-review-spent": ["GitHub Copilot as a third engine the Viewer can launch", "The last review failed, and the fix after it was never reviewed.", "GitHub Copilot як третій рушій, який Viewer уміє запускати", "Останнє рев’ю не пройшло, а виправлення після нього ніхто не перевірив."],
    "t-many": ["Kanban: say what each pipeline of a task does, and fold the finished ones behind their count", "Seven pipelines on one card: four running, three finished.", "Канбан: казати, що робить кожен конвеєр задачі, і згортати завершені за лічильником", "Сім конвеєрів на одній картці: чотири працюють, три завершені."],
    "t-search": ["Restore search results after the index rebuild", "Results vanish for ten minutes after a rebuild. Keep the old index live until the new one answers.", "Повернути результати пошуку після перебудови індексу", "Результати зникають на десять хвилин після перебудови. Тримати старий індекс, доки новий не відповість."],
    "t-upload": ["Redesign attachment upload for large files", "Resumable uploads for files over 100 MB: chunked API, a progress UI that survives a reload, and docs.", "Переробити завантаження великих вкладень", "Відновлюване завантаження файлів понад 100 МБ: API частинами, прогрес, що переживає перезавантаження, і документація."],
    "t-export": ["Simplify the export settings sheet", "Fold the eleven toggles into three sensible presets and one advanced disclosure.", "Спростити аркуш налаштувань експорту", "Згорнути одинадцять перемикачів у три розумні пресети й один розширений розділ."],
    "t-links": ["Repair old links in the release notes", "", "Полагодити старі посилання в нотатках до випуску", ""],
    "t-disk": ["Disk space: find what Docker, worktrees and temp storage hold", "", "Місце на диску: знайти, що тримають Docker, worktree і тимчасові файли", ""],
    "t-rounds": ["Rework the retry banner until review passes", "", "Переробляти банер повтору, доки рев’ю не пройде", ""],
  };
  for (let index = 0; index < tasks.length; index += 1) {
    const entry = retitle[tasks[index]!.id];
    if (!entry) continue;
    const [title, description] = UK ? [entry[2], entry[3]] : [entry[0], entry[1]];
    tasks[index] = { ...tasks[index]!, text: description ? `${title}\n${description}` : title } as BoardTask;
  }
  const rename: Record<string, [string, string]> = {
    "p-review-spent": ["Launch Copilot sessions from the composer", "Запускати сесії Copilot із композера"],
    "p-many-pills": ["Name every pipeline row on a task card", "Назвати кожен рядок конвеєра на картці задачі"],
    "p-many-drawers": ["Remove the legacy drawers under the board columns", "Прибрати старі шухляди під колонками дошки"],
    "p-search": ["Restore search results after the index rebuild", "Повернути результати пошуку після перебудови індексу"],
    "p-upload": ["Redesign attachment upload for large files", "Переробити завантаження великих вкладень"],
    "p-links": ["Repair old links in the release notes", "Полагодити старі посилання в нотатках до випуску"],
    "p-rounds": ["Rework the retry banner until review passes", "Переробляти банер повтору, доки рев’ю не пройде"],
  };
  for (const lane of pipelines) {
    const names = rename[lane.id];
    if (names) (lane as { task: string }).task = UK ? names[1] : names[0];
  }
}
// Stopped launch receipts on a completed task, including a still-retryable parked lane.
if (SCENARIO === "stopped-launches") {
  const launches = ["closed", "needs_decision"].map((state) => {
    const launchId = `launch-${state}`;
    const file = conversation(`stopped-${state}`, `Stopped ${state} launch`, {
      path: `spawn:${launchId}`, size: 0, mtime: now, activityReason: "structured_spawn_failed",
      spawn: { launchId, clientAttemptId: null, accountId: null, state: "failed",
        initialMessage: "failed", retrySafe: true, error: "stage launch never started: runtime host recovery exhausted after 2 checks" },
      durableLineage: { kind: "spawn", role: "builder", parentConversationId: null, reviewsConversationId: null,
        memberships: [{ kind: "pipeline", containerId: `p-${state}`, role: "builder", slot: "build",
          stageId: "build", stageOrder: 0, round: null, parentConversationId: null }] },
    });
    return { file, pipeline: pipeline(`p-${state}`, `Stopped ${state} launch`, "t-stopped", state,
      [stage("build", "builder", null)],
      [{ stageId: "build", attempts: [attempt(1, "failed", file, { agentPath: null, launchId, completedAt: iso(0) })] }],
      { stageId: "build", state: "needs_decision", input: null, activatedBy: null }) };
  });
  files.splice(0, files.length, ...launches.map((entry) => entry.file));
  pipelines.splice(0, pipelines.length, ...launches.map((entry) => entry.pipeline));
  tasks.splice(0, tasks.length, task("t-stopped", "done", "Recover stopped launches", "", 0, files));
}
/* Board order: an Assigned column as the operator reported it on 2026-09-24.
   `t-order-tint`'s build stage is running and its conversation is live on the
   host's turn evidence, with neither a turn boundary nor an agent-work stamp
   on its row yet, which is how the live row read. Beside it, a direct worker
   and a research lane at work, a card whose agent finished minutes ago, one
   that finished yesterday, and a task nobody has worked on that was edited a
   minute ago. */
if (BOARD_ORDER) {
  const agent = (id: string, title: string, over: Record<string, unknown>) => conversation(id, title, over);
  const live = (turnAgo: number | null, workAgo: number | null, over: Record<string, unknown> = {}) => ({
    ...working({ mtime: now - (workAgo ?? 114) }),
    activityReason: "turn_evidence_working",
    lastTurn: turnAgo === null ? undefined : { startedAt: (now - turnAgo) * 1_000, endedAt: null },
    ...(workAgo === null ? {} : { lastAgentWorkAt: (now - workAgo) * 1_000 }),
    ...over,
  });
  const ended = (workAgo: number) => ({
    activity: workAgo < 15 * MIN ? "recent" : "idle", mtime: now - workAgo, lastAgentWorkAt: (now - workAgo) * 1_000,
    authoritativeTurn: { state: "terminal", source: "lifecycle", terminalAt: iso(workAgo) },
    lastTurn: { startedAt: (now - workAgo - 20 * MIN) * 1_000, endedAt: (now - workAgo) * 1_000 },
  });
  const tint = agent("order-tint-build", L("Builder: one icon and colour rule for every new task", "Білдер: одне правило іконки й кольору для кожної нової задачі"),
    live(null, null, { authoritativeTurn: { state: "unknown", source: "empty", terminalAt: null }, lastTurn: undefined }));
  const maint = agent("order-maint", L("Keeping the board's tasks current", "Тримаю задачі дошки актуальними"), live(7 * MIN, 119, { plan: { current: L("Closing tasks whose PRs merged", "Закриваю задачі зі злитими PR") } }));
  const research = agent("order-research", L("Architect: interface improvements from the design skills", "Архітектор: покращення інтерфейсу за дизайн-скілами"), live(35 * MIN, 189));
  const review = agent("order-review", L("Image viewer: arrows and click-outside close", "Перегляд зображень: стрілки й закриття кліком поза ним"), ended(408));
  const yesterday = agent("order-yesterday", L("Rate-limit banner copy", "Текст банера про ліміт"), ended(26 * 60 * MIN));
  const lane = (id: string, stageId: string, file: FileEntry, startedAgo: number) => pipeline(id, `Lane ${id}`, id.replace(/^p-/, "t-"), "running",
    [stage(stageId, "builder", "review"), stage("review", "builder", null)],
    [{ stageId, attempts: [attempt(1, "running", file, { startedAt: iso(startedAgo) })] }],
    { stageId, state: "running", input: null, activatedBy: null });
  files.splice(0, files.length, orchestrator, tint, maint, research, review, yesterday);
  pipelines.splice(0, pipelines.length, lane("p-order-tint", "build", tint, 2 * MIN), lane("p-order-research", "research", research, 35 * MIN));
  tasks.splice(0, tasks.length,
    task("t-order-tint", "assigned", L("Every new task gets an icon and a colour by one rule", "Кожна нова задача отримує іконку й колір за одним правилом"), "", 2 * MIN),
    task("t-order-maint", "assigned", L("Board upkeep: an agent that keeps tasks current", "Обслуговування дошки: агент, який тримає задачі актуальними"), "", 7 * MIN, [maint]),
    task("t-order-research", "assigned", L("Research: improving the interface with the design skills", "Дослідження: як покращити інтерфейс за дизайн-скілами"), "", 35 * MIN),
    task("t-order-review", "assigned", L("Agent image viewer: arrows and click-outside close", "Перегляд зображень агента: стрілки й закриття кліком поза ним"), "", 30 * MIN, [review]),
    task("t-order-yesterday", "assigned", L("Rate-limit banner copy", "Текст банера про ліміт"), "", 26 * 60 * MIN, [yesterday]),
    task("t-order-notes", "assigned", L("Write the upgrade notes", "Написати нотатки до оновлення"), L("Nobody has worked on it yet.", "Над нею ще ніхто не працював."), 1 * MIN),
  );
}
if (TICK_CARDS) {
  const texts = JSON.parse(decodeURIComponent(escape(atob(new URLSearchParams(location.search).get("texts") ?? "e30=")))) as { notice: string; failed: string; live: string };
  files.splice(0, files.length, orchestrator);
  pipelines.splice(0, pipelines.length);
  tasks.splice(0, tasks.length,
    task("t-tick-notice", "inbox", texts.notice, "", 14 * MIN, [], { color: "amber", icon: "timer" }),
    task("t-tick-cleanup", "inbox", L("Remove the unused tmux helpers", "Прибрати невживані помічники tmux"), "", 3 * 60 * MIN, [], { color: "slate", icon: "wrench" }),
    task("t-tick-live", "assigned", texts.live, "", 6 * MIN, [], { color: "slate", icon: "brush-cleaning" }),
    task("t-tick-search", "assigned", L("Restore search results after the index rebuild", "Повернути результати пошуку після перебудови індексу"), "", 25 * MIN),
    task("t-tick-failed", "blocked", texts.failed, "", 40 * MIN, [], { color: "slate", icon: "brush-cleaning" }),
  );
}
if (PRIORITY) {
  const helper = conversation("priority-helper", L("Implementer: remove the unused tmux helpers", "Імплементер: прибрати невживані помічники tmux"), working({ plan: { current: L("Deleting the pane scraper", "Видаляю зчитувач панелей") } }));
  const banner = conversation("priority-banner", L("Builder: the limit banner copy", "Білдер: текст банера про ліміт"), working({ plan: { current: L("Wording the reset time", "Формулюю час скидання") } }));
  files.splice(0, files.length, orchestrator, helper, banner);
  pipelines.splice(0, pipelines.length);
  tasks.splice(0, tasks.length,
    /* Inbox, in the order tasks arrived: the column sorts them. */
    task("t-prio-cleanup", "inbox", L("Remove the unused tmux helpers", "Прибрати невживані помічники tmux"), L("Nothing calls them since the structured transport.", "Їх ніхто не викликає відтоді, як є структурований транспорт."), 3 * MIN, [helper], { priority: "low", color: "slate", icon: "wrench" }),
    task("t-prio-notes", "inbox", L("Write the upgrade notes for 1.5", "Написати нотатки до оновлення 1.5"), "", 12 * MIN, [], { color: "pink", icon: "file-text" }),
    task("t-prio-deploy", "inbox", L("A failed deploy tells the seat and the phone", "Невдалий деплой повідомляє сесію та телефон"), L("Today it fails silently until someone opens the board.", "Зараз він падає тихо, поки хтось не відкриє дошку."), 40 * MIN, [], { priority: "high", color: "coral", icon: "siren" }),
    task("t-prio-export", "inbox", L("Export a board as Markdown", "Експорт дошки в Markdown"), "", 2 * 60 * MIN, [], { color: "lime", icon: "file-down" }),
    task("t-prio-idea", "inbox", L("Try a compact density for the Done column", "Спробувати щільніший вигляд колонки «Готово»"), "", 26 * 60 * MIN, [], { priority: "low", color: "sky", icon: "layout-dashboard" }),
    task("t-prio-limits", "inbox", L("Spend quota before its window resets", "Витратити квоту до скидання вікна"), L("Two accounts reset tonight with most of their week unused.", "Два облікові записи скидаються сьогодні ввечері з майже невикористаним тижнем."), 3 * 24 * 60 * MIN, [], { priority: "high", color: "amber", icon: "key-round" }),
    /* Assigned keeps the most recent agent work on top, whatever the priority. */
    task("t-prio-banner", "assigned", L("Rate-limit banner copy", "Текст банера про ліміт"), "", 20 * MIN, [banner], { priority: "low", color: "sky", icon: "megaphone" }),
    task("t-prio-search", "assigned", L("Restore search results after the index rebuild", "Повернути результати пошуку після перебудови індексу"), "", 5 * 60 * MIN, [], { priority: "high", color: "coral", icon: "bug" }),
    task("t-prio-docs", "assigned", L("Document the merge setting", "Задокументувати налаштування мерджу"), "", 9 * 60 * MIN, [], { color: "pink", icon: "book-open" }),
  );
}
if (BALANCE) {
  for (const column of BALANCE_COLUMNS) {
    tasks.push(task(`t-bal-${column}`, column, `Stage pills in ${column}: 5, 20 and 40 character names`, "One-stage chains and Build → Review with a fail loop that fired.", 1 * MIN));
  }
  /* A shelf with many cards, each with a title long enough to wrap. */
  for (let index = 0; index < 8; index += 1) {
    tasks.push(task(`t-bal-long-${index}`, "inbox", `Investigate why the nightly export of the partner ledger drops rows when the upstream feed arrives after the cut-off window, case ${index + 1}`, "", (index + 2) * 60 * MIN));
  }
}
if (DRAG_BOARD) {
  const columns: TaskStatus[] = ["inbox", "assigned", "assigned", "blocked", "done"];
  for (let index = 0; index < 48; index += 1) {
    const id = `t-drag-${index}`;
    const status = columns[index % columns.length]!;
    const title = `Investigate why the nightly export of the partner ledger drops rows when the upstream feed arrives after the cut-off window, case ${index + 1}`;
    const members = status === "assigned" || index % 3 === 0
      ? [add(conversation(`drag-${index}-impl`, `Implementer: ${title.slice(0, 60)}`, index % 2 === 0 ? working({ model: "opus" }) : {})), add(conversation(`drag-${index}-rev`, `Reviewer: ${title.slice(0, 60)}`, { engine: "codex", model: "gpt-5.6" }))]
      : [];
    tasks.push(task(id, status, title, "Rows from the late feed are written after the ledger closes, so the export sees a shorter table than the bank file. Compare both before the cut-off and name the first row that differs.", (index + 1) * 7 * MIN, members));
    if (index % 2 === 0 && members[0]) {
      pipelines.push(pipeline(`p-drag-${index}`, title, id, "running",
        [stage("build", "builder", "review"), stage("review", "reviewer", "verify"), stage("verify", "verifier", null)],
        [
          { stageId: "build", attempts: [attempt(1, "passed", members[0], { startedAt: iso(80 * MIN) })] },
          { stageId: "review", attempts: [attempt(1, "running", members[1] ?? null, { startedAt: iso(20 * MIN) })] },
        ],
        { stageId: "review", state: "running", input: null, activatedBy: null }));
    }
  }
}
if (OVERVIEW_SCOPE) {
  tasks.push(
    task("t-ledger", "assigned", "Reconcile the ledger export against the bank file", "Two of the quarter's statements disagree by one day.", 3 * MIN, [ledgerBuild!], { project: LEDGER }),
    task("t-ledger-quiet", "assigned", "Archive last quarter's statements", "", 4 * 60 * MIN, [ledgerQuiet!], { project: LEDGER }),
    task("t-mesh", "blocked", "Unblock the mesh id migration", "The old ids must survive the cut-over.", 11 * MIN, [meshAsk!], { project: MESH }),
    task("t-mesh-quiet", "done", "Write the migration notes", "", 6 * 60 * MIN, [meshQuiet!], { project: MESH }),
  );
}
if (ICONS) {
  const stored: Record<string, string> = {
    "t-upload": "cloud-upload", "t-disk": "hard-drive", "t-auth": "key-round", "t-interrupt": "hand",
    "t-many": "kanban", "t-review-spent": "bot", "t-ledger": "landmark", "t-mesh": "network",
  };
  for (let index = 0; index < tasks.length; index += 1) {
    const icon = stored[tasks[index]!.id];
    if (icon) tasks[index] = { ...tasks[index]!, icon } as BoardTask;
  }
}
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
  tasks.push(task("t-seat", "assigned", "Coordinate the atlas release", "What the orchestrator is steering this week.", 30 * MIN, [orchestrator, seatNotes!]));
  hide("t-seat", "agent", 10 * 60 * MIN);
}

/* Short transcripts in the Claude line format, so every reader has a feed. */
const line = (secondsAgo: number, body: Record<string, unknown>) => JSON.stringify({ timestamp: iso(secondsAgo), ...body });
const said = (secondsAgo: number, text: string) => line(secondsAgo, { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const asked = (secondsAgo: number, text: string) => line(secondsAgo, { type: "user", message: { role: "user", content: text }, promptSource: "typed", origin: { kind: "human" } });
/* A Claude seat's mandate is journaled the way the SDK delivers it: `promptSource: "sdk"` with an engine uuid. */
const FM_SEAT_UUID = "engine_message_seat_mandate";
const delivered = (secondsAgo: number, text: string) => line(secondsAgo, { type: "user", uuid: FM_SEAT_UUID, message: { role: "user", content: text }, promptSource: "sdk" });
const tool = (secondsAgo: number, id: string, name: string, input: Record<string, unknown>) => [
  line(secondsAgo, { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } }),
  line(secondsAgo - 2, { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } }),
];
function transcriptOf(pathname: string): string {
  const file = files.find((entry) => entry.path === pathname);
  if (!file || file === pendingWorker) return "";
  /* A launch the transcript has not appeared for reads nothing. */
  if ((LAUNCH_CLS || SEAT_CLS || NEW_AGENT) && file.path.startsWith("spawn:")) return "";
  if (SCENARIO === "fast-tts") return `${said(10, "The first sentence should start speaking immediately. The next sentences should arrive while the first one plays. A single tap in the conversation header starts reading the answer. A second tap stops the voice immediately. Starting another answer cancels the previous read. Highlighting follows the sentence that is being spoken.")}\n`;
  /* The running verifier has a long transcript: its reader scrolls. */
  if (FEED_RELOAD && file === searchVer2) return `${[
    asked(600, L("Please check the result.", "Перевір результат, будь ласка.")),
    said(590, L("The result holds: every check passed.", "Результат тримається: усі перевірки пройшли.")),
    asked(300, L("Please continue with the next step.", "Продовжуй наступний крок, будь ласка.")),
    said(290, L("The next step is done.", "Наступний крок виконано.")),
  ].join("\n")}\n`;
  if (FEED_CONTINUITY && file === searchVer2) return `${[
    asked(120, L("Please check the result.", "Перевір результат, будь ласка.")),
    ...(feedContinuityStep >= 1 ? [asked(30, L("Please continue with the next step.", "Продовжуй наступний крок, будь ласка."))] : []),
    ...(feedContinuityStep >= 3 ? [line(60, { type: "assistant", uuid: "continuity-answer", message: { content: [{ type: "text", text: continuousAnswer }] } })] : []),
  ].join("\n")}\n`;
  if (FEED_FAILURES && file === searchVer2) return `${[
    line(60, { type: "event_msg", payload: { type: "task_complete", error: { message: "fixture provider failure", codex_error_info: "unauthorized" } } }),
    line(30, { type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "fixture-failed-tool", arguments: JSON.stringify({ fixtureToolArgs: true, cmd: "pwd" }) } }),
  ].join("\n")}\n`;
  if (FEED_RECOVERY && file === searchVer2) return `${[said(120, L("Ready for the next request.", "Готовий до наступного запиту.")), ...(feedRecoveryEcho ? [asked(0, delayedLaunchText)] : [])].join("\n")}\n`;
  if (file === searchVer2) {
    const long = [asked(90 * MIN, `${file.title} — pick it up from the task text.`)];
    for (let step = 0; step < 24; step += 1) long.push(said((88 - step * 3) * MIN, `Step ${step + 1}: re-ran the rebuild against live traffic and checked the alias swap window.`));
    return `${long.join("\n")}\n`;
  }
  if (FIRST_MESSAGE && file === orchestrator) {
    if (String(file.path).startsWith("spawn:")) return "";
    const user = FM_ENGINE === "codex"
      ? line(60, { type: "response_item", payload: { type: "message", id: FM_SEAT_UUID, role: "user", content: [{ type: "input_text", text: fmDeliveredText() }] } })
      : FM_SEAT ? delivered(60, fmDeliveredText()) : asked(60, fmDeliveredText());
    const answer = FM_ENGINE === "codex"
      ? line(20, { type: "response_item", payload: { type: "message", id: "seat_answer", role: "assistant", content: [{ type: "output_text", text: "Looking at the export test." }] } })
      : said(20, "Looking at the export test.");
    return `${[user, ...(fm.step >= (FM_HANDOVER ? 2 : 3) ? [answer] : [])].join("\n")}\n`;
  }
  if (SEAT_NOISE && file === orchestrator) {
    if (file.spawn) return "";
    if (file.engine === "codex") {
      const rollout = (secondsAgo: number, payload: Record<string, unknown>) => JSON.stringify({ type: "event_msg", timestamp: iso(secondsAgo), payload });
      return `${[
        rollout(8 * MIN, { type: "user_message", message: "Keep the search fix moving." }),
        rollout(2 * MIN, { type: "agent_message", message: "Search: the verifier passed on the second attempt. Nothing needs you." }),
      ].join("\n")}\n`;
    }
    return `${[
      asked(8 * MIN, "Keep the search fix moving."),
      ...tool(7 * MIN, "toolu_seat_search", "ToolSearch", { query: "select:mcp__viewer__list_pipelines", max_results: 1 }),
      ...tool(6 * MIN, "toolu_seat_list", "mcp__viewer__list_pipelines", { project: PROJECT }),
      /* The rows the operator asked to keep visible but cut to one line (b1-b3 of the design note). */
      ...tool(5 * MIN, "toolu_seat_get_task", "mcp__viewer__get_task", { taskId: SEAT_TASK_ID }),
      ...tool(4 * MIN, "toolu_seat_update_task", "mcp__viewer__update_task", { taskId: SEAT_TASK_ID, status: "assigned" }),
      ...tool(3 * MIN, "toolu_seat_shell", "Bash", { command: SEAT_SHELL, description: "Check the worktree" }),
      said(2 * MIN, "Search: the verifier passed on the second attempt. Nothing needs you."),
    ].join("\n")}\n`;
  }
  if (REPORT_PREVIEW && file === orchestrator) {
    /* Documentation-range addresses and invented names; the path and the token are joined here so no line of this file holds one. */
    const path = ["", "home", "someone", ".config", "app", "state", "launches.json"].join("/");
    const token = ["ghp", "0123456789abcdefghijklmnopqrstuvwxyzAB"].join("_");
    const symptom = 'The tool answered "connection refused during startup".';
    const expected = "## Expected behaviour\nThe requested agent starts.";
    const bodies: Record<string, string> = {
      many: [
        "## Symptom", symptom, "",
        "> the operator said the second project should start first", "",
        "## Evidence",
        `It read ${path} for the launch.`,
        "The host answered from 203.0.113.22:8898 and from 198.51.100.7.",
        `Contact someone@example.org for the trace; token ${token} was in the header.`,
        "![screenshot of the board](board.png)", "",
        expected,
      ].join("\n"),
      long: [
        "## Symptom", symptom, "",
        ...Array.from({ length: 9 }, (_, step) => `## Step ${step + 1}\nThe seat asked for an agent on the second project, the launch was admitted, and a moment later the tool answered that the requested launch cannot start while another one holds the project. Nothing else was running at that time.\n`),
        "## What the tool printed", "```", "launch refused: the project is held", "retry after the holder finishes", "```", "",
        "| Attempt | Answer |", "| --- | --- |", "| first | refused |", "| second | refused |", "",
        expected,
      ].join("\n"),
    };
    const title = REPORT_PREVIEW === "long"
      ? "Delegatus refuses a requested launch on the second project while nothing holds it, and the refusal names a holder that finished long before the request"
      : "Delegatus refuses a requested launch";
    const body = bodies[REPORT_PREVIEW] ?? `## Symptom\n${symptom}\n\n${expected}`;
    const judgment = REPORT_PREVIEW === "many" ? {
      assessment: "I reviewed the whole text. Several details still identify a machine and one line quotes the operator; I am returning it so you can see what remains.",
      removed: "Nothing yet in this draft.",
      harmlessHints: "The quoted tool answer is a technical error message and identifies nobody.",
      uncertainties: "The addresses, the path, the email, the token, the screenshot and the operator's quoted words should probably go.",
    } : {
      assessment: "I reviewed the whole text and judge it suitable for publication.",
      removed: "Removed machine and account details.",
      harmlessHints: "The quotation is a technical error message; it identifies no person or account.",
      uncertainties: "None after reviewing the whole text.",
    };
    /* The hints the detectors answer for these spans, written out: the detector module reads server state and stays out of this bundle. */
    const hint = (kind: IssueReportFinding["class"], label: string, text: string): IssueReportFinding => {
      const start = body.indexOf(text);
      return { class: kind, label, where: "body", lines: [body.slice(0, start).split("\n").length], reading: "written", span: { start, end: start + text.length, text } };
    };
    const quotation = hint("quote", "a quotation", '"connection refused during startup"');
    const hints = REPORT_PREVIEW !== "many" ? [quotation] : [
      quotation,
      hint("quote", "a quoted block", "> the operator said the second project should start first"),
      hint("path", "a local path", path),
      hint("home_path", "a home directory path", path.slice(0, path.indexOf("/.config") + 1)),
      hint("port", "a port", "203.0.113.22:8898"),
      hint("ip", "an IP address", "203.0.113.22"),
      hint("ip", "an IP address", "198.51.100.7"),
      hint("email", "an email address", "someone@example.org"),
      hint("domain", "a domain", "example.org"),
      hint("secret", "a secret", token),
      hint("credential", "a credential", token),
      hint("image", "an embedded image; review screenshot redaction", "![screenshot of the board]("),
    ];
    const preview = issueReportPreviewText({
      digest: REPORT_PREVIEW_DIGEST, title, body,
      ...(REPORT_PREVIEW === "legacy" ? {} : {
        privacyJudgment: judgment,
        hints: REPORT_PREVIEW === "none" ? [] : hints,
        hintWarnings: REPORT_PREVIEW === "many" ? ["Known-name hints are unavailable; review names and identities yourself."] : [],
      }),
    }, reportPreviewLanguage());
    return `${[asked(120, "Prepare a report for me to review."), said(60, preview)].join("\n")}\n`;
  }
  if (AGENT_REPORT && file === orchestrator) {
    return `${[
      asked(12 * MIN, "Where are we on the release? Give me the whole picture before I decide what to cut."),
      said(11 * MIN, [
        "Here is where the release stands. Two lanes are done, one is in review and one is waiting on you; nothing is blocked on infrastructure.",
        "",
        "**Done**",
        "- Search: the verifier failed once (results were empty for 40 s after the alias swap), the fail edge sent it back to Implement, and attempt 2 passed review. Verify is green on the live index.",
        "- Export presets: the eleven toggles are three presets and one advanced sheet; the old keys still read, and a saved export from last month opens unchanged.",
        "",
        "**Waiting on you**",
        "1. Release notes: two anchors match the same heading, and the implementer needs to know which one wins before it rewrites the links.",
        "2. Passkeys: the fallback pipeline needs the domain settled; I have not started it.",
        "",
        "The check the verifier ran, for the record:",
        "",
        "```",
        "bun scripts/verify-search.ts --index live --swap-window 60s",
        "  swap window      41.8 s   (limit 60 s)",
        "  empty results     0 of 1 200 queries",
        "```",
        "",
        "| Lane | Stage | State | Since |",
        "| --- | --- | --- | --- |",
        "| Search fix | Verify | passed | 09:40 |",
        "| Export presets | Review | round 2 | 10:05 |",
        "| Release notes | Implement | waiting on you | 10:12 |",
        "| Passkey fallback | not started | needs the domain | - |",
        "",
        "If you pick the first anchor, I can have the release notes merged within the hour and cut the release after Verify reruns on the merged head.",
      ].join("\n")),
      asked(4 * MIN, "First anchor. Go."),
      said(3 * MIN, "Told the implementer: the first anchor wins. I will report back when the release notes are merged and Verify has rerun on the merged head."),
    ].join("\n")}\n`;
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

/* The orchestrator's wires (docs/design/orchestrator-arrows.md). The seat made the lanes on five open
   tasks and spawned the export implementer; `&many=1` fills the board to about a hundred cards, a third
   of them the seat's. `orchestratorAct` makes somebody act: the record changes the way that writer's own
   write changes it (a `statusBy` on a moved or created task, a new lane, a new attempt carrying the
   `launchedBy` the engine writes for a launch by hand) and the board reloads it as it reloads any
   change; `ago` dates the act that many ms back, as a delta read after a connection gap. Nothing here
   draws: the product's own layer reads the records. */
if (ARROWS) {
  const seatId = orchestrator.conversationId!;
  for (const lane of pipelines) if (["p-search", "p-upload", "p-links", "p-limits", "p-rounds"].includes(lane.id)) lane.srcConversationId = seatId;
  Object.assign(exportImpl, { durableLineage: { kind: "spawn", role: "builder", depth: 1, parentConversationId: seatId, reviewsConversationId: null, memberships: [] } });
  if (params.get("many") === "1") {
    const areas = ["export", "search", "upload", "billing", "sign-in", "settings", "release notes", "webhooks", "invoices", "the importer", "the audit log", "notifications"];
    const verbs = ["Tidy", "Speed up", "Document", "Harden", "Retire the old", "Translate", "Test"];
    const spread: TaskStatus[] = [...Array(26).fill("inbox"), ...Array(34).fill("assigned"), ...Array(10).fill("blocked"), ...Array(14).fill("done")];
    spread.forEach((status, index) => {
      const id = `t-bulk-${index}`;
      const title = `${verbs[index % verbs.length]} ${areas[index % areas.length]} (${index + 1})`;
      tasks.push(task(id, status, title, "", (index + 20) * MIN));
      const seats = (status === "assigned" && index % 3 !== 0) || (status === "blocked" && index % 2 === 0);
      if (!seats) return;
      const lane = status === "blocked" ? "needs_decision" : index % 4 === 0 ? "completed" : "running";
      pipelines.push(pipeline(`p-bulk-${index}`, title, id, lane,
        [stage("build", "builder", "review"), stage("review", "reviewer", null)],
        [{ stageId: "build", attempts: [attempt(1, lane === "running" ? "running" : lane === "completed" ? "passed" : "needs_decision", null)] }],
        lane === "completed" ? null : { stageId: "build", state: "running", input: null, activatedBy: null },
        { srcConversationId: seatId }));
    });
  }
}
type SeatAct = { by?: "seat" | "operator" | "agent" | "nobody"; ago?: number } & (
  | { kind: "move"; taskId: string; to: TaskStatus }
  | { kind: "pipeline"; taskId: string }
  | { kind: "stage"; taskId: string }
  | { kind: "task"; taskId: string; title: string });
const arrowCard = (taskId: string) => document.querySelector<HTMLElement>(`[data-kanban-board] .card[data-id="task:${CSS.escape(taskId)}"], [data-phone-card="task:${CSS.escape(taskId)}"]`);
/** Apply every act in one board update, as one delta carries them. */
async function orchestratorAct(acts: SeatAct | SeatAct[]): Promise<{ landed: boolean }> {
  const landed: Array<() => boolean> = [];
  let touchedTasks = false;
  let touchedLanes = false;
  for (const act of Array.isArray(acts) ? acts : [acts]) {
    const who = act.by ?? "seat";
    const at = new Date(Date.now() - (act.ago ?? 0)).toISOString();
    const actor = who === "operator" ? { kind: "operator" as const }
      : { kind: "agent" as const, role: who === "seat" ? "orchestrator" : "builder", conversationId: who === "seat" ? orchestrator.conversationId! : exportImpl.conversationId! };
    const statusBy = (from: TaskStatus | null): Pick<BoardTask, "statusBy"> => (who === "nobody" ? {} : { statusBy: { actor, from, at } });
    const index = tasks.findIndex((entry) => entry.id === act.taskId);
    if (act.kind === "task") {
      tasks.push(task(act.taskId, "inbox", act.title, "", 0, [], { createdAt: at, updatedAt: at, ...statusBy(null) }));
      touchedTasks = true;
      landed.push(() => !!arrowCard(act.taskId));
    } else if (act.kind === "move") {
      const row = { ...tasks[index]! };
      delete row.statusBy;
      tasks[index] = { ...row, status: act.to, ...statusBy(row.status), updatedAt: at, revision: REV(revision++) } as BoardTask;
      touchedTasks = true;
      landed.push(() => {
        const card = arrowCard(act.taskId);
        return (card?.closest<HTMLElement>("section.column[data-status]")?.dataset.status ?? card?.closest<HTMLElement>("[data-phone-kanban-column]")?.dataset.phoneKanbanColumn) === act.to;
      });
    } else if (act.kind === "pipeline") {
      const id = `p-seat-${act.taskId}`;
      pipelines.push(pipeline(id, tasks[index]!.text.split("\n")[0]!, act.taskId, "running",
        [stage("build", "builder", "review"), stage("review", "reviewer", null)],
        [{ stageId: "build", attempts: [attempt(1, "running", null, { startedAt: at })] }],
        { stageId: "build", state: "running", input: null, activatedBy: null },
        { srcConversationId: who === "seat" ? orchestrator.conversationId : null, createdAt: at }));
      touchedLanes = true;
      landed.push(() => !!arrowCard(act.taskId)?.querySelector(`[data-pipeline="${id}"]`) || !!document.querySelector(`[data-phone-card="task:${CSS.escape(act.taskId)}"][data-phone-card-pipeline="${id}"]`));
    } else {
      /* The lane's running stage is launched again by hand: a new attempt that carries its launcher, as the engine writes it. */
      const position = pipelines.findIndex((entry) => entry.taskIds.includes(act.taskId) && entry.cursor);
      const lane = pipelines[position]!;
      const runs = (lane.runs as unknown as { stageId: string; attempts: Record<string, unknown>[] }[]).map((run) => run.stageId !== lane.cursor!.stageId ? run : {
        ...run,
        attempts: [...run.attempts.map((entry) => entry.state === "running" ? { ...entry, state: "failed", completedAt: at } : entry),
          attempt(run.attempts.length + 1, "running", null, { startedAt: at, ...(who === "nobody" ? {} : { launchedBy: { actor, at } }) })],
      });
      pipelines[position] = { ...lane, runs } as unknown as Pipeline;
      touchedLanes = true;
    }
  }
  if (touchedTasks) window.dispatchEvent(new Event("llv:tasks-changed"));
  if (touchedLanes) window.dispatchEvent(new Event("llv:pipelines-changed"));
  const done = () => landed.every((check) => check());
  for (let waited = 0; waited < 4_000 && !done(); waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
  await new Promise((resolve) => setTimeout(resolve, 250));
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return { landed: done() };
}
if (ARROWS) Object.assign(window, {
  orchestratorAct,
  /* The product's layer, when one is mounted: at rest there is none. */
  orchestratorWires: () => [...orchestratorWireLayers][0]?.probe ?? null,
  /* What deriving the links costs on this board: one pass over the tasks, the lanes and the conversations. */
  orchestratorLinksCost() {
    const input = { seatConversationIds: [orchestrator.conversationId], pipelines, tasks, files };
    const started = performance.now();
    let links = 0;
    for (let run = 0; run < 200; run++) links = orchestratorLinks(input).length;
    return { links, ms: (performance.now() - started) / 200 };
  },
});

let board = {
  schemaVersion: 1, revision: 1, updatedAt: new Date(0).toISOString(), pathAliases: {},
  prefs: {
    manual: [], hidden: oldSpike ? [oldSpike.path] : [], expanded: [], favorites: [], foldedEngineChildIds: [], expandedEngineTrayParentIds: [],
    viewMode: "scheme", desktopBoard: params.get("face") === "scheme" ? null : "kanban", taskPanelOpen: false,
  },
} as unknown as BoardProjectStateV1;

if (FEED_RECOVERY) searchVer2.generation = 1;

const evidence = {
  advanceFeedContinuity() { feedContinuityStep += 1; return getRuntimeBus().refresh(); },
  /* Replies the runtime store holds for the reloaded conversation, read after a fresh snapshot. */
  async feedReloadSnapshotReplies() {
    await getRuntimeBus().refresh();
    return getRuntimeBus().getState().store.sessions[searchVer2.conversationId!]?.liveTurn?.items?.length ?? 0;
  },
  failFeedDelivery() {
    const id = "fixture-failed-delivery";
    enqueueOutbox(searchVer2.conversationId!, { id, text: L("Send this follow-up.", "Надішли це уточнення."), images: 0, at: Date.now() });
    updateOutbox(searchVer2.conversationId!, id, { state: "failed", error: "Fixture delivery refused", settledAt: Date.now() });
  },
  seedDelayedLaunch() {
    const card = searchVer2.conversationId!;
    const at = Date.now();
    const seed = { id: "delayed-launch", text: delayedLaunchText, images: 0, at,
      owner: { conversationId: card, generation: 1 } };
    seedLaunchOutbox(card, seed);
    updateOutbox(card, seed.id, { state: "delivered", settledAt: at });
    for (let i = 0; i < OUTBOX_LIMIT; i++) {
      const id = `settled-filler-${i}`;
      enqueueOutbox(card, { id, text: `Settled filler ${i}`, images: 0, at: at + i + 1 });
      updateOutbox(card, id, { state: "delivered", settledAt: at, responseStartedAt: at });
    }
    seedLaunchOutbox(card, seed);
    return readOutbox(card).find(entry => entry.id === seed.id)?.state;
  },
  publishDelayedLaunch() { feedRecoveryEcho = true; },
  delayedLaunchRetired() { return Boolean(readOutbox(searchVer2.conversationId!).find(entry => entry.id === "delayed-launch")?.retiredEchoId); },
  taskPatches: [] as Array<{ id: string; body: Record<string, unknown> }>,
  /* #2187: what the board's merge-setting row wrote. */
  settingWrites: [] as Array<Record<string, unknown>>,
  presence: [] as Array<{ mode: string; visiblePaths: string[]; focusedPath: string | null }>,
  assignments: [] as Array<{ method: string; id: string; body: Record<string, unknown> }>,
  /* The focus handoff this page's Viewer runs, for driving an attention
     arrival without a server behind the offer. */
  /* `startArrivalPulse` is here for the same reason: a driver that set the
     attribute itself would photograph the stylesheet and prove nothing about
     the code that decides WHAT to mark and how (#1836 item 4). */
  focus: { bus: focusHandoffBus, runFocusTransaction, startArrivalPulse, cancelArrivalPulse },
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
  /* Case iv: the Codex seat's operator-chosen profile is stored, then the seat rotates to a Claude seat launched opus/high. */
  storeSeatProfile() { writeProfile(orchestrator, { model: "gpt-5.6", effort: "low" }); },
  /* The runtime stream is silent here, so the rotation asks the bus for the snapshot that carries the new seat's session, as the panel's own refresh does. */
  rotateSeat() { seatOn("claude", "opus", "high", "iv-new"); return getRuntimeBus().refresh(); },
  /* The first-message cases: move the same window Pending -> Delivered -> Transcript arrived -> Answered. */
  releaseFirstMessageEvidence,
  advanceFirstMessage() {
    fm.step += 1;
    fmApply();
    window.dispatchEvent(new Event("llv:files-changed"));
    return fm.step;
  },
  firstMessagePosts: fm.posts,
  refuseNextTaskPatch: false,
  taskAnswerDelayMs: 400,
  /* When each task write reached the fixture and when it was answered. */
  taskWrites: [] as Array<{ id: string; startedAt: number; answeredAt: number }>,
  /* Tasks created from the board's «+ Task» (K9a), as the route received them. */
  taskCreates: [] as Array<Record<string, unknown>>,
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
    /* A lineage-adopted attempt is evidence; it never moves the cursor. */
    if (!over.historical) record.cursor = { stageId, state: "running", input: null, activatedBy: over.activatedBy ?? null };
    window.dispatchEvent(new Event("llv:pipelines-changed"));
  },
  /* The stored row, as the fixture's server holds it. */
  storedTask(id: string) {
    return tasks.find((entry) => entry.id === id) ?? null;
  },
  /* K5b: the pipeline route's reads and writes, in order. */
  pipelineReads: [] as string[],
  pipelinePatches: [] as Array<{ id: string; body: Record<string, unknown> }>,
  pipelineAnswerDelayMs: 300,
  /* The next pipeline write is refused with these words. */
  refuseNextPipelinePatch: null as { status: number; error: string } | null,
  /* The next pipeline write finds this stage started: the engine's race. */
  startStageOnNextPatch: null as { pipelineId: string; stageId: string } | null,
  /* The next pipeline write is carried out and its answer is lost on the way back. */
  loseNextPipelineAnswer: false,
  /* Another client saves this stage's prompt after the board's read and before its write lands. */
  changeStageBeforeNextPatch: null as { pipelineId: string; stageId: string; prompt: string } | null,
  /* Another client acts first: the pipeline now waits on this stage. */
  moveCursor(pipelineId: string, stageId: string) {
    const index = pipelines.findIndex((entry) => entry.id === pipelineId);
    if (index < 0) return;
    pipelines[index] = { ...pipelines[index]!, cursor: { stageId, state: "running", input: null, activatedBy: null } } as Pipeline;
    window.dispatchEvent(new Event("llv:pipelines-changed"));
  },
  /* Another client saves a stage's prompt; this page learns it on its next read. */
  writeStagePromptQuietly(pipelineId: string, stageId: string, prompt: string) {
    const record = pipelines.find((entry) => entry.id === pipelineId);
    const target = record?.stages.find((entry) => entry.id === stageId);
    if (target) target.prompt = prompt;
  },
  storedPipeline(id: string) {
    return pipelines.find((entry) => entry.id === id) ?? null;
  },
  setRuntimeSwitchPhase(pipelineId: string, stageId: string, phase: "requested" | "committed" | "rolled-back" | "failed" | "switching", outcome?: string) {
    const record = pipelines.find(entry => entry.id === pipelineId);
    const live = record?.runs.find(entry => entry.stageId === stageId)?.attempts.at(-1);
    const change = live?.runtimeSwitches?.at(-1);
    if (!live || !change) return;
    change.phase = phase;
    change.outcome = outcome ?? (phase === "rolled-back" ? "runtime switch failed; continued on previous runtime" : undefined);
    if (phase === "switching" && outcome) {
      live.state = "needs_decision";
      record!.state = "needs_decision";
      record!.stateDetail = outcome;
    } else if (live.state === "needs_decision") {
      live.state = "running";
      if (record!.state === "needs_decision") record!.state = "running";
      record!.stateDetail = null;
    }
    const seat = phase === "committed" ? change.to : change.from;
    live.effectiveRole = { ...live.effectiveRole, engine: seat.engine, model: seat.model, effort: seat.effort, serviceTier: seat.serviceTier ?? undefined };
    /* The conversation runs on what the attempt settled on, and the scan says so. */
    const agent = files.find(entry => entry.conversationId === live.conversationId);
    if (agent && seat.model) Object.assign(agent, { model: seat.model, effort: seat.effort ?? agent.effort });
    window.dispatchEvent(new Event("llv:pipelines-changed"));
  },
  /* K6: conversation account switches the board sent, in order. */
  accountRequests: [] as Array<Record<string, unknown>>,
  /* Reconfigures the runtime pill sent (#1846). */
  pillRequests: [] as Array<Record<string, unknown>>,
  accountAnswerDelayMs: 200,
  /* The next switch is refused with these words. */
  refuseNextAccountRequest: null as { status: number; error: string } | null,
  /* The next switch is queued and its answer is lost on the way back. */
  loseNextAccountAnswer: false,
  /* The project's accounts cannot be read. */
  bindingsUnreadable: false,
  /* K6b: cancels and withdrawals sent to the conversation migration route, in order. */
  migrationRequests: [] as Array<{ conversationId: string; body: Record<string, unknown> }>,
  /* The next cancel or withdrawal is refused with these words and code. */
  refuseNextMigrationRequest: null as { status: number; error: string; code: string } | null,
  /* The conversation's migration record, as the files route projects it. */
  setMigration(pathname: string, migration: Record<string, unknown> | null) {
    const index = files.findIndex((entry) => entry.path === pathname || entry.conversationId === pathname);
    if (index < 0) return;
    const next = { ...files[index]! };
    if (migration) next.migration = migration as unknown as FileEntry["migration"];
    else delete next.migration;
    files[index] = next;
    window.dispatchEvent(new Event("llv:files-changed"));
  },
  /* A committed switch: the transcript continues under the target account's home, the record clears. */
  commitAccountSwitch(conversationId: string, accountId: string) {
    const index = files.findIndex((entry) => entry.conversationId === conversationId);
    if (index < 0) return;
    const current = files[index]! as FileEntry & { migration?: unknown };
    const path = `/repo/accounts/${current.engine}/${accountId}/${current.name}`;
    for (const record of pipelines) {
      for (const run of record.runs) for (const entry of run.attempts) if (entry.conversationId === conversationId) entry.agentPath = path;
    }
    const next = { ...current, path } as FileEntry & { migration?: unknown };
    delete next.migration;
    files[index] = next as FileEntry;
    window.dispatchEvent(new Event("llv:files-changed"));
    window.dispatchEvent(new Event("llv:pipelines-changed"));
  },
  /* #1836: a lane the server has admitted that the corpus scan does not carry
     yet. `/api/attention` hands it out as the pushed rows; `/api/files` never
     does, so a board that draws it drew it from the push. */
  admitted: null as { pipeline: Pipeline; task: BoardTask } | null,
  /* Every `/api/attention` call, as the page made it. */
  attentionCalls: [] as Array<{ url: string; method: string }>,
  admitLane(title: string, stateDetail: string | null = null) {
    evidence.admitted = {
      pipeline: pipeline("p-admitted", title, "t-admitted", "provisioning",
        [stage("build", "builder", "review"), stage("review", "reviewer", null)], [],
        { stageId: "build", state: "pending", input: null, activatedBy: null }, { createdAt: new Date().toISOString(), stateDetail }),
      task: task("t-admitted", "assigned", title, "", 0),
    };
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
/* The runtime stream, when the driver pushes events: `runtimeEmit` delivers one envelope exactly as the SSE route frames it. */
class StreamEventSource extends QuietEventSource {
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  constructor(url: string | URL) {
    super(url);
    if (String(url).startsWith("/api/runtime/stream")) {
      openStream(this);
      setTimeout(() => this.onopen?.(), 0);
    }
  }
}
let streamSource: StreamEventSource | null = null;
const openStream = (source: StreamEventSource) => { streamSource = source; };
Object.assign(window, {
  EventSource: STREAMING ? StreamEventSource : QuietEventSource,
  runtimeEmit: (envelope: unknown) => streamSource?.onmessage?.({ data: JSON.stringify(envelope) }),
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/* The task album (`&album=1`): the search task's pictures across its stages
   and a conversation, as `GET /api/tasks/:id/album` answers them, and the
   export task's, all seen. The pictures are drawn on a canvas in the shapes an
   agent's renders have — a desktop board, a phone screen, a wide strip, a
   small crop — so the grid meets the aspect ratios it will meet. */
const ALBUM = params.get("album") === "1";
function mockRender(width: number, height: number, hue: number, label: string, phone = false): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext("2d")!;
  g.fillStyle = `hsl(${hue} 30% 96%)`;
  g.fillRect(0, 0, width, height);
  g.fillStyle = `hsl(${hue} 35% 28%)`;
  g.fillRect(0, 0, width, Math.max(18, height * 0.07));
  const pad = Math.max(8, Math.round(width * 0.03));
  const columns = phone ? 1 : Math.max(1, Math.round(width / 360));
  const colWidth = (width - pad * (columns + 1)) / columns;
  for (let column = 0; column < columns; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      const top = height * 0.12 + row * (height * 0.2);
      if (top + height * 0.16 > height) break;
      g.fillStyle = row === 1 && column === 0 ? `hsl(${hue} 70% 55%)` : "#fff";
      g.fillRect(pad + column * (colWidth + pad), top, colWidth, height * 0.16);
      g.fillStyle = `hsl(${hue} 15% 70%)`;
      g.fillRect(pad * 2 + column * (colWidth + pad), top + pad, colWidth * 0.6, Math.max(4, height * 0.018));
    }
  }
  g.fillStyle = "#fff";
  g.font = `600 ${Math.max(10, Math.round(height * 0.04))}px sans-serif`;
  g.fillText(label, pad, Math.max(14, height * 0.05));
  return canvas.toDataURL("image/png");
}
/* The prototype review (`&proto=1`): five tasks, one per state the card's
   button draws, answered the way `GET` and `POST /api/tasks/:id/prototypes`
   answer them. The search task waits with four variants: new pictures, two
   original/changed pairs, forty pictures in one variant and a video. Upload
   waits with one variant, whose name is the 60 characters the schema admits and whose
   second caption runs to its 200, and saves into a project with no orchestrator;
   export is decided and its pictures are retired; links carries a decided
   first round and a waiting second; disk is decided and its message failed.
   `&proto=elsewhere` answers the search task as a linked installation does. */
const PROTO = params.get("proto");
const protoPosts: unknown[] = [];
const protoRounds: Record<string, PrototypeRoundView[]> = {};
const protoSaveState: Record<string, PrototypeDeliveryState> = { "t-upload": "no-orchestrator" };
/* The Viewer's own selectors: which round waits and which a later decision retired. */
function protoSummary(rounds: PrototypeRoundView[]): PrototypeReviewSummary {
  return prototypeReviewSummary(rounds)!;
}
function protoPublish(): void {
  for (const [taskId, rounds] of Object.entries(protoRounds)) {
    const held = tasks.find((entry) => entry.id === taskId);
    if (held) Object.assign(held, { prototypeReview: protoSummary(rounds) });
  }
}
if (PROTO) {
  let mediaId = 0;
  const gone = PROTO === "elsewhere";
  const image = (width: number, height: number, hue: number, label: string, phone = false, available = true): PrototypeMediaView => ({
    id: `m${mediaId += 1}`, mime: "image/png", bytes: 48_000, available: available && !gone, url: available && !gone ? mockRender(width, height, hue, label, phone) : null,
  });
  const round = (id: string, taskId: string, title: string, ago: number, variants: PrototypeRoundView["variants"], over: Partial<PrototypeRoundView> = {}): PrototypeRoundView => ({
    id, taskId, project: PROJECT, title, createdAt: iso(ago), source: { conversationId: null }, variants, ...over,
  });
  const decided = (chosen: number[], comment: string, ago: number, state: PrototypeDeliveryState): NonNullable<PrototypeRoundView["decision"]> => ({
    chosen, comment, at: iso(ago), delivery: { state, retryable: state !== "sent" },
  });
  protoRounds["t-search"] = [round("r-search", "t-search", L("Search results layout", "Макет результатів пошуку"), 3 * MIN, [
    { number: 1, name: L("Compact list", "Компактний список"), description: L("One line per result with the path under the title.\nThe densest of the four; no preview.", "Один рядок на результат, шлях під назвою.\nНайщільніший із чотирьох; без попереднього перегляду."), videos: [], frames: [
      { image: image(960, 600, 205, "compact · 1440"), caption: L("results, desktop", "результати, десктоп"), width: 1440, lang: "en" },
      { image: image(800, 600, 205, "compact · 1000"), caption: L("results, narrow pane", "результати, вузька панель"), width: 1000, lang: "en" },
      { image: image(390, 760, 205, "compact · 390", true), caption: L("results, phone", "результати, телефон"), width: 390, lang: "uk" },
    ] },
    { number: 2, name: L("Two columns", "Дві колонки"), description: L("Results on the left, the opened result on the right.\nChanges the existing results page.", "Результати ліворуч, відкритий результат праворуч.\nЗмінює наявну сторінку результатів."), videos: [], frames: [
      { original: image(960, 600, 30, "today · 1440"), image: image(960, 600, 150, "two columns · 1440"), caption: L("results page, before and after", "сторінка результатів, до і після"), width: 1440, lang: "en" },
      { original: image(390, 760, 30, "today · 390", true), image: image(390, 760, 150, "two columns · 390", true), caption: L("phone, before and after", "телефон, до і після"), width: 390, lang: "en" },
      { image: image(960, 600, 150, "two columns · empty"), caption: L("nothing found", "нічого не знайдено"), width: 1440, lang: "en" },
    ] },
    { number: 3, name: L("Dense table", "Щільна таблиця"), description: L("A sortable table: name, path, modified, size.\nEvery state of every column is captured.", "Сортована таблиця: назва, шлях, змінено, розмір.\nЗнято кожен стан кожної колонки."), videos: [], frames:
      Array.from({ length: 40 }, (_, at) => ({ image: image(640, 400, 260 + at * 2, `table · ${at + 1}`), caption: L(`table state ${at + 1}`, `стан таблиці ${at + 1}`), width: 1440, lang: "en" as const })) },
    { number: 4, name: L("Cards with a preview", "Картки з переглядом"), description: L("A card per result with a thumbnail of the match.\nThe video shows the hover and the keyboard walk.", "Картка на результат із мініатюрою збігу.\nВідео показує наведення і прохід клавіатурою."), frames: [
      { image: image(960, 600, 330, "cards · 1440"), caption: L("results, desktop", "результати, десктоп"), width: 1440, lang: "en" },
      { image: image(390, 760, 330, "cards · 390", true), caption: L("results, phone", "результати, телефон"), width: 390, lang: "uk" },
    ], videos: [{ media: { id: "v1", mime: "video/webm", bytes: 210_000, available: !gone, url: gone ? null : "/proto-video.webm" }, caption: L("hover and keyboard walk", "наведення і прохід клавіатурою") }] },
  ])];
  protoRounds["t-upload"] = [round("r-upload", "t-upload", L("Upload progress sheet", "Панель перебігу завантаження"), 9 * MIN, [
    { number: 1, name: L("Progress under the attached file with speed, size and a stop", "Перебіг під прикріпленим файлом зі швидкістю та кнопкою стоп"), description: L("A new design: the bar sits under the attached file.\nNothing existing changes.", "Новий дизайн: смуга стоїть під прикріпленим файлом.\nНаявне не змінюється."), videos: [], frames: [
      { image: image(960, 600, 190, "upload · running"), caption: L("uploading", "завантажується"), width: 1440, lang: "en" },
      { image: image(960, 600, 190, "upload · resumed"), caption: L("resumed after a drop: the bar keeps what was already sent, the label names the retry, the speed returns once two samples exist, and the stop button stays where the pointer left it, so nothing jumps.", "відновлено після обриву: смуга зберігає вже надіслане, підпис називає повтор, швидкість повертається після двох замірів, а кнопка зупинки лишається там, де її залишив вказівник, тож ніщо не стрибає."), width: 1440, lang: "en" },
    ] },
  ])];
  protoRounds["t-export"] = [round("r-export", "t-export", L("Export presets", "Пресети експорту"), 40 * 24 * 60 * MIN, [
    { number: 1, name: L("Three tiles", "Три плитки"), description: L("One tile per preset.", "Плитка на кожен пресет."), videos: [], frames: [{ image: image(960, 600, 40, "tiles", false, false), caption: L("presets", "пресети"), width: 1440 }] },
    { number: 2, name: L("Segmented control", "Сегментований перемикач"), description: L("The presets as one segmented control.", "Пресети одним сегментованим перемикачем."), videos: [], frames: [{ image: image(960, 600, 80, "segments", false, false), caption: L("presets", "пресети"), width: 1440 }] },
    { number: 3, name: L("Advanced drawer", "Шухляда розширених"), description: L("Eleven toggles behind one disclosure.", "Одинадцять перемикачів за одним розкриттям."), videos: [], frames: [{ image: image(960, 600, 120, "drawer", false, false), caption: L("advanced", "розширені"), width: 1440 }] },
  ], { mediaRemovedAt: iso(2 * 24 * 60 * MIN), decision: decided([2, 3], L("Take the segmented control and keep the drawer closed by default.", "Беремо сегментований перемикач, шухляда типово закрита."), 38 * 24 * 60 * MIN, "sent") })];
  /* `&retired=1`: export's design round was never answered and its decided
     round came after it, as on the task a revise stage answered. The decision
     retires that earlier round, so export waits for nothing. */
  if (params.get("retired") === "1") protoRounds["t-export"]!.unshift(round("r-export-0", "t-export", L("Export presets, first take", "Пресети експорту, перша спроба"), 41 * 24 * 60 * MIN, [
    { number: 1, name: L("One long list", "Один довгий список"), description: L("Every preset in one list.", "Усі пресети одним списком."), videos: [], frames: [{ image: image(960, 600, 60, "list", false, false), caption: L("presets", "пресети"), width: 1440, lang: "en" }] },
    { number: 2, name: L("Two tabs", "Дві вкладки"), description: L("Simple and advanced presets on two tabs.", "Прості й розширені пресети на двох вкладках."), videos: [], frames: [{ image: image(960, 600, 90, "tabs", false, false), caption: L("presets", "пресети"), width: 1440, lang: "en" }] },
  ], { mediaRemovedAt: iso(2 * 24 * 60 * MIN) }));
  protoRounds["t-links"] = [
    round("r-links-1", "t-links", L("Release notes links", "Посилання в нотатках релізу"), 3 * 24 * 60 * MIN, [
      { number: 1, name: L("Inline arrows", "Стрілки в рядку"), description: L("An arrow after every repaired link.", "Стрілка після кожного виправленого посилання."), videos: [], frames: [{ image: image(960, 600, 20, "arrows"), caption: L("notes", "нотатки"), width: 1440 }] },
      { number: 2, name: L("Footnotes", "Примітки"), description: L("Links move to numbered footnotes.", "Посилання переходять у нумеровані примітки."), videos: [], frames: [{ image: image(960, 600, 60, "footnotes"), caption: L("notes", "нотатки"), width: 1440 }] },
    ], { decision: decided([1], L("Arrows, but smaller.", "Стрілки, але менші."), 2 * 24 * 60 * MIN, "sent") }),
    round("r-links-2", "t-links", L("Release notes links, smaller arrows", "Посилання в нотатках релізу, менші стрілки"), 6 * MIN, [
      { number: 1, name: L("Arrow at 12 px", "Стрілка 12 px"), description: L("The chosen arrow, two sizes down.", "Обрана стрілка, на два розміри менша."), videos: [], frames: [{ original: image(960, 600, 20, "arrows"), image: image(960, 600, 100, "arrows · 12"), caption: L("notes, before and after", "нотатки, до і після"), width: 1440 }] },
      { number: 2, name: L("Arrow on hover", "Стрілка при наведенні"), description: L("The arrow shows only under the pointer.", "Стрілку видно лише під вказівником."), videos: [], frames: [{ image: image(960, 600, 140, "arrows · hover"), caption: L("notes", "нотатки"), width: 1440 }] },
    ]),
  ];
  protoRounds["t-disk"] = [round("r-disk", "t-disk", L("Disk usage report", "Звіт про використання диска"), 5 * 60 * MIN, [
    { number: 1, name: L("Treemap", "Деревоподібна карта"), description: L("Area by size.", "Площа за розміром."), videos: [], frames: [{ image: image(960, 600, 280, "treemap"), caption: L("report", "звіт"), width: 1440 }] },
    { number: 2, name: L("Sorted bars", "Впорядковані смуги"), description: L("One bar per directory.", "Смуга на кожен каталог."), videos: [], frames: [{ image: image(960, 600, 310, "bars"), caption: L("report", "звіт"), width: 1440 }] },
  ], { decision: decided([2], L("Bars. Add the reclaimable column.", "Смуги. Додайте колонку «можна звільнити»."), 4 * 60 * MIN, "failed") })];
  protoPublish();
  Object.assign(window, { protoPosts });
}
type FixtureAlbumItem = { id: string; src: string; name: string | null; ts: number; via: "read" | "named" | "pasted"; source: { key: string; conversationId: string | null; path: string; stage?: { pipelineId: string; stageId: string; attempt: number; round?: number } }; isNew: boolean };
const albumOpened = new Map<string, number>([["t-export", Date.now()]]);
const albumSource = (file: FileEntry, stage?: { pipelineId: string; stageId: string; attempt: number; round?: number }) => ({ key: file.conversationId ?? file.path, conversationId: file.conversationId ?? null, path: file.path, ...(stage ? { stage } : {}) });
let albumCache: Record<string, Omit<FixtureAlbumItem, "isNew">[]> | null = null;
function albumItems(): Record<string, Omit<FixtureAlbumItem, "isNew">[]> {
  if (albumCache) return albumCache;
  const verify = albumSource(searchVer2, { pipelineId: "p-search", stageId: "verify", attempt: 2 });
  const review = albumSource(searchRev, { pipelineId: "p-search", stageId: "review", attempt: 1, round: 2 });
  const implement = albumSource(searchImpl2, { pipelineId: "p-search", stageId: "implement", attempt: 2 });
  const minutes = (n: number) => Date.now() - n * 60_000;
  albumCache = {
    "t-search": [
      { id: "a1", src: mockRender(1440, 900, 212, "search · after swap · 1440"), name: "after-swap-1440.png", ts: minutes(2), via: "named", source: verify },
      { id: "a2", src: mockRender(390, 844, 212, "phone · 390", true), name: "after-swap-phone-390.png", ts: minutes(3), via: "named", source: verify },
      { id: "a3", src: mockRender(1280, 260, 28, "empty results banner, very wide strip"), name: "results-empty-banner-wide-strip-with-a-long-file-name.png", ts: minutes(9), via: "read", source: verify },
      { id: "a4", src: mockRender(1440, 900, 150, "review · warm-up gate"), name: "warmup-gate-before.png", ts: minutes(41), via: "read", source: review },
      { id: "a5", src: mockRender(1440, 900, 150, "review · after"), name: "warmup-gate-after.png", ts: minutes(43), via: "read", source: review },
      { id: "a6", src: mockRender(96, 96, 340, "x"), name: null, ts: minutes(70), via: "pasted", source: implement },
      { id: "a7", src: mockRender(1024, 768, 260, "implement · index"), name: "index-live-1024.png", ts: minutes(75), via: "named", source: implement },
    ],
    "t-export": [
      { id: "e1", src: mockRender(1440, 900, 40, "export presets"), name: "presets.png", ts: minutes(20), via: "named", source: albumSource(exportImpl) },
    ],
  };
  return albumCache;
}
function albumPage(taskId: string) {
  const items = [...(albumItems()[taskId] ?? [])].sort((a, b) => b.ts - a.ts);
  const lastOpenedAt = albumOpened.get(taskId) ?? Date.now() - 30 * 60_000;
  const marked = items.map((item) => ({ ...item, isNew: item.ts > lastOpenedAt }));
  return { items: marked, total: marked.length, nextCursor: null, indexing: false, lastOpenedAt, newCount: marked.filter((item) => item.isNew).length };
}

/* The engine's stage digest (`stageDigest`) is a SHA-256 the server computes;
   this page has no server, so its route answers an opaque stand-in over the
   same canonical fields. The board only ever hands a digest back. */
function fixtureStageDigest(stage: Pipeline["stages"][number]): string {
  const canonical = JSON.stringify({
    "prompt": stage.prompt,
    account: typeof stage.account === "string" && stage.account.trim() ? stage.account.trim() : null,
    role: stage.role ? { roleId: stage.role.roleId, params: stage.role.params ?? null } : null,
    runtime: { engine: stage.effectiveRole.engine, model: stage.effectiveRole.model ?? null, effort: stage.effectiveRole.effort ?? null, access: stage.effectiveRole.access ?? null },
  });
  let hex = "";
  for (let seed = 0; seed < 8; seed += 1) {
    let hash = 0x811c9dc5 ^ seed;
    for (let index = 0; index < canonical.length; index += 1) hash = Math.imul(hash ^ canonical.charCodeAt(index), 0x01000193);
    hex += (hash >>> 0).toString(16).padStart(8, "0");
  }
  return hex;
}

/* The links go through the board's own resolver, over an invented forge
   cache: the same rules and the same shapes `/api/files` answers with. */
function fixtureWorkLinks(): FilesWorkLinks {
  const repository = "acme/atlas";
  const pr = (number: number, head: string, state: CachedPullRequest["state"], closes: number[] = [], openedAgo = 7 * 60): CachedPullRequest => ({
    number, url: `https://github.com/${repository}/pull/${number}`, headRefName: head, createdAt: iso(openedAgo * MIN), state, closes, checkedAt: iso(2 * MIN),
  });
  const prs = [
    pr(2201, "pipeline/p-many-pills", "open", [2059, 2060]),
    pr(2188, "fix/shared-pill-head", "merged"),
    pr(2170, "pipeline/p-many-collapse", "closed"),
    /* Opened inside its lane's lifetime, which ended 26 hours ago. */
    pr(2150, "pipeline/p-many-report", "merged", [2045], 27 * 60),
    pr(2190, "pipeline/p-search", "open", [2044]),
    /* The lane the phone's queue opens: three chips beside the attach link. */
    pr(2195, "pipeline/p-links", "draft", [2046, 2047]),
    pr(1996, "pipeline/p-md-accept", "open", [1990]),
    pr(2031, "pipeline/p-review-spent", "open", [2030]),
    pr(2204, "pipeline/p-many-drawers", "draft"),
    pr(2207, "pipeline/p-upload", "open", [2061]),
    pr(2212, "pipeline/p-many-loop", "open"),
    pr(2231, "pipeline/p-finish-marked", "open"),
    pr(2240, "pipeline/p-finish-hold", "merged"),
    pr(2242, "pipeline/p-finish-other", "open"),
    pr(2236, "pipeline/p-finish-done", "merged"),
  ];
  const view: ForgeRepositoryView = {
    canonical: repository,
    completeSince: iso(24 * 60 * MIN),
    pr: (number) => prs.find((entry) => entry.number === number),
    byHead: (head) => prs.filter((entry) => entry.headRefName === head),
    isIssue: (number) => number === 2044,
  };
  const cache: ForgeCacheView = { repository: (name) => (name === repository ? view : null) };
  const delivered = (lane: Pipeline) => ({
    ...lane,
    delivery: { target: { repository: PROJECT, remote: `https://github.com/${repository}.git`, branch: `refs/heads/${lane.id === "p-many-pill" || lane.id === "p-many-collapse" ? "fix/shared-pill-head" : lane.branch}` } },
  } as Pipeline);
  const out: FilesWorkLinks = { pipelines: {}, tasks: {} };
  const byTask = new Map<string, ResolvedWorkLinks[]>();
  for (const lane of pipelines) {
    const resolved = resolvePipelineLinks(delivered(lane), repository, cache);
    if (resolved.links.length || resolved.noPr) out.pipelines[lane.id] = resolved;
    for (const taskId of lane.taskIds) byTask.set(taskId, [...(byTask.get(taskId) ?? []), resolved]);
  }
  for (const entry of tasks) {
    const own = entry.id === "t-longtitle" ? { workLinks: [{ repository, number: 2210, kind: "pr" as const, addedAt: iso(MIN), addedBy: "operator" as const }] } : {};
    const numberedHold = (entry.hold?.kind === "pr" || entry.hold?.kind === "issue") && /^\d+$/.test(entry.hold.ref ?? "");
    const resolved = resolveTaskLinks(own, byTask.get(entry.id) ?? [], cache, numberedHold ? repository : null);
    if (resolved.links.length || (numberedHold && resolved.repository)) out.tasks[entry.id] = resolved;
  }
  return out;
}
const workLinks = WORK_LINKS || SCENARIO === "task-motion" ? fixtureWorkLinks() : null;

/* The «Needs you» filter's board. Six tasks: `t-nf-ask` holds a conversation
   that asks a question, `t-nf-lane` a lane parked on a decision, `t-nf-cleared`
   a lane whose decision the operator already dismissed (it no longer waits),
   and `t-nf-run` and `t-nf-idle` wait on no one. `t-nf-wall` is finished and
   holds only conversations from outside this board, folded into one line
   (#2459), in a column that starts narrow. */
const needsFiles: FileEntry[] = [];
const needsAdd = (file: FileEntry) => { needsFiles.push(file); return file; };
const nfAsk = needsAdd(conversation("nf-ask", "Which export presets should ship first?", NEEDS_NOTHING ? { mtime: now - 20 * MIN } : {
  mtime: now - 9 * MIN, lastTurn: { startedAt: (now - 14 * MIN) * 1_000, endedAt: (now - 10 * MIN) * 1_000 },
  pendingQuestion: { kind: "question", toolUseId: "tool-nf-ask", transcriptPath: "/repo/nf-ask.jsonl", pid: 1, paneTarget: null, askedAt: iso(9 * MIN), questions: [{ question: "Which export presets should ship first?", header: "Presets", multiSelect: false, options: [] }] },
}));
const nfLaneBuild = needsAdd(conversation("nf-lane-build", "Reconciling the ledger export", working({ plan: { current: "Reconciling the ledger export" } })));
const nfClearedBuild = needsAdd(conversation("nf-cleared-build", "Rotating the search alias", { mtime: now - 40 * MIN }));
const nfRun = needsAdd(conversation("nf-run", "Writing the migration notes", working({ plan: { current: "Writing the migration notes" } })));
const nfIdle = needsAdd(conversation("nf-idle", "Listing every export toggle", { mtime: now - 2 * 60 * MIN, engine: "codex", model: "gpt-5.6" }));
const needsLane = (id: string, title: string, taskId: string, member: FileEntry, over: Record<string, unknown> = {}) => pipeline(id, title, taskId, "needs_decision",
  [stage("implement", "builder", "review"), stage("review", "reviewer", null)],
  [{ stageId: "implement", attempts: [attempt(1, "failed", member, { startedAt: iso(50 * MIN), completedAt: iso(30 * MIN), verdict: { status: "fail", findings: ["The export drops the last row."] } })] }],
  { stageId: "implement", state: "needs_decision", input: null, activatedBy: null }, { createdAt: iso(120 * MIN), ...over });
const needsPipelines: Pipeline[] = NEEDS_NOTHING ? [] : [
  needsLane("p-nf-lane", "Reconcile the ledger export", "t-nf-lane", nfLaneBuild),
  needsLane("p-nf-cleared", "Rotate the search alias", "t-nf-cleared", nfClearedBuild, { dismissedAt: iso(5 * MIN), dismissedBy: { kind: "operator", surface: "desktop" } }),
];
const needsTasks: BoardTask[] = [
  task("t-nf-ask", "assigned", L("Choose the export presets", "Обрати набір пресетів експорту"), L("Three presets and one advanced drawer.", "Три пресети і одна розширена шухляда."), 9 * MIN, [nfAsk]),
  task("t-nf-lane", "assigned", L("Reconcile the ledger export", "Звірити експорт книги"), L("The export drops its last row.", "Експорт губить останній рядок."), 30 * MIN, [nfLaneBuild]),
  task("t-nf-cleared", "assigned", L("Rotate the search alias", "Перемкнути псевдонім пошуку"), L("Waits for the warm-up query to return.", "Чекає, поки повернеться прогрівальний запит."), 40 * MIN, [nfClearedBuild]),
  task("t-nf-run", "assigned", L("Write the migration notes", "Написати нотатки про міграцію"), L("A draft for the release page.", "Чернетка для сторінки релізу."), 5 * MIN, [nfRun]),
  task("t-nf-idle", "assigned", L("List every export toggle", "Перелічити всі перемикачі експорту"), L("One row per toggle, with its default.", "Один рядок на перемикач, зі значенням за замовчуванням."), 2 * 60 * MIN, [nfIdle]),
  task("t-nf-wall", "done", L("Retire the old export presets", "Прибрати старі пресети експорту"), "", 200 * MIN, [], {
    assignments: wallRows("nf", 12) as unknown as BoardTask["assignments"],
  } as Partial<BoardTask>),
];

/* The launch the page runs on a clock (`?scenario=launch-cls`). POST /api/spawn answers the receipt after the
   latency a real launch has; /api/files then shows the `spawn:` projection, and from the adoption on the
   scanned transcript, whose rows arrive on the timeline below. */
const SEAT_TITLE = "Orchestrator for atlas";
const launchRun = {
  launchId: "launch-cls", conversationId: "conversation_launch-cls", path: "/repo/launch-cls.jsonl",
  startedAt: 0, prompt: "", title: "Claude", engine: "claude", model: "haiku", effort: "low", clientAttemptId: null as string | null,
  /* The card whose own «+ Agent» opened the draft, when one did. */
  taskId: null as string | null,
  /* The account the launch asked for, which the spawn record carries as the product's does. */
  accountId: null as string | null,
  /* How many pictures the first message carried, which the server projects beside its words. */
  images: 0,
  requests: [] as Record<string, unknown>[],
};
/* The new-agent frames read the pane between the press and the receipt, so that scenario holds the receipt longer. */
const LAUNCH_HOLD_MS = NEW_AGENT ? 1_500 : 0;
const LAUNCH_RECEIPT_MS = 700 + LAUNCH_HOLD_MS;
const LAUNCH_ADOPT_MS = 2_400 + LAUNCH_HOLD_MS;
const LAUNCH_END_MS = 10_800 + LAUNCH_HOLD_MS;
const launchTimeline: Array<{ at: number; lines: (stamp: (ms: number) => number) => string[] }> = [
  { at: 3_000, lines: (at) => tool(at(3_000), "toolu_launch_ls", "Bash", { command: "ls", description: "List the project" }).slice(0, 1) },
  { at: 3_400, lines: (at) => tool(at(3_000), "toolu_launch_ls", "Bash", { command: "ls", description: "List the project" }).slice(1) },
  { at: 4_300, lines: (at) => [said(at(4_300), "Looking at the project files first.")] },
  { at: 5_200, lines: (at) => tool(at(5_200), "toolu_launch_read", "Read", { file_path: "README.md" }).slice(0, 1) },
  { at: 5_700, lines: (at) => tool(at(5_200), "toolu_launch_read", "Read", { file_path: "README.md" }).slice(1) },
  { at: 7_000, lines: (at) => [said(at(7_000), "The project has three parts:\n\n- the server, which owns the state\n- the web board, which reads it\n- the scripts that drive both\n\nNothing needs changing yet.")] },
  { at: 9_400, lines: (at) => [said(at(9_400), "Summary: the README describes the layout above and points at the scripts directory for the rest.")] },
];
function launchTranscript(): string {
  if (!launchRun.startedAt) return "";
  const elapsed = Date.now() - launchRun.startedAt;
  if (elapsed < LAUNCH_ADOPT_MS) return "";
  /* A row's stamp is its own time on the clock, so the feed's times read as a turn that ran. */
  const stamp = (ms: number) => (Date.now() - (launchRun.startedAt + ms)) / 1_000;
  const rows = [asked(stamp(LAUNCH_RECEIPT_MS), launchRun.prompt)];
  for (const entry of launchTimeline) if (elapsed >= entry.at + LAUNCH_HOLD_MS) rows.push(...entry.lines(stamp));
  return `${rows.join("\n")}\n`;
}
/* The launch's name: its first line, or for a picture with no words the title it was launched with. */
const launchName = () => launchRun.prompt.split("\n")[0] || launchRun.title.replace(/^[^·]*·\s*/, "");
/* The files and tasks the board holds at this moment of the launch. */
function launchAdvance() {
  if (!(LAUNCH_CLS || SEAT_CLS || NEW_AGENT) || !launchRun.startedAt) return;
  const elapsed = Date.now() - launchRun.startedAt;
  const nowSeconds = Date.now() / 1_000;
  for (let index = files.length - 1; index >= 0; index -= 1) if (files[index]!.conversationId === launchRun.conversationId) files.splice(index, 1);
  const adopted = elapsed >= LAUNCH_ADOPT_MS;
  const ended = elapsed >= LAUNCH_END_MS;
  const common = { model: launchRun.model, launchModel: launchRun.model, effort: launchRun.effort, fast: null, mtime: nowSeconds };
  files.push(adopted
    ? conversation("launch-cls", SEAT_CLS ? SEAT_TITLE : launchName(), {
      ...common, path: launchRun.path, size: new TextEncoder().encode(launchTranscript()).length,
      ...(ended
        ? { activity: "recent", authoritativeTurn: { state: "terminal", source: "lifecycle", terminalAt: new Date().toISOString() }, lastTurn: { startedAt: launchRun.startedAt, endedAt: Date.now() } }
        : working({ mtime: nowSeconds, lastTurn: { startedAt: launchRun.startedAt, endedAt: null } })),
    })
    : conversation("launch-cls", SEAT_CLS ? SEAT_TITLE : launchRun.title, {
      ...common, path: `spawn:${launchRun.launchId}`, size: 0, activity: "live", activityReason: "structured_spawn_starting", generation: 1,
      spawn: {
        launchId: launchRun.launchId, clientAttemptId: launchRun.clientAttemptId, accountId: launchRun.accountId, conversationId: launchRun.conversationId, generation: 1,
        state: "starting", initialMessage: "queued", retrySafe: false, error: null, prompt: launchRun.prompt, promptAt: launchRun.startedAt, promptImages: launchRun.images,
        ...(SEAT_CLS ? { mandate: { kind: "version", version: ORCHESTRATOR_PROMPT_VERSION } } : {}),
      },
    }));
  /* The seat's conversation belongs to no task. */
  if (SEAT_CLS) return;
  const assignment = {
    launchId: launchRun.launchId, clientAttemptId: launchRun.clientAttemptId, conversationId: launchRun.conversationId, path: adopted ? launchRun.path : null,
    panePid: null, state: "delivered", error: null, at: new Date(launchRun.startedAt).toISOString(),
  };
  /* A draft opened from a card launches onto that card's task. */
  const owner = launchRun.taskId ? tasks.find((entry) => entry.id === launchRun.taskId) : null;
  if (owner) {
    Object.assign(owner, {
      assignments: [...(owner.assignments ?? []).filter((entry) => entry.launchId !== launchRun.launchId), assignment],
      updatedAt: new Date().toISOString(), revision: REV(900 + Math.floor(elapsed / 1_000)),
    });
    return;
  }
  const index = tasks.findIndex((entry) => entry.id === "t-launch");
  const placeholder = {
    id: "t-launch", project: PROJECT, text: launchName(), status: "assigned", placement: "unplaced",
    origin: { kind: "launch", key: launchRun.clientAttemptId ?? launchRun.launchId, refinement: "pending" },
    assignments: [{
      launchId: launchRun.launchId, clientAttemptId: launchRun.clientAttemptId, conversationId: launchRun.conversationId, path: adopted ? launchRun.path : null,
      panePid: null, state: "delivered", error: null, at: new Date(launchRun.startedAt).toISOString(),
    }],
    createdAt: new Date(launchRun.startedAt).toISOString(), updatedAt: new Date().toISOString(), revision: REV(900 + Math.floor(elapsed / 1_000)),
  } as unknown as BoardTask;
  if (index >= 0) tasks[index] = placeholder;
  else tasks.push(placeholder);
}
/* Nothing waits on the operator, so the phone's own fallback focus has no reason to leave the launched conversation. */
/* A project created a moment ago holds nothing until its seat is made. */
if (SEAT_CLS) files.splice(0, files.length);
if (LAUNCH_CLS) for (const file of files) Object.assign(file, { waitingInput: null, pendingQuestion: null });
Object.assign(window, { launchRun });

/* The header menu's driver block (kanbanBoard.browser.test.tsx, "the header's menu, built"): `&header=1`
   hands shared memory, the key, the ping and the team to the driver, and `&member=1` signs a member in. */
const HEADER_MENU = new URLSearchParams(location.search).has("header");
const HEADER_ROUTES = ["/api/telemetry", "/api/memory/settings", "/api/asks-you/key", "/api/team"];
/* The one request that leaves the page: the evidence server draws task icons from lucide (#2102). */
const serverFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), location.origin);
  const method = (init?.method ?? "GET").toUpperCase();
  if (SCENARIO === "role-defaults" && url.pathname === "/api/roles") return json({ roles: ROLE_DEFAULTS.map(role => {
    const variants = ROLE_VARIANT_DEFAULTS[role.id as keyof typeof ROLE_VARIANT_DEFAULTS];
    return { ...role, variants, promptPreview: role.promptScaffold, shipped: { config: role.config, variants } };
  }) });
  if (SCENARIO === "service-tier" && url.pathname === "/api/roles") return json({ roles: ROLE_DEFAULTS.map(role => ({ ...role, promptPreview: role.promptScaffold, config: { ...role.config, ...(role.id === "reviewer" ? { serviceTier: "ultrafast" } : {}) }, shipped: { config: role.config } })) });
  if (SCENARIO === "memory-settings" && ["/api/telemetry", "/api/memory/settings", "/api/asks-you/key", "/api/asks-you"].includes(url.pathname)) return serverFetch(url.pathname + url.search, init);
  if (HEADER_MENU && HEADER_ROUTES.includes(url.pathname)) return serverFetch(url.pathname + url.search, init);
  if (url.pathname === "/api/task-icons") return serverFetch(url.pathname + url.search);
  /* The tick panel the notice card opens reads these two; the driver answers them. */
  if ((TICK_CARDS || SEAT_TICK_DRIVER) && (url.pathname === "/api/monitor/seat-tick/settings" || url.pathname === "/api/roles")) return serverFetch(url.pathname + url.search, init);
  if (url.pathname.startsWith("/api/tts")) return serverFetch(url.pathname + url.search, init);
  if (url.pathname.startsWith("/api/links")) return serverFetch(url.pathname + url.search, init);
  if (PROTO && url.pathname === "/api/transcribe" && method === "POST") {
    /* A transcription the driver holds back, to close the review while it is awaited. */
    const held = (window as unknown as { protoTranscribeDelay?: number }).protoTranscribeDelay;
    if (held) await new Promise((resolve) => setTimeout(resolve, held));
    return json({ text: L("Take the header from the two columns and keep the dense rows of the table.", "Візьміть шапку з двох колонок і залиште щільні рядки таблиці.") });
  }
  if (PROTO && /^\/api\/tasks\/[^/]+\/prototypes$/.test(url.pathname)) {
    const taskId = decodeURIComponent(url.pathname.split("/")[3]!);
    const rounds = protoRounds[taskId] ?? [];
    if (method === "POST") {
      const body = JSON.parse(String(init?.body)) as { reviewId: string; chosen?: number[]; comment?: string; retry?: true };
      protoPosts.push({ taskId, ...body });
      const held = rounds.find((entry) => entry.id === body.reviewId);
      if (!held) return json({ error: "prototype review not found" }, 404);
      if (body.retry && held.decision) {
        /* A driver may queue what the next retries answer; with nothing queued a retry lands. */
        const state = (window as unknown as { protoRetryAnswers?: PrototypeDeliveryState[] }).protoRetryAnswers?.shift() ?? "sent";
        held.decision = { ...held.decision, delivery: { state, retryable: state !== "sent" } };
      }
      else if (!held.decision) {
        const state = protoSaveState[taskId] ?? "sent";
        held.decision = { chosen: [...(body.chosen ?? [])].sort((a, b) => a - b), comment: body.comment ?? "", at: new Date().toISOString(), delivery: { state, retryable: state !== "sent" } };
      }
      protoPublish();
    }
    return json({
      taskId, rounds: rounds.map((entry) => { const by = prototypeRoundsSuperseded(rounds).get(entry.id); return by ? { ...entry, supersededBy: by } : entry; }),
      waitingReviewId: rounds.length ? protoSummary(rounds).waitingReviewId : null,
      ...(rounds.length ? { summary: protoSummary(rounds) } : {}),
      ...(PROTO === "elsewhere" ? { unavailable: "another-installation" } : {}),
    });
  }
  if (ALBUM && url.pathname === "/api/task-album") {
    const ids = (url.searchParams.get("ids") ?? "").split(",").filter((id) => albumItems()[id]);
    return json({ tasks: Object.fromEntries(ids.map((id) => {
      const page = albumPage(id);
      return [id, { count: page.total, newCount: page.newCount, newestAt: page.items[0]?.ts ?? null }];
    })) });
  }
  if (ALBUM && /^\/api\/tasks\/[^/]+\/album$/.test(url.pathname)) {
    const taskId = decodeURIComponent(url.pathname.split("/")[3]!);
    if (method === "POST") {
      albumOpened.set(taskId, Date.now());
      return json({ ok: true, lastOpenedAt: Date.now() });
    }
    return json(albumPage(taskId));
  }
  if (NEW_AGENT && url.pathname === "/api/accounts" && method === "GET") {
    return json(NEW_AGENT_SEED === "signed-out" ? {
      ...accountsBody,
      claude: { ...accountsBody.claude, accounts: accountsBody.claude.accounts.map((row, index) => index === 0
        ? { ...row, authPresent: false, loginState: "signed_out", auth: { ...row.auth, state: "signed_out" } } : row) },
    } : NEW_AGENT_SEED === "copilot" ? {
      ...accountsBody,
      copilot: { active: "default", accounts: [accountRow("default", "Account H", "Pro", 22, 160), accountRow("account-k", "Account K", "Pro", 9, 190)], mutationLocked: false, migration: null, autoBalance: null },
    } : accountsBody);
  }
  if (NEW_AGENT && url.pathname === "/api/spawn" && method === "GET") {
    const images = { supported: true, reason: null, formats: ["image/png", "image/jpeg"], maxImages: 8, maxRawBytesPerImage: 5_000_000, maxEncodedBytesPerRequest: 20_000_000 };
    /* A handoff's source names its own checkout, as the route reads it from the source transcript. */
    const sourceCwd = url.searchParams.get("src") && NEW_AGENT_SEED !== "handoff-lost" ? "/repo/worktrees/export-csv" : null;
    return json({ dirs: ["/repo", "/repo/worktrees/export-csv", "/srv/atlas-docs"], cwd: sourceCwd, spawnTransport: "structured", imageInput: { claude: images, codex: images, copilot: images } });
  }
  /* Dictation in the draft's composer: no live token, so the recording is transcribed on stop, and the
     answer is the first prompt the operator spoke. */
  if (NEW_AGENT && url.pathname === "/api/transcribe/token") return json({}, 404);
  if (NEW_AGENT && url.pathname === "/api/transcribe" && method === "POST") {
    return json({ text: L("Read the README and tell me what this project is made of", "Прочитай README і скажи, з чого складається цей проєкт") });
  }
  /* What each launch asked for, kept for the driver: this page answers its own requests, so none reaches the network. */
  if (NEW_AGENT && url.pathname === "/api/spawn" && method === "POST") launchRun.requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
  if (NEW_AGENT_SEED === "refused" && url.pathname === "/api/spawn" && method === "POST") {
    return json({ error: L("Launch refused: /repo/worktrees/export-csv is not a checkout this account may write to.", "Запуск відхилено: /repo/worktrees/export-csv не є копією, у яку цей акаунт може писати.") }, 422);
  }
  if ((LAUNCH_CLS || NEW_AGENT) && url.pathname === "/api/spawn" && method === "POST") {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    Object.assign(launchRun, {
      taskId: typeof body.taskId === "string" ? body.taskId : null,
      accountId: NEW_AGENT && typeof body.accountId === "string" ? body.accountId : null,
      images: Array.isArray(body.images) ? body.images.length : 0,
      /* A managed account's transcripts live under its own home, which is how the conversation names its account. */
      ...(NEW_AGENT && typeof body.accountId === "string" && body.accountId !== "default" ? { path: `/repo/accounts/claude/${body.accountId}/launch-cls.jsonl` } : {}),
      startedAt: Date.now(), prompt: String(body.prompt ?? ""), title: String(body.title ?? "Claude"), engine: String(body.engine ?? "claude"),
      model: String(body.model ?? "") || "haiku", effort: String(body.effort ?? "") || "low", clientAttemptId: typeof body.clientAttemptId === "string" ? body.clientAttemptId : null,
    });
    await new Promise((resolve) => setTimeout(resolve, LAUNCH_RECEIPT_MS));
    launchAdvance();
    return json({ ok: true, launched: true, transport: "structured", state: "path-pending", target: "", launchId: launchRun.launchId, conversationId: launchRun.conversationId, initialMessage: "queued" });
  }
  /* The seat's create: the same receipt a spawn answers, after the same latency. */
  if (SEAT_CLS && url.pathname === "/api/orchestrator/seat" && method === "POST") {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    Object.assign(launchRun, {
      startedAt: Date.now(), prompt: String(body.mandate ?? ""), title: SEAT_TITLE, engine: String(body.engine ?? "claude"),
      model: String(body.model ?? "") || "opus", effort: String(body.effort ?? "") || "high", clientAttemptId: typeof body.clientRequestId === "string" ? body.clientRequestId : null,
    });
    await new Promise((resolve) => setTimeout(resolve, LAUNCH_RECEIPT_MS));
    launchAdvance();
    return json({ ok: true, launched: true, transport: "structured", state: "path-pending", target: "", launchId: launchRun.launchId, conversationId: launchRun.conversationId, initialMessage: "queued" });
  }
  if (SEAT_CLS && url.pathname === "/api/orchestrator/seat" && launchRun.startedAt && url.searchParams.get("scope") !== "all") {
    evidence.seatReads += 1;
    const adopted = Date.now() - launchRun.startedAt >= LAUNCH_ADOPT_MS;
    const at = new Date(launchRun.startedAt).toISOString();
    return json({
      seat: {
        project: PROJECT, seatEpoch: 1, conversationId: launchRun.conversationId, path: adopted ? launchRun.path : `spawn:${launchRun.launchId}`, mandate: launchRun.prompt,
        promptVersion: ORCHESTRATOR_PROMPT_VERSION, predecessorConversationId: null, state: "active",
        intent: { clientRequestId: launchRun.clientAttemptId, mode: "spawn", launchId: launchRun.launchId, error: null }, designatedAt: at, activatedAt: at,
      },
      pending: null, lastFailure: null, exists: true, viewerMcpRegistered: true, previous: [], currentTask: null,
      all: { conversationIds: [launchRun.conversationId], paths: [launchRun.path], previous: { conversationIds: [], paths: [] } },
    });
  }
  if (SEAT_CLS && url.pathname === "/api/orchestrator/seat/status" && launchRun.startedAt) {
    return json({
      project: PROJECT, designated: true, conversationId: launchRun.conversationId, predecessorConversationId: null,
      engine: launchRun.engine, model: launchRun.model, effort: launchRun.effort, accountId: "primary", cwd: "/repo/atlas", transcriptPath: launchRun.path,
      liveness: { lifecycle: "running", hostState: "alive", silentForMs: 1_000 },
      context: null, transcriptFacts: null, rotation: { recommended: false, level: "none", reasons: [], thresholdUnknown: false },
    });
  }
  if (url.pathname === "/api/files") {
    launchAdvance();
    /* #1820's first run: an installation with nothing in it at all. */
    /* Nothing is working in the quiet installation: every conversation has
       an idle process and a turn that closed, nothing waits on the operator,
       and no pipeline is in flight. The projects and their tasks are the
       same ones. */
    const shown = OVERVIEW_QUIET
      ? files.map((file) => ({
        ...file,
        activity: "idle",
        proc: null,
        pid: null,
        waitingInput: null,
        pendingQuestion: null,
        authoritativeTurn: { state: "idle", source: "lifecycle", terminalAt: iso(4 * 60 * MIN) },
        lastTurn: { startedAt: (now - 5 * 60 * MIN) * 1_000, endedAt: (now - 4 * 60 * MIN) * 1_000 },
      } as unknown as FileEntry))
      : files;
    const seatOnly = ORCH_WALK ? files.filter((file) => file.path === orchestrator.path).map((file) => ({
      ...file, activity: "idle", proc: null, pid: null, waitingInput: null, pendingQuestion: null, plan: null,
      authoritativeTurn: { state: "idle", source: "lifecycle", terminalAt: iso(MIN) },
      lastTurn: { startedAt: (now - 2 * MIN) * 1_000, endedAt: (now - MIN) * 1_000 },
    } as unknown as FileEntry)) : [];
    if (RAIL_STATE === "unreachable") return json({ error: "the catalog is unreachable in the evidence fixture" }, 503);
    if (RAIL_STATE === "loading") await new Promise(() => {});
    const scoped = OVERVIEW_EMPTY || RAIL_STATE === "empty"
      ? { files: [], projectCatalog: [], flows: [], pipelines: [], tasks: [] }
      : ORCH_WALK
      ? { files: seatOnly, projectCatalog: [{ project: PROJECT, conversations: 1, smt: now }], projectCwds: { [PROJECT]: "/repo/atlas" }, flows: [], pipelines: [], tasks: [] }
      : NEEDS_FILTER
      ? { files: needsFiles, projectCatalog: [{ project: PROJECT, conversations: needsFiles.length, smt: now }], flows: [], pipelines: needsPipelines, tasks: needsTasks }
      : ORCH_FIRST || (FM_SEAT && !fm.confirmed)
      ? { files: SEAT_CLS ? files : [], projectCatalog: [{ project: PROJECT, conversations: SEAT_CLS ? files.length : 0, smt: now }], projectCwds: { [PROJECT]: "/repo/atlas" }, flows: [], pipelines: [], tasks: [] }
      : {
        files: shown,
        projectCatalog: [...new Set(shown.map((file) => file.project))].filter((project) => !railCatalog.some((entry) => entry.project === project)).map((project) => {
          const own = shown.filter((file) => file.project === project);
          return { project, conversations: own.length, smt: Math.max(...own.map((file) => file.mtime)) };
        }).concat(railCatalog),
        ...(RAIL ? { crownedProjects: [LEDGER, "harbor-docs"] } : {}),
        flows: OVERVIEW_QUIET ? [] : flows,
        pipelines: OVERVIEW_QUIET ? [] : pipelines,
        tasks,
        /* The Telegram step is chosen per project, so the guide needs one with a folder; the seat's first message keeps the
           folder it had before Confirm, since a seat read keyed on another folder answers from its own older cache. */
        ...(TELEGRAM_STEP || FM_SEAT ? { projectCwds: { [PROJECT]: "/repo/atlas" } } : {}),
      };
    const body = JSON.stringify({ ...scoped, workflows: [], systemHealth: { tmux: { status: "healthy" }, ...(new URLSearchParams(location.search).has("state-disk-full") ? { storage: { incidents: [], writes: { state: "disk-full", freeBytes: 32 * 1024 * 1024, since: "2026-10-01T12:00:00Z" } } } : {}) }, ...(workLinks ? { workLinks } : {}) });
    if (evidence.filesDelayMs) await new Promise((resolve) => setTimeout(resolve, evidence.filesDelayMs));
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.pathname === "/api/attention") {
    evidence.attentionCalls.push({ url: url.pathname + url.search, method });
    if (method !== "GET") return json({ error: "unsupported in the evidence fixture" }, 400);
    const echoed = (url.searchParams.get("echoes") ?? "").split(",").filter(Boolean);
    const admitted = evidence.admitted;
    const withdrawn = echoed.filter((id) => id !== admitted?.pipeline.id).map((id) => ({ id, reason: "never-materialized" }));
    const records = admitted || withdrawn.length
      ? { pipelines: admitted ? [admitted.pipeline] : [], tasks: admitted ? [admitted.task] : [], withdrawn }
      : null;
    if (!url.searchParams.get("deviceId")) return json({ ok: true, records });
    return json({ ok: true, rootId: "root-fixture", offer: null, live: [], expired: [], records });
  }
  if (url.pathname === "/api/runtime/snapshot" && STRUCTURED) return json(structuredSnapshot());
  if (url.pathname === "/api/runtime/snapshot") return json({ code: RUNTIME_PLANE_ABSENT }, 503);
  if (STRUCTURED && url.pathname === "/api/tmux" && method === "POST") {
    evidence.pillRequests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return json({ ok: true, structured: true });
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
  if (url.pathname === "/api/view/presence" && method === "POST") {
    const body = JSON.parse(String(init?.body)) as { mode: string; visiblePaths: string[]; focusedPath?: string | null };
    evidence.presence.push({ mode: body.mode, visiblePaths: body.visiblePaths, focusedPath: body.focusedPath ?? null });
    return json({ ok: true, ...(SELF_UPDATE_RELOAD ? { serving: ++presenceAnswers === 1 ? "aaaaaaa" : "bbbbbbb" } : {}) });
  }
  if (TELEGRAM_STEP && url.pathname === "/api/telegram/bot") return json({ bot: TELEGRAM_BOT_STATUS });
  if (TELEGRAM_STEP && url.pathname === "/api/onboarding") {
    return json({ marker: { schemaVersion: 1, completedAt: iso(2 * MIN), dismissedAt: null, reason: null, steps: { engines: "done", project: "done" }, lastHealth: null, walk: "done" }, seatTickCheckMinutes: 5 });
  }
  /* #2187 §6: the project's merge setting, as the settings route answers it. */
  if (url.pathname === "/api/projects/settings") {
    if (method === "PUT") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { mergeOnReview?: unknown; bridgeReports?: unknown };
      evidence.settingWrites.push(body);
      if (typeof body.mergeOnReview === "boolean") MERGE_SETTING.enabled = body.mergeOnReview;
      if (typeof body.bridgeReports === "boolean") BRIDGE_SETTING.enabled = body.bridgeReports;
    }
    return json({
      ok: true,
      project: PROJECT,
      mergeOnReview: { enabled: MERGE_SETTING.enabled, changedAt: iso(24 * 60 * MIN), changedBy: "operator" },
      bridgeReports: { enabled: BRIDGE_SETTING.enabled, changedAt: iso(24 * 60 * MIN), changedBy: "operator" },
      reportTelegram: REPORT_TELEGRAM,
      reportDestination: REPORT_DESTINATION,
      postableChats: TELEGRAM_BOT === "none" ? 0 : TELEGRAM_BOT === "several" ? 2 : 1,
      reportNameSuggestion: "Atlas",
      github: "acme/atlas",
    });
  }
  if (url.pathname === "/api/orchestrator/reports") {
    const known = new Map<string, "task" | "pipeline">([
      ...tasks.map((task) => [task.id, "task"] as const),
      ...pipelines.map((pipeline) => [pipeline.id, "pipeline"] as const),
    ]);
    /* A seat created a moment ago (the walk's scene) has filed nothing yet. */
    return json(reportLogFixturePage(url, {
      project: PROJECT, github: "acme/atlas", enabled: BRIDGE_SETTING.enabled, knownCards: known, empty: REPORTS_EMPTY || ORCH_WALK,
      asks: ASKS_YOU ? asksYouFixtureLines(now * 1_000, [
        { conversationId: exportExplore.conversationId!, path: exportExplore.path, role: "architect", title: exportExplore.title, gist: EXPORT_ASK_GIST, minutesAgo: 7 },
        { conversationId: searchImpl1.conversationId!, path: searchImpl1.path, role: "builder", title: searchImpl1.title, gist: "Лишити старий індекс ще на добу чи прибрати його одразу після перемикання?", minutesAgo: 170 },
      ]) : [],
    }));
  }
  /* "Asks you": the installation's switch and this month's spend. */
  if (url.pathname === "/api/asks-you") {
    if (method === "PUT") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { enabled?: unknown };
      evidence.settingWrites.push({ asksYou: body.enabled });
      if (typeof body.enabled === "boolean") ASKS_YOU_SETTING.enabled = body.enabled;
    }
    return json({ ok: true, ...asksYouFixtureSetting(ASKS_YOU_SETTING.enabled) });
  }
  if (url.pathname === "/api/tasks" && method === "GET") launchAdvance();
  if (url.pathname === "/api/tasks" && method === "GET") return json({ tasks: OVERVIEW_EMPTY || ORCH_FIRST || (FM_SEAT && !fm.confirmed) || ORCH_WALK ? [] : tasks });
  if (ORCH_WALK && url.pathname === "/api/onboarding") {
    const existing = params.get("install") === "existing";
    const stored = sessionStorage.getItem("evidence-walk");
    const marker = {
      schemaVersion: 1, completedAt: existing ? null : iso(2 * MIN), dismissedAt: existing ? iso(2 * MIN) : null, reason: existing ? "existing-install" : null,
      steps: {}, lastHealth: null, walk: stored === "done" || stored === "skipped" ? stored : null,
    };
    if (method === "PUT") {
      const patch = JSON.parse(String(init?.body ?? "{}")) as { walk?: string };
      if (patch.walk) sessionStorage.setItem("evidence-walk", patch.walk);
      const writes = JSON.parse(sessionStorage.getItem("evidence-walk-writes") ?? "[]") as unknown[];
      sessionStorage.setItem("evidence-walk-writes", JSON.stringify([...writes, patch]));
      return json({ marker: { ...marker, walk: patch.walk ?? marker.walk } });
    }
    return json({ marker, seatTickCheckMinutes: 10 });
  }
  if (url.pathname === "/api/tasks" && method === "POST") {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    evidence.taskCreates.push(body);
    const at = new Date().toISOString();
    const created = { id: `created-${evidence.taskCreates.length}`, project: PROJECT, text: String(body.text), status: "inbox", placement: body.placement, assignments: [], createdAt: at, updatedAt: at, revision: REV(revision++) } as BoardTask;
    tasks.push(created);
    return json({ ok: true, task: created });
  }
  /* A draft pane's directory suggestions (K9a): the fixture's one checkout. */
  if (url.pathname === "/api/spawn" && method === "GET") return json({ dirs: ["/repo"], cwd: null });
  if (url.pathname.startsWith("/api/tasks/") && !url.pathname.endsWith("/assignment") && method === "PATCH") {
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
    if (body.status) { next.status = body.status as TaskStatus; if (next.status !== "blocked") delete next.hold; }
    if (Object.hasOwn(body, "hold")) {
      next.hold = readTaskHold(body.hold, new Date().toISOString(), "operator", current.hold);
      if (next.hold) next.status = "blocked";
    }
    if (Object.hasOwn(body, "restoreHold")) next.hold = storedTaskHold(body.restoreHold);
    if (body.board) next.board = body.board as BoardTask["board"];
    if (typeof body.text === "string") {
      next.text = body.text;
      if (current.origin?.refinement === "pending") next.origin = { ...current.origin, refinement: "titled" };
    }
    if (body.color !== undefined) {
      if (body.color === "none") delete next.color;
      else next.color = body.color as BoardTask["color"];
    }
    /* Normal is stored as nothing, as the route stores it. */
    if (body.priority !== undefined) {
      if (body.priority === "high" || body.priority === "low") next.priority = body.priority;
      else delete next.priority;
    }
    /* The picker only ever sends a lucide name or "none" (#2102). */
    if (body.icon !== undefined) {
      if (body.icon === "none" || body.icon === null) delete next.icon;
      else next.icon = String(body.icon);
    }
    /* Agent-facing details (#1834), on the route's own terms: a string sets it,
       null or an empty string clears the field rather than leaving it empty. */
    if (body.details !== undefined) {
      const details = typeof body.details === "string" ? body.details.trim() : "";
      if (details) next.details = details;
      else delete next.details;
    }
    if (body.hide === true) {
      if (current.assignments.some((row) => row.conversationId === orchestrator.conversationId)) {
        return json({ error: "this task holds the project's orchestrator seat conversation, which stays on the board; it cannot be hidden", code: "TASK_HIDE_PROTECTED", field: "hide" }, 409);
      }
      next.groupHidden = { at: new Date().toISOString(), by: "operator", admitted: admissionSnapshot(current.assignments) };
    } else if (body.hide === false) {
      delete next.groupHidden;
    }
    const presentationOnly = Object.keys(body).every((key) => key === "color" || key === "icon" || key === "priority" || key === "hide" || key === "expectedProject" || key === "expectedRevision");
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
    /* «Launch did not start» dismissed: the row is kept as failed, and an
       unnamed launch placeholder with nothing else on it is done. */
    if (method === "PATCH") {
      const assignments = current.assignments.map((assignment) => (assignment.launchId === body.launchId
        ? { ...assignment, state: "failed" as const, error: "launch did not start (dismissed)", at: new Date().toISOString() }
        : assignment));
      const settled = current.origin?.refinement === "pending" && assignments.every((assignment) => assignment.state === "failed");
      const next = { ...current, assignments, ...(settled ? { status: "done" as const } : {}), revision: REV(revision++) } as BoardTask;
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
  if (url.pathname.startsWith("/api/pipelines/")) {
    const id = decodeURIComponent(url.pathname.split("/")[3] ?? "");
    const index = pipelines.findIndex((entry) => entry.id === id);
    if (index < 0) return json({ error: "pipeline not found" }, 404);
    if (method === "GET") {
      evidence.pipelineReads.push(id);
      const read = pipelines[index]!;
      return json({ ok: true, pipeline: read, stageDigests: Object.fromEntries(read.stages.map((stage) => [stage.id, fixtureStageDigest(stage)])) });
    }
    if (method === "PATCH") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      evidence.pipelinePatches.push({ id, body });
      await new Promise((resolve) => setTimeout(resolve, evidence.pipelineAnswerDelayMs));
      const record = structuredClone(pipelines[index]!) as Pipeline;
      const runs = record.runs as unknown as Array<{ stageId: string; attempts: unknown[] }>;
      const race = evidence.startStageOnNextPatch;
      if (race && race.pipelineId === id) {
        evidence.startStageOnNextPatch = null;
        let run = runs.find((entry) => entry.stageId === race.stageId);
        if (!run) runs.push(run = { stageId: race.stageId, attempts: [] });
        run.attempts.push(attempt(run.attempts.length + 1, "running", linksReview, { startedAt: new Date().toISOString(), activatedBy: { stageId: "implement", attempt: 1, edge: "pass" } }));
        record.cursor = { stageId: race.stageId, state: "running", input: null, activatedBy: null } as Pipeline["cursor"];
        record.state = "running";
        pipelines[index] = record;
      }
      const between = evidence.changeStageBeforeNextPatch;
      if (between && between.pipelineId === id) {
        evidence.changeStageBeforeNextPatch = null;
        const target = record.stages.find((entry) => entry.id === between.stageId);
        if (target) target.prompt = between.prompt;
        pipelines[index] = structuredClone(record);
      }
      if (evidence.refuseNextPipelinePatch) {
        const refusal = evidence.refuseNextPipelinePatch;
        evidence.refuseNextPipelinePatch = null;
        return json({ error: refusal.error }, refusal.status);
      }
      /* The engine's guards (#1695 C7, retry/skip), checked before anything changes. */
      const stageChanged = (field: string, error: string) => json({ error, code: "STAGE_CHANGED", field }, 409);
      if ((body.action === "retry-stage" || body.action === "skip-stage") && body.expectedStageId !== undefined) {
        const waiting = record.state === "needs_decision" ? record.cursor?.stageId ?? null : null;
        if (waiting !== body.expectedStageId) return stageChanged("expectedStageId", `the pipeline waits on ${waiting ?? "no stage"}, not ${String(body.expectedStageId)}`);
        const latest = record.runs.find((run) => run.stageId === waiting)?.attempts.findLast((entry) => !entry.historical)?.n ?? 0;
        if (body.expectedAttempt !== undefined && latest !== body.expectedAttempt) return stageChanged("expectedAttempt", `${waiting} waits on ${latest ? `attempt ${latest}` : "no attempt of its own"}`);
      }
      /* The engine's preconditions for what the board sends (`patchPipeline`). */
      const ended = record.state === "completed" || record.state === "closed";
      if (body.action === "override-stage") {
        if (ended) return json({ error: "pipeline is closed or completed" }, 409);
        const target = record.stages.find((entry) => entry.id === body.stageId);
        if (!target) return json({ error: "stage not found" }, 404);
        if (body.applyNow !== true && (record.runs.find((entry) => entry.stageId === target.id)?.attempts.length ?? 0) > 0) return json({ error: "stage has already started" }, 409);
        if (body.expectedStageDigest !== undefined && fixtureStageDigest(target) !== body.expectedStageDigest) return stageChanged("expectedStageDigest", "the stage changed since it was read; read it again before overriding it");
        if (typeof body.prompt === "string") target.prompt = body.prompt;
        if (body.applyNow === true) {
          const live = record.runs.find(entry => entry.stageId === target.id)?.attempts.at(-1);
          if (!live || live.state !== "running" || record.state !== "running") return json({ error: "apply now requires a running stage" }, 409);
          const from = { engine: live.effectiveRole.engine, model: live.effectiveRole.model, effort: live.effectiveRole.effort, serviceTier: live.effectiveRole.serviceTier ?? null, accountId: live.accountId ?? "default", conversationId: live.conversationId ?? "conversation_fixture", launchId: live.launchId, sessionId: live.sessionId, agentPath: live.agentPath };
          const to = { ...from, engine: (body.engine ?? from.engine) as "claude" | "codex", model: typeof body.model === "string" ? body.model : from.model, effort: typeof body.effort === "string" ? body.effort : from.effort, serviceTier: typeof body.serviceTier === "string" ? body.serviceTier : from.serviceTier, accountId: typeof body.account === "string" ? body.account : from.accountId, accountPinned: typeof body.account === "string" };
          live.runtimeSwitches = [{ id: `${id}:${target.id}:${live.n}:1`, seq: 1, requestedAt: new Date().toISOString(), actor: { kind: "operator" }, mode: to.engine === from.engine ? "fork" : "handoff", from, to, phase: "requested" }];
          target.effectiveRole = { ...target.effectiveRole, engine: to.engine, model: to.model, effort: to.effort, serviceTier: to.serviceTier ?? undefined };
        }
        /* #1279: a stage may name only an account the project allows; null clears the pin. */
        if (body.account !== undefined) {
          const requested = typeof body.account === "string" ? body.account.trim() : "";
          if (requested && target.effectiveRole.engine === "claude" && !CLAUDE_ALLOWED.includes(requested)) {
            return json({ error: `claude account ${requested} is not allowed on project ${PROJECT} (allowed: ${CLAUDE_ALLOWED.join(", ")})` }, 409);
          }
          if (requested) target.account = requested;
          else delete target.account;
        }
      } else if (body.action === "pause") {
        if (record.state === "draft") return json({ error: "draft pipelines can only be started, edited, or deleted" }, 409);
        if (!ended && record.state !== "paused") {
          record.pausedState = record.state;
          record.state = "paused";
        }
      } else if (body.action === "resume") {
        if (record.state !== "paused") return json({ error: "pipeline is not paused" }, 409);
        record.state = (record.pausedState ?? "running") as Pipeline["state"];
        record.pausedState = null;
      } else if (body.action === "retry-stage" || body.action === "skip-stage") {
        if (record.state !== "needs_decision") return json({ error: "pipeline does not have a stage awaiting a decision" }, 409);
        record.state = "running";
      } else if (body.action === "retry-merge") {
        if (record.state !== "completed" || record.merge?.state !== "blocked") return json({ error: "only a stopped merge can be tried again" }, 409);
        record.merge = { ...record.merge, state: "queued", attempts: record.merge.attempts + 1, reason: null, blockedAt: null };
      } else if (body.action === "link-task") {
        /* #2187 §5.1: an upsert; `finishes` sets or clears the flag. */
        const taskId = String(body.taskId ?? "");
        if (!record.taskIds.includes(taskId)) record.taskIds = [...record.taskIds, taskId];
        if (body.finishes !== undefined) {
          const others = (record.finishesTaskIds ?? []).filter((entry) => entry !== taskId);
          record.finishesTaskIds = body.finishes === true ? [...others, taskId] : others;
        }
      } else if (body.action === "dismiss") {
        record.dismissedAt = new Date().toISOString();
        record.dismissedBy = { kind: "operator" };
      } else if (body.action === "close") {
        record.state = "closed";
      } else {
        return json({ error: "unsupported in the evidence fixture" }, 400);
      }
      pipelines[index] = record;
      if (evidence.loseNextPipelineAnswer) {
        evidence.loseNextPipelineAnswer = false;
        throw new TypeError("Failed to fetch");
      }
      return json({ pipeline: record });
    }
  }
  /* An account's own reading would stand in for the aged one, so the stale state has none. */
  if (ACCOUNTS && RAIL_STATE === "stale" && url.pathname === "/api/accounts" && method === "GET") {
    return json({ ...accountsBody, claude: { ...accountsBody.claude, accounts: accountsBody.claude.accounts.map((row) => ({ ...row, limits: null })) }, codex: { ...accountsBody.codex, accounts: accountsBody.codex.accounts.map((row) => ({ ...row, limits: null })) } });
  }
  if (ACCOUNTS && url.pathname === "/api/accounts" && method === "GET") return json(TIER_LIMITS ? {
    ...accountsBody,
    claude: { ...accountsBody.claude, accounts: accountsBody.claude.accounts.map((row, index) => index === 0
      ? { ...row, limits: { ...tierLimits, state: "fresh", checkedAt: iso(0) } } : row) },
  } : accountsBody);
  if (ACCOUNTS && url.pathname === "/api/account-project-bindings" && method === "GET") {
    return evidence.bindingsUnreadable ? json({ error: "the account binding record is unreadable in the evidence fixture", code: "RECORD_UNREADABLE" }, 409) : json(bindingsBody);
  }
  const migrationRoute = ACCOUNTS && method === "POST" ? /^\/api\/conversations\/([^/]+)\/migration$/.exec(url.pathname) : null;
  if (migrationRoute) {
    const conversationId = decodeURIComponent(migrationRoute[1]!);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    evidence.migrationRequests.push({ conversationId, body });
    await new Promise((resolve) => setTimeout(resolve, evidence.accountAnswerDelayMs));
    if (evidence.refuseNextMigrationRequest) {
      const refusal = evidence.refuseNextMigrationRequest;
      evidence.refuseNextMigrationRequest = null;
      return json({ error: refusal.error, code: refusal.code }, refusal.status);
    }
    const index = files.findIndex((entry) => entry.conversationId === conversationId);
    if (body.action === "cancel") {
      /* The engine's guard: a revision and a phase it can still cancel in. */
      const current = index >= 0 ? (files[index] as FileEntry & { migration?: { phase: string; revision?: number } }).migration : undefined;
      if (!current) return json({ error: "conversation has no switch to cancel" }, 404);
      if (current.revision !== body.expectedRevision) return json({ error: "migration revision is stale", code: "MIGRATION_STALE" }, 409);
      if (current.phase !== "requested" && current.phase !== "waiting-turn") return json({ error: "the switch has already started", code: "SWITCH_STARTED" }, 409);
      evidence.setMigration(conversationId, null);
      return json({ id: conversationId, migration: { ...current, phase: "rolled-back" } });
    }
    if (body.action === "withdraw") return json({ withdraw: "withdrawn" });
    return json({ error: "unsupported in the evidence fixture" }, 400);
  }
  if (ACCOUNTS && url.pathname === "/api/conversation-host" && method === "POST") {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    evidence.accountRequests.push(body);
    await new Promise((resolve) => setTimeout(resolve, evidence.accountAnswerDelayMs));
    if (evidence.refuseNextAccountRequest) {
      const refusal = evidence.refuseNextAccountRequest;
      evidence.refuseNextAccountRequest = null;
      return json({ error: refusal.error }, refusal.status);
    }
    if (evidence.loseNextAccountAnswer) {
      evidence.loseNextAccountAnswer = false;
      throw new TypeError("Failed to fetch");
    }
    const operationId = `account-switch-${evidence.accountRequests.length}`;
    const file = files.find((entry) => entry.path === body.path);
    const outside = file?.engine === "claude" && !CLAUDE_ALLOWED.includes(String(body.accountId));
    return json({ ok: true, structured: true, target: body.conversationId, operationId, receipt: { operationId, status: "queued" }, ...(outside ? { accountOverride: { outsidePool: true, recorded: true } } : {}) }, 202);
  }
  if (url.pathname === "/api/logs" && method === "POST") {
    const { reqs } = JSON.parse(String(init?.body)) as { reqs: Array<{ id: string; path: string; offset: number }> };
    return json({ chunks: Object.fromEntries(reqs.map((req) => {
      if (req.path === evidence.failLogsFor) return [req.id, { error: "transcript read failed in the evidence fixture" }];
      if ((LAUNCH_CLS || SEAT_CLS || NEW_AGENT) && req.path === launchRun.path) {
        /* The transcript grows by whole lines: a read answers what lies past the offset it was given. */
        const bytes = new TextEncoder().encode(launchTranscript());
        return [req.id, { data: new TextDecoder().decode(bytes.slice(req.offset)), start: req.offset, offset: bytes.length, size: bytes.length }];
      }
      const data = transcriptOf(req.path);
      const bytes = new TextEncoder().encode(data);
      const size = bytes.length;
      /* The first-message window reads a transcript that grows: the route answers from the caller's offset, as the real one does. */
      if ((FIRST_MESSAGE || FEED_RECOVERY || FEED_CONTINUITY) && req.offset > 0 && req.offset < size) return [req.id, { data: new TextDecoder().decode(bytes.slice(req.offset)), start: req.offset, offset: size, size }];
      return [req.id, { data: req.offset >= size ? "" : data, start: 0, offset: size, size }];
    })) });
  }
  /* The seat's mandate is Delegatus's own delivery, so the server's provenance names it as such and the transcript's
     record of it renders as the mandate card, never as the operator's bubble. */
  if (url.pathname === "/api/log/provenance" && FIRST_MESSAGE && FM_SEAT) {
    if (FM_HANDOVER) await fmEvidenceGate;
    return json({ messages: { [FM_SEAT_UUID]: { origin: "agent", mandate: { kind: "version", version: 1 } } }, occurrences: [{ textDigest: messageTextDigest(fmDeliveredText()), deliveredAt: iso(60), origin: "agent", mandate: { kind: "version", version: 1 } }] });
  }
  if (REPORT_PREVIEW && url.pathname === "/api/log/suggestions") {
    /* The set the seat offers after reading the preview back: the tool's own approving draft beside a no and an edit. */
    const uk = reportPreviewLanguage() === "uk";
    const offered = url.searchParams.get("conversationId") === orchestrator.conversationId;
    return json({ set: offered ? {
      conversationId: orchestrator.conversationId, setId: "rsg_report_preview", at: iso(30),
      origin: { kind: "manager", conversationId: orchestrator.conversationId, role: "orchestrator" },
      replies: [
        issueReportApprovalDrafts(REPORT_PREVIEW_DIGEST)[reportPreviewLanguage()],
        uk ? { label: "Ні, не публікуй", text: "Ні, не публікуй цей звіт." } : { label: "No, do not publish", text: "No, do not publish this report." },
        uk ? { label: "Зміни текст…", text: "Зміни текст: " } : { label: "Edit the text…", text: "Edit the text: " },
      ],
    } : null });
  }
  if (url.pathname === "/api/log") return json({ data: "", start: 0, offset: 0, size: 0 });
  if (url.pathname === "/api/conversations") return json({ items: files, total: files.length, nextCursor: null });
  if (url.pathname === "/api/orchestrator/seat" && method === "POST" && FM_SEAT) {
    fm.posts.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    fm.confirmed = true;
    fmApply();
    return json({ ok: true, launched: true, transport: "structured", launchId: FM_LAUNCH_ID, conversationId: FM_CONVERSATION_ID, state: "path-pending", initialMessage: "queued", path: null });
  }
  if (url.pathname === "/api/orchestrator/seat" && NO_SEAT && !(FM_SEAT && fm.confirmed)) {
    evidence.seatReads += 1;
    const all = { conversationIds: [], paths: [], previous: { conversationIds: [], paths: [] } };
    if (url.searchParams.get("scope") === "all") return json({ all });
    return json({ seat: null, pending: null, lastFailure: null, exists: true, viewerMcpRegistered: false, previous: [], currentTask: null, all });
  }
  if (url.pathname === "/api/orchestrator/seat") {
    evidence.seatReads += 1;
    return json({
      seat: {
        project: PROJECT, seatEpoch: 3, conversationId: orchestrator.conversationId, path: orchestrator.path, mandate: "Keep the project moving.",
        promptVersion: SEAT_HEAD ? ORCHESTRATOR_PROMPT_VERSION - 1 : null, predecessorConversationId: null, state: "active",
        intent: { clientRequestId: "seat-atlas", mode: "spawn", launchId: null, error: null }, designatedAt: iso(9 * 60 * MIN), activatedAt: iso(9 * 60 * MIN),
      },
      pending: null,
      exists: true,
      viewerMcpRegistered: true,
      ...(SEAT_HEAD ? {
        previous: Array.from({ length: 20 }, (_, index) => ({
          conversationId: `conversation_previous_${index}`, title: `Seat ${index + 1}`, engine: "claude",
          heldFrom: iso((40 - index) * 60 * MIN), heldTo: iso((39 - index) * 60 * MIN), taskId: null, hasNotes: false,
        })),
      } : {}),
    });
  }
  if ((SEAT_HEAD || (FM_SEAT && fm.confirmed)) && url.pathname === "/api/orchestrator/seat/status") {
    return json({
      project: PROJECT, designated: true, conversationId: orchestrator.conversationId, predecessorConversationId: null,
      engine: "claude", model: "claude-opus-4-5-1m", effort: "high", accountId: "primary", cwd: "/repo/atlas", transcriptPath: orchestrator.path,
      liveness: { lifecycle: "running", hostState: "alive", silentForMs: 1_000 },
      context: { tokens: 520_825, limit: 1_000_000, percent: 52, estimated: false, basis: "" },
      transcriptFacts: null,
      rotation: FM_SEAT
        ? { recommended: false, level: "none", reasons: [], thresholdUnknown: false }
        : SEAT_GONE
        ? {
          recommended: true, level: "strongly_recommend", thresholdUnknown: false,
          reasons: [
            "context usage 520,825 tokens has reached the rotation threshold of 500,000 tokens (claude-opus-1m: 50% of a 1,000,000-token window)",
            "the designated conversation's host is gone; rotate, or resume it with send_message_to_orchestrator",
          ],
          causes: [
            { kind: "context", tokens: 520_825, estimated: false, thresholdTokens: 500_000, windowTokens: 1_000_000 },
            { kind: "host_gone" },
          ],
        }
        : { recommended: true, level: "strongly_recommend", reasons: ["context usage has reached the rotation threshold"], thresholdUnknown: false },
      ...(SEAT_TELEGRAM ? { telegram: SEAT_TELEGRAM } : {}),
    });
  }
  /* The rail's footer, so the frames that fold it away (#1802) have something
     to fold: invented machine figures and one invented limit window. */
  if (url.pathname.startsWith("/api/resources")) {
    const diskRole = new URLSearchParams(location.search).get("disk-role");
    const diskWarning = new URLSearchParams(location.search).get("disk-level") === "warning";
    const host = (target: string, title: string, over: Record<string, unknown>) => ({
      target, panePid: 4_100, kind: "structured", path: null, engine: "claude", title, project: LEDGER, activity: "idle", lastActiveAt: iso(6 * 60 * MIN), cwd: "/repo/ledger",
      rssBytes: 600 * 1024 ** 2, swapBytes: 0, procCount: 3, model: "opus", role: "builder", conversationId: null, stage: "implement", ownership: "owned", seat: false, turnBusy: false, ...over,
    });
    return json({
      ...(diskRole ? { diskPressure: {
        at: iso(0), episode: iso(MIN), warningBytes: 10 * 1024 ** 3, criticalBytes: 2 * 1024 ** 3,
        /* `all`: one 256 GiB volume under state, worktrees and temp, with every consumer measured; `disk-level=warning` leaves it above the admission threshold. */
        volumes: diskRole === "all"
          ? [{ roles: ["state", "worktrees", "temp"], totalBytes: 256 * 1024 ** 3, ...(diskWarning ? { freeBytes: 8 * 1024 ** 3, level: "warning" } : { freeBytes: 1.4 * 1024 ** 3, level: "critical" }) }]
          : [{ roles: [diskRole === "required-temp" ? "temp" : diskRole], freeBytes: 0.5 * 1024 ** 3, level: "critical", ...(diskRole === "required-temp" ? { provisioning: true } : {}) }],
        consumers: diskRole === "all"
          ? [{ kind: "state", bytes: 2.1 * 1024 ** 3, measuredAt: iso(0) }, { kind: "worktrees", bytes: 187 * 1024 ** 3, measuredAt: iso(0) }, { kind: "temp", bytes: 15 * 1024 ** 3, measuredAt: iso(0) }]
          : [{ kind: "worktrees", bytes: 90 * 1024 ** 3, measuredAt: iso(0) }],
      } } : {}),
      system: { ramTotal: 32 * 1024 ** 3, ramAvailable: 9 * 1024 ** 3, swapTotal: 8 * 1024 ** 3, swapUsed: 1024 ** 3, capturedAt: iso(30) },
      sessions: RAIL ? [
        host("host-ledger-build", "Reconciling the ledger export", { activity: "live", lastActiveAt: iso(20), rssBytes: 1_400 * 1024 ** 2, turnBusy: true }),
        host("host-harbor-index", "Indexed the handbook", { project: "harbor-docs", cwd: "/repo/harbor", engine: "codex", model: "gpt-5.6", role: "reviewer", stage: "review" }),
      ] : [],
      ...(RAIL_STATE === "stale" ? { sessionsStale: true, sessionsCapturedAt: iso(40 * MIN) } : {}),
    });
  }
  if (RAIL_STATE === "copilot" && url.pathname === "/api/accounts/copilot") {
    return json({ cli: { present: true, reason: null }, active: "copilot-main", accounts: [{ id: "copilot-main", label: "Account H", kind: "managed", active: true, auth: "signed_in", user: null, loginCommand: null, login: null }] });
  }
  if (RAIL && url.pathname === "/api/limits/history") {
    const series = (windowSeconds: number, spentShare: number, left: number) => {
      const windowStart = now - Math.round(windowSeconds * spentShare);
      return { windowStart, resetsAt: windowStart + windowSeconds, windowSeconds, samples: Array.from({ length: 12 }, (_, index) => ({ t: windowStart + Math.round(((now - windowStart) * index) / 11), remaining: Math.round(100 - ((100 - left) * index) / 11) })) };
    };
    return json({ claude: { session: series(18_000, 0.6, 88), weekly: series(604_800, 0.45, 70) }, codex: { session: series(18_000, 0.8, 60), weekly: series(604_800, 0.7, 90) }, claudeAccountId: "default", codexAccountId: null, historySince: iso(3 * 24 * 60 * MIN) });
  }
  if (RAIL_STATE === "stale" && url.pathname === "/api/limits") {
    return json({
      claude: { ...tierLimits, capturedAt: now - 45 * MIN },
      codex: null,
      claudeAccountId: "default",
      codexAccountId: null,
      provenance: {
        claude: { source: "cache", reason: null, staleSince: iso(45 * MIN) },
        codex: { source: "unavailable", reason: "oauth-rate-limited", staleSince: iso(10 * MIN), retryAt: new Date((now + 20 * MIN) * 1_000).toISOString() },
      },
      staleSince: iso(45 * MIN),
    });
  }
  if (url.pathname === "/api/limits") {
    return json({
      claude: TIER_LIMITS ? tierLimits : null,
      codex: { session: { usedPercent: 40, resetsAt: now + 3_600, windowMinutes: 300 }, weekly: { usedPercent: 10, resetsAt: now + 172_800, windowMinutes: 10_080 }, plan: "pro", capturedAt: now },
      claudeAccountId: TIER_LIMITS ? "default" : null,
      codexAccountId: null,
      ...(RAIL_STATE === "copilot" ? { copilot: { session: null, weekly: { usedPercent: 35, resetsAt: now + 12 * 86_400, windowMinutes: 43_200 }, plan: "pro", capturedAt: now }, copilotAccountId: "copilot-main" } : {}),
      provenance: { claude: { source: TIER_LIMITS ? "live" : "unavailable", reason: null, staleSince: null }, codex: { source: "live", reason: null, staleSince: null }, ...(RAIL_STATE === "copilot" ? { copilot: { source: "live", reason: null, staleSince: null } } : {}) },
      staleSince: null,
    });
  }
  return json({}, 404);
}) as typeof fetch;

/* #1820's scenarios ARE the Overview, which is the view with no project
   selected; every other scenario opens on `atlas`'s own board. */
const OVERVIEW_VIEW = OVERVIEW_SCOPE || OVERVIEW_EMPTY || new URLSearchParams(location.search).get("railview") === "overview";
if (OVERVIEW_VIEW) localStorage.removeItem("llvProject");
else localStorage.setItem("llvProject", PROJECT);
/* The harness may seed a language before this module runs (`openFixture`), so
   English is only the DEFAULT here — writing it unconditionally turned every
   requested Ukrainian frame back into an English render (#1743). */
if (!localStorage.getItem("llv_lang")) localStorage.setItem("llv_lang", "en");
if (!location.hash && !OVERVIEW_VIEW) location.hash = `#p=${PROJECT}`;
const queueTask = { id: "task_native", title: "Fix __init__.py (#42)" };
const queueTaskText = taskReferencePrelude([queueTask]) + "\nstart this one";
const taskDeputy: SeatDeputyView = { askId: "deputy_task", seatConversationId: "conversation_seat_task", deputyConversationId: "conversation_parallel_task",
  ask: { text: queueTaskText, images: 0, sender: null, origin: { kind: "operator" } }, artifactPath: null, forkRecordCount: 0, forkBytes: 0,
  state: "ended", startedAt: "2026-10-02T09:00:00.000Z", activatedAt: null, endedAt: "2026-10-02T09:01:00.000Z", outcome: "done",
  touched: { taskIds: [], pipelineIds: [], conversationIds: [] }, result: { line: "Done", finalText: "Done" } };
const queueTaskPreview = <div className="p-3"><NativeQueuePanel
  view={{ rows: [{ entryId: "entry-task", clientUserMessageId: "client-task", nativeSubmissionId: "native-task", revision: 1, text: queueTaskText,
    selectedContext: { version: 1, state: "none", capturedAt: "2026-10-02T09:00:00.000Z", tasks: [queueTask] }, images: [], imageCount: 0, state: "queued", reason: null,
    busy: false, observedInNative: true, dispatchedRevision: null, proven: false, requestedRuntime: null, actions: ["edit", "delete"], blocked: null }],
    nativeStale: false, canStart: false, activeTurnId: null, reorderable: [], notice: null }}
  unresolved={[{ key: "unknown-task", text: queueTaskText, imageCount: 0 }, { key: "refused-task", text: queueTaskText, imageCount: 0, refused: "refused" }]}
  error={null} thread={{ model: null, effort: null }} cardId="conversation_task_queue" mintKey={() => "task-queue-edit"}
  submit={async () => ({ ok: true })} onRefresh={() => {}} t={(key, params) => translate(UK ? "uk" : "en", key, params)}
/><div className="mt-3"><SeatDeputyChip deputy={taskDeputy} /><DeputyBlock deputy={taskDeputy} /></div></div>;
if (HEADER_MENU && new URLSearchParams(location.search).has("member")) void refreshTeamView();
const diskDensity = new URLSearchParams(location.search).get("disk-density");
createRoot(document.getElementById("root")!).render(diskDensity ? (
  <div className="bg-panel" style={{ width: diskDensity === "full" ? "100%" : 248, marginTop: "auto" }}>
    <ResourcesFooter density={diskDensity === "full" ? "full" : diskDensity === "detail" ? "detail" : "line"} />
  </div>
) : SCENARIO === "task-queue-preview" ? queueTaskPreview : SCENARIO === "service-tier" || SCENARIO === "role-defaults" ? (
  new URLSearchParams(location.search).has("mapping") ? <div className="p-6"><AgentMappingTable statuses={{ claude: { connected: true, account: null }, codex: { connected: true, account: null } }} layout={innerWidth < 640 ? "card" : "table"} onConnect={() => {}} /></div> : <div className="p-6" style={{ paddingTop: 400 }}>
    <RuntimePill file={{ ...searchVer2, engine: "codex", root: "codex-sessions", model: "gpt-6-astra", effort: "high", fast: true, serviceTier: "ultrafast" }} surface="structured" runtimeSettings={{ perTurnEffort: true, perTurnModel: false }} />
  </div>
) : <Viewer />);
