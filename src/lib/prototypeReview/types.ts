import type { PrototypeCriticPass } from "./criticGate";

/** Client-safe contract shared by the task card, review and orchestrator pane. */
export interface PrototypeFrameInput {
  path: string;
  originalPath?: string;
  caption: string;
  width?: number;
  lang?: "en" | "uk";
}
export interface PrototypeVideoInput { path: string; caption: string }
export interface PrototypeVariantInput {
  number: number;
  name: string;
  description: string;
  frames?: PrototypeFrameInput[];
  videos?: PrototypeVideoInput[];
}
export interface PrototypeQuestion {
  id: string;
  text: string;
  options: Array<{ label: string; recommended?: boolean }>;
  multiple?: boolean;
  other?: boolean;
}
export interface PrototypeAnswer { questionId: string; options: number[]; other?: true }
export interface PublishPrototypeInput {
  clientRequestId: string;
  taskId?: string;
  title: string;
  /** Immediate files only: variant-N or vN, width, en/uk, caption. */
  dir?: string;
  variants?: PrototypeVariantInput[];
  questions?: PrototypeQuestion[];
}
export interface PrototypeMedia {
  id: string;
  mime: "image/png" | "image/jpeg" | "image/webp" | "video/mp4" | "video/webm";
  bytes: number;
}
export interface PrototypeFrame {
  image: PrototypeMedia;
  original?: PrototypeMedia;
  caption: string;
  width?: number;
  lang?: "en" | "uk";
}
export interface PrototypeVariant {
  number: number;
  name: string;
  description: string;
  frames: PrototypeFrame[];
  videos: Array<{ media: PrototypeMedia; caption: string }>;
}
export type PrototypeDeliveryState = "pending" | "sent" | "failed" | "uncertain" | "no-orchestrator";
/** What the review says of a saved decision's message, derived on a local
    read: saved and not yet handed to the seat, on its way, delivered, waiting
    for the project to have an orchestrator, or failing long enough to ask for
    the operator's attention. Never crosses to another installation. */
export type PrototypeDeliveryPhase = "saved" | "delivering" | "delivered" | "waiting-seat" | "attention";
export interface PrototypeDecision {
  answers?: PrototypeAnswer[];
  skipped?: true;
  rejected?: true;
  chosen: number[];
  comment: string;
  at: string;
  /** The person who decided; the background delivery sends in their name. Local only. */
  decidedBy?: { kind: "operator" } | { kind: "member"; memberId: string };
  /** 1 for the first decision of a round; a changed decision raises it and gets a message key of its own. */
  revision?: number;
  /** Persisted before dispatch; retries always carry this key and recipient. */
  delivery: {
    state: PrototypeDeliveryState;
    clientMessageId: string;
    conversationId: string | null;
    text: string;
    operationId?: string;
    /** Written before the message is first handed to the send path: from then on a change goes as an amendment. */
    dispatchedAt?: string;
    /** Failed or unconfirmed attempts, including admitted ones the journal later showed failed, and when that run began. Cleared when the message lands or the operator retries. */
    failures?: number;
    failingSince?: string;
  };
}
export interface PrototypeReviewRound {
  id: string;
  title: string;
  /** Null for a round the project's orchestrator published without a task
      (docs/design/operator-decision-forms.md §2.2). */
  taskId: string | null;
  project: string;
  createdAt: string;
  source: { conversationId: string | null; pipelineId?: string; stageId?: string; attempt?: number };
  /** Stable publication key and argument digest survive source-file removal. */
  publicationKey: string;
  inputDigest: string;
  critic?: PrototypeCriticPass;
  variants: PrototypeVariant[];
  questions?: PrototypeQuestion[];
  decision?: PrototypeDecision;
  mediaRemovedAt?: string;
}
export interface PrototypeMediaView extends PrototypeMedia { available: boolean; url: string | null }
export interface PrototypeRoundView extends Omit<PrototypeReviewRound, "publicationKey" | "inputDigest" | "critic" | "decision" | "variants"> {
  variants: Array<Omit<PrototypeVariant, "frames" | "videos"> & {
    frames: Array<Omit<PrototypeFrame, "image" | "original"> & { image: PrototypeMediaView; original?: PrototypeMediaView }>;
    videos: Array<{ media: PrototypeMediaView; caption: string }>;
  }>;
  decision?: Omit<PrototypeDecision, "delivery" | "decidedBy" | "revision"> & { delivery: { state: PrototypeDeliveryState; retryable: boolean; phase?: PrototypeDeliveryPhase } };
}
/** A read's round. Superseded rounds name the later decided round that retired
    them; the mark is derived on read and never crosses to another installation. */
export interface PrototypeRoundRead extends PrototypeRoundView {
  supersededBy?: string;
  hidden?: { at: string; by: import("@/lib/attention/dismissalTypes").DismissedBy };
}
export interface PrototypeReviewRead {
  /** Null for the seat's own rounds, read without a task. */
  taskId: string | null;
  rounds: PrototypeRoundRead[];
  waitingReviewId: string | null;
  /** Replicated metadata has no local media and cannot be decided here. */
  unavailable?: "another-installation";
  summary?: PrototypeReviewSummary;
  historyTruncated?: true;
}
export interface PrototypeReviewReplica { summary: PrototypeReviewSummary; rounds: PrototypeRoundView[]; historyTruncated?: true }
export interface PrototypeReviewSummary {
  asks?: "questions";
  waitingDismissal?: { at: string; by: import("@/lib/attention/dismissalTypes").DismissedBy };
  latestReviewId: string;
  waitingReviewId: string | null;
  title: string;
  rounds: number;
  createdAt: string;
  decision?: { answered?: true; rejected?: true; chosen: Array<{ number: number; name: string }>; comment: string; at: string; delivery: PrototypeDeliveryState; phase?: PrototypeDeliveryPhase };
}
export interface PrototypeReviewNotice {
  asks?: "questions";
  /** The round is decided and its message keeps failing to reach the seat. */
  undelivered?: true;
  id: string;
  project: string;
  /** Null for a question the orchestrator asked without a task. */
  taskId: string | null;
  reviewId: string;
  /** The task's first line: the card the jump lands on. */
  title: string;
  /** The waiting round's own title, shown second. */
  roundTitle?: string;
  createdAt: string;
  /** The UI focuses this task and opens this round in its review surface; a
      seat's own question opens in the seat's «Рішення» column. */
  target: { kind: "prototype-review"; taskId: string; reviewId: string } | { kind: "seat-decision"; project: string; reviewId: string };
}
/** One open decision of a project, as the «Рішення» column draws it: a seat
    round or a task's waiting round, with the task it waits on. */
export interface OperatorDecisionView extends PrototypeRoundRead {
  taskTitle?: string;
}
export interface OperatorDecisionsRead {
  project: string;
  decisions: OperatorDecisionView[];
  /** The one round a read asked for by id, open or answered: the record the
      seat's feed draws where it asked. Null when the project holds no such round. */
  round?: OperatorDecisionView | null;
}
export interface DecidePrototypeInput { reviewId: string; chosen: number[]; comment: string; answers?: PrototypeAnswer[]; skip?: true; reject?: true }
