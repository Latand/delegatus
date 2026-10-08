/*
 * The wording of the reply that approves one bug report (#2518), kept free of
 * server imports because the chat's reply drafts read it too.
 */

export type IssueReportLanguage = "en" | "uk";

/** The replies that approve this exact preview, one per interface language. */
export function issueReportApprovalReplies(digest: string): Record<IssueReportLanguage, string> {
  return { en: `Yes, publish report ${digest}`, uk: `Так, публікуй звіт ${digest}` };
}

/**
 * The same replies as reply drafts: the sentence that approves, under a label
 * short enough for suggest_replies. The label says what the tap leads to.
 */
export function issueReportApprovalDrafts(digest: string): Record<IssueReportLanguage, { label: string; text: string }> {
  const replies = issueReportApprovalReplies(digest);
  return {
    en: { label: "Yes, publish as a public issue", text: replies.en },
    uk: { label: "Так, публікуй як публічний issue", text: replies.uk },
  };
}

const APPROVAL_REPLY = /^(?:Yes, publish report|Так, публікуй звіт) [0-9a-f]{64}$/;

/** Whether a reply draft is the approving reply of some preview. */
export function isIssueReportApprovalReply(text: string): boolean {
  return APPROVAL_REPLY.test(text.trim());
}
