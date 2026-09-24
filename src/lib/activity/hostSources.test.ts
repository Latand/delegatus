import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { exportLines, messageId, type HumanInput } from "./humanInput";
import { readHostsConfig, readHumanInputs } from "./hostSources";
import { activityReport, clampMethodParams, type Anchor } from "./method";
import type { LedgerRead } from "./requestLedger";

/* Two invented hosts: this workstation (`local`) and a stage host. The stage
   host's human input arrives as an export file; the local host is read
   through its ledger. Invented projects and ids only. */

const NOW = Date.parse("2026-09-23T20:00:00Z");
/* 2026-09-23 in Kyiv. */
const DAY = { start: Date.parse("2026-09-22T21:00:00Z"), end: Date.parse("2026-09-23T21:00:00Z") };
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "activity-hosts-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The local ledger: read, with history from a week back and nothing today. */
const quietLedger = (): LedgerRead => ({ rows: [], ledgerStartMs: NOW - 7 * 24 * 3_600_000 });

function hostsFile(hosts: unknown[]): void {
  fs.writeFileSync(path.join(dir, "hosts.json"), JSON.stringify({ v: 1, local: { id: "workstation" }, hosts }));
}

function stageExport(inputs: HumanInput[], coveredFrom = DAY.start, coveredUntil = NOW, host = "stage", name = "human-input-2026-09-23.jsonl"): void {
  const target = path.join(dir, "hosts", host);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, name), exportLines({ host, coveredFrom, coveredUntil, exportedAt: NOW, records: inputs.length + 4, excluded: { "agent-message": 3, unmarked: 1 } }, inputs));
}

const stageInput = (isoTime: string, id: string): HumanInput => ({
  ids: [messageId("codex", id)], at: Date.parse(isoTime), host: "stage", source: "transcripts", project: "client-a", kind: "message", surface: "unknown", hash: "a".repeat(64),
});

function reportFor(read: ReturnType<typeof readHumanInputs>) {
  const anchors: Anchor[] = read.inputs.map((input) => ({ at: input.at, project: input.project, surface: input.surface, kind: input.kind, host: input.host }));
  return activityReport({ params: clampMethodParams({}), range: "today", nowMs: NOW, anchors, hosts: read.coverage, agents: [] });
}

describe("human input from every expected host", () => {
  test("the local host read and empty, the stage host with input: hours from the stage host, coverage complete", () => {
    hostsFile([{ id: "stage", label: "Stage host" }]);
    stageExport([stageInput("2026-09-23T09:00:00Z", "a"), stageInput("2026-09-23T09:10:00Z", "b"), stageInput("2026-09-23T09:45:00Z", "c")]);
    const read = readHumanInputs({ start: DAY.start - 600_000, end: NOW }, NOW, { dir: () => dir, readLedger: quietLedger });
    expect(read.hosts.map((host) => [host.host, host.configured, host.sources.map((source) => `${source.source}:${source.state}`)])).toEqual([
      ["workstation", true, ["ledger:read", "transcripts:absent"]],
      ["stage", true, ["transcripts:read"]],
    ]);
    expect(read.hosts[1]!.sources[0]!.excluded).toEqual({ "agent-message": 3, unmarked: 1 });
    const report = reportFor(read);
    /* 09:00-09:20 and 09:45-09:55 UTC, the 12:00 hour in Kyiv: 30 minutes, 0.5 h. */
    expect(report.totals.humanMs).toBe(30 * 60_000);
    expect(report.totals.humanHours).toBe(0.5);
    expect(report.totals.coverage).toEqual({ complete: true, missingHosts: [] });
    expect(report.projects[0]!.byHost).toEqual({ stage: 30 * 60_000 });
    expect(report.days[0]!.missingSource).toBeNull();
  });

  test("the same with the stage host not connected: coverage unknown and a flagged zero", () => {
    hostsFile([{ id: "stage", label: "Stage host" }]);
    const read = readHumanInputs({ start: DAY.start - 600_000, end: NOW }, NOW, { dir: () => dir, readLedger: quietLedger });
    expect(read.hosts[1]!.sources[0]!.state).toBe("absent");
    const report = reportFor(read);
    expect(report.totals.humanMs).toBe(0);
    expect(report.totals.coverage).toEqual({ complete: false, missingHosts: ["stage"] });
    expect(report.days[0]!.missingSource).toEqual(["unread-source"]);
  });

  test("an export that ends before the day does not cover it", () => {
    hostsFile([{ id: "stage" }]);
    stageExport([], DAY.start - 86_400_000, DAY.start + 3_600_000);
    const report = reportFor(readHumanInputs({ start: DAY.start, end: NOW }, NOW, { dir: () => dir, readLedger: quietLedger }));
    expect(report.days[0]!.coverage.complete).toBe(false);
    expect(report.days[0]!.unknown).toEqual([{ start: DAY.start + 3_600_000, end: NOW }]);
  });

  test("a file naming another host covers nothing, and a host found only by its export directory is expected", () => {
    stageExport([stageInput("2026-09-23T09:00:00Z", "z")], DAY.start, NOW, "stage", "mislabelled.jsonl");
    fs.renameSync(path.join(dir, "hosts", "stage"), path.join(dir, "hosts", "build-box"));
    const read = readHumanInputs({ start: DAY.start, end: NOW }, NOW, { dir: () => dir, readLedger: quietLedger });
    const box = read.hosts.find((host) => host.host === "build-box")!;
    expect(box.configured).toBe(false);
    expect(box.sources[0]!.state).toBe("unreadable");
    expect(read.inputs).toEqual([]);
    expect(reportFor(read).totals.coverage.missingHosts).toEqual(["build-box"]);
  });

  test("the same message exported by both hosts counts once", () => {
    hostsFile([{ id: "stage" }]);
    stageExport([stageInput("2026-09-23T09:00:00Z", "shared-id")]);
    const local = path.join(dir, "hosts", "workstation");
    fs.mkdirSync(local, { recursive: true });
    fs.writeFileSync(path.join(local, "copy.jsonl"), exportLines(
      { host: "workstation", coveredFrom: DAY.start, coveredUntil: NOW, exportedAt: NOW, records: 1, excluded: {} },
      [{ ...stageInput("2026-09-23T09:00:30Z", "shared-id"), host: "workstation" }],
    ));
    expect(readHumanInputs({ start: DAY.start, end: NOW }, NOW, { dir: () => dir, readLedger: quietLedger }).inputs).toHaveLength(1);
  });

  test("the hosts file is read leniently", () => {
    expect(readHostsConfig(dir)).toMatchObject({ state: "absent", local: { id: "local" }, hosts: [] });
    fs.writeFileSync(path.join(dir, "hosts.json"), "{not json");
    expect(readHostsConfig(dir).state).toBe("unreadable");
    hostsFile([{ id: "Bad Id" }, { id: "stage", projects: ["client-a"], since: "2026-09-20" }, { id: "stage" }]);
    expect(readHostsConfig(dir).hosts).toEqual([{ id: "stage", label: null, projects: "all", since: null }]);
  });
});
