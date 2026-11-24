import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* docs/design/spawn-completion-notice.md §3–§5. The obligation rows are the
   real store in a throw-away state directory; the registry, the runtime host
   and the delivery layer are ports. */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-notify-sweep-"));
const RESTORE = { LLV_STATE_DIR: process.env.LLV_STATE_DIR };
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
fs.mkdirSync(process.env.LLV_STATE_DIR, { recursive: true });

const store = await import("./store");
const {
  composeSpawnNotice, cutUtf8, detectedVerdict, spawnNoticeMessageId, sweepSpawnNotices,
  SPAWN_NOTICE_COALESCE_MS, SPAWN_NOTICE_FINAL_MESSAGE_BYTES, SPAWN_NOTICE_MAX_ATTEMPTS,
} = await import("./sweep");
const { recordSpawnTurnEnded } = await import("@/lib/runtime/serverConsumers");
const { spawnLossRelevant, spawnNoticeFinalMessage, spawnNoticeRecipient, transcriptErrorFromRecords } = await import("./production");
const { setAgentRegistryForTests } = await import("@/lib/agent/registry");
type Ports = import("./sweep").SpawnNoticeSweepPorts;
type Request = import("./sweep").SpawnNoticeDeliveryRequest;
type Answer = import("./sweep").SpawnNoticeDeliveryAnswer;

afterAll(() => {
  setAgentRegistryForTests(null);
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  if (RESTORE.LLV_STATE_DIR === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = RESTORE.LLV_STATE_DIR;
});

const T0 = Date.parse("2026-09-29T12:00:00.000Z");
const LAUNCHER = "conversation_launcher";
const DECISION_REPLY_HINT = "If this worker still owns the assignment, send the decision and next action to the conversation above with send_message. Check its delivery receipt before any replacement.";
const DECISION_VERDICT = "Verdict: needs_decision";
let sequence = 0;
const nextChild = () => `conversation_child_${++sequence}`;

function installCodexTranscript(child: string, entries: readonly Record<string, unknown>[]): string {
  const transcript = path.join(SANDBOX, `${child}.jsonl`);
  fs.writeFileSync(transcript, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  setAgentRegistryForTests({
    conversation: (id: string) => id === child ? ({
      engine: "codex",
      generations: [{ path: transcript, launchProfile: { title: `Reviewer ${child.slice(-1)}`, cwd: "/repo" } }],
    }) : null,
  } as never);
  return transcript;
}

function installClaudeTranscript(child: string, entries: readonly Record<string, unknown>[]): string {
  const transcript = path.join(SANDBOX, `${child}.jsonl`);
  fs.writeFileSync(transcript, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  setAgentRegistryForTests({
    conversation: (id: string) => id === child ? ({
      engine: "claude",
      generations: [{ path: transcript, launchProfile: { title: `Reviewer ${child.slice(-1)}`, cwd: "/repo" } }],
    }) : null,
  } as never);
  return transcript;
}

function obligation(child: string, turnId: string, overrides: Partial<import("./store").SpawnNoticeObligation> = {}) {
  return store.recordSpawnNoticeObligation({
    childConversationId: child,
    turnId,
    launcherConversationId: LAUNCHER,
    outcome: "completed",
    startedAt: new Date(T0 - 724_000).toISOString(),
    endedAt: new Date(T0).toISOString(),
    ...overrides,
  });
}

interface Harness {
  ports: Ports;
  sent: Request[];
  clock: { now: number };
  busy: Set<string>;
  answers: Answer[];
}

/** The production store behind every port that writes; pure fakes behind the
    rest. `pending` is narrowed to this test's children so the tests stay
    independent while sharing one database. */
function harness(children: readonly string[], overrides: Partial<Ports> = {}): Harness {
  const sent: Request[] = [];
  const clock = { now: T0 + 1_000 };
  const busy = new Set<string>();
  const answers: Answer[] = [];
  const mine = new Set(children);
  return {
    sent, clock, busy, answers,
    ports: {
      now: () => clock.now,
      pending: () => store.pendingSpawnNotices().filter((row) => mine.has(row.childConversationId)),
      childRecord: store.readSpawnNoticeChild,
      child: async (child) => ({ title: `Reviewer ${child.slice(-1)}`, busy: busy.has(child) }),
      recipient: (launcher) => ({ kind: "deliver", conversationId: launcher, path: `/sessions/${launcher}.jsonl` }),
      finalMessage: () => ({ text: "Reviewed the diff.\nVerdict: pass", error: null }),
      origin: (child) => ({ kind: "agent", role: "reviewer", conversationId: child }),
      recordAttempt: store.recordSpawnNoticeAttempt,
      settle: store.settleSpawnNotices,
      deliver: async (request) => {
        sent.push(request);
        return answers.shift() ?? { ok: true, operationId: `op_${sent.length}` };
      },
      ...overrides,
    },
  };
}

test("a settled turn sends one steer-first notice, attributed to the child, under the turn's hashed key", async () => {
  const child = nextChild();
  expect(obligation(child, "turn-1")).toBe(true);
  const { ports, sent } = harness([child]);
  await sweepSpawnNotices(ports);

  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    pid: null,
    conversationId: LAUNCHER,
    path: `/sessions/${LAUNCHER}.jsonl`,
    clientMessageId: spawnNoticeMessageId(child, "turn-1"),
    origin: { kind: "agent", role: "reviewer", conversationId: child },
    policy: "steer-or-queue",
    images: [],
  });
  expect(sent[0]!.clientMessageId).toMatch(/^spawn_notice_[a-f0-9]{64}$/);
  const lines = sent[0]!.text.split("\n");
  expect(lines[0]).toBe(`Agent finished: Reviewer ${child.slice(-1)} (${child})`);
  expect(lines[1]).toBe("Verdict: pass");
  expect(lines[2]).toBe("Turn completed · ran 12m 04s");
  expect(lines.slice(3)).toEqual(["Final message:", "Reviewed the diff.", "Verdict: pass"]);
  expect(store.readSpawnNoticeTurn(child, "turn-1")).toMatchObject({ state: "sent", operationId: "op_1", recipientConversationId: LAUNCHER });

  /* Settled: the next pass has nothing to send. */
  await sweepSpawnNotices(ports);
  expect(sent).toHaveLength(1);
});

test.each([
  { format: "plain", verdict: DECISION_VERDICT, recipient: LAUNCHER },
  { format: "bold", verdict: "**Verdict:** needs_decision", recipient: "conversation_successor" },
])("a completed $format decision sends the reply hint once to $recipient", async ({ verdict, recipient }) => {
  const child = nextChild();
  const recipientPath = `/sessions/${recipient}.jsonl`;
  const final = `Which option should I use?\n${verdict}`;
  obligation(child, "turn-decision");
  const { ports, sent } = harness([child], {
    finalMessage: () => ({ text: final, error: null }),
    recipient: (launcher) => spawnNoticeRecipient(launcher, {
      seats: () => ({
        seats: { "project-a": { conversationId: recipient } },
        revocations: recipient === LAUNCHER ? [] : [{ project: "project-a", conversationId: LAUNCHER, revokedAt: new Date(T0).toISOString() }],
      }) as never,
      conversation: (id) => id === recipient ? ({ id, generations: [{ path: recipientPath, launchProfile: { cwd: "/repo" } }] }) as never : null,
      hiddenPaths: () => [],
    }),
  });
  await sweepSpawnNotices(ports);

  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ conversationId: recipient, path: recipientPath });
  expect(sent[0]!.text.split("\n")).toEqual([
    `Agent finished: Reviewer ${child.slice(-1)} (${child})`,
    DECISION_VERDICT,
    DECISION_REPLY_HINT,
    "Turn completed · ran 12m 04s",
    "Final message:",
    ...final.split("\n"),
  ]);
  expect(store.readSpawnNoticeTurn(child, "turn-decision")).toMatchObject({ state: "sent", recipientConversationId: recipient });
});

