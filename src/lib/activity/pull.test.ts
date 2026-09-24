import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readAgentConversations } from "./agentSource";
import { readHumanInputs } from "./hostSources";
import { ingestTranscripts } from "./ingest";
import { localTransport, pullHost, type PullConfig } from "./pull";
import { ActivityStore, LOCAL_HOST_KEY } from "./store";
import type { ConversationResolution } from "./transcriptExport";

/* Two invented hosts on one disk: a "stage" host whose own ingest recorded
   its transcripts, and this host, which pulls them. The transport runs the
   real reader with a local Bun, which is what ssh runs on the other side. */

let dir: string;
let remoteState: string;
let localStoreFile: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "activity-pull-"));
  remoteState = path.join(dir, "stage", "state");
  localStoreFile = path.join(dir, "local", "state", "activity", "records.sqlite");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const NOW = Date.parse("2026-09-23T12:00:00Z");
const DAY = { start: Date.parse("2026-09-22T21:00:00Z"), end: Date.parse("2026-09-23T21:00:00Z") };
const mark = (key: string) => `<!-- llv:structured-user ctx=o.${key.padEnd(43, "A")}.${"B".repeat(16)} -->\n`;
const config = (): PullConfig => ({ ssh: "stage-box", bun: null, stateDir: remoteState, everyMin: 5 });

/** The stage host's own ingest over one Codex session with three operator
    messages and two agent turns. */
async function stageRecords(extra = 0): Promise<void> {
  const file = path.join(dir, "stage", "sessions", "rollout-stage.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const at = (minute: number) => new Date(Date.parse("2026-09-23T08:00:00Z") + minute * 60_000).toISOString();
  const rows: unknown[] = [{ timestamp: at(0), type: "session_meta", payload: { cwd: "/srv/client-a", originator: "llv-structured-host" } }];
  for (let index = 0; index < 3 + extra; index += 1) {
    rows.push({ timestamp: at(index * 20), type: "event_msg", payload: { type: "task_started" } });
    rows.push({ timestamp: at(index * 20 + 1), type: "response_item", payload: { type: "message", role: "user", id: `s-${index}`, content: [{ type: "input_text", text: `${mark(`S${index}`)}step ${index}` }] } });
    rows.push({ timestamp: at(index * 20 + 9), type: "event_msg", payload: { type: "task_complete" } });
  }
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const store = ActivityStore.open(path.join(remoteState, "activity", "records.sqlite"));
  try {
    const stat = fs.statSync(file);
    await ingestTranscripts([{ path: file, engine: "codex", size: stat.size, mtimeMs: stat.mtimeMs }], {
      complete: true,
      listedAt: NOW,
      now: () => NOW,
      store,
      resolver: () => (): ConversationResolution => ({ project: "client-a", launch: "operator", registered: true, conversation: "stage-conversation", agent: { role: "builder", pipelineId: null, stageId: null } }),
    });
  } finally {
    store.close();
  }
}

async function pull(pageRows?: number) {
  const store = ActivityStore.open(localStoreFile);
  try {
    return await pullHost(store, "stage", config(), localTransport(), () => NOW, pageRows);
  } finally {
    store.close();
  }
}

function local<T>(read: (store: ActivityStore) => T): T {
  const store = ActivityStore.open(localStoreFile);
  try {
    return read(store);
  } finally {
    store.close();
  }
}

describe("pulling another host's records", () => {
  test("the pull is idempotent: a second pull and a replay from the start change nothing", async () => {
    await stageRecords();
    const first = await pull();
    expect(first).toMatchObject({ ok: true, error: null });
    expect(first.rows).toBe(6);
    expect(local((store) => [store.count("stage"), store.turns("stage", 0, NOW).length, store.count(LOCAL_HOST_KEY)])).toEqual([3, 3, 0]);
    const state = local((store) => store.hostState("stage"))!;
    expect(state).toMatchObject({ coveredUntil: NOW, readAt: NOW, error: null });

    expect(await pull()).toMatchObject({ ok: true, rows: 0, changed: 0 });
    /* A replay of everything, as after a lost cursor. */
    local((store) => store.setHostState("stage", { cursor: 0 }));
    expect(await pull()).toMatchObject({ ok: true, rows: 6, changed: 0 });
    expect(local((store) => [store.count("stage"), store.turns("stage", 0, NOW).length])).toEqual([3, 3]);
  });

  test("a pull in pages takes the host's read span only with its last page", async () => {
    await stageRecords(2);
    const result = await pull(2);
    expect(result.ok).toBeTrue();
    expect(result.pages).toBeGreaterThan(3);
    expect(local((store) => store.count("stage"))).toBe(5);
    expect(local((store) => store.hostState("stage"))!.coveredUntil).toBe(NOW);
  });

  test("a host with no ingest yet is named, and what was read before stays", async () => {
    await stageRecords();
    await pull();
    fs.rmSync(path.join(remoteState, "activity"), { recursive: true, force: true });
    expect(await pull()).toMatchObject({ ok: false, error: "no-ingest" });
    expect(local((store) => store.hostState("stage"))).toMatchObject({ coveredUntil: NOW, error: "no-ingest" });
    expect(local((store) => store.count("stage"))).toBe(3);
  });

  test("pulled records reach both axes: the stage host's input with its coverage, and its agent turns", async () => {
    await stageRecords();
    await pull();
    const activityDir = path.join(dir, "local", "state", "activity");
    fs.writeFileSync(path.join(activityDir, "hosts.json"), JSON.stringify({ v: 1, local: { id: "workstation" }, hosts: [{ id: "stage", pull: { ssh: "stage-box" } }] }));
    const read = readHumanInputs({ start: DAY.start, end: NOW }, NOW, {
      dir: () => activityDir,
      readLedger: () => ({ rows: [], ledgerStartMs: null }),
      store: () => ActivityStore.openReadOnly(localStoreFile),
    });
    expect(read.inputs.filter((input) => input.host === "stage")).toHaveLength(3);
    const stage = read.hosts.find((host) => host.host === "stage")!;
    expect(stage.sources.map((source) => `${source.source}:${source.state}`)).toEqual(["pull:read"]);
    expect(stage.sources[0]!.readAt).toBe(NOW);
    expect(read.coverage.find((host) => host.host === "stage")!.covered).toEqual([{ start: Date.parse("2026-09-23T08:01:00Z"), end: NOW }]);

    const agents = readAgentConversations(DAY, NOW, {
      /* This host has not been ingested here, so its own turns come from the index, which is empty. */
      read: () => ({ available: false, rows: [], files: new Map(), indexedAtMs: null }),
      registrySnapshot: () => { throw new Error("unused"); },
      canonicalProject: (project) => project,
      store: () => ActivityStore.openReadOnly(localStoreFile),
      pulledHosts: () => ["stage"],
    });
    const conversation = agents.agents.find((agent) => agent.key.startsWith("stage:"))!;
    expect(conversation).toMatchObject({ project: "client-a", engine: "codex", role: "builder" });
    expect(conversation.activity.reduce((total, span) => total + span.end - span.start, 0)).toBe(3 * 9 * 60_000);
  });
});
