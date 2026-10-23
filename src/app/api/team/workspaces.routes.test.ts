import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest, type NextResponse } from "next/server";

import { persistProjectAliases } from "@/lib/projects/aliases";
import { createManualProject } from "@/lib/projects/curation";
import { replaceConversationCatalog, type ConversationCatalogEntry } from "@/lib/scanner/conversationCatalog";
import type { Workspace, WorkspacesView } from "@/lib/team/contract";
import { MEMBER_COOKIE } from "@/lib/team/sessions";
import { resetTeamStoreForTests } from "@/lib/team/store";

import { POST as claim } from "./claim/route";
import { POST as createInvite } from "./invites/route";
import { POST as join } from "./join/[code]/route";
import { PUT as place } from "./workspace-projects/route";
import { DELETE as deleteWorkspace, PATCH as patchWorkspace } from "./workspaces/[id]/route";
import { GET as listWorkspaces, POST as createWorkspace } from "./workspaces/route";

/*
 * The workspace routes (docs/design/workspaces.md §13.3, §13.8 test 4), the
 * way the owner's and a member's browsers use them. Each "browser" is one
 * member cookie.
 */

let stateDir = "";
const previousStateDir = process.env.LLV_STATE_DIR;
const W1 = `w_${"a".repeat(32)}`;
const W2 = `w_${"b".repeat(32)}`;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-workspace-routes-"));
  process.env.LLV_STATE_DIR = stateDir;
  resetTeamStoreForTests();
  replaceConversationCatalog([]);
});

