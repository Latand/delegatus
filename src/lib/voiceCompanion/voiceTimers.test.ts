import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setLegacyDocumentWriteHookForTests } from "@/lib/state/legacyDocumentStore";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-timers-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
process.env.XDG_CONFIG_HOME = path.join(root, "config");
const { CHANNEL_RETRY_MS, MAX_PENDING_TIMERS, OWED_MS, RECENT_MS, RESCAN_MS, RETAIN_MS, TOAST_FRESH_MS, TRAFFIC_RECHECK_MS, VOICE_HOLD_MS, VoiceTimers, validVoiceTimer, voiceTimerStore, voiceTimersFile } = await import("./voiceTimers");
const { sendVoiceTimerToTelegram } = await import("./voiceTimersServer");
const { clockText, minutesLeftText, namedClockText } = await import("./timerTime");
const { firedSentence } = await import("./timerWords");

type Starter = { operator: true } | { memberId: string };
const OPERATOR: Starter = { operator: true };
const MEMBER: Starter = { memberId: "member_a" };
/** 10:05 in Kyiv. */
const START = Date.UTC(2026, 10, 1, 8, 5);
const MINUTE = 60_000;

afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });
// The store keeps its connection open, so a removed directory would leave the last test's rows readable.
beforeEach(() => { voiceTimerStore.clear(voiceTimersFile()); });

/** A frozen clock and one armed wake, as the production timeout is one. */
function harness(options: { telegramChosen?: boolean; start?: number; zone?: string | null } = {}) {
  const world = { now: options.start ?? START, armed: null as null | { at: number; wake(): void }, liveOwners: new Set<string>(), owns: true, telegramChosen: options.telegramChosen ?? false,
    push: [] as Array<{ id: string; title: string; body: string }>, telegram: [] as Array<{ id: string; text: string }>,
    pushAnswer: "sent" as "sent" | "none" | "failed", telegramAnswer: "sent" as "sent" | "uncertain" | "none" | "failed" };
  const key = (owner: Starter) => "memberId" in owner ? owner.memberId : "operator";
  const timers = new VoiceTimers({
    now: () => world.now,
    schedule(wake, delayMs) {
      const entry = { at: world.now + delayMs, wake };
      world.armed = entry;
      return { cancel() { if (world.armed === entry) world.armed = null; } };
    },
    ownsTraffic: () => world.owns,
    liveCall: owner => world.liveOwners.has(key(owner)),
    isOperator: owner => "operator" in owner,
    telegramChosen: () => world.telegramChosen,
    timeZone: () => options.zone === undefined ? "Europe/Kyiv" : options.zone,
    push: async message => { world.push.push(message); return world.pushAnswer; },
    telegram: async message => { world.telegram.push(message); return world.telegramAnswer; },
  });
  let call = 0;
  return { world, timers,
    set: (minutes: number, label: string | null, extra: Partial<Parameters<typeof timers.set>[0]> = {}) =>
      timers.set({ owner: OPERATOR, sessionId: "session_a", callId: `call_${++call}`, delegationId: `delegation_${call}`, minutes, label, locale: "en", private: false, ...extra }),
    async advance(to: number) {
      await timers.settled();
      while (world.armed && world.armed.at <= to) {
        const { at, wake } = world.armed;
        world.now = Math.max(world.now, at);
        world.armed = null;
        wake();
        await timers.settled();
      }
      world.now = to;
    },
    live(owner: Starter = OPERATOR) { world.liveOwners.add(key(owner)); },
    gone(owner: Starter = OPERATOR) { world.liveOwners.delete(key(owner)); timers.callEnded(owner); },
    /** One poll of a live call: what it hands the voice. */
    poll(owner: Starter = OPERATOR, sessionId = "session_a", accept: (sentence: string) => boolean = () => true) {
      const said: string[] = [];
      timers.speakOwed(owner, sessionId, "en", sentence => { const taken = accept(sentence); if (taken) said.push(sentence); return taken; });
      return said;
    },
  };
}
const stored = () => voiceTimerStore.read(voiceTimersFile());
const row = (id: string) => stored().find(timer => timer.id === id)!;
function idOf(outcome: Awaited<ReturnType<InstanceType<typeof VoiceTimers>["set"]>>): string {
  if (outcome.state === "limit") throw new Error("not set");
  return outcome.timer.id;
}

