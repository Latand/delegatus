import crypto from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import type { FileDiff } from "@/components/feed/diff";
import { LANE_CHANGE_LIMITS, laneChangeFiles, laneChangeSummary, laneFileDiff, laneReviewTarget, resolveLaneRevisions, type LaneChangeError } from "@/lib/pipelines/laneChanges";
import type { Pipeline } from "@/lib/pipelines/types";
import { redactSecrets } from "@/lib/review";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { activeDeliveryActor, teamActor } from "@/lib/team/actor";
import type { TeamActor } from "@/lib/team/contract";
import type { ExecPort } from "@/lib/workflows/provision";
import { composeLaneReviewMessage, type LaneReviewLocale } from "./message";
import { findRow, LANE_REVIEW_LIMITS, numberRows, rowQuote, SHA_RE, type LaneReviewSide } from "./model";

/* The lane review routes (docs/design/lane-diff-comments.md §1, §5): read a
   lane's changes, and send the operator's line comments to the lane's writer
   as one message. Only a person reads or sends; an agent, a Viewer service or
   an anonymous caller is refused before anything is read. */

export type PersonActor = Extract<TeamActor, { kind: "operator" | "member" }>;
export type LaneReviewDelivery = { conversationId: string; clientMessageId: string; text: string };

export type LaneReviewDependencies = {
  pipeline: (id: string) => Pipeline | null;
  exec: ExecPort;
  deliver: (delivery: LaneReviewDelivery, actor: PersonActor) => Promise<Response>;
};

type Refusal = NextResponse<{ error: string; code?: string; [key: string]: unknown }>;
const refuse = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): Refusal =>
  NextResponse.json({ error, code, ...extra }, { status });

/** The one authority rule for both routes: a person, never a conversation
    capability, a service claim or an anonymous team caller. */
export function laneReviewPerson(req: NextRequest): { actor: PersonActor } | { refusal: Refusal } {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return { refusal: rejection as Refusal };
  const actor = teamActor(req);
  if ((actor.kind === "operator" || actor.kind === "member") && activeDeliveryActor(actor)) return { actor };
  return { refusal: refuse(403, "operator_only", "only the operator reviews a lane's changes; an agent, a service or a signed-out caller may not") };
}

function changeError(result: LaneChangeError): Refusal {
  if (result.code === "path_not_changed") return refuse(404, result.code, result.error);
  if (result.code === "git_failed") return refuse(500, result.code, result.error);
  return refuse(409, result.code, result.error);
}

/** GET …/changes, and GET …/changes?base&head&path for one file. */
export async function laneChangesGET(req: NextRequest, id: string, deps: LaneReviewDependencies): Promise<NextResponse> {
  const admitted = laneReviewPerson(req);
  if ("refusal" in admitted) return admitted.refusal;
  const pipeline = deps.pipeline(id);
  if (!pipeline) return refuse(404, "pipeline_not_found", "pipeline not found");
  const params = req.nextUrl.searchParams;
  const base = params.get("base");
  const head = params.get("head");
  const path = params.get("path");
  if (base !== null || head !== null || path !== null) {
    if (!base || !head) return refuse(400, "invalid_request", "base and head are read together");
    if (!SHA_RE.test(base) || !SHA_RE.test(head)) return refuse(400, "invalid_request", "base and head must be full commit ids");
    if (path === null) {
      /* The file list of a draft's own pair, while the branch has moved on. */
      const files = await laneChangeFiles(pipeline, base, head, deps.exec);
      if (!files) return refuse(500, "git_failed", "git could not list the lane's changes");
      return NextResponse.json({ ok: true, base, head, files: files.slice(0, LANE_CHANGE_LIMITS.files), total: files.length, truncated: files.length > LANE_CHANGE_LIMITS.files });
    }
    const file = await laneFileDiff(pipeline, base, head, path, deps.exec);
    if ("error" in file) return changeError(file);
    return NextResponse.json({ ok: true, base, head, file });
  }
  const summary = await laneChangeSummary(pipeline, deps.exec);
  if ("error" in summary) return changeError(summary);
  return NextResponse.json({ ok: true, summary, target: laneReviewTarget(pipeline) });
}

type ReviewComment = { path: string; side: LaneReviewSide; line: number | null; quote: string; body: string };
type ReviewBody = { draftId: string; base: string; head: string; conversationId: string; locale: LaneReviewLocale; note: string; comments: ReviewComment[] };

