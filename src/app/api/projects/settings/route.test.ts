import { setCallerConversationResolverForTests } from "@/lib/agent/operatorAuthority";
import { soloBrowserSession } from "@/lib/agent/operatorSession";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CloneSendInput } from "@/lib/externalRelay/cloneSend";

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
  headers: { cookie: `llv_operator=${soloBrowserSession()}`, "content-type": "application/json", origin: ORIGIN, host: "127.0.0.1:8899" },
  body: JSON.stringify(body),
}));

test("a clone-only report destination saves its topic and delivers through the paired relay", async () => {
  const { TelegramBotService, productionTelegramBotDependencies, setTelegramBotServiceForTests } = await import("@/lib/telegram/bot/service");
  const { FakeBotTransport, fakeBotToken, ok, refused } = await import("@/lib/telegram/bot/fakeTransport");
  const { CloneDirectory } = await import("@/lib/externalRelay/cloneDirectory");
  const { clonePairing, cloneTargets, cloneReceipt } = await import("@/lib/externalRelay/clone.fixture");
  const { sendAsClone } = await import("@/lib/externalRelay/cloneSend");
  const { startTestRelay } = await import("@/lib/externalRelay/testRelay");
  const now = new Date("2026-10-20T12:00:00Z");
  const sends: CloneSendInput[] = [];
  const server = await startTestRelay((req, body) => {
    if (req.url!.includes("include=chats")) return { body: cloneTargets() };
    expect(req.url!.endsWith("/send")).toBe(true);
    sends.push(body as CloneSendInput);
    return { body: cloneReceipt() };
  });
  const relay = clonePairing(server.origin);
  const directory = new CloneDirectory({ file: path.join(SANDBOX, "report-clones.json"), relays: () => [relay], now: () => now.getTime(), origin: server.origin });
  const transport = new FakeBotTransport();
  let localBotCanSeeTopics = false;
  let localTopicsEnabled = true;
  transport.handlers.getMe = () => ok({ id: 4242424, is_bot: true, first_name: "Local report bot" });
  transport.handlers.getWebhookInfo = () => ok({ url: "https://example.invalid/hook" });
  transport.handlers.getChat = () => localBotCanSeeTopics
    ? ok({ id: -1000000000101, type: "supergroup", title: "Fixture reports", is_forum: localTopicsEnabled })
    : refused(403, "Forbidden: bot was kicked from the supergroup chat");
  transport.handlers.getChatMember = () => ok({ status: "kicked" });
  const deps = productionTelegramBotDependencies();
  let revokeAfterLookup = false;
  let revokeAfterSnapshot = false;
  const service = new TelegramBotService({ ...deps, now: () => now, transportFor: () => transport,
    clones: { discoverChats: () => directory.discoverChats(),
      route: async chat => {
        const found = await directory.route(chat);
        if (revokeAfterLookup) { revokeAfterLookup = false; revokeAfterSnapshot = true; }
        return found;
      },
      peek: chat => {
        const found = directory.peek(chat);
        if (revokeAfterSnapshot) {
          revokeAfterSnapshot = false;
          queueMicrotask(() => service.setChat(chat, "fixture-reports", false));
        }
        return found;
      },
      valid: (r, chat) => directory.valid(r, chat), invalidate: (r, kind) => directory.invalidate(r, kind),
      send: (r, input, options) => sendAsClone(r.relay, r.targetId, input, options) } });
  let store: ReturnType<typeof deps.openStore> | undefined;
  setTelegramBotServiceForTests(service);
  try {
    await service.connect(fakeBotToken());
    await service.discoverCloneChats();
    store = deps.openStore();
    store.setMemberStatus("-1000000000101", "kicked", false);
    service.setChat("-1000000000101", "fixture-reports", true);
    expect(service.listChats().chats.find(chat => chat.chatId === "-1000000000101")).toMatchObject({ postAllowed: true, bots: [expect.objectContaining({ name: "Report clone", canPost: true }), expect.objectContaining({ status: "kicked" })] });
    expect(await service.addChat("-1000000000101")).toMatchObject({ chat: "fixture-reports" });
    const saved = await put({ project: "repo-clone-topic", reportTelegram: { link: "https://t.me/c/0000000101/12", name: "Fixture report" } });
    const body = await saved.json();
    expect(saved.status).toBe(200);
    expect(body).toMatchObject({ reportDestination: { chat: "fixture-reports", topicId: 12 } });
    expect(await (await get("repo-clone-topic")).json()).toMatchObject({ reportTelegram: { topicId: 12 } });
    const { POST: sendReport } = await import("@/app/api/telegram/bot/agent/route");
    const delivered = await sendReport(new NextRequest(`${ORIGIN}/api/telegram/bot/agent`, {
      method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, host: "127.0.0.1:8899" },
      body: JSON.stringify({ op: "send", clientRequestId: "clone-topic-report", ...body.reportDestination, text: "Fixture report", format: "html", silent: true }),
    }));
    expect(delivered.status).toBe(200);
    expect(await delivered.json()).toMatchObject({ messageIds: [101], sentBy: { name: "Report clone" } });
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ chat_id: -1000000000101, message_thread_id: 12 });
    expect(transport.callsOf("sendMessage")).toEqual([]);
    // A local bot can gain visibility after clone coverage was warmed. Saving
    // the link must refresh its forum state before taking the clone fast path.
    store.recordLookedUpChat({ id: -1000000000101, type: "supergroup", title: "Fixture reports", is_forum: false }, null, now);
    const getChatCallsBeforeRefresh = transport.callsOf("getChat").length;
    localBotCanSeeTopics = true;
    const refreshedForum = await put({ project: "repo-clone-forum-refresh", reportTelegram: { link: "https://t.me/c/0000000101/13", name: "Fixture report" } });
    expect(refreshedForum.status).toBe(200);
    expect(await refreshedForum.json()).toMatchObject({ reportDestination: { topicId: 13 } });
    expect(transport.callsOf("getChat").length).toBeGreaterThan(getChatCallsBeforeRefresh);
    expect(service.listChats().chats.find(chat => chat.chatId === "-1000000000101")?.isForum).toBe(true);
    const explicit = await put({ project: "repo-clone-explicit", reportTelegram: { chat: "fixture-reports", topicId: 19, name: "Fixture report" } });
    expect(explicit.status).toBe(200);
    expect(await explicit.json()).toMatchObject({ reportDestination: { topicId: 19 } });
    localTopicsEnabled = false;
    const downgraded = await put({ project: "repo-clone-non-forum", reportTelegram: { link: "https://t.me/c/0000000101/14", name: "Fixture report" } });
    expect(downgraded.status).toBe(200);
    expect(await downgraded.json()).toMatchObject({ notice: "topic_removed", message: expect.stringContaining("without a topic") });
    expect((await (await get("repo-clone-non-forum")).json()).reportTelegram).not.toHaveProperty("topicId");
    localTopicsEnabled = true;
    // Revoke after addChat builds its answer, before the PUT resumes.
    revokeAfterLookup = true;
    const revoked = await put({ project: "repo-clone-revoked", reportTelegram: { link: "https://t.me/c/0000000101/20", name: "Fixture report" } });
    expect(revoked.status).toBe(409);
    expect((await (await get("repo-clone-revoked")).json()).reportDestination).toBeNull();
    service.setChat("-1000000000101", "fixture-reports", true);
    // The same pairing also works with no locally connected bot.
    const { telegramBotTokenPath } = await import("@/lib/telegram/bot/transport");
    fs.unlinkSync(telegramBotTokenPath());
    const tokenless = await put({ project: "repo-clone-tokenless", reportTelegram: { link: "https://t.me/c/0000000101/21", name: "Fixture report" } });
    expect(tokenless.status).toBe(200);
    expect(await tokenless.json()).toMatchObject({ reportDestination: { topicId: 21 } });
    service.setChat("-1000000000101", "fixture-reports", false);
    const blocked = await put({ project: "repo-clone-blocked", reportTelegram: { link: "https://t.me/c/0000000101/22", name: "Fixture report" } });
    expect(blocked.status).toBe(409);
    expect((await (await get("repo-clone-blocked")).json()).reportDestination).toBeNull();
    expect(sends).toHaveLength(1);
  } finally {
    store?.close();
    await service.remove();
    setTelegramBotServiceForTests(null);
    await server.close();
  }
});

