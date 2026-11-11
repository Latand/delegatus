import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { NextRequest } from "next/server";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-runtime-mcp-"));
const prior = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = root;
const { GET } = await import("@/app/api/projects/settings/route");
const { viewerMcpBindings, productionDomainDependencies } = await import("./bindings");
const { createViewerMcpServer, createMcpToolService, MemoryMcpReceiptStore } = await import("./server");
const { permitMaintainerTool } = await import("./toolAllowlist");
const { pipelineStageRuntime } = await import("@/lib/projects/settings");
afterAll(() => { if (prior === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = prior; fs.rmSync(root, { recursive: true, force: true }); });
const http = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => GET(new NextRequest(request)) });
afterAll(() => http.stop(true));
let seatActive = true;
let seatProject = "repo-runtime";
const receipts = new MemoryMcpReceiptStore();
async function protocol(kind: "operator" | "seat" | "worker", project = "repo-runtime", maintenance = false, store = receipts) {
  const bindings = viewerMcpBindings(undefined, undefined, { ...productionDomainDependencies,
    callerProject: () => project,
    callerAttribution: () => ({ kind: kind === "operator" ? "gateway" as const : "agent" as const, conversationId: kind === "operator" ? null : `conversation_${kind}`, role: null }),
    attentionAuthority: () => kind === "operator" ? { kind: "root" as const, conversationId: null } : { kind: "worker" as const, conversationId: `conversation_${kind}`, role: "builder" },
    authorizedSeats: () => seatActive ? [{ conversationId: "conversation_seat", project: seatProject, path: null }] : [],
  });
  const server = createViewerMcpServer(createMcpToolService(bindings, store, maintenance ? { permit: permitMaintainerTool } : undefined));
  const client = new Client({ name: "runtime-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  return { call: (args: Record<string, unknown>) => client.callTool({ name: "seat_tick_settings", arguments: args }), close: async () => { await client.close(); await server.close(); } };
}

test("operator and designated seat read and set the audited project default through the SDK and real service", async () => {
  for (const kind of ["operator", "seat"] as const) {
    const p = await protocol(kind);
    try {
      const read = await p.call({ clientRequestId: `runtime-${kind}-read`, pipelineStageRuntime: null });
      expect(read.isError, JSON.stringify(read)).not.toBe(true);
      expect(read.structuredContent).toMatchObject({ pipelineStageRuntime: "local" });
      const set = await p.call({ clientRequestId: `runtime-${kind}`, pipelineStageRuntime: "codex-cloud" });
      expect(set.isError, JSON.stringify(set)).not.toBe(true);
      expect(set.structuredContent).toMatchObject({ changed: true, changedFields: ["pipelineStageRuntime"], pipelineStageRuntime: "codex-cloud" });
      const body = await (await fetch(`http://127.0.0.1:${http.port}/api/projects/settings?project=repo-runtime`)).json();
      expect(body).toMatchObject({ pipelineStageRuntime: "codex-cloud", pipelineStageRuntimeSetting: { runtime: "codex-cloud", changedBy: kind === "operator" ? "operator" : "conversation_seat", changedAt: expect.any(String) } });
      expect((await p.call({ clientRequestId: `runtime-${kind}-reset`, pipelineStageRuntime: "local" })).isError).not.toBe(true);
    } finally { await p.close(); }
  }
});

test("maintenance policy refuses runtime changes before receipt replay", async () => {
  const accepted = await protocol("operator");
  try {
    expect((await accepted.call({ clientRequestId: "runtime-maintenance-accepted", pipelineStageRuntime: "codex-cloud" })).isError).not.toBe(true);
    expect((await accepted.call({ clientRequestId: "runtime-maintenance-reset", pipelineStageRuntime: "local" })).isError).not.toBe(true);
  } finally { await accepted.close(); }
  const p = await protocol("operator", "repo-runtime", true);
  try { expect((await p.call({ clientRequestId: "runtime-maintenance-accepted", pipelineStageRuntime: "codex-cloud" })).isError).toBe(true); }
  finally { await p.close(); }
});

test("invalid runtimes and mixed tick changes are refused before any setting changes", async () => {
  const p = await protocol("operator", "repo-invalid-runtime");
  try {
    for (const [index, value] of ["remote", 1, {}, false].entries()) {
      expect((await p.call({ clientRequestId: `runtime-invalid-${index}`, pipelineStageRuntime: value })).isError).toBe(true);
    }
    expect((await p.call({ clientRequestId: "runtime-mixed", pipelineStageRuntime: "codex-cloud", enabled: false })).isError).toBe(true);
    expect(pipelineStageRuntime("repo-invalid-runtime")).toBe("local");
    expect((await p.call({ clientRequestId: "runtime-unchanged-tick" })).structuredContent).toMatchObject({ effective: { enabled: true } });
  } finally { await p.close(); }
});

test("a seat moved during receipt admission cannot redirect an omitted-project write", async () => {
  const store = new MemoryMcpReceiptStore();
  const claim = store.claim.bind(store);
  store.claim = (...args) => { const result = claim(...args); seatProject = "repo-moved"; return result; };
  const p = await protocol("seat", "repo-runtime", false, store);
  try {
    const result = await p.call({ clientRequestId: "runtime-moving-seat", pipelineStageRuntime: "codex-cloud" });
    expect(result.isError, JSON.stringify(result)).toBe(true);
    expect(pipelineStageRuntime("repo-runtime")).toBe("local");
    expect(pipelineStageRuntime("repo-moved")).toBe("local");
  } finally { seatProject = "repo-runtime"; await p.close(); }
});

test("an omitted project binds receipts to the actual caller and project", async () => {
  const original = await protocol("operator", "repo-first");
  try {
    expect((await original.call({ clientRequestId: "runtime-scope-read", pipelineStageRuntime: null })).structuredContent).toMatchObject({ project: "repo-first", pipelineStageRuntime: "local" });
    expect((await original.call({ clientRequestId: "runtime-scope-write", pipelineStageRuntime: "codex-cloud" })).isError).not.toBe(true);
  } finally { await original.close(); }
  const other = await protocol("operator", "repo-second");
  try {
    const read = await other.call({ clientRequestId: "runtime-scope-read", pipelineStageRuntime: null });
    expect(read.structuredContent).toMatchObject({ project: "repo-second", pipelineStageRuntime: "local" });
    const set = await other.call({ clientRequestId: "runtime-scope-write", pipelineStageRuntime: "codex-cloud" });
    expect(set.isError, JSON.stringify(set)).not.toBe(true);
    expect(pipelineStageRuntime("repo-second")).toBe("codex-cloud");
    expect((await other.call({ clientRequestId: "runtime-explicit-unseated", pipelineStageRuntime: null, project: "repo-second" })).structuredContent).toMatchObject({ project: "repo-second", pipelineStageRuntime: "codex-cloud" });
  } finally { await other.close(); }
});

test("workers, foreign seats and revoked seats cannot mutate or replay the setting", async () => {
  const accepted = await protocol("seat");
  try {
    expect((await accepted.call({ clientRequestId: "runtime-authorization", project: "repo-runtime", pipelineStageRuntime: "codex-cloud" })).isError).not.toBe(true);
    expect((await accepted.call({ clientRequestId: "runtime-authorization-reset", project: "repo-runtime", pipelineStageRuntime: "local" })).isError).not.toBe(true);
  } finally { await accepted.close(); }
  for (const [kind, project] of [["worker", "repo-runtime"], ["seat", "repo-other"]] as const) {
    const p = await protocol(kind, project);
    try {
      expect((await p.call({ clientRequestId: "runtime-authorization", project, pipelineStageRuntime: "codex-cloud" })).isError).toBe(true);
      expect((await p.call({ clientRequestId: `runtime-denied-read-${kind}`, project, pipelineStageRuntime: null })).isError).toBe(true);
      const ordinaryRead = await p.call({ clientRequestId: `runtime-ordinary-read-${kind}` });
      expect(ordinaryRead.isError, JSON.stringify(ordinaryRead)).not.toBe(true);
      expect(ordinaryRead.structuredContent).not.toHaveProperty("pipelineStageRuntime");
      expect(pipelineStageRuntime(project)).toBe("local");
    } finally { await p.close(); }
  }
  seatActive = false;
  const revoked = await protocol("seat");
  try { expect((await revoked.call({ clientRequestId: "runtime-authorization", project: "repo-runtime", pipelineStageRuntime: "codex-cloud" })).isError).toBe(true); }
  finally { seatActive = true; await revoked.close(); }
});
