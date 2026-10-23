# Carry memory, settings and accounts into a new Delegatus installation

## Originating requirement

Pinned task specification, 2026-10-22 (operator request by voice, paraphrased
for agents), verbatim:

> Operator request, 2026-10-22 (voice; paraphrased, agents only): design a way
> to carry all memory and the core settings into a new Delegatus installation
> so it keeps the needed context and configuration; full transfer of memory
> and core settings is critical when installing Delegatus. Immediate use: a
> temporary second installation on a rented server (linked to this one per
> docs/design/linked-installs.md), then every new install (npm/Docker).
> Deliver one design document at the declared output:
> 1. Inventory, from the code (file:line) and the live state directory
> read-only (names, sizes and counts only, never contents): every piece of
> state that is memory or configuration — role/project/machine learned rules
> and their history and curation records, shared memory profiles, call
> memory, voice settings and voice tools, seat tick settings and monitor
> notes, orchestrator mandates/prompt versions, role registry overrides,
> account-project bindings, worker limits, merge/release/autonomy settings,
> relay pairings and targets, Telegram destinations, forge App declaration,
> sound/UI preferences, project aliases and remotes maps, task board — and
> classify each as portable, portable-with-remap (paths, project keys,
> account ids), machine-local (hosts, registries, caches, worktrees) or
> secret.
> 2. A portable bundle format (versioned, checksummed, one file or
> directory), what goes in by default, what needs an explicit opt-in (board,
> history), and a secrets policy: credentials and tokens never ride in the
> bundle by default; the import lists which logins/pairings the operator must
> redo, with an optional encrypted channel only if the operator asks.
> 3. Export and import paths that fit the product: CLI (`delegatus export` /
> `delegatus import`), an in-app action, and a linked-install path (pull from
> the linked peer over the existing authenticated link); conflict rules on
> import (merge vs replace per section, rule ids and revisions preserved,
> project keys remapped through the existing alias/succession machinery), dry
> run with a diff, and atomic apply under the state ownership rules (AGENTS.md
> «Only a declared owner resolves the operator's state directory»).
> 4. Verification: after import, a check that compares section counts and
> rule-scope sizes with the source and shows the operator what arrived and
> what must be redone.
> 5. Slices in order and 3–7 operator decision questions (each with options
> and one recommendation).
> Fences: read-only; no product code; nothing written to live state; no
> identities, paths, ids or secrets in the document.

Operator addition, 2026-10-22 about 12:30 UTC (voice, paraphrased by the
controller), verbatim as relayed:

> transfer of the accounts in use must be part of installing Delegatus; the
> transfer is not complete if only memory and core settings moved. So the
> design must also cover accounts: every Claude and Codex (and Copilot)
> account the installation uses, with its role (active, allowed per project,
> credit guard state, labels, project bindings), and how its working login
> reaches the new install. Treat credentials as secrets: compare (a)
> re-login on the new install guided by the transfer (device-code/OAuth steps
> listed per account), (b) an end-to-end encrypted transfer of the account
> credential files over the existing authenticated linked-install channel
> with explicit per-account operator consent and immediate verification by a
> real limit read, (c) any provider rule that forbids moving a login (check
> vendor docs and say what you could not confirm). Recommend one, and make
> «accounts usable on the new install» part of the post-import verification
> (each account reads its limits successfully).
> Also add a short section on execution placement once two installs exist:
> development stays on the current install or goes to cloud agents (claude
> --cloud / codex cloud exec) where the task is self-contained; test gates and
> other CPU-heavy work run on a separate server (see task «Важкі тестові гейти
> на окремому сервері»); name what the design needs from that runner.

## Status and sources

Status: design, 2026-10-22. Read-only design stage; no product code changes
here. Every `file:line` was read at `e12215c01` (the pipeline's base on
`main`). `origin/main` moved to `8851fb611` during the stage (#3187: the Codex
memory hook is now installed per thread, and the engine's `hooks.json` no
longer carries it); it touches `src/lib/memory/hook.ts` and adds
`src/lib/memory/hookMigration.ts`, which nothing below cites, and it means no
engine hook file has to be carried to a new install.

Live state on the machine this design was written for was read read-only
between 12:30 and 12:55 UTC on 2026-10-22: directory listings, file sizes,
SQLite row counts and JSON key names. Record bodies were parsed only inside
scratch scripts that printed counts; no memory text, rule text or value was
printed or quoted. Engine credential files were checked for presence and size
only; state files that hold a secret beside settings (the environment file,
the peer list, the relay store) were parsed for key names and counts only.
The method is in §1.1.
Accounts and projects are described by kind and count only.

What "done" means for this design, read from both quotes: after an import,
the new install holds the source's learned rules with their history, its core
settings, and every account the source uses in the same role, and each of
those accounts has read its limits live on the new install. Anything that
could not travel is on one list the operator works through. The validation is
in §9.

### Built

Operator decisions of 2026-10-22: Q1 (a), Q2 (a), Q4 (a), Q5 (a), Q6 (a); Q3
overridden: the bundle carries Delegatus memory only, engine memory is
imported into Delegatus memory before export (`memory-source-switch.md`) and
slice 3 is dropped. What the build settled differently from the text below:

- The code is `src/lib/transfer/`. Sections are made of parts, one per store
  (`sections.ts`); a record key is `<part>|<key>`. Project keys are remapped by
  rewriting every `repo-…`/`dir-…` key in a record (`projectKeys.ts`).
- The subscription API consent, the voice tool registry, relay targets,
  Telegram chats and the machine worker limit wait in the import record and on
  the redo list. The memory source travels only once the source settled it
  (Delegatus memory with its engine import finished, or the engines' own
  memory): it is written to a target that never chose, as that settled choice,
  so the target starts no engine memory import; a target's own choice stays,
  and a choice the source is still importing waits on the redo list.
- Settings whose record holds several choices (project settings) merge per
  choice: a field the target set stays, a field it never set arrives.
- The shared memory index is not refreshed after an import: it is built from
  engine memory files, which no longer travel.
- Only the journals of the closed calls that travel go with them; an ongoing
  call's journal and one no closed call cites stay on the source.
- The secret guard also covers the finished header: environment values,
  project names and remotes, account labels and notices.
- The engine memory notice compares, on an install that already switched to
  Delegatus memory, each engine memory file's content with the manifest of
  the import that switch ran: a file added or changed since is named, with
  the action that imports it (switch to the engines' memory and back). An
  install that never switched names every engine memory file. Engine memory
  is never read into the bundle.
- `delegatus export` needs the running Viewer, like `import`; an export of an
  install whose Viewer does not start is deferred.
- File revisions in the dry run are content hashes, so a file restored by a
  rolled-back import still matches its preview.
- Apply holds the shared write lock of every file it writes from the revision
  check through its commit or rollback, and checks each file again just before
  writing it. Every product writer of those files takes the same lock for its
  read-modify-write (shared memory, project, operator and «asks you»
  settings, relay switches, the voice choices; worker limits, the memory
  source and the voice companion store already did), so a setting changed
  during an apply waits and lands on top of the import, or of the original
  after a rollback. A file the dry run found absent is created only if it
  still is (written aside, then linked into place), so a writer that made it
  meanwhile keeps it, lock or no lock. A target file that is a link, not a
  regular file, or over 64 MiB is never read or replaced: its records are
  skipped as `target-file-unreadable`.
- The checkpoint is a hard link to each replaced file (a copy where links are
  refused), kept beside the file under a name of the import, so putting it
  back is a rename inside one directory that needs no free space and never
  crosses a file system, wherever the state and config roots live; a full
  disk during the writes leaves the originals in place. A rollback puts
  back only what is still the import's: a file holding the import's bytes gets
  its original back, a file a later writer rewrote keeps that writer's values
  and loses only the import's own, and a file the import never reached is left
  alone. The work after the commit (lesson known values, accounts) is recorded
  in the import record and finished by recovery. A recovery that cannot settle
  refuses the Viewer's activation; the journal stays for the next start. A
  journal or an import listing that exists and cannot be read or decoded
  (an I/O error, permissions, a damaged journal) is such a refusal, never read
  as absent; only an import directory whose journal was never written holds
  nothing to settle.
- For an apply the serving Viewer takes the account mutation lock itself and
  lends that hold to its worker, so the lock never passes to a waiting launch
  between a worker's death and the recovery. After a failed apply the Viewer
  runs recovery at once under that hold; a recovery that fails keeps the hold
  and is retried (after 5 s, 30 s, 2 min, then every 10 min) until it settles,
  answering the caller `recovery_pending` meanwhile, so launches and further
  imports wait.
- Each import record lists the bundle records it did not apply: those it
  skipped, and conflicts where this install kept its own value. Importing the
  same bundle again plans only the records no earlier import of it applied
  (§4.8), so a newly mapped folder or «take the source's» still works, and a
  record that arrived is left as this install now holds it: a rule edited
  here since gets no second stored version. Such records count as skipped,
  `already-imported`.
- Accounts (slice 2, `src/lib/transfer/accounts.ts`): an account travels
  when it is signed in or bound to a project. Its identity hash is salted
  with the export id. On the target an account stands in for a source account
  only when it is proven the same: the account an import of the same export
  made, an account here signed into the identity this export reports (an
  earlier import's account included), the target's own engine home while
  signed out or signed into the same identity, or the same id signed into
  the same identity. A row an earlier import left proves nothing by itself:
  another install, or the source after a new login, can use the same id, and
  each export salts its identity hash anew. A checklist row is keyed by the
  source account and the account here, so a later import never inherits an
  earlier row's state or confirmation; only the same export keeps them, and
  an account proven by its login is read again before it is ready. Every other account
  gets a fresh id, reserved before the commit by an empty home that every
  account setup skips. The bindings and the checklist rows commit in the
  import's own transaction, so a project is fenced to its accounts before any
  of them exists; the accounts are then made through the existing account
  setup under their reserved ids, and recovery or «Try again» finishes one that
  failed or was cut short, making it once. An account that cannot be made here
  (a Claude custom-provider account, whose token never travels) is bound under
  an id no account can have, so its projects park. The checklist rows live in
  the `transfer_accounts` collection; `POST /api/transfer/accounts` verifies
  them with the `transfer-verify` live read, and a completed sign-in settles
  its row at once. Usable needs that read's own observation: provenance
  `live` with no stale mark, taken within two minutes of the check, naming a
  plan and at least one window. A cached or carried reading, or one without
  a plan, stays `read_failed` and switches no active account. A source identity that this install cannot read keeps the
  row waiting, and nothing becomes active, until a read answers or the
  operator confirms the account. The checklist is in the desktop accounts
  dialog (inside its bounded account list; the dialog itself is bounded to the
  window), on the phone's accounts screen and in the Copilot list, which
  opens as the Claude and Codex account lists do, a flyout beside the rail
  bounded by the room above its row and scrolling inside: opened inline in
  the rail's footer it ran under the lower edge of a short window. Copilot
  rows count as usable when the CLI config shows a signed-in user; no limit
  read exists for them (§11), and the Copilot checklist says so.
- Measured apply window for the learned rules of §1.10's shape (2,898 rules,
  112 scopes, about 20 MB of history): 1.33 s in the worker, 1.62–1.63 s with
  the worker's start, over three runs on the shared test server on
  2026-10-23 (`src/lib/transfer/transferMeasure.test.ts` with
  `LLV_TRANSFER_MEASURE=1`). The test applies in the real worker under the
  Viewer's own deadline, so an apply that hangs is stopped and fails.

## 0. Earlier work this builds on

`search_transcripts` (project-scoped, then unscoped; "export import memory
bundle new installation", "перенесення пам'яті нова інсталяція", "delegatus
export state bundle portable") and `search_memory` ("transfer memory settings
new install export import") found no earlier design or conversation about
moving memory, settings or accounts to another install. The board holds the
related task «Важкі тестові гейти на окремому сервері» (inbox, not started).
The designs below settled parts of this problem and are reused as they are.

| Earlier work | What it settled | How this design uses it |
| --- | --- | --- |
| `docs/design/keys-settings.md` §2b, §7, §15 (built) | API keys and the Telegram bot token move between machines as `NAME=value` lines through `POST /api/keys/export` and `POST /api/keys/import`, behind the owner gate `src/lib/keys/access.ts:33-49`. Engine logins, the access key, team sessions, push keys, the GitHub App credential and the Telegram personal session "stay with their machine or account" (§2b), because "refresh tokens rotate: a copy that refreshes on machine B logs machine A out". | The bundle carries no API key; its redo list sends the operator to Keys → Import. The classification of §2b is kept. |
| `docs/design/linked-installs.md` §2, §2.4-2.5, §10.2, M.0-M.5 (pairing and board sync built) | Pairing codes, the `X-Delegatus-Peer` header, a uniform `401`, HTTPS for public peers, scopes on a grant (`board:sync` only today, `src/lib/links/protocol.ts:51`), and the rule that a stronger capability is "a separate, explicit grant per peer, never implied by the read-only pairing" (§10.2). Board tasks of shared projects already sync both ways. | The link path (§4.4) adds two scopes the receiving operator grants for one transfer. The board section stays off for projects the two installs already share. |
| `docs/design/state-sqlite-migration.md`, `src/lib/state/legacyCollections.ts:24-163` | Most memory stores and many settings stores are collections of `state.sqlite`; the rest are small JSON files in `<state>`. Backups are `VACUUM INTO` copies taken in a worker off the Viewer's thread (`src/lib/state/durability.ts:28`, `:873-876`). | Export reads a `VACUUM INTO` copy; import commits all SQLite sections in one transaction. |
| `docs/design/role-memory.md`, `role-memory-curation.md`, `role-memory-layers.md` | Rule rows are never deleted, scopes keep their history and the curator's Undo records, the 10 000-code-point scope figure is a target that overflows until curation (`src/lib/memory/roleTypes.ts:11-13`). | §4.6 keeps every row, id and history entry. |
| `docs/design/memory-source-switch.md` | One memory per installation, chosen by a switch between Delegatus memory and the engines' own memory. | The engine memory section follows the source's switch position (§2.2). |
| `docs/design/agent-memory.md` §1.2 | Claude auto memory lives in `~/.claude/projects/<project>/memory/`, where `<project>` is derived from the git repository path. | §2.3 remaps those directories by project key. |
| AGENTS.md, «Only a declared owner resolves the operator's state directory» and «Worktree → project grouping» | Only `viewer` and `runtime-host` run state-mutating startup steps; a repository key comes from its origin remote and is the same on every machine, a folder key comes from a path. | §4.1 and §2.3. |

Open changes that touch the same ground, read on 2026-10-22: #3188 (voice
tool approvals are sealed with a key that has no disk copy, so approvals
become pending after a restart) agrees with §4.6, which brings voice tools in
as pending. #3193 adds browser-local sound keys (`llvAudioTypingEnabled`,
`llvAudioHeardDone`, `llvAudioEventTab`); §2.2 takes the browser keys from the
modules that own them, so new keys arrive without a change here. #3169 (Host
allowlist on every route) must also admit the new peer routes of §4.4 through
the existing peer guard. None of the three edits a file this design cites as
built behaviour.

