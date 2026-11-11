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
const { queueSeatMessage, resolveSeatMessageMachine, recoverSeatMessage, seatMessageRetryFence, drainSeatMessages } = await import("@/lib/links/seatMessages");
const { acceptAgents, dropAgents } = await import("@/lib/links/agentFeed");
const { viewerMcpBindings, viewerMcpRecoverableTools } = await import("./bindings");
const { createMcpToolService, MemoryMcpReceiptStore, FileMcpReceiptStore, SqliteMcpReceiptStore, McpDispatchUncertainError } = await import("./server");
import type { McpRequestBinding, McpToolResult, McpRecoveryReceiptStore } from "./server";
import type { ViewerMcpDomainDependencies } from "./bindings";

afterAll(async () => {
  await (await import("@/lib/links/taskPageWorker")).shutdownTaskPageWorker();
  for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
  Object.assign(process.env, previous);
  fs.rmSync(root, { recursive: true, force: true });
});

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
  for (const machine of [undefined, "Here", "this machine", selfId]) {
    const local = await recoverable.bind({ ...args, machine });
    expect(local.sendPayload!.text).toContain(rule);
  }
  const posts: Record<string, unknown>[] = [];
  const api = createMcpToolService(viewerMcpBindings(undefined, { post: async (_path, body) => { posts.push(body); const link = resolveSeatMessageMachine(String(body.machine), String(body.project))!; return queueSeatMessage(link, String(body.project), String(body.text), caller, String(body.clientMessageId)); } }, domain), new MemoryMcpReceiptStore(), undefined, { recovery: viewerMcpRecoverableTools(domain) });
  expect(await api.callTool("send_message_to_orchestrator", args)).toMatchObject({ ok: true });
  expect(posts[0]!.text).toContain("[learned rule]");
  expect(posts[0]!.text).not.toContain(rule);
  expect(await api.callTool("send_message_to_orchestrator", args)).toMatchObject({ ok: true, replayed: true });
  expect(posts).toHaveLength(1);
  const read = spyOn(roleMemoryCollection()!, "snapshot").mockImplementation(() => { throw new Error("unreadable rule store"); });
  try {
    expect(await api.callTool("send_message_to_orchestrator", { ...args, clientRequestId: "unreadable-rule" })).toMatchObject({ ok: false, code: "LESSON_PRIVACY_UNAVAILABLE" });
    expect(posts).toHaveLength(1);
  } finally { read.mockRestore(); }
});

