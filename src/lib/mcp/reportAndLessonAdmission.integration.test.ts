import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { NextRequest } from "next/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { POST } from "@/app/api/mcp/route";
import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import * as bridge from "@/lib/bridge/service";
import * as reportStore from "@/lib/bridge/store";
import { shutdownTaskPageWorker } from "@/lib/links/taskPageWorker";
import { roleMemoryCollection } from "@/lib/memory/roleStore";
import { defaultSeatTickSettings, writeSeatTickSettings } from "@/lib/monitor/seatTickSettings";
import { setReportTelegram } from "@/lib/projects/settings";
import { StateLockDeferredError } from "@/lib/state/lockWait";
import { productionDomainDependencies, viewerMcpBindings, viewerMcpToolPolicy } from "./bindings";
import { currentMcpHttpCaller } from "./callerContext";
import { setMcpHttpDependenciesForTests } from "./http";
import { ownExternalFixtureChild, ownFixtureChild, reapFixtureChildren } from "./ownedFixtureChildren";
import { createMcpToolService, requestDigest, SqliteMcpReceiptStore, type McpToolResult } from "./server";

const project = "repo-admission-fixture";
const seat = "conversation_fixture_seat";
const capability = "a".repeat(43);
const now = "2026-11-19T00:00:00.000Z";
const busyMessage = "state admission is busy at state.lease.sqlite";
const cases = {
  leave_lesson: {
    args: { clientRequestId: "lesson-write", lesson: { scope: "role", rule: "Read the durable result before declaring a background operation complete.", why: "The first response arrived before the write completed." } },
    changed: { lesson: { scope: "role", rule: "Check the saved result before closing the task.", why: "The first response arrived before the write completed." } },
    effect: () => roleMemoryCollection()!.snapshot().filter(row => row.kind === "rule" || row.kind === "scope"),
    success: { left: [{ action: "lesson", state: "active" }] },
  },
  bridge_report: {
    args: { clientRequestId: "report-write", key: "fixture-report", class: "status", summary: "The checks finished." },
    changed: { summary: "A different report." },
    effect: () => reportStore.readBridgeReportLog().reports,
    success: { recorded: true, seq: 1, destinations: { telegram: { state: "sent", messageIds: [71] } } },
  },
};
type Tool = keyof typeof cases;
let directory: string;
let receipts: SqliteMcpReceiptStore[];
let clients: Client[];
let listener: ReturnType<typeof Bun.serve> | undefined;
let services: ReturnType<typeof createMcpToolService>[];
let serviceIndex: number;
let authorized: boolean;
let sends: number;
let beforeSend: (() => Promise<void>) | undefined;
let registry: AgentRegistry | undefined;
const previousState = process.env.LLV_STATE_DIR;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-report-lesson-"));
  process.env.LLV_STATE_DIR = directory;
  receipts = [];
  clients = [];
  services = [];
  serviceIndex = 0;
  authorized = true;
  sends = 0;
  beforeSend = undefined;
  setSystemTime(new Date(now));
  registry = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, { sqliteMode: "sqlite" });
  setAgentRegistryForTests(registry);
  roleMemoryCollection(true);
  writeSeatTickSettings(project, { ...defaultSeatTickSettings(project), enabled: false });
  reportStore.readBridgeReportLog();
  reportStore.readBridgeChannel();
  setReportTelegram(project, { chat: "fixture-room", name: "Fixture room" }, "operator");
  const dependencies = {
    ...productionDomainDependencies,
    callerAttribution: () => currentMcpHttpCaller()?.capability === capability
      ? { kind: "manager" as const, conversationId: seat, role: "orchestrator" }
      : { kind: "agent" as const, conversationId: "conversation_fixture_worker", role: "builder" },
    callerProject: () => project,
    authorizedSeats: () => authorized ? [{ conversationId: seat, project, path: null }] : [],
    listPipelineRecords: () => [],
    operatorLocale: () => "en" as const,
    operatorTimeZone: () => "UTC",
    publicDenyList: () => ({ accounts: [], people: [], local: [], projects: [] }),
    sendReportTelegram: async () => {
      sends++;
      await beforeSend?.();
      return { ok: true as const, messageIds: [71] };
    },
  };
  for (let index = 0; index < 2; index++) {
    const store = new SqliteMcpReceiptStore(path.join(directory, "test-receipts.sqlite"));
    receipts.push(store);
    services.push(createMcpToolService(viewerMcpBindings(undefined, undefined, dependencies), store, viewerMcpToolPolicy(dependencies)));
  }
  setMcpHttpDependenciesForTests({ service: async () => services[serviceIndex]!, conversationForCapability: value => value === capability && authorized ? seat : null });
  listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => POST(new NextRequest(request)) });
});

