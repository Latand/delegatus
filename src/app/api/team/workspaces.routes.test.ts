import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest, type NextResponse } from "next/server";

import { persistProjectAliases } from "@/lib/projects/aliases";
import * as createByName from "@/lib/projects/createByName";
import { createManualProject, projectCurationSnapshot } from "@/lib/projects/curation";
import { replaceConversationCatalog, type ConversationCatalogEntry } from "@/lib/scanner/conversationCatalog";
import type { Workspace, WorkspacesView } from "@/lib/team/contract";
import { MEMBER_COOKIE, verifySessionValue } from "@/lib/team/sessions";
import { resetTeamStoreForTests, teamStore } from "@/lib/team/store";
import { workspaceScope } from "@/lib/team/workspaceAccess";
import { placeCreatedProject, placeProject, workspaceDirectory } from "@/lib/team/workspaces";
import { resetProjectDirectoryCacheForTests } from "@/lib/scanner/projectDirectories";
import { directoryProjectId } from "@/lib/projects/identity";
import { TeamError } from "@/lib/team/members";

import { POST as createProject } from "../projects/create/route";

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
    expect(both.workspaces).toEqual([]);

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
      expect(["owner_required", "workspace_forbidden"]).toContain((await asMember.json()).code);
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

/* Red on main: the gate decision was "owner" and the route had no workspace
   checks, so a member could not create at all and an owner's project could not be
   placed by the create request. */
