import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs/promises";
import path from "node:path";
import { statePath } from "@/lib/configDir";
import { NextRequest } from "next/server";
import { reviewPOST } from "@/lib/prototypeReview/http";
import { prototypeWorld } from "@/lib/prototypeReview/world";
import { saveTasks, loadTasks } from "@/lib/tasks/store";
import { taskRevision } from "@/lib/tasks/revision";
import { updateRelayStore } from "@/lib/externalRelay/store";
import { destinationRelay } from "@/lib/externalRelay/ownerDestination.fixture";
import { startTestRelay } from "@/lib/externalRelay/testRelay";
import { sampleRequest } from "@/lib/externalRelay/request.fixture";
import { requestSchema } from "@/lib/externalRelay/protocol";
import { runClaimedRequest } from "@/lib/externalRelay/runner";
import { telegramRound, telegramTask } from "@/lib/prototypeReview/telegram.fixture";
import { postPrototypeReviewToTelegram, renderPrototypeTelegram } from "@/lib/prototypeReview/telegramPost";
import { telegramPostSignals } from "@/lib/prototypeReview/telegramPostSignals";
import { prototypeReviewReplica } from "@/lib/prototypeReview/model";
import { isPrototypeReplica } from "@/lib/prototypeReview/replica";
import { readPrototypeReviews } from "@/lib/prototypeReview/read";
import { insertSeatRound, findSeatRound, clearSeatRoundsForTests } from "@/lib/prototypeReview/seatRounds";
import { resetPrototypeDeliveryWorkerForTests, sweepPrototypeDeliveries } from "@/lib/prototypeReview/deliveryWorker";
import { prototypeRoot } from "@/lib/prototypeReview/store";
import type { TelegramPublishReceipt } from "@/lib/externalRelay/publish";
import * as bot from "./service";
import { FakeBotTransport, fakeBotToken, ok, refused, unreachable } from "./fakeTransport";
import { TelegramBotStore } from "./store";
import { reconcileReviewPolls, reviewPollPayload } from "./reviewPolls";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function connected(key = "poll-boundary") {
  const directory = await fs.mkdtemp(path.join(process.env.TMPDIR!, "review-polls-"));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new TelegramBotStore(path.join(directory, "bot.sqlite"));
  const transport = new FakeBotTransport();
  const published: TelegramPublishReceipt[] = [];
  let token: string | null = null;
  const service = new bot.TelegramBotService({ ...bot.productionTelegramBotDependencies(),
    transportFor: () => transport, openStore: () => store, removeStoreFiles: () => {},
    saveToken: value => { token = value; }, removeToken: () => { token = null; },
    withStoredToken: consume => token ? consume(token, "42") : null,
    publishMessage: receipt => { published.push(receipt); },
  });
  cleanups.push(async () => { await service.waitForReviewPolls(); await service.remove(); });
  const factory = spyOn(bot, "telegramBotService").mockReturnValue(service);
  cleanups.push(() => factory.mockRestore());
  transport.script("getMe", ok({ id: 42, is_bot: true, first_name: "Fixture" }));
  await service.connect(fakeBotToken()); await service.stopPoller();
  transport.handlers.getChat = () => ok({ id: 41, type: "private", first_name: "Owner" });
  transport.handlers.sendRichMessage = () => ok({ message_id: 10, date: 1791724800 });
  let messageId = 10;
  transport.handlers.sendPoll = () => ok({ message_id: ++messageId, date: 1791724801 });
  updateRelayStore(s => ({ ...s, relays: [destinationRelay()] }));
  const round = telegramRound(key);
  saveTasks([telegramTask([round])]);
  await fs.mkdir(prototypeRoot(), { recursive: true });
  return { round, service, transport, published };
}
const saved = () => loadTasks()[0]!.prototypeReviews![0]!;

