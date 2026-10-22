# Relay: send and read through a paired Celestia clone (Delegatus side)

## Originating requirement

Original requirement: the operator's voice comment on a decision form,
2026-10-22 ~12:05 UTC, relayed to this project's seat by the partner service's
seat.

> [REDACTED: private source.]

In short: Delegatus should post into a Telegram group directly, with no AI
request, as the Celestia clone that sits in that group, using only the pairing
credential. Connecting Celestia should be enough: Celestia names the clones and
their chats, and Delegatus uses them to send into a group and to read it, so it
no longer needs to keep a bot token for this.

Public task requirement, 2026-10-22 (verbatim):

> Send to Telegram groups through a paired Celestia clone (relay v1 send
> endpoint), no bot token needed for that path
>
> Outcome: from Delegatus, with only the pairing credential, list the paired
> clones and their chats, and send text into a chat as the clone bound there,
> idempotently, with no AI request. Delegatus's outbound Telegram paths (bridge
> reports' Telegram delivery, telegram_bot_send and its document/media variants,
> prototype review delivery) use the clone path where a clone covers the
> destination chat and fall back to the existing bot path otherwise. The clone
> path is used only when the partner's discovery answers for it, so until the
> partner release is live nothing changes for the operator. Stored bot tokens are
> NOT deleted in this lane: removal needs the clone path proven live on every
> configured destination and is a separate, operator-approved step; the plan
> states the condition and leaves it deferred.

Correction, 2026-10-22 ~22:05 UTC, from the partner seat: reading is part of the
contract. The existing owner history read stays as it is on the wire, and any
of the owner's active clones now authorizes it. Reading a group's recent
messages through the clone is in scope for this lane.

What triggered it: on 2026-10-22 the Delegatus bot was removed from a group
where one of the owner's clones still sits, and Delegatus could no longer post
there.

**Should this be built?** Yes. The bot path cannot post into that group, and
the requirement asks for exactly this path. The plan below is the smallest
build that serves it: one relay client call, one bounded clone directory and
one candidate step in the existing multi-bot selector. The allowlist, the
durable send claim, the outgoing journal and the bot fallback already exist
and are reused.

## Prior work

Transcript and memory search (this project first, then everywhere) found the
seat's relay of the request (2026-10-22 12:16 UTC), the seat's reply asking the
partner to pin media, replies, an idempotency key, error codes and paged reads,
and the partner's final design. No earlier Delegatus design for sending as a
clone exists. Related designs here: `telegram-bot-account.md`,
`telegram-multi-bot.md`, `telegram-relay-publication.md`,
`relay-owner-group-history-install.md`.

