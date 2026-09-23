import { afterAll, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/*
 * What a seat reads back from `seat_tick_settings` and `pipeline_action close`
 * (#2030), measured the way the seat reads it: through the MCP protocol, the
 * tool service with its policy and receipts, the registered input schema and
 * the real bindings, over the real seat tick settings store. The bytes counted
 * are the text block the client receives.
 *
 * Roots are set before anything is imported, so nothing here resolves the
 * operator's state (#1905).
 */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-seat-answer-budgets-"));
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "LLV_STATE_DIR", "TMPDIR"]) {
  process.env[key] = path.join(sandbox, key);
  fs.mkdirSync(process.env[key]!, { recursive: true });
}
process.env.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:1";
process.env.LLV_RUNTIME_HOST_SOCKET = path.join(sandbox, "absent.sock");
process.env.LLV_RUNTIME_HOST_CONTROL_SOCKET = path.join(sandbox, "absent-control.sock");
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { viewerMcpBindings, viewerMcpToolPolicy } = await import("./bindings");
const { createMcpToolService, createViewerMcpServer, MemoryMcpReceiptStore } = await import("./server");
const { readSeatTickSettings, SEAT_TICK_PROMPT_LIMIT } = await import("@/lib/monitor/seatTickSettings");
const { buildPipeline, savePipelines } = await import("@/lib/pipelines/store");
const { ORCHESTRATOR_PROMPT_VERSION, ORCHESTRATOR_SYSTEM_PROMPT } = await import("@/lib/orchestrator/prompt");
const { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent, failOrchestratorSeatIntent } = await import("@/lib/orchestrator/seats");
import type { Pipeline, PipelineCloseReport, PipelineStageHostRef } from "@/lib/pipelines/types";

const PROJECT = "budget-board";
const SEAT = "conversation_budget_seat";

/** A lane ledger the size the audited seat kept in its note (2.26 KB), one
    line per lane — the shape a line edit is for. */
const LEDGER = Array.from({ length: 24 }, (_, lane) =>
  `lane ${lane + 1}: pipeline_${String(lane).padStart(4, "0")}ab — review round 2 of 4, PR open, waiting on CI; next: merge on green.`,
).join("\n");