test.each([
  { outcome: "completed", final: `${DECISION_VERDICT}\nVerdict: pass` },
  { outcome: "completed", final: "Verdict: fail" },
  { outcome: "completed", final: "No verdict was recorded." },
  { outcome: "interrupted", final: DECISION_VERDICT },
  { outcome: "error", final: DECISION_VERDICT },
] as const)("the reply hint is absent for $outcome with final text '$final'", async ({ outcome, final }) => {
  const child = nextChild();
  obligation(child, "turn-no-hint", { outcome });
  const { ports, sent } = harness([child], { finalMessage: () => ({ text: final, error: null }) });
  await sweepSpawnNotices(ports);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.text).not.toContain(DECISION_REPLY_HINT);
});

test("an error or an interrupted turn notifies with its reason", async () => {
  const child = nextChild();
  obligation(child, "turn-err", { outcome: "error", startedAt: new Date(T0 - 40_000).toISOString() });
  const { ports, sent } = harness([child], {
    finalMessage: () => ({ text: null, error: "API Error: 529 overloaded" }),
  });
  await sweepSpawnNotices(ports);
  expect(sent[0]!.text).toContain("Turn ended with an error: API Error: 529 overloaded · ran 40s");
  expect(sent[0]!.text).toContain(`Final message: none recorded — conversation_messages conversationId=${child}`);

  const crashed = nextChild();
  obligation(crashed, "turn-crash", { outcome: "error", startedAt: null });
  const second = harness([crashed], { finalMessage: () => ({ text: "half done", error: null }) });
  await sweepSpawnNotices(second.ports);
  expect(second.sent[0]!.text.split("\n")[1]).toBe("Turn ended with an error: no reason recorded");

  const interrupted = nextChild();
  obligation(interrupted, "turn-int", { outcome: "interrupted" });
  const third = harness([interrupted], { finalMessage: () => ({ text: "stopped", error: null }) });
  await sweepSpawnNotices(third.ports);
  expect(third.sent[0]!.text).toContain("Turn was interrupted: no reason recorded");
});