## 1. Inventory

### 1.1 How the live state was read

- Directory listings and `du` of the app directory, the state directory and
  its subdirectories, names only.
- Row counts of `state.sqlite`, `telegram/bot.sqlite`, `team/team.sqlite`,
  `role-memory/delivery.sqlite` and `activity/records.sqlite` through a
  scratch `bun:sqlite` script that opened each database with `readonly: true`,
  grouped `state_rows` by collection, and grouped row keys by prefix.
- For JSON files: top-level key names and list lengths, parsed in a scratch
  Python process that printed no values.
- For the environment: variable names only, from a key-only parser.
- Account homes: presence and byte size of the credential file, never its
  content.
- Bundle size estimates: the rows each default and opt-in section would carry,
  concatenated and compressed with `node:zlib` `gzipSync` (level 6) at
  12:47:09 UTC. Role memory counts were taken again at 12:53:38 UTC in one
  read, because a lesson landed between two earlier reads.

Nothing was written to live state. The scratch scripts lived in the stage's
own temporary directory and are not part of the change.

### 1.2 Where state lives

| Root | Resolved by | Holds |
| --- | --- | --- |
| `<config>`: the app directory, `delegatus` (or `agent-log-viewer` on an install from before the rename) under `$XDG_CONFIG_HOME` | `src/lib/configDir.ts:25-37`, `bin/appDir.mjs` | API key files, voice backend choices, `telegram.json`, the access key file, `service.env` |
| `<state>` = `<config>/state` | `src/lib/configDir.ts:186-201`, `:222-224` | Everything below unless named otherwise. On the live machine: 116 entries; `state.sqlite` 309 MB with 21,127 rows in 33 non-empty collections |
| `<config>/accounts/<engine>/<id>` | `src/lib/accounts/claude.ts:55`, `codex.ts:114`, `copilot.ts:88-90` | One engine home per managed account (CLI config, credential, transcripts). Live: 26 GB in total, of which 20.5 GB are transcript directories |
| The operator's own engine homes, `~/.claude`, `~/.codex`, `~/.copilot` | `src/lib/accounts/claude.ts:54`, `copilot.ts:117-119`, `src/lib/memory/service.ts:22-35` | The legacy ("Main") account of each engine, engine memory files, global instruction files, skills |
| The browser's `localStorage` | `src/lib/audio/prefs.ts:5-23`, `src/lib/i18n/index.ts:9` and the other `llv*` keys | Sound, theme, panel widths and other UI preferences of that browser profile |
| The service environment | `service.env`, the service unit | Live: two names in `service.env` (the access key and the agent CPU placement) and one language variable in the unit |

### 1.3 Classes

- **P, portable**: means the same thing on any install; copied as is.
- **R, portable with remap**: portable once project keys, account ids or
  paths inside it are translated (§2.3). The table names what remaps.
- **M, machine-local**: describes this machine's processes, hosts, caches,
  registries or worktrees; rebuilt or re-observed on the target, never
  copied.
- **S, secret**: a credential or token; never in the bundle (§2.4).
- **H, history**: portable in principle, large and mostly useful only on the
  machine that produced it; carried only on explicit opt-in.

### 1.4 Memory