afterEach(async () => {
  await Promise.all(clients.map(client => client.close()));
  await reapFixtureChildren();
  await shutdownTaskPageWorker();
  listener?.stop(true);
  setMcpHttpDependenciesForTests(null);
  setAgentRegistryForTests(null);
  registry?.close();
  for (const store of receipts) store.close();
  setSystemTime();
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  fs.rmSync(directory, { recursive: true, force: true });
});

class OwnedStdioTransport extends StdioClientTransport {
  override async start(): Promise<void> {
    await super.start();
    const child = (this as unknown as { _process?: ChildProcess })._process;
    if (!child) throw new Error("stdio fixture did not start a child");
    ownExternalFixtureChild(child, () => this.close());
  }
}

async function connect(stdio = false) {
  const client = new Client({ name: "admission-fixture", version: "1" });
  clients.push(client);
  const url = listener!.url;
  await client.connect(stdio ? new OwnedStdioTransport({
    command: process.execPath,
    args: ["src/lib/mcp/entry.ts"],
    cwd: process.cwd(),
    env: { LLV_STATE_DIR: directory, LLV_SPAWN_CAPABILITY: capability, LLV_VIEWER_CONTROL_URL: url.origin },
    stderr: "inherit",
  }) : new StreamableHTTPClientTransport(new URL("/api/mcp", url), { requestInit: { headers: { "x-llv-spawn-capability": capability } } }));
  return client;
}

async function call(client: Client, name: Tool, args = cases[name].args as Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 15_000 });
  if (!result.structuredContent) throw new Error(`MCP returned no structured answer: ${JSON.stringify(result.content)}`);
  const answer = result.structuredContent as McpToolResult;
  expect(result.isError === true).toBe(answer.ok === false);
  return answer;
}

async function withHeldWriter(work: () => Promise<void>) {
  const holder = ownFixtureChild(Bun.spawn([process.execPath, "-e", `
    import { Database } from "bun:sqlite";
    const db = new Database(process.argv[1]);
    db.exec("BEGIN IMMEDIATE");
    console.log("writer held");
    for await (const chunk of Bun.stdin.stream()) break;
    db.close();
  `, path.join(directory, "state.sqlite")], { stdin: "pipe", stdout: "pipe", stderr: "inherit" }));
  const reader = holder.stdout.getReader();
  try {
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toBe("writer held\n");
    await work();
    expect(holder.exitCode).toBeNull();
  } finally {
    reader.releaseLock();
    await holder.stdin.end();
    expect(await holder.exited).toBe(0);
  }
}

