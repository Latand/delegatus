import type { RegistryConversation } from "@/lib/agent/registry";
import { activeOrchestratorSeats, seatWorkspaceFromMessage } from "@/lib/orchestrator/seats";
import { effectiveReportTelegram, projectReportDestinations } from "@/lib/projects/settings";
import { parseTelegramChatReference } from "@/lib/telegram/chatReference";
import type { TeamStore } from "./store";
import { readWorkspaceDefaults } from "./workspaceDefaultsRead";
import { conversationWorkspaceReach, memberWorkspacePrincipal, workspacePrincipalAllows } from "./workspacePrincipal";
import { workspaceDirectory } from "./workspaces";

export interface TelegramCatalogChat { chatId: string; chat?: string | null; alias?: string | null; username?: string | null }

/** What one caller may do with the Telegram bot. `installation` is a caller
    with no workspace fence; `seat` is a fenced seat using its own grant. */
export type TelegramAgentAccess = { kind: "installation" } | { kind: "refused" }
  | { kind: "seat"; send(reference: unknown): boolean; read(reference: unknown): boolean };

/**
 * One judgement for every path to the bot: the agent route asks it for each
 * request, and the MCP fence asks it before it dispatches.
 *
 * A caller under member reach is refused, with one exception: a project's
 * current seat that holds the Telegram grant and that no person designated for
 * a member. Its grant belongs to the project, so it stays usable while a
 * member's message fences the seat, for the chats the seat's workspace holds:
 * the project's effective report destination, the workspace's report and
 * directive chats, and the report destinations of the workspace's projects.
 * Nothing else is admitted. A held chat that is also the owner's private chat,
 * or that another workspace or a project outside this workspace holds as well,
 * takes posts and gives no history.
 */
export function telegramAgentAccess(conversationId: string | null, store: TeamStore | null,
  lookup: (id: string) => RegistryConversation | null, catalog: () => readonly TelegramCatalogChat[]): TelegramAgentAccess {
  const reach = conversationWorkspaceReach(lookup, conversationId, store);
  if (!reach.principal) return { kind: "installation" };
  if (!store) return { kind: "refused" };
  const seat = activeOrchestratorSeats().find(candidate => candidate.conversationId === conversationId);
  if (!seat || seat.telegramGrant !== true || (seat.workspace && !seatWorkspaceFromMessage(seat))) return { kind: "refused" };
  const principal = memberWorkspacePrincipal(store, reach.principal.memberId, seat.project);
  const directory = workspaceDirectory(store);
  const own = directory.workspaceOf(seat.project);
  if (!principal || !own || !workspacePrincipalAllows(principal, seat.project, store)) return { kind: "refused" };
  const chats = catalog();
  const resolve = (reference: unknown): string | null => {
    const parsed = parseTelegramChatReference(reference)?.chat ?? (typeof reference === "string" ? reference.trim() : "");
    if (!parsed) return null;
    return chats.find(chat => chat.chatId === parsed || chat.chat === parsed || chat.alias?.toLowerCase() === parsed.toLowerCase()
      || (parsed.startsWith("@") && chat.username?.toLowerCase() === parsed.slice(1).toLowerCase()))?.chatId ?? null;
  };
  const held = new Set<string>(), shared = new Set<string>();
  const hold = (reference: unknown, mine: boolean) => { const chatId = resolve(reference); if (chatId) (mine ? held : shared).add(chatId); };
  for (const member of store.members()) if (member.role === "owner" && member.telegram?.userId) shared.add(member.telegram.userId);
  for (const workspace of directory.workspaces) {
    const defaults = readWorkspaceDefaults(store, workspace.id);
    for (const reference of [defaults.reportChat?.chat, ...defaults.directiveChats]) hold(reference, workspace.id === own);
  }
  for (const destination of projectReportDestinations()) hold(destination.chat, directory.workspaceOf(destination.project) === own);
  hold(effectiveReportTelegram(seat.project)?.chat, true);
  return {
    kind: "seat",
    send: reference => { const chatId = resolve(reference); return chatId !== null && held.has(chatId); },
    read: reference => { const chatId = resolve(reference); return chatId !== null && held.has(chatId) && !shared.has(chatId); },
  };
}

/** The production reading: the live registry, team store and bot catalog. Only
    chats the bot is in now resolve, so an inactive chat is never admitted. */
export async function productionTelegramAgentAccess(conversationId: string | null): Promise<TelegramAgentAccess> {
  const [{ agentRegistry }, { existingTeamStore }, { telegramBotService }] = await Promise.all([
    import("@/lib/agent/registry"), import("./store"), import("@/lib/telegram/bot/service")]);
  return telegramAgentAccess(conversationId, existingTeamStore(), id => agentRegistry().conversation(id as `conversation_${string}`),
    () => telegramBotService().listChats().chats);
}
