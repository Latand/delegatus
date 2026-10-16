# One memory per installation: a switch between Delegatus memory and the engines' own memory

Status: design, no product change. Written 2026-10-16 against `main` at
`e200f9c59`; every `file:line` is from that commit. `origin/main` has since
moved to `99211e151`, which changes only `docs/design/role-avatars.md`, so no
cited line moved. Live records were read once, read-only, at 2026-10-16
16:10:43 UTC (the appendix says how); the engine memory stores were read for
metadata only (sizes, line counts, frontmatter type and session fields,
modification times, content hashes). No memory text and no rule text is quoted here.
Projects other than this repository are named by letter, as in
`docs/design/memory-quality-benchmark.md`: A is this repository, B an ERP
customization, C a bot and web-app product, D a dispatching web application,
E and F two small projects.

## Originating requirement

Operator, 2026-10-16. The idea came in the seat conversation at 15:48 UTC
(dictated, in Russian), and the decision form on task 97f2370c settled it at
15:53 UTC; the earlier form of the same task (answered 15:37 UTC) asked how
the engines' memory reaches agents, what it holds, how it would be switched
off and what switching it off is for. The words are private operator speech,
so this document paraphrases them in English and keeps date and provenance
(the seat conversation and the form round, both held on this machine). The
requirement:

1. One memory per installation, chosen by a switch: either Delegatus memory
   (learned rules, their levels, the curator) or the engines' own memory
   (Claude auto memory, Codex memories).
2. When the switch moves to Delegatus memory, the engines' memory is turned
   off, and what it has accumulated is brought into Delegatus memory through
   the curator. Historical detail that does not survive the import is left to
   transcript search.
3. Design first. Which position is the default is chosen after one week in
   Delegatus mode, compared with the week before; no paid replay runs for this
   question.
4. The orchestrator's own notes, which today live in Claude's memory
   directory, move into the orchestrator's role memory through the curator.
5. The rule budgets may be raised if more volume is needed; the operator was
   unsure by how much.

The operator also named the doubt behind the trial: with Delegatus memory
alone, the mechanism the engines use, which may help, is lost, and it is not
obvious how to test that. The default answer to "should we build this" is no
unless the requirement demands it. It demands a switch, an import and a
trial; everything else this document considered is in "Deferred".

## 0. Earlier work this builds on

`search_transcripts` (project-scoped, then unscoped) and `search_memory` for
the switch, engine memory, the import and the curator found the lane's own
conversations, the memory-quality benchmark lane and the designs below; the
memory index held nothing on the subject.

| Earlier work | What it settled | What this design changes |
| --- | --- | --- |
| `docs/design/memory-quality-benchmark.md` (2026-10-16) | Inventory of every memory path; engine memory reaches stages ungoverned (§1.4, §3.5); a full builder scope evicts uncurated lessons within minutes; the delivery ledger is missing (§4.4) | Its item 8 (engine memory off for stages, kept for seats) is superseded by the operator's switch; its §4.2 metrics become the trial's |
| `docs/design/orchestrator-role-memory.md` (2026-10-12) | Seats read and write role rules through `leave_lesson`; deferred "importing the seat's private notes automatically" and "turning the engine's own memory off for the seat" | The operator's 2026-10-16 answer lifts both deferrals |
| `docs/design/role-memory-curation.md` (2026-10-11) | Four levels and their boundaries (§3.0), the 10 000-character bound and the leaving order (§3.2), the curator's checks (§3.6) | The curator gains candidates to adopt or drop |
| `docs/design/agent-memory.md` (2026-10-02) | Facts about Claude auto memory (§1.2): which setting turns it off, which directory a worktree reads, the 200-line or 25 KB load | Used as the basis for the off switch |
| Task a70effa6 (planned 2026-10-16, held for a worker slot) | A delivery ledger row per engine start, with hashes of the engine memory files loaded; no budget eviction of a lesson the curator has not seen; an early pass at 90 % | Used as planned; this design changes nothing in it. The trial needs both parts (§6.5) |

## 1. What exists today

This section answers the operator's 15:37 question: how the engines' memory
reaches an agent, what it holds, how it is switched off, and what switching
it off changes.

### 1.1 Who receives which memory