Open work on the same files, checked at base `78f15cfb` (`origin/main` has not
moved): the two owner-relay lanes, 6491e899 (#3209) and fdd34726 (#3210), change
`runner.ts`, `poller.ts`, `ownerRun.ts`, `ownerAuthority.ts`, `relayLease*.ts`,
`deadline.ts`, `answers.ts` and `store.ts` under `src/lib/externalRelay/`. This
plan touches none of those. #3212 and #3200 edit `src/lib/mcp/bindings.ts`;
this plan leaves that file alone.

## What exists today

| # | Fact | Where |
|---|---|---|
| E1 | Relay HTTP client: DNS pin, redirect refusal, response cap, error envelope parsed into `ExternalRelayError(code, status, retryAfterSeconds)`. Its publication-reference hook matches only `POST /targets/{id}/messages`. | `src/lib/externalRelay/client.ts:75-202`, `:184`; `publishedReferences.ts:38-53` |
| E2 | Targets: `GET /targets` parsed non-strictly; the store keeps the operator's settings per target (`enabled`, `answered_by`, engine). The owner destination is the first enabled, install-answered, configured target, owner tier first. | `client.ts:338-353`; `protocol.ts:24-39`; `store.ts:9-25`, `:50-69`; `ownerDestination.ts:14-41` (all under `src/lib/externalRelay/`) |
| E3 | Owner history read: `readOwnerGroups` and `readOwnerGroupMessages` with strict parsers, behind the owner-tools switch (default off), with the target taken from the owner destination; reached by the MCP tool `relay_owner_history` through the Viewer route. | `ownerHistory.ts:97-116`, `:146-188` (target at `:148`); `protocol.ts:428-442`; `switches.ts:10-15`; `src/app/api/external-relay/owner-history/route.ts:8-16`; `src/lib/mcp/bindings.ts:5330-5335` |
| E4 | Text send: the agent route calls `TelegramBotService.send`, which checks the operator's allowlist first, takes a durable claim on `(caller, clientRequestId)`, splits plain text into at most 4 parts of 4,096, and sends each part through the selection's transport. | `src/app/api/telegram/bot/agent/route.ts:48-79`; `src/lib/telegram/bot/service.ts:1071-1178`, `:194-205`, `:228-255`; `src/lib/telegram/bot/store.ts:677-687`; `contracts.ts:342-343` |
| E5 | Multi-bot selection: candidates ordered with the assigned bot first, membership checked, every refusal recorded in `sends.attempts`, delivery state kept per chat, pinned to the first bot that posts, fallback only on refusals that prove nothing was posted, claim settled as failed when every bot refuses. | `src/lib/telegram/bot/multiBot.ts:174-317` (`:242-245`, `:192-201`, `:184-191`, `:227-241`, `:277-290`, `:304-309`); `mayFallback` `:16-17` |
| E6 | Publication: each confirmed send is journaled, and a durable queue posts the receiving bot's messages to `POST /targets/{id}/messages`. Unrouted receipts may be forwarded by a linked install when the bot id matches. | `service.ts:359-378`, `:1518-1521`; `outbound.ts:96-114` (state at `:105`); `src/lib/externalRelay/telegramPublication.ts:13-46`; `src/lib/links/telegramPublication.ts:142-147` |
| E7 | Bridge reports: the seat's report is rendered as HTML for the project's chosen chat and posted through the same agent route (`op: send`, `format: html`, `silent`). | `bindings.ts:3829-3878`, `:3972-3993`, `:4006-4028` |
| E8 | `telegram_bot_send`, `_send_media`, `_send_document` reach the agent route; media and documents use `sendMedia` / `sendDocument`. | `bindings.ts:5358-5454`; `service.ts:1329-1426`, `:1433-1509` |
| E9 | Prototype review delivery: a Bot API `sendRichMessage` (photo slideshow, copy buttons) to the owner's private chat, then polls on the receiving bot's own transport. | `src/lib/prototypeReview/telegramPost.ts:128-164`; `service.ts:1182-1221`, `:1231-1325`, polls `:1210-1219` |
| E10 | The operator's test post goes through the same selection. | `service.ts:779-812` |
| E11 | Listing: `listChats` / `agentChat` call a chat postable only when some bot can post; the panel lists per-bot state when a chat has more than one bot and moves non-member chats to the inactive list; the report picker and its "refused" marker read the same flags. | `service.ts:974-1029`, `:528-567`; `src/components/TelegramBot.tsx:169-182`, `:395-397`; `src/lib/projects/reportDestination.ts:22-32`, `:63-86` |
| E12 | Without a stored bot token every service call is refused; removing the bot deletes the tokens and the store that holds the chat allowlist. | `service.ts:500-505`, `:817-832` |
| E13 | Owner reply context: a reply to a bridge report resolves through the published reference and the report's message ids; question and history context keys outgoing rows by the receiving bot's id. | `src/lib/externalRelay/ownerBridgeContext.ts:37-56`; `ownerOutboundContext.ts:26-55` |
| E14 | Deadlines: an MCP tool call gets at most 30 s; a Bot API call defaults to 20 s. | `src/lib/mcp/server.ts:4946-4947`; `src/lib/telegram/bot/transport.ts:53` |
| E15 | Harnesses: a fake relay on port 0 and a scripted Bot API transport. | `src/lib/externalRelay/testRelay.ts:1-30`; `src/lib/telegram/bot/fakeTransport.ts` |

Live state on this machine, read 2026-10-22 ~22:15 UTC through the
`telegram_bot_chats` tool and a key-only read of the relay store (counts only):
one bot connected, its updates delivered to a webhook owned by another
program; five known chats, of which four are allowlisted with the bot a member
(three groups and the owner's private chat) and one is an allowlisted group the
bot was removed from. One Celestia pairing with three targets: two answered by
this installation, one by the service.

## The partner contract, paraphrased

Source: the partner's relay design and pull request, final as of 2026-10-22
~21:45 UTC, reviewed and green on their side, shipping with their next release.
Authentication everywhere is the existing pairing credential.

- **P1 Send.** `POST /api/relay/v1/targets/{target_id}/send` with `client_key`
  (8 to 64 of `[A-Za-z0-9_-]`), `chat_id`, `text`, optional `parse_mode`
  (`"HTML"` or null for plain), `reply_to_message_id`, `message_thread_id`,
  `silent`. Answers `message_id`, `message_key`, `sent_at` (Telegram's date) and
  `replayed`. One call is one message. Plain text over 4,096 UTF-16 units is
  refused; `text` is at most 16,384 code points; the body at most 65,536 bytes.
  No buttons and no media.
- **P2 Who and where.** Any active clone of the pairing's owner, into a chat
  where that clone holds the active binding, or into the owner's own private
  chat. The clone's AI routing plays no part.
- **P3 Idempotency.** The key is scoped to the pairing and kept 24 h; the stored
  digest binds clone, chat and body. Same key and body after a send: the
  original answer with `replayed: true`. Same key, other body: 409
  `idempotency_conflict`. In flight: 409 `send_in_progress` with
  `retry_after_s`. A send whose outcome Celestia could not learn: 409
  `send_uncertain` for the rest of the 24 h.
- **P4 Limits.** 30 sends a minute per pairing (replays do not count), plus a
  per-chat cooldown taken from Telegram; both answer 429 `rate_limited` with
  `retry_after_s`. Allow at least 30 s per call.
- **P5 Answers that leave the key unused (nothing posted):** 400 `malformed`,
  `text_too_long`, `format_invalid`; 401 `unauthorized`; 403
  `chat_not_allowed`; 404 `not_found`; 409 `clone_inactive`,
  `clone_not_in_chat`; 413 `too_large`; 422 `telegram_rejected`; 426; 429; 503
  `telegram_unavailable`. A 500 may leave any state; the same key asks the
  ledger.
- **P6 Recording.** Celestia records each sent message in its own history,
  exactly as publish does. Delegatus must not publish those messages again.
- **P7 Discovery.** `GET /targets?include=chats` adds per target `active`,
  `chats` (each with `chat_id` and `title`) and `chats_next_cursor`, at most
  1,000 chats per answer; continuation through `GET /targets/{id}/chats`.
  Without `include`, `/targets` is byte-identical to today. The owner's private
  chat is not listed.
- **P8 Read.** The existing owner history read, unchanged on the wire; any of
  the owner's active targets authorizes it; group membership and presence rules
  and its own limit (60 a minute per pairing) stay.

## Plan

### 1. Modules

| File | Change |
|---|---|
| `src/lib/externalRelay/cloneSend.ts` (new) | The send client (§2) and its answer table (§6). |
| `src/lib/externalRelay/cloneDirectory.ts` (new) | Discovery, the persisted snapshot and the chat-to-clone lookup (§3, §4). |
| `src/lib/externalRelay/publishedReferences.ts` | Add `recordSentRelayReference`, writing the same row the publish hook writes, from a send answer (§7). The existing recorder is unchanged. |
| `src/lib/externalRelay/ownerHistory.ts` | Target choice for reads (§8): one call site, `:148`. |
| `src/lib/telegram/bot/multiBot.ts` | The clone candidate step inside `selection()` (§5). |
| `src/lib/telegram/bot/errors.ts` | `sendFailure` and `mayFallback` honour a result the clone step already classified (§5). |
| `src/lib/telegram/bot/outbound.ts` | A clone receipt is journaled as already published (§7). |
| `src/lib/telegram/bot/service.ts` | Wire the clone port into `selector()` (`:425-427`), pass each part's key from `send` and `testPost`, show coverage in `agentChat`, `status` and the `listChats` filter (§10). |

No new route, MCP tool, tool argument, switch or table. No component change:
the panel already renders what §10 adds.

### 2. The send client

`sendAsClone(relay, targetId, input, { deadline })` in `cloneSend.ts`:

- Builds `{client_key, chat_id, text, parse_mode, reply_to_message_id,
  message_thread_id, silent}` and posts it with `relayCall` (E1) to
  `/targets/{id}/send`, 64 KiB response cap, under
  `withViewerOperation("external-relay.clone-send")`.
- **Coverable payload, checked before any request:** plain text within one
  4,096-unit part (the splitter already guarantees it, `service.ts:228-255`);
  HTML within 16,384 code points; the encoded body within 65,536 bytes. A
  payload outside these bounds is never offered to the clone, and the bot path
  sends it as today.
- **Per-part budget 25 s**, inside the 30 s MCP deadline (E14). First request
  timeout 20 s, matching the Bot API default. While budget remains, a 500, a
  409 `send_in_progress` (after its `retry_after_s`) or a transport failure
  after the request went out is retried **with the same key**. A connection
  that never opened (DNS failure, refused connection) counts as nothing sent.
- Returns one of `sent {messageId, messageKey, sentAt, replayed}`,
  `refused {code, retryAfterSeconds, fallback}` or `uncertain`, classified by
  the table in §6.
- On `sent` it records the published reference (§7) before answering.

### 3. The clone directory: discovery, cache, refresh

`cloneDirectory.ts` owns one snapshot per paired, unpaused relay whose origin is
the known Celestia origin (`knownRelays.ts:41`, as `ownerDestination.ts:15`):

```
{ v: 1, relayId, apiBase, pairedAt, fetchedAt, supported,
  targets: [{ targetId, name, active, chats: [{ chatId, title }] }] }
```

- **Fetch:** `GET /targets?include=chats`, then `GET /targets/{id}/chats` only
  while a target carries `chats_next_cursor`, up to 100 chats per target and
  1,000 per relay. Anything beyond is left uncovered (bot path). Production
  bindings today stay far below that (at most 23 per clone, per the partner's
  observation).
- **Supported or not:** a 400, or a 200 whose targets lack `active` or `chats`,
  means the partner release is not live; the snapshot stores
  `supported: false`, which covers nothing. Until the release, every send takes
  today's bot path unchanged.
- **Persisted** to `external-relay/clone-directory.json` with the store's
  atomic `writeRelayFile` (`src/lib/externalRelay/store.ts:129-141`, mode
  0600), validated on load and held in memory afterwards, so a restarted Viewer
  answers its first send from disk. An invalid file, or one whose `relayId`,
  `apiBase` or `pairedAt` differs from the stored pairing, counts as absent.
  The file holds chat ids and titles, the same class of data the bot store
  already keeps; it holds no credential and no hash of one.
- **Freshness, with no timer and no per-tick fetch:** a read of a snapshot
  older than 15 minutes returns it and starts one background refresh. A send
  waits for a fetch only when no snapshot exists for that relay, bounded by 5 s;
  a failure means no coverage for that send. Fetches are single-flight per
  relay and at least 60 s apart, failures included; a failed fetch keeps the
  previous snapshot. A stale snapshot is safe because Celestia checks every
  send (P2), and a refusal falls back (§6).
- **Invalidation:** the clone refusals `not_found`, `chat_not_allowed`,
  `clone_inactive`, `clone_not_in_chat` and `unauthorized` mark the snapshot
  stale. Unpairing or pausing removes coverage at the next lookup, since
  lookups read the relay store first.
- One owner per process through a `globalThis` symbol, as
  `ownerHistory.ts:38-41` does, so route bundles share it. Lookups build a
  `Map<chatId, route>` once per snapshot; `status()` and `listChats()` read only
  that map.

### 4. Which clone serves a chat

`cloneRoute(chat)` answers `{ id: "clone:<relayId>:<targetId>", relay,
targetId, name }` or null:

- the chat is a group, supergroup or channel (a negative id) listed under
  exactly one target of a supported snapshot;
- that target is `active` in the snapshot and enabled in Delegatus
  (`src/lib/externalRelay/store.ts:14`; the operator's existing off switch for
  a clone, which already stops it answering,
  `src/lib/externalRelay/runner.ts:381`);
- the chat has no assigned bot (`multiBot.ts:242`): an operator who picked who
  posts in a chat keeps that choice.

If two pairings list the same chat, the first in relay-store order wins, the
rule `ownerDestination.ts:12-13` uses. **Private chats, the owner's included,
are never covered in this lane** (§9 says why).

### 5. Where the clone step runs

In `selection()`'s transport (`multiBot.ts:222-315`), before the bot loop, for
`sendMessage` calls only:

1. After the assigned-bot read (`:242`), ask the clone port for a route. None:
   today's loop runs unchanged.
2. Write `sends.bot_id` and `bot_identity` for the clone (`{name, username:
   null}`), the same statement as `:267-272`, then call `sendAsClone` with the
   part's key (§6). The selection knows the caller and claim key; the send loop
   passes the part index in the call options, which Bot API transports ignore
   (`transport.ts:80-83`).
3. `sent`: the clone is selected and pinned, its publication target is null,
   and the call returns a Bot-API-shaped receipt (`message_id`, `date` from
   `sent_at`, `chat`, the requested topic). Later parts go to the pinned clone.
4. `refused` with `fallback`: record the refusal in `attempts` with the clone
   as the bot (`:192-201`) and enter the bot loop. If every bot also refuses,
   the existing settle at `:304-309` throws the first attempt's code, the
   clone's.
5. `refused` without fallback (rate limit): record it, set delivery
   `refused`, settle the claim as failed with no message ids (as `:304-309`) so
   the same key may send later, and refuse with `rate_limited` and
   `retryAfterSeconds`.
6. `uncertain`: pin, set delivery `uncertain`, answer `send_uncertain`; the
   claim stays pending, exactly as a Bot API timeout does today. No bot is
   tried, because a second post is worse than a missing one.

The clone's results carry their classified code, and `sendFailure` and
`mayFallback` (`errors.ts:21-42`, `multiBot.ts:16-17`) use it when present, so
the pinned branch (`:227-241`) and the send loop's partial-send handling
(`service.ts:1145-1160`) work for the clone without dressing relay answers as
Telegram descriptions. `refreshRefusal` and membership checks never run for
the clone: its coverage comes from the directory.

### 6. Idempotency, rate limits and every relay answer

**Keys.** One key per logical message part:
`ck_` + the first 40 base64url characters of SHA-256 over
`["delegatus-clone-send-v1", relayId, callerKey, clientRequestId, partIndex]`.
The claim on `(callerKey, clientRequestId)` is committed before the transport
is touched (`service.ts:1100`), so the key is effectively persisted before the
first attempt with no new column, and every retry of that part derives the
same key. Conversation ids and request ids enter only the hash. A claim that
failed with nothing sent may be taken again
(`src/lib/telegram/bot/store.ts:680`); its key is then unused at Celestia
(P5), so a corrected body sends. The operator's test post
uses its own fresh key (`service.ts:784`) and part 0.

| Relay answer | Delegatus |
|---|---|
| 200, `replayed` either way | `sent` |
| 401, 403, 404, 409 `clone_inactive` / `clone_not_in_chat`, 422, 426, 503; 400 / 413 payload refusals; connection never opened | `refused`, **fall back** to the bot path. Codes: 401 and 403 → `chat_not_allowed`; 404 and both 409s → `bot_not_in_chat`; 422 and other 400 / 413 → `bad_request`; `format_invalid` and `text_too_long` keep their names; 426 and 503 → `telegram_failed`; no connection → `network_failed`. 426 also marks the directory unsupported. |
| 429 `rate_limited` | `refused`, **no fallback**: `rate_limited` with `retryAfterSeconds` (a retryable code, `contracts.ts:72-74`) |
| 409 `send_in_progress`; 500; transport failure after sending | retry the same key while the part budget lasts, then `uncertain` |
| 409 `send_uncertain`, 409 `idempotency_conflict`, budget spent | `uncertain` → `send_uncertain` |

Every answer in the fallback row proves Celestia posted nothing (P5), so a bot
may post the message without a duplicate. The rule in one line: **fall back
whenever the key is unused, except on a rate limit; stop on any uncertainty.**

**Rate limits: refuse, never queue, never drop.** A rate-limited clone send is
refused to its caller with the wait. Agents already retry `rate_limited`. A
bridge report records it on its row as a failed copy with a retryable code,
and the seat's replay under the same report key re-sends it
(`bindings.ts:3802-3806`), as for a Bot API 429 today. Falling back to a bot on
a rate limit is left out on purpose: the poster's identity in a chat would then
depend on load, and the partner's per-pairing volume bound would stop bounding
anything. A part refused mid-message after earlier parts went out is the
existing `send_partial` with the posted ids. Volume today is well inside the
limit (the partner saw at most 15 publishes a minute in one chat).

### 7. Journal, references, publication

- The confirmed clone send goes through `publishConfirmed` (`service.ts:359-378`)
  like any send: the outgoing journal row, the chat's last post and the
  conversation attribution are written as today. Its bot id is the clone's
  `clone:` id; its publication target is null; production publishes nothing
  without a target (`service.ts:1521`), so Celestia's own record (P6) is the
  only one.
- `recordOutbound` inserts a clone receipt in a settled publication state
  (`outbound.ts:105`). Neither the publication queue nor linked-install
  forwarding (`links/telegramPublication.ts:142-147`, which would otherwise
  revisit an unrouted row every 30 s for 24 h) ever picks it up.
- `recordSentRelayReference(apiBase, targetId, {messageKey, chatId,
  messageId, topicId})` stores the send's `message_key` in the same collection
  as publish (E1). A reply to a clone-posted bridge report then resolves to its
  report (`ownerBridgeContext.ts:37-56`). The relay's hook still matches only
  `/messages`, so nothing records twice.

### 8. Reading a group's recent messages through the clone

The caller is unchanged: a seat or agent calls the MCP tool
`relay_owner_history` (`bindings.ts:5330-5335`) with `action: "groups"`, then
`action: "messages"` with a chat; the Viewer route
(`owner-history/route.ts:8-16`) runs `readOwnerHistory`
(`ownerHistory.ts:146-188`), which calls `readOwnerGroups` /
`readOwnerGroupMessages` (`:97-116`), the endpoints P8 keeps. Wire shapes and
strict parsers, the owner-tools switch, the four-second deadline, the 429
cooldown, the privacy note and the refusal while answering in Telegram all
stay as they are.

One change, at `ownerHistory.ts:148`: when `selectOwnerDestination` refuses with
`no_target` or `not_configured`, the read uses the first active, enabled target
of that pairing's supported clone directory, as held in memory: the read
waits for no fetch, and with no snapshot it starts one in the background and
answers as today. An installation whose clones are
all answered by Celestia, or not configured here, can then read with the
pairing credential alone, which P8 now allows. Which owner target authorizes
the read does not change the groups or messages Celestia returns (P8), so no
chat-specific choice is needed. Without a supported directory the read behaves
exactly as today.

### 9. Which paths switch in this lane

| Path | This lane |
|---|---|
| `telegram_bot_send`, text, into an allowlisted group a clone covers (E4, E8) | **Clone first**, bot on fallback |
| Bridge reports' Telegram copy into such a group (E7) | **Clone first**: the same route and `send` call |
| The operator's test post into such a group (E10) | **Clone first**: a one-click proof that the clone path works for that chat |
| `telegram_bot_send_media`, `telegram_bot_send_document` | **Bot path, deferred**: the contract carries no media (P1); the partner's media slice is the trigger |
| Prototype review delivery (E9) | **Bot path, deferred**: a rich message with frames and copy buttons, followed by polls, which a text-only send cannot carry; it also targets the owner's private chat |
| Any text into the owner's private chat | **Bot path, deferred**: replies there resolve their context through rows keyed by the receiving bot (`ownerOutboundContext.ts:26-55`), which sits on the owner-relay request path that the two open lanes are changing; and today the bot reaches the owner there |
| Replies to bot updates (sign-in, `service.ts:956-968`), `addChat` lookups, membership checks | Bot only, by nature |

So in this lane the clone covers group text, which includes the trigger case.
Every other send behaves exactly as today.

### 10. What agents and the operator see

- `telegram_bot_chats` and the panel status: a covered chat lists the clone in
  its `bots` (`name`, `username: null`, `member: true`, `canPost: true`,
  `canSendPhotos` and `canSendDocuments` false), so the chat counts as a member
  and postable even when every bot was removed, and its report line loses the
  "refused" mark (`reportDestination.ts:63-86`). The report picker offers it
  (`reportDestination.ts:22-32`).
- A send answer's `sentBy` names the clone; `refusals` name the clone when it
  refused and a bot posted.
- In the panel (`TelegramBot.tsx:169-182`) that is one more name in the
  existing per-bot line, and the chat leaves the inactive list
  (`TelegramBot.tsx:395-397`). The posting picker lists only bots with a
  username (`:188`), so the clone cannot be assigned. No new control or text.
- Before the partner release, none of this appears.

### 11. Logs and privacy

One allowlisted log line per clone send and per directory fetch: outcome,
relay code, HTTP status, elapsed ms, part index. Never text, chat ids, titles,
target ids, keys or the credential. The credential travels only in the
`Authorization` header inside `relayCall`. Test fixtures use invented ids and
an obviously fake credential written as prose in comments.

### 12. Tests

All against `startTestRelay` (E15) on port 0 and the scripted Bot API
transport, with HOME, XDG_CONFIG_HOME, TMPDIR and `LLV_STATE_DIR` isolated and
`LLV_VIEWER_CONTROL_URL` pointed at a closed port. No live installation.

`cloneSend.test.ts`
1. Request shape: path, version header, bearer header, body fields; plain sends
   `parse_mode: null`, HTML sends `"HTML"`, `silent` and topic pass through.
2. 200 and `replayed: true` both answer `sent`; the published reference row
   exists afterwards.
3. Each row of the §6 table gives its outcome, code and fallback flag.
4. A dropped connection after the body was sent, then a replay: two requests
   with the same `client_key`, outcome `sent`. A server that never answers:
   `uncertain` within the budget (injected clock).
5. `send_in_progress` with `retry_after_s: 1`: waits, retries the same key.
6. A closed port: nothing sent, fallback.
7. Uncoverable payloads (HTML over 16,384 code points, body over 65,536 bytes):
   no request at all.
8. Captured logs hold no text, chat id, key or credential.

`cloneDirectory.test.ts`
1. An `include=chats` answer maps chats to active, enabled targets; inactive
   and disabled targets cover nothing; private chats never.
2. Pre-release answers (400; a 200 without `active` / `chats`): unsupported, no
   coverage, no second fetch inside the TTL (request count).
3. Concurrent lookups make one request; a stale read returns the old snapshot
   and starts one refresh; invalidations fetch at most once per 60 s.
4. A persisted snapshot answers after a fresh module load with no request; a
   corrupt file or another `pairedAt` counts as absent.
5. Continuation via `/targets/{id}/chats` stops at the bounds.
6. Paused, unpaired or non-Celestia relays cover nothing.

`multiBot.test.ts` and `service.test.ts` (selector and service)
1. Covered group, text: one relay call, no Bot API `sendMessage`, `sentBy` is
   the clone, `sends.bot_id` is the clone's, no `POST /messages`, no handoff
   row.
2. The trigger case: the bot was removed, the clone covers the group: sent.
3. `clone_not_in_chat`: the bot posts, `refusals` lists the clone first, the
   directory is marked stale.
4. Rate limit: refused with `retryAfterSeconds`, no Bot API call; the same
   `clientRequestId` sends after the wait.
5. Uncertain: `send_uncertain`, no Bot API call; a retry under the same
   `clientRequestId` still answers `send_uncertain`.
6. Two-part plain text: two relay calls with different keys; a refusal on part
   two gives `send_partial` with part one's id.
7. The bridge report route call (`format: "html"`, `silent: true`) reaches the
   relay with `parse_mode: "HTML"` and `silent: true`.
8. An assigned bot, a private chat, media, a document and a prototype review
   never reach the relay, even when the directory covers the chat.
9. Hostile inputs, each with no relay call: a chat the operator never allowed
   (the allowlist refusal comes first, `service.ts:1083-1084`); a chat id
   absent from the directory; another user's private chat.
10. Without a supported directory, the existing service, selector and
    publication tests pass with no edits.

`ownerHistory.test.ts`: a service-answered-only pairing reads through the
directory's first active target; without directory support it answers
`no_target` as today; existing cases unchanged.

Rendered: one case in `src/components/TelegramBot.render.test.tsx` for a chat
row with a clone entry (en and uk), and a chat with a clone entry added to the
phone driver's existing "telegram bot" block
(`src/components/mobile/issue1671Evidence.browser.test.tsx:4032-4053`, its
fixture builds chat bots at `issue1671Evidence.fixture.tsx:1884`), which frames
the panel at its widths in both schemes.

### 13. Checks and rollout

- Typecheck through `gate-remote -- <command>`; ESLint on the touched files;
  the touched test files by path. The change touches neither the runtime host
  nor the Bun pin.
- No switch. The clone path wakes up by itself once the partner release
  answers discovery; until then the directory stays unsupported and nothing
  changes. The kill path already exists: pausing or unpairing the relay, or
  switching a target off, removes coverage at the next lookup.
- After the partner release, the operator's test post on each covered group is
  the live check (§14).

### 14. Condition for removing stored bot tokens (deferred, operator-approved)

Removal stays a separate step the operator approves. It becomes possible only
when all of these hold:

1. The partner release is live and the directory is supported for the pairing.
2. **Every configured destination proven live through a clone**: every
   allowlisted chat, every project's report chat, and the owner's private chat
   have a confirmed clone send in the journal after the release (`sends` rows
   with a `clone:` bot id), and the latest delivery on each was by a clone.
3. Every bot-only feature still in use has a replacement or the operator
   accepts losing it: media and documents (the partner's media slice), the
   prototype review's frames, buttons and polls, owner-chat sends with their
   reply context (the deferred owner-chat row of §9), and adding a chat by id
   (`service.ts:726-772` asks Telegram through a bot).
4. The chat allowlist survives without a token. Today it lives in the bot store,
   which every call refuses without a token and which removal deletes (E12). The
   removal step moves it off the token first.

## Validation against the requirement

- **Only the pairing credential, no AI request:** §2 sends with the credential
  alone; the partner's send makes no AI call (P1).
- **List the paired clones and their chats:** §3 reads them in one call; §10
  shows the clone on every allowlisted chat it covers; `relay_owner_history`
  lists the groups for reading.
- **Send as the clone bound there, idempotently:** §4 picks the bound clone;
  §6 derives one key per part from the committed claim and retries only with
  it.
- **Outbound paths use the clone where it covers the chat and fall back
  otherwise:** §5 and §9. Group text (agents, bridge reports, test posts) goes
  clone first. The payloads and chats the contract or the open lanes do not
  yet cover stay on the bot, as the fallback clause allows.
- **Read a group through the clone:** §8, the existing endpoint and client.
- **Nothing changes before the partner release:** §3, unsupported discovery.
- **Tokens kept, removal condition stated:** §14.

## Deferred — not currently justified

- **Media and documents through a clone.** The contract has none; the trigger
  is the partner's media slice.
- **Prototype reviews through a clone,** including a text-only review with its
  link when no bot is connected. Trigger: the media slice, or the token-removal
  step.
- **Owner private-chat text through a clone.** Trigger: the open owner-relay
  lanes land, and the outbound context lookup learns clone receipts.
- **Reply context for owner replies to clone-posted agent questions in groups**
  (`ownerOutboundContext.ts:26-55` keys rows by the receiving bot). Bridge
  report replies already resolve (§7). Same trigger as the line above.
- **Posting into a chat only a clone was ever in.** The allowlist holds only
  chats a bot has seen or looked up. Trigger: the operator asks to post into
  such a group, or the token-removal step.
- **Working with no bot connected at all,** which needs the allowlist off the
  token (§14 item 4). Trigger: the token-removal step.
- **Settling a pending clone claim on a later retry** by asking the relay with
  the same key. The derived keys keep this possible without a migration.
  Trigger: `send_uncertain` from the clone path shows up in practice.
- **A local mirror of the 30-a-minute window or a send queue.** Celestia
  enforces the limit and answers the wait.
- **Reading through `telegram_bot_messages`.** Agents read through
  `relay_owner_history`.
- **Any new switch, tool, tool argument or panel control.**

## Notes

- The prototype-review and owner-chat rows of §9 are this plan's reading of
  "where a clone covers the destination": a clone covers a send when it can
  carry the payload into that chat with today's behaviour around it intact. A
  seat that wants owner-chat text on the clone sooner can lift that row once
  the two owner-relay lanes merge.
- No performance gain is claimed. The hot reads (`status`, `listChats`) look
  up an in-memory map; discovery runs at most once per relay per 15 minutes
  under normal use and never on a timer.
