import type { FileDiff } from "@/components/feed/diff";
import type { LaneChangeFile, LaneChangeSummary, LaneReviewTarget } from "@/lib/pipelines/laneChanges";
import type { LaneReviewComment, LaneReviewDraft } from "@/lib/laneReview/model";

/* The lane review sheet's reads and its one write, over the routes in
   src/app/api/pipelines/[id]/changes and …/review. */

export type FetchPort = (input: string, init?: RequestInit) => Promise<Response>;

export type ReadResult<T> = { ok: true; value: T } | { ok: false; status: number; code: string | null; reason: string; body: Record<string, unknown> };

async function read<T>(fetchPort: FetchPort, url: string, init?: RequestInit): Promise<ReadResult<T>> {
  try {
    const response = await fetchPort(url, init);
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      return { ok: false, status: response.status, code: typeof body.code === "string" ? body.code : null, reason: typeof body.error === "string" ? body.error : `HTTP ${response.status}`, body };
    }
    return { ok: true, value: body as T };
  } catch (error) {
    return { ok: false, status: 0, code: null, reason: error instanceof Error ? error.message : "the server is unavailable", body: {} };
  }
}

const changesUrl = (pipelineId: string, query?: Record<string, string>) =>
  `/api/pipelines/${encodeURIComponent(pipelineId)}/changes${query ? `?${new URLSearchParams(query).toString()}` : ""}`;

export const readLaneSummary = (fetchPort: FetchPort, pipelineId: string) =>
  read<{ summary: LaneChangeSummary; target: LaneReviewTarget | null }>(fetchPort, changesUrl(pipelineId), { cache: "no-store" });

export type PairFiles = { files: LaneChangeFile[]; total: number; truncated: boolean };
export const readPairFiles = (fetchPort: FetchPort, pipelineId: string, base: string, head: string) =>
  read<PairFiles>(fetchPort, changesUrl(pipelineId, { base, head }), { cache: "no-store" });

export const readLaneFile = (fetchPort: FetchPort, pipelineId: string, base: string, head: string, path: string) =>
  read<{ file: FileDiff }>(fetchPort, changesUrl(pipelineId, { base, head, path }), { cache: "no-store" });

export type ReviewAnswer = { operationId?: string; clientMessageId: string; conversationId: string; receipt?: { status?: string; resend?: string }; outcome?: string; target: LaneReviewTarget };

export function sendLaneReview(fetchPort: FetchPort, draft: LaneReviewDraft, conversationId: string, locale: "en" | "uk") {
  const comments = draft.comments.map(({ path, side, line, quote, body }: LaneReviewComment) => ({ path, side, line, quote, body }));
  return read<ReviewAnswer>(fetchPort, `/api/pipelines/${encodeURIComponent(draft.pipelineId)}/review`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ draftId: draft.draftId, base: draft.base, head: draft.head, conversationId, locale, note: draft.note, comments }),
  });
}

export type OperationAnswer = { operationId?: string; receipt?: { status?: string; resend?: string } };
export const readOperation = (fetchPort: FetchPort, operationId: string) =>
  read<OperationAnswer>(fetchPort, `/api/runtime/operations/${encodeURIComponent(operationId)}`, { cache: "no-store" });
export const retryOperation = (fetchPort: FetchPort, operationId: string) =>
  read<OperationAnswer>(fetchPort, `/api/runtime/operations/${encodeURIComponent(operationId)}`, { method: "POST" });

export const shortSha = (sha: string) => sha.slice(0, 10);