test("form with media posts native polls with stable letters, marks, multiple answers and custom hint; captures Bot API payload", async () => {
  const { round, service, transport } = await connected();
  const taskBefore = loadTasks()[0]!;
  await service.sendOwnerReview({ clientRequestId: round.id, message: renderPrototypeTelegram(round,
    [{ id: "v1f1", variantNumber: 1, caption: "1 · Compact", blob: new Blob(["fixture photo"], { type: "image/png" }) }], "Review layout") });
  await service.waitForReviewPolls();
  const polls = transport.callsOf("sendPoll");
  expect(polls).toHaveLength(3);
  for (const [index, call] of polls.entries()) {
    expect(call.params).toMatchObject({ chat_id: 41, reply_parameters: { message_id: 10 }, type: "regular", is_anonymous: true,
      allows_multiple_answers: index === 1, shuffle_options: false,
      options: round.questions![index]!.options.map((o, j) => ({ text: `${index + 1}${String.fromCharCode(97 + j)}) ${o.label}${o.recommended ? " ✅" : ""}` })) });
    expect(String(call.params.question)).toContain(`${index + 1}. ${round.questions![index]!.text}`);
  }
  expect(polls[2]!.params.question).toContain("Свій варіант — текстовим reply");
  expect(saved().telegramPolls?.questions.map(q => q.state)).toEqual(["sent", "sent", "sent"]);
  const taskAfter = loadTasks()[0]!;
  expect(taskAfter.updatedAt).toBe(taskBefore.updatedAt);
  expect(taskAfter.sync).toEqual(taskBefore.sync);
  expect(taskRevision(taskAfter)).not.toBe(taskRevision(taskBefore));
  const replica = prototypeReviewReplica(taskAfter)!;
  expect(replica.rounds[0]).not.toHaveProperty("telegramPolls");
  expect(isPrototypeReplica(replica, taskAfter.id, taskAfter.project)).toBe(true);
  const capture = transport.calls.filter(call => ["sendRichMessage", "sendPoll"].includes(call.method))
    .map(call => ({ method: call.method, params: Object.fromEntries(Object.entries(call.params).filter(([, value]) => !(value instanceof Blob))) }));
  const bytes = JSON.stringify(capture, null, 2) + "\n";
  if (process.env.LLV_REVIEW_POLLS_OUTPUT) await fs.writeFile(process.env.LLV_REVIEW_POLLS_OUTPUT, bytes);
  else expect(bytes).toBe(await fs.readFile(path.join(import.meta.dir, "fixtures/review-polls.json"), "utf8"));
  await service.sendOwnerReview({ clientRequestId: round.id, message: renderPrototypeTelegram(round, []) });
  await service.waitForReviewPolls();
  expect(transport.callsOf("sendPoll")).toHaveLength(3);
});

test("poll limits preserve ordered options and recommendation after Unicode shortening; unrepresentable questions stay text-only", async () => {
  const { round, service, transport } = await connected("limits");
  round.questions![0]!.text = "🙂".repeat(300);
  round.questions![0]!.options[0]!.label = "🙂".repeat(120);
  round.questions![1]!.options = Array.from({ length: 13 }, (_, i) => ({ label: `Choice ${i}` }));
  saveTasks([telegramTask([round])]);
  await postPrototypeReviewToTelegram(round); await service.waitForReviewPolls();
  const poll = transport.callsOf("sendPoll")[0]!.params;
  expect([...String(poll.question)]).toHaveLength(300);
  const option = (poll.options as Array<{ text: string }>)[0]!.text;
  expect([...option]).toHaveLength(100);
  expect(option).toEndWith("… ✅");
  expect(String(poll.question)).toContain("…");
  const form = (transport.callsOf("sendRichMessage")[0]!.params.rich_message as { markdown: string }).markdown;
  expect(form).toContain(round.questions![0]!.text);
  expect(form).toContain(round.questions![0]!.options[0]!.label);
  expect(form).toContain("Choice 12");
  expect(saved().telegramPolls?.questions[1]).toMatchObject({ state: "text-only", reason: "poll_limits" });
  expect(transport.callsOf("sendPoll")).toHaveLength(2);
  for (const count of [1, 12]) {
    const payload = reviewPollPayload(round, { ...round.questions![0]!, options: Array.from({ length: count }, (_, i) => ({ label: `Choice ${i}` })) }, 0)!;
    expect(payload.options).toHaveLength(count);
  }
});

