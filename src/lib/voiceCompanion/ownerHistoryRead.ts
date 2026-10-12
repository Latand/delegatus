import { readOwnerHistory, type OwnerHistoryRead } from "@/lib/externalRelay/ownerHistory";

/** Only the backend receives the page; speech is safe for the call record and events. */
export async function ownerHistoryRead(args: Record<string, unknown>, read: OwnerHistoryRead = readOwnerHistory) {
  const outcome = await read(Object.fromEntries(Object.entries(args).filter(([, value]) => value !== null && value !== undefined)));
  if (!outcome.available) return { status: "refused", code: outcome.reason, reason: outcome.note, retryAfterSeconds: outcome.retryAfterSeconds, speech: outcome.note };
  if ("groups" in outcome) return { status: "done", groups: outcome.groups, privacy: outcome.privacy, speech: `${outcome.groups.length} groups listed.` };
  return { status: "done", title: outcome.title, timeZone: outcome.timeZone, start: outcome.start, end: outcome.end, oldestStoredAt: outcome.oldestStoredAt,
    messages: outcome.messages, nextCursor: outcome.nextCursor, privacy: outcome.privacy,
    speech: `${outcome.messages.length} messages, oldest first. ${outcome.nextCursor ? "More follow: call again with cursor set to nextCursor." : "That is the end of this range."}` };
}