for (const backend of ["memory", "file", "sqlite"] as const) {
  test(`absent remote outbox reaches a retained negative fence and same-key retry on ${backend}`, async () => {
    const file = path.join(root, `negative-${backend}`);
    let receipts = backend === "memory" ? new MemoryMcpReceiptStore() : backend === "file" ? new FileMcpReceiptStore(file) : new SqliteMcpReceiptStore(file);
    const posts: Record<string, unknown>[] = [];
    const control = { post: async (_path: string, body: Record<string, unknown>) => {
      posts.push(body);
      if (posts.length === 1) throw new McpDispatchUncertainError("connection lost before outbox admission");
      const link = resolveSeatMessageMachine(String(body.machine), String(body.project))!;
      return queueSeatMessage(link, String(body.project), String(body.text), caller, String(body.clientMessageId), body.seatMessageFence as string | undefined);
    } };
    const create = () => createMcpToolService(viewerMcpBindings(undefined, control, domain), receipts, undefined, { recovery: viewerMcpRecoverableTools(domain) });
    const args = { project: project.project, machine: "Other", text: "Retry one instruction.", clientRequestId: `absent-${backend}` };
    const receiptKey = `send_message_to_orchestrator:${args.clientRequestId}`;
    let restoreClock: (() => void) | undefined;
    try {
      expect(await create().callTool("send_message_to_orchestrator", args)).toMatchObject({ ok: false, code: "outcome_unknown" });
      const claimed = (await receipts.lookup(receiptKey))!;
      const clock = spyOn(Date, "now").mockReturnValue(Date.parse(claimed.binding!.claimedAt) + 29_999);
      restoreClock = () => clock.mockRestore();
      expect(await create().callTool("send_message_to_orchestrator", { ...args, recoveryOnly: true })).toMatchObject({ code: "outcome_unknown" });
      clock.mockReturnValue(Date.parse(claimed.binding!.claimedAt) + 30_000);
      const answer = await create().callTool("send_message_to_orchestrator", { ...args, recoveryOnly: true });
      expect(answer).toMatchObject({ ok: false, code: "not_executed", details: {
        outcome: "not-executed", state: "not-delivered", evidence: "seat-message-admission-fence",
        nextAction: "retry-same-key", resend: "safe", duplicateRisk: false, hop: "mcp-to-outbox",
      } });
      expect(posts).toHaveLength(1);
      if (receipts instanceof SqliteMcpReceiptStore) { receipts.close(); receipts = new SqliteMcpReceiptStore(file); }
      if (receipts instanceof FileMcpReceiptStore) receipts = new FileMcpReceiptStore(file);
      expect(await create().callTool("send_message_to_orchestrator", { ...args, recoveryOnly: true })).toEqual({ ...answer, replayed: true });
      expect(await create().callTool("send_message_to_orchestrator", { ...args, text: "Changed" })).toMatchObject({ code: "idempotency_conflict" });
      const foreign = { ...domain, callerAttribution: () => ({ kind: "agent", conversationId: "conversation_foreign", role: "orchestrator" }),
        attentionAuthority: () => ({ kind: "worker", conversationId: "conversation_foreign" }),
        authorizedSeats: () => [{ project: project.project, conversationId: "conversation_foreign", path: null }] } as unknown as ViewerMcpDomainDependencies;
      expect(await createMcpToolService(viewerMcpBindings(undefined, control, foreign), receipts, undefined, { recovery: viewerMcpRecoverableTools(foreign) })
        .callTool("send_message_to_orchestrator", args)).toMatchObject({ code: "recovery_not_permitted" });
      const link = resolveSeatMessageMachine(install, project.project)!;
      expect(() => queueSeatMessage(link, project.project, String(posts[0]!.text), caller, String(posts[0]!.clientMessageId))).toThrow("fenced");
      const retry = await create().callTool("send_message_to_orchestrator", args);
      expect(retry).toMatchObject({ ok: true, state: "queued" });
      if (!retry.ok) throw new Error("same-key retry failed");
      const operationId = String(retry.operationId);
      expect(posts).toHaveLength(2);
      expect(posts[1]!.seatMessageFence).toBeString();
      if (receipts instanceof SqliteMcpReceiptStore) { receipts.close(); receipts = new SqliteMcpReceiptStore(file); }
      if (receipts instanceof FileMcpReceiptStore) receipts = new FileMcpReceiptStore(file);
      expect((await receipts.lookup(receiptKey))!.binding!.seatMessageFence).toBe(String(posts[1]!.seatMessageFence));
      // A late original after retry admission resolves to the SAME peer id.
      expect(queueSeatMessage(link, project.project, String(posts[0]!.text), caller, String(posts[0]!.clientMessageId)).operationId).toBe(operationId);
      expect(await create().callTool("send_message_to_orchestrator", args)).toMatchObject({ operationId });
      expect(posts).toHaveLength(2);
    } finally { restoreClock?.(); if (receipts instanceof SqliteMcpReceiptStore) receipts.close(); }
  });
}