test("a held or refused poll never delays form publication; failures are durable, reported and replay does not repost", async () => {
  const { round, service, transport } = await connected("failure");
  let release!: () => void, entered!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; });
  transport.handlers.sendPoll = async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); return refused(429, "private provider diagnostic"); };
  const result = await postPrototypeReviewToTelegram(round);
  expect(result?.state).toBe("sent");
  expect(saved().telegramPost?.state).toBe("sent");
  await pending;
  expect(saved().telegramPolls?.questions[0]?.state).toBe("pending");
  transport.handlers.sendPoll = () => unreachable("timed_out");
  release(); await service.waitForReviewPolls();
  expect(saved().telegramPost?.state).toBe("sent");
  expect(saved().telegramPolls?.questions).toMatchObject([{ state: "failed", reason: "rate_limited" }, { state: "uncertain", reason: "send_uncertain" }, { state: "uncertain", reason: "send_uncertain" }]);
  expect(readPrototypeReviews(loadTasks()[0]!).rounds[0]?.telegramPolls).toEqual(saved().telegramPolls!);
  expect(JSON.stringify(saved())).not.toContain("private provider diagnostic");
  expect(telegramPostSignals(round.project, loadTasks(), [])).toMatchObject([{ actionable: true, label: expect.stringContaining("rate_limited") }]);
  await service.sendOwnerReview({ clientRequestId: round.id, message: renderPrototypeTelegram(round, []) });
  await service.waitForReviewPolls();
  expect(transport.callsOf("sendPoll")).toHaveLength(3);
  expect(transport.callsOf("sendRichMessage")).toHaveLength(1);
});

test.each([["form", "1b"], ["poll", "1b"], ["poll", "1b, 2a"], ["poll", "Мій власний варіант."]])("fake Bot API vote does nothing; owner reply to %s (%s) decides through authenticated relay and replay is stable", async (parentKind, reply) => {
  const { round, service, transport, published } = await connected(`reply-${parentKind}`);
  if (reply !== "1b, 2a") round.questions = round.questions!.slice(0, 1);
  saveTasks([telegramTask([round])]);
  await postPrototypeReviewToTelegram(round); await service.waitForReviewPolls();
  const before = JSON.stringify(saved());
  transport.script("getUpdates", ok([{ update_id: 1, poll_answer: { poll_id: "fixture", user: { id: 41 }, option_ids: [1] } },
    { update_id: 2, poll: { id: "fixture", total_voter_count: 1 } }]));
  await service.pollOnce(new AbortController().signal);
  expect(JSON.stringify(saved())).toBe(before);
  const completions: unknown[] = [];
  const server = await startTestRelay((req, body) => { if (req.url?.endsWith("/complete")) completions.push(body); return { body: { status: "ok" } }; });
  cleanups.push(() => server.close());
  const paired = { ...destinationRelay(), api_base: `${server.origin}/v1` };
  updateRelayStore(s => ({ ...s, relays: [paired] }));
  const parent = published[parentKind === "form" ? 0 : 1]!;
  const request = requestSchema.parse({ ...sampleRequest, target_id: "first", answer: { max_chars: 4000, progress: "notes" }, request_id: `poll-answer-${parentKind}-${reply === "1b" ? "single" : reply === "1b, 2a" ? "mixed" : "prose"}`, input: { ...sampleRequest.input,
    requester: { key: "owner", is_owner: true, is_admin: false, is_anonymous_admin: false, can_restrict_members: false, can_delete_messages: false },
    conversation: [{ id: "posted", author: { key: "bot", name: "Clone", self: true }, sent_at: "2026-10-11T13:20:00Z", text: parent.text, reply_to: null },
      { id: "reply", author: { key: "owner", name: "Owner", self: false }, sent_at: "2026-10-11T13:21:00Z", text: reply, reply_to: "posted" }], respond_to: "reply" } });
  const result = await runClaimedRequest(paired, request, undefined, { command: "/missing-fixture-agent" });
  expect(result).toMatchObject({ outcome: "answered", answer: { text: expect.stringContaining("✅ Записав рішення") } });
  expect(saved().decision?.originalReply).toBe(reply);
  if (reply.startsWith("1b")) expect(saved().decision?.answers?.[0]).toMatchObject({ questionId: "place", options: [1] });
  if (reply === "1b, 2a") expect(saved().decision?.answers?.[1]).toMatchObject({ questionId: "scope", options: [0] });
  if (reply === "Мій власний варіант.") expect(saved().decision?.comment).toBe(reply);
  const settled = JSON.stringify(saved());
  await runClaimedRequest(paired, request, undefined, { command: "/missing-fixture-agent" });
  expect(JSON.stringify(saved())).toBe(settled);
  expect(completions).toHaveLength(1);
  expect(transport.callsOf("stopPoll")).toHaveLength(0);
});

