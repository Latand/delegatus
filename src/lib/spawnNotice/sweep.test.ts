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
const { spawnNoticeRecipient, transcriptErrorFromRecords } = await import("./production");
type Ports = import("./sweep").SpawnNoticeSweepPorts;
type Request = import("./sweep").SpawnNoticeDeliveryRequest;
type Answer = import("./sweep").SpawnNoticeDeliveryAnswer;

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  if (RESTORE.LLV_STATE_DIR === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = RESTORE.LLV_STATE_DIR;
});

const T0 = Date.parse("2026-09-29T12:00:00.000Z");
const LAUNCHER = "conversation_launcher";
let sequence = 0;
const nextChild = () => `conversation_child_${++sequence}`;

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

test("a settled turn sends one queued notice, attributed to the child, under the turn's hashed key", async () => {
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
    policy: "queue",
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
    final: { text: `${"x".repeat(5_000)}\nVerdict: fail`, error: null },
  });
  const lines = text.split("\n");
  expect(lines[1]).toBe("Verdict: fail");
  expect(lines.at(-1)).toBe(`[… cut: ${5_000 + 14 - 4_096} bytes more — conversation_messages conversationId=conversation_c]`);
});

test("the verdict is the last Verdict line, and absent when none is written", () => {
  expect(detectedVerdict("Verdict: fail\n...\nVerdict: pass")).toBe("pass");
  expect(detectedVerdict("**Verdict:** needs_decision")).toBe("needs_decision");
  expect(detectedVerdict("the verdict: pass is not a line start")).toBeNull();
  expect(detectedVerdict(null)).toBeNull();
});

test("restart replay: a replayed event writes nothing, and a crash between deliver and mark resends under the same key", async () => {
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
  const first = harness([child], { settle: () => { throw new Error("process died before the mark"); } });
  await sweepSpawnNotices(first.ports);
  expect(first.sent).toHaveLength(1);
  expect(store.readSpawnNoticeTurn(child, "turn-replay")?.state).toBe("pending");

  /* The restarted sweep resends the recorded attempt: same key, same text,
     which the delivery layer answers from its record. A newer turn does not
     change what that attempt was. */
  obligation(child, "turn-later", { endedAt: new Date(T0 + 500).toISOString() });
  const second = harness([child], { finalMessage: () => ({ text: "a different, later message", error: null }) });
  await sweepSpawnNotices(second.ports);
  expect(second.sent).toHaveLength(1);
  expect(second.sent[0]!.clientMessageId).toBe(first.sent[0]!.clientMessageId);
  expect(second.sent[0]!.text).toBe(first.sent[0]!.text);
  expect(store.readSpawnNoticeTurn(child, "turn-replay")?.state).toBe("sent");
  expect(store.readSpawnNoticeTurn(child, "turn-later")?.state).toBe("pending");
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

test("coalescing: turns within 30 s fold into one notice, and a busy child holds", async () => {
  const child = nextChild();
  const h = harness([child]);
  obligation(child, "turn-a", { endedAt: new Date(T0).toISOString() });
  await sweepSpawnNotices(h.ports);
  expect(h.sent).toHaveLength(1);

  /* Three more turns end inside the window: nothing goes out until it closes. */
  obligation(child, "turn-b", { endedAt: new Date(T0 + 5_000).toISOString(), outcome: "interrupted" });
  obligation(child, "turn-c", { endedAt: new Date(T0 + 10_000).toISOString() });
  obligation(child, "turn-d", { endedAt: new Date(T0 + 20_000).toISOString() });
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
  expect(h.sent[1]!.text).toContain("Turn completed · ran 12m 24s · 3 turns since the last notice (interrupted among the earlier ones)");
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
