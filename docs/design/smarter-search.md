# Smarter transcript search: relevance, word forms, linked fragments

## Originating requirement

Operator request, 2026-09-26, dictated to the Delegatus project's orchestrator
seat while it watched an agent's `search_transcripts` calls come back empty
(paraphrased in English; the dictated original stays in the Viewer
conversation):

> Does our search really work properly? Look, the agent makes queries like
> these, and I think many conversations would fit, yet it says zero matches.
> How does it search: does it take the whole text and try to match it, or
> word by word? Does it ignore case, and are there other tricks? I would make
> this search smarter. Maybe even connect it with graphs somehow, I don't
> know. But without a million pieces of information being passed along;
> instead, fragments should be linked intelligently.

The pinned lane specification turns that into: find relevant conversations by
meaning, rank them, and connect related fragments without flooding the
caller; measure on a copy of the live index with 30+ real agent queries; decide
query semantics, word forms for en/ru/uk, whether local embeddings earn their
cost, the result shape, the index migration, and a backwards-compatible MCP
contract; report before/after hit counts; name the files for the build lane.

### The operator's direct questions, answered

- **Whole text or words?** Words. `ftsQuery`
  (`src/lib/search/transcriptSearch.ts`) splits the query on whitespace,
  quotes each piece, and joins them with `AND`: **every** word must appear in
  **one** message. A 7-word query therefore asks for a single message that
  contains all 7 words verbatim, and most such queries find none.
- **Case?** Ignored. The FTS5 `unicode61` tokenizer folds case.
- **Other tricks?** None. No word forms (`login` does not find `logins`,
  `сохранённые` does not find `сохранённых`), no prefix matching, `е` and `ё`
  are different letters, `1533` does not find `#1533` (the tokenizer keeps
  `#` inside the token), and results are newest-first with no relevance.

## Prior art (searched before deciding)

- **#1825 / PR #1828** (2026-09-19): the index used to rank in memory by a
  relevance score, and the operator filed "results come back in no readable
  order" against the *Find my messages* dialog. The fix made **newest first
  the default** and set the rule this design keeps: *"If a relevance order is
  kept at all, it is an explicit choice in the dialog, never the silent
  default"*, and the MCP tool follows the same order *"or the tool documents
  its own"*. So relevance ranking goes to the MCP tool, documented there; the
  dialog stays newest-first.
- **#1429** (`docs/performance/issue-1429-transcript-search.md`): the search
  runs synchronously on the Viewer's only thread; a common-word query cost
  170–350 ms of stall after that fix. **#1438** (open) owns moving it off the
  thread and measuring FTS5 `optimize`/`merge`. Latency below is held to that
  bar.
- `search_transcripts` for `BM25`, `stemming`, `embeddings`: nothing else in
  the history designs word forms or a semantic layer for this index.

## Method

Everything ran against a **copy** of the live index, made with
`sqlite3 'file:…?mode=ro' .backup` into a private scratch directory (1.8 GB,
9,600 transcripts, 293,368 messages, schema v4). Nothing wrote to live state;
every heavy step ran under `flock /var/tmp/llv-heavy-gate.lock`. The harness
is a self-contained Bun script over `bun:sqlite`: it re-implements today's
`ftsQuery` and collapse verbatim for the *before* column and the prototype
for the *after* columns. It is not committed because it reads private
transcripts.

**Real queries.** Every `search_transcripts` call recorded in the indexed
transcripts: Claude `tool_use` blocks, Codex `item_completed` `McpToolCall`
items and `mcp_tool_call_end` events. That gives **10,048 calls** (2,781 Claude,
7,267 Codex) since 2026-08-27, or 9,522 distinct (query, project) pairs. A seeded random
sample of **1,000** pairs is the test set: 159 one-word, 215 two-word, 263
with 3–4 words, 251 with 5–7, 112 with 8+; 458 scoped to a project; 59 in
Cyrillic.

**Fence.** Each query runs only against what existed when the agent asked:
messages with `sort_timestamp <=` the call time, with the calling transcript
excluded. Without the fence, later conversations (including the one that
asked) would inflate the *after* numbers.

