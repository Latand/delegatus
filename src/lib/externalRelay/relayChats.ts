import type { FileEntry } from "@/lib/types";

/*
 * The relay's per-chat conversations (docs/design/relay-slice3.md §4) as the
 * operator's conversation list shows them. The scanner never lists them
 * (§4.6), so the operator reads them through the relay's own route and they
 * sit in the sidebar under the service's name, one row per chat and context.
 * Shared by the route and the browser; it imports nothing from Node.
 */

const PREFIX = "relay-chats-";

/** The sidebar entry of one paired relay service. Scanner keys start `repo-` or `dir-`, so none can collide. */
export const relayChatsProject = (relayId: string) => `${PREFIX}${relayId}`;
export const relayIdOfChatsProject = (project: string): string | null => project.startsWith(PREFIX) ? project.slice(PREFIX.length) || null : null;

export interface RelayChatRow {
  /** The conversation record's id (a UUID). */
  id: string;
  relayId: string;
  relayName: string;
  targetId: string;
  /** Null when the target has left the service's list since. */
  targetName: string | null;
  chatKey: string;
  /** Whose session this is: the members' of the chat, or its owner's. */
  context: "member" | "owner";
  engine: "claude" | "codex";
  turns: number;
  compactions: number;
  createdAt: string;
  lastTurnAt: string;
  state: "idle" | "running" | "broken";
  /** The transcript as a conversation entry; null until its first turn wrote one. */
  file: FileEntry | null;
}

export interface RelayChatsPayload {
  relays: { id: string; name: string; origin: string }[];
  chats: RelayChatRow[];
}

/** The short form of a chat key the rows print, enough to tell chats apart. */
export const shortChatKey = (key: string) => key.slice(0, 6);
