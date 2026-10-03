import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { createFeedSession, feedJoinStats, type FeedSession, type FeedSnapshot } from "./parse";

/*
 * Older history prepended to a window the session already parsed. The page and
 * a seam are parsed, the rows before the first clean point are replaced, and
 * every later row keeps its object. The result has to be the snapshot a parse
 * of the whole window gives: same rows, keys, anchors and hidden-service count.
 * Every id, path and body below is invented.
 */

type Fmt = "claude" | "codex" | "openclaw" | "copilot";

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const T0 = Date.parse("2026-09-01T10:00:00.000Z");
let tick = 0;
const at = () => new Date(T0 + (tick += 1500)).toISOString();

const user = (text: string) => JSON.stringify({ type: "user", timestamp: at(), message: { content: text } });
const assistant = (id: string, content: unknown[], stop: string | null, output = 40) =>
  JSON.stringify({
    type: "assistant",
    timestamp: at(),
    requestId: id,
    message: { id, role: "assistant", stop_reason: stop, usage: { input_tokens: 100, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0, output_tokens: output }, content },
  });
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });
const result = (id: string, text: string, isError = false) =>
  JSON.stringify({ type: "user", timestamp: at(), message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }], is_error: isError }] } });
const attachment = (kind: string) => JSON.stringify({ type: "attachment", timestamp: at(), attachment: { type: kind } });

/** A Claude conversation of `turns` turns with the shapes that reach across
    lines: parallel calls answered out of order, a call nobody answers, outgoing
    teammate messages, wakeups, a compaction with its summary, results whose
    call lies before the window, and an interrupted turn. */
function claudeTranscript(seed: number, turns: number): string[] {
  const next = rng(seed);
  const lines: string[] = [result("toolu_before_window", "output of a call before the first line")];
  let call = 0;
  const id = () => `toolu_${seed}_${call++}`;
  for (let turn = 0; turn < turns; turn += 1) {
    lines.push(user(`turn ${turn} request`));
    const rounds = 1 + Math.floor(next() * 4);
    for (let round = 0; round < rounds; round += 1) {
      const kind = next();
      const message = `m${turn}-${round}`;
      if (kind < 0.35) {
        const a = id();
        const b = id();
        lines.push(assistant(message, [{ type: "thinking", thinking: `think ${turn}.${round}` }, toolUse(a, "Bash", { command: `echo ${a}` }), toolUse(b, "Read", { file_path: `/work/${b}.ts` })], "tool_use"));
        lines.push(result(b, `file ${b}`));
        if (next() < 0.5) lines.push(attachment("todo_reminder"));
        lines.push(result(a, `ran ${a}`, next() < 0.2));
      } else if (kind < 0.5) {
        const a = id();
        lines.push(assistant(message, [toolUse(a, "SendMessage", { to: "peer", summary: "ping", message: `hello ${a}` })], "tool_use"));
        lines.push(result(a, JSON.stringify({ success: true, msg_id: `msg-${a}` })));
      } else if (kind < 0.62) {
        const a = id();
        lines.push(assistant(message, [toolUse(a, "ScheduleWakeup", { delaySeconds: 60 + turn, reason: "poll", prompt: "continue" })], "tool_use"));
        lines.push(result(a, JSON.stringify({ scheduledFor: new Date(T0 + 60_000 * (turn + 1)).toISOString() })));
      } else if (kind < 0.7) {
        lines.push(assistant(message, [toolUse(id(), "Bash", { command: "sleep 900" })], "tool_use"));
      } else {
        const a = id();
        lines.push(assistant(message, [{ type: "text", text: `working on ${turn}.${round}` }, toolUse(a, "Edit", { file_path: `/work/${a}.ts`, old_string: "a", new_string: "b" })], "tool_use"));
        lines.push(result(a, "edited"));
      }
    }
    if (turn % 5 === 2) {
      lines.push(JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: at(), compactMetadata: { trigger: "auto", preTokens: 90_000 } }));
      lines.push(attachment("plan_mode"));
      lines.push(JSON.stringify({ type: "user", isCompactSummary: true, timestamp: at(), message: { content: `summary of turns before ${turn}` } }));
    }
    if (turn % 7 === 3) {
      lines.push(user("[Request interrupted by user]"));
    } else {
      lines.push(assistant(`end${turn}`, [{ type: "text", text: `done with turn ${turn}` }], "end_turn", 60));
    }
  }
  return lines;
}

