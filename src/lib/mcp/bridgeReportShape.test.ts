import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/*
 * docs/design/orchestrator-reports.md §5.2, §5.5: the designated seat's report
 * is filed as a summary and sections, rendered once into the bridge copy and
 * the Telegram copy, scrubbed of private information, and posted to the
 * project's chat through the bot service, idempotently and silently.
 */

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-bridge-report-shape-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");

const { appendBridgeReports, readBridgeReportLog, resetBridgeCollectionsForTests, scopedReportId } = await import("@/lib/bridge/store");
const { persistProjectAliases, resetProjectAliasesForTests } = await import("@/lib/projects/aliases");
const { recordDeploySnapshot, resetTaskChangeCollectionsForTests } = await import("@/lib/bridge/taskChanges");
const { resetProjectSettingsForTests, setBridgeReports, setReportTelegram } = await import("@/lib/projects/settings");
const { TelegramBotError, TelegramBotService, productionTelegramBotDependencies } = await import("@/lib/telegram/bot/service");
const { FakeBotTransport, fakeBotToken, ok, refused, unreachable } = await import("@/lib/telegram/bot/fakeTransport");
const { viewerMcpBindings } = await import("./bindings");
const { createMcpToolService, MemoryMcpReceiptStore } = await import("./server");

import type { BoardTask } from "@/lib/tasks/types";
import type { CallerAttribution, ReportTelegramSend } from "./bindings";
import type { McpToolResult } from "./server";

const MANAGER: CallerAttribution = { kind: "manager", conversationId: "conversation_mgr", role: "orchestrator" };
const WORKER: CallerAttribution = { kind: "agent", conversationId: "conversation_builder", role: "builder" };
const PROJECT = "repo-project-a";
const OTHER = "repo-project-b";
/* Invented chat; no such group exists. */
const TEAM = { id: -1000000000101, type: "supergroup", title: "Team Reports" };
const LOUNGE = { id: -1000000000202, type: "supergroup", title: "Design Lounge" };
const NOW = new Date("2026-09-25T18:45:00Z");
/* A deployment id, assembled at run time: a UUID written out is what the
   publication gate refuses in a committed file. */
const deploymentId = (head: string) => [head, "0000", "4000", "8000", "0".repeat(12)].join("-");

let transport: InstanceType<typeof FakeBotTransport>;
let bot: InstanceType<typeof TelegramBotService>;
let locale: "en" | "uk" | null = "en";
let tasks: BoardTask[] = [];

function newBot() {
  return new TelegramBotService({
    ...productionTelegramBotDependencies(),
    transportFor: () => transport,
    now: () => NOW,
    sleep: async () => {},
    conversationTitle: () => null,
  });
}

async function connectTeamChat() {
  transport.script("getMe", ok({ id: 4242424, is_bot: true, first_name: "Report Bot", username: "report_test_bot", can_join_groups: true, can_read_all_group_messages: false }));
  await bot.connect(fakeBotToken());
  await bot.stopPoller();
  transport.script("getUpdates", ok([
    { update_id: 1, my_chat_member: { chat: TEAM as never, date: 1, new_chat_member: { status: "administrator" } } },
  ]));
  await bot.pollOnce(new AbortController().signal);
  bot.setChat(String(TEAM.id), "team-reports", true);
}

/** A second chat agents may post in, after `connectTeamChat`. */
async function allowLoungeChat() {
  transport.script("getUpdates", ok([
    { update_id: 2, my_chat_member: { chat: LOUNGE as never, date: 2, new_chat_member: { status: "administrator" } } },
  ]));
  await bot.pollOnce(new AbortController().signal);
  bot.setChat(String(LOUNGE.id), "design-lounge", true);
}

/** What the Viewer's bot agent route does with the binding's post. */
async function sendThroughBot(input: ReportTelegramSend) {
  try {
    const answer = await bot.send({ conversationId: MANAGER.conversationId, clientRequestId: input.clientRequestId, chat: input.chat, text: input.html, format: "html", silent: true });
    return { ok: true as const, messageIds: answer.messageIds };
  } catch (error) {
    if (error instanceof TelegramBotError) return { ok: false as const, code: error.code };
    throw error;
  }
}

