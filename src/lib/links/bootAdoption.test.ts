/**
 * M.4 seams 4 and 5 (docs/design/linked-installs.md): boot adoption and the
 * migration successor reopen a conversation's process; a conversation whose
 * task runs on another linked machine is left stopped with its claim released
 * and no process opens. Real registry, real adoption loops, isolated state.
 */
import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const state = fs.mkdtempSync(path.join(os.tmpdir(), "llv-boot-adoption-"));
const original = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = state;
const SELF = ["0a0a0a0a", "1111", "4111", "8111", "111111111111"].join("-");
const PEER = ["0b0b0b0b", "2222", "4222", "8222", "222222222222"].join("-");
fs.mkdirSync(path.join(state, "links"), { recursive: true });
fs.writeFileSync(path.join(state, "links/self.json"), JSON.stringify({ v: 1, installId: SELF, label: "alpha", publicUrl: null, check: null }));

const { AgentRegistry } = await import("@/lib/agent/registry");
const { adoptClaudeRegistryHosts, adoptCodexRegistryHosts } = await import("@/lib/runtime/registry");
const { saveTasks } = await import("@/lib/tasks/store");
const { successorRefusal } = await import("./adoptionGuard");

afterAll(() => {
  if (original === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = original;
  fs.rmSync(state, { recursive: true, force: true });
});

type Registry = InstanceType<typeof AgentRegistry>;

function hostedRow(registry: Registry, engine: "codex" | "claude", sessionId: string) {
  const artifactPath = path.join(state, `${sessionId}.jsonl`);
  const conversation = registry.ensureConversation(engine, artifactPath, null);
  registry.upsert({
    key: { engine, sessionId }, artifactPath, cwd: "/repo", accountId: null, status: "dead", host: null,
    structuredHost: { kind: engine === "codex" ? "codex-app-server" : "claude-broker", endpoint: "stdio:old", process: null, eventCursor: 3,
      protocolVersion: null, writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] },
    claimEpoch: 1, claimOwner: null, pendingAction: null,
  });
  return { conversationId: conversation.id, artifactPath };
}

function taskHolding(id: string, conversationId: string, machine: string) {
  return { id, project: "repo-fixture", status: "assigned" as const, text: `Task ${id}`, placement: "unplaced" as const, machine,
    assignments: [{ path: null, conversationId, panePid: null, state: "linked" as const, error: null, at: "2026-09-28T00:00:00.000Z" }],
    createdAt: "2026-09-28T00:00:00.000Z", updatedAt: "2026-09-28T00:00:00.000Z" };
}

for (const engine of ["codex", "claude"] as const) {
  test(`boot adoption (${engine}) opens no process for a conversation whose task runs on another machine, and adopts one whose task runs here`, async () => {
    const registry = new AgentRegistry(path.join(state, `${engine}-registry.json`));
    const elsewhere = hostedRow(registry, engine, `${engine}-elsewhere`);
    const here = hostedRow(registry, engine, `${engine}-here`);
    saveTasks([taskHolding(`${engine}-task-peer`, elsewhere.conversationId, PEER), taskHolding(`${engine}-task-here`, here.conversationId, SELF)]);
    const adopted: string[] = [];
    const adoptHost = async (sessionId: string) => { adopted.push(sessionId); throw new Error("fixture host does not open"); };
    const env = { NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "1" } as NodeJS.ProcessEnv;
    if (engine === "codex") await adoptCodexRegistryHosts(registry, () => ({ cwd: "/repo" }) as never, env, () => true, undefined, { adoptHost: adoptHost as never });
    else await adoptClaudeRegistryHosts(registry, () => ({ cwd: "/repo" }) as never, env, () => true, undefined, { adoptHost: adoptHost as never });
    expect(adopted).toEqual([`${engine}-here`]);
    const refused = registry.snapshot().entries[`${engine}:${engine}-elsewhere`]!;
    expect(refused.status).toBe("dead");
    expect(refused.claimOwner).toBeNull();
    expect(refused.structuredHost?.endpoint).toBe("stdio:released");

    // The migration successor of the same conversation is refused the same way.
    const snapshot = registry.readOnlySnapshot();
    expect(successorRefusal({ conversationId: elsewhere.conversationId, receipt: { nativeId: "successor", path: "/sessions/successor.jsonl" } }, engine, snapshot)?.code).toBe("TASK_RUNS_ELSEWHERE");
    expect(successorRefusal({ conversationId: here.conversationId, receipt: { nativeId: "successor-here", path: "/sessions/successor-here.jsonl" } }, engine, snapshot)).toBeNull();
  });
}
