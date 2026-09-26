/**
 * "Asks you" (docs/research/attention-classifier.md §7): the shapes the
 * server writes and the board reads. Browser-safe: no store and no filesystem
 * here, so the reason model and the report log can import it.
 */

/** The open ask `/api/files` stamps on a conversation's current entry. */
export interface OperatorAskMark {
  /** The ask's identity: the needs-you reason id and the report-log line's. */
  id: string;
  /** Epoch ms of the agent message that asks. A newer turn or a newer agent
      message means the operator answered or the agent moved on. */
  messageAt: number;
  /** The agent's own words: the sentence that asks, on one line. */
  gist: string;
}

/** One Viewer-authored report-log line: an agent that asked the operator. */
export interface ReportLogAsk {
  id: string;
  /** ISO time the agent asked. */
  at: string;
  conversationId: string | null;
  path: string;
  /** The agent's role id, when the registry names one. */
  role: string | null;
  /** The conversation's title, for an agent without a role. */
  title: string | null;
  gist: string;
}

/** What the setting row draws: the switch, the key, and this month's spend. */
export interface AsksYouSettingView {
  enabled: boolean;
  /** Where the OpenRouter key comes from, never the key itself. */
  keySource: "env" | "file" | null;
  /** The file a key may be put in. */
  keyPath: string;
  month: string;
  spentUsd: number;
  capUsd: number;
  calls: number;
  /** Messages left unclassified this month because the cap was reached. */
  capped: number;
}
