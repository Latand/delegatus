# Shared memory for Claude Code and Codex agents

Status: research and design. Written against `main` at `311e47fd1`
(2026-10-01). File and line references are to that commit. This stage wrote
only this document: no code, no test, no state, no issue.

## Originating requirement

Operator, 2026-10-01, by voice. The board card carries a paraphrase, and the
pipeline pinned that paraphrase to this stage. Verbatim from the pinned
specification:

> Operator 2026-10-01 (voice, paraphrased on the card): a big task. Study how
> memory works in Claude Code and in Codex (ChatGPT), in code and in
> documentation. Make Delegatus's component that already makes decisions
> decide, whenever anyone writes a prompt, which of all memories are worth
> including, and check which ones are actually useful. Do not contradict what
> Claude Code or Codex do themselves. See how they work with memory now and
> how to improve it by uniting the memory of both, and maintain it
> additionally. Start with research only. 19:24: «розбирай задачі з вхідних по
> пріорітетам і правильно запускай».

The original voice message is absent from this machine's transcript index
(searched 2026-10-01, section 0), so the paraphrase is the requirement this
document is validated against. The default answer to "should we build this"
is no. Section 4 argues which parts the quote demands and which parts the
engines already cover.

## How claims are marked

Every factual claim carries one of two marks.

- **documented** — an official page, linked. D1–D6 are listed below.
- **observed** — seen on this machine on 2026-10-01, with the place. All
  observations were read-only and describe shapes and counts. No memory text,
  account name or personal content is reproduced here.

| Tag | Source |
| --- | --- |
| D1 | Claude Code, "How Claude remembers your project": <https://code.claude.com/docs/en/memory> |
| D2 | Claude Code, hooks reference: <https://code.claude.com/docs/en/hooks> |
| D3 | Codex, memories: <https://learn.chatgpt.com/docs/customization/memories> (redirect target of `developers.openai.com/codex/memories`) |
| D4 | Codex, AGENTS.md: <https://learn.chatgpt.com/docs/agent-configuration/agents-md> |
| D5 | Codex, configuration reference: <https://learn.chatgpt.com/docs/config-file/config-reference> |
| D6 | Codex, hooks: <https://learn.chatgpt.com/docs/hooks> |
| O-session | this stage's own Claude Code session (its system prompt and loaded context) |
| O-disk | read-only listings under `$HOME/.claude`, `$HOME/.codex` and `$HOME/.config/delegatus` |
| O-db | Codex SQLite state opened with `mode=ro` |
| O-bin | printable strings of the installed binaries: Claude Code 2.1.284, codex-cli 0.159.3 |
| O-code | this repository at `311e47fd1` |
| O-search | `search_transcripts` results (383 conversations, 10 671 messages indexed) |

D1 and D2 were read in full. D3–D6 were read through a fetch tool that
returns a condensed rendering, so their numbers are documented values and
their wording here is a paraphrase. Where the installed binary confirms a
documented name, the claim carries both marks. The Codex CLI source is absent
from this machine (the package ships a compiled binary), so O-bin stands in
for it.

## 0. Prior conversations

`search_transcripts`, unscoped and project-scoped, 2026-10-01:

| Query | Hits | What they are |
| --- | ---: | --- |
| `shared memory` | 38 | Unrelated uses of "shared" (a shared dev server, a shared checkout). No design for shared agent memory. |
| `MEMORY.md` | 292 | Almost all are Codex `<oai-mem-citation>` blocks closing an answer (section 2.4). |
| `memory` | 482 | The global instruction file's "Memory" heading inside Codex first messages; agents saying they saved a note. |
| `remember` | 2 | An operator brief reminding a worker of a known trap (2026-08-09). |
| `пам'ять`, `пам'яті` | 39, 20 | Agents reporting a saved or corrected memory; findings below. |
| `memories`, `autoMemoryDirectory`, `memory symlink`, `imported-desktop` | 0 | — |

Nothing in the index proposes or decides a shared memory, so this document
starts the topic. Five earlier moments are evidence for section 5:

| Date (UTC) | Engine | What happened (paraphrased) |
| --- | --- | --- |
| 2026-08-12 | Codex | A path taken from the memory registry was an abbreviated rendering and failed to open; the agent re-derived the real file names. |
| 2026-08-20 | Codex | A reference path from an old memory no longer existed; the agent checked the current directory. |
| 2026-08-30 | Claude | Twelve ticks of working state had accumulated in a memory file; the orchestrator moved it onto a board card. |
| 2026-09-28 | Claude | An orchestrator took a destination from conversation memory without checking a newer binding and sent a report to the wrong place. |
| 2026-09-29 | Claude | An orchestrator corrected a wrong memory and the matching monitor note. |
| 2026-10-01 | Claude | A handover told the successor that paths in the project memory point at another machine. |

Each old answer was checked against the present state: the memory files those
sessions wrote are still under the same directories, and the failure classes
(stale path, stale fact, state stored as memory, memory moved between
machines) recur in today's observations.

