# Per-project relay clone, clones and avatars through MCP, team members' messenger identity

## Originating requirement

Operator, 2026-11-02 ~13:40 UTC, the Delegatus seat chat (voice, verbatim
excerpts):

> «к каждому проекту привязывать разного, э-э, разных ботов. То есть
> оркестратору привязывается к оркестратору там, где настройка звиты [звіти],
> привязывается Telegram бот, то есть можно выбрать из того из клонов, который
> будет публиковать.»
>
> «вместо того чтобы создавать клона через UI, я бы хотел, чтобы было
> возможность использовать штатный механизм... ну, штатных агентов ... MCP ...
> чтобы можно было создавать клонов. Оркестратором.»
>
> «пусть он не предлагает, но по крайней мере он знает, имеет информацию о том,
> что у него есть такая возможность.»
>
> «Иметь возможность сгенерировав картинку привязывать её. К боту ... через API
> SLST [Celestia] ... через бот API не получится, потому что у нас доступа к
> токену нет ... бот там управляет SLST.»

Operator, 2026-11-02 ~13:45 UTC, comment on the task (verbatim):

> «сюди треба додати ще дещо - щоб можна було прив'язувати учасн6ика команди до
> телеграм акаунту - і щоб бот якось мав інфу (мб потім не тільки телеграм, а
> навіть слак) але суть в тому щоб зберігати сутність користувача, щоб можна
> було потім юзати цю базу айдішників і відправиляти повідомлення з бота
> (ретратранслятором)»

Operator, 2026-11-02 ~13:55 UTC, principle (verbatim):

> «бажано щоб це саме agent first було, щоб через агента все рішати а не в UI»

The pinned specification turns this into four parts, each with an MCP tool on
the Delegatus server (key `viewer`) as its primary surface, consent and safety
enforced on the server, and a UI that shows state and offers a one-action
confirmation only where a person must confirm. A human confirmation is always
an agent-initiated request that a person settles with one action.

**Should this be built?** Yes, in the slices below. Parts 1 and 2 reuse code
that exists. Part 3 is half there: generating a portrait for a clone that is
still being created works on Celestia's side today, and Delegatus calls it the
wrong way (§3.5). Changing the photo of a clone that already exists, and
messaging a team member other than the owner, need Celestia endpoints that do
not exist; they are written as explicit cross-project requests (§8).

## 1. Prior work and open work on the same files

- `docs/research/celestia-clone-creation.md` (2026-10-11) designed the
  one-button clone. Decisions recorded there (`:239-249`): the form lives in
  the Celestia card, the photo comes from Celestia's generator (four
  candidates, at most five generations a day) with upload and «Без фото»
  beside it, the new clone is answered by this installation with Celestia as
  the fallback, and the block shows only on a paired Celestia card.
- `docs/design/relay-send-as-clone.md` built group text through a clone. Its
  §9 left owner private-chat text and media on the bot path; its §14 states
  the condition for removing stored bot tokens (task 8ca994ec, still open).
- `docs/design/sign-in-and-team.md` §5.3 built "Link my Telegram" through the
  installation's own bot, with the code typed back into the browser.
