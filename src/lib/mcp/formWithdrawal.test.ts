import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/mcp/route";
import { POST as operatorDismiss } from "@/app/api/attention/dismissals/route";
import { teamStore, resetTeamStoreForTests } from "@/lib/team/store";
import { mintSession, MEMBER_COOKIE } from "@/lib/team/sessions";
import { createWorkspace } from "@/lib/team/workspaces";
import type { Member } from "@/lib/team/contract";
import * as dismissalService from "@/lib/attention/dismissals";
import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { soloBrowserSession } from "@/lib/agent/operatorSession";
import { readAttentionDismissals } from "@/lib/attention/dismissals";
import { needsYouAnswer, type NeedsYouAnswer } from "@/lib/attention/needsYouRead";
import { operatorDecisions, readSeatRounds, seatDecisionNotices, withPrototypeReviewSummaries } from "@/lib/prototypeReview/read";
import { insertSeatRound, mutateSeatRound, clearSeatRoundsForTests } from "@/lib/prototypeReview/seatRounds";
import type { PrototypeReviewRound } from "@/lib/prototypeReview/types";
import { saveTasks, loadTasks, TASKS_FILE } from "@/lib/tasks/store";
import { persistProjectAliases, resetProjectAliasesForTests } from "@/lib/projects/aliases";
import { setMcpHttpDependenciesForTests } from "./http";
import { callerAttributionFrom, productionDomainDependencies, viewerMcpBindings, viewerMcpToolPolicy } from "./bindings";
import { createMcpToolService, MemoryMcpReceiptStore } from "./server";

const NOW = Date.parse("2026-11-12T08:00:00Z");
const PROJECT = "form-project";
const SEAT = "conversation_form_seat";
const ID = `pr_${"a".repeat(32)}`;
const OTHER = `pr_${"b".repeat(32)}`;
const TASK_ROUND = `pr_${"c".repeat(32)}`;
const capability = "f".repeat(43);
let root: string;
let registry: AgentRegistry;
const previous = process.env.LLV_STATE_DIR;
beforeEach(() => {
  setSystemTime(NOW);
  root = fs.mkdtempSync(path.join(process.env.TMPDIR!, "form-state-"));
  process.env.LLV_STATE_DIR = root;
  resetProjectAliasesForTests();
  resetTeamStoreForTests();
  registry = new AgentRegistry(path.join(root, "registry.json"));
  setAgentRegistryForTests(registry);
  saveTasks([]);
});
afterEach(() => {
  setMcpHttpDependenciesForTests(null);
  resetTeamStoreForTests();
  setAgentRegistryForTests(null); registry.close();
  resetProjectAliasesForTests();
  process.env.LLV_STATE_DIR = previous;
  setSystemTime();
  fs.rmSync(root, { recursive: true, force: true });
});

function round(id = ID, project = PROJECT): PrototypeReviewRound {
  return { id, project, taskId: null, title: "A waiting form", createdAt: new Date(NOW).toISOString(),
    publicationKey: id, inputDigest: "fixture", source: { conversationId: SEAT }, variants: [],
    questions: [{ id: "go", text: "Proceed?", options: [{ label: "Proceed" }] }] };
}
function panel(): NeedsYouAnswer {
  const tasks = loadTasks();
  return needsYouAnswer({ files: [], pipelines: [], tasks: withPrototypeReviewSummaries(tasks), seatDecisions: seatDecisionNotices(PROJECT) },
    null, NOW / 1000, PROJECT, { tasks, pipelines: [], dismissals: readAttentionDismissals().records, reports: null, admissions: [], unavailable: [] });
}

async function sdk() {
  let authorized = true;
  const seats = () => authorized ? [{ conversationId: SEAT, project: PROJECT, path: null }] : [];
  let preparation: (() => void) | undefined;
  const dependencies = { ...productionDomainDependencies,
    attentionAuthority: () => ({ kind: "worker" as const, conversationId: SEAT, role: "orchestrator" }),
    authorizedSeats: seats,
    callerAttribution: () => callerAttributionFrom({ kind: "worker", conversationId: SEAT, role: "orchestrator" }, id => seats().some(s => s.conversationId === id)),
    getPipelines: () => ({ pipelines: [] }), loadTasks, listFiles: async () => [],
    registrySnapshot: () => ({ conversations: {}, conversationAliases: {}, lineageEdges: {}, memberships: {}, receipts: {} }) as never,
    get dismissalPorts() {
      if (preparation) { const change = preparation; preparation = undefined; queueMicrotask(change); return undefined; }
      return { now: () => new Date(NOW), task: (id: string) => loadTasks().find(t => t.id === id) ?? null,
      resolveConversation: () => null, pipelines: () => [], pipeline: () => null,
      setPipelineDismissal: async () => { throw new Error("no lanes in this fixture"); },
      resolveReports: () => ({ resolved: [], alreadyClear: [], unknown: [] }) };
    },
  };
  const managerSources = () => ({ activeSeats: () => [], revocations: () => [], conversationFacts: () => null, resolveAlias: (id: string) => id });
  const service = createMcpToolService(viewerMcpBindings(undefined, {
    post: async (route: string) => { expect(route).toBe("/api/attention/needs-you"); return panel(); },
  } as never, dependencies), new MemoryMcpReceiptStore(), viewerMcpToolPolicy(dependencies, false, managerSources));
  setMcpHttpDependenciesForTests({ service: async () => service, conversationForCapability: value => value === capability ? SEAT : null });
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => POST(new NextRequest(request)) });
  const client = new Client({ name: "form-withdrawal", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`/api/mcp`, listener.url), { requestInit: { headers: { "x-llv-spawn-capability": capability } } }));
  let readSequence = 0;
  return { client, prepare: (change: () => void) => { preparation = change; }, authorize: (value: boolean) => { authorized = value; },
    call: async (args: Record<string, unknown>) => {
      const result = await client.callTool({ name: "dismiss_attention", arguments: { clientRequestId: `panel-read-${++readSequence}`, ...args, full: true } });
      return result.structuredContent ?? JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    },
    close: async () => { await client.close(); listener.stop(true); } };
}