**Live cross-check.** Of the 2,166 Codex calls whose recorded answer is still
in the rollout, **845 (39%) came back empty in production**. That is an
independent measurement of the live tool, and it agrees with the replica.

## What fails today, and why

Share of the 1,000 real queries that return **no conversation at all**
(before):

| words in query | queries | zero today |
| --- | --- | --- |
| 1 | 159 | 34.0% |
| 2 | 215 | 34.0% |
| 3–4 | 263 | 41.1% |
| 5–7 | 251 | 66.1% |
| 8+ | 112 | 76.8% |
| **all** | **1,000** | **48.7%** |

The spec's example, `Telegram login MTProto api_id QR sign-in Delegatus`,
returns 0 today. The design conversation for that exact topic exists and
covers all seven terms, spread over several of its messages.

Three causes, in order of weight:

1. **Every word must meet in one message.** Zero rate climbs with query length
   (34% → 77%). Agents write queries as keyword bags drawn from their task;
   the words co-occur within a *conversation* and rarely within one message.
2. **The `project` argument silently matches nothing.** 162 of the 487 zero
   results (a third) were scoped queries whose `project` value is not a
   project key at all: a bare repository name (71), an absolute path (39), an
   encoded directory name (28), or an invented `repo-github-…` string (24).
   The route compares it with `=` and returns an empty page with no hint.
3. **No word forms.** Inflections, `е`/`ё`, and `#1533` against `1533`.
   Adding word forms alone (still AND, still one message) moves the zero
   rate only from 48.7% to 44.2%. It helps, but it is the smallest of the three.

## Decisions

### D1. Query units and word forms, on the query side (no reindex)

The query is parsed into **units**, and each unit becomes one FTS5 expression:

- A `"quoted phrase"` stays a phrase.
- A whitespace term that tokenizes to several tokens (`sign-in`,
  `report.md`, a branch name, a path) is a phrase of those tokens, which is
  exactly what FTS5 does with today's quoted term.
- A single token becomes its **word form**:
  - identifiers (anything with a digit, `#` or `_`) match exactly; a bare
    number also matches `#number` (`("1533" OR "#1533")`);
  - words shorter than 5 letters match exactly;
  - longer Latin words drop one inflectional ending (`ies ied ing ed es s`,
    keeping a stem of at least 4 letters) and match the stem as a prefix:
    `logins` → `login*`, `rebasing` → `rebas*`;
  - longer Cyrillic words drop one ru/uk ending from a fixed list of about 70
    (`ами ями ого ому ими ої ій ий ая ое ые ів ах ях ть ти ся сь а я о е и і ї у ю ь й …`,
    stem ≥ 4 letters) and match the stem as a prefix: `сохранённые` →
    `сохранённ*`, `картки` → `картк*`;
  - a Cyrillic stem containing `е`/`ё` also matches its variants (`ё`→`е`
    everywhere, and `е`→`ё` at its first and last `е`), so `сохраненные` finds
    `сохранённые`;
  - if stripping the ending makes the prefix common (over 5% of messages)
    while the whole word is not, the whole word is the prefix instead
    (`liveness` stays `livenes*`; it must not become `live*`).

This is prefix matching over a light suffix-stripper. Snowball-grade
stemming is not needed for recall here, because the prefix absorbs the
remaining inflections. It needs no tokenizer change and no index rebuild, and
it covers en, ru and uk with one rule set of about 60 lines.

Both orders use these units. The **newest** order ANDs them, so for any query
without quotation marks it returns a superset of today's matches. The **relevance** order ranks by them.

### D2. Two orders; each surface keeps a documented default

| surface | default order | why |
| --- | --- | --- |
| *Find my messages* dialog (`/api/search/transcripts`) | `newest` (unchanged) | #1825: the operator reads newest first, and relevance there is only an explicit choice |
| `search_transcripts` MCP tool | `relevance` | the question is "has this been solved before?"; #1825 lets the tool document its own order |

`order: "newest"` on the tool returns today's shape and order with word forms
added, for agents that do want a timeline.

