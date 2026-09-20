import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { hash, plan, recover, readRun, writeRun } from "./runner";
import { sandbox, candidate, evidence, model } from "./testSupport";
import type { TrialReceipt } from "./schema";
// Isolation must already be declared before importing the application's module graph.
if (!process.env.LLV_STATE_DIR || !process.env.HOME?.includes("tmp"))
    throw new Error("run lifecycle checks under isolated HOME/XDG/state/provider/TMP");
const { MCP_TOOL_NAMES, TOOL_INPUT_SCHEMAS, createMcpToolService, SqliteMcpReceiptStore, McpDispatchUncertainError } = await import("../../src/lib/mcp/server");
import type { McpToolBindings, McpRecoverableTool, McpRecoveryEvidence } from "../../src/lib/mcp/server";
test("actual Viewer receipt service: lost acknowledgement, reopen, original-key recovery and argument conflict dispatch once", async () => {
    const s = sandbox();
    let count = 0;
    const filename = path.join(s.root, "receipts.sqlite");
    let downstream: McpRecoveryEvidence = { outcome: "unknown", evidence: "none", reason: "lost acknowledgement", ids: {} };
    const bindings = Object.fromEntries(MCP_TOOL_NAMES.map(name => [name, async () => { throw new Error("unexpected call"); }])) as unknown as McpToolBindings;
    bindings.spawn_agent = async () => { count++; throw new McpDispatchUncertainError("ack lost"); };
    const tool: McpRecoverableTool = { bind: args => ({ caller: { kind: "worker", conversationId: "test-root", project: "test" }, target: { project: "test", identity: String(args.cwd) }, downstreamKey: String(args.clientRequestId) }), recover: async () => downstream };
    const args = { clientRequestId: "immutable-cell", cwd: s.root, prompt: "Fixture only", title: "Visible synthetic launch", taskId: "test-task", parentConversationId: "test-root", engine: "claude", model: "sonnet", effort: "high", role: "builder", allowSubagents: false };
    expect(TOOL_INPUT_SCHEMAS.spawn_agent.safeParse(args).success).toBe(true);
    let store = new SqliteMcpReceiptStore(filename);
    try {
        let service = createMcpToolService(bindings, store, undefined, { recovery: { spawn_agent: tool } });
        expect(await service.callTool("spawn_agent", args)).toMatchObject({ ok: false, code: "outcome_unknown" });
        expect(count).toBe(1);
        store.close();
        store = new SqliteMcpReceiptStore(filename);
        service = createMcpToolService(bindings, store, undefined, { recovery: { spawn_agent: tool } });
        expect(await service.callTool("spawn_agent", { ...args, recoveryOnly: true })).toMatchObject({ ok: false, code: "outcome_unknown" });
        expect((await service.callTool("spawn_agent", { ...args, prompt: "changed" })).ok).toBe(false);
        downstream = { outcome: "accepted", evidence: "delivery-record", reason: "root readback", ids: { conversationId: "fresh-worker", launchId: "one-launch" } };
        expect(await service.callTool("spawn_agent", { ...args, recoveryOnly: true })).toMatchObject({ ok: true, outcome: "accepted" });
        expect(count).toBe(1);
    }
    finally {
        store.close();
        s.cleanup();
    }
});
test("all unresolved states fence the next plan, immutable outcomes advance monotonically", () => {
    const s = sandbox();
    try {
        const w = candidate(s.root, "quota-window");
        const { intent, receipt } = evidence(s.root, "quota-window-A", w);
        for (const status of ["planned", "unknown", "admitted"] as const) {
            const run = readRun(s.root);
            run.receipts = [{ ...receipt, status }];
            writeRun(s.root, run);
            const result = plan(s.dataset, s.root, [model], { taskId: "t", parentConversationId: "p", cwd: w });
            expect(result).toMatchObject({ blocked: "unresolved receipt", recovery: { clientRequestId: intent.clientRequestId, recoveryOnly: true } });
        }
        expect(() => recover([receipt], { ...receipt, status: "unknown" }, intent)).toThrow("regression");
        expect(() => recover([receipt], { ...receipt, clientRequestId: "new-key" }, intent)).toThrow("immutable");
        const unknown: TrialReceipt = { cellId: receipt.cellId, clientRequestId: receipt.clientRequestId, payloadHash: receipt.payloadHash, status: "unknown" };
        expect(recover([unknown], { ...receipt, status: "admitted" }, intent)[0].status).toBe("admitted");
    }
    finally {
        s.cleanup();
    }
});
test("real flow relay and review-head seams retain REQUEST_CHANGES and fresh round after exactly one delivery", () => {
    const stdout = execFileSync(process.execPath, ["test", "src/lib/flows/engine.test.ts", "-t", "overlapping relay ticks deliver one review|a review round captures its clean commit"], { encoding: "utf8", stdio: "pipe", timeout: 60000 });
    expect(typeof stdout).toBe("string");
});