## 1. How Claude Code memory works today

### 1.1 Instruction files

| Fact | Basis |
| --- | --- |
| Two mechanisms carry knowledge across sessions: instruction files a person writes, and auto memory Claude writes. Both load at the start of every conversation and are treated as context. | documented D1 |
| Load order, broadest first: managed policy (`/etc/claude-code/CLAUDE.md` on Linux), user (`~/.claude/CLAUDE.md`), project (`./CLAUDE.md` or `./.claude/CLAUDE.md`), local (`./CLAUDE.local.md`). | documented D1 |
| Files from the working directory and every directory above it load at launch and are concatenated, root first. Files in subdirectories load when Claude reads a file there. | documented D1 |
| `@path` imports expand at launch, at most four hops deep. An import does not reduce context cost. | documented D1 |
| `.claude/rules/*.md` load at launch; a rule with `paths:` frontmatter loads when a matching file is read. `~/.claude/rules/` applies to every project. | documented D1 |
| `AGENTS.md` is read directly since v2.1.277 when no `CLAUDE.md` or `CLAUDE.local.md` sits in the working directory or above it. A setting (`claude-md-and-agents-md`) loads both. `AGENTS.override.md` and `.agents/` are never read. | documented D1 |
| Limits: target under 200 lines per file; a file over 4 MiB is skipped; block HTML comments are stripped. | documented D1 |
| The content arrives as a user message after the system prompt. After `/compact` the project-root file is re-read from disk. | documented D1 |
| This repository uses a one-line `CLAUDE.md` that imports `AGENTS.md`. Both arrived in this session inside a system reminder, together with the user-level file. | observed O-session, O-code (`CLAUDE.md`, `AGENTS.md`) |
| The user-level file here is 698 bytes. Managed account homes link to it. | observed O-disk |

### 1.2 Auto memory

| Fact | Basis |
| --- | --- |
| On by default. `autoMemoryEnabled` in settings or `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` turns it off. | documented D1 |
| Location: `~/.claude/projects/<project>/memory/`. `<project>` comes from the git repository, so worktrees and subdirectories of one repository share one directory. Machine-local. | documented D1 |
| This stage ran in a pipeline worktree and received the parent repository's memory directory. | observed O-session |
| `autoMemoryDirectory` moves the directory. It is read from user, project, local, policy and `--settings` scope. | documented D1 |
| Layout: a `MEMORY.md` index with one line per memory, plus one topic file per memory. | documented D1 |
| The first 200 lines or 25 KB of `MEMORY.md` load into every conversation. Topic files load on demand through ordinary file tools. A write that pushes the index over the limit returns an error asking Claude to shorten it. | documented D1 |
| Four kinds, recorded as `type`: `user`, `feedback`, `project`, `reference`. Claude skips what the code or the instruction files already say. | documented D1 |
| A `modified` timestamp is written into frontmatter on each write (v2.1.214+). | documented D1 |
| The main conversation's memory does not load into subagents, except a fork. | documented D1 |
| Memory files are exempt from transcript cleanup. | documented D1 |
| The session's system prompt defines the file shape: frontmatter `name`, `description`, `metadata.type`, then the fact, with `[[name]]` links between memories. It also says recalled memories arrive inside system reminders as background and reflect what was true when written. | observed O-session |

Shapes on this machine (observed O-disk, default home, counts only):

- 22 memory directories across 52 project directories.
- 656 topic files, every one with `name` and `description` frontmatter.
  Types: 282 `project`, 279 `feedback`, 93 `reference`, 1 `user`. 419 carry
  `modified`; 523 carry an origin session id.
- Topic file size: median 1.5 KB, 90th percentile 2.7 KB, largest 15.7 KB.
- Index sizes range from 1 to 176 lines. The largest index is 17.1 KB with
  215 files beside it, which is 88% of the line limit.
- One directory holds a subtree imported from another machine today, with its
  own index that the main index links to.
- 60 of the 75 transcripts in that home mention a memory topic path, so
  agents here read and write these files routinely.

### 1.3 What the binary adds beyond the documentation

- The binary contains a selector prompt: given the list of memory files with
  their names and descriptions and a user query, return up to five file names
  that will clearly be useful, through a structured side request. It also
  names a `relevant_memories` attachment for the result. (observed O-bin)
- None of the 75 transcripts in the default home contains a
  `relevant_memories` attachment. Whether that selector runs for sessions on
  this machine is therefore unconfirmed. (observed O-disk)
- The binary names further memory features that D1 does not describe:
  post-turn extraction, a background consolidation setting, team and
  organisation memory sync, a remote memory directory. (observed O-bin)

The consequence for design: Claude Code already owns "which of this
project's memories suit this prompt", and its implementation moves faster
than its documentation.

### 1.4 A native point for adding context to a prompt

A `UserPromptSubmit` hook receives the submitted prompt on stdin and may add
context through plain stdout or `hookSpecificOutput.additionalContext`.
Claude Code wraps it in a system reminder beside the prompt. Each output is
capped at 10 000 characters, the default timeout for this event is 30
seconds, the hook can block the prompt, and it runs in non-interactive mode.
(documented D2)

