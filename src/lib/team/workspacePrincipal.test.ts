import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { statePath } from "@/lib/configDir";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import type { RegistryConversation } from "@/lib/agent/registry";
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
