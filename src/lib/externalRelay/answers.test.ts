import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-answers-test-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const {
  answerRecorder,
  listAnswerRecords,
  pruneAnswerRecords,
  readAnswerRecord,
  relayAnswersRoot,
  RELAY_ANSWER_LIST_LIMIT,
  RELAY_ANSWER_RETENTION_DAYS,
} = await import("./answers");
const DAY = 24 * 60 * 60 * 1000;
const input = (text: string) => ({ conversation: [{ id: "m1", author: { key: "u1", name: "User" }, text }], respond_to: "m1", request_text: null });
function recordFile(relayId: string, targetId: string, requestId: string): string {
  const dir = path.join(relayAnswersRoot(), relayId, targetId);
  return path.join(dir, fs.readdirSync(dir).find((name) => name.endsWith(`_${requestId}.json`))!);
}
/** Moves a finished record's end, and its file time, back by `days`. */
function age(relayId: string, targetId: string, requestId: string, days: number): void {
  const file = recordFile(relayId, targetId, requestId);
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  const at = Date.now() - days * DAY;
  fs.writeFileSync(file, JSON.stringify({ ...record, finishedAt: new Date(at).toISOString() }));
  fs.utimesSync(file, at / 1000, at / 1000);
}
function finished(requestId: string, text = "Hello", targetId = "target") {
  const recorder = answerRecorder({ requestId, relayId: "relay", targetId, targetName: "Target", claimedAt: null, input: input(text) })!;
  recorder.begin("claude", "opus");
  recorder.finish({ outcome: "answered", answer: { action: "reply", text: `Re: ${text}`, reply_to: "m1" }, delivery: "accepted" });
  return recorder;
}

test("the retention is one 30-day constant for readers and pruning", () => {
  expect(RELAY_ANSWER_RETENTION_DAYS).toBe(30);
  finished("rq_young");
  finished("rq_edge");
  finished("rq_old");
  age("relay", "target", "rq_young", 29);
  age("relay", "target", "rq_edge", 29.99);
  age("relay", "target", "rq_old", 30.01);
  // An expired record is hidden at once, before any prune ran.
  expect(readAnswerRecord("relay", "target", "rq_old")).toBeNull();
  expect(listAnswerRecords("relay", "target").map((row) => row.requestId).sort()).toEqual(["rq_edge", "rq_young"]);
  expect(pruneAnswerRecords()).toBe(1);
  expect(readAnswerRecord("relay", "target", "rq_edge")).not.toBeNull();
  expect(fs.readdirSync(path.join(relayAnswersRoot(), "relay", "target")).some((name) => name.includes("rq_old"))).toBe(false);
});

test("a running record is never pruned, however old its file", () => {
  const recorder = answerRecorder({ requestId: "rq_running", relayId: "relay", targetId: "slow", targetName: null, claimedAt: null, input: input("Still going") })!;
  recorder.begin("codex", "gpt-6-sol");
  const file = recordFile("relay", "slow", "rq_running");
  const at = (Date.now() - 40 * DAY) / 1000;
  fs.utimesSync(file, at, at);
  pruneAnswerRecords();
  expect(readAnswerRecord("relay", "slow", "rq_running")).toMatchObject({ state: "running", outcome: null });
});

test("the list is newest first, bounded, and summarises the message and the answer", async () => {
  for (let index = 0; index < RELAY_ANSWER_LIST_LIMIT + 2; index++) {
    finished(`rq_many_${index}`, `Question ${index} ${"long ".repeat(60)}`, "busy");
    await Bun.sleep(2);
  }
  const rows = listAnswerRecords("relay", "busy");
  expect(rows).toHaveLength(RELAY_ANSWER_LIST_LIMIT);
  expect(rows[0]!.requestId).toBe(`rq_many_${RELAY_ANSWER_LIST_LIMIT + 1}`);
  expect([...rows[0]!.request].length).toBeLessThanOrEqual(160);
  expect(rows[0]!.request.startsWith(`Question ${RELAY_ANSWER_LIST_LIMIT + 1} long`)).toBe(true);
  expect(rows[0]!.answer?.startsWith("Re: Question")).toBe(true);
  expect(rows[0]).not.toHaveProperty("input");
});

test("ids that cannot name a file read nothing and record nothing", () => {
  expect(answerRecorder({ requestId: "../x", relayId: "relay", targetId: "target", targetName: null, claimedAt: null, input: null })).toBeNull();
  expect(answerRecorder({ requestId: "rq", relayId: "relay", targetId: 7, targetName: null, claimedAt: null, input: null })).toBeNull();
  expect(listAnswerRecords("..", "target")).toEqual([]);
  expect(readAnswerRecord("relay", "..", "rq_young")).toBeNull();
  // A request id that ends like another one is not confused with it.
  finished("b_rq");
  finished("a_b_rq");
  expect(readAnswerRecord("relay", "target", "b_rq")?.requestId).toBe("b_rq");
});
