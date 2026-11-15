# Relay: fetch the media of a stored group message, and show edits

Status: design, 2026-11-13. Lane 91187a0c (design → build → review → fix).
Delegatus anchors are on `ce7806df4a` (main, the base of this branch).
Celestia anchors are on `9668cc85cf`, its main, which equalled the remote head
when it was read (`git ls-remote`, 2026-11-13 ~08:50Z). The Celestia checkout
was read with `git show` and `git grep` only; nothing in it was changed.
Rechecked 2026-11-13 ~09:20Z before hand-over: Delegatus `origin/main` is still
`ce7806df4a`; Celestia's main had moved two commits (to `d05b19aff8`), and
neither touches a file cited here (`git diff --stat 9668cc85 origin/main`).

## Originating requirement

On 2026-11-13 at about 08:45Z the operator asked, through another project's seat
on this machine (an agent relay with no authority of its own), for two things:
seats should be able to set reactions selectively and list the available ones,
and media fetching should finally be fixed, including video and files larger
than 20 MB and 50 MB. This document covers the media half; reactions are a
separate task. Source: the pinned specification of this lane's task.

The need behind it, as the requesting seat described it: a seat reads a pilot
group with `relay_owner_history` and answers with `telegram_bot_send`. Users
report interface problems there with screenshots. The history returns such a
message as `media: {kind: "photo", description: null}` and nothing else, so the
seat cannot see the screenshot. It fell back to a separate personal-account
Telegram session. A third seat reported the same day that an edited message
keeps its first text in the history.

