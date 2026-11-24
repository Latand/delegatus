import { NextRequest, NextResponse } from "next/server";

import type { TranscriptWork } from "@/lib/board/attemptWork";
import { completedFileScan } from "@/lib/scanner/scanCache";
import { transcriptWorkFor } from "@/lib/scanner/transcriptWork";
import { overlaySessionTitles } from "@/lib/session/titleProjection";
import { filterWorkspaceRows, requestWorkspaceScope, workspaceRoute } from "@/lib/team/workspaceRoute";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_IDENTITIES = 12;

/**
 * The turn windows of whole conversation transcripts, for the board chart's
 * working time: GET /api/board/work-time?conversationId=…
 *
 * An identity is a conversation id or a transcript path. The gate has already
 * checked each against the caller's workspaces; the files are filtered by the
 * same scope again, and one the caller may not read answers `null`, the same
 * as one that does not exist. The files come from the latest completed scan,
 * so the read costs one transcript walk per changed file and nothing else.
 */
async function workspaceGET(req: NextRequest): Promise<NextResponse<{ work: Record<string, TranscriptWork | null> } | ApiError>> {
  const identities = [...new Set(req.nextUrl.searchParams.getAll("conversationId").map(id => id.trim()).filter(Boolean))];
  if (!identities.length) return NextResponse.json({ error: "conversationId required" }, { status: 400 });
  if (identities.length > MAX_IDENTITIES) return NextResponse.json({ error: `at most ${MAX_IDENTITIES} conversations per read` }, { status: 400 });
  const completed = await completedFileScan();
  const files = completed.snapshot.files.map(entry => ({ ...entry }));
  overlaySessionTitles(files);
  const readable = filterWorkspaceRows(requestWorkspaceScope(req), files);
  return NextResponse.json({ work: await transcriptWorkFor(readable, identities) }, { headers: { "cache-control": "private, no-store" } });
}

export const GET = workspaceRoute("/api/board/work-time", workspaceGET);