| Conversation | Learned rules (Delegatus) | Engine memory | Shared recall memory |
| --- | --- | --- | --- |
| Pipeline stage of a non-clean role | Four scopes, whole, at every engine start (`src/lib/memory/roleLaunch.ts:33-42`, `roleStore.ts:109-111`, `:180-192`); a lesson request on its report (`roleStage.ts:45-53`) | Claude: the repository's `MEMORY.md` index, worktrees included. Codex: the memories summary | `search_memory` on demand; the injection hook on a later human turn only |
| Clean stage: reviewer, verifier, issue reporter, curator, any stage with a fail edge (`src/lib/memory/eligibility.ts:11-24`) | None | Off: `autoMemoryEnabled: false` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` (`src/lib/agent/spawnPolicy.ts:531`, `:534`); Codex `memories=false` (`src/lib/runtime/codexAppServerHost.ts:1489-1490`, `src/lib/codexHeadlessConfig.ts:157`) | Hook off (`controller.ts:51-53`) |
| Designated seat and board maintainer | Their role scopes, project, machine (`src/lib/agent/registry.ts:6320-6338`); the seat writes with `leave_lesson` (`roleStage.ts:158-176`) | As a non-clean conversation; the Claude seat writes its own notes there | As above |
| The operator's own conversation launched by Delegatus (no role) | None: the only setters of a selector are the pipeline engine for stages and `registry.ts:6320-6338` for seats and maintainers (`memory-quality-benchmark.md` §1.2) | As a non-clean conversation | The per-project injection hook, when the project is switched on |

One decision already serves every path: `cleanMemory` on the launch profile
turns off learned rules, the shared-memory hook and engine memory together
(`eligibility.ts:3-7`). Two more switches exist: `LLV_ROLE_MEMORY=off` stops
lesson requests, rule delivery and the curator
(`src/lib/memory/settings.ts:25-30`, read at `roleStage.ts:32`, `:50`,
`:139`, `:160`, `roleLaunch.ts:35`, `curation/admission.ts:21`), and
`shared-memory-settings.json` holds the per-project injection switch
(`settings.ts:9-23`).

### 1.2 The engine memory stores, measured

**Claude auto memory.** One directory per repository under the native Claude
home, `projects/<slug>/memory`; a pipeline worktree reads its parent
repository's directory (`agent-memory.md` §1.2; this stage received this
repository's index in its own context). Both Claude account homes link their
project memory entries into the native home: one account home holds 24
entries of which 22 are links, the other 22 of 22. Claude loads the first 200
lines or 25 KB of the index at start and reads topic files on demand.

| Store | Index | Topic files | Notes |
| --- | ---: | ---: | --- |
| A, root of the directory | 8,620 bytes, 54 lines, 50 pointers | 50 (31 feedback, 11 reference, 8 project; 98,100 bytes, median 1,681) | Writers, by the session each file names: 39 sessions in the repository checkout (the seat and the operator's own), 9 pipeline worktree sessions (stages), 2 unrecorded. 24 files changed since 2026-10-09 |
| A, nested subtree | its own index | 214 (87 feedback, 99 project, 28 reference) | A copy of the directory this repository used before the rename: 213 of 214 files are byte-identical to it, and that directory last changed on 2026-10-01 |
| B, C, D, F | 7,735 / 18,703 / 4,335 / 581 bytes | 48 / 91 / 21 / 26 | B and F hold 18 and 12 nested duplicates |
| The home folder | 6,456 bytes | 40 | Sessions started in the home folder |
| 16 more directories | | 39 in all | Projects with no Delegatus pipelines; several are empty |
| All 23 directories | 21 indexes, 72,135 bytes | 743 (337 feedback, 294 project, 109 reference, 2 user, 1 untyped); median 1,545 bytes, p90 2,715 | 1,369,465 bytes of topic files |

**Codex memories.** One folder in the native Codex home; all three managed
Codex homes link to it, and every home's configuration has the feature on,
generation off and use on. With generation off, the summary Codex loads has
not changed since 2026-10-01; the folder's own history ends 2026-10-01 19:25
UTC (the registry file was last modified on 2026-10-11).

| File | Size | Loaded at start |
| --- | ---: | --- |
| `memory_summary.md` | 11,302 bytes, 143 lines, 15 sections, 66 bullets | Yes, into the developer instructions of every non-clean Codex conversation (`memory-quality-benchmark.md` §1.4) |
| `MEMORY.md` registry | 350,909 bytes, 90 task groups, 1,037 bullets | On demand |
| `raw_memories.md` (1,018,338 bytes), a recovery dump (193,806 bytes), 298 rollout summaries and three loose files | | No |
| Whole folder | 4,438,433 bytes | |

**Who received it last week.** In the 7 days to the read, 1,729 stage starts
were non-clean and so received learned rules and, where their project has a
store, engine memory: 1,127 Codex, 602 Claude. By project and engine: A 718 Codex and 385 Claude, B 154
and 16, C 161 and 86, D 86 and 107, E 3 and 7, F 5 and 1. At current sizes
that is 18.3 MB of engine memory in the week (Codex 1,127 × 11,302 bytes =
12.7 MB; Claude, each start times its project's index, 5.5 MB), beside 25.4
MB of learned rules (14,678 bytes per start on average). Seats and the
operator's own conversations come on top; no record counts their starts
until the a70effa6 ledger exists.

**What it holds that stages should not read.** The benchmark observed
seat-only directives (deploying, cutting releases, the worker cap) arriving
in a read-only architect stage through this repository's index
(`memory-quality-benchmark.md` §1.4, §3.5). In the other direction, nine of
the 50 root notes were written by stages into the directory the seat and
every other stage read.

### 1.3 Facts the design depends on

- **The curator runs one pass at a time on the machine**
  (`src/lib/memory/curation/store.ts:128-129`), with a 30-minute claim cooldown
  per project (`store.ts:132`), and only for a project whose designated seat
  has a live host and a delivered wake within two intervals
  (`curation/admission.ts:28-43`). In the last 7 days it ran 72 passes (68
  succeeded, 4 failed; median 10 minutes, p90 22.5).
- **The curator reads a scope in 24 KB pages** (`curation/read.ts:11`, `:60-72`)
  and today has no operation that creates a rule from outside text; `split`
  is the nearest (`curation/apply.ts:13-22`).
- **The memory index already discovers and parses every engine store**:
  `discoverMemorySources` resolves links so a shared store is read once
  (`src/lib/memory/sources.ts:15-89`), and `parseMemory` reads Claude topic
  files, Codex summary bullets and the registry (`parsers.ts:27-135`). It
  stores bodies clipped to 2 KB and redacted (`index.ts:215-216`), so the
  import reads the files again in full.
- **A curator pass can be undone as a whole** from the rules window
  (`curation/apply.ts:206`, `src/app/api/role-memory/route.ts:30-34`).

## 2. Choices settled here, with reasons

1. **Scope: the installation.** The operator asked for one memory per
   installation; a per-project switch would bring back two memories on one
   machine. Deferred.
2. **Two positions, Delegatus and Claude and Codex, plus the state before the
   first choice.** Until an installation chooses, it keeps today's behaviour
   (both memories), so the change lands without moving anyone. The first
   choice can only be Delegatus (the switch starts off and turning it on
   starts the import); after that it moves freely between the two positions.
   The default an unchosen installation gets is set after the trial (§7,
   slice 7).
3. **The Claude and Codex position stops Delegatus memory the way
   `LLV_ROLE_MEMORY=off` does**: no lesson requests, no rules at start, the
   curator paused, the store kept. The operator described the two as either
   one or the other.
4. **The decision is read at every engine start**, from the installation
   setting, and never stored on the launch profile. A resumed seat follows
   the switch at its next engine start; a running process keeps what it
   loaded until then. No running agent is interrupted.
5. **Clean launches stay clean in every position.** Reviewers keep reading
   nothing, so the judge of the trial is the same in both weeks.
6. **Import first, then turn the engines off.** While the import runs the
   engines' memory stays on, so no agent starts with neither memory. The
   switch turns the engines off once every candidate the engines loaded at
   start has a disposition (§4.6).
7. **The operator's own conversations get Delegatus memory too**: the project
   and machine rules at start, and `leave_lesson` at those levels. With the
   engines off they would otherwise start with no memory, and keeping the
   engines on for them would be two memories.
8. **Shared recall memory stays as it is in both positions.** `search_memory`
   and the per-project injection read the engine stores as history; in
   Delegatus mode those stores stop changing. This is where the operator
   placed historical detail.
9. **Budgets stay as they are through the trial**, except one sentence of the
   curator brief for the orchestrator's import (§5.5): the trial measures one
   change.
10. **Delegatus never writes the engine stores or the operator's engine
    configuration files.** Every off switch is per launch, as the clean path
    already does it, so returning to the engines' memory finds their stores
    exactly as they were.

## 3. The switch

### 3.1 Storage

One installation file, `memory-source.json` under the state directory,
written with `writeJsonDurably` and read through an mtime-and-size cache, the
shape `src/lib/operator/settings.ts:51-107` uses for the operator's language:

```ts
type MemorySourceFile = {
  schemaVersion: 1;
  source: "delegatus" | "engines";
  changedAt: string;
  /** Present while, and after, the switch moved to Delegatus memory. */
  importId?: string;
  phase?: "importing" | "active";
  importStartedAt?: string;
  activeAt?: string;          // the moment engine memory went off: the trial clock starts here
};
```

A missing or malformed file reads as "not chosen". `memorySource()` in
`src/lib/memory/source.ts` returns `{ choice, phase }`, and two functions
read it:

- `engineMemoryOff({ cleanMemory })`: true for a clean launch, and for every
  launch when `choice === "delegatus" && phase === "active"`.
- `roleMemoryEnabled()` (`settings.ts:28-30`): false when
  `LLV_ROLE_MEMORY=off` or `choice === "engines"`. Every existing caller
  (requests, delivery, curator, `leave_lesson`) follows without change.

The route is `/api/memory/source`, GET and PUT, with the guards of
`/api/memory/settings` (`rejectCrossOrigin`, `requireOperatorAuthority`,
`src/app/api/memory/settings/route.ts:17-18`). A PUT to Delegatus from "not
chosen" or from the engines position writes `phase: "importing"` and starts
the import job; a PUT to the engines position takes effect at once and leaves
the import record in place. During the import it stops the import passes, and
the pending candidates wait for the next switch to Delegatus. The import
record keeps its counts by state, updated with each disposition, so the
row's read every 15 seconds while the menu is open costs one small file.

### 3.2 Every place that decides engine memory

The off switch must reach every producer of Claude settings and Codex
configuration. At `e200f9c59` they are:

| Launch path | Where it decides today | In Delegatus mode |
| --- | --- | --- |
| Structured Claude (stages, seats, operator sessions) | `claudeStreamBrokerHost.ts:898` → `applyClaudeSpawnPolicy` (`spawnPolicy.ts:438`, flags at `:531`, `:534`) | `autoMemoryEnabled: false` and the env flag from `engineMemoryOff` |
| Claude tmux spawn | `src/lib/agent/spawnCommand.ts:1035` (passes no `cleanMemory`) | Same |
| Claude resume and terminal specs | `src/lib/agent/cli.ts:172`, `:370`, `:566` | Same |
| Claude account terminal | `src/lib/accounts/terminalLaunch.ts:32` for a provider account; plain terminals at `:28` and `:30` write no settings | Same for the provider account; the plain terminals gain `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in their command |
| Claude headless reviewer | `src/lib/agent/headless.ts:310`, `:346` | Already clean |
| Structured Codex app-server | features at `codexAppServerHost.ts:1489-1490`; thread config at `:1578-1588` → `codexHeadlessConfig.ts:157` | `features.memories=false` on the app-server and the thread |
| Account app-server thread resume | `src/lib/accounts/codexAppServer.ts:431` (passes no clean flag) | Same thread override |
| Codex terminal command | `cli.ts:604-617`; `terminalLaunch.ts:39-40` | `-c features.memories=false` |
| Ephemeral Codex runs | `src/lib/agent/ephemeral.ts:225` | Already `--disable memories` |

