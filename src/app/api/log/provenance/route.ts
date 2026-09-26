import { NextRequest, NextResponse } from "next/server";

import { claudeMessageProvenance, type DeliveredMessageProvenance } from "@/lib/runtime/claudeMessageProvenance";
import { deliveredMessageOccurrences } from "@/lib/runtime/deliveredMessageOccurrences";
import type { DeliveredMessageOccurrence } from "@/lib/runtime/messageOrigin";
import { submissionIdentities } from "@/lib/runtime/submissionIdentity";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { messageSenders } from "@/lib/team";
import type { MessageSender } from "@/lib/team/contract";
import { pathAllowed } from "@/lib/scanner/roots";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface MessageProvenanceResponse {
  /** Delivered-message authorship keyed by the transcript row's engine uuid
      (#1117). Only rows with real delivery evidence appear; the feed keeps
      today's rendering for everything else. */
  messages: Record<string, DeliveredMessageProvenance>;
  /** Occurrence evidence for deliveries that left no per-row identity —
      legacy tmux pastes on both engines, flow relays, pre-#1117 structured
      sends — each joined by the feed to the ONE row nearest its settlement. */
  occurrences: DeliveredMessageOccurrence[];
  /** `dedup token → submission id` for this conversation (#1950 round 2): the
      per-row identity a structured Codex record carries in its own marker,
      resolved to the client message id that admitted it. The feed binds a
      record into the outbox row it belongs to through this, so nothing about
      the binding depends on the delivered TEXT. Empty when the registry
      cannot answer, and a row with no entry here binds as it did before. */
  submissions: Record<string, string>;
  /** `submission id → sender` for the submissions this answer names
      (sign-in-and-team §6.7): which member sent each human message, resolved
      from the team's own record at read time. Empty on a solo install and
      for any message sent before a team existed. */
  senders: Record<string, MessageSender>;
}

/**
 * Delivery-evidence provenance for one conversation. The `messages` id join is
 * Claude-only (a non-Claude path yields an empty map); the occurrence join
 * serves both engines, since a legacy paste's transcript row looks the same
 * on each.
 */
export function GET(req: NextRequest): NextResponse<MessageProvenanceResponse | ApiError> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  const path = req.nextUrl.searchParams.get("path") ?? "";
  if (!path || !pathAllowed(path)) {
    return NextResponse.json({ error: "path not allowed" }, { status: 403 });
  }
  const messages = claudeMessageProvenance(path);
  const occurrences = deliveredMessageOccurrences(path);
  const submissions = submissionIdentities(path);
  const ids = [
    ...Object.values(messages).flatMap((entry) => (entry.submissionId ? [entry.submissionId] : [])),
    ...occurrences.flatMap((entry) => (entry.submissionId ? [entry.submissionId] : [])),
    ...Object.values(submissions),
  ];
  return NextResponse.json(
    { messages, occurrences, submissions, senders: messageSenders(ids) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