test("two overlapping timers fire in due order, the shorter first even when it was set second", async () => {
  const h = harness();
  h.timers.start();
  const twenty = idOf(await h.set(20, "oven"));
  const fifteen = idOf(await h.set(15, "tea"));
  await h.timers.settled();
  expect(h.world.armed!.at).toBe(START + RESCAN_MS);
  await h.advance(START + 14 * MINUTE);
  expect(row(fifteen).state).toBe("pending");
  await h.advance(START + 15 * MINUTE);
  expect(row(fifteen)).toMatchObject({ state: "fired", firedAt: START + 15 * MINUTE });
  expect(row(twenty).state).toBe("pending");
  await h.advance(START + 20 * MINUTE);
  expect(row(twenty)).toMatchObject({ state: "fired", firedAt: START + 20 * MINUTE });
  expect(h.world.push.map(message => message.id)).toEqual([fifteen, twenty]);
  expect(h.world.push[0]!.body).toBe("The 15-minute timer «tea», set at 10:05, is up.");
  h.timers.stop();
});

test("the armed wake is the earliest thing owed: a timer due inside the rescan arms exactly its time", async () => {
  const h = harness();
  h.timers.start();
  await h.set(0.5, "soon");
  await h.timers.settled();
  expect(h.world.armed!.at).toBe(START + 30_000);
  h.timers.stop();
});

test("timers due at the same moment fire in creation order, each spoken once on one live call", async () => {
  const h = harness();
  h.timers.start();
  await h.set(5, "first");
  h.world.now += 1;
  await h.set(5 - 1 / 60_000, "second");
  h.world.now -= 1;
  h.live();
  await h.advance(START + 5 * MINUTE + 1);
  expect(h.poll().map(line => line.match(/«(.+)»/)![1])).toEqual(["first", "second"]);
  expect(h.poll()).toEqual([]);
  expect(h.world.push).toEqual([]);
  h.timers.stop();
});

test("cancel works by label: only that timer stops, near words match one, several match none, and a stranger's label is out of reach", async () => {
  const h = harness();
  h.timers.start();
  const tea = idOf(await h.set(15, "Tea"));
  const oven = idOf(await h.set(20, "the oven"));
  const unnamed = idOf(await h.set(25, null));
  const others = idOf(await h.set(30, "tea", { owner: MEMBER }));
  const answer = await h.timers.cancel(OPERATOR, "session_a", "  TEA ");
  expect(answer).toMatchObject({ state: "cancelled", timer: { id: tea } });
  expect(answer.state === "cancelled" && answer.running.map(timer => timer.id)).toEqual([oven, unnamed]);
  expect(row(others).state).toBe("pending");
  await h.advance(START + 16 * MINUTE);
  expect(row(tea)).toMatchObject({ state: "cancelled" });
  expect(h.world.push).toEqual([]);
  expect(await h.timers.cancel(OPERATOR, "session_a", "oven")).toMatchObject({ state: "cancelled", timer: { id: oven } });
  expect(await h.timers.cancel(OPERATOR, "session_a", "tea")).toMatchObject({ state: "not_found", running: [{ id: unnamed }] });
  expect(await h.timers.cancel(OPERATOR, "session_a", unnamed)).toMatchObject({ state: "cancelled", timer: { id: unnamed } });
  h.timers.stop();
});

test("two timers with one label cancel nothing and name both; a handle then cancels the one meant", async () => {
  const h = harness();
  h.timers.start();
  const first = idOf(await h.set(15, "tea"));
  const second = idOf(await h.set(20, "tea"));
  const answer = await h.timers.cancel(OPERATOR, "session_a", "tea");
  expect(answer.state === "ambiguous" && answer.matches.map(timer => timer.id)).toEqual([first, second]);
  expect(row(first).state).toBe("pending");
  expect(row(second).state).toBe("pending");
  expect(await h.timers.cancel(OPERATOR, "session_a", second)).toMatchObject({ state: "cancelled", timer: { id: second } });
  expect(row(first).state).toBe("pending");
  h.timers.stop();
});

test("a timer cancelled in the moment it fires is one or the other, never both", async () => {
  const h = harness();
  h.timers.start();
  const id = idOf(await h.set(5, "tea"));
  await h.advance(START + 5 * MINUTE);
  expect(await h.timers.cancel(OPERATOR, "session_a", "tea")).toMatchObject({ state: "not_found" });
  expect(row(id).state).toBe("fired");
  expect(h.world.push).toHaveLength(1);
  h.timers.stop();
});

test("a cancel that lands while the fire waits on the store wins: nothing fires and nothing is delivered", async () => {
  const h = harness();
  h.timers.start();
  const tea = idOf(await h.set(5, "tea"));
  await h.timers.settled();
  h.world.now = START + 5 * MINUTE;
  let raced = false;
  setLegacyDocumentWriteHookForTests(collection => {
    if (collection !== "voice_timers" || raced) return;
    raced = true;
    voiceTimerStore.patchRows(voiceTimersFile(), 2, tx => { tx.put({ key: tea, value: { ...row(tea), state: "cancelled", settledAt: h.world.now } }); });
  });
  try { await h.advance(START + 5 * MINUTE + RESCAN_MS); }
  finally { setLegacyDocumentWriteHookForTests(null); }
  expect(raced).toBe(true);
  expect(row(tea).state).toBe("cancelled");
  expect(row(tea).firedAt).toBeUndefined();
  expect(h.world.push).toEqual([]);
  h.timers.stop();
});

