import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";
import { NextRequest } from "next/server";

/* The project settings route (#2187 §4.1): the board reads the merge setting
   with whether the project has a GitHub repository, and the operator's PUT
   writes it under the canonical key. A sandboxed state directory, pinned
   before the stores load. */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-project-settings-route-"));
const ORIGINAL_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = SANDBOX;
fs.writeFileSync(path.join(SANDBOX, "project-remotes.json"), JSON.stringify({ schemaVersion: 1, remotes: { "repo-with-github": "github.com/acme/widgets" } }));

const { GET, PUT } = await import("./route");

afterAll(() => {
  if (ORIGINAL_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = ORIGINAL_STATE;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

const ORIGIN = "http://127.0.0.1:8899";
const get = (project: string) => GET(new NextRequest(`${ORIGIN}/api/projects/settings?project=${encodeURIComponent(project)}`));
const put = (body: unknown) => PUT(new NextRequest(`${ORIGIN}/api/projects/settings`, {
  method: "PUT",
  headers: { "content-type": "application/json", origin: ORIGIN, host: "127.0.0.1:8899" },
  body: JSON.stringify(body),
}));

test("the setting reads off by default, turns on through PUT, and says when the project has no GitHub repository", async () => {
  const before = await (await get("repo-with-github")).json();
  expect(before).toMatchObject({ ok: true, project: "repo-with-github", mergeOnReview: { enabled: false }, github: "acme/widgets" });
  const on = await put({ project: "repo-with-github", mergeOnReview: true });
  expect(on.status).toBe(200);
  expect((await on.json()).mergeOnReview).toMatchObject({ enabled: true, changedBy: "operator" });
  expect((await (await get("repo-with-github")).json()).mergeOnReview.enabled).toBe(true);
  expect((await (await get("dir-no-remote")).json())).toMatchObject({ mergeOnReview: { enabled: false }, github: null });
  expect((await put({ project: "repo-with-github", mergeOnReview: "yes" })).status).toBe(400);
  expect((await get("")).status).toBe(400);
});

/* #2146: Bridge reports read on by default, and a PUT carrying only that
   switch leaves the merge setting as it was. */
test("the bridge reports setting reads on by default and turns off through its own PUT", async () => {
  const before = await (await get("repo-bridge")).json();
  expect(before.bridgeReports).toMatchObject({ enabled: true, changedAt: null });
  const off = await put({ project: "repo-bridge", bridgeReports: false });
  expect(off.status).toBe(200);
  const body = await off.json();
  expect(body.bridgeReports).toMatchObject({ enabled: false, changedBy: "operator" });
  expect(body.mergeOnReview.enabled).toBe(false);
  expect((await (await get("repo-bridge")).json()).bridgeReports.enabled).toBe(false);
  await put({ project: "repo-bridge", mergeOnReview: true });
  expect((await (await get("repo-bridge")).json())).toMatchObject({ bridgeReports: { enabled: false }, mergeOnReview: { enabled: true } });
  expect((await put({ project: "repo-bridge", bridgeReports: "off" })).status).toBe(400);
  expect((await put({ project: "repo-bridge" })).status).toBe(400);
});

/* docs/design/orchestrator-reports.md §5.6: the Telegram report destination
   is the operator's to set, only to a chat the bot may post in, and a
   project with a GitHub remote gets its repository's name as the suggested
   header name. */
test("the Telegram report destination is refused for a chat the bot may not post in, set for one it may, and cleared with null", async () => {
  const { setTelegramBotServiceForTests } = await import("@/lib/telegram/bot/service");
  const before = await (await get("repo-with-github")).json();
  expect(before).toMatchObject({ reportTelegram: null, reportNameSuggestion: "Widgets" });

  expect((await put({ project: "repo-with-github", reportTelegram: { chat: "team-reports", name: "Widgets" } })).status).toBe(409);
  expect((await put({ project: "repo-with-github", reportTelegram: { chat: "team-reports", name: "" } })).status).toBe(400);

  setTelegramBotServiceForTests({
    listChats: () => ({ chats: [{ chat: "team-reports", chatId: "-100100", title: "Team Reports", alias: "team-reports", postAllowed: true }, { chat: "-100200", alias: null, postAllowed: false }] }),
  } as never);
  try {
    expect((await put({ project: "repo-with-github", reportTelegram: { chat: "-100200", name: "Widgets" } })).status).toBe(409);
    const set = await put({ project: "repo-with-github", reportTelegram: { chat: "team-reports", name: "Widgets" } });
    expect(set.status).toBe(200);
    const setBody = await set.json();
    expect(setBody.reportTelegram).toMatchObject({ chat: "team-reports", name: "Widgets", changedBy: "operator" });
    /* The seat's chip names the group by the title the picker shows. */
    expect(setBody.reportChatTitle).toBe("Team Reports");
    expect((await (await get("repo-with-github")).json()).mergeOnReview.enabled).toBe(true);
    const cleared = await put({ project: "repo-with-github", reportTelegram: null });
    expect((await cleared.json())).toMatchObject({ reportTelegram: { chat: null, changedBy: "operator" }, reportDestination: null, reportChatTitle: null });
  } finally {
    setTelegramBotServiceForTests(null);
  }
});

/* Only a project the operator marked posts to Telegram: a project that never
   chose shows no destination even when the bot may post in exactly one chat,
   a chosen chat is the destination, and a stored Log only stays the log only. */
test("the effective destination is the chosen chat only, never a chat the operator did not pick", async () => {
  const { setTelegramBotServiceForTests } = await import("@/lib/telegram/bot/service");
  setTelegramBotServiceForTests({
    listChats: () => ({ chats: [{ chat: "team-reports", alias: "team-reports", postAllowed: true }] }),
  } as never);
  try {
    const fresh = await (await get("repo-fresh")).json();
    expect(fresh).toMatchObject({ reportTelegram: null, reportDestination: null, postableChats: 1 });
    expect("reportFallbackName" in fresh).toBe(false);
    await put({ project: "repo-fresh", reportTelegram: { chat: "team-reports", name: "Fresh" } });
    expect(await (await get("repo-fresh")).json()).toMatchObject({ reportDestination: { chat: "team-reports", name: "Fresh", source: "chosen" } });
    await put({ project: "repo-fresh", reportTelegram: null });
    expect(await (await get("repo-fresh")).json()).toMatchObject({ reportTelegram: { chat: null }, reportDestination: null, postableChats: 1 });
  } finally {
    setTelegramBotServiceForTests(null);
  }
});

/* A post-only bot (another program owns its updates) never hears of the
   groups it joins; the operator adds them by id. Such a chat is selectable
   for a project's reports with no update received, and each project's group
   is its own: switching one leaves the other where it was. */
test("a chat added by id is selectable with no update, and each project keeps its own group", async () => {
  const { TelegramBotService, productionTelegramBotDependencies, setTelegramBotServiceForTests } = await import("@/lib/telegram/bot/service");
  const { FakeBotTransport, fakeBotToken, ok } = await import("@/lib/telegram/bot/fakeTransport");
  const { projectReportOverview } = await import("@/lib/projects/reportDestination");
  const transport = new FakeBotTransport();
  transport.handlers.getWebhookInfo = () => ok({ url: "https://example.invalid/hook" });
  const service = new TelegramBotService({ ...productionTelegramBotDependencies(), transportFor: () => transport, sleep: async () => {} });
  setTelegramBotServiceForTests(service);
  try {
    transport.script("getMe", ok({ id: 4242424, is_bot: true, first_name: "Report Bot" }));
    await service.connect(fakeBotToken());
    expect(await put({ project: "repo-alpha", reportTelegram: { chat: "release-notes", name: "Alpha" } })).toHaveProperty("status", 409);

    transport.script("getChat", ok({ id: -1000000000404, type: "supergroup", title: "Release Notes" }), ok({ id: -1000000000505, type: "supergroup", title: "Design Lounge" }));
    transport.script("getChatMember", ok({ status: "member" }), ok({ status: "administrator" }));
    await service.addChat("-1000000000404");
    await service.addChat("-1000000000505");

    expect((await put({ project: "repo-alpha", reportTelegram: { chat: "release-notes", name: "Alpha" } })).status).toBe(200);
    expect((await put({ project: "repo-beta", reportTelegram: { chat: "design-lounge", name: "Beta" } })).status).toBe(200);
    expect(await (await get("repo-alpha")).json()).toMatchObject({ reportDestination: { chat: "release-notes", name: "Alpha" }, postableChats: 2 });
    expect(await (await get("repo-beta")).json()).toMatchObject({ reportDestination: { chat: "design-lounge", name: "Beta" } });

    /* Moving one project leaves the other, and a project never set stays the log only. */
    await put({ project: "repo-alpha", reportTelegram: null });
    expect(await (await get("repo-alpha")).json()).toMatchObject({ reportTelegram: { chat: null }, reportDestination: null });
    expect(await (await get("repo-beta")).json()).toMatchObject({ reportDestination: { chat: "design-lounge", name: "Beta" } });
    expect(projectReportOverview(["repo-alpha", "repo-beta", "repo-gamma"]).map((line) => [line.project, line.reportTelegram?.chat])).toEqual([
      ["repo-alpha", null],
      ["repo-beta", "design-lounge"],
      ["repo-gamma", undefined],
    ]);
    expect(transport.callsOf("getUpdates")).toEqual([]);
  } finally {
    await service.remove();
    setTelegramBotServiceForTests(null);
  }
});