## 2. How Codex memory works today

### 2.1 Instruction files

| Fact | Basis |
| --- | --- |
| Global scope: `AGENTS.override.md`, then `AGENTS.md`, in the Codex home; the first non-empty one is used. | documented D4 |
| Project scope: from the git root down to the working directory, one file per directory (`AGENTS.override.md`, `AGENTS.md`, then `project_doc_fallback_filenames`). Files concatenate root first. | documented D4 |
| Loaded once per run. Combined size is capped by `project_doc_max_bytes`, 32 KiB by default. | documented D4 |
| `CODEX_HOME` relocates the home. | documented D4 |
| The global file here is 10 lines and 620 bytes. It has a "Memory" heading with a few standing preferences and one `@` import. Its text recurs at the top of Codex sessions in the transcript index. | observed O-disk, O-search |

### 2.2 Memories

| Fact | Basis |
| --- | --- |
| Off by default. `[features] memories = true` enables it. It is enabled here. | documented D3, D5; observed O-disk (`config.toml`) |
| Memories live under the Codex home in `memories/` and are generated state, to be left unedited by hand. | documented D3 |
| Generation runs in the background from threads that have been idle long enough, skips active sessions, redacts secrets, and pauses when the remaining rate limit falls under a threshold. | documented D3 |
| Keys and defaults: `generate_memories` true, `use_memories` true, `disable_on_external_context` false, `min_rollout_idle_hours` 6, `max_rollout_age_days` 30, `max_rollouts_per_startup` 16, `max_raw_memories_for_consolidation` 256, `max_unused_days` 30, `min_rate_limit_remaining_percent` 25, optional `extract_model` and `consolidation_model`. | documented D5; key names also observed O-bin |
| `/memories` controls whether the current chat reads memories and feeds future ones. | documented D3 |
| Required team guidance belongs in `AGENTS.md` or checked-in documentation. | documented D3 |

Shapes on this machine (observed O-disk, O-db, O-bin):

- **Folder.** `memory_summary.md` (143 lines, 11.3 KB, first line `v1`),
  `MEMORY.md` (3 557 lines, 350 KB), `raw_memories.md`, `rollout_summaries/`,
  `skills/` (7), `extensions/ad_hoc/` (an instruction file and 91 dated
  notes), a `.git` baseline and a workspace diff file.
- **`MEMORY.md`.** 89 task groups. Each group lists its source rollout
  summaries with `cwd`, rollout path, thread id and time, then keywords, then
  "User preferences", "Reusable knowledge" and "Failures and how to do
  differently" bullets.
- **`memory_summary.md`.** A user profile, user preferences, general tips,
  and "What's in Memory" with one routing section per working directory.
- **Two phases.** A per-thread extraction writes a raw memory and a rollout
  summary into `stage1_outputs`. A global consolidation, run by an agent
  whose workspace is the memory folder, rebuilds `MEMORY.md` and the summary
  from the selected rows and a git diff of the folder.
- **Read path.** The summary is injected into every session inside a
  "Memory" section of the developer instructions. That section tells the
  model when to skip memory, to search `MEMORY.md` by keyword, to open at
  most one or two rollout summaries, to keep the pass to four to six search
  steps, and to say when an unverified fact may be stale.
- **Tools.** A `memories_v2` tool set lists, reads and searches the store. A
  fourth tool appends one ad-hoc note after the user explicitly asks Codex to
  remember, forget or update something. The model is told to leave the
  memory files alone and add only that note.
- **Import from other agents.** The binary carries an
  `external_agent_import` memory extension with rules for ingesting another
  agent's per-project memory directories, reading each project's `MEMORY.md`
  first and keeping the content scoped to that project. D3 does not describe
  it, and the extension is absent from this machine's `extensions/`.

### 2.3 Codex already measures usefulness

- Every answer that used memory ends with an `<oai-mem-citation>` block:
  file and line range per entry with a short note, plus the ids of the
  rollouts that proved useful. (observed O-bin; 292 hits in O-search)
- The state database counts it: `stage1_outputs` has `usage_count` and
  `last_usage`, incremented by an update statement in the binary.
  `max_unused_days` then drops unused sources from consolidation. (observed
  O-db, O-bin; documented D5)
- Here: 707 extracted threads in the default home, 118 of them used at least
  once (17%), the most used 26 times. (observed O-db)
- A thread that touched external context can be marked `polluted` and kept
  out of generation. All 309 threads here read `enabled`. (observed O-db,
  O-bin; documented D5 for `disable_on_external_context`)

### 2.4 A native point for adding context to a prompt

Codex supports hooks, on by default, configured in `hooks.json` or `[hooks]`
beside each config layer. `UserPromptSubmit` receives the prompt and may add
developer context through stdout or `additionalContext`. The default
`additionalContextLimit` is 2 500 tokens. A hook that is not managed must be
reviewed and trusted before it runs. (documented D6; event and field names
observed O-bin)

