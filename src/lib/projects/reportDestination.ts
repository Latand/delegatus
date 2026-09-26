import { activeOrchestratorSeats, canonicalOrchestratorProject } from "@/lib/orchestrator/seats";
import { effectiveReportTelegram } from "@/lib/projects/settings";
import type { TelegramBotStatusPayload } from "@/lib/telegram/bot/contracts";
import { telegramBotService } from "@/lib/telegram/bot/service";

/*
 * The Viewer's side of the report destination
 * (docs/design/orchestrator-reports.md §5.6): which chats the connected bot
 * may post in, read from the bot service in this process, and what the bot
 * panel says about the projects whose reports go to each chat.
 */

/** The aliases of the chats an agent may post in: the bot is a member, and
    the operator switched "Agents may post" on. Empty with no bot. */
export function postableReportChats(chats: readonly { chat?: unknown; postAllowed?: unknown }[]): string[] {
  return chats.filter((entry) => entry.postAllowed === true && typeof entry.chat === "string").map((entry) => entry.chat as string);
}

export function viewerPostableReportChats(): string[] {
  try {
    return postableReportChats(telegramBotService().listChats().chats);
  } catch {
    return [];
  }
}

function seatProjects(): string[] {
  try {
    return [...new Set(activeOrchestratorSeats().map((seat) => canonicalOrchestratorProject(seat.project)))];
  } catch {
    return [];
  }
}

/**
 * The bot panel's status with each chat's reports: the name of every project
 * with a seat whose reports go there, and whether it goes there only because
 * it is the one chat agents may post in. Only seats file manager reports, so
 * a project without one is not listed.
 */
export function withReportDestinations(status: TelegramBotStatusPayload, projects: readonly string[] = seatProjects()): TelegramBotStatusPayload {
  if (!status.connected || status.chats.length === 0 || projects.length === 0) return status;
  const postable = status.chats.filter((chat) => chat.postable && chat.alias).map((chat) => chat.alias!);
  const destinations = projects.flatMap((project) => {
    try {
      const destination = effectiveReportTelegram(project, postable);
      return destination ? [destination] : [];
    } catch {
      return [];
    }
  });
  if (destinations.length === 0) return status;
  return {
    ...status,
    chats: status.chats.map((chat) => {
      const reports = destinations
        .filter((destination) => chat.postable && (destination.chat === chat.alias || destination.chat === chat.chatId))
        .map((destination) => ({ name: destination.name, onlyAllowedChat: destination.source === "only-allowed-chat" }));
      return reports.length ? { ...chat, reports } : chat;
    }),
  };
}
