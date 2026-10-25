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
   switch turns the engines off for new engine starts once every candidate the
   engines loaded at start has a disposition, and the trial begins only when
   the Claude processes that started earlier with their memory on have retired
   and their late writes are backed up (§4.6).
7. **The operator's own conversations get Delegatus memory too**: the project
   and machine rules at start, and `leave_lesson` at those levels. With the
   engines off they would otherwise start with no memory, and keeping the
   engines on for them would be two memories.
8. **Explicit recall stays; automatic recall of engine notes stops in
   Delegatus mode.** `search_memory` (and the transcripts) read the engine
   stores as history in every position; in Delegatus mode those stores stop
   changing. This is where the operator placed historical detail. The
   per-project injection hook is different: every candidate it can offer
   comes from the engine stores (`index.ts:403-415` selects `claude` and
   `codex` entries and excludes only skills), and it fires on a later human
   turn of any non-clean conversation (`controller.ts:85-96`, `:168-173`). Left
   running, a builder launched with engine memory off would receive a native
   note after an operator follow-up, including a note the curator dropped,
   which is a second memory. In `delegatus/draining` and `delegatus/active`
   the hook therefore offers nothing and records the new turn reason
   `memorySource`; the per-project Shared memory setting is kept as it is and
   takes effect again in the other positions. The project's existing
   last-turn line says so (`view.ts:17`, `memory.last.*` in `en.ts:27` and
   `uk.ts:27`) with one more reason string, so no new control appears. Recall over curated rules stays
   deferred.
