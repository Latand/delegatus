import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CardStatusBadge } from "./CardStatusBadge";
import { expect, test } from "bun:test";
import type { FileEntry } from "@/lib/types";
import { translate } from "@/lib/i18n";
import { cardStatus } from "./cardStatus";
import { activityDotText, cardStatusText } from "./CardStatusBadge";
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
    expect(nowFragment(f)).toBeNull();
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

test("an incomplete native tail cannot give the card an idle or stalled verdict", () => {
  const uncertain = { ...file(false, 900_000), agentActivity: { lastRecordAt: null, turnBoundaryVerified: false } } as FileEntry;
  expect(cardStatus(uncertain, now)).toMatchObject({ kind: "running", activity: { state: "working", idleForMs: null } });
  expect(mobileRowState(uncertain, now / 1000).key).toBe("working");
});


test("a provider retry keeps its existing limit row and never gains an idle badge", () => {
  const limited = { ...file(false, 660_000), rateLimit: { resetAt: now / 1000 + 60 } } as FileEntry;
  expect(cardStatus(limited, now)).toBeNull();
  expect(mobileRowState(limited, now / 1000).key).toBe("limit");
  expect(isWorkingAgent(limited, now / 1000)).toBe(false);
});

test("running activity renders only an accessible dot, with no visible status text or pill", () => {
  for (const checking of [true, false]) {
    const html = renderToStaticMarkup(createElement(CardStatusBadge, { file: { ...file(checking, 300_000), agentActivity: { lastRecordAt: Date.now() - 300_000, checking } } }));
    expect(html).toContain('data-agent-activity=');
    expect(html).toContain('role="button"');
    expect(html).toContain('aria-label=');
    expect(html).toContain('width:8px');
    expect(html).toContain('height:8px');
    expect(html).not.toContain('px-[0.6em]');
    expect(html).not.toMatch(/>[^<]+<\/span>/);
  }
});


test("dot details stay short and omit paths, identifiers and oversized check descriptions", () => {
  const t = ((key, params) => translate("uk", key, params)) as Parameters<typeof activityDotText>[0];
  const f = file(true, 300_000);
  for (const check of ["/repo/private/check.ts", "check " + "long ".repeat(30), "task-abcdef0123456789"]) {
    expect(activityDotText(t, f, { kind: "running", elapsedSeconds: 300, activity: { state: "checking", check, idleForMs: null } }, now)).toEqual(["чекає перевірку · 5 хв"]);
  }
  const lines = activityDotText(t, file(false, 840_000), { kind: "running", elapsedSeconds: 900, activity: { state: "idle", check: null, idleForMs: 840_000 } }, now);
  expect(lines[0]).toBe("стоїть 14 хв");
  expect(lines[1]).toMatch(/^остання дія \d{2}:\d{2}$/);
});
