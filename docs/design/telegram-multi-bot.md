# Telegram: several bots, each send through a bot that is in the chat

Status: design, the first step of the lane. Grounded in `main` at
`f335de650` (2026-10-20). `origin/main` had not moved when this was written,
and no open pull request or lane touches the files named here (checked with
`gh pr list` and `list_pipelines` on 2026-10-20). The prototype-review
`no_target` diagnostics named in the task's fences landed as #3136
(`f335de650`), which this design builds on and keeps.

## Originating requirement

Recorded on the board task on 2026-10-20. The request came from the operator
through a decision form in a partner project and was relayed by that project's
orchestrator; the operator then answered this project's own form the same day,
taking every recommended option. The task instructs that the operator's own
wording stays out of published files, so this document quotes the task's
English record of the request and of the answers:

> Several Telegram bots: send with a bot that is in the target chat, fall back
> to another on refusal
>
> Operator's answers in this project's form (2026-10-20, all recommendations):
> design first, then build; membership learned by asking Telegram directly per
> bot and chat, cached and re-checked after a refusal; try the bot assigned to
> the chat/project first, then any other connected bot that is in the chat and
> may post; if none can, the report stays in Delegatus and the chat's card
> shows the reason and which bot was refused.
>
> Trigger: the installation's bot was kicked from a partner supergroup; report
> copies there answer code=forbidden «bot was kicked from the supergroup chat».
> telegram_bot_chats lists one connected bot whose updates go to a webhook set
> by another program (receiving: webhook_elsewhere), so Delegatus never sees
> membership changes and shows stale member:true.
>
> Acceptance:
> 1. Design step first (written to docs/design/telegram-multi-bot.md): observe
>    how bots are connected today (UI, store, service, MCP tools), whether more
>    than one bot can be connected, and state it with file:line; then the
>    model: bots[], per (bot, chat) membership with can-post and topic rights,
>    how it is checked (Bot API getChatMember/getChat with each bot's own
>    token), cached with an expiry and re-checked after a refusal; the
>    selection order; fallback on refusal kinds (forbidden/kicked, not enough
>    rights, chat not found) and NOT on ambiguous network failures that may
>    have delivered; idempotency so one logical message is never delivered
>    twice by two bots; what each send records (which bot delivered or every
>    bot's refusal). If the UI cannot connect several bots today, the design
>    adds the minimal way to connect, list and remove additional bots in the
>    existing Telegram settings surface (no new screens if an existing control
>    fits).
> 2. Build: bridge-report copies, telegram_bot_send/send_document/send_media,
>    report topics and prototype-review posts all go through the same
>    selector; the owner's private chat keeps working as today;
>    telegram_bot_chats shows per chat which connected bots are members and
>    can post.
> 3. When no connected bot can post, the send answers with the per-bot reasons
>    (codes as #3135 made visible), and the chat's card in the UI shows the
>    reason and which bot was refused.
> 4. Tests with a fake transport for: assigned bot in chat; assigned bot kicked
>    → second bot delivers once; both refused → stored with reasons; ambiguous
>    failure → no fallback resend; membership cache expiry and refresh after
>    refusal.
> 5. No live Telegram sends from tests or stages; no bot tokens in logs,
>    commits or reports. The project's own checks (typecheck, lint on changed
>    files, privacy gate, the hook's touched-test gate) pass.

**Should this be built?** Yes. Delegatus can hold one bot today (below), so a
report to a group that bot was removed from has no second way out, and the
stored membership cannot notice the removal while another program owns the
bot's updates. Both halves of the request (several bots, and knowing which bot
sits in which chat) are absent from the code. What the requirement does not
need is listed under [Deferred](#deferred--not-currently-justified).

## What exists today

### One bot can be connected, and only one

| Where | What the code does |
|---|---|
| `src/lib/telegram/bot/store.ts:239-250` | The `bot` table is a singleton: `id INTEGER PRIMARY KEY CHECK (id = 1)` (line 240). `bot()` reads row 1 (`:357-374`) and `saveIdentity` upserts row 1 (`:378-391`). |
| `src/lib/telegram/bot/transport.ts:147-159` | One token file, `<state>/telegram/bot-token.json`, holding one `{ version, botId, token, savedAt }` (`:153`). `withStoredBotToken` hands that one token to its consumer (`:165-171`). |
| `src/lib/telegram/bot/service.ts:90-97` | The service's dependencies save one token (`saveToken(token, botId, now)`, line 94), read one (`withStoredToken`, 95) and remove one (`removeToken`, 96). |
| `src/lib/telegram/bot/service.ts:316, 377-385` | One cached transport, built from the one stored token. |
| `src/lib/telegram/bot/service.ts:512-537` | `connect` refuses a second bot: a token whose bot id differs from the stored one answers `bot_already_connected` "remove the current bot first" (`:519-522`). The same bot's token replaces itself. |
| `src/lib/telegram/bot/service.ts:662-673` | `remove` deletes the token and the whole store file (chats, aliases, messages, sends). |
| `src/app/api/telegram/bot/route.ts:55-60, 75-76` | The operator route has `connect` and `remove` with no bot argument. |
| `src/components/TelegramBot.tsx:376-380, 397-399` | The panel shows the token field only while no bot is connected, or again when the one bot's token was rejected. The header shows one bot (`:383-391`); one Remove button (`:445-458`). |
| `src/lib/keys/store.ts:46-51, 59-65` | The Keys page writes and reads the same single token through the same `connect`. |
| `src/lib/externalRelay/telegramPublication.ts:11-12, 21-26` | "There is one connected bot in the Telegram store." Relay publication answers a target only for the stored bot id. |
| `docs/design/telegram-bot-account.md:753-754` | The original design deferred multiple bots: "The store has one bot row; a second bot would add a bot key to every table." |

**Conclusion:** the UI, the route, the service and the store each allow exactly
one connected bot; a second token is refused. Acceptance 1 asks whether more
than one bot can be connected today: no, so this design adds the way to
connect, list and remove more (acceptance 1's last sentence).

Two records already carry a bot id and need no change of key:
`relay_outbound` is keyed `[botId, chatId, messageId]`
(`src/lib/telegram/bot/outbound.ts:20, 55-59`), and report replies keep their
`botId` (`store.ts:105`).

### Membership is one status per chat, and it goes stale

- `chats.bot_status` holds one status per chat (`store.ts:257`), the
  connected bot's.
- It is written from `my_chat_member` updates (`store.ts:451-457`), from a
  private message (`:434`), from `getChatMember` only while the status is still
  unknown (`service.ts:754-759`, `onlyIfUnknown`), and when the operator adds a
  chat by id (`service.ts:609-615`).
- Every one of those writers but the last needs the update poller. When
  another program holds the bot's webhook, `getUpdates` answers 409, the
  service records `webhook_elsewhere` and the poller stops
  (`service.ts:765-769`). From then on nothing re-reads the status.
- Readers: the pre-send refusal (`postRefusal`, `service.ts:185-196`), the
  agents' chat list filter (`service.ts:842`), the panel's active/inactive
  split (`TelegramBot.tsx:358-359`) and the history publication guard
  (`outbound.ts:245-253`).

Live observation, read-only, 2026-10-20 evening (UTC), through
`telegram_bot_chats` with `includeInactive: true`: one bot, `receiving:
webhook_elsewhere`, `lastUpdateAt: null`, five chats, every one `member: true`
and `postAllowed: true`, including the supergroup whose report copies answer
`forbidden` "bot was kicked from the supergroup chat". This is the stale
`member: true` the task names.

### Every send path uses that one bot

| Caller | Route into the service | Chat |
|---|---|---|
| Bridge-report copy (`src/lib/mcp/bindings.ts:3956-3976`, `:3989-4009`) and its replay (`:3788-3792`) | Viewer agent route `op: "send"` (`src/app/api/telegram/bot/agent/route.ts:48-78`) → `send` (`service.ts:902-1008`), silent HTML, with the project's `topicId` | the project's chosen chat (`src/lib/projects/settings.ts:44-52, 251-254`; `bindings.ts:3817, 3862-3864`) |
| `telegram_bot_send` / `_send_media` / `_send_document` (`bindings.ts:5317, 5346, 5368`) | the same agent route → `send` / `sendMedia` (`service.ts:1164-1263`) / `sendDocument` (`:1270-1347`) | any allowlisted chat |
| Seat authentication incidents (`src/lib/monitor/seatAuthRecovery.ts:100-108, 151-161`) | `send` directly | the project's chosen chat |
| Prototype-review post (`src/lib/prototypeReview/telegramPost.ts:152-155`) | `sendOwnerReview` (`service.ts:1012-1051`) → `sendRich` (`:1061-1160`) | the paired owner's private chat (`src/lib/externalRelay/ownerDestination.ts:14-41`) |
| Review polls under that post (`service.ts:1043-1048`) | the same transport | the same private chat |
| Operator's test post (`service.ts:637-657`) | direct | an allowlisted chat |
| Sign-in replies (`service.ts:791-805`) | direct, inside the poller | private chats |

Each takes `this.transport()`, the one cached transport.

### Refusals and ambiguous outcomes today

- `sendFailure` (`service.ts:249-268`) maps Telegram's answer to a code: 403 →
  `forbidden`; 401/404 → `token_rejected`; 429 → `rate_limited`; a 400 that
  names HTML parsing → `format_invalid`; 5xx → `telegram_failed`; every other
  400 → `bad_request`. So "chat not found" and "not enough rights" both arrive
  as `bad_request` today.
- The transport separates outcomes (`transport.ts:22-31, 118-137`):
  `unreachable` proves nothing left the machine; `network_failed` and
  `timed_out` may follow a post Telegram completed; only Telegram's explicit
  `ok: false` envelope is a refusal (`:131-137`).
- An ambiguous outcome keeps the send claim `pending`, so a retry under the
  same key answers `send_uncertain` (`service.ts:983-988`); a definite refusal
  settles it `failed` with no message ids, and the same key may then send
  again (`store.ts:656-669`, rule on line 662).
- A refusal leaves the Viewer route as `{ error, code, retryable }` plus
  selected fields (`src/lib/telegram/bot/http.ts:59-75`); the MCP tools keep
  the bot's own code and `retryable` (`bindings.ts:5317-5344`,
  `src/lib/mcp/server.ts:3489-3491`). #3135 made those codes survive route
  bundles; that is the shape acceptance 3 extends.

### The Bot API facts this design rests on

Read from `https://core.telegram.org/bots/api` on 2026-10-20: HTTP 200,
860 230 bytes, newest "Recent changes" entry August 24, 2026 (Bot API 10.3),
SHA-256 prefix `a2c2b4023612ff03`; tags stripped and read in scratch.

- `getChatMember`: "Use this method to get information about a member of a
  chat. The method is only guaranteed to work for other users if the bot is an
  administrator in the chat." A bot asking about its own id is the case the
  service already uses (`service.ts:611`).
- `ChatMemberAdministrator`: `can_post_messages` "for channels only";
  `can_manage_topics` "for supergroups only". The owner (`creator`) has all
  administrator privileges.
- `ChatMemberRestricted` ("Supergroups only"): `is_member`, and
  `can_send_messages` ("text messages, rich messages, …"),
  `can_send_photos`, `can_send_documents`, `can_manage_topics`.
- `ChatMemberLeft` (`left`) and `ChatMemberBanned` (`kicked`, "can't return to
  the chat or view chat messages").
- `ChatMemberMember` carries no rights of its own; `getChat` returns
  `ChatFullInfo.permissions`: "Default chat member permissions, for groups and
  supergroups", a `ChatPermissions` with the same `can_send_*` and
  `can_manage_topics` fields.
- Error envelopes: "An Integer 'error_code' field is also returned, but its
  contents are subject to change in the future." The documentation lists no
  descriptions. The 403 "bot was kicked from the supergroup chat" is the
  trigger's own observed answer; the other descriptions in the classification
  below are matched by pattern, and a description that matches nothing takes
  the safe branch (no fallback).

## The model

One paragraph first. Delegatus keeps one **receiving bot**: the bot connected
today, unchanged, which polls updates, answers sign-ins, carries the owner's
private chat and the relay publication. Next to it the operator may connect up
to eight **sending bots**, which only post. For every allowlisted chat and
every connected bot, Delegatus stores what Telegram last said about that bot in
that chat (status and rights), asked with that bot's own token, with an
expiry. Every send to a group, supergroup or channel walks an ordered list of
bots: the chat's assigned bot, then the others; it asks Telegram about a bot
whose entry expired, skips a bot known to be unable, and tries the next bot
only after Telegram explicitly refused the previous one for a reason another
bot can fix. An answer that may mean the message went out ends the walk. The
send records which bot delivered, or every bot's reason.

### 1. Bots

- **Receiving bot.** Exactly today's bot: `bot-token.json`, the singleton `bot`
  row, the poller, sign-in, report replies, the Keys page, the relay
  publication target. Nothing about it changes, so a one-bot installation
  behaves as it does now apart from the membership checks in section 2.
- **Sending bots.** Up to eight more. Their tokens live in a second owner-only
  file beside the first, `<state>/telegram/bot-tokens.json`:
  `{ version: 1, bots: [{ botId, token, savedAt }] }`, written with
  `atomicSecretWrite` and read with `readSafeJson` like `bot-token.json`
  (`transport.ts:155-171`). `transport.ts` stays the only module that reads a
  token: it gains `saveSendingBotToken`, `removeSendingBotToken` and
  `withSendingBotTokens(consume)`, which hands each token to `consume` and
  returns what it built. Their identities sit in a new table:

  ```sql
  sending_bots (bot_id TEXT PRIMARY KEY, name TEXT NOT NULL, username TEXT,
                connected_at TEXT NOT NULL, last_checked_at TEXT,
                token_state TEXT NOT NULL DEFAULT 'ok')   -- 'ok' | 'rejected'
  ```

  Sending bots do not poll. A sending bot whose updates belong to another
  program posts the same as any other: posting needs only the token.
- **Outward names.** Answers and the browser name a bot by `{ name, username }`.
  Every bot has a username in Telegram, and the payload already shows the
  receiving bot's (`contracts.ts:156-161`). The numeric bot id stays inside the
  Viewer, as `contracts.ts:5-9` requires; the operator's add, remove and assign
  actions name a bot by username and the server resolves it.
- **Why keep the receiving bot separate.** Every existing reader of
  `bot-token.json` (Keys page, relay publication, sign-in, report replies)
  keeps working unread, and private chats stay unambiguous: a private chat's id
  is the user's id whatever the bot, so a private chat with a second bot would
  share an id with the first bot's chat and collide on the `messages` primary
  key `(chat_id, message_id)` (`store.ts:266-281`). Sending bots never post to
  private chats (section 3), so that collision cannot occur. In groups,
  supergroups and channels a message id is the chat's own sequence, so posts by
  several bots share the table safely.

### 2. Membership per (bot, chat)

A new table in `bot.sqlite`:

```sql
chat_bots (chat_id TEXT NOT NULL, bot_id TEXT NOT NULL,
           status TEXT,               -- creator|administrator|member|restricted|left|kicked; NULL when the chat is invisible to the bot
           can_send_messages INTEGER, -- 1, 0, or NULL when unknown
           can_send_photos INTEGER,
           can_send_documents INTEGER,
           can_manage_topics INTEGER,
           reason TEXT,               -- why it cannot post: bot_not_in_chat | not_enough_rights | forbidden
           source TEXT NOT NULL,      -- check | refusal | update
           checked_at TEXT NOT NULL,
           expires_at TEXT NOT NULL,
           PRIMARY KEY (chat_id, bot_id))
```

The primary key leads with `chat_id`, so a send reads one chat's rows with one
key range. Rows exist only for groups, supergroups and channels.

**How a bot is checked** (one function, `checkMembership(bot, chat)`):

1. `getChatMember { chat_id, user_id: <that bot's own id> }` through that
   bot's own transport.
2. Status mapping:
   - `creator`, or `administrator` in a group or supergroup → may send
     messages, photos and documents; `can_manage_topics` from the field
     (`creator`: true).
   - `administrator` in a channel → may send everything only with
     `can_post_messages: true`; otherwise `not_enough_rights`.
   - `member` in a channel → `not_enough_rights`.
   - `member` in a group or supergroup → `getChat` with the same bot, and the
     rights come from `permissions`. A missing field reads as unknown.
   - `restricted` → `is_member: false` reads as `bot_not_in_chat`; otherwise
     the rights come from the member's own fields.
   - `left`, `kicked` → `bot_not_in_chat`, status kept so the panel can say
     "removed from the chat".
3. Telegram's own refusal of the check: 403, or a 400 naming "chat not found",
   → `bot_not_in_chat`, with status `kicked` when the description says the bot
   was kicked and NULL otherwise. 401/404 → the bot's
   `token_state = 'rejected'`, no row change. Any ambiguous outcome
   (`unreachable`, `network_failed`, `timed_out`, 429, 5xx) leaves the row as it
   was; with no row the bot stays unknown.
4. The call timeout is 5 s (the transport's default is 20 s,
   `transport.ts:53`); the work registers as `telegram.membership-check` with
   the loop monitor (`withViewerOperation`).
5. One check per (bot, chat) runs at a time per process: a map of in-flight
   promises keyed by the pair, removed when each settles, so it holds at most
   bots × chats entries.

**Expiry.** A row that says the bot may post expires after **6 hours**; a row
that says it cannot expires after **10 minutes**. The asymmetry follows the
cost of being wrong. A stale "may post" costs one refused attempt, after which
the walk falls back and re-checks (section 4); no message is lost. A stale
"cannot" keeps a bot that was added back out of the order, so it is short, and
the panel's Refresh re-checks at once. Six hours bounds the background traffic
at four `getChatMember` calls a day per pair, and only for chats something
posts to.

**Who writes rows.**

| Writer | When | Source |
|---|---|---|
| The send walk | before using a bot whose row is missing or expired | `check` |
| The send walk | right after a bot's definite refusal: re-check it; if the re-check itself is ambiguous, store the refusal's own class with the 10-minute expiry so the next send skips that bot | `check` / `refusal` |
| Update intake, receiving bot | a `my_chat_member` update (`store.ts:451-457`) also writes the receiving bot's row | `update` |
| Operator: add chat (`service.ts:591-630`) | the chat is looked up with every connected bot until one sees it; every bot that answered gets a row | `check` |
| Operator: add a sending bot | that bot is checked against allowlisted chats, newest posted first, at most 16 inline; the rest wait for their first send | `check` |
| Operator: Refresh (`service.ts:539-565`) | `getMe` for every bot, then checks for allowlisted chats, oldest checked first, at most 64 per press | `check` |
| Chat migration (`store.ts:533-557`) | rows move to the supergroup's id with the chat | move |
| Removing a sending bot | its rows are deleted | delete |

For the receiving bot, every write to its row also writes `chats.bot_status`
in the same transaction, so the visibility note, the inactive list and the
history publication guard (`outbound.ts:245-253`) stop showing the stale
`member` the trigger describes. All of these writes go through `outboundState`
(`outbound.ts:41-44`): a zero-wait connection behind the asynchronous state-lock
admission, the same path the outbound journal uses, so none of them adds a
synchronous SQLite wait to the Viewer loop.

**Effective membership of a pair**, used by every reader: the `chat_bots` row
when one exists; for the receiving bot without a row, `chats.bot_status` as
today; otherwise unknown.

### 3. Selection order

`selectBots(chat, kind)` returns the order the walk uses. `kind` is `text`
(also rich messages), `photo` (a photo or album) or `document`; it picks the
right column (`can_send_messages`, `can_send_photos`, `can_send_documents`).

1. **Private chat:** the receiving bot alone, with no check, exactly as today.
   This covers the owner's private chat (prototype reviews, review polls) and
   every allowlisted private chat. A second bot cannot open a private chat with
   a user who never wrote to it, and a reply to it would never reach Delegatus.
2. **Group, supergroup, channel:**
   - the chat's **assigned bot**, a new column `chats.preferred_bot_id`, set by
     the operator in the chat's row (section 7); when none is set, the
     receiving bot comes first;
   - then the remaining connected bots, the receiving bot first, then sending
     bots by the time they were connected;
   - bots whose `token_state` is `rejected` are skipped and recorded;
   - a bot whose fresh row says it cannot post for this `kind` is skipped and
     recorded with the row's reason and check time;
   - a bot whose row is missing or expired is checked when the walk reaches it,
     and only then; a send whose assigned bot has a fresh "may post" row makes
     no check at all;
   - a bot that stays unknown after its check (the check was ambiguous) goes to
     the end of the order: bots known to be in the chat are tried first, as the
     operator chose, and an unknown bot is still worth one attempt because a
     definite refusal costs nothing.

The project level of "assigned to the chat/project" is met through the chat: a
project's reports go to the one chat the operator chose for it
(`settings.ts:251-254`), so that chat's assigned bot is the project's. A
per-project override is deferred.

### 4. The walk, and when it falls back

The walk runs inside the existing send claim (section 5). For each bot in
order: write that bot as the claim's bot in flight, call Telegram, then
classify the answer.

| Telegram's answer | Code recorded for that bot | Next step |
|---|---|---|
| `ok: true` | none | delivered; stop |
| 403, any description ("bot was kicked…", "bot is not a member…", "bot was blocked by the user") | `forbidden` | **fall back**; re-check this bot |
| 400 naming "chat not found" | `bot_not_in_chat` | **fall back**; re-check |
| 400 naming "not enough rights", "have no rights", `CHAT_WRITE_FORBIDDEN`, `CHAT_SEND_…_FORBIDDEN`, `TOPIC_CLOSED` | `not_enough_rights` (new code) | **fall back**; re-check |
| 401 / 404 | `token_rejected` | **fall back**; the bot's `token_state` becomes `rejected` |
| 400 with `migrate_to_chat_id` | none | the same bot again at the new id, as today (`service.ts:970-975`) |
| 400 naming HTML parsing | `format_invalid` | stop: every bot would refuse the same text |
| 400, any other description ("message thread not found", "message is too long", …) | `bad_request` | stop: the request itself is wrong |
| 429 | `rate_limited` | stop, retryable as today |
| 5xx | `telegram_failed` | stop, retryable as today |
| `unreachable` (connection refused, name not resolved) | `network_failed` | stop: every bot uses the same host |
| `network_failed`, `timed_out`, unreadable or malformed success body | `send_uncertain` | stop; the claim stays pending, nothing else is tried |

Only the four **fall back** rows let a second bot post, and each of them is
Telegram's explicit `ok: false` envelope with a status, which proves the first
bot's message was never accepted (`transport.ts:131-137`). Classification looks
at the status first and the description second, so a reworded description
moves a refusal only between "fall back" and "stop"; it can never turn an
ambiguous outcome into a fallback.

**Multi-part text.** A text split into several messages (`service.ts:958-995`)
falls back only before its first part is delivered. A refusal after part one
ends as `send_partial`, exactly as today: mixing two bots inside one message
would show the reader half a message from each.

**The answer's code.** When the walk stops on a "stop" row, that row's code is
the answer's code, so `retryable` keeps today's meaning. When every bot was
skipped or refused on "fall back" rows, the answer's code is the first bot's
(the assigned bot's) code, `retryable: false`, and the answer carries every
bot's reason (section 6). When no bot was even tried because every row was
fresh and negative, the claim is settled `failed` with no message ids, so a
retry under the same key may send once a bot is back.

### 5. One logical message, at most one bot

The existing claim stays the unit: one `sends` row per `(caller_key,
client_request_id)` (`store.ts:282-293`), whatever the number of bots. Two
columns join it:

```sql
ALTER TABLE sends ADD COLUMN bot_id TEXT;                          -- the bot in flight, then the bot that delivered
ALTER TABLE sends ADD COLUMN attempts TEXT NOT NULL DEFAULT '[]';  -- each bot that refused or was skipped, in order
```

The invariant: **bot n+1 is called only after bot n's refusal is committed to
the claim row.** The order of writes for each bot is: set `bot_id` to the bot
(state stays `pending`), call Telegram, then on a "fall back" answer append
the refusal to `attempts` and move on.

- Two callers with the same key: the second claim finds the row `pending` and
  answers `send_uncertain` (`store.ts:662`), as today.
- A process that dies during any call leaves the row `pending` with that bot in
  `bot_id`; a retry answers `send_uncertain` and calls no bot. A process that
  dies between a committed refusal and the next call also leaves the row
  `pending`; the same rule answers `send_uncertain`. That loses a fallback in a
  rare crash window and can never post twice, which is the trade the existing
  claim already makes.
- A replay of a delivered key answers the stored receipt with the delivering
  bot, and calls no bot.
- A bridge-report replay uses a new key per retry (`bindings.ts:3792`) only
  after a retryable code (`bindings.ts:3945-3948`), and every retryable code
  either proves nothing was posted or is a pre-existing case this design does
  not change. The new walk adds no retryable outcome after a delivery.

### 6. What each send records

| Record | Contents |
|---|---|
| `sends` row | `state`, `chat_id`, `message_ids`, `error_code` as today; `bot_id`, the bot that delivered (or was in flight); `attempts`, one entry per bot that refused or was skipped: `{ botId, code, source: "send" \| "check", status?, at }`. At most nine entries. |
| `relay_outbound` row | already keyed by the delivering bot (`outbound.ts:20`). Posts by sending bots have no publication target (`telegramPublication.ts:21-26` answers only for the receiving bot), so they stay locally recorded as `unrouted`, the documented behaviour for posts with no selected pairing (`docs/design/telegram-relay-publication.md`, first section). |
| `chats.last_delivery` (new JSON column) | the chat's newest outcome: `{ at, state: "sent" \| "refused" \| "uncertain", botId?, refusals: [{ botId, code, at }] }`. The chat's row in the panel reads this (section 7). |
| Send answer (`TelegramBotSendAnswer`, `contracts.ts:259-268`) | adds `sentBy: { name, username }` and, when another bot refused first, `refusals`. |
| Refusal answer (`http.ts:59-75` → MCP) | adds `refusals: [{ bot: { name, username }, code, reason, source, at }]` beside `code` and `retryable`. `reason` is the service's sentence with Telegram's description scrubbed by `scrubTelegramDiagnostic` and bounded to 300 characters. |
| Bridge report row (`src/lib/bridge/types.ts:237-252`) | adds `bot` (the delivering bot's username) and `refusals` (`{ bot, code }[]`). |

No record holds a token. The `attempts` column holds bot ids, which already
appear in `relay_outbound` and `report_replies` in the same owner-only file.

### 7. Surfaces

**Operator route** (`src/app/api/telegram/bot/route.ts`), three new actions,
operator-only like the rest:

- `add_bot { token }`: validates the token's shape, asks `getMe`, refuses the
  receiving bot's own token and a ninth sending bot (`bad_request`, "at most
  eight additional bots"), and replaces the token of a sending bot already
  connected (as `connect` does for the receiving bot). Then it checks
  allowlisted chats (section 2).
- `remove_bot { bot }`: removes one sending bot (section 8).
- `chat_bot { chatId, bot | null }`: sets or clears the chat's assigned bot; the
  bot must be connected.

`connect` and the Keys page keep their meaning: they set the receiving bot, and
still refuse a different bot with `bot_already_connected`.

**Agent route and MCP tools.** `telegram_bot_chats` gains, per chat,

```json
"bots": [{ "name": "…", "username": "…", "assigned": true,
           "member": false, "status": "kicked", "canPost": false,
           "canSendPhotos": false, "canSendDocuments": false, "canManageTopics": null,
           "reason": "bot_not_in_chat", "checkedAt": "…" }]
```

and a top-level `bots` list (`{ name, username, receiving, tokenState }`). The
existing `bot` object stays and still names the receiving bot. A chat's
`member` becomes "some connected bot is in it" and `postAllowed` becomes
"allowlisted, and some connected bot may post or is not yet checked"; the
default list hides a chat only when no connected bot is in it. The three send
tools forward `sentBy` and `refusals`, and their refusal path passes `refusals`
into the `McpToolRefusal` details beside `code` and `retryable`
(`bindings.ts:5317-5392`). Tool descriptions (`server.ts:3781-3802`) name the
new code `not_enough_rights` and the two fields. No test bounds the size of
these descriptions (searched `src/lib/mcp/*.test.ts`).

**The panel** (`src/components/TelegramBot.tsx`), inside the existing Bot
section; no new screen:

- Under the receiving bot's header, when sending bots exist, one row per bot:
  name, username, a warning line when its token was rejected, and the existing
  `ConfirmingAction` with the trash icon to remove it (`TelegramControls.tsx`).
- An "Add another bot" disclosure (`<details>`, the pattern the panel already
  uses for inactive chats and limits, `:412-419, 435-443`) holding the
  existing `TokenForm` (`:317-351`), wired to `add_bot`. Hidden at eight.
- In each chat row (`ChatRow`, `:70-176`), when more than one bot is
  connected: one line of bots, each a status dot and the bot's name, with the
  reason and check time in a short popover (green: may post; red: cannot;
  hollow: not checked yet). A "Posts as" native select appears only when two or
  more connected bots may post there: "Automatic" plus those bots.
- In each chat row, at any bot count: when `last_delivery.state` is `refused`,
  a warning line in the style of the refused-reports line (`:166-170`): the
  time, then each bot and its reason ("removed from the chat", "not in the
  chat", "may not post here", "token rejected"). The next delivered post clears
  it. Such a chat stays in the main list even when no connected bot is in it
  (today the list hides non-members behind the inactive disclosure,
  `:358-359, 412-419`), so the reason is on the first screen. Its posting
  switch stays visible there (today it renders for members only, `:111-129`);
  switching posting off moves the chat to the inactive disclosure. When a post
  went out through a bot other than the first in order, the last-post line
  (`:171-173`) adds "via" and that bot's name.
- `ERROR_KEYS` (`:24-42`) gains `not_enough_rights`; en and uk strings for
  every new line (`src/lib/i18n/en.ts`, `src/lib/i18n/uk.ts`).

A one-bot installation sees two additions only: the "Add another bot"
disclosure and, after a refused delivery, the refused line.

### 8. Removing bots

- **A sending bot:** its token entry, its `sending_bots` row and its `chat_bots`
  rows are deleted; chats assigned to it fall back to "Automatic"; its
  transport is dropped. `sends` rows keep its id as history. Chats, aliases and
  messages stay.
- **The receiving bot** (the existing Remove): unchanged in effect, it removes
  the Telegram bot account from Delegatus, now with the sending bots' token
  file too, since the store they depend on is deleted with it
  (`service.ts:662-673`). The confirm text says that every connected bot is
  removed. Promoting a sending bot to receiving is deferred.

### 9. Process and hot-path notes

- The poller, sign-in, report replies and the relay publication queue remain
  the receiving bot's alone; nothing new runs per tick.
- `status()`, which the footer polls (`route.ts:32-43`), adds one read of
  `chat_bots` and `sending_bots`, bounded by nine bots times the known chats,
  and makes no Telegram call. Telegram is called only on a send, a Refresh, an
  added chat and an added bot.
- The send walk is bounded by nine bots, at most two check calls each with a
  5-second deadline, and runs inside `withViewerOperation`. A send whose
  assigned bot has a fresh positive row adds no network call and one indexed
  read. No speed gain is claimed, so no before/after measurement is owed.
- The service keeps one transport per connected bot in a map that is rebuilt
  when a bot is added or removed (at most nine entries).

### 10. Contracts touched: who produces and who reads them

| Contract | Producers | Readers that must follow |
|---|---|---|
| `TelegramBotStatusPayload` / `TelegramBotChatView` (`contracts.ts:131-178`) | `service.status()` | `TelegramBot.tsx`, `src/hooks/useTelegramBot.ts`, `withReportDestinations` (`src/lib/projects/reportDestination.ts:63-86`, its `refused` flag reads `postable`), `ProjectReportsOverview`, `src/lib/team/http.ts:114-120` (receiving bot's username; unchanged), and the fixtures `src/components/mobile/issue1671Evidence.fixture.tsx:1806-1823`, `src/components/kanban/issue1695Evidence.fixture.tsx:4166`, `src/components/attention/needsYouPanel.fixture.tsx:538` |
| `TelegramBotChatsAnswer` / `TelegramBotAgentChat` (`contracts.ts:193-224`) | `service.listChats()` | agent route's chat match (`agent/route.ts:57-60`), `postableReportChats` / `viewerReportChatTitle` (`reportDestination.ts:22-45`), the project settings route (`src/app/api/projects/settings/route.ts:132-153`), the privacy name reader `telegramPeople` (`bindings.ts:4109+`), the MCP tool |
| `TelegramBotSendAnswer` and the refusal envelope | `send`, `sendMedia`, `sendDocument`, `sendRich`, `http.ts` | `productionSendReportTelegram` (`bindings.ts:3989-4009`), `seatAuthRecovery.ts:100-118, 148-168`, `prototypeReview/telegramPost.ts:152-161` (owner path; its `no_target` details from #3136 stay as they are), the three MCP send tools |
| Error codes (`contracts.ts:33-64`) | the service | `http.ts` `STATUS` (`:13-47`, `not_enough_rights` → 403), `ERROR_KEYS`, `telegramRefusedBeforeSend` (`seatAuthRecovery.ts:22-24`, add `not_enough_rights`), `isRetryableReportSend` (unchanged: the new code is not retryable), `PrototypeTelegramActions.tsx:18` (owner path only; unchanged) |
| `bot.sqlite` schema | `TelegramBotStore`, `outboundState` | the store's migration on open adds tables and columns with `CREATE TABLE IF NOT EXISTS` and the `PRAGMA table_info` guard it already uses (`store.ts:304-307`) |

## Tests (acceptance 4)

All with `FakeBotTransport` (`src/lib/telegram/bot/fakeTransport.ts`), one fake
per bot, chosen by token in `transportFor`; tokens from `fakeBotToken(<id>)` so
no token-shaped literal enters a source file. The clock is the injected
`deps.now`. State, HOME, XDG_CONFIG_HOME, TMPDIR and `LLV_STATE_DIR` are
isolated, and nothing reaches the network.

1. **Assigned bot in the chat.** Bot B is assigned and has a fresh positive
   row: B's `sendMessage` is called once, bot A's fake records no call, the
   answer's `sentBy` names B, the claim row's `bot_id` is B.
2. **Assigned bot kicked, second bot delivers once.** A answers
   `refused(403, "Forbidden: bot was kicked from the supergroup chat")`; A is
   re-checked (`getChatMember` on A's fake); B delivers. Exactly one
   `sendMessage` on each fake; `attempts` holds A's `forbidden`; `refusals` in
   the answer names A. A replay under the same key answers `alreadySent` with
   B's message ids and adds no call on either fake. A second send to the chat
   within ten minutes calls no `sendMessage` on A.
3. **Both refused, stored with reasons.** A 403, B 400 "not enough rights to
   send text messages to the chat": the refusal's code is A's `forbidden`,
   `retryable: false`, `refusals` carries both with `not_enough_rights` for B;
   `chats.last_delivery` is `refused` with both; no outgoing message is
   stored; a bridge report through `postReportTelegram` records `failed` with
   both refusals; the panel payload shows the refused line's data.
4. **Ambiguous failure, no fallback.** A answers `unreachable("timed_out")`,
   and in a second case `unreachable("network_failed")`: the answer is
   `send_uncertain`, B's fake records no `sendMessage`, the row stays `pending`
   with `bot_id` A, and a replay under the same key answers `send_uncertain`
   with still no call on B.
5. **Cache expiry and refresh after refusal.** A positive row checked at t0:
   a send at t0 + 6 h − 1 s makes no `getChatMember`; at t0 + 6 h + 1 s it
   makes one before sending. After a refusal the re-check stores `kicked`; a
   send 9 minutes later skips A with no call; a send 11 minutes later re-checks
   A, finds `member`, and A delivers.
6. **Unchanged paths.** A one-bot installation passes the existing
   `service.test.ts`, `outbound.test.ts`, `publish.test.ts` and
   `src/lib/mcp/telegramBot.test.ts` unchanged apart from the added answer
   fields. The owner's private chat: with a sending bot connected, a refused
   owner review is never retried through it, and the `no_target` details
   (`telegramPost.test.ts`) are unchanged. A multi-part text refused after part
   one answers `send_partial` and calls no second bot.
7. **Secrets.** `JSON.stringify` and `util.inspect` of the service, the status
   payload, the chats answer and every refusal contain neither token nor bot
   id; removing a sending bot leaves the receiving bot's token file and the
   store intact.
8. **Classification.** One fixture per row of the section 4 table, including a
   400 with an unknown description (stops) and a 403 with an unknown
   description (falls back).

Rendered evidence for the panel goes through the existing drivers: the phone
driver (`src/components/mobile/issue1671Evidence.browser.test.tsx`, whose
fixture already serves `/api/telegram/bot` GET and POST) and the desktop footer
through the kanban board driver (its fixture serves the panel under its
Telegram step). States: one bot; two bots with one removed from a chat; every
bot refused; the add-bot disclosure open. en and uk, light and dark. No new
driver file.

## Rollout and the live effect

- The store gains its tables and columns on first open after deploy; nothing
  needs migrating, because every pair starts unknown.
- With only today's bot connected, the first send to each group after the
  deploy asks Telegram once about that bot. For the partner supergroup the
  answer is "kicked", so its sends are refused before any post with
  `bot_not_in_chat`, the stale `member: true` is gone, and the chat's row in
  the panel shows the refused line naming the bot.
- **No design can deliver to that supergroup until some connected bot is a
  member of it.** The operator (or the partner) has to add a bot to it, either
  today's bot again or another bot, and connect that other bot here with "Add
  another bot". Once connected, the next report copy there goes through it.
  The seat should tell the partner project this when the lane lands.

## Validation against the requirement

| The task asks | Where this design answers |
|---|---|
| Observe how bots are connected, whether more than one can be, with file:line | "One bot can be connected, and only one" |
| bots[] | section 1 |
| Per (bot, chat) membership with can-post and topic rights | section 2, `chat_bots` |
| Checked with each bot's own token via getChatMember/getChat | section 2, "How a bot is checked" |
| Cached with an expiry and re-checked after a refusal | section 2, "Expiry" and "Who writes rows" |
| Selection order: the assigned bot, then any other that is in the chat and may post | section 3 |
| Fallback on kicked, not enough rights, chat not found; never on ambiguous failures | section 4 |
| One logical message never delivered by two bots | section 5 |
| What each send records | section 6 |
| Minimal way to connect, list and remove additional bots in the existing panel | section 7, "The panel" |
| Every send path through the same selector; the owner's private chat as today | section 3 (private chats: the receiving bot alone) and the send-path table above |
| telegram_bot_chats shows per chat which bots are members and may post | section 7, agent route |
| Per-bot reasons in the answer; the chat's card shows the reason and the refused bot | sections 6 and 7 |
| Tests with a fake transport for the five named cases | "Tests", cases 1–5 |
| No live sends, no tokens in logs or reports | "Tests" (fakes, isolated state) and section 6 |

## Deferred — not currently justified

- **Reading updates through sending bots.** Replies to a post made by a sending
  bot reach Delegatus only if the receiving bot sees them. Polling more bots
  would add pollers, per-bot private chats and a bot key on the `messages`
  table; the request is about delivering.
- **A per-project bot assignment.** A project reports into one chat, and that
  chat's assigned bot serves it. Two projects that share a chat and want
  different bots have not come up.
- **Falling back on `rate_limited`.** It is a definite refusal, so it would be
  safe; it stays retryable under a new key as today because the request names
  removal, rights and unknown chats.
- **A periodic membership sweep.** Lazy checks on send, on Refresh and on add
  cover the request without any per-tick work.
- **Promoting a sending bot to receiving, or swapping them.** Remove and
  reconnect does it today.
- **Relay publication of posts by sending bots.** The pairing was authorised
  for the receiving bot (`telegramPublication.ts:11-12`); those posts stay
  recorded locally.
- **Per-topic rights** (a closed topic in a chat where the bot may otherwise
  post). The refusal falls back and is recorded; a topic-level cache would add
  a key for a rare case.
- **A private message to the operator when no bot can post.** The operator
  chose the option without it.
- **The sending bot on each stored outgoing message** in
  `telegram_bot_messages`. The claim row and the chat's last post name it.
- **Sending-bot tokens on the Keys page.** The Keys page keeps the receiving
  bot's token; sending bots are added in the panel.

## Notes for the build stage

- Run touched test files by path through `scripts/gate-slot.sh` with isolated
  HOME, XDG_CONFIG_HOME, TMPDIR and `LLV_STATE_DIR`; never sweep the live state
  (AGENTS.md).
- Merge `origin/main` before finishing; keep the prototype-review `no_target`
  details from #3136 (`ownerDestination.ts`, `telegramPost.ts`) as they are.
- No bot token, bot username, chat title or chat id from the live installation
  goes into fixtures, evidence, commits or the pull request.
