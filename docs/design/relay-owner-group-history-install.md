# Relay: owner group history on the install (dark)

Status: design, 2026-10-12. The operator has decided the read surface (§5):
any agent may read the history, as agents read the Telegram bot's chats today,
and voice Delegatus can read it too. Every other decision is taken here.

File anchors are on `0846ab8fb`, the base of this pipeline's branch. Remote
main is `bc51788ac`, seven commits later. Of the files cited here it changed
these:

- `src/lib/mcp/bindings.ts` gained five lines near `:1931`, so its anchors
  below that line sit five lines lower on main; `src/lib/mcp/server.ts` changed
  one description line and kept its line count.
- #2796 changed seven voice files this plan edits (`tools.ts`,
  `liveSession.ts`, `sessionConfig.ts` and four test files). The registry and
  the tool recorder work as described here; their lines moved. The table after
  §2 gives the same places on main, and the build merges main before its first
  voice edit (§7).

## Originating requirement (verbatim)

Operator, voice message of 2026-10-11 ~19:50Z, in the words the voice gateway
handed to the Delegatus seat (the gateway writes its directives in English):

> «implement a way for the operator to request Telegram group message history
> through Celestia Connect, but only for groups the operator belongs to. Include
> a way to show which groups the operator is in and retrieve messages for a
> chosen group/date range (for example, today). Ensure arbitrary users cannot
> make this request; it must be authorized as coming from the operator via
> Delegatus.»

Operator, 2026-10-12 ~04:30Z, in the Delegatus seat's conversation:

> «История групп будет только там, где бот или клон. Да, всё правильно.»

Operator, 2026-10-12, in the Celestia seat's conversation, recorded in
Celestia's design document and relayed here:

> «Так, роби історію груп: тільки групи, де є Celestia чи клон і де я учасник,
> як інструменти власника за тим самим вимикачем, просто апі запит на селестію,
> вона перевіряє права і видає.»

Operator, 2026-10-12 16:34Z, decision form on this task. The question as it
was shown, the answer chosen and the comment:

> «Історія твоїх Telegram-груп через Celestia (у них уже на проді, перемикач
> вимкнений до твого слова): хто може її читати?»
>
> «b) Будь-який агент, як чати бота сьогодні»
>
> «голосовому теж треба мати можливість читати.»

Pinned acceptance for this lane (task specification, 2026-10-12, verbatim):

> 1. A client for H1–H3 in the existing external relay code, behind the existing
>    owner-tools switch (default OFF, no new switch), with paging, the 429 rule
>    and the error envelope mapped to plain outcomes.
> 2. One owner-facing read surface that uses it and shows the data only to the
>    installation's operator. Which surface (a tool the operator's own agents
>    call, a screen, or both) is decided in the design stage from what the code
>    already has; if the existing code and the operator's words above do not
>    settle it, the design stage stops and asks instead of choosing.
> 3. The operator's IANA time zone is read from where the installation already
>    keeps it and sent as tz; the design names that place.
> 4. Group message content is private: it is never written to logs, bridge
>    reports, transcripts of other agents, test fixtures or evidence from real
>    chats. Fixtures and the recorded run use synthetic groups and messages.
> 5. The cross-check Celestia asks for (§9.2): a recorded API run with
>    credentials redacted covering list; today plus the next page; an explicit
>    3-day range; a continuation in a later call; a forbidden group; a bad tz; an
>    overlong range; malformed args; rate limit — committed under
>    evidence/external-relay/, with its path, size, sha256 and commit stated in
>    the build report. Record it against a double that follows the document; say
>    so in the report.

The decision of 16:34Z governs where it differs from item 2 and item 4: the
tool is open to every agent, and the agent that reads a page holds it in its
own transcript (§3.8, §4).