test("SDK HTTP: taskless and decided rows have withdrawal targets, exact counts, durable reads and replay", async () => {
  insertSeatRound(round());
  insertSeatRound(round(OTHER));
  for (const digit of ["e", "f", "9"]) insertSeatRound(round(`pr_${digit.repeat(32)}`));
  const saved = { ...round(TASK_ROUND), taskId: "task-a", decision: { chosen: [], comment: "Keep this answer", at: new Date(NOW - 600_000).toISOString(),
    delivery: { state: "failed" as const, conversationId: SEAT, clientMessageId: "answer-key", text: "Keep this answer", failingSince: new Date(NOW - 600_000).toISOString() } } };
  saveTasks([{ id: "task-a", project: PROJECT, text: "Finished work", status: "done", placement: "unplaced", assignments: [], createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(), prototypeReviews: [saved] }]);
  const f = await sdk();
  try {
    const read = await f.call({ project: PROJECT }) as unknown as NeedsYouAnswer;
    expect(read.count).toBe(6);
    expect(read.rows.every(row => row.target?.kind === "prototype")).toBe(true);
    expect(read.rows.map(row => row.subject.reviewId).sort()).toEqual(operatorDecisions(PROJECT).decisions.map(row => row.id).sort());
    for (const [index, row] of read.rows.entries()) {
      const args = { target: row.target, reason: "The work is finished", clientRequestId: `withdraw-${index}` };
      expect(await f.call(args)).toMatchObject({ ok: true, dismissed: [row.target] });
      expect(await f.call(args)).toMatchObject({ ok: true, replayed: true });
    }
    expect(await f.call({ project: PROJECT })).toMatchObject({ count: 0 });
    expect(operatorDecisions(PROJECT).decisions).toHaveLength(0);
    expect(readSeatRounds(PROJECT).waitingReviewId).toBeNull();
    const child = Bun.spawn([process.execPath, "-e", `
      import {readSeatRounds,operatorDecisions} from ${JSON.stringify(new URL("../prototypeReview/read.ts", import.meta.url).pathname)};
      import {loadTasks} from ${JSON.stringify(new URL("../tasks/store.ts", import.meta.url).pathname)};
      import {readAttentionDismissals} from ${JSON.stringify(new URL("../attention/dismissals.ts", import.meta.url).pathname)};
      console.log(JSON.stringify({waiting:readSeatRounds(${JSON.stringify(PROJECT)}).waitingReviewId, count:operatorDecisions(${JSON.stringify(PROJECT)}, loadTasks(${JSON.stringify(TASKS_FILE)})).decisions.length, records:readAttentionDismissals().records.length}));
    `], { env: process.env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(JSON.parse(stdout)).toEqual({ waiting: null, count: 0, records: 6 });
    insertSeatRound(round(`pr_${"8".repeat(32)}`));
    expect(await f.call({ project: PROJECT })).toMatchObject({ count: 1 });
    expect(loadTasks()[0]!.prototypeReviews![0]!.decision!.comment).toBe("Keep this answer");
    expect(await f.call({ target: { kind: "prototype", taskId: null, reviewId: ID }, undo: true, clientRequestId: "restore-form" })).toMatchObject({ ok: true });
    expect(await f.call({ project: PROJECT })).toMatchObject({ count: 2 });
  } finally { await f.close(); }
});

test("SDK HTTP: foreign and aliased projects, missing rounds and revoked-seat replay stay fenced", async () => {
  insertSeatRound(round()); insertSeatRound(round(OTHER, "foreign-project"));
  const f = await sdk();
  try {
    const target = { kind: "prototype", taskId: null, reviewId: ID };
    expect(await f.call({ target: { ...target, reviewId: OTHER }, clientRequestId: "foreign-form" })).toMatchObject({ ok: false });
    expect(await f.call({ target: { ...target, reviewId: `pr_${"d".repeat(32)}` }, clientRequestId: "missing-form" })).toMatchObject({ ok: false });
    expect(readAttentionDismissals().records).toHaveLength(0);
    expect(await f.call({ target, clientRequestId: "own-form" })).toMatchObject({ ok: true });
    f.authorize(false);
    expect(await f.call({ target, clientRequestId: "own-form" })).toMatchObject({ ok: false });
    expect(await f.call({ target, undo: true, clientRequestId: "revoked-restore" })).toMatchObject({ ok: false });
    f.authorize(true);
    expect(persistProjectAliases([{ source: "foreign-project", target: PROJECT, displayName: "Forms" }])).toBe(true);
    expect(await f.call({ target: { ...target, reviewId: OTHER }, clientRequestId: "aliased-form" })).toMatchObject({ ok: true });
  } finally { await f.close(); }
});

test("the operator's existing dismissal route clears a taskless form and restores it", async () => {
  insertSeatRound(round());
  for (const undo of [false, true]) {
    const response = await operatorDismiss(new NextRequest("http://localhost/api/attention/dismissals", {
      method: "POST", headers: { host: "localhost", cookie: `llv_operator=${soloBrowserSession()}`, "content-type": "application/json" },
      body: JSON.stringify({ target: { kind: "prototype", taskId: null, reviewId: ID }, undo }),
    }));
    expect(response.status).toBe(200);
    expect(operatorDecisions(PROJECT).decisions).toHaveLength(undo ? 1 : 0);
  }
});


test.each(["revoked", "moved", "removed"])("SDK HTTP: %s during asynchronous store preparation writes no withdrawal", async change => {
  insertSeatRound(round());
  const f = await sdk();
  try {
    f.prepare(() => {
      if (change === "revoked") f.authorize(false);
      else if (change === "moved") mutateSeatRound(ID, held => { held.project = "foreign-project"; });
      else clearSeatRoundsForTests();
    });
    expect(await f.call({ target: { kind: "prototype", taskId: null, reviewId: ID }, clientRequestId: `pending-${change}` })).toMatchObject({ ok: false });
    expect(readAttentionDismissals().records).toHaveLength(0);
  } finally { await f.close(); }
});


test("scoped operators withdraw taskless forms, with stored ownership guarding forged projects and pending revocation", async () => {
  const store = teamStore();
  const member = (id: string, role: Member["role"]): Member => ({ id, name: role, role, status: "active", color: "teal", telegram: null, createdAt: new Date(NOW).toISOString(), createdBy: "claim", revokedAt: null });
  const owner = member("m_owner", "owner"), actor = member("m_actor", "member");
  store.insertMember(owner); store.insertMember(actor);
  const workspace = `w_${"a".repeat(32)}`;
  createWorkspace(store, owner, { id: workspace, name: "Forms", projects: [PROJECT] });
  store.putWorkspaceMember(workspace, actor.id, "member", owner.id, new Date(NOW).toISOString());
  const session = mintSession(store, actor.id, "claim", { surface: "desktop", browser: "chrome" }, NOW).value;
  const request = (reviewId: string, undo = false) => new NextRequest("http://localhost/api/attention/dismissals", {
    method: "POST", headers: { host: "localhost", cookie: `${MEMBER_COOKIE}=${session}`, "content-type": "application/json" },
    body: JSON.stringify({ project: PROJECT, target: { kind: "prototype", taskId: null, reviewId }, undo }),
  });
  insertSeatRound(round()); insertSeatRound(round(OTHER, "foreign-project"));
  expect((await operatorDismiss(request(ID))).status).toBe(200);
  expect((await operatorDismiss(request(ID, true))).status).toBe(200);
  expect((await operatorDismiss(request(OTHER))).status).toBe(403);
  expect(readAttentionDismissals().records).toHaveLength(0);
  const original = dismissalService.dismissAttention;
  const pending = spyOn(dismissalService, "dismissAttention").mockImplementation(async (...args) => {
    await Promise.resolve();
    store.updateMember({ ...actor, status: "revoked", revokedAt: new Date(NOW).toISOString() });
    return original(...args);
  });
  try { expect((await operatorDismiss(request(ID))).status).toBe(403); }
  finally { pending.mockRestore(); }
  expect(readAttentionDismissals().records).toHaveLength(0);
  store.updateMember(actor);
  expect((await operatorDismiss(request(ID))).status).toBe(200);
});

test("the operator route refuses an agent capability without writing a taskless dismissal", async () => {
  insertSeatRound(round());
  const response = await operatorDismiss(new NextRequest("http://localhost/api/attention/dismissals", {
    method: "POST", headers: { host: "localhost", cookie: `llv_operator=${soloBrowserSession()}`, "x-llv-spawn-capability": capability, "content-type": "application/json" },
    body: JSON.stringify({ project: PROJECT, target: { kind: "prototype", taskId: null, reviewId: ID } }),
  }));
  expect(response.status).toBe(403);
  expect(readAttentionDismissals().records).toHaveLength(0);
});
