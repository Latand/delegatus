import { NextRequest, NextResponse } from "next/server";
import { companionBody, companionFailure, companionOperator } from "@/lib/voiceCompanion/http";
import { companionSessions } from "@/lib/voiceCompanion/server";
import type { CompanionCommand } from "@/lib/voiceCompanion/contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);

/** Only operator browser actions reach session controls. Provider tool events,
 * final usage and transcripts have no browser-write route. */
export async function POST(req: NextRequest) {
  const denied = companionOperator(req); if (denied) return denied;
  try {
    const body = await companionBody(req, 100_000);
    const service = companionSessions();
    if (body.action === "start") {
      if (typeof body.project !== "string" || !["en", "uk"].includes(body.locale as string) || typeof body.sdp !== "string" || !id(body.requestId)) throw new Error("INVALID_REQUEST");
      return NextResponse.json(await service.start({ project: body.project, locale: body.locale as "en" | "uk", sdp: body.sdp, requestId: body.requestId }), { status: 201, headers });
    }
    if (body.action === "close" && id(body.requestId) && body.sessionId === undefined) {
      await service.closeRequest(body.requestId); return NextResponse.json({ ok: true }, { headers });
    }
    if (!id(body.sessionId)) throw new Error("INVALID_REQUEST");
    if (body.action === "close") await service.close(body.sessionId);
    else if (body.action === "command") {
      const value = body.command;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_REQUEST");
      const command = value as CompanionCommand;
      if (command.type === "confirmation") {
        if (!id(command.proposalId) || command.via !== "tap" || !["send", "cancel"].includes(command.decision)) throw new Error("INVALID_REQUEST");
      } else if (command.type === "mute") { if (typeof command.muted !== "boolean") throw new Error("INVALID_REQUEST"); }
      else if (command.type === "interrupt") { if (!id(command.responseId)) throw new Error("INVALID_REQUEST"); }
      else throw new Error("INVALID_REQUEST");
      await service.command(body.sessionId, command);
    } else throw new Error("INVALID_REQUEST");
    return NextResponse.json({ ok: true }, { headers });
  } catch (error) { return companionFailure(error); }
}

export async function GET(req: NextRequest) {
  const denied = companionOperator(req); if (denied) return denied;
  try {
    const sessionId = req.nextUrl.searchParams.get("sessionId");
    const after = Number(req.nextUrl.searchParams.get("after") ?? 0);
    if (!id(sessionId) || !Number.isSafeInteger(after) || after < 0) throw new Error("INVALID_REQUEST");
    if (req.nextUrl.searchParams.get("view") === "transcript")
      return NextResponse.json(companionSessions().transcriptRecord(sessionId), { headers });
    return NextResponse.json({ events: await companionSessions().events(sessionId, after) }, { headers });
  } catch (error) { return companionFailure(error); }
}
