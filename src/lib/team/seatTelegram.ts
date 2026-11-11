import { orchestratorSeatFor } from "@/lib/orchestrator/seats";
import { effectiveReportTelegram, projectReportDestinations } from "@/lib/projects/settings";
import { parseTelegramChatReference } from "@/lib/telegram/chatReference";
import type { TeamStore } from "./store";
import { readWorkspaceDefaults } from "./workspaceDefaultsRead";
import { workspaceDirectory } from "./workspaces";

export interface SeatTelegramChat { chatId: string; chat?: string | null; alias?: string | null; username?: string | null }

/**
 * A project's seat holds the Telegram grant for its project, whoever wrote to
 * it last. Under member reach that grant covers the project's own report
 * destination and every chat nobody else holds. It leaves out what a workspace
 * manager may not choose as a destination either: the owner's private chat,
 * another workspace's report and directive chats, and the report destination
 * of a project outside the seat's workspace. Null when the caller is not the
 * project's current seat or the seat holds no grant.
 */
export function seatTelegramChatAccess(conversationId: string | null, project: string | null, store: TeamStore,
  catalog: readonly SeatTelegramChat[]): ((reference: unknown) => boolean) | null {
  if (!conversationId || !project) return null;
  const seat = orchestratorSeatFor(project).active;
  if (!seat || seat.conversationId !== conversationId || seat.telegramGrant !== true) return null;
  const resolve = (reference: unknown): string | null => {
    const parsed = parseTelegramChatReference(reference)?.chat ?? (typeof reference === "string" ? reference.trim() : "");
    if (!parsed) return null;
    return catalog.find(chat => chat.chatId === parsed || chat.chat === parsed || chat.alias?.toLowerCase() === parsed.toLowerCase()
      || (parsed.startsWith("@") && chat.username?.toLowerCase() === parsed.slice(1).toLowerCase()))?.chatId ?? null;
  };
  const directory = workspaceDirectory(store);
  const own = directory.workspaceOf(project);
  if (!own) return null;
  const reserved = new Set<string | null>();
  for (const member of store.members()) if (member.role === "owner" && member.telegram?.userId) reserved.add(member.telegram.userId);
  for (const workspace of directory.workspaces) {
    if (workspace.id === own) continue;
    const defaults = readWorkspaceDefaults(store, workspace.id);
    for (const reference of [defaults.reportChat?.chat, ...defaults.directiveChats]) reserved.add(resolve(reference));
  }
  for (const destination of projectReportDestinations()) if (directory.workspaceOf(destination.project) !== own) reserved.add(resolve(destination.chat));
  const destination = resolve(effectiveReportTelegram(project)?.chat);
  return reference => {
    const chatId = resolve(reference);
    return chatId !== null && (chatId === destination || !reserved.has(chatId));
  };
}