/* The Viewer control a binding reads the bot's chats through, answered from
   the test bot and refusing everything else, so a revision that still looks
   the chat list up sees the one allowed chat without a network. */
const BOT_CONTROL = {
  get: async (pathname: string) => {
    if (pathname !== "/api/telegram/bot/agent?op=chats") throw new Error(`unexpected Viewer control read ${pathname}`);
    return { chats: bot.listChats().chats.map((chat) => ({ chat: chat.chat, postAllowed: chat.postAllowed })) };
  },
  post: async (pathname: string) => { throw new Error(`unexpected Viewer control write ${pathname}`); },
};

function serviceAs(attribution: CallerAttribution, project = PROJECT, seatProject = project) {
  const bindings = viewerMcpBindings(undefined, BOT_CONTROL, {
    callerAttribution: () => attribution,
    callerProject: () => project,
    authorizedSeats: () => [{ conversationId: MANAGER.conversationId!, path: null, project: seatProject }],
    operatorLocale: () => locale,
    operatorTimeZone: () => "Europe/Kyiv",
    publicDenyList: () => ({ accounts: ["account-b"], people: ["Person Bee"], local: [], projects: [{ repository: "someone/other-repo", names: ["other-repo"] }] }),
    sendReportTelegram: sendThroughBot,
    listTaskRecords: () => tasks,
    loadTasks: () => tasks,
  } as never);
  return createMcpToolService(bindings, new MemoryMcpReceiptStore());
}

type ReportAnswer = McpToolResult & {
  recorded?: boolean;
  alreadyRecorded?: boolean;
  seq?: number;
  reportId?: string;
  warnings?: string[];
  destinations?: { bridge: { seq: number }; telegram?: { chat: string; state: string; messageIds?: number[]; code?: string; retryable?: boolean } };
  code?: string;
  error?: string;
};

let counter = 0;
async function file(args: Record<string, unknown>, as: CallerAttribution = MANAGER, project = PROJECT): Promise<ReportAnswer> {
  counter += 1;
  return await serviceAs(as, project).callTool("bridge_report", { clientRequestId: `rep-${counter}`, class: "status", ...args }) as ReportAnswer;
}