test("the final message is cut at 4 KB on a character boundary, with the marker", () => {
  const long = "é".repeat(3_000); // 6 000 bytes
  const cut = cutUtf8(long, SPAWN_NOTICE_FINAL_MESSAGE_BYTES);
  expect(Buffer.byteLength(cut.text)).toBe(4_096);
  expect(cut.text).toBe("é".repeat(2_048));
  expect(cut.omittedBytes).toBe(6_000 - 4_096);
  const odd = cutUtf8(`a${"é".repeat(3_000)}`, SPAWN_NOTICE_FINAL_MESSAGE_BYTES);
  expect(Buffer.byteLength(odd.text)).toBe(4_095);
  expect(odd.text.endsWith("�")).toBe(false);

  const text = composeSpawnNotice({
    child: "conversation_c",
    title: "Long reporter",
    turns: [{ kind: "turn", childConversationId: "conversation_c", turnId: "t", launcherConversationId: LAUNCHER, outcome: "completed",
      startedAt: null, endedAt: new Date(T0).toISOString(), state: "pending", reason: null, recipientConversationId: null,
      clientMessageId: null, operationId: null, settledAt: null }],
    final: { text: `${"x".repeat(5_000)}\n${DECISION_VERDICT}`, error: null },
  });
  const lines = text.split("\n");
  expect(lines.slice(1, 3)).toEqual([DECISION_VERDICT, DECISION_REPLY_HINT]);
  expect(lines.at(-2)).toBe("x".repeat(4_096));
  expect(lines.at(-1)).toBe(`[… cut: ${5_000 + 1 + DECISION_VERDICT.length - 4_096} bytes more — conversation_messages conversationId=conversation_c]`);
});

test("the verdict is the last Verdict line, and absent when none is written", () => {
  expect(detectedVerdict("Verdict: fail\n...\nVerdict: pass")).toBe("pass");
  expect(detectedVerdict("**Verdict:** needs_decision")).toBe("needs_decision");
  expect(detectedVerdict("the verdict: pass is not a line start")).toBeNull();
  expect(detectedVerdict(null)).toBeNull();
});

test.each([
  { firstFinal: DECISION_VERDICT, laterFinal: "Verdict: pass", hasHint: true },
  { firstFinal: "Verdict: pass", laterFinal: DECISION_VERDICT, hasHint: false },
])("restart replay preserves stored text and key for '$firstFinal'", async ({ firstFinal, laterFinal, hasHint }) => {
  const child = nextChild();
  /* The runtime host replays an unconsumed `turn-ended` after a restart: the
     consumer runs twice for one turn and the second insert finds its row. */
  const view = { conversationId: child, launcher: { conversationId: LAUNCHER, notify: true }, contained: false } as const;
  const turn = { conversationId: child, turnId: "turn-replay", outcome: "completed" as const, startedAt: null, endedAt: new Date(T0).toISOString() };
  const ports = { child: () => view as never, record: store.recordSpawnNoticeObligation };
  expect(recordSpawnTurnEnded(turn, ports)).toBe(true);
  expect(recordSpawnTurnEnded(turn, ports)).toBe(false);
  expect(store.pendingSpawnNotices().filter((row) => row.childConversationId === child)).toHaveLength(1);

  /* The Viewer dies after the delivery layer accepted the notice and before
     the row was marked: the attempt is still recorded. */
  const first = harness([child], {
    finalMessage: () => ({ text: firstFinal, error: null }),
    settle: () => { throw new Error("process died before the mark"); },
  });
  await sweepSpawnNotices(first.ports);
  expect(first.sent).toHaveLength(1);
  expect(store.readSpawnNoticeTurn(child, "turn-replay")?.state).toBe("pending");
  const attempt = store.readSpawnNoticeChild(child)?.attempt;
  expect(attempt).toMatchObject({ text: first.sent[0]!.text, clientMessageId: spawnNoticeMessageId(child, "turn-replay") });
  expect(attempt!.text.split("\n").filter(line => line === DECISION_REPLY_HINT)).toHaveLength(hasHint ? 1 : 0);

  /* The restarted sweep resends the recorded attempt: same key, same text,
     which the delivery layer answers from its record. A newer turn does not
     change what that attempt was. */
  obligation(child, "turn-later", { endedAt: new Date(T0 + 500).toISOString() });
  const second = harness([child], { finalMessage: () => ({ text: laterFinal, error: null }) });
  await sweepSpawnNotices(second.ports);
  expect(second.sent).toHaveLength(1);
  expect(second.sent[0]).toMatchObject({ clientMessageId: attempt!.clientMessageId, text: attempt!.text });
  expect(store.readSpawnNoticeTurn(child, "turn-replay")?.state).toBe("sent");
  expect(store.readSpawnNoticeTurn(child, "turn-later")?.state).toBe("pending");
});

test.each([
  { newestMessage: null, expectedHints: 0 },
  { newestMessage: `Decision needed.\n${DECISION_VERDICT}`, expectedHints: 1 },
])("a folded Codex notice uses only the newest task_complete verdict ($expectedHints hints)", async ({ newestMessage, expectedHints }) => {
  const child = nextChild();
  installCodexTranscript(child, [
    { type: "event_msg", timestamp: "2026-09-29T11:00:00.000Z", payload: { type: "task_started", turn_id: "turn-a" } },
    { type: "event_msg", timestamp: "2026-09-29T11:01:00.000Z", payload: { type: "task_complete", turn_id: "turn-a", last_agent_message: `Earlier decision.\n${DECISION_VERDICT}` } },
    { type: "event_msg", timestamp: "2026-09-29T11:02:00.000Z", payload: { type: "task_started", turn_id: "turn-b" } },
    { type: "event_msg", timestamp: "2026-09-29T11:03:00.000Z", payload: { type: "task_complete", turn_id: "turn-b", last_agent_message: newestMessage } },
  ]);
  obligation(child, "turn-a", { endedAt: "2026-09-29T11:01:00.000Z" });
  obligation(child, "turn-b", { endedAt: "2026-09-29T11:03:00.000Z" });
  const { ports, sent } = harness([child], {
    finalMessage: (id, turnId) => spawnNoticeFinalMessage(id, text => text, { turnId }),
  });

  await sweepSpawnNotices(ports);

  expect(sent).toHaveLength(1);
  expect(sent[0]!.clientMessageId).toBe(spawnNoticeMessageId(child, "turn-b"));
  expect(sent[0]!.text.split("\n").filter(line => line === DECISION_REPLY_HINT)).toHaveLength(expectedHints);
  expect(sent[0]!.text).toContain(" · 2 turns since the last notice");
});