test("pipeline stage runtime defaults to local and only an operator can change it", async () => {
  const project = "repo-cloud-runtime";
  expect((await (await get(project)).json()).pipelineStageRuntime).toBe("local");
  for (const pipelineStageRuntime of ["codex-cloud", "local"]) {
    expect((await put({ project, pipelineStageRuntime })).status).toBe(200);
    expect((await (await get(project)).json()).pipelineStageRuntime).toBe(pipelineStageRuntime);
    expect((await (await get(project)).json()).pipelineStageRuntimeSetting).toMatchObject({ runtime: pipelineStageRuntime, changedBy: "operator", changedAt: expect.any(String) });
  }
  for (const pipelineStageRuntime of [null, "other", "constructor", {}, 1]) {
    expect((await put({ project, pipelineStageRuntime, bridgeReports: false })).status).toBe(400);
    expect((await (await get(project)).json()).pipelineStageRuntime).toBe("local");
  }
  const foreign = await PUT(new NextRequest(`${ORIGIN}/api/projects/settings`, {
    method: "PUT", headers: { "content-type": "application/json", origin: "https://example.invalid", host: "127.0.0.1:8899" },
    body: JSON.stringify({ project, pipelineStageRuntime: "codex-cloud" }),
  }));
  expect(foreign.status).toBe(403);
  const { VIEWER_SPAWN_CAPABILITY_HEADER } = await import("@/lib/agent/spawnPolicy");
  setCallerConversationResolverForTests(() => "conversation_cloud_worker");
  try {
    const refused = await PUT(new NextRequest(`${ORIGIN}/api/projects/settings`, {
      method: "PUT", headers: { "content-type": "application/json", origin: ORIGIN, host: "127.0.0.1:8899",
        [VIEWER_SPAWN_CAPABILITY_HEADER]: Buffer.alloc(32, 1).toString("base64url") },
      body: JSON.stringify({ project, pipelineStageRuntime: "codex-cloud", bridgeReports: false }),
    }));
    expect(refused.status).toBe(403);
    expect((await (await get(project)).json()).pipelineStageRuntime).toBe("local");
  } finally { setCallerConversationResolverForTests(null); }
});