| Item | Code | Live (names, counts, sizes) | Class | Section |
| --- | --- | --- | --- | --- |
| Learned rules, every state (active, merged, archived, kept earlier versions) | `src/lib/memory/roleStore.ts:30-59`, rule fields `roleTypes.ts:88-123` | `role_memory` `r:` rows: 2,898 (459 active, 213 merged, 2,226 archived; 1,423 are earlier versions of rewritten rules); 2,536 written by stages, 362 by seats; 3.7 MB | R: the project key inside the scope and inside `source.project` | `memory.role` |
| Rule scopes: active list, revision, history with the curator's Undo records | `roleStore.ts:30-48`, scope keys `roleScopes.ts:1-8` | 112 `s:` rows, 20.2 MB (history is most of it): 91 role-in-project scopes (297 active rules, 79,014 code points of rule text, 2,462 history entries), 13 role-on-every-project scopes (142; 33,116; 1,109), 7 project scopes (1; 255; 326), 1 machine scope (19; 4,011; 194). Largest single row 4.68 MB | R: project keys in scope names; the machine scope is Q2 | `memory.role` |
| Lesson requests per stage attempt (which rules an attempt received, applied, misled) | `roleStore.ts:54`, `:296-310` | 2,570 `q:` rows, 1.0 MB | H: names attempts and conversations of this install | `history` |
| Curation state per project and for the machine | `src/lib/memory/curation/store.ts:33` | `role_memory_curation` `p:` 7 rows and 1 machine row, 15 KB | R | `memory.role` |
| Curator runs and conversation passes | same | 171 `r:` and 164 `c:` rows, 1.9 MB | H | `history` |
| Rule delivery ledger | `src/lib/memory/deliveryLedger.ts:136` | `role-memory/delivery.sqlite`: 2,877 deliveries | M: records which of this install's attempts received which rules | none |
| Lesson known values for the publication gate | `roleStore.ts:908-935` | `role-memory/known-values.txt`, 4,637 lines | M: derived; rewritten on the target after import (§4.8) | none |
| Memory profiles per project and language | `src/lib/memory/profileStore.ts:7` | `memory_profile` 4 rows, 106 KB | R | `memory.profile` |
| Shared memory switch per project | `src/lib/memory/settings.ts:9-22` | `shared-memory-settings.json`, 1 project | R | `memory.settings` |
| Memory source switch (Delegatus memory or engine memory) | `src/lib/memory/source.ts:55` | absent: never chosen | P | `memory.settings` |
| Shared memory search index | `src/lib/memory/index.ts:141` | `memory-index.sqlite` 48.5 MB | M: derived from the files below | none |
| Engine memory: Claude project memory | `src/lib/memory/sources.ts:56-76`, location `docs/design/agent-memory.md` §1.2 | 775 files in 23 project directories of the legacy Claude home, 1.48 MB; both managed Claude homes link to them (22 links each) | R: the directory name encodes the checkout path | `memory.engine` |
| Engine memory: Codex memories | `sources.ts:81-84` | 403 files, 2.94 MB in the legacy Codex home; the three managed Codex homes link their `memories` to it (`src/lib/accounts/codex.ts:22`, `:573`) | P | `memory.engine` |
| Global instruction files | `sources.ts:57`, `:78-80` | one Claude and one Codex file (698 and 1,587 bytes); every managed home links to them (Codex by product code, `codex.ts:22`, `:573`; Claude by links no product code at the base creates) | P | `memory.engine` |
| Skills | `sources.ts:85-87`, shipped skills linked by `bin/skillLinks.mjs:1-16` | three skill roots with 109, 79 and 117 `SKILL.md`; a shared root with 103 linked into each managed Claude home | P for the operator's own; shipped ones are re-linked by the installer | `memory.engine` |
| Call memory: per-call summaries and the call journals they come from | `src/lib/voiceCompanion/callMemory.ts:97-135`, `callMemoryTypes.ts:22`, `transcriptRecord.ts:33` | `voice-companion/transcripts`: 30 files, 2.3 MB; only the last 7 days are offered to a call | R: project keys | `memory.calls` |
| Engine-memory import candidates and backups | `src/lib/memory/importStore.ts:1-40`, `importBackup.ts` | `role_memory_import` collection absent | H | `history` |

### 1.5 Core settings

