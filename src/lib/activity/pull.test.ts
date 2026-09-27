import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { readAgentConversations } from "./agentSource";
import { conversationResolver } from "./conversationResolver";
import { readHumanInputs } from "./hostSources";
import { activityReport, clampMethodParams } from "./method";
import { ingestTranscripts } from "./ingest";
import { localTransport, pullHost, type PullConfig } from "./pull";
import { ActivityStore, LOCAL_HOST_KEY } from "./store";
import type { ConversationResolution } from "./transcriptExport";
import { deliveryDedupToken } from "@/lib/runtime/deliveryDedup";
import type { RegistryFile } from "@/lib/agent/registry";
import { TeamStore, resetTeamStoreForTests } from "@/lib/team/store";

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
const MEMBER_A = "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MEMBER_B = "m_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

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

async function pullWith(configured: PullConfig, transport = localTransport()) {
  const store = ActivityStore.open(localStoreFile);
  try { return await pullHost(store, "stage", configured, transport, () => NOW); }
  finally { store.close(); }
}

async function teamStageRecords(): Promise<void> {
  const file = path.join(dir, "stage", "sessions", "team.jsonl");
  const terminal = path.join(dir, "stage", "sessions", "typed.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sent = (minute: number, member: "a" | "b") => ({
    timestamp: new Date(Date.parse("2026-09-23T08:00:00Z") + minute * 60_000).toISOString(),
    type: "response_item", payload: { type: "message", role: "user", id: `message-${member}`,
      content: [{ type: "input_text", text: `<!-- llv:structured-user origin=operator dedup=${deliveryDedupToken(`queue-${member}-v1`)} -->\nmessage ${member}` }] },
  });
  fs.writeFileSync(file, [
    { timestamp: "2026-09-23T07:59:00Z", type: "session_meta", payload: { cwd: "/work/harbor", originator: "llv-structured-host" } },
    sent(1, "a"), sent(30, "b"),
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  fs.writeFileSync(terminal, JSON.stringify({ type: "user", timestamp: "2026-09-23T09:00:00Z", uuid: "typed-1", promptSource: "typed",
    entrypoint: "cli", cwd: "/work/harbor", message: { role: "user", content: "typed terminal prompt" } }) + "\n");
  const team = new TeamStore(path.join(remoteState, "team", "team.sqlite"));
  for (const [id, role] of [[MEMBER_A, "owner"], [MEMBER_B, "member"]] as const) {
    team.insertMember({ id, name: role, role, status: "active", color: "teal", telegram: null,
      createdAt: "2026-09-23T00:00:00Z", createdBy: "claim", revokedAt: null });
  }
  for (const [id, memberId] of [["queue-a-v1", MEMBER_A], ["queue-b-v1", MEMBER_B]] as const) {
    team.recordMessageAuthor({ clientMessageId: id, conversationId: "conversation_team", memberId,
      at: "2026-09-23T08:00:00Z", textDigest: null });
  }
  team.close();
  const previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = remoteState;
  try {
    const snapshot = { conversations: { conversation_team: {
      id: "conversation_team", generations: [{ path: file, launchProfile: { cwd: "/work/harbor" } }],
      continuityPaths: [], projectOwnership: null, delegationDepth: 0, agentRole: null,
    } }, memberships: {}, lineageEdges: {}, conversationAliases: {} } as unknown as RegistryFile;
    const store = ActivityStore.open(path.join(remoteState, "activity", "records.sqlite"));
    try {
      const sources = [file, terminal].map((filename) => {
        const stat = fs.statSync(filename);
        return { path: filename, engine: filename === file ? "codex" : "claude", size: stat.size, mtimeMs: stat.mtimeMs };
      });
      await ingestTranscripts(sources, { complete: true, listedAt: NOW, now: () => NOW, store, resolver: () => conversationResolver(snapshot) });
    } finally { store.close(); }
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    resetTeamStoreForTests();
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
  test("the activity writer adds author to an existing store without losing rows", async () => {
    await stageRecords();
    const file = path.join(remoteState, "activity", "records.sqlite");
    const old = new Database(file);
    old.exec(`ALTER TABLE activity_inputs DROP COLUMN author;
      ALTER TABLE activity_hosts DROP COLUMN remote_mode;
      ALTER TABLE activity_hosts DROP COLUMN pulled_member;
      ALTER TABLE activity_hosts DROP COLUMN unknown_authors;
      PRAGMA user_version = 1`);
    old.close();
    const upgraded = ActivityStore.open(file);
    expect(upgraded.localRowsAfter(0, 10)).toHaveLength(3);
    expect(upgraded.localRowsAfter(0, 10).every((row) => row.author === null)).toBeTrue();
    expect(upgraded.db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(2);
    upgraded.close();
  });

  test("team ingest and pull keep only the selected member; terminal input stays unknown", async () => {
    await teamStageRecords();
    const remote = ActivityStore.open(path.join(remoteState, "activity", "records.sqlite"));
    const authors = remote.localRowsAfter(0, 10).map((row) => row.author).sort();
    remote.close();
    expect(authors).toEqual([null, MEMBER_A, MEMBER_B].sort());

    const own = readHumanInputs(DAY, NOW, { dir: () => path.join(remoteState, "activity"),
      readLedger: () => ({ rows: [], ledgerStartMs: null }),
      store: () => ActivityStore.openReadOnly(path.join(remoteState, "activity", "records.sqlite")) },
    { mode: "team", memberId: MEMBER_A });
    expect(own.inputs.map((row) => row.author)).toEqual([MEMBER_A]);
    expect(own.unknownAuthors).toBe(1);
    const anonymous = readHumanInputs(DAY, NOW, { dir: () => path.join(remoteState, "activity"),
      readLedger: () => ({ rows: [], ledgerStartMs: null }),
      store: () => ActivityStore.openReadOnly(path.join(remoteState, "activity", "records.sqlite")) },
    { mode: "team", memberId: null });
    expect(anonymous.inputs).toEqual([]);
    expect(anonymous.hosts[0]?.configurationGap).toBeTrue();
    expect(anonymous.coverage[0]?.covered).toEqual([]);

    const missing = config();
    expect(await pullWith(missing)).toMatchObject({ ok: true });
    expect(local((store) => store.count("stage"))).toBe(0);
    expect(local((store) => store.hostState("stage"))).toMatchObject({ error: "member-unconfigured", unknownAuthors: 1 });
    const activityDir = path.join(dir, "local", "state", "activity");
    fs.writeFileSync(path.join(activityDir, "hosts.json"), JSON.stringify({ v: 1, local: { id: "workstation" }, hosts: [{ id: "stage", pull: { ssh: "stage-box" } }] }));
    const gap = readHumanInputs(DAY, NOW, { dir: () => activityDir, readLedger: () => ({ rows: [], ledgerStartMs: null }),
      store: () => ActivityStore.openReadOnly(localStoreFile) });
    expect(gap.hosts.find((host) => host.host === "stage")).toMatchObject({ configurationGap: true, unknownAuthors: 1 });
    expect(gap.coverage.find((host) => host.host === "stage")?.covered).toEqual([]);
    const selected = { ...config(), memberId: MEMBER_A };
    let output = "";
    const transport = async (env: Record<string, string>, script: string) => {
      const answer = await localTransport()(env, script);
      output += answer.stdout;
      return answer;
    };
    expect(await pullWith(selected, transport)).toMatchObject({ ok: true });
    expect(local((store) => store.candidates("stage", DAY.start, NOW, "stage").map((row) => row.author))).toEqual([MEMBER_A]);
    expect(output).not.toContain(MEMBER_B);
    expect(output).not.toContain("typed terminal prompt");
    fs.writeFileSync(path.join(activityDir, "hosts.json"), JSON.stringify({ v: 1, local: { id: "workstation" }, hosts: [{ id: "stage", pull: { ssh: "stage-box", memberId: MEMBER_A } }] }));
    const read = readHumanInputs(DAY, NOW, { dir: () => activityDir, readLedger: () => ({ rows: [], ledgerStartMs: null }),
      store: () => ActivityStore.openReadOnly(localStoreFile) });
    expect(read.inputs.filter((row) => row.host === "stage")).toHaveLength(1);
    expect(read.unknownAuthors).toBe(1);
    const report = activityReport({ params: clampMethodParams({}), range: "today", nowMs: NOW,
      anchors: read.inputs.map((row) => ({ at: row.at, project: row.project, surface: row.surface, kind: row.kind, host: row.host })),
      hosts: read.coverage, agents: [] });
    expect(report.totals.requests).toBe(1);
    expect(await pullWith({ ...config(), memberId: MEMBER_B })).toMatchObject({ ok: true });
    expect(local((store) => store.candidates("stage", DAY.start, NOW, "stage").map((row) => row.author))).toEqual([MEMBER_B]);
  });

  test("a legacy remote schema supplies solo rows and only an unknown count on a team host", async () => {
    await stageRecords();
    const file = path.join(remoteState, "activity", "records.sqlite");
    const db = new Database(file);
    db.exec("ALTER TABLE activity_inputs DROP COLUMN author; PRAGMA user_version = 1");
    db.close();
    expect(await pull()).toMatchObject({ ok: true });
    expect(local((store) => store.count("stage"))).toBe(3);
    const team = new TeamStore(path.join(remoteState, "team", "team.sqlite"));
    team.insertMember({ id: MEMBER_A, name: "Owner", role: "owner", status: "active", color: "teal", telegram: null,
      createdAt: "2026-09-23T00:00:00Z", createdBy: "claim", revokedAt: null });
    team.close();
    expect(await pullWith({ ...config(), memberId: MEMBER_A })).toMatchObject({ ok: true });
    expect(local((store) => [store.count("stage"), store.hostState("stage")?.unknownAuthors])).toEqual([0, 3]);
  });
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

  test("a recreated remote store is read again whole, and its rows replace the old ones", async () => {
    await stageRecords();
    await pull();
    /* The stage host loses its store and records one session again, now with
       one more step: its versions restart below the cursor held here. */
    fs.rmSync(path.join(remoteState, "activity"), { recursive: true, force: true });
    await stageRecords(1);
    expect(await pull()).toMatchObject({ ok: true, rows: 8 });
    expect(local((store) => [store.count("stage"), store.turns("stage", 0, NOW).length])).toEqual([4, 4]);
  });
});
