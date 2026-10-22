import { NextRequest, NextResponse } from "next/server";
import { authenticatedOwner } from "@/lib/team";
import { ownerReviewDestination } from "@/lib/externalRelay/telegramPublication";
import { companionOperator } from "@/lib/voiceCompanion/http";
import { readBoundedJson } from "@/lib/keys/access";
import { telegramBotService, TelegramBotError } from "@/lib/telegram/bot/service";
import { telegramBotFailure } from "@/lib/telegram/bot/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };
function failure(error: unknown) {
  const response = telegramBotFailure(error);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

/** Reuses the established browser perimeter and independently paired owner verifier. */
function owner(req: NextRequest): NextResponse | null {
  const rejection = companionOperator(req);
  if (rejection) return rejection;
  let paired: string | undefined;
  try { paired = ownerReviewDestination().chatId; } catch { /* unpaired refuses */ }
  return authenticatedOwner(req, paired) ? null : NextResponse.json({ code: "OPERATOR_REQUIRED" }, { status: 401, headers: NO_STORE });
}
export async function GET(req: NextRequest) {
  const rejected = owner(req); if (rejected) return rejected;
  try {
    const id = req.nextUrl.searchParams.get("id") ?? "";
    return NextResponse.json(telegramBotService().fileConfirmation(id), { headers: NO_STORE });
  } catch (error) { return failure(error); }
}
export async function POST(req: NextRequest) {
  const rejected = owner(req); if (rejected) return rejected;
  const input = await readBoundedJson(req, 1024);
  const recheck = owner(req); if (recheck) return recheck;
  if (!input || Object.keys(input).some(key => !["id", "digest", "approve"].includes(key))
    || typeof input.id !== "string" || input.id.length > 80 || typeof input.digest !== "string" || !/^[a-f0-9]{64}$/.test(input.digest) || typeof input.approve !== "boolean")
    return NextResponse.json({ code: "INVALID_REQUEST" }, { status: 400, headers: NO_STORE });
  try {
    const authorize = () => { if (owner(req)) throw new TelegramBotError("forbidden", "The paired owner's live session is required to approve this send."); };
    const result = await telegramBotService().decideFileConfirmation(input.id, input.digest, input.approve, authorize);
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) { return failure(error); }
}
