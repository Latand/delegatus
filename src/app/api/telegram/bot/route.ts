import { NextRequest, NextResponse } from "next/server";

import { requireOperatorAuthority } from "@/lib/agent/operatorAuthority";
import { translate } from "@/lib/i18n";
import { operatorLocale } from "@/lib/operator/settings";
import { withReportDestinations } from "@/lib/projects/reportDestination";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { telegramBotFailure } from "@/lib/telegram/bot/http";
import { ensureTelegramBotPoller, telegramBotService } from "@/lib/telegram/bot/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The operator's surface for the Telegram bot account
 * (`docs/design/telegram-bot-account.md`, Decision 7). GET is the panel's
 * status; POST is `connect {token}`, `refresh`, `chat {chatId, alias,
 * postAllowed}`, `add {chat, alias?}`, `test {chat}` and `remove`. `add`
 * allows a chat named by its id or @username, verified with `getChat`, so a
 * post-only bot (another program owns its updates) can reach a group it never
 * received an update from; `test` is the operator's own silent test post.
 * Every answer is a `TelegramBotStatusPayload`, which carries no token and no
 * bot id, with each chat's report destinations added. The token arrives on `connect` and never leaves this server again.
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
    return NextResponse.json({ bot: withReportDestinations(telegramBotService().status()) });
  } catch (error) {
    return telegramBotFailure(error);
  }
}

export async function POST(req: NextRequest) {
  const rejected = rejectCrossOrigin(req);
  if (rejected) return rejected;
  const authority = requireOperatorAuthority(req);
  if (!authority.ok) return NextResponse.json({ error: authority.error, code: "operator_only" }, { status: authority.status });
  let body: { action?: unknown; token?: unknown; chatId?: unknown; chat?: unknown; alias?: unknown; postAllowed?: unknown };
  try { body = await req.json() as typeof body; } catch { return NextResponse.json({ error: "Invalid JSON", code: "invalid_json" }, { status: 400 }); }
  const service = telegramBotService();
  try {
    switch (body.action) {
      case "connect":
        return NextResponse.json({ bot: withReportDestinations(await service.connect(body.token)) });
      case "refresh":
        return NextResponse.json({ bot: withReportDestinations(await service.refresh()) });
      case "chat":
        return NextResponse.json({ bot: withReportDestinations(service.setChat(body.chatId, body.alias, body.postAllowed)) });
      case "add": {
        const added = await service.addChat(body.chat, body.alias);
        return NextResponse.json({ bot: withReportDestinations(added.status), added: { chat: added.chat, chatId: added.chatId } });
      }
      case "test": {
        const tested = await service.testPost(body.chat, translate(operatorLocale() ?? "en", "telegram.bot.testPostText"));
        return NextResponse.json({ bot: withReportDestinations(tested.status), tested: { chat: body.chat, sentAt: tested.sentAt } });
      }
      case "remove":
        return NextResponse.json({ bot: withReportDestinations(await service.remove()) });
      default:
        return NextResponse.json({ error: "Unknown Telegram bot action", code: "invalid_action" }, { status: 400 });
    }
  } catch (error) {
    return telegramBotFailure(error);
  }
}
