import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/*
 * docs/design/orchestrator-reports.md §5.6: where a project's reports go
 * besides the bridge. Only a chat the operator chose is posted to; "Log only"
 * and a project that never chose report to the bridge log only, however many
 * chats the bot may post in. The bot panel names the projects each chat
 * carries reports for.
 */

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-report-destination-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = SANDBOX;
fs.writeFileSync(path.join(SANDBOX, "project-remotes.json"), JSON.stringify({ schemaVersion: 1, remotes: { "repo-with-github": "github.com/acme/widgets" } }));

const { effectiveReportTelegram, reportHeaderName, reportTelegram, reportTelegramChoice, resetProjectSettingsForTests, setReportTelegram } = await import("./settings");
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

test("a project that never chose posts nowhere, however many chats accept posts", () => {
  expect(reportTelegramChoice(PROJECT)).toBeNull();
  expect(effectiveReportTelegram(PROJECT)).toBeNull();
});

test("Log only is stored apart from never chosen and posts nowhere", () => {
  expect(setReportTelegram(PROJECT, null, "operator", "2026-09-26T10:00:00.000Z")).toEqual({ chat: null, changedAt: "2026-09-26T10:00:00.000Z", changedBy: "operator" });
  resetProjectSettingsForTests();
  expect(reportTelegramChoice(PROJECT)).toEqual({ chat: null, changedAt: "2026-09-26T10:00:00.000Z", changedBy: "operator" });
  expect(reportTelegram(PROJECT)).toBeNull();
  expect(effectiveReportTelegram(PROJECT)).toBeNull();
  const stored = JSON.parse(fs.readFileSync(path.join(SANDBOX, "project-settings.json"), "utf8"));
  expect(stored.projects[PROJECT].reportTelegram).toEqual({ chat: null, changedAt: "2026-09-26T10:00:00.000Z", changedBy: "operator" });
});

test("a chosen chat is the destination and keeps its own name", () => {
  setReportTelegram(PROJECT, { chat: "design-lounge", name: "Atlas" }, "operator");
  expect(effectiveReportTelegram(PROJECT)).toEqual({ chat: "design-lounge", name: "Atlas", source: "chosen" });
});

/* An explicit record written before this change reads the same. */
test("a record stored by the earlier release keeps working unchanged", () => {
  fs.writeFileSync(path.join(SANDBOX, "project-settings.json"), JSON.stringify({ schemaVersion: 1, projects: {
    [PROJECT]: { reportTelegram: { chat: "team-reports", name: "Widgets", changedAt: "2026-09-26T09:00:00.000Z", changedBy: "operator" } },
    "repo-other": { reportTelegram: { chat: null, changedAt: "2026-09-26T09:00:00.000Z", changedBy: "operator" } },
  } }));
  resetProjectSettingsForTests();
  expect(effectiveReportTelegram(PROJECT)).toEqual({ chat: "team-reports", name: "Widgets", source: "chosen" });
  expect(effectiveReportTelegram("repo-other")).toBeNull();
});

test("a report header names the project readably and never by its internal key", () => {
  const opaque = ["dir-0123456789abcdef0123", "repo-fedcba9876543210fedc"];
  for (const project of opaque) {
    expect(reportHeaderName(project)).toBe("Unnamed project");
    expect(reportHeaderName(project, "uk")).toBe("Проєкт без назви");
  }
  expect(reportHeaderName(PROJECT)).toBe("Widgets");
  setReportTelegram(opaque[0]!, { chat: "team-reports", name: "Atlas" }, "operator");
  expect(reportHeaderName(opaque[0]!)).toBe("Atlas");
  fs.writeFileSync(path.join(SANDBOX, "project-aliases.json"), JSON.stringify({ schemaVersion: 1, aliases: {}, displayNames: { [opaque[1]!]: "Orbit" } }));
  expect(reportHeaderName(opaque[1]!)).toBe("Orbit");
});

const chat = (over: Partial<TelegramBotChatView>): TelegramBotChatView => ({
  chatId: "-1000000000101", title: "Team Reports", type: "supergroup", username: null, isForum: false, member: true, alias: "team-reports",
  postAllowed: true, postable: true, seesAllMessages: false, readdToApply: false, lastMessageAt: null, lastPostAt: null, lastPostBy: null, storedMessages: 0, ...over,
});
const status = (chats: TelegramBotChatView[]): TelegramBotStatusPayload => ({
  connected: true, bot: null, receiving: "polling", lastUpdateAt: null, lastCheckedAt: null, chats, limits: [],
});

test("the bot panel names only the projects whose operator chose each chat", () => {
  const lounge = chat({ chatId: "-1000000000202", title: "Design Lounge", alias: null, postAllowed: false, postable: false });
  const one = withReportDestinations(status([chat({}), lounge]), [PROJECT]);
  expect(one.chats[0]!.reports).toBeUndefined();
  expect(one.chats[1]!.reports).toBeUndefined();

  setReportTelegram("repo-other", { chat: "team-reports", name: "Atlas" }, "operator");
  const two = withReportDestinations(status([chat({}), chat({ chatId: "-1000000000303", title: "Design Lounge", alias: "design-lounge" })]), [PROJECT, "repo-other"]);
  expect(two.chats[0]!.reports).toEqual([{ name: "Atlas" }]);
  expect(two.chats[1]!.reports).toBeUndefined();

  setReportTelegram(PROJECT, null, "operator");
  expect(withReportDestinations(status([chat({})]), [PROJECT]).chats[0]!.reports).toBeUndefined();
});

/* A chosen chat switched off in the bot panel stays the destination, which
   records its refused posts; the panel keeps its line on that chat, marked
   refused, and does not re-route to another chat. */
test("a chosen chat that refuses posts keeps its reports line, marked refused", () => {
  setReportTelegram(PROJECT, { chat: "design-lounge", name: "Atlas" }, "operator");
  const lounge = chat({ chatId: "-1000000000202", title: "Design Lounge", alias: "design-lounge", postAllowed: false, postable: false });
  const panel = withReportDestinations(status([chat({}), lounge]), [PROJECT]);
  expect(panel.chats[1]!.reports).toEqual([{ name: "Atlas", refused: true }]);
  expect(panel.chats[0]!.reports).toBeUndefined();
  const gone = withReportDestinations(status([chat({}), { ...lounge, member: false }]), [PROJECT]);
  expect(gone.chats[1]!.reports).toEqual([{ name: "Atlas", refused: true }]);
});
