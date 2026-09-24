import { NextRequest, NextResponse } from "next/server";

import { requireOperatorAuthority } from "@/lib/agent/operatorAuthority";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { telegramBotFailure } from "@/lib/telegram/bot/http";
import { ensureTelegramBotPoller, telegramBotService } from "@/lib/telegram/bot/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The operator's surface for the Telegram bot account
 * (`docs/design/telegram-bot-account.md`, Decision 7). GET is the panel's
 * status; POST is `connect {token}`, `refresh`, `chat {chatId, alias,
 * postAllowed}` and `remove`. Every answer is a `TelegramBotStatusPayload`,
 * which carries no token and no bot id. The token arrives on `connect` and
 * never leaves this server again.
 *
 * Every POST is the operator's alone: an agent presenting its capability is
 * refused, so no agent can connect a bot or widen its own allowlist.
 */

export async function GET(req: NextRequest) {
  const rejected = rejectCrossOrigin(req);
  if (rejected) return rejected;
  try {
    /* The footer panel polls this, which keeps the poller alive in this
       process the way the Telegram route keeps the report scheduler alive. */
    ensureTelegramBotPoller();
    return NextResponse.json({ bot: telegramBotService().status() });
  } catch (error) {
    return telegramBotFailure(error);
  }
}

export async function POST(req: NextRequest) {
  const rejected = rejectCrossOrigin(req);
  if (rejected) return rejected;
  const authority = requireOperatorAuthority(req);
  if (!authority.ok) return NextResponse.json({ error: authority.error, code: "operator_only" }, { status: authority.status });
  let body: { action?: unknown; token?: unknown; chatId?: unknown; alias?: unknown; postAllowed?: unknown };
  try { body = await req.json() as typeof body; } catch { return NextResponse.json({ error: "Invalid JSON", code: "invalid_json" }, { status: 400 }); }
  const service = telegramBotService();
  try {
    switch (body.action) {
      case "connect":
        return NextResponse.json({ bot: await service.connect(body.token) });
      case "refresh":
        return NextResponse.json({ bot: await service.refresh() });
      case "chat":
        return NextResponse.json({ bot: service.setChat(body.chatId, body.alias, body.postAllowed) });
      case "remove":
        return NextResponse.json({ bot: await service.remove() });
      default:
        return NextResponse.json({ error: "Unknown Telegram bot action", code: "invalid_action" }, { status: 400 });
    }
  } catch (error) {
    return telegramBotFailure(error);
  }
}