async function session(domain: Record<string, unknown>) {
  const bindings = viewerMcpBindings(undefined, undefined, domain as never);
  const service = createMcpToolService(bindings, new MemoryMcpReceiptStore(), viewerMcpToolPolicy(domain as never));
  const server = createViewerMcpServer(service);
  const client = new Client({ name: "seat-answer-budgets", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  let sequence = 0;
  const call = async (name: string, args: Record<string, unknown>) => {
    const request = { clientRequestId: `budget-${++sequence}`, ...args };
    const result = await client.callTool({ name, arguments: request });
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    return {
      failed: result.isError === true,
      payload: JSON.parse(text) as Record<string, unknown>,
      bytes: Buffer.byteLength(text),
      sentBytes: Buffer.byteLength(JSON.stringify(request)),
    };
  };
  return { call, close: async () => { await client.close(); await server.close(); } };
}

const tickDomain = {
  callerAttribution: () => ({ kind: "manager", conversationId: SEAT }),
  authorizedSeats: () => [{ conversationId: SEAT, path: null, project: PROJECT }],
  callerProject: () => PROJECT,
  attentionAuthority: () => ({ kind: "worker", conversationId: SEAT, role: "orchestrator" }),
};

test("seat_tick_settings acknowledges a write in 300 B, edits one note line for under 300 B sent, and reads the note back once (#2030)", async () => {
  const mcp = await session(tickDomain);
  try {
    const written = await mcp.call("seat_tick_settings", { monitorPrompt: LEDGER });
    expect(written.failed).toBe(false);
    expect(Object.keys(written.payload).filter((key) => !["ok", "toolName", "clientRequestId", "replayed"].includes(key)).sort())
      .toEqual(["changed", "changedFields", "monitorPromptLength", "revision"]);
    expect(written.payload).toMatchObject({ changed: true, changedFields: ["monitorPrompt"], monitorPromptLength: LEDGER.length });
    expect(written.bytes).toBeLessThanOrEqual(300);

    const cadence = await mcp.call("seat_tick_settings", { wakeIntervalMinutes: 30, reason: "two lanes are close to merging" });
    expect(cadence.payload).toMatchObject({ changed: true, changedFields: ["wakeIntervalMinutes", "reason"] });
    expect(cadence.bytes).toBeLessThanOrEqual(300);

    /* One lane line changes by sending that line. */
    const replaced = await mcp.call("seat_tick_settings", {
      replaceLine: { prefix: "lane 7:", text: "lane 7: pipeline_0006ab — merged, deploy pending." },
    });
    expect(replaced.failed).toBe(false);
    expect(replaced.sentBytes).toBeLessThan(300);
    expect(replaced.bytes).toBeLessThanOrEqual(300);
    const stored = readSeatTickSettings(PROJECT).monitorPrompt!;
    expect(stored.split("\n")[6]).toBe("lane 7: pipeline_0006ab — merged, deploy pending.");
    expect(stored.split("\n")).toHaveLength(24);
    expect(replaced.payload.revision).not.toBe(cadence.payload.revision);

    const appended = await mcp.call("seat_tick_settings", { appendLine: "lane 25: pipeline_0024ab — building." });
    expect(appended.sentBytes).toBeLessThan(300);
    const removed = await mcp.call("seat_tick_settings", { removeLine: { index: 0 } });
    expect(removed.sentBytes).toBeLessThan(300);
    const edited = readSeatTickSettings(PROJECT).monitorPrompt!.split("\n");
    expect(edited[0]).toStartWith("lane 2:");
    expect(edited.at(-1)).toBe("lane 25: pipeline_0024ab — building.");

    /* A prefix that names more than one line ("lane 1" is also lanes 10 to
       19) is refused, and nothing moves. */
    const before = readSeatTickSettings(PROJECT);
    const ambiguous = await mcp.call("seat_tick_settings", { replaceLine: { prefix: "lane 1", text: "lane 1: gone" } });
    expect(ambiguous.failed).toBe(true);
    expect(JSON.stringify(ambiguous.payload)).toContain("matches 10 lines");
    expect(readSeatTickSettings(PROJECT)).toEqual(before);
    /* An index read off an older copy of the note names the wrong lane: with
       the prefix beside it, the pair must agree or nothing moves. */
    const stale = await mcp.call("seat_tick_settings", { replaceLine: { index: 3, prefix: "lane 7:", text: "lane 7: gone" } });
    expect(stale.failed).toBe(true);
    expect(JSON.stringify(stale.payload)).toContain("line 3 of the note does not start with the prefix");
    expect((await mcp.call("seat_tick_settings", { removeLine: { index: 3, prefix: "lane 7:" } })).failed).toBe(true);
    expect(readSeatTickSettings(PROJECT)).toEqual(before);
    /* Agreeing, they edit that line. */
    const agreed = await mcp.call("seat_tick_settings", { replaceLine: { index: 5, prefix: "lane 7:", text: "lane 7: pipeline_0006ab — deployed." } });
    expect(agreed.failed).toBe(false);
    expect(readSeatTickSettings(PROJECT).monitorPrompt!.split("\n")[5]).toBe("lane 7: pipeline_0006ab — deployed.");
    /* So is an edit alongside a whole note. */
    expect((await mcp.call("seat_tick_settings", { monitorPrompt: "x", appendLine: "y" })).failed).toBe(true);

    /* The whole-note rules still hold for an edited note: redaction, and the
       limit refused rather than cut. */
    const secret = ["ghp", "_", "a".repeat(36)].join("");
    await mcp.call("seat_tick_settings", { appendLine: `token ${secret}` });
    expect(readSeatTickSettings(PROJECT).monitorPrompt).not.toContain(secret);
    const overflow = await mcp.call("seat_tick_settings", { appendLine: "n".repeat(SEAT_TICK_PROMPT_LIMIT) });
    expect(overflow.failed).toBe(true);
    expect(JSON.stringify(overflow.payload)).toContain(`the limit is ${SEAT_TICK_PROMPT_LIMIT}`);

    const note = readSeatTickSettings(PROJECT).monitorPrompt!;
    const verbose = await mcp.call("seat_tick_settings", { verbose: true });
    expect(verbose.payload.monitorPrompt).toBe(note);
    expect(JSON.stringify(verbose.payload).split(JSON.stringify(note).slice(1, -1)).length - 1).toBe(1);
    expect(verbose.bytes).toBeLessThanOrEqual(Buffer.byteLength(JSON.stringify(note)) + 1_024);

    console.log(`[#2030] seat_tick_settings: write ${written.bytes} B, cadence write ${cadence.bytes} B, replaceLine sent ${replaced.sentBytes} B / answered ${replaced.bytes} B, verbose ${verbose.bytes} B for a ${Buffer.byteLength(note)} B note`);
  } finally {
    await mcp.close();
  }
});

function hostRef(stageId: string, attempt: number): PipelineStageHostRef {
  const id = crypto.randomUUID();
  return {
    stageId,
    attempt,
    conversationId: `conversation_${id}`,
    agentPath: path.join(sandbox, "HOME", ".claude", "projects", "-srv-work-repo-pipeline-lane", `${id}.jsonl`),
    paneId: null,
    launchId: `launch_${crypto.randomUUID()}`,
  };
}

test("pipeline_action close answers counts in 600 B with 8 pending hosts, and get_pipeline keeps the list (#2030)", async () => {
  const stage = (id: string, next: string | null) => ({
    id, kind: "run" as const, prompt: `Stage ${id}`, next,
    effectiveRole: { roleId: null, engine: "claude" as const, model: "opus", effort: "high", access: "read-write" as const, promptScaffold: null },
  });
  const open = buildPipeline({
    id: "pipeline_budget_close", task: "Close with pending hosts", project: PROJECT, repoDir: "/srv/work/repo",
    stages: [stage("design", "implement"), stage("implement", "review"), stage("review", "fix"), stage("fix", null)],
    srcPath: null, srcConversationId: SEAT, now: "2026-09-22T10:00:00Z", state: "draft",
  }) as Pipeline;
  open.state = "running";
  open.taskIds = ["task_budget_close"];
  const pending = ["design", "implement", "review", "fix", "implement", "review", "fix", "review"].map((id, index) => hostRef(id, 1 + Math.floor(index / 4)));
  const close: PipelineCloseReport = {
    pending, status: "pending", stopped: [], alreadyStopped: [], unconfirmed: [], reviewers: [],
    acknowledged: [], stillRunning: [], notes: [], worktree: { dir: "/srv/work/repo-pipeline-budget", uncommitted: [], truncated: false },
  };
  const closed: Pipeline = { ...structuredClone(open), state: "closed", cursor: null, closedAt: "2026-09-22T11:00:00Z", closeReport: close,
    closeTeardown: { id: "close-budget", phase: "pending", waitingForActivation: false, acknowledgeHosts: false, flow: null } };
  savePipelines([closed]);
  const mcp = await session({
    ...tickDomain,
    readPipelineRecord: () => open,
    getPipelines: () => ({ pipelines: [closed] }),
    patchPipeline: async () => ({ pipeline: closed, close }),
  });
  try {
    const answer = await mcp.call("pipeline_action", { pipelineId: open.id, action: "close", reason: "superseded by the fix lane" });
    expect(answer.failed).toBe(false);
    expect(answer.payload).toMatchObject({
      pipelineId: open.id, state: "closed",
      close: { status: "pending", pending: 8, stopped: 0, alreadyStopped: 0 },
    });
    expect(answer.payload.close).not.toHaveProperty("stillRunning");
    for (const host of pending) expect(JSON.stringify(answer.payload)).not.toContain(host.conversationId!);
    expect(answer.bytes).toBeLessThanOrEqual(600);

    /* The list is the record's, and the record is one read away. */
    const read = await mcp.call("get_pipeline", { pipelineId: open.id });
    expect((read.payload.pipeline as Pipeline).closeReport!.pending).toEqual(pending);
    console.log(`[#2030] pipeline_action close with 8 pending hosts: ${answer.bytes} B`);
  } finally {
    await mcp.close();
  }
});

test("get_orchestrator answers a real seat in under 8 KB by default and whole with full:true (#2064)", async () => {
  /* The seat the issue was filed from: the default mandate (about 25 KB), a
     2 KB role table, fifteen terminalized intents that each keep their own copy
     of the mandate, and seventy-six predecessors in the lineage. */
  const project = "budget-seat-project";
  const roleTable = Array.from({ length: 24 }, (_, row) => `| role-${row} | claude | opus | high | read-write | builds one slice |`).join("\n");
  const at = (minute: number) => new Date(Date.parse("2026-09-01T00:00:00Z") + minute * 60_000).toISOString();
  let minute = 0;
  const seat = (index: number) => {
    const key = `seat_${String(index).padStart(8, "0")}`;
    beginOrchestratorSeatIntent({ project, mandate: ORCHESTRATOR_SYSTEM_PROMPT, roleTable, clientRequestId: key, mode: "spawn", promptVersion: ORCHESTRATOR_PROMPT_VERSION, now: at(++minute) });
    completeOrchestratorSeatIntent({ project, clientRequestId: key, conversationId: `conversation_${crypto.randomUUID()}`, path: null, now: at(++minute) });
  };
  for (let index = 0; index <= 76; index += 1) seat(index);
  for (let index = 0; index < 15; index += 1) {
    const key = `failed_${String(index).padStart(8, "0")}`;
    beginOrchestratorSeatIntent({ project, mandate: ORCHESTRATOR_SYSTEM_PROMPT, roleTable, clientRequestId: key, mode: "spawn", promptVersion: ORCHESTRATOR_PROMPT_VERSION, now: at(++minute) });
    failOrchestratorSeatIntent(project, key, "the spawn never produced a readable conversation", at(++minute));
  }

  const mcp = await session({ ...tickDomain, callerProject: () => project });
  try {
    const compact = await mcp.call("get_orchestrator", { project });
    expect(compact.failed).toBe(false);
    expect(compact.payload).toMatchObject({
      project,
      designated: true,
      promptVersion: ORCHESTRATOR_PROMPT_VERSION,
      defaultPromptVersion: ORCHESTRATOR_PROMPT_VERSION,
      intentHistoryCount: 15,
      lineageCount: 76,
      seat: { mandateLength: ORCHESTRATOR_SYSTEM_PROMPT.length, roleTableLength: roleTable.length },
    });
    for (const key of ["conversationId", "seatEpoch", "engine", "model", "health", "rotation", "predecessorConversationId"]) {
      expect(compact.payload).toHaveProperty(key);
    }
    expect(JSON.stringify(compact.payload)).not.toContain(ORCHESTRATOR_SYSTEM_PROMPT.slice(0, 200));
    expect(compact.bytes).toBeLessThan(8 * 1024);

    const full = await mcp.call("get_orchestrator", { project, full: true });
    expect(full.failed).toBe(false);
    expect((full.payload.seat as { mandate: string }).mandate).toBe(ORCHESTRATOR_SYSTEM_PROMPT);
    expect(full.payload.intentHistory as unknown[]).toHaveLength(15);
    expect(full.payload.lineage as unknown[]).toHaveLength(76);
    console.log(`[#2064] get_orchestrator: default ${compact.bytes} B, full:true ${full.bytes} B`);
  } finally {
    await mcp.close();
  }
});
