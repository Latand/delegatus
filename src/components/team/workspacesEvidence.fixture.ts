import type { MemberColor, TeamView, WorkspaceCatalogProject, WorkspacesView } from "@/lib/team/contract";

import { createdLocally, deletedLocally, placedLocally, updatedLocally, type TeamWorkspaces } from "./workspaceFilter";
import { workspaceNameProblem } from "./workspacesClient";

/*
 * The team and workspace routes as the evidence fixtures answer them in the
 * page (docs/design/workspaces.md §13.9): an owner and a member, workspaces
 * placed over the fixture's own projects, and the writes the pages make, so
 * every state the drivers frame is reached through the real controls. The
 * names are invented.
 */

export interface WorkspacesFixtureOptions {
  uk: boolean;
  /** Signed in as the member rather than the owner. */
  member: boolean;
  manager?: boolean;
  refuseMembership?: boolean;
  refuseInvite?: boolean;
  failMembershipReadOnce?: boolean;
  projects: WorkspaceCatalogProject[];
  /** Each workspace's projects, in the order the fixture names them. */
  placed: { client: string[]; research: string[]; long: string[] };
  /** Starts with no workspace at all: the team's UI is today's. */
  empty?: boolean;
}

export const FIXTURE_WORKSPACE_IDS = {
  client: `w_${"c1".repeat(16)}`,
  research: `w_${"d2".repeat(16)}`,
  long: `w_${"e3".repeat(16)}`,
} as const;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function workspacesFixture(options: WorkspacesFixtureOptions) {
  const L = (en: string, uk: string) => (options.uk ? uk : en);
  const owner = { id: "m_owner", name: L("Mira Koval", "Міра Коваль"), color: "coral" as MemberColor, initials: "MK", role: "owner" as const, status: "active" as const };
  const member = { id: "m_member", name: L("Oleh Marchenko", "Олег Марченко"), color: "sky" as MemberColor, initials: "OM", role: "member" as const, status: "active" as const };
  const me = options.member || options.manager ? member : owner;
  const unplaced = { ...member, id: "m_unplaced", name: L("Team member", "Учасник команди") };
  const team: TeamView = {
    mode: "team",
    me: { ...me, telegram: null },
    members: [owner, member, unplaced].map((person) => ({
      ...person, telegram: null, passkeys: 0, lastSeenAt: "2026-10-20T09:00:00.000Z", lastSurface: "desktop" as const,
      online: person.id === me.id, createdAt: "2026-10-01T09:00:00.000Z", revokedAt: null,
    })),
    methods: { approval: true, telegram: { available: false, botUsername: null }, passkey: { available: false } },
  };
  let view: TeamWorkspaces = {
    mode: "team",
    canManage: !options.member && !options.manager,
    managedWorkspaceIds: options.manager ? [FIXTURE_WORKSPACE_IDS.client] : options.member ? [] : Object.values(FIXTURE_WORKSPACE_IDS),
    workspaces: options.empty ? [] : [
      { id: FIXTURE_WORKSPACE_IDS.client, name: L("Client work", "Клієнтська робота"), color: "teal", createdAt: "2026-10-20T08:00:00.000Z", projects: [...options.placed.client].sort() },
      { id: FIXTURE_WORKSPACE_IDS.research, name: L("Research", "Дослідження"), color: "violet", createdAt: "2026-10-20T08:01:00.000Z", projects: [...options.placed.research].sort() },
      /* Forty characters, the longest a name may be, for the chip's truncation. */
      { id: FIXTURE_WORKSPACE_IDS.long, name: L("Northwind customer data platform rollout", "Впровадження платформи даних Northwind"), color: "amber", createdAt: "2026-10-20T08:02:00.000Z", projects: [...options.placed.long].sort() },
    ],
  };
  if (!options.empty) view = { ...view, workspaces: [...view.workspaces].sort((a, b) => a.name.localeCompare(b.name, options.uk ? "uk" : "en")) };
  const refuse = (code: string, status: number) => json({ error: code, code }, status);
  const memberships = new Map<string, Map<string, "member" | "manager">>();
  memberships.set(FIXTURE_WORKSPACE_IDS.client, new Map(options.member || options.manager ? [[member.id, options.manager ? "manager" : "member"]] : []));
  const invites: { id: string; invitedName: string; expiresAt: string; workspaceId: string | null }[] = [];
  let failedMembershipRead = false;

  /** The answer for a team route, or null for any other path. */
  async function answer(url: URL, init?: RequestInit): Promise<Response | null> {
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (url.pathname === "/api/team") return json(team);
    if (url.pathname === "/api/team/invites") {
      if (method === "GET") return json({ invites, requests: [] });
      if (options.refuseInvite) return refuse("workspace_forbidden", 403);
      if (options.member || (options.manager && body.workspaceId !== FIXTURE_WORKSPACE_IDS.client)) return refuse("workspace_forbidden", 403);
      const invite = { id: `invite-${invites.length + 1}`, invitedName: String(body.name ?? ""), expiresAt: "2026-11-01T09:00:00.000Z", workspaceId: typeof body.workspaceId === "string" ? body.workspaceId : null };
      invites.push(invite);
      return json({ ...invite, url: `https://delegatus.example/team/join/${invite.workspaceId ?? "team"}` });
    }
    const membership = /^\/api\/team\/workspaces\/([^/]+)\/members$/.exec(url.pathname);
    if (membership) {
      if (method === "GET" && options.failMembershipReadOnce && !failedMembershipRead) {
        failedMembershipRead = true;
        return refuse("unavailable", 503);
      }
      const id = membership[1]!;
      const held = memberships.get(id) ?? new Map<string, "member" | "manager">();
      memberships.set(id, held);
      const canManage = view.canManage || (options.manager && id === FIXTURE_WORKSPACE_IDS.client);
      if (method !== "GET") {
        if (!canManage || options.refuseMembership) return refuse("workspace_forbidden", 403);
        if (method === "DELETE") held.delete(String(body.memberId));
        else held.set(String(body.memberId), body.role as "member" | "manager");
        return json({ ok: true });
      }
      const people = team.members.map(person => ({ id: person.id, name: person.name, owner: person.role === "owner", role: held.get(person.id) ?? null }));
      return json({ canManage, members: people.filter(person => person.owner || person.role), candidates: canManage ? people.filter(person => !person.owner && !person.role) : [] });
    }
    if (url.pathname === "/api/team/workspaces" && method === "GET") {
      const shown: WorkspacesView = url.searchParams.get("catalog") === "1" ? { ...view, catalog: { ready: true, projects: options.projects } } : view;
      return json(shown);
    }
    if (url.pathname === "/api/team/workspaces" && method === "POST") {
      if (options.member) return refuse("owner_required", 403);
      const name = String(body.name ?? "");
      const problem = workspaceNameProblem(view, name);
      if (problem) return refuse(problem, problem === "name_taken" ? 409 : 400);
      view = createdLocally(view, { id: String(body.id), name: name.trim(), color: (body.color as MemberColor) ?? "slate", projects: (body.projects as string[]) ?? [], createdAt: "2026-10-20T10:00:00.000Z" });
      return json({ workspace: view.workspaces.find((workspace) => workspace.id === body.id) }, 201);
    }
    const one = /^\/api\/team\/workspaces\/([^/]+)$/.exec(url.pathname);
    if (one) {
      if (options.member) return refuse("owner_required", 403);
      const id = decodeURIComponent(one[1]!);
      const held = view.workspaces.find((workspace) => workspace.id === id);
      if (method === "DELETE") {
        if (!held) return json({ ok: true, deleted: false });
        if (held.projects.length) return refuse("workspace_not_empty", 409);
        view = deletedLocally(view, id);
        return json({ ok: true, deleted: true });
      }
      if (!held) return refuse("workspace_gone", 404);
      if (typeof body.name === "string") {
        const problem = workspaceNameProblem(view, body.name, id);
        if (problem) return refuse(problem, problem === "name_taken" ? 409 : 400);
      }
      view = updatedLocally(view, id, { ...(typeof body.name === "string" ? { name: body.name.trim() } : {}), ...(body.color ? { color: body.color as MemberColor } : {}) });
      return json({ workspace: view.workspaces.find((workspace) => workspace.id === id) });
    }
    if (url.pathname === "/api/team/workspace-projects" && method === "PUT") {
      if (options.member) return refuse("owner_required", 403);
      const target = body.workspaceId as string | null;
      if (target && !view.workspaces.some((workspace) => workspace.id === target)) return refuse("workspace_gone", 404);
      view = placedLocally(view, String(body.project), target);
      return json({ project: body.project, workspaceId: target });
    }
    return null;
  }

  return { answer, view: () => view };
}
