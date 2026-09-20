import { expect, test } from "bun:test";
import { readDataset, validate, hash, readRun, writeRun, plan } from "./runner";
import { sandbox, model } from "./testSupport";
import fs from "node:fs";
import path from "node:path";
test("manifest pins actual bytes, balanced arms, Viewer engine/alias and order", () => {
    const d = readDataset();
    expect(validate(d)).toEqual([]);
    expect(d.cells.filter(c => c.requestedModel === "sonnet-5").every(c => c.engine === "claude" && c.launchAlias === "sonnet")).toBe(true);
    const changed = structuredClone(d);
    changed.fixtures[0].treeHash = "0".repeat(64);
    expect(validate(changed)).toContain("quota-window: fixture bytes changed");
    changed.cells[0].requestedEffort = "medium";
    expect(validate(changed)).toContain("quota-window: A/B treatment drift");
});
test("plan checks current dataset before even recovering pending work", () => {
    const s = sandbox();
    try {
        const r = readRun(s.root);
        r.receipts.push({ cellId: "quota-window-A", clientRequestId: "old", payloadHash: hash("old"), status: "unknown" });
        writeRun(s.root, r);
        s.dataset.fixtures[0].taskHash = "0".repeat(64);
        expect(() => plan(s.dataset, s.root, [model], { taskId: "t", parentConversationId: "p", cwd: s.root })).toThrow("fixture bytes changed");
    }
    finally {
        s.cleanup();
    }
});
test("unsupported model evidence blocks and never silently substitutes", () => {
    const s = sandbox();
    try {
        expect(() => plan(s.dataset, s.root, [], { taskId: "t", parentConversationId: "p", cwd: s.root }, { kind: "planner", caseId: "quota-window" })).toThrow("blocked");
        expect(readRun(s.root).intents).toHaveLength(0);
    }
    finally {
        s.cleanup();
    }
});
test("B requires fresh root planner/assessor receipts and immutable brief bytes; actual launch schema accepts Claude Sonnet", async () => {
    const { prepare, ingest, freezeBrief, verifiedBrief, briefCoverage, git } = await import("./runner");
    const { TOOL_INPUT_SCHEMAS } = await import("../../src/lib/mcp/server");
    const { resolveRole } = await import("../../src/lib/roles/registry");
    const { ROLE_DEFAULTS } = await import("../../src/lib/roles/defaults");
    const s = sandbox();
    try {
        const workspaces = path.join(s.root, "candidates");
        prepare(s.dataset, workspaces, s.sealed);
        const strongHigh = { ...model, launchAlias: "gpt-6-astra", requestedModel: "gpt-6-astra", resolvedModel: "gpt-6-astra", effort: "high" };
        const strongMedium = { ...strongHigh, effort: "medium" };
        const sonnet = { ...model, engine: "claude" as const, launchAlias: "sonnet", requestedModel: "sonnet-5", resolvedModel: "sonnet-5" };
        const models = [model, strongHigh, strongMedium, sonnet];
        // Independent discovery files are bound to each engine.
        strongHigh.discoveryArtifact = strongMedium.discoveryArtifact = model.discoveryArtifact = "codex-discovery.json";
        sonnet.discoveryArtifact = "claude-discovery.json";
        for (const engine of ["codex", "claude"])
            fs.writeFileSync(path.join(s.root, engine + "-discovery.json"), JSON.stringify({ engine, runtimeVersion: "test-runtime", models: models.filter(m => m.engine === engine) }));
        function complete(output: NonNullable<ReturnType<typeof plan>>) {
            if (!output.intent)
                throw new Error("unexpected blocked plan");
            const i = output.intent;
            expect(TOOL_INPUT_SCHEMAS.spawn_agent.safeParse(i.payload).success).toBe(true);
            expect(resolveRole(String(i.payload.role), i.payload.roleParams, { engine: i.model.engine, model: i.model.launchAlias, effort: i.model.effort }, [...ROLE_DEFAULTS]).ok).toBe(true);
            const r = { cellId: i.cellId, clientRequestId: i.clientRequestId, payloadHash: i.payloadHash, status: "admitted" as const, conversationId: "fresh-" + i.cellId, launchId: "launch-" + i.cellId, observedModel: i.model.resolvedModel };
            ingest(s.dataset, s.root, r);
            const completed = { ...r, status: "completed" as const, candidateHead: git(i.cwd, ["rev-parse", "HEAD"]), publishedHead: git(i.cwd, ["rev-parse", "HEAD"]) };
            ingest(s.dataset, s.root, completed);
            return { intent: i, receipt: completed };
        }
        for (const fixture of s.dataset.fixtures) {
            const identity = { taskId: "canonical", parentConversationId: "root", cwd: path.join(workspaces, fixture.id + "-planner") };
            const planner = complete(plan(s.dataset, s.root, models, identity, { kind: "planner", caseId: fixture.id })!);
            const text = "Behavior and invariant decisions for " + fixture.id + ". Preserve the provided interfaces and validate all declared checks. Escalate unknown behavior. No implementation is supplied.";
            const plannerFile = fixture.id + "-planner.json";
            fs.writeFileSync(path.join(s.root, plannerFile), JSON.stringify({ conversationId: planner.receipt.conversationId, hasMore: false, records: [{ role: "assistant", text, ts: "2026-09-20T01:00:00Z" }] }));
            const frozen = freezeBrief(s.dataset, s.root, fixture.id, plannerFile);
            const assessor = complete(plan(s.dataset, s.root, models, identity, { kind: "brief-assessor", caseId: fixture.id, briefFile: frozen.file })!);
            const assessorFile = fixture.id + "-assessor.json";
            fs.writeFileSync(path.join(s.root, assessorFile), JSON.stringify({ conversationId: assessor.receipt.conversationId, hasMore: false, records: [{ role: "assistant", text: "APPROVE at " + frozen.briefHash + "; inspected all coverage and no-code conditions.", ts: "2026-09-20T01:01:00Z" }] }));
            fs.writeFileSync(path.join(s.root, "briefs", fixture.id, "approval.json"), JSON.stringify({ briefHash: frozen.briefHash, taskHash: fixture.taskHash, baseCommit: fixture.baseCommit, planner: { ...planner, transcript: plannerFile }, assessor: { ...assessor, transcript: assessorFile }, coverage: Object.fromEntries(briefCoverage.map(k => [k, "Independently checked in this synthetic test."])), verdict: "APPROVE" }));
            expect(verifiedBrief(s.dataset, fixture, s.root).digest).toBe(frozen.briefHash);
        }
        const identity = { taskId: "canonical", parentConversationId: "root", cwd: path.join(workspaces, "quota-window-A") };
        const a = plan(s.dataset, s.root, models, identity)!;
        expect(a).not.toHaveProperty("blocked");
        const done = complete(a);
        const b = plan(s.dataset, s.root, models, { ...identity, cwd: path.join(workspaces, "quota-window-B") })!;
        if (!b.intent)
            throw new Error("B unexpectedly blocked");
        expect(b.intent.prompt.startsWith(done.intent.prompt)).toBe(true);
        expect(b.intent.briefHash).toMatch(/^[a-f0-9]{64}$/);
        complete(b);
        const c = plan(s.dataset, s.root, models, { ...identity, cwd: path.join(workspaces, "quota-window-C") })!;
        complete(c);
        const ui = plan(s.dataset, s.root, models, { ...identity, cwd: path.join(workspaces, "error-row-B") })!;
        if (!ui.intent)
            throw new Error("UI unexpectedly blocked");
        expect(ui.payload).toMatchObject({ engine: "claude", model: "sonnet", effort: "high" });
        expect(TOOL_INPUT_SCHEMAS.spawn_agent.safeParse(ui.payload).success).toBe(true);
        fs.appendFileSync(path.join(s.root, "briefs/error-row/brief.md"), "\nconst executable = true;");
        expect(() => verifiedBrief(s.dataset, s.dataset.fixtures[1], s.root)).toThrow("brief coverage/bytes");
    }
    finally {
        s.cleanup();
    }
});
