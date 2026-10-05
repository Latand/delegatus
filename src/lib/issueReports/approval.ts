import { conversationResolver } from "@/lib/activity/conversationResolver";
import { bodyOf } from "@/lib/activity/humanInput";
import { operatorRecords, readTranscript, transcriptContext } from "@/lib/activity/transcriptExport";
import { readOnlyConversationLookupFromSnapshot, type RegistryFile } from "@/lib/agent/registry";

/*
 * The operator's approval of one Delegatus bug report (#2518).
 *
 * An agent's account of what the operator said proves nothing: the seat that
 * wants to publish is the one that would report the "yes". So publication
 * reads the approval where the operator wrote it. The seat's own transcript
 * is the record, and a message counts only on the evidence Delegatus already
 * keeps of who wrote it (`classifyUserRecord`): an operator-origin delivery or
 * a line typed at the terminal. A relay from another agent, a notice, a tool
 * result and anything the seat wrote itself are never the operator's.
 *
 * The approval names the text it is for. Reading a preview back answers a
 * reply that carries a code taken from the preview's digest, the seat offers
 * that reply as a suggested reply under the text, and the operator sends it.
 * A reply for another text carries another code, so a "yes" cannot move from
 * the text the operator read to an edited one, and a "no" or any other
 * sentence is no approval however the seat reads it.
 *
 * The approval is the operator's LAST message since the seat read the preview
 * back: a "yes" followed by "wait" is withdrawn.
 */

export interface OperatorMessage {
  /** When the transcript recorded it, in milliseconds. */
  at: number;
  text: string;
}

export function issueReportApprovalCode(digest: string): string {
  return digest.slice(0, 8);
}

/** The replies that approve this exact preview, one per interface language. */
export function issueReportApprovalReplies(digest: string): { en: string; uk: string } {
  const code = issueReportApprovalCode(digest);
  return { en: `Yes, publish report ${code}`, uk: `Так, публікуй звіт ${code}` };
}

function normalized(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase("uk-UA").replace(/[.,!]/g, " ").replace(/\s+/g, " ").trim();
}

/** Whether one message is the approving reply of this preview, and nothing else. */
export function approvesIssueReport(message: string, digest: string): boolean {
  const said = normalized(message);
  return Object.values(issueReportApprovalReplies(digest)).some((reply) => normalized(reply) === said);
}

export type IssueReportApproval =
  | { approved: true; message: OperatorMessage }
  | { approved: false; reason: "no_operator_message" | "not_an_approval" };

/** The operator's standing answer to a preview a seat read back at `shownAt`. */
export function issueReportApproval(messages: readonly OperatorMessage[], digest: string, shownAt: number): IssueReportApproval {
  const since = messages.filter((message) => message.at > shownAt).sort((left, right) => left.at - right.at);
  const last = since.at(-1);
  if (!last) return { approved: false, reason: "no_operator_message" };
  return approvesIssueReport(last.text, digest) ? { approved: true, message: last } : { approved: false, reason: "not_an_approval" };
}

/**
 * What the operator wrote in one conversation, oldest first, read from the
 * conversation's current transcript. Empty when the conversation or its
 * transcript cannot be read: no evidence is no approval.
 */
export async function operatorMessagesOf(conversationId: string, snapshot: RegistryFile): Promise<OperatorMessage[]> {
  const conversation = readOnlyConversationLookupFromSnapshot(snapshot).conversation(conversationId as `conversation_${string}`);
  const file = conversation?.generations.at(-1)?.path;
  if (!file) return [];
  let transcript: Awaited<ReturnType<typeof readTranscript>>;
  try { transcript = await readTranscript(file); } catch { return []; }
  if (!transcript) return [];
  const context = transcriptContext("local", transcript.facts, conversationResolver(snapshot)(transcript.facts));
  return operatorRecords(transcript.records, context).map((rec) => ({ at: rec.at, text: bodyOf(rec.text).trim() }));
}
