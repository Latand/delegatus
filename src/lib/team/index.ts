/*
 * The team module's one door (docs/design/sign-in-and-team.md §11). Every
 * file outside `src/lib/team/`, `src/app/(team)/`, `src/app/team/`,
 * `src/app/api/team/` and `src/components/team/` reaches the module through
 * this file, and each call here answers the solo install's answer when no
 * team exists — so a build without the directory replaces this file with
 * `nullTeam` from `contract.ts` and nothing else changes.
 *
 * One exception, on purpose: `src/proxy.ts` imports `./gate` directly. The
 * proxy is its own bundle, and this file's imports (the agent registry, via
 * `teamActor`) would pull the whole server graph into it.
 */

import type { MessageSender, TeamActor, TeamModule } from "./contract";
import { isHumanActor, refuseAnonymous, teamActor } from "./actor";
import { memberInitials } from "./contract";
import { claimMessageAuthor, settleMessageAuthor } from "./authorship";
import { messageTextDigest, recordMessageAuthor, recordTeamEvent } from "./events";
import { teamMode } from "./sessions";
import { existingTeamStore } from "./store";
import { recordConversationEvent } from "./subjects";
import { teamTelegramHook } from "./telegramSignIn";

export { claimMessageAuthor, isHumanActor, recordConversationEvent, recordMessageAuthor, recordTeamEvent, refuseAnonymous, settleMessageAuthor, teamActor, teamMode, teamTelegramHook };
export type { MessageAuthorClaim, PriorSubmission } from "./contract";

/** `client message id → sender`, for the ids a feed asks about. Members are
    resolved at read time, so a rename shows everywhere and a revoked member
    keeps their name on what they sent. Unknown ids resolve to nothing.
    `inConversation` binds the answer to the conversation being read: a row
    recorded for another conversation, or for none, names nobody here, so an
    id reused somewhere else cannot put a name on this conversation's message. */
export function messageSenders(
  clientMessageIds: readonly string[],
  inConversation?: (conversationId: string) => boolean,
): Record<string, MessageSender> {
  if (!clientMessageIds.length) return {};
  try {
    const store = existingTeamStore();
    if (!store) return {};
    const authors = store.messageAuthors([...new Set(clientMessageIds)]);
    if (!authors.size) return {};
    const members = new Map(store.members().map((member) => [member.id, member]));
    const senders: Record<string, MessageSender> = {};
    for (const [id, { memberId, conversationId }] of authors) {
      if (inConversation && (!conversationId || !inConversation(conversationId))) continue;
      const member = members.get(memberId);
      if (member) senders[id] = { memberId, name: member.name, color: member.color, initials: memberInitials(member.name) };
    }
    return senders;
  } catch {
    return {};
  }
}

/** The member an actor names, as a sender, or null. */
export function actorSender(actor: TeamActor | null | undefined): MessageSender | null {
  if (actor?.kind !== "member") return null;
  try {
    const member = existingTeamStore()?.member(actor.memberId);
    return member ? { memberId: member.id, name: member.name, color: member.color, initials: memberInitials(member.name) } : null;
  } catch {
    return null;
  }
}

export interface SubjectAuthorship {
  /** Who started it (a conversation) or created it (a task). */
  startedBy: MessageSender | null;
  /** Who changed it last (a task), with when. */
  changedBy: MessageSender | null;
  changedAt: string | null;
}

/** Who started or last changed each subject, from the audit. Subjects with
    no member-attributed event are absent. */
export function subjectAuthorship(subjectIds: readonly string[]): Record<string, SubjectAuthorship> {
  const result: Record<string, SubjectAuthorship> = {};
  if (!subjectIds.length) return result;
  try {
    const store = existingTeamStore();
    if (!store || !store.hasActiveOwner()) return result;
    const members = new Map(store.members().map((member) => [member.id, member]));
    const sender = (actor: TeamActor): MessageSender | null => {
      if (actor.kind !== "member") return null;
      const member = members.get(actor.memberId);
      return member ? { memberId: member.id, name: member.name, color: member.color, initials: memberInitials(member.name) } : null;
    };
    for (const subjectId of [...new Set(subjectIds)].slice(0, 500)) {
      const events = store.events({ subjectId, limit: 50, actions: ["agent.started", "task.created", "task.changed"] });
      if (!events.length) continue;
      const started = events.findLast((event) => event.action === "agent.started" || event.action === "task.created");
      const changed = events.find((event) => event.action === "task.changed") ?? null;
      const entry: SubjectAuthorship = {
        startedBy: started ? sender(started.actor) : null,
        changedBy: changed ? sender(changed.actor) : null,
        changedAt: changed?.at ?? null,
      };
      if (entry.startedBy || entry.changedBy) result[subjectId] = entry;
    }
  } catch {
    /* authorship is decoration on a read */
  }
  return result;
}

export const team: TeamModule = {
  teamMode,
  teamActor,
  refuseAnonymous,
  recordTeamEvent,
  recordMessageAuthor,
  claimMessageAuthor,
  settleMessageAuthor,
  messageSenders,
  subjectAuthorship,
  teamTelegramHook,
};

/** What `conversation_messages` says about a human message's author. */
export interface RecordAuthor {
  kind: "member";
  memberId: string;
  name: string;
}

const RECORD_MARKER = /^<!-- llv:structured-user[^>]*-->\n?/;
const AUTHOR_SLACK_MS = 10 * 60_000;

/**
 * The member behind each user record of one conversation, for the MCP read
 * (#1497: "reading it through the MCP tools still says who sent what"). A
 * transcript record carries no submission id, so the join is the one the
 * occurrence evidence already uses: the digest of the words the member sent,
 * and the latest send at or before the record (a send just after it only
 * when none precedes it). Each send names at most one
 * record; a record nothing matches is left unnamed.
 */
export function recordAuthors(
  conversationId: string | null,
  records: ReadonlyArray<{ role: string; ts: string | null; text: string }>,
): Map<number, RecordAuthor> {
  const result = new Map<number, RecordAuthor>();
  if (!conversationId) return result;
  try {
    const store = existingTeamStore();
    if (!store) return result;
    const sends = store.messageAuthorsForConversation(conversationId).filter((row) => row.textDigest);
    if (!sends.length) return result;
    const members = new Map(store.members().map((member) => [member.id, member]));
    const used = new Set<string>();
    records.forEach((record, index) => {
      if (record.role !== "user" || !record.ts) return;
      const at = Date.parse(record.ts);
      const digest = messageTextDigest(record.text.replace(RECORD_MARKER, ""));
      /* The latest send at or before the record is its own. A send up to 5 s
         after the record counts only when none precedes it (clocks differ):
         taking the latest inside that slack named a record after whoever sent
         the same words a moment later. */
      let preceding: (typeof sends)[number] | null = null;
      let following: (typeof sends)[number] | null = null;
      for (const send of sends) {
        if (used.has(send.clientMessageId) || send.textDigest !== digest) continue;
        const sentAt = Date.parse(send.at);
        if (sentAt > at + 5_000 || at - sentAt > AUTHOR_SLACK_MS) continue;
        if (sentAt <= at) {
          if (!preceding || sentAt > Date.parse(preceding.at)) preceding = send;
        } else if (!following || sentAt < Date.parse(following.at)) {
          following = send;
        }
      }
      const best = preceding ?? following;
      const member = best ? members.get(best.memberId) : null;
      if (best && member) {
        used.add(best.clientMessageId);
        result.set(index, { kind: "member", memberId: member.id, name: member.name });
      }
    });
  } catch {
    /* authorship is decoration on a read */
  }
  return result;
}
