import { NextRequest, NextResponse } from "next/server";

import { claudeMessageProvenance, type DeliveredMessageProvenance } from "@/lib/runtime/claudeMessageProvenance";
import { deliveredMessageOccurrences } from "@/lib/runtime/deliveredMessageOccurrences";
import type { DeliveredMessageOccurrence } from "@/lib/runtime/messageOrigin";
import { submissionIdentities } from "@/lib/runtime/submissionIdentity";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
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
  return NextResponse.json(
    {
      messages: claudeMessageProvenance(path),
      occurrences: deliveredMessageOccurrences(path),
      submissions: submissionIdentities(path),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