Adoption at startup (`src/lib/runtime/startup.ts:1906`, `:2308`) and account
migration (`src/lib/accounts/migration/provider.ts:375`, `:511`) start their
engines through the same hosts, so they follow without change of their own;
the table test of slice 1 reaches them through the hosts.

The learned rules and the shared-memory hook keep reading `cleanMemory`
alone (`spawnPolicy.ts:491`, `codexAppServerHost.ts:1466`, `:1620`,
`claudeStreamBrokerHost.ts:923`), so turning the engines off never turns
Delegatus memory off with them.

### 3.3 What changes for each kind of conversation

| Conversation | Not chosen (today) | Delegatus | Claude and Codex |
| --- | --- | --- | --- |
| Non-clean pipeline stage | Rules, lesson request, engine memory | Rules and lesson request; engine memory off | Engine memory; no rules, no lesson request |
| Clean stage | Nothing | Nothing | Nothing |
| Designated seat, board maintainer | Rules, `leave_lesson`, engine memory (the Claude seat writes notes there) | Rules, the imported notes among them; `leave_lesson`; engine memory off. The seat's pointer text says its engine memory is off on this installation and that `leave_lesson` is its only memory that lasts (`roleRender.ts:15`) | Engine memory; no rules; `leave_lesson` refused with `LESSON_SWITCHED_OFF` (`roleStage.ts:160`) |
| The operator's own Delegatus-launched conversation | Engine memory; injection hook per project | Project and machine rules at start, with a notice of its own; `leave_lesson` with scope project or machine; engine memory off; injection hook unchanged | Engine memory; injection hook |
| Curator | Runs | Runs, with import passes | Paused (`admission.ts:21`) |
| A conversation started outside Delegatus with the operator's own engine homes | Engine memory | Unchanged: Delegatus edits no engine configuration file | Unchanged |

For the operator's conversations, the selector is the existing text-free
marker with `roleId: null`, which already reads the project and machine
scopes (`roleStore.ts:109-111`). It is set at spawn and re-derived on resume
in the block that sets the seat's (`registry.ts:6320-6338`) for a root
conversation with no role and no parent, and only while the source is
Delegatus. The block's notice and pointer for this reader are new text in
`roleRender.ts:47-58`: the stage notice (`:13`) speaks of finishing stages and
the stage pointer (`:12`) of `stage_report`, neither of which an operator
conversation does. `leave_lesson` admits such a conversation in the binding
(`src/lib/mcp/bindings.ts:2564-2580`) with a new source origin `operator`,
scope `project` or `machine` only, and the same text guards as a seat
(`roleStage.ts:158-176`).

### 3.4 Where the operator finds it

