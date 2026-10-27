import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { statePath } from "@/lib/configDir";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import type { RegistryConversation } from "@/lib/agent/registry";
import { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } from "@/lib/orchestrator/seats";
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

test("one seat snapshot resolves a deep parent chain, and a later resolution rereads revocation", () => {
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
  const file = statePath("orchestrator-seats.json");
  const read = spyOn(fs, "readFileSync");
  try {
    expect(conversationWorkspacePrincipal(chain(10), "conversation_0", store)).toEqual(workspace);
    expect(read.mock.calls.filter(([name]) => name === file)).toHaveLength(1);
    const seats = JSON.parse(fs.readFileSync(file, "utf8"));
    delete seats.seats["project-alpha"];
    fs.writeFileSync(file, JSON.stringify(seats));
    expect(conversationWorkspacePrincipal(chain(10), "conversation_0", store)).toBeNull();
  } finally { read.mockRestore(); }
});

for (const mode of ["solo", "team without workspaces"] as const) {
  test(`${mode} resolves without reading seats`, () => {
    const store = mode === "solo" ? null : teamStore();
    const read = spyOn(fs, "readFileSync");
    try {
      expect(conversationWorkspacePrincipal(chain(10), "conversation_0", store)).toBeNull();
      expect(read.mock.calls.filter(([name]) => name === statePath("orchestrator-seats.json"))).toEqual([]);
    } finally { read.mockRestore(); }
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
