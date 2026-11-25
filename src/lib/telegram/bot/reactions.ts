import { z } from "zod";

/** Telegram Bot API ReactionType. Paid entries can appear in the chat catalog. */
export const telegramReactionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("emoji"), emoji: z.string().min(1).max(32) }),
  z.object({ type: z.literal("custom_emoji"), custom_emoji_id: z.string().regex(/^\d{1,20}$/) }),
  z.object({ type: z.literal("paid") }),
]);

type TelegramReaction = z.infer<typeof telegramReactionSchema>;
export type TelegramReactionCatalog = { kind: "standard" } | { kind: "explicit"; reactions: TelegramReaction[] };

export const telegramReactionCatalogSchema = z.array(telegramReactionSchema);
export const telegramReactionMessageIdSchema = z.number().int().min(1).max(2147483647);