### 2.5 Side by side

| Question | Claude Code | Codex |
| --- | --- | --- |
| Scope of learned memory | one directory per repository | one store for all projects, routed by working directory |
| Unit | one fact per file | one bullet inside a task group |
| Who writes | the model, during the session | background pipeline after the session; ad-hoc notes on request |
| Always loaded | index, 200 lines or 25 KB | summary (11.3 KB here) |
| On demand | topic files through file tools; possibly a native selector | keyword search of the registry, guided by the system prompt |
| Usefulness signal | none documented; file reads visible in transcripts | citations, usage counters, a 30-day unused cutoff |
| Hand editing | plain markdown, editable (D1) | generated state, edit through notes (D3) |
| Reads the other engine's memory | no | only through a one-time import extension |

## 3. What Delegatus already has

### 3.1 Prompt composition

A first message is assembled from layers (`docs/design/agent-prompt-contract.md`
§1.2, observed O-code):

- the seat-written brief, the role scaffold with its fences, and the stage
  wrapper with the pinned task and specification
  (`src/lib/pipelines/prompts.ts:31`, `src/lib/roles/defaults.ts`);
- the orchestrator mandate, delivered as an ordinary message
  (`src/lib/orchestrator/prompt.ts:374`);
- MCP server instructions and tool descriptions (`src/lib/mcp/server.ts`).

Every later message passes one delivery entry point
(`src/lib/delivery.ts:728`), and structured deliveries carry a marker with
authorship (`src/lib/runtime/codexStructuredUserText.ts:86`,
`src/lib/runtime/messageOrigin.ts`).

Claude launches receive a settings file Delegatus writes per launch and
passes with `--settings`; it already manages a hook there
(`src/lib/agent/spawnPolicy.ts:227`, `:443-484`).

### 3.2 Memory-like surfaces Delegatus owns

| Surface | What it holds | Where |
| --- | --- | --- |
| Pinned task and specification | the requirement, on every stage of a pipeline | `src/lib/pipelines/prompts.ts:31` |
| Task details | agent-facing context behind one collapsed row | MCP `create_task`, `update_task` |
| Seat monitor note | an orchestrator's working state, up to 16 000 characters | `src/lib/monitor/seatTickSettings.ts:62` |
| Rotation history | a bounded digest handed to a successor seat | `src/lib/orchestrator/handoffDigest.ts:16` |
| Board maintainer log | what the previous maintenance run changed, asked and left alone | `docs/design/board-maintainer.md` |
| Transcript search index | every user and assistant message, both engines, all accounts | `src/lib/search/transcriptSearch.ts` |

### 3.3 Transcript search

`state/transcript-search.sqlite` is an FTS5 index (`unicode61`, diacritics
kept, `#` and `_` as token characters) over message bodies, fed incrementally
by the scanner and exposed as the `search_transcripts` MCP tool
(`src/lib/search/transcriptSearch.ts:10`, `:260`, `:805`). Every role
scaffold ends with a rule to search prior conversations before deciding
(`src/lib/roles/defaults.ts:31`), and the mandate repeats it
(`src/lib/orchestrator/prompt.ts:408`). This is recall by search, done by the
agent, already in daily use: this stage ran nineteen such queries.

### 3.4 Skills

- Five skills ship in the repository under `.claude/skills`.
- Account homes share skills: Codex homes link `skills`, and Claude homes
  link to a copied snapshot (`src/lib/accounts/codex.ts:23`,
  `src/lib/accounts/claude.ts:446`).
- Observed O-disk: 105 skills in the default Claude home, 64 in the
  snapshot, 74 in the Codex home. About one in ten is under 700 bytes: a
  single fact or preference stored as a skill by an external skill-and-memory
  manager. Their descriptions load into the skill listing of every session in
  both engines (observed O-session), so one cross-engine memory channel
  already exists here, outside Delegatus.

### 3.5 How account homes treat memory today

- **Codex.** Managed homes link `memories` to the default home's folder
  (`src/lib/accounts/codex.ts:23`). Each home keeps its own
  `memories_1.sqlite`. Observed O-db: 707, 183, 65 and 0 extracted threads
  across four homes, each with its own usage counters. Four pipelines
  therefore feed and consolidate one folder.
- **Claude.** No code links memory directories. `projects` is private to a
  home unless the shared-store cutover ran
  (`src/lib/accounts/claude.ts:66`). On this machine each managed home has 22
  per-project `memory` links into the default home, all dated 2026-10-01
  (observed O-disk). Their author is unknown (open question 4).
- **One-shot runs.** The ephemeral runner starts Codex with
  `--disable memories` (`src/lib/agent/ephemeral.ts:211`).
- **Merging.** The one-time transcript-store cutover merges two `MEMORY.md`
  files as a union of lines (`scripts/cutover-shared-claude-projects.ts:63`).

### 3.6 Observed during this research: a memory folder emptied itself