The header menu's Settings page already carries installation-wide rows
beside the per-project ones: the worker limit is one, drawn inline with an
icon, a title and a muted state line (`WorkerLimitChip.tsx:143-182`, listed at
`HeaderMenu.tsx:140`, `:327`). The switch is one more row of that kind, placed
right after Shared memory in both item lists
(`src/components/headerMenu/headerMenuModel.ts:44`, `:52`), with the existing
`SettingSwitch` (`src/components/ProjectSettingRow.tsx:41`) as its control
and an icon distinct from Shared memory's. It shows on the overview too,
because the setting belongs to the installation. No new page, popover or
dialog.

| State | Switch | Title | State line (en / uk) |
| --- | --- | --- | --- |
| Not chosen | off | Delegatus memory / Пам'ять Delegatus | Off: agents use Claude's and Codex's own memory and Delegatus rules together. Turn on to keep one memory. / Вимкнено: агенти мають і власну пам'ять Claude та Codex, і правила Delegatus. Увімкніть, щоб лишилася одна пам'ять. |
| Importing | on | same | Importing Claude and Codex notes through the curator: 120 of 351. Their memory stays on until this finishes. / Імпорт нотаток Claude і Codex через куратора: 120 з 351. Їхня пам'ять працює, доки імпорт не завершиться. |
| Delegatus | on | same | On: agents remember through Delegatus rules. Claude's and Codex's own memory is off. / Увімкнено: агенти пам'ятають через правила Delegatus. Власна пам'ять Claude і Codex вимкнена. |
| Claude and Codex | off | same | Off: agents use Claude's and Codex's own memory. Delegatus rules are paused. / Вимкнено: агенти користуються власною пам'яттю Claude і Codex. Правила Delegatus на паузі. |

The two off states differ in their words, which is what tells them apart. A
press moves the switch and the line at once and sends the PUT in the
background; a refused write puts the switch back and shows the failure in the
same line, as `ProjectSettingRow`'s `failed` state does. Only the import's
counts are the server's to compute and arrive with the next read. The
learned-rules window keeps its banner for `LLV_ROLE_MEMORY=off`
(`LearnedRules.tsx:379`) and shows, in the engines position, that the rules
are paused by the Settings row of that name.

## 4. The import

### 4.1 Sequence

1. **The operator turns the switch on.** The setting becomes
   `delegatus/importing` with a new `importId`. Engine memory stays on.
2. **Backup** (4.2), then **candidates** (4.3, 4.4), in a background job
   registered with the loop monitor under its own operation label; nothing
   runs on a request.
3. **Import passes** (4.5): the curator adopts or drops every candidate, the
   ones the engines loaded at start first.
4. **The flip** (4.6): when every loaded-at-start candidate has a
   disposition, the setting becomes `delegatus/active` with `activeAt`, the
   stores are scanned once more for files changed since the backup, and
   engine memory is off from the next engine start of every conversation.
5. The remaining candidates (nested subtrees, deltas) are curated after the
   flip by the same passes.

### 4.2 Private backup before anything is turned off

- **What**: every engine memory directory, each physical directory once
  (resolved by `realpath`, as `sources.ts:15-24` does): the 23 Claude
  directories of the native home, the two real directories of one account
  home, and the Codex memories folder. About 1.4 MB of Claude files and 4.4
  MB of Codex files today.
- **Where**: the state directory, `backups/engine-memory/<importId>/`, mode
  0700 and files 0600, never under a checkout. A manifest lists each file's
  path relative to its engine home, engine, kind, size, modification time and
  SHA-256.
- **Check**: the job re-hashes each copy against its source before any
  candidate is written; a mismatch stops the import with the switch back off
  and the reason in the state line.
- **Bound**: the newest five backups are kept; an older one is removed only
  by path from its own manifest (never by pattern).
- **The engine stores are only read.** The import writes nothing into them.

### 4.3 Inputs, and what is dropped before the curator

| Source | Becomes | Count at the read | Why |
| --- | --- | ---: | --- |
| Claude topic files, every directory | One candidate per file, whole body up to 8 KB (the largest file is 8,655 bytes; p90 2,715) | 500 unique: A 265, B 30, C 91, D 21, F 14, the home folder 40, other folders 39 (these 39 not checked for duplicates) | What the engines accumulated |
| Claude topic files with the same normalized content (frontmatter dropped, spacing folded) | Recorded as a duplicate of the first, no candidate | 243 (213 in the pre-rename copy, 18 in B, 12 in F) | One fact once |
| Claude `MEMORY.md` indexes | Nothing | 21 | Pointers to the topic files, which are imported themselves |
| Codex summary bullets | One candidate per bullet, under its section heading | up to 66 | What every Codex start loaded |
| Codex registry, raw memories, rollout summaries, recovery dump | Nothing | 1,037 registry bullets, 298 summaries | History: no Codex start loaded them; `search_memory` keeps the registry and the rollout summaries searchable (`sources.ts:81-84`) |
| Instruction files (`CLAUDE.md`, `AGENTS.md`, rules) and skills | Nothing | | Instructions a person wrote; they stay loaded in both positions |

**Loaded at start**, the set the flip waits for: the files a root index
names, and the Codex summary. That is 351 candidates (285 Claude, 66 Codex).
The 215 files of the pre-rename copy (214 reachable only through A's nested
index, one more in the old directory itself, which no checkout uses now) are
curated after the flip, since no agent received them at start.

### 4.4 Candidate rows and provenance

Candidates live in their own collection, `role_memory_import`, beside
`role_memory`:

```ts
interface ImportCandidate {
  kind: "candidate";
  id: string;                     // c_<16 hex>
  importId: string;
  engine: "claude" | "codex";
  store: "claude_topic" | "codex_summary";
  file: string;                   // relative to the engine home
  sha256: string;                 // of the whole file, from the manifest
  anchor: string;                 // the bullet's anchor for Codex; "topic" for Claude
  type: "user" | "feedback" | "project" | "reference" | "summary" | null;
  writtenAt: string | null;       // frontmatter `modified`, else mtime
  writer: { kind: "seat" | "stage" | "operator" | "unknown"; roleId: string | null };
  project: string | null;         // the store's project, canonical
  loadedAtStart: boolean;
  suggestedScope: string;         // where the curator starts looking (4.5)
  title: string; body: string;    // bounded; private
  state: "pending" | "adopted" | "dropped";
  disposition?: { at: string; pass: string; ruleIds: string[]; reason?: CuratorReason; note: string };
}
```