test("a restart keeps pending timers: a fresh instance over the same store fires each once", async () => {
  const before = harness();
  before.timers.start();
  const tea = idOf(await before.set(15, "tea"));
  const oven = idOf(await before.set(20, "oven"));
  await before.timers.settled();
  before.timers.stop();
  const after = harness({ start: START + 10 * MINUTE });
  after.timers.start();
  await after.timers.settled();
  expect(after.world.armed!.at).toBe(START + 11 * MINUTE);
  await after.advance(START + 15 * MINUTE);
  expect(row(tea).state).toBe("fired");
  expect(row(oven).state).toBe("pending");
  await after.advance(START + 20 * MINUTE);
  expect(after.world.push.map(message => message.id)).toEqual([tea, oven]);
  after.timers.stop();
  const again = harness({ start: START + 21 * MINUTE });
  again.timers.start();
  await again.timers.settled();
  expect(again.world.push).toEqual([]);
  again.timers.stop();
});

test("a timer written by another process survives that process and fires once in this one", async () => {
  const script = path.join(root, "set-timer.ts");
  fs.writeFileSync(script, `const { voiceTimerStore, voiceTimersFile } = await import(${JSON.stringify(path.join(import.meta.dir, "voiceTimers.ts"))});
voiceTimerStore.patchRows(voiceTimersFile(), 1, tx => tx.put({ key: "vt_child", value: { id: "vt_child", owner: { operator: true }, label: "tea", minutes: 15, createdAt: ${START}, dueAt: ${START + 15 * MINUTE}, timeZone: "Europe/Kyiv", locale: "en", private: false, sessionId: "session_a", state: "pending", delivery: {} } }));
process.exit(0);`);
  const child = Bun.spawn([process.execPath, script], { env: { ...process.env, NODE_ENV: "test" }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const code = await child.exited;
  expect({ code, stderr: await new Response(child.stderr).text() }).toEqual({ code: 0, stderr: "" });
  const h = harness();
  h.timers.start();
  await h.advance(START + 15 * MINUTE);
  expect(h.world.push.map(message => message.id)).toEqual(["vt_child"]);
  h.timers.stop();
});

test("a timer due while the Viewer was down fires at boot and says when it was due", async () => {
  const before = harness();
  before.timers.start();
  const tea = idOf(await before.set(15, "tea"));
  await before.timers.settled();
  before.timers.stop();
  const after = harness({ start: START + 40 * MINUTE });
  after.timers.start();
  await after.timers.settled();
  expect(row(tea)).toMatchObject({ state: "fired", firedAt: START + 40 * MINUTE });
  expect(after.world.push[0]!.body).toBe("The 15-minute timer «tea» was due at 10:20 and is up.");
  after.timers.stop();
});

test("a voice entry a restart cut off moves on: the call is gone, so push takes it, and the voice never says it", async () => {
  const before = harness();
  before.timers.start();
  const tea = idOf(await before.set(5, "tea"));
  before.live();
  await before.advance(START + 5 * MINUTE);
  expect(row(tea).delivery.voice?.state).toBe("owed");
  before.timers.stop();
  const after = harness({ start: START + 5 * MINUTE + 1000 });
  after.timers.start();
  await after.timers.settled();
  expect(row(tea).delivery.voice?.state).toBe("withdrawn");
  expect(after.world.push.map(message => message.id)).toEqual([tea]);
  after.live();
  expect(after.poll()).toEqual([]);
  after.timers.stop();
});

test("exactly once per channel: a poll, a tab, a push and a Telegram send each deliver one timer one time", async () => {
  const h = harness({ telegramChosen: true });
  h.timers.start();
  const tea = idOf(await h.set(5, "tea"));
  await h.advance(START + 5 * MINUTE);
  await h.advance(START + 5 * MINUTE + RESCAN_MS);
  expect(h.world.push).toHaveLength(1);
  expect(h.world.telegram).toHaveLength(1);
  const claims = await Promise.all([h.timers.claimToast(OPERATOR, tea, "en"), h.timers.claimToast(OPERATOR, tea, "uk")]);
  expect(claims.filter(claim => claim.claimed)).toHaveLength(1);
  expect(await h.timers.claimToast(OPERATOR, tea, "en")).toEqual({ claimed: false });
  expect(await h.timers.forTab(OPERATOR)).toEqual({ claimable: [], nextInMs: null });
  expect(row(tea).delivery).toMatchObject({ push: { state: "sent", attempts: 1 }, telegram: { state: "sent", attempts: 1 }, toast: {} });
  h.timers.stop();
});

test("a live call says the timer once, with no push, toast or Telegram beside it, and that sticks after a restart", async () => {
  const h = harness({ telegramChosen: true });
  h.timers.start();
  const tea = idOf(await h.set(5, "tea"));
  h.live();
  await h.advance(START + 5 * MINUTE);
  expect(await h.timers.forTab(OPERATOR)).toEqual({ claimable: [], nextInMs: null });
  expect(await h.timers.claimToast(OPERATOR, tea, "en")).toEqual({ claimed: false });
  expect(h.poll()).toEqual(["The 5-minute timer «tea», set at 10:05, is up."]);
  expect(h.poll()).toEqual([]);
  await h.timers.settled();
  expect(row(tea).delivery.voice).toMatchObject({ state: "spoken", sessionId: "session_a" });
  await h.advance(START + 5 * MINUTE + VOICE_HOLD_MS + 1);
  h.gone();
  await h.advance(START + 5 * MINUTE + 2 * VOICE_HOLD_MS);
  expect(h.world.push).toEqual([]);
  expect(h.world.telegram).toEqual([]);
  h.timers.stop();
  const after = harness({ start: START + 5 * MINUTE + 3 * VOICE_HOLD_MS, telegramChosen: true });
  after.timers.start();
  await after.timers.settled();
  expect(after.world.push).toEqual([]);
  after.timers.stop();
});

test("a provider that refuses the words keeps the timer owed for the next poll, in its place", async () => {
  const h = harness();
  h.timers.start();
  await h.set(5, "first");
  await h.set(5.5, "second");
  h.live();
  await h.advance(START + 5.5 * MINUTE);
  expect(h.poll(OPERATOR, "session_a", () => false)).toEqual([]);
  expect(h.poll().map(line => line.match(/«(.+)»/)![1])).toEqual(["first", "second"]);
  h.timers.stop();
});

test("a timer set during a call that dropped fires after it and reaches the next channels; the voice records nothing", async () => {
  const h = harness({ telegramChosen: true });
  h.timers.start();
  h.live();
  const tea = idOf(await h.set(5, "tea"));
  h.gone();
  await h.advance(START + 5 * MINUTE);
  expect(row(tea).delivery.voice).toBeUndefined();
  expect(h.world.push.map(message => message.id)).toEqual([tea]);
  expect(h.world.telegram.map(message => message.id)).toEqual([tea]);
  expect((await h.timers.forTab(OPERATOR)).claimable).toEqual([tea]);
  expect(await h.timers.claimToast(OPERATOR, tea, "en")).toMatchObject({ claimed: true, text: "The 5-minute timer «tea», set at 10:05, is up." });
  h.timers.stop();
});

test("a call that ends before it spoke hands the timer over at once, and a late poll says nothing", async () => {
  const h = harness();
  h.timers.start();
  const tea = idOf(await h.set(5, "tea"));
  h.live();
  await h.advance(START + 5 * MINUTE);
  expect(h.world.push).toEqual([]);
  h.gone();
  await h.timers.settled();
  expect(row(tea).delivery.voice?.state).toBe("withdrawn");
  expect(h.world.push.map(message => message.id)).toEqual([tea]);
  expect(h.poll()).toEqual([]);
  h.timers.stop();
});

test("a call that holds a timer for 60 s gives it up: the next channels take it and that call never says it", async () => {
  const h = harness();
  h.timers.start();
  const tea = idOf(await h.set(5, "tea"));
  h.live();
  await h.advance(START + 5 * MINUTE);
  expect(h.world.armed!.at).toBe(START + 5 * MINUTE + VOICE_HOLD_MS);
  await h.advance(START + 5 * MINUTE + VOICE_HOLD_MS - 1);
  expect(h.world.push).toEqual([]);
  await h.advance(START + 5 * MINUTE + VOICE_HOLD_MS);
  expect(row(tea).delivery.voice?.state).toBe("withdrawn");
  expect(h.world.push.map(message => message.id)).toEqual([tea]);
  expect(h.poll()).toEqual([]);
  h.timers.stop();
});

test("a call that ended while the fire waited on the store gets nothing owed to it", async () => {
  const h = harness();
  h.timers.start();
  const tea = idOf(await h.set(5, "tea"));
  h.live();
  const liveCall = h.world.liveOwners;
  const answers = [true, false];
  const has = liveCall.has.bind(liveCall);
  liveCall.has = (value: string) => answers.shift() ?? has(value);
  await h.advance(START + 5 * MINUTE);
  await h.timers.settled();
  expect(h.poll()).toEqual([]);
  expect(row(tea).delivery.voice?.state).toBe("withdrawn");
  expect(h.world.push.map(message => message.id)).toEqual([tea]);
  h.timers.stop();
});

test("a timer no channel reached stays owed: the next call says it as news, the row records the voice and nothing else repeats", async () => {
  const h = harness();
  h.world.pushAnswer = "none";
  h.timers.start();
  const tea = idOf(await h.set(5, "tea"));
  await h.advance(START + 5 * MINUTE);
  await h.advance(START + 2 * 60 * MINUTE);
  h.live();
  h.timers.callStarted(OPERATOR);
  await h.timers.settled();
  expect(h.poll()).toEqual(["While you were away, the 5-minute timer «tea» came up at 10:10."]);
  await h.timers.settled();
  expect(row(tea).delivery.voice?.state).toBe("spoken");
  h.timers.callStarted(OPERATOR);
  await h.timers.settled();
  expect(h.poll()).toEqual([]);
  h.timers.stop();
});

test("a timer no channel reached is toasted at the next page load, and one a push reached is not toasted hours later", async () => {
  const h = harness();
  h.world.pushAnswer = "none";
  h.timers.start();
  const unreached = idOf(await h.set(5, "tea"));
  await h.advance(START + 5 * MINUTE);
  h.world.pushAnswer = "sent";
  const reached = idOf(await h.set(5, "oven"));
  await h.advance(START + 10 * MINUTE);
  expect((await h.timers.forTab(OPERATOR)).claimable.sort()).toEqual([unreached, reached].sort());
  await h.advance(START + 10 * MINUTE + TOAST_FRESH_MS);
  expect((await h.timers.forTab(OPERATOR)).claimable).toEqual([unreached]);
  expect(await h.timers.claimToast(OPERATOR, reached, "en")).toEqual({ claimed: false });
  expect(await h.timers.claimToast(OPERATOR, unreached, "uk")).toMatchObject({ claimed: true, text: "Поки вас не було, о 10:10 сплив таймер «tea» на 5 хвилин." });
  h.timers.stop();
});

test("past 12 hours an undelivered timer is missed, list still shows it for an hour, and rows retire 24 hours after they settle", async () => {
  const h = harness();
  h.world.pushAnswer = "none";
  h.timers.start();
  const missed = idOf(await h.set(5, "tea"));
  const firedAt = START + 5 * MINUTE;
  await h.advance(firedAt);
  await h.advance(firedAt + OWED_MS - 1);
  expect(row(missed).state).toBe("fired");
  await h.advance(firedAt + OWED_MS + RESCAN_MS);
  expect(row(missed)).toMatchObject({ state: "missed" });
  expect((await h.timers.forTab(OPERATOR)).claimable).toEqual([]);
  expect((await h.timers.list(OPERATOR)).recent.map(timer => timer.id)).toEqual([missed]);
  await h.advance(firedAt + OWED_MS + RESCAN_MS + RECENT_MS);
  expect((await h.timers.list(OPERATOR)).recent).toEqual([]);
  await h.advance(firedAt + OWED_MS + RESCAN_MS + RETAIN_MS);
  expect(stored().map(timer => timer.id)).toEqual([]);
  h.timers.stop();
});

test("a release that does not own traffic fires nothing and asks again; once it owns traffic the timer fires", async () => {
  const h = harness();
  h.world.owns = false;
  h.timers.start();
  await h.timers.settled();
  expect(h.world.armed!.at).toBe(START + TRAFFIC_RECHECK_MS);
  const tea = idOf(await h.set(1, "tea"));
  await h.advance(START + 2 * MINUTE);
  expect(row(tea).state).toBe("pending");
  expect(h.world.push).toEqual([]);
  expect(await h.timers.claimToast(OPERATOR, tea, "en")).toEqual({ claimed: false });
  h.world.owns = true;
  await h.advance(START + 2 * MINUTE + TRAFFIC_RECHECK_MS);
  expect(row(tea).state).toBe("fired");
  expect(h.world.push.map(message => message.id)).toEqual([tea]);
  h.timers.stop();
});

test("a tab whose timeout ran before the server's wake fires the timer and wins the toast", async () => {
  const h = harness();
  h.timers.start();
  const tea = idOf(await h.set(5, "tea"));
  await h.timers.settled();
  expect((await h.timers.forTab(OPERATOR)).nextInMs).toBe(5 * MINUTE);
  h.world.now = START + 5 * MINUTE;
  expect(await h.timers.claimToast(OPERATOR, tea, "en")).toMatchObject({ claimed: true });
  await h.timers.settled();
  expect(row(tea)).toMatchObject({ state: "fired" });
  h.timers.stop();
});

test("a toast claim from another owner is refused, whatever the id", async () => {
  const h = harness();
  h.timers.start();
  const tea = idOf(await h.set(5, "tea"));
  await h.advance(START + 5 * MINUTE);
  expect((await h.timers.forTab(MEMBER)).claimable).toEqual([]);
  expect(await h.timers.claimToast(MEMBER, tea, "en")).toEqual({ claimed: false });
  expect(await h.timers.claimToast(OPERATOR, "vt_absent", "en")).toEqual({ claimed: false });
  expect((await h.timers.forTab(OPERATOR)).claimable).toEqual([tea]);
  h.timers.stop();
});

test("a member's timer uses voice and toast only: push and Telegram belong to the operator's devices", async () => {
  const h = harness({ telegramChosen: true });
  h.timers.start();
  const tea = idOf(await h.set(5, "tea", { owner: MEMBER }));
  await h.advance(START + 5 * MINUTE);
  expect(h.world.push).toEqual([]);
  expect(h.world.telegram).toEqual([]);
  expect(row(tea).delivery).toMatchObject({ push: { state: "none" }, telegram: { state: "none" } });
  expect((await h.timers.forTab(MEMBER)).claimable).toEqual([tea]);
  h.timers.stop();
});

test("Telegram stays off until chosen, and a choice made after a timer fired does not reach back to it", async () => {
  const h = harness();
  h.timers.start();
  const tea = idOf(await h.set(5, "tea"));
  await h.advance(START + 5 * MINUTE);
  expect(row(tea).delivery.telegram?.state).toBe("off");
  h.world.telegramChosen = true;
  await h.advance(START + 5 * MINUTE + RESCAN_MS);
  expect(h.world.telegram).toEqual([]);
  const oven = idOf(await h.set(5, "oven"));
  await h.advance(START + 11 * MINUTE + RESCAN_MS);
  expect(h.world.telegram.map(message => message.id)).toEqual([oven]);
  h.timers.stop();
});

test("a private timer keeps its label in its own call and on screen; push, Telegram and a later call go without it", async () => {
  const h = harness({ telegramChosen: true });
  h.timers.start();
  const secret = idOf(await h.set(5, "reply about the salary", { private: true }));
  await h.advance(START + 5 * MINUTE);
  expect(h.world.push[0]!.body).toBe("The 5-minute timer, set at 10:05, is up.");
  expect(h.world.telegram[0]!.text).toBe("Timer is up. The 5-minute timer, set at 10:05, is up.");
  expect(await h.timers.claimToast(OPERATOR, secret, "en")).toMatchObject({ claimed: true, text: "The 5-minute timer «reply about the salary», set at 10:05, is up." });
  const voiced = harness();
  voiced.timers.start();
  await voiced.set(5, "reply about the salary", { private: true, callId: "own" });
  await voiced.set(5, "reply about the salary", { private: true, callId: "other" });
  voiced.live();
  await voiced.advance(START + 5 * MINUTE);
  expect(voiced.poll(OPERATOR, "session_b")).toEqual(["The 5-minute timer, set at 10:05, is up.", "The 5-minute timer, set at 10:05, is up."]);
  voiced.timers.stop();
  h.timers.stop();
});

test("a private timer's label answers no cancel from another call, while its handle still works", async () => {
  const h = harness();
  h.timers.start();
  const secret = idOf(await h.set(5, "salary", { private: true }));
  expect(await h.timers.cancel(OPERATOR, "session_b", "salary")).toMatchObject({ state: "not_found" });
  expect(row(secret).state).toBe("pending");
  expect(await h.timers.cancel(OPERATOR, "session_b", secret)).toMatchObject({ state: "cancelled" });
  h.timers.stop();
});

test("an owner runs at most 20 timers; one more is refused and another owner is unaffected", async () => {
  const h = harness();
  h.timers.start();
  for (let index = 0; index < MAX_PENDING_TIMERS; index += 1) expect((await h.set(5 + index, `timer ${index}`)).state).toBe("set");
  expect(await h.set(90, "one more")).toMatchObject({ state: "limit", running: { length: MAX_PENDING_TIMERS } });
  expect((await h.set(90, "theirs", { owner: MEMBER })).state).toBe("set");
  expect(stored()).toHaveLength(MAX_PENDING_TIMERS + 1);
  h.timers.stop();
});

test("concurrent sets past the cap still hold it", async () => {
  const h = harness();
  h.timers.start();
  const outcomes = await Promise.all(Array.from({ length: MAX_PENDING_TIMERS + 3 }, (_, index) => h.set(5 + index, null)));
  expect(outcomes.filter(outcome => outcome.state === "limit")).toHaveLength(3);
  h.timers.stop();
});

test("one provider call replayed sets one timer, and a duplicate handoff of one attempt sets one timer", async () => {
  const h = harness();
  h.timers.start();
  const first = await h.set(15, "tea", { callId: "same-call", delegationId: "delegation_a" });
  expect(first.state).toBe("set");
  expect(await h.set(15, "tea", { callId: "same-call", delegationId: "delegation_a" })).toMatchObject({ state: "duplicate", timer: { id: idOf(first) } });
  const one = await h.set(20, null, { callId: "handoff_a", delegationId: "delegation_b", attempt: "attempt_a" });
  expect(await h.set(20, null, { callId: "handoff_b", delegationId: "delegation_c", attempt: "attempt_a" })).toMatchObject({ state: "duplicate", timer: { id: idOf(one) } });
  // One delegation asked twice in one turn: two timers, as the operator said.
  expect((await h.set(20, null, { callId: "handoff_c", delegationId: "delegation_b", attempt: "attempt_a" })).state).toBe("set");
  expect(stored()).toHaveLength(3);
  h.timers.stop();
});

test("a failed push is asked again on its schedule and then left owed; a success stops it", async () => {
  const h = harness();
  h.world.pushAnswer = "failed";
  h.timers.start();
  const tea = idOf(await h.set(5, "tea"));
  const firedAt = START + 5 * MINUTE;
  await h.advance(firedAt);
  expect(row(tea).delivery.push).toMatchObject({ state: "failed", attempts: 1, retryAt: firedAt + CHANNEL_RETRY_MS[0] });
  await h.advance(firedAt + CHANNEL_RETRY_MS[0] - 1);
  expect(h.world.push).toHaveLength(1);
  await h.advance(firedAt + CHANNEL_RETRY_MS[0]);
  expect(h.world.push).toHaveLength(2);
  await h.advance(firedAt + CHANNEL_RETRY_MS[0] + CHANNEL_RETRY_MS[1]);
  expect(h.world.push).toHaveLength(3);
  await h.advance(firedAt + 10 * CHANNEL_RETRY_MS[1]);
  expect(h.world.push).toHaveLength(3);
  expect(row(tea).delivery.push).toMatchObject({ state: "failed", attempts: 3 });
  expect((await h.timers.forTab(OPERATOR)).claimable).toEqual([tea]);
  h.timers.stop();
});

test("a push the restart cut off mid-send is asked again under its key, and a settled one is not", async () => {
  const before = harness();
  before.timers.start();
  const tea = idOf(await before.set(5, "tea"));
  await before.advance(START + 5 * MINUTE);
  before.timers.stop();
  voiceTimerStore.patchRows(voiceTimersFile(), 2, tx => {
    const value = tx.get(tea)!.value as import("./voiceTimers").VoiceTimer;
    tx.put({ key: tea, value: { ...value, delivery: { ...value.delivery, push: { state: "sending", at: START, attempts: 1 } } } });
  });
  const after = harness({ start: START + 6 * MINUTE });
  after.timers.start();
  await after.timers.settled();
  expect(after.world.push.map(message => message.id)).toEqual([tea]);
  expect(row(tea).delivery.push).toMatchObject({ state: "sent", attempts: 2 });
  after.timers.stop();
});

test("every writer's stored row passes the reader", async () => {
  const h = harness({ telegramChosen: true });
  h.timers.start();
  const spoken = idOf(await h.set(5, "spoken"));
  const cancelled = idOf(await h.set(5, "cancelled"));
  await h.timers.cancel(OPERATOR, "session_a", cancelled);
  h.live();
  await h.advance(START + 5 * MINUTE);
  h.poll();
  h.gone();
  const pushed = idOf(await h.set(1, null));
  await h.advance(START + 6 * MINUTE);
  const rows = stored();
  expect(rows.map(timer => timer.id).sort()).toEqual([spoken, cancelled, pushed].sort());
  for (const timer of rows) expect(validVoiceTimer(timer)).toBe(true);
  expect(validVoiceTimer({ id: "vt_bad", owner: null })).toBe(false);
  h.timers.stop();
});

test("an unreadable row is skipped, and the timers beside it still fire", async () => {
  const h = harness();
  h.timers.start();
  const tea = idOf(await h.set(5, "tea"));
  voiceTimerStore.patchRows(voiceTimersFile(), 1, tx => tx.put({ key: "vt_bad", value: { id: "vt_bad" } }));
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try { await h.advance(START + 5 * MINUTE); }
  finally { console.error = original; }
  expect(h.world.push.map(message => message.id)).toEqual([tea]);
  expect(errors.some(line => line.includes("vt_bad"))).toBe(true);
  h.timers.stop();
});

test("times read in the operator's zone with minutes left; an unknown or unusable zone says UTC", () => {
  expect(clockText(START, "Europe/Kyiv")).toBe("10:05");
  expect(namedClockText(START, "Europe/Kyiv")).toBe("10:05 Kyiv time");
  expect(namedClockText(START, "Europe/Kiev")).toBe("10:05 Kyiv time");
  expect(namedClockText(START, "America/New_York")).toBe("03:05 New York time");
  for (const zone of [null, "UTC", "Not/AZone"]) {
    expect(clockText(START, zone)).toBe("08:05 UTC");
    expect(namedClockText(START, zone)).toBe("08:05 UTC");
  }
  expect(minutesLeftText(12 * MINUTE)).toBe("in 12 minutes");
  expect(minutesLeftText(11 * MINUTE + 1)).toBe("in 12 minutes");
  expect(minutesLeftText(MINUTE)).toBe("in 1 minute");
  expect(minutesLeftText(30_000)).toBe("in under a minute");
});

test("the fired sentence names what it can in both languages, with Ukrainian plurals", () => {
  const facts = { label: "чай", minutes: 15, createdAt: START, dueAt: START + 15 * MINUTE, timeZone: "Europe/Kyiv" };
  expect(firedSentence(facts, "uk", "due")).toBe("Таймер «чай» на 15 хвилин, поставлений о 10:05, сплив.");
  expect(firedSentence(facts, "uk", "late")).toBe("Таймер «чай» на 15 хвилин мав спливти о 10:20 і вже сплив.");
  expect(firedSentence({ ...facts, label: null, minutes: 1 }, "uk", "due")).toBe("Таймер на 1 хвилину, поставлений о 10:05, сплив.");
  expect(firedSentence({ ...facts, label: null, minutes: 2 }, "uk", "due")).toBe("Таймер на 2 хвилини, поставлений о 10:05, сплив.");
  expect(firedSentence({ ...facts, label: null, minutes: 0.5 }, "uk", "due")).toBe("Таймер на 30 секунд, поставлений о 10:05, сплив.");
  expect(firedSentence({ ...facts, label: null, minutes: 2.5 }, "uk", "due")).toBe("Таймер на 2,5 хвилини, поставлений о 10:05, сплив.");
  expect(firedSentence({ ...facts, label: null, minutes: 0.5 }, "en", "due")).toBe("The 30-second timer, set at 10:05, is up.");
  expect(firedSentence({ ...facts, timeZone: null }, "en", "away")).toBe("While you were away, the 15-minute timer «чай» came up at 08:20 UTC.");
});

test("Telegram answers map to what the row records, and an uncertain send is never asked to go out again", async () => {
  class Refusal extends Error { constructor(readonly code: string) { super(code); } }
  const errorCode = (error: unknown) => error instanceof Refusal ? error.code : null;
  const message = { id: "vt_a", text: "Timer is up." };
  const sends: unknown[] = [];
  const answering = (result: () => Promise<unknown>) => ({ destination: () => ({ chatId: "1001" }), errorCode, send: (input: unknown) => { sends.push(input); return result(); } });
  expect(await sendVoiceTimerToTelegram(message, answering(async () => ({ messageIds: [1] })))).toBe("sent");
  expect(sends[0]).toEqual({ conversationId: null, clientRequestId: "voice-timer:vt_a", chat: "1001", text: "Timer is up." });
  expect(await sendVoiceTimerToTelegram(message, answering(async () => { throw new Refusal("send_uncertain"); }))).toBe("uncertain");
  expect(await sendVoiceTimerToTelegram(message, answering(async () => { throw new Refusal("chat_not_allowed"); }))).toBe("none");
  expect(await sendVoiceTimerToTelegram(message, answering(async () => { throw new Refusal("network_failed"); }))).toBe("failed");
  expect(await sendVoiceTimerToTelegram(message, answering(async () => { throw new Error("boom"); }))).toBe("failed");
  sends.length = 0;
  expect(await sendVoiceTimerToTelegram(message, { destination: () => ({}), errorCode, send: async input => { sends.push(input); } })).toBe("none");
  expect(sends).toEqual([]);

  const h = harness({ telegramChosen: true });
  h.world.telegramAnswer = "uncertain";
  h.timers.start();
  const tea = idOf(await h.set(5, "tea"));
  await h.advance(START + 5 * MINUTE);
  await h.advance(START + 5 * MINUTE + 5 * RESCAN_MS);
  expect(h.world.telegram).toHaveLength(1);
  expect(row(tea).delivery.telegram).toMatchObject({ state: "uncertain", attempts: 1 });
  h.timers.stop();
});