test.each(["toString", "constructor", "__proto__"])("runtime settings preserve a project named %s", async project => {
  expect((await (await get(project)).json()).pipelineStageRuntime).toBe("local");
  expect((await put({ project, pipelineStageRuntime: "codex-cloud" })).status).toBe(200);
  expect((await (await get(project)).json()).pipelineStageRuntime).toBe("codex-cloud");
  expect((await put({ project, bridgeReports: false })).status).toBe(200);
  expect((await (await get(project)).json()).pipelineStageRuntime).toBe("codex-cloud");
});

test("a refused runtime persistence reports failure and can be retried", async () => {
  const state = process.env.LLV_STATE_DIR;
  const broken = path.join(SANDBOX, "runtime-write-failure");
  fs.mkdirSync(path.join(broken, "project-settings.json"), { recursive: true });
  process.env.LLV_STATE_DIR = broken;
  try {
    expect((await put({ project: "repo-write-failure", pipelineStageRuntime: "codex-cloud" })).status).toBe(500);
    fs.rmdirSync(path.join(broken, "project-settings.json"));
    expect((await put({ project: "repo-write-failure", pipelineStageRuntime: "codex-cloud" })).status).toBe(200);
    expect(await (await get("repo-write-failure")).json()).toMatchObject({ pipelineStageRuntime: "codex-cloud", pipelineStageRuntimeSetting: { changedBy: "operator" } });
  } finally { process.env.LLV_STATE_DIR = state; }
});

