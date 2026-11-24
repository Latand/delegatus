import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { statePath } from "@/lib/configDir";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry, type RegistryConversation } from "@/lib/agent/registry";
import { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent, readOrchestratorSeatFile } from "@/lib/orchestrator/seats";
import * as seatStore from "@/lib/orchestrator/seatStore";
import { clearStoredSeatRecord, damageStoredSeatRecord, writeStoredSeatRecord } from "@/lib/orchestrator/seatStoreFixture";
import { resetTeamStoreForTests, teamStore } from "./store";
import { createWorkspace } from "./workspaces";
import { conversationWorkspacePrincipal } from "./workspacePrincipal";

const AT = "2026-10-20T09:00:00.000Z";
const W = `w_${"c".repeat(32)}`;
let root: string;
const previous = process.env.LLV_STATE_DIR;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-principal-"));
  process.env.LLV_STATE_DIR = root; resetTeamStoreForTests();
});
afterEach(() => {
  resetTeamStoreForTests();
  if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
  fs.rmSync(root, { recursive: true, force: true });
});
function chain(depth: number) {
  return (id: string) => {
    const index = Number(id.slice("conversation_".length));
    return { id, generations: [{ launchProfile: emptyLaunchProfile({ cwd: root, project: "project-alpha",
      ...(index + 1 < depth ? { parentConversationId: `conversation_${index + 1}` } : {}) }) }] } as RegistryConversation;
  };
}

test("unchanged seats reuse one parsed map across deep chains; rebinding and revocation invalidate it", () => {
  const store = teamStore();
  const owner = { id: "m_owner", name: "Owner", role: "owner" as const, status: "active" as const, color: "teal" as const,
    telegram: null, createdAt: AT, createdBy: "claim", revokedAt: null };
  store.insertMember(owner);
  store.insertMember({ ...owner, id: "m_member", name: "Member", role: "member" });
  createWorkspace(store, owner, { id: W, name: "Alpha", projects: ["project-alpha"] });
  const workspace = { memberId: "m_member", workspaceId: W };
  store.putWorkspaceMember(W, "m_member", "member", owner.id, AT);
  beginOrchestratorSeatIntent({ project: "project-alpha", mandate: "Run work", clientRequestId: "seat", mode: "existing", conversationId: "conversation_9", workspace, now: AT });
  completeOrchestratorSeatIntent({ project: "project-alpha", clientRequestId: "seat", conversationId: "conversation_9", path: "seat.jsonl", now: AT });
  const read = spyOn(seatStore, "readOrchestratorSeatStore");
  try {
    expect(conversationWorkspacePrincipal(chain(10), "conversation_0", store)).toEqual(workspace);
    for (const depth of [1, 4, 10]) {
      for (let n = 0; n < 5; n++) conversationWorkspacePrincipal(chain(depth), "conversation_0", store);
    }
    expect(read.mock.calls).toHaveLength(1);
    const seats = readOrchestratorSeatFile();
    seats.seats["project-alpha"]!.workspace = { ...workspace, workspaceId: null as unknown as string };
    writeStoredSeatRecord(seats);
    expect(conversationWorkspacePrincipal(chain(10), "conversation_0", store)).toEqual({ ...workspace, workspaceId: null });
    delete seats.seats["project-alpha"];
    writeStoredSeatRecord(seats);
    expect(conversationWorkspacePrincipal(chain(10), "conversation_0", store)).toBeNull();
    damageStoredSeatRecord();
    expect(() => conversationWorkspacePrincipal(chain(10), "conversation_0", store)).toThrow("workspace seat authority is unavailable");
    clearStoredSeatRecord();
    expect(conversationWorkspacePrincipal(chain(10), "conversation_0", store)).toBeNull();
  } finally { read.mockRestore(); }
});

for (const mode of ["solo", "team without workspaces"] as const) {
  test(`${mode} resolves without reading seats`, () => {
    const store = mode === "solo" ? null : teamStore();
    const read = spyOn(seatStore, "readOrchestratorSeatStore");
    const revision = spyOn(seatStore, "orchestratorSeatStoreSignature");
    try {
      expect(conversationWorkspacePrincipal(chain(10), "conversation_0", store)).toBeNull();
      expect(read.mock.calls).toEqual([]);
      expect(revision.mock.calls).toEqual([]);
    } finally { read.mockRestore(); revision.mockRestore(); }
  });
}

test("unreadable seat authority never becomes installation reach", () => {
  const store = teamStore();
  const owner = { id: "m_owner", name: "Owner", role: "owner" as const, status: "active" as const, color: "teal" as const,
    telegram: null, createdAt: AT, createdBy: "claim", revokedAt: null };
  store.insertMember(owner);
  createWorkspace(store, owner, { id: W, name: "Alpha", projects: ["project-alpha"] });
  for (const raw of ["{", JSON.stringify({ schemaVersion: 999 })]) {
    fs.writeFileSync(statePath("orchestrator-seats.json"), raw);
    expect(() => conversationWorkspacePrincipal(chain(10), "conversation_0", store)).toThrow("workspace seat authority is unavailable");
  }
});