test.each([
  { bMessage: `B asks.\n${DECISION_VERDICT}`, expectedHints: 1 },
  { bMessage: "B completed with pass.", expectedHints: 0 },
])("a standalone Codex final message stays bound to its task_complete turn ($expectedHints hints)", async ({ bMessage, expectedHints }) => {
  const child = nextChild();
  installCodexTranscript(child, [
    { type: "event_msg", timestamp: "2026-09-29T11:00:00.000Z", payload: { type: "task_started", turn_id: "turn-a" } },
    { type: "event_msg", timestamp: "2026-09-29T11:01:00.000Z", payload: { type: "task_complete", turn_id: "turn-a", last_agent_message: DECISION_VERDICT } },
    { type: "event_msg", timestamp: "2026-09-29T11:02:00.000Z", payload: { type: "task_started", turn_id: "turn-b" } },
    { type: "event_msg", timestamp: "2026-09-29T11:02:30.000Z", payload: { type: "agent_message", message: bMessage } },
    { type: "event_msg", timestamp: "2026-09-29T11:03:00.000Z", payload: { type: "task_complete", turn_id: "turn-b" } },
    { type: "event_msg", timestamp: "2026-09-29T11:04:00.000Z", payload: { type: "task_started", turn_id: "turn-c" } },
    { type: "event_msg", timestamp: "2026-09-29T11:05:00.000Z", payload: { type: "agent_message", message: `Later commentary.\n${DECISION_VERDICT}` } },
    { type: "event_msg", timestamp: "2026-09-29T11:06:00.000Z", payload: { type: "task_complete", turn_id: "turn-c" } },
  ]);
  obligation(child, "turn-b", { endedAt: "2026-09-29T11:03:00.000Z" });
  const { ports, sent } = harness([child], {
    finalMessage: (id, turnId) => spawnNoticeFinalMessage(id, text => text, { turnId }),
  });

  await sweepSpawnNotices(ports);

  expect(sent).toHaveLength(1);
  expect(sent[0]!.text.split("\n").filter(line => line === DECISION_REPLY_HINT)).toHaveLength(expectedHints);
});

test.each([
  { bText: null, expectedHints: 0 },
  { bText: DECISION_VERDICT, expectedHints: 1 },
])("a Claude notice reads only assistant text inside the selected turn ($expectedHints hints)", async ({ bText, expectedHints }) => {
  const child = nextChild();
  installClaudeTranscript(child, [
    { type: "assistant", timestamp: "2026-09-29T11:01:00.000Z", message: { role: "assistant", content: [{ type: "text", text: DECISION_VERDICT }] } },
    { type: "user", timestamp: "2026-09-29T11:02:00.000Z", message: { role: "user", content: "Turn B" } },
    ...(bText ? [{ type: "assistant", timestamp: "2026-09-29T11:02:30.000Z", message: { role: "assistant", content: [{ type: "text", text: bText }] } }] : []),
  ]);
  obligation(child, "turn-b", { startedAt: "2026-09-29T11:02:00.000Z", endedAt: "2026-09-29T11:03:00.000Z" });
  const { ports, sent } = harness([child], {
    finalMessage: (id, turnId, turn) => spawnNoticeFinalMessage(id, text => text, {
      turnId, turnStartedAt: turn?.startedAt, turnEndedAt: turn?.endedAt,
    }),
  });

  await sweepSpawnNotices(ports);

  expect(sent).toHaveLength(1);
  expect(sent[0]!.text.split("\n").filter(line => line === DECISION_REPLY_HINT)).toHaveLength(expectedHints);
});

test.each([
  { caseName: "one MiB plus", finalBytes: 1_048_600 },
  { caseName: "near the 8 MiB record limit", finalBytes: 8 * 1_048_576 - 512 },
])("the production reader finds a verdict in a supported large Codex final ($caseName) while the notice quote stays capped", async ({ finalBytes }) => {
  const child = nextChild();
  const finalText = `${"x".repeat(finalBytes - DECISION_VERDICT.length - 1)}\n${DECISION_VERDICT}`;
  const transcript = installCodexTranscript(child, [
    { type: "event_msg", timestamp: "2026-09-29T11:02:00.000Z", payload: { type: "task_started", turn_id: "turn-large" } },
    { type: "event_msg", timestamp: "2026-09-29T11:03:00.000Z", payload: { type: "task_complete", turn_id: "turn-large", last_agent_message: finalText } },
  ]);
  expect(fs.statSync(transcript).size).toBeGreaterThan(131_072);
  if (finalBytes > 4 * 1_048_576) {
    const finalRecord = fs.readFileSync(transcript, "utf8").split("\n")[1]!;
    expect(Buffer.byteLength(finalRecord)).toBeGreaterThan(4 * 1_048_576);
    expect(Buffer.byteLength(finalRecord)).toBeLessThanOrEqual(8 * 1_048_576);
  }
  obligation(child, "turn-large", { endedAt: "2026-09-29T11:03:00.000Z" });
  const { ports, sent } = harness([child], {
    finalMessage: (id, turnId) => spawnNoticeFinalMessage(id, text => text, { turnId }),
  });

  await sweepSpawnNotices(ports);

  expect(sent).toHaveLength(1);
  expect(sent[0]!.text.split("\n").slice(1, 3)).toEqual([DECISION_VERDICT, DECISION_REPLY_HINT]);
  expect(sent[0]!.text).toContain(`[… cut: ${Buffer.byteLength(finalText) - SPAWN_NOTICE_FINAL_MESSAGE_BYTES} bytes more — conversation_messages conversationId=${child}]`);
  expect(Buffer.byteLength(sent[0]!.text.split("\n").at(-2)!)).toBe(SPAWN_NOTICE_FINAL_MESSAGE_BYTES);
});