The writer comes from the session id a Claude topic file names in its
frontmatter, resolved to that conversation's role in the registry: a
designated seat, a stage of role R, or the operator's own conversation. A file
that names no session, or a session no transcript holds (common outside A:
in C, 70 of 91 files), is `unknown`. Every adopted rule carries
`source: { origin: "import", candidate, engine, sha256, importId }`, a third
variant of `RuleSource` beside the stage and seat sources
(`roleTypes.ts:55-76`), so the rules window shows where each rule came from.

### 4.5 Import passes and level assignment

An import pass is a curator pass whose read returns, after the scope pages, up
to 40 candidates or 64 KB of candidate bodies, whichever comes first
(`kind: "candidate"` entries in `readCuration`, `curation/read.ts:43-47`).
Its apply gains two operations:

- `adopt: { candidate, parts: { to, rule, why }[], note }[]`: one or more new
  rules, each within the lesson limits (`apply.ts:28-33`), at scopes the pass
  may reach (`apply.ts:34-37`). An adopted rule is written with `curatedAt`,
  so the retention order (`roleConsolidate.ts:50-56`) treats it as curated.
- `drop: { candidate, reason, where?, note }[]` with the curator's existing
  reasons: task-specific, stale, in-code, in-instructions, no-reader,
  contradicted, duplicate; a candidate that names a concrete defect goes
  through the existing `problem` transfer to the seat's agenda.

A pass that leaves a candidate of its batch unaccounted for is refused, as an
active rule left unaccounted for is today. The brief gains one check before
the seven (`curation/brief.ts:1-7`): every candidate is adopted at the
narrowest level whose readers all act on it, merged into an equal active
rule, or dropped with a reason; a seat's notes about running the board land
under the orchestrator role; when the candidate's project has no folder on
this machine, it is judged from its text alone.

**Suggested level**, which only decides which pass a candidate joins first:

| Candidate | Suggested scope |
| --- | --- |
| Written by the seat | `role:<P>:orchestrator` |
| Written by a stage of role R | `role:<P>:<R>` |
| Written by the operator's conversation, or unknown, type feedback, project or reference | `project:<P>` |
| Type user; Codex summary preferences and general tips | `machine` |
| Codex summary bullets under a project's heading | `project:<P>` of that heading |

**Which project's pass, and how far an adoption reaches.** An adoption may
land in the candidate's own project's scopes, at `machine`, or under a role
on every project. A curator pass needs the project's designated seat
(`admission.ts:33-42`), so candidates of a folder without a seat (the home
folder and the 16 other folders: 79 in all) join A's passes. What holds only
for such a folder is adopted into that folder's project scope, which the
operator's conversations there read; that scope is curated once, in the
import, and again only when the folder gets a seat.

**Volume and time.** The 351 loaded-at-start candidates make 10 to 12 passes
(batches stay within one project: A 50, B 30, C 91, D 21, F 14, the seatless
folders 79, the Codex summary 66), plus about 6 for the nested copy
afterwards. A pass may apply its adoptions in several calls, as passes
already do (`apply.ts:213`). Admission holds an import pass whenever it holds
a normal one: seat wakes off, a deployment running, the automatic update
draining (`admission.ts:20-26`); the switch's state line then names the hold.
Passes run one at a time on the machine; an import pass follows a
succeeded pass of the same project without the 30-minute cooldown
(`store.ts:132`), which stays after a failure. At 20 to 40 minutes a pass the
flip comes 4 to 8 hours after the switch is pressed.

### 4.6 The flip and later writes

When no loaded-at-start candidate is pending, one write sets `phase:
"active"` and `activeAt`. The same job then hashes every engine memory file
again; a file new or changed since the backup becomes a candidate of the same
import (the seat may have written a note while the import ran), and the
manifest gains its copy. After the flip no Delegatus-launched conversation
writes the engine stores. Notes written later from outside Delegatus are not
imported (Deferred); they stay in the files and in `search_memory`.

### 4.7 Reversal

- **Back to the engines' memory**: one press. Engine memory comes back at
  each conversation's next engine start, from stores that were never written;
  Delegatus rules pause and stay in the store.
- **Undo the import itself**: each import pass is a curator pass, so the
  rules window's existing pass undo (`curation/apply.ts:206`) archives what
  it adopted; its candidates return to pending with the undo's time.
- **Switching to Delegatus again**: a new `importId`; a file whose SHA-256 an
  earlier import already dispositioned is not offered again.
- **The backup** is for the case where something outside Delegatus changed
  the stores. Copying the manifest's files back is a manual step (Deferred).

### 4.8 Privacy

Candidate bodies are private like rules: they live in the state directory and
leave the server only through `curate_rules read`, to the curator. Adopted
rule texts become known values for the publication gate and the relays like
every stored rule (`roleStore.ts:541-745`). Candidate bodies are not added to
the known-value list: whole notes of up to 8 KB would make patterns far
beyond what the list holds, and only the curator reads them. The
import report on the window gives counts by project letter, reason and level;
it quotes no text.

## 5. The rule budget question

### 5.1 Budgets in code

| Budget | Value | Enforced by |
| --- | --- | --- |
| One scope's rendered lines | 10,000 code points | `ROLE_MEMORY_BOUND`, `roleTypes.ts:11`; eviction in `retainRules`, `roleConsolidate.ts:59-72` |
| A role's four scopes together | 16,000 bytes | The curator brief only (`curation/brief.ts:7`); nothing evicts for it |
| One engine start's block | 120,000 bytes | `LEARNED_RULES_MAX_BYTES`, `roleLaunch.ts:11`; never reached |

### 5.2 Current fill, at the read

102 scope rows, 28 with rules, 256 active rules, 67,417 code points in all;
no scope above 90 % of its bound and six above 50 %.

| Scope | Rules | Code points | Of the bound |
| --- | ---: | ---: | ---: |
| builder, every project | 34 | 7,607 | 76 % |
| builder, A | 25 | 7,025 | 70 % |
| builder, C | 24 | 6,589 | 66 % |
| orchestrator, every project | 25 | 6,528 | 65 % |
| builder, D | 22 | 6,522 | 65 % |
| builder, B | 19 | 5,296 | 53 % |
| architect, every project | 20 | 4,997 | 50 % |
| architect, A | 17 | 4,719 | 47 % |
| orchestrator, A | 5 | 1,431 | 14 % |
| project A | 5 | 996 | 10 % |
| machine | 6 | 984 | 10 % |