### D3. Relevance: rank conversations by how much of the query they cover

The unit of result is the **conversation**, because that is where an agent's
keywords actually meet.

1. **Document frequency** per unit from an `fts5vocab` table: an exact term
   is one row, a prefix one range sum. That costs 0.1–6 ms for ordinary
   words, but fts5vocab counts documents by walking the doclist, so `the`
   costs 212 ms on the live-shaped index (46 ms after `optimize`, D6). A
   fixed list of about 60 en/ru/uk function words (`the and of to in is for
   with и в на не что і та що у до …`) is dropped **without** a lookup.
2. **Common units are dropped**: a unit found in more than 5% of messages
   (`test`, `file`) is ignored, but the rarest unit is kept if all are
   common. With `in` included, the spec's example matches 62,138
   messages and takes 250 ms; without it, 11,135 messages and 23 ms. The
   answer names what was ignored.
3. **Per unit**, one FTS5 match joined to `transcript_messages` gives
   (message, conversation) pairs; retrieval costs 25–50 ms for the most common
   unit that is still kept.
4. **Score per conversation**, with `idf(u) = ln(1 + (N − df + ½)/(df + ½))`:
   - `coverage` = Σ idf of the units found **anywhere** in the conversation;
   - `best` = the largest Σ idf of units found together in **one** message
     (proximity: words that meet in one message are stronger evidence);
   - `lengthDamp = 1 / (1 + 0.15·log10(messages))`, so a 2,000-message
     orchestrator seat does not win just by containing every common word
     somewhere;
   - `recency = 1 + 0.6·e^(−age_days/14)`, from the conversation's newest
     matching message;
   - `score = (coverage·lengthDamp + best) / (2·Σidf) · recency`; ties go to
     the newer conversation.
5. **Fragments: a greedy cover.** Inside each conversation, pick the message
   that covers the most query idf, then the one that adds the most of what is
   still missing, up to 3. These are the "linked fragments": together they
   show where each part of the query appears in that conversation.
6. **Copies fold together.** Conversations whose lead fragment has the same
   snippet text (one spec pasted into every stage of a pipeline, a forked
   rollout) become **one** result with `alsoIn`. On the spec's example, five
   stage conversations of the same design lane fold into one item. That is
   the graph edge the operator asked for, and it costs nothing extra.
7. Snippets come from **one** batched `snippet()` pass over at most
   5 × `limit` candidates. A per-candidate snippet pass had cost up to 9 s on
   duplicate-heavy queries.

The recency weight was chosen by measurement (below): 0.1/30 days, 0.3/14 and
0.6/14 were compared on the click set, and 0.6/14 was best on every cut.

### D4. Result shape: small, with one conversation per item

A relevance page is **6 conversations by default** (`limit` still clamps to
1..100). Each item keeps **every field an item has today**: `snippet`,
`speaker`, `timestamp`, `transcriptPath`, `byteOffset`, `lineNumber`,
`project`, `engine`, `title` and `duplicateCount`, all describing the **lead
fragment**. So a caller that reads today's fields keeps working unchanged. It
adds:

```json
{
  "matched": ["telegram*", "login*", "mtproto", "api_id", "qr", "sign in"],
  "missing": ["delegatu*"],
  "fragments": [
    { "snippet": "…talks to \u0001Telegram\u0002: the design uses the Bot API…",
      "speaker": "assistant", "timestamp": 1790000000, "byteOffset": 81234, "lineNumber": 212 }
  ],
  "alsoIn": { "count": 5, "transcriptPaths": ["<path>", "<path>", "<path>"] }
}
```

- `fragments` holds at most 2 more, each one covering what the lead did not;
  snippets are 16 tokens in this order (today: 24).
- `matched`/`missing` tell the agent in a glance whether the conversation
  answers all of the question.
- `alsoIn` lists at most 3 paths plus the count, and `duplicateCount` becomes
  `1 + alsoIn.count`.
- The page adds `interpretedAs: { units: [...], ignored: ["in", "the"] }` and
  `order: "relevance"`. `total` counts conversations that match at least one
  unit, before copies are folded.