for (const backend of ["memory", "file", "sqlite"] as const) {
  test(`late terminal writes cannot settle a newer retry on ${backend}`, async () => {
    const file = path.join(root, `attempt-cas-${backend}`);
    const store = backend === "memory" ? new MemoryMcpReceiptStore() : backend === "file" ? new FileMcpReceiptStore(file) : new SqliteMcpReceiptStore(file);
    const binding: McpRequestBinding = { version: 1, toolName: "send_message_to_orchestrator", clientRequestId: "cas-key",
      caller: { kind: "worker", conversationId: caller, project: project.project }, target: { project: project.project, identity: `machine:${install}` },
      downstreamKey: "cas-downstream", owner: { pid: process.pid, startIdentity: null }, claimedAt: "2026-10-01T00:00:00.000Z" };
    const key = "send_message_to_orchestrator:cas-key", digest = "a".repeat(64);
    const failed: McpToolResult = { ok: false, toolName: "send_message_to_orchestrator", clientRequestId: "cas-key", replayed: false,
      code: "not_executed", error: "Fenced before admission", retryable: true,
      details: { outcome: "not-executed", evidence: "seat-message-admission-fence", nextAction: "retry-same-key" } };
    const next = { ...binding, seatMessageDigest: digest, seatMessageFence: ["00112233", "4455", "4677", "8899", "aabbccddeeff"].join("-") };
    try {
      expect(await store.claim(key, digest, "durable", binding)).toMatchObject({ kind: "fresh" });
      expect(await store.markDispatching(key, digest)).toBe(true);
      await store.settle(key, digest, failed, "not-executed", true, binding);
      expect(await store.claim(key, digest, "durable", { ...next, target: { ...next.target, identity: "machine:foreign" } })).toMatchObject({ kind: "replay" });
      expect(await store.release(key, digest, binding)).toBe(false);
      expect(await store.claim(key, digest, "durable", next)).toMatchObject({ kind: "fresh" });
      expect((await store.lookup(key))!.digest).toBe(digest);
      expect(await store.markDispatching(key, digest, binding)).toBe(false);
      expect(await store.fenceUndispatched(key, digest, failed, binding)).toBe(false);
      expect(await store.release(key, digest, binding)).toBe(false);
      // Calls using the old unscoped signature cannot settle a new attempt.
      await expect(Promise.resolve().then(() => store.settle(key, digest, failed))).rejects.toThrow("ownership changed");
      const legacyModule = process.env.LLV_TEST_LEGACY_MCP;
      if (legacyModule) {
        const legacy = await import(legacyModule);
        const old = backend === "memory" ? new legacy.MemoryMcpReceiptStore() : backend === "file" ? new legacy.FileMcpReceiptStore(file) : new legacy.SqliteMcpReceiptStore(file);
        if (backend === "memory") Reflect.set(old, "receipts", Reflect.get(store, "receipts"));
        try {
          expect((await old.lookup(key)).digest).not.toBe(digest);
          expect(await old.markDispatching(key, digest)).toBe(false);
          expect(await old.fenceUndispatched(key, digest, failed)).toBe(false);
          expect(await old.release(key, digest, binding)).toBe(false);
          await expect(Promise.resolve().then(() => old.settle(key, digest, failed))).rejects.toThrow("ownership changed");
        } finally { old.close?.(); }
      }
      for (const foreign of [
        { ...next, caller: { ...next.caller, conversationId: "conversation_foreign" } },
        { ...next, target: { ...next.target, identity: "machine:foreign" } },
        { ...next, owner: { ...next.owner, pid: next.owner.pid + 1 } },
      ]) {
        expect(await store.markDispatching(key, digest, foreign)).toBe(false);
        expect(await store.fenceUndispatched(key, digest, failed, foreign)).toBe(false);
        expect(await store.release(key, digest, foreign)).toBe(false);
        await expect(Promise.resolve().then(() => store.settle(key, digest, failed, "not-executed", true, foreign))).rejects.toThrow("attempt changed");
      }
      expect(await store.markDispatching(key, digest, next)).toBe(true);
      await expect(Promise.resolve().then(() => store.settle(key, digest, failed, "not-executed", true, binding))).rejects.toThrow("ownership changed");
      expect((await store.lookup(key))!.result).toBeNull();
      expect((await store.lookup(key))!.binding!.seatMessageFence).toBe(next.seatMessageFence);
      const accepted: McpToolResult = { ok: true, toolName: "send_message_to_orchestrator", clientRequestId: "cas-key", replayed: false, state: "queued", operationId: "seatmsg_fixture" };
      expect(await store.settle(key, digest, accepted, "settled", false, next)).toEqual(accepted);
      expect(await store.claim(key, digest, "durable", next)).toMatchObject({ kind: "replay" });
      await expect(Promise.resolve().then(() => store.settle(key, digest, failed, "not-executed", true, binding))).rejects.toThrow("ownership changed");
    } finally { if (store instanceof SqliteMcpReceiptStore) store.close(); }
  });
}

test("an acceptance without a durable outbox admission cannot suppress safe retry", async () => {
  const receipts = new MemoryMcpReceiptStore();
  let posts = 0;
  const control = { post: async (_path: string, body: Record<string, unknown>) => {
    if (++posts === 1) return { outcome: "accepted", operationId: "seatmsg_unadmitted", state: "queued" };
    const link = resolveSeatMessageMachine(String(body.machine), String(body.project))!;
    return queueSeatMessage(link, String(body.project), String(body.text), caller, String(body.clientMessageId), body.seatMessageFence as string | undefined);
  } };
  const create = () => createMcpToolService(viewerMcpBindings(undefined, control, domain), receipts, undefined, { recovery: viewerMcpRecoverableTools(domain) });
  const args = { project: project.project, machine: "Other", text: "Corroborate admission.", clientRequestId: "uncorroborated-answer" };
  expect(await create().callTool("send_message_to_orchestrator", args)).toMatchObject({ code: "outcome_unknown" });
  const binding = receipts.lookup(`send_message_to_orchestrator:${args.clientRequestId}`)!.binding!;
  const clock = spyOn(Date, "now").mockReturnValue(Date.parse(binding.claimedAt) + 30_000);
  try {
    expect(await create().callTool("send_message_to_orchestrator", { ...args, recoveryOnly: true })).toMatchObject({ code: "not_executed" });
    const retried = await create().callTool("send_message_to_orchestrator", args);
    expect(retried).toMatchObject({ ok: true, state: "queued" });
    if (!retried.ok) throw new Error("same-key retry failed");
    expect(retried.operationId).not.toBe("seatmsg_unadmitted");
    expect(posts).toBe(2);
  } finally { clock.mockRestore(); }
});