beforeEach(async () => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
  resetBridgeCollectionsForTests();
  resetTaskChangeCollectionsForTests();
  resetProjectSettingsForTests();
  resetProjectAliasesForTests();
  locale = "en";
  tasks = [];
  transport = new FakeBotTransport();
  bot = newBot();
});
afterEach(async () => {
  await bot.remove();
});
afterAll(() => {
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = OLD_STATE;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test("a summary and sections are stored as the rendered bridge copy, with no warning when the report is clean", async () => {
  const answer = await file({
    key: "digest:2026-09-25T15:30",
    summary: "Two lanes running, nothing needed from you.",
    sections: { inProgress: ["the large board's scroll speed: measuring, then the fix", "part 2 of the first-run flow (#2166): the build is running"], queued: ["find out why agent turns hang"] },
  });
  expect(answer.ok).toBe(true);
  expect(answer.recorded).toBe(true);
  expect(answer.warnings).toEqual([]);
  const row = readBridgeReportLog().reports[0]!;
  expect(answer.destinations).toEqual({ bridge: { seq: row.seq } });
  expect(row.id).toBe(scopedReportId(PROJECT, "digest:2026-09-25T15:30"));
  const lines = row.body.split("\n");
  expect(lines[0]).toStartWith("🕒 ");
  expect(lines[0]).toContain(" · status · ");
  expect(lines[1]).toBe("Two lanes running, nothing needed from you.");
  expect(row.body).toContain("🛠 In progress\n• the large board's scroll speed: measuring, then the fix");
  expect(row.body).toContain("⏳ Next\n• find out why agent turns hang");
  expect(row.telegram).toBeUndefined();
});

test("an older caller's body is filed as in-progress items, with a warning to use summary and sections", async () => {
  const answer = await file({ key: "legacy-1", body: "deploy 1c41d361 passed\nprod answers 200" });
  expect(answer.recorded).toBe(true);
  expect(answer.warnings!.some((warning) => warning.startsWith("Use summary and sections"))).toBe(true);
  expect(readBridgeReportLog().reports[0]!.body).toContain("• deploy 1c41d361 passed\n• prod answers 200");
});

test("covers are stored as project-scoped ids, and coversOwed stores coversOwedAt equal to the row's time", async () => {
  await file({ key: "deploy:aaaaaaaa:succeeded", class: "completed", summary: "Deploy aaaaaaaa is on prod.", sections: { prod: ["deploy aaaaaaaa"] }, covers: ["lane:L1:completed"], coversOwed: true });
  const row = readBridgeReportLog().reports[0]!;
  expect(row.covers).toEqual([scopedReportId(PROJECT, "lane:L1:completed")]);
  expect(row.coversOwedAt).toBe(row.at);
});

test("two projects filing the same key get two rows: ids are scoped by project", async () => {
  const first = await file({ key: "digest:2026-09-25T15:30", summary: "Project A has one lane running." });
  const second = await file({ key: "digest:2026-09-25T15:30", summary: "Project B has one lane running." }, MANAGER, OTHER);
  expect(first.recorded).toBe(true);
  expect(second.recorded).toBe(true);
  expect(readBridgeReportLog().reports.map((report) => report.id)).toEqual([
    scopedReportId(PROJECT, "digest:2026-09-25T15:30"),
    scopedReportId(OTHER, "digest:2026-09-25T15:30"),
  ]);
  const again = await file({ key: "digest:2026-09-25T15:30", summary: "again" });
  expect(again.alreadyRecorded).toBe(true);
});

test("a seat whose conversation still carries the project's old key files under the canonical key, and a row filed under the old key is its replay", async () => {
  /* The folder had no origin when the seat was recorded, and the origin added
     later made the repository key; the alias joins the two. */
  const OLD = "repo-project-a-before-origin";
  expect(persistProjectAliases([{ source: OLD, target: PROJECT, displayName: "Project A" }])).toBe(true);
  const aliased = serviceAs(MANAGER, OLD, PROJECT);
  const answer = await aliased.callTool("bridge_report", {
    clientRequestId: "rep-aliased", class: "completed", key: "deploy:aaaaaaaa:succeeded",
    summary: "Deploy aaaaaaaa is on prod.", covers: ["lane:L1:completed"], coversOwed: true,
  }) as ReportAnswer;
  expect(answer.recorded).toBe(true);
  const row = readBridgeReportLog().reports[0]!;
  expect(row.project).toBe(PROJECT);
  expect(row.id).toBe(scopedReportId(PROJECT, "deploy:aaaaaaaa:succeeded"));
  expect(row.covers).toEqual([scopedReportId(PROJECT, "lane:L1:completed")]);
  expect(row.targetSeatConversationId).toBe(MANAGER.conversationId);

  /* Filed before the fold: the same key under the old project is already recorded. */
  appendBridgeReports([{ key: "digest:2026-09-25T15:30", class: "status", at: NOW.toISOString(), origin: MANAGER, project: OLD, targetSeatConversationId: null, body: "One lane running." }]);
  const replay = await aliased.callTool("bridge_report", { clientRequestId: "rep-aliased-2", key: "digest:2026-09-25T15:30", class: "status", summary: "One lane running." }) as ReportAnswer;
  expect(replay.alreadyRecorded).toBe(true);
  expect(readBridgeReportLog().reports).toHaveLength(2);
});

test("a report in another language than the interface warns; none while the interface language is unknown", async () => {
  locale = "uk";
  const english = await file({ key: "lang-1", summary: "Release 1.5.0 is on production and npm is still catching up with the new version." });
  expect(english.recorded).toBe(true);
  expect(english.warnings).toContain("This report reads as English; the operator's interface is Ukrainian. Write it in Ukrainian.");
  expect(readBridgeReportLog().reports[0]!.body).toContain(" · статус · ");

  const russian = await file({ key: "lang-2", summary: "Релиз 1.5.0 уже на проде, а npm ещё обновляет версию, это займёт несколько минут." });
  expect(russian.warnings).toContain("This report reads as Russian; the operator's interface is Ukrainian. Write it in Ukrainian.");

  locale = null;
  const unknown = await file({ key: "lang-3", summary: "Release 1.5.0 is on production and npm is still catching up with the new version." });
  expect(unknown.warnings!.some((warning) => warning.includes("reads as"))).toBe(false);
});

function task(id: string, status: BoardTask["status"], text: string): BoardTask {
  return { id, project: PROJECT, status, text, assignments: [], createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() } as unknown as BoardTask;
}

test("a deploy report lists the board's task changes since the previous successful deploy", async () => {
  tasks = [task("t1", "assigned", "Scroll on the large board is slow"), task("t2", "inbox", "First run leads with the orchestrator")];
  recordDeploySnapshot(PROJECT, { deploymentId: deploymentId("d0000001"), revision: "5064e5ec".padEnd(40, "0"), phase: "succeeded", terminal: true, updatedAt: "2026-09-25T16:20:00Z" }, tasks);
  tasks = [task("t1", "done", "Scroll on the large board is slow"), task("t2", "inbox", "First run leads with the orchestrator"), task("t3", "inbox", "Activity opens on the phone")];
  recordDeploySnapshot(PROJECT, { deploymentId: deploymentId("d0000002"), revision: "1c41d361".padEnd(40, "0"), phase: "succeeded", terminal: true, updatedAt: "2026-09-25T18:45:00Z" }, tasks);

  const answer = await file({ key: "deploy:1c41d361:succeeded", class: "completed", summary: "Release 1.5.0 is on prod.", sections: { prod: ["release 1.5.0"] }, coversOwed: true });
  expect(answer.recorded).toBe(true);
  const body = readBridgeReportLog().reports[0]!.body;
  expect(body.split("\n")[0]).toContain(" · deploy · ");
  expect(body).toContain("📋 Tasks since the previous deploy\n• Done: Scroll on the large board is slow\n• New: Activity opens on the phone");
});

test("a deploy with no snapshot shows no task section, and the answer says so", async () => {
  const answer = await file({ key: "deploy:99999999:succeeded", class: "completed", summary: "Deploy 99999999 is on prod.", sections: { prod: ["deploy 99999999"] } });
  expect(readBridgeReportLog().reports[0]!.body).not.toContain("📋");
  expect(answer.warnings!.some((warning) => warning.startsWith("No task changes are listed"))).toBe(true);
});

test("a report with nothing left after the scrub is refused, stores nothing and posts nothing", async () => {
  await connectTeamChat();
  setReportTelegram(PROJECT, { chat: "team-reports", name: "Delegatus" }, "operator");
  const answer = await file({ key: "deploy:aaaaaaaa:succeeded", class: "completed", sections: { prod: ["the build reads /srv/build/checkout/state and account-b"] } });
  expect(answer.ok).toBe(false);
  expect(answer.code).toBe("report_empty_after_scrub");
  expect(answer.retryable).toBe(false);
  expect(readBridgeReportLog().reports).toEqual([]);
  expect(transport.callsOf("sendMessage")).toHaveLength(0);
});

test("an item with private information is dropped from both copies with a warning naming only the class", async () => {
  await connectTeamChat();
  setReportTelegram(PROJECT, { chat: "team-reports", name: "Delegatus" }, "operator");
  transport.script("sendMessage", ok({ message_id: 70, date: 100 }));
  const answer = await file({ key: "digest-scrub", summary: "One lane running.", sections: { inProgress: ["the release lane", "the deploy failed because account-b spent its weekly limit"] } });
  expect(answer.recorded).toBe(true);
  expect(answer.warnings!.join(" ")).toContain("named an account name");
  expect(answer.warnings!.join(" ")).not.toContain("account-b");
  const row = readBridgeReportLog().reports[0]!;
  expect(row.body).not.toContain("account-b");
  expect(row.telegram!.html).not.toContain("account-b");
  expect(row.body).toContain("• the release lane");
});

test("a manager report posts once to the project's chat, silently and as HTML, the row's stored Telegram copy; a replay posts nothing", async () => {
  await connectTeamChat();
  setReportTelegram(PROJECT, { chat: "team-reports", name: "Delegatus" }, "operator");
  transport.script("sendMessage", ok({ message_id: 71, date: 100 }));
  const answer = await file({ key: "digest-post", summary: "One lane running, see #2166.", sections: { inProgress: ["part 3 of the first-run flow (#2166)"] } });
  expect(answer.recorded).toBe(true);
  const row = readBridgeReportLog().reports[0]!;
  expect(answer.destinations!.telegram).toEqual({ chat: "team-reports", state: "sent", messageIds: [71] });
  const sends = transport.callsOf("sendMessage");
  expect(sends).toHaveLength(1);
  expect(sends[0]!.params).toMatchObject({ chat_id: TEAM.id, parse_mode: "HTML", disable_notification: true });
  expect(sends[0]!.params.text).toBe(row.telegram!.html);
  expect(row.telegram!.html).toStartWith("🕒 <b>Delegatus · status</b> · ");
  expect(row.telegram!.html).toContain("<blockquote expandable>");
  expect(row.telegram!.html).not.toContain("<a ");

  const replay = await file({ key: "digest-post", summary: "different words" });
  expect(replay.alreadyRecorded).toBe(true);
  expect(transport.callsOf("sendMessage")).toHaveLength(1);
});

test("a rate-limited post is re-sent on replay byte for byte, under a new request id, whatever the replay says", async () => {
  await connectTeamChat();
  setReportTelegram(PROJECT, { chat: "team-reports", name: "Delegatus" }, "operator");
  transport.script("sendMessage", refused(429, "Too Many Requests", { retryAfterSeconds: 3 }));
  const first = await file({ key: "digest-retry", summary: "One lane running.", sections: { inProgress: ["the release lane"] } });
  expect(first.recorded).toBe(true);
  expect(first.destinations!.telegram).toMatchObject({ state: "failed", code: "rate_limited", retryable: true });
  const stored = readBridgeReportLog().reports[0]!.telegram!.html;

  transport.script("sendMessage", ok({ message_id: 72, date: 101 }));
  const replay = await file({ key: "digest-retry", summary: "A completely different summary.", sections: { queued: ["something else entirely"] } });
  expect(replay.alreadyRecorded).toBe(true);
  expect(replay.destinations!.telegram).toEqual({ chat: "team-reports", state: "sent", messageIds: [72] });
  const sends = transport.callsOf("sendMessage");
  expect(sends).toHaveLength(2);
  expect(sends[1]!.params.text).toBe(stored);
  expect(readBridgeReportLog().reports[0]!.telegram).toMatchObject({ state: "sent", attempts: 2, html: stored });
});

test("a failed post is not re-sent on replay once the project chose the log only", async () => {
  await connectTeamChat();
  setReportTelegram(PROJECT, { chat: "team-reports", name: "Delegatus" }, "operator");
  transport.script("sendMessage", refused(429, "Too Many Requests", { retryAfterSeconds: 3 }));
  const first = await file({ key: "leak-log-only", summary: "One lane running." });
  expect(first.destinations!.telegram).toMatchObject({ state: "failed", code: "rate_limited", retryable: true });

  setReportTelegram(PROJECT, null, "operator");
  transport.script("sendMessage", ok({ message_id: 74, date: 103 }));
  const replay = await file({ key: "leak-log-only", summary: "One lane running." });
  expect(replay.alreadyRecorded).toBe(true);
  expect(replay.destinations!.telegram).toMatchObject({ chat: "team-reports", state: "failed", code: "rate_limited" });
  expect(transport.callsOf("sendMessage")).toHaveLength(1);
  expect(readBridgeReportLog().reports[0]!.telegram).toMatchObject({ state: "failed", attempts: 1 });
});

/* A row written while the removed fallback chat stood in for a choice carries
   that chat for a project that never chose. */
test("a failed post of a project that never chose is not re-sent on replay", async () => {
  await connectTeamChat();
  setReportTelegram(PROJECT, { chat: "team-reports", name: "Delegatus" }, "operator");
  transport.script("sendMessage", refused(429, "Too Many Requests", { retryAfterSeconds: 3 }));
  const first = await file({ key: "leak-never-chose", summary: "One lane running." });
  expect(first.destinations!.telegram).toMatchObject({ state: "failed", code: "rate_limited", retryable: true });

  fs.rmSync(path.join(process.env.LLV_STATE_DIR!, "project-settings.json"), { force: true });
  resetProjectSettingsForTests();
  transport.script("sendMessage", ok({ message_id: 75, date: 104 }));
  const replay = await file({ key: "leak-never-chose", summary: "One lane running." });
  expect(replay.alreadyRecorded).toBe(true);
  expect(replay.destinations!.telegram).toMatchObject({ chat: "team-reports", state: "failed", code: "rate_limited" });
  expect(transport.callsOf("sendMessage")).toHaveLength(1);
});

test("a failed post is not re-sent to a chat the project chose after it", async () => {
  await connectTeamChat();
  await allowLoungeChat();
  setReportTelegram(PROJECT, { chat: "team-reports", name: "Delegatus" }, "operator");
  transport.script("sendMessage", refused(429, "Too Many Requests", { retryAfterSeconds: 3 }));
  await file({ key: "leak-new-chat", summary: "One lane running." });

  setReportTelegram(PROJECT, { chat: "design-lounge", name: "Delegatus" }, "operator");
  transport.script("sendMessage", ok({ message_id: 76, date: 105 }));
  const replay = await file({ key: "leak-new-chat", summary: "One lane running." });
  expect(replay.destinations!.telegram).toMatchObject({ chat: "team-reports", state: "failed" });
  expect(transport.callsOf("sendMessage")).toHaveLength(1);
});

test("a worker replaying the manager's key after a failed send re-sends nothing", async () => {
  await connectTeamChat();
  setReportTelegram(PROJECT, { chat: "team-reports", name: "Delegatus" }, "operator");
  transport.script("sendMessage", refused(429, "Too Many Requests", { retryAfterSeconds: 3 }));
  const first = await file({ key: "digest-worker-replay", summary: "One lane running." });
  expect(first.destinations!.telegram).toMatchObject({ state: "failed", code: "rate_limited", retryable: true });

  transport.script("sendMessage", ok({ message_id: 73, date: 102 }));
  const replay = await file({ key: "digest-worker-replay", summary: "One lane running." }, WORKER);
  expect(replay.alreadyRecorded).toBe(true);
  expect(replay.destinations!.telegram).toMatchObject({ state: "failed", code: "rate_limited" });
  expect(transport.callsOf("sendMessage")).toHaveLength(1);
  expect(readBridgeReportLog().reports[0]!.telegram).toMatchObject({ state: "failed", attempts: 1 });
});

test("a send that may already be posted is never re-sent", async () => {
  await connectTeamChat();
  setReportTelegram(PROJECT, { chat: "team-reports", name: "Delegatus" }, "operator");
  transport.script("sendMessage", unreachable("timed_out"));
  const first = await file({ key: "digest-uncertain", summary: "One lane running." });
  expect(first.destinations!.telegram).toMatchObject({ state: "uncertain", code: "send_uncertain", retryable: false });
  await file({ key: "digest-uncertain", summary: "One lane running." });
  expect(transport.callsOf("sendMessage")).toHaveLength(1);
});

test("an agent's report, a project that chose the log only and a project with reports off post nothing", async () => {
  await connectTeamChat();
  setReportTelegram(PROJECT, { chat: "team-reports", name: "Delegatus" }, "operator");
  setReportTelegram(OTHER, null, "operator");
  const agent = await file({ key: "agent-1", summary: "stage settled" }, WORKER);
  expect(agent.recorded).toBe(true);
  expect(readBridgeReportLog().reports[0]!.body).toBe("[builder conversation_builder — not the manager] stage settled");

  const noChat = await file({ key: "other-1", summary: "Project B has one lane running." }, MANAGER, OTHER);
  expect(noChat.recorded).toBe(true);
  expect(noChat.destinations!.telegram).toBeUndefined();

  setBridgeReports(PROJECT, false, "operator");
  const off = await file({ key: "off-1", summary: "One lane running." });
  expect(off.recorded).toBe(false);
  expect(transport.callsOf("sendMessage")).toHaveLength(0);
});

/* Only a project the operator marked reports to Telegram. The bot's one chat
   agents may post in is not a choice for a project that never chose: a
   private project's report must not reach a public group by default. */
test("a project that never chose posts nothing to Telegram, even with exactly one allowed chat", async () => {
  await connectTeamChat();
  transport.script("sendMessage", ok({ message_id: 81, date: 110 }));
  const answer = await file({ key: "never-1", summary: "One lane running.", sections: { inProgress: ["the release lane"] } });
  expect(answer.recorded).toBe(true);
  expect(answer.destinations).toEqual({ bridge: { seq: answer.seq! } });
  expect(transport.callsOf("sendMessage")).toHaveLength(0);
  expect(readBridgeReportLog().reports[0]!.telegram).toBeUndefined();
});

test("a project the operator marked posts to its chat under the name it was given", async () => {
  await connectTeamChat();
  setReportTelegram(PROJECT, { chat: "team-reports", name: "Atlas" }, "operator");
  transport.script("sendMessage", ok({ message_id: 82, date: 111 }));
  const answer = await file({ key: "marked-1", summary: "One lane running." });
  expect(answer.destinations!.telegram).toEqual({ chat: "team-reports", state: "sent", messageIds: [82] });
  const sends = transport.callsOf("sendMessage");
  expect(sends).toHaveLength(1);
  expect(sends[0]!.params).toMatchObject({ chat_id: TEAM.id, parse_mode: "HTML", disable_notification: true });
  expect(String(sends[0]!.params.text)).toStartWith("🕒 <b>Atlas · status</b> · ");
});

test("a project that chose the log only posts nothing, even with one allowed chat", async () => {
  await connectTeamChat();
  setReportTelegram(PROJECT, null, "operator");
  const answer = await file({ key: "log-only-1", summary: "Two lanes running." });
  expect(answer.recorded).toBe(true);
  expect(answer.destinations).toEqual({ bridge: { seq: answer.seq! } });
  expect(transport.callsOf("sendMessage")).toHaveLength(0);
  expect(readBridgeReportLog().reports[0]!.telegram).toBeUndefined();
});

/* A project keyed by its identity hash with no GitHub repository and no
   display name: nothing in either copy of the report names it by that key. */
test("a report header never prints an internal dir- or repo- key", async () => {
  await connectTeamChat();
  for (const [index, project] of ["dir-0123456789abcdef0123", "repo-fedcba9876543210fedc"].entries()) {
    const logOnly = await file({ key: `opaque-${index}`, summary: "One lane running." }, MANAGER, project);
    expect(logOnly.recorded).toBe(true);
    const row = readBridgeReportLog().reports.find((entry) => entry.seq === logOnly.seq)!;
    expect(row.body).not.toMatch(/\b(?:dir|repo)-[0-9a-f]{16,}/);
    expect(row.body.split("\n")[0]).toContain("Unnamed project");

    setReportTelegram(project, { chat: "team-reports", name: "Orbit" }, "operator");
    transport.script("sendMessage", ok({ message_id: 90 + index, date: 120 + index }));
    const posted = await file({ key: `opaque-posted-${index}`, summary: "Two lanes running." }, MANAGER, project);
    expect(posted.destinations!.telegram).toMatchObject({ chat: "team-reports", state: "sent" });
  }
  const sends = transport.callsOf("sendMessage");
  expect(sends).toHaveLength(2);
  for (const send of sends) {
    expect(String(send.params.text)).toStartWith("🕒 <b>Orbit · status</b> · ");
    expect(String(send.params.text)).not.toMatch(/\b(?:dir|repo)-[0-9a-f]{16,}/);
  }
});

test("a chat the operator chose stays the destination once agents may no longer post there, and a project that never chose still posts nothing", async () => {
  await connectTeamChat();
  await allowLoungeChat();
  setReportTelegram(PROJECT, { chat: "design-lounge", name: "Atlas" }, "operator");
  transport.script("sendMessage", ok({ message_id: 82, date: 111 }));
  const answer = await file({ key: "chosen-1", summary: "One lane running." });
  expect(answer.destinations!.telegram).toEqual({ chat: "design-lounge", state: "sent", messageIds: [82] });
  const sends = transport.callsOf("sendMessage");
  expect(sends).toHaveLength(1);
  expect(sends[0]!.params.chat_id).toBe(LOUNGE.id);

  /* The lounge is switched off, so the team chat is the only one agents may
     post in: the project that chose the lounge is refused there, and the one
     that never chose goes nowhere. */
  bot.setChat(String(LOUNGE.id), "design-lounge", false);
  const other = await file({ key: "chosen-other", summary: "Project B has one lane running." }, MANAGER, OTHER);
  expect(other.destinations!.telegram).toBeUndefined();
  const refused = await file({ key: "chosen-2", summary: "Two lanes running." });
  expect(refused.destinations!.telegram).toMatchObject({ chat: "design-lounge", state: "failed", code: "chat_not_allowed" });
  expect(transport.callsOf("sendMessage")).toHaveLength(1);
});