test("an uncertain answer retries under the same key and fails only after the bound", async () => {
  const child = nextChild();
  obligation(child, "turn-u");
  const { ports, sent, answers } = harness([child]);
  answers.push({ ok: false, error: "runtime host is unavailable", uncertain: true });
  await sweepSpawnNotices(ports);
  expect(store.readSpawnNoticeTurn(child, "turn-u")?.state).toBe("pending");
  await sweepSpawnNotices(ports);
  expect(sent.map((request) => request.clientMessageId)).toEqual([spawnNoticeMessageId(child, "turn-u"), spawnNoticeMessageId(child, "turn-u")]);
  expect(store.readSpawnNoticeTurn(child, "turn-u")).toMatchObject({ state: "sent" });

  const stuck = nextChild();
  obligation(stuck, "turn-s");
  const always = harness([stuck], { deliver: async () => ({ ok: false, error: "still unavailable", uncertain: true }) });
  for (let pass = 0; pass < SPAWN_NOTICE_MAX_ATTEMPTS; pass += 1) await sweepSpawnNotices(always.ports);
  expect(store.readSpawnNoticeTurn(stuck, "turn-s")).toMatchObject({ state: "failed", reason: "still unavailable" });

  const refused = nextChild();
  obligation(refused, "turn-r");
  const once = harness([refused], { deliver: async () => ({ ok: false, error: "superseded", uncertain: false }) });
  await sweepSpawnNotices(once.ports);
  expect(store.readSpawnNoticeTurn(refused, "turn-r")).toMatchObject({ state: "failed", reason: "superseded" });
});

test("opt-out, no launcher and a contained child owe nothing", () => {
  const turn = { turnId: "turn-x", outcome: "completed" as const, startedAt: null, endedAt: new Date(T0).toISOString() };
  const recorded: string[] = [];
  const record = (row: { childConversationId: string }) => { recorded.push(row.childConversationId); return true; };
  const cases = [
    { conversationId: "conversation_optout", launcher: { conversationId: LAUNCHER, notify: false }, contained: false },
    { conversationId: "conversation_rootless", launcher: null, contained: false },
    { conversationId: "conversation_stage", launcher: { conversationId: LAUNCHER, notify: true }, contained: true },
    { conversationId: "conversation_self", launcher: { conversationId: "conversation_self", notify: true }, contained: false },
  ];
  for (const view of cases) {
    expect(recordSpawnTurnEnded({ ...turn, conversationId: view.conversationId }, { child: () => view as never, record: record as never })).toBe(false);
  }
  expect(recordSpawnTurnEnded({ ...turn, conversationId: "conversation_unknown" }, { child: () => null, record: record as never })).toBe(false);
  expect(recorded).toEqual([]);
});

test("a contained decision turn produces no notice", async () => {
  const child = nextChild();
  const view = { conversationId: child, launcher: { conversationId: LAUNCHER, notify: true }, contained: true } as const;
  const turn = { conversationId: child, turnId: "turn-contained", outcome: "completed" as const, startedAt: null, endedAt: new Date(T0).toISOString() };
  expect(recordSpawnTurnEnded(turn, { child: () => view as never, record: store.recordSpawnNoticeObligation })).toBe(false);
  expect(store.readSpawnNoticeTurn(child, turn.turnId)).toBeNull();
  const { ports, sent } = harness([child], { finalMessage: () => ({ text: DECISION_VERDICT, error: null }) });
  await sweepSpawnNotices(ports);
  expect(sent).toHaveLength(0);
});

test("a gone or archived launcher is skipped with the reason and nothing is delivered", async () => {
  for (const reason of ["launcher-gone", "launcher-closed", "no-seat"] as const) {
    const child = nextChild();
    obligation(child, `turn-${reason}`);
    const { ports, sent } = harness([child], { recipient: () => ({ kind: "skip", reason }) });
    await sweepSpawnNotices(ports);
    expect(sent).toHaveLength(0);
    expect(store.readSpawnNoticeTurn(child, `turn-${reason}`)).toMatchObject({ state: "skipped", reason });
  }
});

