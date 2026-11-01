/**
 * claude-cloud over the tool surface: an SDK client on the real MCP server and
 * tool service, into the real bindings and engine and a real Git repository.
 */
import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "claude-cloud-mcp-"));
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "LLV_STATE_DIR", "LLV_CODEX_HOME", "LLV_CLAUDE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "TMPDIR"]) {
  const dir = path.join(sandbox, key);
  fs.mkdirSync(dir, { recursive: true });
  process.env[key] = dir;
}
process.env.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:1";
/* A stage running this test carries its own capability; the caller here is the injected one. */
const { VIEWER_SPAWN_CAPABILITY_ENV } = await import("@/lib/agent/spawnPolicy");
delete process.env[VIEWER_SPAWN_CAPABILITY_ENV];
process.env.LLV_RUNTIME_HOST_SOCKET = path.join(sandbox, "runtime.sock");
process.env.LLV_RUNTIME_HOST_CONTROL_SOCKET = path.join(sandbox, "absent.sock");
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

/* A signed-in Claude account: a stage on an engine nobody is signed in to is refused at start. */
fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR!, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fixture", expiresAt: Date.now() + 3_600_000, scopes: ["user:inference"] } }));

const repoDir = path.join(sandbox, "repo");
fs.mkdirSync(repoDir);
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture", ...args], { cwd: repoDir, encoding: "utf8" });
git("init", "--initial-branch=main"); git("commit", "--allow-empty", "-m", "base");
const baseRef = git("rev-parse", "HEAD").trim();
const creatorPath = path.join(process.env.LLV_CODEX_HOME!, "sessions", "creator.jsonl");
fs.mkdirSync(path.dirname(creatorPath), { recursive: true });
fs.writeFileSync(creatorPath, "{}\n");

const { viewerMcpBindings, productionDomainDependencies } = await import("./bindings");
const { agentRegistry } = await import("@/lib/agent/registry");
const { createMcpToolService, createViewerMcpServer, MemoryMcpReceiptStore } = await import("./server");
const { loadPipelines } = await import("@/lib/pipelines/store");
const { getPipeline } = await import("@/lib/pipelines/engine");
const creator = agentRegistry().ensureConversation("codex", creatorPath, null);

let sequence = 0;
async function protocol() {
  const bindings = viewerMcpBindings(undefined, undefined, { ...productionDomainDependencies,
    attentionAuthority: () => ({ kind: "root" as const, conversationId: creator.id, role: null }),
    callerAttribution: () => ({ kind: "manager" as const, conversationId: creator.id, role: "orchestrator" }),
    authorizedSeats: () => [], callerProject: () => null } as never);
  const server = createViewerMcpServer(createMcpToolService(bindings, new MemoryMcpReceiptStore()));
  const client = new Client({ name: "claude-cloud-runtime-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: { clientRequestId: `claude-cloud-${++sequence}`, ...args } });
    return { isError: result.isError === true, answer: result.structuredContent as Record<string, unknown>, raw: JSON.stringify(result) };
  };
  return { call, close: async () => { await client.close(); await server.close(); } };
}

const stage = (over: Record<string, unknown> = {}) => ({ id: "review", kind: "run", role: { roleId: "reviewer" }, engine: "claude", model: "opus", effort: "high", prompt: "Review {{task}}.", next: null, ...over });
const create = (p: Awaited<ReturnType<typeof protocol>>, task: string, stages: unknown[]) => p.call("create_pipeline", { task, repoDir, baseRef, src: creatorPath, autoStart: false, stages });

test("create_pipeline accepts claude-cloud on a Claude stage and stores it", async () => {
  const p = await protocol();
  try {
    const created = await create(p, "Run the review in the cloud", [stage({ runtime: "claude-cloud" })]);
    expect(created.isError, created.raw).toBe(false);
    const record = loadPipelines().find(row => row.id === created.answer.pipelineId || row.id === created.answer.id);
    expect(record?.stages[0]).toMatchObject({ runtime: "claude-cloud", model: "opus" });
  } finally { await p.close(); }
});

test("create_pipeline refuses claude-cloud on a Codex stage with its reason, and an unknown runtime at the schema", async () => {
  const p = await protocol();
  try {
    const mismatched = await create(p, "Wrong engine", [stage({ runtime: "claude-cloud", engine: "codex", model: "gpt-6.1-sol", effort: "high" })]);
    expect(mismatched.isError).toBe(true);
    expect(mismatched.raw).toContain("claude-cloud requires a Claude reviewer");
    const unknown = await create(p, "Unknown runtime", [stage({ runtime: "gemini-cloud" })]);
    expect(unknown.isError).toBe(true);
    expect(unknown.raw).toContain("runtime");
  } finally { await p.close(); }
});

test("override-stage moves a stage to claude-cloud and back to local for the next attempt", async () => {
  const p = await protocol();
  try {
    const created = await create(p, "Move a stage to the cloud", [stage()]);
    expect(created.isError, created.raw).toBe(false);
    const pipelineId = String(created.answer.pipelineId ?? created.answer.id);
    const moved = await p.call("pipeline_action", { pipelineId, action: "override-stage", stageId: "review", runtime: "claude-cloud" });
    expect(moved.isError, moved.raw).toBe(false);
    expect(getPipeline(pipelineId)?.stages[0]).toMatchObject({ runtime: "claude-cloud", model: "opus" });
    const refused = await p.call("pipeline_action", { pipelineId, action: "override-stage", stageId: "review", engine: "codex", model: "gpt-6.1-sol" });
    expect(refused.isError).toBe(true);
    expect(refused.raw).toContain("claude-cloud requires a Claude reviewer");
    expect(getPipeline(pipelineId)?.stages[0]?.engine).toBe("claude");
    const local = await p.call("pipeline_action", { pipelineId, action: "override-stage", stageId: "review", runtime: "local" });
    expect(local.isError, local.raw).toBe(false);
    expect(getPipeline(pipelineId)?.stages[0]?.runtime).toBe("local");
  } finally { await p.close(); }
});