Measured on 836 full pages from the 1,000-query run: **653 bytes per
conversation at p50, 843 at p95**, so a 6-conversation page is **≈ 3.9 KB
p50, ≈ 5.1 KB p95** before the route adds titles. Today's recorded non-empty
answers are 2.1 KB p50 and 4.5 KB p95 (max 22 KB) and, 39% of the time, empty.

### D5. `project` accepts what agents actually pass

Resolution order in the route (clamp over reject):

1. a key found in the index: as today, after `canonicalProject()` so an
   aliased old key follows its successor;
2. an absolute or `~/` path: `projectForCwd(path)`, the scanner's own
   recognizer, so a worktree path lands on its parent repository;
3. anything else is a name. Compare it with every recorded repository remote
   (`state/project-remotes.json`, key → `github.com/<owner>/<name>`, which
   `aliases.ts` already reads) and every display name in
   `projectAliasSnapshot()`. Case and the separators `-`, `_`, `.`, `/` are
   ignored. The value matches a project when it equals that project's
   `<name>` or `<owner>/<name>` or **ends** with one of them at a separator:
   a bare `name`, `owner/name`, `repo-github.com/owner/name`
   and an encoded directory `-home-…-<name>` all qualify;
4. no match, or several: search **every** project and say so in the answer:
   `projectScope: { requested, resolved: null, note: "names no indexed project; searched every project" }`.
   A resolved scope reports `resolved: <key>`.