function parseReviewBody(raw: unknown): ReviewBody | { field: string; error: string } {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  if (!value) return { field: "body", error: "request body must be an object" };
  const { draftId, base, head, conversationId, locale, note = "", comments } = value;
  if (typeof draftId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(draftId)) return { field: "draftId", error: "draftId is invalid" };
  if (typeof base !== "string" || !SHA_RE.test(base)) return { field: "base", error: "base must be a full commit id" };
  if (typeof head !== "string" || !SHA_RE.test(head)) return { field: "head", error: "head must be a full commit id" };
  if (typeof conversationId !== "string" || !conversationId) return { field: "conversationId", error: "conversationId is required" };
  if (locale !== "en" && locale !== "uk") return { field: "locale", error: "locale must be en or uk" };
  if (typeof note !== "string" || note.length > LANE_REVIEW_LIMITS.note) return { field: "note", error: `note is at most ${LANE_REVIEW_LIMITS.note} characters` };
  if (!Array.isArray(comments) || comments.length > LANE_REVIEW_LIMITS.comments) return { field: "comments", error: `comments is a list of at most ${LANE_REVIEW_LIMITS.comments}` };
  const parsed: ReviewComment[] = [];
  for (const [index, entry] of comments.entries()) {
    const field = `comments[${index}]`;
    const comment = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string, unknown> : null;
    if (!comment) return { field, error: "a comment must be an object" };
    const { path, side, line, quote = "", body } = comment;
    if (typeof path !== "string" || !path || path.length > 4_096) return { field: `${field}.path`, error: "path is required" };
    if (side !== "old" && side !== "new") return { field: `${field}.side`, error: "side must be old or new" };
    if (line !== null && !(typeof line === "number" && Number.isInteger(line) && line > 0)) return { field: `${field}.line`, error: "line is a positive integer or null" };
    if (typeof quote !== "string" || quote.length > LANE_REVIEW_LIMITS.quote) return { field: `${field}.quote`, error: `quote is at most ${LANE_REVIEW_LIMITS.quote} characters` };
    if (typeof body !== "string" || !body.trim() || body.length > LANE_REVIEW_LIMITS.body) return { field: `${field}.body`, error: `body is 1 to ${LANE_REVIEW_LIMITS.body} characters` };
    parsed.push({ path, side, line, quote, body });
  }
  return { draftId, base, head, conversationId, locale, note, comments: parsed };
}

/** Repeating one draft at one head replays the first answer and delivers nothing twice. */
export function laneReviewMessageKey(pipelineId: string, draftId: string, head: string): string {
  return `lane-review:${crypto.createHash("sha256").update(`${pipelineId}\0${draftId}\0${head}`).digest("hex")}`.slice(0, 128);
}

/** POST …/review. Each refusal delivers nothing. */
export async function laneReviewPOST(req: NextRequest, id: string, deps: LaneReviewDependencies): Promise<NextResponse> {
  const admitted = laneReviewPerson(req);
  if ("refusal" in admitted) return admitted.refusal;
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return refuse(400, "invalid_request", "invalid JSON");
  }
  const body = parseReviewBody(raw);
  if ("field" in body) return refuse(400, "invalid_request", body.error, { field: body.field });
  if (!body.comments.length && !body.note.trim()) return refuse(422, "empty_review", "a review needs a comment or a note");
  const pipeline = deps.pipeline(id);
  if (!pipeline) return refuse(404, "pipeline_not_found", "pipeline not found");

  /* The head is read again here: the draft's pair must still be the lane's. */
  const current = await resolveLaneRevisions(pipeline, deps.exec);
  if ("error" in current) return changeError(current);
  if (current.head !== body.head || current.base !== body.base) {
    return refuse(409, "head_moved", "the lane's branch moved since these comments were written; re-anchor them first", { base: current.base, head: current.head });
  }

  const files = await laneChangeFiles(pipeline, body.base, body.head, deps.exec);
  if (!files) return refuse(500, "git_failed", "git could not list the lane's changes");
  const listed = new Set(files.map((file) => file.path));
  const missing = body.comments.findIndex((comment) => !listed.has(comment.path));
  if (missing >= 0) return refuse(400, "path_not_changed", "a comment names a file this pair does not change", { field: `comments[${missing}].path` });

  const target = laneReviewTarget(pipeline);
  if (!target) return refuse(409, "no_target", "no stage has written to this lane yet");
  if (target.conversationId !== body.conversationId) return refuse(409, "target_changed", "the lane's writer changed", { target });

  /* A line comment's quote must be that row's redacted text, so the message
     carries no quote the diff does not hold. A file comment's quote (kept
     from a line that is gone) is redacted here. */
  const diffs = new Map<string, FileDiff>();
  const comments: ReviewComment[] = [];
  for (const [index, comment] of body.comments.entries()) {
    if (comment.line === null) {
      comments.push({ ...comment, quote: rowQuote(redactSecrets(comment.quote)) });
      continue;
    }
    let diff = diffs.get(comment.path);
    if (!diff) {
      const read = await laneFileDiff(pipeline, body.base, body.head, comment.path, deps.exec, files);
      if ("error" in read) return changeError(read);
      diff = read;
      diffs.set(comment.path, diff);
    }
    const row = findRow(numberRows(diff.hunks), comment.side, comment.line);
    if (!row || rowQuote(row.line.text) !== comment.quote) {
      return refuse(400, "quote_mismatch", "a comment's quote is not the text of its line in this diff", { field: `comments[${index}].quote` });
    }
    comments.push(comment);
  }

  const text = composeLaneReviewMessage({
    locale: body.locale, base: body.base, head: body.head, branch: pipeline.branch,
    note: body.note, comments, pathOrder: files.map((file) => file.path),
  });
  const clientMessageId = laneReviewMessageKey(pipeline.id, body.draftId, body.head);
  const response = await deps.deliver({ conversationId: target.conversationId, clientMessageId, text }, admitted.actor);
  const answer = await response.json().catch(() => ({})) as Record<string, unknown>;
  return NextResponse.json({ ...answer, conversationId: target.conversationId, clientMessageId, target }, { status: response.status });
}

/** An in-process request to the Viewer's own conversation host, from loopback,
    as the prototype decision form sends its answer. */
export async function deliverLaneReview(delivery: LaneReviewDelivery, actor: PersonActor): Promise<Response> {
  const { conversationHostPOST } = await import("@/app/api/conversation-host/handlers");
  const request = new NextRequest(new URL("/api/conversation-host", "http://localhost"), {
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ ...delivery, policy: "steer-or-queue", images: [] }),
  });
  return conversationHostPOST(request, { actor });
}
