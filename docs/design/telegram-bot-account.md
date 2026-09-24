# Telegram bot account

Status: design, one implementable slice. Grounded in `main` at `bfd58b846`; the
20 commits `origin/main` had on top at writing time touch none of the files
named here.

## Originating requirement

The operator's request, recorded on the task on 2026-09-24 (the record itself
paraphrases the operator; quoted here unedited, with no credentials or
personal data to redact):

> Operator ask (2026-09-24, paraphrased): Delegatus can connect a Telegram BOT
> (by its BotFather token), not only a personal account. The bot posts messages
> into the groups the operator names, and agents can read the messages the bot
> sees, all through Viewer MCP tools, for example so reports go to a team group.
>
> Today Delegatus has a personal-account connector (bin/telegram-login-bridge.py,
> bin/telegram-mcp-server.py on Telethon, src/lib/telegram/*,
> src/components/TelegramConnect.tsx, the reports runner). Reuse that
> infrastructure where it fits (Telethon can log in with a bot token over
> MTProto; the Bot API is the other option); the design picks one with reasons.
>
> Required:
> - Setup in the Telegram / Accounts panel: paste a bot token, see the bot's
>   name and status, remove it. The token is a secret: stored like the other
>   credentials (keyring/secret store or the existing credential file pattern),
>   never logged, never in browser payloads, never in transcripts or MCP answers.
> - Chats: the bot learns the chats it is added to; the operator marks which
>   chats agents may post to (an allowlist, with a friendly alias per chat).
>   Posting to a chat outside the allowlist is refused with a clear reason.
> - MCP tools for agents: list the bot's chats (alias, type, whether posting is
>   allowed, whether the bot can see all messages); send a message (plain text
>   or safe formatting, optional reply-to and forum topic) to an allowed chat,
>   attributed in Delegatus to the calling conversation; read recent messages
>   the bot received in a chat (bounded, paged, newest first), stored locally
>   since a bot has no history API.
> - Honest limits surfaced in the UI and tool answers: a bot sees only messages
>   after it joined; in groups it sees all messages only with privacy mode off
>   or as admin; it cannot start a chat with a user who never wrote to it.
> - The existing personal-account connector and the reports path keep working
>   unchanged.
>
> Acceptance: design doc docs/design/telegram-bot-account.md (transport choice,
> secret storage, allowlist, MCP shapes, update intake and retention, limits);
> implementation with unit tests (token never serialised, allowlist refusal,
> send attribution, message intake and paging) using a fake Telegram transport,
> no network in tests; desktop and phone renders of the setup panel under
> ~/Pictures/delegatus-review/telegram-bot/; tsc clean; touched tests by path;
> bun run build with an isolated config root; no real token anywhere in the
> repo, fixtures or PR.

**Should this be built?** Yes. The requirement names the capability directly,
and nothing in Delegatus can do it today: the personal connector is read-only
by design (see below). Everything past what the quote asks for is under
[Deferred](#deferred--not-currently-justified).

## What exists, and what the bot can reuse

| Piece on main | What it does | Reuse for the bot |
| --- | --- | --- |
| `bin/telegram-login-bridge.py`, `src/lib/telegram/adapter.ts` | Telethon QR + 2FA login for a **user** account, NDJSON over pipes | No. A bot has no login ceremony; the token *is* the credential. |
| `bin/telegram-mcp-server.py`, `src/lib/telegram/connector.ts`, `packaging.ts`, `hostRegistration.ts` | One shared loopback `telegram-mcp` (vendored chigwell connector, Python venv), **verified read-only**: every advertised tool must be on `TELEGRAM_READ_TOOL_ALLOWLIST`, else `not_read_only`. Registered as its own MCP server into operator-root Claude/Codex hosts only. | No. Its whole gate is "this surface cannot write". The bot's purpose is to write, and the requirement puts its tools on the Viewer MCP. |
| `src/lib/telegram/sessionStore.ts` | Owner-only secret files under `<state>/telegram/` (0700 dir, 0600 files, symlink/uid/mode fence, atomic tmp+fsync+rename): `atomicSecretWrite`, `readSafeJson`, `removeSafeFile`, `ensureTelegramStateDir` | **Yes**: the token file uses exactly this. |
| `src/lib/telegram/contracts.ts` | Browser-safe payload types; sanitized error-code vocabulary | Pattern reused in a sibling `bot/contracts.ts`. |
| `src/app/api/telegram/route.ts` | Status GET + action POST, `rejectCrossOrigin`, sanitized payloads only | Pattern reused in `/api/telegram/bot`. |
| `src/components/TelegramConnect.tsx` (`TelegramPanel`, opened from `TelegramFooterRow` in `LimitsFooter`) | The Telegram panel: personal login, API credentials, Daily Reports | **Yes**: the bot gets a section in this panel. |
| `src/lib/viewerInstrumentation.ts` | Starts the Telegram connector boot and report scheduler in the release that owns traffic | **Yes**: the bot's update poller starts here too. |
| `src/lib/agent/operatorAuthority.ts` | `callerConversationId(request)` resolves the calling agent from the forwarded spawn capability; `requireOperatorAuthority` refuses any caller that names itself as an agent | **Yes**: attribution of sends, and the fence that keeps agents from editing their own allowlist. |
| `src/lib/mcp/server.ts`, `bindings.ts` | `MCP_TOOL_NAMES`, `TOOL_INPUT_SCHEMAS` (zod, `clientRequestId` on every call), `TOOL_DESCRIPTIONS`, `MUTATING_MCP_TOOL_NAMES` (durable receipts), bindings that reach the Viewer through `viewerControlForCall` with `callerCapabilityHeaders()` | **Yes**: three new tools follow this exact path. |
| `bun:sqlite` via `process.getBuiltinModule` + `openCurrentDatabase` (`src/lib/runtime/handoffQueueStore.ts`) | Durable local tables | **Yes**: the received-message store. |

Prior work: `search_transcripts` (project-scoped, then unscoped; "telegram bot
token BotFather", "bot api getUpdates privacy mode group", "telegram connector
read-only send message write tools", "Telegram bot Delegatus team group
reports", and a Ukrainian phrasing) found no earlier bot-account design in this
project. The one relevant hit is the 2026-08-20 architecture note for the
personal connector (#1059). That note deliberately scoped the connector to a
read-only surface for operator-root sessions only, and main still enforces that
(`connector.ts`, `telegram.readOnlyNote`). An unrelated project's transcript
recorded a bot answering `409 Conflict` because another instance was already
polling the same token. The intake design below plans for that failure.

## Decision 1 — transport: the Bot API over HTTPS, called from the Viewer

Two options, as the requirement names them.

**A. Telethon bot login over MTProto**, in the vendored Python environment.

- Needs `api_id`/`api_hash`. A bot token alone is not enough for MTProto, so
  an operator who only has a BotFather token hits the same credentials step the
  personal connector makes them do (#1070).
- Needs the provisioned Python venv (`ensureConnectorProvisioned`) and a second
  supervised process, with its own pid identity, lock and generation checks
  (`connector.ts` is ~550 lines of exactly that).
- Stores a second secret, the MTProto session string, next to the token.
- Gains no history. A bot cannot read chat history over MTProto either, so the
  local store is needed on both paths.
- The vendored connector's tool surface is gated read-only and registered as a
  separate MCP server. Neither matches this requirement, so option A would
  still mean new Python code, while every consumer is TypeScript.

**B. The Bot API (`https://api.telegram.org/bot<token>/<method>`)**, called
with `fetch` from the Viewer process.

- The token is the only credential, with no api_id/hash and no venv.
- `getMe` answers exactly the facts the requirement surfaces:
  `can_read_all_group_messages` ("True, if privacy mode is disabled for the
  bot. Returned only in getMe"), `can_join_groups`, name and username.
- `getUpdates` long polling needs no public URL. That matters because
  Delegatus binds to loopback.
- A fake transport is a single function port, so tests need no network.
- Costs, all handled below: one consumer per token (`409 Conflict`), no polling
  while a webhook is set, and "updates … will not be kept longer than 24 hours".

**Choice: B.** It adds no process, no Python and no second secret, and the
transport sits behind a one-method port, so switching later means rewriting one
file. The choice is easy to reverse, so it gets no ADR.

Bot API facts were checked against the live documentation on 2026-09-24 (Bot
API 10.3, dated 2026-08-24): the `getUpdates` notes (24-hour retention, "will
not work if an outgoing webhook is set up", an update is confirmed "as soon as
getUpdates is called with an offset higher than its update_id", the default
`allowed_updates` excludes only `chat_member`, `message_reaction` and
`message_reaction_count`), `sendMessage` (`message_thread_id`,
`reply_parameters`, `parse_mode`, `link_preview_options`,
`disable_notification`, text 1–4096 characters after entity parsing),
`ResponseParameters` (`migrate_to_chat_id`, `retry_after`), `Chat.is_forum`,
and `Update.my_chat_member`. Privacy-mode and rate-limit wording comes from
`core.telegram.org/bots/features` and `/bots/faq` (quoted under
[Limits](#limits-surfaced-honestly)).

## Decision 2 — secret storage: the existing owner-only credential file

The token is stored the way the personal session is. Delegatus has no keyring
path today; the `gh`/Copilot keyring is a third-party tool's own store. So the
requirement's "existing credential file pattern" option is the one that exists.

- **`<state>/telegram/bot-token.json`** (0600, in the fenced 0700
  `<state>/telegram/`), written with `atomicSecretWrite` and read with
  `readSafeJson`: `{ version: 1, botId, token, savedAt }`. This file is the
  token's only home at rest.
- The personal connector's `deleteTelegramSession` removes named files only
  (`session.json`, `connector-token`, `incoming_feed*.jsonl`), and
  `clearTelegramReports` removes its own files. The `bot-` prefix keeps the two
  accounts' files disjoint, so removing either account leaves the other
  untouched.
- The token lives in one module, `src/lib/telegram/bot/transport.ts`, which
  reads the file and holds the token in a closure. Everything else receives a
  `BotTransport` whose only method is `call(method, params, signal)`. It exposes
  no property, getter or `toJSON` that can reach the token, so
  `JSON.stringify(transport)` and `util.inspect(transport)` show nothing.
- **The URL is the leak.** The Bot API puts the token in the request path, so
  a fetch rejection, a `Response.url` or a logged request would carry it. The
  production transport catches every fetch failure and returns only a code
  (`network_failed`, `timed_out`). It never logs a URL or rethrows an error
  object. It passes Telegram's `description` through with every occurrence of
  the token replaced by `[token]` and cut to 300 characters. Descriptions do
  not contain the token; the replacement guards a future vendor change.
- The inbound path is `POST /api/telegram/bot {action:"connect", token}`. The
  browser keeps the field in a ref (as the panel does for the 2FA password) and
  clears it before the request resolves. No response ever carries it back.
  Validation shape: `^\d{5,20}:[A-Za-z0-9_-]{30,64}$`, checked before any
  network call. The part before the colon is the public bot id; that is the
  only part stored outside the token file.
- Tests build an obviously fake sentinel at runtime (a short numeric id, a
  colon, and a filler string spelling out that it is fake), so the test source
  holds no token-shaped literal. The privacy gate already flags credential
  idioms. No real token appears in fixtures, evidence or the PR.

## Decision 3 — state and store

Everything non-secret goes into one SQLite file,
**`<state>/telegram/bot.sqlite`**, created 0600 before its first open. SQLite
gives `-wal` and `-shm` files the database file's mode. The file is opened with
the `handoffQueueStore.ts` pattern (`process.getBuiltinModule("bun:sqlite")`,
`openCurrentDatabase`, WAL). Nothing opens it at module load. It is opened only
when a token file exists, so `bun run build` and route imports never touch it
(#1905).

```sql
bot      (singleton row) bot_id, name, username, can_read_all_group_messages,
                         can_join_groups, connected_at, receiving, receiving_code,
                         last_update_at, last_checked_at
chats    chat_id TEXT PK, type, title, username, is_forum, bot_status,
                         alias UNIQUE NULL, post_allowed INTEGER, first_seen_at,
                         last_message_at, last_post_at, last_post_conversation_id
messages chat_id, message_id, PRIMARY KEY (chat_id, message_id),
                         direction ('in'|'out'), date, edited_at, from_id, from_name,
                         from_username, kind, text, reply_to_message_id, topic_id,
                         sent_by_conversation_id NULL
sends    caller_key, client_request_id, PRIMARY KEY (caller_key, client_request_id),
                         state ('pending'|'sent'|'failed'), chat_id, message_ids,
                         error_code, created_at
```

Chat ids are stored as decimal strings because Telegram ids are 64-bit. This
matches `validTelegramAccountId` in `contracts.ts`.

## Decision 4 — update intake and retention

**One poller per process, in the release that owns traffic.**
`viewerInstrumentation.ts` starts `ensureTelegramBotPoller()` beside the report
scheduler, in its own try/catch so a failure cannot stop the other controllers.
A successful `connect` starts it too. It is a `globalThis` singleton, the
`reportRunner.ts` pattern, because route bundles and instrumentation can load
separate module copies.

Loop:

1. `getUpdates { offset, timeout: 50, allowed_updates: ["message",
   "edited_message", "channel_post", "edited_channel_post", "my_chat_member"] }`,
   with an `AbortController` that `remove` fires.
2. Apply the batch in **one** SQLite transaction (`applyUpdates`, a pure
   function of `(db, updates, now)`, so tests drive it directly):
   - a `message`/`channel_post` upserts its chat (type, title, username,
     `is_forum`, `last_message_at`) and inserts the message with
     `INSERT OR IGNORE`;
   - an `edited_*` updates `text` and `edited_at` in place;
   - `my_chat_member` sets `bot_status` from `new_chat_member.status`
     (`member`, `administrator`, `left`, `kicked`, `restricted`) and creates the
     chat if it is new;
   - a `migrate_to_chat_id` service message moves the chat row, its alias,
     allowlist flag and messages to the supergroup id;
   - text is `text ?? caption`. A message without either stores `kind`
     (`photo`, `document`, `sticker`, `voice`, …, taken from which field is
     present) and `text: null`. Media is not downloaded.
3. Only after the commit, the next call uses `offset = max(update_id) + 1`. A
   crash between the commit and that call redelivers the batch, and the upserts
   are idempotent, so **no offset is persisted**: Telegram's confirmed offset
   is the cursor.
4. A chat seen for the first time without a `my_chat_member` event (the bot
   was added before Delegatus connected) gets one
   `getChatMember(chat_id, bot_id)` so its visibility is known.

**Failures map to one `receiving` state**, shown in the panel and in
`telegram_bot_chats`:

| Bot API answer | `receiving` | Poller |
| --- | --- | --- |
| ok | `polling` | continue |
| 409 while a webhook is set (`getWebhookInfo().url` non-empty) | `webhook_elsewhere` | stop; recheck on the panel's Refresh |
| 409 otherwise ("terminated by other getUpdates request") | `another_reader` | back off 30 s, retry |
| 401 | `token_rejected` | stop; the token needs replacing |
| 429 | `polling` | sleep `retry_after` |
| network / 5xx | `network_error` | back off 5 s → 60 s, retry |

`another_reader` is expected for a few seconds during a release succession,
when the old and new generation both poll, and clears on its own. It stays set
when some other program uses the same token. The panel then says so and names
the fix: stop the other program, or give Delegatus its own bot. A dev Viewer
sharing the operator's state directory shows the same flapping. Both
generations write the same idempotent store, so nothing is lost or duplicated.

A webhook set by another service is **never deleted automatically**. Deleting
it would silently break whatever uses it. The bot can still post in that state,
and the panel says reading is blocked and why.

**Retention.** After each committed batch, per touched chat: keep the newest
2 000 messages and nothing older than 30 days. Outgoing rows count toward the
same bound. `remove` deletes `bot.sqlite` with the token. Like the personal
feed (#1091), a record of the bot's correspondents does not outlive the
credential.

**Backlog on connect.** The first `getUpdates` delivers whatever Telegram
still holds, which is at most 24 hours. Chats active in that window appear
immediately.

## Decision 5 — chats and the allowlist

- A chat appears once the bot has evidence of it: a message it could see, or a
  `my_chat_member` change such as being added, promoted or removed. The Bot API
  cannot list a bot's chats. So in a privacy-mode group where nobody has written
  anything the bot can see, the panel's hint asks the operator to mention the
  bot there once (for example `/start@<botname>`).
- **Posting is allowed only when the operator has set `post_allowed` *and* an
  alias.** The alias is how agents name the chat. It is lowercase, 1–32
  characters, `[a-z0-9][a-z0-9_-]*`, and unique. The panel suggests one from the
  title (for example `team-reports`).
- **Only the operator edits the allowlist.** `POST /api/telegram/bot` passes
  `rejectCrossOrigin` and then `requireOperatorAuthority`. A caller presenting
  an agent capability gets 403, so an agent cannot widen its own reach. No MCP tool writes the allowlist.
- A chat whose `bot_status` is `left` or `kicked` keeps its row and alias
  (re-adding the bot restores posting) but refuses posts with `bot_not_in_chat`.
  The panel lists such chats greyed out under "no longer a member".
- Private chats (a user wrote to the bot) appear like any other chat and can be
  allowlisted the same way.

**Visibility per chat** (`seesAllMessages`, and a one-line reason):

| Chat type | Sees all messages when | Otherwise |
| --- | --- | --- |
| `private` | always | — |
| `group` / `supergroup` | `can_read_all_group_messages` (privacy off) **or** `bot_status = administrator` | only commands to it, replies to it, and messages via it |
| `channel` | the bot is in the channel (a bot joins a channel only as an admin) | — |

`can_read_all_group_messages` is re-read with `getMe` on connect and on the
panel's Refresh. Telegram applies a privacy change to a group only after the
bot is re-added, so for a non-admin group chat first seen before the flag
turned on, the reason line adds "re-add the bot to apply".

## Decision 6 — the MCP tools

Three tools on the Viewer MCP (`mcp__viewer__*`), following main's conventions:
snake_case names, `clientRequestId` on every call, compact answers, and inputs
clamped to their bounds wherever a clamp keeps the call meaningful. Each
binding reaches the Viewer through `viewerControlForCall(...)` with
`callerCapabilityHeaders()`, so stdio and `/api/mcp` callers behave
identically, and the Viewer is the only process that holds the token. The tools
are on every agent's surface (the B+ policy in `toolAllowlist.ts`). The
operator's allowlist is the control.

Every answer carries `limits`: the three sentences under
[Limits](#limits-surfaced-honestly), plus the per-chat reason where a chat is
named. Answers never contain the token, the bot id or a Telegram user id. They
contain names, usernames and chat ids, which the bot already shows to anyone in
those chats.

### `telegram_bot_chats` (read)

```ts
input:  { clientRequestId: string, includeInactive?: boolean /* left/kicked chats; default false */ }
answer: {
  bot: { connected: boolean, name: string | null, username: string | null,
         receiving: "polling" | "webhook_elsewhere" | "another_reader" | "token_rejected" | "network_error" | "stopped",
         receivingNote: string | null, lastUpdateAt: string | null },
  chats: Array<{
    chat: string,              // alias when set, else chatId — the value the other tools accept
    chatId: string, alias: string | null, title: string, type: "private" | "group" | "supergroup" | "channel",
    isForum: boolean, member: boolean,
    postAllowed: boolean, postRefusal: string | null,   // why not, in words, when postAllowed is false
    seesAllMessages: boolean, visibilityNote: string,
    lastMessageAt: string | null, storedMessages: number,
  }>,
  limits: string[],
}
```

Ordered by the newest `last_message_at`, capped at 200 chats with a
`truncated` count. When no bot is connected the answer is still `ok`, with
`connected: false`, an empty list and a note naming the panel. That follows the
clamp-over-reject convention.

### `telegram_bot_send` (mutating, durable receipt)

```ts
input: {
  clientRequestId: string,
  chat: string,                    // alias or chatId from telegram_bot_chats
  text: string,
  format?: "plain" | "html",       // default plain; html = Telegram's HTML subset
  replyToMessageId?: number,       // → reply_parameters { message_id, allow_sending_without_reply: true }
  topicId?: number,                // → message_thread_id (forum topics)
  silent?: boolean,                // → disable_notification
}
answer: { chat: string, chatId: string, messageIds: number[], sentAt: string,
          attributedTo: { conversationId: string } | { unidentified: true }, parts: number }