test("unreadable outbox evidence never becomes a safe retry answer", async () => {
  const { SqliteStateCollection } = await import("@/lib/state/sqliteStateStore");
  const receipts = new MemoryMcpReceiptStore();
  const control = { post: async () => { throw new McpDispatchUncertainError("lost answer"); } };
  const create = () => createMcpToolService(viewerMcpBindings(undefined, control, domain), receipts, undefined, { recovery: viewerMcpRecoverableTools(domain) });
  const args = { project: project.project, machine: "Other", text: "Unreadable evidence.", clientRequestId: "unreadable-outbox" };
  await create().callTool("send_message_to_orchestrator", args);
  const binding = (await receipts.lookup(`send_message_to_orchestrator:${args.clientRequestId}`))!.binding!;
  const clock = spyOn(Date, "now").mockReturnValue(Date.parse(binding.claimedAt) + 30_000);
  const read = spyOn(SqliteStateCollection.prototype, "get").mockImplementation(() => { throw new Error("fixture outbox read refused"); });
  try {
    expect(await create().callTool("send_message_to_orchestrator", { ...args, recoveryOnly: true })).toMatchObject({ code: "outcome_unknown", details: { nextAction: "original-key-lookup" } });
  } finally { read.mockRestore(); clock.mockRestore(); }
});

test("an older recovery held at terminal save cannot overwrite an admitted same-key retry", async () => {
  const receipts: McpRecoveryReceiptStore = new MemoryMcpReceiptStore();
  let posts = 0;
  const control = { post: async (_path: string, body: Record<string, unknown>) => {
    if (++posts === 1) throw new McpDispatchUncertainError("lost before admission");
    const link = resolveSeatMessageMachine(String(body.machine), String(body.project))!;
    return queueSeatMessage(link, String(body.project), String(body.text), caller, String(body.clientMessageId), body.seatMessageFence as string | undefined);
  } };
  const create = () => createMcpToolService(viewerMcpBindings(undefined, control, domain), receipts, undefined, { recovery: viewerMcpRecoverableTools(domain) });
  const args = { project: project.project, machine: "Other", text: "Race one instruction.", clientRequestId: "held-negative-save" };
  await create().callTool("send_message_to_orchestrator", args);
  const bound = (await receipts.lookup(`send_message_to_orchestrator:${args.clientRequestId}`))!.binding!;
  const clock = spyOn(Date, "now").mockReturnValue(Date.parse(bound.claimedAt) + 30_000);
  let arrived!: () => void, release!: () => void;
  const held = new Promise<void>(resolve => { arrived = resolve; });
  const proceed = new Promise<void>(resolve => { release = resolve; });
  const settle = receipts.settle.bind(receipts);
  let first = true;
  const save = spyOn(receipts, "settle").mockImplementation(async (...parameters) => {
    if (first) { first = false; arrived(); await proceed; }
    return settle(...parameters);
  });
  let older: Promise<McpToolResult> | undefined;
  try {
    older = create().callTool("send_message_to_orchestrator", { ...args, recoveryOnly: true });
    await held;
    expect(await create().callTool("send_message_to_orchestrator", { ...args, recoveryOnly: true })).toMatchObject({ code: "not_executed" });
    const reopen = spyOn(receipts, "claim").mockImplementation(async (key) => ({ kind: "pending", record: (await receipts.lookup(key))! }));
    try {
      expect(await create().callTool("send_message_to_orchestrator", args)).toMatchObject({ code: "not_executed" });
      expect(posts).toBe(1);
    } finally { reopen.mockRestore(); }
    expect(await create().callTool("send_message_to_orchestrator", { ...args, recoveryOnly: true })).toMatchObject({ code: "not_executed" });
    const retried = await create().callTool("send_message_to_orchestrator", args);
    expect(retried).toMatchObject({ ok: true, state: "queued" });
    if (!retried.ok) throw new Error("same-key retry failed");
    release();
    expect(await older).toMatchObject({ code: "outcome_unknown" });
    expect(await create().callTool("send_message_to_orchestrator", { ...args, recoveryOnly: true })).toMatchObject({ ok: true, state: "queued", operationId: retried.operationId });
    expect(posts).toBe(2);
  } finally { release(); await older; save.mockRestore(); clock.mockRestore(); }
});