describe("creating a project by name in a team", () => {
  const previousHome = process.env.HOME;
  let parent = "";
  let ownerCookie = "";
  let memberCookie = "";
  let ownerId = "";
  let memberId = "";

  beforeEach(async () => {
    const home = path.join(fs.realpathSync(stateDir), "home");
    fs.mkdirSync(home);
    process.env.HOME = home;
    parent = path.join(home, "Projects");
    resetProjectDirectoryCacheForTests();
    const people = await team();
    ownerCookie = people.owner;
    memberCookie = people.member;
    ownerId = verifySessionValue(teamStore(), ownerCookie)!.member.id;
    memberId = verifySessionValue(teamStore(), memberCookie)!.member.id;
    expect((await create(ownerCookie, { id: W1, name: "Clients" })).status).toBe(201);
    expect((await create(ownerCookie, { id: W2, name: "Research" })).status).toBe(201);
  });

  afterEach(() => {
    process.env.HOME = previousHome;
    resetProjectDirectoryCacheForTests();
  });

  const join = (role: "manager" | "member" = "member", workspaceId = W1) => teamStore().putWorkspaceMember(workspaceId, memberId, role, ownerId, new Date().toISOString());
  const post = (cookie: string | undefined, body: unknown, headers?: Record<string, string>) => createProject(call("/api/projects/create", { body, cookie, headers }));
  const placedIn = (project: unknown) => workspaceDirectory(teamStore()).workspaceOf(project as string);
  const nothingCreated = () => {
    expect(fs.existsSync(parent)).toBe(false);
    expect(projectCurationSnapshot().manualProjects).toEqual([]);
  };

  test.each(["member", "manager"] as const)("a %s creates by name and the project lands in their workspace", async (role) => {
    join(role);
    const response = await post(memberCookie, { name: "PR GRAM", workspaceId: W1 });
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, displayName: "PR GRAM", root: path.join(parent, "pr-gram"), workspaceId: W1 });
    expect(placedIn(body.project)).toBe(W1);
    expect(workspaceScope(teamStore(), memberId).canAct(body.project as string)).toBe(true);
    expect(fs.statSync(path.join(parent, "pr-gram")).isDirectory()).toBe(true);
  });

  test.each([
    ["an existing folder", (root: string) => ({ name: "Bound", root, workspaceId: W1 })],
    ["a missing folder to create", (root: string) => ({ name: "Bound", root: path.join(root, "new"), createRoot: true, workspaceId: W1 })],
    ["an empty root", () => ({ name: "Bound", root: "", workspaceId: W1 })],
    ["a root that is not a string", () => ({ name: "Bound", root: 5, workspaceId: W1 })],
  ])("a member naming %s is refused and nothing is created", async (_label, body) => {
    join();
    const existing = path.join(process.env.HOME!, ".config");
    fs.mkdirSync(existing);
    const response = await post(memberCookie, body(existing));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "workspace_forbidden" });
    nothingCreated();
    expect(fs.readdirSync(existing)).toEqual([]);
  });

  test.each([
    ["no workspace", { name: "Lost" }],
    ["a null workspace", { name: "Lost", workspaceId: null }],
    ["a workspace they do not belong to", { name: "Lost", workspaceId: W2 }],
    ["a workspace that does not exist", { name: "Lost", workspaceId: `w_${"c".repeat(32)}` }],
    ["a malformed workspace", { name: "Lost", workspaceId: "../W1" }],
    ["a workspace that is not a string", { name: "Lost", workspaceId: [W1] }],
  ])("a member with %s is refused and nothing is created", async (_label, body) => {
    join();
    const response = await post(memberCookie, body);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "workspace_forbidden" });
    nothingCreated();
  });

  test("a member of no workspace passes the gate and is refused here", async () => {
    expect((await post(memberCookie, { name: "Lost", workspaceId: W1 })).status).toBe(403);
    expect((await post(memberCookie, { name: "Lost" })).status).toBe(403);
    nothingCreated();
  });

  test("the owner with a workspace gets the project placed there, without one it is Unassigned", async () => {
    const placed = await (await post(ownerCookie, { name: "Placed", workspaceId: W2 })).json() as Record<string, unknown>;
    expect(placed.workspaceId).toBe(W2);
    expect(placedIn(placed.project)).toBe(W2);
    const loose = await (await post(ownerCookie, { name: "Loose" })).json() as Record<string, unknown>;
    expect(loose.workspaceId).toBeNull();
    expect(placedIn(loose.project)).toBeNull();
  });

  test("the owner keeps the existing-folder flow, placed in the workspace they name", async () => {
    const folder = path.join(process.env.HOME!, "existing");
    fs.mkdirSync(folder);
    const answer = await post(ownerCookie, { name: "Existing", root: folder, workspaceId: W1 });
    expect(answer.status).toBe(200);
    const body = await answer.json() as Record<string, unknown>;
    expect(body).toMatchObject({ root: folder, workspaceId: W1 });
    expect(placedIn(body.project)).toBe(W1);
  });

  test("the owner naming a workspace that does not exist creates nothing", async () => {
    expect((await post(ownerCookie, { name: "Nowhere", workspaceId: `w_${"c".repeat(32)}` })).status).toBe(403);
    nothingCreated();
  });

  test("a project in the member's workspace with the same name answers 409 with its key", async () => {
    join();
    const first = await (await post(memberCookie, { name: "Shared", workspaceId: W1 })).json() as Record<string, unknown>;
    const second = await post(memberCookie, { name: "shared", workspaceId: W1 });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: "DUPLICATE_NAME", project: first.project, root: path.join(parent, "shared") });
  });

  test("a name outside the member's scope says nothing about that project", async () => {
    join();
    const foreign = await (await post(ownerCookie, { name: "Secret", workspaceId: W2 })).json() as Record<string, unknown>;
    const response = await post(memberCookie, { name: "Secret", workspaceId: W1 });
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.project).not.toBe(foreign.project);
    expect(body.root).toBe(path.join(parent, "secret-2"));
    expect(placedIn(foreign.project)).toBe(W2);
    expect(placedIn(body.project)).toBe(W1);
  });

  test("the key of a deleted folder still placed elsewhere costs a suffix and is not moved", async () => {
    join();
    const stale = directoryProjectId(path.join(parent, "reused"));
    expect((await put(ownerCookie, { project: stale, workspaceId: W2 })).status).toBe(200);
    const response = await post(memberCookie, { name: "Reused", workspaceId: W1 });
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.root).toBe(path.join(parent, "reused-2"));
    expect(placedIn(stale)).toBe(W2);
    expect(placedIn(body.project)).toBe(W1);
  });

  test("a role lost between creation and placement answers 403 and the project stays Unassigned", async () => {
    join();
    const real = createByName.createProjectByName;
    const racing = spyOn(createByName, "createProjectByName").mockImplementation((name, options) => {
      const result = real(name, options);
      teamStore().removeWorkspaceMember(W1, memberId);
      return result;
    });
    try {
      const response = await post(memberCookie, { name: "Raced", workspaceId: W1 });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "workspace_forbidden" });
    } finally {
      racing.mockRestore();
    }
    const [row] = projectCurationSnapshot().manualProjects;
    expect(row).toMatchObject({ displayName: "Raced", root: path.join(parent, "raced") });
    expect(placedIn(row!.project)).toBeNull();
    expect(workspaceScope(teamStore(), ownerId).canAct(row!.project)).toBe(true);
  });

  test("a session revoked while the body is read admits nothing", async () => {
    join();
    const request = call("/api/projects/create", { body: { name: "Revoked", workspaceId: W1 }, cookie: memberCookie });
    const readBody = request.json.bind(request);
    request.json = async () => {
      const body = await readBody();
      teamStore().removeWorkspaceMember(W1, memberId);
      return body;
    };
    expect((await createProject(request)).status).toBe(403);
    nothingCreated();
  });

  test("the access key alone names no member, so it is asked to sign in", async () => {
    const previous = process.env.LLV_TOKEN;
    process.env.LLV_TOKEN = "fixture-access-key";
    try {
      const response = await post(undefined, { name: "Keyed" }, { cookie: "llv_auth=fixture-access-key" });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: "member_required" });
      nothingCreated();
    } finally {
      if (previous === undefined) delete process.env.LLV_TOKEN; else process.env.LLV_TOKEN = previous;
    }
  });

  test("a signed-out or cross-origin request creates nothing", async () => {
    expect((await post(undefined, { name: "Nobody" })).status).toBe(403);
    expect((await post(memberCookie, { name: "Foreign", workspaceId: W1 }, { origin: "https://elsewhere.invalid" })).status).toBe(403);
    nothingCreated();
  });

  describe("placeCreatedProject", () => {
    const member = () => verifySessionValue(teamStore(), memberCookie)!.member;
    const code = (run: () => unknown): string | null => {
      try { run(); return null; }
      catch (error) { return error instanceof TeamError ? error.code : "not a TeamError"; }
    };

    test("places a project with no placement, for a member and a manager of the workspace", () => {
      join("member");
      expect(placeCreatedProject(teamStore(), member(), "dir-fresh", W1)).toEqual({ project: "dir-fresh", workspaceId: W1 });
      expect(placedIn("dir-fresh")).toBe(W1);
      join("manager");
      expect(placeCreatedProject(teamStore(), member(), "dir-fresher", W1).workspaceId).toBe(W1);
    });

    test("refuses a project that already has a placement, so it can never move one", () => {
      join("manager");
      join("manager", W2);
      placeProject(teamStore(), teamStore().member(ownerId)!, "repo-placed", W2);
      expect(code(() => placeCreatedProject(teamStore(), member(), "repo-placed", W1))).toBe("workspace_forbidden");
      expect(placedIn("repo-placed")).toBe(W2);
      /* The owner too: this call is for new projects, and Move to… is another. */
      expect(code(() => placeCreatedProject(teamStore(), teamStore().member(ownerId)!, "repo-placed", W1))).toBe("workspace_forbidden");
    });

    test("refuses a placement held under an alias of the key", () => {
      join();
      placeProject(teamStore(), teamStore().member(ownerId)!, "repo-old", W2);
      expect(persistProjectAliases([{ source: "repo-old", target: "repo-new", displayName: "New" }])).toBe(true);
      expect(code(() => placeCreatedProject(teamStore(), member(), "repo-new", W1))).toBe("workspace_forbidden");
    });

    test("refuses a caller outside the workspace, a revoked caller and a deleted workspace", () => {
      expect(code(() => placeCreatedProject(teamStore(), member(), "dir-a", W1))).toBe("workspace_forbidden");
      join();
      expect(code(() => placeCreatedProject(teamStore(), member(), "dir-a", W2))).toBe("workspace_forbidden");
      const owner = teamStore().member(ownerId)!;
      expect(code(() => placeCreatedProject(teamStore(), owner, "dir-a", `w_${"c".repeat(32)}`))).toBe("workspace_gone");
      expect(code(() => placeCreatedProject(teamStore(), owner, "dir-a", "not-an-id"))).toBe("invalid_id");
      const held = member();
      teamStore().updateMember({ ...held, status: "revoked", revokedAt: new Date().toISOString() });
      expect(code(() => placeCreatedProject(teamStore(), held, "dir-a", W1))).toBe("workspace_forbidden");
      expect(placedIn("dir-a")).toBeNull();
    });
  });
});