```

- **Allowlist refusal** comes before any network call, as a non-retryable
  failure with a code and a sentence: `chat_unknown` ("no chat named X; list
  them with telegram_bot_chats"), `chat_not_allowed` ("the operator has not
  allowed posting to <title>; ask them to allow it in the Telegram panel"),
  `bot_not_in_chat`, `bot_not_connected`.
- **Attribution.** The Viewer route resolves the caller with
  `callerConversationId(request)` from the forwarded capability, never from an
  argument. The conversation id is written on the `sends` row, on every
  outgoing `messages` row (`sent_by_conversation_id`), and on the chat's
  `last_post_conversation_id`. A caller with no capability (an operator lane
  started outside Delegatus) is still allowed and is recorded as
  `unidentified`. The requirement asks for attribution and names no refusal
  for an unattributed caller.
- **Idempotency.** `telegram_bot_send` joins `MUTATING_MCP_TOOL_NAMES`, so a
  replay inside the MCP layer returns the stored receipt. The Viewer
  additionally keys `sends` by `(callerKey, clientRequestId)`. A repeat of a
  `sent` row returns the stored message ids and does not post again. A repeat
  of a row still `pending` (the Viewer died mid-send) answers `send_uncertain`,
  non-retryable, because Telegram has no idempotency key and the bot does not
  receive its own messages to check. Posting twice into a team group is the
  worse failure.
- **Length.** Plain text over 4 096 characters is split at paragraph, then
  line, then character boundaries into at most 4 parts (16 384 characters), sent
  in order. Only the first part carries `replyToMessageId`; every part carries
  `topicId`. Longer text is refused with `text_too_long`. HTML over
  4 096 is refused with `text_too_long` ("send plain or split it"), because a
  split can cut a tag.
- **Telegram's own refusals** map to codes, with the sanitized description in
  the error text: 400 entity-parse → `format_invalid`; 403 → `forbidden` (the
  bot was blocked, removed, or never messaged by that user; this is where "a
  bot cannot start a chat with a user who never wrote to it" surfaces); 429 →
  `rate_limited`, retryable, with `retryAfterSeconds`; a `migrate_to_chat_id`
  response moves the chat row and retries once; network → `network_failed`,
  retryable.
- The sent message is stored as an `out` row, so `telegram_bot_messages` shows
  the conversation both ways. The bot does not receive its own messages as
  updates.

### `telegram_bot_messages` (read)

```ts
input:  { clientRequestId: string, chat: string, limit?: number /* 1..100, default 20, clamped */,
          cursor?: string, since?: string /* ISO, inclusive */, maxChars?: number /* 1..4000, default 1000 */ }