test("a stalled pre-dispatch owner resumes into the fence without automatically retrying", async () => {
  const receipts: McpRecoveryReceiptStore = new MemoryMcpReceiptStore();
  let posts = 0;
  const control = { post: async (_path: string, body: Record<string, unknown>) => {
    posts++;
    const link = resolveSeatMessageMachine(String(body.machine), String(body.project))!;
    return queueSeatMessage(link, String(body.project), String(body.text), caller, String(body.clientMessageId), body.seatMessageFence as string | undefined);
  } };
  const create = () => createMcpToolService(viewerMcpBindings(undefined, control, domain), receipts, undefined, { recovery: viewerMcpRecoverableTools(domain) });
  const args = { project: project.project, machine: "Other", text: "Stalled before dispatch.", clientRequestId: "stalled-remote-marker" };
  let entered!: () => void, release!: () => void;
  const held = new Promise<void>(resolve => { entered = resolve; });
  const proceed = new Promise<void>(resolve => { release = resolve; });
  const mark = receipts.markDispatching.bind(receipts);
  let first = true;
  const marker = spyOn(receipts, "markDispatching").mockImplementation(async (...parameters) => {
    if (first) { first = false; entered(); await proceed; }
    return mark(...parameters);
  });
  const original = create().callTool("send_message_to_orchestrator", args);
  await held;
  const row = (await receipts.lookup(`send_message_to_orchestrator:${args.clientRequestId}`))!;
  expect(row.stage).toBe("claimed");
  const clock = spyOn(Date, "now").mockReturnValue(Date.parse(row.binding!.claimedAt) + 30_000);
  try {
    expect(await create().callTool("send_message_to_orchestrator", { ...args, recoveryOnly: true })).toMatchObject({ code: "not_executed", details: { state: "not-delivered", nextAction: "retry-same-key" } });
    release();
    expect(await original).toMatchObject({ code: "not_executed" });
    expect(posts).toBe(0);
    expect(await create().callTool("send_message_to_orchestrator", args)).toMatchObject({ ok: true, state: "queued" });
    expect(posts).toBe(1);
  } finally { release(); await original; marker.mockRestore(); clock.mockRestore(); }
});

test("a same-key retry keeps its original install when another machine adopts the old label", async () => {
  const receipts = new MemoryMcpReceiptStore();
  const posts: Record<string, unknown>[] = [];
  const control = { post: async (_path: string, body: Record<string, unknown>) => {
    posts.push(body);
    if (posts.length === 1) throw new McpDispatchUncertainError("lost before admission");
    const link = resolveSeatMessageMachine(String(body.machine), String(body.project))!;
    return queueSeatMessage(link, String(body.project), String(body.text), caller, String(body.clientMessageId), body.seatMessageFence as string | undefined);
  } };
  const create = () => createMcpToolService(viewerMcpBindings(undefined, control, domain), receipts, undefined, { recovery: viewerMcpRecoverableTools(domain) });
  const args = { project: project.project, machine: "Other", text: "Keep the original recipient.", clientRequestId: "renamed-negative-target" };
  await create().callTool("send_message_to_orchestrator", args);
  const bound = receipts.lookup(`send_message_to_orchestrator:${args.clientRequestId}`)!.binding!;
  const clock = spyOn(Date, "now").mockReturnValue(Date.parse(bound.claimedAt) + 30_000);
  const saved = JSON.parse(fs.readFileSync(linkFile("peers"), "utf8"));
  try {
    expect(await create().callTool("send_message_to_orchestrator", { ...args, recoveryOnly: true })).toMatchObject({ code: "not_executed" });
    const second = ["fedcba98", "7654", "4321", "8fed", "cba987654321"].join("-");
    atomicWrite(linkFile("peers"), { ...saved, peers: [
      { ...saved.peers[0], label: "Renamed" },
      { ...saved.peers[0], id: second, install: second, label: "Other" },
    ] });
    updateRemoteProjects(second, [{ key: project.project, name: "widget" }], saved.peers[0].store);
    recordSeatMessages(`peer:${second}`, true);
    expect(await create().callTool("send_message_to_orchestrator", args)).toMatchObject({ ok: true, state: "queued" });
    expect(posts).toHaveLength(2);
    expect(posts[1]!.machine).toBe(install);
  } finally { atomicWrite(linkFile("peers"), saved); clock.mockRestore(); }
});

