import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { childFinalMessage, withChildFinalMessages } from "./childFinalMessage";
import { seatTickWakeMessage } from "./report";
import type { SeatTickItem } from "./types";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-child-final-message-"));
afterAll(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));

function claudeTranscript(lines: Record<string, unknown>[]): string {
  const file = path.join(SANDBOX, `${crypto.randomUUID()}.jsonl`);
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return file;
}

test("a settled child's last assistant text is its final message, bounded (#1881)", () => {
  const file = claudeTranscript([
    { type: "user", message: { role: "user", content: [{ type: "text", text: "review the exporter" }] }, timestamp: "2026-09-19T10:00:00.000Z" },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Looking at it." }] }, timestamp: "2026-09-19T10:01:00.000Z" },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Verdict: approve.\n\nNo findings." }] }, timestamp: "2026-09-19T10:02:00.000Z" },
  ]);
  expect(childFinalMessage(file, "claude")).toBe("Verdict: approve. No findings.");
  const long = claudeTranscript([{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(2_000) }] } }]);
  expect(childFinalMessage(long, "claude")!.length).toBeLessThanOrEqual(600);
});

test("a transcript that is gone or says nothing leaves the line as it was (#1881)", () => {
  expect(childFinalMessage(path.join(SANDBOX, "gone.jsonl"), "claude")).toBeNull();
  const silent = claudeTranscript([{ type: "user", message: { role: "user", content: [{ type: "text", text: "hello" }] } }]);
  const item: SeatTickItem = { kind: "child", id: "child-one", label: "reviewer — spawned child finished, outcome unharvested", finalMessageFrom: { path: silent, engine: "claude" } };
  expect(withChildFinalMessages([item])).toEqual([item]);
});

test("the wake carries the final message under the child's line (#1881)", () => {
  const file = claudeTranscript([{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Approve: the exporter is correct." }] } }]);
  const items = withChildFinalMessages([
    { kind: "child", id: "child-one", label: "reviewer — spawned child finished, outcome unharvested", finalMessageFrom: { path: file, engine: "claude" } },
  ]);
  const text = seatTickWakeMessage({
    project: "viewer",
    reasons: [{ kind: "child-terminal", detail: "a spawned child finished and its outcome is unharvested" }],
    items,
    deferred: 0,
    signals: [],
  });
  expect(text).toContain("- [child] child-one — reviewer — spawned child finished, outcome unharvested\n  final message: Approve: the exporter is correct.");
});
