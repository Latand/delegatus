import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { procBackend } from "@/lib/proc";
import { structuredTerminationDecision } from "./structuredTerminationDecision";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { AgentRegistry, normalizeRegistry, type AgentRegistryEntry, type RegistryConversation } from "./registry";
import { SqliteAgentRegistryStore } from "./sqliteRegistryStore";

const key = { engine: "claude" as const, sessionId: "decision-session" };
const ref = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const decision = { caller: "terminal-recovery" as const, claimRefusal: null };

// Capture through the production writer and read its actual NDJSON output.
function fixture(run: (registry: AgentRegistry, root: string, entry: AgentRegistryEntry) => void, sqlite = false): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stop-decision-"));
  const filename = path.join(directory, "registry.json");
  const identity = captureProcessIdentity(process.pid);
  const entry = { key, artifactPath: path.join(directory, "decision-session.jsonl"), cwd: directory, accountId: null,
    status: "live" as const, host: null, claimEpoch: 1, claimOwner: `structured-host:${JSON.stringify(identity)}`, pendingAction: null,
    structuredHost: { kind: "claude-broker" as const, endpoint: "stdio:fixture", process: identity,
      writerClaimEpoch: 1, eventCursor: 1, activeTurnRef: "fixture-turn", protocolVersion: null, pendingAttention: [], activeFlags: [] },
    updatedAt: "2026-01-01T00:00:00.000Z" };
  const conversation = { id: "conversation_fixture", engine: "claude", generations: [{ id: key.sessionId, path: entry.artifactPath,
    accountId: null, createdAt: entry.updatedAt, archivedAt: null }], continuityPaths: [], abandonedContinuityPaths: [],
    providerForkPaths: [], turn: { state: "busy", source: "lifecycle", terminalAt: null, observedAt: entry.updatedAt } } as unknown as RegistryConversation;
  const file = normalizeRegistry({ version: 2, receipts: {}, entries: { "claude:decision-session": entry }, conversations: { conversation_fixture: conversation },
    memberships: { conversation_fixture: [{ conversationId: "conversation_fixture", kind: "pipeline", containerId: "pipeline_fixture",
      role: "builder", slot: "build:1", stageId: "build", stageOrder: 1, round: 1, parentConversationId: null, createdAt: entry.updatedAt }] } });
  let registry: AgentRegistry | undefined;
  try {
    if (sqlite) {
      const seed = new SqliteAgentRegistryStore(path.join(directory, "registry.sqlite"), { initialSnapshot: file, normalize: normalizeRegistry });
      seed.close();
    } else fs.writeFileSync(filename, JSON.stringify(file));
    registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: sqlite ? "sqlite" : "off" });
    run(registry, directory, entry);
  } finally { registry?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
}
function capture(registry: AgentRegistry, directory: string, entry: AgentRegistryEntry) {
  expect(registry.captureStructuredTerminationSurvivors(key, entry.structuredHost!.process!, [], "structured-orphan-stop", decision)).not.toBeNull();
  const lines = fs.readFileSync(path.join(directory, "host-termination-journal.ndjson"), "utf8").trim().split("\n");
  return JSON.parse(lines.at(-1)!).decision;
}

for (const sqlite of [false, true]) test(`capture reads current ownership from ${sqlite ? "SQLite" : "JSON"} and leaves stop eligibility unchanged`, () => fixture((registry, directory, entry) => {
  const before = registry.readOnlySnapshot().entries["claude:decision-session"]!;
  const result = capture(registry, directory, entry);
  expect(result).toMatchObject({ ownerState: "alive", ownerStartIdentity: captureProcessIdentity(process.pid).startIdentity,
    activeTurnRef: ref("fixture-turn"), turnOpen: true, ownershipState: "read", conversationsTruncated: false,
    conversations: [{ id: ref("conversation_fixture"), currentGeneration: true, turnState: "busy", membershipsTruncated: false,
      memberships: [{ kind: "pipeline", containerId: ref("pipeline_fixture"), stageId: ref("build"), round: 1 }] }],
    runtimeHostGeneration: { state: "missing" } });
  const after = registry.readOnlySnapshot().entries["claude:decision-session"]!;
  expect(after.claimOwner).toBe(before.claimOwner);
  expect(after.structuredHost).toEqual(before.structuredHost);
  // Changes made after the earlier observation are serialized at capture.
  registry.upsert({ ...after, claimOwner: null, structuredHost: { ...after.structuredHost!, activeTurnRef: null } });
  expect(capture(registry, directory, entry)).toMatchObject({ ownerState: "absent", ownerPid: null,
    ownerStartIdentity: null, ownerBootEpoch: null, turnOpen: false, activeTurnRef: null });
}, sqlite));