test("recipient resolution: retired seat → current seat, no seat, superseded, unknown, archived, and an idle retired host", () => {
  const conversation = (id: string, extra: Record<string, unknown> = {}) => ({
    id, supersededBy: null, projectOwnership: { project: "project-a" },
    generations: [{ path: `/sessions/${id}.jsonl`, launchProfile: { cwd: "/repo", project: "project-a" } }],
    ...extra,
  });
  const seatFile = {
    seats: { "project-a": { conversationId: "conversation_seat_new" } },
    revocations: [
      { project: "project-a", conversationId: "conversation_seat_old", revokedAt: "2026-09-28T00:00:00.000Z" },
      { project: "project-b", conversationId: "conversation_seat_b", revokedAt: "2026-09-28T00:00:00.000Z" },
    ],
  };
  const known: Record<string, ReturnType<typeof conversation>> = {
    conversation_seat_new: conversation("conversation_seat_new"),
    conversation_worker: conversation("conversation_worker"),
    conversation_superseded: conversation("conversation_superseded", { supersededBy: { conversationId: "conversation_next" } }),
    conversation_archived: conversation("conversation_archived"),
  };
  const ports = {
    seats: () => seatFile as never,
    conversation: (id: string) => (known[id] ?? null) as never,
    hiddenPaths: () => ["/sessions/conversation_archived.jsonl"],
  };
  expect(spawnNoticeRecipient("conversation_seat_old", ports)).toEqual({ kind: "deliver", conversationId: "conversation_seat_new", path: "/sessions/conversation_seat_new.jsonl" });
  expect(spawnNoticeRecipient("conversation_seat_b", ports)).toEqual({ kind: "skip", reason: "no-seat" });
  expect(spawnNoticeRecipient("conversation_superseded", ports)).toEqual({ kind: "skip", reason: "launcher-gone" });
  expect(spawnNoticeRecipient("conversation_missing", ports)).toEqual({ kind: "skip", reason: "launcher-gone" });
  expect(spawnNoticeRecipient("conversation_archived", ports)).toEqual({ kind: "skip", reason: "launcher-closed" });
  /* A launcher whose host was retired while idle is an ordinary registry
     conversation: the send resumes it. */
  expect(spawnNoticeRecipient("conversation_worker", ports)).toEqual({ kind: "deliver", conversationId: "conversation_worker", path: "/sessions/conversation_worker.jsonl" });
});

test("no loop: a notice-started turn of a worker notifies only the worker's own launcher, and a root worker sends nothing", async () => {
  /* The seat launched W; W launched R. R's notice starts a turn of W. That
     turn ends; W's launcher (the seat) is told, never R. */
  const registry: Record<string, { launcher: { conversationId: string; notify: boolean } | null }> = {
    conversation_w: { launcher: { conversationId: "conversation_seat", notify: true } },
    conversation_r: { launcher: { conversationId: "conversation_w", notify: true } },
    conversation_seat: { launcher: null },
  };
  const recorded: Array<{ child: string; launcher: string }> = [];
  const ports = {
    child: (id: string) => registry[id] ? { conversationId: id, launcher: registry[id]!.launcher, contained: false } : null,
    record: (row: { childConversationId: string; launcherConversationId: string }) => {
      recorded.push({ child: row.childConversationId, launcher: row.launcherConversationId });
      return true;
    },
  };
  const ended = (conversationId: string) => ({ conversationId, turnId: `${conversationId}-turn`, outcome: "completed" as const, startedAt: null, endedAt: new Date(T0).toISOString() });
  recordSpawnTurnEnded(ended("conversation_r"), ports as never);
  recordSpawnTurnEnded(ended("conversation_w"), ports as never);
  recordSpawnTurnEnded(ended("conversation_seat"), ports as never);
  expect(recorded).toEqual([
    { child: "conversation_r", launcher: "conversation_w" },
    { child: "conversation_w", launcher: "conversation_seat" },
  ]);

  /* A recipient that resolves to the child itself is refused. */
  const child = nextChild();
  obligation(child, "turn-self");
  const { ports: sweepPorts, sent } = harness([child], { recipient: () => ({ kind: "deliver", conversationId: child, path: "/sessions/self.jsonl" }) });
  await sweepSpawnNotices(sweepPorts);
  expect(sent).toHaveLength(0);
  expect(store.readSpawnNoticeTurn(child, "turn-self")).toMatchObject({ state: "skipped", reason: "self" });
});

test.each([
  { outcome: "completed", final: DECISION_VERDICT, hasHint: true },
  { outcome: "completed", final: "Verdict: pass", hasHint: false },
  { outcome: "interrupted", final: DECISION_VERDICT, hasHint: false },
] as const)("coalescing uses the newest turn ($outcome, $final) after the window and busy hold", async ({ outcome, final, hasHint }) => {
  const child = nextChild();
  let finalText: string = DECISION_VERDICT;
  const h = harness([child], { finalMessage: () => ({ text: finalText, error: null }) });
  obligation(child, "turn-a", { endedAt: new Date(T0).toISOString() });
  await sweepSpawnNotices(h.ports);
  expect(h.sent).toHaveLength(1);

  /* Three more turns end inside the window: nothing goes out until it closes. */
  obligation(child, "turn-b", { endedAt: new Date(T0 + 5_000).toISOString(), outcome: "interrupted" });
  obligation(child, "turn-c", { endedAt: new Date(T0 + 10_000).toISOString() });
  obligation(child, "turn-d", { endedAt: new Date(T0 + 20_000).toISOString(), outcome });
  finalText = final;
  h.clock.now = T0 + 1_000 + SPAWN_NOTICE_COALESCE_MS - 1;
  await sweepSpawnNotices(h.ports);
  expect(h.sent).toHaveLength(1);

  /* The window closed but the child is running a turn: that turn will end
     and cover these rows. */
  h.clock.now = T0 + 1_000 + SPAWN_NOTICE_COALESCE_MS;
  h.busy.add(child);
  await sweepSpawnNotices(h.ports);
  expect(h.sent).toHaveLength(1);

  h.busy.delete(child);
  await sweepSpawnNotices(h.ports);
  expect(h.sent).toHaveLength(2);
  expect(h.sent[1]!.clientMessageId).toBe(spawnNoticeMessageId(child, "turn-d"));
  expect(h.sent[1]!.text).toContain(" · ran 12m 24s · 3 turns since the last notice (interrupted among the earlier ones)");
  expect(h.sent[1]!.text.split("\n").filter(line => line === DECISION_REPLY_HINT)).toHaveLength(hasHint ? 1 : 0);
  for (const turnId of ["turn-b", "turn-c", "turn-d"]) {
    expect(store.readSpawnNoticeTurn(child, turnId)).toMatchObject({ state: "sent", clientMessageId: h.sent[1]!.clientMessageId });
  }
});