for (const backend of ["file", "sqlite"] as const) {
  test(`a ${backend} retry claim retains its owner and target after the writer process exits`, async () => {
    const file = path.join(root, `restart-${backend}`);
    let receipts = backend === "file" ? new FileMcpReceiptStore(file) : new SqliteMcpReceiptStore(file);
    let posts = 0;
    const control = { post: async (_path: string, body: Record<string, unknown>) => {
      if (++posts === 1) throw new McpDispatchUncertainError("lost before admission");
      const link = resolveSeatMessageMachine(String(body.machine), String(body.project))!;
      return queueSeatMessage(link, String(body.project), String(body.text), caller, String(body.clientMessageId), body.seatMessageFence as string | undefined);
    } };
    const tools = viewerMcpRecoverableTools(domain);
    const create = () => createMcpToolService(viewerMcpBindings(undefined, control, domain), receipts, undefined, { recovery: tools });
    const args = { project: project.project, machine: "Other", text: "Resume the same durable claim.", clientRequestId: `restart-claim-${backend}` };
    const key = `send_message_to_orchestrator:${args.clientRequestId}`;
    await create().callTool("send_message_to_orchestrator", args);
    const initial = (await receipts.lookup(key))!;
    const clock = spyOn(Date, "now").mockReturnValue(Date.parse(initial.binding!.claimedAt) + 30_000);
    let cleanupChild: (() => Promise<void>) | undefined;
    let receiptsOpen = true;
    try {
      expect(await create().callTool("send_message_to_orchestrator", { ...args, recoveryOnly: true })).toMatchObject({ code: "not_executed" });
      const fresh = await tools.send_message_to_orchestrator!.bind(args);
      const claimedAt = new Date(Date.parse(initial.binding!.claimedAt) + 30_000).toISOString();
      const input = path.join(root, `restart-input-${backend}.json`);
      fs.writeFileSync(input, JSON.stringify({ backend, file, key, digest: initial.digest,
        module: path.resolve("src/lib/mcp/server.ts"), identityModule: path.resolve("src/lib/processIdentity.ts"),
        binding: { ...initial.binding, ...fresh, claimedAt, seatMessageDigest: initial.digest } }));
      if (receipts instanceof SqliteMcpReceiptStore) { receipts.close(); receiptsOpen = false; }
      const source = `const input = await Bun.file(process.env.LLV_TEST_REARM_INPUT).json();
        const { captureProcessIdentity } = await import(input.identityModule);
        const classes = await import(input.module);
        const store = input.backend === "file" ? new classes.FileMcpReceiptStore(input.file) : new classes.SqliteMcpReceiptStore(input.file);
        const binding = { ...input.binding, owner: captureProcessIdentity(process.pid) };
        const result = await store.claim(input.key, input.digest, "durable", binding);
        store.close?.(); console.log(result.kind);`;
      const child = Bun.spawn([process.execPath, "scripts/owned-runner.ts", "--portable", process.execPath, "-e", source], {
        cwd: process.cwd(), env: { ...process.env, LLV_TEST_REARM_INPUT: input }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      cleanupChild = async () => { if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; } };
      const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      if (code !== 0) throw new Error(`owned retry writer exited ${code}: ${errors}`);
      expect(output.trim()).toBe("fresh");
      receipts = backend === "file" ? new FileMcpReceiptStore(file) : new SqliteMcpReceiptStore(file);
      receiptsOpen = true;
      const retained = (await receipts.lookup(key))!;
      expect(retained.stage).toBe("claimed");
      expect(retained.result).toBeNull();
      expect(retained.digest).toBe(initial.digest);
      expect(retained.binding!.owner.pid).not.toBe(process.pid);
      expect(retained.binding!.target).toEqual(initial.binding!.target);
      expect(await create().callTool("send_message_to_orchestrator", { ...args, text: "Changed" })).toMatchObject({ code: "idempotency_conflict" });
      clock.mockReturnValue(Date.parse(claimedAt) + 30_000);
      expect(await create().callTool("send_message_to_orchestrator", { ...args, recoveryOnly: true })).toMatchObject({ code: "not_executed", details: { nextAction: "retry-same-key" } });
      expect(await create().callTool("send_message_to_orchestrator", args)).toMatchObject({ ok: true, state: "queued" });
      expect(posts).toBe(2);
    } finally {
      await cleanupChild?.();
      clock.mockRestore(); if (receiptsOpen && receipts instanceof SqliteMcpReceiptStore) receipts.close();
    }
  });
}

test("a retry interrupted before outbox admission rotates its fence without reopening an older attempt", async () => {
  const key = "retry-fence-rotation";
  const input = { project: project.project, text: "One instruction.", caller, claimedAt: "2026-01-01T00:00:00.000Z" };
  expect(recoverSeatMessage(install, key, input, Date.parse(input.claimedAt) + 30_000)).toMatchObject({ state: "not-delivered" });
  const first = seatMessageRetryFence(install, key)!;
  expect(recoverSeatMessage(install, key, { ...input, admissionFence: first }, Date.parse(input.claimedAt) + 30_000)).toMatchObject({ state: "not-delivered" });
  const second = seatMessageRetryFence(install, key)!;
  expect(second).not.toBe(first);
  recoverSeatMessage(install, key, { ...input, admissionFence: first }, Date.parse(input.claimedAt) + 30_000);
  expect(seatMessageRetryFence(install, key)).toBe(second);
  const link = resolveSeatMessageMachine(install, project.project)!;
  expect(() => queueSeatMessage(link, project.project, input.text, caller, key, first)).toThrow("fenced");
  expect(queueSeatMessage(link, project.project, input.text, caller, key, second)).toMatchObject({ state: "queued" });
});

test("an admission winning between the preliminary read and the fence transaction keeps its original id", async () => {
  const { SqliteStateCollection } = await import("@/lib/state/sqliteStateStore");
  const link = resolveSeatMessageMachine(install, project.project)!;
  const key = "admission-before-negative-cas";
  const input = { project: project.project, text: "Admission wins the race.", caller, claimedAt: "2026-01-01T00:00:00.000Z" };
  const prototype = SqliteStateCollection.prototype as unknown as { boundedPatch: (...parameters: unknown[]) => unknown };
  const patch = prototype.boundedPatch;
  let intervene = true, operationId = "";
  const race = spyOn(prototype, "boundedPatch").mockImplementation(function (this: object, ...parameters) {
    if (intervene) {
      intervene = false;
      operationId = queueSeatMessage(link, project.project, input.text, caller, key).operationId;
    }
    return Reflect.apply(patch, this, parameters);
  });
  try {
    expect(recoverSeatMessage(install, key, input, Date.parse(input.claimedAt) + 30_000)).toMatchObject({ state: "queued", operationId: expect.any(String) });
    expect(recoverSeatMessage(install, key, input, Date.parse(input.claimedAt) + 30_000)).toMatchObject({ operationId });
    expect(seatMessageRetryFence(install, key)).toBeUndefined();
  } finally { race.mockRestore(); }
});

test("an expired negative fence never regains admission through the message pruning pass", async () => {
  const key = "retained-negative-fence";
  const input = { project: project.project, text: "Retained negative proof.", caller, claimedAt: "2026-01-01T00:00:00.000Z" };
  recoverSeatMessage(install, key, input, Date.parse(input.claimedAt) + 30_000);
  const fence = seatMessageRetryFence(install, key)!;
  const link = resolveSeatMessageMachine(install, project.project)!;
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 36 * 86_400_000);
  try {
    await drainSeatMessages(link);
    expect(seatMessageRetryFence(install, key)).toBe(fence);
    expect(() => queueSeatMessage(link, project.project, input.text, caller, key)).toThrow("fenced");
  } finally { clock.mockRestore(); }
});