test("cloud environment is off by default, persists, clears, and rejects malformed and cross-origin writes", async () => {
  const project = "repo-cloud-setting";
  expect((await (await get(project)).json()).codexCloudEnvironmentId).toBe("");
  const hostedId = "00000000-0000-0000-0000-000000000000~asenvcfg_fixture";
  expect((await put({ project, codexCloudEnvironmentId: hostedId })).status).toBe(200);
  expect((await (await get(project)).json()).codexCloudEnvironmentId).toBe(hostedId);
  expect((await put({ project, codexCloudEnvironmentId: "  env-fixture  " })).status).toBe(200);
  expect((await (await get(project)).json()).codexCloudEnvironmentId).toBe("env-fixture");
  // Other settings' writers must keep this field when they copy the entry.
  await put({ project, bridgeReports: false });
  expect((await (await get(project)).json()).codexCloudEnvironmentId).toBe("env-fixture");
  const memoryCap = 4 * 2 ** 30;
  expect((await put({ project, agentMemoryMaxBytes: memoryCap })).status).toBe(200);
  expect(await (await get(project)).json()).toMatchObject({ codexCloudEnvironmentId: "env-fixture", agentMemoryMaxBytes: memoryCap });
  for (const value of [null, false, {}, "--option", "foreign/target", "x".repeat(129)]) {
    expect((await put({ project, codexCloudEnvironmentId: value })).status).toBe(400);
    expect((await (await get(project)).json()).codexCloudEnvironmentId).toBe("env-fixture");
  }
  const foreign = await PUT(new NextRequest(`${ORIGIN}/api/projects/settings`, {
    method: "PUT", headers: { "content-type": "application/json", origin: "https://example.invalid", host: "127.0.0.1:8899" },
    body: JSON.stringify({ project, codexCloudEnvironmentId: "foreign" }),
  }));
  expect(foreign.status).toBe(403);
  expect((await (await get(project)).json()).codexCloudEnvironmentId).toBe("env-fixture");
  const { setCallerConversationResolverForTests } = await import("@/lib/agent/operatorAuthority");
  const { VIEWER_SPAWN_CAPABILITY_HEADER } = await import("@/lib/agent/spawnPolicy");
  setCallerConversationResolverForTests(() => "conversation_cloud_worker");
  try {
    const refused = await PUT(new NextRequest(`${ORIGIN}/api/projects/settings`, {
      method: "PUT", headers: { "content-type": "application/json", origin: ORIGIN, host: "127.0.0.1:8899",
        [VIEWER_SPAWN_CAPABILITY_HEADER]: Buffer.alloc(32, 1).toString("base64url") },
      body: JSON.stringify({ project, codexCloudEnvironmentId: "foreign", bridgeReports: true, agentMemoryMaxBytes: null }),
    }));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "operator_only" });
    expect((await (await get(project)).json())).toMatchObject({ codexCloudEnvironmentId: "env-fixture", bridgeReports: { enabled: false }, agentMemoryMaxBytes: memoryCap });
  } finally { setCallerConversationResolverForTests(null); }
  expect((await put({ project, codexCloudEnvironmentId: "" })).status).toBe(200);
  expect(await (await get(project)).json()).toMatchObject({ codexCloudEnvironmentId: "", agentMemoryMaxBytes: memoryCap });
});

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