**Should this be built?** Yes. The quotes ask for it and Celestia's half is
merged. The minimum that serves them is a client, the tool, the voice read, the
time zone, the privacy rules and the recorded run. Everything beyond that sits
under [Deferred](#deferred--not-currently-justified).

## Was this solved before?

- `search_transcripts`, project-scoped and then unscoped, with three phrasings
  («история групп только там где бот или клон», "Telegram group message history
  through Celestia Connect groups the operator belongs to", "owner group history
  Celestia read surface tool or screen") found the operator's three statements,
  the seat's hand-offs to Celestia and Celestia's own design lane. No earlier
  design of the Delegatus side exists. `search_memory` returned nothing.
- After the decision: `search_transcripts` for the operator's comment about the
  voice and for "voice companion registry new read tool private content call
  record result", and `search_memory` for "voice companion tool registry
  Telegram group history read". The hits are the decision message itself and
  the voice lanes; none designed a voice read of private chat content.
- Three existing designs solve neighbouring problems, and this one reuses them:
  `docs/design/telegram-bot-account.md` Decision 6 (agents list a bot's chats
  and read one chat's messages through two MCP tools), `relay.md` §B.14 with
  `relay-slice3.md` §4.6 (relay chat text is hidden from every agent and read by
  the operator alone, in the browser), and `voice-tools-and-spend.md` item (a)
  (the voice reads through its own registry, which calls the real read
  implementations inside the Viewer).

## 1. Step one: Celestia's document against the relayed summary

**What was read.** The Celestia repository's main at `f1c79dcf`, file
`docs/design/relay-owner-group-history.md`, added by `507ac6e0` (their #3565):
34,077 bytes, SHA-256
`becc3785513c31c22411a00af4f8b7a2b3eea6348ef0c4ec097670d18fed5996`. The local
checkout's remote-tracking main equalled the remote head (`git ls-remote`); the
file was read with `git show`, and nothing in that checkout was changed. Four
files of the same commit settle bytes the document leaves open:
`apps/backend/api/schemas/relay_v1.json` (`$defs` `OwnerHistoryQuery`,
`OwnerHistoryGroups`, `OwnerHistoryPage`, `Error`),
`apps/backend/api/controllers/relay_owner_history.py`, the refusal lines of
`apps/backend/application/usecase/clones/owner_group_history.py`, and the cases
of `apps/backend/tests/api/test_relay_owner_history.py`.

Celestia's main has moved twice since, to `f232fe40` and then `8e1a0904`. At
`8e1a0904` the document is the same blob (`2fcbee95`, 34,077 bytes), the
controller, the use case and the endpoint test are the same blobs, and
`relay_v1.json` changed only in its clone and avatar definitions: the four
`$defs` named above compare equal.

Everything the summary states is correct. The table lists where the document
says more, says it differently, or where the summary's wording would mislead a
builder.

| # | The summary | The document (and the code behind it) | What it changes here |
|---|---|---|---|
| S1 | "the target must be assigned to this pairing" | §0, §5 row 2: the target belongs to the pairing's owner and is bound to this pairing with `answered_by: install`. Any other target answers 404 `not_found`. | The install picks an install-answered target (§3.3). |
| S2 | silent | §2, §5 rows 1 and 4: the pairing must be active and its owner Telegram-confirmed; a revoked or unverified pairing answers 401. | 401 maps to `unauthorized`. |
| S3 | H1 returns `{groups:[{chat_id,title}]}` | §3, §4.1: H1 accepts no query parameter (any one is 400). All groups arrive in one answer, sorted by lower-cased title, then chat id; `title` can be empty. The list uses the owner's recorded membership; the live Telegram check runs on history only. | A listed group can still answer 404 on history. H1 is sent with no query. Only `max_response_bytes` bounds its size. |
| S4 | H3 "with from=…&to=…" as a pair | §3, §4.2: each is optional alone. `from` only reads that day through today, `to` only reads that single day, neither reads today. | The client passes through exactly what the caller gave. |
| S5 | "cursor=<message_id>" | §3, §4.3, schema: the request `cursor` is a decimal string matching `^[1-9][0-9]{0,9}$`; the response `next_cursor` is a JSON string or null. | Both are strings in the schemas. |
| S6 | silent | §4.3: messages come in ascending `message_id` order; the next page is `message_id > cursor`. | The opposite of `telegram_bot_messages`, which is newest first. The tool description says oldest first. |
| S7 | "at most 100 messages and 12,000 UTF-8 bytes per page" | §4.3: the 12,000 bytes cover the complete HTTP body. A page can hold fewer messages than `limit` and still continue. `text` is cut at 4,096 code points and `media.description` at 1,000, ending in `…` with `truncated: true`; an emoji-heavy message can be cut shorter. | Only `next_cursor: null` ends a read; a short page can still continue. The client caps H2/H3 bodies at 12,000 bytes. |
| S8 | silent | §3: duplicate and unknown query parameters are 400. `limit` is 1..100. `chat_id` is a negative signed 64-bit integer and lives in the path only. Schema: `tz` is 1..64 characters. | The query is built once from a fixed key set. |
| S9 | a few field facts | §3, §4.4, schema: the page is `chat_id`, `title`, `timezone`, `start`, `end`, `oldest_stored_at`, `messages[]`, `next_cursor`; a message is `message_id`, `sent_at`, `author{user_id,name,username}`, `from_assistant`, `thread_id`, `reply_to_message_id`, `text`, `media{kind,description}` or null, `truncated`. Every key is present. Every object has `additionalProperties: false`. Nullable: `oldest_stored_at`, `author.name`, `author.username`, `thread_id`, `reply_to_message_id`, `media`, `media.description`. | Strict schemas (§3.1). |
| S10 | "sent_at … UTC" | §4.2: `sent_at` is the moment Celestia stored the message, normally seconds after sending; Telegram's own date only for backfilled rows. The window matches on that time. | A message sent seconds before local midnight can fall on the next day. The tool description says what the time is. |
| S11 | "start/end carry the zone offset" | §4.2: the window is `[from 00:00, to + 1 day 00:00)`. `end` echoes the next day's midnight. A daylight-saving day lasts 23 or 25 hours. | Continuation dates are derived as `from` = date of `start`, `to` = date of `end` minus one day (§3.5). |
| S12 | silent | §4.4, §11: every message carries its author's raw Telegram user id, current name and username. Messages their authors deleted in Telegram are still returned, because Celestia is never told. Edited messages keep their first text. A plain member can read stored messages from before they joined. | This is other people's personal data. §3.8 drops the user ids and treats the rest as private. |
| S13 | "no file ids" | §4.4: also left out are rows Celestia deleted, system notices, forward origin, quotes, poll options, reactions, document names, file sizes and media group ids. Celestia keeps the newest 30,000 rows per chat; `oldest_stored_at` shows where stored history starts. | The tool description says so, and an agent can tell the operator when older messages are gone. |
| S14 | "the HTTP error envelope of §5" | §5 mapping and `_error`: `{"error":{"code","message"}}`, where `message` is the code with spaces for underscores. 400 `malformed` (shape), 422 `malformed` (unknown zone, `from` after `to`, over 31 days), 401 `unauthorized`, 404 `not_found`, 426 `unsupported_version`, 429 `rate_limited`, 500 and 503 `server_error`. 400 and 422 share one code; the status tells them apart. | The outcome table of §3.7. |
| S15 | "with the switch OFF both endpoints answer 404 as an unknown route" | §5 rows 2, 3, 9, 14: OFF, a target routed to another pairing, an unknown group, a group without a bot or clone and an owner who is no member all answer the same 404 bytes. OFF is answered before the version, credential and query checks, so with OFF a bad credential also gets 404. | The install cannot tell "switched off there" from "no such group for you", and the outcome text says both. |
| S16 | "on 429 retry after Retry-After" | §0, §5 rows 1 and 11: two different 429s. Both endpoints share 60 admissions per minute per pairing; the 61st answers 429 with `retry_after_s` in the body and `Retry-After`. Repeated failed authentication from one address answers 429 too. Code: the value falls back to 60 s. Every history page costs one admission and one live Telegram lookup. | §3.6. A 31-day read at 100 messages a page is bounded by 60 pages a minute. |
| S17 | silent | §2, §5 row 10: 503 when the live Telegram lookup is unavailable, 500 on a database or Redis failure, never partial data. A switch flip or a revocation during a read discards the answer. | `service_error`: try again later. |
| S18 | silent | §6, §11: history adds no descriptor feature and ignores the tool-call and action switches. Only Celestia's owner-tools key gates it. | The install cannot learn from the descriptor whether history is on. It asks and reads the 404. |
| S19 | silent | §4.2: future days are allowed and return nothing. | No local date check. |
| S20 | item 5 of the pinned acceptance | §9.2 asks three things: where `tz` is read, which surface shows the data and to whom, and the recorded run. | §6 answers all three. |

The document also keeps the withdrawn tool-loop refusal table in §5, marked
"retained". Only its endpoint mapping is implemented.

## 2. Today in this repository

| # | Fact | Where |
|---|---|---|
| R1 | `relayCall` is the one transport: address pinned after DNS, HTTPS (plain HTTP on loopback only), `Delegatus-Relay-Version: 1`, the pairing Bearer, a byte cap, a timeout, redirects refused. The route is appended to the API base path, so a route may carry a query string. A 4xx or 5xx becomes `ExternalRelayError(code, status, retryAfterSeconds, payload)`; the retry value is read from `retry_after_s`, then from the `Retry-After` header. | `src/lib/externalRelay/client.ts:14-23`, `:64-170`, `:135-157` |
| R2 | The owner-tools switch is `relay:owner_tools:enabled` in `external-relay/switches.json` under the state directory. Absent, malformed or unreadable reads OFF. The tool loop, the claim capabilities and the round prompt read it. The operator's switch script accepts only the two other switches. | `src/lib/externalRelay/switches.ts:4`, `:10-15`; `toolLoop.ts:56`; `poller.ts:248-253`, `:300`; `prompt.ts:64`; `scripts/relay-switch.ts:5-7` |
| R3 | One rule names the Celestia target that stands for the owner: the first enabled install-answered target of an unpaused Celestia pairing, owner tier first, with a Telegram owner id. | `src/lib/externalRelay/ownerDestination.ts:9-29` |
| R4 | Every relay route is operator-only through one guard. It refuses a cross-origin request, a team member who is not the owner, a caller that presented an agent capability, and a staging Viewer. | `src/lib/externalRelay/routeGuard.ts:8-22`; `src/lib/team/actor.ts:71-81`; `src/lib/agent/operatorAuthority.ts:176` |
| R5 | The operator already reads relay chat text privately. The scanner skips the relay's conversation transcripts, so search, MCP tools, flows and composers never reach them. A relay route lists them and the feed routes serve exactly those files to a request that passes the guard of R4. | `src/app/api/external-relay/conversations/route.ts:12-20`; `conversationView.ts:112-143`, `:156-169`; `feedAccess.ts:15-22`; `src/components/externalRelay/RelayChats.tsx`; `relay-slice3.md` §4.6 |
| R6 | Agents already read Telegram chats through two MCP tools: one lists the chats of the operator's bot, one reads a chat's messages in pages. The bindings call one agent route in the Viewer, and the Viewer alone holds the token. The read route asks nothing about its caller beyond the origin check. The requirement behind them said "agents can read the messages the bot sees". | `src/lib/mcp/server.ts:3440`, `:3462`, `:4389`, `:4427`; `src/lib/mcp/bindings.ts:4904-4916`; `src/app/api/telegram/bot/agent/route.ts:23-46`; `telegram-bot-account.md` Decision 6 |
| R7 | The full MCP surface is present in every agent session, the operator's root session (the gateway identity) included. Three kinds of session keep their own closed boundary, which refuses any tool outside a short list: a board maintenance run, an issue reporter and a curator. The health-probe credential holds two reads. | `src/lib/mcp/toolAllowlist.ts:5-12`, `:97-105`, `:118-126`, `:322-365`; `src/lib/mcp/bindings.ts:6997-7005` |
| R8 | An MCP read called with a `clientRequestId` stores its whole answer in the receipt store on disk. A tool in `OPTIONAL_READ_KEY_TOOLS` skips that only when the key is omitted. `telegram_bot_messages` is outside the set, so its answers are stored. | `src/lib/mcp/server.ts:206-211`, `:2572-2596` |
| R9 | The operator's IANA time zone is kept in `operator-settings.json` under the state directory. Every browser that opens Delegatus reports `Intl.DateTimeFormat().resolvedOptions().timeZone` on load and on a language change; the settings route validates and stores it. `operatorTimeZone()` reads it, null until a browser has reported. Report headers already use it. | `src/lib/operator/settings.ts:55-57`, `:64-72`, `:119-126`; `src/lib/i18n/index.ts:75-79`, `:125-138`; `src/app/api/operator/settings/route.ts:42-54`; `src/lib/monitor/seatAutoRotation.ts:226` |
| R10 | Relay code logs fixed words and an error's class name, nothing from a body. The MCP slow-call line prints the tool name and phase times only. | `src/lib/externalRelay/poller.ts:238-241`; `answers.ts:108`; `src/lib/mcp/server.ts:3235-3239` |
| R11 | A recorded run is a test that drives real code against the local HTTP double, compares the bytes with a committed JSON and writes that file when an `LLV_RELAY_WIRE_OUTPUT_*` variable is set. The hash-pin tests read named files, so a new evidence file breaks no pin. | `src/lib/externalRelay/testRelay.ts`; `runner.test.ts:1825-1826`; `ownerPrivateLoop.test.ts:108-110`; `protocol.test.ts:48-52` |
| R12 | Every ordinary agent on this computer has full host access and can read the pairing credential in the state directory. | `relay-owner-tier.md` §8 |
| R13 | An MCP binding reaches the Viewer through the control channel. One attempt has 5 s, and an attempt that timed out is repeated within the budget. A GET read carries the control token and the MCP service claim and no caller identity. A POST adds the origin, and a binding whose route must know its caller passes `callerCapabilityHeaders()`, as the needs-you read does. | `src/lib/mcp/bindings.ts:313-317`, `:361-372`, `:447-456`, `:4036-4042`, `:6859` |
| R14 | Voice Delegatus holds no MCP inventory. Both of its backends are given exactly `COMPANION_TOOL_REGISTRY`; its Codex thread starts with `mcp_servers={}` and the shell off; a name outside the registry is `TOOL_NOT_ALLOWED`. | `src/lib/voiceCompanion/tools.ts:78-80`, `:169-170`; `codexProvider.ts:57`, `:65`, `:147-148`; `sessionConfig.ts:67` |
| R15 | A registry tool runs inside the Viewer process. The board reads call the MCP read implementations in-process, without receipts. The ten board reads pass a project fence and a per-call read ledger kept in memory. | `src/lib/voiceCompanion/liveSession.ts:213-222`, `:500-501`, `:522-549`; `readPaths.ts:18-19`; `boardReads.ts:7`, `:73-77` |
| R16 | Every voice tool call is written to the call's record on disk: its name, its arguments (4,000 characters) and its result (8,000 characters), in `voice-companion/transcripts/<session>.jsonl`, mode 0600, kept for the newest 50 calls and 30 days. A `tool.result` event carries the first 240 characters of the result's `speech`. The record also keeps what the backend handed to the voice and what the voice said. It is served only to the browser of whoever started the call; no scanner and no MCP tool reads it. | `src/lib/voiceCompanion/liveSession.ts:291`, `:497`, `:506-510`, `:617`; `transcriptRecord.ts:30-33`, `:71`, `:92`; `src/app/api/voice-companion/session/route.ts:57-72`; `http.ts:15-22` |
| R17 | Neither voice backend stores the conversation: the API requests send `store: false`, and the Codex thread is `ephemeral`, which writes no rollout file. | `src/lib/voiceCompanion/sessionConfig.ts:56`, `:69`; `codexProvider.ts:64`; `voice-codex-subscription.md:156`, `:295` |
| R18 | The Live model's instructions list its capabilities from the registry and name when to delegate. The backend's instructions allow a read "only for a question about the board, a prototype, or what the orchestrator was sent or reported", allow four tool rounds per delegation and ask for an answer of at most three short sentences. The voice window labels a call from a fixed table and falls back to the tool's name with spaces, as it does for `orchestrator_messages` and `search_transcripts`. | `src/lib/voiceCompanion/sessionConfig.ts:27`, `:31-36`, `:48`; `usage.ts:14`; `src/components/voiceCompanion/VoiceCompanion.tsx:82-86`, `:1160-1161` |
| R19 | A relay run that answers other Telegram users is an ephemeral agent started with no MCP configuration and no tools beyond optional web search, so it reaches no Viewer tool. A relay run that answers the owner is an ordinary agent; one function tells whether a conversation is such a live run, and the bindings already ask it. | `src/lib/agent/ephemeral.ts:176-179`; `src/lib/externalRelay/ownerAuthority.ts:11-29`; `src/lib/mcp/bindings.ts:7120-7123` |

**The voice anchors on main `bc51788ac`** (after #2796). `tools.ts`,
`codexProvider.ts`, `transcriptRecord.ts`, `http.ts`, the session route and
`VoiceCompanion.tsx` keep the lines given above.

| Place | On the base | On main |
|---|---|---|
| The Codex backend's tool calls reach `tool()` | `liveSession.ts:213-222` | `:233-242` |
| A spoken turn is recorded | `liveSession.ts:291` | `:311` |
| A refusal's `reason` is kept for speech | `liveSession.ts:472` | `:495` |
| `tool()`: the running record, the registry call, the status, the result record, the `tool.result` event | `liveSession.ts:497`, `:500-501`, `:505`, `:506-508`, `:509-510` | `:521`, `:524-525`, `:529`, `:530-532`, `:533-534` |
| The read ledger | `liveSession.ts:522-549` | `:549-576` |
| The backend's hand-off to the voice is recorded | `liveSession.ts:617` | `:644` |
| The capability list, the delegate list, the backend's instructions | `sessionConfig.ts:27`, `:31-36`, `:48` | `:30`, `:34-39`, `:53` |
| `store: false`, the backend's tool list | `sessionConfig.ts:56`, `:69`, `:67` | `:61`, `:74`, `:72` |
| The board reads' names and project fence | `boardReads.ts:7`, `:73-77` | `:9`, `:77-81` |

Main also added one thing this plan must respect: when a delegation spends its
tool rounds, the voice now says what it tried, built from each call's tool
name, a `query` argument and the first sentence of the result's `speech`
(`liveSession.ts:21-39` on main). This read has no `query` argument, and its
`speech` holds counts only (§3.8, point 8).

## 3. Decisions

### 3.1 Where the H1–H3 client lives

A new module, `src/lib/externalRelay/ownerHistory.ts`, built on `relayCall`
(R1). `client.ts` stays the transport and is not edited: a GET route with a
query already works, and `recordPublishedRelayReference` ignores it (it matches
only `POST /targets/{id}/messages`).

The wire schemas go to `src/lib/externalRelay/protocol.ts` beside the other
relay schemas: `ownerHistoryGroupsSchema` and `ownerHistoryPageSchema`, strict
objects that mirror Celestia's `$defs` (S9). `chat_id` and the other ids are
safe integers; a value outside the safe range fails the schema. An unknown key
fails the schema, which keeps a future file id or a new personal field from
passing through unseen.

The module exports:

- `readOwnerGroups(relay, targetId, runtime?)` — H1.
- `readOwnerGroupMessages(relay, targetId, query, runtime?)` — H2 when `query`
  holds only `chatId` and `tz`, H3 otherwise. `query` is `{ chatId, tz, from?,
  to?, cursor?, limit? }`, all strings except `limit`.
- `readOwnerHistory(input, ports?)` — what both surfaces call: it checks the
  switch, picks the target, reads the time zone, decodes a continuation, calls
  one of the two reads and shapes the answer (§3.8).

`runtime` injects `now`, as `createToolLoop` does (`toolLoop.ts:40`), so tests
hold the clock.

Request rules: the route is `/targets/${encodeURIComponent(targetId)}/owner/groups`
and `…/groups/${chatId}/messages?…`; the query is built with one
`URLSearchParams` from the keys `tz`, `from`, `to`, `cursor`, `limit`, each at
most once, absent when the caller gave none (S4, S8). Byte cap:
`relay.limits.max_response_bytes` for H1, 12,000 for H2 and H3 (S7). Request
timeout: 4 s, inside the 5 s the control channel gives one attempt (R13).

The client validates nothing that Celestia judges: dates, the 31-day span, the
zone, `limit` and the wire cursor go out as given, and Celestia's verdict comes
back as an outcome. One rule lives in one place, and the recorded run of §3.9
can drive every refusal through the real client. The client does check what
keeps the URL well formed: `chatId` matches `^-[1-9][0-9]{0,18}$`. The MCP tool
clamps `limit` to 1..100 above the client, as it does for every bounded number
(`server.ts:393`, `:501-520`); the recorded run calls the client below that
clamp.

Options considered: adding the functions to `client.ts` (it would mix one
feature's semantics into the transport), and calling Celestia from the MCP
server process (the credential would be used outside the Viewer; R6 shows the
existing choice).

### 3.2 The switch

`readRelaySwitches().owner_tools` (R2), read on every call. OFF: nothing is
sent, and the read answers `switch_off`. No descriptor feature is consulted
(S18). No new switch, no new key.

`scripts/relay-switch.ts` learns the name `owner_tools` (`on`/`off`), which
writes `relay:owner_tools:enabled`. Today the operator's word to switch owner
tools on can only be carried out by editing the private JSON by hand (R2). The
same switch already gates the owner tools of the relay tool loop, so the
operator's «за тим самим вимикачем» holds on both sides.

### 3.3 Which pairing and target

`selectOwnerDestination(readRelayStore().relays)` (R3), unchanged. Its target
is install-answered, which is what Celestia requires (S1), and it is the same
target that stands for the owner everywhere else. Its refusal reasons
(`no_relay`, `paused`, `no_target`, `invalid_owner`, `not_configured`) pass
through as outcomes. Neither surface takes a relay or target argument.

### 3.4 The operator's time zone

`operatorTimeZone()` from `src/lib/operator/settings.ts:119-126` (R9), read in
the Viewer process at the moment of the call and sent as `tz`. When it is null
the read answers `time_zone_unknown` and sends nothing: the host's zone is not
necessarily the operator's (`settings.ts:16-17`), and a guessed zone would
silently move "today". The zone becomes known the first time the operator opens
Delegatus in a browser.

A continuation uses the zone its first page used (§3.5), so a zone that changes
between two pages cannot shift the window.

One limit of the stored value: it is the zone of the browser that opened
Delegatus last (R9). On an installation whose team members sit in other zones,
a member's visit moves it. Every answer carries `timeZone`, `start` and `end`,
so the reader sees which day was read.

### 3.5 Paging

One call reads one page. The answer carries `nextCursor`, and the caller passes
it back as `cursor` to read the next page; `nextCursor: null` ends the read
(S7).

`nextCursor` is the install's own token: base64url of
`{"v":1,"chat":…,"tz":…,"from":…,"to":…,"after":…}`. `after` is Celestia's
`next_cursor`. `from` and `to` are the explicit dates of the window the first
page returned: `from` is the date part of `start`, `to` is the date part of
`end` minus one day (S11). A call with `cursor` sends H3 with exactly those
values. This is how a continuation that crosses local midnight keeps the same
explicit dates, in the same process or a later one, and why a "today" read
stays on the day it started. A token is at most about 220 characters.

The token is decoded with the same patterns Celestia uses (`chat` as in §3.1,
dates `^\d{4}-\d{2}-\d{2}$`, `after` `^[1-9][0-9]{0,9}$`, `tz` through
`isTimeZone`). A token that fails them, or a call that passes `cursor` together
with `chat`, `from` or `to`, answers `invalid_arguments` and sends nothing. The
token is unsigned: it grants nothing, since Celestia rechecks the pairing, the
target and the owner's membership on every page (document §4.3).

### 3.6 The 429 rule

After a 429 the install sends nothing more to that pairing's history endpoints
until `Retry-After` has passed. The read that received the 429 answers
`rate_limited` with `retryAfterSeconds`: the value `ExternalRelayError` carries
(R1), at least 1 s and at most 60 s. The module keeps a not-before time per
relay in the Viewer's memory, held on `globalThis` as `activity.ts:14-17` holds
the activity map. Until that time every history read for the relay answers
`rate_limited` with the seconds that remain and reaches no network. The first
read after it goes out. A Viewer restart forgets the time, and Celestia then
answers 429 again. The tool and the voice read share this one gate, because
both call `readOwnerHistory` in the Viewer process.

The client never sleeps inside a call. The control channel gives one attempt
5 s and repeats an attempt that timed out (R13), so a route that waited would
be asked twice. The caller is an agent, and it comes back after the stated
seconds.

Both kinds of 429 (S16) are treated the same way.

### 3.7 The error envelope as plain outcomes

A read answers `{ available: true, … }` or `{ available: false, reason,
retryAfterSeconds, note }`. `note` is one fixed English sentence per reason; an
agent relays it in the operator's language. No outcome carries a response body.

| Reason | When | Sent to Celestia? |
|---|---|---|
| `switch_off` | the install's owner-tools switch is OFF | no |
| `no_relay`, `paused`, `no_target`, `invalid_owner`, `not_configured` | `selectOwnerDestination` gave no target | no |
| `time_zone_unknown` | no browser has reported the operator's zone | no |
| `invalid_arguments` | a bad continuation token or a malformed chat id here; 400 or 422 `malformed` from Celestia (shape, unknown zone, `from` after `to`, over 31 days) | depends |
| `unauthorized` | 401: the pairing credential was refused or the pairing is revoked | yes |
| `not_found` | 404. On the group list: Celestia's switch is off, or the target is routed elsewhere. On messages: no such group for the owner, Celestia or a clone is absent there, the owner is no member, or Celestia's switch is off (S15) | yes |
| `unsupported_version` | 426 | yes |
| `rate_limited` | 429 after the rule of §3.6, with `retryAfterSeconds` | yes |
| `service_error` | 500 or 503: Celestia could not read now (S17) | yes |
| `unreachable` | DNS, connection, timeout, redirect, a refused address | attempted |
| `malformed_response` | a 200 whose body is not JSON, fails the schema or exceeds the byte cap | yes |

The read changes no relay state on any outcome: a 401 here does not park the
poller, and nothing is written to the activity map.

### 3.8 How message content stays private

**What Delegatus's own code guarantees, each with a test (§8):**

1. No log line. The module, the route, the binding and the voice read log
   nothing. A refusal carries a reason, a status and a retry value. A schema
   failure discards zod's issue text, which can echo a received value. This
   follows R10.
2. No store. Nothing is written under the state directory: no cache, no
   activity note, no file. A page lives in memory for one call.
3. No MCP receipt. The tool always takes the path that stores no receipt, with
   or without a `clientRequestId` (R8). The receipt store would otherwise keep
   whole pages on disk.
4. No caching in between: the route answers with `Cache-Control: no-store`.
5. Less data: the author's raw Telegram user id is removed before the answer
   leaves the module (S12). Names, usernames and chat ids stay, as the bot
   tools already show them (`telegram-bot-account.md` Decision 6).
6. Fixtures and evidence are synthetic. The double generates its groups, people
   and messages (names such as "Example group one" and "Member one", chat ids
   such as `-1001000000001`). No test, fixture, evidence file or pull request
   holds text, a title, an id or a name from a real chat, and no check calls
   Celestia.
7. The credential never leaves the Viewer process, never appears in an answer,
   and is written as `[redacted]` in the recorded run.
8. No page in the voice call's record. For this read the record keeps the
   tool's name, its arguments, its status and one count sentence; the page the
   backend received is not written (R16). The `speech` of the result, which
   also travels in the `tool.result` event and, on main, in the sentence the
   voice says when its tool rounds are spent, is a fixed sentence with counts
   and holds no title, name or text.

**Where the messages rest under the operator's choice.**

- *An agent.* The tool returns the page to the agent that called it, so that
  agent's transcript holds the messages, as it holds a page of the bot's chats
  today (R6). Other full-access agents can open that transcript, through
  `conversation_messages` or as a file (R12), and on a team installation every
  member who can open the conversation in the Viewer can read it. This is the
  cost the decision form named, and the operator chose it.
- *Voice Delegatus.* The page goes to the backend model for that delegation
  and into no file (R17, point 8). What the backend then hands to the voice,
  and what the voice says, is the conversation itself. The call's record keeps
  it like any other reply: a private file, the newest 50 calls and 30 days,
  served to the browser of whoever started the call, read by no agent tool
  (R16).

**Where a rule replaces a mechanism.** What the reader then writes is governed
by a contract, stated in the tool description, in the voice backend's
instructions and in a `privacy` field of every answer: use the messages only to
answer the operator in this conversation; never copy message text, names,
usernames, chat titles or chat ids into bridge reports, messages or requests to
other agents or seats, spawn prompts, task text or details, files, commits,
pull requests, issues or lessons. A bridge report may say that the answer is in
the conversation. No code can enforce that sentence, and this document says so
plainly. It is also the reason the voice reads by itself: a voice question
passed to the orchestrator would come back as a bridge report, which the
contract keeps empty of chat content.

### 3.9 The recorded cross-check run

File: `evidence/external-relay/install_owner_group_history.json`, written by a
test in the way of R11. The test drives `readOwnerGroups` and
`readOwnerGroupMessages` against a double and records each exchange as the wire
carried it.

The double is `src/lib/externalRelay/ownerHistory.fixture.ts`, a handler for
`startTestRelay` that follows the document: the paths of §3; the gate order
(switch, version, credential, query); the strict query of S8; the window, order,
page and cut rules of §4.2–§4.3 including the 12,000-byte body bound; the
refusal mapping of §5 with Celestia's error bytes (S14); one shape for every
404 (S15); and a counter of 60 admissions per minute per pairing shared by both
endpoints, answering 429 with `retry_after_s` and `Retry-After`. Its 400 and 422
cases are the ones Celestia's own endpoint test lists on the same commit
(`apps/backend/tests/api/test_relay_owner_history.py`: 400 for `limit` 0, 101
and 1.5, `cursor` 0, -1 and eleven digits, `from` `bad` and `2026-02-30`, an
empty `tz`, an extra key, a repeated key; 422 for an unknown zone, `from` after
`to`, 32 days and an unrepresentable bound). Its clock is a value the test
sets. Its data is synthetic (§3.8, point 6): three groups, about a dozen
messages over four days with a reply, a topic, a voice message with a
description, a message from the assistant, a null author name and one text long
enough to be cut.

Shape:

```json
{
  "spec": {
    "document": "docs/design/relay-owner-group-history.md",
    "revision": "507ac6e0",
    "bytes": 34077,
    "sha256": "becc3785513c31c22411a00af4f8b7a2b3eea6348ef0c4ec097670d18fed5996"
  },
  "recorded_against": "local double (ownerHistory.fixture.ts); no call to Celestia",
  "request_headers": { "Authorization": "Bearer [redacted]", "Delegatus-Relay-Version": "1" },
  "scenarios": [
    {
      "name": "list",
      "reads": [
        {
          "service_now": "2026-10-12T09:00:00Z",
          "exchanges": [
            {
              "request": { "method": "GET", "path": "/v1/targets/target_1/owner/groups", "query": {} },
              "response": { "status": 200, "headers": {}, "body": { "groups": [] } }
            }
          ],
          "outcome": { "available": true }
        }
      ]
    }
  ]
}
```

A scenario is a list of reads, each with the double's clock at that moment.
`query` is the decoded pairs in the order sent; `response.headers` holds
`Retry-After` when present; `outcome` is what the client returned, without the
page. A read that reaches no network has an empty `exchanges` list. A scenario
that starts from a prepared state names it in a `precondition` string.

Scenarios, in this order:

| Name | Calls |
|---|---|
| `list` | H1 |
| `today_and_next_page` | H2 with `tz` and `limit=3`; then the continuation, which carries the explicit date of the first page |
| `range_three_days` | H3 with `from` two days back and `to` today |
| `continuation_in_a_later_call` | H3 page one with `limit=2`; the double's clock then passes local midnight; a second read, started from the token alone, sends the same explicit dates |
| `forbidden_group` | H2 for a chat the owner is not in: 404 |
| `bad_tz` | H2 with an unknown zone: 422 |
| `overlong_range` | H3 over 32 days: 422 |
| `malformed_arguments` | three reads: `limit=0`, `cursor=0`, `from=2026-02-30`: 400 each |
| `rate_limit` | with 60 admissions already counted in the minute (stated as `precondition`): a read gets 429 with `Retry-After: 2` and ends as `rate_limited`; a read one second later reaches no network and reports the second that remains; a read after the two seconds gets 200 |

The test asserts the bytes equal the committed file, that the file holds
neither the fixture credential nor any `Bearer` value other than `[redacted]`,
and writes the file when `LLV_RELAY_WIRE_OUTPUT_OWNER_HISTORY` names a path.
The build report states the file's path, size, SHA-256 and commit, and says the
run was recorded against the double.

## 4. The read surface

### 4.1 What the code and the quotes settled, and what they left open

- The operator asked for "a way for the operator to request" history, by voice,
  to an agent, and later compared it to the owner tools («як інструменти
  власника»). No quote asks for a screen.
- A tool that lists chats and reads one chat's messages in pages already exists
  in exactly this shape (R6). A new tool can follow it file for file.
- A screen needs new UI: a group list, a day or range control and a message
  list. Nothing existing shows Telegram messages by date.

They left open whether other people's messages may rest in an agent's
transcript at all. The code holds two precedents that point opposite ways: for
the operator's own bot every agent may read chat messages (R6, R8); for relay
chats the text is hidden from every agent (R5). This lane guards private
message content and an authorization boundary, so the first attempt of this
stage stopped and asked. The options offered:

| # | Surface | Who can read the messages |
|---|---|---|
| 1 | One MCP tool for the agents the operator talks to directly: each project's designated orchestrator seat and voice Delegatus | The operator, in that conversation; every other agent refused |
| 2 | The same tool for every agent, like the bot tools | Any agent the operator or a team member directs; pages rest in any transcript |
| 3 | A private screen in the Celestia section of the Viewer | The operator's browser only; no agent, no transcript |
| 4 | Options 1 and 3 together | as in 1 and 3 |

The recommendation was option 1.

### 4.2 The decision, and the two reads it becomes

The operator chose option 2 and added that the voice must be able to read
(§5). In the code that is two reads over one function, because voice Delegatus
holds no MCP tools (R14):

1. **`relay_owner_history`, an MCP tool on every agent's surface**, built like
   the bot's two reads (R6): a binding posts to one Viewer route, and the route
   calls `readOwnerHistory`. The operator's root session calls it the same way.
2. **`relay_owner_history`, an entry in the voice's tool registry**, built like
   the voice's other reads (R15): its handler calls `readOwnerHistory` inside
   the Viewer process. No MCP server, no route and no receipt take part.

Both take the same arguments and return the same data.

### 4.3 Who reaches the read

| Caller | Path | Verdict | Decided in |
|---|---|---|---|
| Any agent session: a seat, a worker, a pipeline stage, on either engine | MCP tool, then the route with the caller's capability | admitted | route, step 3 (§7) |
| The operator's root session, with or without a capability | MCP tool, then the route | admitted | route, steps 3 and 4 |
| Voice Delegatus, on the API or the Codex backend | registry entry, in process | admitted | `voiceCompanion/tools.ts` |
| A live relay run that answers the owner in Telegram | MCP tool | refused, `owner_history_refused` | the binding, then the route |
| A relay run that answers other Telegram users | none | cannot call: it starts with no MCP and no tools (R19) | `agent/ephemeral.ts:176-179` |
| A board maintenance run, an issue reporter, a curator | MCP tool | refused by the boundary each already has (R7), as the bot reads are | `toolAllowlist.ts:322-365` |
| The health-probe credential | MCP tool | refused | `toolAllowlist.ts:118-126` |
| The owner's browser | the route, directly | admitted; no page of the Viewer calls it | route, step 4 |
| A team member's browser, when the member is not the owner; an anonymous request | the route | 403 | route, step 4 |
| A cross-origin request; a staging Viewer | the route | refused | route, steps 1 and 2 |
| A Telegram user, Celestia, any remote party | none | no path: Celestia answers only this pairing's credential, and the Viewer holds it | §3.1 |

**The one agent refusal.** A live owner relay run answers a message the owner
sent in Telegram, and its answer is posted into that Telegram chat, which can
be a group. Reading one group's history there could carry it into another
chat. Celestia's document defers the same case. The refusal reuses
`liveOwnerRelayConversation` (R19). It stops an agent that follows its
instructions. An agent that ignores them has host access anyway (R12).

### 4.4 What "only to the operator" means after the decision

Pinned item 2 says the surface shows the data only to the installation's
operator. After the decision the data is shown to whoever directs an agent or
a voice call on this installation. On a solo installation that is the
operator. On a team installation it is every member, exactly as for the bot's
chats today (R6): a member can ask an agent, or start a voice call
(`voiceCompanion/http.ts:9-14`).

A rule per member inside this tool would close nothing. Every ordinary agent
has host access and can read the pairing credential itself (R12), so a member
who may direct an agent is already inside the boundary. The boundary this
feature keeps is the installation: the endpoints are called only by the Viewer
with the pairing credential, the route refuses a browser that is not the
owner's, and nobody outside the installation has a path (§4.3, last row).

## 5. The operator's decision

Asked by the first attempt of this stage, answered on the task's decision form
on 2026-10-12 at 16:34Z (quoted in full at the top):

- **Who may read the history:** «Будь-який агент, як чати бота сьогодні».
- **Added:** «голосовому теж треба мати можливість читати.»

Nothing further is open. The parts of options 1, 3 and 4 that were not chosen
are listed under [Deferred](#deferred--not-currently-justified).

## 6. Answers for Celestia's cross-check (§9.2)

1. **Time zone.** The install reads the operator's IANA zone from
   `operator-settings.json` in its state directory through `operatorTimeZone()`.
   The operator's browser reports it. It is sent as `tz` on every history read,
   and a continuation repeats the zone and the explicit dates of its first
   page.
2. **Read surface.** By the operator's decision the install has no screen for
   this data. One tool serves the agents of the installation, and voice
   Delegatus has the same read. The endpoints are called only by the Viewer
   process with the pairing credential. The data reaches a person as an agent's
   answer in a conversation of this installation, or as speech in a voice call;
   the people who can direct either are the operator and, on a team
   installation, its members.
3. **Recorded run.** §3.9. Path, size, SHA-256 and commit come with the build
   report.

## 7. File-level plan

**Before the first edit:** merge `origin/main` into the pipeline branch with an
ordinary merge. #2796 changed the seven voice files this plan edits; merging
first keeps the voice edits on the current code. The voice line numbers below
are on main `bc51788ac`. Every other anchor is on the base, and the
`bindings.ts` ones sit five lines lower after the merge.

### New files

| File | Content |
|---|---|
| `src/lib/externalRelay/ownerHistory.ts` | §3.1–§3.8: the two reads, the not-before gate of §3.6, the outcome mapping, the continuation token, `readOwnerHistory`, the answer shaping (camelCase, author id removed, `privacy` sentence). About 200 lines. No `console` call, no file write. |
| `src/lib/externalRelay/ownerHistory.fixture.ts` | The double and its synthetic data (§3.9), and the scenario list the test replays. |
| `src/lib/externalRelay/ownerHistory.test.ts` | §8, group A, and the recorded-run byte check. |
| `src/app/api/external-relay/owner-history/route.ts` | `POST` with a JSON body `{ op: "groups" }` or `{ op: "messages", chat?, from?, to?, limit?, cursor? }`. A POST, because the route must know its caller (R13); it also keeps chat ids and dates out of URLs. Caller rule below. Domain outcomes answer 200 with the outcome object; a refused caller answers 403 `{ error, code: "owner_history_refused" }`. `Cache-Control: no-store`. The route answers within the 4 s of §3.1 and never waits. |
| `src/app/api/external-relay/owner-history/route.test.ts` | §8, group B. |
| `src/lib/mcp/relayOwnerHistory.test.ts` | §8, group C, in the pattern of `src/lib/mcp/telegramBot.test.ts`. |
| `src/lib/voiceCompanion/ownerHistoryRead.ts` | `ownerHistoryRead(args, read = readOwnerHistory)`: drops the registry's nulls, calls the read, and returns the voice shape (below). About 40 lines. |
| `src/lib/voiceCompanion/ownerHistoryRead.test.ts` | §8, group D. |
| `evidence/external-relay/install_owner_group_history.json` | The recorded run. |

### Edited files

| File | Change |
|---|---|
| `src/lib/externalRelay/protocol.ts` | `ownerHistoryGroupsSchema`, `ownerHistoryPageSchema` and their types. |
| `src/lib/externalRelay/routeGuard.ts` | `guardOwnerHistoryRoute(request)` appended beside `guardRelayRoute`: the caller rule below. A route module may export only route fields, so the rule lives here where the test can call it. |
| `src/lib/mcp/server.ts` | Tool `relay_owner_history` appended beside the bot tools: its name in `MCP_TOOL_NAMES`, its description, its input schema (`action: "groups" \| "messages"`, `chat`, `from`, `to`, `limit`, `cursor` up to 400 characters; no `clientRequestId`), `limit` in `MCP_BOUNDED_NUMERIC_ARGS` (1..100, fallback 50). The name joins `OPTIONAL_READ_KEY_TOOLS` and a new one-member set `RECEIPT_FREE_READ_TOOLS`; the condition at `:2576-2577` takes the receipt-free path for a member of that set whether or not a key came. |
| `src/lib/mcp/bindings.ts` | `relayOwnerHistory(args, control, dependencies)`: refuses a live owner relay run through the existing `ownerRelayCaller` (`:7120-7123`) with `McpToolRefusal`, code `owner_history_refused`, before any control call; otherwise posts the body to `/api/external-relay/owner-history` with `callerCapabilityHeaders()`, in the way the needs-you read does (`:6859`), then `redactPayload`. One line in the binding table (`:7583-7587`). |
| `src/lib/voiceCompanion/tools.ts` | `"owner-read"` joins the `class` union; `ToolEntry` gains `privateResult?: true`; `CompanionToolContext` gains `ownerHistory?` (the read, for tests); the entry `relay_owner_history` is added after the ten board reads; `PRIVATE_RESULT_TOOLS` is exported as the names of the entries that carry the flag. The name stays out of `READ_TOOL_NAMES`: those reads pass the project fence and the read ledger (R15), and this one has no project. |
| `src/lib/voiceCompanion/liveSession.ts` | `Options` (`:72`) gains `ownerHistory?`, passed into the tool context at `:524`. In `tool()` (`:530-532`), for a name in `PRIVATE_RESULT_TOOLS` the record's `result` is `JSON.stringify({ status, speech })`; every other tool keeps today's line. `triedTool`'s labels (`:33-36`) gain `relay_owner_history: "read a Telegram group"`. Nothing else in the file changes. |
| `src/lib/voiceCompanion/sessionConfig.ts` | `liveInstructions`: one bullet under "Delegate to the backend when" (`:34-39`): the operator asks which Telegram groups they share with Celestia or a clone, or what was written in one of them. A constant `OWNER_HISTORY_BACKEND_RULES`, in the way of `PROTOTYPE_BACKEND_RULES` (`:14`), joins `BACKEND_INSTRUCTIONS` (`:53`): a question about the operator's Telegram groups is answered with `relay_owner_history` (groups, then messages for today or the dates the operator named; `nextCursor` continues), the answer is a short summary for the operator, and no message text, name or title goes into a request to the orchestrator. The read rule in the same string gains "or the operator's Telegram groups". |
| `scripts/relay-switch.ts` | Accepts `owner_tools on\|off`; usage text updated. |
| `src/lib/externalRelay/fixtures/relay_v1/README.md` | A section "Owner group history (H1–H3), dark": the pin of Celestia's document (§1), the evidence file's path, bytes and SHA-256, the variable that rewrites it, and the sentence that the run is recorded against the double. |
| Voice pins | `src/lib/voiceCompanion/sessionConfig.test.ts:33` lists the registry's names and gains one; `tools.test.ts:37` holds one argument set per registry tool and gains one. |
| MCP list pins | Whatever pins the tool list or its sizes (`schemaParity.test.ts`, `callCost.test.ts`, the `answerSizes.*.json` baselines, `server.test.ts`) is updated for one more tool; the builder runs those files and updates only what they name. |

No file under `src/components` and no i18n file is edited. The voice window
shows this call with the tool's name while it runs and the count sentence when
it ends (R18). `src/lib/mcp/toolAllowlist.ts` is not edited: the tool carries no
rule by caller kind.

### The MCP tool

One tool with an `action`, as `issue_report` and `conversation_action` have, so
the receipt rule and the privacy contract are each stated once. It stays in the
list while the switch is OFF and answers `switch_off`: the MCP list is fixed
per session, and a session that is running when the operator flips the switch
must be able to call it. The description tells an agent: messages come oldest
first; `sentAt` is when Celestia stored the message; a short page can still
continue and `nextCursor: null` ends the read; `oldestStoredAt` marks where
stored history begins; deleted and edited messages behave as S12 says; and the
privacy contract of §3.8. The orchestrator mandate is not edited, and no role
scaffold or pipeline prompt names the tool.

Answer shape for `messages`:
`{ available, chat, title, timeZone, start, end, oldestStoredAt, messages: [{
messageId, sentAt, author: { name, username }, fromAssistant, topicId,
replyToMessageId, text, media: { kind, description } | null, truncated }],
nextCursor, privacy }`. For `groups`: `{ available, groups: [{ chat, title }],
privacy }`. `chat` is the chat id as a decimal string.

### The route's caller rule

`guardOwnerHistoryRoute`, in this order:

1. `rejectCrossOrigin` (`src/lib/sameOrigin.ts:51`).
2. A staging Viewer: 409, as `guardRelayRoute` answers.
3. A request that presents an agent capability which names a conversation
   (`callerConversationId`, `operatorAuthority.ts:49`): 403
   `owner_history_refused` when `liveOwnerRelayConversation` says it is a live
   owner relay run; admitted otherwise.
4. Any other request: the rest of `guardRelayRoute` (R4). It admits the
   Viewer's own MCP server acting for a caller that has no capability, such as
   the operator's own terminal session, and the owner's browser. It refuses a
   team member who is not the owner and an anonymous request.

The binding applies the relay-run refusal first; the route repeats it because
any local process can reach the route.

### The voice read

Registry entry: name `relay_owner_history`, class `owner-read`,
`privateResult: true`. Capability line: "Telegram groups: the operator's groups
where Celestia or a clone is present, and what was written in one of them on a
day or over a range." Parameters, every key required and the optional ones
nullable, as the registry's strict schema demands (`tools.ts:34-35`):
`action` (`groups` or `messages`), `chat`, `from`, `to`, `cursor` (strings or
null), `limit` (integer 1..100 or null).

`ownerHistoryRead` returns:

- for groups: `{ status: "done", groups, privacy, speech }`;
- for messages: `{ status: "done", title, timeZone, start, end, oldestStoredAt,
  messages, nextCursor, privacy, speech }`;
- for an outcome of §3.7: `{ status: "refused", code: reason, reason: note,
  retryAfterSeconds, speech: note }`, which the session already records and
  speaks as a failed tool (`liveSession.ts:529`, `:495`).

`speech` is fixed English with counts: "3 groups listed.", "42 messages, oldest
first. More follow: call again with cursor set to nextCursor.", "42 messages,
oldest first. That is the end of this range." It never holds a title, a name or
message text, because the session copies it into the call's events and record
(R16).

The entry is in the registry whatever the switch says, and answers
`switch_off` while it is OFF. On the API backend one delegation makes at most
four tool calls (R18), so the voice reads the group list and three pages, or
four pages, per question, and each delegation starts from the first page (see
Deferred). On the Codex backend a later question continues from `nextCursor`,
because the thread keeps earlier results.

### Fences

No fenced file is touched: `install_tool_loop_owner.json`, its double
(`toolLoop.fixture.ts`, `ownerCapture.*`), the orchestrator mandate, the task
card, the board header, the pipeline engine and `src/lib/memory` stay as they
are. `server.ts` and `bindings.ts` are edited by many lanes; every change here
is an appended entry, and their anchors are re-read after the merge (the note
at the top).

One open pull request edits the voice registry too: #2793 adds a board read.
Its hunk in `tools.ts` is at `:67-70`, apart from the entry this plan adds
after the board reads at `:81-85`. The two lanes meet in the names list of
`sessionConfig.test.ts:33` and the argument map of `tools.test.ts:37`; whichever
lands second adds its name again after merging.

## 8. Tests

Each file runs by path, several files in one call:
`bash scripts/gate-slot.sh bun test <file> …`, with `HOME`, `XDG_CONFIG_HOME`,
`TMPDIR` and `LLV_STATE_DIR` under `/tmp` and `LLV_VIEWER_CONTROL_URL` on a
closed port. No directory sweep, no live state, no call to Celestia. Every test
below fails on main, where the module, the route, the tool and the registry
entry are absent.

**A. `src/lib/externalRelay/ownerHistory.test.ts`** (real client against the
double)

1. Switch OFF: both reads answer `switch_off` and the double counts zero
   requests. Switch ON with a paused pairing, no Celestia pairing, no
   install-answered target: the matching reason, zero requests.
2. H1: `GET`, the exact path, no query, `Authorization: Bearer <credential>`
   and `Delegatus-Relay-Version: 1`; the groups parse.
3. H2: the query holds `tz` alone, percent-encoded. H3: `from`, `to`, `cursor`
   and `limit` appear once each, exactly as given, and an omitted one is absent.
4. `from` only and `to` only are sent as given (S4).
5. Paging: page one returns a token; the call with that token sends the same
   chat, zone and dates with Celestia's cursor; the last page returns
   `nextCursor: null`. A page shorter than `limit` with a cursor continues (S7).
6. Midnight: a "today" read served at 23:59:50 local; the double's clock moves
   to 00:00:10; the continuation sends `from` and `to` equal to the first day
   and returns that day's remaining messages. The same with a zone change in
   the operator settings between the pages.
7. A tampered token, a token used with `chat` or dates beside it, a malformed
   chat id: `invalid_arguments`, zero requests.
8. 429: the read answers `rate_limited` with the body's `retry_after_s`, and
   with the header's value when the body has none. A second read before that
   time reaches no network and answers the seconds that remain; the first read
   after it is sent. The gate holds for both endpoints of one relay and leaves
   another relay alone.
9. One case per row of §3.7: 400, 422, 401, 404 on the list, 404 on messages,
   426, 500, 503, a dropped connection, a timeout, a redirect, a 200 that is
   not JSON, a 200 with an unknown key, a 200 with a `file_id` key, a 200 with
   a numeric `next_cursor`, a body over 12,000 bytes.
10. Time zone: with no stored zone the read answers `time_zone_unknown` and
    sends nothing; a stored zone is sent unchanged.
11. Answer shape: no `user_id` anywhere, no key containing `file`, every wire
    field mapped, `privacy` present; compared with the fixture page.
12. Privacy sentinels: a unique synthetic message text, a synthetic title and
    the credential appear in no `console` output (spied) and in no file under
    `LLV_STATE_DIR` after successful and refused reads (the directory is walked
    and searched); a refusal object holds no response body.
13. No relay state changes: the relay store and the activity map are equal
    before and after a 401.
14. The recorded run: bytes equal the committed evidence file; all nine
    scenarios present; no credential in the file.

**B. `src/app/api/external-relay/owner-history/route.test.ts`**

1. Cross-origin: refused.
2. The capability of an ordinary worker conversation, of a designated seat and
   of the root conversation: 200 each, with the double's data.
3. The capability of a live owner relay run: 403 `owner_history_refused`, zero
   requests at the double. The same conversation after its run ended: 200.
4. No capability, with the Viewer MCP service claim: 200. No capability on a
   solo installation: 200. No capability from a team member who is not the
   owner, and an anonymous request on a team installation: 403, zero requests.
5. Staging: refused on both branches.
6. The response carries `Cache-Control: no-store` and holds no credential and
   no owner id.
7. An unknown `op` and a body that is not JSON: 400.
8. A slow double: the route answers `unreachable` inside 5 s.

**C. `src/lib/mcp/relayOwnerHistory.test.ts`** and
`src/lib/mcp/toolAllowlist.test.ts`

1. A worker, a designated seat, the root and an unidentified caller: each makes
   one POST to the route with the expected body, and the capability header when
   the caller has one. `permitMcpTool` allows the tool for all four.
2. A live owner relay run: `owner_history_refused`, and the control channel is
   never called.
3. Receipt-free: two calls with one `clientRequestId` reach the binding twice,
   both answer `replayed: false`, and the receipt store (memory and SQLite)
   holds no row and no sentinel text afterwards.
4. `limit` clamps to 1..100. `action: "messages"` without `chat` and without
   `cursor` is refused before any read.
5. `tools/list`: the schema does not require `clientRequestId`; the description
   holds the privacy contract sentence.
6. The three closed boundaries of R7 refuse the tool
   (`permitMaintainerTool`, `permitIssueReporterTool`, `permitCuratorTool`),
   and the health-probe identity is refused.

**D. Voice: `src/lib/voiceCompanion/ownerHistoryRead.test.ts`,
`tools.test.ts`, `liveSession.test.ts`, `codexConversation.test.ts`,
`sessionConfig.test.ts`**

1. `ownerHistoryRead` against the double through the real `readOwnerHistory`:
   groups, a first page, a continuation from `nextCursor`. Each `speech`
   matches its fixed sentence and holds none of the sentinel title, name or
   text. Nulls from the registry reach the read as absent keys.
2. Each outcome of §3.7 becomes `status: "refused"` with `code` and the fixed
   note; with the switch OFF the double counts zero requests.
3. `tools.test.ts`: the registry holds the entry; its schema lists every key as
   required; an extra key is `INVALID_TOOL_ARGUMENTS`; the entry runs with no
   project in the context.
4. `liveSession.test.ts`, API backend: a delegation whose backend calls the
   tool, with an injected read that returns a page holding a sentinel text. The
   `function_call_output` sent to the backend holds the page. The call's record
   file, `voice-companion.json` and every emitted event hold no sentinel; the
   record's `result` for this call equals `{ status, speech }`. Control in the
   same test: a `list_tasks` call still records its result as today. A second
   case spends the tool rounds on this read: the sentence the voice says about
   what it tried holds the count and no sentinel.
5. `codexConversation.test.ts`: the thread's `dynamicTools` hold the entry; an
   `item/tool/call` for it is answered with the page; the record holds no
   sentinel.
6. `sessionConfig.test.ts`: the names list; the Live instructions hold the new
   bullet and the capability line; `BACKEND_INSTRUCTIONS` names the read and
   the rule about requests to the orchestrator.

**E. Small ones**

- `src/lib/externalRelay/protocol.test.ts`: the two schemas accept the example
  objects of the document's §3 and refuse an extra key, a missing key and a
  numeric cursor.
- `src/lib/externalRelay/switches.test.ts`: `relay-switch.ts owner_tools on`
  and `off`, run under an isolated state directory, set and clear
  `relay:owner_tools:enabled`; `status` prints it.

**Checks before the pull request:** the files above by path; the local privacy
gate over every changed file (with the two `LLV_PRIVACY_*` variables the hook
sets); `tsc`; eslint on the changed files. Hosted checks are not waited for.
No rendered evidence is owed: no component, style or visible string changes.

## 9. Rollout

1. Merge dark: the install's switch is OFF, so no request to Celestia changes.
   Two things are visible at once: every agent's tool list holds
   `relay_owner_history`, and the voice's capability list holds the Telegram
   groups line. Both answer that group history is switched off.
2. Send Celestia the answers of §6 and the evidence file's path, size, SHA-256
   and commit. They replay the run on their real path.
3. After the joint cross-check and on the operator's word: Celestia sets its
   key, and here `bun scripts/relay-switch.ts owner_tools on`. The same switch
   also enables the owner tools of the relay tool loop on this side, which is
   the operator's stated intent.
4. First real read: the operator asks an agent or the voice for the group
   list. Nothing from that read goes into a report or an issue.

## Deferred — not currently justified

- **The tool for seats and the voice only** (option 1 of §4.1). The operator
  chose every agent.
- **A screen** (options 3 and 4). No quote asks for one, the operator did not
  choose it, and it needs a prototype round.
- **A rule per team member.** §4.4: a member who may direct an agent already
  holds what the rule would guard.
- **History in the owner's Telegram chat with a clone** (a live owner relay
  run calling the tool). Its answer is posted into a Telegram chat, which can be
  a group. Celestia's document defers the same case.
- **Hiding these tool results inside `conversation_messages` from other
  agents.** Any full-access agent can read the transcript file directly (R12),
  so the filter would slow a reader down without closing the path.
- **The page in the voice call's record.** The operator hears the answer and
  can read the group in Telegram; a stored copy of other people's messages adds
  nothing to that.
- **A voice read that continues in a later question on the API backend.** That
  backend keeps nothing between delegations except the read ledger's summary
  lines (R15), so a busy day ends for the voice after about three pages. The
  Codex backend continues, and an agent pages without that bound. Carrying the
  token in the ledger is a few lines if the limit is felt.
- **A voice registry that lists this read only while the switch is ON.** The
  registry is one constant read by both providers and by pinned tests (R14);
  a per-call list would thread a flag through all of them to hide one line
  for the days before the operator's word.
- **A label for this read in the voice window.** The window falls back to the
  tool's name, as it does for two reads today (R18); a label is a visible
  string and a rendered-evidence round.
- **Reading a whole range in one call.** One page per call keeps every answer
  under 12,000 bytes and leaves the pace to the caller and the 60-per-minute
  limit.
- **A local copy, search or author filters.** A stored copy is exactly what
  §3.8 forbids; filtering is the reading agent's work over the pages.
- **Author ids in the answer.** Names and usernames answer "who said what".
- **A time zone argument and a host-zone fallback.** The stored zone is the
  operator's; a guess can move "today".
- **A time zone kept per person.** The installation keeps one (R9), and each
  answer already shows the zone it used.
- **A descriptor check to tell "switched off there" from "no such group".**
  Celestia publishes no feature for history (S18).
- **Choosing among several pairings or owners.** One rule already names the
  owner's target (R3).
- **Local validation of dates and ranges.** Celestia judges them once.
- **An ADR.** Every decision here is reversed by a switch or a small pull
  request.

## Validation against the requirement

- «request Telegram group message history through Celestia Connect»: H1–H3
  through `relayCall` with the pairing credential (§3.1).
- «only for groups the operator belongs to» and «только там, где бот или клон»:
  Celestia decides the list and rechecks membership on every page; the install
  adds no group of its own and shows a refused group as `not_found`.
- «show which groups the operator is in and retrieve messages for a chosen
  group/date range (for example, today)»: the `groups` and `messages` actions;
  today by default in the operator's zone (§3.4), explicit days up to 31,
  pages that continue correctly across midnight (§3.5).
- «arbitrary users cannot make this request; it must be authorized as coming
  from the operator via Delegatus»: Celestia takes the owner from the pairing.
  Here the endpoints are called only by the Viewer with that pairing's
  credential; a relay run that answers Telegram users has no tool at all, the
  run that answers the owner in Telegram is refused, and a browser that is not
  the owner's is refused (§4.3). Who may ask inside the installation is the
  operator's own decision of 16:34Z (§4.4).
- «як інструменти власника за тим самим вимикачем»: the existing
  `relay:owner_tools:enabled`, default OFF, nothing sent while OFF (§3.2).
- «просто апі запит на селестію, вона перевіряє права і видає»: two GETs, no
  claim, no lease, no local re-validation of what Celestia judges (§3.1).
- «Будь-який агент, як чати бота сьогодні»: one tool on every agent's surface,
  built on the bot reads' pattern, with no rule by caller kind (§4.2, §7).
- «голосовому теж треба мати можливість читати»: the same read in the voice's
  own registry, on both of its backends (§4.2, §7).
- Pinned items 1, 3 and 5: §3.1–§3.7, §3.4, §3.9. Item 2: §4, as the decision
  changed it. Item 4: §3.8; logs, bridge reports, fixtures and evidence hold no
  chat content, and the reading agent's own transcript holds the page it asked
  for, which the decision accepts.

## Decisions taken here without the operator

1. The client is a new module over the existing transport; `client.ts` is not
   edited.
2. One page per call, with an install-made continuation token that pins the
   zone and the explicit dates.
3. An unknown operator zone refuses the read; the host's zone is never used.
4. Telegram user ids are removed from every answer.
5. One MCP tool with an action, listed while the switch is OFF.
6. The tool's reads never leave an MCP receipt.
7. `scripts/relay-switch.ts` accepts `owner_tools`, so the operator's word can
   be carried out with a command.
8. The owner's target is chosen by the existing `selectOwnerDestination`.
9. 429: the read answers at once, and the install sends nothing to that
   pairing's history endpoints before `Retry-After` has passed.
10. A live owner relay run is refused; it was named as the one exception in the
    option the operator chose.
11. Celestia's own example chat ids and names are not copied; the double has its
    own synthetic data.
12. The voice reads through an entry in its own registry that calls the same
    function in the Viewer process, because the voice holds no MCP tools.
13. The voice call's record keeps this read's name, arguments and count
    sentence and leaves the page out.
14. The voice entry is always in the registry and answers `switch_off` while
    the switch is OFF.
15. No rule per team member, and no label or screen: no component and no
    visible string changes.
