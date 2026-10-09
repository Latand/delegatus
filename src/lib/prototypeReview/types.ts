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
export interface PrototypeDecision {
  answers?: PrototypeAnswer[];
  skipped?: true;
  chosen: number[];
  comment: string;
  at: string;
  /** Persisted before dispatch; retries always carry this key and recipient. */
  delivery: {
    state: PrototypeDeliveryState;
    clientMessageId: string;
    conversationId: string | null;
    text: string;
    operationId?: string;
  };
}
export interface PrototypeReviewRound {
  id: string;
  title: string;
  taskId: string;
  project: string;
  createdAt: string;
  source: { conversationId: string | null; pipelineId?: string; stageId?: string; attempt?: number };
  /** Stable publication key and argument digest survive source-file removal. */
  publicationKey: string;
  inputDigest: string;
  variants: PrototypeVariant[];
  questions?: PrototypeQuestion[];
  decision?: PrototypeDecision;
  mediaRemovedAt?: string;
}
export interface PrototypeMediaView extends PrototypeMedia { available: boolean; url: string | null }
export interface PrototypeRoundView extends Omit<PrototypeReviewRound, "publicationKey" | "inputDigest" | "decision" | "variants"> {
  variants: Array<Omit<PrototypeVariant, "frames" | "videos"> & {
    frames: Array<Omit<PrototypeFrame, "image" | "original"> & { image: PrototypeMediaView; original?: PrototypeMediaView }>;
    videos: Array<{ media: PrototypeMediaView; caption: string }>;
  }>;
  decision?: Omit<PrototypeDecision, "delivery"> & { delivery: { state: PrototypeDeliveryState; retryable: boolean } };
}
/** A read's round. Superseded rounds name the later decided round that retired
    them; the mark is derived on read and never crosses to another installation. */
export interface PrototypeRoundRead extends PrototypeRoundView { supersededBy?: string }
export interface PrototypeReviewRead {
  taskId: string;
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
  latestReviewId: string;
  waitingReviewId: string | null;
  title: string;
  rounds: number;
  createdAt: string;
  decision?: { answered?: true; chosen: Array<{ number: number; name: string }>; comment: string; at: string; delivery: PrototypeDeliveryState };
}
export interface PrototypeReviewNotice {
  asks?: "questions";
  id: string;
  project: string;
  taskId: string;
  reviewId: string;
  /** The task's first line: the card the jump lands on. */
  title: string;
  /** The waiting round's own title, shown second. */
  roundTitle?: string;
  createdAt: string;
  /** The UI focuses this task and opens this round in its review surface. */
  target: { kind: "prototype-review"; taskId: string; reviewId: string };
}
export interface DecidePrototypeInput { reviewId: string; chosen: number[]; comment: string; answers?: PrototypeAnswer[]; skip?: true }
