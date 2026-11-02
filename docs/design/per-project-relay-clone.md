# Per-project relay clone, clones and avatars through MCP, team members' messenger identity

## Originating requirement

On 2026-11-02 the operator asked for four things, by voice in the Delegatus
seat chat (about 13:40 UTC) and in a comment on the task (about 13:45 UTC),
and stated a principle for all of them (about 13:55 UTC). The repository is
public, so this document paraphrases them (`CONTRIBUTING.md:33-35`); the
verbatim wording stays in the task's private record.

1. **A clone bot per project for reports.** Where an orchestrator's report
   settings live, the operator can choose which of the Celestia clone bots
   publishes that project's reports, so that different projects can post
   through different bots.
2. **Clones created by agents.** Instead of creating a clone through the UI,
   the orchestrator creates clones through the regular agent mechanism, the
   Delegatus MCP tools. The orchestrator should not propose creating a clone
   on its own initiative, but it should know that it can.
3. **A generated avatar.** Generate a picture and attach it to a clone bot as
   its avatar, through Celestia's relay API. Delegatus cannot use the Telegram
   Bot API for this, because it has no clone bot token: Celestia runs the bots.
4. **A stored user identity.** A team member can be linked to a Telegram
   account (later perhaps Slack and others). The point is a stored user entity,
   so that this base of ids can later be used to send people messages from a
   bot through the relay.

Principle: agent first. Every part is done through an agent.

The pinned specification turns this into four parts, each with an MCP tool on
the Delegatus server (key `viewer`) as its primary surface, consent and safety
enforced on the server, and a UI that shows state and offers a one-action
confirmation only where a person must confirm. A human confirmation is always
an agent-initiated request that a person settles with one action.

**Should this be built?** Yes, in the slices below. Parts 1 and 2 reuse code
that exists. Part 3 is half there: Celestia generates portraits for a clone
that is still being created, and Delegatus calls that the wrong way today
(§3.5). Changing the photo of a clone that already exists, and messaging a
person other than the pairing owner, need Celestia endpoints that do not
exist; they are written as explicit cross-project requests (§8).

**Revision 2 (2026-11-02, after review).** The clone card becomes a view of
the agent's request (§5.2, slice 0); a report's poster is resolved by the
server from the reporting seat's own project (§5.1); the owner is identified
by the existing identity precedence and messaged only under a revocable
consent (§5.4.2, §5.4.3); unlinking keeps a revocation outbox (§5.4.6);
private sends get their own error contract (§5.4.5) and leave no publication
reference (§5.4.7); every citation was rechecked; the requirement is
paraphrased.

## 1. Prior work and open work on the same files

- `docs/research/celestia-clone-creation.md` (2026-10-11) designed the
  one-button clone. Its decisions (`:239-249`) put a form in the Celestia
  card, with Celestia's generator (four candidates, at most five generations a
  day), an upload and «Без фото» beside it; the new clone is answered by this
  installation with Celestia as the fallback; the block shows only on a
  paired Celestia card. The 2026-11-02 request replaces creation through the
  UI with creation by agents. §5.2 therefore turns the card into a view of an
  agent's request, and §5.3 keeps all three photo options on the MCP surface:
  a generated portrait, a picture file, or none.
- `docs/design/relay-send-as-clone.md` built group text through a clone. Its
  §9 (`:350-364`) left text into the owner's private chat on the bot path,
  because replies there resolve their context through rows keyed by the
  receiving bot; its §14 (`:468`) states the condition for removing stored
  bot tokens (task 8ca994ec, still open).
- `docs/design/sign-in-and-team.md` §5.3 (`:699`) built "Link my Telegram"
  through the installation's own bot, with the code typed back into the
  browser.
