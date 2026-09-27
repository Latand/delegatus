import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { Database } from "bun:sqlite";

import { readAgentConversations } from "./agentSource";
import { conversationResolver } from "./conversationResolver";
import { exportLines, ledgerRowKey, requestKey } from "./humanInput";
import { readHumanInputs } from "./hostSources";
import { activityReport, clampMethodParams } from "./method";
import { readRequests, recordOperatorRequest } from "./requestLedger";
import { ingestTranscripts } from "./ingest";
import { localTransport, pullHost, type PullConfig } from "./pull";
import { ActivityStore, LOCAL_HOST_KEY } from "./store";
import { exportHumanInputs, listTranscriptFiles, type ConversationResolution } from "./transcriptExport";
import { deliveryDedupToken } from "@/lib/runtime/deliveryDedup";
import { FileClaudeDeliveryLedger } from "@/lib/runtime/claudeStreamBrokerHost";
import { AgentRegistry, closeAgentRegistryForTests, type RegistryFile } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { TeamStore, resetTeamStoreForTests, teamStore } from "@/lib/team/store";
import { mintSession } from "@/lib/team/sessions";

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
afterEach(() => {
  closeAgentRegistryForTests();
  fs.rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.parse("2026-09-23T12:00:00Z");
const DAY = { start: Date.parse("2026-09-22T21:00:00Z"), end: Date.parse("2026-09-23T21:00:00Z") };
const mark = (key: string) => `<!-- llv:structured-user ctx=o.${key.padEnd(43, "A")}.${"B".repeat(16)} -->\n`;
const config = (): PullConfig => ({ ssh: "stage-box", bun: null, stateDir: remoteState, everyMin: 5 });
const MEMBER_A = "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MEMBER_B = "m_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const LOCAL_MEMBER = "m_cccccccccccccccccccccccccccccccc";

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

async function teamStageRecords(includeAnonymous = false, revokeOwnerBeforeIngest = false): Promise<void> {
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
    ...(includeAnonymous ? [{ timestamp: "2026-09-23T08:50:00Z", type: "response_item", payload: {
      type: "message", role: "user", id: "anonymous-message",
      content: [{ type: "input_text", text: "<!-- llv:structured-user origin=operator -->\nanonymous delivered input" }],
    } }] : []),
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
  if (revokeOwnerBeforeIngest) {
    const owner = team.member(MEMBER_A)!;
    team.updateMember({ ...owner, status: "revoked", revokedAt: "2026-09-23T10:00:00Z" });
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
  test("a fresh solo export counts its operator without a host mode setting", async () => {
    const transcript = path.join(dir, "stage", "sessions", "solo.jsonl");
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, JSON.stringify({ type: "user", timestamp: "2026-09-23T09:00:00Z",
      uuid: "typed-solo", promptSource: "typed", entrypoint: "cli", cwd: "/work/harbor",
      message: { role: "user", content: "typed solo prompt" } }) + "\n");
    const previous = process.env.LLV_STATE_DIR;
    process.env.LLV_STATE_DIR = remoteState;
    let exported: Awaited<ReturnType<typeof exportHumanInputs>>;
    try {
      exported = await exportHumanInputs({ host: "stage", from: DAY.start, to: NOW, now: NOW,
        files: listTranscriptFiles([path.dirname(transcript)], DAY.start), resolve: conversationResolver(null) });
    } finally {
      resetTeamStoreForTests();
      if (previous === undefined) delete process.env.LLV_STATE_DIR;
      else process.env.LLV_STATE_DIR = previous;
    }
    expect(exported.inputs.map((input) => input.author)).toEqual(["operator"]);
    const activityDir = path.join(dir, "local", "state", "activity");
    const exportsDir = path.join(activityDir, "hosts", "stage");
    fs.mkdirSync(exportsDir, { recursive: true });
    fs.writeFileSync(path.join(exportsDir, "solo.jsonl"), exportLines(exported.manifest, exported.inputs));
    fs.writeFileSync(path.join(activityDir, "hosts.json"), JSON.stringify({ v: 1, local: { id: "workstation" },
      hosts: [{ id: "stage" }] }));
    const read = readHumanInputs(DAY, NOW, { dir: () => activityDir,
      readLedger: () => ({ rows: [], ledgerStartMs: null }), store: () => null }, { mode: "solo", memberId: null });
    expect(read.inputs.map((input) => input.author)).toEqual(["operator"]);
    expect(read.hosts.find((host) => host.host === "stage")).toMatchObject({
      configurationGap: false, unknownAuthors: 0, sources: [{ source: "transcripts", inputs: 1 }],
    });
    expect(read.coverage.find((host) => host.host === "stage")?.covered).toEqual([{ start: DAY.start, end: NOW }]);
    const report = activityReport({ params: clampMethodParams({}), range: "today", nowMs: NOW,
      anchors: read.inputs.map((input) => ({ at: input.at, project: input.project, surface: input.surface, kind: input.kind, host: input.host })),
      hosts: read.coverage, agents: [] });
    expect(report.totals.requests).toBe(1);
    expect(report.totals.humanMs).toBe(10 * 60_000);
  });

  test("the activity writer adds author to an existing store without losing rows", async () => {
    await stageRecords();
    const file = path.join(remoteState, "activity", "records.sqlite");
    const old = new Database(file);
    old.exec(`ALTER TABLE activity_inputs DROP COLUMN author;
      ALTER TABLE activity_hosts DROP COLUMN remote_mode;
      ALTER TABLE activity_hosts DROP COLUMN team_history;
      ALTER TABLE activity_hosts DROP COLUMN pulled_member;
      ALTER TABLE activity_hosts DROP COLUMN unknown_authors;
      PRAGMA user_version = 1`);
    old.close();
    const upgraded = ActivityStore.open(file);
    expect(upgraded.localRowsAfter(0, 10)).toHaveLength(3);
    expect(upgraded.localRowsAfter(0, 10).every((row) => row.author === null)).toBeTrue();
    expect(upgraded.db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(3);
    upgraded.close();
  });

  test("migration retains team history from member-authored rows", async () => {
    await teamStageRecords(false, true);
    const file = path.join(remoteState, "activity", "records.sqlite");
    const old = new Database(file);
    old.exec("ALTER TABLE activity_hosts DROP COLUMN team_history; PRAGMA user_version = 2");
    old.close();
    const upgraded = ActivityStore.open(file);
    expect(upgraded.localRowsAfter(0, 10)).toHaveLength(3);
    expect(upgraded.hostState(LOCAL_HOST_KEY)?.teamHistory).toBeTrue();
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
    const ambientMember = process.env.LLV_ACTIVITY_MEMBER;
    process.env.LLV_ACTIVITY_MEMBER = MEMBER_A;
    try {
      expect(await pullWith(missing)).toMatchObject({ ok: true });
    } finally {
      if (ambientMember === undefined) delete process.env.LLV_ACTIVITY_MEMBER;
      else process.env.LLV_ACTIVITY_MEMBER = ambientMember;
    }
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

  test("a configured member change leaves old remote coverage pending until repulled", async () => {
    await teamStageRecords();
    expect(await pullWith({ ...config(), memberId: MEMBER_A })).toMatchObject({ ok: true });
    const activityDir = path.join(dir, "local", "state", "activity");
    fs.writeFileSync(path.join(activityDir, "hosts.json"), JSON.stringify({ v: 1, local: { id: "workstation" },
      hosts: [{ id: "stage", pull: { ssh: "stage-box", memberId: MEMBER_B } }] }));
    const sources = { dir: () => activityDir,
      readLedger: () => ({ rows: [], ledgerStartMs: null }),
      store: () => ActivityStore.openReadOnly(localStoreFile) };
    const pending = readHumanInputs(DAY, NOW, sources);
    expect(pending.inputs.filter((input) => input.host === "stage")).toEqual([]);
    expect(pending.coverage.find((host) => host.host === "stage")?.covered).toEqual([]);
    expect(pending.hosts.find((host) => host.host === "stage")).toMatchObject({
      configurationGap: false, sources: [{ source: "pull", state: "pending", inputs: 0 }],
    });
    expect(await pullWith({ ...config(), memberId: MEMBER_B })).toMatchObject({ ok: true });
    const complete = readHumanInputs(DAY, NOW, sources);
    expect(complete.inputs.filter((input) => input.host === "stage").map((input) => input.author)).toEqual([MEMBER_B]);
    expect(complete.coverage.find((host) => host.host === "stage")?.covered).not.toEqual([]);
  });

  test("pre-team solo input becomes unknown after team enrollment locally and remotely", async () => {
    await stageRecords();
    const team = new TeamStore(path.join(remoteState, "team", "team.sqlite"));
    team.insertMember({ id: MEMBER_A, name: "Owner", role: "owner", status: "active", color: "teal", telegram: null,
      createdAt: "2026-09-23T10:00:00Z", createdBy: "claim", revokedAt: null });
    team.close();
    const previous = process.env.LLV_STATE_DIR;
    process.env.LLV_STATE_DIR = remoteState;
    try {
      const activityDir = path.join(remoteState, "activity");
      const read = readHumanInputs(DAY, NOW, { dir: () => activityDir,
        readLedger: () => ({ rows: [], ledgerStartMs: null }),
        store: () => ActivityStore.openReadOnly(path.join(activityDir, "records.sqlite")) },
      { mode: "team", memberId: MEMBER_A });
      expect(read.inputs).toEqual([]);
      expect(read.unknownAuthors).toBe(3);
    } finally {
      resetTeamStoreForTests();
      if (previous === undefined) delete process.env.LLV_STATE_DIR;
      else process.env.LLV_STATE_DIR = previous;
    }
    expect(await pullWith({ ...config(), memberId: MEMBER_A })).toMatchObject({ ok: true });
    expect(local((store) => [store.count("stage"), store.hostState("stage")?.unknownAuthors])).toEqual([0, 3]);
    let stdout = "";
    const transport = async (env: Record<string, string>, script: string) => {
      const answer = await localTransport()(env, script);
      stdout += answer.stdout;
      return answer;
    };
    expect(await pullWith({ ...config(), memberId: "operator" }, transport)).toMatchObject({ ok: true });
    expect(stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string })
      .filter((line) => line.type === "input")).toEqual([]);
    expect(local((store) => [store.count("stage"), store.hostState("stage")?.unknownAuthors,
      store.hostState("stage")?.error])).toEqual([0, 3, "member-unconfigured"]);
  });

  test("a local team member's figure excludes the owner's pulled remote inputs", async () => {
    await teamStageRecords();
    expect(await pullWith({ ...config(), memberId: MEMBER_A })).toMatchObject({ ok: true });
    const localState = path.join(dir, "local", "state");
    const activityDir = path.join(localState, "activity");
    fs.writeFileSync(path.join(activityDir, "hosts.json"), JSON.stringify({ v: 1, local: { id: "workstation" },
      hosts: [{ id: "stage", pull: { ssh: "stage-box", memberId: MEMBER_A } }] }));
    const team = new TeamStore(path.join(localState, "team", "team.sqlite"));
    for (const [id, role] of [[LOCAL_MEMBER, "owner"], [MEMBER_B, "member"]] as const) {
      team.insertMember({ id, name: role, role, status: "active", color: "teal", telegram: null,
        createdAt: "2026-09-23T00:00:00Z", createdBy: "claim", revokedAt: null });
    }
    team.close();
    const previous = process.env.LLV_STATE_DIR;
    process.env.LLV_STATE_DIR = localState;
    try {
      const sources = { dir: () => activityDir,
        readLedger: () => ({ rows: [], ledgerStartMs: null }),
        store: () => ActivityStore.openReadOnly(localStoreFile) };
      const member = readHumanInputs(DAY, NOW, sources, { mode: "team", memberId: MEMBER_B });
      expect(member.inputs).toEqual([]);
      expect(member.hosts.map((host) => host.host)).toEqual(["workstation"]);
      expect(member.unknownAuthors).toBe(0);
      const report = activityReport({ params: clampMethodParams({}), range: "today", nowMs: NOW,
        anchors: member.inputs.map((input) => ({ at: input.at, project: input.project, surface: input.surface, kind: input.kind, host: input.host })),
        hosts: member.coverage, agents: [] });
      expect(report.totals.requests).toBe(0);
      expect(report.totals.humanMs).toBe(0);
      const owner = readHumanInputs(DAY, NOW, sources, { mode: "team", memberId: LOCAL_MEMBER });
      expect(owner.inputs.map((input) => [input.host, input.author])).toEqual([["stage", MEMBER_A]]);
    } finally {
      resetTeamStoreForTests();
      if (previous === undefined) delete process.env.LLV_STATE_DIR;
      else process.env.LLV_STATE_DIR = previous;
    }
  });

  test("a member's first spawn prompt is attributed through ingest and remote pull", async () => {
    const file = path.join(dir, "stage", "sessions", "spawn-first.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const registry = new AgentRegistry(path.join(remoteState, "registry.json"), undefined, undefined, { sqliteMode: "off" });
    const previous = process.env.LLV_STATE_DIR;
    process.env.LLV_STATE_DIR = remoteState;
    try {
      const begun = registry.beginSpawnRequest({ engine: "codex", cwd: "/work/harbor", transport: "structured",
        clientAttemptId: "codex_spawn_activity_20260928",
        accountId: "work", launchProfile: emptyLaunchProfile({ cwd: "/work/harbor", title: "Inspect harbor work" }) });
      if (begun.kind !== "created") throw new Error("spawn receipt was not created");
      const spawnId = `spawn_${begun.receipt.launchId}`;
      const operationId = `spawn_message_${begun.receipt.launchId}`;
      const settled = registry.settleSpawn(begun.receipt.launchId, { key: { engine: "codex", sessionId: crypto.randomUUID() },
        artifactPath: file, cwd: "/work/harbor", accountId: "work", status: "starting", host: null,
        claimEpoch: 0, claimOwner: null, pendingAction: "spawn" });
      if (settled.kind !== "settled") throw new Error("spawn receipt was not settled");
      registry.holdDelivery(begun.receipt.conversationId, "inspect", spawnId, "text", [], null,
        { operationId, kind: "send", policy: "queue" });
      const team = teamStore();
      team.insertMember({ id: MEMBER_A, name: "Owner", role: "owner", status: "active", color: "teal", telegram: null,
        createdAt: "2026-09-23T00:00:00Z", createdBy: "claim", revokedAt: null });
      team.recordMessageAuthor({ clientMessageId: spawnId, conversationId: begun.receipt.conversationId,
        memberId: MEMBER_A, at: "2026-09-23T08:00:00Z", textDigest: null });
      const session = mintSession(team, MEMBER_A, "claim", { surface: "desktop", browser: "chrome" });
      const ledger = recordOperatorRequest(new NextRequest("http://localhost/api/spawn", {
        headers: { host: "localhost", origin: "http://localhost", "sec-fetch-site": "same-origin",
          cookie: `llv_member=${session.value}` },
      }), { kind: "spawn", project: "harbor", idempotencyKey: "spawn:codex_spawn_activity_20260928" }, {
        now: () => Date.parse("2026-09-23T08:00:00Z"), dir: () => path.join(remoteState, "activity"),
      });
      expect(ledger?.author).toBe(MEMBER_A);
      fs.writeFileSync(file, [
        { timestamp: "2026-09-23T07:59:00Z", type: "session_meta", payload: { cwd: "/work/harbor", originator: "llv-structured-host" } },
        { timestamp: "2026-09-23T08:00:00Z", type: "response_item", payload: { type: "message", role: "user", id: "spawn-first",
          content: [{ type: "input_text", text: `<!-- llv:structured-user origin=operator dedup=${deliveryDedupToken(operationId)} -->\ninspect` }] } },
      ].map((row) => JSON.stringify(row)).join("\n") + "\n");
      const activity = ActivityStore.open(path.join(remoteState, "activity", "records.sqlite"));
      try {
        const stat = fs.statSync(file);
        await ingestTranscripts([{ path: file, engine: "codex", size: stat.size, mtimeMs: stat.mtimeMs }], {
          complete: true, listedAt: NOW, now: () => NOW, store: activity,
          resolver: () => conversationResolver(registry.readOnlySnapshot(), () => registry.readOnlySnapshot()),
        });
        expect(activity.localRowsAfter(0, 10).map((row) => row.author)).toEqual([MEMBER_A]);
        expect(activity.localRowsAfter(0, 10)[0]?.ids).toContain(requestKey("spawn:codex_spawn_activity_20260928"));
      } finally { activity.close(); }
      const activityDir = path.join(remoteState, "activity");
      const read = readHumanInputs(DAY, NOW, { dir: () => activityDir,
        readLedger: (from, to) => readRequests(from, to, { dir: () => activityDir }),
        store: () => ActivityStore.openReadOnly(path.join(activityDir, "records.sqlite")) },
      { mode: "team", memberId: MEMBER_A });
      expect(read.inputs).toHaveLength(1);
      expect(read.inputs[0]?.source).toBe("ledger");
    } finally {
      resetTeamStoreForTests();
      registry.close();
      if (previous === undefined) delete process.env.LLV_STATE_DIR;
      else process.env.LLV_STATE_DIR = previous;
    }
    expect(await pullWith({ ...config(), memberId: MEMBER_A })).toMatchObject({ ok: true });
    expect(local((store) => store.candidates("stage", DAY.start, NOW, "stage").map((row) => row.author))).toEqual([MEMBER_A]);
  });

  test("a Claude member's first spawn prompt keeps its author through ingest and remote pull", async () => {
    const sessionId = crypto.randomUUID();
    const file = path.join(dir, "stage", "sessions", `${sessionId}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const registry = new AgentRegistry(path.join(remoteState, "registry.json"), undefined, undefined, { sqliteMode: "off" });
    const previous = process.env.LLV_STATE_DIR;
    process.env.LLV_STATE_DIR = remoteState;
    try {
      const begun = registry.beginSpawnRequest({ engine: "claude", cwd: "/work/harbor", transport: "structured",
        accountId: "work", launchProfile: emptyLaunchProfile({ cwd: "/work/harbor", title: "Inspect harbor work" }) });
      if (begun.kind !== "created") throw new Error("spawn receipt was not created");
      const spawnId = `spawn_${begun.receipt.launchId}`;
      const operationId = `spawn_message_${begun.receipt.launchId}`;
      const settled = registry.settleSpawn(begun.receipt.launchId, { key: { engine: "claude", sessionId },
        artifactPath: file, cwd: "/work/harbor", accountId: "work", status: "starting", host: null,
        claimEpoch: 0, claimOwner: null, pendingAction: "spawn" });
      if (settled.kind !== "settled") throw new Error("spawn receipt was not settled");
      registry.holdDelivery(begun.receipt.conversationId, "inspect", spawnId, "text", [], null,
        { operationId, kind: "send", policy: "queue" });
      const ledger = new FileClaudeDeliveryLedger();
      ledger.recordQueued(sessionId, { id: operationId, text: "inspect" }, "turn-started");
      ledger.confirmDelivered(sessionId, operationId, "engine-spawn-first");
      const team = teamStore();
      team.insertMember({ id: MEMBER_A, name: "Owner", role: "owner", status: "active", color: "teal", telegram: null,
        createdAt: "2026-09-23T00:00:00Z", createdBy: "claim", revokedAt: null });
      team.recordMessageAuthor({ clientMessageId: spawnId, conversationId: begun.receipt.conversationId,
        memberId: MEMBER_A, at: "2026-09-23T08:00:00Z", textDigest: null });
      fs.writeFileSync(file, JSON.stringify({ type: "user", timestamp: "2026-09-23T08:00:00Z",
        uuid: "engine-spawn-first", sessionId, cwd: "/work/harbor", entrypoint: "sdk",
        message: { role: "user", content: "inspect" } }) + "\n");
      const activity = ActivityStore.open(path.join(remoteState, "activity", "records.sqlite"));
      try {
        const stat = fs.statSync(file);
        await ingestTranscripts([{ path: file, engine: "claude", size: stat.size, mtimeMs: stat.mtimeMs }], {
          complete: true, listedAt: NOW, now: () => NOW, store: activity,
          resolver: () => conversationResolver(registry.readOnlySnapshot(), () => registry.readOnlySnapshot()),
        });
        expect(activity.localRowsAfter(0, 10).map((row) => row.author)).toEqual([MEMBER_A]);
      } finally { activity.close(); }
    } finally {
      resetTeamStoreForTests();
      registry.close();
      if (previous === undefined) delete process.env.LLV_STATE_DIR;
      else process.env.LLV_STATE_DIR = previous;
    }
    expect(await pullWith({ ...config(), memberId: MEMBER_A })).toMatchObject({ ok: true });
    expect(local((store) => store.candidates("stage", DAY.start, NOW, "stage").map((row) => row.author))).toEqual([MEMBER_A]);
  });

  test("an interrupted member change does not keep the previous member's coverage", async () => {
    await teamStageRecords();
    expect(await pullWith({ ...config(), memberId: MEMBER_A })).toMatchObject({ ok: true });
    expect(local((store) => store.hostState("stage")?.coveredUntil)).toBe(NOW);
    const real = localTransport();
    let calls = 0;
    const transport = async (env: Record<string, string>, script: string) => {
      calls += 1;
      return calls === 3 ? { code: 1, stdout: "", timedOut: false } : real(env, script);
    };
    const store = ActivityStore.open(localStoreFile);
    try {
      expect(await pullHost(store, "stage", { ...config(), memberId: MEMBER_B }, transport, () => NOW, 1))
        .toMatchObject({ ok: false, error: "unreachable" });
      expect(calls).toBe(3);
      expect(store.hostState("stage")).toMatchObject({ coveredFrom: null, coveredUntil: null, readAt: null });
    } finally { store.close(); }
    const activityDir = path.join(dir, "local", "state", "activity");
    fs.writeFileSync(path.join(activityDir, "hosts.json"), JSON.stringify({ v: 1, local: { id: "workstation" },
      hosts: [{ id: "stage", pull: { ssh: "stage-box", memberId: MEMBER_B } }] }));
    const read = readHumanInputs(DAY, NOW, { dir: () => activityDir,
      readLedger: () => ({ rows: [], ledgerStartMs: null }), store: () => ActivityStore.openReadOnly(localStoreFile) });
    expect(read.coverage.find((host) => host.host === "stage")?.covered).toEqual([]);
    expect(read.hosts.find((host) => host.host === "stage")?.sources[0]).toMatchObject({ state: "unreadable", error: "unreachable" });
  });

  test("the operator's differently named memberships dedupe one input across hosts", async () => {
    await teamStageRecords();
    expect(await pullWith({ ...config(), memberId: MEMBER_A })).toMatchObject({ ok: true });
    const file = path.join(dir, "local", "sessions", "same-input.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      { timestamp: "2026-09-23T08:00:00Z", type: "session_meta", payload: { cwd: "/work/harbor", originator: "llv-structured-host" } },
      { timestamp: "2026-09-23T08:01:00Z", type: "response_item", payload: { type: "message", role: "user", id: "message-a",
        content: [{ type: "input_text", text: `<!-- llv:structured-user origin=operator dedup=${deliveryDedupToken("queue-a-v1")} -->\nmessage a` }] } },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    const store = ActivityStore.open(localStoreFile);
    try {
      const stat = fs.statSync(file);
      await ingestTranscripts([{ path: file, engine: "codex", size: stat.size, mtimeMs: stat.mtimeMs }], {
        complete: true, listedAt: NOW, now: () => NOW, store,
        resolver: () => (): ConversationResolution => ({ project: "harbor", launch: "operator", registered: true,
          mode: "team", conversation: "local-conversation",
          deliveryOrigin: () => ({ origin: "operator", memberId: LOCAL_MEMBER }) }),
      });
    } finally { store.close(); }
    const activityDir = path.join(dir, "local", "state", "activity");
    fs.writeFileSync(path.join(activityDir, "hosts.json"), JSON.stringify({ v: 1, local: { id: "workstation" },
      hosts: [{ id: "stage", pull: { ssh: "stage-box", memberId: MEMBER_A } }] }));
    const read = readHumanInputs(DAY, NOW, { dir: () => activityDir,
      readLedger: () => ({ rows: [], ledgerStartMs: null }), store: () => ActivityStore.openReadOnly(localStoreFile) },
    { mode: "team", memberId: LOCAL_MEMBER });
    expect(read.inputs).toHaveLength(1);
  });

  test("an unrelated owner ledger request does not hide ingested unknown input", async () => {
    await teamStageRecords(true);
    const remote = ActivityStore.openReadOnly(path.join(remoteState, "activity", "records.sqlite"))!;
    expect(remote.localRowsAfter(0, 10).map((row) => row.author).sort()).toEqual([null, null, MEMBER_A, MEMBER_B].sort());
    remote.close();
    const previous = process.env.LLV_STATE_DIR;
    process.env.LLV_STATE_DIR = remoteState;
    try {
      const session = mintSession(teamStore(), MEMBER_A, "claim", { surface: "desktop", browser: "chrome" });
      const request = new NextRequest("http://localhost/api/tasks", { headers: {
        cookie: `llv_member=${session.value}`, "user-agent": "Mozilla/5.0 Chrome/140.0 Safari/537.36",
      } });
      const row = recordOperatorRequest(request, { kind: "task", project: "harbor", idempotencyKey: "unrelated-owner-action" }, {
        dir: () => path.join(remoteState, "activity"), now: () => Date.parse("2026-09-23T08:40:00Z"),
      });
      expect(row?.author).toBe(MEMBER_A);
      const read = readHumanInputs(DAY, NOW, {
        dir: () => path.join(remoteState, "activity"),
        readLedger: (from, to) => readRequests(from, to, { dir: () => path.join(remoteState, "activity") }),
        store: () => ActivityStore.openReadOnly(path.join(remoteState, "activity", "records.sqlite")),
      }, { mode: "team", memberId: MEMBER_A });
      expect(read.inputs).toHaveLength(2);
      expect(read.unknownAuthors).toBe(2);
      expect(read.hosts[0]?.unknownAuthors).toBe(2);
    } finally {
      resetTeamStoreForTests();
      if (previous === undefined) delete process.env.LLV_STATE_DIR;
      else process.env.LLV_STATE_DIR = previous;
    }
  });

  test("a matching legacy ledger row does not add unknown authors to known team input", async () => {
    await teamStageRecords();
    const activityDir = path.join(remoteState, "activity");
    const file = path.join(dir, "stage", "sessions", "legacy-match.jsonl");
    fs.writeFileSync(file, [
      { timestamp: "2026-09-23T09:29:00Z", type: "session_meta", payload: { cwd: "/work/harbor", originator: "llv-structured-host" } },
      { timestamp: "2026-09-23T09:30:00Z", type: "response_item", payload: { type: "message", role: "user", id: "legacy-match",
        content: [{ type: "input_text", text: "<!-- llv:structured-user origin=operator -->\nlegacy delivery" }] } },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    const store = ActivityStore.open(path.join(activityDir, "records.sqlite"));
    try {
      const stat = fs.statSync(file);
      await ingestTranscripts([{ path: file, engine: "codex", size: stat.size, mtimeMs: stat.mtimeMs }], {
        complete: true, listedAt: NOW, now: () => NOW, store,
        resolver: () => (): ConversationResolution => ({ project: "harbor", launch: "operator", registered: true,
          mode: "team", conversation: "legacy-conversation",
          deliveryOrigin: () => ({ origin: "operator", memberId: MEMBER_A, idempotencyKey: "legacy-match" }) }),
      });
      expect(store.localRowsAfter(0, 10).find((row) => row.ids.includes(requestKey("legacy-match")))?.author).toBe(MEMBER_A);
    } finally { store.close(); }
    fs.writeFileSync(path.join(activityDir, "requests-2026-09-23.jsonl"), JSON.stringify({
      v: 1, key: ledgerRowKey("legacy-match"), at: Date.parse("2026-09-23T09:30:00Z"),
      kind: "message", surface: "desktop", project: "harbor",
    }) + "\n");
    const read = readHumanInputs(DAY, NOW, { dir: () => activityDir,
      readLedger: (from, to) => readRequests(from, to, { dir: () => activityDir }),
      store: () => ActivityStore.openReadOnly(path.join(activityDir, "records.sqlite")) },
    { mode: "team", memberId: MEMBER_A });
    expect(read.inputs).toHaveLength(2);
    expect(read.unknownAuthors).toBe(1);
    const other = readHumanInputs(DAY, NOW, { dir: () => activityDir,
      readLedger: (from, to) => readRequests(from, to, { dir: () => activityDir }),
      store: () => ActivityStore.openReadOnly(path.join(activityDir, "records.sqlite")) },
    { mode: "team", memberId: MEMBER_B });
    expect(other.inputs).toHaveLength(1);
    expect(other.unknownAuthors).toBe(1);
  });

  test("a legacy remote schema supplies solo rows and only an unknown count on a team host", async () => {
    await stageRecords();
    const file = path.join(remoteState, "activity", "records.sqlite");
    const db = new Database(file);
    db.exec("ALTER TABLE activity_inputs DROP COLUMN author; PRAGMA user_version = 1");
    db.close();
    expect(await pull()).toMatchObject({ ok: true });
    expect(local((store) => store.count("stage"))).toBe(3);
    new TeamStore(path.join(remoteState, "team", "team.sqlite")).close();
    local((store) => { store.forgetHost("stage"); store.setHostState("stage", { cursor: 0 }); });
    expect(await pull()).toMatchObject({ ok: true });
    expect(local((store) => [store.count("stage"), store.hostState("stage")?.remoteMode,
      store.hostState("stage")?.unknownAuthors])).toEqual([3, "solo", 0]);
    const activityDir = path.join(dir, "local", "state", "activity");
    fs.writeFileSync(path.join(activityDir, "hosts.json"), JSON.stringify({ v: 1, local: { id: "workstation" },
      hosts: [{ id: "stage", pull: { ssh: "stage-box" } }] }));
    const soloRead = readHumanInputs(DAY, NOW, { dir: () => activityDir,
      readLedger: () => ({ rows: [], ledgerStartMs: null }), store: () => ActivityStore.openReadOnly(localStoreFile) });
    expect(soloRead.inputs.filter((input) => input.host === "stage")).toHaveLength(3);
    expect(soloRead.unknownAuthors).toBe(0);
    const team = new TeamStore(path.join(remoteState, "team", "team.sqlite"));
    team.insertMember({ id: MEMBER_A, name: "Owner", role: "owner", status: "active", color: "teal", telegram: null,
      createdAt: "2026-09-23T00:00:00Z", createdBy: "claim", revokedAt: null });
    team.close();
    expect(await pullWith({ ...config(), memberId: MEMBER_A })).toMatchObject({ ok: true });
    expect(local((store) => [store.count("stage"), store.hostState("stage")?.unknownAuthors])).toEqual([0, 3]);
  });

  test("a former team with no active owner does not release member rows as solo input", async () => {
    await teamStageRecords(false, true);
    const remote = ActivityStore.openReadOnly(path.join(remoteState, "activity", "records.sqlite"))!;
    expect(remote.localRowsAfter(0, 10).map((row) => row.author).sort()).toEqual([null, MEMBER_A, MEMBER_B].sort());
    remote.close();
    const legacy = new Database(path.join(remoteState, "activity", "records.sqlite"));
    legacy.exec("ALTER TABLE activity_hosts DROP COLUMN team_history; PRAGMA user_version = 2");
    legacy.close();
    let output = "";
    const transport = async (env: Record<string, string>, script: string) => {
      const answer = await localTransport()(env, script);
      output += answer.stdout;
      return answer;
    };
    expect(await pullWith(config(), transport)).toMatchObject({ ok: true });
    expect(local((store) => [store.count("stage"), store.hostState("stage")?.unknownAuthors])).toEqual([0, 1]);
    expect(output).not.toContain(MEMBER_A);
    expect(output).not.toContain(MEMBER_B);
    const reset = new Database(path.join(remoteState, "team", "team.sqlite"));
    reset.exec("DELETE FROM members");
    reset.close();
    local((store) => { store.forgetHost("stage"); store.setHostState("stage", { cursor: 0 }); });
    output = "";
    expect(await pullWith(config(), transport)).toMatchObject({ ok: true });
    expect(local((store) => store.count("stage"))).toBe(0);
    expect(output).not.toContain(MEMBER_A);
    expect(output).not.toContain(MEMBER_B);
  });

  test("a former team ledger keeps a live member and leaves an unsigned request unknown", async () => {
    await teamStageRecords(false, true);
    const activityDir = path.join(remoteState, "activity");
    const previous = process.env.LLV_STATE_DIR;
    process.env.LLV_STATE_DIR = remoteState;
    try {
      const session = mintSession(teamStore(), MEMBER_B, "claim", { surface: "desktop", browser: "chrome" });
      const memberRequest = new NextRequest("http://localhost/api/tasks", { headers: {
        cookie: `llv_member=${session.value}`, "user-agent": "Mozilla/5.0 Chrome/140.0 Safari/537.36",
      } });
      const unsignedRequest = new NextRequest("http://localhost/api/tasks", { headers: {
        "user-agent": "Mozilla/5.0 Chrome/140.0 Safari/537.36",
      } });
      for (const [index, request] of [memberRequest, unsignedRequest].entries()) {
        recordOperatorRequest(request, { kind: "task", project: "harbor", idempotencyKey: `former-team-${index}` }, {
          dir: () => activityDir, now: () => Date.parse(`2026-09-23T08:4${index}:00Z`),
        });
      }
      expect(readRequests(DAY.start, DAY.end, { dir: () => activityDir }).rows.map((row) => row.author))
        .toEqual([MEMBER_B, null]);
      const sources = { dir: () => activityDir,
        readLedger: (from: number, to: number) => readRequests(from, to, { dir: () => activityDir }),
        store: () => ActivityStore.openReadOnly(path.join(activityDir, "records.sqlite")) };
      const solo = readHumanInputs(DAY, NOW, sources, { mode: "solo", memberId: null });
      expect(solo.inputs).toEqual([]);
      expect(solo.unknownAuthors).toBe(2);
      const report = activityReport({ params: clampMethodParams({}), range: "today", nowMs: NOW,
        anchors: solo.inputs.map((input) => ({ at: input.at, project: input.project, surface: input.surface, kind: input.kind, host: input.host })),
        hosts: solo.coverage, agents: [] });
      expect(report.totals.requests).toBe(0);
      expect(report.totals.humanMs).toBe(0);
      const member = readHumanInputs(DAY, NOW, sources, { mode: "team", memberId: MEMBER_B });
      expect(member.inputs.filter((input) => input.author === MEMBER_B)).toHaveLength(2);
      expect(member.unknownAuthors).toBe(2);
      resetTeamStoreForTests();
      const team = new Database(path.join(remoteState, "team", "team.sqlite"));
      team.exec("DELETE FROM members");
      team.close();
      const afterReset = recordOperatorRequest(unsignedRequest,
        { kind: "task", project: "harbor", idempotencyKey: "former-team-after-reset" },
        { dir: () => activityDir, now: () => Date.parse("2026-09-23T08:42:00Z") });
      expect(afterReset?.author).toBeNull();
      expect(readHumanInputs(DAY, NOW, sources, { mode: "solo", memberId: null }).unknownAuthors).toBe(3);
    } finally {
      resetTeamStoreForTests();
      if (previous === undefined) delete process.env.LLV_STATE_DIR;
      else process.env.LLV_STATE_DIR = previous;
    }
  });

  test("a former team export cannot restore unknown input as operator hours", async () => {
    await teamStageRecords(false, true);
    expect(await pullWith(config())).toMatchObject({ ok: true });
    expect(local((store) => store.hostState("stage"))).toMatchObject({ remoteMode: "solo", teamHistory: true, unknownAuthors: 1 });
    const activityDir = path.join(dir, "local", "state", "activity");
    const exportsDir = path.join(activityDir, "hosts", "stage");
    fs.mkdirSync(exportsDir, { recursive: true });
    const remote = ActivityStore.openReadOnly(path.join(remoteState, "activity", "records.sqlite"))!;
    const unknown = remote.candidates(LOCAL_HOST_KEY, DAY.start, DAY.end, "stage")
      .filter((row) => row.author === null)
      .map((row) => ({ ...row, source: "transcripts" as const, hash: row.textHash }));
    remote.close();
    expect(unknown).toHaveLength(1);
    fs.writeFileSync(path.join(exportsDir, "legacy.jsonl"), exportLines({ host: "stage", coveredFrom: DAY.start,
      coveredUntil: DAY.end, exportedAt: NOW, records: 1, excluded: {} }, unknown));
    fs.writeFileSync(path.join(activityDir, "hosts.json"), JSON.stringify({ v: 1, local: { id: "workstation" },
      hosts: [{ id: "stage", pull: { ssh: "stage-box" } }] }));
    const read = readHumanInputs(DAY, NOW, { dir: () => activityDir,
      readLedger: () => ({ rows: [], ledgerStartMs: null }), store: () => ActivityStore.openReadOnly(localStoreFile) });
    expect(read.inputs.filter((row) => row.host === "stage")).toEqual([]);
    expect(read.hosts.find((host) => host.host === "stage")).toMatchObject({ configurationGap: true, unknownAuthors: 1 });
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