Checked by hand against this machine's remote map, 17 of the 20 distinct
unknown values in the sample resolve to the project the agent meant. The
other 3 (a truncated key hash, and two `…-live-log-viewer` strings missing the
repository's `-next`) fall to rule 4, which still answers them unscoped.
The before/after table below measures rule 4 alone (every unknown value
searched unscoped), so rules 1–3 can only narrow those results toward the
intended project.

### D6. Index: one cheap migration, plus merging after full passes

- **Schema v5** adds `CREATE VIRTUAL TABLE transcript_messages_vocab USING
  fts5vocab(transcript_messages_fts, row)` in `openWriterDatabase`. It is a
  view over the existing index: no data is copied, and it is created
  instantly. It has to be persistent, because the query connection runs with
  `query_only = ON`, which refuses even a `temp` virtual table (verified:
  `SQLITE_READONLY`).
- **No tokenizer change and no rebuild.** Measured alternatives on the copy
  (full contentless build of 293k messages): `unicode61` today's rules,
  14.2 s / 107 MB; `porter unicode61`, 12.7 s / 103 MB (English only, and it
  changes exact-word matching for the dialog); `trigram`, 668 MB (6.2×; ranks
  substrings, not words). Query-side forms cover en/ru/uk with none of that.
- **Merge after complete passes (cheap win, overlaps #1438).** The live FTS
  index is 548 MB in 21 segments, because growing transcripts are re-indexed
  as delete + insert. `optimize` on a second copy took 100 s and left 97 MB in
  one segment, and on the same 200 queries it cut **today's AND query from
  p95 42 ms to 3 ms and relevance from p95 327 ms to 225 ms**. A 100 s write
  lock is too long for the indexer, so the build lane runs **incremental**
  merges after each complete indexing pass: `INSERT INTO
  transcript_messages_fts(transcript_messages_fts, rank) VALUES('merge', 256)`
  repeated while `total_changes()` shows the step wrote pages, yielding to
  the event loop between steps. #1438 keeps the
  worker move.

### D7. No local embeddings

Measured on this machine with `multilingual-e5-small` (q8, native ONNX
runtime through `@huggingface/transformers`), on 400 real messages
(≤ 2,000 chars each), batch 16:

| cost | measured |
| --- | --- |
| dependency | +396 MB `node_modules`, +130 MB model |
| peak RSS while embedding | **1.6 GB** (model load alone: 454 MB) |
| throughput | 320 ms per message → **≈ 26 hours** for the 293k-message corpus |
| vectors | 430 MB float32, plus a scan or ANN index per query |
| query embedding | 31 ms |

The machine runs with 20 of 31 GB used and 12 GB of swap in use, and the
indexer already competes with agent builds (three stacked gates rebooted it
on 2026-09-25). The lexical design already takes the zero rate from 48.7% to
5.9%. The one gap embeddings would close is cross-lingual matching (a Russian
query finding an English conversation), which the operator did not ask for
(see Deferred).

## Before / after on the same 1,000 real queries

Same fence and sample for every column. "Strong" is a conversation covering
at least 60% of the query's units. That is the fair zero test for relevance,
since OR on its own nearly always returns something.

| words | queries | zero today | zero, word forms (AND, newest) | zero, relevance (strong) | zero, relevance (any) |
| --- | --- | --- | --- | --- | --- |
| 1 | 159 | 34.0% | 33.3% | 17.0% | 17.0% |
| 2 | 215 | 34.0% | 29.8% | 7.4% | 1.9% |
| 3–4 | 263 | 41.1% | 37.6% | 3.4% | 1.1% |
| 5–7 | 251 | 66.1% | 59.8% | 2.8% | 0.0% |
| 8+ | 112 | 76.8% | 67.9% | 0.0% | 0.0% |
| **all** | **1,000** | **48.7%** | **44.2%** | **5.9%** | **3.4%** |

Scoped queries: 57.4% zero today, 5.2% after (the project resolution
recovers them). Unscoped: 41.3% → 6.5%. The one-word residue is mostly
identifiers (commit hashes, class names, env names) that did not exist yet
when the agent asked.

Four queries (0.4%) found something today and nothing strong after. All four
are explicit `"quoted phrases"` (`"Shall I proceed"`,
`"fenced during release handoff"`, …): today the quotes break the quoting and
the words match anywhere, while the design honours the phrase. That is
intended behaviour.

**Latency** (whole-query wall time on the live-shaped copy, 1,000 queries):

| | p50 | p95 | max |
| --- | --- | --- | --- |
| today | 4 ms | 34 ms | 202 ms |
| word forms, AND (dialog) | 13 ms | 82 ms | 196 ms |
| relevance (MCP) | 67 ms | 254 ms | 569 ms |
| relevance after `optimize` (200-query subset) | 49 ms | 225 ms | 491 ms |

The relevance p95 sits inside the 170–350 ms stall that #1429 left for a
common-word query and #1438 tracks. Agents issue about 330 searches a day
(10,048 in 30 days), none of them per keystroke. The query in the last row is
the same prototype on a copy after `optimize` (D6).

**Is the right conversation ranked higher?** 1,717 times an agent searched
and then opened a transcript with `conversation_messages`/`get_conversation`
before its next search. That opened transcript is a relevance judgment made
by the agent. On 296 seeded (query, opened transcript) pairs, rank of the
opened conversation:

| opened conversation within | today (newest first) | relevance, recency 0.1/30 d | relevance, 0.3/14 d | **relevance, 0.6/14 d (chosen)** |
| --- | --- | --- | --- | --- |
| top 1 | 87 | 76 | 83 | **84** |
| top 3 | 131 | 133 | 149 | **152** |
| top 6 | 149 | — | — | **181** |
| top 8 | 152 | 182 | 188 | **191** |
| top 20 | 156 | 207 | 213 | **212** |
| MRR | 0.377 | 0.384 | 0.412 | **0.418** |

This set favours *today*: agents could only open what today's search showed
them. Relevance still puts that transcript in the first 6 results 32 more
times out of 296, and misses it in the top 20 in 84 cases where today misses
140. Top-1 is 3 lower: when the newest hit is the one wanted, newest-first
wins by construction, and the recency term recovers most of that.

**Hand judgment, 34 queries** that return **nothing** today (seeded random
from the 293 zero-hit queries of 4+ words). Top results of the chosen
ranking, read one by one:

- **20 / 34**: the top result is on topic;
- **23 / 34**: a top-3 result is on topic;
- 11 / 34: nothing relevant in the top 3. One is a cross-language miss:
  `wall of boxes kanban card too many borders` does not reach a Ukrainian
  seat report about five nested frames on the desktop card, which the
  Ukrainian query `варіанти картки десктоп рамки` finds at rank 1. In
  another, the query's rare identifiers occur only outside the scoped project
  and time fence, so no in-scope answer exists. For the other nine I did not
  establish whether a relevant conversation existed at all.

Examples from the judged set (Delegatus-internal queries only):

| query (0 results today) | top result after |
| --- | --- |
| `Telegram login MTProto api_id QR sign-in Delegatus` | the sign-in design conversation, covering all 7 terms; next, the Telegram bot design lane, with 5 stage copies folded in `alsoIn` |
| `dead host whole payload reservation` | the lane whose fragment reads "a dead-host send now reserves the whole payload" |
| `taskIds create_pipeline placeholder task duplicate card` | the diagnosis stage that names the duplicate placeholder card |
| `terminal reap unresolved survivor` | the #1501 architect stage, with fragments on reap and on typed `unresolved` survivors |
| `1875 revert only 1874` | "The PR is open and closes #1874 only. #1875 is fully reverted" |
| `варіанти картки десктоп рамки` | the seat report on five nested frames on the desktop task card |

## MCP contract (backwards compatible)

`search_transcripts` input, additions only:

```ts
order: z.enum(["relevance", "newest"]).optional()
  .describe("relevance (default): conversations ranked by how much of the query they cover, with the fragments that cover it. newest: matching messages newest first, every word required."),
project: z.string().trim().min(1).optional()
  .describe("Project key, repository name, or a path inside the project. An unrecognised value searches every project, and the answer says so."),
```

- `limit` defaults to **6** in `relevance` (conversations) and stays 20 in
  `newest` (messages); the 1..100 clamp is unchanged.
- `cursor` stays opaque. A relevance cursor is `{version: 3, scope,
  throughId, offset}`: the ranking is recomputed with `m.id <= throughId`, so
  page 2 continues page 1 while new messages are indexed, as #1825 requires.
  Scope hashes query, project, speaker and order, so a cursor from the other
  order is refused like today's foreign cursor.
- Output keeps `items`, `nextCursor`, `total` and `stats`, so the binding's
  shape check (`bindings.ts` `searchTranscripts`) still passes. The additions
  are the per-item and page fields of D4, plus `projectScope` when a
  non-key `project` was passed.
- The tool description is rewritten around the default: one query with the
  words you have; results are conversations ranked by coverage; read
  `missing`; open a hit with `conversation_messages` at `transcriptPath`
  (`timestamp` as `since`); `order: "newest"` for a timeline.

The route gains `order=relevance|newest` (default `newest`, so the dialog is
untouched) and the D5 project resolution for both orders.

## Build: files for the lane

Main code:

- `src/lib/search/queryUnits.ts` (**new**, pure): tokenize → units (D1), word
  forms, `е`/`ё` variants, `#N`, the FTS5 expression per unit, common-unit
  dropping given a df lookup. No SQLite import, so it can be tested alone.
- `src/lib/search/transcriptSearch.ts`: replace `ftsQuery` with the units'
  AND for `newest`; add the relevance path (D3) and its cursor v3; schema v5
  (the vocab table); an incremental `merge` step after a complete pass in
  `indexTranscriptSources` (D6). Shared types gain the D4 fields as optional.
- `src/lib/search/projectScope.ts` (**new**): D5 resolution over
  `canonicalProject`, `projectForCwd`, the remote map and the alias
  display names.
- `src/lib/projects/aliases.ts`: export a read-only `recordedProjectRemotes()`
  beside `recordedProjectRemote(project)`.
- `src/app/api/search/transcripts/route.ts`: `order` param, project
  resolution, titles for relevance items.
- `src/lib/mcp/server.ts`: input schema and description; `src/lib/mcp/bindings.ts`:
  pass `order`, default `limit` by order; `src/lib/mcp/presentation.ts`:
  subtitle "N conversations" for relevance.
- `src/components/search/useTranscriptSearch.ts` / `GlobalSearch.tsx`: **no
  change**; the dialog keeps `newest` and gains word forms through the route.

Tests, run by path:

- `src/lib/search/queryUnits.test.ts` (**new**): `logins`→`login*`,
  `сохраненные` finds `сохранённые` forms, `картки`→`картк*`, identifiers
  exact, `1533`→`1533 OR #1533`, `liveness` does not widen to `live*`, a
  quoted phrase stays a phrase, `sign-in` is a phrase.
- `src/lib/search/transcriptSearch.test.ts`: a conversation covering all
  terms across *separate* messages outranks one repeating a single term in
  many; fragments cover distinct units; copies with the same lead fragment fold into
  `alsoIn`; a common unit is ignored and reported; relevance cursor pages are
  stable while rows are appended; `newest` with word forms returns a superset
  of the v4 results on the existing fixtures for unquoted queries; the v4 → v5 migration keeps
  every row and creates the vocab table.
- `src/lib/search/projectScope.test.ts` (**new**): a key, an aliased key, a
  worktree path, `owner/name`, an encoded directory, and an unknown value
  that searches everything with the note.
- `src/app/api/search/transcripts/route.test.ts`, `src/lib/mcp/searchTranscripts.test.ts`,
  `src/lib/mcp/schemaParity.test.ts`: order defaults per surface, the
  preserved fields, the new fields.
- `scripts/transcript-search-bench.ts`: add `order=relevance` cells on the
  synthetic fixture; it is the existing driver, so no new one.

### Acceptance

1. On the synthetic bench: the relevance library median ≤ 300 ms on the
   "two common words" query; `newest` stays within 10% of today's cells.
2. A 6-conversation relevance page for the fixture's common query is ≤ 6 KB.
3. Before promotion, rerun this document's method on a fresh read-only copy
   of the live index (the harness shape is described under *Method*): zero
   rate (strong) ≤ 8% on a 1,000-query seeded sample, and the opened-transcript
   top-6 count at least today's. Report both in the PR, with no query text
   that names a client, account or path.
4. For any unquoted query, the dialog still returns every row today's search
   returns, newest first, with the inflected matches placed by their time.

## Validation against the requirement

| operator's words | this design |
| --- | --- |
| "zero matches while many conversations would fit" | zero results 48.7% → 5.9% on 1,000 real agent queries; 5–7-word queries 66% → 3% |
| "whole text or words? case?" | answered above; word forms added for en/ru/uk |
| "make the search smarter" | conversations ranked by idf-weighted coverage, proximity and recency; the opened transcript lands in the top 6 in 181 of 296 cases (today 149) |
| "maybe connect with graphs" | fragments inside a conversation are linked by what they cover (`fragments`, `matched`/`missing`); conversations sharing a fragment are linked by `alsoIn` |
| "without a million pieces of information" | 6 conversations, ≤ 3 short fragments each: ≈ 3.9 KB p50 |

## Deferred — not currently justified

- **Local embeddings / semantic vectors.** D7: 26 h to embed the corpus,
  1.6 GB peak RSS, +526 MB of dependencies and model, on a machine short of
  RAM. The lexical design closes most of the gap. Revisit if cross-lingual
  misses (like the `wall of boxes` example) become a recurring complaint.
- **Cross-language or synonym expansion** (a curated ru/uk ↔ en dictionary).
  It is the cheap form of the item above; nobody has asked for it yet.
- **A "Best match" toggle in the dialog.** #1825 allows it only as an
  explicit choice, and the current requirement is about agents' searches.
- **A cross-conversation graph** from shared issue/PR numbers, branches or
  pipeline lineage. `alsoIn` covers the case the prototype showed (one spec
  across pipeline stages); a wider graph needs data the index does not hold.
- **External-content FTS** (`content='transcript_messages'`), which would save
  313 MB of duplicated bodies on disk. That is disk, not RAM, and it needs a
  full rebuild; nothing in the requirement calls for it.
- **Porter or trigram tokenizers.** Measured in D6 and rejected there.
- **Moving the search off the Viewer thread.** Owned by #1438; the relevance
  p95 stays inside the band that issue already accepts.