test("the engine's error text is read from the transcript tail", () => {
  expect(transcriptErrorFromRecords([
    { type: "assistant", message: { content: [{ type: "text", text: "working" }] } },
    { type: "assistant", isApiErrorMessage: true, message: { content: [{ type: "text", text: "API Error: 500" }] } },
  ], "claude")).toBe("API Error: 500");
  expect(transcriptErrorFromRecords([{ type: "system", level: "error", content: "hook failed" }], "claude")).toBe("hook failed");
  expect(transcriptErrorFromRecords([{ payload: { type: "error", message: "stream disconnected" } }], "codex")).toBe("stream disconnected");
  expect(transcriptErrorFromRecords([{ type: "assistant", message: { content: [{ type: "text", text: "fine" }] } }], "claude")).toBeNull();
});

test("Codex transcript tail error belongs to the most recent completed turn", () => {
  const records = [
    { type: "event_msg", payload: { type: "task_started", turn_id: "first" } },
    { type: "event_msg", payload: { type: "turn_aborted", turn_id: "first", reason: "provider interruption" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "second" } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "second", last_agent_message: "Inventory complete. Verdict: pass" } },
  ];
  expect(transcriptErrorFromRecords(records, "codex")).toBeNull();
  expect(transcriptErrorFromRecords(records.slice(0, 2), "codex")).toBe("provider interruption");
});

test("a turn that ends while hot-state writes are fenced is deferred past the quarantine budget and lands once the fence lifts (§2)", async () => {
  const { RuntimeJournal } = await import("@/runtime-host/journal");
  const { RuntimeHost } = await import("@/runtime-host/host");
  const child = nextChild();
  const view = { conversationId: child, launcher: { conversationId: LAUNCHER, notify: true }, contained: false };
  let attempts = 0;
  const ports = {
    taskDeliveryAcknowledged: () => undefined,
    spawnTurnEnded: (turn: Parameters<typeof recordSpawnTurnEnded>[0]) => {
      attempts += 1;
      recordSpawnTurnEnded(turn, { child: () => view as never, record: store.recordSpawnNoticeObligation });
    },
  };
  /* A release target this process holds no revision for: exactly the window
     between the target flipping and the new Viewer activating, in which the
     real store refuses every hot-state write. */
  const releaseTarget = path.join(process.env.LLV_STATE_DIR!, "viewer-release.json");
  fs.writeFileSync(releaseTarget, JSON.stringify({ endpoint: "http://127.0.0.1:1", revision: "a".repeat(40) }));
  const journalFile = path.join(SANDBOX, `journal-${child}.sqlite`);
  let journal = new RuntimeJournal(journalFile);
  try {
    const host = new RuntimeHost(journal, ports, undefined, undefined, undefined, undefined, undefined, 60_000);
    await host.handle({ id: "terminal", method: "append", params: { event: {
      scope: `session:${child}`, kind: "turn-ended", payload: { conversationId: child, turnId: "turn-fenced", outcome: "completed" },
      producer: { kind: "claude-stream-broker", eventKey: "engine-host:claude:terminal:fenced" },
    } } });
    /* Well past the three attempts that used to quarantine it: no recovery
       rejects, and the event stays owed. */
    for (let pass = 0; pass < 4; pass++) expect(await host.recoverConsumers()).toBe(0);
    expect(attempts).toBe(5);
    expect(journal.unconsumedEvents("orchestration")).toHaveLength(1);
    expect(store.readSpawnNoticeTurn(child, "turn-fenced")).toBeNull();
    journal.close();

    /* A runtime host restarted inside the same window: its boot recovery
       resolves instead of rejecting, and its retry timer lands the row the
       moment the fence lifts, with no further call. */
    journal = new RuntimeJournal(journalFile);
    const restarted = new RuntimeHost(journal, ports, undefined, undefined, undefined, undefined, undefined, 10);
    expect(await restarted.recoverConsumers()).toBe(0);
    expect(journal.unconsumedEvents("orchestration")).toHaveLength(1);
    fs.rmSync(releaseTarget);
    for (let wait = 0; wait < 200 && journal.unconsumedEvents("orchestration").length > 0; wait++) await Bun.sleep(10);
    expect(journal.unconsumedEvents("orchestration")).toHaveLength(0);
    expect(store.pendingSpawnNotices().filter((row) => row.childConversationId === child)).toEqual([
      expect.objectContaining({ turnId: "turn-fenced", launcherConversationId: LAUNCHER, state: "pending" }),
    ]);
  } finally {
    fs.rmSync(releaseTarget, { force: true });
    journal.close();
  }
});


