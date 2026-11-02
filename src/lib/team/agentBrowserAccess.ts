import fs from "node:fs";
import path from "node:path";

import { homeDirectory } from "@/lib/platformHome";
import { appendTeamEvent } from "./events";
import { TeamError } from "./members";
import { MEMBER_COOKIE, sessionIsLive, sha256Hex } from "./sessions";
import { existingTeamStore, type TeamStore } from "./store";
import { requestWorkspaceOptions, workspaceDirectory } from "./workspaces";

export interface AgentBrowserSeat {
  conversationId: string;
  project: string;
}

/** The existing Playwright login is the identity authority. Names are mutable;
 * caller-supplied member ids and browser state paths cannot select a member. */
async function browserCookie() {
  let value: string | undefined;
  try {
    const filename = path.join(homeDirectory(), ".local/share/delegatus-agent-login/state.json");
    const descriptor = await fs.promises.open(filename, "r");
    try {
      const stat = await descriptor.stat();
      if (!stat.isFile() || stat.size > 65_536) throw new Error("invalid login store");
      const buffer = Buffer.alloc(65_537);
      const { bytesRead } = await descriptor.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 65_536) throw new Error("invalid login store");
      const state: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
      const cookies = (state as { cookies?: unknown } | null)?.cookies;
      if (!Array.isArray(cookies)) throw new Error("missing cookies");
      const matches = cookies.filter(cookie => cookie?.name === MEMBER_COOKIE
        && cookie.domain === "127.0.0.1" && cookie.path === "/");
      if (matches.length === 1 && typeof matches[0].value === "string") value = matches[0].value;
    } finally { await descriptor.close(); }
  } catch {
    // Withhold parser and filesystem errors: either can carry the login secret.
    throw new TeamError("agent_browser_login_unavailable", "the saved agent browser login is unavailable", 409);
  }
  return value;
}

function browserMember(store: TeamStore, value: string | undefined) {
  const session = value && /^[A-Za-z0-9_-]{43}$/.test(value) ? store.session(sha256Hex(value)) : null;
  const member = session && sessionIsLive(session, Date.now()) ? store.member(session.memberId) : null;
  if (!member || member.status !== "active" || member.role !== "member") {
    throw new TeamError("agent_browser_login_unavailable", "the saved agent browser login must name an active ordinary member with a live session", 409);
  }
  return member;
}

function target(store: TeamStore, input: Record<string, unknown>, seat: AgentBrowserSeat, value: string | undefined) {
  if (input.role !== undefined && input.role !== "member") {
    throw new TeamError("agent_browser_role_refused", "agent browser access grants only the member role", 403);
  }
  const member = browserMember(store, value);
  if (input.memberId !== undefined && input.memberId !== member.id) {
    throw new TeamError("agent_browser_member_refused", "only the member identified by the saved agent browser login may be placed", 403);
  }
  const options = requestWorkspaceOptions();
  const project = options.resolve!(seat.project);
  const workspaceId = workspaceDirectory(store, options).workspaceOf(project);
  if (!workspaceId || (input.workspaceId !== undefined && input.workspaceId !== workspaceId)) {
    throw new TeamError("agent_browser_workspace_refused", "choose only the workspace holding the calling seat's project; an unassigned project has no workspace", 403);
  }
  return { member, project, workspaceId };
}

/** Both receipt replay and dispatch re-read authority, session and placement.
 * The write and its audit share one transaction; a failed audit rolls it back. */
export async function agentBrowserAccess(
  input: Record<string, unknown>,
  requireSeat: () => AgentBrowserSeat,
  write: boolean,
) {
  const store = existingTeamStore();
  if (!store?.hasActiveOwner()) throw new TeamError("agent_browser_team_required", "agent browser workspace access requires team mode", 409);
  requireSeat();
  const value = await browserCookie();
  return store.transaction(() => {
    const seat = requireSeat();
    const { member, project, workspaceId } = target(store, input, seat, value);
    const held = store.workspaceMemberships(member.id).find(row => row.workspaceId === workspaceId);
    const changed = held?.role !== "member";
    if (write && changed) {
      const now = Date.now();
      store.putWorkspaceMember(workspaceId, member.id, "member", seat.conversationId, new Date(now).toISOString());
      appendTeamEvent(store, {
        actor: { kind: "agent", conversationId: seat.conversationId },
        action: "member.joined",
        project,
        subject: { kind: "member", id: member.id, title: null },
        detail: { workspaceId, role: "member", authority: "operator", source: "agent-browser-access" },
      }, now);
    }
    return { memberId: member.id, project, workspaceId, role: "member", changed };
  });
}
