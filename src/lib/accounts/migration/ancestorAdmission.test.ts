import { test, expect, spyOn, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { RegisteredSuccessorProvider, preflightCodexSource } from "./provider";
import { MissingSourceAncestorError } from "./safeHistoryCopy";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import type { RuntimeOperationCommand } from "@/lib/runtime/contracts";
import { CodexAppServerHost } from "@/lib/runtime/codexAppServerHost";
import { setCodexFeatureReaderForTest } from "@/lib/agent/codexSpawnPolicy";
import { CodexAppServerClient } from "@/lib/accounts/codexAppServer";
import { emptyLaunchProfile } from "./contracts";
import { AgentRegistry } from "@/lib/agent/registry";
import { beginLegacySpawnFixture } from "@/lib/agent/registryTestFixtures";
import { applyStructuredReconfigure } from "@/lib/runtime/structuredReconfigure";
import { advanceConversationMigration } from "./coordinator";
import { RuntimeJournal } from "@/runtime-host/journal";
import { dispatchStructuredControl } from "@/lib/runtime/structuredControls";
import { applyConversationMigration } from "./conversationCommand";
import { StructuredDeliveryQueue } from "@/lib/runtime/structuredDeliveryQueue";
const restorations: Array<() => void> = [];
afterEach(() => { for (const restore of restorations.splice(0).reverse())
    restore(); });
function accountRoot(engine: "claude" | "codex", base: string, id: string) {
    const home = path.join(base, id);
    const transcriptRoot = path.join(home, engine === "claude" ? "projects" : "sessions");
    fs.mkdirSync(transcriptRoot, { recursive: true, mode: 0o700 });
    fs.chmodSync(home, 0o700);
    fs.chmodSync(transcriptRoot, 0o700);
    return { engine, accountId: id, kind: "managed" as const, home, transcriptRoot, env: { ...process.env } };
}
function codexSessionMeta(id: string, forkedFromId?: string): string {
    return JSON.stringify({
        type: "session_meta",
        payload: { id, ...(forkedFromId ? { forked_from_id: forkedFromId } : {}) },
    }) + "\n";
}
test.each(["native-host-control", "native-host-preparation", "native-host-owner", "native-host-epoch", "native-host-writer", "native-host-policy", "native-host-operation", "native-host-successor-owner", "native-host-successor-epoch", "native-host-successor-writer", "missing", "missing-hostile", "valid", "removed", "removed-hostile", "provider-missing", "provider-hostile", "withdraw-missing", "carried-missing", "source-start", "source-auth", "fork-return", "target-start", "target-auth", "config-read", "resume-return", "name-return", "goal-return", "read-return", "verify-start", "verify-auth", "verify-read", "publish-return", "publication-authorization", "journal-ack", "release-owner", "admission-owner", "admission-epoch", "admission-writer", "admission-generation", "operation-revision", "pipeline-policy", "execution-owner", "authentication", "reseat-write", "continuity-write", "commit-write"] as const)("ancestor admission through selection, journal and queue: %s", async (mode) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "ancestor-admission-"));
    const source = accountRoot("codex", base, "source"), target = accountRoot("codex", base, "target");
    const fixtureId = (part: string) => [part.repeat(8), part.repeat(4), "4" + part.repeat(3), "8" + part.repeat(3), part.repeat(12)].join("-");
    const sourceId = fixtureId("1"), parentId = fixtureId("2"), missingId = fixtureId("3"), forkId = fixtureId("4");
    const sourcePath = path.join(source.transcriptRoot, `rollout-${sourceId}.jsonl`);
    const hostileId = "../private/path\n" + "credential-material".repeat(4);
    const failedId = mode.endsWith("hostile") ? hostileId : missingId;
    const parentPath = path.join(source.transcriptRoot, `rollout-${parentId}.jsonl`);
    const forkPath = path.join(source.transcriptRoot, `rollout-${forkId}.jsonl`);
    fs.writeFileSync(sourcePath, codexSessionMeta(sourceId, parentId) + JSON.stringify({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "done" } }) + "\n", { mode: 0o600 });
    fs.writeFileSync(parentPath, codexSessionMeta(parentId, mode === "missing-hostile" ? hostileId : missingId), { mode: 0o600 });
    if (!mode.startsWith("missing"))
        fs.writeFileSync(path.join(source.transcriptRoot, `rollout-${missingId}.jsonl`), codexSessionMeta(missingId), { mode: 0o600 });
    const registry = new AgentRegistry(path.join(base, "registry.json"), undefined, undefined, { sqliteMode: "off" });
    const profile = emptyLaunchProfile({ cwd: base, title: "Ancestry probe", model: "gpt-6-astra", effort: "high", fast: false, ...(mode === "goal-return" ? { goal: { objective: "Fixture objective", status: "active" as const, tokensUsed: null, timeUsedSeconds: null } } : {}) });
    const begun = beginLegacySpawnFixture(registry, { engine: "codex", cwd: base, accountId: "source", transport: "structured", launchProfile: profile });
    if (begun.kind !== "created")
        throw Error("fixture admission failed");
    registry.settleSpawn(begun.receipt.launchId, { key: { engine: "codex", sessionId: sourceId }, artifactPath: sourcePath, cwd: base, accountId: "source", status: "idle", host: null,
        structuredHost: { kind: "codex-app-server", endpoint: "test:host", process: { pid: process.pid, startIdentity: "fixture" }, eventCursor: 1, protocolVersion: "test", writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] },
        claimEpoch: 1, claimOwner: "structured-host:test", pendingAction: null, launchProfile: begun.receipt.launchProfile });
    registry.reconcileConversations([{ engine: "codex", path: sourcePath, accountId: "source", launchProfile: profile, turn: { state: "terminal", source: "lifecycle", terminalAt: "2026-11-07T10:00:00.000Z" }, observedAt: "2026-11-07T10:00:00.000Z" }]);
    const events: string[] = [];
    let displaced = false;
    let pipelineAllowed = true;
    const boundary = (at: string) => {
        if (mode !== at || displaced)
            return;
        displaced = true;
        if (at.startsWith("native-host-successor")) {
            const key = { engine: "codex" as const, sessionId: forkId };
            const entry = registry.readOnlySnapshot().entries[`codex:${forkId}`]!;
            registry.upsert({ ...entry, key,
                claimOwner: at.endsWith("owner") ? "structured-host:replacement" : entry.claimOwner,
                claimEpoch: entry.claimEpoch + (at.endsWith("epoch") ? 1 : 0),
                structuredHost: { ...entry.structuredHost!, writerClaimEpoch: entry.claimEpoch + (at.endsWith("writer") ? 1 : 0) },
            });
            return;
        }
        if (at === "pipeline-policy" || at === "native-host-policy") { pipelineAllowed = false; return; }
        if (at === "operation-revision" || at === "native-host-operation") {
            registry.claimConversationReconfigure(begun.receipt.conversationId, { operationId: "replacement-switch", revision: 100, profile: { model: profile.model, effort: profile.effort, fast: profile.fast }, accountId: "target" });
            return;
        }
        if (at === "admission-generation") {
            const id = begun.receipt.conversationId;
            let migration = registry.requestConversationReseat(id, "replacement").migration!;
            migration = registry.transitionConversationMigration(id, migration.revision, [migration.phase], { phase: "preparing" }).migration!;
            migration = registry.transitionConversationMigration(id, migration.revision, ["preparing"], { phase: "successor-starting" }).migration!;
            const replacement = { operationId: migration.operationId, nativeId: fixtureId("5"), path: path.join(base, "replacement.jsonl"), continuityPaths: [], historyHash: "fixture-hash", host: { kind: "codex-app-server" as const, identity: "replacement", epoch: 2, verifiedAt: "2026-11-07T10:00:00.000Z" } };
            registry.persistMigrationProviderReceipt(id, migration.revision, migration.operationId, replacement);
            registry.commitSuccessor(id, { id: replacement.nativeId, path: replacement.path, accountId: "replacement", launchProfile: profile, historyHash: replacement.historyHash, host: replacement.host }, migration.revision, migration.operationId, replacement);
            return;
        }
        if (["native-host-owner", "native-host-epoch", "native-host-writer"].includes(at) || at.startsWith("admission") || at === "execution-owner" || at === "authentication" || at === "reseat-write" || at === "commit-write" || at === "publication-authorization" || at === "journal-ack" || at === "release-owner") {
            const key = { engine: "codex" as const, sessionId: sourceId };
            const entry = registry.readOnlySnapshot().entries[`codex:${sourceId}`]!;
            registry.upsert({ ...entry, key,
                claimOwner: (at === "admission-epoch" || at === "native-host-epoch") || (at === "admission-writer" || at === "native-host-writer") ? entry.claimOwner : "structured-host:replacement",
                claimEpoch: (at === "admission-epoch" || at === "native-host-epoch") ? entry.claimEpoch + 1 : entry.claimEpoch,
                structuredHost: { ...entry.structuredHost!, writerClaimEpoch: (at === "admission-writer" || at === "native-host-writer") ? entry.claimEpoch + 1 : entry.structuredHost!.writerClaimEpoch },
            });
        }
        else {
            const current = registry.conversation(begun.receipt.conversationId)!;
            if (current.migration)
                registry.rollbackConversationMigration(current.id, current.migration.revision);
            else
                registry.withdrawConversationReconfigure(current.id, "ancestor-probe");
        }
    };
    const atWrite = (label: string) => {
        if (label === "delivery.reseat") boundary("reseat-write");
        if (label === "migration.continuity") boundary("continuity-write");
        if (label === "migration.commit") boundary("commit-write");
    };
    const deliveryWrite = registry.deliveryWrite.bind(registry);
    const writer = spyOn(registry, "deliveryWrite").mockImplementation((<T>(correlation: Parameters<AgentRegistry["deliveryWrite"]>[0], write: () => T) => deliveryWrite(correlation, () => {
        atWrite(correlation.label);
        return write();
    })) as AgentRegistry["deliveryWrite"]);
    const writeOrBusy = registry.deliveryWriteOrBusy.bind(registry);
    const busyWriter = spyOn(registry, "deliveryWriteOrBusy").mockImplementation((<T>(correlation: Parameters<AgentRegistry["deliveryWriteOrBusy"]>[0], write: () => T) => writeOrBusy(correlation, () => {
        atWrite(correlation.label);
        return write();
    })) as AgentRegistry["deliveryWriteOrBusy"]);
    restorations.push(() => writer.mockRestore(), () => busyWriter.mockRestore());
    let clientStarts = 0;
    class Transport extends EventEmitter {
        constructor(readonly clientNumber: number) { super(); }
        pid = 4242;
        stdout = { on: (_e: string, cb: (chunk: string) => void) => this.on("stdout", cb) };
        stderr = { on: () => { } };
        stdin = { write: (line: string) => {
                const m = JSON.parse(line) as {
                    id?: number;
                    method: string;
                    params: {
                        path?: string;
                        threadId?: string;
                    };
                };
                if (typeof m.id !== "number")
                    return true;
                events.push(m.method);
                let result: unknown = {};
                if (m.method === "account/read")
                    result = { account: { type: "chatgpt" }, requiresOpenaiAuth: true };
                else if (m.method === "thread/fork") {
                    expect(m.params).toEqual({ threadId: sourceId });
                    fs.writeFileSync(forkPath, codexSessionMeta(forkId, sourceId), { mode: 0o600 });
                    result = { thread: { id: forkId, path: forkPath } };
                }
                else if (m.method === "config/read")
                    result = { config: { mcp_servers: {} } };
                else if (m.method === "thread/resume") {
                    for (const id of [sourceId, parentId, missingId])
                        expect(fs.existsSync(path.join(target.transcriptRoot, `rollout-${id}.jsonl`))).toBe(true);
                    result = { thread: { id: forkId, path: m.params.path } };
                }
                else if (m.method === "thread/read")
                    result = { thread: { id: forkId, path: null } };
                else if (m.method === "thread/name/set" || m.method === "thread/goal/set")
                    result = {};
                else if (m.method !== "initialize")
                    throw Error("unexpected vendor method " + m.method);
                if (m.method === "account/read" && this.clientNumber === 1) {
                    boundary("pipeline-policy"); boundary("operation-revision");
                }
                if (m.method === "account/read")
                    boundary(this.clientNumber === 1 ? "source-auth" : this.clientNumber === 2 ? "target-auth" : "verify-auth");
                if (m.method === "thread/fork")
                    boundary("fork-return");
                if (m.method === "config/read")
                    boundary("config-read");
                if (m.method === "thread/resume")
                    boundary("resume-return");
                if (m.method === "thread/name/set")
                    boundary("name-return");
                if (m.method === "thread/goal/set")
                    boundary("goal-return");
                if (m.method === "thread/read")
                    boundary(this.clientNumber === 3 ? "verify-read" : "read-return");
                this.emit("stdout", JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\n");
                return true;
            }, end: () => { this.emit("close", 0, null); } };
        kill() { this.emit("close", 0, null); return true; }
    }
    if (mode.startsWith("native-host")) {
        const flags = { LLV_STRUCTURED_HOSTS: process.env.LLV_STRUCTURED_HOSTS, LLV_AGENT_CPU: process.env.LLV_AGENT_CPU, LLV_AGENT_MEMORY: process.env.LLV_AGENT_MEMORY };
        Object.assign(process.env, { LLV_STRUCTURED_HOSTS: "1", LLV_AGENT_CPU: "off", LLV_AGENT_MEMORY: "off" });
        restorations.push(() => { for (const [key,value] of Object.entries(flags)) { if(value === undefined) delete process.env[key]; else process.env[key] = value; } });
        restorations.push(setCodexFeatureReaderForTest(() => []));
        const realAdopt = CodexAppServerHost.adopt.bind(CodexAppServerHost);
        const adoptSpy = spyOn(CodexAppServerHost, "adopt").mockImplementation((threadId, options) => realAdopt(threadId, { ...options,
            binary: "/fixture/codex", launchBinary: "/fixture/codex", memoryCell: null,
            readProtocolVersion: () => { events.push("host-protocol-preparation"); for (const at of ["native-host-preparation", "native-host-owner", "native-host-epoch", "native-host-writer", "native-host-policy", "native-host-operation", "native-host-successor-owner", "native-host-successor-epoch", "native-host-successor-writer"]) boundary(at); return "0.162.1"; },
            spawnProcess: () => { events.push("native-spawn"); throw new Error("fixture stops at native spawn boundary"); },
        }));
        restorations.push(() => adoptSpy.mockRestore());
    }
    const provider = new RegisteredSuccessorProvider({ accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source }, registry,
        startCodex: async (home, assertCurrent) => {
            events.push(home === source.home ? "source-start" : "target-start");
            boundary(clientStarts === 2 ? "verify-start" : home === source.home ? "source-start" : "target-start");
            return CodexAppServerClient.start({ home, assertCurrent, launchBinary: "/fixture/codex", readProtocolVersion: () => "0.162.1", protocolProfile: "thread-control", spawn: () => new Transport(++clientStarts) as never, signalProcess: () => { throw Error("unexpected process signal"); } });
        },
        ...(mode.startsWith("native-host") ? {} : { publishCodexHost: async () => { events.push("publish-successor"); boundary("publish-return"); return async () => { }; } }), claudeStatus: async () => ({ loggedIn: false }), journalRoot: path.join(base, "journal"), now: () => "2026-11-07T10:00:00.000Z" });
    const publish = provider.publishHost.bind(provider);
    provider.publishHost = (receipt, input) => publish(receipt, { ...input, ownsOperation: async () => {
        const owned = await input.ownsOperation!();
        boundary("publication-authorization");
        return owned;
    } });
    const terminate = spyOn(registry, "terminateStructuredHost").mockImplementation(() => false);
    const journal = new RuntimeJournal(path.join(base, "runtime.sqlite"), { structuredHosts: true });
    restorations.push(() => terminate.mockRestore(), () => journal.close());
    let attributions = 0;
    const commands: RuntimeOperationCommand[] = [];
    const client = { command: async (command: RuntimeOperationCommand) => { commands.push(command); const result = journal.executeOperation(command); boundary("journal-ack"); return result; }, effectBatch: async (kinds: Parameters<RuntimeJournal["effectBatch"]>[1], cursor: number) => journal.effectBatch(100, kinds, cursor), operationStatus: async (id: string) => journal.operationResult(id) };
    const admitted = await applyConversationMigration({ action: "select-account", conversationId: begun.receipt.conversationId, accountId: "target", requestOperationId: "ancestor-probe" }, { registry: () => registry,
        dispatchControl: (request, dependencies) => dispatchStructuredControl(request, { ...dependencies, client: client as unknown as RuntimeHostClient, accountExists: () => true, attributeAccountChoice: () => { attributions++; return null; }, enabled: () => true, kick: () => { }, preflightSource: async (generation, _accounts, assertCurrent) => {
                await preflightCodexSource(generation, { resolveTranscriptOwner: () => source }, assertCurrent);
                for (const at of ["admission-owner", "admission-epoch", "admission-writer", "admission-generation"])
                    boundary(at);
            } }) });
    if (mode === "journal-ack") {
        expect(admitted.status).toBe(503);
        expect(attributions).toBe(0);
        expect(commands).toHaveLength(1);
        expect(journal.operationResult("ancestor-probe")?.receipt.status).toBe("queued");
        expect(events).toEqual([]);
        expect(displaced).toBe(true);
        return;
    }
    if (mode.startsWith("missing") || mode.startsWith("admission")) {
        expect(admitted.status).toBe(mode.startsWith("missing") ? 409 : 503);
        if (mode.startsWith("missing"))
            expect(admitted.body).toMatchObject({ code: "source-ancestor-missing", error: new MissingSourceAncestorError(failedId).message });
        expect(commands).toHaveLength(0);
        expect(attributions).toBe(0);
        expect(events).toEqual([]);
        expect(fs.existsSync(forkPath)).toBe(false);
        expect(fs.readdirSync(target.transcriptRoot)).toEqual([]);
        expect(registry.conversation(begun.receipt.conversationId)?.generations).toHaveLength(mode === "admission-generation" ? 2 : 1);
        expect(terminate).not.toHaveBeenCalled();
        expect(displaced).toBe(!mode.startsWith("missing"));
        return;
    }
    expect(admitted.status).toBe(202);
    expect(commands).toHaveLength(1);
    if (mode === "removed")
        fs.unlinkSync(path.join(source.transcriptRoot, `rollout-${missingId}.jsonl`));
    if (mode === "removed-hostile") fs.writeFileSync(parentPath, codexSessionMeta(parentId, hostileId));
    expect(events).toEqual([]);
    if (mode === "withdraw-missing" || mode === "carried-missing") {
        fs.unlinkSync(path.join(source.transcriptRoot, `rollout-${missingId}.jsonl`));
        const followup = await dispatchStructuredControl({ path: sourcePath, conversationId: begun.receipt.conversationId,
            action: "reconfigure", operationId: "followup", reconfiguration: { model: "gpt-6-astra", effort: "high", fast: false, ...(mode === "withdraw-missing" ? { accountId: "source" } : {}) },
        }, { registry, client: client as unknown as RuntimeHostClient, enabled: () => true, accountExists: () => true, kick: () => {},
            preflightSource: (generation, _accounts, assertCurrent) => preflightCodexSource(generation, { resolveTranscriptOwner: () => source }, assertCurrent),
        });
        expect(followup?.status).toBe(mode === "withdraw-missing" ? 200 : 409);
        if(mode === "carried-missing") expect(followup?.body).toMatchObject({ code: "source-ancestor-missing" });
        expect(commands).toHaveLength(1);
        expect(events).toEqual([]);
        return;
    }
    let error: unknown;
    const queue = new StructuredDeliveryQueue({ terminalTurn: id => registry.conversation(id as never)?.turn.state === "terminal", effects: async (kinds, seq) => journal.effectBatch(100, kinds, seq), transition: async (id, status, details) => { journal.transitionOperation(id, status, details); }, status: async (id) => journal.operationResult(id)?.receipt ?? null }, () => null, undefined, undefined, undefined, async (effect, ownership) => {
        try {
            return await applyStructuredReconfigure(effect, { registry, ownsOperation: async () => {
                    const owned = await ownership.isCurrent();
                    if(registry.conversation(begun.receipt.conversationId)?.migration?.phase === "committed") boundary("release-owner");
                    return owned;
                }, ...(ownership.carriedSends ? { carriedSends: ownership.carriedSends } : {}),
                pipelineSwitch: () => mode === "pipeline-policy" || mode === "native-host-policy" ? { authorize() { if (!pipelineAllowed) throw new Error("target account is no longer allowed"); } } : null,
                preflightSource: async (generation, _accounts, assertCurrent) => {
                    await preflightCodexSource(generation, { resolveTranscriptOwner: () => source }, assertCurrent);
                    boundary("execution-owner");
                },
                validateAccount: async () => { events.push("account-preflight"); boundary("authentication"); }, resolveAccount: () => target,
                migrate: async (id, targetId, reg, ownsOperation, reconfigureOperationId, authorizeTarget, assertCurrent) => { expect(targetId).toBe(target.accountId); events.push("migrate");
                    if(mode === "provider-missing") fs.unlinkSync(path.join(source.transcriptRoot, `rollout-${missingId}.jsonl`));
                    if(mode === "provider-hostile") fs.writeFileSync(parentPath, codexSessionMeta(parentId, hostileId));
                    return advanceConversationMigration(id, reg, provider, { ownsOperation, reconfigureOperationId, authorizeTarget, assertCurrent, deferBoardRepair: true }); },
                releaseHost: async () => { expect(registry.conversation(begun.receipt.conversationId)?.migration?.phase).toBe("committed"); expect(events).toContain("publish-successor"); events.push("incumbent-release"); return true; }, recover: async () => { throw Error("unexpected recovery"); } });
        }
        catch (e) {
            error = e;
            throw e;
        }
    });
    await queue.drain();
    if (mode.startsWith("native-host")) {
        expect(events).toContain("host-protocol-preparation");
        expect(events.includes("native-spawn")).toBe(mode === "native-host-control");
        expect(displaced).toBe(mode !== "native-host-control");
        expect(terminate).not.toHaveBeenCalled();
        expect(registry.conversation(begun.receipt.conversationId)?.generations).toHaveLength(1);
        return;
    }
    const row = registry.conversation(begun.receipt.conversationId)!;
    if (mode !== "valid") {
        expect(events).not.toContain("incumbent-release");
        expect(terminate).not.toHaveBeenCalled();
        expect(row.generations).toHaveLength(mode === "release-owner" ? 2 : 1);
        if (mode.startsWith("removed") || mode.startsWith("provider")) {
            expect(events).toEqual(mode.startsWith("provider") ? ["account-preflight", "migrate"] : []);
            if(mode.startsWith("provider")) expect(row.migration?.errorCode).toBe("source-ancestor-missing");
            expect((error as Error).message).toBe(new MissingSourceAncestorError(failedId).message);
            expect(journal.operationResult("ancestor-probe")?.receipt.reason).toBe(new MissingSourceAncestorError(failedId).message);
        }
        else {
            expect(displaced).toBe(true);
            const forbidden: Partial<Record<typeof mode, string>> = {
                "publication-authorization": "publish-successor", "operation-revision": "thread/fork", "pipeline-policy": "thread/fork", "execution-owner": "account-preflight", authentication: "migrate", "reseat-write": "migrate",
                "source-start": "account/read", "source-auth": "thread/fork", "fork-return": "target-start", "continuity-write": "target-start",
                "target-start": "config/read", "target-auth": "config/read", "config-read": "thread/resume",
                "resume-return": "thread/name/set", "name-return": "thread/read", "goal-return": "thread/read", "read-return": "publish-successor", "verify-start": "publish-successor", "verify-auth": "publish-successor", "verify-read": "publish-successor",
            };
            if (forbidden[mode])
                expect(events).not.toContain(forbidden[mode]!);
        }
        if (["removed", "execution-owner", "authentication", "reseat-write", "source-start", "source-auth"].includes(mode)) {
            expect(fs.existsSync(forkPath)).toBe(false);
            expect(fs.readdirSync(target.transcriptRoot)).toEqual([]);
        }
    }
    else {
        expect(error).toBeUndefined();
        expect(row.migration?.phase).toBe("committed");
        expect(row.generations).toHaveLength(2);
        expect(events.filter(x => x === "incumbent-release")).toHaveLength(1);
        expect(terminate).toHaveBeenCalledTimes(1);
        expect(events.lastIndexOf("thread/read")).toBeLessThan(events.indexOf("publish-successor"));
        expect(events.indexOf("publish-successor")).toBeLessThan(events.indexOf("incumbent-release"));
    }
});