Four-scope blocks per start, with the starts that read them in the last 7
days: builder A 16,628 bytes (919 starts), builder C 15,195 (224), builder D
15,128 (140), builder B 14,808 (128), architect A 11,701 (134). The seat of A
reads 9,939 code points in its four scopes.

### 5.3 Evictions and writes

- **Budget archives in the last 7 days: 25, all in the builder scope of A**,
  20 on 2026-10-15 and 5 on 2026-10-16; 20 of them never curated, median life
  0.33 hours. No other scope has ever evicted for budget.
- **Writes**: 856 new rule rows in 7 days (122 a day, mean 249 code points;
  versions and curator parts included). Lesson requests were answered with
  639 lessons, 152 rewrites, 24 problems and 581 none; seats wrote 79 rules.
  The curator's 72 passes archived 482 rules and returned 270.

### 5.4 What volume costs per start

Tokens below are estimated at four bytes per token, as in the benchmark; no
tokenizer was run.

| Start | Today | Delegatus mode, budgets unchanged |
| --- | ---: | ---: |
| Builder in A, Codex | 16.6 KB rules + 11.3 KB summary = 27.9 KB (≈ 7,000 tokens) | 16.6 KB (≈ 4,200) |
| Builder in A, Claude | 16.6 KB + 8.6 KB index = 25.2 KB (≈ 6,300) | 16.6 KB |
| Seat of A, Claude | 9.9 KB + 8.6 KB = 18.5 KB | 9.9 KB plus the imported notes |

Raising budgets costs nothing until scopes fill, and then it costs on every
start of the roles that fill them; builder starts in A (919 a week) dominate:

| Change | Extra bytes per builder start in A, once full | Per week, builder A alone |
| --- | ---: | ---: |
| Four-scope target 16 → 24 KB | up to 8 KB (≈ 2,000 tokens) | up to 7.4 MB |
| Scope bound 10,000 → 15,000 code points, both builder role scopes full (with the four-scope target lifted to match) | up to 15.4 KB (≈ 3,800 tokens) | up to 14.1 MB |

An 8 KB rise stays below the 8.6 KB (Claude) and 11.3 KB (Codex) that
Delegatus mode removes from every start, so it is free against today's
context. A 15.4 KB rise is not.

### 5.5 The answer

- **Stage roles: no rise now.** The only measured loss to the budget is
  uncurated lessons evicted from one scope, and task a70effa6 removes it (no
  eviction before a curator pass, an early pass at 90 %). The benchmark's
  traced cases found delivered rules that were ignored or too narrow behind
  more errors than absent ones (§3.5), so more volume has no measured benefit
  yet, and changing budgets during the trial would confound it.
- **The orchestrator: the four-scope target rises from 16,000 to 24,000
  bytes for the import.** Most imported notes are the seat's (A: 39 of 50
  root files from checkout sessions). At a mean of about 270 code points per
  rendered line, today's target leaves the seat of A room for about 22 more
  rules; 24 KB leaves about 52. The seat drops the 8.6 KB index in the same
  step, so each seat start stays at or below today's size however many there
  are (the a70effa6 ledger will count them; a project has one designated
  seat, against 919 builder starts a week in A). One sentence of
  `curation/brief.ts:7` changes; the per-scope bound stays.
- **When to raise stage budgets, and by how much.** After the trial, if a
  week shows a curated rule archived for budget, or an import candidate
  dropped only for room, raise the four-scope target to 24 KB for that role:
  at most 8 KB per start, which the removed engine memory pays for. A per-scope
  bound above 10,000 code points waits until a scope reaches it after a70effa6
  with curated rules only.

## 6. The one-week trial

### 6.1 Windows

| Window | From | To |
| --- | --- | --- |
| Baseline | the switch press minus 7 days | the switch press |
| Import (excluded) | the switch press | `activeAt` |
| Trial | `activeAt` | `activeAt` plus 7 days |

A lane belongs to the window in which its first builder attempt that no fail
edge activated started; its reviews count when they completed within 24
hours after the window ends. Lanes that started in the import window are in
neither. Reviewers are clean in both windows, so the judge does not change.

### 6.2 Metrics

| Metric | Definition | Role in the decision |
| --- | --- | --- |
| Failed-review share | lanes whose first reviewer verdict is `fail` ÷ lanes reviewed within the grace, with a Wilson 95 % interval | Primary |
| Fix rounds per lane | attempts activated by a fail edge ÷ lanes reviewed, mean with a bootstrap 95 % interval over lanes, and the median | Corroboration |
| Repeated finding classes | findings of a second or later review round whose keyword class (rendered, contract, seam, tests, privacy, hot path) appeared in an earlier round of the same lane ÷ findings of later rounds | Corroboration. Its base rate is high (78–86 % in every window measured), so it moves little |
| Lesson writes | lesson-request answers by kind (lesson, rewrite, none, problem, open), fix-round answers separately; seat and operator rules written | Reported |
| Evictions | budget archives, never-curated and curated separately | Guard |
| Import | candidates adopted, dropped by reason, adopted rules archived later in the window | Reported |

### 6.3 What the baseline looks like now

From the 16:10 UTC read, the most recent complete week (2026-10-08 16:10 to
2026-10-15 16:10, grace to the read):

| | All projects | A | Others |
| --- | ---: | ---: | ---: |
| Builder lanes / reviewed | 368 / 335 | 252 / 232 | 116 / 103 |
| Failed-review share | 158 of 335 = 47 % (42–53) | 104 of 232 = 45 % (39–51) | 54 of 103 = 52 % |
| Fix rounds per reviewed lane (median) | 1.18 (1) | 1.04 (0) | |
| Repeated finding classes | 191 of 232 = 82 % (77–87) | 104 of 125 = 83 % | |
| Lesson answers | 563 lessons, 114 rewrites, 483 none, 21 problems | 393, 73, 259, 13 | |
| Budget evictions | 7, of them 4 never curated | 7 | 0 |

Lesson request rows begin on 2026-10-10 06:52 UTC, so a baseline window
reaching before that date undercounts them.

The same measure over rolling 7-day windows shows a strong trend:

| Window ends (16:10 UTC) | 10-08 | 10-09 | 10-10 | 10-11 | 10-12 | 10-13 | 10-14 | 10-15 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Failed-review share | 57 % | 53 % | 53 % | 51 % | 47 % | 45 % | 43 % | 47 % |
| Fix rounds per reviewed lane | 1.83 | 1.73 | 1.71 | 1.61 | 1.42 | 1.14 | 1.06 | 1.18 |