test("a transient read failure recovers without a file change", () => {
  const store = teamStore();
  const owner = { id: "m_owner", name: "Owner", role: "owner" as const, status: "active" as const, color: "teal" as const,
    telegram: null, createdAt: AT, createdBy: "claim", revokedAt: null };
  store.insertMember(owner);
  createWorkspace(store, owner, { id: W, name: "Alpha", projects: ["project-alpha"] });
  const file = statePath("orchestrator-seats.json");
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, nextSeatEpoch: 1, seats: {} }));
  const original = fs.readFileSync;
  const read = spyOn(fs, "readFileSync").mockImplementation(((name: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (name === file) throw new Error("transient read failure");
    return Reflect.apply(original, fs, [name, ...args]);
  }) as typeof fs.readFileSync);
  try { expect(() => conversationWorkspacePrincipal(chain(1), "conversation_0", store)).toThrow("workspace seat authority is unavailable"); }
  finally { read.mockRestore(); }
  expect(conversationWorkspacePrincipal(chain(1), "conversation_0", store)).toBeNull();
});

function storeWithWorkspaceMember() {
  const store = teamStore();
  const owner = { id: "m_owner", name: "Owner", role: "owner" as const, status: "active" as const, color: "teal" as const,
    telegram: null, createdAt: AT, createdBy: "claim", revokedAt: null };
  store.insertMember(owner);
  store.insertMember({ ...owner, id: "m_member", name: "Member", role: "member" });
  createWorkspace(store, owner, { id: W, name: "Alpha", projects: ["project-alpha"] });
  store.putWorkspaceMember(W, "m_member", "member", owner.id, AT);
  return store;
}

test("workspace reach checks revocations against the caller's seat epoch", () => {
  const store = storeWithWorkspaceMember();
  const caller = "conversation_worker";
  const previous = "conversation_previous";
  beginOrchestratorSeatIntent({ project: "project-beta", clientRequestId: "older-seat", mode: "existing", conversationId: "conversation_peer", now: AT, mandate: "Older seat" });
  completeOrchestratorSeatIntent({ project: "project-beta", clientRequestId: "older-seat", conversationId: "conversation_peer", path: "peer.jsonl", now: AT });
  beginOrchestratorSeatIntent({ project: "project-alpha", clientRequestId: "current-seat", mode: "existing", conversationId: caller, now: AT, mandate: "Current seat" });
  completeOrchestratorSeatIntent({ project: "project-alpha", clientRequestId: "current-seat", conversationId: caller, path: "current.jsonl", now: AT });
  store.admitConversationMember(caller, "m_member");
  const seats = readOrchestratorSeatFile();
  const epoch = seats.seats["project-alpha"]!.seatEpoch;
  const revocation = { project: "project-alpha", conversationId: previous, seatEpoch: epoch - 1, revokedAt: AT };
  seats.revocations.push(revocation);
  writeStoredSeatRecord(seats);

  const read: string[] = [];
  const lookup = (id: string) => {
    read.push(id);
    return { id: id === previous ? caller : id, generations: [{ launchProfile: emptyLaunchProfile({
      cwd: root, project: id === "conversation_peer" ? "project-beta" : "project-alpha",
    }) }] } as RegistryConversation;
  };
  expect(conversationWorkspacePrincipal(lookup, caller, store)).toBeNull();
  expect(read).not.toContain(previous);

  revocation.seatEpoch = epoch;
  writeStoredSeatRecord(seats);
  read.length = 0;
  expect(conversationWorkspacePrincipal(lookup, caller, store)).toEqual({ memberId: "m_member", workspaceId: W });
  expect(read).toContain(previous);
});

test("live revocation reads preserve member reach across a peer alias commit", () => {
  const store = storeWithWorkspaceMember();
  const filename = path.join(root, "registry.json");
  const reader = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
  const writer = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
  try {
    const designate = (project: string) => {
      const transcript = path.join(root, project + ".jsonl");
      const { id } = writer.ensureConversation("claude", transcript, null);
      writer.agentStateWrite(file => {
        file.conversations[id]!.generations[0]!.launchProfile = emptyLaunchProfile({ cwd: root, project });
      });
      beginOrchestratorSeatIntent({ project, clientRequestId: project, mode: "existing", mandate: "Seat", conversationId: id, now: AT });
      completeOrchestratorSeatIntent({ project, clientRequestId: project, conversationId: id, path: transcript, now: AT });
      return id;
    };
    const caller = designate("project-alpha");
    const neighbour = designate("project-beta");
    store.admitConversationMember(caller, "m_member");
    const seats = readOrchestratorSeatFile();
    seats.revocations.push({ project: "project-alpha", conversationId: neighbour,
      seatEpoch: seats.seats["project-alpha"]!.seatEpoch, revokedAt: AT });
    writeStoredSeatRecord(seats);

    const observations: string[] = [];
    const liveLookup = (id: string) => {
      const row = reader.conversation(id as `conversation_${string}`);
      if (id === neighbour && row) {
        observations.push(row.id);
        if (observations.length === 1) {
          // The active-seat read has completed. Publish the peer update before the revocation read.
          writer.agentStateWrite(file => { file.conversationAliases[neighbour] = caller; });
        }
      }
      return row;
    };
    expect(conversationWorkspacePrincipal(liveLookup, caller, store)).toEqual({ memberId: "m_member", workspaceId: W });
    expect(observations).toEqual([neighbour, caller]);
  } finally {
    reader.close();
    writer.close();
  }
});
