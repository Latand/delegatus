import type { Pipeline } from "./types";

/** Browser contract; source paths and source text are resolved only by the server. */
export type ConversationDraftRequest = {
  conversationId: string;
  taskId: string;
  sourceRevision: string;
  clientRequestId: string;
};

export type ConversationDraftError = {
  error: string;
  code: string;
  retryable?: true;
};

export type ConversationDraftPreview = {
  ok: true;
  source: {
    conversationId: string;
    title: string;
    branch: string;
    head: string;
    sourceRevision: string;
    canCreate: boolean;
    refusal?: ConversationDraftError;
  };
};

export type ConversationDraftResponse = { ok: true; pipeline: Pipeline };
