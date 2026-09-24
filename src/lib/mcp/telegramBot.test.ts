import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { VIEWER_SPAWN_CAPABILITY_ENV, VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";

import { TelegramBotError } from "@/lib/telegram/bot/service";
import { telegramBotFailure } from "@/lib/telegram/bot/http";

import { productionViewerControlDependencies, viewerMcpBindings, type ViewerControlDependencies } from "./bindings";
import { createMcpToolService, McpDispatchVerdictError, McpToolRefusal, MemoryMcpReceiptStore } from "./server";

/* The three Telegram bot tools reach the Viewer's agent route and nothing
   else (docs/design/telegram-bot-account.md, Decision 6). */

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-telegram-bot-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
const OLD_CAPABILITY = process.env[VIEWER_SPAWN_CAPABILITY_ENV];
const OLD_CONTROL_URL = process.env.LLV_VIEWER_CONTROL_URL;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
const CAPABILITY = "B".repeat(43);

afterAll(() => {
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = OLD_STATE;
  if (OLD_CAPABILITY === undefined) delete process.env[VIEWER_SPAWN_CAPABILITY_ENV];
  else process.env[VIEWER_SPAWN_CAPABILITY_ENV] = OLD_CAPABILITY;
  if (OLD_CONTROL_URL === undefined) delete process.env.LLV_VIEWER_CONTROL_URL;
  else process.env.LLV_VIEWER_CONTROL_URL = OLD_CONTROL_URL;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

let reads: string[];
let dispatched: Array<{ pathname: string; body: Record<string, unknown>; headers: Record<string, string> }>;
let dispatchAnswer: () => Promise<Record<string, unknown>>;

beforeEach(() => {
  process.env[VIEWER_SPAWN_CAPABILITY_ENV] = CAPABILITY;
  reads = [];
  dispatched = [];
  dispatchAnswer = async () => ({ chat: "team-reports", messageIds: [6], attributedTo: { conversationId: "conversation_writer" } });
});

function bindings() {
  const control: ViewerControlDependencies = {
    get: async (pathname) => {
      reads.push(pathname);
      return { chats: [], limits: [] };
    },
    post: async () => { throw new Error("the bot tools never use the plain post"); },
    dispatch: async (pathname, body, headers) => {
      dispatched.push({ pathname, body, headers: headers ?? {} });
      return dispatchAnswer();
    },
  };
  return viewerMcpBindings(undefined, control);
}

test("telegram_bot_send dispatches once with the caller's capability, never a caller-named conversation", async () => {
  const answer = await bindings().telegram_bot_send({
    clientRequestId: "req-1", chat: "team-reports", text: "Weekly report", format: "html", topicId: 3, replyToMessageId: 9, silent: true,
    conversationId: "conversation_someone_else",
  });
  expect(answer).toMatchObject({ messageIds: [6], attributedTo: { conversationId: "conversation_writer" } });
  expect(dispatched).toHaveLength(1);
  expect(dispatched[0]!.pathname).toBe("/api/telegram/bot/agent");
  expect(dispatched[0]!.body).toEqual({ op: "send", clientRequestId: "req-1", chat: "team-reports", text: "Weekly report", format: "html", replyToMessageId: 9, topicId: 3, silent: true });
  expect(dispatched[0]!.headers[VIEWER_SPAWN_CAPABILITY_HEADER]).toBe(CAPABILITY);
});

test("a route refusal keeps its code, whether a new key may retry, and Telegram's wait", async () => {
  dispatchAnswer = async () => { throw new McpDispatchVerdictError("the operator has not allowed posting to Team Reports", { status: 403, code: "chat_not_allowed" }); };
  const notAllowed = await bindings().telegram_bot_send({ clientRequestId: "req-2", chat: "team-reports", text: "x" }).catch((error: unknown) => error);
  expect(notAllowed).toBeInstanceOf(McpToolRefusal);
  expect((notAllowed as InstanceType<typeof McpToolRefusal>).details).toEqual({ code: "chat_not_allowed", retryable: false });

  dispatchAnswer = async () => { throw new McpDispatchVerdictError("Telegram is rate-limiting this bot; retry after 9 s", { status: 429, code: "rate_limited", retryAfterSeconds: 9 }); };
  const limited = await bindings().telegram_bot_send({ clientRequestId: "req-3", chat: "team-reports", text: "x" }).catch((error: unknown) => error);
  expect((limited as InstanceType<typeof McpToolRefusal>).details).toEqual({ code: "rate_limited", retryable: true, retryAfterSeconds: 9 });
});

test("the reads carry their arguments into the agent route query", async () => {
  await bindings().telegram_bot_chats({ clientRequestId: "c1", includeInactive: true });
  await bindings().telegram_bot_messages({ clientRequestId: "m1", chat: "team-reports", limit: 5, maxChars: 200, cursor: "abc", since: "2026-09-24T00:00:00Z" });
  expect(reads).toEqual([
    "/api/telegram/bot/agent?op=chats&includeInactive=1",
    "/api/telegram/bot/agent?op=messages&chat=team-reports&limit=5&maxChars=200&cursor=abc&since=2026-09-24T00%3A00%3A00Z",
  ]);
});

test("through the MCP service, a send refusal answers with the bot's code and its retryable at the top, and a partial send keeps its ids", async () => {
  /* The real dispatch against a stand-in Viewer that answers exactly as the
     agent route does, through the route's own failure writer. */
  let next: TelegramBotError = new TelegramBotError("chat_unknown", "unset");
  const viewer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => telegramBotFailure(next) });
  process.env.LLV_VIEWER_CONTROL_URL = `http://127.0.0.1:${viewer.port}`;
  try {
    const service = createMcpToolService(viewerMcpBindings(undefined, productionViewerControlDependencies(true)), new MemoryMcpReceiptStore());
    const send = (key: string, error: TelegramBotError) => {
      next = error;
      return service.callTool("telegram_bot_send", { clientRequestId: key, chat: "team-reports", text: "Weekly report" });
    };

    const uncertain = await send("req-uncertain", new TelegramBotError("send_uncertain", "Telegram did not answer in time, so the message may already be posted"));
    expect(uncertain).toMatchObject({ ok: false, code: "send_uncertain", retryable: false, details: { code: "send_uncertain", retryable: false } });

    for (const code of ["chat_not_allowed", "bot_not_in_chat"] as const) {
      expect(await send(`req-${code}`, new TelegramBotError(code, `refused: ${code}`))).toMatchObject({ ok: false, code, retryable: false });
    }

    const limited = await send("req-limited", new TelegramBotError("rate_limited", "Telegram is rate-limiting this bot; retry after 9 s", { retryAfterSeconds: 9 }));
    expect(limited).toMatchObject({ ok: false, code: "rate_limited", retryable: true, details: { retryAfterSeconds: 9 } });

    const partial = await send("req-partial", new TelegramBotError("send_partial", "parts 1–2 of 3 were posted", { sentMessageIds: [80, 81] }));
    expect(partial).toMatchObject({ ok: false, code: "send_partial", retryable: false, details: { code: "send_partial", sentMessageIds: [80, 81] } });

    /* The refusal is the key's answer: a replay never posts. */
    expect(await send("req-uncertain", new TelegramBotError("chat_unknown", "a second dispatch"))).toMatchObject({ code: "send_uncertain", replayed: true });
  } finally {
    viewer.stop(true);
  }
});