Two things follow. At about 300 reviewed lanes a week, a difference in the
failed-review share is distinguishable from zero only above about 8 points,
and a harm of about 11 points is found with 80 % power. And the share moved
14 points in a week with no memory switch at all, so a continuing trend can
hide or fake a change of that size. One week can exclude a large harm; it
cannot prove a small benefit. The decision rule is written for that.

### 6.4 Load recorded

For each window: attempts started, non-clean starts, the split by engine and
by model, mean and peak concurrent attempts, lanes with attempts, by project;
the worker limit in force; deploys that landed (from the deploy records);
the role presets' engine and model for builder and reviewer. For the 7 days
to the read: 2,773 attempts, 1,729 non-clean, 1,960 Codex and 813 Claude,
mean concurrency 8.6, peak 36 (attempts with both times), 582 lanes; the
week before: 1,929 attempts, mean 6.1, peak 22, 353 lanes. Load grew 44 % in a
week, so load is recorded and guarded loosely (6.5).

### 6.5 Guards and what is held still

The trial starts only when task a70effa6 is deployed: the ledger shows that
no trial start loaded an engine memory file, and no lesson is evicted before
curation. It is void, and the week runs again, if a ledger row in the trial
window lists an engine memory hash, if a never-curated rule is archived for
budget, or if attempts started differ from the baseline by more than 50 %.
Held still in the trial week: the builder and reviewer role scaffolds and
presets, the lesson request text, the curator brief and both budgets. A
change to one of them restarts the week. Mandate versions, models and the
worker limit are recorded.

### 6.6 What result switches the default

Pre-registered, on all projects together:

- **Delegatus becomes the default** unless the difference in failed-review
  share (trial minus baseline) has its 95 % interval entirely above zero.
- **Claude and Codex becomes the default** when that interval is entirely
  above zero and one corroborating metric (fix rounds per lane or repeated
  classes) is also higher with its own interval entirely above zero.
- **Otherwise one more week**: a primary harm without corroboration, or a
  void week. The second week is pooled with the first against the same
  baseline, and then only the primary decides.

The trial compares Delegatus mode with today's state, which runs both
memories; the Claude and Codex position alone is never measured. The second
outcome therefore reads as "removing the engines' memory cost more than the
import gave back", which is the operator's stated doubt, and the either-or
switch then offers the engines' side.

Per-project and per-engine results are reported beside it and decide
nothing: a week holds about 100 reviewed lanes outside A, too few to read.
The seat files the result with the numbers and the load in one decision form
before it moves this installation's switch; the operator's answer sets the
shipped default for unchosen installations (slice 7).

## 7. Build plan

Each slice is one pull request with its tests, run by path through
`scripts/gate-slot.sh` with private HOME, XDG_CONFIG_HOME, TMPDIR and
`LLV_STATE_DIR`. Task a70effa6 lands first.

**Slice 1: the setting and the off switch at every launch.** `memory-source.json`,
`memorySource()`, `engineMemoryOff()`, `roleMemoryEnabled()` reading the
choice, the route, every launch path of 3.2. No UI, no import; a PUT to
Delegatus is refused until slice 3 lands.
Tests: a table test drives each launch builder of 3.2 for "not chosen",
`delegatus/importing`, `delegatus/active` and `engines`, and asserts the
Claude settings (`autoMemoryEnabled`, the env flag) and the Codex arguments
and thread config (`features.memories`); "not chosen" and `importing` match
today's output byte for byte. In the engines position a stage report gets no
lesson request, a launch gets no rules, the curator admission answers paused.
A clean launch is clean in all four. A resume after a change of the setting
follows the new value. The route refuses cross-origin and non-operator
writes.

**Slice 2: backup and candidates.** The import job, the manifest,
`role_memory_import`, writer resolution, the loop-monitor label.
Tests on fixture homes: two account homes linking one Claude directory give
one copy and one candidate per file; a duplicate in two directories gives one
candidate and one duplicate record; indexes, the Codex registry and rollout
summaries give none; the copy's hashes equal the sources'; every source file's
hash is the same after the job; a mismatch stops the import and returns the
switch to its previous position; the backup refuses a destination under a
checkout; the sixth backup removes the oldest by its manifest.

**Slice 3: import passes and the flip.** Candidate pages in `readCuration`,
`adopt` and `drop` in `applyCuration`, the brief's import check and the
orchestrator's 24 KB target, the `import` rule source, the flip and the delta
scan, the cooldown exception.
Tests: a pass that leaves a candidate unaccounted is refused; an adopted rule
is active with `curatedAt` and its provenance; an adoption beyond the pass's
reach is refused; the flip happens once, when the last loaded-at-start
candidate is dispositioned and not before; a file changed after the backup
becomes a delta candidate at the flip; undoing an import pass archives its
rules and returns its candidates to pending; a second import skips files
already dispositioned. The curator evaluation (`curator.eval.test.ts`) gains
import cases: a seat-only directive lands under the orchestrator, a writing
preference every role shares lands at machine, a task narration is dropped,
a defect becomes a problem.

**Slice 4: seats and the operator's conversations.** The seat pointer by
position, the selector for the operator's root conversations, their notice
and pointer, `leave_lesson` for them.
Tests: in Delegatus mode an operator root conversation is spawned with
`{ project, roleId: null }` and starts with the project and machine rules
under its own notice; "not chosen" spawns none; its `leave_lesson` writes
origin `operator` at project or machine and is refused at role scope; a stage
without a request and a clean role are still refused; the seat's block
carries the Delegatus-mode pointer only in that mode.

**Slice 5: the Settings row.** The row of 3.4, its four states, the
rules-window line, `docs/guide/memory.md`.
Tests: DOM tests for each state's words, the optimistic press and the
rollback on a refused write. Rendered evidence through the existing drivers
(`scripts/capture-board-geometry.ts` for the desktop menu,
`src/components/mobile/issue1671Evidence.browser.test.tsx` for the phone
sheet) at the desktop menu width and at 360 and 390 px, en and uk, light and
dark, every state, with the import counts at their real size; the row's state
line is measured from text ranges for clipping. This slice rebases on open
pull request #2979 (§8).