test("missing history expires only beyond the retention boundary with a valid claim time", () => {
  const input = { project: project.project, text: "Boundary proof.", caller, claimedAt: "2026-01-01T00:00:00.000Z" };
  const boundary = Date.parse(input.claimedAt) + 35 * 86_400_000;
  expect(recoverSeatMessage(install, "retention-boundary", input, boundary)).toMatchObject({ state: "not-delivered" });
  expect(recoverSeatMessage(install, "retention-boundary", input, boundary + 1)).toMatchObject({ state: "not-delivered" });
  expect(recoverSeatMessage(install, "retention-expired", input, boundary + 1)).toMatchObject({ outcome: "history-expired" });
  expect(recoverSeatMessage(install, "retention-invalid", { ...input, claimedAt: "invalid" }, boundary + 1)).toBeNull();
  expect(recoverSeatMessage(install, "retention-future", { ...input, claimedAt: new Date(boundary + 2).toISOString() }, boundary + 1)).toBeNull();
});

for (const backend of ["memory", "file", "sqlite"] as const) for (const acknowledged of [false, true]) {
  test(`expired ${backend} outbox history closes recovery after ${acknowledged ? "an accepted answer" : "a lost answer"}`, async () => {
    const file = path.join(root, `expired-${backend}-${acknowledged}`);
    const receipts = backend === "memory" ? new MemoryMcpReceiptStore() : backend === "file" ? new FileMcpReceiptStore(file) : new SqliteMcpReceiptStore(file);
    let posts = 0;
    const control = { post: async (_path: string, body: Record<string, unknown>) => {
      posts++;
      const link = resolveSeatMessageMachine(String(body.machine), String(body.project))!;
      const accepted = queueSeatMessage(link, String(body.project), String(body.text), caller, String(body.clientMessageId));
      if (!acknowledged) throw new McpDispatchUncertainError("lost after admission");
      return accepted;
    } };
    const create = () => createMcpToolService(viewerMcpBindings(undefined, control, domain), receipts, undefined, { recovery: viewerMcpRecoverableTools(domain) });
    const args = { project: project.project, machine: "Other", text: "Keep expiry separate from non-delivery.", clientRequestId: `expired-history-${backend}-${acknowledged}` };
    const initial = await create().callTool("send_message_to_orchestrator", args);
    expect(initial.ok).toBe(true);
    const bound = (await receipts.lookup(`send_message_to_orchestrator:${args.clientRequestId}`))!.binding!;
    const clock = spyOn(Date, "now").mockReturnValue(Date.parse(bound.claimedAt) + 35 * 86_400_000);
    try {
      // Age alone never overrides an extant receipt, even past retention.
      expect(await create().callTool("send_message_to_orchestrator", { ...args, recoveryOnly: true })).toMatchObject({ outcome: "accepted", state: "queued" });
      clock.mockReturnValue(Date.parse(bound.claimedAt) + 36 * 86_400_000);
      expect(await create().callTool("send_message_to_orchestrator", { ...args, recoveryOnly: true })).toMatchObject({ outcome: "accepted", state: "queued" });
      const link = resolveSeatMessageMachine(install, project.project)!;
      await drainSeatMessages(link);
      expect(recoverSeatMessage(install, bound.downstreamKey)).toBeNull();
      const expired = { ok: false, code: "history_expired", retryable: false, details: {
        outcome: "history-expired", state: "history-expired", nextAction: "manual-check", resend: "manual-check", duplicateRisk: true,
      } };
      expect(await create().callTool("send_message_to_orchestrator", { ...args, recoveryOnly: !acknowledged })).toMatchObject(expired);
      expect(await create().callTool("send_message_to_orchestrator", { ...args, recoveryOnly: true })).toMatchObject(expired);
      expect(await create().callTool("send_message_to_orchestrator", args)).toMatchObject(expired);
      expect(await create().callTool("send_message_to_orchestrator", { ...args, text: "Changed words" })).toMatchObject({ code: "idempotency_conflict" });
      const foreignDomain = { ...domain, callerAttribution: () => ({ kind: "agent", conversationId: "conversation_foreign", role: "orchestrator" }),
        attentionAuthority: () => ({ kind: "worker", conversationId: "conversation_foreign" }),
        authorizedSeats: () => [{ project: project.project, conversationId: "conversation_foreign", path: null }] } as unknown as ViewerMcpDomainDependencies;
      const foreign = createMcpToolService(viewerMcpBindings(undefined, control, foreignDomain), receipts, undefined, { recovery: viewerMcpRecoverableTools(foreignDomain) });
      expect(await foreign.callTool("send_message_to_orchestrator", { ...args, recoveryOnly: true })).toMatchObject({ code: "recovery_not_permitted" });
      const row = (await receipts.lookup(`send_message_to_orchestrator:${args.clientRequestId}`))!;
      expect(row.stage).toBe("settled");
      expect(row.recoveryResult ?? row.result).toMatchObject(expired);
      // A fresh process reads the real writer's terminal result and cannot
      // dispatch, including when its clock is earlier than the expiry seam.
      if (backend !== "memory") {
        const input = path.join(root, `expired-input-${backend}-${acknowledged}.json`);
        fs.writeFileSync(input, JSON.stringify({ backend, file, args, caller, project: project.project,
          server: path.resolve("src/lib/mcp/server.ts"), bindings: path.resolve("src/lib/mcp/bindings.ts"), registry: path.resolve("src/lib/agent/registry.ts") }));
        const source = `const input = await Bun.file(process.env.LLV_TEST_EXPIRY_INPUT).json();
          const classes = await import(input.server);
          const { viewerMcpBindings, viewerMcpRecoverableTools } = await import(input.bindings);
          const { agentRegistry } = await import(input.registry);
          const store = input.backend === "file" ? new classes.FileMcpReceiptStore(input.file) : new classes.SqliteMcpReceiptStore(input.file);
          const domain = { registrySnapshot: () => agentRegistry().readOnlySnapshot(),
            callerAttribution: () => ({ kind: "agent", conversationId: input.caller, role: "orchestrator" }),
            attentionAuthority: () => ({ kind: "worker", conversationId: input.caller }),
            authorizedSeats: () => [{ project: input.project, conversationId: input.caller, path: null }], recoveryPredecessors: () => [] };
          let posts = 0;
          const service = classes.createMcpToolService(viewerMcpBindings(undefined, { post: async () => { posts++; throw new Error("unexpected dispatch"); } }, domain), store,
            undefined, { recovery: viewerMcpRecoverableTools(domain) });
          const results = [];
          for (const recoveryOnly of [false, true]) results.push(await service.callTool("send_message_to_orchestrator", { ...input.args, recoveryOnly }));
          store.close?.(); console.log(JSON.stringify({ results, posts }));`;
        const child = Bun.spawn([process.execPath, "scripts/owned-runner.ts", "--portable", process.execPath, "-e", source], {
          cwd: process.cwd(), env: { ...process.env, LLV_TEST_EXPIRY_INPUT: input }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
        });
        try {
          const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
          if (code !== 0) throw new Error(`expiry reader exited ${code}: ${errors}`);
          const restarted = JSON.parse(output);
          expect(restarted.posts).toBe(0);
          expect(restarted.results).toHaveLength(2);
          for (const result of restarted.results) expect(result).toMatchObject(expired);
        } finally { if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; } }
      }
      expect(posts).toBe(1);
      expect(seatMessageRetryFence(install, bound.downstreamKey)).toBeUndefined();
    } finally { clock.mockRestore(); if (receipts instanceof SqliteMcpReceiptStore) receipts.close(); }
  });
}

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