function fixture(name: string): string[] {
  return readFileSync(path.join(import.meta.dir, "fixtures", name), "utf8").trim().split("\n");
}

const record = (type: string, data: Record<string, unknown>) => JSON.stringify({ type, data, id: `id-${tick}`, timestamp: at(), parentId: null });
function copilotTranscript(turns: number): string[] {
  const lines: string[] = [record("session.start", { sessionId: "s", version: 1, producer: "copilot-agent", startTime: at(), selectedModel: "m", context: { cwd: "/srv/repo" } })];
  for (let turn = 0; turn < turns; turn += 1) {
    lines.push(record("user.message", { content: `ask ${turn}`, messageId: `u${turn}`, interactionId: "i", turnId: String(turn), delivery: "idle" }));
    lines.push(record("assistant.turn_start", { turnId: String(turn) }));
    lines.push(record("assistant.message", { messageId: `a${turn}`, content: "", toolRequests: [{ toolCallId: `c${turn}`, name: "bash", arguments: { command: `echo ${turn}` }, type: "function" }], turnId: String(turn) }));
    lines.push(record("tool.execution_start", { toolCallId: `c${turn}`, toolName: "bash", arguments: { command: `echo ${turn}` }, turnId: String(turn) }));
    lines.push(record("tool.execution_complete", { toolCallId: `c${turn}`, success: true, shellExecution: { exitCode: 0 }, result: { content: `out ${turn}` } }));
    lines.push(record("assistant.turn_end", { turnId: String(turn) }));
  }
  return lines;
}

function openclawTranscript(turns: number): string[] {
  const message = (id: string, body: Record<string, unknown>) => JSON.stringify({ type: "message", id, parentId: "p", timestamp: at(), message: body });
  const lines: string[] = [JSON.stringify({ type: "session", version: 3, id: "h", timestamp: at(), cwd: "/oc" })];
  for (let turn = 0; turn < turns; turn += 1) {
    lines.push(message(`u${turn}`, { role: "user", content: `ask ${turn}` }));
    lines.push(message(`a${turn}`, { role: "assistant", provider: "p", model: turn > 3 ? "m2" : "m1", stopReason: "toolUse", content: [{ type: "text", text: `on it ${turn}` }, { type: "toolCall", id: `c${turn}`, name: "Bash", arguments: { command: `echo ${turn}` } }] }));
    lines.push(message(`r${turn}`, { role: "toolResult", toolCallId: `c${turn}`, toolName: "Bash", isError: false, content: [{ type: "text", text: `out ${turn}` }] }));
  }
  return lines;
}

/** The comparable shape of a snapshot. Events a record gave no id are named by
    the session's row counter, which a joined and a whole parse number apart. */
function shape(snapshot: FeedSnapshot): unknown {
  return JSON.parse(JSON.stringify(
    { hidden: snapshot.hiddenServiceCount, rows: snapshot.items.map((entry) => [entry.key, entry.anchorKey, entry.item, entry.responseDurationMs, entry.submissionDedup]) },
    (key, value) => (typeof value === "string" ? value.replace(/^plain-\d+-/, "plain-N-") : value === undefined ? "__undefined" : value),
  ));
}

interface Walk {
  session: FeedSession;
  steps: number;
}

/** Parses the last `page` lines, then prepends `page` more at a time to the
    start, comparing every step with a whole parse of the same window. */