test("project memory caps validate, persist and reset through the operator route", async () => {
  for (const cap of [0, -1, "8G", 2 ** 40 + 1, {}, false]) {
    expect((await put({ project: "memory-project", agentMemoryMaxBytes: cap })).status).toBe(400);
  }
  expect((await put({ project: "memory-project", agentMemoryMaxBytes: 8 * 2 ** 30 })).status).toBe(200);
  expect((await (await get("memory-project")).json()).agentMemoryMaxBytes).toBe(8 * 2 ** 30);
  expect((await put({ project: "memory-project", agentMemoryMaxBytes: null })).status).toBe(200);
  expect((await (await get("memory-project")).json()).agentMemoryMaxBytes).toBeNull();
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

test("topic links preserve topics only for forums", async () => {
  const { TelegramBotError, setTelegramBotServiceForTests } = await import("@/lib/telegram/bot/service");
  const chats = [
    { chat: "reports", chatId: "-1000000000101", alias: "reports", username: "public_reports", isForum: true, postAllowed: true },
    { chat: "plain", chatId: "-10077", alias: "plain", username: "plain_group", isForum: false, postAllowed: true },
    { chat: "blocked", chatId: "-10088", alias: "blocked", username: "blocked_group", isForum: true, postAllowed: false },
  ];
  setTelegramBotServiceForTests({
    addChat: async (reference: string) => {
      const chat = chats.find((entry) => entry.chatId === reference || `@${entry.username}` === reference);
      if (!chat || !chat.postAllowed) throw new TelegramBotError("chat_unknown", "no such chat");
      return { chat: chat.alias, chatId: chat.chatId, status: { chats } };
    },
    listChats: () => ({ chats }),
  } as never);
  try {
    const privateLink = await put({ project: "repo-topic", reportTelegram: { link: "https://t.me/c/0000000101/51865", name: "Topic" } });
    expect(privateLink.status).toBe(200);
    expect(await privateLink.json()).toMatchObject({ reportTelegram: { chat: "reports", topicId: 51865 }, reportDestination: { chat: "reports", topicId: 51865 } });
    const publicLink = await put({ project: "repo-topic", reportTelegram: { link: "t.me/public_reports/42", name: "Topic" } });
    expect(publicLink.status).toBe(200);
    expect((await publicLink.json()).reportTelegram.topicId).toBe(42);
    const plain = await put({ project: "repo-topic", reportTelegram: { link: "t.me/plain_group/42", name: "Topic" } });
    expect(plain.status).toBe(200);
    const plainBody = await plain.json();
    expect(plainBody.reportTelegram).not.toHaveProperty("topicId");
    expect(plainBody.message).toContain("does not use topics");
    for (const link of ["t.me/unknown_group/42", "t.me/blocked_group/42"]) {
      expect((await put({ project: "repo-topic", reportTelegram: { link, name: "Topic" } })).status).toBe(404);
    }
    expect((await put({ project: "repo-topic", reportTelegram: { chat: "reports", name: "Topic", topicId: 0 } })).status).toBe(400);
    expect((await put({ project: "repo-topic", reportTelegram: { chat: "reports", name: "Topic", topicId: 77 } })).status).toBe(200);
  } finally {
    setTelegramBotServiceForTests(null);
  }
});

test("a pasted topic link discovers a post-only bot's chat, refreshes forum state, and explains a 403", async () => {
  const { TelegramBotService, productionTelegramBotDependencies, setTelegramBotServiceForTests } = await import("@/lib/telegram/bot/service");
  const { FakeBotTransport, fakeBotToken, ok, refused } = await import("@/lib/telegram/bot/fakeTransport");
  const transport = new FakeBotTransport();
  transport.handlers.getWebhookInfo = () => ok({ url: "https://example.invalid/hook" });
  const service = new TelegramBotService({ ...productionTelegramBotDependencies(), transportFor: () => transport, sleep: async () => {} });
  setTelegramBotServiceForTests(service);
  try {
    transport.script("getMe", ok({ id: 4242424, is_bot: true, first_name: "Report Bot" }));
    await service.connect(fakeBotToken());
    const link = "https://t.me/c/9876543210/51865";
    transport.script("getChat", ok({ id: -1009876543210, type: "supergroup", title: "Reports", is_forum: true }));
    transport.script("getChatMember", ok({ status: "member" }));
    const created = await put({ project: "repo-new-topic", reportTelegram: { link, name: "Reports" } });
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ reportTelegram: { chat: "reports", topicId: 51865 }, reportDestination: { chat: "reports", topicId: 51865 } });

    transport.script("getChat", ok({ id: -1009876543212, type: "supergroup", title: "Fresh Reports", username: "fresh_reports", is_forum: false }));
    transport.script("getChatMember", ok({ status: "member" }));
    const byUsername = await put({ project: "repo-new-username", reportTelegram: { chat: "@fresh_reports", name: "Fresh" } });
    expect(byUsername.status).toBe(200);
    expect((await byUsername.json()).reportTelegram.chat).toBe("fresh-reports");

    // Membership checks also read getChat for permissions. Keep each observed
    // forum state stable until the next action, regardless of those reads.
    let isForum = false;
    transport.handlers.getChat = () => ok({ id: -1009876543210, type: "supergroup", title: "Reports", is_forum: isForum });
    transport.handlers.getChatMember = () => ok({ status: "member" });
    await service.addChat("-1009876543210");
    expect(service.listChats().chats.find((chat) => chat.chatId === "-1009876543210")?.isForum).toBe(false);
    isForum = true;
    const refreshed = await put({ project: "repo-new-topic", reportTelegram: { link, name: "Reports" } });
    expect(refreshed.status).toBe(200);
    expect((await refreshed.json()).reportTelegram.topicId).toBe(51865);

    transport.script("getChat", refused(403, "Forbidden"));
    const denied = await put({ project: "repo-denied-topic", reportTelegram: { link: "https://t.me/c/9876543211/51865", name: "Reports" } });
    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({ code: "bot_not_in_chat", message: expect.stringContaining("add it to the chat first") });
  } finally {
    await service.remove();
    setTelegramBotServiceForTests(null);
  }
});