| Item | Code | Live | Class | Section |
| --- | --- | --- | --- | --- |
| Seat tick settings per project: on/off, wake interval, instruction lines, the monitor note (`monitorPrompt`), autonomy and its history, release, auto-rotation, board maintenance, curation, expiry | `src/lib/monitor/seatTickSettings.ts:105-135`, `:348` | `seat_tick_settings` 9 rows, 91 KB (7 repository keys, 2 folder keys) | R | `settings.seat` |
| Seat tick run state | `src/lib/monitor/seatTickState.ts:49` | `seat-tick-v3` 550 rows, `seat-tick/` 13 files | M | none |
| Orchestrator seats: mandate text, the default-prompt version it was based on, role table, engine, model | `src/lib/orchestrator/seats.ts:94-106` | `orchestrator-seats.json` 1.43 MB: 10 active seats, mandates of 27-28 KB each | R: project key | `seats` |
| Seat parts bound to this install: conversation, path, seat epoch, credential baseline, lineage, history | same | same file | M | none |
| Seat deputies, seat deployments, decision forms | `src/lib/orchestrator/deputies.ts:135`, `seatDeployments.ts:54` | 7 deputies; `seat-deployments.json`; `seat-decisions` 116 rows | M; decision forms H | `history` (forms) |
| Role registry overrides (engine, model, effort, scaffold per role) | `src/lib/roles/store.ts:20-37` | `role_presets` 3 rows | P | `settings.roles` |
| Review-loop presets, workflow templates, spawn nesting policy | `src/lib/state/legacyCollections.ts:85-104` | no rows | P | `settings.roles` |
| Worker limits: one per project and one for the machine | `src/lib/operator/workerLimit.ts:1-38` | `worker-limit.json`: machine value set, 0 project values, 1 history entry | Project values R; the machine value M by meaning (other hardware) | `settings.limits` |
| Merge on review, bridge reports, reports to Telegram per project | `src/lib/projects/settings.ts:1-60`, `:99` | `project-settings.json`: 5 projects (merge on review set on 1, report chat on 5) | R | `settings.projects` |
| Operator language and time zone | `src/lib/operator/settings.ts:1-56` | `operator-settings.json` | P | `settings.operator` |
| «Asks you» spending cap | `src/lib/asks/settings.ts:40` | `asks-you-settings.json` | P | `settings.operator` |
| Subscription API consent | `src/lib/accounts/subscriptionApiConsent.ts:9` | `subscription-api-consent.json` | P, but a consent: re-confirmed on the target | `settings.operator` |
| Setup guide progress | `src/lib/onboarding/marker.ts:41` | `onboarding.json` | M | none |
| Voice call settings: on/off, call memory on/off, backend, monthly cap | `src/lib/voiceCompanion/storage.ts:15-31`, `:112-120`, `:213` | inside `voice-companion.json` (6.9 MB, almost all call records and charges) | P | `settings.voice` |
| Voice call charges, sessions, month usage | same | same file | M: this install's accounting | none |
| Read-aloud and dictation backends, voices, models, persona | `src/lib/ttsBackend.ts:54-79`, `transcribeBackend.ts:28`, `:52`, `src/lib/runtime/voicePersona.ts:364` | `<config>/tts-backend`, `tts-voice-*`, `tts-model-*`, `transcribe-backend` | P | `settings.voice` |
| Voice tools: registry and approvals | `src/lib/voiceTools/store.ts:143-160`, `hub.ts:150` | `voice-tools.json` absent | Registry R (entries name local commands); approvals M (sealed per process, open #3188) | `settings.voice` |
| Voice tool secrets | same | `voice-tools-secrets.json` absent | S | none |
| Forge App declaration (repositories whose writes go through the App) | `src/lib/git/agentForgeCredentials.ts:26-37` | `forge-app-repositories.json`, 1 repository | P | `settings.forge` |
| Forge App credential | `bin/forge-app-token.mjs:28`, `:580` | OS keyring | S | none |
| Sound and UI preferences | `src/lib/audio/prefs.ts:5-23` ("device-local by construction"), language `src/lib/i18n/index.ts:9`, theme, panel widths, rail state | browser `localStorage` only; no server copy | Device-local by design | `browser` (opt-in) |
| Settings supplied by the environment | `src/lib/accounts/creditGuard.ts:19-22` (credit guard threshold), CPU placement, language | names only, §1.2 | M: the deployer's environment; listed by name, values only for an allowlist of non-secret names | report only |

### 1.6 Accounts

Live: three Claude accounts in use (the legacy home and two managed homes),
four Codex accounts (the legacy home and three managed homes), no Copilot
account (`copilot-accounts.json` absent, no `~/.copilot`). One account per
engine is active. Each of the five managed homes and both legacy homes holds a
credential file.

| Item | Code | Live | Class | Section |
| --- | --- | --- | --- | --- |
| Registry row per account: id, label, kind, creation time | `src/lib/accounts/accountsStore.ts:62-100`, `claude.ts:25-38`, `codex.ts:30-70`, `copilot.ts:32-40` | `accounts` collection: 2 `claude:` rows, 3 `codex:` rows; legacy accounts have no row | R: account id; a legacy account becomes a managed one on the target when the target's own engine home is taken (§2.3) | `accounts` |
| Active account per engine | same, `active:<engine>` rows | 2 rows | P, applied after verification | `accounts` |
| Account-project bindings (which accounts a project's work may run on) | `src/lib/accounts/projectBindings.ts:10-58` | 14 `binding:` rows: per engine 7 bindings over 3 projects, naming 3 Claude and 4 Codex accounts | R: project key and account id | `accounts` |
| Out-of-pool choice journal | `src/lib/accounts/accountOverrides.ts:8-34` | 6 `override:` rows | H: a report, never an input | `history` |
| Claude custom provider (base URL, model, header names) | `claude.ts:34-38` | none | P | `accounts` |
| Claude custom provider token | `claude.ts:152` | none | S | none |
| Credit guard: threshold and the paid-credit state of each Codex account | `src/lib/accounts/creditGuard.ts:19-55` | threshold not set (default 99 %); paid-credit state lives in the last limit observation | Threshold M (environment); state M: recomputed from the first live read (§3.5) | report only |
| Limit observations, limit history, reset-credit journal | `src/lib/limits.ts`, `src/lib/limitsHistoryStore.ts:38`, `src/lib/accounts/resetCreditJournal.ts:16` | `limits-cache.json`, `limits-history.json` (890 KB), `codex-reset-credits.ndjson` | M | none |
| Spawn admission fences, login operations, device-login attempts | `accountsStore.ts:85-100` | 115 `fence:` rows | M | none |
| Claude login | `src/lib/accounts/claudeCredentials.ts:33-60` | `.credentials.json` (524 bytes) in each Claude home; on macOS the Keychain entry is keyed by a hash of the home path (`:37-41`) | S | none |
| Codex login | `src/lib/accounts/codex.ts`, vendor doc §3.2 | `auth.json` (4.2-4.4 KB) in each Codex home | S | none |
| Copilot login | `src/lib/accounts/copilot.ts:14-27` ("the token itself stays in the desktop keyring and is never read") | none live | S | none |
| Account homes: CLI config, transcripts, caches | `claude.ts:55-70` | 26 GB (20.5 GB transcripts) | M (config regenerated by Delegatus; transcripts §10) | none |

`accountsStore.ts:51-53` already states the rule this design keeps:
"CREDENTIALS NEVER MOVE. `.credentials.json` and `auth.json` are not state".

### 1.7 Projects

| Item | Code | Live | Class | Section |
| --- | --- | --- | --- | --- |
| Project key of a repository with an origin: hash of the remote | `src/lib/projects/identity.ts:160-175` | — | P: the same key on every machine | header |
| Project key of a folder or of a repository without origin: hash of the path | `identity.ts:56-57`, `:193-200` | — | R | header |
| Display names (`name:` rows) | `src/lib/projects/aliases.ts:1-80` | part of `project_aliases`, 10 rows in total | R | `settings.projects` |
| Aliases (`alias:` rows): old key → current key | same; `src/lib/projects/succession.ts` | same | M: export resolves every key through them (§2.3); new transfer aliases are written on the target | none |
| Remotes map behind each repository key | `aliases.ts:302` | `project_remotes` 6 rows | M: AGENTS.md never aliases a forge rename through a remote this machine did not record itself; importing another machine's map would weaken that rule | none |
| Crowned projects and projects created by hand (name and root folder) | `src/lib/projects/curation.ts:14-26`, `:61` | `project_curation` 11 rows | Crowned R; manual projects R (the root is a path; the target asks for a folder) | `settings.projects` |
| Worktree map, worktree recovery rows, project catalog, directory suggestions | `src/lib/projects/worktreeBackfill.ts:222`, `:251` | `worktree_map` 1,720 rows; `project-catalog.json` 11.5 MB | M | none |

### 1.8 Relay, Telegram, linked installs, team, keys

| Item | Code | Live | Class | Section |
| --- | --- | --- | --- | --- |
| Relay pairing credential and this install's relay id | `src/lib/externalRelay/store.ts:50-90` | `external-relay/relays.json`: 1 paired relay | S and M: bound to this install's id; re-paired on the target | none |
| Relay target settings (engine, model, effort, project, concurrency, caps, owner tier) | same, `:20-25` | 3 targets | R: project key; re-applied after re-pairing to the same targets | `settings.relay` |
| Relay switches | `src/lib/externalRelay/switches.ts:5` | 1 switch | P | `settings.relay` |
| Relay runs, requests, answers, conversation homes | `store.ts:91-120`, `answers.ts:73`, `conversations.ts:21` | 875 files, 43 MB | M / H | none |
| Telegram destinations: bot chats with alias and posting permission | `src/lib/telegram/bot/store.ts:254-268` | 5 chats, all with an alias and posting allowed; 3 chat-bot rows | R: valid only for the same bot | `settings.telegram` |
| Telegram bot token | `src/lib/telegram/bot/transport.ts:143-150` | `telegram/bot-token.json` | S: moves through Keys → Import | none |
| Telegram messages and sends | same | 2,417 messages, 2,140 sends | H | none |
| Telegram personal session, connector token, app credentials | `src/lib/telegram/sessionStore.ts:31-35`, `src/lib/telegram/packaging.ts:126` | `telegram/session.json`, `connector-token`, `<config>/telegram.json` | S | none |
| Telegram host registrations | `legacyCollections.ts:115-118` | `telegram_registrations` 3 rows | M | none |
| Linked installs: own address, peers with tokens, grants, shared projects | `src/lib/links/linked.ts:29`, `self.ts:73` | `links/`: 1 peer (this install connects to it and grants nothing), 1 shared project | S and M | none |
| Team: members, sessions, passkeys | `src/lib/team/store.ts:772` | 3 members, 7 sessions, 0 passkeys | S and M | none |
| Access key, Viewer control credential, push keys and subscriptions | `bin/viewerGateKey.mjs`, `src/lib/push.ts:14-16` | `<config>/token`, `push-keys.json` | S and M | none |
| API keys (OpenAI, ElevenLabs, Soniox, Fish Audio, OpenRouter) | `src/lib/keys/store.ts:29-41` | 5 files in `<config>` | S: Keys → Export / Import already moves them | none |

### 1.9 Board, history and caches

| Item | Code | Live | Class | Section |
| --- | --- | --- | --- | --- |
| Tasks | `src/lib/tasks/store.ts`, `legacyCollections.ts:25-29` | `tasks` 2,853 rows: 523 open, 2,224 done, 106 other rows; 11.9 MB | R | `board` (opt-in) |
| Board layout and links per project | `src/lib/board/store.ts:26` | `board` 12 rows, `board_links` 4 | R | `board` (opt-in) |
| Pipelines, archived pipelines, bridge reports, done items, attention, prototype reviews, spawn notices | `src/lib/pipelines/store.ts:46-47` and others | 355 + 1,248 pipelines (203 MB of JSON), 2,506 bridge reports, 1,465 done items, 837 prototype reviews (756 MB) | H | `history` (opt-in; prototype media excluded) |
| Transcripts | account homes | 20.5 GB | M (§10) | none |
| Activity records, usage, telemetry, journals, sweep reports, backups, scratch, runtime images, release records | `src/lib/activity/store.ts` and others | `activity/records.sqlite` 46 MB, `backups/` 3.6 GB, others | M | none |

### 1.10 Measured size of each section

Rows each section would carry on the live machine, raw JSON and compressed
(`gzipSync`, level 6, 12:47:09 UTC). Measured on the rows only; the bundle's
header and line framing add a few kilobytes.

| Section group | Rows | Raw | Compressed |
| --- | --- | --- | --- |
| Learned rules, scopes, curation state | 3,018 | 23.9 MB | 3.6 MB |
| SQLite settings collections (seat ticks, role overrides, memory profiles, project names and curation, account rows and bindings, Telegram registrations) | 73 | 0.22 MB | 0.05 MB |
| Board (opt-in): tasks, layout, links | 2,869 | 13.7 MB | 3.7 MB |
| History (opt-in): pipelines and archive, bridge reports, done items, lesson requests, curator runs, decision forms | 8,597 | 225 MB | 40 MB |

Files outside `state.sqlite` add about 4.4 MB of engine memory text, 2.3 MB of
call journals, 0.3 MB of seat mandates and a few kilobytes of settings files.
A default bundle on this machine is therefore about 5 MB compressed.

## 2. The bundle

### 2.1 Format

One file, `delegatus-transfer-<date>.dlgt`: a gzip stream (`node:zlib`) of
JSON Lines. No archive library is needed: every record is text, including the
engine memory files, which are UTF-8 Markdown.

```
line 1     header  {"format":"delegatus-transfer","version":1,
                    "exportId":<random>,"createdAt":<ISO>,"product":<release>,
                    "sections":[{"name","schema","records","bytes","sha256","summary"}],
                    "projects":[{"key","kind","displayName","remote"?}],
                    "accounts":[{"engine","id","label","kind","active","identity"}],
                    "environment":[{"name","value"?}]}
lines 2..n record  {"s":<section>,"k":<key within the section>,"v":<value>}
last line  trailer {"end":true,"records":<n>,"sha256":<hash of every byte before this line>}
```

- **Versioned.** `version` is the container format; each section has its own
  `schema`, which is the owning store's schema version (for example the role
  memory collection's `schemaVersion: 1`, `roleStore.ts:69`). A target that
  does not know a section, or knows an older schema of it, skips that section
  and lists it as "needs a newer Delegatus".
- **Checksummed.** Each section's `sha256` covers its record lines in order;
  the trailer's `sha256` covers the header and every record. The import
  checks both before it shows a dry run. Export writes each section to a
  temporary file first, so the header can carry counts and hashes, then
  concatenates.
- **Summaries for verification.** `summary` holds what §5 compares: for
  `memory.role`, per scope the number of rules, active rules, active code
  points as the store counts them (`scopeChars`, `src/lib/memory/roleConsolidate.ts:24`) and
  history entries; for other sections, record counts per kind.
- **Bounds.** The import refuses a file whose declared total exceeds 1 GiB
  uncompressed, stops reading when the decompressed bytes pass the declared
  total (a decompression bomb ends there), and refuses a line longer than its
  section's declared byte length. There is no fixed per-record cap: the
  largest live record is a 4.68 MB scope row whose history has no hard
  ceiling, and a fixed cap would one day refuse a real install.
- **Records are the stores' own rows.** A value is exactly what the owning
  store keeps (a `state_rows.value_json`, a settings file's body), so the
  import validates each record with the owner's decoder (for role memory the
  strict decoder at `roleStore.ts:62-68`) and writes through the owner's
  writer. No second schema exists to drift from the stores.
- **Sealed form (Q4).** When sealed, the file begins with one plain line
  `{"format":"delegatus-transfer-sealed","version":1,"kdf":{"name":"scrypt",…,"salt"},"cipher":"aes-256-gcm","chunk":1048576}`
  followed by the gzip stream encrypted in 1 MiB chunks, each with its own
  nonce and tag, from `node:crypto` (the M2 construction of
  `keys-settings.md` §7, which was designed there and not built). The
  passphrase is generated, shown once, and never stored.

### 2.2 Sections and defaults

| Section | Default | Contents | Excluded on purpose |
| --- | --- | --- | --- |
| `memory.role` | on | every rule row in every state, every scope row with its history, curation state per project and for the machine | lesson requests and curator runs (→ `history`); the delivery ledger stays on the source |
| `memory.profile` | on | memory profiles | — |
| `memory.settings` | on | shared memory per project, memory source switch | the search index (rebuilt) |
| `memory.calls` | on | call summaries and the call journals they cite, the call memory switch | charges, live sessions |
| `memory.engine` | on when the source's memory source (`src/lib/memory/source.ts:11`) is unchosen or `engines`; offered off when it is `delegatus` (Q3) | Claude project memory per project, Codex memories, global instruction files, the operator's own skills | shipped skills (the installer links them), engine config files (regenerated), transcripts |
| `settings.seat` | on | seat tick settings per project, monitor notes included | run state |
| `settings.roles` | on | role overrides, review presets, workflow templates, nesting policy | — |
| `settings.limits` | on | project worker limits; the machine value as a suggestion only | — |
| `settings.projects` | on | merge on review, bridge reports, report chats, display names, crowned projects, hand-made projects (name and folder name only) | aliases, remotes map, worktree map, catalog |
| `settings.operator` | on | language, time zone, «asks you» cap, subscription API consent (to re-confirm) | setup guide progress |
| `settings.voice` | on | call settings, read-aloud and dictation choices, persona, voice tool registry | tool secrets and approvals |
| `settings.forge` | on | App repository declaration | App credential |
| `settings.relay` | on | relay target settings and switches, by relay origin and target id | pairing credential |
| `settings.telegram` | on | chat aliases and posting permission, by bot id | bot token, messages, personal session |
| `accounts` | on | per account: engine, id, label, kind, active flag, Claude provider settings, a hash of the login identity the provider reports; bindings | every credential, fences, observations |
| `seats` | on, as drafts (Q5) | per seat: project, engine, model, role table, mandate, prompt version | conversation, path, epoch, credential baseline |
| `board` | opt-in | tasks, board layout, board links | projects already shared with that install through board sync |
| `history` | opt-in | pipelines and archive, bridge reports, done items, decision forms, lesson requests, curator runs, out-of-pool journal, engine-memory import records | prototype media, transcripts, delivery ledger |
| `browser` | opt-in, in-app export only | this browser's preferences, keys taken from the modules that own them (`src/lib/audio/prefs.ts:19-23` and the others in §1.5) | anything outside that list |

The header's `environment` lists the names of the `DELEGATUS_*` and `LLV_*`
variables set for the source's Viewer. Values are included only for an
allowlist of non-secret settings (CPU placement, the credit guard threshold,
language); every other name, the access key among them, appears without a
value. The import never sets an environment variable; it lists them for the
operator.

### 2.3 Project keys and account ids

Export resolves every project key in every section through the source's
aliases (`canonicalProject`, `src/lib/projects/aliases.ts:75-77`), so the
bundle holds current keys only, and lists each key once in the header:

- **Repository key** (from the origin remote, `identity.ts:160-175`): the same
  key on every machine (linked boards rely on this, `linked-installs.md` M.0).
  It passes unchanged. The header carries the remote so the target can show
  which repository it is.
- **Folder key** or key of a repository without origin (from a path hash,
  `identity.ts:56-57`): the target cannot derive it. The header carries the
  folder's display name and no path. The dry run asks the operator to pick
  the folder on the target from the existing directory suggestions
  (`src/lib/projects/suggestionRoots.ts`), or to leave it unmapped. A picked
  folder gives the target key through the same identity functions; the import
  rewrites the records to it and writes an alias source key → target key into
  the target's alias store, so a later bundle from the same source resolves
  without asking. This is a third alias origin beside succession and worktree
  recovery: one the operator confirmed in the dry run, recorded with that
  origin. An unmapped key's records are still imported under the source key,
  where they match nothing, and are listed; mapping it later in the same
  dialog aliases them.
- **Claude project memory** directories are named after the checkout path.
  The export records each directory under its project key (resolved by the
  existing slug resolution, `sources.ts:59-66`). The import writes it under
  the directory name the target's checkout of that project produces. A
  project with no checkout on the target keeps its memory in the bundle's
  import record and is listed; importing the same bundle again after cloning
  writes it. On the live machine the files sit in the legacy Claude home and
  each managed Claude home links its project memory directories and its
  instruction file there; no product code at the base creates those links
  (the account setup links only `skills`, `commands` and `agents`,
  `src/lib/accounts/claude.ts:18`, `:522`). The export therefore records,
  per home, which memory directories are files and which are links into
  another home, and the import recreates that layout on the target.
- **Account ids** keep their value. A same-id account on the target with the
  same identity hash is the same account; with a different identity it gets a
  new id and every binding and seat reference is rewritten. A source legacy
  account (id `default`) maps to the target's legacy account when the
  target's own engine home is signed out or signed into the same identity;
  otherwise it becomes a managed account.

### 2.4 Secrets policy

1. No credential, token, key, session, passkey, pairing secret or keyring item
   is ever written into a bundle. The export reads none of them: it never
   opens an account home's credential file or a keyring, and the accounts
   section is built from registry rows and the identity the provider already
   reported to the source.
2. A guard runs on the finished bundle before it is offered: the existing
   static secret detectors (`src/lib/privacy/staticDetectors.ts`, already used
   to hint rules, `roleStore.ts:10`) over every string value. A hit stops the
   export and names the section and key, never the value. A lesson that holds
   a secret-shaped string is the realistic case.
3. The import report lists every login and pairing to redo (§5.3).
4. The bundle still carries private text (rules, mandates, tasks). It is
   written 0600, sealed by default when it is a file (Q4), and travels only
   over TLS with a peer token on the link path.
5. An encrypted channel for credentials exists only if the operator chooses
   §3.2 option (b); it is never part of the bundle.

## 3. Accounts: how a working login reaches the new install

### 3.1 What travels for each account

The `accounts` section gives the target, per account: engine, id, label,
kind, whether it is the active one, Claude provider settings without the
token, its bindings, and a SHA-256 of the login identity the provider reports
(the e-mail `claude auth status` returns, `src/lib/accounts/claudeLogin.ts:237`;
the e-mail the Codex app server's account read returns, `src/lib/accounts/codexAppServer.ts:62`, `:353`). The
hash lets the target warn when an account is signed into a different identity
from the one the source used. The credit guard needs nothing from the source:
it is computed from limit readings (`creditGuard.ts:25-33`), and the first
reading on the target is a live one (§3.5). Its threshold, when set, is listed
from the environment.

### 3.2 Options for the login itself

Vendor sources, fetched into scratch on 2026-10-22 between 12:38 and 12:45
UTC, tags stripped and read whole:

- Claude Code, Authentication: `https://code.claude.com/docs/en/iam` (HTTP 200,
  583,868 bytes, no page date). "On Linux, credentials are stored in
  `~/.claude/.credentials.json` with file mode 0600." "If you've set the
  `CLAUDE_CONFIG_DIR` environment variable, Claude Code keeps the
  `.credentials.json` file under that directory instead, … and keys the macOS
  Keychain entry to that directory too." "If your browser shows a login code
  instead of redirecting back after you sign in, paste it into the terminal …
  common in WSL2, SSH sessions, and containers." `claude setup-token` makes a
  one-year token that "can only make model requests". The page says nothing
  about copying a credential file to another machine.
- Anthropic Consumer Terms (`https://www.anthropic.com/legal/consumer-terms`,
  HTTP 200, 632,846 bytes, "Effective Oct 8, 2025"): "You may not share your
  Account login information, Anthropic API key, or Account credentials with
  anyone else or make your Account available to anyone else."
- Codex, Authentication: `https://developers.openai.com/codex/auth`, redirected
  to `learn.chatgpt.com/docs/auth` (HTTP 200, 591,363 bytes). For headless
  machines it prefers device code login ("Enable device code login in your
  ChatGPT security settings"; `codex login --device-auth`) and documents a
  fallback: "Copy `~/.codex/auth.json` to `~/.codex/auth.json` on the headless
  machine. Treat `~/.codex/auth.json` like a password".
- Codex, CI/CD auth (`learn.chatgpt.com/docs/auth/ci-cd-auth`, HTTP 200,
  401,126 bytes): "Use one auth.json per runner or per serialized workflow
  stream. Do not share the same file across concurrent jobs or multiple
  machines." Reseed when "another machine or concurrent job rotated the token
  first".
- GitHub Copilot CLI, Authenticating
  (`docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli`,
  HTTP 200, 660,129 bytes): remote and headless environments default to the
  device code flow at `https://github.com/login/device`; the token is stored
  in the OS keychain, or with consent in a plaintext config file when no
  keychain exists.
- GitHub Terms of Service (HTTP 200, 366,845 bytes): "Your login may only be
  used by one person — i.e., a single login may not be shared by multiple
  people."
- OpenAI Terms of Use: `openai.com/policies/terms-of-use/` answered 403 to the
  scratch fetch and to the fetch tool, so its text is unread (§11).

| | (a) Sign in again on the new install, guided | (b) Encrypted move of the credential file over the link | (c) Provider rules |
| --- | --- | --- | --- |
| How | The import creates each account signed out; the checklist runs the product's own sign-in per account (§3.4) | The target makes a key pair for this transfer and shows its fingerprint; the source operator confirms per account; the source encrypts the credential file to that key; the target writes it into the account home and reads limits live; the source then signs that account out | — |
| Claude | Supported in the product today, from any browser: `claude auth login --claudeai` in the account's home, URL shown, code pasted back (`claudeLogin.ts:445-465`, `:511-518`) | On Linux the login is one file (vendor doc), so a copy is mechanically possible; on macOS the Keychain entry is keyed by the home path (`claudeCredentials.ts:37-41`), so the target writes a new entry. Whether a copy keeps working on both machines after a token refresh is not documented | Terms forbid sharing with anyone else; moving between one's own machines is not addressed |
| Codex | Device code in the product today (`codexRuntime.ts:34`, `:147-169`); needs device code login enabled in ChatGPT settings | Vendor-documented as a fallback for one headless machine, with the rule: one copy per machine. Using both copies is the failure the vendor names | Docs allow the copy for one machine; the terms page could not be read |
| Copilot | Device code in the product today (`src/lib/accounts/copilotLogin.ts:16-22`) | Impossible as built: Delegatus never reads the keychain token (`copilot.ts:24-26`) | One person per login |
| Keeps the source working | Yes: each install has its own session | Only if the source stops using that account | — |
| Secret crosses the network | No | Yes, encrypted twice (TLS and end to end) | — |
| Build cost | Small: rows, checklist, verification (§7 slice 2) | Large: key exchange, per-account consent, keychain writes per platform, source-side sign-out, a new peer route | — |

### 3.3 Recommendation: (a)

Sign in again, guided by the transfer. The temporary server runs beside this
install, so every account must keep working here; Codex's own rule makes a
shared copy fail on the first token rotation, and nobody documents the same
case for Claude, where the rotation behaviour of a copied refresh token is
unconfirmed. Option (a) gives each install its own session, sends no secret
over any network, works the same for all three engines, and uses sign-in
flows the product already runs on a headless server from a browser anywhere.
It costs one sign-in per account: seven on this machine, each a link and a
code. Option (b) stays in §10, to be built only if the operator asks (Q1).

`claude setup-token` was considered and set aside: managed agents strip
`CLAUDE_CODE_OAUTH_TOKEN` from their environment (`src/lib/agent/cli.ts:210`,
`keys-settings.md` §2c), and the token "can only make model requests", so
Delegatus's own limit read through the CLI is unproven with it.

### 3.4 The sign-in checklist

After the import, the accounts panel and the setup guide's Engines step show
one row per imported account in the source's order, with its label, engine,
role (active, bound projects) and state: **Signed out**, **Signing in**,
**Usable** (live limit read passed), **Different account** (identity hash
differs), **Read failed** (with the provider's redacted detail). Each signed-out
row has one button, the product's existing sign-in for that engine:

- **Claude**: «Sign in» starts the login in that account's home; the row
  shows the authorize link; the operator opens it in any browser, approves,
  and pastes the code into the row. On success the product already reads
  limits live (`claudeLogin.ts:263-264`).
- **Codex**: «Sign in» starts the device login in that account's home; the row
  shows the link and the one-time code. If the provider refuses device code
  login, the row says to enable it in ChatGPT security settings. On success
  the product already reads limits live (`codexRuntime.ts:165-166`).
- **Copilot**: «Sign in» starts the device code flow; the row shows
  `github.com/login/device` and the code; on a server without a keychain the
  existing prompt asks to store the token in the account's config file
  (`copilotLogin.ts:22`).

### 3.5 Bindings, active account and credit guard on arrival

- **Bindings apply at once**, before any account signs in. A project bound to
  an account that is still signed out parks its work until that account is
  usable. This keeps the binding's own rule: an unreadable or missing
  reservation must never widen which accounts a project may use
  (`projectBindings.ts:24-33`). Applying bindings only after sign-in would
  leave those projects unrestricted in the meantime, so work could run on an
  account the binding was written to keep away from it.
- **The active account** of each engine switches to the source's choice when
  that account becomes usable; until then the target keeps its own.
- **Credit guard**: no observation travels. The first observation is the live
  read after sign-in, so the guard's first decision on the target rests on
  the provider's own answer (`creditGuard.ts:25-33`). If the source set the
  threshold variable, the report names it and its value.
- **Different account**: when the identity hash differs, bindings stay as
  imported and the row asks the operator to confirm the account or sign in
  again; until confirmed, the account is not made active.

## 4. Export and import paths

### 4.1 Who does the work

The serving Viewer owns both directions. It already declares the `viewer`
owner, may run state-mutating steps (`src/lib/stateOwnership.ts:49-55`), and
runs heavy work in workers. Export and apply each run in one worker process,
the way state backups do (`src/lib/stateBackup.worker.ts`), and the Viewer
side wraps them in loop-monitor operations (`transfer.export`,
`transfer.preview`, `transfer.apply`) so a long pass is attributed. Every wait
on a state lock is the asynchronous `waitForStateLock` admission
(`src/lib/state/lockWait.ts`).

The CLI and other entry points never open live state for writing:

- `delegatus export` and `delegatus import` (launcher owner) talk to the
  running Viewer over loopback with the controller credential that
  `scripts/rebuild-http.ts` already presents for deploys: loopback address
  resolved and pinned, redirects refused, credentials kept inside the client.
  The transfer routes admit exactly two callers: that credential and the
  owner's browser page through the Keys gate (§4.3). Agents and services are
  refused.
- With no Viewer running, `delegatus import` refuses with "start Delegatus,
  then import". `delegatus export` reads a `VACUUM INTO` copy it makes in the
  OS temp directory, which only needs read access, so an install whose Viewer
  will not start can still be exported.

### 4.2 CLI

```
delegatus export [--sections a,b] [--with board,history] [--plain] [--out FILE | -]
delegatus import FILE|- [--dry-run] [--map SOURCE_KEY=FOLDER ...] [--yes] [--report]
```

- `export` writes the bundle (sealed by default, Q4; `--plain` for a pipe
  such as `delegatus export --plain - | ssh server delegatus import -`, where
  ssh already encrypts) and prints the passphrase once when sealed.
- `import --dry-run` prints the dry run (§4.5) and exits 0 without writing.
- `import` without `--yes` prints the dry run and asks for each folder key
  that has no `--map`, then asks to apply. `--report` prints the verification
  of the last import (§5).

For the immediate case (a rented server reachable over SSH), slices 1 and 2
are enough: export here, pipe over SSH, import there, sign in.

### 4.3 In-app action

One page, «Move to another install», reached from three places:

1. Settings in the header menu (`src/components/headerMenu/HeaderMenu.tsx:185-189`)
   gets one row that opens it; there are no other new menu entries.
2. The setup guide's Engines step on a fresh install offers «Bring from
   another Delegatus», which opens the same page; after an import, the Engines
   step is the sign-in checklist (§3.4) and the Orchestrator step offers the
   imported seat drafts.
3. Settings → Linked installs (`src/components/links/LinkedSettingsDialog.tsx`)
   gets «Send memory and settings» and «Receive» on each peer row (§4.4).

The page has two halves: **Export** (sections with defaults, opt-ins with
their measured size, «Download»; the passphrase shown once) and **Import**
(file picker and passphrase, then the dry run, folder choices, «Apply», then
the report). The routes are owner-only and reuse the Keys gate
(`src/lib/keys/access.ts:33-49`): same origin, a browser page's own request,
no agent or service caller, the owner on a team install.

Apply waits on the server: it is server-computed and hard to reverse, so the
button shows progress until the report arrives, and nothing on the page claims
success before that.

### 4.4 Linked-install path

Measured on the live machine: its only link is one it opened (it holds a peer
token and has granted nothing), and its own address check ends in
`host-rewritten` (`src/lib/links/self.ts:14`, `:265`), with which pairing
refuses to mint a code (`src/lib/links/protocol.ts:36-42`). This install is
the calling side of its link, and a rented server with a public address is
the called side. A pull started by the server would have to call this install,
which the link was never set up to do, so the path moves the bundle in
whichever direction the link already runs:

- Two new scopes on an existing grant, each granted by the operator of the
  called install (B) from its peer row, for 15 minutes and one bundle:
  `state:receive` (B accepts a bundle from that peer) and `state:send` (B
  serves a bundle to that peer). Neither is implied by `board:sync`
  (`linked-installs.md` §10.2).
- **B is the target** (the immediate case): A's operator presses «Send memory
  and settings» on B's row; A builds the bundle and uploads it in chunks of at
  most 1 MiB (the peer routes' body limit, `src/app/api/peer/v1/[...path]/route.ts:23`)
  to `PUT /api/peer/v1/transfer/<exportId>/<offset>`, then
  `POST /api/peer/v1/transfer/<exportId>/commit` with the trailer hash.
- **A is the target**: A's operator presses «Receive» on B's row; A pulls
  `GET /api/peer/v1/transfer/export?sections=…` as a stream.
- Either way the bytes equal a file export (unsealed: the link is TLS with a
  peer token), and the target stages the bundle and shows its own operator
  the same dry run. Nothing applies without that operator's «Apply».
- Without the scope, the routes answer the uniform `401` of §2.5 of the
  linked-installs design; a revocation during an upload stops it the way
  `boards/sync` re-checks its grant (`route.ts:56`).

### 4.5 Dry run

The dry run is the import with no writes, computed in the worker against the
target's current state. Per section it shows counts: **new**, **same**
(identical content), **conflict** (same key, different content, and what the
rule in §4.6 will do), **skipped** (with the reason: unknown section, newer
schema, unmapped project, excluded by choice). It lists the folder keys to
map, the accounts with their planned id and state, the scopes whose active
text will pass the 10 000-code-point target after the merge, and the redo
list of §5.3. For a conflict it shows the two versions' kind and time and,
for rules, both texts in the operator's view only.

Every section's preview records the target section's revision (the state
collection revision, or the file's mtime and size for a JSON store). Apply
re-checks each revision inside the lock and refuses if any moved since the
preview: "the target changed since the preview; preview again".

### 4.6 Conflict rules per section

"Into an empty target" is the immediate case. "Into a populated target" is the
second transfer into the same install, or bringing a temporary install's
lessons home (Q6).

| Section | Into an empty target | Into a populated target |
| --- | --- | --- |
| `memory.role` rules | Copied with their ids, versions, revision records and sources | Union by rule id. Same id and same content hash: skipped. Same id and different content (any write that keeps the id changed it: rewrite, merge, archive, restore, revert, curator Undo, split, move, keep): the target's row stays and the incoming text is stored the way a rewrite stores an older text (`versionedRule`, `roleStore.ts:258-267`): a new archived row with a fresh id and `versionOf` set to the shared id, added to that rule's `versions`; the import record maps the fresh id to the source's. Listed as a conflict. Nothing is deleted |
| `memory.role` scopes | Copied with revision and history | Absent: copied. Present: incoming active ids that are not already present are appended after the target's, the import adds one history entry by `transfer` naming them, and the incoming scope history is kept in the import record. No rule leaves the active list at import; a scope over its target waits for the next curation pass, as any unseen lesson does (`roleTypes.ts:11-13`) |
| `memory.role` curation state | Copied | Per project, the later `lastAt` wins; the machine row of the target stays |
| `memory.profile` | Copied | Target kept (profiles are regenerated) |
| `memory.settings` | Copied | Target's explicit value kept; memory source taken only when the target never chose |
| `memory.calls` | Copied | Union by call session id |
| `memory.engine` | Files written | Only absent files are written; a present file with different content is listed and left alone. The engines remain the writers of their stores |
| `settings.*` | Copied | Each field kept on the target when set there, with a «take the source's» switch per section in the dry run (the "replace" choice). The machine worker limit is never applied, only shown |
| `settings.voice` tools | Imported as pending; secrets missing | Same; existing tools kept |
| `settings.relay`, `settings.telegram` | Kept in the import record as pending until the same relay target or the same bot connects on the target, then applied through the stores' own writers | Same |
| `accounts` | Rows created signed out; bindings applied; active after sign-in | Id rules of §2.3; bindings united |
| `seats` | Drafts (Q5), kept in the import record; starting one goes through the existing designation with that mandate, so the seats file is not written at import | Drafts beside any existing seat |
| `board` | Union by task id; a project already shared with the source by board sync is skipped | Same id: the newer `updatedAt` wins, since tasks already carry last-write-wins with a stated tiebreak in board sync (`linked-installs.md` M.5) |
| `history` | Copied | Union by id; never replaces |

### 4.7 Apply: all or nothing on failure

Apply runs in the worker, holding the account mutation lock
(`src/lib/accounts/accountMutation.ts`), which spawn admission also takes
(`src/lib/agent/spawnAdmission.ts:224`): a launch that arrives meanwhile is
answered "busy" and retried by the existing path (`spawnCommand.ts:224`), so
no launch is admitted against a half-imported account set. Order:

1. Validate the whole bundle (checksums, decoders, mappings). Nothing written.
2. Check every section revision against the preview (§4.5).
3. Write a checkpoint: a copy of every file the import will replace, into
   `<state>/transfer/<importId>/checkpoint/`, and an apply journal listing
   every file and directory the import will create.
4. Write the file sections, each through its store's writer and atomic rename
   (`src/lib/state/durableJson.ts:20`): worker limits, project settings,
   operator settings, «asks you», shared memory and memory source, the forge
   declaration, voice settings and choices, the voice tool registry, call
   journals, engine memory files, new account homes.
5. Commit every SQLite section and the import ledger row in one transaction
   on `state.sqlite`. This commit is the point of no return.
6. Remove the checkpoint and mark the journal done.

Every exit, and what it leaves:

| Exit | State after |
| --- | --- |
| Validation or revision check fails (1-2) | Nothing written |
| A file step fails (4), the disk is full included | Replaced files restored from the checkpoint, created files and directories deleted from the journal's list; SQLite untouched |
| The SQLite transaction fails (5) | SQLite rolled back by SQLite; files restored as above |
| The worker dies between 3 and 6 while the Viewer lives | The Viewer's worker-exit handler runs the recovery below at once |
| The Viewer stops between 3 and 6 (crash, deploy, restart) | At the next activation, as a startup step under the release fence: a ledger row for that import exists → it committed, finish step 6; no row → restore files from the checkpoint |
| Success | Ledger row, report, checkpoint removed |

Files written in step 4 are visible to readers for the seconds until step 5
commits. Visibility is therefore atomic per section and failure-atomic across
the import; the window is the apply duration, which slice 1 measures and
reports (target: under 10 s for the default sections of this machine's size).

### 4.8 After apply

- Rewrite the lesson known-values file (`refreshLessonKnownValues`,
  `roleStore.ts:917-935`); the publication gate refuses a push while it is
  missing.
- Refresh the shared memory index (`refreshMemoryIndex`,
  `src/lib/memory/service.ts:39-48`).
- Create account homes for imported accounts (0700) through the existing
  account setup, which links a Codex home's instruction file, memories,
  rules, skills, prompts and config to the legacy Codex home
  (`codex.ts:22`, `:573`) and a Claude home's capability directories to the
  shared root (`claude.ts:522`); the Claude memory and instruction-file links
  come from the recorded layout (§2.3).
- Write the import record: bundle hash, export id, source label, product
  versions, sections and counts, mappings, outcome, timestamps. Importing the
  same bundle again finds this record, says so, and applies only what was
  skipped before (a newly cloned project's memory, a newly mapped folder).

## 5. Verification

The report opens after apply, stays readable from the page and from
`delegatus import --report`, and is stored with the import record. It has
three parts.

### 5.1 What arrived

| Per section | Compared |
| --- | --- |
| Every section | Records in the bundle = new + same + conflict + skipped, each listed by reason. Any difference fails the section in the report |
| `memory.role` per scope (after remap) | Source and target: rules, active rules, active code points, history entries. Every source active id is active on the target or kept as a version of a target rule; the target's active count is at least the source's; code points over the target are named for curation |
| `accounts` | Every source account has a target row, with the same bindings after remap |
| `memory.engine` | Files in the bundle = written + already present + waiting for a checkout |

### 5.2 Accounts usable

Each imported Claude and Codex account reads its limits live on the target
through the existing per-account read (`refreshAccountLimits`,
`src/lib/accounts/liveLimits.ts:95-130`, the same call as
`POST /api/accounts/{engine}/limits`), with a new read phase `transfer-verify`
for the quota log. Usable means the read returned a fresh observation with a
plan and windows; the report shows **Usable**, **Signed out**,
**Different account** or **Read failed** with the redacted detail, and
re-runs the read on each row's sign-in. The import is not complete until every
row is Usable or the operator marks it «not needed here».

Copilot has no live limit read in the product: its quota comes from its own
config and transcripts (`copilot.ts:24-26`), and there is no
`/api/accounts/copilot/limits` route. A Copilot row is Usable when its config
shows a signed-in user (`copilot.ts:105-115`) and its model catalog reads
(`src/app/api/accounts/copilot/models/route.ts`). This is weaker than a
limit read; §11 names it. The live machine has no Copilot account.

### 5.3 What must be redone

One list, each item with the place that does it:

- Each account's sign-in (§3.4).
- API keys and the Telegram bot token: Keys → Import with the source's Keys →
  Export text (`keys-settings.md` §15). The bot answers on one machine; the
  list says to disconnect it on the source if it moves.
- The relay pairing, then the stored target settings apply.
- The GitHub App credential for each declared repository.
- The access key, phone access, push subscriptions, team members and their
  sign-ins, linked installs.
- Voice tool secrets and approvals.
- The subscription API consent (one confirm).
- Environment variables, by name, with values for the allowlisted ones.
- Folder keys left unmapped and hand-made projects without a folder.
- Claude project memory waiting for a checkout.
- Seat drafts to start (Q5).
- Browser preferences, when the bundle came from the CLI or the link (only
  an in-app export can read a browser's storage).

## 6. Execution placement once two installs exist

- **Development** stays on the main install, where the accounts' working
  sessions, the full memory and the operator are. A self-contained task (one
  repository, no live Delegatus state, no machine-specific tools) can go to a
  vendor cloud agent: `claude --cloud <description>` (present in Claude Code
  2.1.302 on this machine) or `codex cloud exec --env <ENV_ID> <prompt>`
  (codex-cli 0.162.1, marked experimental). Cloud sessions use the account's
  subscription on the vendor side ("Cloud sessions always use your
  subscription credentials", Claude Code docs), so no login moves for them;
  the stage's learned-rule block goes into the cloud prompt the same way it
  goes into a local one, and no bundle goes anywhere.
- **The temporary second install** runs work that needs its CPU or its
  location, with its own sessions and the imported memory. Lessons it learns
  stay there until a transfer brings them home (Q6).
- **Test gates and other CPU-heavy work** run on a separate runner (task
  «Важкі тестові гейти на окремому сервері»). From that runner this design
  needs only the following:
  1. The runner is no Delegatus install: it receives no bundle, no account,
     no credential and no learned rule; a repository at a commit and the
     frozen dependency install are its whole input.
  2. The privacy lane stays on the install that publishes. It reads the
     install's known values, including the lesson text in
     `role-memory/known-values.txt` (`roleStore.ts:908-935`); running it on
     the runner would copy memory there.
  3. Each verdict names the runner by kind and environment (OS, CPU count,
     runtime versions), so a lesson about the runner's machine is not filed
     in the install's machine scope, which means "this machine".
  4. Both installs may use one runner; its CPU admission counts work per
     install, so the two do not overcommit it.

## 7. Slices

Each slice is usable on its own, runs its tests with isolated HOME,
XDG_CONFIG_HOME, TMPDIR and `LLV_STATE_DIR`, and never touches live state.

1. **Bundle core, CLI, memory and settings.** Format (§2.1), the sections
   `memory.role`, `memory.profile`, `memory.settings`, `memory.calls`,
   `settings.*` and the environment list; project key remap with transfer
   aliases; dry run; apply with checkpoint and exits (§4.7); import record;
   report parts 5.1 and 5.3; known values and index refresh. Tests: round
   trip between two isolated state directories (counts and per-scope figures
   equal); each exit of §4.7 by fault injection, including a stop between
   steps 3 and 6; revision refusal; the secret guard on a lesson holding a
   secret-shaped string; the minimum macOS SQLite preload
   (`src/lib/state/minimumSqlite.preload.ts`); the CLI refusing without a
   Viewer; the apply window measured on a copy shaped like §1.10.
2. **Accounts.** The `accounts` section, rows created signed out, bindings at
   once, active after sign-in, identity hash check, the checklist in the
   accounts panel, the `transfer-verify` live read (§5.2). With slices 1 and 2
   the rented server can be set up over SSH, which is the immediate use.
3. **Engine memory files.** `memory.engine` with the Claude directory remap,
   absent-only writes, and "waiting for a checkout" (§2.3).
4. **In-app page and setup guide.** The page of §4.3 with sealing (Q4), the
   Settings row, the Engines step entry, seat drafts in the Orchestrator step
   (`seats`, Q5). Rendered evidence through the existing drivers in en and uk,
   light and dark, desktop and phone.
5. **Linked-install path.** The two scopes, chunked upload and streamed pull,
   staging and the receiving operator's dry run (§4.4).
6. **Opt-in sections.** `board` (skipping shared projects), `history`,
   `browser`, pending relay and Telegram settings that apply on re-pairing.

## 8. Operator decisions

**Q1. How does each account's login reach the new install?**
(a) Sign in again on the new install from the import's checklist, one link
and code per account; every install keeps its own session. *(recommended)*
(b) An encrypted move of the credential file over the link, confirmed per
account, after which the source signs that account out.
(c) Both: (a) by default, (b) on request per account.

**Q2. Learned rules of the "machine" scope describe the source machine. On
the new machine they should be:**
(a) carried active and put first in the target's next curation pass, which
already removes stale and contradicted rules. *(recommended)*
(b) carried archived, restored by hand.
(c) left behind.

**Q3. The engines' own memory files (Claude project memory, Codex memories,
global instruction files, the operator's skills):**
(a) carried by default while the installation uses engine memory, writing
only files the target lacks. *(recommended)*
(b) carried only when ticked.
(c) never carried; Delegatus memory only.

**Q4. A bundle saved as a file holds private text (rules, mandates, tasks):**
(a) sealed by default with a generated passphrase shown once; plain only on
request, for a pipe over SSH. *(recommended)*
(b) plain by default (0600), sealing on request.

**Q5. Orchestrator seats on the new install:**
(a) arrive as drafts with their mandates; the operator starts each one.
*(recommended)*
(b) start automatically after import.
(c) are not carried.

**Q6. When the temporary install is retired, its new lessons and settings:**
(a) come home by the same transfer in the other direction, offered when the
link is removed, merged by §4.6. *(recommended)*
(b) stay there and are lost with it.
(c) sync continuously between linked installs (larger; see §10).

## 9. Validation against the requirement

| Requirement | Where |
| --- | --- |
| Inventory from code and live state, names/sizes/counts only, every listed item classified | §1.4-1.9 (each item of the quote has a row; sound/UI is device-local by design and has an opt-in section), §1.1 method |
| Portable bundle: versioned, checksummed, one file | §2.1 |
| Default content and explicit opt-ins (board, history) | §2.2 |
| Secrets never ride by default; redo list; encrypted channel only on request | §2.4, §5.3, §3.2 (b), Q1 |
| CLI export/import, in-app action, linked-install path | §4.2, §4.3, §4.4 (with the measured direction of the live link) |
| Conflict rules, merge or replace per section, ids and revisions kept, keys remapped through aliases | §4.6, §2.3 |
| Dry run with a diff, atomic apply under the ownership rules | §4.5, §4.7, §4.1 |
| Verification of counts and scope sizes, what arrived and what to redo | §5.1, §5.3 |
| Slices and 3-7 questions | §7, §8 |
| Accounts in use, their roles, how a login reaches the new install, a-b-c compared, one recommended | §1.6, §3 |
| Accounts usable as part of verification: each account reads its limits | §5.2 (Copilot gap named in §11) |
| Execution placement and what the runner must provide | §6 |
| Fences: no product code, nothing written to live state, no identities, paths, ids or secrets | Status, §1.1 |

## 10. Deferred — not currently justified

- **Credential move over the link (§3.2 (b)).** Not needed for the immediate
  case and weaker than signing in again; built only if the operator picks it
  in Q1.
- **Transcripts and conversation history** (20.5 GB here). The linked-installs
  MVP already keeps transcripts on their machine; a new install starts its
  own conversations, and the search index of the source stays on the source.
- **Continuous memory sync between linked installs** (Q6 (c)). The one-off
  transfer in both directions covers a temporary install.
- **One-click undo of an applied import.** Failure leaves nothing applied
  (§4.7), and the state backups already keep earlier generations
  (`durability.ts:46`).
- **A replace mode for learned rules** that would archive the target's own
  rules. Merge equals replace on an empty target.
- **Moving the Telegram personal session, the bot connection, the relay
  pairing, team passkeys and push subscriptions.** Each is bound to one
  machine or one origin; the redo list covers them.
- **A live Copilot quota read.** No product read exists and the CLI's support
  for one is unconfirmed.
- **Cloning repositories on the target** during import.
- **Public-key sealing** of the bundle file; the passphrase covers the file
  case and the link is TLS.
- **Activity, usage and limit history, prototype review media, done media.**

## 11. What could not be confirmed

- **OpenAI's terms of use** on moving a ChatGPT login between one's own
  machines: the page answered 403 to both fetches. The Codex documentation
  itself describes copying `auth.json` to one headless machine, which
  suggests no prohibition, but the terms text is unread.
- **Anthropic** documents where credentials live and a long-lived token for
  headless use, and its terms forbid sharing with anyone else. Neither says
  whether one person may copy a credential file between their own machines,
  nor whether a copied refresh token keeps working on both after a refresh.
- **Copilot verification** rests on the signed-in config and a model catalog
  read; a live quota read is not available in the product.
- **Apply duration** on a populated target is a target until slice 1
  measures it.