- The fix lane of the clone button (2026-10-11, lane 0f1a2b9a) already noted
  that Celestia's own design used `/clone-requests/{id}/avatar-candidates`,
  `candidate_id` and a `PATCH` to choose, unlike the branch, and that the two
  had to be synchronised before `clone_create` was switched on. No commit
  since touched `src/lib/externalRelay/cloneCreate.ts` for it (`git log`:
  `a8e005428` #2757 and `11a5d55fa` only). §3.5 shows the switch is now on.
- The first attempt of this design (lane d9f6709c, 2026-11-02 13:16 UTC) died
  in a deploy before writing anything; its progress notes reached the same
  drift. Transcript and memory search found no earlier design for messaging
  team members through the relay.
- Related open tasks: 8ca994ec (group messages through a clone without a bot
  token; token removal deferred), 65762062 (a clone binding that stays
  inactive until the clone is re-added to the group), 9b76e868 (live check of
  button clone creation).

Open pull requests touching files this plan names, read 2026-11-02 14:10 UTC
(`gh pr list --state open`, 28 open):

| PR | Overlap | Effect on this plan |
|---|---|---|
| #3552 | `src/lib/projects/settings.ts`, `src/app/api/projects/settings/route.ts`, `src/lib/mcp/bindings.ts`, `server.ts` | Adds `pipelineStageRuntime` to `seat_tick_settings`, writable by the operator root or that project's designated seat (`projectRuntimeAuthority`). Slice 1 uses the same authority rule and lands after it, or copies the eight-line check if it has not merged. |
| #3577 | `settings.ts`, the settings route | Rebase only; no shared field. |
| #3415 | `src/lib/team/store.ts` and other team files | Slice 5 adds a table to `team.sqlite`; it lands after #3415 or rebases on it. |
| #3532 | `src/lib/externalRelay/protocol.ts` | No shared schema; rebase only. |
| #3572, #3566, #3508, #3265, #3263 | `src/lib/team/workspaceRoutes.ts`, MCP files | Slice 2 removes one line from `workspaceRoutes.ts` (`:55`); rebase only. |

## 2. What Delegatus has today

### 2.1 Relay client and clone creation

| # | Fact | Where |
|---|---|---|
| D1 | Every relay call goes through `relayCall`: DNS pin, redirect refusal, response cap, `Delegatus-Relay-Version: 1`, bearer pairing credential, error envelope parsed into `ExternalRelayError(code, status, retryAfterSeconds)`. | `src/lib/externalRelay/client.ts:75-202` |
| D2 | Clone creation calls `POST /clone-requests` with `{name, username, photo}`, where `photo` is `{kind:"jpeg", data}`, `{kind:"candidate", storage_key}` or null, with a 15 s timeout. It refuses while a created clone's setup is unfinished (`clone_setup_pending`) and replaces any open request. | `cloneCreate.ts:129-160` (`:134`, `:139-145`, `:148-153`) |
| D3 | Avatar generation calls `POST /clone-avatars {prompt}` with a 120 s timeout and expects `{candidates:[{storage_key, url}]}`; it downloads each candidate and returns 160 px JPEG previews. | `cloneCreate.ts:217-245` (`:227`); UI `src/components/externalRelay/CloneCreate.tsx:135` |
| D4 | An uploaded picture becomes a 640 px square JPEG with `sharp` (`photo_unreadable` otherwise). | `cloneCreate.ts:62-81` |
| D5 | The open request and the created record live on the paired relay in `external-relay/relays.json` (0600). | `src/lib/externalRelay/store.ts:28-71`, write `:171-183` |
| D6 | The block shows only when the descriptor lists `clone_create`. | `cloneNames.ts:9-12` |
| D7 | After `created`, the browser finishes the setup: default engine `codex-cloud` with its model, `answered_by: install` on the relay, then forgets the created record. A closed page finishes it on reopen. | `CloneCreate.tsx:245-290`; engine `ExternalRelaySection.tsx:607` |
| D8 | The clone routes admit only the operator: same origin, owner in team mode, `requireOperatorAuthority`, which refuses any caller with an agent conversation. | `src/lib/externalRelay/routeGuard.ts:9-23`; `src/lib/agent/operatorAuthority.ts:140-151` (`:141`) |
| D9 | A relay's local id is minted per pairing attempt, so re-pairing changes it. | `pairing.ts:30`, `:103` |

### 2.2 Seat report destination and who posts

| # | Fact | Where |
|---|---|---|
| R1 | A project's report destination is `reportTelegram {chat, name, topicId?, changedAt, changedBy}` or "Log only" (`chat: null`) in `project-settings.json`. Absent means log only. | `src/lib/projects/settings.ts:39-76`, decode `:114-124` |
| R2 | `setReportTelegram` writes a fresh object each time. | `settings.ts:336-356` (`:348`) |
| R3 | Only the operator sets it, and only to a chat the bot store allows posting in. "Agents read the settings (get_orchestrator, list_pipelines) and have no write path." | `src/app/api/projects/settings/route.ts:118-120`, `:181-219` |
| R4 | `get_orchestrator` answers `reportTelegram` as the effective destination `{chat, name, topicId?, source:"chosen"}`. | `src/lib/mcp/bindings.ts:4576-4583`, used at `:4720`, `:4745` |
| R5 | A manager's bridge report renders HTML for that chat and posts it through `/api/telegram/bot/agent` with `op:"send"`, `format:"html"`, `silent:true`. | `bindings.ts:4020-4069`, `:4197-4208` |
| R6 | The agent route resolves the caller from the forwarded capability and calls `TelegramBotService.send`. | `src/app/api/telegram/bot/agent/route.ts:49-80` |
| R7 | Who posts is decided per chat by the multi-bot selector. A clone is tried first only for `sendMessage` into a non-private chat with no bot assigned to it; an assigned bot makes the clone transport refuse. | `src/lib/telegram/bot/multiBot.ts:252-263`, `:189-192` |
| R8 | The clone directory maps a chat to the one clone bound there. A chat listed under two clones is dropped from the map, so no clone covers it. A clone covers chats only while it is `active` at Celestia and enabled here. | `src/lib/externalRelay/cloneDirectory.ts:114-137` (`:118-124`, `:134`) |
| R9 | The send client: idempotent key per part (`cloneClientKey`), 25 s budget, the answer table of `relay-send-as-clone.md` §6, one allowlisted log line with no text, chat ids or keys. | `src/lib/externalRelay/cloneSend.ts:133-226` (`:222-223`) |
| R10 | The seat's Reports line reads «→ <chat>» from the stored choice. | `src/components/orchestrator/SeatReports.tsx:262-264` |
| R11 | Installation transfer copies project settings entries as they are. | `src/lib/transfer/sections.ts:218-221` |

### 2.3 Team members and Telegram identity

| # | Fact | Where |
|---|---|---|
| T1 | A member holds at most one Telegram link: `telegram {userId, username, firstName, linkedAt}`, stored in `members.telegram_user_id` (UNIQUE) in `team/team.sqlite` (0600). The file's absence is solo mode. | `src/lib/team/contract.ts:16-36`; `src/lib/team/store.ts:24-37`, `:281-294`, lookup `:425` |
| T2 | Linking goes through the installation's own bot: a deep link `t.me/<bot>?start=<link>`, the bot answers whoever pressed Start with what is asked and a six-digit code, and only the code typed back into the member's browser binds `from.id`. "Pressing Start is not consent." | `src/lib/team/telegramSignIn.ts:21-42`, `:216-255`, `:317-359` |
| T3 | Unlinking clears the member's link and records `telegram.unlinked`. | `telegramSignIn.ts:468-476`; route `src/app/api/team/telegram/route.ts:11-22` |
| T4 | Without a connected bot the Team page refuses: "Connect a Telegram bot in the Telegram panel first." | `src/components/team/MembersTab.tsx:417`, `:508-518`; `src/lib/i18n/en.ts:7362` |
| T5 | A Telegram link is also a sign-in method: the user id picks the member. | `sign-in-and-team.md` §5.3; `actor.ts:53-61` |
| T6 | The paired relay owner's identity is `{namespace:"telegram", id:<Telegram user id>}` and already counts as the install owner when the owner has no link of their own. | `src/lib/externalRelay/store.ts:202-207`; `src/lib/team/actor.ts:30-43` |
| T7 | The team view shows other members' Telegram username and first name, never their id; the member's own row has the id. | `contract.ts:131-146` |
| T8 | Who may act in a project: `workspaceScope(store, memberId).access(project)`. | `src/lib/team/workspaceAccess.ts:10-58` |

### 2.4 MCP surface and authority

| # | Fact | Where |
|---|---|---|
| M1 | Every tool is available to every agent; identity decides operations, such as the designated seat being the only one that deploys. | `src/lib/mcp/toolAllowlist.ts:5-35` |
| M2 | A caller is `root` (the operator's own conversation) or `worker`; designated seats come from `authorizedManagerSeats`. | `src/lib/attention/callerAuthority.ts:58-60`; `bindings.ts:1182-1184`; `src/lib/orchestrator/authority.ts:87` |
| M3 | One tool call gets at most 30 s. | `src/lib/mcp/server.ts:5156-5158` |
| M4 | Mutating tools keep durable receipts per `clientRequestId`. | `server.ts:149-234` |
| M5 | The established "agent asks, a person confirms once" pattern: a file send refused by a detector answers `confirmation {id, url, expiresAt}`; the paired owner opens the URL and approves once; the approval binds a digest. | `docs/design/telegram-file-confirmation.md`; `src/app/api/telegram/bot/confirmation/route.ts:18-45` |
| M6 | The relay's owner service tools run only inside a live owner request ("One live request owns one loop"), so a seat outside such a request cannot call them. | `src/lib/externalRelay/ownerServiceTools.ts:31` |

## 3. What the relay offers today

Read from the Celestia repository at its `main` `7c74fa2b` (2026-11-02 12:59
UTC; the remote head matched it by `git ls-remote`), read-only with
`git show`/`git grep`, and from the live public descriptor and two
unauthenticated probes on 2026-11-02 14:06 UTC. Celestia paths below are
relative to that repository.

### 3.1 Creating a clone: offered

| # | Fact | Where (Celestia) |
|---|---|---|
| C-a | `POST /clone-requests` (201), `GET`, `PATCH`, `DELETE /clone-requests/{id}`, and `POST /clone-requests/{id}/avatar-candidates`, all behind the `clone_create` switch and the pairing credential. | `apps/backend/api/controllers/relay_clone_requests.py:28`, `:51`, `:71`, `:96`, `:117` |
| C-b | Create accepts `photo` as `CloneJpegPhoto` or null only. | `apps/backend/api/schemas/relay_v1.json:420-462` |
| C-c | A request lives 60 minutes; at most 20 requests a day per owner. | `apps/backend/application/usecase/clones/relay_clone_requests.py:209`, `:217` |
| C-d | The answer is `{request_id, status, create_url, expires_at, target_id?, username?, reason?}`, `reason` one of `photo_failed`, `clone_limit`. | `relay_v1.json:555-601`; `relay_clone_requests.py:174-199` |
| C-e | The live descriptor lists `clone_create` (read 2026-11-02 14:06 UTC, among 14 features). | `GET /.well-known/delegatus-relay.json`; built at `apps/backend/api/controllers/relay_v1.py:330-343` |

### 3.2 Setting a clone's photo: offered only before the clone exists

| # | Fact | Where (Celestia) |
|---|---|---|
| P-a | `POST /clone-requests/{id}/avatar-candidates {prompt ≤500}` answers `{candidates:[{candidate_id, url}] (1–4), remaining_today}`. It needs a pending, unexpired request and counts against five generations a day per owner; a run with no candidate refunds the slot. | `relay_v1.json:602-660`; `relay_clone_requests.py:274-329` (`:278`, `:306-308`); limit `generate_onboarding_avatar.py:25` |
| P-b | `PATCH /clone-requests/{id}` takes `name`, `username` and `photo` (`{kind:"jpeg", data}`, `{kind:"candidate", candidate_id}` or null), again only while the request is pending (409 `not_pending` otherwise). A candidate is matched against the draft's own candidates (404 `candidate_not_found`). | `relay_v1.json:463-553`; `relay_clone_requests.py:234-263` (`:240-242`), `:146-152` |
| P-c | No route changes the photo of a clone that already exists. The owner tool `owner_update_clone` changes `access_mode`, `allow_adult_content` and `default_prompt` only, and owner tools run only inside a live owner request (M6). | route list `relay_v1.py`; Delegatus copy `src/lib/externalRelay/fixtures/relay_v1/owner-tools-index.json` (SHA-256 `13ffb1c9…`) |

### 3.3 Telegram user ids: the owner's, and group authors'

| # | Fact | Where |
|---|---|---|
| U-a | The pairing owner is `{namespace:"telegram", id:<Telegram user id>, display_name, handle}`. | Celestia `apps/backend/application/usecase/clones/relay_protocol.py:133-143`; Delegatus `protocol.ts:18-23` |
| U-b | Owner history pages carry each group message author's `user_id`, `name` and `username`. That proves only that someone posted in a group; the person agreed to nothing. | Delegatus `protocol.ts:453-464` |
| U-c | Answer requests carry no platform ids: `author.key` is opaque per target. | `docs/design/relay.md:1481-1483`; `protocol.ts:101-124` |
| U-d | Celestia's `/start` deep links (pairing, `relay_<code>`) are handled by the main bot only; nothing handles a `/start` payload in a clone's private chat. | `apps/backend/tgbot/handlers/private/relay.py:25-26`, `:70-107` |
| U-e | A target lists `target_id, name, answered_by, fallback, answered_elsewhere?, active?, chats?`; no @username. | `relay_v1.json:250` (`Target`) |

### 3.4 Sending to a user: the owner only

`POST /targets/{target_id}/send` accepts a positive `chat_id` only when it is
the pairing owner's own; any other private chat is 403 `chat_not_allowed`
(Celestia `apps/backend/application/usecase/clones/relay_send.py:99-117`, the
test at `:106-112`). Target ids are derived from the clone id with a service
key (`relay_send.py:93`), so the same clone keeps its target id across
pairings.

Telegram adds its own rule: «Bots can't start conversations with users. A user
must either add them to a group or send them a message first.»
(<https://core.telegram.org/bots>, fetched raw 2026-11-02 14:09 UTC). Each
clone is a separate bot, so a person has to start each clone that will write
to them.

### 3.5 Defect: the clone button's photo generation is broken against live Celestia

Delegatus calls `POST /clone-avatars` (D3) and sends a chosen candidate as
`{kind:"candidate", storage_key}` inside `POST /clone-requests` (D2).
Celestia serves neither: the generator hangs off a pending request (P-a), a
candidate is chosen by `PATCH` with `candidate_id` (P-b), and create accepts
JPEG or null only (C-b). With `clone_create` live (C-e), the card's
«Згенерувати» fails and a chosen candidate cannot be sent. Upload and «Без
фото» work. Probe, 2026-11-02 14:06 UTC, no credential:

```
POST /api/relay/v1/clone-avatars                         → 404 {"error":{"code":"not_found",…}}
POST /api/relay/v1/clone-requests/<uuid>/avatar-candidates → 401 {"error":{"code":"unauthorized",…}}
```

The first route does not exist; the second exists and wants the credential.
Slice 0 fixes this before anything is built on top of it.

### 3.6 Summary

| Capability | Relay today | Needed from Celestia |
|---|---|---|
| Create a clone | Yes (C-a…C-e) | Nothing |
| Generate portraits | Yes, for a clone still being created (P-a) | For an existing clone: C2 |
| Set the photo | Yes, before creation (P-b) | After creation: C2 |
| A clone's @username | Only from the creation answer (C-d) | C1 |
| A person's Telegram id | The owner's (U-a); group authors without consent (U-b) | Consented link through a clone: C3 |
| Send to a person | The owner's private chat (§3.4) | Any linked, consenting person: C3 |

## 4. Design principles applied here

1. **The MCP tool is the surface.** Two new tools, `relay_clones` and
   `team_members`, and one new field on `seat_tick_settings`. Each calls the
   same Viewer routes and library functions the UI calls, so UI and agents
   share one implementation and one authority check.
2. **Authority lives on the server, in the route.** The MCP binding repeats
   the check only to give a clear refusal before a network call. Writes are
   admitted for the operator root (M2) or a designated seat; reads for every
   agent, with personal data left out of every answer.
3. **A person confirms once, where only a person can.** Creating a bot is
   confirmed in Telegram's own window (the existing `t.me/newbot` link).
   Consent to receive messages is one press in the clone's private chat.
   Binding a Telegram account to a member is one press in Delegatus, by that
   member or by the owner. Each is started by an agent and never needs a
   manual UI flow.
4. **Tool descriptions say what exists.** The seat learns from the
   description that it can create clones and set their photos. The
   description states capabilities and the confirmation each one needs, and
   gives no instruction to offer them. The seat prompt stays as it is.

## 5. The design, part by part

### 5.1 Part 1: which clone posts a project's reports

**Storage.** `reportTelegram` gains one optional field:

```
poster?: { origin: string; targetId: string; changedAt: string; changedBy: string }
```

Keyed by the relay origin and Celestia's target id, which survive re-pairing
(D9, §3.4); a relay id would not. Absent means **automatic**: today's
selection (R7, R8), unchanged.

- `reportTelegramOf` (R1) parses `poster` and drops a malformed one alone,
  keeping the chat.
- `setReportTelegram` (R2) carries `poster` over when the new chat and topic
  equal the stored ones and drops it otherwise. Without this, renaming the
  report header in the UI would silently forget the clone.
- A release without this field ignores the key (the decoder reads named
  fields only), so a downgrade posts automatically again.
- Transfer (R11) copies it; on another installation it resolves only when a
  pairing with that origin lists that target, otherwise its state is
  `unpaired` and sends run automatically.

**Migration of existing projects.** None. Every stored entry lacks `poster`
and keeps today's behaviour. No project is seeded with a clone.

**Write (agent-first).** `seat_tick_settings` gains
`reportPoster: { clone: "<target id>" } | "automatic"`, beside #3552's
`pipelineStageRuntime`, with the same authority: the operator root or the
designated seat of that project (refused `report_poster_refused`, 403). The
binding dispatches to `PUT /api/projects/settings { project, reportPoster }`,
and the route checks the same authority from the forwarded capability. The
route refuses, with nothing written:

| Code | When |
|---|---|
| `no_report_chat` | The project has no chosen chat (log only or never chose). The chat itself stays operator-only (R3): a public destination needs the operator's own choice. |
| `private_report_chat` | The chosen chat is a private chat; clones cover group text only (R7). |
| `clone_unknown` | No paired, unpaused Celestia relay lists that target. |
| `clone_not_in_report_chat` | The clone directory does not list the report chat under that clone, or the clone is inactive there or switched off here (R8). The answer carries the clone's `startgroup` link when its @username is known (C1 or the creation record), so the operator can add it to the group in one action: `https://t.me/<username>?startgroup` (<https://core.telegram.org/api/links>, "t.me syntax (groups)"). |

`"automatic"` removes the field. The write records `changedBy`
(`operator` or `seat:<conversation id>`).

**Read.** `get_orchestrator`'s `reportTelegram` (R4) gains
`poster: { mode: "chosen" | "automatic", clone?, name?, state }`, with `state`
one of `ready`, `not_in_chat`, `inactive`, `switched_off`, `unpaired`, or for
automatic `clone` / `bot` / `none` (who would post now). The settings route
answers the same view as `reportPoster` so the UI can show it.

**Send.** The bridge report binding (R5) reads the project's stored `poster`
and passes it to the agent route as `poster: {origin, targetId}`. The route
admits a `poster` only when some project's stored `reportTelegram` names that
clone for that chat and topic; the stored settings are the authority, whoever
calls. `TelegramBotService.send` hands it to `selection()`, which:

1. asks the clone directory for that exact clone and chat with a new
   `CloneDirectory.routeFor(chatId, origin, targetId)`, which ignores the
   two-clone ambiguity rule (R8, `:118-124`) and keeps the active and enabled
   checks (`:134`);
2. puts that clone first, ahead of an assigned bot: the project's choice
   covers that project's reports only, and for them it wins over the
   chat-wide assignment. The clone transport's assigned-bot refusal
   (`multiBot.ts:189-192`) does not apply to it;
3. on a refusal that leaves the key unused, records it and continues with
   today's candidates (assigned bot, automatic clone, bots), exactly as the
   current fallback (`relay-send-as-clone.md` §6). On `rate_limited` or
   `uncertain` it stops, as today. The report row keeps `sentBy` and
   `refusals`, so the seat and the operator see that the chosen clone did
   not post.

**UI.** The seat's Reports line (R10) adds the poster after the chat:
«→ <chat> · від <clone name>» (en «→ <chat> · as <clone name>»), and the
unavailable states in words («клон не в групі», «клона вимкнено тут»). No
picker: the choice is the agent's, on the operator's word.

### 5.2 Part 2: a seat creates a clone through MCP

`relay_clones` actions `create`, `status` and `cancel` call the existing
library functions through the existing Viewer routes (D2, D8). The route guard
gains one option, `guardRelayRoute(request, { seats: true })`, which admits,
besides the operator, a caller whose forwarded conversation is a designated
seat (M2). Every other agent is refused `relay_clones_refused` (403). The
same consent rules as the card hold:

| Rule | Card today | MCP |
|---|---|---|
| Who may start | The operator (D8) | The operator root or a designated seat |
| Relay must offer it | `clone_create` in the descriptor (D6) | Same: `clone_create_unsupported` |
| One clone at a time until set up | `clone_setup_pending` (D2) | Same, and the setup finishes on the server (below) |
| One open request | The card replaces it | Refused `clone_request_open` with the open request's state; the agent cancels it explicitly. A seat never overwrites a request the operator has open in the card. |
| Who creates the bot | The person who confirms in Telegram's window; only the paired owner's clones appear here | Same: `create` answers `createUrl`; the agent hands it to the operator, who confirms once in Telegram |
| Limits | Celestia: 20 requests a day per owner (C-c) | Same, answered `clone_daily_limit` with `retryAfterSeconds` |

`create { name?, username? }`: a missing name is `randomCloneName` in the
operator's language and a missing username is `deriveCloneUsername(name)`
(`cloneNames.ts:65-74`, `:90-101`); invalid ones are refused (they become a public bot's
identity). The answer: `{ requestId, createUrl, expiresAt, next }`, where
`next` says: set a photo first if wanted, then give `createUrl` to the
operator, who confirms in Telegram; then call `status`.

`status { requestId, wait? }` reads `GET /clone-requests/{id}`; with
`wait: true` it polls every 3 s for up to 25 s inside the 30 s call budget
(M3). On `created` the server finishes the setup the browser does today (D7):
the default engine `codex-cloud` with its model, `answered_by: install` on the
relay, then forget the created record. Each step starts from the relay's
current row, so a repeated `status` repeats nothing that went through. This
moves D7 to the server for both surfaces; the card then finds the setup done
and only refreshes. The answer names the new clone `{clone, name, username,
setup: "done" | {failed: step, code}}`.

`cancel { requestId }` is the existing `DELETE`.

The card already shows an open request with «Відкрити Telegram» (D5), so a
request a seat opened is visible and the operator can confirm from either
place.

### 5.3 Part 3: generate a portrait and set it as the clone's photo

**While the clone is being created (works with Celestia today).**

- `avatar { requestId, prompt? }` starts generation in the Viewer, one job
  per relay at a time, and answers `{ jobId, state: "generating" }` at once,
  because Celestia's generator can take up to the 120 s the client already
  allows (D3) and an MCP call has 30 s (M3). `prompt` defaults to
  `cloneAvatarPrompt(name)` (`cloneNames.ts:120-123`); a longer one is cut to
  Celestia's 500 characters and the answer says `promptTruncated: true`.
- `avatar { jobId, wait? }` reads the job: `generating`, or `ready` with
  `candidates: [{ candidate, preview }]` and `remainingToday`, or `failed`
  with a code. `preview` is a path to the 160 px JPEG the server already makes
  (D3), written to `external-relay/avatar-previews/<jobId>/` under the state
  directory (0600 files, removed 24 h later or by the next job), so the agent
  can look at each portrait before choosing.
- `set_photo { requestId, candidate }` sends
  `PATCH /clone-requests/{id} {photo:{kind:"candidate", candidate_id}}`
  (P-b).
- The job state lives on the paired relay record (D5) as
  `avatarJob {id, requestId, state, candidates, startedAt, error?}`, so a
  Viewer restart answers `interrupted` and never a stale `generating`.

The photo must be chosen before the operator confirms in Telegram: Celestia
applies the draft's photo while provisioning. A clone created first comes out
without a photo, or with `reason: "photo_failed"`; its photo then needs C2.

**After the clone exists (needs C2).** `avatar { clone, prompt? }` and
`set_photo { clone, candidate }` call the C2 endpoints. Until the descriptor
lists `clone_photo`, both answer `photo_change_unsupported`, and the answer
says the photo can be set while a clone is being created.

Who may call: the operator root or a designated seat, as in §5.2. Generation
spends the owner's five daily slots, so ordinary agents are refused.

### 5.4 Part 4: a team member's messenger identity

**What is stored.** A new table in `team/team.sqlite` (T1). Adding a table
keeps the schema number (`src/lib/team/store.ts:39-40`):

```
member_messenger_accounts(
  member_id TEXT NOT NULL,
  namespace TEXT NOT NULL,          -- "telegram" now; "slack" later
  account_id TEXT NOT NULL,         -- the platform's user id
  handle TEXT, display_name TEXT,
  proof TEXT NOT NULL,              -- "clone_link" | "install_bot_code"
  linked_at TEXT NOT NULL, linked_by TEXT NOT NULL,
  PRIMARY KEY (namespace, account_id),
  UNIQUE (member_id, namespace))
member_messenger_channels(
  namespace TEXT NOT NULL, account_id TEXT NOT NULL,
  origin TEXT NOT NULL, target_id TEXT NOT NULL,
  link_id TEXT NOT NULL,            -- Celestia's contact link (C3)
  state TEXT NOT NULL,              -- "active" | "inactive"
  granted_at TEXT NOT NULL, checked_at TEXT,
  PRIMARY KEY (namespace, account_id, origin, target_id))
member_messages(
  member_id TEXT NOT NULL, caller TEXT NOT NULL, client_request_id TEXT NOT NULL,
  project TEXT, sent_at TEXT, state TEXT NOT NULL, message_id INTEGER,
  PRIMARY KEY (caller, client_request_id))
```

`namespace` uses the relay protocol's own owner vocabulary (U-a), so Slack is
one more value and one more link proof and transport, with no schema change.
The message table keeps no text; it exists for idempotency, limits and audit.

The **owner** needs no row: the owner's Telegram identity is the paired relay
owner (T6, U-a), proven by pairing. The existing sign-in link (T1, T2) stays
the sign-in method, and its account is also written to
`member_messenger_accounts` (proof `install_bot_code`) in the same
transaction, backfilled once from `members.telegram_*`. The two can never name
different people: a link through a clone for a member whose sign-in link names
another account is refused `account_mismatch`, and the primary key refuses an
account already linked to another member (`account_taken`). A link made
through a clone never becomes a sign-in method, because its proof is weaker
than T2's typed-back code.

**How a link is made and proven.** Agent-initiated, three presses by people,
each one action:

1. A seat (or the operator) calls
   `team_members { action: "link", member, messenger: "telegram", clone? }`.
   The server checks that the member is active and that the caller may link
   (below), opens `POST /contact-links { target_id }` at Celestia (C3) for the
   clone (default: the caller project's report poster, else the first active
   clone enabled here), and stores a pending link bound to that member. It
   answers `{ linkId, startUrl, confirmUrl, expiresAt, next }`.
2. The agent sends `startUrl` (`https://t.me/<clone>?start=dlk_<code>`) to the
   person through whatever reaches them: its own chat, a group the clone sits
   in (`telegram_bot_send`), or the operator. The person opens it and presses
   Start, which also satisfies Telegram's first-contact rule for that clone
   (§3.4). The clone asks, in that private chat, whether this installation may
   send them messages through this bot; the person presses **Allow** (C3).
3. Delegatus polls the link (on the next `team_members` call and on the
   Team page's read) and learns the account `{namespace, id, display_name,
   handle}`. The binding to the member is then confirmed once in Delegatus,
   at `confirmUrl`, by **that member in their own session or by the owner**:
   a card «<first name> (@handle) allowed messages through <clone>. Link to
   <member>?» with **Link** and **Not them**. The same card shows on the
   member's Team row. Nothing binds before that press; **Not them** revokes the
   contact link at Celestia.

Why two confirmations: the Allow press is the account holder's consent to
receive messages; the Delegatus press is a member or the owner vouching that
this account is that member. A forwarded `startUrl` alone can bind nobody,
which keeps T2's lesson ("Pressing Start is not consent"). The residue is a
look-alike name and handle that the confirmer accepts; the card shows both.

How the Telegram id is learned: only from Celestia's contact link after
Allow (C3). Group history authors (U-b) are never used as a link source.

**Who may link, unlink and message.**

| Action | Admitted |
|---|---|
| `list` | Every agent; the answer carries no ids and no handles |
| `link` | The operator root and designated seats; at most 3 open links per member and 10 a day per member |
| confirm (`confirmUrl`) | That member's live session, or the owner's |
| `unlink` | The operator root, designated seats, the member in their own session (Team row), the owner |
| `message` | The operator root; a designated seat or a worker whose project the member can access (`workspaceScope(member).access(project) !== "none"`, T8); the member must be active and linked |

In solo mode (no team file) the only person is the operator, whose identity
is the pairing owner; `list` shows that one row and `link` answers
`owner_linked_by_pairing`.

**Unlinking.** `unlink { member, messenger }` deletes the account and its
channels, revokes each contact link at Celestia (`DELETE /contact-links/{id}`,
best effort; a failure is recorded on the channel and retried on the next
`list`), and records `messenger.unlinked` with the namespace only. Revoking a
member does the same for all their accounts. The person can also stop it from
Telegram (C3); Delegatus learns at the next send (`contact_inactive`) or the
next check and marks the channel inactive.

**Messaging a member.**
`team_members { action: "message", member, text, project?, clientRequestId }`:

1. Authority and audience as in the table; limits checked from
   `member_messages`: at most 10 messages per member per rolling hour and 50
   a day across all callers, and 5 per hour per calling conversation. Over a
   limit: `member_rate_limited` with `retryAfterSeconds`.
2. Pick the channel: the caller project's report poster when the member is
   reachable through it, else the most recently granted active channel. For
   the owner: any active clone enabled here, sending to the owner's private
   chat, which Celestia allows today (§3.4).
3. Compose on the server: a first line naming the sender, from
   `reportHeaderName(project)` and the caller's role (as bridge reports do for
   non-manager authors, `bindings.ts:4070-4076`), then the text. Plain text,
   one message of at most 4,096 UTF-16 units (`text_too_long` otherwise).
4. Send with `sendAsClone` (R9) and `chat_id` set to the account id, key
   `cloneClientKey(relayId, caller, clientRequestId, 0)`; write the
   `member_messages` row before the call, settle it after.
5. Answer `{ sent: true, via: <clone name> }` or one refusal (§6).

Member replies in the clone's private chat are out of scope (Deferred).

**Privacy.**

- Account ids and handles live only in `team.sqlite` (0600) and, for the
  owner, in `relays.json` (0600), where the owner id already is (T6).
- No MCP answer, bridge report, task text or log line carries an account id,
  a handle or message text. `list` says per member which messenger is linked,
  through which proof, and which clones reach them. Messages are addressed by
  member id.
- Log lines follow R9's allowlist: outcome, code, HTTP status, elapsed ms.
- Celestia receives no member names: a contact link carries only the clone,
  and the Telegram prompt names the installation's label.
- Fixtures and tests use invented ids that match no real account, and the
  privacy gate's known-value fingerprints run on them as on any change.
- Team events for the new actions carry the namespace and member id, never the
  username (today's `telegram.linked` event carries the username, T2 `:358`;
  that event is left as it is).

## 6. Failure and partial success

| Part | Situation | Answer and state |
|---|---|---|
| 1 | Chosen clone refuses with an unused key (not in chat, inactive, 403, 404, 409, 422, 503) | Falls back to today's selection; the report row records the clone's refusal first; `get_orchestrator` shows `poster.state` from the refusal; the directory is invalidated as today (R8) |
| 1 | Chosen clone rate-limited or uncertain | No fallback; the report copy fails retryable or stays `send_uncertain`; the seat's replay uses the same key (R9) |
| 1 | Operator changes the report chat | The poster is dropped with the old chat (§5.1) |
| 1 | Re-pairing, unpairing, pause | The poster resolves by origin and target id; unpaired or paused reads `unpaired` and sends run automatically |
| 2 | Lost answer to `create` | The MCP receipt replays a recorded answer. If Celestia created a request the receipt never saw, a retry opens a new one, which replaces the old at Celestia (newest wins; one open per owner) |
| 2 | The operator confirms in another Telegram account | The clone never appears here; the request expires after 60 min; `status` answers `expired` |
| 2 | `created` with `photo_failed` | The clone stands; `status` says so; C2 sets the photo later |
| 2 | Setup step fails (engine, route, forget) | `status` answers `setup: {failed: step, code}`; the next `status` resumes from the relay's current row |
| 3 | Generation yields nothing | Celestia refunds the slot (P-a); `failed: generation_failed` |
| 3 | Daily limit | `avatar_daily_limit`, `retryAfterSeconds`, `remainingToday: 0` |
| 3 | Viewer restarts mid-generation | `interrupted`; the slot may be spent; the agent may retry |
| 3 | Request no longer pending when choosing | Celestia 409 `not_pending`; the clone exists, so C2 applies |
| 4 | Celestia lacks `contact_links` | `link` answers `link_unsupported`; the owner still gets messages (pairing identity) |
| 4 | Person declines or lets the link expire | Link `declined` / `expired`; counted against the daily link limit |
| 4 | Account already linked to another member, or differs from the member's sign-in link | `account_taken` / `account_mismatch`; the contact link is revoked at Celestia |
| 4 | Person stopped messages or blocked the clone | Celestia 409 `contact_inactive` or 403; the channel goes inactive; `not_reachable` with the clone's start link for the person |
| 4 | Owner has never started that clone | Telegram refuses; Celestia answers 422 `telegram_rejected`; `not_reachable` with `https://t.me/<clone>` for the operator |
| 4 | Lost answer to a send | Same key retried within the budget, then `send_uncertain`; the row stays pending; no second clone is tried (R9) |

## 7. The tools

### 7.1 `relay_clones`

Mutating (durable receipts, M4). Arguments:

```
{ action: "list" | "create" | "status" | "cancel" | "avatar" | "set_photo",
  clientRequestId, name?, username?, requestId?, clone?, prompt?, jobId?,
  candidate?, wait? }
```

`list` answers, per paired Celestia relay, `create: {available, reason?,
open?}` and `clones: [{clone, name, username, active, switchedOn,
answeredBy, reportsFor: [project]}]`. No owner identity, no chat ids.

Proposed description (behaviour is tested; the wording is not):

> Celestia clones of this installation's relay pairing. List them; create a
> new clone (answers a Telegram link the owner opens to confirm the new bot);
> follow or cancel a creation; generate portraits and set one as a clone's
> photo. Creating and photo actions need the operator or a designated seat.
> Telegram asks the owner to confirm every new bot. Which clone posts a
> project's reports is set with seat_tick_settings reportPoster.

### 7.2 `team_members`

Mutating. Arguments:

```
{ action: "list" | "link" | "unlink" | "message", clientRequestId,
  member?, messenger?: "telegram", clone?, text?, project? }
```

`member` is a member id (`m_…`) or an exact member name. Proposed description:

> Team members and the messenger accounts linked to them. List members and
> whether each can be messaged; start linking a member's Telegram through a
> Celestia clone (the person allows it in Telegram, then the member or the
> owner confirms once in Delegatus); unlink; send a member a short text
> through a clone. Account ids are never shown; address people by member.

### 7.3 `seat_tick_settings.reportPoster` and `get_orchestrator`

As §5.1. The new field follows the tool's existing write contract (answers
`changedFields` and `revision`).

## 8. Cross-project requests for Celestia

Nothing below exists at Celestia's `main` `7c74fa2b`. The seat sends them to
the Celestia project's orchestrator once the operator accepts this design.
Each new capability is advertised by a descriptor feature, and Delegatus does
nothing until the feature appears.

**C1. A clone's @username in the target list.** Add optional
`username` (5–32, the bot username pattern) to `Target` in `GET /targets`
(`relay_v1.json:250`). Delegatus uses it for `t.me/<username>?startgroup`
(adding a clone to a group) and `t.me/<username>` (asking the owner to start
it). No feature flag: an optional field.

**C2. Photo of an existing clone.** Feature `clone_photo`.

- `POST /targets/{target_id}/avatar-candidates { prompt }`: the same
  `AvatarCandidates` answer and the same five-a-day owner limit as P-a,
  candidates kept for that target for 24 h.
- `PUT /targets/{target_id}/photo { client_key, photo }` with `photo` either
  `CloneJpegPhoto` or `{kind:"candidate", candidate_id}` from that target's
  candidates. Celestia applies it with the clone's own token
  (`setMyProfilePhoto`) and answers `200 {applied_at, replayed}`.
- Idempotent by `client_key` for 24 h, as send is (`relay-send-as-clone.md`,
  P3): Telegram stores every upload as a new photo, so a retried upload after
  a lost answer must not add a second one.
- Errors: 404 `not_found` (not this owner's clone), 404
  `candidate_not_found`, 409 `clone_inactive`, 422 `telegram_rejected`, 429
  `rate_limited` with `retry_after_s` (a per-clone cap Celestia chooses, for
  example ten changes a day), 503 `telegram_unavailable`.

**C3. Contact links: a person allows a clone to message them.** Feature
`contact_links`.

- `POST /contact-links { target_id }` → `201 { link_id, start_url,
  expires_at }`, `start_url = https://t.me/<clone username>?start=dlk_<code>`,
  30-minute expiry, at most 20 a day per owner (429 beyond).
- In the clone's private chat, `/start dlk_<code>` gets one message in the
  person's language: the installation's label (from the pairing) asks to send
  them messages through this bot; buttons **Allow** and **Decline**. Allow
  records an active grant `(pairing, clone, Telegram user)`. Today only the
  main bot handles `/start` payloads (U-d).
- `GET /contact-links/{link_id}` → `{ status: pending | allowed | declined |
  expired | revoked, account? }`, `account` = the `Owner` shape
  `{namespace:"telegram", id, display_name, handle}` once allowed.
- `GET /contact-links?status=active&cursor=` lists this pairing's active
  grants, so Delegatus can rebuild its channel table.
- `DELETE /contact-links/{link_id}` revokes (204; 404 when unknown).
- The person can stop it: a **Stop messages** button on the clone's messages
  or `/stop` in that chat, and blocking the bot; each makes the grant
  inactive.
- Send: `POST /targets/{target_id}/send` accepts a positive `chat_id` equal
  to the user of an active grant for this pairing and this clone; everything
  else stays 403 `chat_not_allowed` (§3.4). A grant made inactive answers 409
  `contact_inactive` with the key unused. Limits stay those of send (30 a
  minute per pairing).
- Celestia stores no Delegatus member names; the grant is pairing, clone and
  Telegram user.

## 9. Slices, in order

Every slice runs its touched test files by path with isolated `HOME`,
`XDG_CONFIG_HOME`, `TMPDIR` and `LLV_STATE_DIR`, the Viewer control URL on a
closed port, and relay calls against `startTestRelay` on port 0
(`src/lib/externalRelay/testRelay.ts`) answering Celestia's exact wire shapes
from `relay_v1.json`. MCP tools are proved end to end through an SDK client
over the real server and tool service into the route, on a port-0 loopback
server. UI changes add a case to the existing drivers: the clone card block
in `src/components/kanban/kanbanBoard.browser.test.tsx` (`:34446`), the team
workspaces blocks (`:37744`), and the phone driver block that renders
`SeatReports`, in en and uk, light and dark, desktop and phone.

### Slice 0: align clone creation with Celestia's live contract (Delegatus only)

Change `cloneCreate.ts`: `generateCloneAvatars(relayId, requestId, prompt)`
calls `POST /clone-requests/{id}/avatar-candidates` and parses
`{candidates:[{candidate_id, url}], remaining_today}`; a new
`chooseClonePhoto(relayId, requestId, photo)` sends `PATCH /clone-requests/{id}`;
create sends `photo` as JPEG or null only. Routes: add
`POST /api/external-relay/relays/[id]/clone-requests/[requestId]/avatar-candidates`
and `PATCH …/clone-requests/[requestId]`; delete `…/clone-avatars` and its
line in `src/lib/team/workspaceRoutes.ts:55`. The card: «Згенерувати» opens
the request first when none is open (name and username as typed), then
generates; picking a candidate sends the `PATCH`; «Створити в Telegram» sends
a `PATCH` for an edited name or username and opens the stored `create_url`.
`RelayCloneRequest` (D5) gains `openedAt` so the waiting note shows only after
the link was opened. Move D7's setup into `checkCloneRequest` on the server.

Acceptance: against the fake relay, generate → choose → create sends exactly
`POST /clone-requests`, `POST …/avatar-candidates`, `PATCH {photo:{kind:
"candidate", candidate_id}}` in that order, and no request reaches
`/clone-avatars`; a candidate is never sent to create; a created clone gets
engine `codex-cloud`, `answered_by: install` and its record forgotten with
the page closed; closing and reopening resumes from the relay's row; the
`clone_limit` reason has its own words in en and uk. The kanban driver frames
the card's states with the new order. Live acceptance stays with 9b76e868.

### Slice 1: which clone posts a project's reports

`reportTelegram.poster` (decode, carry-over, transfer), the
`reportPoster` write in `seat_tick_settings` and the settings route with the
authority of §5.1, `CloneDirectory.routeFor`, the `poster` argument through
the agent route into `selection()`, `get_orchestrator`'s poster view, and the
Reports line.

Acceptance: a seat of project A sets clone X for A's report chat; a seat of
project B is refused for A (403), a worker is refused; a bridge report of A
posts through X with one relay call and no Bot API call, also in a chat where
two clones sit and where a bot is assigned; B's report into the same chat
keeps automatic selection; X refusing `clone_not_in_chat` falls back to the
bot with the refusal recorded; rate-limited and uncertain do not fall back;
renaming the report header keeps X, changing the chat drops it; a settings
file without `poster` reads and sends exactly as before (existing selector
and service tests pass unedited); an agent-supplied `poster` that no project
names for that chat is refused with no relay call.

### Slice 2: `relay_clones` create, status, cancel, list

The tool, `guardRelayRoute(request, { seats: true })`, the
`clone_request_open` rule.

Acceptance: through the MCP client, a seat creates a request, receives
`createUrl`, and after the fake relay flips to `created`, `status` answers the
new clone with `setup: "done"` and the card's next read shows it set up; a
worker and an ordinary route call with an agent capability are refused; an
open request from the card makes `create` refuse without touching it; 429
from the relay answers `clone_daily_limit` with the wait; `list` carries no
owner identity or chat ids.

### Slice 3: portraits and photo while creating

`avatar` with the background job, previews on disk, `set_photo` for a pending
request.

Acceptance: `avatar` answers within 1 s while the fake generator takes 60 s;
`avatar {jobId, wait:true}` returns `ready` with four readable previews;
`set_photo` sends the `PATCH`; two `avatar` calls on one relay share one job;
a restart mid-job answers `interrupted`; 429 and 502 map as §6; a worker is
refused.

### Slice 4: messaging the owner through a clone, and the member store

The tables of §5.4 with the backfill, `team_members list` and `message` for
the owner (Celestia already allows the owner's private chat, §3.4), limits
and the message ledger.

Acceptance: `message` to the owner sends one relay call with `chat_id` equal
to the pairing owner's id and the server-composed first line; a repeat with
the same `clientRequestId` replays; the 11th message in an hour is refused
with a wait; a worker of a project the member cannot access is refused;
`list` and every log line carry no id, handle or text; `telegram_rejected`
answers `not_reachable` with the clone's link; solo mode answers the operator
row from the pairing.

### Slice 5: linking other members (needs C1 and C3)

`link`, the confirmation card and route (the M5 pattern), `unlink`, channel
refresh, `message` to any linked member, the Team row's pending state.

Acceptance: with the fake relay offering `contact_links`, `link` returns
`startUrl` and `confirmUrl`; nothing is bound after Allow until the member or
the owner presses **Link**; another member's session and an agent cannot
confirm; **Not them** revokes at the relay; `account_taken` and
`account_mismatch` refuse; `unlink` deletes rows and revokes; a send after
the person stopped answers `not_reachable` and marks the channel inactive;
without the feature `link` answers `link_unsupported`. Rendered: the Team row
and the confirmation card in both languages and themes, desktop and phone.

### Slice 6: photo of an existing clone (needs C2)

`avatar {clone}` and `set_photo {clone}` against C2, with `client_key`
derived from the call's `clientRequestId`.

Acceptance: a retried `set_photo` after a dropped answer sends the same
`client_key` and reports `replayed`; without `clone_photo` both actions
answer `photo_change_unsupported`.

Slices 0 to 4 need nothing from Celestia. C1, C2 and C3 can be built at
Celestia in parallel; slices 5 and 6 wait for their feature flags.

## 10. Validation against the requirement

- «к каждому проекту привязывать разного ... бота ... можно выбрать из
  клонов, который будет публиковать»: §5.1. Each project stores its own
  poster; reports post through it, also where several clones share a group.
- «создавать клона ... через MCP ... Оркестратором»: §5.2, the same request,
  limits and Telegram confirmation as the card.
- «пусть он не предлагает, но ... знает»: §4 item 4 and §7.1; the seat learns
  it from the tool description; the prompt is unchanged.
- «сгенерировав картинку привязывать её ... через API Celestia ... доступа к
  токену нет»: §5.3. Every photo goes through Celestia's endpoints; Delegatus
  holds no clone token. Existing clones wait for C2.
- «прив'язувати учасника команди до телеграм акаунту ... мб потім ... слак ...
  зберігати сутність користувача ... відправляти повідомлення з бота
  (ретранслятором)»: §5.4. A member entity with namespaced accounts, Slack as
  one more namespace; messages through a clone; the owner from slice 4,
  everyone else after C3.
- «agent first ... через агента все рішати а не в UI»: every capability is an
  MCP action; the UI shows state (the Reports line, the card, the Team row)
  and offers one press where a person must confirm (Telegram's new-bot
  window, Allow, Link).

## 11. Deferred — not currently justified

- **A clone picker in the report settings UI.** The operator asked for agent
  first; the Reports line shows the choice. Trigger: the operator asks for a
  picker.
- **A chosen poster for a private report chat.** Clones carry group text
  (R7); owner private-chat text through a clone is deferred by
  `relay-send-as-clone.md` §9. Trigger: that row is lifted.
- **An agent's own image file as a clone photo.** The 2026-10-11 decision
  chose Celestia's generator, and the spec asks to reuse it. Trigger: the
  operator asks to use a picture an agent drew; the UI's upload path
  (`cloneJpeg`, D4) and the document-root loader
  (`src/lib/telegram/bot/documents.ts:397`) are the parts to reuse.
- **Portraits as MCP image content.** Preview files are enough for an agent
  to look at. Trigger: a client that cannot read local files.
- **Removing a clone's photo** (`removeMyProfilePhoto`). Nobody asked.
- **Member replies routed back to the sending agent.** A reply in the clone's
  private chat from a non-owner is Celestia's to answer today. Trigger: the
  operator asks for two-way member conversations.
- **Messages to members through the installation's own bot.** The operator
  asked for the relay; 8ca994ec moves away from stored bot tokens.
- **Slack link proof and transport.** The namespace is reserved; nothing
  else is built. Trigger: a Slack workspace to connect.
- **Quiet hours, digests or batching of member messages.** The hourly and
  daily caps bound volume. Trigger: a member complains about volume.
- **Ids or handles in agent answers.** No agent task needs them; messages are
  addressed by member.
- **Linking from group history authors** (U-b). That is no consent and no
  proof.
- **Removing stored bot tokens.** Owned by 8ca994ec with its own condition.

## 12. Notes and decisions taken with a default

- **Fallback of a chosen poster.** A clone that cannot post falls back to
  today's selection so reports keep arriving, with the refusal visible. A
  stricter "chosen clone or nothing" is one condition in `selection()` if the
  operator prefers it.
- **Who vouches for a member's account.** The member or the owner, with one
  press. The literal request («щоб можна було прив'язувати учасника») reads
  as the owner linking people, and the member's own press covers members who
  use the UI.
- **Limits** (10 an hour and 50 a day per member, 5 an hour per calling
  conversation, 3 open links per member) are starting values in one constant
  each.
- **No performance claim.** The report send adds one in-memory directory
  lookup; nothing new runs per tick.
- **Task 65762062** (a binding that stays inactive) shows up here as
  `poster.state: inactive`; its fix stays in that task.
