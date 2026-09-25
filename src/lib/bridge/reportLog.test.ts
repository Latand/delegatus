import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { setBridgeReports } from "@/lib/projects/settings";

import { readProjectReportLog, reportCardRefs, type ReportLogCard } from "./reportLog";
import { acknowledgeBridgeReports, appendBridgeReports, BRIDGE_REPORT_PAGE_MAX, openBridgeChannel, pageBridgeReports, readBridgeChannel } from "./store";
import type { BridgeReportInput } from "./types";

/* The operator's report log (#2146): one project's bridge reports, newest
   first, paged by seq, and a read that leaves the voice relay's cursor alone.
   Every test runs in its own LLV_STATE_DIR. */

const sandboxes: string[] = [];
const originalStateDir = process.env.LLV_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalStateDir;
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

function sandbox(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-report-log-"));
  sandboxes.push(dir);
  process.env.LLV_STATE_DIR = path.join(dir, "state");
}

const SCOPE = { project: "repo-project-a", seatConversationId: "conversation_seat_a" };

function report(index: number, overrides: Partial<BridgeReportInput> = {}): BridgeReportInput {
  return {
    key: `report-${index}`,
    class: "completed",
    at: new Date(Date.UTC(2026, 8, 24, 8, index)).toISOString(),
    body: `report ${index}`,
    project: SCOPE.project,
    targetSeatConversationId: SCOPE.seatConversationId,
    ...overrides,
  };
}

const NO_CARDS = { knownCards: () => new Map<string, ReportLogCard["kind"]>() };
const inProjectA = (project: string) => project === SCOPE.project;

test("a page is one project's reports, newest first, and pages back by seq to the start", () => {
  sandbox();
  const inputs: BridgeReportInput[] = [];
  for (let index = 1; index <= 45; index += 1) {
    inputs.push(report(index));
    /* Another project's report between every two of ours. */
    if (index % 2 === 0) inputs.push(report(1000 + index, { project: "repo-project-b", targetSeatConversationId: "conversation_seat_b" }));
  }
  appendBridgeReports(inputs);

  const first = pageBridgeReports({ inProject: inProjectA, limit: 20 });
  expect(first.reports.map((entry) => entry.body)).toEqual(Array.from({ length: 20 }, (_, index) => `report ${45 - index}`));
  expect(first.nextBefore).toBe(first.reports.at(-1)!.seq);

  const second = pageBridgeReports({ inProject: inProjectA, before: first.nextBefore, limit: 20 });
  expect(second.reports.map((entry) => entry.body)).toEqual(Array.from({ length: 20 }, (_, index) => `report ${25 - index}`));
  const third = pageBridgeReports({ inProject: inProjectA, before: second.nextBefore, limit: 20 });
  expect(third.reports.map((entry) => entry.body)).toEqual(["report 5", "report 4", "report 3", "report 2", "report 1"]);
  expect(third.nextBefore).toBeNull();

  /* A page is bounded whatever the caller asks for. */
  expect(pageBridgeReports({ inProject: () => true, limit: 10_000 }).reports).toHaveLength(Math.min(BRIDGE_REPORT_PAGE_MAX, 67));
});

test("reading the log moves no cursor and opens no channel", () => {
  sandbox();
  appendBridgeReports([report(1), report(2), report(3)]);
  expect(readBridgeChannel(SCOPE)).toBeNull();
  readProjectReportLog({ project: SCOPE.project }, NO_CARDS);
  expect(readBridgeChannel(SCOPE)).toBeNull();

  openBridgeChannel("root_report_log", new Date(), SCOPE);
  acknowledgeBridgeReports(1, new Date(), SCOPE);
  const page = readProjectReportLog({ project: SCOPE.project }, NO_CARDS);
  expect(page.entries.map((entry) => entry.seq)).toEqual([3, 2, 1]);
  expect(readBridgeChannel(SCOPE)?.managerReportCursor).toBe(1);
});

test("the read carries the setting, the GitHub repository and a revision that answers unchanged", () => {
  sandbox();
  appendBridgeReports([report(1)]);
  const first = readProjectReportLog({ project: SCOPE.project }, NO_CARDS);
  expect(first).toMatchObject({ ok: true, project: SCOPE.project, bridgeReports: true, github: null, nextBefore: null });
  expect(first.entries).toHaveLength(1);

  const again = readProjectReportLog({ project: SCOPE.project, since: first.revision }, NO_CARDS);
  expect(again.unchanged).toBe(true);
  expect(again.entries).toEqual([]);

  appendBridgeReports([report(2)]);
  const moved = readProjectReportLog({ project: SCOPE.project, since: first.revision }, NO_CARDS);
  expect(moved.unchanged).toBeUndefined();
  expect(moved.entries.map((entry) => entry.body)).toEqual(["report 2", "report 1"]);

  /* Off, the reports already stored are kept and still read. */
  setBridgeReports(SCOPE.project, false, "operator");
  const off = readProjectReportLog({ project: SCOPE.project }, NO_CARDS);
  expect(off.bridgeReports).toBe(false);
  expect(off.entries).toHaveLength(2);
});

test("a body names only the cards the board knows, each once", () => {
  const known = new Map<string, ReportLogCard["kind"]>([["9612c532", "pipeline"], ["fix-login-banner", "task"]]);
  expect(reportCardRefs("lane 9612c532 merged; 9612c532 again, task fix-login-banner done, deadbeef is a SHA", known)).toEqual([
    { id: "9612c532", kind: "pipeline" },
    { id: "fix-login-banner", kind: "task" },
  ]);
  expect(reportCardRefs("x9612c532 and fix-login-banner-2", known)).toEqual([]);

  sandbox();
  appendBridgeReports([report(1, { body: "Lane 9612c532 completed; PR #2146 is green." })]);
  const page = readProjectReportLog({ project: SCOPE.project }, { knownCards: () => known });
  expect(page.entries[0]!.cards).toEqual([{ id: "9612c532", kind: "pipeline" }]);
});