test("a lost launch sends its reason and task moves once even with a busy child and no transcript", async () => {
  const child = nextChild();
  obligation(child, "launch:lost-fixture", { outcome: "lost", lost: {
    launchId: "lost-fixture", title: "Restore lost work", reason: "no rollout found for thread id",
    tasks: [{ taskId: "task-loss", from: "assigned", to: "assigned" }],
  } });
  const { ports, sent, busy, answers } = harness([child], {
    finalMessage: () => { throw new Error("a lost launch has no final message to read"); },
    recipient: () => ({ kind: "deliver", conversationId: LAUNCHER, path: `/sessions/${LAUNCHER}.jsonl` }),
  });
  busy.add(child);
  answers.push({ ok: false, error: "delivery unknown", uncertain: true });
  await sweepSpawnNotices(ports);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.text).toContain(`Agent lost before its first turn: Restore lost work (${child})`);
  expect(sent[0]!.text).toContain("Launch lost-fixture failed: no rollout found for thread id");
  expect(sent[0]!.text).toContain("Task task-loss: launch row failed, assigned → assigned");
  expect(sent[0]!.text).toContain("original key replays this failure");
  expect(sent[0]!.text).not.toContain(DECISION_REPLY_HINT);
  expect(sent[0]!.conversationId).toBe(LAUNCHER);
  await sweepSpawnNotices(ports);
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
  await sweepSpawnNotices(ports);
  expect(sent).toHaveLength(2);
});

test.each(["initial", "retry"])("a lost launch never follows a rotated seat on %s delivery", async phase => {
  const child = nextChild();
  obligation(child, "launch:rotated", { outcome: "lost" });
  let rotated = phase === "initial";
  const { ports, sent, answers } = harness([child], { recipient: () => ({ kind: "deliver", conversationId: rotated ? "conversation_successor" : LAUNCHER, path: "/sessions/seat.jsonl" }) });
  if (phase === "retry") {
    answers.push({ ok: false, error: "connection closed", uncertain: true });
    await sweepSpawnNotices(ports);
    rotated = true;
  }
  const before = sent.length;
  await sweepSpawnNotices(ports);
  expect(sent).toHaveLength(before);
  expect(store.readSpawnNoticeTurn(child, "launch:rotated")?.state).toBe("skipped");
});

test("a delayed lost notice records the failure time and offers no relaunch", async () => {
  const child = nextChild();
  obligation(child, "launch:old", { outcome: "lost", endedAt: new Date(T0 - 24 * 60 * 60_000).toISOString() });
  const { ports, sent } = harness([child]);
  const row = store.readSpawnNoticeTurn(child, "launch:old")!;
  const text = composeSpawnNotice({ child, title: "Old work", turns: [row], final: { text: null, error: null } });
  expect(text).toContain(row.endedAt);
  expect(text).not.toContain("Relaunch");
  await sweepSpawnNotices(ports);
  expect(sent).toEqual([]);
  expect(store.readSpawnNoticeTurn(child, "launch:old")?.state).toBe("skipped");
});

test.each(["legacy", "refused", "settled", "deleted", "current"] as const)("delivery rechecks a %s launch against its admitted task", async state => {
  const child = nextChild();
  obligation(child, "launch:recheck", { outcome: "lost", lost: { launchId: "recheck", title: "Check work", reason: "host lost", tasks: [] } });
  const { ports, sent } = harness([child], { lossRelevant: row => spawnLossRelevant(row, {
    receipt: () => ({ rejection: null,
      ...(state === "refused" ? { failureAnnouncementSuppressed: true as const } : {}),
      ...(state === "legacy" ? {} : { failureReporting: { failedAt: row.endedAt, lifecycle: true, notice: true, task: true, taskIds: ["work"] } }) }),
    task: () => state === "deleted" ? null : { status: state === "settled" ? "done" : "inbox" },
  }) });
  await sweepSpawnNotices(ports);
  expect(sent).toHaveLength(state === "current" ? 1 : 0);
  expect(store.readSpawnNoticeTurn(child, "launch:recheck")?.state).toBe(state === "current" ? "sent" : "skipped");
});

test("a queued spawn notice whose seat was revoked is retried for the current seat", async () => {
  const child = nextChild();
  obligation(child, "rotation-turn");
  const h = harness([child], { clearAttempt: store.clearRevokedSpawnNoticeAttempt });
  h.answers.push({ ok: false, error: "queued", uncertain: true });
  await sweepSpawnNotices(h.ports);
  expect(store.readSpawnNoticeChild(child)?.attempt?.recipientConversationId).toBe(LAUNCHER);
  h.ports.revokedAttempt = async () => true;
  h.ports.recipient = () => ({ kind: "deliver", conversationId: "conversation_new_seat", path: "/sessions/new-seat.jsonl" });
  await sweepSpawnNotices(h.ports);
  expect(h.sent.map(row => row.conversationId)).toEqual([LAUNCHER, "conversation_new_seat"]);
  expect(store.readSpawnNoticeTurn(child, "rotation-turn")).toMatchObject({ state: "sent", recipientConversationId: "conversation_new_seat" });
});