9. **Budgets stay as they are through the trial.** The orchestrator's
   target rises only if the import shows a seat candidate dropped for room
   (§5.5), and that happens before the trial starts: the trial measures one
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
  phase?: "importing" | "draining" | "active";
  importStartedAt?: string;
  flippedAt?: string;         // engine memory is off for every engine start from here
  drainedAt?: string;         // the last engine process that started before flippedAt with its memory on has retired, and the final scan is backed up: the trial clock starts here
};
```

A missing or malformed file reads as "not chosen". `memorySource()` in
`src/lib/memory/source.ts` returns `{ choice, phase }`, and two functions
read it:

- `engineMemoryOff({ cleanMemory })`: true for a clean launch, and for every
  launch when `choice === "delegatus"` and `phase` is `draining` or `active`.
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
| Automatic recall on a later human turn (not a launch path: it injects engine notes into a running conversation) | `controller.ts:155` checks `sharedMemoryEnabled(project)`; candidates come from `index.ts:403-415` | A check of the source beside it: `delegatus` with phase `draining` or `active` returns empty with reason `memorySource`, before any candidate query, so no recall spend and no curated-out note reaches an agent |

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
| The operator's own Delegatus-launched conversation | Engine memory; injection hook per project | Project and machine rules at start, with a notice of its own; `leave_lesson` with scope project or machine; engine memory off; injection hook offers nothing (`memorySource`) | Engine memory; injection hook |
| Later human turn of any non-clean conversation (automatic recall) | Engine-store notes offered when the project is switched on | Nothing offered, whichever engine, role or project switch (`memorySource`); `search_memory` still answers on request | Engine-store notes offered as today |
| Curator | Runs | Runs, with import passes | Paused (`admission.ts:21`), except import passes for the periodic sync of 4.9 |
| A conversation started outside Delegatus with the operator's own engine homes | Engine memory | Unchanged: Delegatus edits no engine configuration file | Unchanged |

For the operator's conversations, the selector is the existing text-free
marker with `roleId: null`, which already reads the project and machine
scopes (`roleStore.ts:109-111`), plus `reader: "operator"` so the block can
tell it from a role-less stage. It is set at spawn and re-derived on resume
in the block that sets the seat's (`registry.ts:6320-6338`) for a root
conversation the operator launched, and only while the source is Delegatus
(`draining` or `active`, the phases in which the engines' memory is off). A
launch from an external client also has no role, no parent and depth zero, so
the shape proves nothing alone: admission stamps `operatorOrigin` on a launch
receipt whose origin is `operator`, and the settlement that creates the
conversation copies it onto the conversation record once. Resume, restart
adoption, account migration and `leave_lesson` read that stamp beside the
root shape (`src/lib/memory/operatorMemory.ts`); an external root, and a
conversation born before the stamp existed, stay excluded. The block's notice and pointer for this reader are new text in
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
| Draining | on | same | New agent starts use Delegatus rules only; waiting for 2 agents that started earlier to restart so their last notes can be imported. / Нові агенти користуються лише правилами Delegatus; чекаємо, поки 2 агенти, запущені раніше, перезапустяться, щоб імпортувати їхні останні нотатки. |
| Delegatus | on | same | On: agents remember through Delegatus rules. Claude's and Codex's own memory is off. / Увімкнено: агенти пам'ятають через правила Delegatus. Власна пам'ять Claude і Codex вимкнена. |
| Claude and Codex | off | same | Off: agents use Claude's and Codex's own memory. Delegatus rules are paused. / Вимкнено: агенти користуються власною пам'яттю Claude і Codex. Правила Delegatus на паузі. |

The importing state counts files, with the parts left in brackets when a file
has several (4.4). The two off states differ in their words, which is what tells them apart. A
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
   disposition, the setting becomes `delegatus/draining` with `flippedAt`, and
   engine memory is off from the next engine start of every conversation.
   Claude processes that started earlier keep their memory on and may still
   write; the stores are scanned again whenever one retires.
5. **The drain** (4.6): when the last of those processes has retired and the
   final scan is backed up, the setting becomes `delegatus/active` with
   `drainedAt`, which starts the trial clock.
6. The remaining candidates (nested subtrees, deltas) are curated after the
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
| Claude topic files, every directory | One candidate per file when the body fits one part (8,192 bytes); longer files become linked parts, so no byte of a file is cut off (4.4). Read from the verified backup copy, never the live file | 500 unique: A 265, B 30, C 91, D 21, F 14, the home folder 40, other folders 39 (these 39 not checked for duplicates). Seven files are longer than one part: 8,650, 8,650, 8,655, 9,412, 9,412, 11,482 and 16,170 bytes (file sizes at the read; median 1,545, p90 2,715) | What the engines accumulated, whole |
| Claude topic files with the same normalized content (frontmatter dropped, spacing folded) *and* the same applicability: same canonical project, same type, same writer kind and role | One candidate that lists every such file as an occurrence (4.4) | 243 (213 in the pre-rename copy of A, 18 in B, 12 in F; each pair sits in one project's store, so the applicability matches) | One fact once per applicability, with every provenance kept |
| The same normalized content under a different project, type or writer | Separate candidates, linked by the content hash (4.4) | Not counted at this read: the 39 unchecked folders and the cross-project pairs are counted by the slice 2 job and reported before any pass runs | Equal wording can apply to different readers; folding it would drop the second reader's copy or widen the first |
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
`role_memory`. A file is cut into parts of at most 8,192 bytes, at line
boundaries (a single line longer than the part is cut at a code-point
boundary), so every byte of the backed-up file belongs to exactly one part.
Short files, which are nearly all of them, have one part.

```ts
interface ImportCandidate {
  kind: "candidate";
  id: string;                     // c_<16 hex>
  importId: string;
  engine: "claude" | "codex";
  store: "claude_topic" | "codex_summary";
  group: string;                  // c_<16 hex> of the file's first part; equal to id for a one-part file
  part: { index: number; of: number; bytes: [number, number] };  // byte range within the normalized file
  contentSha256: string;          // of the normalized whole body; equal bodies with the same applicability share a candidate
  linked: string[];               // candidates with the same contentSha256 but another applicability
  occurrences: Occurrence[];      // at least one; see below
  anchor: string;                 // the bullet's anchor for Codex; "topic" for Claude
  loadedAtStart: boolean;
  suggestedScope: string;         // where the curator starts looking (4.5)
  title: string; body: string;    // this part only; private
  readBy?: string[];              // curator passes whose read returned this part
  /** One per curator call; together they cover every occurrence of every part. */
  dispositions: { at: string; pass: string; kind: "adopt" | "drop"; ruleIds: string[]; reason?: CuratorReason; note: string; occurrences: string[] }[];
}
interface Occurrence {
  id: string;                     // o_<16 hex>
  file: string;                   // relative to the engine home
  sha256: string;                 // of the whole file, from the manifest
  type: "user" | "feedback" | "project" | "reference" | "summary" | null;
  writtenAt: string | null;       // frontmatter `modified`, else mtime
  writer: { kind: "seat" | "stage" | "operator" | "unknown"; roleId: string | null };
  project: string | null;         // the store's project, canonical
}
```

The state of a candidate is derived rather than stored (4.7): pending until a
disposition names it, `adopted` while a surviving rule it produced exists, and
`dropped` for a drop; it returns to pending only by the rules of 4.7.

**Whole files reach the curator.** A pass's read returns the parts of a group
together, in order, within its 64 KB page (4.5). A group longer than a page
(none today; the longest file is 16,170 bytes) continues in the next pass of
the same project. Three rules keep an unread part from being lost:

- a disposition (`adopt` or `drop`) on a part is refused unless the same pass's
  read returned that part (`readBy`), and a pass that names a group
  dispositions every part of it or says which parts it leaves for the next
  pass; the pass is refused if a part of its batch is unaccounted for (4.5);
- a *file* counts as dispositioned only when all its parts do, so neither the
  flip (4.6) nor the import counts treat a file as done while a part is
  unread: the state line counts files, with the parts left in brackets;
- the part list comes from the verified backup copy, so what the curator reads
  is what the manifest hashed.

**Occurrences keep every provenance.** Two files with equal normalized
content and equal applicability (same canonical project, type, writer kind and
role) become one candidate with two occurrences: this removes the pre-rename
copy's 213 duplicates without losing which files held the note. Equal content
under a different project, type or writer becomes a separate candidate in its
own project's batch, carrying `linked` ids. The curator's brief says what
that means: an identical rule adopted for another project does not satisfy
this candidate; it is judged for its own readers, merged into an equal active
rule of its own scopes, or widened (for example to `machine`) only if its
readers justify it, never merely because an equal body already exists. A
disposition lists the occurrence ids it covers, and a pass is refused if an
occurrence of a candidate in its batch is covered by neither an `adopt` nor a
`drop`; occurrences of one candidate may therefore get different dispositions
(for example the seat's copy adopted, an unknown-writer copy dropped as a
duplicate of it).

The writer comes from the session id a Claude topic file names in its
frontmatter, resolved to that conversation's role in the registry: a
designated seat, a stage of role R, or the operator's own conversation. A file
that names no session, or a session no transcript holds (common outside A:
in C, 70 of 91 files), is `unknown`. Every adopted rule carries
`source: { origin: "import", candidate, occurrences, engine, sha256, importId }`,
a third variant of `RuleSource` beside the stage and seat sources
(`roleTypes.ts:55-76`), so the rules window shows where each rule came from
and every file that held it.

### 4.5 Import passes and level assignment

An import pass is a curator pass whose read returns, after the scope pages, up
to 40 candidates or 64 KB of candidate bodies, whichever comes first, in whole
groups (4.4; `kind: "candidate"` entries in `readCuration`,
`curation/read.ts:43-47`). Its apply gains two operations:

- `adopt: { candidate, occurrences, parts: { to, rule, why }[], note }[]`: one
  or more new rules, each within the lesson limits (`apply.ts:28-33`), at
  scopes the pass may reach (`apply.ts:34-37`), covering the listed
  occurrences. An adopted rule is written with `curatedAt`, so the retention
  order (`roleConsolidate.ts:50-56`) treats it as curated.
- `drop: { candidate, occurrences, reason, where?, note }[]` with the curator's existing
  reasons: task-specific, stale, in-code, in-instructions, no-reader,
  contradicted, duplicate; a candidate that names a concrete defect goes
  through the existing `problem` transfer to the seat's agenda.

A pass that leaves a part or an occurrence of its batch unaccounted for is
refused, as an active rule left unaccounted for is today, and so is a
disposition of a part its read did not return (4.4). The brief gains one check before
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

**Volume and time.** The 351 loaded-at-start files and bullets (seven long files add at least
seven parts) make 10 to 12 passes
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

### 4.6 The flip, the drain and later writes

**Who can still write after the flip.** The off switch is read at every engine
start (§2 item 4), so a conversation whose engine process started before the
flip keeps its memory on until its next engine start. Only Claude processes
can still write notes: Codex generation has been off since 2026-10-01 (§1.2),
so its folder is read-only in practice. A *legacy generation* is therefore a
non-clean Claude generation whose `createdAt` is before `flippedAt` and whose
`archivedAt` is null while its recorded host is live
(`NativeGeneration`, `src/lib/accounts/migration/contracts.ts:174-183`; a
resume or rotation starts a successor generation, which is how the registry
sets `archivedAt` on the previous one, `registry.ts:7052`). Interrupting these
processes is not allowed (§2 item 4), so the design waits for them.

**Sequence.**

1. When no loaded-at-start file has a part or an occurrence pending (4.4),
   one write sets `phase:
   "draining"` and `flippedAt`. The job lists the legacy generations and
   stores the list (ids only) with the record. From this write on, no new
   engine start has memory on, and the hook offers nothing (§2 item 8).
2. The job hashes every engine memory file again, and does so each time a
   legacy generation retires, with a fallback pass every 30 minutes while any
   remains (a size and modification-time prefilter keeps each scan cheap;
   hashing runs off the event loop under its own operation label). A file new
   or changed since the last scan becomes a candidate of the same import
   (anchor and part rules of 4.4), and its copy joins the backup manifest
   before the candidate is written. A write that lands after one scan is
   therefore caught by the next scan, and the retirement of its writer always
   triggers one.
3. When the list is empty, the job runs one final scan, writes its candidates
   and manifest entries, and only then sets `phase: "active"` and
   `drainedAt`. A candidate from a late write is pending at that moment; it is
   curated by the ordinary passes and is reported in the import counts. It
   need not be dispositioned before the trial starts; the import counts show
   it, and a rule adopted from it during the trial is reported with the
   import's other adoptions (6.2).
4. The state line (§3.4) shows `draining` with the number of legacy
   generations left. If one is still alive 24 hours after `flippedAt` (a seat
   is the usual case), the seat asks the operator in a decision form whether
   to rotate it (`rotate_orchestrator` exists for the seat); nothing is
   rotated without the answer, and the trial does not start meanwhile.

**Trial exposure.** A legacy generation is never a clean trial exposure: any
lane that has an attempt on a legacy generation is excluded from the trial
window (6.1), and the 6.5 ledger guard reads rows from `drainedAt` on. The
deferred rule stands for notes written from outside Delegatus after
`drainedAt`: not imported, still searchable.

### 4.7 Reversal

- **Back to the engines' memory**: one press. Engine memory comes back at
  each conversation's next engine start. Delegatus never wrote those stores
  (a note a legacy process wrote during the drain is in them and in the
  backup); Delegatus rules pause and stay in the store.
- **Undo an import pass is partial by construction, and says so.** Each import
  pass is a curator pass, so the rules window's existing pass undo
  (`curation/apply.ts:206`) applies. That undo reverses only rules that no
  later write touched: it skips a rule with a later writer, including another
  curator's ranking at the same clock instant (`apply.ts:232-253`; the case is
  pinned by the test `pass undo preserves another curator's ranking at the same
  clock instant`, `src/lib/memory/curation/curation.test.ts:334-342`, where all three ids come back as
  skipped). The import therefore does not promise an unconditional reversal. A
  candidate's state follows what the undo did to the rules it produced, and is
  derived at read time from the pass record and the rules, so no second
  collection needs a write in the same transaction as the undo:
  - **Every rule the disposition created was reversed** (archived or restored
    to its prior version by that undo, none in `undoSkipped`): the candidate
    is pending again, with a note naming the undone pass.
  - **Some rules were skipped** (a later rewrite, ranking, merge or move):
    the candidate stays `adopted`, its surviving rule ids replace the reversed
    ones, and the undo's reply lists the skipped ids and their candidates
    ("partly undone: N rules kept because of later edits"). A rule merged into
    a surviving rule counts as surviving through the merge target; a rule
    split into parts, through the parts.
  - **A pending candidate with a surviving descendant is impossible**: `adopt`
    refuses a candidate whose earlier disposition still has an active rule or
    descendant, so a re-pended candidate cannot be adopted twice. To replace a
    surviving rule the curator rewrites it by id, as for any rule.
  - The import is "undone" in the window and the state line only when no rule
    it produced survives; otherwise it reads "partly undone" with the count.
- **Switching to Delegatus again**: a new `importId`; a file whose SHA-256 an
  earlier import already dispositioned (and not re-pended by an undo) is not
  offered again.
- **The backup** is for the case where something outside Delegatus changed
  the stores. Copying the manifest's files back is a manual step (Deferred).

### 4.8 Privacy

Candidate bodies are private like rules: they live in the state directory and
leave the server only through `curate_rules read`, to the curator. Adopted
rule texts become known values for the publication gate and the relays like
every stored rule (`roleStore.ts:541-745`). Candidate bodies are not added to
the known-value list: whole notes (up to 16 KB each) would make patterns far
beyond what the list holds, and only the curator reads them. The
import report on the window gives counts by project letter, reason and level;
it quotes no text.

### 4.9 Periodic sync while the engines' memory is on

Added 2026-10-22 at the operator's request (seat conversation, voice,
paraphrased): an installation that has imported once and then runs with the
engines' memory on again keeps writing engine notes, and Delegatus memory
should take them in from time to time instead of falling behind until the
next switch.

**When it runs.** Only in the Claude and Codex position, and only when an
earlier import of this installation finished its backup and candidates (its
record is `ready`; `memory-source.json` keeps that `importId` when the switch
moves to the engines). An installation that never chose, or chose and never
imported, has nothing to sync with: its first import is the switch. In
Delegatus mode the engines' stores stop changing for everything Delegatus
launches, and the deferred rule for notes written from outside after
`drainedAt` stands.

**What triggers it.** No timer of its own. The memory index refresh, which
already runs on the transcript-scan cadence and already calls
`scheduleMemoryImport()`, checks whether a sync is due from two small reads:
the setting and the import record. Due means the record's last sync attempt
(`sync.lastAt`, durable, so a restart neither repeats nor skips one; the
helper stamps it with the time the due check read) is at least the interval
old; a run that stopped at its cap is due again at the
next refresh; a failed run is retried after one hour. A run records its
start (`result: "running"`) once the state directory is proven apart from the
engines' stores and before its inventory, its wait for the import lock and any
copy, so a helper its five-minute deadline or a crash ended in any of them also
waits that hour, and the state line names it interrupted once ten minutes have
passed. A run the lock refused records that failure in place of its start. A
refusal before the start (the engines' memory is no longer selected, or the
sync is off) writes nothing. The interval is
`memory-sync.json` under the state directory, `intervalHours` 1 to 168,
default 24 (daily) when the file is absent, 0 for off. `PUT
/api/memory/source` with `syncIntervalHours` writes it under the same guards
as the switch.

**What it does.** One run of the existing leased import helper on the same
import: the delta scan of 4.6 step 2 (size and modification-time prefilter,
hashing off the event loop, each new or changed file copied into the same
backup under its own version directory and added to the manifest, the copy
re-hashed against the source before any candidate is written), then candidate
rows of the same import with the part and occurrence rules of 4.4. The
engines' stores are only read, as in 4.2. Dedup is by content: a new
occurrence whose normalized content hash, part, anchor and applicability
(project, type, writer kind and role) equal an occurrence that already has a
disposition, in this import or an earlier one and not re-pended by an undo
(4.7), inherits that disposition and is never offered to the curator. Only new
content becomes pending. The lookup runs inside the transaction that writes the
candidate rows, so a curator outcome committed while the run was scanning
covers the new copy too. An inherited copy keeps the original's pass, time and
reason, and names the candidate whose outcome it repeats (`inheritedFrom`).

**Budget.** At most 200 files are hashed per run (the prefilter skips
unchanged files before that count); the rest wait for the next run, which is
then due at once. The helper keeps its five-minute deadline and the
one-job-at-a-time slot it shares with the import, so a sync never runs beside
an import. The backup grows only by changed files. Curator spend is bounded by
the existing pass rules: one pass at a time on the machine, at most 40
candidates or 64 KB per pass, the project's cadence between passes.

**Curation in the engines position.** The curator stays paused for ordinary
work in that position, but a pass is admitted while that import has pending
candidates and the sync is not off. It is an import pass as in 4.5, claimed
only when it has a batch, and its adoptions are stored like any rule. Agents
do not receive them while the engines' memory is selected (no rules at start,
no lesson requests, `leave_lesson` refused, as in 3.3); they are in place when
the switch returns to Delegatus. `LLV_ROLE_MEMORY=off` still stops all of it.
Switching back to Delegatus starts a new import as in 4.7; everything the sync
already dispositioned is inherited there and not offered again.

**State line.** `GET /api/memory/source` gains `sync`: `{ intervalHours,
lastAt, nextAt, added, capped, failure }`, counts only; `added` counts the
files of the last run that the curator had not seen. The Settings row of
slice 5 shows it in the engines position's off state, after the existing
words: "New Claude and Codex notes are imported daily (last 3 hours ago, 4
new)." / "Нові нотатки Claude і Codex імпортуються щодня (востаннє 3 години
тому, 4 нові)." With the sync off:
"Their new notes are not imported." / "Їхні нові нотатки не імпортуються." A
failed run names its reason in place of the time.

Tests (slice 8): on fixture homes, a note written after the import becomes a
backed-up pending candidate of the same import at the next due run, and not
before the interval; a note changed back to content an earlier pass dropped or
adopted inherits that disposition and is never offered; a run over the cap
leaves the rest for the next run; the sync is not due in Delegatus mode,
before any import, or with the setting off, and its schedule survives a
restart; every source file's hash is the same after the run; a helper process
killed in its inventory or while it waits for the import lock leaves its start
marked, so a restarted reader waits the hour; in the engines position the
curator claims an import pass only while that import has pending candidates,
never an ordinary pass, and a project due only for ordinary curation never
stands in front of one with a pending batch.

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

Four-scope rule-line sizes per start (UTF-8 bytes of the rendered lines;
code points and bytes differ by 5 on the seat's 9,939, under 0.1 %), with the
starts that read them in the last 7 days: builder A 16,628 bytes (919 starts), builder C 15,195 (224), builder D
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

Two sizes are kept apart. *Rule-line bytes* are the UTF-8 length of the
rendered `- [id] rule` lines, which the budgets of 5.1 bound. A *rendered start
block* adds the heading, the notice, the four scope headings and the pointer
(`roleRender.ts:11-15`, `:54-64`). The wrapper was measured by rendering four
empty scopes with the reviewed `roleRender.ts`: about 1.4 KB for the seat
(notice and pointer are long) and about 0.7 KB for a builder, with four
"none yet" lines inside both. The seat of A, read on 2026-10-16: 9,944
rule-line bytes (9,939 code points), 11,332 bytes as a rendered block. The
Claude index it also loads today is 8,620 bytes. Tokens are estimated at four
bytes per token, as in the benchmark; no tokenizer was run.

| Start | Today (rendered block + engine memory) | Delegatus mode, budgets unchanged |
| --- | ---: | ---: |
| Seat of A, Claude | 11,332 + 8,620 = 19,952 bytes (≈ 5,000 tokens) | 11,332 bytes: 8,620 less |
| Builder in A, Codex | 16,628 rule-line bytes + ≈ 0.7 KB wrapper + 11,302 summary ≈ 28.6 KB | ≈ 17.3 KB: 11,302 less |
| Builder in A, Claude | 16,628 + ≈ 0.7 KB + 8,620 index ≈ 25.9 KB | ≈ 17.3 KB: 8,620 less |

(The builder block sizes of 5.2 are rule-line bytes; the wrapper is added
here.) What Delegatus mode removes differs by project and engine, because the
Claude index of each project differs and the Codex summary is one size:

| Engine memory removed per non-clean start | Bytes | Starts last week |
| --- | ---: | ---: |
| Codex, any project | 11,302 | 1,127 |
| Claude in A | 8,620 | 385 |
| Claude in B | 7,735 | 16 |
| Claude in C | 18,703 | 86 |
| Claude in D | 4,335 | 107 |
| Claude in F | 581 | 1 |
| Claude in E | not measured | 7 |

A rise of the rule budgets costs on every start of the roles that fill them,
and it is paid for by those removals only where the removal is larger. The
rise in the table is an upper bound (every scope full) against the saving
that is certain (every start loses its engine memory), per start:

| Change | Extra rule-line bytes, once full | Net per start against what is removed |
| --- | ---: | --- |
| Seat's four-scope target 16 → 24 KB (seat of A) | up to 24,000 − 9,944 = 14,056 | Net growth about 14,056 − 8,620 = **+5,436 bytes (≈ 1,360 tokens)** over today's 11,332 + 8,620; the rendered block would be up to 25,388 bytes against 19,952 today |
| Builder four-scope target 16 → 24 KB | up to 8,000 above the 16,000 target (builder A now holds 16,628 bytes) | Codex −3.3 KB, Claude A −0.6 KB, B +0.3 KB, C −10.7 KB, D **+3.7 KB**, F **+7.4 KB** |
| Scope bound 10,000 → 15,000 code points, both builder role scopes full (with the target lifted to match) | up to 15.4 KB | Only Claude C's index covers it (−3.3 KB); **net cost** for Codex (+4.1 KB), Claude in A (+6.8 KB), B (+7.7 KB), D (+11.1 KB) and F (+14.8 KB) |

Weighted by last week's builder starts, the 24 KB builder row is a net saving
of 4.5 MB over the week only if every non-clean start filled the extra 8,000
bytes (1,729 starts × 8,000 = 13.8 MB against 18.3 MB removed); that holds for
no real week, because the roles that fill are few (builder A is the only scope
that has evicted), and a rise is a cost to Claude starts in D and F whatever
the weekly total. No rise is described as free.

### 5.5 The answer

- **Stage roles: no rise now.** The only measured loss to the budget is
  uncurated lessons evicted from one scope, and task a70effa6 removes it (no
  eviction before a curator pass, an early pass at 90 %). The benchmark's
  traced cases found delivered rules that were ignored or too narrow behind
  more errors than absent ones (§3.5), so more volume has no measured benefit
  yet, and changing budgets during the trial would confound it.
- **The orchestrator: the four-scope target stays 16,000 bytes until the
  import shows a seat candidate dropped only for room; then it rises to
  24,000 for the orchestrator role alone.** The need is unmeasured today: the
  seat of A holds 9,944 rule-line bytes, so 6,056 bytes (about 22 rules at 270
  code points) fit under today's target, against 39 notes written from checkout sessions (the seat's and the
  operator's own) of 1,962 bytes on average (the mean of all 50 root notes),
  which the curator is expected to merge into existing rules or drop in part;
  how much survives is what the import measures. If the rise is needed, its worst
  case is the +5.4 KB per seat start of 5.4, which the removed index (8.6 KB)
  does not fully cover, so it is a real cost, of the size of a few rules per
  start, paid by one conversation per project instead of the 919 builder
  starts a week. The a70effa6 ledger will count seat starts; until then the
  cost per week is not stated. The brief's sentence (`curation/brief.ts:7`)
  and the per-scope bound change only when the trigger fires, and the trigger
  is evaluated per project at the end of the import.
- **When to raise stage budgets, and by how much.** After the trial, if a
  week shows a curated rule archived for budget, raise that role's
  four-scope target by the smaller of 8 KB and the amount that role's
  recorded `dropped for room` count requires; at most 8 KB per start, with
  the per-project cost of the table above stated beside the decision (it is a
  net cost for Claude starts in D and F). A per-scope bound above 10,000 code
  points waits until a scope reaches it after a70effa6 with curated rules
  only.

## 6. The one-week trial

### 6.1 Windows

| Window | From | To |
| --- | --- | --- |
| Baseline | the switch press minus 7 days | the switch press |
| Import and drain (excluded) | the switch press | `drainedAt` |
| Trial | `drainedAt` | `drainedAt` plus 7 days |

A lane belongs to the window in which its first builder attempt that no fail
edge activated started; its reviews, their findings and its fix rounds count
when they completed (a fix round: started) within 24 hours after the window
ends, so a closed window's numbers never change with later work. A window
decides nothing before those 24 hours have passed at the read: the report
shows it as provisional. Lanes that started in the import-and-drain window are in
neither, and so is any lane with an attempt on a legacy generation (4.6). Reviewers are clean in both windows, so the judge does not change.

### 6.2 Metrics

| Metric | Definition | Role in the decision |
| --- | --- | --- |
| Failed-review share | lanes whose first reviewer verdict is `fail` ÷ lanes reviewed within the grace, with a Wilson 95 % interval | Primary |
| Fix rounds per lane | attempts activated by a fail edge ÷ lanes reviewed, mean with a bootstrap 95 % interval over lanes, and the median | Corroboration |
| Repeated finding classes | findings of a second or later review round whose keyword class (rendered, contract, seam, tests, privacy, hot path) appeared in an earlier round of the same lane ÷ findings of later rounds | Corroboration. Its base rate is high (78–86 % in every window measured), so it moves little |
| Lesson writes | lesson-request answers by kind (lesson, rewrite, none, problem, open), fix-round answers separately; seat and operator rules written | Reported |
| Evictions | budget archives, never-curated and curated separately, read from each rule's departure log | Guard |
| Import | candidates adopted, dropped by reason, adopted rules archived later in the window | Reported |

Every writer that archives a rule appends `{ at, reason, curated }` to the
rule's `departures` (`roleConsolidate.ts` `archivedRule`), and nothing removes
an entry: a later restore, curation or re-archive leaves a closed week's
evictions and adopted-archive count unchanged. A curator `problem` on a
candidate writes its agenda row already archived; that row was never an
adopted rule and is not counted as one. Import outcomes count each curator
disposition once: a copy a later sync or import inherited (4.9) is skipped. An archive the log cannot
account for (a rule archived in the window with no matching departure, a scope
history entry naming one, or a scope history that no longer reaches back over
the window) makes the window unverified, never clean.

`scripts/memory-weekly-metrics.ts --state-dir <dir>` computes this table, the
load of 6.4, the guards of 6.5 and the decision of 6.6 from `VACUUM INTO`
copies of the state database and the delivery ledger; with no `--baseline`
and `--window` it takes the windows from `memory-source.json`. The keyword
classes, the verdict reading per writer (`stage_report`, the fenced JSON
fallback, a review-loop outcome, a retried attempt, a `needs_decision` routed
along a fail edge, which counts as a fail) and the intervals (Wilson; Newcombe
for a difference of shares; a seeded bootstrap over lanes for fix rounds) are
defined in `src/lib/memory/weeklyMetrics.ts`. Held-still changes that no record
dates (the lesson request text, the curator brief, the budgets) are passed as
`--held-change <time>`; a builder or reviewer scaffold or preset (engine,
model, effort) that changes inside a window is detected from the attempts,
comparing only launches of the same project, role, effective role parameters
and stage runtime choice, because a role renders a different scaffold and
runtime per parameter (a builder's domain, a fix round's mode). Effective
parameters are the ones the scaffold renders with: an omitted or blank value
is its default, so `{}` and `{ domain: "general" }` are one variant. A missing delivery
ledger, one without its table, or one whose oldest kept start is later than a
start in the window cannot check the engine-memory guard: such a window is
unverified and decides nothing, which is distinct from a ledger that reaches
back over the window and shows no engine memory.

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
curation. A window is **invalid** (not merely inconclusive) if a ledger row
in it lists an engine memory hash, if a never-curated rule is archived for
budget, if attempts started differ from the baseline by more than 50 %, or if
a held-still item below changed. An invalid window is discarded whole: its
lanes and findings enter no estimate, no interval and no pooled count,
whichever way they would have pointed. The week then runs again from a fresh
`drainedAt` (the clean window is re-established; for an engine-memory hash
that means the drain of 4.6 is checked again before the new window opens).
Held still in the trial week: the builder and reviewer role scaffolds and
presets, the lesson request text, the curator brief and both budgets. A
change to one of them restarts the week. Mandate versions, models and the
worker limit are recorded.

### 6.6 What result switches the default

Pre-registered, on the valid windows only and on all projects together. A
valid window is one that passed every guard of 6.5; the rule below is applied
to valid windows in order.

- **Delegatus becomes the default** unless the difference in failed-review
  share (trial minus baseline) has its 95 % interval entirely above zero.
- **Claude and Codex becomes the default** when that interval is entirely
  above zero and one corroborating metric (fix rounds per lane or repeated
  classes) is also higher with its own interval entirely above zero.
- **One extension, for an inconclusive valid week only**: the interval is
  entirely above zero but no corroborating metric is. The second week must
  also be valid; the two valid weeks are pooled against the same baseline,
  and then only the primary decides, with no further extension. An invalid
  week is never an extension: it is repeated under 6.5 and contributes
  nothing. If two windows in a row are invalid, the seat stops, reports the
  guard that failed each time, and asks the operator in a decision form; the
  default is not chosen by an invalid week.

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
`delegatus/importing`, `delegatus/draining`, `delegatus/active` and `engines`, and asserts the
Claude settings (`autoMemoryEnabled`, the env flag) and the Codex arguments
and thread config (`features.memories`); "not chosen" and `importing` match
today's output byte for byte for non-clean launches. In the engines position a stage report gets no
lesson request, a launch gets no rules, the curator admission answers paused.
A clean launch is clean in all five. A resume after a change of the setting
follows the new value. The route refuses cross-origin and non-operator
writes. The automatic-recall hook (`controller.ts`) is driven by a later human
turn to a non-clean stage of each engine, with a candidate in the index that
the curator dropped and one the curator never saw: in `delegatus/draining` and
`delegatus/active` it injects no entry and records `memorySource`, before any
candidate query or spend; in "not chosen", `importing` and `engines` it selects
as today.

The byte-for-byte compatibility promise covers non-clean launches in "not
chosen" and `importing`. A clean Claude launch without `claudeConfigDir` uses
an inline settings fallback that previously omitted both engine-memory off
fields; this slice adds `autoMemoryEnabled: false` and
`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` there so the existing clean-launch promise
also holds on that path. The committed host regression pins the legacy inline
body for non-clean starts and the two permitted additions for clean fresh and
adopted starts in both compatibility states.

**Slice 2: backup and candidates.** The import job, the manifest,
`role_memory_import`, writer resolution, the loop-monitor label.
Tests on fixture homes: two account homes linking one Claude directory give
one copy and one candidate per file; a duplicate in two directories of one
project and writer gives one candidate with two occurrences; equal bodies from
two projects, and from a seat and a stage, give separate linked candidates
that keep each provenance; a 16 KB file with its decisive instruction in the
last 100 bytes gives parts that cover the file exactly once (concatenated, they
equal the backed-up bytes) and the final part's text is in a read's output; indexes, the Codex registry and rollout
summaries give none; the copy's hashes equal the sources'; every source file's
hash is the same after the job; a mismatch stops the import and returns the
switch to its previous position; the backup refuses a destination under a
checkout; the sixth backup removes the oldest by its manifest.

**Slice 3: import passes and the flip.** Candidate pages in `readCuration`,
`adopt` and `drop` in `applyCuration`, the brief's import check and the
orchestrator's 24 KB target (applied only when its trigger fires, §5.5), the
`import` rule source, parts and occurrences, the flip, the drain with its
repeated scans, partial pass undo, the cooldown exception.
Tests: a pass that leaves a candidate, a part or an occurrence unaccounted is
refused; a disposition of a part the pass's read did not return is refused, and
a 16 KB file is not counted dispositioned while any part is unread; an adopted
rule is active with `curatedAt` and its provenance (every occurrence); equal
bodies from two projects reach both projects' narrow scopes and neither is
widened to compensate; an adoption beyond the pass's reach is refused; the flip
happens once, when the last loaded-at-start file is dispositioned and not
before; the drain, with a Claude generation created before `flippedAt`: a note
it writes after the first delta scan produces a backed-up candidate at its
retirement scan, `drainedAt` is not set while it lives or before the final
scan's candidates and manifest entries are written, and a Codex generation
never holds the drain; a lane with an attempt on that generation is excluded
from the trial window; a file changed after the backup becomes a delta
candidate; undoing an import pass archives the rules no later write touched,
returns the skipped ids, and leaves a candidate whose rule was rewritten,
ranked by a second pass or merged as adopted (with the surviving id), while a
fully reversed candidate returns to pending and `adopt` refuses a candidate
that still has a surviving rule; a second import skips files already
dispositioned and not re-pended. The curator evaluation (`curator.eval.test.ts`) gains
import cases: a seat-only directive lands under the orchestrator, a writing
preference every role shares lands at machine, a task narration is dropped,
a defect becomes a problem.

**Slice 4: seats and the operator's conversations.** The seat pointer by
position, the selector for the operator's root conversations, their notice
and pointer, `leave_lesson` for them.
Tests: in Delegatus mode an operator root conversation is spawned with
`{ project, roleId: null }` and starts with the project and machine rules
under its own notice; "not chosen" spawns none; an external root of the same
shape gets no selector and no `leave_lesson` across resume, restart and a
record without the stamp; its `leave_lesson` writes
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
for each branch of 6.6, including a synthetic invalid first week (an engine
memory hash in its ledger) followed by a valid week: the invalid week
contributes zero lanes and zero findings to the decision, which is the same
with and without it in the input, even when including it would reverse the
result, and two invalid windows in a row give the stop-and-ask outcome. One row
set per verdict writer: `stage_report`,
the fenced-JSON fallback, a review-loop outcome, a retried attempt and a
parked `needs_decision`. Reviews and fix rounds appended after the grace leave
a closed window unchanged; a week read before its grace ends, or with a
missing, tableless or pruned ledger, gives no default; builder domains are
separate scaffold variants, omitted and explicit default parameters are one,
and an edit or a preset change within one invalidates the week; restoring or
re-archiving a rule after a week leaves its evictions unchanged.

**Slice 8: periodic sync while the engines' memory is on.** 4.9: the setting
and its route field, the due check on the refresh cadence, the sync run of
the import helper with its cap, content dedup against dispositioned
candidates, import passes in the engines position, and `sync` in the state
read. Tests as listed in 4.9.

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
  they write. The periodic sync of 4.9 covers the engines position only.
- **Importing the Codex registry, raw memories and rollout summaries.**
  History; searchable.
- **Restoring the engine stores from the backup in the interface.** The
  switch never writes them; a manual copy from the manifest covers damage
  from elsewhere.
- **Teaching shared recall memory to recall learned rules.** Rules are
  delivered whole at start; recall over them adds nothing yet.
- **Raising stage budgets**, until a week after a70effa6 shows the trigger of
  5.5 and its per-project cost is stated.
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
| 5. Budgets: raise if volume is needed, by how much | §5: no rise for stage roles now, the orchestrator's target 16 → 24 KB only when the import drops a seat note for room (worst case +5.4 KB per seat start, measured), and a per-project cost table for any stage rise; no rise is called free |

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
- **Parts, wrapper and budget arithmetic.** The seven long files are the
  Claude topic files over 8,192 bytes under the native home's memory
  directories (links followed, each physical file once; sizes only, no text
  read), at 2026-10-16 after the first read. The wrapper sizes came from
  rendering four empty scopes with `renderLearnedRules` of this commit, once
  for the orchestrator and once for the builder reader (1,426 and 758 bytes
  including four "none yet" lines). The seat's 9,944 rule-line bytes and
  11,332-byte rendered block come from a second read-only sample of the same
  store, by the correctness pass that reviewed this document. Everything in
  the 5.4 tables is arithmetic over those figures and the sizes of 1.2.
- **Detectable difference.** Two proportions near 0.47 with 300 lanes each:
  1.96 × √(2 × 0.25 / 300) ≈ 0.08; 80 % power at α = 0.05 needs a difference
  of about 0.11.
