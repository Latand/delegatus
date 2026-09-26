import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/*
 * docs/design/orchestrator-reports.md §5.6: where a project's reports go
 * besides the bridge. A chat the operator chose and "Log only" always win; a
 * project that never chose uses the bot's one allowed chat, since the
 * operator already picked it in the bot panel; with none or several nothing
 * is posted until they pick. The bot panel names the projects each chat
 * carries reports for.
 */

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-report-destination-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = SANDBOX;
fs.writeFileSync(path.join(SANDBOX, "project-remotes.json"), JSON.stringify({ schemaVersion: 1, remotes: { "repo-with-github": "github.com/acme/widgets" } }));

const { effectiveReportTelegram, reportTelegram, reportTelegramChoice, resetProjectSettingsForTests, setReportTelegram } = await import("./settings");
const { withReportDestinations } = await import("./reportDestination");

import type { TelegramBotChatView, TelegramBotStatusPayload } from "@/lib/telegram/bot/contracts";

const PROJECT = "repo-with-github";

beforeEach(() => {
  fs.rmSync(path.join(SANDBOX, "project-settings.json"), { force: true });
  resetProjectSettingsForTests();
});
afterAll(() => {
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = OLD_STATE;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test("a project that never chose uses the one allowed chat, named after its repository", () => {
  expect(reportTelegramChoice(PROJECT)).toBeNull();
  expect(effectiveReportTelegram(PROJECT, ["team-reports"])).toEqual({ chat: "team-reports", name: "Widgets", source: "only-allowed-chat" });
});

test("a project that never chose posts nowhere with no allowed chat or with several", () => {
  expect(effectiveReportTelegram(PROJECT, [])).toBeNull();
  expect(effectiveReportTelegram(PROJECT, ["team-reports", "design-lounge"])).toBeNull();
});

test("Log only is stored apart from never chosen and wins over the one allowed chat", () => {
  expect(setReportTelegram(PROJECT, null, "operator", "2026-09-26T10:00:00.000Z")).toEqual({ chat: null, changedAt: "2026-09-26T10:00:00.000Z", changedBy: "operator" });
  resetProjectSettingsForTests();
  expect(reportTelegramChoice(PROJECT)).toEqual({ chat: null, changedAt: "2026-09-26T10:00:00.000Z", changedBy: "operator" });
  expect(reportTelegram(PROJECT)).toBeNull();
  expect(effectiveReportTelegram(PROJECT, ["team-reports"])).toBeNull();
  const stored = JSON.parse(fs.readFileSync(path.join(SANDBOX, "project-settings.json"), "utf8"));
  expect(stored.projects[PROJECT].reportTelegram).toEqual({ chat: null, changedAt: "2026-09-26T10:00:00.000Z", changedBy: "operator" });
});

test("a chosen chat wins over the one allowed chat and keeps its own name", () => {
  setReportTelegram(PROJECT, { chat: "design-lounge", name: "Atlas" }, "operator");
  expect(effectiveReportTelegram(PROJECT, ["team-reports"])).toEqual({ chat: "design-lounge", name: "Atlas", source: "chosen" });
  expect(effectiveReportTelegram(PROJECT, ["team-reports", "design-lounge"])).toMatchObject({ chat: "design-lounge", source: "chosen" });
});

const chat = (over: Partial<TelegramBotChatView>): TelegramBotChatView => ({
  chatId: "-1000000000101", title: "Team Reports", type: "supergroup", username: null, isForum: false, member: true, alias: "team-reports",
  postAllowed: true, postable: true, seesAllMessages: false, readdToApply: false, lastMessageAt: null, lastPostAt: null, lastPostBy: null, storedMessages: 0, ...over,
});
const status = (chats: TelegramBotChatView[]): TelegramBotStatusPayload => ({
  connected: true, bot: null, receiving: "polling", lastUpdateAt: null, lastCheckedAt: null, chats, limits: [],
});

test("the bot panel names the projects whose reports go to each chat, and why", () => {
  const lounge = chat({ chatId: "-1000000000202", title: "Design Lounge", alias: null, postAllowed: false, postable: false });
  const one = withReportDestinations(status([chat({}), lounge]), [PROJECT]);
  expect(one.chats[0]!.reports).toEqual([{ name: "Widgets", onlyAllowedChat: true }]);
  expect(one.chats[1]!.reports).toBeUndefined();

  setReportTelegram("repo-other", { chat: "team-reports", name: "Atlas" }, "operator");
  const two = withReportDestinations(status([chat({}), chat({ chatId: "-1000000000303", title: "Design Lounge", alias: "design-lounge" })]), [PROJECT, "repo-other"]);
  expect(two.chats[0]!.reports).toEqual([{ name: "Atlas", onlyAllowedChat: false }]);
  expect(two.chats[1]!.reports).toBeUndefined();

  setReportTelegram(PROJECT, null, "operator");
  expect(withReportDestinations(status([chat({})]), [PROJECT]).chats[0]!.reports).toBeUndefined();
});
