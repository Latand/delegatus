import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getLocale, setLocale } from "@/lib/i18n";
import {
  assistantEchoText, codexHistoryStats, createFeedSession, feedJoinStats,
  hasSameSessionOwner, nativeUserRefFor, rawUserTextFor,
  type FeedSnapshot,
} from "./parse";
import { codexHistoryCorpus, codexHistorySeams, historyCall, historyOutput, historyRecord, historyUsage } from "./__fixtures__/codexHistory";

import { comparableHistory, realHistoryIds } from "./__fixtures__/codexHistoryComparison";
import oracle from "./__fixtures__/codexHistoryOracle.json";

const config = { fmt: "codex", engine: "codex", showSvc: false, lineFilter: "" } as const;


const historyShape = (snapshot: FeedSnapshot, lines: readonly string[] = []) => comparableHistory(snapshot, { nativeUserRefFor, rawUserTextFor, assistantEchoText, hasSameSessionOwner }, realHistoryIds(lines));

function equalWalk(lines: string[], page: number, showSvc: boolean, offset = 0, lineFilter = "") {
  const cfg = { ...config, showSvc, lineFilter };
  const session = createFeedSession(cfg);
  let from = lines.length;
  while (from > 0) {
    const previousFrom = from;
    from = Math.max(0, from - page);
    const window = lines.slice(from);
    const before = codexHistoryStats(session)!;
    const paged = session.feed(window, from + offset, true);
    expect(historyShape(paged, window)).toEqual(historyShape(createFeedSession(cfg).feed(window, from + offset, true), window));
    const after = codexHistoryStats(session)!;
    expect(after.rawLines - before.rawLines).toBe(previousFrom - from);
    expect(session.feed(window, from + offset, true)).toBe(paged);
  }
  expect(feedJoinStats(session).rebuilt).toBe(0);
  expect(codexHistoryStats(session)!.resets).toEqual({});
  const live = [...lines, historyOutput("early", 20, "late continuation"), historyUsage(21, 3000, 1700),
    historyRecord("event_msg", { type: "user_message", message: "Inspect the fixture" }), historyRecord("event_msg", { type: "task_complete" }, 22)];
  expect(historyShape(session.feed(live, offset, false))).toEqual(historyShape(createFeedSession(cfg).feed(live, offset, false)));
  return session;
}

