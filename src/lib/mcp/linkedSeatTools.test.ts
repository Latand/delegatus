import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, expect, spyOn, test } from "bun:test";

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

test("remote relay binds and dispatches withheld lesson text; local binding stays verbatim", async () => {
  const { leaveLessons, recordLessonRequest, roleMemoryCollection } = await import("@/lib/memory/roleStore");
  const rule = "Inspect the current durable owner before replaying a saved acknowledgement.";
  const source = { project: project.project, pipelineId: "relay-fixture", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: caller };
  recordLessonRequest({ ...source, at: new Date().toISOString() });
  leaveLessons({ request: source, source, lessons: [{ scope: "role", rule, why: "A saved acknowledgement had changed owners." }], none: null });
  const recoverable = viewerMcpRecoverableTools(domain).send_message_to_orchestrator!;
  const args = { project: project.project, machine: "Other", text: rule, clientRequestId: "linked-private-rule" };
  const bound = await recoverable.bind(args);
  expect(bound.sendPayload!.text).toContain("[learned rule]");
  expect(bound.sendPayload!.text).not.toContain(rule);
  const local = await recoverable.bind({ ...args, machine: undefined });
  expect(local.sendPayload!.text).toContain(rule);
  const posts: Record<string, unknown>[] = [];
  const api = createMcpToolService(viewerMcpBindings(undefined, { post: async (_path, body) => { posts.push(body); return { outcome: "accepted", state: "queued" }; } }, domain), new MemoryMcpReceiptStore(), undefined, { recovery: viewerMcpRecoverableTools(domain) });
  expect(await api.callTool("send_message_to_orchestrator", args)).toMatchObject({ ok: true });
  expect(posts[0]!.text).toContain("[learned rule]");
  expect(posts[0]!.text).not.toContain(rule);
  const read = spyOn(roleMemoryCollection()!, "snapshot").mockImplementation(() => { throw new Error("unreadable rule store"); });
  try {
    await expect(recoverable.bind({ ...args, clientRequestId: "unreadable-rule" })).rejects.toMatchObject({ code: "LESSON_PRIVACY_UNAVAILABLE" });
  } finally { read.mockRestore(); }
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

test("get_orchestrator ignores a peer seat timestamp outside the JavaScript date range", async () => {
  recordSeatMessages(`peer:${install}`, true);
  acceptAgents(`peer:${install}`, { cursor: "0011223344556677:2", reset: true, rows: [{ k: "a:0011223344556677", p: project.project, t: "orchestrator", ro: "orchestrator", seat: 1, e: "codex", m: "fixture-model", st: "done", at: Number.MAX_SAFE_INTEGER }] }, new Set([project.project]));
  const bindings = viewerMcpBindings(undefined, { post: async () => ({}) }, domain);
  expect(await bindings.get_orchestrator!({ project: project.project })).toMatchObject({ linkedSeats: [{ machine: "Other", seat: null }] });
});

test("get_orchestrator distinguishes seats on linked installs with the same machine label", async () => {
  const second = randomUUID();
  atomicWrite(linkFile("peers"), { v: 1, peers: [install, second].map(id => ({ id, install: id, grantId: randomUUID(), token: "fixture", label: "Other", url: "http://127.0.0.1:1", store: randomUUID(), state: "active", lastCall: Date.now(), error: null })) });
  updateRemoteProjects(second, [{ key: project.project, name: "widget" }], randomUUID());
  for (const [id, engine] of [[install, "codex"], [second, "claude"]] as const) {
    recordSeatMessages(`peer:${id}`, true);
    acceptAgents(`peer:${id}`, { cursor: "0011223344556677:3", reset: true, rows: [{ k: "a:0011223344556677", p: project.project, t: "orchestrator", ro: "orchestrator", seat: 1, e: engine, m: "fixture-model", st: "working", at: Date.now() }] }, new Set([project.project]));
  }
  const bindings = viewerMcpBindings(undefined, { post: async () => ({}) }, domain);
  expect(await bindings.get_orchestrator!({ project: project.project })).toMatchObject({ linkedSeats: [
    { machine: "Other", install, seat: { engine: "codex" } },
    { machine: "Other", install: second, seat: { engine: "claude" } },
  ] });
});
