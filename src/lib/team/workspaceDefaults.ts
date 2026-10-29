import { existingTeamStore, type TeamStore } from "./store";
import { workspaceDirectory } from "./workspaces";
import { requireWorkspaceManager } from "./workspaceAccess";
import { TeamError } from "./members";
import type { Member, TeamActor } from "./contract";
import { projectReportDestinations } from "@/lib/projects/settings";

export interface WorkspaceDefaults {
  accounts: { claude: string[]; codex: string[] };
  reportChat: { chat: string; name: string; topicId?: number } | null;
  directiveChats: string[];
}

export function parseWorkspaceDefaults(value: unknown): WorkspaceDefaults {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TeamError("invalid_defaults", "workspace defaults must be an object");
  const input = value as Record<string, unknown>;
  const strings = (items: unknown): string[] => {
    if (!Array.isArray(items) || items.length > 100 || items.some(item => typeof item !== "string" || !item.trim() || item.length > 200 || /[\u0000-\u001f]/.test(item)))
      throw new TeamError("invalid_defaults", "choose at most 100 bounded account or chat names");
    return [...new Set((items as string[]).map(item => item.trim()))].sort();
  };
  const accounts = input.accounts as Record<string, unknown> | undefined;
  if (accounts !== undefined && (!accounts || typeof accounts !== "object" || Array.isArray(accounts)))
    throw new TeamError("invalid_defaults", "account defaults must name engine pools");
  const report = input.reportChat as Record<string, unknown> | null | undefined;
  if (report != null && (typeof report !== "object" || Array.isArray(report) || typeof report.chat !== "string" || !report.chat.trim() || report.chat.length > 200
    || typeof report.name !== "string" || !report.name.trim() || report.name.length > 120
    || (report.topicId !== undefined && (!Number.isSafeInteger(report.topicId) || Number(report.topicId) <= 0))))
    throw new TeamError("invalid_defaults", "choose a report chat and report name");
  return {
    accounts: { claude: strings(accounts?.claude ?? []), codex: strings(accounts?.codex ?? []) },
    reportChat: report == null ? null : { chat: (report.chat as string).trim(), name: (report.name as string).trim(), ...(report.topicId === undefined ? {} : { topicId: report.topicId as number }) },
    directiveChats: strings(input.directiveChats ?? []),
  };
}

export function readWorkspaceDefaults(store: TeamStore, id: string): WorkspaceDefaults {
  const raw = store.workspaceDefaults(id);
  return parseWorkspaceDefaults(raw === undefined ? {} : raw);
}

function assertReportDestination(store: TeamStore, actor: Member, id: string, chatId: string | null, resolve: (reference: string) => string | undefined): void {
  requireWorkspaceManager(store, actor, id);
  if (chatId === null || store.member(actor.id)?.role === "owner") return;
  const directory = workspaceDirectory(store);
  const reserved = store.members().some(member => member.role === "owner" && member.telegram?.userId === chatId)
    || directory.workspaces.some(workspace => {
      if (workspace.id === id) return false;
      const defaults = readWorkspaceDefaults(store, workspace.id);
      return [defaults.reportChat?.chat ?? "", ...defaults.directiveChats].some(reference => resolve(reference) === chatId);
    })
    || projectReportDestinations().some(destination => directory.workspaceOf(destination.project) !== id && resolve(destination.chat) === chatId);
  if (reserved) throw new TeamError("chat_reserved", "that report chat belongs to another workspace or the installation", 403);
}

/** Explicit project choices obey the same destination fence as defaults.
 * Called after catalog/network waits, immediately before the settings write. */
export function assertProjectReportDestination(actor: TeamActor, project: string, chatId: string | null, resolve: (reference: string) => string | undefined): void {
  if (actor.kind !== "member") return;
  const store = existingTeamStore();
  const member = store?.member(actor.memberId);
  if (!store || member?.status !== "active") throw new TeamError("team_store_unavailable", "member authority is unavailable", 503);
  if (member.role === "owner") return;
  const id = workspaceDirectory(store).workspaceOf(project);
  if (!id) throw new TeamError("workspace_forbidden", "workspace access denied", 403);
  assertReportDestination(store, member, id, chatId, resolve);
}

export async function setWorkspaceDefaults(store: TeamStore, actor: Member, id: string, input: unknown): Promise<WorkspaceDefaults> {
  const value = parseWorkspaceDefaults(input);
  requireWorkspaceManager(store, actor, id);
  // Keep bot startup out of account/default reads. Only a report-chat write
  // needs its posting catalog; recheck membership after loading it.
  const chats = value.reportChat ? (await import("@/lib/telegram/bot/service")).telegramBotService().listChats().chats : [];
  return store.transaction(() => {
    requireWorkspaceManager(store, actor, id);
    if (value.reportChat) {
      const resolve = (reference: string) => chats.find(chat => chat.chat === reference || chat.chatId === reference || chat.alias?.toLowerCase() === reference.toLowerCase()
        || (reference.startsWith("@") && chat.username?.toLowerCase() === reference.slice(1).toLowerCase()));
      const chosen = resolve(value.reportChat.chat);
      if (!chosen?.postAllowed) throw new TeamError("chat_not_allowed", "choose a known chat where the bot may post", 409);
      assertReportDestination(store, actor, id, chosen.chatId, reference => resolve(reference)?.chatId);
      value.reportChat = { chat: chosen.alias ?? chosen.chat ?? chosen.chatId, name: value.reportChat.name,
        ...(chosen.isForum && value.reportChat.topicId ? { topicId: value.reportChat.topicId } : {}) };
    }
    store.putWorkspaceDefaults(id, value);
    return readWorkspaceDefaults(store, id);
  });
}

/** Read-through inheritance keeps aliases, newly placed projects and later edits
 * consistent without copying stale defaults over explicit project choices. */
export function workspaceDefaultsForProject(project: string | null | undefined): WorkspaceDefaults | null {
  const store = existingTeamStore();
  if (!store || !project) return null;
  const id = workspaceDirectory(store).workspaceOf(project);
  return id ? readWorkspaceDefaults(store, id) : null;
}