test("malformed identities, opaque references and oversized ownership remain private and bounded", () => fixture((registry, directory, entry) => {
  const payload = "private message /private/path value".repeat(1000);
  const filename = path.join(directory, "registry.json");
  const file = JSON.parse(fs.readFileSync(filename, "utf8"));
  const original = file.conversations.conversation_fixture;
  for (let i = 0; i < 8; i++) {
    const id = `conversation_fixture_${i}`;
    file.conversations[id] = { ...original, id };
    file.memberships[id] = Array.from({ length: 8 }, () => ({ ...file.memberships.conversation_fixture[0], conversationId: id,
      containerId: payload, stageId: payload, parentConversationId: payload, role: payload, slot: payload }));
  }
  const row = file.entries["claude:decision-session"];
  row.claimOwner = `structured-host:${JSON.stringify({ pid: process.pid, startIdentity: payload, bootEpoch: payload })}`;
  row.structuredHost.activeTurnRef = payload;
  fs.writeFileSync(filename, JSON.stringify(file));
  const result = capture(registry, directory, entry);
  expect(result.ownerState).toBe("invalid");
  expect(result.activeTurnRef).toBe(ref(payload));
  expect(result.conversationsTruncated).toBe(true);
  expect(result.conversations).toHaveLength(4);
  const truncated = result.conversations.filter((row: { membershipsTruncated: boolean }) => row.membershipsTruncated);
  expect(truncated.length).toBeGreaterThan(0);
  for (const related of truncated) expect(related.memberships).toHaveLength(4);
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain("private message");
  expect(serialized).not.toContain("/private/path");
  expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(12_000);
  row.claimOwner = `structured-host:${JSON.stringify({ pid: process.pid, startIdentity: "private token", bootEpoch: "private epoch" })}`;
  fs.writeFileSync(filename, JSON.stringify(file));
  const masked = capture(registry, directory, entry);
  expect(masked.ownerStartIdentity).toBe(ref("private token"));
  expect(masked.ownerBootEpoch).toBe(ref("private epoch"));
  expect(JSON.stringify(masked)).not.toContain("private token");
  expect(JSON.stringify(masked)).not.toContain("private epoch");
  for (const owner of ["invalid", "structured-host:null", "structured-host:{}", `structured-host:${JSON.stringify({ pid: process.pid })}`]) {
    row.claimOwner = owner;
    fs.writeFileSync(filename, JSON.stringify(file));
    expect(capture(registry, directory, entry).ownerState).toBe(owner.endsWith(`{"pid":${process.pid}}`) ? "unverified" : "invalid");
  }
}));

test("runtime fence absence, corrupt data, oversized files and unreadable paths never refuse capture", () => fixture((registry, directory, entry) => {
  const filename = path.join(directory, "runtime-host.sock.lock");
  expect(capture(registry, directory, entry).runtimeHostGeneration).toEqual({ state: "missing" });
  for (const text of ["{}", "null", "x".repeat(4097), JSON.stringify({ pid: process.pid, startIdentity: "private content", acquisitionId: "private content" })]) {
    fs.writeFileSync(filename, text);
    expect(capture(registry, directory, entry).runtimeHostGeneration).toEqual({ state: "invalid" });
  }
  fs.writeFileSync(filename, "{");
  expect(capture(registry, directory, entry).runtimeHostGeneration).toEqual({ state: "unreadable" });
  fs.unlinkSync(filename);
  fs.mkdirSync(filename);
  // Platforms can reject opening a directory before fstat classifies it.
  expect(["invalid", "unreadable"]).toContain(capture(registry, directory, entry).runtimeHostGeneration.state);
}));

