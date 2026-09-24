import { NextRequest, NextResponse } from "next/server";

import { callerConversationId } from "@/lib/agent/operatorAuthority";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { telegramBotFailure } from "@/lib/telegram/bot/http";
import { telegramBotService } from "@/lib/telegram/bot/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The agents' surface for the Telegram bot account, called by the three
 * Viewer MCP tools (`docs/design/telegram-bot-account.md`, Decision 6).
 *
 * GET `?op=chats[&includeInactive=1]` and `?op=messages&chat=…` read; POST
 * `{op:"send", …}` posts. The sender is resolved here from the forwarded
 * conversation capability, never from an argument, so the attribution a post
 * carries is the caller's own. No answer carries the token or the bot id.
 */

export async function GET(req: NextRequest) {
  const rejected = rejectCrossOrigin(req);
  if (rejected) return rejected;
  const params = new URL(req.url).searchParams;
  const service = telegramBotService();
  try {
    switch (params.get("op")) {
      case "chats":
        return NextResponse.json(service.listChats({ includeInactive: params.get("includeInactive") === "1" }));
      case "messages":
        return NextResponse.json(service.readMessages({
          chat: params.get("chat") ?? "",
          limit: params.get("limit") ?? undefined,
          cursor: params.get("cursor") ?? undefined,
          since: params.get("since") ?? undefined,
          maxChars: params.get("maxChars") ?? undefined,
        }));
      default:
        return NextResponse.json({ error: "Unknown Telegram bot read", code: "invalid_action" }, { status: 400 });
    }
  } catch (error) {
    return telegramBotFailure(error);
  }
}

export async function POST(req: NextRequest) {
  const rejected = rejectCrossOrigin(req);
  if (rejected) return rejected;
  let body: Record<string, unknown>;
  try { body = await req.json() as Record<string, unknown>; } catch { return NextResponse.json({ error: "Invalid JSON", code: "invalid_json" }, { status: 400 }); }
  if (body.op !== "send") return NextResponse.json({ error: "Unknown Telegram bot action", code: "invalid_action" }, { status: 400 });
  try {
    return NextResponse.json(await telegramBotService().send({
      conversationId: callerConversationId(req),
      clientRequestId: body.clientRequestId,
      chat: body.chat,
      text: body.text,
      format: body.format,
      replyToMessageId: body.replyToMessageId,
      topicId: body.topicId,
      silent: body.silent,
    }));
  } catch (error) {
    return telegramBotFailure(error);
  }
}