**Should this be built?** Yes. The operator asked for it in plain words, a seat
is blocked on it today, and the workaround it used (the operator's personal
account) is exactly what the requirement forbids. The minimum that serves it:
one fetch action on the existing history tool, a media description in the
history page, the edit fix, and one new endpoint in the paired service. Cut
scope is listed under [Deferred](#deferred--not-currently-justified).

## Was this solved before?

- `search_transcripts`, project-scoped then unscoped, with three phrasings
  ("relay_owner_history media fetch photo file download", "owner history photo
  placeholder without contents", "owner history media endpoint TDLib large file
  download relay"). Hits: an issue-reporter's unpublished draft from the same
  morning describing the same symptom (no earlier issue existed); lane
  1843dc92 and Celestia PR #4082, which return *tool-result* images to the
  relay tool loop (a different path, fenced for this lane); nothing that
  designs a fetch for stored history. `search_memory` returned nothing.
- `docs/design/relay-owner-group-history-install.md` S12–S13 (this repository)
  and Celestia's `docs/design/relay-owner-group-history.md:73` (S4) and `:268`
  already recorded both gaps as known limits of the first history release:
  edited messages keep their first text, and file ids, document names and file
  sizes are left out of the page. Neither designed a way past them.

## 1. Observed limits and configuration

### 1.1 Vendor documentation, read 2026-11-13 08:55Z

Pages were fetched with `curl` into stage scratch and read there.

| Source | Statement (verbatim) | Page SHA-256 |
|---|---|---|
| [Bot API, `getFile`](https://core.telegram.org/bots/api#getfile) (Bot API 10.4, dated 2026-11-09 in "Recent changes") | "For the moment, bots can download files of up to 20MB in size." | `5efc6ff6a69473f756fe1611586d2855921b2ed54639b72b31c11a2be3467c0d` |
| [Bot API, Sending files](https://core.telegram.org/bots/api#sending-files) | Multipart upload: "10 MB max size for photos, 50 MB for other files." By URL: "5 MB max size for photos and 20 MB max for other types of content." | same page |
| same section | "file_id is unique for each individual bot and can't be transferred from one bot to another." | same page |
| [Bot API, Using a Local Bot API Server](https://core.telegram.org/bots/api#using-a-local-bot-api-server) | "Download files without a size limit. Upload files up to 2000 MB." | same page |
| [Bot API, `logOut`](https://core.telegram.org/bots/api#logout) | "You must log out the bot before running it locally … will not be able to log in back to the cloud Bot API server for 10 minutes." | same page |
| [telegram-bot-api README](https://github.com/tdlib/telegram-bot-api#usage) | "The only mandatory options are `--api-id` and `--api-hash`" (application credentials from my.telegram.org). | `3bae926527cbf9b9a4f9ef377d35f54435e938db3fcddcaf8e78a21607ed00f6` |
| [Bots FAQ](https://core.telegram.org/bots/faq) | "Bots can currently send files of any type of up to 50 MB in size." | `ba8a21cc842480cea791c0dde2e45c22328e32ff0f5b663288e45807e0496f20` |
| [MTProto files](https://core.telegram.org/api/files) | Upload size is bounded by the `upload_max_fileparts_default` / `_premium` configuration values times a part of at most 512 KB. The page gives no byte figure; the effective bound used here is the paired service's own ceiling (§1.3). | `625f2666b0369544268fe0f5bf4295f5e9cc37ae52b2bf3b6851225ac78ff4c9` |

What the operator's two numbers are: 20 MB is the cloud Bot API's **download**
ceiling. 50 MB is its **upload** ceiling for documents and video. Fetching to a
local file is bound only by the first. The 50 MB figure would bind a design that
re-posts media through a bot; this one never does.

### 1.2 This installation (read 2026-11-13, without printing any secret)

| # | Fact | Where |
|---|---|---|
| I1 | Delegatus's own bot transport has one API origin, the cloud server, as a constant; `src/` names no other Bot API origin and reads no setting for one. | `src/lib/telegram/bot/transport.ts:54`, `:108` |
| I2 | The installation's bot reports `receiving: webhook_elsewhere`: its updates go to another program's webhook. The bot store holds no inbound message at all (outbound rows only). So `telegram_bot_messages` sees no group message here, and file ids the paired service received cannot be used by this bot anyway (I1, §1.1 row 3). | `bot` and `messages` tables of the bot store, read in read-only mode; meaning at `src/lib/telegram/bot/contracts.ts:128` |
| I3 | Even where the bot does receive, its store keeps `kind` and text and no file id, size, name or MIME type. It does keep edits (`UPDATE … text, edited_at`). | `src/lib/telegram/bot/store.ts:145-149`, `:166-170`, `:452-470`, `:528-545` |
| I4 | One Celestia pairing, HTTPS, unpaused. Descriptor features: `relay_owner_tools`, `relay_media_in`, `relay_media_any_document`, `clone_send_methods`, `relay_media_out` and others; no feature for history media. The owner-tools switch is ON. `max_response_bytes` is 1 MiB. | `external-relay/relays.json`, `switches.json` (shapes read, credential redacted) |
| I5 | The clone send limits this pairing advertises: photo 10,000,000 bytes; document and video 20 MiB. These bound *sending* through a clone and are not used here. | `external-relay/clone-directory.json.send.json` |
| I6 | A personal-account Telegram connector exists (a user session of the operator's own account). The requirement forbids it for this work and the design never calls it. | `src/lib/telegram/connector.ts:18-30` |

### 1.3 The paired service (Celestia, `9668cc85`)

| # | Fact | Where |
|---|---|---|
| C1 | Primary and clone bots use the cloud Bot API; "No local Bot API server … Existing cloud file limits remain." | `AGENTS.md:63`; `docs/distributed-blue-green.md:302-304` |
| C2 | A bot-authenticated TDLib service runs as one shared owner on infrastructure, with `TDLIB_MEDIA_ENABLED: "true"` in its compose file and a 37 GB production database. | `docker-compose.telegram.yml:1-9`; `docs/distributed-blue-green.md:1693` |
| C3 | It exposes `POST /v1/media/fetch` (bot id, chat, message, kind, file unique id, size) and streams the file it downloaded through MTProto. It serves the primary bot and every active clone, from the clone's stored token. Private networks only. | `apps/backend/tdlib_sidecar/controllers.py:43-53`; `token_store.py:22-32`; `access.py` |
| C4 | Its ceiling is `TDLIB_MAX_MEDIA_SIZE_BYTES`, default 2,147,483,648 (2 GiB); 330 s per fetch; two downloads per bot at once. It refuses a size of 0 and a size that differs from the message's. | `.env.dist:90-107`; `tdlib_sidecar/media_resolver.py:14-27`; `tdlib_client.py:40`, `:420-461` |
| C5 | Kinds it fetches: video, audio, voice, video note, animation, document (a document with a `video/*` type counts as either). Photos are not among them, so photos come only through the Bot API. A photo above 20 MiB would have no path; a bot may upload at most 10 MB as a photo (§1.1), and H4 answers `too_large` if such a photo ever appears. | `tdlib_client.py:1116-1163` |
| C6 | Celestia's media service already routes by size: up to 20 MiB through the Bot API, above through TDLib. | `golang/services/mediaservice/internal/infrastructure/mediafetcher/fetcher.go:17`, `:143-158` |
| C7 | The relay's own media input (`/requests/{id}/media/{ref}`) reads through the Bot API only and refuses anything over 20 MiB. It is bound to a claimed request's lease, so a seat reading history cannot use it. | `apps/backend/infrastructure/tgbot/relay_media_input.py:23-45`; this repository `src/lib/externalRelay/client.ts:212-256` |
| C8 | A fresh TDLib session can lack a chat until an update arrives there; Celestia's rehearsal recorded this. | `docs/distributed-blue-green.md:1544-1547` |

**What could not be confirmed from this machine:** the production values of
`TDLIB_MEDIA_ENABLED` on the app hosts and of `TDLIB_MAX_MEDIA_SIZE_BYTES`
(protected environment files on other hosts), the read timeouts of the
production edge proxy, and whether the TDLib session of the clone in the pilot
group already knows that chat (C8). All three belong to Celestia's seat and are
listed in its request (§6.5); none needs the operator.

### 1.4 The real limits, per size class

| Size of the file | Cloud Bot API (C1) | Celestia TDLib (C2–C5) | Delegatus's bot (I1–I3) | Chosen path |
|---|---|---|---|---|
| up to 20 MiB | yes, through the bot that received it | yes, except photos | no | Celestia, Bot API of the receiving bot |
| 20 MiB – 50 MB | no | yes | no | Celestia, TDLib |
| 50 MB – 2 GiB | no | yes | no | Celestia, TDLib |
| above 2 GiB (or above Celestia's configured ceiling) | no | no | no | explicit refusal `too_large` naming the limit and what lifts it |

## 2. The existing code paths

### 2.1 Where history is stored

Group history lives in Celestia, never in Delegatus. The bot middleware
publishes every new group message to a save queue
(`apps/backend/tgbot/middlewares/save_incoming_messages.py:85-210`, registered
for every update at `apps/backend/bot.py:191`); the saver
(`messaging/controllers/save/chat/message.py:50-72`) inserts one
`chat_messages` row keyed by `(message_id, chat_id)`
(`infrastructure/database/repo/chat_messages.py:160-215`). The row's
`message_metadata` holds the media facts, written by `build_message_metadata`
(`tgbot/middlewares/parsers.py:26-72`): the receiving bot's id, the bot's file
id per kind, `file_unique_id`, `file_size`, `media_kind`, and for photos width,
height and `image/jpeg`, for documents MIME type and file name. Video, audio and
animation get no MIME type, no name and no duration, and the proto has no
duration field (`proto/messaging/v1/message.proto:11-54`). Celestia keeps the
newest 30,000 rows per chat.

H3 reads those rows (`infrastructure/database/repo/owner_group_history.py:95-167`)
after the authority checks of the use case
(`application/usecase/clones/owner_group_history.py:129-144`, `:175-194`).

### 2.2 Where media is described

The H3 reader derives `kind` from `media_kind` or the per-kind id keys and takes
`description` from `ai_media_description`, which exists only if a relay request
once asked for a description of that message
(`owner_group_history.py:119-149`; writer `ai_agent/services/relay_media.py:107-194`).
A screenshot nobody asked about therefore reads `{kind: "photo", description: null}`.
Delegatus validates that object strictly as `{kind, description}`
(`src/lib/externalRelay/protocol.ts:453-464`, media at `:460`) and passes it
through unchanged (`src/lib/externalRelay/ownerHistory.ts:185-189`).

### 2.3 The relay's media input

For a claimed relay request, Celestia lists media refs on the trigger and its
direct parent; Delegatus validates them
(`src/lib/externalRelay/mediaInputValidation.ts:20-60`, 20 MiB per file, 100 MiB
per request) and streams each one to a private file through the lease-bound
route (`mediaInput.ts:210-286`, `client.ts:212-256`). The pieces worth reusing
are the streaming discipline (`O_CREAT|O_EXCL|O_NOFOLLOW`, mode 0600, a counting
`Transform`, the length check, cleanup on every failure:
`mediaInput.ts:240-271`) and the client's DNS pinning and redirect refusal
(`client.ts:59-68`, `:217-230`). The route itself cannot serve history: it
needs a live lease (C7).

### 2.4 The Delegatus read path the new action rides on

| Step | Where | What the new action must respect |
|---|---|---|
| MCP schema | `src/lib/mcp/server.ts:5143-5146` | A plain `z.object`: unknown keys are **stripped**, so `messageId` and `directory` vanish unless added. |
| MCP description | `server.ts:4112-4115` | Says "Received edits keep first text … file ids are excluded"; must change with the behaviour. |
| Receipts | `server.ts:254`, `:257-258` | No receipt for this tool, with or without a key. Kept. |
| Binding | `src/lib/mcp/bindings.ts:5801-5806` | Refuses a live owner relay run; forwards a **fixed key list** (`:5804`) that would drop the new arguments. |
| Control channel | `bindings.ts:373-379` | 5 s per attempt, retried within an 8 s budget; one precedent of a 30 s budget for long work (`PROTOTYPE_CONTROL_BUDGET_MS`). |
| Route | `src/app/api/external-relay/owner-history/route.ts:6-16` | Strict body with `op: groups \| messages`; guard first. |
| Guard | `src/lib/externalRelay/routeGuard.ts:45-54` | Cross-origin, staging, live owner relay run refused; the operator's own session admitted. |
| Reader | `src/lib/externalRelay/ownerHistory.ts:151-198` | Switch before and after the call; one destination rule with the clone fallback (`:153-157`); the shared 429 cooldown map (`:40-42`, `:67-86`); four-second deadline for H3 pages. |
| Feature list | `src/lib/externalRelay/poller.ts:460-503` | The descriptor's features are re-read before the first claim and every five minutes. |
| Evidence | `src/lib/runtime/structuredSpawn.ts:207-212`; `src/lib/artifact/localFile.ts:43-47` | Every spawned agent gets `LLV_EVIDENCE_DIR = <state>/evidence/<pipeline or agents/hash>`; the evidence root is `<state>/evidence`, the same path in the Viewer's and the agent's mount namespace. |
| Voice | `src/lib/voiceCompanion/tools.ts:112-119`; `ownerHistoryRead.ts:4-12` | The voice registry has its own two-action enum and calls `readOwnerHistory` in process. It gets the richer media description for free and no fetch. |

## 3. Why edits are dropped

Two places in Celestia, both observed in code:

1. `ChatMessagesMiddleware` runs for every update but takes only
   `Update.message` (`save_incoming_messages.py:95-104`). An `edited_message`
   update falls through "Skip if no chat context or message" and is never
   published to the save queue.
2. Were it published, the saver calls `add_message` without `replace_existing`
   (`messaging/controllers/save/chat/message.py:68-72`), and the repository then
   inserts with `ON CONFLICT DO NOTHING` (`chat_messages.py:213-214`), so the
   first text would stay anyway. The row has no edit time to show
   (`infrastructure/database/models/chat_messages.py:18-36`).

Celestia's own history design recorded the same cause as its S4 and deferred
it. Delegatus's own bot store handles edits correctly (I3); the defect is only
on the service side. Delegatus can show an edit once the service reports one
(§5.1); the fix itself is a Celestia change (§6.3).

## 4. The mechanism per size class

Every file comes from Celestia, through the **bot that received the message**:
only that bot's file id works (§1.1), only Celestia holds its token, and Celestia
already chooses between the Bot API and TDLib by size (C6). Delegatus asks for
one message's media at a new owner endpoint, H4, under the same pairing
credential and authority as H3, and streams the answer into the caller's
evidence directory.

- **Up to 20 MiB** (every photo, most screenshots and documents): Celestia calls
  `getFile` for the stored file id of the receiving bot and streams it.
- **Above 20 MiB up to Celestia's TDLib ceiling** (2 GiB by default): Celestia
  asks its TDLib service, under the same bot, and streams the file it produced.
  Celestia also falls back to TDLib when `getFile` answers "file is too big" for
  a file whose stored size looked smaller: Telegram's "20MB" and the code's
  20 MiB differ by 971,520 bytes.
- **Above the ceiling**, or a kind neither path carries (sticker, poll), or
  protected content: an explicit refusal naming the reason and, for size, the
  limit and what would lift it.

Alternatives considered and rejected:

| Alternative | Why not |
|---|---|
| Delegatus's own bot, `getFile` | Receives nothing here (I2); a file id is valid only for the bot that received it; 20 MB cap. |
| A local Bot API server for Delegatus's bot | Needs application credentials from my.telegram.org and `logOut` of a bot whose webhook another program owns (I2), and it still has no file ids for these messages. |
| The operator's personal session (I6) | Forbidden by the requirement and by the machine rule for paired clones. |
| A new owner tool inside Celestia's owner-tools loop | That loop exists only while a relay run answers the owner in Telegram, returns JSON tool results bounded by 1 MiB (I4), and no seat can call it. |
| The lease-bound relay media route (C7) | Needs a claimed request; 20 MiB cap. |
| Celestia uploads to S3 and hands out a URL | Celestia's attachment store holds 20 MiB per object; a second copy of up to 2 GiB for one read. |

## 5. The tool contract (Delegatus)

`relay_owner_history` keeps its name, switch, guard, privacy contract and its
"no receipt" rule. It gains richer `messages` pages and one action.

### 5.1 `action: "messages"`: media described, edits shown

Delegatus asks for the richer page with the request header
`Delegatus-Relay-Owner-History: 2`. An older Celestia ignores an unknown header
and answers the first shape; an older Delegatus never sends it, so Celestia's
new fields never reach a strict schema that would refuse them. The schema stays
`.strict()` and accepts these optional additions (§6.2):

```
message.edited_at        ISO-8601 UTC | null
media.file_name          string ≤ 128 | null
media.mime_type          string ≤ 100 | null
media.size               integer bytes | null
media.duration           integer seconds | null   (video, audio, voice, video note, animation)
media.width, .height     integer | null
media.fetch              "available" | "too_large" | "protected" | "unsupported_kind" | "unavailable"
```

The tool answers, per message:

```
editedAt: string | null
media: { kind, description, fileName, mimeType, size, duration, width, height,
         fetch } | null
```

and per page `editsReported: boolean` (true when the page came in shape 2), so
a null `editedAt` is never read as "not edited" when the service could not say.
`fetch` is the service's value; Delegatus writes `"not_offered"` when the pairing
does not publish `relay_owner_media` (§6.1) and `"unknown"` when it does but the
page lacks the field. Nothing is downloaded by a `messages` read.

### 5.2 `action: "media"`

```
relay_owner_history {
  action: "media",
  chat: "-100…",            // as in messages
  messageId: 1234,          // integer 1 … 2147483647
  directory?: "/…"          // absolute, an existing directory under the evidence root;
                            // pass $LLV_EVIDENCE_DIR; default <state>/evidence/relay-media
}
```

Answers, all with `available` and `privacy` as today:

| Status | Fields | When |
|---|---|---|
| `done` | `path`, `kind`, `mimeType`, `size`, `sha256`, `fileName` (or null), `source` (`bot_api` \| `tdlib` \| null) | The whole file is on disk, its byte count equals the declared length, and its SHA-256 is computed over exactly those bytes. |
| `in_progress` | `phase` (`queued` \| `preparing` \| `downloading`), `receivedBytes`, `totalBytes`, `retryAfterSeconds` | Not finished within the call's wait. Repeat the identical call to read the outcome; it joins the same job. |
| refused | `reason`, `note`, `retryAfterSeconds`, and for `too_large` also `limitBytes`, `sizeBytes` | See below. |

Refusal reasons: every reason `messages` already has (switch off, no pairing,
paused, rate limited, transport causes, …) plus `not_offered` (the pairing does
not publish `relay_owner_media`; the note says the paired service must offer it
first), `no_media`, `unsupported_kind`, `protected`, `media_unavailable` (the
service could not obtain the file), `too_large` (note names the limit: Celestia's
stated `limit_bytes`, or Delegatus's own 2 GiB per call, and that raising
Celestia's TDLib ceiling together with Delegatus's constant lifts it),
`insufficient_space` (free bytes and needed bytes), `directory_refused`,
`busy`, `incomplete` (the stream ended short, ran long, or failed its digest:
nothing was kept), `deadline_exceeded`.

The on-disk name uses safe parts only:
`relay-<first 12 hex of SHA-256 of the chat id>-<messageId>.<ext>`, the extension
from the MIME type (`.jpg`, `.png`, `.mp4`, `.pdf`, …, else `.bin`), with ` (2)`,
` (3)` before the extension when the name is taken. The original name is
returned as `fileName` and never becomes a path, so no sender-chosen text
reaches the filesystem. The answer passes through the binding's redaction
(`bindings.ts:6225-6233`): a probe in stage scratch showed a 64-hex digest, a
`sha256:`-prefixed digest and an evidence path pass through it unchanged; a
secret-shaped original name may come back redacted in `fileName`, which is
data only.

`directory` is an explicit argument because the binding cannot learn the
caller's evidence directory by itself: a Codex agent's Viewer MCP server
receives only `LLV_SPAWN_CAPABILITY` from the agent's environment
(`src/lib/agent/cli.ts:387`), while `LLV_EVIDENCE_DIR` is set on the agent
(`structuredSpawn.ts:207-212`). Containment is deliberately narrower than
`evidenceRoots()`, which also admits the legacy `/var/tmp`
(`src/lib/artifact/localFile.ts:43-47`): only `<state>/evidence` qualifies.

### 5.3 The Viewer job: queue, join, deadlines

The loopback POST has five seconds per attempt (§2.4), and a large file takes
minutes. So the route never downloads inside the request:

1. The route validates, then joins or starts a job keyed by
   `SHA-256(caller, relay, target, chat, messageId, real directory)`. The caller
   is the calling conversation from the capability header, or `operator`.
2. It waits at most 3 s for that job and answers its state.
3. The binding repeats the identical POST while the answer is `in_progress`,
   for at most 30 s in total (the precedent at `bindings.ts:379`, which already
   runs under both engines; Delegatus sets no MCP tool timeout of its own,
   `src/lib/codexHeadlessConfig.ts:22-31`), then returns
   `in_progress`. A screenshot is expected to finish within that one tool call;
   a large video returns `in_progress` and the seat repeats the call.

Registry: one module-owned map on `globalThis`, as the history cooldown already
does (`ownerHistory.ts:40-42`), so the route bundles share it. At most two jobs
run on the installation, at most eight wait in FIFO order, a further start
answers `busy`. Calls join unfinished jobs. A result completed between polls
stays available until its first delivery, at most 15 minutes and 64 results.
After delivery, an identical call starts a fresh H4 read to check current access
and obtain the current attachment; the protocol supplies no mandatory version
validator for cached files. Refusals are forgotten; the shared history cooldown
controls retries after 429.
A restart forgets jobs; the next identical call starts afresh.

Each job, under `withViewerOperation("external-relay.owner-media", …)` (the
label is added to the union at `src/lib/viewerLoopMonitor.ts:34`):

- total deadline 15 minutes; response headers within 30 s per request; 60 s
  without a body byte aborts;
- `GET` H4 through a new `relayStreamGet` beside `relayDownloadMedia`, sharing
  its DNS pinning, HTTPS-only (plain HTTP on loopback for tests), redirect
  refusal and bounded error-body parse (`client.ts:212-256`), with the pairing
  credential and without a lease;
- `202` waits `retry_after_s` (clamped to 1…30) and asks again; `429` uses the
  shared cooldown map of the history reads;
- `200` is admitted only with a decimal `Content-Length` no larger than the
  per-call ceiling (2 GiB) and no larger than free space minus a 2 GiB reserve
  (`fs.promises.statfs`, probed under the pinned Bun 1.4.0), no
  `Content-Encoding` or `Content-Range`, and a known `Delegatus-Media-Kind`.
  Per-filesystem reservations count all admitted jobs until completion or cleanup;
  a suspended free-space probe also accounts for writes completed since it began.

No step waits synchronously; every file operation is the promise form; memory
per job is one stream buffer. No performance gain is claimed.

### 5.4 Writing the file

- Before: the directory's real path must lie under the real path of
  `<state>/evidence`, be a directory owned by this user, and not be world
  writable. Its device and inode are recorded. The default directory is
  created with mode 0700.
- During: `<final>.part` opened with `O_CREAT|O_EXCL|O_NOFOLLOW`, mode 0600;
  `pipeline(response, guard, writeStream)` where the guard counts bytes, feeds
  SHA-256 and stops on more than the declared length, the ceiling, abort, or the
  owner-tools switch turning off (re-read at most once a second, so the stream
  adds no file read per chunk).
- After: the count equals `Content-Length`, the response is `complete`, and a
  `Repr-Digest: sha-256=…` header, when present, matches. Then `fsync`, recheck
  the switch and the directory's identity, and `link` the part to the final name
  (`EEXIST` takes the next suffix), then remove the part.
- A failure attempts to remove the part and answers a refusal. A cleanup error
  retains its allowlisted errno and conservatively accounts for leftover bytes
  against suspended free-space probes. A partial file is never named in an
  answer. Parts left by a crash are removed by the next job writing
  to the same directory when they are older than 30 minutes.
- One failure line per job, the history reader's way (`ownerHistory.ts:88-101`):
  a fixed cause, HTTP status, elapsed milliseconds, received bytes, and an
  allowlisted errno. No path, chat id, file name, URL or caught message.

### 5.5 Authorization and the threat cases

The server-side check that keeps "a seat fetches only what it may read" is
Celestia's: H4 runs H3's own authority, group and live membership checks on
every request (§6.1). Delegatus adds nothing a caller can widen.

| Hostile input | Path that answers first | Outcome |
|---|---|---|
| A group the owner is not in, a foreign target, a message from another chat | Celestia H4 | 404 with H3's bytes; tool `not_found` |
| A live relay run answering in Telegram calls `media` | binding, then route guard | `owner_history_refused` before any request |
| Switch off; switched off mid-download | `fetchOwnerMedia` before and after; the stream guard | `switch_off`; the part removed |
| `chat` not a negative id, `messageId` out of range, extra keys | MCP schema, route schema (strict) | `invalid_arguments` |
| `directory` outside the evidence root, `..`, a symlink out of it, a file | realpath and type check | `directory_refused` |
| Directory swapped between check and link | identity recheck before `link` | `directory_refused`, part removed |
| Celestia sends more or fewer bytes than declared, or a different digest | stream guard, length and digest checks | `incomplete`, nothing kept |
| HTTP 200 carries `Content-Range` | header admission | `malformed_response`, no file or part |
| A declared size of 3 GiB | header admission | `too_large` with `limitBytes`, no byte written |
| A sender's file name with separators or a secret-shaped string | never used on disk | returned as data only |
| The operator's personal account | no code path reaches it (I6) | — |

### 5.6 Privacy

The tool's existing contract covers the files: use them only to answer the
operator in this conversation; never copy a fetched file, its contents or its
original name into reports, messages to other agents, tasks, commits, pull
requests, issues, lessons, Telegram hand-off folders or other chats. Where the
files rest:

- in the caller's evidence directory, mode 0600, kept like other evidence
  (no automatic expiry: Deferred);
- the operator's browser can open a fetched picture through the artifact route,
  which already serves rasters under the evidence root; team members only as
  their workspace scope admits that directory
  (`src/app/api/artifact/route.ts:20-40`, `:104`);
- `telegram_bot_send_document` and `telegram_bot_send_media` refuse the state
  directory (`server.ts:4101`, `:4106`), so a fetched file cannot be re-posted
  without being copied out first, which the contract forbids;
- an agent that opens the image holds it in its own transcript, as it holds a
  history page today.

## 6. Request for Celestia (the seat relays it; this lane does not act there)

To the CelestiaCompose seat, from the Delegatus seat. Everything below is a
request with acceptance; the design inside Celestia is theirs.

### 6.1 H4: one message's media

`GET {api_base}/targets/{target_id}/owner/groups/{chat_id}/messages/{message_id}/media`,
pairing Bearer and `Delegatus-Relay-Version: 1`, no query parameters.

- Authority, gating and refusal bytes exactly as H3: owner-tools key, active
  confirmed pairing, target bound to this pairing and answered by the install,
  a group of the owner's with the bot or a clone present, the owner's live
  membership, the message stored and not deleted in that chat. Every failure of
  authority or existence answers H3's identical 404.
- Shares the 60-per-minute admission with H1–H3; each poll is one admission.
- Source: the stored receiving bot and its file id. Up to 20 MiB through
  `getFile`; above, or after "file is too big", through TDLib with the stored
  locator. A stored size of 0 with a Bot API refusal is `media_unavailable`.
- `200`: the exact original bytes; `Content-Length` always; `Content-Type`
  (Telegram's MIME, `image/jpeg` for photos); `Delegatus-Media-Kind` (`photo`,
  `document`, `video`, `animation`, `audio`, `voice`, `video_note`);
  `Delegatus-Media-Source` (`bot_api` or `tdlib`); `Content-Disposition` with
  `filename*` when Telegram gave a name; `Repr-Digest: sha-256=:…:` when known.
  No `Content-Encoding`, no ranges. A failure after the headers aborts the
  connection; it never ends a short body cleanly.
- `202 {"status":"preparing","retry_after_s":n}`, n 1…30, answered within
  20 s whenever the file is not ready yet, so no proxy read timeout decides.
- Refusals in the existing envelope: 422 `no_media`, 415 `unsupported_kind`,
  403 `protected` (the relay input's existing rule for protected content),
  413 `too_large` with `limit_bytes` and `size_bytes`, 422 `media_unavailable`,
  429, 500/503.
- Publish the descriptor feature `relay_owner_media` once H4 serves.

### 6.2 H3 shape 2

Only when the request carries `Delegatus-Relay-Owner-History: 2`, add the fields
of §5.1, inside the existing 12,000-byte page budget. A request without the
header keeps today's exact bytes. To fill them, the writer records duration,
and MIME type and file name for video, audio and animation, which Telegram's
objects carry (`parsers.py:48-72`; a new proto field for duration). `fetch`
states what H4 would answer for that message without contacting Telegram.
Rows stored before that writer change keep null for what was never recorded
(duration; MIME type and name of video, audio and animation); `size`, kind
and the protected flag are already stored for every kind
(`parsers.py:26-72`), so old rows still report them and remain fetchable.

### 6.3 Edits

Save `edited_message` updates (`save_incoming_messages.py:95-104`) and let the
saver update the stored text, caption and media metadata of an existing row and
record the edit time from Telegram's `edit_date`, keeping `created_at`
(`messaging/controllers/save/chat/message.py:68-72`;
`chat_messages.py:213-214`). An edit of a message that was never stored inserts
nothing. H3 returns the latest text and `edited_at`. Edits that arrived
before this change were never saved and stay lost; only later edits show.

### 6.4 Acceptance on Celestia's side

A photo through the Bot API; a 21 MiB document and a 60 MB video through TDLib
for a clone; the "file is too big" fallback; a file above the ceiling answers
413 with the limit; protected content 403; a foreign group answers H3's 404
bytes; one `202` then `200`; an edited message reads back with its latest text
and `edited_at`; a request without the shape-2 header gets today's bytes.

### 6.5 What only Celestia can confirm

Production `TDLIB_MEDIA_ENABLED` for the API path and the real
`TDLIB_MAX_MEDIA_SIZE_BYTES`; that a clone's TDLib session can read an older
message in the pilot group (C8), or the retry it needs; the edge proxy
behaviour for long bodies. Coordination: Celestia PR #4082 (open, lane 1843dc92's
counterpart) edits `infrastructure/tgbot/relay_media_input.py` and
`ai_agent/services/relay_media.py`, which H4 may reuse.

### 6.6 Order

Delegatus's slice first: it reads both page shapes and answers `not_offered`
until the feature appears, so Celestia can ship in any later week. Celestia
second. Then the seat runs the operator's case on the live installation: a real
screenshot, a real video over 50 MB and an edited message in the pilot group.
This lane fetches nothing from a real chat.

## 7. The slice this lane builds

| File | Change |
|---|---|
| `src/lib/externalRelay/protocol.ts` | H3 page: optional shape-2 fields, still strict; H4 `202` and refusal bodies. |
| `src/lib/externalRelay/ownerHistory.ts` | Send the shape-2 header; map `editedAt`, `editsReported` and the media fields; `fetch` from the feature list; export the destination selection and cooldown for reuse. |
| `src/lib/externalRelay/client.ts` | `relayStreamGet` (§5.3). |
| `src/lib/externalRelay/ownerMedia.ts` (new) | Job registry, admission, stream to file (§5.3–5.4). |
| `src/lib/viewerLoopMonitor.ts` | The `external-relay.owner-media` label. |
| `src/app/api/external-relay/owner-history/route.ts` | `op: "media"` with `chat`, `messageId`, `directory`. |
| `src/lib/mcp/server.ts` | Schema (`action` gains `media`; `messageId`, `directory`) and description: media fields, `fetch`, `editedAt`, the media action, repeat on `in_progress`, the file privacy sentence. Remove "Received edits keep first text" and "file ids are excluded" in favour of what is true per shape. |
| `src/lib/mcp/bindings.ts` | Forward `messageId` and `directory`; the 30 s join loop for `media` only. |
| `docs/guide/telegram.md:99-100` | One sentence: the history tool can also save a message's media to evidence. |

Tests, all against fakes: the existing history double
(`src/lib/externalRelay/ownerHistory.fixture.ts`) supplies history pages;
`src/lib/externalRelay/ownerMedia.test.ts` streams generated bytes from its own
H4 server. No real file or real chat is involved. Each case names the branch
that turns it red.

| Case | Red if |
|---|---|
| Photo, 300 KB, `bot_api` → `done`, SHA-256 equals the generator's, mode 0600, under the evidence directory | the writer keeps the original name or skips the hash |
| Document, 21 MiB: `202` then `200`, `tdlib` | `202` is treated as an error |
| Video, 51 MiB streamed in 64 KiB chunks; paused halfway: the part grows and no final file exists | the file is buffered whole or linked before the end |
| `Content-Length` 30 MiB, 10 MiB sent, then close → `incomplete`, no file and no part | the length check is missing |
| Service 413 with `limit_bytes` → `too_large` naming it | mapped to a transport cause |
| Declared 2 GiB + 1 → `too_large` before any byte is written | the ceiling is checked after streaming |
| Free space short (injected `statfs`) → `insufficient_space` | no space check |
| Feature absent → `not_offered`, the double received no request | the feature gate is missing |
| Switch off, and switched off mid-stream → `switch_off`, part removed | the switch is read once |
| Directory outside the root, or a symlink out of it → `directory_refused` | containment is lexical only |
| Live owner relay run → `owner_history_refused` before control | the guard is skipped for `media` |
| Identical calls while H4 is held → one H4 request | unfinished jobs are not joined |
| A completed read followed by revoked access or replaced media → fresh H4 authority and current bytes | completed outcomes are reused |
| Two simultaneous 64-byte jobs with only 64 bytes above the reserve → one refused | reservations are independent |
| HTTP 200 with a 64-byte body and `Content-Range: bytes 0-63/128` → refused, no file | a prefix is treated as a whole file |
| Identical call after a one-second 429 cooldown, with an advanced clock → fresh H4 | refusal outlives the cooldown |
| Suspend `statfs`, then await the first successful write before inspecting `.part` | the test assumes disk latency |
| Two running, eight queued, the eleventh → `busy` | the queue is unbounded |
| 429 → `rate_limited` with the wait, and the next history read waits too | the cooldown is not shared |
| Shape-2 page → `editedAt`, `editsReported: true`, media fields, `fetch`; a shape-1 page still reads; an unknown extra key is still refused | the schema loosened or the header is not sent |
| The failure log line holds only allowlisted keys | a path, id or message leaks into logs |
| MCP: `messageId` and `directory` reach the route; no receipt is written | the fixed key list or the strip drops them |

Run each test file by path in its own isolated command through
`scripts/gate-slot.sh`, with private HOME, TMPDIR, `LLV_STATE_DIR` and a closed
`LLV_VIEWER_CONTROL_URL`; typecheck, lint, the privacy gate and the unmodified
pre-push hook as the stage brief names. Fixtures use synthetic ids such as
`-1001000000001` and names such as "Example group one".

Fence: nothing here touches the relay tool loop or how tool-result images reach
a model (lane 1843dc92). A seat opens a fetched image with its own file-reading
tool.

## 8. The requirement's example through each state

| State | Screenshot in the pilot group | 60 MB screen recording | Edited message |
|---|---|---|---|
| Today | `{kind: "photo", description: null}`, no way to fetch | same, kind `video` | first text |
| After this lane, before Celestia | same page; `fetch: "not_offered"`; `media` answers `not_offered` naming the missing service feature | same | first text, `editsReported: false` |
| After Celestia ships §6 | `fetch: "available"`, size, dimensions; `media` → `done` with path, kind, `image/jpeg`, size, SHA-256 inside the first call | size, duration, `fetch: "available"`; `media` → `in_progress` a few times, then `done`, `source: "tdlib"` | latest text, `editedAt` set |
| A 3 GB file | — | `fetch: "too_large"`; `media` → `too_large` naming 2 GiB and the lift | — |

The operator's case is closed only in the third row, verified by the seat on
the live installation (§6.6).

## Deferred — not currently justified

- **Fetch in the voice registry.** The voice has no file tools; it keeps reading
  the richer description. Trigger: a voice question that needs a file.
- **Fetch for `telegram_bot_messages`.** This installation's bot receives
  nothing (I2) and stores no file ids (I3). Trigger: a bot that receives in a
  chat with media worth fetching.
- **A local Bot API server or MTProto client in Delegatus.** Needs application
  credentials and a bot `logOut`, and still lacks the file ids. Celestia's
  TDLib carries large files today.
- **Files above Celestia's ceiling** (Premium uploads reach beyond 2 GiB).
  Trigger: a real refusal of a file the operator needed.
- **Resumable or ranged downloads.** Trigger: repeated `deadline_exceeded` on
  large files.
- **Automatic expiry of fetched files.** Evidence is kept today; a retention
  rule for private media is a separate decision. Trigger: the operator asks, or
  evidence disk pressure shows them.
- **Several messages or a whole album per call.** One message per call keeps
  the budget per call simple; an album is several calls.
- **Protected-content media.** Celestia's relay input already refuses it; this
  follows. Trigger: the operator asks for it.
- **Returning the image inline to the model.** That path belongs to lane
  1843dc92.
- **Media in private chats.** H1–H3 cover groups only.
- **An ADR.** Every choice here is reversed by a constant, a feature flag or a
  small pull request.

## Validation against the requirement

1. *One call writes the media into the caller's evidence directory and returns
   path, kind, MIME type, size and a hash; photos, documents, video:* §5.2; a
   large file repeats the identical call (§5.3), as the five-second control
   attempt requires. End to end after §6.
2. *Limits observed:* §1.1–§1.4. Within 20 MiB through the receiving bot,
   above through Celestia's TDLib up to its ceiling, beyond it an explicit
   refusal with the limit and its lift; no partial file is ever named (§5.4).
3. *Authorization equals reading; never the personal account; evidence root
   only; bounded and streamed:* §5.5, §5.4, §6.1; 2 GiB per call, two jobs at
   once.
4. *History describes media without downloading:* §5.1 with §6.2.
5. *Edited messages:* cause in §3, display in §5.1, fix requested in §6.3.
6. *Fakes only, isolated test files, checks, no identities:* §7.

## Decisions taken here without the operator

- 2 GiB per call, equal to Celestia's default TDLib ceiling, and a 2 GiB free
  space reserve.
- The default directory `<state>/evidence/relay-media` when a caller passes
  none.
- Fetched files stay like other evidence (no expiry).
- Protected content is refused, as Celestia's relay input already does.
- The shape-2 header and the `relay_owner_media` feature as the compatibility
  switches between the two releases.