describe("Codex history hand-over", () => {
  test("one-shot semantics retain the immutable baseline's full shapes and private metadata", async () => {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "__fixtures__/codexHistoryOracle.ts")], {
      env: { ...process.env, TZ: oracle.timezone }, stdout: "pipe", stderr: "pipe",
    });
    try {
      const [status, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(err).toBe("");
      expect(status).toBe(0);
      expect(JSON.parse(out)).toEqual(oracle.rows.map(row => row.sha256));
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
    }
  });

  for (const showSvc of [false, true]) for (const offset of [0, -100]) {
    test(`open exec, pending user and ledger/context seams; services=${showSvc}, offset=${offset}`, () => {
      const lines = codexHistorySeams();
      for (const page of [1, 2, 7, 24, 25, 137, 300]) equalWalk(lines, page, showSvc, offset);
      for (let split = 1; split < lines.length; split += 1) {
        const cfg = { ...config, showSvc };
        const session = createFeedSession(cfg);
        session.feed(lines.slice(split), split + offset, true);
        expect(historyShape(session.feed(lines, offset, true))).toEqual(historyShape(createFeedSession(cfg).feed(lines, offset, true)));
        expect(feedJoinStats(session).joined).toBe(1);
      }
    });
  }

  for (const name of ["codex-turn-chronology-0.151.jsonl", "codex-item-completed-envelope.jsonl", "codex-thread-items-0.151.jsonl", "codex-payload-audit.jsonl"]) {
    test(`all split points in ${name}, including private metadata and live continuation`, () => {
      const lines = readFileSync(path.join(import.meta.dir, "fixtures", name), "utf8").trim().split("\n");
      for (const page of [1, 2, 7]) equalWalk(lines, page, true, -lines.length);
    });
  }

  test("a fixed open frontier skips independent closed rounds as history grows", () => {
    const work = (padding: number) => {
      const lines = [historyCall("early"), historyOutput("early"), historyUsage(2), historyUsage(3),
        ...codexHistoryCorpus(padding), historyRecord("event_msg", { type: "task_complete" }, 50)];
      const session = createFeedSession(config);
      session.feed(lines.slice(1), 1, true);
      const before = codexHistoryStats(session)!;
      const snapshot = session.feed(lines, 0, true);
      const after = codexHistoryStats(session)!;
      expect(historyShape(snapshot)).toEqual(historyShape(createFeedSession(config).feed(lines, 0, true)));
      expect(after.rawLines - before.rawLines).toBe(1);
      expect(feedJoinStats(session)).toMatchObject({ joined: 1, rebuilt: 0, joinedLines: 1 });
      return after.effectVisits - before.effectVisits;
    };
    expect(work(320)).toBe(work(3200));
  });

  test("an unresolved exec does not replay unrelated result deletions across the suffix", () => {
    const visits = (rounds: number) => {
      const lines = [historyRecord("response_item", { type: "custom_tool_call", name: "exec", call_id: "held-wrapper", input: 'text(await tools.exec_command({cmd:"echo held"}));' })];
      for (let i = 0; i < rounds; i += 1) lines.push(historyCall(`independent-${i}`, i), historyOutput(`independent-${i}`, i), historyUsage(i, i * 100 + 1, i * 1000 + 1));
      const session = createFeedSession(config);
      session.feed(lines.slice(1), 1, false);
      const before = codexHistoryStats(session)!;
      const result = session.feed(lines, 0, false);
      expect(historyShape(result)).toEqual(historyShape(createFeedSession(config).feed(lines, 0, false)));
      const after = codexHistoryStats(session)!;
      expect(after.rawLines - before.rawLines).toBe(1);
      return after.effectVisits - before.effectVisits;
    };
    const small = visits(40);
    expect(small).toBeLessThan(20);
    expect(visits(400)).toBe(small);
  });

  test("many pending structured users in other time buckets add no reconciliation work", () => {
    const work = (count: number) => {
      const message = (n: number) => historyRecord("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "<!-- llv:structured-user -->\nRepeated request" }] }, n);
      const lines = [message(0), ...Array.from({ length: count }, (_, n) => message(100 + n * 10))];
      const session = createFeedSession(config);
      session.feed(lines.slice(1), 1, true);
      const before = codexHistoryStats(session)!;
      const result = session.feed(lines, 0, true);
      const after = codexHistoryStats(session)!;
      expect(historyShape(result)).toEqual(historyShape(createFeedSession(config).feed(lines, 0, true)));
      expect(after.rawLines - before.rawLines).toBe(1);
      return [after.effectChecks - before.effectChecks, after.effectVisits - before.effectVisits];
    };
    expect(work(100)).toEqual(work(1000));
  });

  test("old snapshots stay immutable and independent item/group identities survive", () => {
    const lines = codexHistoryCorpus(140);
    const session = createFeedSession(config);
    const old = session.feed(lines.slice(20), 20, true);
    const oldShape = historyShape(old);
    const next = session.feed(lines, 0, true);
    const held = old.items.filter(entry => Number(entry.key.split(":")[1]) > 40);
    expect(held.length).toBeGreaterThan(10);
    for (const entry of held) expect(next.items.find(value => value.key === entry.key)?.item).toBe(entry.item);
    expect(historyShape(old)).toEqual(oldShape);
  });

  test("interior rewrite, truncation, gaps and eviction refuse reuse and release the old journal", () => {
    const lines = codexHistoryCorpus(60);
    const session = createFeedSession(config);
    session.feed(lines.slice(20), 20, false);
    const rewritten = lines.slice(); rewritten[30] = historyCall("changed", 1);
    expect(historyShape(session.feed(rewritten, 0, false))).toEqual(historyShape(createFeedSession(config).feed(rewritten, 0, false)));
    expect(codexHistoryStats(session)!.resets).toEqual({ rewritten: 1 });
    for (const [window, start] of [[lines.slice(10), 10], [lines.slice(0, 10), 0], [lines.slice(0, 2), 100]] as const) {
      expect(historyShape(session.feed([...window], start, false))).toEqual(historyShape(createFeedSession(config).feed([...window], start, false)));
      expect(codexHistoryStats(session)!.effects).toBe(window.length);
    }
  });

  test("filter, malformed input and simultaneous prepend/append use the same reduction", () => {
    equalWalk(["{broken", "null", "[]", ...codexHistorySeams()], 2, true);
    for (const filter of ["fixture", "no-match"]) equalWalk(codexHistorySeams(), 3, false, 0, filter);
    const lines = codexHistorySeams(); const session = createFeedSession(config);
    session.feed(lines.slice(5, 12), 5, true);
    expect(historyShape(session.feed(lines, 0, false))).toEqual(historyShape(createFeedSession(config).feed(lines, 0, false)));
    expect(codexHistoryStats(session)!.rawLines).toBe(lines.length);
  });

  test("a locale change starts a new generation with the current labels", () => {
    const locale = getLocale();
    try {
      setLocale("en");
      const lines = codexHistorySeams();
      const session = createFeedSession(config);
      session.feed(lines, 0, false);
      setLocale("uk");
      expect(historyShape(session.feed(lines, 0, false))).toEqual(historyShape(createFeedSession(config).feed(lines, 0, false)));
      expect(codexHistoryStats(session)!.resets.configuration).toBe(1);
    } finally { setLocale(locale); }
  });

  test("reaching coordinate zero changes the ledger's initial partialness", () => {
    const lines = [historyCall("first"), historyOutput("first"), historyUsage(2, 100, 100), historyUsage(3, 200, 900)];
    const session = createFeedSession(config);
    session.feed(lines.slice(1), 1, false);
    const result = session.feed(lines, 0, false);
    expect(historyShape(result)).toEqual(historyShape(createFeedSession(config).feed(lines, 0, false)));
    const item = result.items.find(({ item }) => item.kind === "tool")!.item;
    expect(item.kind === "tool" && item.contextTokens?.basis).toBe("measured");
  });

  test("late duplicate IDs, repeated results and representation preserve their source order", () => {
    const lines = [...codexHistorySeams(), historyCall("early", 30), historyOutput("early", 31, "replacement"),
      historyOutput("early", 32, "second fragment"), historyUsage(33, 4000, 2400), historyUsage(34, 5000, 3000)];
    for (const distance of [24, 25, 61, 62, 310]) {
      const padded = [...lines.slice(0, 8), ...Array.from({ length: distance }, (_, n) => historyRecord("event_msg", { type: "thread_settings_applied" }, n)), ...lines.slice(8)];
      equalWalk(padded, 7, false);
    }
  });

  test("structured users retain delivery identity and attachments across distant echoes", () => {
    const user = (dedup: string, origin = "operator", attachment = false) => historyRecord("response_item", {
      type: "message", role: "user", content: [
        { type: "input_text", text: `<!-- llv:structured-user origin=${origin} dedup=${dedup.repeat(64)} -->\nSame request` },
        ...(attachment ? [{ type: "input_image", image_url: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" }] : []),
      ],
    });
    const lines = [user("a", "agent", true), user("b"), ...Array.from({ length: 90 }, (_, n) => historyRecord("event_msg", { type: "thread_settings_applied" }, n)),
      historyRecord("event_msg", { type: "user_message", message: "Same request" }), user("b"), historyCall("next", 100)];
    const session = equalWalk(lines, 7, true);
    const result = session.feed(lines, 0, false);
    expect(result.items.filter(({ item }) => (item.kind === "tmsg" || item.kind === "user") && item.text === "Same request")).toHaveLength(2);
    expect(result.items.filter(({ item }) => item.kind === "image")).toHaveLength(1);
  });

  test("a real call ID in the generated namespace uses the explicit one-shot fallback", () => {
    const id = "plain-1-2026-09-01T10:00:01.000Z";
    const lines = [historyCall(id), historyRecord("response_item", { type: "custom_tool_call", name: "exec", input: 'text(await tools.exec_command({cmd:"echo fallback"}));' }, 1), historyOutput(id, 2)];
    const session = createFeedSession(config);
    session.feed(lines.slice(1), 1, false);
    const result = session.feed(lines, 0, false);
    const full = createFeedSession(config).feed(lines, 0, false);
    expect(result).toEqual(full);
    expect(codexHistoryStats(session)!.resets["reserved-id"]).toBeGreaterThan(0);
  });

  test("an oversized complete result keeps original accounting sizes across the hand-over", () => {
    const chars = 4 * 1024 * 1024 + 17;
    const output = "fixture output\n".repeat(Math.ceil(chars / 15)).slice(0, chars);
    const lines = [historyCall("oversized"), historyOutput("oversized", 1, output)];
    const session = createFeedSession(config);
    session.feed(lines.slice(1), 1, false);
    const before = codexHistoryStats(session)!;
    const result = session.feed(lines, 0, false);
    expect(historyShape(result)).toEqual(historyShape(createFeedSession(config).feed(lines, 0, false)));
    const item = result.items[0].item;
    expect(item.kind === "tool" && item.contextTokens?.n).toBe(Math.round(chars / 3.6));
    expect(item.kind === "tool" && item.outputTruncated).toBe(true);
    expect(codexHistoryStats(session)!.rawLines - before.rawLines).toBe(1);
  });

  test("ambiguous execs and overflow remain latched until a real reset", () => {
    const wrapper = (id: string) => historyRecord("response_item", { type: "custom_tool_call", name: "exec", call_id: id, input: 'text(await tools.exec_command({cmd:"echo nested"}));' });
    const child = (id: string) => historyRecord("event_msg", { type: "item_completed", item: { type: "commandExecution", id, command: "echo nested", status: "completed", aggregatedOutput: "nested" } });
    const lines = [...Array.from({ length: 17 }, (_, n) => wrapper(`outer-${n}`)), child("exec-ambiguous"),
      historyOutput("outer-0", 1, "Error: refused"), historyOutput("outer-1", 2),
      historyRecord("turn_context", { cwd: "workspace", turn_id: "reset" }, 3),
      wrapper("recovered"), child("exec-recovered"), historyOutput("recovered", 4), historyUsage(5), historyUsage(6)];
    for (const page of [1, 2, 7]) equalWalk(lines, page, false);
  });

  test("random partitions, live arrivals and later window eviction agree at each operation", () => {
    const all = [...codexHistoryCorpus(137), ...codexHistorySeams()];
    for (let seed = 1; seed < 5; seed += 1) {
      let random = seed;
      const next = () => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0);
      const session = createFeedSession(config);
      let start = all.length - 17, end = all.length - 6;
      for (let step = 0; start > 0 || end < all.length; step += 1) {
        if (step % 3 === 1) end = Math.min(all.length, end + 1 + next() % 5);
        else start = Math.max(0, start - 1 - next() % 24);
        const lines = all.slice(start, end), live = Boolean(step % 2);
        expect(historyShape(session.feed(lines, start - 300, live), lines)).toEqual(historyShape(createFeedSession(config).feed(lines, start - 300, live), lines));
      }
      const shortened = all.slice(25);
      expect(historyShape(session.feed(shortened, -275, false))).toEqual(historyShape(createFeedSession(config).feed(shortened, -275, false)));
      expect(codexHistoryStats(session)!.resets.evicted).toBe(1);
    }
  });

  test("the installed terminal continuation pairs a live child of an exec left open at the join", () => {
    const lines = codexHistorySeams(), prefix = lines.slice(0, 5);
    for (const offset of [0, -20]) {
      const session = createFeedSession(config);
      session.feed(prefix.slice(4), 4 + offset, true);
      session.feed(prefix, offset, true);
      for (const end of [6, 7, 10, lines.length]) {
        const window = lines.slice(0, end);
        expect(historyShape(session.feed(window, offset, true))).toEqual(historyShape(createFeedSession(config).feed(window, offset, true)));
      }
      expect(codexHistoryStats(session)!.resets).toEqual({});
    }
  });
});
