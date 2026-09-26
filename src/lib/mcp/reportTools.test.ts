import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { emptySeatTickState, type SeatTickProjectState } from "@/lib/monitor/types";
import { resetOperatorSettingsForTests, updateOperatorSettings } from "@/lib/operator/settings";
import { setBridgeReports, setReportTelegram } from "@/lib/projects/settings";

import { viewerMcpBindings, type CallerAttribution } from "./bindings";
import { operatorLanguageInstruction, viewerMcpInstructions } from "./server";

/*
 * The tool answers that carry the report rules (docs/design/orchestrator-reports.md
 * §4.2, §5.3, §5.4): the interface language on get_orchestrator and in the
 * session instructions, the language warning on task text, the reminder on an
 * ask, and what a seat is told when it quiets its own tick.
 */

let sandbox = "";
let previous: string | undefined;

beforeEach(() => {
  previous = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-report-tools-"));
  process.env.LLV_STATE_DIR = sandbox;
  resetOperatorSettingsForTests();
});
afterEach(() => {
  if (previous === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previous;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const PROJECT = "repo-project-a";
const SEAT = "conversation_seat";
const MANAGER: CallerAttribution = { kind: "manager", conversationId: SEAT, role: "orchestrator" };

function bindings(over: Record<string, unknown> = {}) {
  return viewerMcpBindings(undefined, { post: async () => ({ ok: true }) }, {
    registrySnapshot: () => ({ conversations: {}, conversationAliases: {} }),
    attentionAuthority: () => ({ kind: "worker", conversationId: SEAT, role: "orchestrator" }),
    callerAttribution: () => MANAGER,
    callerProject: () => PROJECT,
    authorizedSeats: () => [{ conversationId: SEAT, path: "/seat.jsonl", project: PROJECT }],
    canonicalSeatConversationId: (id: string) => id,
    ...over,
  } as never);
}

test("get_orchestrator carries the interface language and the Telegram destination, null until set", async () => {
  expect(await bindings().get_orchestrator({ clientRequestId: "o-1", project: PROJECT })).toMatchObject({ operatorLocale: null, reportTelegram: null });
  updateOperatorSettings({ locale: "uk", source: "chosen" });
  setReportTelegram(PROJECT, { chat: "team-reports", name: "Delegatus" }, "operator");
  expect(await bindings().get_orchestrator({ clientRequestId: "o-2", project: PROJECT })).toMatchObject({ operatorLocale: "uk", reportTelegram: { chat: "team-reports", name: "Delegatus" } });
  expect(await bindings().get_orchestrator({ clientRequestId: "o-3", project: PROJECT, full: true })).toMatchObject({ operatorLocale: "uk", reportTelegram: { chat: "team-reports", name: "Delegatus" } });
});

test("get_orchestrator reports the bot's one allowed chat for a project that never chose, and nothing after Log only", async () => {
  const withChats = (chats: string[]) => bindings({ reportChats: async () => chats });
  expect(await withChats(["team-reports"]).get_orchestrator({ clientRequestId: "f-1", project: PROJECT })).toMatchObject({ reportTelegram: { chat: "team-reports", source: "only-allowed-chat" } });
  expect(await withChats(["team-reports", "design-lounge"]).get_orchestrator({ clientRequestId: "f-2", project: PROJECT })).toMatchObject({ reportTelegram: null });
  setReportTelegram(PROJECT, null, "operator");
  expect(await withChats(["team-reports"]).get_orchestrator({ clientRequestId: "f-3", project: PROJECT })).toMatchObject({ reportTelegram: null });
  setReportTelegram(PROJECT, { chat: "design-lounge", name: "Atlas" }, "operator");
  expect(await withChats(["team-reports"]).get_orchestrator({ clientRequestId: "f-4", project: PROJECT, full: true })).toMatchObject({ reportTelegram: { chat: "design-lounge", name: "Atlas", source: "chosen" } });
});

test("the session instructions name the interface language once a client reported it, and say nothing before", () => {
  expect(operatorLanguageInstruction(null)).toBe("");
  expect(viewerMcpInstructions(null)).not.toContain("interface language");
  const uk = viewerMcpInstructions("uk");
  expect(uk).toContain("The operator's interface language is Ukrainian: write board task text (create_task and update_task text, refine) and bridge reports in Ukrainian.");
  expect(uk.startsWith("This server is Delegatus")).toBe(true);
});

test("task text in another language than the interface is stored with a warning; details are never checked; nothing is said while the language is unknown", async () => {
  const english = "Scroll on the large board is slow\nFind the cause on the real board and fix it before the next release.";
  const unknown = await bindings().create_task({ clientRequestId: "t-0", project: PROJECT, text: english });
  expect(unknown.warnings).toBeUndefined();

  const created = await bindings({ operatorLocale: () => "uk" }).create_task({ clientRequestId: "t-1", project: PROJECT, text: english, details: "agent notes in any language whatsoever, long enough to classify" });
  expect(created.warnings).toEqual(["This task text reads as English; the operator's interface is Ukrainian. Write it in Ukrainian."]);

  const ukrainian = "Прокрутка великої дошки гальмує\nЗнайти причину на справжній дошці і виправити її до наступного релізу.";
  const taskId = (created as { id?: string; taskId?: string }).id ?? (created as { taskId?: string }).taskId;
  const updated = await bindings({ operatorLocale: () => "uk" }).update_task({ clientRequestId: "t-2", taskId, text: ukrainian });
  expect(updated.warnings).toBeUndefined();
  const detailsOnly = await bindings({ operatorLocale: () => "uk" }).update_task({ clientRequestId: "t-3", taskId, details: "english agent notes that are long enough to be classified as english prose" });
  expect(detailsOnly.warnings).toBeUndefined();
});

test("a seat's ask reminds it that an away operator learns the ask only from a question report", async () => {
  const replies = [{ label: "yes", text: "Yes, go ahead." }, { label: "hold", text: "Hold for now." }];
  const answer = await bindings().suggest_replies({ clientRequestId: "s-1", replies });
  expect(answer.reminder).toBe(`If the operator is away, they learn this ask only from a question report: file one with key ask:${answer.setId as string} and the ask in the decision section.`);
  setBridgeReports(PROJECT, false, "operator");
  const off = await bindings().suggest_replies({ clientRequestId: "s-2", replies });
  expect(off.reminder).toBeUndefined();
});

test("switching the tick off or slowing it answers with the owed reports, the open ask and a request for a report now", async () => {
  const owed: SeatTickProjectState = {
    ...emptySeatTickState(),
    reportsOwed: [{ key: "deploy:aaaaaaaa:succeeded", label: "deploy aaaaaaaa succeeded", receivedAt: "2026-09-25T12:00:00.000Z" }],
    asksOwed: [{ key: "ask:rsg_1", setId: "rsg_1", conversationId: SEAT, at: "2026-09-25T12:00:00.000Z" }],
  };
  const domain = { peekTickState: () => owed };
  const off = await bindings(domain).seat_tick_settings({ clientRequestId: "k-1", enabled: false, reason: "night" });
  expect(off).toMatchObject({ reportsOwed: ["deploy:aaaaaaaa:succeeded"], askOwed: ["ask:rsg_1"] });
  expect(off.reportReminder).toStartWith("Nothing will ask you for reports while the tick is off or slowed. File a report now");

  const slower = await bindings(domain).seat_tick_settings({ clientRequestId: "k-2", enabled: true, wakeIntervalMinutes: 180, reason: "slow day" });
  expect(slower.reportsOwed).toEqual(["deploy:aaaaaaaa:succeeded"]);

  const faster = await bindings(domain).seat_tick_settings({ clientRequestId: "k-3", wakeIntervalMinutes: 30, reason: "busy" });
  expect(faster.reportReminder).toBeUndefined();

  setBridgeReports(PROJECT, false, "operator");
  const reportsOff = await bindings(domain).seat_tick_settings({ clientRequestId: "k-4", enabled: false, reason: "night" });
  expect(reportsOff.reportReminder).toBeUndefined();
});
