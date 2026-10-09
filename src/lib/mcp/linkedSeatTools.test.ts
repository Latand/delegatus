import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, expect, test } from "bun:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-linked-seat-tools-"));
const previous = { ...process.env };
for (const [key, folder] of Object.entries({ HOME: "home", TMPDIR: "tmp", LLV_STATE_DIR: "state", XDG_CONFIG_HOME: "config" })) {
  process.env[key] = path.join(root, folder); fs.mkdirSync(process.env[key]!, { recursive: true });
}
process.env.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:1";
const { agentRegistry } = await import("@/lib/agent/registry");
const { projectIdentityFromRemote } = await import("@/lib/projects/identity");
const { recordProjectRemote } = await import("@/lib/projects/aliases");
const { atomicWrite, linkFile, setShared } = await import("@/lib/links/state");
const { updateRemoteProjects, recordSeatMessages } = await import("@/lib/links/boardLinks");
const { queueSeatMessage, resolveSeatMessageMachine } = await import("@/lib/links/seatMessages");
const { acceptAgents, dropAgents } = await import("@/lib/links/agentFeed");
const { viewerMcpBindings, viewerMcpRecoverableTools } = await import("./bindings");
const { createMcpToolService, MemoryMcpReceiptStore, McpDispatchUncertainError } = await import("./server");
import type { ViewerMcpDomainDependencies } from "./bindings";

afterAll(() => { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); fs.rmSync(root, { recursive: true, force: true }); });

const project = projectIdentityFromRemote("https://code.example.test/acme/widget", root)!;
recordProjectRemote(project);
setShared({ v: 1, all: false, projects: [project.project] });
const selfId = randomUUID(), install = randomUUID();
atomicWrite(path.join(process.env.LLV_STATE_DIR!, "links/self.json"), { v: 1, installId: selfId, label: "Here", publicUrl: null });
atomicWrite(linkFile("peers"), { v: 1, peers: [{ id: install, install, grantId: randomUUID(), token: "fixture", label: "Other", url: "http://127.0.0.1:1", store: randomUUID(), state: "active", lastCall: Date.now(), error: null }] });
updateRemoteProjects(install, [{ key: project.project, name: "widget" }], randomUUID());
recordSeatMessages(`peer:${install}`, true);
const caller = `conversation_${randomUUID()}`;
const domain = {
  registrySnapshot: () => agentRegistry().readOnlySnapshot(),
  callerAttribution: () => ({ kind: "agent", conversationId: caller, role: "orchestrator" }),
  attentionAuthority: () => ({ kind: "worker", conversationId: caller }),
  authorizedSeats: () => [{ project: project.project, conversationId: caller, path: null }],
  recoveryPredecessors: () => [],
} as unknown as ViewerMcpDomainDependencies;

test("remote orchestrator recovery reads the queued outbound row after a lost reply and never dispatches twice", async () => {
  const posts: Record<string, unknown>[] = [];
  const control = { post: async (_path: string, body: Record<string, unknown>) => {
    posts.push(body);
    const link = resolveSeatMessageMachine(String(body.machine), String(body.project))!;
    queueSeatMessage(link, String(body.project), String(body.text), caller, String(body.clientMessageId));
    throw new McpDispatchUncertainError("fixture answer was lost");
  } };
  const receipts = new MemoryMcpReceiptStore();
  const create = () => createMcpToolService(viewerMcpBindings(undefined, control, domain), receipts, undefined, { recovery: viewerMcpRecoverableTools(domain) });
  const args = { project: project.project, machine: "Other", text: "Please hold the lock.", clientRequestId: "linked-recovery" };
  await create().callTool("send_message_to_orchestrator", args);
  const recovered = await create().callTool("send_message_to_orchestrator", args);
  expect(posts).toHaveLength(1);
  expect(posts[0]!.machine).toBe(install);
  expect(recovered).toMatchObject({ outcome: "accepted", state: "queued" });
  expect((await create().callTool("send_message_to_orchestrator", { ...args, text: "Different words" })).code).toBe("idempotency_conflict");
});

test("get_orchestrator names a linked seat, an absent seat on a capable peer, and unknown on an older peer", async () => {
  const bindings = viewerMcpBindings(undefined, { post: async () => ({}) }, domain);
  acceptAgents(`peer:${install}`, { cursor: "0011223344556677:1", reset: true, rows: [{ k: "a:0011223344556677", p: project.project, t: "orchestrator", ro: "orchestrator", seat: 1, e: "codex", m: "fixture-model", st: "working", at: Date.now() }] }, new Set([project.project]));
  expect(await bindings.get_orchestrator!({ project: project.project })).toMatchObject({ linkedSeats: [{ machine: "Other", seat: { engine: "codex", state: "working", stale: false } }] });
  dropAgents(`peer:${install}`);
  expect(await bindings.get_orchestrator!({ project: project.project })).toMatchObject({ linkedSeats: [{ machine: "Other", seat: null }] });
  recordSeatMessages(`peer:${install}`, false);
  expect(await bindings.get_orchestrator!({ project: project.project })).toMatchObject({ linkedSeats: [{ machine: "Other", seat: "unknown" }] });
});