test("real Telegram lookup failures retain their reason and unexpected storage errors are logged", async () => {
  const { spyOn } = await import("bun:test");
  const { TelegramBotService, productionTelegramBotDependencies, setTelegramBotServiceForTests } = await import("@/lib/telegram/bot/service");
  const { FakeBotTransport, fakeBotToken, ok, refused, unreachable } = await import("@/lib/telegram/bot/fakeTransport");
  const { telegramBotTokenPath } = await import("@/lib/telegram/bot/transport");
  const transport = new FakeBotTransport();
  transport.handlers.getMe = () => ok({ id: 4242424, is_bot: true, first_name: "Report bot" });
  transport.handlers.getWebhookInfo = () => ok({ url: "https://example.invalid/hook" });
  const service = new TelegramBotService({ ...productionTelegramBotDependencies(), transportFor: () => transport });
  setTelegramBotServiceForTests(service);
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    await service.connect(fakeBotToken());
    for (const [response, status, code, reason] of [
      [refused(403, "Forbidden"), 409, "bot_not_in_chat", "add it to the chat first"],
      [refused(400, "chat not found"), 404, "chat_unknown", "id or username"],
      [unreachable(), 503, "network_failed", "could not be reached"],
      [unreachable("timed_out"), 503, "timed_out", "did not answer in time"],
      [refused(429, "Too many requests", { retryAfterSeconds: 7 }), 429, "rate_limited", "7 s"],
    ] as const) {
      transport.script("getChat", response);
      const result = await put({ project: "repo-lookup-failure", reportTelegram: { link: "https://t.me/c/0000000202/12", name: "Report" } });
      expect(result.status).toBe(status);
      expect(await result.json()).toMatchObject({ code, message: expect.stringContaining(reason) });
      expect((await (await get("repo-lookup-failure")).json()).reportDestination).toBeNull();
    }
    // Exercise a real untyped exception, rather than replacing addChat.
    const sendingTokens = path.join(path.dirname(telegramBotTokenPath()), "bot-tokens.json");
    fs.writeFileSync(sendingTokens, JSON.stringify({ version: 2, bots: [] }), { mode: 0o600 });
    const unexpected = await put({ project: "repo-storage-failure", reportTelegram: { link: "https://t.me/c/0000000202/12", name: "Report" } });
    expect(unexpected.status).toBe(503);
    expect(await unexpected.json()).toMatchObject({ message: expect.stringContaining("invalid sending bot token file") });
    expect(log).toHaveBeenCalledWith("[project reports] Telegram chat verification failed", "Error: invalid sending bot token file");
    fs.unlinkSync(sendingTokens);
  } finally {
    log.mockRestore();
    await service.remove();
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


test("an agent cannot change a project cap through the operator route", async () => {
  setCallerConversationResolverForTests(() => "conversation_memory_agent");
  try {
    const response = await PUT(new NextRequest(`${ORIGIN}/api/projects/settings`, {
      method: "PUT", headers: { "content-type": "application/json", origin: ORIGIN,
        host: "127.0.0.1:8899", "x-llv-spawn-capability": "a".repeat(43) },
      body: JSON.stringify({ project: "agent-memory-project", agentMemoryMaxBytes: 8 * 2 ** 30 }),
    }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "operator_only", error: expect.stringContaining("operator-only") });
    expect((await (await get("agent-memory-project")).json()).agentMemoryMaxBytes).toBeNull();
  } finally { setCallerConversationResolverForTests(null); }
  expect((await put({ project: "agent-memory-project", agentMemoryMaxBytes: 8 * 2 ** 30 })).status).toBe(200);
});
