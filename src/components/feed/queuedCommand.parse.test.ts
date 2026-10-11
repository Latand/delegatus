import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { FileEntry } from "@/lib/types";

import { buildFeed, createFeedSession, type Item } from "./parse";

/*
 * A message that reaches Claude while a turn runs is journaled as a
 * `queued_command` attachment in place of a user record. The fixture copies
 * the structure of real records and carries only invented text and ids.
 */

const claudeFile = { path: "/tmp/x.jsonl", engine: "claude", fmt: "claude", activity: "recent" } as FileEntry;
const QUEUED_TEXT = "Fixture follow-up sent while the turn ran.";

/* Plain-tool ids and absolute source indices differ between a windowed parse
   and a one-shot parse of the same lines; both are opaque tokens. */
function normalize(items: Item[], start = 0): unknown {
  return JSON.parse(
    JSON.stringify(items, (key, value) => {
      if (key === "srcCall" || key === "srcResult") return 0;
      if (key === "anchorKey" && typeof value === "string") return value.replace(/^row:(\d+):/, (_, src) => `row:${Number(src) - start}:`);
      return typeof value === "string" && (key === "id" || key === "ids") ? value.replace(/^plain-\d+-/, "plain-N-") : value;
    }),
  );
}

/** Feed `lines` chunk by chunk, trimming to `cap`, and compare every
    incremental snapshot with a one-shot parse of the same window. */
function assertParity(lines: string[], opts: { cap?: number; chunks?: number[] } = {}) {
  const { cap = 0, chunks = [1] } = opts;
  const session = createFeedSession({ engine: claudeFile.engine, fmt: claudeFile.fmt, showSvc: false, lineFilter: "" });
  let window: string[] = [];
  let start = 0;
  let fed = 0;
  let step = 0;
  while (fed < lines.length) {
    const take = Math.min(chunks[step % chunks.length], lines.length - fed);
    window = window.concat(lines.slice(fed, fed + take));
    fed += take;
    step += 1;
    if (cap > 0 && window.length > cap) {
      start += window.length - cap;
      window = window.slice(-cap);
    }
    const incremental = session.feed(window, start, false);
    const oneShot = buildFeed(claudeFile, window, false, "");
    expect(normalize(incremental.items.map((entry) => entry.item), start)).toEqual(normalize(oneShot.items));
    expect(incremental.hiddenServiceCount).toBe(oneShot.hiddenServiceCount);
  }
}

const claudeProse = (text: string) =>
  JSON.stringify({ type: "assistant", timestamp: "2026-10-11T09:00:03.000Z", message: { stop_reason: "end_turn", content: [{ type: "text", text }] } });

function fixtureLines(): string[] {
  return readFileSync(path.join(import.meta.dir, "fixtures", "claude-queued-command.jsonl"), "utf8").trim().split("\n");
}

const queuedPrompt = () => fixtureLines().find((line) => line.includes("\"commandMode\":\"prompt\""))!;

function itemsOfKind(feed: ReturnType<typeof buildFeed>, kind: Item["kind"]) {
  return feed.items.filter((item) => item.kind === kind);
}

describe("Claude messages delivered mid-turn", () => {
  test("renders a message delivered mid-turn as the delivered row it stands for, at its transcript position", () => {
    const lines = fixtureLines();
    const feed = buildFeed(claudeFile, lines, false, "");

    expect(itemsOfKind(feed, "sysmsg")).toEqual([expect.objectContaining({
      text: QUEUED_TEXT,
      deliveredMessage: { engineMessageId: "queued-one", ts: "2026-10-11T09:00:02.500Z" },
    })]);
    expect(feed.items.map((item) => item.kind)).toEqual(["tool", "sysmsg", "prose"]);
    /* Claude's reminder around the queued prompt is never content, and a
       background-task notice queued the same way is not a message. */
    expect(JSON.stringify(feed.items)).not.toContain("sent a new message while you were working");
    expect(JSON.stringify(feed.items)).not.toContain("task-notification");
    assertParity(lines, { chunks: [1] });
    assertParity(lines, { chunks: [1], cap: 3 });
  });

  test("a delivery journaled both as a queued_command and as a user record shows one row", () => {
    const queued = queuedPrompt();
    const record = JSON.stringify({
      type: "user", uuid: "queued-one", timestamp: "2026-10-11T09:00:05.000Z", promptSource: "sdk", entrypoint: "sdk-cli",
      message: { role: "user", content: [{ type: "text", text: QUEUED_TEXT }] },
    });
    const between = claudeProse("between");
    for (const lines of [[queued, between, record], [record, between, queued]]) {
      const feed = buildFeed(claudeFile, lines, false, "");
      expect(itemsOfKind(feed, "sysmsg")).toHaveLength(1);
      expect(feed.items[0]).toEqual(expect.objectContaining({ kind: "sysmsg" }));
      assertParity(lines, { chunks: [1] });
      assertParity(lines, { chunks: [1], cap: 2 });
    }
    /* Rows of ONE record share its id and all stay. */
    const twoParts = queued.replace(`[{"type":"text","text":"${QUEUED_TEXT}"}]`,
      "[{\"type\":\"text\",\"text\":\"first part\"},{\"type\":\"text\",\"text\":\"second part\"}]");
    expect(itemsOfKind(buildFeed(claudeFile, [twoParts], false, ""), "sysmsg").map((item) => "text" in item && item.text))
      .toEqual(["first part", "second part"]);
  });

  test("a prompt queued in an interactive session is the operator's own bubble", () => {
    const lines = [queuedPrompt().replace("\"entrypoint\":\"sdk-cli\"", "\"entrypoint\":\"cli\"")];
    const feed = buildFeed(claudeFile, lines, false, "");
    expect(itemsOfKind(feed, "user")).toEqual([
      { kind: "user", ts: "2026-10-11T09:00:02.500Z", text: QUEUED_TEXT },
    ]);
    expect(itemsOfKind(feed, "sysmsg")).toHaveLength(0);
  });
});
