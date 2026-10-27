"use client";

import type { ConversationDraftError, ConversationDraftPreview, ConversationDraftRequest } from "@/lib/pipelines/conversationDraftContract";
import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";
import type { PipelinePorts } from "@/components/kanban/pipelinePorts";
import { applyPipelineSnapshot } from "@/hooks/useFiles";
import { PIPELINES_CHANGED_EVENT } from "./pipelineEvents";

/**
 * A pipeline drafted from a conversation the task card holds
 * (docs/design/start-pipeline-from-conversation/implementation.md, variant 3).
 *
 * The card's ⋯ names one source conversation and its branch, read from the
 * server while the menu is open (`readConversationPreview`). Choosing it
 * posts once with a key of its own; the server reads the branch, the commit
 * and the first message, and answers the draft. Everything the browser sends
 * is ids: the path, the branch and the words are the server's.
 *
 * One store per page (`ConversationDrafts`), shared by the desktop card and
 * the phone's screens, so a creation in flight keeps its key and a Start in
 * flight its state when the width crosses the breakpoint.
 */

export type ConversationSource = ConversationDraftPreview["source"];

/** A conversation the card holds that can be a source: a local row with a canonical id. */
export function conversationSourceFile(files: readonly FileEntry[]): FileEntry | null {
  const byId = new Map<string, FileEntry>();
  for (const file of files) {
    const id = file.conversationId;
    if (!id) continue;
    const held = byId.get(id);
    /* Generations of one conversation: the newest stands for it. */
    if (!held || file.mtime > held.mtime) byId.set(id, file);
  }
  const rows = [...byId.values()];
  /* Rows with a recorded working directory first; the server can still
     recover one for an imported conversation, so none is left out. */
  const withCwd = rows.filter((file) => Boolean(file.cwd));
  const pool = withCwd.length ? withCwd : rows;
  pool.sort((a, b) => b.mtime - a.mtime || (a.conversationId! < b.conversationId! ? -1 : a.conversationId! > b.conversationId! ? 1 : 0));
  return pool[0] ?? null;
}

export type PreviewOutcome =
  | { kind: "ready"; source: ConversationSource }
  | { kind: "failed"; refusal: ConversationDraftError | null };

type Fetch = typeof fetch;

/** The menu's read of its source: the conversation's name, branch and whether it can be drafted now. */
export async function readConversationPreview(conversationId: string, taskId: string, signal?: AbortSignal, fetcher: Fetch = fetch): Promise<PreviewOutcome> {
  try {
    const query = new URLSearchParams({ conversationId, taskId });
    const response = await fetcher(`/api/pipelines/from-conversation?${query}`, { cache: "no-store", signal });
    const json = (await response.json().catch(() => null)) as (Partial<ConversationDraftPreview> & Partial<ConversationDraftError>) | null;
    if (response.ok && json?.ok && json.source) return { kind: "ready", source: json.source };
    return { kind: "failed", refusal: typeof json?.code === "string" ? { code: json.code, error: String(json.error ?? ""), ...(json.retryable ? { retryable: true } : {}) } : null };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { kind: "failed", refusal: null };
  }
}

export type CreateOutcome =
  | { kind: "created"; pipeline: Pipeline }
  | { kind: "refused"; refusal: ConversationDraftError }
  /* No answer, or one that does not say what happened: the draft may exist.
     Only the same request under the same key may ask again. */
  | { kind: "unknown"; error: string };

