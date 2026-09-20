import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { hash, plan, prepare, recover, readRun, writeRun } from "./runner";
import { sandbox, candidate, evidence, model } from "./testSupport";
import type { TrialReceipt } from "./schema";
// Isolation must already be declared before importing the application's module graph.
if (!process.env.LLV_STATE_DIR || !process.env.HOME?.includes("tmp"))
    throw new Error("run lifecycle checks under isolated HOME/XDG/state/provider/TMP");
const { MCP_TOOL_NAMES, TOOL_INPUT_SCHEMAS, createMcpToolService, SqliteMcpReceiptStore, McpDispatchUncertainError } = await import("../../src/lib/mcp/server");
import type { McpToolBindings, McpRecoverableTool, McpRecoveryEvidence } from "../../src/lib/mcp/server";
test("independent runs dispatch twice through Viewer; reopening one run preserves its original request", async () => {
    const first = sandbox(), second = sandbox();
    const filename = path.join(first.root, "shared-receipts.sqlite");
    let store = new SqliteMcpReceiptStore(filename);
    let dispatches = 0;
    const observed = new Map<string, McpRecoveryEvidence>();
    const bindings = Object.fromEntries(MCP_TOOL_NAMES.map(name => [name, async () => { throw new Error("unexpected call"); }])) as unknown as McpToolBindings;
    bindings.spawn_agent = async args => {
        dispatches++;
        const ids = { conversationId: "fresh-worker-" + dispatches, launchId: "fresh-launch-" + dispatches };
        observed.set(String(args.clientRequestId), { outcome: "accepted", evidence: "delivery-record", reason: "fake dispatch readback", ids });
        return { ...ids, outcome: "accepted" };
    };
    const tool: McpRecoverableTool = {
        bind: args => ({ caller: { kind: "worker", conversationId: "test-root", project: "test" }, target: { project: "test", identity: String(args.cwd) }, downstreamKey: String(args.clientRequestId) }),
        recover: async binding => observed.get(binding.clientRequestId) ?? { outcome: "unknown", evidence: "none", reason: "not observed", ids: {} },
    };
    try {
        const workspaces = path.join(first.root, "workspaces");
        prepare(first.dataset, workspaces, first.sealed);
        const strong = { ...model, launchAlias: "gpt-6-astra", requestedModel: "gpt-6-astra", resolvedModel: "gpt-6-astra" };
        for (const root of [first.root, second.root]) fs.writeFileSync(path.join(root, strong.discoveryArtifact), JSON.stringify({ engine: strong.engine, runtimeVersion: strong.runtimeVersion, models: [strong] }));
        const identity = { taskId: "test-task", parentConversationId: "test-root", cwd: path.join(workspaces, "quota-window-planner") };
        const stage = { caseId: "quota-window", kind: "planner" as const };
        const a = plan(first.dataset, first.root, [strong], identity, stage)!;
        const b = plan(second.dataset, second.root, [strong], identity, stage)!;
        if (!a.intent || !b.intent) throw new Error("fresh plans expected");
        const original = structuredClone(readRun(first.root));
        expect(original.datasetHash).toBe(readRun(second.root).datasetHash);
        expect({ ...a.payload, clientRequestId: "same" }).toEqual({ ...b.payload, clientRequestId: "same" });
        let service = createMcpToolService(bindings, store, undefined, { recovery: { spawn_agent: tool } });
        const launchedA = await service.callTool("spawn_agent", a.payload);
        const launchedB = await service.callTool("spawn_agent", b.payload);
        expect(launchedA).toMatchObject({ ok: true, conversationId: "fresh-worker-1" });
        expect(launchedB).toMatchObject({ ok: true, conversationId: "fresh-worker-2" });
        expect(dispatches).toBe(2);
        expect(a.intent.clientRequestId).not.toBe(b.intent.clientRequestId);
        store.close();
        store = new SqliteMcpReceiptStore(filename);
        service = createMcpToolService(bindings, store, undefined, { recovery: { spawn_agent: tool } });
        const reopened = plan(first.dataset, first.root, [strong], identity, stage)!;
        expect(reopened).toMatchObject({ blocked: "unresolved receipt", recovery: { ...a.payload, recoveryOnly: true } });
        expect(readRun(first.root)).toEqual(original);
        expect(await service.callTool("spawn_agent", reopened.recovery!)).toMatchObject({ ok: true, conversationId: "fresh-worker-1", replayed: true });
        expect(await service.callTool("spawn_agent", { ...a.payload, prompt: "changed payload" })).toMatchObject({ ok: false, code: "idempotency_conflict" });
        expect(dispatches).toBe(2);
    } finally {
        store.close();
        first.cleanup();
        second.cleanup();
    }
});
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