answer: {
  chat: { chat, chatId, alias, title, type, seesAllMessages, visibilityNote },
  messages: Array<{
    messageId: number, date: string, editedAt: string | null, direction: "in" | "out",
    from: { name: string, username: string | null } | null,   // null for channel posts and outgoing
    kind: "text" | string, text: string | null, truncated: boolean,
    replyToMessageId: number | null, topicId: number | null,
    sentBy: { conversationId: string } | { unidentified: true } | null,     // outgoing only
  }>,
  nextCursor: string | null, hasMore: boolean,
  storedSince: string | null,   // oldest stored row: nothing older exists locally
  limits: string[],
}
```

Newest first, ordered by `(date DESC, message_id DESC)`. The cursor is the
opaque base64url of the last row's `(date, message_id)` pair, which stays
stable while new messages arrive. Reading is not limited to allowlisted chats:
the requirement says agents read "the messages the bot sees", and the
allowlist governs posting. `text` passes through the MCP layer's existing
`redactPayload` like every other answer.

## Decision 7 — Viewer routes

- **`/api/telegram/bot`**, the operator surface for the panel. `GET` returns a
  `TelegramBotStatusPayload` (bot name, username, `receiving`, chats with
  alias, allowlist flag, visibility, and the last post time with the posting
  conversation's title from the registry). It has no token and no bot id.
  `POST` accepts `connect {token}`, `refresh`, `chat {chatId, alias,
  postAllowed}` and `remove`. Every POST passes `rejectCrossOrigin`, then
  `requireOperatorAuthority`.
  - `connect` validates the token's shape, calls `getMe` and requires
    `is_bot: true`, calls `getWebhookInfo`, then writes the token and starts the
    poller. A token for the **same** `bot_id` as the stored one replaces it and
    keeps the chats and allowlist; this is the path after `/revoke` in
    BotFather. A different bot while one is connected is refused with
    `bot_already_connected` ("remove the current bot first").
  - `remove` aborts the poller, then deletes `bot-token.json` and
    `bot.sqlite`. It is local only: Delegatus does not call `logOut`, which
    only moves a bot to a local Bot API server. The panel says to revoke the
    token in BotFather to invalidate it at Telegram.
- **`/api/telegram/bot/agent`**, the agent surface the three bindings call.
  `GET ?op=chats`, `GET ?op=messages&chat=…`, and `POST {op:"send", …}` for the
  send, attributed with `callerConversationId(request)`. It returns the answer
  bodies above.

## Decision 8 — the panel

A **Bot** section in the existing `TelegramPanel`, below the personal account.
The panel opens from the footer's Telegram row. Personal-account content,
Daily Reports stay as they are. The header's `telegram.readOnlyNote` ("Read-only
· operator sessions only") would now sit above a section that writes, so it
moves from the header to the top of the personal-account section with its
string unchanged. That is the one visible change to the personal side.

- **Not connected:** a password-type input "Bot token from @BotFather", a
  Connect button, and one line of help (create a bot in @BotFather with
  `/newbot` and paste the token it gives you).
- **Connected:** a status dot and the bot's name and `@username`, the
  `receiving` state in words (for example "Receiving messages", "Another
  program is reading this bot's updates", "This bot delivers to a webhook
  elsewhere: Delegatus can post but not read", "Telegram rejected the token:
  paste a new one"), Refresh, and Remove. Remove confirms inline: two taps, no
  modal.
- **Chats list:** one row per chat with the title, a type chip, the
  visibility line ("Sees all messages" / "Sees only mentions and replies:
  privacy mode is on"), an alias input and an "Agents may post" switch. The
  switch is disabled until an alias is set, and the row says so. Below: the
  last post time and the posting conversation's title. A collapsed "No longer
  a member (n)" group holds left and kicked chats.
- **Limits:** the three sentences, as one collapsed "What a bot can see" note,
  plus the mention-the-bot hint when the list is empty.
- The panel keeps its current geometry: `w-[min(320px,calc(100vw-16px))]`,
  fixed to the bottom on phone and anchored beside the footer on desktop,
  `max-h` with inner scroll. Chat rows stack vertically (title and chips, then
  alias and switch), so nothing sits side by side below 320 px. Targets are at
  least 44 px on phone, as the existing buttons are.
- Strings live in `src/lib/i18n/en.ts` and `uk.ts` under `telegram.bot.*`.

## Limits surfaced honestly

These exact sentences go in every tool answer's `limits` and in the panel note.
Each rests on a verified source.

1. "A bot sees only messages sent after it joined a chat. Telegram holds
   undelivered updates for at most 24 hours, and Delegatus keeps what it
   received since the bot was connected." (Bot API `getUpdates`: "will not be
   kept longer than 24 hours"; bots have no history method.)
2. "In groups, a bot with privacy mode on sees only commands, replies and
   messages meant for it. It sees everything when it is an admin, or when
   privacy mode is turned off in @BotFather and the bot is then re-added to the
   group." (`/bots/features`: "bot admins always receive all messages"; "the
   bot will need to be re-added to the group for this change to take effect".)
   "Bots never see messages from other bots." (`/bots/faq`, verbatim.)
3. "A bot cannot start a chat with a user who never wrote to it." This comes
   from the requirement and is enforced by Telegram, which answers such a send
   with 403. The implementation maps every 403 to `forbidden` with Telegram's
   description, so the check does not depend on the wording.

Rate limits (`/bots/faq`: about one message per second per chat, 20 per minute
per group) are not pre-enforced. Telegram's 429 is returned with its
`retry_after`.

## What stays unchanged

The personal connector's files, its verified read-only tool surface, its host
registration, `session.json`/`connection.json`/feeds, `/api/telegram`, the
Daily Report runner, schedule and prompt, and the `TelegramFooterRow` trigger
are untouched. The only shared file the bot changes is `TelegramConnect.tsx`,
which renders one more section and moves the read-only note into the personal
section. The existing `TelegramConnect.render.test.tsx`
and `TelegramConnect.dom.test.tsx` must pass unchanged, with an unconnected bot
status injected.

## Implementation plan (one slice)

New:

- `src/lib/telegram/bot/contracts.ts`: browser-safe payloads, the chat view,
  error codes, `validBotToken`, `validChatAlias`, the three limit sentences.
- `src/lib/telegram/bot/transport.ts`: the `BotTransport` port, a production
  `fetch` transport with the token closed over and every error reduced to a
  code, and token file read/write/remove over `sessionStore`'s fence.
- `src/lib/telegram/bot/store.ts`: `bot.sqlite` schema, `applyUpdates`,
  retention, chat and allowlist edits, message paging, `sends` rows.
- `src/lib/telegram/bot/service.ts`: `connect`, `refresh`, `setChat`,
  `remove`, `status`, `listChats`, `readMessages`, `send`; the poller;
  `ensureTelegramBotPoller`; a `globalThis` singleton with a test seam
  (`setTelegramBotServiceForTests`, as `service.ts`).
- `src/app/api/telegram/bot/route.ts` and
  `src/app/api/telegram/bot/agent/route.ts`.
- `src/hooks/useTelegramBot.ts` and `src/components/TelegramBot.tsx`, the
  section rendered by `TelegramPanel`.

Changed:

- `src/lib/mcp/server.ts`: three names in `MCP_TOOL_NAMES`, schemas and
  descriptions; `telegram_bot_send` in `MUTATING_MCP_TOOL_NAMES` with durable
  retention.
- `src/lib/mcp/bindings.ts`: three bindings through `viewerControlForCall` +
  `callerCapabilityHeaders()`.
- `src/lib/viewerInstrumentation.ts`: a `loadTelegramBotPoller` loader beside
  the report scheduler.
- `src/components/TelegramConnect.tsx`: renders `<TelegramBot />`.
- `src/lib/i18n/en.ts`, `uk.ts`; `README.md`'s MCP tool list.

Tests, run **by path**, all against a fake `BotTransport` that records calls
and replays scripted answers, with no network and a temp `LLV_STATE_DIR`:

- `bot/transport.test.ts`: **token never serialised.** `JSON.stringify` and
  `util.inspect` of the transport show no token. A fake `fetch` that rejects
  with an error whose message contains the full request URL yields only
  `network_failed`. A description echoing the token comes back with `[token]`
  in its place. The token file is 0600 and a symlinked file is refused.
- `bot/store.test.ts`: **intake and paging.** Messages, edits, channel posts,
  `my_chat_member` (added, promoted, kicked), group→supergroup migration
  carrying alias and allowlist, a redelivered batch is idempotent, retention
  bounds, newest-first paging with a cursor that stays stable while new rows
  arrive, `since`, and `maxChars` truncation.
- `bot/service.test.ts`: **allowlist refusal** (unknown chat, no alias, not
  allowed, left chat; no transport call in any of them); **send attribution**
  (the conversation id from the resolver lands on `sends`, the `out` message
  and the chat; an unidentified caller is recorded as such); replay of a `sent`
  key does not re-post; a `pending` key answers `send_uncertain`; the 4-part
  split; 403, 429 and migrate mapping; the `receiving` state machine (409
  webhook vs. other reader, 401 stop); `remove` aborts the poller and deletes
  both files; the same-bot token replacement keeps the chats.
- `src/app/api/telegram/bot/route.test.ts`: status and every response contain
  no token (sentinel search over the serialized bodies); an agent capability
  gets 403 on `chat` and `connect`.
- `src/lib/mcp/schemaParity.test.ts` and `server.test.ts`: the three tools are
  in the published surface; every existing assertion stays.
- `TelegramBot.render.test.tsx`: disconnected, connected with mixed chats,
  `webhook_elsewhere`, and `token_rejected`, rendered to static markup;
  the input carries no value attribute.

Verification before the PR:

- `bunx tsc --noEmit` logged to a file with `$?` appended.
- The touched test files by path.
- `bun run build` with `LLV_STATE_DIR` and `XDG_CONFIG_HOME` pointed at a temp
  directory.
- `bun scripts/privacy-publication-gate.ts --base <merge-base>`.
- Renders: add one `describe` case to the phone evidence driver
  (`src/components/mobile/issue1671Evidence.browser.test.tsx`, which serves
  the real Viewer fixture); no new driver. The case renders the panel
  at 390×844 and 430×932 in light and dark, plus one desktop viewport
  (1440×900), for the disconnected, connected-with-chats and blocked-reading
  states, from fixture data with invented bot and chat names. It writes PNGs
  to `~/Pictures/delegatus-review/telegram-bot/` and reports overflow, clipped
  controls and overlap numerically.

## Validation against the requirement

| Requirement | Where |
| --- | --- |
| Paste a token, see name and status, remove it | Decisions 7 and 8 |
| Token stored like other credentials; never logged, in browser payloads, transcripts or MCP answers | Decision 2 (owner-only file, closure-held token, URL-leak handling, sentinel tests) |
| Bot learns the chats it is added to | Decision 4 (`my_chat_member`, messages, `getChatMember`) |
| Operator allowlist with aliases; outside it refused with a clear reason | Decision 5, `telegram_bot_send` refusals, operator-only edits |
| List chats: alias, type, posting allowed, sees all messages | `telegram_bot_chats` |
| Send plain or safe formatting, reply-to, forum topic, to an allowed chat, attributed to the calling conversation | `telegram_bot_send` |
| Read recent received messages: bounded, paged, newest first, stored locally | Decision 4 + `telegram_bot_messages` |
| Honest limits in UI and tool answers | [Limits](#limits-surfaced-honestly), `limits` on every answer, panel note |
| Personal connector and reports unchanged | [What stays unchanged](#what-stays-unchanged) |
| Transport choice with reasons | Decision 1 |
| Fake transport, no network in tests; renders; tsc; build isolated; no real token | Implementation plan |

## Deferred — not currently justified

- **Daily Report delivery into a bot chat.** The quote's example ("so reports
  go to a team group") is met by the tool: a report or any agent calls
  `telegram_bot_send` with the alias. A report-settings option that posts the
  finished report automatically changes the reports path, which the
  requirement says stays unchanged. File it as a follow-up if the operator
  wants it without an agent step.
- **Media**: downloading received photos and files, and sending files, photos
  or polls. Not asked for, and it brings size limits and storage.
- **Taking over from a webhook** (`deleteWebhook` from the panel). Automating
  that would break another deployment silently. Manual removal is one BotFather
  or curl step, and the panel explains it.
- **Adding a chat by id or @username** before the bot has seen it. The mention
  hint covers the privacy-mode case at no cost.
- **A read fence per chat.** The requirement gives agents the bot's inbox; the
  allowlist is for posting only.
- **Multiple bots.** The requirement says "a Telegram BOT". The store has one
  bot row; a second bot would add a bot key to every table.
- **Reacting, editing or deleting sent messages; inline keyboards; commands
  the bot answers by itself.** Each is a separate agent capability that no one
  has asked for.
- **Surfacing incoming bot messages as wakes for an agent or orchestrator.**
  Reading is pull-only through `telegram_bot_messages`; a push path belongs in
  its own design.
- **A keyring store for either Telegram credential.** Both stay on the one
  fenced file pattern; moving them together would be its own change.