**Slice 6: the weekly report.** `scripts/memory-weekly-metrics.ts`, run
against a `VACUUM INTO` copy of the state database: the metrics of 6.2 and the
load of 6.4 for any two windows, and the decision of 6.6. The same script
serves the benchmark's weekly metrics (`memory-quality-benchmark.md` §4.2), so
it is no single-use driver.
Tests: a synthetic pipeline set per case (a lane reviewed within the grace, one
reviewed after it, one activated by a fail edge, one started in the import
window, an eviction of each kind) gives the expected counts and the decision
for each branch of 6.6, with one row set per verdict writer: `stage_report`,
the fenced-JSON fallback, a review-loop outcome, a retried attempt and a
parked `needs_decision`.

**Then**: the operator presses the switch (the seat asks in a form once
slices 1 to 6 are deployed); the import runs; the trial week runs; slice 6
reports.

**Slice 7: the default.** One constant for unchosen installations, set by the
operator's answer. If it is Delegatus, an unchosen installation runs the
import on its first start under the release fence and flips as in 4.6. From
then on "not chosen" means the default, and the switch has the two positions
only; the state line for "not chosen" and the first-choice rule of §2 item 2
go.

## 8. Open work that touches the same files

| Pull request | Files shared with this plan | Effect |
| --- | --- | --- |
| #2979 Settings «Keys» | `HeaderMenu.tsx`, `MemoryPage.tsx`, `en.ts`, `uk.ts`, `docs/guide/memory.md` | Slice 5 rebases on it; the row sits beside its Keys row |
| #2930 MCP writes through the Viewer | `spawnPolicy.ts`, `codexAppServerHost.ts`, `mcp/bindings.ts`, `mcp/server.ts` | Moves where `leave_lesson` and `curate_rules` execute; slices 1, 3 and 4 follow its routing if it lands first |
| #2987 Codex CLI 0.163.0 | `codexAppServerHost.ts` | Slice 1's Codex flag rebases on it |
| #2981 orchestrator delivery | `mcp/bindings.ts` | Slice 4's binding change rebases on it |
| Task a70effa6 | `roleLaunch.ts`, `roleConsolidate.ts`, the curation trigger | Lands first; slice 3's adopted rules enter as curated, so its "no eviction before curation" rule leaves them alone |

## Deferred — not currently justified

- **A per-project switch.** The operator asked for one memory per
  installation.
- **A permanent position with both memories.** It exists only as the state
  before the first choice; the trial decides between the two positions the
  operator named.
- **Editing the operator's engine configuration files** (the native Claude
  settings, the Codex configuration) so that sessions started outside
  Delegatus lose engine memory too. Delegatus governs what it launches.
- **Continuous import of notes written outside Delegatus after the flip.**
  Delegatus-launched conversations stop writing the stores; whether outside
  sessions write enough to matter is unmeasured, and the search keeps what
  they write.
- **Importing the Codex registry, raw memories and rollout summaries.**
  History; searchable.
- **Restoring the engine stores from the backup in the interface.** The
  switch never writes them; a manual copy from the manifest covers damage
  from elsewhere.
- **Teaching shared recall memory to recall learned rules.** Rules are
  delivered whole at start; recall over them adds nothing yet.
- **Raising stage budgets** beyond the orchestrator's import target, until a
  week after a70effa6 shows the trigger of 5.5.
- **Paid replay runs for this question.** Declined by the operator; the
  benchmark's replay (§4.1) stays available for other questions.
- **Per-task selection of rules at start.** As in the benchmark's deferred
  list.

## Decisions for the operator

None blocks this design. One action follows the build: pressing the switch
to start the import and, after it, the trial week. The seat asks for it in a
decision form once slices 1 to 6 are deployed, and files the trial's result
in another, where the operator's answer sets the default. Both forms keep a
free-text answer beside their options.

## Validation against the requirement

| Requirement | Where |
| --- | --- |
| 1. One memory per installation, a switch between Delegatus memory and the engines' | §3.1 storage, §3.2 every launch path, §3.3 by conversation, §3.4 the row |
| 2. Engines off on switching, accumulated memory imported through the curator, history to search | §4.1–4.6; history kept in `search_memory` and the transcripts (§4.3, choice 8) |
| 3. Design first; default after one week in Delegatus mode; no paid replay | This document; §6; slice 7; the replay is deferred |
| 4. The orchestrator's notes into the orchestrator's role memory through the curator | §4.5 suggested level and brief check; §5.5 room for them |
| 5. Budgets: raise if volume is needed, by how much | §5: no rise for stage roles now, the orchestrator's target 16 → 24 KB for the import, and a measured trigger with a free ceiling of 8 KB per start |

## Appendix: how the numbers were produced

- **Store export.** One read-only open of the state database (`bun:sqlite`,
  `readonly: true`) copied the `role_memory`, `role_memory_curation`,
  `pipelines` and `pipelines_archive` collections into this stage's scratch
  directory at 2026-10-16 16:10:43 UTC (1.2 seconds; 3,321, 150, 276 and 799
  rows). Scripts over that export computed every store number: scope sizes as
  code points of the rendered lines `- [id] rule` (`roleConsolidate.ts:18-25`),
  four-scope blocks per (project, role) for the non-clean attempts of the
  last 7 days, budget archives by `reason = budget` without `versionOf`, and
  the trial measures with the window and grace rules of 6.1, keyword classes
  as in 6.2 and Wilson intervals. The export and the scripts lived in the
  stage's scratch directory and are gone with it; the queries are restated in
  this appendix and in 6.1–6.2, and slice 6 commits them. The rolling window
  ending 2026-10-14 was computed later from the same export; the others came
  from its first runs.
- **Engine stores.** File sizes, line counts, frontmatter `type` and session
  fields, modification times and SHA-256 of normalized content (frontmatter
  removed, spacing folded) of every `.md` file under each Claude memory
  directory of the native home, with links followed and each physical file
  counted once; link counts of both Claude account homes; the Codex memories
  folder's file sizes, its configuration flags in every Codex home, and its
  history's last commit time. Writers were resolved by finding the
  transcript each named session id belongs to.
- **Starts that received engine memory** are the non-clean attempts of the 7
  days to the read, by project and engine; engine memory bytes multiply them
  by the size of the index or summary at the read, so they approximate the
  week (the indexes changed during it).
- **Detectable difference.** Two proportions near 0.47 with 300 lanes each:
  1.96 × √(2 × 0.25 / 300) ≈ 0.08; 80 % power at α = 0.05 needs a difference
  of about 0.11.