test.each(["b", "1b, 2", "1b, 2m"])("ambiguous owner reply %s asks back once across request replay and keeps the round open", async reply => {
  const { round, service, published } = await connected("ambiguous");
  await postPrototypeReviewToTelegram(round); await service.waitForReviewPolls();
  const completions: unknown[] = [];
  const server = await startTestRelay((req, body) => { if (req.url?.endsWith("/complete")) completions.push(body); return { body: { status: "ok" } }; });
  cleanups.push(() => server.close());
  const paired = { ...destinationRelay(), api_base: `${server.origin}/v1` };
  updateRelayStore(s => ({ ...s, relays: [paired] }));
  const request = requestSchema.parse({ ...sampleRequest, target_id: "first", answer: { max_chars: 4000, progress: "notes" }, request_id: `ambiguous-poll-answer-${reply.replace(/\W/g, "")}`, input: { ...sampleRequest.input,
    requester: { key: "owner", is_owner: true, is_admin: false, is_anonymous_admin: false, can_restrict_members: false, can_delete_messages: false },
    conversation: [{ id: "poll", author: { key: "bot", name: "Clone", self: true }, sent_at: "2026-10-11T13:20:00Z", text: published[1]!.text, reply_to: null },
      { id: "reply", author: { key: "owner", name: "Owner", self: false }, sent_at: "2026-10-11T13:21:00Z", text: reply, reply_to: "poll" }], respond_to: "reply" } });
  for (let n = 0; n < 2; n++) expect(await runClaimedRequest(paired, request, undefined, { command: "/missing-fixture-agent" }))
    .toMatchObject({ outcome: "answered", answer: { text: expect.stringContaining("Уточніть відповідь") } });
  expect(completions).toHaveLength(1);
  expect(saved().decision).toBeUndefined();
});

