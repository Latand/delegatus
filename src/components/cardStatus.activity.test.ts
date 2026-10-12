import { expect, test } from "bun:test";
import type { FileEntry } from "@/lib/types";
import { translate } from "@/lib/i18n";
import { cardStatus } from "./cardStatus";
import { cardStatusText } from "./CardStatusBadge";
import { mobileRowState, nowFragment } from "./mobile/mobileBoardModel";
import { isWorkingAgent } from "./workingAgents";
const now = 1_800_000_000_000;
function file(checking: boolean, age: number): FileEntry {
  return { path: "/fixture/one.jsonl", engine: "codex", root: "codex-sessions", proc: "running", pid: 42, activity: "stalled", activityReason: "jsonl_turn_stalled", mtime: (now-age)/1000, lastTurn: { startedAt: now-900_000, endedAt: null }, agentActivity: { lastRecordAt: now-age, checking, check: checking ? "privacy-publication-gate" : null } } as FileEntry;
}
test("long checks retain the card badge, phone working state and working count in both languages", () => {
  const f = file(true, 300_000);
  const status = cardStatus(f, now);
  expect(status).toMatchObject({ kind: "running", activity: { state: "checking", check: "privacy-publication-gate" } });
  for (const locale of ["en", "uk"] as const) {
    const text = cardStatusText(((key, params) => translate(locale, key, params)), status!);
    expect(text.word).toBe(locale === "uk" ? "чекає перевірку" : "waiting on a check");
    expect(text.detail).toBe("privacy-publication-gate");
    expect(nowFragment(f, now, locale)).toContain(text.word);
  }
  expect(mobileRowState(f, now/1000).key).toBe("working");
  expect(isWorkingAgent(f, now/1000)).toBe(true);
});
test("real idle uses record age on both surfaces and leaves the working count", () => {
  const f = file(false, 840_000);
  const status = cardStatus(f, now);
  expect(status).toMatchObject({ kind: "running", activity: { state: "idle", idleForMs: 840_000 } });
  expect(mobileRowState(f, now/1000)).toMatchObject({ key: "stalled", seconds: 840 });
  expect(isWorkingAgent(f, now/1000)).toBe(false);
});