for (const collection of ["conversations", "memberships"] as const) test(`an unreadable ${collection} projection keeps the diagnostic serializable`, () => fixture((registry, directory, entry) => {
  const file = registry.readOnlySnapshot();
  const unavailable = "private observation failure";
  const broken = { ...file, [collection]: new Proxy(file[collection], {
    ownKeys() { throw new Error(unavailable); },
    get() { throw new Error(unavailable); },
  }) };
  const observed = structuredTerminationDecision(broken, entry, decision, path.join(directory, "registry.json"));
  const serialized = JSON.stringify(observed);
  expect(serialized).not.toContain(unavailable);
  expect(JSON.parse(serialized)).toMatchObject({ ownershipState: "unreadable", conversations: [], conversationsTruncated: false,
    caller: "terminal-recovery", ownerState: "alive", activeTurnRef: ref("fixture-turn"), turnOpen: true });
}));

test("a failed extra kernel observation leaves the owner unverified", () => fixture((registry, directory, entry) => {
  const file = registry.readOnlySnapshot();
  const probe = spyOn(procBackend, "processIdentity").mockImplementation(() => { throw new Error("private probe failure"); });
  let observed: Record<string, unknown> | undefined;
  try { observed = structuredTerminationDecision(file, entry, decision, path.join(directory, "registry.json")); }
  finally { probe.mockRestore(); }
  expect(observed!).toMatchObject({ ownerState: "unverified", ownerPid: process.pid, ownershipState: "read" });
  expect(JSON.stringify(observed!)).not.toContain("private probe failure");
}));

test("a diagnostic descriptor cleanup failure leaves capture metadata available", () => fixture((registry, directory, entry) => {
  const file = registry.readOnlySnapshot();
  fs.writeFileSync(path.join(directory, "runtime-host.sock.lock"), JSON.stringify({
    ...captureProcessIdentity(process.pid), acquisitionId: "00000000-0000-0000-0000-000000000001",
  }));
  const close = fs.closeSync.bind(fs);
  const closing = spyOn(fs, "closeSync").mockImplementation(fd => { close(fd); throw new Error("private close failure"); });
  let observed: Record<string, unknown> | undefined;
  try { observed = structuredTerminationDecision(file, entry, decision, path.join(directory, "registry.json")); }
  finally { closing.mockRestore(); }
  expect(observed!).toMatchObject({ runtimeHostGeneration: { state: "read", pid: process.pid }, ownershipState: "read" });
  expect(JSON.stringify(observed!)).not.toContain("private close failure");
}));

test("configured and default fence selection matches runtime-host whitespace handling", () => fixture((registry, directory, entry) => {
  const previous = process.env.LLV_RUNTIME_HOST_FENCE;
  const identity = captureProcessIdentity(process.pid);
  const custom = path.join(directory, "configured-fence");
  const first = "00000000-0000-0000-0000-000000000001";
  const second = "00000000-0000-0000-0000-000000000002";
  fs.writeFileSync(path.join(directory, "runtime-host.sock.lock"), JSON.stringify({ ...identity, acquisitionId: first }));
  fs.writeFileSync(custom, JSON.stringify({ ...identity, acquisitionId: second }));
  try {
    process.env.LLV_RUNTIME_HOST_FENCE = "  ";
    expect(capture(registry, directory, entry).runtimeHostGeneration).toMatchObject({ state: "read", acquisitionId: first });
    process.env.LLV_RUNTIME_HOST_FENCE = ` ${custom} `;
    expect(capture(registry, directory, entry).runtimeHostGeneration).toMatchObject({ state: "read", acquisitionId: second });
  } finally {
    if (previous === undefined) delete process.env.LLV_RUNTIME_HOST_FENCE;
    else process.env.LLV_RUNTIME_HOST_FENCE = previous;
  }
}));
