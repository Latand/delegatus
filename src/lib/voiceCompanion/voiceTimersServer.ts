import { viewerReleaseOwnsTraffic } from "@/lib/viewerReleaseTraffic";
import { operatorTimeZone } from "@/lib/operator/settings";
import { existingTeamStore } from "@/lib/team/store";
import { CompanionStorage, type SessionStarter } from "./storage";
import { VoiceTimers, type TelegramOutcome, type VoiceTimerPorts } from "./voiceTimers";

/* The production side of voice timers. The route bundle and the instrumentation bundle load this module apart, so the
   one instance, like the voice sessions it asks about, lives on `globalThis`. */

const globals = globalThis as typeof globalThis & {
  __delegatusVoiceTimers?: VoiceTimers;
  __delegatusVoiceSessions?: { liveCall(owner: SessionStarter): boolean };
};

/** Telegram's answer for one timer. The send's own key makes a repeat safe: an earlier send it cannot account for
 * answers `send_uncertain` and nothing goes out again. */
export async function sendVoiceTimerToTelegram(message: { id: string; text: string }, ports: {
  destination(): { chatId?: string };
  send(input: { conversationId: null; clientRequestId: string; chat: string; text: string }): Promise<unknown>;
  errorCode(error: unknown): string | null;
}): Promise<TelegramOutcome> {
  const chat = ports.destination().chatId;
  if (!chat) return "none";
  try {
    await ports.send({ conversationId: null, clientRequestId: `voice-timer:${message.id}`, chat, text: message.text });
    return "sent";
  } catch (error) {
    const code = ports.errorCode(error);
    if (code === "send_uncertain" || code === "send_partial") return "uncertain";
    // The operator's chat cannot take posts: the bot is not connected there, or posting is off. Asking again changes nothing.
    if (code === "bot_not_connected" || code === "chat_not_allowed" || code === "bot_not_in_chat" || code === "chat_not_found") return "none";
    return "failed";
  }
}

export function productionVoiceTimerPorts(): VoiceTimerPorts {
  return {
    now: Date.now,
    schedule(wake, delayMs) {
      const timer = setTimeout(wake, delayMs);
      (timer as { unref?(): void }).unref?.();
      return { cancel: () => clearTimeout(timer) };
    },
    ownsTraffic: () => viewerReleaseOwnsTraffic(),
    liveCall: owner => globals.__delegatusVoiceSessions?.liveCall(owner) ?? false,
    // Push subscriptions and the paired Telegram chat are the installation's; in a team, its active owner is the operator.
    isOperator(owner) {
      if ("operator" in owner) return true;
      const member = existingTeamStore()?.member(owner.memberId);
      return member?.role === "owner" && member.status === "active";
    },
    telegramChosen: () => new CompanionStorage().read().settings.timerTelegram === true,
    timeZone: operatorTimeZone,
    async push(message) {
      const { notifyVoiceTimer } = await import("@/lib/push");
      return notifyVoiceTimer(message);
    },
    async telegram(message) {
      const [{ telegramBotService, TelegramBotError }, { ownerReviewDestination }] = await Promise.all([import("@/lib/telegram/bot/service"), import("@/lib/externalRelay/telegramPublication")]);
      return sendVoiceTimerToTelegram(message, { destination: ownerReviewDestination, send: input => telegramBotService().send(input),
        errorCode: error => error instanceof TelegramBotError ? error.code : null });
    },
    async forgetPush(id) {
      const { retireVoiceTimerPush } = await import("@/lib/push");
      await retireVoiceTimerPush(id);
    },
  };
}

export const voiceTimers = (): VoiceTimers => globals.__delegatusVoiceTimers ??= new VoiceTimers(productionVoiceTimerPorts());
/** At Viewer boot: reads the pending rows and arms the wake. */
export function startVoiceTimers(): void { voiceTimers().start(); }
export function setVoiceTimersForTests(value: VoiceTimers | undefined): void { globals.__delegatusVoiceTimers = value; }