export async function postConversationDraft(request: ConversationDraftRequest, fetcher: Fetch = fetch): Promise<CreateOutcome> {
  try {
    const response = await fetcher("/api/pipelines/from-conversation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    const json = (await response.json().catch(() => null)) as { ok?: boolean; pipeline?: Pipeline; code?: unknown; error?: unknown; retryable?: unknown } | null;
    if (response.ok && json?.pipeline) return { kind: "created", pipeline: json.pipeline };
    /* The route's catch-all 500 can follow a stored draft: only a named
       refusal says nothing was written. */
    if (response.ok || (response.status >= 500 && json?.retryable !== true) || typeof json?.code !== "string") return { kind: "unknown", error: `HTTP ${response.status}` };
    return { kind: "refused", refusal: { code: json.code, error: typeof json.error === "string" ? json.error : "", ...(json.retryable === true ? { retryable: true } : {}) } };
  } catch (error) {
    return { kind: "unknown", error: error instanceof Error ? error.message : String(error) };
  }
}

/** The source as the card names it while its draft is being made. */
export interface DraftSourceLabel { conversationId: string; title: string; branch: string }

export interface ConversationDraftAttempt {
  taskId: string;
  source: DraftSourceLabel;
  request: ConversationDraftRequest;
  /* "checking" reads the source again after a refusal; "checked" holds what
     it read until the operator creates from it or closes it. */
  phase: "creating" | "refused" | "unknown" | "checking" | "checked";
  refusal: ConversationDraftError | null;
  /** The source read again, which Create posts under a new key. */
  checked?: ConversationSource;
}

export interface DraftStartState {
  phase: "starting" | "refused" | "unknown";
  error: string | null;
}

export interface ConversationDraftDeps {
  post: (request: ConversationDraftRequest) => Promise<CreateOutcome>;
  preview: (conversationId: string, taskId: string) => Promise<PreviewOutcome>;
  /** Draw a pipeline the server answered on every surface. */
  apply: (pipeline: Pipeline) => void;
  newKey: () => string;
}

const browserDeps: ConversationDraftDeps = {
  post: (request) => postConversationDraft(request),
  preview: (conversationId, taskId) => readConversationPreview(conversationId, taskId),
  apply: (pipeline) => {
    applyPipelineSnapshot(pipeline, true);
    window.dispatchEvent(new Event(PIPELINES_CHANGED_EVENT));
  },
  newKey: () => `from-conversation:${crypto.randomUUID()}`,
};

export class ConversationDrafts {
  private readonly attempts = new Map<string, ConversationDraftAttempt>();
  /* A draft the server answered, by task, until the surface showing that task opens it. */
  private readonly landed = new Map<string, string>();
  private readonly starts = new Map<string, DraftStartState>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;

  constructor(private readonly deps: ConversationDraftDeps = browserDeps) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  version = (): number => this.revision;

  private changed(): void {
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }

  attempt(taskId: string): ConversationDraftAttempt | null {
    return this.attempts.get(taskId) ?? null;
  }

  start(pipelineId: string): DraftStartState | null {
    return this.starts.get(pipelineId) ?? null;
  }

  /** The draft made for this task that no surface has opened yet. */
  landedFor(taskId: string): string | null {
    return this.landed.get(taskId) ?? null;
  }

  /** The surface opened it. */
  take(taskId: string): void {
    if (this.landed.delete(taskId)) this.changed();
  }

  /**
   * Post the draft once. A second press while one is on its way, or while the
   * source is being read again, changes nothing; a request that may have
   * landed goes again under its own key and never under a new one.
   */
  create(taskId: string, source: ConversationSource): Promise<Pipeline | null> {
    const attempt = this.attempts.get(taskId);
    if (attempt?.phase === "creating" || attempt?.phase === "checking") return Promise.resolve(null);
    if (attempt?.phase === "unknown") return this.send({ ...attempt, phase: "creating", refusal: null });
    return this.fresh(taskId, source);
  }

  private fresh(taskId: string, source: ConversationSource): Promise<Pipeline | null> {
    const request: ConversationDraftRequest = { conversationId: source.conversationId, taskId, sourceRevision: source.sourceRevision, clientRequestId: this.deps.newKey() };
    return this.send({ taskId, source: { conversationId: source.conversationId, title: source.title, branch: source.branch }, request, phase: "creating", refusal: null });
  }

  /**
   * Retry: a request that may have landed, or one refused for a passing
   * reason, goes again under its own key, which the server answers with the
   * draft it already made. A source that changed is only read again: what it
   * reads now is shown, and nothing is posted until the operator creates
   * from it (`create`), under a new key.
   */
  async retry(taskId: string): Promise<Pipeline | null> {
    const attempt = this.attempts.get(taskId);
    if (!attempt || attempt.phase === "creating" || attempt.phase === "checking" || attempt.phase === "checked") return null;
    if (attempt.phase === "unknown" || attempt.refusal?.retryable) return this.send({ ...attempt, phase: "creating", refusal: null });
    this.set(taskId, { ...attempt, phase: "checking", refusal: null, checked: undefined });
    /* Nothing replaces a check while it reads: create and dismiss both hold. */
    const preview = await this.deps.preview(attempt.request.conversationId, taskId);
    if (preview.kind === "failed" || !preview.source.canCreate) {
      /* A read that failed for a passing reason is read again, never answered
         by sending the refused request. */
      const failed = preview.kind === "ready" ? preview.source.refusal ?? { code: "SOURCE_CHANGED", error: "" } : preview.refusal ?? { code: "PREVIEW_FAILED", error: "" };
      const refusal: ConversationDraftError = { code: failed.code, error: failed.error };
      this.set(taskId, { ...attempt, phase: "refused", refusal });
      return null;
    }
    const read = preview.source;
    this.set(taskId, { ...attempt, phase: "checked", refusal: null, checked: read, source: { conversationId: read.conversationId, title: read.title, branch: read.branch } });
    return null;
  }

  /** Close a refusal or a source read again. A request on its way, or one that may have landed, stays until it is answered. */
  dismiss(taskId: string): void {
    const attempt = this.attempts.get(taskId);
    if (attempt?.phase !== "refused" && attempt?.phase !== "checked") return;
    this.set(taskId, null);
  }

  private set(taskId: string, attempt: ConversationDraftAttempt | null): void {
    if (attempt) this.attempts.set(taskId, attempt);
    else this.attempts.delete(taskId);
    this.changed();
  }

  private async send(attempt: ConversationDraftAttempt): Promise<Pipeline | null> {
    this.set(attempt.taskId, attempt);
    const outcome = await this.deps.post(attempt.request);
    if (this.attempts.get(attempt.taskId)?.request !== attempt.request) return null;
    if (outcome.kind === "created") {
      this.deps.apply(outcome.pipeline);
      this.attempts.delete(attempt.taskId);
      this.landed.set(attempt.taskId, outcome.pipeline.id);
      this.changed();
      return outcome.pipeline;
    }
    if (outcome.kind === "unknown") this.set(attempt.taskId, { ...attempt, phase: "unknown", refusal: null });
    else this.set(attempt.taskId, { ...attempt, phase: "refused", refusal: outcome.refusal });
    return null;
  }

  /**
   * Start the draft with the engine's own `start`. Nothing is drawn as
   * running before the answer: the server checks the graph, the accounts and
   * the repository first.
   */
  async startDraft(pipeline: Pipeline, ports: PipelinePorts): Promise<void> {
    if (this.starts.get(pipeline.id)?.phase === "starting") return;
    this.setStart(pipeline.id, { phase: "starting", error: null });
    const result = await ports.patch(pipeline.id, { action: "start" });
    if (result.ok) {
      ports.refresh();
      return this.setStart(pipeline.id, null);
    }
    this.setStart(pipeline.id, result.unknown ? { phase: "unknown", error: null } : { phase: "refused", error: result.error });
  }

  /**
   * A Start with no answer is read before anything is sent again: a lane past
   * its draft started (whoever started it); a lane still a draft takes Start
   * again, which the engine refuses once the lane has left its draft.
   */
  async checkStart(pipelineId: string, ports: PipelinePorts): Promise<void> {
    if (this.starts.get(pipelineId)?.phase !== "unknown") return;
    const read = await ports.read(pipelineId);
    if (!read) return;
    if (read.pipeline.state !== "draft") this.deps.apply(read.pipeline);
    ports.refresh();
    this.setStart(pipelineId, null);
  }

  dismissStart(pipelineId: string): void {
    if (this.starts.get(pipelineId)?.phase === "refused") this.setStart(pipelineId, null);
  }

  private setStart(pipelineId: string, state: DraftStartState | null): void {
    if (state) this.starts.set(pipelineId, state);
    else this.starts.delete(pipelineId);
    this.changed();
  }
}