At about 19:29 UTC the default Codex memory folder held `MEMORY.md`
(350 KB), `memory_summary.md` and a `.git` baseline committed at 19:25 UTC
with 256 rollout summaries. By 19:33 UTC `MEMORY.md` and `memory_summary.md`
were gone and 14 rollout summaries remained; the baseline shows 255 deleted
paths. The global consolidation job had been running since 19:25:48 UTC and
was still running at 19:41 UTC, with both files still absent. File times in
the folder (19:24 UTC) and an import subtree in the Claude memory stamped two
minutes earlier suggest the folder had just been copied in from another
machine. (observed O-disk, O-db)

This stage ran only read commands there (`ls`, `wc`, `grep`, `sed -n`,
`git log`, `git status`, `git ls-tree`, `git cat-file`; `git status` may
refresh that folder's own git index file). A likely reading is that
consolidation re-synced the folder to this machine's own database, which has
never seen the imported threads. The cause is unconfirmed. The earlier content
is still in the folder's git baseline (open question 5).

The lesson holds either way: an engine's memory folder belongs to that
engine's pipeline and its database, and a copy placed there from outside can
vanish.

### 3.7 The component that already makes decisions

**Identified: the Jev classifier behind "Asks you"**, `src/lib/asks/jev.ts`.

- It calls a decisions endpoint with a `state` and typed questions and gets
  a probability per question (`:14-15`, `:105`).
- It runs on the release that owns traffic, on a sweep beside the seat tick
  (`src/lib/asks/controller.ts`), behind a per-installation switch that is
  off by default with a monthly cap of USD 1 (`src/lib/asks/settings.ts`).
- Measured in `docs/research/attention-classifier.md`: USD 0.042 per million
  input tokens with free output, median latency 0.34 s, 99th percentile
  0.47 s over 4 591 calls, and one request with several questions bills the
  state once.
- Text is redacted before it leaves the machine
  (`redactForClassifier`, `:77`).

Other components that decide, and why they fit worse:

| Component | Decides | Fit for a per-prompt choice |
| --- | --- | --- |
| Orchestrator seat | what to launch and when | a full agent turn per prompt; sees only prompts it writes |
| Board maintainer | board upkeep every few hours | periodic; suits upkeep (section 4.6) |
| Ephemeral runner (`src/lib/agent/ephemeral.ts`) | one schema-bound answer from a full model | seconds of latency and subscription quota per prompt |

The card paraphrases a voice message, so this identification is open
question 1. The first slice (section 6) holds under any answer.

## 4. Design

### 4.1 What the requirement demands, and what already exists

| Requirement | Already covered | Gap |
| --- | --- | --- |
| Decide per prompt which memories to include | Each engine does this for its own store (1.2, 1.3, 2.2). | Neither engine sees the other's store. |
| Check which are actually useful | Codex counts citations (2.3). | Claude has no counter. Nothing joins the two. |
| Do not contradict the engines | — | A constraint on every option below. |
| Unite the memory of both | Instruction files and skills cross engines today (1.1, 2.1, 3.4). | Learned memory stays inside the engine that wrote it. |
| Maintain it additionally | Codex prunes after 30 unused days. | Claude memory only grows; stale entries persist (section 0). |

So the work Delegatus should take on is narrow: make each engine's learned
memory reachable from the other, offer only what the receiving engine lacks,
and keep a ledger of what was offered and what was used.

### 4.2 Options

| Option | Description | Verdict |
| --- | --- | --- |
| A. Join the stores on disk | Link or copy one engine's folder into the other, or feed Claude memory to Codex through its import extension. | Rejected. Formats differ, the Codex folder is generated state (D3), the import is undocumented and one-way, and a transplanted folder emptied itself today (3.6). |
| B. Replace native memory | Disable both, keep one Delegatus store, inject it. | Rejected. Contradicts both engines, discards their recall and pruning, and breaks with each engine update. |
| C. Put everything in instruction files | Promote memories into `AGENTS.md`. | Rejected for volume: 32 KiB cap in Codex (D4), a 200-line target in Claude (D1). This repository is public. Remains the right home for rules that must hold. |
| **D. Index both stores, offer across engines** | Read both stores into a Delegatus index; offer cross-engine entries on demand and, later, per prompt; record use. | **Chosen.** Engines stay sole writers of their stores. |

### 4.3 The shared store is an index plus a ledger

A derived SQLite database in the state directory, `memory-index.sqlite`,
built the way `transcript-search.sqlite` is built: incremental by file
modification time, rebuildable from nothing, owned by the Viewer process.

One row per entry:

| Field | Claude source | Codex source |
| --- | --- | --- |
| `id` | hash of engine, source path and anchor | same |
| `engine` | `claude` | `codex` |
| `scope` | project, from the memory directory's encoded path through `projectInfoFromCwd` | project, from the `cwd` on the task group's source lines; global for summary-level preferences |
| `kind` | `type`: `user` and `feedback` → preference, `project` → project fact, `reference` → reference | section heading: preferences, reusable knowledge, failures |
| `title`, `summary` | `name`, `description` | task title, the bullet |
| `body` | file body, capped at 2 KB with a pointer to the source | the bullet with its group's keywords |
| `writtenAt` | `modified`, else file time | the group's newest `updated_at` |
| `flags` | missing path, foreign home path, redacted secret, retired | same |

Rules:

- **Unit.** One Claude topic file is one entry. One Codex bullet is one
  entry and carries its group's scope and keywords.
- **Parsers fail closed.** A file whose shape the parser does not recognise
  is skipped and counted. The formats are observed, undocumented and
  changing (1.3).
- **Redaction at ingest.** Entries pass the same redaction
  `conversation_messages` applies before any text is stored or returned.
- **No copy of an engine's database.** Codex usage counters are read from
  citation blocks in transcripts, which Delegatus already indexes. The
  per-account databases have a private schema.

The ledger, one table in the same file:

`memory_offers(memory_id, conversation_id, at, channel, score, outcome, outcome_at)`

`channel` is `search` or `inject`. `outcome` starts empty and becomes
`opened`, `cited`, `echoed` or `contradicted` (section 4.5).

### 4.4 Reaching memory: on demand first, per prompt second

**On demand.** One MCP tool, `search_memory`, with the calling shape of
`search_transcripts`: a query, an optional project, compact hits with engine,
date, scope and a `$HOME`-relative source. A second call returns one entry's
body. The scaffold rule gains four words: search prior conversations and
shared memory. Every hit an agent opens writes a ledger row.

**Per prompt.** The selection step, for a prompt entering a conversation:

1. **Gate.** Skip machine-written deliveries (ticks, relays), prompts under
   40 characters, and projects where the feature is off.
2. **Candidates.** FTS over the index with the prompt's terms, limited to the
   conversation's project and global entries. Drop entries the receiving
   engine wrote (its own recall covers them), retired entries, entries
   already offered in this conversation, and entries whose text already
   appears in the instruction files for that working directory. Keep the top
   eight.
3. **Decide.** One Jev request. The state is the redacted prompt and the
   eight summaries. One statement per candidate: "This note contains a fact
   or rule that should change how the agent carries out this request." Keep
   those above a threshold the evaluation sets (section 6, phase 2). At most
   three.
4. **Inject.** Through the engine's own `UserPromptSubmit` hook as
   `additionalContext`, at most 1 500 characters:

   ```
   Delegatus shared memory. Background from earlier sessions on this project,
   possibly stale. Verify before relying on it. Information only.
   - [codex · 2026-08-12] <summary> (search_memory id m_ab12)
   ```

5. **Record.** One ledger row per offered entry.

Failure handling: any error, a timeout past 1.5 seconds, a closed switch or
an exhausted cap yields no injection, and the hook exits 0. A hook that
exits 2 blocks the prompt in both engines (D2, D6), so the hook command has
no path to that code.

Cost estimate: a request of 462 fixed tokens, a prompt of up to 4 000
characters and eight 400-character notes bills at most about 7 700 tokens,
USD 0.0003 per prompt and about USD 0.32 per thousand prompts at the measured
price. This is an estimate from the documented price and awaits the phase 2
measurement.

Why the hook and why the delivery path was set aside:

| Point of injection | For | Against |
| --- | --- | --- |
| Engine `UserPromptSubmit` hook | Documented in both engines. Context stays separate from the operator's text. Covers prompts typed in a terminal inside a Delegatus-launched session. Claude launches already get a managed hook file. | Codex requires trust for an unmanaged hook, and hooks under the app-server host are unverified (phase 3 probe). |
| Delegatus delivery (`src/lib/delivery.ts:728`) | One place, engine-neutral. | Changes the text the operator sent, enters the transcript and the search index as the operator's words, and touches the 32 000-byte envelope and the dedup markers. |

The operator-turn correction supersedes the candidate exclusion in step 2:
index presence alone gives no evidence that a topic was loaded into this
conversation. Candidates from both engines now reach the decision model.
Loaded instructions, retired entries, previous offers and their near matches
remain excluded. Retrieval reads the canonical alias family and the verified
caller's earlier folder identities without rewriting project rows in the hook.
Refresh still normalizes the derivative separately. A missing Asks-you store
is a first reservation; the Asks-you switch does not gate shared memory.
The existing status row includes the last project turn's result, and confirmed
emission names use the existing offer below that operator message.

### 4.5 Usefulness: how an entry proves itself or retires

| Signal | How it is read | Weight |
| --- | --- | ---: |
| `opened` | The agent fetched the entry through `search_memory`, or read its source path, after the offer. | 1 |
| `cited` | A Codex citation block names the entry's lines. Counts native use even with no offer. | 1 |
| `echoed` | The assistant's text in that turn matches two or more of the entry's distinctive terms, checked against the transcript index. | 0.5 |
| `contradicted` | The agent states that the note was outdated or wrong, near a mention of it. Section 0 shows agents do say this. | flags |

- **Score.** Weighted uses divided by offers, shown once an entry has five
  offers.
- **Retire.** Eight offers with no use; two contradictions; a missing source
  file; a missing-path flag on an entry older than 90 days. Retiring stops
  the offering and nothing else. The source file is untouched, and a change
  to it revives the entry.
- **Review.** A list for the operator: most used, never used, retired,
  flagged. This is the answer to "check which ones are actually useful".

### 4.6 Maintenance

- **Refresh.** The scan that feeds the transcript index also feeds this
  index. No new clock.
- **Upkeep.** The board maintainer's brief gains a short memory section:
  retire candidates, and pairs of entries from different engines in one
  project that match closely and disagree. It raises attention lines for the
  operator and changes nothing itself.
- **Settled rules.** An entry both engines keep using is a candidate for the
  project's instruction file. The operator promotes it by hand, through the
  publication gate.

### 4.7 Coexistence: who writes where

| Store | Writer | Delegatus |
| --- | --- | --- |
| `CLAUDE.md`, `AGENTS.md` | people, and agents when asked | reads; links the global files into account homes (exists) |
| Claude memory directory | Claude Code | reads and indexes |
| Codex `memories/` | Codex's pipeline | reads and indexes |
| Codex ad-hoc notes | Codex's own tool, on the user's request | reads and indexes |
| `memory-index.sqlite` | the Viewer | new; derived; safe to delete |

Rules that keep the peace:

1. Delegatus writes nothing inside an engine's memory directory and moves
   no memory folder between homes or machines.
2. Native memory stays enabled. The one existing exception stays: one-shot
   ephemeral runs.
3. An engine is offered only entries the other engine wrote.
4. Offered text is framed as background that may be stale, which matches how
   both engines frame their own memory (D1, and the Codex read path in 2.2).
5. Injection stays far under engine caps: 1 500 characters against 10 000
   (D2) and 2 500 tokens (D6). The 200-line index and the 32 KiB instruction
   cap are untouched.
6. Rules that must hold live in instruction files, as both vendors advise
   (D1, D3).

Conflicts and duplicates:

- **Two entries disagree.** Each offer carries its engine and date. The
  upkeep pass surfaces the pair. The operator settles it in an instruction
  file.
- **Duplicates.** Exact duplicates collapse on a normalised-text hash.
  Near-duplicates across engines are offered once, newest first.
- **Already known.** The candidate filter in 4.4 step 2 keeps out what the
  receiving engine or the instruction files already hold.

## 5. Risks

| Risk | Evidence | Answer in this design |
| --- | --- | --- |
| **Privacy: a public repository.** Memories hold names, paths and pointers to credentials. | Types and descriptions seen while counting (O-disk). | Memory text never enters the repository. The index lives in the state directory. Tests use synthetic fixtures. Tool output uses `$HOME`-relative paths. |
| **Privacy: text leaving the machine.** Per-prompt selection sends the prompt and eight summaries to an outside vendor. | `docs/research/attention-classifier.md` §7 on retention. | A separate switch, off by default, with the existing redaction. Phase 1 sends nothing. Open question 2. |
| **Privacy: across installs.** | Linked installs sync board data. | The index and ledger never cross a link. |
| **Poisoned memory.** A note written after an agent read hostile content can carry instructions; sharing widens its reach to the other engine. | Codex guards its own pipeline with a pollution mark (2.3). | Offers are framed as information. Entries from polluted threads are skipped. Kinds are limited to the four mapped in 4.3. |
| **Prompt bloat.** | Always-loaded memory here: an 11.3 KB summary in Codex, up to 25 KB of index in Claude, plus instruction files and a role scaffold. | Three entries and 1 500 characters at most, nothing when no candidate passes, each entry once per conversation. |
| **Stale memory.** | Section 0: a dead path, a superseded destination, memory from another machine. | Date on every offer; missing-path and foreign-home flags at ingest; contradiction signal; retirement. |
| **Cross-project leakage.** | Codex memory is global across projects by design. | Delegatus scopes every entry to its project and offers global entries only when the source marks them global. Open question 3. |
| **Engine internals move.** | Undocumented features in both binaries (1.3, 2.2). | Depend on documented surfaces (hooks, settings) and on file shapes read by parsers that fail closed. |
| **Shared Codex folder, split databases.** | Four homes, one folder (3.5); the folder emptied itself (3.6). | Out of this feature's path, and a hazard today. Phase 0. |
| **A young vendor and an alpha endpoint.** | The classifier research names a fallback model. | Selection sits behind one function with a local fallback of no injection. |
| **A hook that blocks prompts.** | Exit code 2 blocks (D2, D6). | The hook command always exits 0 and has a hard timeout. |

## 6. Phased plan

**Phase 0 — make today's memory safe (investigation, then small fixes).**

- Reproduce 3.6 in a private Codex home: one folder shared by two homes
  with separate databases. Decide whether managed homes keep linking
  `memories`.
- Give Claude accounts one memory directory per project through the
  documented `autoMemoryDirectory` in the per-launch settings, replacing the
  hand-made links, once open question 4 is answered.

**Phase 1 — the smallest slice that delivers value: read-only index and
`search_memory`.**

- Builds: the two parsers, the index, the ledger table, one MCP tool with
  two calls, four words in the scaffold rule.
- Value: an agent on either engine can find what the other engine learned
  about the project, through a habit agents here already have. The ledger
  starts counting from the first day.
- Leaves out: any model call, any injection, any text leaving the machine,
  any write to an engine's store.
- Acceptance: a Codex stage finds a fixture Claude memory by query and a
  Claude stage finds a fixture Codex bullet; an entry scoped to project A is
  absent from a search in project B; an unrecognised file is skipped and
  counted; a secret-shaped string in a fixture is returned redacted; opening
  a hit writes one ledger row.

**Phase 2 — proof and price for per-prompt selection (research, paid cap).**

- Replay a sample of real first prompts from the transcript index against
  the phase 1 index. Label which candidate entries would have helped.
- Compare three deciders: FTS rank alone, Jev, and no injection. Report
  precision at three entries, latency and spend, in the manner of the
  attention-classifier study.
- Go on only if a decider beats FTS rank alone by a margin worth the
  outbound text.

**Phase 3 — per-prompt injection, Claude first.**

- A probe confirms the hook fires and its context lands for Claude under the
  stream host, then for Codex under the app-server host with a trusted hook.
- Per-project switch, the ledger from 4.4, a line in the conversation view
  naming what was offered.

**Phase 4 — usefulness and upkeep.**

- Outcome detection, scores, retirement, the operator's review list, the
  maintainer's memory section.

## Deferred — not currently justified

- **A writable Delegatus store and a `remember` tool.** Both engines already
  save on request, and a third write path would compete with them.
- **Writing into native stores**: Codex ad-hoc notes or Claude topic files
  authored by Delegatus.
- **Feeding Claude memory to Codex through its import extension.**
  Undocumented, one-way, and absent here.
- **Embeddings or a vector index.** FTS serves `search_transcripts` at this
  corpus size.
- **A model-judged "did the reply rely on this note" check.** Three cheap
  signals come first.
- **Automatic promotion into `AGENTS.md`.** Public repository; the operator
  promotes by hand.
- **Memory sync across machines or linked installs.**
- **Other engines** (Copilot, OpenClaw) and Claude subagent memory.
- **Indexing single-fact skills.** They already reach both engines through
  the skill listing.

## Validation against the requirement

| Quote | Where answered |
| --- | --- |
| "Study how memory works in Claude Code and in Codex, in code and in documentation." | Sections 1 and 2, each claim marked. |
| "Make Delegatus's component that already makes decisions decide, whenever anyone writes a prompt, which of all memories are worth including" | Component identified in 3.7; the selection step in 4.4; gated on the phase 2 proof. |
| "and check which ones are actually useful" | Ledger and signals in 4.5; counting starts in phase 1. |
| "Do not contradict what Claude Code or Codex do themselves." | Option D and the six rules in 4.7. |
| "improve it by uniting the memory of both" | The index over both stores (4.3) and cross-engine offering (4.4). |
| "and maintain it additionally" | 4.6 and phase 4. |
| "Start with research only." | This document. No product change. |

One place departs from the quote on purpose: per-prompt selection is phase
3, after a search tool and a measurement. Both engines already select from
their own stores per prompt, the decider is unproven for this job, and the
search tool is the piece every later phase needs.

## Open questions for the operator

1. **Which component did you mean by "already makes decisions"?**
   Options: the Jev classifier behind "Asks you"; the orchestrator seat; the
   board maintainer. Recommendation: Jev for the per-prompt choice and the
   maintainer for upkeep. Phase 1 is the same under every answer.
2. **May a prompt and eight memory summaries leave the machine for
   selection?** Options: yes, per project, with the existing redaction;
   local ranking only; a full model on your own subscription through the
   ephemeral runner, at seconds per prompt. Recommendation: decide after
   phase 2 shows what the outbound text buys.
3. **How far may a memory travel between projects?** Options: its own
   project only; its own project plus entries the source marks global; every
   project. Recommendation: the second.
4. **Who created the per-project `memory` links in the managed Claude homes
   on 2026-10-01, and should Delegatus own that sharing?** Recommendation:
   yes, through `autoMemoryDirectory` in the per-launch settings.
5. **The Codex memory folder lost its registry and summary during this
   research (3.6).** Do you want the earlier content restored from that
   folder's git baseline, and should managed Codex homes keep sharing one
   folder? Recommendation: let the running consolidation finish, compare
   against the baseline, then run the phase 0 reproduction before changing
   the link.
6. **Retirement: automatic or proposed?** Options: Delegatus stops offering
   an entry on its own and lists it; every retirement waits for you.
   Recommendation: automatic, since it is reversible and touches no file.
7. **Should the "Memory" block of the global instruction files and the
   single-fact skills join the index?** Recommendation: no. Both engines
   already load them.