for (const tool of ["leave_lesson", "bridge_report"] as const) {
  const { args, changed, effect, success } = cases[tool];
  const receiptKey = `${tool}:${args.clientRequestId}`;
  const effectCount = tool === "leave_lesson" ? 2 : 1; // One lesson and its scope row, or one report.

  test.each(["HTTP", "stdio"])(`${tool} releases a proven busy write over %s`, async transport => {
    const client = await connect(transport === "stdio");
    const expectRevoked = async () => {
      if (transport === "stdio") expect(await call(client, tool)).toMatchObject({ ok: false, code: "outcome_unknown" });
      else await expect(call(client, tool)).rejects.toThrow();
    };
    let refusals: McpToolResult[] = [];
    await withHeldWriter(async () => {
      refusals = [await call(client, tool), await call(client, tool)];
      expect(effect()).toHaveLength(0);
      expect(sends).toBe(0);
    });
    const heldReceipt = receipts[0]!.lookup(receiptKey);
    serviceIndex = 1;
    authorized = false;
    await expectRevoked();
    expect(effect()).toHaveLength(0);
    expect(sends).toBe(0);
    authorized = true;
    const retried = await call(client, tool);
    expect(retried).toMatchObject({ ok: true, replayed: false, ...success });
    for (const refusal of refusals) expect(refusal).toMatchObject({ ok: false, error: busyMessage, code: "store_busy", retryable: true, replayed: false,
      details: { outcome: "not-executed", evidence: "not-admitted", nextAction: "retry-same-key" } });
    expect(heldReceipt).toBeNull();
    const written = effect();
    expect(written).toHaveLength(effectCount);
    expect(sends).toBe(tool === "bridge_report" ? 1 : 0);
    expect(await call(client, tool)).toEqual({ ...retried, replayed: true });
    expect(await call(client, tool, { ...args, ...changed })).toMatchObject({ ok: false, code: "idempotency_conflict" });
    authorized = false;
    await expectRevoked();
    expect(effect()).toEqual(written);
    expect(sends).toBe(tool === "bridge_report" ? 1 : 0);
  });

  test(`${tool} retains an older busy receipt and an interrupted claim`, async () => {
    const client = await connect();
    const saved = { ok: false as const, toolName: tool, clientRequestId: args.clientRequestId, code: "tool_failed", error: busyMessage, retryable: true, replayed: false };
    const digest = requestDigest(tool, args);
    receipts[0]!.claim(receiptKey, digest, "durable");
    expect(await call(client, tool)).toMatchObject({ ok: false, code: "outcome_unknown", replayed: true });
    receipts[0]!.complete(receiptKey, digest, saved, "durable");
    serviceIndex = 1;
    expect(await call(client, tool)).toEqual({ ...saved, replayed: true });
    expect(effect()).toHaveLength(0);
    expect(sends).toBe(0);
  });

  test.each(["untyped", "post-write"])(`${tool} keeps the %s busy failure`, async phase => {
    const client = await connect();
    const memory = roleMemoryCollection()!;
    const patch = memory.boundedPatch.bind(memory);
    const record = bridge.recordManagerReport;
    const fail = () => { throw phase === "untyped" ? new Error(busyMessage) : new StateLockDeferredError("state.lease.sqlite"); };
    const fault = tool === "leave_lesson" ? spyOn(memory, "boundedPatch").mockImplementationOnce((...params) => {
      if (phase === "post-write") patch(...params);
      return fail();
    }) : spyOn(bridge, "recordManagerReport").mockImplementationOnce(input => {
      if (phase === "post-write") record(input);
      return fail();
    });
    let failed: McpToolResult;
    try { failed = await call(client, tool); }
    finally { fault.mockRestore(); }
    expect(failed).toMatchObject({ ok: false, error: busyMessage, code: "tool_failed", replayed: false });
    const written = effect();
    expect(written).toHaveLength(phase === "post-write" ? effectCount : 0);
    serviceIndex = 1;
    expect(await call(client, tool)).toEqual({ ...failed, replayed: true });
    expect(effect()).toEqual(written);
    expect(sends).toBe(0);
  });
}

test("a concurrent bridge duplicate sees the original claim while delivery is in progress", async () => {
  const first = await connect();
  const second = await connect();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  beforeSend = async () => { entered.resolve(); await release.promise; };
  const pending = call(first, "bridge_report");
  try {
    await Promise.race([entered.promise, pending.then(() => { throw new Error("report returned before reaching delivery"); })]);
    expect(reportStore.readBridgeReportLog().reports).toHaveLength(1);
    serviceIndex = 1;
    expect(await call(second, "bridge_report")).toMatchObject({ ok: false, code: "outcome_unknown", replayed: true });
    expect(sends).toBe(1);
  } finally { release.resolve(); }
  const success = await pending;
  expect(success).toMatchObject({ ok: true, ...cases.bridge_report.success });
  expect(await call(second, "bridge_report")).toEqual({ ...success, replayed: true });
  expect(reportStore.readBridgeReportLog().reports).toHaveLength(1);
  expect(sends).toBe(1);
});

test("a refused bridge recovery retains its earlier success receipt", async () => {
  const client = await connect();
  const bookkeeping = spyOn(reportStore, "recordBridgeReportTelegram").mockImplementationOnce(() => {
    throw new StateLockDeferredError("state.lease.sqlite");
  });
  let recorded: McpToolResult;
  try { recorded = await call(client, "bridge_report"); }
  finally { bookkeeping.mockRestore(); }
  expect(recorded).toMatchObject({ ok: true, recorded: true, seq: 1,
    destinations: { telegram: { state: "sent", bookkeeping: { state: "pending" } } } });
  const reports = reportStore.readBridgeReportLog().reports;
  expect(reports).toHaveLength(1);
  const receiptKey = "bridge_report:report-write";
  const retained = receipts[0]!.lookup(receiptKey);
  expect(retained?.result).toMatchObject({ ok: true, reportId: reports[0]!.id });
  // Simulate a report missing from the lookup while its MCP receipt is still retained.
  const missingReport = spyOn(reportStore, "findBridgeReport").mockReturnValueOnce(null);
  serviceIndex = 1;
  try {
    await withHeldWriter(async () => {
      expect(await call(client, "bridge_report")).toEqual({ ...recorded, replayed: true });
    });
  } finally { missingReport.mockRestore(); }
  expect(receipts[1]!.lookup(receiptKey)).toEqual(retained);
  expect(reportStore.readBridgeReportLog().reports).toEqual(reports);
  expect(sends).toBe(1);
});