test.each([["task", "open"], ["task", "completed"], ["seat", "open"], ["seat", "completed"]] as const)("upgrade sweep preserves historical %s forms (%s) without poll-failure alerts", async (kind, status) => {
  const { round, service, transport } = await connected(`historical-${kind}-${status}`);
  await resetPrototypeDeliveryWorkerForTests();
  cleanups.push(resetPrototypeDeliveryWorkerForTests);
  cleanups.push(clearSeatRoundsForTests);
  round.taskId = kind === "seat" ? null : round.taskId;
  round.telegramPost = { key: round.id, state: "sent", at: round.createdAt };
  if (status === "completed") round.decision = { chosen: [], comment: "Recorded answer", at: round.createdAt,
    delivery: { state: "sent", clientMessageId: "historical-decision", conversationId: null, text: "Recorded answer" } };
  if (kind === "seat") { saveTasks([]); insertSeatRound(round); }
  else saveTasks([telegramTask([round])]);
  const read = () => kind === "seat" ? findSeatRound(round.id)! : saved();
  const before = JSON.stringify(read());
  for (let attempt = 0; attempt < 2; attempt++) {
    await sweepPrototypeDeliveries(undefined, { force: true, rescan: true });
    expect(JSON.stringify(read())).toBe(before);
    expect(telegramPostSignals(round.project, kind === "seat" ? [] : loadTasks(), kind === "seat" ? [read()] : [])).toEqual([]);
  }
  await service.waitForReviewPolls();
  expect(transport.callsOf("sendPoll")).toHaveLength(0);
  expect(transport.callsOf("sendRichMessage")).toHaveLength(0);
});

test.each(["task", "seat"])("restart sweep reconciles %s polls independently of a sent form without sending duplicates", async kind => {
  const { round, service, transport } = await connected(`restart-${kind}`);
  await resetPrototypeDeliveryWorkerForTests();
  cleanups.push(resetPrototypeDeliveryWorkerForTests);
  cleanups.push(clearSeatRoundsForTests);
  round.taskId = kind === "seat" ? null : round.taskId;
  round.telegramPost = { key: round.id, state: "sent", at: round.createdAt };
  round.telegramPolls = { key: round.id, questions: [
    { questionId: "place", state: "sent", messageId: 11 }, { questionId: "scope", state: "pending" },
  ] };
  if (kind === "seat") { saveTasks([]); insertSeatRound(round); }
  else saveTasks([telegramTask([round])]);
  const read = () => kind === "seat" ? findSeatRound(round.id)! : saved();
  await sweepPrototypeDeliveries(undefined, { force: true, rescan: true });
  await postPrototypeReviewToTelegram(round);
  await service.waitForReviewPolls();
  expect(read().telegramPost).toEqual(round.telegramPost);
  expect(read().telegramPolls?.questions).toEqual([
    { questionId: "place", state: "sent", messageId: 11 },
    { questionId: "scope", state: "uncertain", reason: "interrupted" },
    { questionId: "timing", state: "failed", reason: "interrupted_before_send" },
  ]);
  expect(telegramPostSignals(round.project, kind === "seat" ? [] : loadTasks(), kind === "seat" ? [read()] : []))
    .toMatchObject([{ id: expect.stringContaining("prototype-telegram-polls:"), label: expect.stringContaining("interrupted") }]);
  const settled = JSON.stringify(read());
  await sweepPrototypeDeliveries(undefined, { force: true, rescan: true });
  expect(JSON.stringify(read())).toBe(settled);
  expect(transport.callsOf("sendPoll")).toHaveLength(0);
  expect(transport.callsOf("sendRichMessage")).toHaveLength(0);
});

test("recovery accounts for jobs lost before the first claim in batches of sixteen", async () => {
  const { service, transport } = await connected("lost-jobs");
  await resetPrototypeDeliveryWorkerForTests();
  cleanups.push(resetPrototypeDeliveryWorkerForTests);
  const rounds = Array.from({ length: 17 }, (_, i) => {
    const round = telegramRound(`lost-job-${i}`);
    round.telegramPost = { key: round.id, state: "sent", at: round.createdAt };
    round.telegramPolls = { key: round.id, questions: [] };
    return round;
  });
  saveTasks([telegramTask(rounds)]);
  await sweepPrototypeDeliveries(undefined, { force: true, rescan: true });
  const first = loadTasks()[0]!.prototypeReviews!;
  expect(first.filter(round => round.telegramPolls?.questions.length === 3)).toHaveLength(16);
  expect(first[16]!.telegramPolls).toEqual({ key: rounds[16]!.id, questions: [] });
  expect(first[0]!.telegramPolls?.questions.map(q => q.reason)).toEqual(Array(3).fill("interrupted_before_send"));
  await sweepPrototypeDeliveries(undefined, { force: true, rescan: true });
  expect(loadTasks()[0]!.prototypeReviews!.every(round => round.telegramPolls?.questions.length === 3)).toBe(true);
  await service.waitForReviewPolls();
  expect(transport.callsOf("sendPoll")).toHaveLength(0);
});

