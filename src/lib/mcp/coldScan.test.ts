import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { agentRegistry } from "@/lib/agent/registry";
import { statePath } from "@/lib/configDir";
import { completedFileScan, resetFilesRouteCacheForTests, setFileCatalogMembershipProbeForTests, setFileScanRunnerForTests } from "@/lib/scanner/scanCache";
import { productionDomainDependencies, viewerMcpBindings, viewerMcpRecoverableTools, type ViewerMcpDomainDependencies } from "./bindings";
import { createMcpToolService, SqliteMcpReceiptStore } from "./server";

afterEach(() => {
  resetFilesRouteCacheForTests();
  setFileScanRunnerForTests(null);
  setFileCatalogMembershipProbeForTests(null);
  fs.rmSync(statePath("files-scan-snapshot.json"), { force: true });
});

test("MCP waits for catalog membership before treating a cached inventory as complete", async () => {
  resetFilesRouteCacheForTests();
  setFileCatalogMembershipProbeForTests(async () => "initial");
  setFileScanRunnerForTests(async () => ({ files: [], projectCatalog: [], complete: true }));
  await completedFileScan();
  setFileCatalogMembershipProbeForTests(async () => "changed");
  setFileScanRunnerForTests(async () => ({ files: [], projectCatalog: [], complete: false }));
  // An older snapshot cannot prove that a newly created project is absent.
  await expect(productionDomainDependencies.completedFileScan()).rejects.toMatchObject({
    details: { code: "scan_incomplete", retryable: true },
  });
});

test("an incomplete scan refuses an orchestrator send retryably before claiming its key", async () => {
  resetFilesRouteCacheForTests();
  setFileCatalogMembershipProbeForTests(async () => "fixture");
  let complete = false;
  setFileScanRunnerForTests(async () => ({ files: [], projectCatalog: [], complete }));
  const registry = agentRegistry();
  const caller = registry.ensureConversation("codex", "/sessions/source.jsonl", null);
  const domain: ViewerMcpDomainDependencies = {
    ...productionDomainDependencies,
    registrySnapshot: () => registry.readOnlySnapshot(),
    authorizedSeats: () => [],
    attentionAuthority: () => ({ kind: "worker" as const, conversationId: caller.id, role: "builder" }),
    callerAttribution: () => ({ kind: "gateway", conversationId: caller.id, role: "gateway" }),
    recoveryPredecessors: () => [],
  };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scan-receipts-"));
  const receipts = new SqliteMcpReceiptStore(path.join(directory, "receipts.sqlite"));
  let writes = 0;
  const control = {
    post: async () => { writes += 1; throw new Error("unexpected dispatch"); },
  };
  const service = createMcpToolService(viewerMcpBindings(undefined, control, domain), receipts, undefined, {
    recovery: viewerMcpRecoverableTools(domain),
  });
  const args = { project: "unknown-project", text: "Synthetic status", clientRequestId: "cold-send" };
  try {
    const result = await service.callTool("send_message_to_orchestrator", args);
    expect(result).toMatchObject({
      ok: false, code: "scan_incomplete", retryable: true,
      details: { retryAfterSeconds: 5, outcome: "not-executed", nextAction: "retry-same-key" },
    });
    expect("error" in result && result.error).toContain("still scanning, retry in 5 s");
    expect(receipts.lookup("send_message_to_orchestrator:cold-send")).toBeNull();
    expect(writes).toBe(0);
    // Ordinary admission preparation uses the same retryable contract.
    const create = await service.callTool("create_orchestrator", { project: "unknown-project", clientRequestId: "cold-create" });
    expect(create).toMatchObject({ ok: false, code: "scan_incomplete", retryable: true });
    expect(receipts.lookup("create_orchestrator:cold-create")).toBeNull();
    complete = true;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    await completedFileScan();
    // The same key reaches normal project validation after the scan completes.
    expect(await service.callTool("send_message_to_orchestrator", args)).toMatchObject({
      ok: false, code: "unknown_project", retryable: false,
    });
    expect(writes).toBe(0);
  } finally {
    receipts.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