afterEach(() => {
  resetTeamStoreForTests();
  process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function call(url: string, init: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}): NextRequest {
  return new NextRequest(`http://127.0.0.1:8898${url}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: {
      host: "127.0.0.1:8898",
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(init.cookie ? { cookie: `${MEMBER_COOKIE}=${init.cookie}` } : {}),
      ...(init.headers ?? {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

function cookieOf(response: NextResponse): string {
  const value = response.cookies.get(MEMBER_COOKIE)?.value;
  if (!value) throw new Error("the response set no member cookie");
  return value;
}

const params = <T,>(value: T) => ({ params: Promise.resolve(value) });

async function team(): Promise<{ owner: string; member: string }> {
  const owner = cookieOf(await claim(call("/api/team/claim", { body: { name: "Mira" } })));
  const invite = await (await createInvite(call("/api/team/invites", { body: { name: "Oleh" }, cookie: owner }))).json() as { url: string };
  const code = new URL(invite.url).pathname.split("/").pop()!;
  const member = cookieOf(await join(call(`/api/team/join/${code}`, { body: { name: "Oleh" } }), params({ code })));
  return { owner, member };
}

async function view(cookie?: string, query = ""): Promise<WorkspacesView & { mode: "team" }> {
  const response = await listWorkspaces(call(`/api/team/workspaces${query}`, { cookie }));
  expect(response.status).toBe(200);
  return await response.json() as WorkspacesView & { mode: "team" };
}

const create = (cookie: string | undefined, body: unknown, headers?: Record<string, string>) => createWorkspace(call("/api/team/workspaces", { body, cookie, headers }));
const patch = (cookie: string | undefined, id: string, body: unknown, headers?: Record<string, string>) => patchWorkspace(call(`/api/team/workspaces/${id}`, { method: "PATCH", body, cookie, headers }), params({ id }));
const remove = (cookie: string | undefined, id: string, headers?: Record<string, string>) => deleteWorkspace(call(`/api/team/workspaces/${id}`, { method: "DELETE", cookie, headers }), params({ id }));
const put = (cookie: string | undefined, body: unknown, headers?: Record<string, string>) => place(call("/api/team/workspace-projects", { method: "PUT", body, cookie, headers }));

describe("solo", () => {
  test("GET answers solo and creates no file", async () => {
    const response = await listWorkspaces(call("/api/team/workspaces?catalog=1"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ mode: "solo" });
    expect(fs.existsSync(path.join(stateDir, "team", "team.sqlite"))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, "team"))).toBe(false);
  });

  test("a write on a solo install is refused and creates no file", async () => {
    expect((await create(undefined, { id: W1, name: "A" })).status).toBe(401);
    expect((await put(undefined, { project: "repo-a", workspaceId: null })).status).toBe(401);
    expect(fs.existsSync(path.join(stateDir, "team", "team.sqlite"))).toBe(false);
  });
});

describe("the owner's round trip", () => {
  test("create with projects, rename, place, move, unassign, delete refused, empty, delete", async () => {
    const { owner, member } = await team();
    const created = await create(owner, { id: W1, name: "Client work", color: "teal", projects: ["repo-a"] });
    expect(created.status).toBe(201);
    expect((await created.json() as { workspace: Workspace }).workspace).toMatchObject({ id: W1, name: "Client work", color: "teal", projects: ["repo-a"] });
    /* A lost answer retried with its key answers the same workspace. */
    const replay = await create(owner, { id: W1, name: "Client work", color: "teal", projects: ["repo-a"] });
    expect(replay.status).toBe(200);
    expect((await create(owner, { id: W1, name: "Another" })).status).toBe(409);
    expect((await create(owner, { id: W2, name: "Research" })).status).toBe(201);

    const renamed = await patch(owner, W1, { name: "Clients" });
    expect(renamed.status).toBe(200);
    expect((await renamed.json() as { workspace: Workspace }).workspace.name).toBe("Clients");

    expect(await (await put(owner, { project: "repo-b", workspaceId: W1 })).json()).toEqual({ project: "repo-b", workspaceId: W1 });
    expect(await (await put(owner, { project: "repo-a", workspaceId: W2 })).json()).toEqual({ project: "repo-a", workspaceId: W2 });
    const both = await view(member);
    expect(both.canManage).toBe(false);
    expect(both.workspaces.map((workspace) => [workspace.name, workspace.projects])).toEqual([["Clients", ["repo-b"]], ["Research", ["repo-a"]]]);

    const refused = await remove(owner, W1);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "workspace_not_empty" });
    expect((await put(owner, { project: "repo-b", workspaceId: null })).status).toBe(200);
    expect(await (await remove(owner, W1)).json()).toEqual({ ok: true, deleted: true });
    expect(await (await remove(owner, W1)).json()).toEqual({ ok: true, deleted: false });
    const after = await view(owner);
    expect(after.canManage).toBe(true);
    expect(after.workspaces.map((workspace) => workspace.id)).toEqual([W2]);
  });

  test("a placement under an alias answers the canonical key", async () => {
    const { owner } = await team();
    await create(owner, { id: W1, name: "A" });
    expect(persistProjectAliases([{ source: "dir-a", target: "repo-b", displayName: "b" }])).toBe(true);
    expect(await (await put(owner, { project: "dir-a", workspaceId: W1 })).json()).toEqual({ project: "repo-b", workspaceId: W1 });
    expect((await view(owner)).workspaces[0]!.projects).toEqual(["repo-b"]);
  });
});

describe("who may write", () => {
  test("every write as a member is owner_required, signed out member_required, cross-origin refused", async () => {
    const { owner, member } = await team();
    await create(owner, { id: W1, name: "A" });
    const writes: Array<(cookie: string | undefined, headers?: Record<string, string>) => Promise<NextResponse>> = [
      (cookie, headers) => create(cookie, { id: W2, name: "B" }, headers),
      (cookie, headers) => patch(cookie, W1, { name: "Renamed" }, headers),
      (cookie, headers) => remove(cookie, W1, headers),
      (cookie, headers) => put(cookie, { project: "repo-a", workspaceId: W1 }, headers),
    ];
    for (const write of writes) {
      const asMember = await write(member);
      expect(asMember.status).toBe(403);
      expect(await asMember.json()).toMatchObject({ code: "owner_required" });
      const signedOut = await write(undefined);
      expect(signedOut.status).toBe(401);
      expect(await signedOut.json()).toMatchObject({ code: "member_required" });
      expect((await write(owner, { origin: "https://elsewhere.example" })).status).toBe(403);
      expect((await write(owner, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    }
    /* Nothing any refused write asked for happened. */
    const after = await view(owner);
    expect(after.workspaces.map((workspace) => [workspace.id, workspace.name, workspace.projects])).toEqual([[W1, "A", []]]);
    expect((await listWorkspaces(call("/api/team/workspaces"))).status).toBe(401);
  });
});

describe("refusals", () => {
  test("invalid ids, names, colours and projects are 400; an unknown workspace 404", async () => {
    const { owner } = await team();
    const code = async (response: Promise<NextResponse>) => {
      const answer = await response;
      return [answer.status, (await answer.json() as { code?: string }).code ?? null];
    };
    expect(await code(create(owner, { id: "w_1", name: "A" }))).toEqual([400, "invalid_id"]);
    expect(await code(create(owner, { name: "A" }))).toEqual([400, "invalid_id"]);
    expect(await code(create(owner, { id: W1, name: "" }))).toEqual([400, "name_required"]);
    expect(await code(create(owner, { id: W1, name: "x".repeat(41) }))).toEqual([400, "name_too_long"]);
    expect(await code(create(owner, { id: W1, name: "A", color: "black" }))).toEqual([400, "invalid_color"]);
    expect(await code(create(owner, { id: W1, name: "A", projects: "repo-a" }))).toEqual([400, "invalid_project"]);
    expect(await code(create(owner, { id: W1, name: "A", projects: ["__overview__"] }))).toEqual([400, "invalid_project"]);
    expect(await code(create(owner, { id: W1, name: "A" }))).toEqual([201, null]);
    expect(await code(create(owner, { id: W2, name: "a" }))).toEqual([409, "name_taken"]);
    for (const project of ["__overview__", "a\u0000b", "line\nbreak", "", 7]) {
      expect(await code(put(owner, { project, workspaceId: W1 }))).toEqual([400, "invalid_project"]);
    }
    expect(await code(put(owner, { project: "repo-a" }))).toEqual([400, "invalid_id"]);
    expect(await code(put(owner, { project: "repo-a", workspaceId: "nope" }))).toEqual([400, "invalid_id"]);
    expect(await code(put(owner, { project: "repo-a", workspaceId: W2 }))).toEqual([404, "workspace_gone"]);
    expect(await code(patch(owner, W2, { name: "Gone" }))).toEqual([404, "workspace_gone"]);
    expect(await code(patch(owner, "not-an-id", { name: "Gone" }))).toEqual([400, "invalid_id"]);
    expect(await code(patch(owner, W1, { color: "black" }))).toEqual([400, "invalid_color"]);
  });
});

describe("the catalog read", () => {
  const entry = (project: string, mtime: number, projectName?: string): ConversationCatalogEntry => ({
    path: `/transcripts/${project}-${mtime}.jsonl`, root: "claude" as ConversationCatalogEntry["root"], name: `${project}-${mtime}`, project, projectName,
    title: "t", firstPrompt: "p", engine: "claude", kind: "session", fmt: "claude" as ConversationCatalogEntry["fmt"], mtime, size: 1,
  });

  test("?catalog=1 reduces the catalog to one row per canonical key and adds manual projects", async () => {
    const { owner, member } = await team();
    expect((await view(member, "?catalog=1")).catalog).toEqual({ ready: true, projects: [] });
    expect(persistProjectAliases([{ source: "dir-a", target: "repo-b", displayName: "b" }])).toBe(true);
    replaceConversationCatalog([
      entry("dir-a", 100, "old name"),
      entry("repo-b", 300, "shop-backend"),
      entry("repo-b", 200),
      entry("repo-c", 50),
    ]);
    const scratch = path.join(stateDir, "scratch-notes");
    fs.mkdirSync(scratch);
    const manual = createManualProject("Scratch notes", scratch);
    if (!manual.ok) throw new Error(manual.message);
    const answer = await view(owner, "?catalog=1");
    expect(answer.catalog?.ready).toBe(true);
    expect(answer.catalog?.projects).toEqual([
      { project: manual.entry.project, displayName: "Scratch notes", smt: manual.entry.createdAt },
      { project: "repo-b", displayName: "shop-backend", smt: 300 },
      { project: "repo-c", displayName: "repo-c", smt: 50 },
    ]);
    /* Without the query, no catalog. */
    expect((await view(owner)).catalog).toBeUndefined();
  });
});