test("recovery waits for the active sender and preserves its confirmed outcomes", async () => {
  const { round, service, transport } = await connected("active-recovery");
  let entered!: () => void, release!: () => void;
  const sending = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  cleanups.push(release);
  let messageId = 10;
  transport.handlers.sendPoll = async () => { entered(); await held; return ok({ message_id: ++messageId, date: 1791724801 }); };
  await postPrototypeReviewToTelegram(round);
  await sending;
  let settled = false;
  const recovery = reconcileReviewPolls(round).then(() => { settled = true; });
  try {
    await Bun.sleep(30);
    expect(settled).toBe(false);
    expect(saved().telegramPolls?.questions).toEqual([{ questionId: "place", state: "pending" }]);
  } finally { release(); await recovery; await service.waitForReviewPolls(); }
  expect(saved().telegramPolls?.questions.map(q => q.state)).toEqual(["sent", "sent", "sent"]);
  expect(transport.callsOf("sendPoll")).toHaveLength(3);
});

test("the sweep leaves live queued poll jobs with their current owner", async () => {
  const { round, service, transport } = await connected("queue-owner");
  let entered!: () => void, release!: () => void;
  const sending = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  cleanups.push(release);
  cleanups.push(resetPrototypeDeliveryWorkerForTests);
  let messageId = 10;
  transport.handlers.sendPoll = async () => { entered(); await held; return ok({ message_id: ++messageId, date: 1791724801 }); };
  await postPrototypeReviewToTelegram(round);
  await sending;
  const queued = telegramRound("queued-polls");
  saveTasks([telegramTask([saved(), queued])]);
  await postPrototypeReviewToTelegram(queued);
  const read = () => loadTasks()[0]!.prototypeReviews!.find(r => r.id === queued.id)!;
  const recovery = sweepPrototypeDeliveries(undefined, { force: true, rescan: true });
  try {
    await Bun.sleep(30);
    expect(read().telegramPolls).toEqual({ key: queued.id, questions: [] });
  } finally { release(); await recovery; await service.waitForReviewPolls(); }
  expect(read().telegramPolls?.questions.map(q => q.state)).toEqual(["sent", "sent", "sent"]);
  expect(transport.callsOf("sendPoll")).toHaveLength(6);
});

test.each(["task", "seat"])("%s poll scheduling yields to a peer state lock while form publication returns", async kind => {
  const { round, service, transport } = await connected(`schedule-contention-${kind}`);
  if (kind === "seat") {
    round.taskId = null;
    saveTasks([]); insertSeatRound(round);
    cleanups.push(clearSeatRoundsForTests);
  }
  const read = () => kind === "seat" ? findSeatRound(round.id)! : saved();
  const peer = new Database(statePath("state.sqlite"));
  peer.exec("PRAGMA busy_timeout = 0");
  peer.exec("BEGIN IMMEDIATE");
  let locked = true, ticks = 0;
  const release = () => { if (locked) { peer.exec("ROLLBACK"); locked = false; } };
  const timer = setInterval(() => { ticks++; }, 2);
  const deadline = setTimeout(release, 2000);
  try {
    const result = await service.sendOwnerReview({ clientRequestId: round.id, message: renderPrototypeTelegram(round, []) });
    expect(result?.messageIds).toEqual([10]);
    expect(locked).toBe(true);
    await Bun.sleep(30);
    expect(ticks).toBeGreaterThan(2);
    expect(read().telegramPolls).toBeUndefined();
    expect(transport.callsOf("sendPoll")).toHaveLength(0);
    release();
    await service.waitForReviewPolls();
    expect(read().telegramPolls?.questions.map(q => q.state)).toEqual(["sent", "sent", "sent"]);
  } finally { clearTimeout(deadline); clearInterval(timer); release(); peer.close(); }
});