function walk(fmt: Fmt, lines: string[], page: number, showSvc: boolean, live = false): Walk {
  const config = { engine: fmt, fmt, showSvc, lineFilter: "" } as const;
  let start = Math.max(0, lines.length - page);
  const session = createFeedSession(config);
  session.feed(lines.slice(start), start, live);
  let steps = 0;
  while (start > 0) {
    start = Math.max(0, start - page);
    const window = lines.slice(start);
    const joined = session.feed(window, start, live);
    const whole = createFeedSession(config).feed(window, start, live);
    expect(shape(joined)).toEqual(shape(whole));
    steps += 1;
  }
  return { session, steps };
}

describe("older history joins the window without parsing it again", () => {
  for (const seed of [1, 2, 3]) {
    for (const showSvc of [false, true]) {
      test(`Claude transcript ${seed} (service rows ${showSvc ? "shown" : "hidden"}) equals a whole parse at every step`, () => {
        const lines = claudeTranscript(seed, 26);
        for (const page of [1, 3, 7]) {
          const { session, steps } = walk("claude", lines, page, showSvc);
          const stats = feedJoinStats(session);
          expect(steps).toBeGreaterThan(0);
          /* Pages that cannot be joined fall back (a window shorter than the
             seam has no join point), but this transcript has a clean point
             every few lines, so most of them join. */
          expect(stats.joined).toBeGreaterThan(stats.rebuilt);
        }
        /* One page holding most of the transcript is equal as well. */
        walk("claude", lines, 40, showSvc);
      });
    }
  }

  test("a join parses the page and a bounded seam, not the window", () => {
    const lines = claudeTranscript(4, 60);
    const page = 10;
    const { session } = walk("claude", lines, page, false);
    const stats = feedJoinStats(session);
    expect(stats.joined).toBeGreaterThan(5);
    /* The page, the 24-line seam and the distance to the next clean point. */
    expect(stats.joinedLines / stats.joined).toBeLessThan(page + 24 + 40);
    expect(stats.joinedLines / stats.joined).toBeLessThan(lines.length / 4);
  });

  test("rows past the join keep their objects and keys", () => {
    const lines = claudeTranscript(5, 40);
    const config = { engine: "claude", fmt: "claude", showSvc: false, lineFilter: "" } as const;
    const start = 200;
    const session = createFeedSession(config);
    const before = session.feed(lines.slice(start), start, false);
    const after = session.feed(lines.slice(start - 30), start - 30, false);
    expect(feedJoinStats(session).joined).toBe(1);
    const tail = before.items.slice(-25).filter((entry) => entry.item.kind !== "cmd-group");
    expect(tail.length).toBeGreaterThan(5);
    for (const entry of tail) {
      const kept = after.items.find((candidate) => candidate.key === entry.key);
      expect(kept).toBeDefined();
      expect(kept!.item).toBe(entry.item);
    }
    /* A re-parse of the same lines hands every row the key it had. */
    const whole = createFeedSession(config).feed(lines.slice(start - 30), start - 30, false);
    expect(after.items.map((entry) => entry.key)).toEqual(whole.items.map((entry) => entry.key));
  });

  test("the live tail keeps appending after a join", () => {
    const lines = claudeTranscript(6, 30);
    const config = { engine: "claude", fmt: "claude", showSvc: true, lineFilter: "" } as const;
    const session = createFeedSession(config);
    const start = lines.length - 90;
    session.feed(lines.slice(start, lines.length - 12), start, true);
    session.feed(lines.slice(start - 20, lines.length - 12), start - 20, true);
    expect(feedJoinStats(session).joined).toBe(1);
    for (let end = lines.length - 11; end <= lines.length; end += 1) {
      const incremental = session.feed(lines.slice(start - 20, end), start - 20, true);
      expect(shape(incremental)).toEqual(shape(createFeedSession(config).feed(lines.slice(start - 20, end), start - 20, true)));
    }
  });

  test("a page and new live lines arriving together still join", () => {
    const lines = claudeTranscript(7, 30);
    const config = { engine: "claude", fmt: "claude", showSvc: false, lineFilter: "" } as const;
    const session = createFeedSession(config);
    const start = lines.length - 60;
    session.feed(lines.slice(start, lines.length - 5), start, true);
    const grown = session.feed(lines.slice(start - 25), start - 25, true);
    expect(feedJoinStats(session).joined).toBe(1);
    expect(shape(grown)).toEqual(shape(createFeedSession(config).feed(lines.slice(start - 25), start - 25, true)));
  });

  test("a result whose call sits in the older page is not joined across", () => {
    /* The call is the last line of the page and the result the first of the
       window: only a parse that starts before the call can attach them. */
    const lines = [
      user("start"),
      assistant("m0", [toolUse("toolu_seam", "Bash", { command: "ls" })], "tool_use"),
      result("toolu_seam", "listing"),
      assistant("m1", [{ type: "text", text: "listed" }], "end_turn"),
      user("next"),
      assistant("m2", [{ type: "text", text: "ok" }], "end_turn"),
    ];
    for (let page = 1; page <= 4; page += 1) walk("claude", lines, page, true);
  });

  test("a compaction summary whose boundary sits in the older page is not joined across", () => {
    const lines = [
      user("before"),
      assistant("m0", [{ type: "text", text: "answer" }], "end_turn"),
      JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: at(), compactMetadata: { trigger: "auto", preTokens: 5 } }),
      attachment("a"),
      attachment("b"),
      JSON.stringify({ type: "user", isCompactSummary: true, timestamp: at(), message: { content: "the summary" } }),
      user("after"),
      assistant("m1", [{ type: "text", text: "continuing" }], "end_turn"),
    ];
    for (let page = 1; page <= 5; page += 1) walk("claude", lines, page, true);
  });

  test("a transcript with no clean point falls back to the whole parse", () => {
    const lines = [user("one long task")];
    for (let i = 0; i < 60; i += 1) {
      lines.push(assistant(`m${i}`, [toolUse(`toolu_long_${i}`, "Bash", { command: `echo ${i}` })], "tool_use"));
      lines.push(result(`toolu_long_${i}`, `out ${i}`));
    }
    const { session } = walk("claude", lines, 20, true);
    const stats = feedJoinStats(session);
    expect(stats.joined).toBe(0);
    expect(stats.rebuilt).toBeGreaterThan(0);
  });

  test("a window rewritten in place is parsed whole", () => {
    const lines = claudeTranscript(8, 12);
    const config = { engine: "claude", fmt: "claude", showSvc: false, lineFilter: "" } as const;
    const session = createFeedSession(config);
    session.feed(lines.slice(30), 30, false);
    const rewritten = [...lines.slice(20, lines.length - 1), user("rewritten tail")];
    expect(shape(session.feed(rewritten, 20, false))).toEqual(shape(createFeedSession(config).feed(rewritten, 20, false)));
  });

  for (const name of ["codex-turn-chronology-0.151.jsonl", "codex-item-completed-envelope.jsonl", "codex-thread-items-0.151.jsonl", "codex-payload-audit.jsonl"]) {
    test(`Codex fixture ${name} equals a whole parse at every step`, () => {
      const lines = fixture(name);
      for (const page of [1, 2, 5]) walk("codex", lines, page, true);
    });
  }

  test("Codex orchestration fixture equals a whole parse at every step", () => {
    const lines = readFileSync(path.join(import.meta.dir, "__fixtures__", "codex-orchestration.jsonl"), "utf8").trim().split("\n");
    for (const page of [3, 11]) walk("codex", lines, page, false);
  });

  test("Copilot transcript equals a whole parse at every step", () => {
    const lines = copilotTranscript(12);
    for (const page of [1, 4, 9]) walk("copilot", lines, page, true);
  });

  test("OpenClaw transcript equals a whole parse at every step", () => {
    const lines = openclawTranscript(10);
    for (const page of [1, 4, 9]) walk("openclaw", lines, page, true);
  });
});
