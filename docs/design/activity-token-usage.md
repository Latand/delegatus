# Activity: token usage — data design and UI variants

- Status: design. No product change in this lane; the prototype stage renders
  the variants in §9 and the operator chooses one.
- Grounded on: `main` at `c62bc941a` (2026-10-17). The files this design
  touches (`src/lib/activity/**`, `src/components/activity/**`,
  `src/app/activity/**`, `src/app/api/activity/**`) did not change between that
  commit and `origin/main` at `9745b6ec7`, and no open pull request touches them.
- Evidence: measured on this host on 2026-10-17 between 11:50Z and 12:40Z,
  over the transcript stores (`$HOME/.claude/projects`, `$HOME/.codex/sessions`
  and every account store under the state directory's `accounts/`) and over
  read-only copies (`VACUUM INTO`) of `activity/records.sqlite` and
  `team/team.sqlite`. Only counts, sizes, field names and record types were
  extracted. No transcript text, session or response id, account name, member
  id or path from those stores appears in this document. Appendix A says how
  each figure was produced.
- Prior work: `search_transcripts` ("token usage activity page cache read
  output tokens by model", "estimated cost model price per million tokens cache
  write cache read", project-scoped) found this lane's own brief, a voice-cost
  audit (`src/lib/voiceCompanion/usage.ts`) and the model analysis whose token
  rules this design keeps (`docs/design/model-analysis-2026-10.md:17`).
  `search_memory` found nothing. `docs/design/tool-call-tokens.md` §2 describes
  the same usage fields from 2026-10-01 transcripts; every claim it makes that
  this design relies on was re-measured on today's files (§1).

## Originating requirement

Source: the operator, 2026-10-17 about 11:50Z, dictated in the seat chat. The
pinned specification forbids copying, translating or excerpting the operator's
words into any published file, so they do not appear here. The pinned task
specification, written by the orchestrator, restates the requirement:

> Goal of THIS lane: a data design and 2–4 numbered UI variants the operator
> chooses from (no product build yet).
> Must cover: accumulated tokens with a project filter; breakdown by role
> (orchestrator, builder, reviewer, …); grouping by model; grouping by team
> member (who launched / whose account); a chart filterable by a custom date
> range that works well (presets + free range); input vs output, cached vs
> uncached (Claude: cache read vs cache write vs fresh input; Codex: cached
> input; reasoning tokens where reported). Answer the operator's «що ще?» with
> concrete optional extras shown in the variants […] — each clearly marked
> optional.
> Existing surface: src/app/activity/page.tsx and src/components/activity/* —
> extend it, reuse its controls (no new chrome when an existing control fits;
> status as dots with short popovers). […] Aggregation must follow the
> hot-path rules: incremental from a persisted cursor, bounded work per tick,
> first request answers from a persisted summary, no full rescans per request;
> say how roles, members, projects and models are attributed per turn and how
> double counting is avoided (Codex token_count cumulative vs per-turn;
> resumed/forked sessions; compactions).
> UI: Ukrainian copy, light and dark, desktop 1440 and phone 390.

§12 checks the design against each item.

## Decisions in one screen

| # | Decision | Why |
|---|---|---|
| 1 | Tokens are read by the activity ingest's existing pass, by the same line reader, and committed in the same transaction as the transcript cursor. | The ingest already reads every appended byte of every Claude and Codex transcript once (`src/lib/activity/ingest.ts:167`); a second reader would read the same bytes again. One transaction makes a restart resume exactly where the last commit ended. |
| 2 | The unit counted is one model response: a Claude `message.id`, a Codex `token_usage_record.response_id`. Codex `token_count` is read only for rollouts that carry no `token_usage_record`. | Measured: every Codex rollout with usage in 21 days carries `token_usage_record`, and its per-response `usage` adds up exactly to the cumulative thread total (5 618 of 5 618 rollouts). Summing `token_count.last_token_usage` overstates in 101 of 723 rollouts. |
| 3 | Counters per response: fresh input, cache read, cache write and its 1-hour share, output and its reasoning share, and the response count. | The requirement's input/output and cached/uncached split, plus the two fields cost needs, captured now because the transcripts last about a month (§1.5). |
| 4 | Project, role, pipeline and stage come from the resolution the activity turns already use; model per response; account per transcript generation; member by the launch chain (§3). Attribution is fixed when the row is committed; project aliases fold at read. | One answer to "which project, which role" across the Activity page. |
| 5 | Double counting is stopped by a Claude message-id set (92 days) and a per-thread watermark on Codex's cumulative thread total (§4). | Both copy patterns were measured: Claude copies repeat a prefix with unchanged ids and times; Codex copies repeat whole rollouts under the same thread id. |
| 6 | Four tables inside `activity/records.sqlite`: `usage_hours` (conversation grain, 92 days), `usage_days` (one row per day and attribute combination, in the settings zone, 25 months), and two dedupe tables. Bounded at about 85 MB at the highest measured rates. | Per-request reads stay at or under 33 ms per query for a one-year range (measured on a synthetic store at the upper row rate, §5.7). |
| 7 | History is backfilled once from what is on disk, with a second cursor per transcript (`usage_offset`) inside the pass's existing byte budget, newest first. | The 8 131 transcripts already under cursors hold 30.2 GB; a selective read costs 1.84 s per GB. |
| 8 | A new read, `GET /api/activity/tokens`: presets or a free `from`/`to` of up to 366 days, one stacking dimension and one listing dimension per request. | Each request runs three one-dimension queries; grouping by every dimension at once costs 81–103 ms at one year (measured) and is never done. |
| 9 | Member and account groupings are shown to the owner (or a solo host's operator), like the existing member filter; host-wide totals to everyone, like agent time today. | Same authority as `GET /api/activity` (`src/app/api/activity/route.ts:32`). |
| 10 | Optional extras are priced in §8 and spread over the variants so the operator sees each once. | The requirement asks for extras, each marked optional. |
| 11 | Four numbered variants (§9). Variant 1 is recommended. | They differ in where tokens live on the page, the range control, the chart and which extras show. |

## 1. Data sources per engine

### 1.1 Claude

Where: `$HOME/.claude/projects/<encoded cwd>/<session>.jsonl` and every Claude
account store's `projects` directory, which on a cut-over machine is one shared
store (`src/lib/accounts/claude.ts:382`).

Each API response is written as one line per content block (`thinking`,
`text`, `tool_use`). Every line repeats the response's `message.id`,
`message.model`, `requestId`, `timestamp` and the full `message.usage`.

| `message.usage` field | Meaning | Use here |
|---|---|---|
| `input_tokens` | input billed at the base rate (outside any cache) | fresh input |
| `cache_read_input_tokens` | input served from the prompt cache | cache read |
| `cache_creation_input_tokens` | input written to the cache | cache write |
| `cache_creation.ephemeral_1h_input_tokens`, `…ephemeral_5m_input_tokens` | the cache write split by lifetime | 1-hour share of cache write (priced differently, §8 E1) |
| `output_tokens` | output, thinking included | output |
| `output_tokens_details.thinking_tokens` | thinking inside output | reasoning |
| `speed`, `service_tier` | fast or standard mode, tier | tier (cost) |
| `server_tool_use`, `iterations`, `inference_geo`, `fallback_credit` | web search/fetch counts, per-iteration usage, region, credit | not stored (Deferred) |

Measured over 7 days to 2026-10-17 12:00Z (990 transcripts, 6.05 GB):

- 144 962 assistant lines with usage; 70 235 responses counted per file;
  74 727 lines repeat a response already seen in the same file, and none of
  them carries different usage.
- 1 025 response ids appear in more than one transcript. The 13 transcripts
  involved all share a contiguous run of responses starting at their first
  response, with the same timestamps. One pair shares 227 responses and then
  continues with 88 and 9 responses of its own: a fork whose branches both
  went on.
- Models seen: `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-fable-5-1`,
  `claude-opus-4-8`, `claude-haiku-5-5`, and `<synthetic>` (38 lines, the
  CLI's own placeholder, which the feed parser already leaves out at
  `src/components/feed/parse.ts:3557`).
- Thinking is a part of output: `thinking_tokens ≤ output_tokens` in all
  6 612 responses of a 2-day sample, where it was 37 % of output.
- `iterations` has one element in every response; the top-level counters are
  the response's usage.
- No sidechain line (`isSidechain: true`) and no subagent transcript
  (`…/subagents/…`) in the 7 days.
- Compaction: 4 in 7 days. The `system` record `compact_boundary` carries
  `compactMetadata.preTokens` and `postTokens`; the request that wrote the
  summary leaves no assistant record with usage. Its tokens cannot be counted
  from the transcript (§4 rule 7).

### 1.2 Codex

Where: `$HOME/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` and every Codex
account's `sessions` directory (`src/lib/accounts/codex.ts:514`).

| Record | Fields used | Notes |
|---|---|---|
| `token_usage_record` (top-level type) | `payload.response_id`, `thread_id`, `turn_id`, `usage{…}`, `thread_token_usage{…}`, `timestamp` | one per model response; `usage` is that response; `thread_token_usage` is cumulative for the thread |
| `event_msg` / `token_count` | `info.total_token_usage`, `info.last_token_usage` | cumulative and last-request counters; fallback only (§4 rule 4) |
| `turn_context` | `payload.model`, `effort`, `turn_id` | one per turn; the model for the turn's responses |
| `session_meta` | `id`, `forked_from_id`, `source` (`{subagent: {thread_spawn…}}` for a subagent), `cli_version` | also carries provider-side creator identity fields, which are never read or stored |

Each counter set is `{input_tokens, cached_input_tokens,
cache_write_input_tokens, output_tokens, reasoning_output_tokens,
total_tokens}`. `input_tokens` contains `cached_input_tokens`;
`output_tokens` contains `reasoning_output_tokens`; `total_tokens =
input_tokens + output_tokens`.

Measured over 21 days to 2026-10-17 (all Codex stores):

- 5 618 rollouts carry usage, and every one of them carries
  `token_usage_record` (CLI versions 0.156.1 to 0.162.1). 348 449 distinct
  response ids. 89 of them appear in more than one rollout, all inside three
  rollouts copied whole from one account store to another.
- In 5 618 of 5 618 rollouts, the last record's `thread_token_usage.total`
  equals the first record's thread total minus its own usage, plus the sum of
  `usage.total` over the rollout. So per-response usage is complete, and a
  rollout can start from a non-zero thread total.
- A fork (`session_meta.forked_from_id`) starts from its parent's cumulative
  total: in one fork the first record's thread total is 2 113 745 while its
  own usage is 126 540.
- 815 rollouts are subagent threads. In 60 of 60 checked, `thread_id` is the
  subagent's own id and `session_id` is the parent's. The identity above holds
  per rollout, so a subagent's usage is absent from its parent's thread total.
- `cache_write_input_tokens` is 0 in every record seen.
- On 2026-10-16: 25 674 usage records and 373 `turn_context` lines.

Measured over 2 days (723 rollouts, 2.1 GB), on `token_count`:

- 52 407 events. In every one, `cached ≤ input`, `reasoning ≤ output` and
  `total = input + output`.
- 169 events repeat the previous cumulative total; none decreases, including
  across the 59 compactions in the same rollouts.
- Summing `last_token_usage` gives more than the final cumulative total in 101
  of 723 rollouts (the repeats).

### 1.3 Copilot and OpenClaw

Neither scanner reads a usage field (`src/lib/scanner/copilotNative.ts`,
`src/lib/scanner/openclawNative.ts`), the ingest skips both engines
(`src/lib/activity/ingest.ts:185`), and this host has no session of either.
The page names them as engines whose tokens are not read (§6.2 `coverage`).
Reading them is deferred.

### 1.4 Today's readers of these fields

| Where | Reads | Why it does not serve this page as is |
|---|---|---|
| `src/lib/activity/transcriptExport.ts:212-260` (`acceptBytes`, `accept`) | every Claude line is parsed whole when turns are kept; a Codex line is classified from its first 300 bytes (`CODEX_PREFIX`, `:174`) and parsed only for `session_meta`, an early `turn_context` and user messages | the reader the ingest uses; it reads no usage today. This design extends it. |
| `src/lib/activity/ingest.ts:167-288` | the pass: per transcript from its cursor, pieces of 32 MiB (`:78`), at most 1 GiB per pass (`:83`), commit per piece (`:242`) | the write path this design extends |
| `src/lib/scanner/context.ts:43-56` (`codexCtx`), `:58-70` (`claudeCtx`) | the newest usage record of a transcript tail, for the context meter | one record per transcript, no history |
| `src/components/feed/parse.ts:3347-3351` (Codex `token_count`), `:3556-3566` (Claude per `message.id`), `:3467` (hides `token_usage_record`) | per-response usage for the conversation view's ledger | browser-side, per open conversation |
| `src/lib/orchestrator/health.ts:211-222` | last usage for a seat's context figure | one record; see "Found while reading" |
| `scripts/harness-ledger.ts:186-224` (`transcriptTokens`) | Claude once per `message.id`; Codex the last cumulative `total_token_usage` | an offline analysis over whole files |

### 1.5 How long the source lives

On this host the oldest Claude transcript on disk is from September (25
files; 2 128 from October) and every Codex rollout is from October. Whatever
removes them, the source holds about one month. A field the ingest does not
store when it reads a response is lost for good once the transcript goes.
That is why §2 keeps the 1-hour cache share and the tier now, and why the
aggregates outlive their transcripts: `forgetFile`
(`src/lib/activity/store.ts:357`) drops a cursor and never a token row.

## 2. Token kinds

| Kind (API name) | Ukrainian label | Claude | Codex |
|---|---|---|---|
| `input` | Нові вхідні | `input_tokens` | `input_tokens − cached_input_tokens − cache_write_input_tokens` |
| `cacheRead` | Читання з кешу | `cache_read_input_tokens` | `cached_input_tokens` |
| `cacheWrite` | Запис у кеш | `cache_creation_input_tokens` | `cache_write_input_tokens` (0 so far) |
| `cacheWrite1h` | (part of Запис у кеш) | `cache_creation.ephemeral_1h_input_tokens` | 0 |
| `output` | Вихідні | `output_tokens` | `output_tokens` |
| `reasoning` | з них міркування | `output_tokens_details.thinking_tokens` | `reasoning_output_tokens` |
| `requests` | Запити | 1 per `message.id` | 1 per `response_id` |

Total = `input + cacheRead + cacheWrite + output`. `cacheWrite1h` and
`reasoning` are parts of other kinds and are never added. The Codex cache-write
subtraction follows the same reading as `src/lib/voiceCompanion/usage.ts:31-33`
(cached and written input are both inside input); every record seen has 0
there, so the reading changes no number today. A negative result clamps to 0
and is counted as a malformed record.

Cache reads dominate: 97.9 % of recorded input in the model analysis
(`docs/design/model-analysis-2026-10.md:56`). Every variant therefore prints
each kind as a number; a bar alone would show output as a sliver.

## 3. Attribution model

### 3.1 Per response

Every counted response carries these attributes. All but the model and the
account are per conversation and come from the resolution the ingest already
builds for agent turns (`src/lib/activity/ingest.ts:232-239`,
`src/lib/activity/conversationResolver.ts:24-117`).

| Attribute | Source | Rule | When unknown |
|---|---|---|---|
| time | the record's `timestamp` | the response's own time; buckets are UTC hours | the record is skipped and counted as malformed |
| conversation | `turnOwnerConversation` (`ingest.ts:151`) | the registry conversation, else `session:<file name>`; a Codex subagent thread and a Claude subagent transcript take their own key beside the parent's | — |
| project | `resolveProjectAttribution` via the resolver (`conversationResolver.ts:43-53`) | stored raw; aliases fold at read through `canonicalProject`, as the activity report does (`src/lib/activity/report.ts:2`) | `null`, shown as «Без проєкту» |
| role | `conversationAgentRole` (`conversationResolver.ts:112`) | the registry role (`orchestrator`, `builder`, `reviewer`, …) | `none` (registered, no role), `unregistered` (not launched by Delegatus) — the existing labels «без ролі», «немає в реєстрі» |
| pipeline, stage | the newest pipeline membership (`conversationResolver.ts:55-57`) | stored; tasks and pull requests join at read through the pipeline record (`taskIds`, `src/lib/pipelines/types.ts:1015`) | `null` |
| engine | the transcript | `claude` or `codex` | — |
| model | Claude `message.model`; Codex the latest `turn_context.model` before the record (kept in the reader's state across pieces) | raw id; display labels at read | the generation's `launchProfile.model`, else `unknown` |
| tier | Claude `usage.speed`; Codex the generation's `launchProfile.serviceTier` | `standard`, `fast`, `priority`, … | `standard` |
| account | §3.3 | provider account id | `unknown`, shown as «Акаунт не визначено» |
| member | §3.2 | team member id, `operator` on a solo host | `unattributed`, shown as «Не визначено» |

A Codex subagent thread keeps its parent's project, role, pipeline, stage and
member (the resolver names the parent's conversation for its rollout), so a
lane's tokens include its subagents.

An unregistered Delegatus transcript is held until the registry names it, as
it is today (`ingest.ts:221-225`, 15 minutes); its usage is committed with the
same piece, so it waits too. Attribution is fixed at commit. A conversation
the registry names later than that keeps the attribution its earlier rows were
committed with; only project aliases move at read.

### 3.2 Member: who launched it

The requirement names two readings of "user": who launched the work, and whose
account paid for it. Both become groupings: member here, account in §3.3.

What the records hold today (team store copy, 2026-10-17): 3 members (one
owner); 1 219 `agent.started` events from 2026-10-01 to 2026-10-17, of which 11
name a member and 1 208 a service (pipelines and seats start their agents
through the Viewer); 1 066 authored messages over 79 conversations. A launch
chain is therefore needed to reach a person for almost every agent.

The member of a conversation is the first of:

1. the member named by its `agent.started` event
   (`src/lib/agent/spawnCommand.ts:1127-1133`; read the way
   `subjectAuthorship` reads it, `src/lib/team/index.ts:99-128`);
2. the member who authored its spawn message (`spawn_<launchId>` in the
   message authors, recorded at `spawnCommand.ts:1125`);
3. the member of its spawn parent (registry lineage edge, `src/lib/agent/registry.ts:374-391`, or `launcher`);
4. for a pipeline stage, the member of the pipeline's creator conversation
   (`srcConversationId`, passed as `creatorConversationId` at
   `src/lib/pipelines/engine.ts:7212`), else the member who created one of its
   tasks (`task.created`);
5. for a conversation members write to (a seat, a chat), the member who
   authored most of its messages so far;
6. `operator` on a solo host; `unattributed` on a team host.

At most 8 steps; resolved once per conversation per pass and cached in the
pass's map. Step 5 changes as messages arrive: rows committed before a
member's first message keep `unattributed`. The coverage popover says members
are attributed by launch chain («за ланцюжком запуску»). Splitting a shared
seat's turns by the author of each turn's opening message is deferred.

### 3.3 Account: whose subscription

1. The registry generation of the conversation whose `path` (or continuity
   path) is this transcript and whose `createdAt` is the latest at or before
   the response's time: its `accountId`
   (`src/lib/accounts/migration/contracts.ts:174-183`).
2. Else the store the file lives in: `codexHomeOwningSessionPath`
   (`src/lib/accounts/codex.ts:518`) for Codex; `claudeTranscriptOwnership`
   (`src/lib/accounts/claude.ts:412`) for Claude when its answer has source
   `path` or `recorded`.
3. Else `unknown`. The shared-store answer (`source: "shared-store"`, the
   account new spawns route to) is a guess and is never stored as an account.

## 4. Double counting

1. **One Claude response, several lines.** Lines with the same `message.id`
   in one piece fold into one response, each counter taking its maximum (the
   rule of `model-analysis-2026-10.md:17`; measured identical anyway).
2. **Claude copies across transcripts.** A continued or migrated conversation
   copies a prefix of responses with unchanged ids and times into a new
   transcript, and both branches of a fork can go on (§1.1). A per-conversation
   time watermark would drop the second branch's own responses, so the store
   keeps the set of counted Claude response ids (`usage_claude_seen`). A
   response whose id is in the set adds nothing. Read order does not matter.
3. **One Codex response, copies across stores.** A thread's cumulative total
   only rises (0 decreases in 52 407 events), and a copy repeats the same
   sequence under the same `thread_id`. The store keeps, per thread, the
   highest `thread_token_usage.total_tokens` already counted
   (`usage_codex_threads`). A record at or under it adds nothing; a record
   above it adds its own `usage` and raises the watermark. In 21 days every
   duplicated response (89) sat in a rollout copied whole, so a watermark is
   exact there. If two copies of one thread were both continued, the second
   branch would be under-counted. A copy's skipped records are dated no later
   than the record that set the watermark, and a second branch's are dated
   later, so the build counts skipped records dated later than the watermark's
   own (`branch_skipped`) and the coverage popover reports any.
4. **Codex cumulative counters.** `token_count` is never summed. A rollout
   without `token_usage_record` (CLIs before 0.156; the pinned protocol window
   starts at 0.154.0, `src/lib/accounts/codexPinnedProtocol.ts:16`) is counted
   from `total_token_usage` deltas per kind against the same thread watermark.
   The first event's baseline is its total minus its `last_token_usage`, which
   is 0 for a new thread and the parent's total for a fork. A repeated total
   adds nothing. A rollout that starts writing records mid-thread switches to
   them; both paths raise the same watermark.
5. **Forks.** A Codex fork's records carry its parent's total in
   `thread_token_usage`; only `usage` is ever added, so the parent's part is
   never counted again. A Claude fork is rule 2.
6. **Subagents.** A Codex subagent thread has its own `thread_id` and its usage
   is absent from the parent's total (§1.2): counted once, under its own
   conversation key. A Claude subagent transcript has its own response ids.
7. **Compactions.** Codex compactions do not reset or repeat the cumulative
   total (59 compactions, 0 decreases); nothing special happens. A Claude
   compaction's summarising request is absent from the transcript: those
   tokens are not counted, and the coverage lists «стиснення контексту Claude»
   as unrecorded. The count of compactions is not stored (Deferred).
8. **A rewritten transcript** (shorter than its cursor) is read again from the
   start, as today (`ingest.ts:198-200`); rules 2 and 3 make the second read
   add nothing.
9. **Records older than the dedupe horizon.** Rules 2 and 3 remember 92 days.
   A response whose time is more than 92 days old when it is first read is
   skipped and counted in `coverage.skippedOld`. With about one month of
   transcripts on disk (§1.5), the backfill has none.
10. **Remote hosts.** Token rows are this host's only (`host = ''`). Linked
   installs do not send them (Deferred), so nothing arrives twice.

## 5. Aggregation store

### 5.1 Tables

The tables live in `activity/records.sqlite`, beside the activity tables, so a
piece's token rows, its dedupe marks and its cursor commit in one transaction
(`ActivityStore.commitFile`, `src/lib/activity/store.ts:366`).

```sql
-- One row per UTC hour, conversation, model, tier and account.
CREATE TABLE usage_hours (
  host TEXT NOT NULL, hour INTEGER NOT NULL,            -- epoch hour
  conversation TEXT NOT NULL,                            -- conversationDigest() of the owner key
  model TEXT NOT NULL, tier TEXT NOT NULL, account TEXT NOT NULL,
  engine TEXT NOT NULL, project TEXT, role TEXT NOT NULL, member TEXT NOT NULL,
  pipeline TEXT, stage TEXT,
  requests INTEGER NOT NULL, input INTEGER NOT NULL, cache_read INTEGER NOT NULL,
  cache_write INTEGER NOT NULL, cache_write_1h INTEGER NOT NULL,
  output INTEGER NOT NULL, reasoning INTEGER NOT NULL,
  PRIMARY KEY (host, hour, conversation, model, tier, account)
) WITHOUT ROWID;

-- One row per local day and attribute combination, in usage_meta.zone.
CREATE TABLE usage_days (
  host TEXT NOT NULL, zone TEXT NOT NULL, day TEXT NOT NULL,    -- 'YYYY-MM-DD'
  project TEXT NOT NULL, role TEXT NOT NULL, model TEXT NOT NULL, tier TEXT NOT NULL,
  account TEXT NOT NULL, member TEXT NOT NULL, engine TEXT NOT NULL,
  requests INTEGER NOT NULL, input INTEGER NOT NULL, cache_read INTEGER NOT NULL,
  cache_write INTEGER NOT NULL, cache_write_1h INTEGER NOT NULL,
  output INTEGER NOT NULL, reasoning INTEGER NOT NULL,
  PRIMARY KEY (host, zone, day, project, role, model, tier, account, member, engine)
) WITHOUT ROWID;                                                 -- project '' = none

CREATE TABLE usage_claude_seen (k INTEGER PRIMARY KEY, at INTEGER NOT NULL); -- 64-bit hash of message.id
CREATE TABLE usage_codex_threads (
  thread TEXT PRIMARY KEY, total INTEGER NOT NULL, at INTEGER NOT NULL,
  input INTEGER NOT NULL, cached INTEGER NOT NULL, cache_write INTEGER NOT NULL,
  output INTEGER NOT NULL, reasoning INTEGER NOT NULL           -- the watermark's counters, for rule 4 deltas
) WITHOUT ROWID;
CREATE TABLE usage_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema INTEGER NOT NULL, version INTEGER NOT NULL, zone TEXT NOT NULL,
  zone_since TEXT, counted_from INTEGER, skipped_old INTEGER NOT NULL DEFAULT 0,
  malformed INTEGER NOT NULL DEFAULT 0, branch_skipped INTEGER NOT NULL DEFAULT 0
);
-- And two columns on the existing cursor table:
ALTER TABLE activity_files ADD COLUMN usage_offset INTEGER NOT NULL DEFAULT 0;
ALTER TABLE activity_files ADD COLUMN usage_facts TEXT;      -- reader state at usage_offset
```

`usage_days` is maintained by the same deltas as `usage_hours`, in the same
transaction: it is a sum the reader never has to compute. `usage_meta.version`
rises once per commit that wrote token rows; the read cache keys on it (§6.4).
A hash collision in `usage_claude_seen` (64 bits over about a million ids)
would drop one response; the probability is about 2·10⁻⁸.

### 5.2 Bounds and retention

| Table | Rows per day (measured basis) | Retention | Upper bound |
|---|---|---|---|
| `usage_hours` | 270–1 127 (hour, conversation, model) keys per day over 2026-10-11..17; the activity turns' busiest day had 1 677 conversation-hours (2026-10-02). Bound: 2 000. | 92 days | 184 000 rows, about 25 MB |
| `usage_days` | 3–59 (project, role, engine) combinations per day over 21 days; with model, tier, account and member spread, at most 200 | 25 months (760 days) | 152 000 rows; 26.2 MB measured at that size |
| `usage_claude_seen` | 69 080 Claude responses in 7 days, about 9 900 a day | 92 days | 0.91 million rows, about 18 MB |
| `usage_codex_threads` | 5 618 threads in 21 days, about 270 a day | 92 days after the thread's last record | 25 000 rows |

The four together stay under about 85 MB at those rates (the activity store is
14.7 MB today). Retention is enforced by the ingest once per day, at most
10 000 rows per table per pass, so pruning never makes a long pass. 92 days
holds a 35-day range and the 35 days before it with room to spare, and serves
every per-conversation extra (§8). 25 months holds a one-year range and the
year before it.

### 5.3 Write path

Inside `ingestTranscripts`, per piece, nothing beyond what the piece read:

1. The reader collects usage records while it reads the piece: Claude from
   lines it already parses; Codex from `token_usage_record` and `turn_context`
   lines, which join the lines `acceptBytes` parses whole (`token_count` too
   while a rollout has shown no record). Its state, stored with the cursor,
   gains the Codex current model and thread id.
2. With the piece's resolution (the same `owner` the turns get,
   `ingest.ts:232-239`) plus account and member, records become attributed
   responses.
3. In `commitFile`'s transaction: each response passes rule 2 or 3; survivors
   are folded in memory by hour key and by day key, then upserted
   (`… ON CONFLICT DO UPDATE SET input = input + excluded.input, …`); the
   cursor's `offset` and `usage_offset` advance together; `usage_meta.version`
   rises.

A piece of 32 MiB folds into at most a few dozen hour keys. The extra parse
cost was measured on a full day of Codex rollouts (§5.7): 40–65 ms per day.

### 5.4 Backfill and cursors

The 8 131 transcripts already under cursors have `offset` at their end and,
after the migration, `usage_offset = 0`. For a transcript whose
`usage_offset < offset`, the pass first reads `[usage_offset, offset)` with
the reader in usage-only mode (no inputs, no turns), from `usage_facts`, and
commits the token rows with the advanced `usage_offset`. Once
`usage_offset = offset`, the normal read produces both. Rules:

- The skip test (`ingest.ts:193`) also requires `usage_offset = offset`.
- Usage-only bytes count against the pass's existing budget
  (`INGEST_PASS_BUDGET_BYTES`, 1 GiB), and transcripts go newest first, so the
  recent days fill first. A pass that stops at the budget resumes inside the
  piece, as the ingest does today.
- The usage-only read runs under its own loop-monitor operation,
  `activity.usage-backfill` (the operation union is
  `src/lib/viewerLoopMonitor.ts:7-15`).
- Cost: 30.2 GB at 1.84 s per GB is about 56 s of CPU in total, read in 1 MiB
  chunks with an await between chunks, at most 1 GiB per pass. The Viewer's
  loop-gap records named `activity.ingest` as in flight 20 times in the six
  hours before 12:25Z (140–3 322 ms), so the build measures loop gaps during
  the backfill on a scratch copy and lowers the backfill's share of the budget
  if any gap names it.
- Before the backfill finishes, the answer carries `coverage.complete: false`
  and `countedFrom` (the oldest counted response).

### 5.5 Day boundaries and zone changes

Days are local days in the zone the activity settings name (Europe/Kyiv unless
changed), with real 23- and 25-hour days (`zonedDays`,
`src/lib/activity/method.ts:370`). Hour buckets are UTC hours, exact for every
whole-hour offset. A zone with a fractional offset gets day edges rounded to
the hour, and the drawer says so.

`usage_meta.zone` is the zone `usage_days` was written in. When the settings
zone changes, the ingest rebuilds `usage_days` for the dates `usage_hours` still
holds, 10 000 hour rows per pass, and sets `zone_since` to the first rebuilt
date. Older day rows keep their zone. A range that reaches them is answered
with `coverage.daysZone: { zone, before }`, and the popover says those days
end at midnight in the earlier zone.

### 5.6 Migration and mixed releases

- The existing tables keep `SCHEMA_VERSION = 3` (`store.ts:40`); the token
  tables carry their own `usage_meta.schema`. A reader that finds no
  `usage_meta` reports "nothing recorded yet". Bumping `SCHEMA_VERSION` would
  make `openReadOnly` (`store.ts:301`) answer null to the activity page until
  the first pass migrated the file, and `pull.test.ts:211` asserts the value 3.
- During a release succession an older Viewer can still run the ingest. Its
  cursor upsert names only the columns it knows, so it leaves `usage_offset`
  where it was, and a row it inserts gets the default 0. Either way the newer
  release later finds `usage_offset < offset` and backfills those bytes (§5.4).
  Nothing is lost and nothing doubles.

### 5.7 Measured costs

Extraction (Appendix A): a selective read of 13.51 GB (3 597 transcripts, 7
days) took 24.9 s in one Bun process, 1.84 s per GB. The marginal parse for
one day of Codex (2026-10-16, all stores: 25 674 usage records and 373
`turn_context` lines, 23.2 MB) took 40–65 ms over three runs.

Reads, on a synthetic store in Bun SQLite with WAL, 7 runs each (median / max, ms):

| Query on `usage_days` at 200 rows per day (150 671 rows) | 30 d | 92 d | 183 d | 366 d | 731 d |
|---|---|---|---|---|---|
| totals by kind | 1.3 / 2.0 | 3.2 / 3.6 | 6.1 / 8.6 | 11.1 / 11.8 | 23.8 / 26.1 |
| series by day | 1.1 / 1.2 | 3.3 / 3.7 | 9.2 / 9.6 | 12.3 / 12.9 | 24.8 / 26.9 |
| one breakdown (by model) | 1.9 / 2.2 | 6.7 / 7.3 | 19.1 / 21.1 | 30.3 / 33.1 | 61.7 / 69.3 |
| every dimension at once | 9.0 / 9.5 | 24.0 / 26.5 | 46.1 / 66.9 | 80.8 / 103.2 | 235.9 / 240.3 |
| series for one project | 0.3 / 0.5 | 2.0 / 2.8 | 3.8 / 4.4 | 8.2 / 9.1 | 16.2 / 20.3 |

| Query on a conversation-grain table at 1 000 rows per day (399 376 rows) | 1 d | 7 d | 30 d | 90 d | 400 d |
|---|---|---|---|---|---|
| totals | 0.1 | 0.7 | 3.7 | 12.8 / 19.1 | 60.6 / 75.6 |
| series by day and model | 0.3 / 0.4 | 2.3 / 2.5 | 11.7 / 13.1 | 43.0 / 56.5 | 219.6 / 285.2 |

What follows from these: ranges are capped at 366 days; every request groups
by one dimension at a time; `usage_hours` serves only ranges of up to 2 days
(hourly chart) and the per-conversation extras; everything else reads
`usage_days`.

## 6. API

### 6.1 Request

`GET /api/activity/tokens`, same-origin like `/api/activity`
(`src/app/api/activity/route.ts:24`), `Cache-Control: no-store`.

| Parameter | Values | Default, clamps |
|---|---|---|
| `range` | `today`, `7d`, `30d`, `90d`, `365d` | `7d` when neither a preset nor `from`/`to` is given |
| `from`, `to` | `YYYY-MM-DD` in `tz` | `to` after today becomes today; `from` after `to` swaps them; a span over 366 days moves `from` to `to − 365` |
| `tz` | IANA zone | the activity settings' zone |
| `project` | project key | aliases fold to the canonical key |
| `member` | absent, a member id, `all` | absent = every member (host-wide, as agent time is) |
| `stack` | `kind`, `model`, `role`, `project`, `member`, `account`, `engine` | `kind` |
| `list` | same minus `kind` | `model` |
| `role`, `model`, `account`, `engine` | one value each | filters from a clicked row |
| `compare` | `previous` | absent (extra E6) |

Bucket: an hour for spans of up to 2 days, a day up to 92 days, an ISO week
(Monday) beyond.

### 6.2 Response

```ts
interface TokenCounts {
  input: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number;
  output: number; reasoning: number; requests: number;
}

interface ActivityTokensResponse {
  generatedAt: number;
  params: {
    from: string; to: string; preset: "today" | "7d" | "30d" | "90d" | "365d" | null;
    tz: string; bucket: "hour" | "day" | "week";
    stack: TokenDimension; list: Exclude<TokenDimension, "kind">;
    filters: Partial<Record<"role" | "model" | "account" | "engine", string>>;
  };
  scope: { project: string; name: string | null } | null;
  member: {
    selection: "all" | "member"; memberId: string | null; canChoose: boolean;
    /** Roster names, colours and initials; empty unless canChoose. No email or handle. */
    members: Array<{ id: string; name: string | null; color: string | null; initials: string | null; self: boolean }>;
  };
  coverage: {
    countedFrom: number | null;     // the oldest counted response
    complete: boolean;              // every transcript read to its end, backfill included
    pendingBytes: number;           // still to read: backfill and deferred bytes
    skippedOld: number;             // §4 rule 9
    branchSkipped: number;          // §4 rule 3, later-dated records under a watermark
    engines: Array<{ engine: "claude" | "codex" | "copilot" | "openclaw"; read: boolean }>;
    unrecorded: Array<"claude-compaction">;
    memberRule: "launch-chain";
    daysZone?: { zone: string; before: string };
  };
  totals: TokenCounts;
  /** One entry per bucket; `counted: false` before countedFrom. With stack=kind, one part keyed "all". */
  series: Array<{ start: number; end: number; counted: boolean; parts: Array<{ key: string; counts: TokenCounts }> }>;
  /** Top 12 by total, then one row keyed "other". */
  list: Array<{ key: string; name: string | null; counts: TokenCounts }>;
  previous?: { from: string; to: string; totals: TokenCounts };
}
```

Names: project names as the activity report names them; member names from the
roster; account labels from the accounts store. Roles and models are labelled
by the client (existing role strings; model labels from the model helpers).
The answer holds counts, times, enums, project keys and names, member ids and
roster names, account ids and labels, and model ids. It holds no path, title,
message text or email, the same promise `/api/activity` makes
(`route.ts:18-21`).

### 6.3 Who may see what

- Whoever can open the page sees host-wide totals, every kind, and the `model`,
  `role`, `project` and `engine` dimensions, as they see agent time today.
- `member=<id>`, `member=all`, and the `member` and `account` dimensions need
  `canChoose`: the owner, or a solo host's operator (`route.ts:32`).
  Anyone else naming them gets `403 activity_member_forbidden`, the existing
  code (`src/lib/activity/report.ts:135`).
- The server enforces this in the route; the client hides the controls only
  as a courtesy.

### 6.4 Read path and budgets

1. Parse and clamp; resolve the range to dates in `tz`.
2. Open the store read-only (`ActivityStore.openReadOnly`); no store or no
   `usage_meta` gives an empty answer with `countedFrom: null`.
3. Read `usage_meta.version`. If the shared answer cache holds this query at
   this version and this local date, return it.
4. Run three queries: totals (`usage_days`), series (`usage_hours` for ≤ 2
   days, else `usage_days`, weeks folded in SQL), list (`usage_days` grouped by
   the list dimension). `compare=previous` adds one totals query.
5. Name, cache, answer.

Budgets, from §5.7: each query at most 33 ms at 366 days and at most 7.3 ms at
92 days; the answer at most 4 queries. No request reads a transcript, waits for
the ingest or groups by more than one dimension. The answer is at most 53 week
or 92 day buckets × 13 parts, about 60 KB.

The cache is one instance on `globalThis` (compiled bundles duplicate module
state), owned by the tokens report, 16 entries, least recently used evicted.
The page polls every 60 s (`REFRESH_MS`,
`src/components/activity/ActivityDashboard.tsx:34`); a poll after a commit
recomputes, other polls hit the cache. The route runs under
`withViewerOperation("activity.tokens.read")`.

## 7. Hot-path checklist

| Rule | How this design meets it |
|---|---|
| incremental from a persisted cursor | the existing per-transcript cursor plus `usage_offset`; only appended bytes are read |
| bounded work per tick | the pass's byte budget (1 GiB, shared with the backfill), pieces of 32 MiB, retention deletes ≤ 10 000 rows per table per pass, zone rebuild ≤ 10 000 hour rows per pass |
| first request from a persisted summary | `usage_days` and `usage_hours` are the persisted summary; the request path reads only them |
| no full rescans per request | a request runs at most 4 indexed range queries |
| no synchronous wait on the main loop | writes ride the ingest's existing transaction (no new lock site); reads use the existing read-only WAL handle |
| caches bounded, one owner | the answer cache, 16 entries, LRU, on `globalThis` |
| labelled slow work | `activity.ingest` (existing), `activity.usage-backfill`, `activity.tokens.read` |
| before/after measurement | slice 1 measures the ingest pass on a `VACUUM INTO` copy of this host's store and a scratch copy of a day of transcripts, before and after; slice 2 measures the route at 7, 30, 92 and 366 days on a copy filled by the backfill |

## 8. Optional extras and their cost

Each extra is optional and labelled «Додатково» wherever a variant shows it.
Sizes: XS under half a day, S about a day, M two to three days, L a week.

| # | Extra (Ukrainian label) | What it shows | Data and build | Cost |
|---|---|---|---|---|
| E1 | Оцінка вартості за цінами API | an API-equivalent price per model and kind, «≈ $…» | a dated price table per model, kind (fresh, cache read, 5-minute and 1-hour cache write, output) and tier, kept by hand from the providers' published price pages; the store already keeps every needed split. Models with no published API price show «—». Work on a subscription is billed per plan, so the figure is a comparison and is never called spending. `src/lib/roles/costHints.ts:2` notes the Viewer holds no prices today. | S to build, recurring upkeep |
| E2 | Частка кешу | cache reads as a share of all input: `cacheRead / (input + cacheRead + cacheWrite)` | derived from the answer | XS |
| E3 | Ліміти акаунтів | per account, tokens beside its 5-hour and weekly window usage | joins `limitsHistoryStore` samples; that store keeps 8 days (`src/lib/limitsHistoryStore.ts:15`), so a longer range needs a daily peak per window kept for 25 months | M |
| E4 | За задачами, лейнами й PR | tokens per task, lane and merged pull request | `usage_hours.pipeline` joined to the pipeline record (`taskIds`, delivery PR) at read; within 92 days | M |
| E5 | Найбільші розмови | the 10 conversations with the most tokens, with titles, linking to the conversation | `usage_hours` grouped by conversation; titles through the registry (digest to id map, cached); owner only | S |
| E6 | Порівняно з попереднім періодом | change against the previous range of the same length | one more totals query (`compare=previous`) | XS |
| E7 | Частка міркувань | reasoning as a share of output | derived | XS |
| E8 | Токени на годину роботи агентів | tokens per hour of agent time, per role or model | joins agent time from the existing `/api/activity` answer for the same range | S |
| E9 | Стиснення контексту | how often contexts were compacted and how large they were | stores Claude `compact_boundary` and Codex `compacted` counts per hour; history begins when it ships | S |
| E10 | CSV | the current view as a file | client-side from the answer | S |

## 9. UI variants brief

### 9.1 Common to every variant

- The page is `/activity`; tokens are counted host-wide. Copy in Ukrainian;
  light and dark through the app's tokens; desktop 1440 and phone 390.
- Reused controls: the range switch (`ActivityDesktop.tsx:101`, `Segmented` at
  `ActivityDashboard.tsx:135`), `ActivityProjectPicker`,
  `ActivityMemberFilter` (owner), `ActivityScopeChip` for every active filter,
  the counting drawer (gains a tokens section), `MarkPatterns` (texture means
  "not read": days before `countedFrom`).
- Range presets: «Сьогодні · 7 днів · 30 днів · 90 днів · Період…». «Період…»
  opens a popover with two native date inputs, «Від» and «До», the platform
  control the task forms already use (`datetime-local` at
  `src/components/kanban/TaskHoldEditor.tsx:24`), and the hint «Не більше
  року». The range applies as soon as both dates are valid; the chart dims
  while the answer loads, as the page does today. The segment then reads the
  dates («1–16 жовт.»).
- Coverage is a dot beside the main figure with a short popover: green when
  everything is read; amber with «≥» on the figure when it is a lower bound.
  Popover lines: «Пораховано з 1 жовтня.», «Ще читаються транскрипти: 2,1 ГБ.»,
  «Учасників визначено за ланцюжком запуску.», «Стиснення контексту Claude не
  враховано.» No text pill.
- Numbers: compact Ukrainian («1,8 млрд», «512 млн», «36 тис.»), exact values
  in tooltips. Every kind is printed as a number (§2).
- Colour: four kind colours that read in both themes; warning amber stays
  reserved for trust, as on the rest of the page
  (`docs/design/activity-dashboard-v2.md`). Models and other dimensions take a
  categorical palette; the prototype stage loads the data-visualisation skill.
- Each frame prints its variant as «Варіант N з 4».
- The URL keeps the state: `?view=tokens&range=…&from=…&to=…&stack=…&list=…&project=…&member=…`.

### 9.2 Варіант 1 з 4 — окрема вкладка, одна цифра й один графік (recommended)

- Where: a «Час | Токени» switch beside the title; «Час» is today's page,
  unchanged. The custom range belongs to «Токени» only.
- Desktop: the left card holds the figure «1,8 млрд токенів» with its
  coverage dot, one meter in four labelled parts (Нові вхідні, Читання з кешу,
  Запис у кеш, Вихідні «з них міркування 37 %»), then a stacked column chart
  per bucket. The right column (420 px, where Projects sits today) holds
  «Розбити за: Модель · Роль · Проєкт · Учасник · Акаунт» and a ranked list:
  name, total, a thin four-kind bar, share. The list's choice also stacks the
  chart; «Тип» stacks by kind. A row click filters the page and shows a chip.
- Phone: «Токени» joins the phone's existing view switch («Дні · Проєкти ·
  Токени», `Segmented` at `ActivityDashboard.tsx:135`); the range control and
  the filters stack at full width; the figure and meter; the chart (weeks above
  31 days); «Розбити за» as a scrollable segmented row; the list.
- Extras shown: E2 (as «Кеш: 96 % вхідних» under the figure), E6 («+12 % до
  попередніх 7 днів»), E7.
- Build beyond the core: XS.
- Why recommended: the smallest build that answers every item of the
  requirement on one screen; the accepted «Час» presentation stays as it is;
  the only new piece of chrome is the date popover, and the switches reuse
  `Segmented`.

### 9.3 Варіант 2 з 4 — токени всередині сторінки «Активність»

- Where: no new view. One range control serves the whole page and gains
  «Період…», so your time and agent time also take a free range.
- Desktop: a third figure «Токени» beside «Ви» and «Агенти»; a thin row of
  token columns under the day chart, on the same day axis; the Projects list
  gains a «Токени» column, and an opened project row shows its split by role
  and by model. Grouping by model across projects lives in the drawer.
- Phone: a «Токени» tile beside the existing tiles; the token row under the
  day list; the tokens column in project rows.
- Extras shown: E1 («≈ $…» under the tokens figure and per project).
- Build beyond the core: M. The activity method takes only `today | 7d | 30d`
  (`src/lib/activity/method.ts:68`); a free range for human and agent time
  means `from`/`to` through `rangeDays` and the report, and a cost check of the
  method at 366 days, which nobody has measured.

### 9.4 Варіант 3 з 4 — таблиця для аналізу

- Where: the «Токени» view, as in variant 1.
- Desktop: a short area chart across the range (about 120 px) with a draggable
  selection that narrows the range; the date inputs mirror it. Below, a table:
  rows by «Моделі» (switch: Ролі, Проєкти, Учасники, Акаунти), columns Нові
  вхідні · Читання з кешу · Запис у кеш · Вихідні · з них міркування ·
  Запити · Кеш % · ≈ Вартість, and a sparkline per row; columns sort on click.
  Under it, two folding tables: «Найбільші розмови» and «За лейнами й
  задачами».
- Phone: the table becomes one card per row (name, total, four-kind bar, the
  kinds as a 2×2 grid); the date inputs replace the drag selection.
- Extras shown: E1, E4, E5.
- Build beyond the core: M. The drag selection is a new control; the critic
  judges whether it earns its place.

### 9.5 Варіант 4 з 4 — акаунти й ліміти

- Where: the «Токени» view, organised by account first.
- Desktop: one card per provider account, side by side: tokens per day stacked
  by model, with the account's 5-hour and weekly window usage as a line over
  the same days. Under the cards, tabs «Учасники · Ролі · Проєкти» with ranked
  lists. The project filter applies to every card.
- Phone: the account cards stack; the tabs follow.
- For a member who is not the owner, accounts are hidden (§6.3) and the view
  falls back to variant 1's layout.
- Extras shown: E3, E2.
- Build beyond the core: M (E3's longer window history).

### 9.6 Fixtures, states and capture

- Fixture: an isolated state directory whose `activity/records.sqlite` holds
  token tables for 35 days, built by a fixture builder in the test tree.
  Invented data only: projects orchard-client, lantern-api, kestrel-cli,
  sorrel-bot and a tail of seven more; members Ada Quill (owner), Bo Tern, Cy
  Moss; accounts «Claude · A (Max)», «Claude · B (Pro)», «Codex · C»; models
  from §1; roles weighted like this host's turns (builder, orchestrator,
  reviewer, без ролі, немає в реєстрі, visual-critic, architect, merger and a
  tail). Proportions: cache reads 95–98 % of input, output about 0.4 % of
  input, reasoning about a third of output. A heavy day, an empty weekend,
  Today partial to 14:00, five days before `countedFrom`, and a pending
  backfill for the amber state.
- States per variant: 7 днів; a free range (1–16 жовт.); one project; grouped
  by model; grouped by member (owner); the coverage popover open in the amber
  state; nothing counted yet; and the phone layout of each.
- Widths: 1440×900, 1024×768 (the first desktop width, between the two named
  ones) and 390×844; Ukrainian; light and dark.
- Capture: a new case in the existing board-geometry driver
  (`scripts/capture-board-geometry.ts`, `BOARD_CAPTURE_CASE=activity-tokens`)
  against the production build, with a private HOME, TMPDIR and
  `LLV_STATE_DIR`, and the Viewer control URL on a closed port. The variant
  comes from a prototype-only `variant` parameter that the build removes once
  the operator has chosen. Frames stay outside the repository.
- The critic measures: the five-segment range control at 390 px with no cut
  text; the date popover and every tooltip inside the viewport; every number
  labelled once; text contrast in both themes.

## 10. Tests

Fixture shapes the cases need, each checked to exist before a case relies on it:
Claude assistant lines repeating `message.id` per content block with full
usage; Codex `token_usage_record` lines with `response_id`, `usage` and
`thread_token_usage`; `turn_context` with `model`; `session_meta` with
`forked_from_id` and with a subagent `source`; `token_count` lines with
`total_token_usage` and `last_token_usage`. None of today's activity fixtures
carries usage (`src/lib/activity/ingest.test.ts`,
`src/lib/activity/replayDay.fixture.ts`), so existing cases write no token rows
and keep passing; `pull.test.ts:211` keeps asserting `user_version` 3.

`src/lib/activity/transcriptExport.test.ts`:
- three lines of one Claude response give one response with each counter's
  maximum; a `<synthetic>` line gives none;
- a Codex `token_usage_record` gives one response; the model comes from the
  preceding `turn_context`, also across a piece boundary;
- `token_count` only: deltas per kind, a repeated total adds nothing, a fork's
  first event adds only its `last_token_usage`; a thread that switches to
  records mid-way counts each response once.

`src/lib/activity/ingest.test.ts` (each in both read orders where order could matter):
- a Claude prefix copy counts the shared responses once;
- a Claude fork whose branches both continue counts each branch's own responses;
- a Codex rollout copied whole into a second store counts once;
- a Codex fork adds its own usage and none of its parent's;
- a Codex subagent rollout counts under its parent's project, role and member,
  with its own conversation key;
- a rewritten (shorter) transcript adds nothing on the second read;
- an unregistered Delegatus transcript commits no token row while held;
- a cursor with `usage_offset = 0` and `offset` at the end is backfilled, a
  budget stop resumes inside the piece, and the file is skipped once caught up;
- a cursor row written without `usage_offset` (an older release) is backfilled;
- a response older than 92 days is skipped and counted in `skippedOld`;
- a commit that fails rolls back token rows, dedupe marks and the cursor together.

Store: retention deletes at most 10 000 rows per table per pass; a zone change
rebuilds days within 92 days and reports `daysZone`; a store without
`usage_meta` reads as nothing recorded.

`src/app/api/activity/tokens/route.test.ts`: preset and free-range clamps (to
in the future, from after to, span over 366 days); bucket choice; a project
alias folds; `member` and `account` refused with 403 for a member who is not
the owner; the answer holds no path, title or email; `compare=previous`; a
cache hit at an unchanged version and a recompute after a commit.

Rendered: the chosen variant's states in the board-geometry driver case (§9.6).

## 11. Build slices

1. Extraction, tables, dedupe, backfill and migration, with the tests in §10
   and the before/after ingest measurement (§7). No UI.
2. The route, read path and cache, with route tests and read timings on a copy
   filled by the backfill.
3. The chosen variant and the drawer's tokens section, with rendered evidence.
4. The extras the operator chooses.

## 12. Check against the requirement

| Item in the pinned specification | Where |
|---|---|
| accumulated tokens with a project filter | §6 totals with `project`; §9.1 project picker |
| breakdown by role | role attribute §3.1; `stack`/`list=role` §6.1 |
| grouping by model | model per response §3.1; `list=model` default |
| grouping by team member (who launched / whose account) | member §3.2 and account §3.3, owner-only §6.3 |
| chart with a custom date range, presets and free range | §6.1 `from`/`to` up to 366 days; §9.1 presets and «Період…» |
| input vs output, cached vs uncached, Claude read/write/fresh, Codex cached, reasoning | §2 |
| answer to «що ще?» with optional extras in the variants | §8, spread over §9.2–§9.5 |
| extend the existing surface, reuse its controls, status as dots | §9.1 |
| hot-path rules | §5, §6.4, §7 |
| attribution per turn and double counting (cumulative vs per-turn, resume, fork, compaction) | §3, §4 |
| Ukrainian, light and dark, 1440 and 390, frames from a real route against fixtures in isolated state | §9.1, §9.6 |

## Deferred — not currently justified

- **Tokens from linked installs.** Remote hosts send no activity records yet
  (`docs/design/linked-seats-and-activity.md` §2). The tables carry `host` so a
  pull can add them later.
- **Copilot and OpenClaw tokens.** No parser reads their usage and this host
  has no session of either.
- **Splitting a shared seat's turns by the author of each turn's opening
  message.** §3.2 attributes per conversation.
- **The cost of Claude compaction requests.** The transcript does not record
  them; they are named as unrecorded.
- **Web search and fetch counts** (`server_tool_use`) and compaction counts
  (E9 if chosen).
- **A per-response id set for Codex.** The thread watermark matched every
  duplicate seen; the build reports `branchSkipped` if that ever changes.
- **Ranges over 366 days in one request**, and days older than 25 months.
- **Live updates faster than the page's 60-second poll.**
- **Budgets and alerts on token use.**
- **Reconciling with provider invoices.**

## Found while reading (outside this lane)

- `src/lib/orchestrator/health.ts:217-222` sums Codex `input_tokens` and
  `cached_input_tokens`, but `input_tokens` already contains the cached part
  (in every one of 52 407 events, `cached ≤ input` and `total = input +
  output`). With cache reads near 98 % of input, a Codex seat's context figure
  reads close to twice its real size, and that figure drives the rotation
  advice (`rotationRecommendation`, `health.ts:409`). A fix belongs in its own
  task.
- `scripts/harness-ledger.ts:196-201` takes a Codex rollout's last cumulative
  `total_token_usage`, which for a fork includes its parent's tokens (§1.2).
  Analyses built on it overstate forked attempts.

## Appendix A: how the measurements were made

All on 2026-10-17 between 11:50Z and 12:40Z, with Bun 1.4.0, from scratch
scripts in the stage's temporary directory (removed with it). Transcripts were
read in place, read-only; the activity and team stores were copied with
`VACUUM INTO` and the copies queried.

- Claude: every `.jsonl` modified in the last 7 days under `$HOME/.claude/projects`
  and each Claude account store's `projects`, de-duplicated by real path;
  assistant lines containing `"usage"` parsed; counts per file and across files
  by `message.id`; for shared ids, the position of each shared response in its
  file and its timestamp. The usage sub-fields over 2 days of the shared store.
- Codex: every rollout modified in the last 2 and 21 days under
  `$HOME/.codex/sessions` and each Codex account's `sessions`; `token_count`,
  `token_usage_record`, `turn_context` and `session_meta` lines parsed; per
  rollout, the thread-total identity of §1.2; across rollouts, response ids and
  session ids seen more than once.
- Extraction cost: one pass over every transcript modified in 7 days (3 597
  files, 13.51 GB), reading each file whole, splitting lines and parsing only
  the usage lines, timed with `performance.now()`. The page cache held part of
  these files from the earlier probes.
- Cardinality: (hour, conversation, model) keys per day from the same pass;
  conversation-hours and (project, role, engine) combinations per day from
  `activity_turns` in the store copy, last 21 days.
- Read timings: synthetic stores with the keys and counters of §5.1, without
  the `tier`, `pipeline` and `stage` columns (random values; 12
  projects, 12 roles, 5 models, 5 accounts, 3 members), each query run once to
  warm and then 7 times.
- Team store: `events` grouped by action and actor kind; `message_authors`
  counted by conversation and member (no id kept).