test.each([["task", "send"], ["seat", "send"], ["task", "recover"], ["seat", "recover"]])("%s round poll %s yields under a peer SQLite write lock", async (kind, action) => {
  const { round, service } = await connected(`contention-${kind}`);
  const held = kind === "seat" ? { ...round, taskId: null } : round;
  if (action === "recover") {
    held.telegramPost = { key: held.id, state: "sent", at: held.createdAt };
    held.telegramPolls = { key: held.id, questions: [{ questionId: "place", state: "pending" }] };
    if (kind === "task") saveTasks([telegramTask([held])]);
  }
  if (kind === "seat") insertSeatRound(held);
  if (kind === "seat") cleanups.push(clearSeatRoundsForTests);
  const peer = new Database(statePath("state.sqlite"));
  peer.exec("PRAGMA busy_timeout = 0");
  peer.exec("BEGIN IMMEDIATE");
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 2);
  const release = setTimeout(() => { peer.exec("ROLLBACK"); }, 80);
  try {
    if (action === "recover") await reconcileReviewPolls(held);
    else await service.sendOwnerReview({ clientRequestId: held.id, message: renderPrototypeTelegram(held, []) });
    await service.waitForReviewPolls();
    expect(ticks).toBeGreaterThan(2);
    expect((kind === "seat" ? findSeatRound(held.id) : saved())?.telegramPolls?.questions.map(q => q.state))
      .toEqual(action === "recover" ? ["uncertain", "failed", "failed"] : ["sent", "sent", "sent"]);
  } finally { clearInterval(timer); clearTimeout(release); peer.close(); }
});

test("a board answer leaves existing polls and their votes unchanged", async () => {
  const { round, service, transport } = await connected("board-answer");
  await postPrototypeReviewToTelegram(round); await service.waitForReviewPolls();
  const polls = structuredClone(saved().telegramPolls);
  const response = await reviewPOST(new NextRequest("http://localhost/api/tasks/task-prototype/prototypes", {
    method: "POST", headers: { host: "localhost", "sec-fetch-site": "same-origin" },
    body: JSON.stringify({ reviewId: round.id, chosen: [], skip: true, comment: "" }),
  }), round.taskId!, { ...prototypeWorld, caller: () => ({ conversationId: null, project: null }), orchestrator: () => null });
  expect(response.status).toBe(200);
  expect(saved().decision?.skipped).toBe(true);
  expect(saved().telegramPolls).toEqual(polls);
  expect(transport.callsOf("stopPoll")).toHaveLength(0);
  const decision = structuredClone(saved().decision);
  transport.script("getUpdates", ok([{ update_id: 9, poll_answer: { poll_id: "fixture", user: { id: 41 }, option_ids: [1] } }]));
  await service.pollOnce(new AbortController().signal);
  expect(saved().decision).toEqual(decision);
});

test("interrupted poll claims stay uncertain and a changed pairing prevents queued sends", async () => {
  const { round, service, transport } = await connected("interrupted");
  round.telegramPolls = { key: round.id, questions: [{ questionId: "place", state: "pending" }] };
  saveTasks([telegramTask([round])]);
  await service.sendOwnerReview({ clientRequestId: round.id, message: renderPrototypeTelegram(round, []) });
  updateRelayStore(s => ({ ...s, relays: [] }));
  await service.waitForReviewPolls();
  expect(transport.callsOf("sendPoll")).toHaveLength(0);
  expect(saved().telegramPolls?.questions).toMatchObject([
    { questionId: "place", state: "uncertain", reason: "interrupted" },
    { questionId: "scope", state: "uncertain" }, { questionId: "timing", state: "uncertain" },
  ]);
});