- The fix lane of the clone button (2026-10-11, lane 0f1a2b9a) noted that
  Celestia's own design used `/clone-requests/{id}/avatar-candidates`,
  `candidate_id` and a `PATCH` to choose, unlike the branch. No commit since
  touched `src/lib/externalRelay/cloneCreate.ts` for it (`git log`:
  `a8e005428` #2757 and `11a5d55fa` only). §3.5 shows the switch is now on.
- The first attempt of this design (lane d9f6709c, 2026-11-02 13:16 UTC) died
  in a deploy before writing anything. Transcript and memory search found no
  earlier design for messaging team members through the relay.
- Related open tasks: 8ca994ec (group messages through a clone without a bot
  token; token removal deferred), 65762062 (a clone binding that stays
  inactive until the clone is re-added to the group), 9b76e868 (live check of
  button clone creation).

Open pull requests touching files this plan names, read 2026-11-02 15:24 UTC
(`gh pr list --state open`, 28 open). #3532, listed in revision 1, has merged
(main `b39546b38`; it moved no line cited here).

| PR | Overlap | Effect on this plan |
|---|---|---|
| #3552 | `src/lib/projects/settings.ts`, `src/app/api/projects/settings/route.ts`, `src/lib/mcp/bindings.ts`, `server.ts` | Adds `pipelineStageRuntime` to `seat_tick_settings`, writable by the operator root or that project's designated seat (`projectRuntimeAuthority` in its `bindings.ts` diff). Slice 2 uses the same authority rule and lands after it, or copies the check if it has not merged. |
| #3577 | `settings.ts`, the settings route, `server.ts` | Rebase only; no shared field. |
| #3415 | `src/lib/team/store.ts`, the settings route, MCP files | Slice 3 adds tables to `team.sqlite`; it lands after #3415 or rebases on it. |
| #3572, #3566, #3508, #3265, #3263 | `src/lib/team/workspaceRoutes.ts`, MCP files | Slice 0 removes one line from `workspaceRoutes.ts` (`:55`); rebase only. |
| #3585, #3575, #3485, #3473 | `src/lib/mcp/server.ts` or `bindings.ts` | New tool registrations; rebase only. |

## 2. What Delegatus has today

Read at `550e16597` (this lane's base). Main moved to `b39546b38` during the
work; that commit changes `protocol.ts:1` and `:103` only, so every line
below still holds there.

### 2.1 Relay client and clone creation

| # | Fact | Where |
|---|---|---|
| D1 | Every relay call goes through `relayCall`: DNS pin, redirect refusal, response cap, `Delegatus-Relay-Version: 1`, bearer pairing credential, error envelope parsed into `ExternalRelayError(code, status, retryAfterSeconds)`. | `src/lib/externalRelay/client.ts:75-202` (header `:116`) |
| D2 | Clone creation calls `POST /clone-requests` with `{name, username, photo}`, where `photo` is `{kind:"jpeg", data}`, `{kind:"candidate", storage_key}` or null, with a 15 s timeout. It refuses while a created clone's setup is unfinished (`clone_setup_pending`) and replaces the stored open request. | `cloneCreate.ts:129-160` (`:134`, `:138-145`, `:150-154`) |
| D3 | Avatar generation calls `POST /clone-avatars {prompt}` with a 120 s timeout and expects `{candidates:[{storage_key, url}]}`; it downloads each candidate and returns 160 px JPEG previews as data URLs. | `cloneCreate.ts:217-245` (`:227`, `:237`), `:50`; UI `src/components/externalRelay/CloneCreate.tsx:135` |
| D4 | An uploaded picture becomes a 640 px square JPEG with `sharp` (`photo_unreadable` otherwise). | `cloneCreate.ts:62-81` |
| D5 | The open request (`RelayCloneRequest`) and the created record (`RelayCloneCreated`) live on the paired relay in `external-relay/relays.json`, written 0600. | `src/lib/externalRelay/store.ts:29-36`, `:43-51`, `:52-71`; write `:171-183` (mode `:176-177`) |
| D6 | The block shows only when the descriptor lists `clone_create`. | `cloneNames.ts:9-12` |
| D7 | After `created`, the browser finishes the setup: engine `codex-cloud` with a model fixed in the component, `answered_by: install` on the relay, then forgets the created record. A closed page finishes it on reopen. | `CloneCreate.tsx:245-290` (model `:269`); mounted `ExternalRelaySection.tsx:605-609` |
| D8 | The clone routes admit only the operator: same origin, owner in team mode, `requireOperatorAuthority`, which refuses any caller with an agent conversation. | `src/lib/externalRelay/routeGuard.ts:9-23`; `src/lib/agent/operatorAuthority.ts:140-151` (`:141`) |
| D9 | A relay's local id is minted per pairing attempt, so re-pairing changes it. | `pairing.ts:30`, `:103` |
| D10 | Every opener of the card's form: the empty-state button (`CloneEmpty`, `CloneCreate.tsx:314-325`, mounted `ExternalRelaySection.tsx:677`), the list row (`CloneCreateRow`, `:328-336`, mounted `:670`) and «Спробувати ще» in the ended state (`:485`). The form is `CloneForm` (`:384`) with `PhotoChooser` (`:346`), mounted at `ExternalRelaySection.tsx:669`, `:676`. The waiting block offers the Telegram link and Cancel (`CloneCreate.tsx:448-460`). | as given |
| D11 | Each paired relay has a poll loop that refreshes its targets at most every 300 s. | `src/lib/externalRelay/poller.ts:505-511`, `:334` |

### 2.2 Seat report destination and who posts

| # | Fact | Where |
|---|---|---|
| R1 | A project's report destination is `reportTelegram {chat, name, topicId?, changedAt, changedBy}` or "Log only" (`chat: null`) in `project-settings.json`. Absent means log only. | `src/lib/projects/settings.ts:39-64`, decode `:114-124` |
| R2 | `setReportTelegram` writes a fresh object each time. | `settings.ts:336-356` (`:348`) |
| R3 | Only the operator sets it, and only to a chat the bot store allows posting in; the route's comment says agents have no write path. | `src/app/api/projects/settings/route.ts:118-120`, `:181-219` |
| R4 | `get_orchestrator` answers `reportTelegram` as the effective destination `{chat, name, topicId?, source:"chosen"}`. | `src/lib/mcp/bindings.ts:4576-4583`, used `:4720`, `:4745`; `settings.ts:326` |
| R5 | Only a report whose origin is the project's manager gets a Telegram copy. The binding renders HTML for the project's chosen chat and posts it through `/api/telegram/bot/agent` with `op:"send"`, the chat, `format:"html"`, `silent:true`. A replay re-sends a stored copy only while the project still reports to the same chat. | `bindings.ts:4020-4022`, `:4067-4069`; send `:4197-4208`; replay `:3993-3996` |
| R6 | The agent route takes the chat from the request body and resolves the sender from the forwarded capability. It names no project, and it reads only the body fields it lists, so any other key is dropped silently. | `src/app/api/telegram/bot/agent/route.ts:49-80` (`:55-59`, `:66-77`) |
| R7 | Who posts is decided per chat by the multi-bot selector. A clone is tried first only for `sendMessage` into a non-private chat with no bot assigned to it; an assigned bot makes the clone transport refuse. | `src/lib/telegram/bot/multiBot.ts:256-262`, `:189-192` |
| R8 | The clone directory maps a chat to the one clone bound there. A chat listed under two clones is dropped from the map, so no clone covers it. A clone covers chats only while it is `active` at Celestia and enabled here. The route id is `clone:<relay id>:<target id>`. | `src/lib/externalRelay/cloneDirectory.ts:114-126` (`:118-124`), `:128-137` (`:134-135`) |
| R9 | The clone send client: an idempotency key per caller, request and part (`cloneClientKey`); one 25 s budget with retries on the same key; a `beforeSend` hook rechecked before every attempt, whose refusal ends the send (`uncertain` if an earlier attempt is unresolved); a fixed classification of relay answers where 422 is `bad_request`, an unknown 409 code is unclassified and an unclassified 4xx ends the send `uncertain`; on success a publication reference row with the chat id; one allowlisted log line. | `src/lib/externalRelay/cloneSend.ts:10-11`; `:49-102` (`:50`, `:66`, `:78-80`); classifier `:25-43` (`:26`, `:35-38`), `:83-89`; reference `:71-73`; log `:99-100` |
| R10 | The publication reference rows live in `relay_published_references` in `state.sqlite`, keyed by relay, target and message key, holding the chat id. Their readers resolve an owner's reply to a message Delegatus published: the bridge report context and the owner outbound context. | `src/lib/externalRelay/publishedReferences.ts:5-19`, `:38-66`; readers `ownerBridgeContext.ts:37-57` (`:40`), `ownerOutboundContext.ts:26-28` |
| R11 | The seat's Reports line reads «→ <chat>» from the stored choice. | `src/components/orchestrator/SeatReports.tsx:262-264` |
| R12 | Installation transfer copies project settings entries as they are. | `src/lib/transfer/sections.ts:218-221` |

### 2.3 Team members and Telegram identity

| # | Fact | Where |
|---|---|---|
| T1 | A member holds at most one Telegram link, `telegram {userId, username, firstName, linkedAt}`, stored in `members.telegram_user_id` (UNIQUE) in `team/team.sqlite`, 0600. The file's absence is solo mode. A new table keeps the schema number. | `src/lib/team/contract.ts:16-36`; `src/lib/team/store.ts:24-37`, `:39-41`, `:281-294` (`:287`), lookup `:424-427` |
| T2 | Linking goes through the installation's own bot: a deep link, the bot answers whoever pressed Start with what is asked and a six-digit code, and only the code typed back into the member's browser binds `from.id`; an account linked to another member is refused. "Pressing Start is not consent." | `src/lib/team/telegramSignIn.ts:21-42` (`:27`), `:216-255` (`:232-236`), link `:343-359` |
| T3 | Unlinking clears the member's link and records `telegram.unlinked`. | `telegramSignIn.ts:468-476`; route `src/app/api/team/telegram/route.ts:10-21` |
| T4 | Without a connected bot the Team page refuses linking: "Connect a Telegram bot in the Telegram panel first." | `src/components/team/MembersTab.tsx:417`; `src/lib/i18n/en.ts:7362` |
| T5 | A Telegram sign-in signs in the member whose link holds that user id. | `telegramSignIn.ts:341`, `:362-363`; session `:381-399` (`:390`) |
| T6 | **Identity precedence for a paired owner's Telegram id.** A member linked to that id is that member (revoked: nobody). Only when no member holds the id, the install owner is active and has no Telegram link of their own, and an unpaused pairing names the id, does the id count as the install owner. Without a team store it is the operator. | `src/lib/team/actor.ts:31-43` (`:34-36`, `:40-41`); `src/lib/externalRelay/store.ts:202-207` |
| T7 | Pairing confirmation checks the pending pairing's own owner id against the relay's answer; it never compares it with the team owner's link. | `src/lib/externalRelay/pairing.ts:81-110` (`:86-87`, `:96-101`, `:110`) |
| T8 | The team view shows other members' Telegram username and first name, never their id; the caller's own row has the id. | `contract.ts:132-146` |
| T9 | Who may act in a project: `workspaceScope(store, memberId).access(project)`. | `src/lib/team/workspaceAccess.ts:10-51` (`:43-50`) |

### 2.4 MCP surface and authority

| # | Fact | Where |
|---|---|---|
| M1 | Every tool is available to every agent; identity decides operations, such as the designated seat being the only one that deploys. | `src/lib/mcp/toolAllowlist.ts:5-35` |
| M2 | A caller is `root` (the operator's own conversation) or `worker`. The manager attribution names a designated seat, or a deputy of one, as its project's manager. | `src/lib/attention/callerAuthority.ts:58`, `:60`; `bindings.ts:1159-1175`, `:1182-1184`; `src/lib/orchestrator/authority.ts:87` |
| M3 | One tool call gets at most 30 s. | `src/lib/mcp/server.ts:5156-5158` |
| M4 | Mutating tools keep durable receipts per `clientRequestId`. A receipt holds a SHA-256 digest of the tool name and arguments, and the answer. | `server.ts:149-234`; record `:696-703`; digest `:2382` |
| M5 | The established "agent asks, a person confirms once" pattern: a file send refused by a detector answers `confirmation {id, url, expiresAt}`; the paired owner opens the URL and approves once; the approval binds a digest. | `docs/design/telegram-file-confirmation.md`; `src/app/api/telegram/bot/confirmation/route.ts:18-45` |
| M6 | The browser perimeter for such a confirmation refuses any request that carries an agent's spawn capability and admits only the operator's browser (a live member session in team mode). | `src/lib/voiceCompanion/http.ts:26-36` |
| M7 | The relay's owner service tools run only inside a live owner request, so a seat outside such a request cannot call them. | `src/lib/externalRelay/ownerServiceTools.ts:29-32` |
| M8 | An agent's picture file is admitted only from under the operator's document roots, by the rule `telegram_bot_send_media` already follows. | `src/lib/telegram/bot/service.ts:128-145`; `documents.ts:397` |

## 3. What the relay offers today

Read from the Celestia repository at `main` `7c74fa2b` (the remote head by
`git ls-remote` at 15:27 UTC), read-only with `git show` and `git grep`; and
from the live public descriptor and three unauthenticated probes at
2026-11-02 15:23 UTC. Celestia paths are relative to that repository.

**The whole relay surface.** Celestia registers four relay routers
(`apps/backend/api/factory.py:103-106`). Their routes:
`relay_v1.py` `POST /pairings` `:371`, `GET /pairings/{id}` `:407`,
`POST /pairings/{id}/confirm` `:429`, `DELETE /pairings/{id}` `:460`,
`GET /targets` `:480`, `PATCH /targets/{id}` `:502`,
`GET /targets/{id}/chats` `:522`, `PATCH /targets/{id}/chats/{key}` `:545`,
`POST /requests/claim` `:573`, `…/heartbeat` `:606`, `…/tool-calls` `:659`,
`POST /targets/{id}/send` `:686`, `POST /targets/{id}/messages` `:705`,
`…/complete` `:727`, `PUT …/attachments/{id}` `:753`, `DELETE /pairing`
`:783`, `GET …/media/{ref}` `:798`; the descriptor `:284`, `:366`;
`relay_clone_requests.py` `:28`, `:51`, `:71`, `:96`, `:117` (§3.1); and two
`GET` routes in `relay_owner_history.py` `:43`, `:47`. Absence claims below
rest on this list.

### 3.1 Creating a clone: offered

| # | Fact | Where (Celestia) |
|---|---|---|
| C-a | `POST /clone-requests` (201), `GET`, `PATCH`, `DELETE /clone-requests/{id}`, and `POST /clone-requests/{id}/avatar-candidates`, behind the `clone_create` switch and the pairing credential. | `apps/backend/api/controllers/relay_clone_requests.py:28`, `:51`, `:71`, `:96`, `:117` |
| C-b | Create accepts `photo` as `CloneJpegPhoto` or null only. | `apps/backend/api/schemas/relay_v1.json:420-462`, `:522` |
| C-c | A request lives 60 minutes; at most 20 requests a day per owner. | `apps/backend/application/usecase/clones/relay_clone_requests.py:209`, `:217` |
| C-d | The answer is `{request_id, status, create_url, expires_at, target_id?, username?, reason?}`, `reason` one of `photo_failed`, `clone_limit`; `create_url` is Telegram's new-bot link for the requested name and username. | `relay_v1.json:555-601`; `relay_clone_requests.py:174-199` (`:186-187`) |
| C-e | The live descriptor lists `clone_create` among 14 features and lists neither `clone_photo` nor `contact_links` (read 15:23 UTC). | `GET /.well-known/delegatus-relay.json`; built `apps/backend/api/controllers/relay_v1.py:330-343` (`:337`) |

### 3.2 Setting a clone's photo: offered only before the clone exists

| # | Fact | Where (Celestia) |
|---|---|---|
| P-a | `POST /clone-requests/{id}/avatar-candidates {prompt ≤500}` answers `{candidates:[{candidate_id, url}] (1–4), remaining_today}`. It needs a pending, unexpired request and counts against five generations a day per owner; a run that yields no candidate refunds the slot, and provider work that started keeps it. | `relay_v1.json:602-660`; `relay_clone_requests.py:274-329` (`:278`, `:283-285`, `:306-308`); limit `generate_onboarding_avatar.py:25` |
| P-b | `PATCH /clone-requests/{id}` takes `name`, `username` and `photo` (`{kind:"jpeg", data}`, `{kind:"candidate", candidate_id}` or null), only while the request is pending (409 `not_pending`). A JPEG counts against the 20 requests a day. A candidate is matched against the draft's own candidates (404 `candidate_not_found`). | `relay_v1.json:463-553`; `relay_clone_requests.py:234-263` (`:240-242`, `:249-252`), `:118-123`, `:146-152` |
| P-c | No relay route changes the photo of a clone that already exists (route list above). The owner tool `owner_update_clone` takes `access_mode`, `allow_adult_content` and `default_prompt` only, and owner tools run only inside a live owner request (M7). Inside Celestia, a clone's own assistant can change its picture (`update_self_profile_photo`) and provisioning applies a photo from a URL with the clone's token; neither is reachable over the relay. | schema `apps/backend/api/schemas/celestia_clone.py:53-58`; Delegatus copy `src/lib/externalRelay/fixtures/relay_v1/owner-tools-index.json` (one-line JSON array of 14 tools, SHA-256 `13ffb1c9…`); `ai_agent/agent/tools/self_management.py:310`, `ai_agent/gateways/bot_management.py:210`; `infrastructure/tgbot/clone_profile_photo.py:30-63` |

### 3.3 Telegram user ids: the owner's, and group authors'

| # | Fact | Where |
|---|---|---|
| U-a | The pairing owner is `{namespace:"telegram", id:<Telegram user id>, display_name, handle}`. | Celestia `apps/backend/application/usecase/clones/relay_protocol.py:133-143`; Delegatus `src/lib/externalRelay/protocol.ts:18-23` |
| U-b | Owner history pages carry each group message author's `user_id`, `name` and `username`. That proves only that someone posted in a group; the person agreed to nothing. | Delegatus `protocol.ts:453-466` (`:459`) |
| U-c | Answer requests carry no platform ids: `author.key` is opaque per target. | `docs/design/relay.md:1481-1483`; `protocol.ts:101-112` |
| U-d | Nothing at Celestia records a person's consent to receive messages from a pairing through a clone. The only relay start payload is pairing (`relay_<code>`), and its handler returns at once on any bot but the main one. The other start payloads serve Celestia's own features. `git grep -n "contact.link\|contact_link"` over `apps/backend` matches only an evaluation dataset line. Live, `POST /api/relay/v1/contact-links` answers 404 `not_found` unauthenticated, while an existing route answers 401. | Celestia `apps/backend/tgbot/handlers/private/relay.py:70-72`, `:83-84`; `tgbot/handlers/private/basic.py:88`, `:119`, `:159`, `:197`, `:222`, `:256`; probe below |
| U-e | A target lists `target_id, name, answered_by, fallback, answered_elsewhere?, active?, chats?, chats_next_cursor?`; no @username. | `relay_v1.json:250-302` |

### 3.4 Sending to a person: the pairing owner only

`POST /targets/{target_id}/send` checks, in `_authorize`, that the clone is
active (409 `clone_inactive`) and that a positive `chat_id` is the pairing
owner's own; any other private chat is 403 `chat_not_allowed`
(`apps/backend/application/usecase/clones/relay_send.py:99-117`, `:104-112`).
Target ids are derived from the clone id with a service key (`:75-97`,
`:93`), so a clone keeps its target id across pairings. When Telegram
refuses, Celestia answers:

| Telegram | Celestia | Where |
|---|---|---|
| Forbidden (the person blocked the bot or never started it) | 409 `clone_not_in_chat` | `relay_send.py:306-307` |
| Bad request "chat not found" | 409 `clone_not_in_chat` | `:49-50` |
| Other bad request, not found, conflict, migrated chat | 422 `telegram_rejected` | `:55`, `:308-315` |
| Connection refused | 503 `telegram_unavailable` | `:316-318` |
| Other network or server error | 409 `send_uncertain` | `:319-321` |
| More than 30 sends a minute per pairing | 429 `rate_limited`, 60 s | `:189-190`; `infrastructure/redis/relay.py:169-172` |

Telegram adds its own rule: «Bots can't start conversations with users. A user
must either add them to a group or send them a message first.»
(<https://core.telegram.org/bots>, fetched raw 2026-11-02 15:27 UTC). Each
clone is a separate bot, so a person has to start each clone that will write
to them.

### 3.5 Defect: the clone button's photo generation is broken against live Celestia

Delegatus calls `POST /clone-avatars` (D3) and sends a chosen candidate as
`{kind:"candidate", storage_key}` inside `POST /clone-requests` (D2).
Celestia serves neither: the generator hangs off a pending request (P-a), a
candidate is chosen by `PATCH` with `candidate_id` (P-b), and create accepts
JPEG or null only (C-b). With `clone_create` live (C-e), the card's
«Згенерувати» fails and a chosen candidate cannot be sent. Upload and «Без
фото» work. Probes, 2026-11-02 15:23 UTC, no credential:

```
POST /api/relay/v1/clone-avatars                           → 404 not_found
POST /api/relay/v1/clone-requests/<uuid>/avatar-candidates → 401 unauthorized
POST /api/relay/v1/contact-links                           → 404 not_found
```

The first and third routes do not exist; the second exists and wants the
credential. Slice 0 fixes the drift before anything is built on top of it.

### 3.6 Summary

| Capability | Relay today | Needed from Celestia |
|---|---|---|
| Create a clone | Yes (C-a…C-e) | Nothing |
| Generate portraits | Yes, for a clone still being created (P-a) | For an existing clone: C2 |
| Set the photo | Yes, before creation (P-b) | After creation: C2 |
| A clone's @username | Only from the creation answer (C-d) | C1 |
| A person's Telegram id | The pairing owner's (U-a); group authors without consent (U-b) | Consented link through a clone: C3 |
| Send to a person | The pairing owner's private chat (§3.4) | Any person who allowed it: C3 |

## 4. Design principles applied here

1. **The MCP tool is the surface.** Two new tools, `relay_clones` and
   `team_members`, and one new field on `seat_tick_settings`. Each calls the
   same Viewer routes and library functions; UI and agents share one
   implementation and one authority check.
2. **Authority lives on the server, in the route.** The MCP binding repeats
   the check only to give a clear refusal before a network call. Writes are
   admitted for the operator root or a designated seat (M2); reads for every
   agent, with personal data left out of every answer.
3. **The server decides where and to whom.** No caller supplies a report's
   poster, a report's chat, or a recipient's messenger id. The server derives
   each from the caller's identity and stored settings, at every send.
4. **A person confirms once, where only a person can.** Creating a bot is
   confirmed in Telegram's own window (C-d). The owner allows messages with
   one press in Delegatus; another person allows them with one press in the
   clone's chat, and a member or the owner confirms who that person is with
   one press in Delegatus. An agent starts each of these; none is a manual UI
   flow. A person can also withdraw their own consent with one press, because
   consent that only an agent can withdraw is not the person's.
5. **Tool descriptions say what exists.** The seat learns from the
   description that it can create clones and set their photos. The
   description states capabilities and the confirmation each needs, and gives
   no instruction to offer them. The seat prompt stays as it is.

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
  report header would silently forget the clone.
- A release without this field ignores the key (the decoder reads named
  fields only, R1), so a downgrade posts automatically again.
- Transfer (R12) copies it; on another installation it resolves only when a
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
| `private_report_chat` | The chosen chat is a private chat; clones carry group text only (R7). |
| `clone_unknown` | No paired, unpaused Celestia relay lists that target. |
| `clone_not_in_report_chat` | The clone directory does not list the report chat under that clone, or the clone is inactive there or switched off here (R8). The answer carries `https://t.me/<username>?startgroup` when the clone's @username is known (C1 or the creation record), so the operator can add it to the group in one action (<https://core.telegram.org/api/links>, "t.me syntax (groups)"). |

`"automatic"` removes the field. The write records `changedBy`
(`operator` or `seat:<conversation id>`).

**Read.** `get_orchestrator`'s `reportTelegram` (R4) gains
`poster: { mode: "chosen" | "automatic", clone?, name?, state }`, with `state`
one of `ready`, `not_in_chat`, `inactive`, `switched_off`, `unpaired`, or for
automatic `clone` / `bot` / `none` (who would post now). The settings route
answers the same view as `reportPoster` so the UI can show it.

**Send: the poster belongs to the report, never to the caller.** Today the
bridge report's Telegram copy goes out as a generic `op:"send"` with a chat the
caller names (R5, R6). A poster carried on that path would be usable by any
caller that names the same chat. So the report gets its own operation:

1. The bridge report binding sends
   `{op:"report", clientRequestId, text, format:"html", silent:true, expectChat, expectTopicId?}`
   to the agent route. It names no chat to post to and no poster.
2. The route resolves the forwarded conversation with the same manager
   attribution the binding uses (M2, `bindings.ts:1159-1175`): a designated
   seat, or a deputy of one, is the manager of exactly one project. Any other
   caller is refused `report_not_manager` (403), with no send.
3. The route reads that project's stored `reportTelegram`. When it is log
   only or reports are off, it answers `no_report_chat` (409). When its chat
   or topic differs from `expectChat`/`expectTopicId`, it answers
   `report_chat_changed` (409): the HTML was rendered for another chat. This
   closes the window between the binding's own chat check (R5, replay) and the
   send.
4. The route calls `TelegramBotService.send` with the stored chat and topic
   and, as an internal argument, the stored `poster`. No other operation can
   pass a poster: `send`, `send_media` and `send_document` refuse a body that
   has a `poster` key with 400 `poster_not_allowed`, before any chat lookup.
5. `selection()` with a poster:
   1. asks the clone directory for that exact clone and chat with a new
      `CloneDirectory.routeFor(chatId, origin, targetId)`, which ignores the
      two-clone ambiguity rule (R8, `:118-124`) and keeps the active and
      enabled checks (`:134`);
   2. puts that clone first, ahead of an assigned bot: the project's choice
      covers that project's reports only, and for them it wins over the
      chat-wide assignment, so the clone transport's assigned-bot refusal
      (`multiBot.ts:189-192`) does not apply to it;
   3. on a refusal that leaves the key unused, records it and continues with
      today's candidates (assigned bot, automatic clone, bots), exactly as the
      current fallback (`relay-send-as-clone.md` §6). On `rate_limited` or
      `uncertain` it stops, as today. The report row keeps `sentBy` and
      `refusals`, so the seat and the operator see that the chosen clone did
      not post.

Projects A and B reporting into the same group therefore stay apart: A's
seat posts A's reports through A's clone; B's seat, calling `op:"report"`,
gets B's own settings; and no caller can put A's clone on a generic send.

**UI.** The seat's Reports line (R11) adds the poster after the chat:
«→ <chat> · від <clone name>» (en «→ <chat> · as <clone name>»), and the
unavailable states in words («клон не в групі», «клона вимкнено тут»). No
picker: the choice is the agent's, on the operator's word.

### 5.2 Part 2: a seat creates a clone through MCP

`relay_clones` actions `create`, `status`, `cancel` and `list` call the
library functions through the Viewer routes (D2, D8). The route guard gains
one option, `guardRelayRoute(request, { seats: true })`, which admits,
besides the operator, a caller whose forwarded conversation is a designated
seat (M2). Clones belong to the installation's pairing, so any project's seat
qualifies. Every other agent is refused `relay_clones_refused` (403). The
same consent rules hold as in the card:

| Rule | Card until now | MCP |
|---|---|---|
| Who may start | The operator (D8) | The operator root or a designated seat |
| Relay must offer it | `clone_create` in the descriptor (D6) | Same: `clone_create_unsupported` |
| One clone at a time until set up | `clone_setup_pending` (D2) | Same; the setup finishes on the server (below) |
| One open request | A new one replaced it (D2) | Refused `clone_request_open` with the open request's state; the agent cancels it explicitly. No caller overwrites a request another caller opened. |
| Who creates the bot | The person who confirms in Telegram's window; only the paired owner's clones appear here | Same: `create` answers `createUrl`; the agent hands it to the operator, who confirms once in Telegram |
| Limits | Celestia: 20 requests a day per owner (C-c) | Same, answered `clone_daily_limit` with `retryAfterSeconds` |

`create { name?, username? }`: a missing name is `randomCloneName` in the
operator's language and a missing username is `deriveCloneUsername(name)`
(`cloneNames.ts:65-74`, `:90-101`); invalid ones are refused, because they
become a public bot's identity. The request is created with no photo (C-b);
a photo is set on the open request (§5.3). The answer:
`{ requestId, createUrl, expiresAt, next }`, where `next` says: set a photo
first if wanted, then give `createUrl` to the operator, who confirms in
Telegram; then call `status`.

`status { requestId, wait? }` reads `GET /clone-requests/{id}`; with
`wait: true` it polls every 3 s for up to 25 s inside the 30 s call budget
(M3). `cancel { requestId }` is the existing `DELETE`.

**The setup runs on the server.** On `created`, `checkCloneRequest` finishes
what the browser does today (D7): engine `codex-cloud` with the default model
(the constant moves from `CloneCreate.tsx:269` to the server module unchanged),
`answered_by: install` on the relay, then forget the created record. Each step
starts from the relay's current row, so a repeated check repeats nothing that
went through. Three callers run the same check: `status`, the card's read
while it is open, and the relay's poll loop (D11), which checks an open
request or an unfinished created record at most every 30 s. So a clone is set
up with no browser open and no further agent call. Each relay holds at most
one open request, so the loop adds at most two `GET`s a minute for its
60-minute life (C-c).

**The card shows the agent's request and asks for nothing else.** The
Celestia card stops being a place to prepare a clone:

- Removed: the form (`CloneForm`, `PhotoChooser`) and every opener of it
  (D10): the empty state's button, the list's «Створити клона» row and
  «Спробувати ще». The empty state keeps its line saying the pairing has no
  clones yet. The browser's setup hook (D7) goes, since the server does it,
  and so does its retry button: the next check retries.
- Shown, while a request is open: the requested name and @username, the
  chosen portrait when there is one, the expiry, the Telegram link and
  «Скасувати». The link is the one thing a person must do, and Telegram's own
  window is where they do it; its label becomes «Відкрити Telegram» (en «Open
  Telegram») because the request may not have been opened yet. The operator
  may also open `createUrl` from the agent's message; either way is one press.
- Shown afterwards, as today: created (with `photo_failed` and the link to the
  new bot), or the request's end in words.

The card's only write is `DELETE` on «Скасувати».

### 5.3 Part 3: generate a portrait and set it as the clone's photo

**While the clone is being created (works with Celestia today).**

- `avatar { requestId, prompt? }` starts generation in the Viewer, one job
  per relay at a time, and answers `{ jobId, state: "generating" }` at once,
  because Celestia's generator can take up to the 120 s the client already
  allows (D3) and an MCP call has 30 s (M3). It calls
  `POST /clone-requests/{id}/avatar-candidates` (P-a). `prompt` defaults to
  `cloneAvatarPrompt(name)` (`cloneNames.ts:120-123`); a longer one is cut to
  Celestia's 500 characters and the answer says `promptTruncated: true`.
- `avatar { jobId, wait? }` reads the job: `generating`; `ready` with
  `candidates: [{ candidate, preview }]` and `remainingToday`; or `failed`
  with a code. `preview` is a path to the 160 px JPEG the server already makes
  (D3), written to `external-relay/avatar-previews/<jobId>/` under the state
  directory (0600 files, removed 24 h later or by the next job), so the agent
  can look at each portrait before choosing.
- `set_photo { requestId, candidate }` sends
  `PATCH /clone-requests/{id} {photo:{kind:"candidate", candidate_id}}` (P-b).
- `set_photo { requestId, file }` takes an absolute path to a picture the
  agent has, admitted only under the operator's document roots by the rule
  `telegram_bot_send_media` follows (M8), turned into the 640 px JPEG (D4),
  and sends `PATCH … {photo:{kind:"jpeg", data}}`. This keeps the upload
  option of the 2026-10-11 decision now that the card has no form; Celestia
  counts it against the 20 requests a day (P-b).
- `set_photo { requestId, none: true }` sends `photo: null`.
- The job lives on the paired relay record (D5) as
  `avatarJob {id, requestId, state, candidates, startedAt, error?}`, so a
  Viewer restart answers `interrupted` and never a stale `generating`. The
  open request record gains `photo?: {kind: "candidate" | "file", preview}`
  (the 160 px data URL), so the card shows the chosen portrait.

The photo must be chosen before the operator confirms in Telegram: Celestia
applies the draft's photo while provisioning. A clone created first comes out
without a photo, or with `reason: "photo_failed"`; its photo then needs C2.

**After the clone exists (needs C2).** `avatar { clone, prompt? }` and
`set_photo { clone, candidate | file }` call the C2 endpoints. Until the
descriptor lists `clone_photo`, both answer `photo_change_unsupported`, and
the answer says the photo can be set while a clone is being created.

Who may call: the operator root or a designated seat, as in §5.2. Generation
spends the owner's five daily slots, so ordinary agents are refused.

### 5.4 Part 4: a team member's messenger identity, consent, and messages

#### 5.4.1 Where an identity comes from

Three proofs exist or are added; none replaces another:

| Source | Proof | Where it is kept |
|---|---|---|
| (a) Sign-in link | The typed-back code (T2) | `members.telegram_*` (T1), unchanged |
| (b) Relay pairing owner | Celestia's pairing, confirmed by the account in its main bot (U-a, T7) | `relays.json` (D5), unchanged |
| (c) Link through a clone | Allow in the clone's chat (C3) plus one press in Delegatus by the member or the owner (§5.4.4) | new `member_messenger_accounts` |

A clone link (c) never becomes a sign-in method: its proof is weaker than
the typed-back code.

**The recipient account of a member**, resolved at every send:

1. the member's sign-in link (a), when present;
2. else the member's clone link (c), when present;
3. else, for the install owner only, the pairing owner (b) under exactly the
   existing precedence (T6): the pairing names the id, no member holds that
   id, and the active owner has no link of their own. Without a team store
   (solo mode) the pairing owner is the operator, the only person there.

Conflicts are refused, never resolved by guessing:

- (c) must equal (a) when both exist (`account_mismatch` when linking). A
  change of (a) to another account, or its removal, deletes (c) in the same
  transaction (`confirmTelegram`'s link branch and `unlinkTelegram`, T2, T3).
- No account belongs to two members across (a) and (c) (`account_taken`).
- **The owner through a clone today.** Celestia lets a clone write only to
  the pairing owner (§3.4). A message to the owner is therefore sendable only
  when the owner's recipient account equals that relay's `owner.id`. The owner
  linked to account A while the relay is paired to account B, or account B
  linked to another member, answers `owner_identity_conflict` and sends
  nothing. The message never goes to whoever the pairing names merely because
  it is the pairing.

#### 5.4.2 What is stored

New tables in `team/team.sqlite` (T1); adding tables keeps the schema number
(`store.ts:39-41`).

```
member_messenger_accounts(          -- source (c) only
  member_id TEXT NOT NULL,
  namespace TEXT NOT NULL,          -- "telegram" now; "slack" later
  account_id TEXT NOT NULL,         -- the platform's user id
  handle TEXT, display_name TEXT,
  linked_at TEXT NOT NULL, linked_by TEXT NOT NULL,
  PRIMARY KEY (namespace, account_id),
  UNIQUE (member_id, namespace))
member_message_grants(              -- consent to receive, per clone
  grant_id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  account_id TEXT NOT NULL,         -- the account the consent was given for
  origin TEXT NOT NULL, target_id TEXT NOT NULL,
  consent TEXT NOT NULL,            -- "owner_press" | "contact_link"
  link_id TEXT,                     -- Celestia's contact link (C3)
  state TEXT NOT NULL,              -- "pending" | "active"
  requested_by TEXT NOT NULL, expires_at TEXT, granted_at TEXT,
  UNIQUE (member_id, namespace, origin, target_id))
member_messenger_revocations(       -- outbox of contact links to revoke
  link_id TEXT PRIMARY KEY,
  origin TEXT NOT NULL, target_id TEXT NOT NULL,
  requested_at TEXT NOT NULL, attempts INTEGER NOT NULL,
  next_attempt_at TEXT NOT NULL, last_code TEXT)
member_messages(                    -- idempotency, limits, audit; no text
  member_id TEXT NOT NULL, caller TEXT NOT NULL, client_request_id TEXT NOT NULL,
  project TEXT, grant_id TEXT, sent_at TEXT, state TEXT NOT NULL,
  message_id INTEGER,
  PRIMARY KEY (caller, client_request_id))
```

`namespace` uses the relay protocol's own owner vocabulary (U-a), so Slack is
one more value with its own proof and transport, and no schema change. Sign-in
links are read where they are (T1); nothing is copied out of `members`.

#### 5.4.3 Consent to receive messages

A message goes out only under an **active grant** for that member, that
clone, and the account the member resolves to at send time (§5.4.1). A grant
is per clone: consent given for one clone lets no other clone write. Its
scope matches Celestia's own (pairing, clone, Telegram user) in C3.

**The owner's consent (works with Celestia today).**

1. An agent calls `team_members { action: "request_consent", member: <owner>, clone? }`.
   The server resolves the owner's recipient account and refuses
   `owner_identity_conflict` as in §5.4.1. It picks the clone (the one named,
   else the caller project's report poster, else the first active clone
   enabled here), stores a pending `owner_press` grant bound to that account,
   and answers `{ consentUrl, expiresAt }` (24 hours).
2. The agent gives `consentUrl` to the operator. The page shows «<project
   seat> asks to send you messages through <clone>» with **Дозволити** and
   **Відхилити**. The route behind it uses the browser perimeter (M6), so an
   agent's capability is refused; in team mode it also requires the owner's
   own live session. One press activates the grant or deletes it.
3. The owner withdraws with one press, from the clone's row in the Celestia
   card («Зупинити повідомлення») or the same page, or by asking an agent,
   which calls `withdraw`. A withdrawal deletes the grant at once.

**Another member's consent (needs C3).** The person's Allow in the clone's
chat is the consent; §5.4.4 binds it to a member.

**Grants end**, and their rows are deleted, when consent is withdrawn
(`withdraw`, the Stop press, Telegram's **Stop messages** for a contact link),
the identity under them changes or is unlinked, the member is revoked, the
relay is unpaired, or a send learns the person blocked the clone or stopped
the grant (§5.4.5). A contact-link grant that ends locally goes to the
revocation outbox (§5.4.6).

#### 5.4.4 Linking a member through a clone (needs C1 and C3)

Agent-initiated; the person presses twice and a member or the owner once,
each one action:

1. A seat (or the operator) calls
   `team_members { action: "link", member, messenger: "telegram", clone? }`.
   The server checks that the member is active and that the caller may link
   (§5.4.8), opens `POST /contact-links { target_id }` at Celestia (C3) for
   the clone chosen as in §5.4.3, and stores a pending `contact_link` grant
   bound to that member, with no account yet. It answers
   `{ startUrl, confirmUrl, expiresAt, next }`.
2. The agent sends `startUrl` (`https://t.me/<clone>?start=dlk_<code>`) to the
   person through whatever reaches them: its own chat, a group the clone sits
   in (`telegram_bot_send`), or the operator. The person presses Start, which
   also satisfies Telegram's first-contact rule for that clone (§3.4), and
   then **Allow** in the clone's message (C3).
3. Delegatus polls the link (on the next `team_members` call and on the Team
   page's read) and learns the account `{namespace, id, display_name, handle}`.
   The binding to the member is then confirmed once in Delegatus, at
   `confirmUrl`, by **that member in their own live session or by the owner**,
   behind the browser perimeter (M6): «<first name> (@handle) allowed messages
   through <clone>. Link to <member>?» with **Link** and **Not them**. The same
   card shows on the member's Team row. Nothing binds before that press;
   **Link** writes the account (c) and activates the grant in one
   transaction, after the §5.4.1 checks; **Not them** ends the grant (outbox).

Two confirmations, because Allow is the account holder's consent to receive
messages and the Delegatus press is a member or the owner vouching that this
account is that member. A forwarded `startUrl` alone binds nobody, which keeps
T2's lesson. The residue is a look-alike name and handle that the confirmer
accepts; the card shows both. The Telegram id is learned only from Celestia's
contact link after Allow; group history authors (U-b) are never a source.

#### 5.4.5 Messaging a member

`team_members { action: "message", member, text, project?, clientRequestId }`:

1. Authority and audience (§5.4.8); limits from `member_messages`: at most 10
   messages per member per rolling hour and 50 a day across all callers, and
   5 per hour per calling conversation (`member_rate_limited` with
   `retryAfterSeconds`).
2. Resolve the recipient account (§5.4.1) and pick the grant: the caller
   project's report poster when the member has an active grant for it, else
   the member's most recently granted active grant. No active grant for the
   resolved account: `consent_required`, which names `request_consent` (the
   owner) or `link` (anyone else).
3. Compose on the server: a first line naming the sender from
   `reportHeaderName(project)` and the caller's role, as bridge reports label
   authors other than the manager (`bindings.ts:4075`), then the text. Plain
   text, one message of at most 4,096 UTF-16 units (`text_too_long`).
4. Write the `member_messages` row, then send through the new person send
   (below) with `chat_id` set to the resolved account and key
   `cloneClientKey(relayId, caller, clientRequestId, 0)` (R9). Its `beforeSend`
   hook repeats step 2, and for the owner the match with the relay's
   `owner.id` (§5.4.1), before **every** attempt, including a retry
   inside the budget and a later call that replays the same
   `clientRequestId`, so a withdrawal, an unlink or an identity change stops
   the next emission. A refusal there answers `consent_withdrawn`; when an
   earlier attempt is unresolved the answer says so, since that attempt may
   have been delivered (R9, `:78-80`).
5. Settle the row and answer `{ sent: true, via: <clone name> }` or one code
   (§6).

**The person send.** `cloneSend.ts` gains `sendToPerson(relay, targetId,
input, options)`. It shares the retry loop of `sendAsClone` and differs in two
ways; the group path and its tests stay as they are.

- It writes **no** publication reference (R9 `:71-73`, R10). Those rows exist
  so an owner's reply to a published message finds its context; replies in a
  clone's private chat are deferred (§11), so nothing reads them, and a row
  would copy the person's id into `state.sqlite`.
- It classifies relay answers with its own closed set of codes. No relay text
  and no unknown relay code leaves the adapter:

| Relay answer | Result | Grant | Other clone tried |
|---|---|---|---|
| 200 receipt | `sent` (or `replayed`) | — | — |
| 409 `contact_inactive` (C3) | `consent_withdrawn` | Ended at once (outbox) | No |
| 409 `clone_not_in_chat` (blocked or never started, §3.4) | `not_reachable` with `https://t.me/<clone>` when the username is known | `owner_press`: kept, the owner can start the clone; `contact_link`: ended (the person blocked it after Allow) | No |
| 403 `chat_not_allowed` | owner: `owner_identity_conflict`; others: `consent_withdrawn` | `contact_link`: ended | No |
| 409 `clone_inactive`, 404 `not_found` | `clone_unavailable` | Kept | No |
| 422 `telegram_rejected` | `telegram_rejected` | Kept | No |
| 400 `format_invalid`, `text_too_long` | the same code | Kept | No |
| 503 `telegram_unavailable` | `telegram_unavailable`, retryable; the row returns to pending | Kept | No |
| 429 | `rate_limited` with the wait | Kept | No |
| 409 `send_uncertain`, `idempotency_conflict`; no answer within the budget; any other 4xx or 5xx | `send_uncertain`; a replay uses the same key | Kept | No |

Member replies in the clone's private chat are out of scope (§11).

#### 5.4.6 Unlinking and the revocation outbox

`team_members { action: "unlink", member, messenger }`, the member's own
press on their Team row, or revoking the member, does this in **one
transaction**: delete the member's account (c), delete every grant resting on
that account, and add each contact link of those grants to
`member_messenger_revocations`. From that commit no send can resolve a grant,
so delivery stops before anything reaches Celestia. A team event
`messenger.unlinked` records the namespace and member id only.

The outbox holds only Celestia's opaque `link_id`, the origin and the target:
the person's id, handle and name are gone at the commit, because retrying a
revocation needs only the link id. The outbox is worked:

- at Viewer start, and on each `team_members` call and Team page read, at most
  five due rows per pass;
- `DELETE /contact-links/{link_id}` (C3): 204 or 404 removes the row; any
  other answer or no answer keeps it with `attempts + 1`, `last_code`, and the
  next attempt after 1, 5 and 15 minutes, then hourly;
- rows for an origin with no pairing wait; the next pairing's `DELETE`
  answers 404 for another pairing's link, which removes them, and C3 ends a
  pairing's grants with the pairing.

A row is removed only when Celestia confirms. The table stays small because
each row is one ended contact link, and links are capped at 10 a day per
member (§5.4.8).

**Nothing comes back by import.** Delegatus never creates a grant from
Celestia's list. `GET /contact-links?status=active` (C3) is read only to
refresh known grants and to find **orphans**, active grants whose `link_id`
no local grant holds; an orphan is revoked through the outbox. A link in the
outbox is an orphan by definition, so a list that still shows it makes the
same `DELETE` due again and never makes it sendable.

The person can also stop from Telegram (C3); Delegatus learns at the next send
(`contact_inactive`) or the next refresh and ends the grant.

#### 5.4.7 Privacy: every persisted copy

| Store | What it holds | Who reads it | Retention | On unlink or withdrawal |
|---|---|---|---|---|
| `team.sqlite` `members` (T1) | Sign-in link: id, username, first name | Sign-in, the Team view (T8) | Until unlinked | Unchanged by this design |
| `team.sqlite` `member_messenger_accounts` | Clone link (c): id, handle, display name | The Viewer's team routes; the confirmation card shows the handle to the confirmer | Until unlinked | Deleted in the unlink transaction |
| `team.sqlite` `member_message_grants` | Member id, the account id, clone, link id | The send path; `list` (without the id) | Until it ends (§5.4.3) | Deleted in the same transaction |
| `team.sqlite` `member_messenger_revocations` | Opaque link id, origin, target | The outbox worker | Until Celestia confirms | — |
| `team.sqlite` `member_messages` | Member id, caller, request id, project, grant id, state, message id; no text, no account id | Limits, idempotency | 7 days | Kept: holds no id |
| `relays.json` (D5) | The pairing owner's id, as today | Pairing, identity precedence (T6) | Life of the pairing | Unchanged |
| `state.sqlite` `relay_published_references` (R10) | Chat ids of group publications | Owner reply context | As today | Person sends write nothing here |
| MCP receipts (M4) | Argument digest and the answer; answers carry no id, handle or text | Replay | As today | — |
| Console (R9 `:99-100`) | Outcome, code, status, elapsed ms, part | Logs | As today | — |
| Team events | Action, member id, namespace | Audit | As today | New actions never carry a handle; today's `telegram.linked` keeps its username (T2 `:358`) |
| Celestia | Its grant (pairing, clone, user) and its 24-hour send ledger | Celestia | Celestia's | `DELETE` through the outbox |

No MCP answer, bridge report, task text or log line carries an account id, a
handle or message text. `list` says per member which messenger is linked,
through which proof, which clones may write to them, and whether a consent is
pending. Messages are addressed by member id. Celestia receives no member
names: a contact link carries only the clone, and the prompt in Telegram names
the installation's label. Fixtures and tests use invented ids that match no
real account, and the privacy gate runs on them as on any change.

#### 5.4.8 Who may do what

| Action | Admitted |
|---|---|
| `list` | Every agent; the answer carries no ids and no handles |
| `request_consent` | The operator root and designated seats; at most 3 pending requests per member and 10 a day |
| `link` | The operator root and designated seats; at most 3 open links per member and 10 a day per member |
| consent page, confirmation card | Behind the browser perimeter (M6): the owner for the owner's consent; that member or the owner for a link |
| `withdraw` | The operator root, designated seats, the member in their own session (Team row), the owner; it only reduces who can be messaged |
| `unlink` | The operator root, designated seats, the member in their own session (Team row), the owner |
| `message` | The operator root; a designated seat or a worker whose project the member can access (`workspaceScope(member).access(project) !== "none"`, T9); the member must be active, with an active grant |

In solo mode (no team file) the only person is the operator, whose identity
is the pairing owner (T6); `list` shows that one row, `link` answers
`owner_linked_by_pairing`, and the consent page admits the operator's browser.

## 6. Failure and partial success

| Part | Situation | Answer and state |
|---|---|---|
| 1 | Chosen clone refuses with an unused key (not in chat, inactive, 403, 404, 409, 422, 503) | Falls back to today's selection; the report row records the clone's refusal first; `get_orchestrator` shows `poster.state` from the refusal; the directory is invalidated as today (R8) |
| 1 | Chosen clone rate-limited or uncertain | No fallback; the report copy fails retryable or stays `send_uncertain`; the seat's replay uses the same key (R9) |
| 1 | The operator changes the report chat | The poster is dropped with the old chat (§5.1); a stored copy rendered for the old chat answers `report_chat_changed` |
| 1 | A caller that is not a project's manager calls `op:"report"`; any caller puts `poster` on a generic send | `report_not_manager` (403) / `poster_not_allowed` (400); no relay call |
| 1 | Re-pairing, unpairing, pause | The poster resolves by origin and target id; unpaired or paused reads `unpaired` and sends run automatically |
| 2 | Lost answer to `create` | The MCP receipt replays a recorded answer. If Celestia created a request the receipt never saw, a retry opens a new one, which replaces the old at Celestia (one open per owner) |
| 2 | The operator confirms in another Telegram account | The clone never appears here; the request expires after 60 min; `status` answers `expired` |
| 2 | `created` with `photo_failed` | The clone stands; `status` and the card say so; C2 sets the photo later |
| 2 | Setup step fails (engine, route, forget) | `status` answers `setup: {failed: step, code}`; the next check (status, card, poll loop) resumes from the relay's current row |
| 3 | Generation yields nothing | Celestia refunds the slot (P-a); `failed: generation_failed` |
| 3 | Daily limit | `avatar_daily_limit`, `retryAfterSeconds`, `remainingToday: 0` |
| 3 | Viewer restarts mid-generation | `interrupted`; the slot may be spent (P-a); the agent may retry |
| 3 | Request no longer pending when choosing | Celestia 409 `not_pending`; the clone exists, so C2 applies |
| 3 | `file` outside the document roots or unreadable | `photo_outside_roots` / `photo_unreadable`; nothing sent (M8, D4) |
| 4 | Celestia lacks `contact_links` | `link` answers `link_unsupported`; the owner can still be messaged under an owner grant |
| 4 | Owner's identity conflicts with the pairing | `owner_identity_conflict`; nothing sent, no grant created |
| 4 | No active grant | `consent_required`; no relay call |
| 4 | Consent withdrawn or identity unlinked, then a send or a replay | `consent_withdrawn` or `consent_required`; no relay call; another clone without its own grant cannot write |
| 4 | Person declines or lets the link expire | Grant deleted; counted against the daily link limit |
| 4 | Account already linked to another member, or differs from the member's sign-in link | `account_taken` / `account_mismatch`; the contact link goes to the outbox |
| 4 | Person blocked or never started the clone | Celestia 409 `clone_not_in_chat` (§3.4); `not_reachable` with the clone's link; see §5.4.5 for the grant |
| 4 | Lost answer to a send | Same key retried within the budget, then `send_uncertain`; the row stays pending; no second clone is tried |
| 4 | `DELETE /contact-links` fails at unlink | Local rows gone at once; the outbox retries; a list showing the link re-queues it (§5.4.6) |

## 7. The tools

### 7.1 `relay_clones`

Mutating (durable receipts, M4). Arguments:

```
{ action: "list" | "create" | "status" | "cancel" | "avatar" | "set_photo",
  clientRequestId, name?, username?, requestId?, clone?, prompt?, jobId?,
  candidate?, file?, none?, wait? }
```

`list` answers, per paired Celestia relay, `create: {available, reason?,
open?}` and `clones: [{clone, name, username, active, switchedOn,
answeredBy, reportsFor: [project]}]`. No owner identity, no chat ids.

Proposed description (behaviour is tested; the wording is not):

> Celestia clones of this installation's relay pairing. List them; create a
> new clone (answers a Telegram link the owner opens to confirm the new bot);
> follow or cancel a creation; generate portraits, or use a picture file, and
> set one as a clone's photo. Creating and photo actions need the operator or
> a designated seat. Telegram asks the owner to confirm every new bot. Which
> clone posts a project's reports is set with seat_tick_settings reportPoster.

### 7.2 `team_members`

Mutating. Arguments:

```
{ action: "list" | "request_consent" | "link" | "withdraw" | "unlink" | "message",
  clientRequestId, member?, messenger?: "telegram", clone?, text?, project? }
```

`member` is a member id (`m_…`) or an exact member name. Proposed description:

> Team members and the messenger accounts linked to them. List members and
> whether each can be messaged; ask the owner to allow messages through a
> clone (the owner allows once in Delegatus); start linking another member's
> Telegram through a Celestia clone (the person allows it in Telegram, then
> the member or the owner confirms once in Delegatus); withdraw or unlink;
> send a member a short text through a clone they allowed. Account ids are
> never shown; address people by member.

### 7.3 `seat_tick_settings.reportPoster` and `get_orchestrator`

As §5.1. The new field follows the tool's existing write contract (answers
`changedFields` and `revision`).

## 8. Cross-project requests for Celestia

Nothing below exists at Celestia's `main` `7c74fa2b` (route list in §3). The
seat sends these to the Celestia project's orchestrator once the operator
accepts this design. Each new capability is advertised by a descriptor
feature, and Delegatus does nothing until the feature appears.

**C1. A clone's @username in the target list.** Add optional `username`
(5–32, the bot username pattern) to `Target` in `GET /targets`
(`relay_v1.json:250-302`). Delegatus uses it for `t.me/<username>?startgroup`
(adding a clone to a group) and `t.me/<username>` (asking a person to start
it). No feature flag: an optional field.

**C2. Photo of an existing clone.** Feature `clone_photo`.

- `POST /targets/{target_id}/avatar-candidates { prompt }`: the same
  `AvatarCandidates` answer and the same five-a-day owner limit as P-a,
  candidates kept for that target for 24 h.
- `PUT /targets/{target_id}/photo { client_key, photo }` with `photo` either
  `CloneJpegPhoto` or `{kind:"candidate", candidate_id}` from that target's
  candidates. Celestia applies it with the clone's own token, as provisioning
  already does (`infrastructure/tgbot/clone_profile_photo.py:30-63`), and
  answers `200 {applied_at, replayed}`.
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
  main bot handles a relay start payload (U-d).
- `GET /contact-links/{link_id}` → `{ status: pending | allowed | declined |
  expired | revoked, account? }`, `account` = the `Owner` shape
  `{namespace:"telegram", id, display_name, handle}` once allowed.
- `GET /contact-links?status=active&cursor=` lists this pairing's active
  grants, so Delegatus can refresh its grants and revoke orphans (§5.4.6).
- `DELETE /contact-links/{link_id}` revokes (204; 404 when unknown or another
  pairing's).
- The person can stop it: a **Stop messages** button on the clone's messages
  or `/stop` in that chat, and blocking the bot; each makes the grant
  inactive. Deleting a pairing ends its grants.
- Send: `POST /targets/{target_id}/send` accepts a positive `chat_id` equal
  to the user of an active grant for this pairing and this clone; everything
  else stays 403 `chat_not_allowed` (§3.4). A grant made inactive answers 409
  `contact_inactive` with the key unused. Telegram's refusals keep their
  current codes (§3.4). Limits stay those of send (30 a minute per pairing).
- Celestia stores no Delegatus member names; the grant is pairing, clone and
  Telegram user.

## 9. Slices, in order

Every slice runs its touched test files by path with isolated `HOME`,
`XDG_CONFIG_HOME`, `TMPDIR` and `LLV_STATE_DIR`, the Viewer control URL on a
closed port, and relay calls against `startTestRelay` on port 0
(`src/lib/externalRelay/testRelay.ts:2`) answering Celestia's exact wire
shapes from `relay_v1.json`. MCP tools are proved end to end through an SDK
client over the real server and tool service into the route, on a port-0
loopback server. UI changes add cases to the existing drivers: the clone card
block of `src/components/kanban/kanbanBoard.browser.test.tsx` (`:34446`), the
team workspaces blocks (`:37744`, `:38606`), and the seat reports sheet in
`src/components/mobile/issue1671Evidence.browser.test.tsx` (`:6544`), in en
and uk, light and dark, desktop and phone.

### Slice 0: clone creation through MCP; the card shows the agent's request (Delegatus only)

Library: `cloneCreate.ts` creates with `photo` JPEG or null only; a new
`setClonePhoto(relayId, requestId, photo)` sends `PATCH /clone-requests/{id}`;
`checkCloneRequest` runs the setup (§5.2) and the poll loop calls it. Routes:
add `PATCH /api/external-relay/relays/[id]/clone-requests/[requestId]`;
delete `…/clone-avatars` and its line in `src/lib/team/workspaceRoutes.ts:55`.
`guardRelayRoute(request, { seats: true })`. Tool: `relay_clones` `list`,
`create`, `status`, `cancel`, `set_photo { file | none }`. Card: §5.2.

This slice removes the card's form; its replacement, the MCP tool, lands in
the same slice. The form's generator is already broken live (§3.5); slice 1
restores generation. Upload survives as `set_photo { file }`.

Acceptance:

1. With no browser open, through the MCP client: a seat calls `create`, then
   `set_photo { file }` with a PNG under a document root; the fake relay
   flips to `created`; nobody calls `status`. Within one poll-loop pass the
   new target has engine `codex-cloud` with the default model and
   `answered_by: install`, and the created record is gone. The fake relay saw,
   in this order, `POST /clone-requests` (`photo: null`),
   `PATCH /clone-requests/{id}` (`photo.kind: "jpeg"`), one or more
   `GET /clone-requests/{id}`, the targets refresh and `PATCH /targets/{id}`,
   and nothing else; no request reached `/clone-avatars`.
2. The card, rendered at each state (open request with and without a
   portrait, created, `photo_failed`, setup failed, expired, failed), shows
   the state and offers only the Telegram link and «Скасувати» while open. A
   DOM test finds no text input, no create button and no «Спробувати ще» in
   any state, and the card's only non-read request is `DELETE` on cancel.
3. A worker, and a direct route call carrying an agent capability that is not
   a seat's, are refused; an open request makes `create` refuse
   `clone_request_open` and leaves it untouched; a relay 429 answers
   `clone_daily_limit` with the wait; `list` carries no owner identity or
   chat id; a `file` outside the document roots is refused with no relay call.
4. The kanban driver frames the card's states in both languages and themes,
   desktop and phone. Live acceptance stays with 9b76e868.

### Slice 1: portraits while creating

`avatar` with the background job and preview files, the
`avatar-candidates` route, `set_photo { candidate }`, the chosen portrait on
the open request record and in the card.

Acceptance: `avatar` answers within 1 s while the fake generator takes 60 s;
`avatar {jobId, wait:true}` returns `ready` with four readable previews;
`set_photo` sends `PATCH {photo:{kind:"candidate", candidate_id}}` and never a
candidate inside `POST /clone-requests`; the card shows the chosen portrait;
two `avatar` calls on one relay share one job; a restart mid-job answers
`interrupted`; 429 and 502 map as §6; a worker is refused.

### Slice 2: which clone posts a project's reports

`reportTelegram.poster` (decode, carry-over, transfer); the `reportPoster`
write in `seat_tick_settings` and the settings route with the authority of
§5.1; `CloneDirectory.routeFor`; `op:"report"` in the agent route, the
`poster_not_allowed` refusal on the generic operations, and the bridge report
binding switched to `op:"report"`; the internal `poster` argument into
`selection()`; `get_orchestrator`'s poster view; the Reports line.

Acceptance:

1. A seat of project A sets clone X for A's report chat; a seat of project B
   is refused for A (403); a worker is refused.
2. A bridge report of A posts through X with one relay call and no Bot API
   call, also in a chat where two clones sit and where a bot is assigned.
3. Projects A and B report into the same group. B's seat files a report: it
   posts by B's own setting (automatic), never through X. An agent of B sends
   `op:"send"` into that group with `poster: {origin, targetId}` naming X: 400
   `poster_not_allowed` and the fake relay records no call. A worker calls
   `op:"report"`: 403 `report_not_manager`, no call.
4. X refusing `clone_not_in_chat` falls back to the bot with the refusal
   recorded; rate-limited and uncertain do not fall back.
5. Renaming the report header keeps X; changing the chat drops it; a stored
   copy for the old chat answers `report_chat_changed`.
6. A settings file without `poster` reads and sends exactly as before, and the
   existing selector and service tests pass unedited.
7. The phone driver's seat reports sheet shows «→ <chat> · від <clone>» and
   each unavailable state, in both languages and themes.

### Slice 3: identity resolution, the owner's consent, messages to the owner

The tables of §5.4.2; recipient resolution (§5.4.1); `request_consent`, the
consent page and route, `withdraw`, the Stop press on the clone's row;
`sendToPerson` with its classification and no publication reference;
`team_members list` and `message`; limits and the message ledger.

Acceptance:

1. The owner has no grant: `message` answers `consent_required`, and the fake
   relay records no call.
2. `request_consent` answers `consentUrl`; a POST to it carrying an agent's
   capability is refused; the owner's browser presses **Дозволити** once;
   `message` then sends exactly one relay call, with `chat_id` equal to the
   pairing owner's id and the server-composed first line. A repeat with the
   same `clientRequestId` replays.
3. Identity conflicts, each with zero relay calls at `request_consent` and at
   `message`: the owner linked to account A while the relay is paired to B;
   the owner without a link while B is linked to another member.
4. After `withdraw` (by MCP, and separately by the Stop press): a new
   `message` and a replay of an earlier `send_uncertain` with the same
   `clientRequestId` both answer `consent_withdrawn` with zero relay calls; a
   message naming a second active clone answers `consent_required`. A
   withdrawal committed between two attempts of one send stops the second
   attempt in `beforeSend`. Unlinking the sign-in account the grant was given
   for ends the grant.
5. Adapter, against the fake relay: 409 `clone_not_in_chat` answers
   `not_reachable` with the clone's link and keeps the owner grant; 422
   `telegram_rejected` answers `telegram_rejected`; 403 answers
   `owner_identity_conflict`; 409 `send_uncertain`, and an unknown 409 code,
   answer `send_uncertain`; no case tries a second clone. Existing
   `cloneSend` tests pass unedited.
6. Privacy: after a sent message, a test searches `team.sqlite` (every
   table), `state.sqlite` (every collection, `relay_published_references`
   included), `relays.json`, the receipt store, the captured console and the
   team events for the invented account id. It is found only in `relays.json`
   and the grant row; after `withdraw`, only in `relays.json`.
7. The 11th message in an hour is refused with a wait; a worker of a project
   the member cannot access is refused; solo mode admits the operator's
   browser on the consent page.
8. Rendered: the consent page and the clone row's Stop press, both languages
   and themes, desktop and phone.

### Slice 4: linking other members (needs C1 and C3)

`link`, the confirmation card and route, `unlink`, the revocation outbox,
grant refresh with orphan revocation, `message` to any linked member, the
Team row's pending and linked states.

Acceptance:

1. With the fake relay offering `contact_links`, `link` returns `startUrl`
   and `confirmUrl`; nothing is bound after Allow until the member or the
   owner presses **Link** in their own browser; another member's session and
   an agent's capability cannot confirm; **Not them** revokes at the relay.
2. `account_taken` and `account_mismatch` refuse and revoke.
3. A member send succeeds; then `DELETE /contact-links` is forced to fail and
   the member is unlinked: the account and grant rows are gone at once and a
   `message` answers `consent_required` with no relay call. The Viewer
   restarts. `list` runs while the fake relay still lists the grant as
   active: no grant is created, the same `DELETE` is retried. The fake relay
   then accepts it: the outbox row is removed. At no point is a send possible.
4. 409 `contact_inactive` answers `consent_withdrawn`, ends the grant and
   tries no other clone; 409 `clone_not_in_chat` ends a contact-link grant.
5. Privacy: after a member send and unlink, the search of slice 3 finds the
   invented id nowhere.
6. Without the feature `link` answers `link_unsupported`.
7. Rendered: the Team row and the confirmation card in both languages and
   themes, desktop and phone.

### Slice 5: photo of an existing clone (needs C2)

`avatar {clone}` and `set_photo {clone}` against C2, with `client_key`
derived from the call's `clientRequestId`.

Acceptance: a retried `set_photo` after a dropped answer sends the same
`client_key` and reports `replayed`; without `clone_photo` both actions
answer `photo_change_unsupported`.

Slices 0 to 3 need nothing from Celestia. C1, C2 and C3 can be built at
Celestia in parallel; slices 4 and 5 wait for their feature flags.

## 10. Validation against the requirement

- Requirement 1, a clone bot per project for reports: §5.1. Each project
  stores its own poster; its manager's reports post through it, also where
  several clones or projects share a group, and nobody else can use it.
- Requirement 2, clones created by agents, known but not proposed: §5.2 and
  §7.1. The same request, limits and Telegram confirmation as the card had;
  the seat learns the capability from the tool description; the prompt is
  unchanged; the card no longer prepares clones.
- Requirement 3, a generated avatar through Celestia's API with no token on
  our side: §5.3. Every photo goes through Celestia's endpoints; Delegatus
  holds no clone token. Existing clones wait for C2.
- Requirement 4, a stored user identity usable for messages through the
  relay: §5.4. Namespaced accounts with Slack as one more namespace, consent
  per clone, messages through a clone; the owner from slice 3, everyone else
  after C3.
- The agent-first principle: every capability is an MCP action. The UI shows
  state (the Reports line, the clone card, the Team row) and offers one press
  where a person must act: Telegram's new-bot window, the owner's consent,
  Allow, Link, and a person's own Stop.

## 11. Deferred — not currently justified

- **A clone picker in the report settings UI.** The operator asked for agent
  first; the Reports line shows the choice. Trigger: the operator asks for a
  picker.
- **A chosen poster for a private report chat.** Clones carry group text
  (R7); owner private-chat text through a clone is deferred by
  `relay-send-as-clone.md` §9. Trigger: that row is lifted.
- **An agent's own image file as a clone photo.** Moved into scope in
  revision 2 as `set_photo { file }` (§5.3): with the card's form gone it is
  the only way to keep the upload option of the 2026-10-11 decision.
- **Portraits as MCP image content.** Preview files are enough for an agent
  to look at. Trigger: a client that cannot read local files.
- **Removing a clone's photo** (`removeMyProfilePhoto`). Nobody asked.
- **Member and owner replies routed back to the sending agent.** A reply in
  the clone's private chat is Celestia's to answer, or an owner request
  without a publication context (no reference row, §5.4.5). Trigger: the
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
- **The owner's consent through a contact link.** Once C3 exists, the owner
  could allow in Telegram and stop there too. The Delegatus press already
  works today. Trigger: the operator asks to manage it from Telegram.
- **A history of ended consents.** Ended grants are deleted, so their ids go
  with them; team events keep the namespace and member id. Trigger: an audit
  need that events do not meet.
- **Choosing a clone for the card's own creation.** The card no longer
  creates. Trigger: the operator asks for a creation control back.

## 12. Notes and decisions taken with a default

- **Fallback of a chosen poster.** A clone that cannot post falls back to
  today's selection so reports keep arriving, with the refusal visible. A
  stricter "chosen clone or nothing" is one condition in `selection()` if the
  operator prefers it.
- **The card's form is removed** on the 2026-11-02 request to create clones
  through agents instead of the UI; the 2026-10-11 decision placed it there.
  Its three photo options stay, through MCP.
- **Who vouches for a member's account.** The member or the owner, with one
  press. The request reads as the owner linking people, and the member's own
  press covers members who use the UI.
- **Limits** (10 an hour and 50 a day per member, 5 an hour per calling
  conversation, 3 open links or consent requests per member) are starting
  values in one constant each.
- **No performance claim.** The report send adds one in-memory directory
  lookup and one settings read; the poll loop adds at most two `GET`s a
  minute while a clone request is open; the outbox works at most five rows
  per pass; nothing new runs per tick.
- **Task 65762062** (a binding that stays inactive) shows up here as
  `poster.state: inactive`; its fix stays in that task.
