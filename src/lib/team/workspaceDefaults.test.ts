import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { NextRequest } from "next/server";
import type { Member } from "./contract";
import { TeamStore, resetTeamStoreForTests, teamStore, teamStoreFile } from "./store";
import { createWorkspace, placeProject } from "./workspaces";
import { parseWorkspaceDefaults, setWorkspaceDefaults, workspaceDefaultsForProject } from "./workspaceDefaults";
import { allowedAccountIdsForProject, bindAccountToProject } from "@/lib/accounts/projectBindings";
import { selectProjectAccount } from "@/lib/accounts/projectSelection";
import { effectiveReportTelegram, setReportTelegram } from "@/lib/projects/settings";
import { mintSession } from "./sessions";
import { GET, PUT } from "@/app/api/team/workspaces/[id]/defaults/route";

const W1 = `w_${"1".repeat(32)}`, W2 = `w_${"2".repeat(32)}`, AT = "2026-10-20T09:00:00.000Z";
let root: string, store: TeamStore, owner: Member, manager: Member, member: Member;
const previous = process.env.LLV_STATE_DIR;
function person(id: string, role: Member["role"]): Member {
  const row: Member = { id, name: id, role, status: "active", color: "teal", telegram: null, createdAt: AT, createdBy: "claim", revokedAt: null };
  store.insertMember(row); return row;
}
const defaults = { accounts: { claude: ["account-a"], codex: ["account-b"] }, reportChat: { chat: "reports-alpha", name: "Alpha", topicId: 5 }, directiveChats: ["directives-alpha"] };
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-defaults-"));
  process.env.LLV_STATE_DIR = root; resetTeamStoreForTests(); store = teamStore();
  owner = person("m_owner", "owner"); manager = person("m_manager", "member"); member = person("m_member", "member");
  createWorkspace(store, owner, { id: W1, name: "Alpha", projects: ["project-alpha"] });
  createWorkspace(store, owner, { id: W2, name: "Beta", projects: ["project-beta"] });
  store.putWorkspaceMember(W1, manager.id, "manager", owner.id, AT);
  store.putWorkspaceMember(W1, member.id, "member", owner.id, AT);
});
afterEach(() => {
  resetTeamStoreForTests();
  if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
  fs.rmSync(root, { recursive: true, force: true });
});

test("workspace defaults survive reopening and feed the real automatic launch selector", () => {
  setWorkspaceDefaults(store, owner, W1, defaults);
  const reader = new TeamStore(teamStoreFile());
  expect(parseWorkspaceDefaults(reader.workspaceDefaults(W1))).toEqual(defaults); reader.close();
  expect(allowedAccountIdsForProject("project-alpha", "codex")).toEqual(["account-b"]);
  expect(selectProjectAccount({ project: "project-alpha", engine: "codex", accounts: [{ id: "account-a", authPresent: true }, { id: "account-b", authPresent: true }],
    observations: [], bindings: [], preferredId: "account-a", unbound: "engine-default" })).toMatchObject({ kind: "available", accountId: "account-b" });
  expect(allowedAccountIdsForProject("project-beta", "codex")).toBeNull();
  expect(effectiveReportTelegram("project-alpha")).toEqual({ ...defaults.reportChat, source: "chosen" });
});

test("project bindings narrow workspace pools; report choices and placements resolve live", () => {
  setWorkspaceDefaults(store, owner, W1, defaults);
  expect(bindAccountToProject("codex", "account-explicit", "project-alpha").ok).toBe(true);
  setReportTelegram("project-alpha", null, "operator");
  expect(allowedAccountIdsForProject("project-alpha", "codex")).toEqual([]);
  expect(selectProjectAccount({ project: "project-alpha", engine: "codex", accounts: [{ id: "account-explicit", authPresent: true }],
    observations: [], bindings: [{ engine: "codex", accountId: "account-explicit", project: "project-alpha", createdAt: AT }], unbound: "engine-default" }).kind).toBe("unavailable");
  expect(bindAccountToProject("codex", "account-b", "project-alpha").ok).toBe(true);
  expect(allowedAccountIdsForProject("project-alpha", "codex")).toEqual(["account-b"]);
  expect(effectiveReportTelegram("project-alpha")).toBeNull();
  placeProject(store, owner, "project-new", W1);
  expect(allowedAccountIdsForProject("project-new", "codex")).toEqual(["account-b"]);
  setWorkspaceDefaults(store, manager, W1, { ...defaults, accounts: { claude: [], codex: ["account-c"] } });
  expect(allowedAccountIdsForProject("project-new", "codex")).toEqual(["account-c"]);
  expect(allowedAccountIdsForProject("project-alpha", "codex")).toEqual([]);
  placeProject(store, owner, "project-new", W2);
  expect(workspaceDefaultsForProject("project-new")?.accounts.codex).toEqual([]);
});

test("the defaults endpoint admits the owner and that workspace's manager, and refuses members and foreign managers", async () => {
  for (const [actor, id, expected] of [[owner, W2, 200], [manager, W1, 200], [manager, W2, 403], [member, W1, 403]] as const) {
    const cookie = mintSession(store, actor.id, "claim", { surface: "desktop", browser: "chrome" }).value;
    const request = (method: string) => new NextRequest(`http://localhost/api/team/workspaces/${id}/defaults`, { method, headers: { host: "localhost", cookie: `llv_member=${cookie}`, "content-type": "application/json" }, ...(method === "PUT" ? { body: JSON.stringify(defaults) } : {}) });
    expect((await PUT(request("PUT"), { params: Promise.resolve({ id }) })).status).toBe(expected);
    expect((await GET(request("GET"), { params: Promise.resolve({ id }) })).status).toBe(expected);
  }
});

test("malformed durable defaults refuse rather than opening the account pool", () => {
  store.putWorkspaceDefaults(W1, { accounts: { codex: "account-a" } });
  expect(() => allowedAccountIdsForProject("project-alpha", "codex")).toThrow();
  for (const input of [{ accounts: "all" }, { accounts: { codex: [""] } }, { reportChat: { chat: "reports", name: "Alpha", topicId: -1 } }, { directiveChats: "all" }])
    expect(() => setWorkspaceDefaults(store, owner, W1, input)).toThrow();
});
