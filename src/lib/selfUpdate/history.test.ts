import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendHistory, findAutoSwitchRequest, readHistory } from "./history";

const root = mkdtempSync("/var/tmp/self-update-history-");
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("history keeps the newest twenty and skips a torn line", () => {
  const file = join(root, "history.jsonl");
  for (let index = 0; index < 25; index++) appendHistory(file, { at: new Date(index * 1_000).toISOString(), by: "auto", kind: "build", target: String(index), from: null, outcome: "done" });
  expect(readHistory(file)).toHaveLength(20);
  expect(readHistory(file)[0]?.target).toBe("24");
  writeFileSync(file, `${readFileSync(file, "utf8")}{\"at\":`, "utf8");
  expect(readHistory(file)[0]?.target).toBe("24");
});

test("more than one thousand records compacts to five hundred", () => {
  const file = join(root, "many.jsonl");
  for (let index = 0; index < 1_001; index++) appendHistory(file, { at: new Date(index * 1_000).toISOString(), by: "operator", kind: "restart-web", target: String(index), from: null, outcome: "done" });
  expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(500);
  expect(readHistory(file)[0]?.target).toBe("1000");
});

test("compaction retains durable switch receipts while the history view hides them", () => {
  const file = join(root, "receipts.jsonl");
  for (let index = 0; index < 1_000; index++) appendHistory(file, { at: new Date(index * 1_000).toISOString(), by: "operator", kind: "restart-web", target: String(index), from: null, outcome: "done" });
  const response = { auto: { enabled: false }, token: "private-response" };
  appendHistory(file, { at: new Date(1_000_000).toISOString(), by: "seat", kind: "auto-off", target: "", from: null, outcome: "done", requestId: "receipt-id", response });

  expect(findAutoSwitchRequest(file, "receipt-id")).toMatchObject({ requestId: "receipt-id", response });
  expect(readHistory(file, 500)[0]).not.toHaveProperty("requestId");
  expect(readHistory(file, 500)[0]).not.toHaveProperty("response");
});
