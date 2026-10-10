import { expect, test } from "bun:test";
import { NextRequest } from "next/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { POST } from "@/app/api/board/maintenance/worktrees/route";
import { viewerMcpBindings } from "./bindings";
import { createMcpToolService, MemoryMcpReceiptStore, TOOL_INPUT_SCHEMAS, type McpReceiptStore } from "./server";
import { mcpToolPolicy, permitMaintainerTool } from "./toolAllowlist";

test("MCP dry-run reaches board maintenance without a receipt, even with an explicit key", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "recovery-http-"));
  process.env.LLV_STATE_DIR = root;
  const catalog = path.join(root, "project-catalog.json");
  fs.writeFileSync(catalog, JSON.stringify({ version: 2, files: {} }));
  const receipts: McpReceiptStore = { claim: () => { throw Error("dry-run wrote a receipt"); }, complete: () => { throw Error("dry-run completed a receipt"); } };
  const requests: Record<string, unknown>[] = [];
  const bindings = viewerMcpBindings(undefined, { post: async (url, body) => {
    expect(url).toBe("/api/board/maintenance/worktrees"); requests.push(body);
    const result = await POST(new NextRequest("http://127.0.0.1" + url, { method: "POST", headers: { "Content-Type": "application/json", host: "127.0.0.1" }, body: JSON.stringify(body) }));
    expect(result.status).toBe(200);
    return await result.json();
  } });
  const service = createMcpToolService(bindings, receipts);
  try {
    const result = await service.callTool("backfill_worktree_projects", { clientRequestId: "preview-key" });
    expect(result).toMatchObject({ ok: true, dryRun: true, folded: [], leftAlone: [], rescanned: false });
    expect(requests).toEqual([{ dryRun: true }]);
    expect(fs.readdirSync(root)).toEqual(["project-catalog.json"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("scheduled maintenance can preview; workers and unidentified sessions cannot apply", async () => {
  expect(permitMaintainerTool("backfill_worktree_projects", {})).toEqual({ allowed: true });
  expect(permitMaintainerTool("backfill_worktree_projects", { dryRun: false }).allowed).toBe(false);
  expect(TOOL_INPUT_SCHEMAS.backfill_worktree_projects.safeParse({ dryRun: "false" }).success).toBe(false);
  const bindings = viewerMcpBindings(undefined, { post: async () => { throw Error("refused caller reached action"); } });
  for (const reason of ["worker", "unidentified"] as const) {
    const identity = reason === "worker" ? { kind: "unrestricted" as const, reason: "worker" as const } : { kind: "restricted" as const, reason: "unidentified" as const };
    const service = createMcpToolService(bindings, new MemoryMcpReceiptStore(), mcpToolPolicy(() => identity));
    expect(await service.callTool("backfill_worktree_projects", { dryRun: false, clientRequestId: "apply-key" })).toMatchObject({ ok: false, code: "tool_not_permitted" });
  }
});

test("maintenance endpoint rejects cross-origin and malformed requests before reading state", async () => {
  const url = "http://127.0.0.1/api/board/maintenance/worktrees";
  expect((await POST(new NextRequest(url, { method: "POST", headers: { host: "127.0.0.1", origin: "https://foreign.invalid" }, body: "{}" }))).status).toBe(403);
  expect((await POST(new NextRequest(url, { method: "POST", headers: { host: "127.0.0.1" }, body: JSON.stringify({ dryRun: "false" }) }))).status).toBe(400);
});
