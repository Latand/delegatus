# Account removal is refused over stored conversations (#1857)

Investigation on the live machine, 2026-09-19. Read-only: no file under the
Viewer config directory was moved, removed or rewritten, no removal route was
called, and no provider was contacted. Account ids below are invented
placeholders (Claude A/B, Codex A–D, retired Claude R1/R2). Paths are relative
to `<config>` = `$XDG_CONFIG_HOME/agent-log-viewer` or to `$HOME`.

## Originating requirement

From issue #1857 (2026-09-19, the operator's report as the issue paraphrases
it in English):

> In the accounts dialog the operator presses remove on an old account and the
> account stays. The Viewer answers that the account still has stored
> conversations. Old accounts therefore stay for ever in the dialog and as
> pills in the board header.
>
> Removing an account must work. Conversations must not be lost and should not
> block the removal: if an account home still holds transcripts, move them to
> where the main account's conversations live (or the shared store), then
> remove the account.
>
> Expected outcome: remove succeeds for an account with leftover history, the
> history stays readable in the Viewer, and the dialog says what was moved.

Every design choice below is checked against these three sentences: removal
succeeds, conversations stay readable, leftovers move to the shared location
and the dialog reports the move.

## Summary

No managed account on this machine can be removed today. Two independent
fences refuse, and either alone is enough:

1. **The filesystem history inventory refuses every home that was ever used.**
   Since #314 / PR #1401 it classifies every entry in the home and refuses on
   anything that is not provably owned. The Claude homes' `projects` entry,
   which is the symlink into the shared transcript store from #891, is itself
   classified as unowned history, so every cut-over Claude home is refused
   even though it holds **zero transcripts**. Codex homes hold their real
   rollouts plus provider SQLite state, logs and runtime files, all of which
   refuse.
2. **The liveness fence counts parked migrations and weeks-old owed
   deliveries as current conversations.** A migration in `failed-recoverable`
   is terminal to the migration coordinator, but the removal fence treats it
   as in flight. That keeps Claude B, Codex A and Codex B refused for ever,
   before the filesystem check even runs.

The dialog maps both to the same message, "has protected conversation history
or active conversations", which the operator reads as "still has stored
conversations".

## 1. Every check that can refuse a removal

Both engines share one route shape: `DELETE /api/accounts/claude` and
`DELETE /api/accounts/codex`, body `{ id, force? }`. `force` is accepted and
ignored: no blocker has a bypass.

| # | Check | Where | Response | Dialog text (en) |
|---|---|---|---|---|
| a | Accounts registry corrupt | `src/app/api/accounts/claude/route.ts:98`, `codex/route.ts:73` | 409 `accounts_locked` | "could not be removed" family |
| b | Unknown or legacy (Main) account | `claude/route.ts:100`, `codex/route.ts:75` | 404 `unknown_account` | removeFailed |
| c | `live_sessions`: a hosted registry entry whose process answers a probe or is under 5 min old; an open launch receipt that is live; **a queued account pin (#1600)** | `src/lib/agent/accountLiveness.ts:222-248` (queued pin at `:244-246`), called from `src/lib/accounts/removal.ts:638-648` | 409 `account_removal_blocked`, `blockers: ["live_sessions"]` | `accounts.removeBlocked`: "{label} still has an active session or sign-in." |
| d | `current_conversations`: a conversation whose **latest** generation is on the account and which has a live host, a migration not in `committed`/`rolled-back`, an owed held delivery (`held`/`assigned` always, `delivery-uncertain` inside 5 min), or a live receipt | `accountLiveness.ts:179-209`, `:288-302`; phases at `:64`, delivery states at `:74` | 409, `blockers: ["current_conversations"]` | `accounts.removeHistoryBlocked`: "{label} has protected conversation history or active conversations. Resolve the reported history and wait for active conversations before removal." |
| e | Sign-in in progress | `claude/route.ts:104`, `codex/route.ts:79` | 409, `blockers: ["login_pending"]` | removeBlocked |
| f | Same liveness check again inside the registry transaction | `src/lib/agent/registry.ts:6593` ("account has current conversations") | 500 `removal_failed` | removeFailed |
| g | Home unsafe (symlinked home, wrong owner, group/world-writable) | `claude.ts:355`, `codex.ts` equivalent; `removal.ts:181-185` | 409 `unsafe_home` or 409 `filesystem_history` with an `error` entry | removeHistoryBlocked |
| h | **History inventory (#314)**: any entry classified `history` or `unknown` | `removal.ts:171-220`, refusal at `:216-218` | 409, `blockers: ["filesystem_history"]`, `history: report` | removeHistoryBlocked |
| i | Inventory traversal error: an entry on another device, an external mount, a foreign owner, or **a group/world-writable file anywhere in the tree** | `removal.ts:194-198`, caught at `:208-214` | same as h | removeHistoryBlocked |
| j | Owned history outside the retained tree (`projects/` for Claude, `sessions/` for Codex) | `claude.ts:326-328`, `:357-359`; `codex.ts:440-442`, `:461-463` | same as h | removeHistoryBlocked |
| k | Identity-bound unlink fence (#1408): any entry whose inode, type or classification changed between classification and removal | `removal.ts:261-335`, staging at `:460-520`, verification at `:424-453` | same as h, account record restored | removeHistoryBlocked |

The dialog chooses its message in `src/hooks/useEngineAccounts.ts:777-785`:
`current_conversations` and `filesystem_history` both select
`accounts.removeHistoryBlocked` (`src/lib/i18n/en.ts:286`,
`src/lib/i18n/uk.ts:287`). The paths in `history` are sent in the response and
never shown, so the operator cannot tell which fence refused or what to do.

### The classification rule that refuses everything

`classifyArtifact` (`removal.ts:114-142`):

- A **symlink** is owned only if it is one of `skills`, `commands`, `agents`
  (Claude) or the Codex capability links. Any other symlink whose path looks
  like history is `history` (`:122-125`). `projects` is a history root name
  (`:54`), so the shared-store link `projects -> <config>/shared/claude/projects`
  is **unowned history**. The inventory never follows it, so it does not know
  the link points at the Viewer's own store.
- A regular file is owned history only when the agent registry names it as a
  generation or continuity path of this account (`:71-88`, `:134-136`). Every
  other `*.jsonl`, every file under `shell-snapshots`, `backups`,
  `paste-cache`, `file-history`, `todos`, `debug`, `history.jsonl`, and for
  Codex every `*.sqlite*` file and everything under `log/`, is unowned history.
- Every other entry the lists do not name (`.llv/`, `statsig/`, `sessions/`
  for Claude, `.claude.json.backup`, `installation_id`, `cache/` for Codex,
  `vendor_imports/`, …) is `unknown`, which also refuses.

A home in use always holds some of these, so the only homes this fence lets
through are homes that were never used.

## 2. The live machine

### Account homes (read-only inventory)

`GET /api/accounts` on the production port lists Claude: Main (legacy),
Claude A (active, managed), Claude B (managed); Codex: Main (legacy, active),
Codex A, Codex B, Codex C (signed out), Codex D (all managed). The Claude
accounts registry also records two **retired** archives, R1 and R2, removed on
2026-07-24 by the old retain-in-place path before #1401 tightened the fence.

Counts are regular files (links not followed). "Unowned" is what the
inventory would refuse on, computed by a read-only Python mirror of
`classifyArtifact` plus the registry's generation paths from the JSON mirror
of the agent registry.

| Home | Transcripts physically inside | `projects`/`sessions` | Unowned history | Unknown | Other refusal |
|---|---|---|---|---|---|
| Claude A (active) | **0** | `projects` is a symlink into `shared/claude/projects` | 167 entries, 10.1 MB: the `projects` link, `history.jsonl`, `shell-snapshots/`, `backups/`, `paste-cache/` | 1 536 (0.6 MB): `.llv/`, `sessions/`, `statsig/`, `tasks/`, `teams/`, `chrome/`, `plugins/data`, settings and backups | live sessions (this lane runs on it) |
| Claude B | **0** | symlink into `shared/claude/projects` | 103, 6.4 MB (same kinds) | 3 066 (1.4 MB) | 3 migrations in `failed-recoverable` |
| Claude R1, R2 (retired) | **0** | symlink into `shared/claude/projects` | the link | `.claude.json.backup`, `statsig/` | not in the dialog; strip left incomplete |
| Codex A | 2 197 rollouts, **4.09 GB** | real `sessions/` dir | 458 entries, 3.76 GB: 11 unregistered rollouts and 388 `.json`/`.bak` sidecars under `sessions/`, `history.jsonl` (1 MB), `session_index.jsonl`, `log/`, `shell_snapshots/`, provider SQLite (`logs_2` 3.2 GB, `thread_history_1` 0.4 GB, `state_5`, `memories_1`, `queue_1`, `goals_1` with WAL/SHM) | 7 291 | 96 group-writable files under `plugins/.remote-plugin-install-staging/` stop the traversal (row i); 2 migrations in `failed-recoverable`; 1 `held` + 1 `assigned` delivery since 2026-09-10 |
| Codex B | 433 rollouts, **1.37 GB** | real dir | 40 entries, 0.72 GB (2 unregistered rollouts, 10 `.json` sidecars, SQLite) | 1 081 | 4 migrations in `failed-recoverable` |
| Codex C (signed out) | **0** | none | 16 entries, 0.36 GB (SQLite and WAL only) | 11 (`installation_id`, `tmp/`, `mcp-oauth-locks/`) | none found |
| Codex D | 128 rollouts, **0.61 GB** | real dir | 34 entries, 0.47 GB (2 unregistered rollouts, 4 `.json` sidecars, SQLite) | 201 | none found |

What this shows:

- **Claude homes hold symlinks into the shared store and no transcripts.**
  #891 phase 1 already moved every Claude conversation to
  `shared/claude/projects`. What a Claude home still holds is CLI runtime
  state: prompt history, shell snapshots, `.claude.json` backups and
  statistics.
- **Codex homes hold real files.** Codex has no shared store (#891 phase 2 was
  never done), so 6.1 GB of rollouts across Codex A, B and D live inside the
  account homes, next to about 5.2 GB of provider SQLite state (with WAL/SHM).
- All homes sit on the same filesystem as `shared/` and `~/.codex/sessions`
  (same device id), so a `rename(2)` between them is atomic and copies nothing.

### Which accounts are refused today, and by which check

| Account | First refusal the route returns | Refusals behind it |
|---|---|---|
| Claude A | c `live_sessions` (4 hosted entries whose process answers) | h (the `projects` link and runtime files), j |
| Claude B | d `current_conversations` (3 `failed-recoverable` migrations, dated 2026-08-18 to 2026-09-04) | h, j |
| Codex A | d (2 `failed-recoverable` migrations; 1 `held` and 1 `assigned` delivery from 2026-09-10) | i (group-writable plugin staging files), h, j |
| Codex B | d (4 `failed-recoverable` migrations from July) | h, j |
| Codex C | h (SQLite, WAL, `installation_id`) | j |
| Codex D | h (2 unregistered rollouts, `.json` sidecars, SQLite, `history.jsonl`) | j |

The #1600 queued-pin branch (row c) does **not** fire on this machine: there
is no open receipt with a queued pinned spawn. The #1408 fence (row k) only
acts once removal is under way and is not what the operator hit.

Liveness was computed from the registry's JSON mirror with `/proc` checks,
not by running `accountRemovalBlockers` against the live registry. See
"What I could not confirm".

## 3. How conversations bind to an account

| Binding | Where it lives | What reads it | After the account is gone |
|---|---|---|---|
| `generations[].accountId` | agent registry | liveness (latest generation), ownership of registry paths, spawn/resume admission, migration | Stays as a historical fact. Harmless once nothing routes by it. |
| `generations[].path`, `continuityPaths`, `providerForkPaths` | agent registry | card identity, `/api/log` admission, resume, liveness | **Breaks if the file moves.** Claude paths are stored in both forms: 414 current generations for Claude A/B address the file *through the home's* `projects` symlink (`accounts/claude/<id>/projects/…`). Removing the home removes the symlink, and those paths stop resolving although the bytes sit in the shared store. Codex paths name the real file inside the home. |
| `pinnedAccountId` (Claude A 274, Claude B 491, Codex A 277, B 291, D 121 conversations) | agent registry | automatic migration skips pinned conversations (`registry.ts:990`, `:6684`, `:6753`); a resume names that account | A pin on a deleted account keeps the conversation out of every automatic move and names an account that no longer exists. It has to be cleared. |
| `conversation.migration` | agent registry | liveness (`accountLiveness.ts:190`) | `retireAccount` clears it only when the migration intent **targeted** the removed account (`registry.ts:6600-6619`). A `failed-recoverable` record that migrated *away* from it stays and keeps blocking. |
| Held deliveries | agent registry | liveness `:190-204` | A `held`/`assigned` message owed to a conversation whose account is being removed blocks for ever, since no host can ever take it. |
| Registry `entries[].accountId`, receipts | agent registry | liveness | Dead ones are ignored already (#643, #1595). |
| Engine default account | agent registry `engineRouting` | new spawns | `retireAccount` resets it to Main (`registry.ts:6595-6598`). |
| Project → account bindings | `state/account-project-bindings.json` | automatic account choice per project | Not touched by removal today. Not checked further here. |
| **Account pill on the card** | derived from the transcript **path** (`src/lib/accounts/badge.ts:16-23`, used by `cardAnatomy.tsx:39`, `RuntimePill.tsx:494`, `MobileFocusView.tsx:784`) | card, composer, phone | Any path without an `accounts/<engine>/<id>/` segment shows **Main**. Claude conversations addressed in the shared store already show Main today. |
| **Resume** | Claude: `claudeTranscriptOwnership` (`claude.ts:210-236`) tries path, then the recorded account, then the active account for shared-store paths. Codex: `codexHomeOwningSessionPath` (`codex.ts:380-395`) uses path containment in a **live** account's `sessions` | resume, attach command | Claude: a shared-store transcript whose recorded account is gone falls back to the active account, so it stays resumable. Codex: a rollout outside every live home has no owner and cannot be resumed in place. That is already true of the retained archives from #643. |
| Header pills | `GET /api/accounts` list | board header | Disappear as soon as the account leaves the accounts registry. Retired entries are not listed. |

What removal must therefore do in the registry: rewrite every path that
addresses a file through the removed home, clear pins naming the account,
settle migrations and owed deliveries that can never complete on it, and
reset the engine default. The accounts registry keeps a `retired` record that
points the scanner at wherever the leftovers now live.

## 4. Prior work

- **#314** (open, P0): "block account deletion on filesystem history
  inventory". It asked for a history inventory, **and** "an explicit
  archive/export or migration workflow before deletion". Only the first half
  shipped (PR #1401, merged as b868fcaa). The archive or migration workflow was
  never built, so the fence refuses with no way forward.
- **PR #1401 review rounds** (Codex reviewer transcripts, 2026-09-01, found
  with `search_transcripts` "#314" and "retired archive account home"). Round
  findings pushed the inventory to be exhaustive ("every filesystem entry
  needs an explicit classification, and every unknown or user-history artifact
  must block") and added `log/` and SQLite state to Codex history. One round
  also flagged retain-in-place as contradicting #314's archive requirement;
  retain-in-place survived and still runs, reached only by homes whose history
  is entirely registry-owned and under `projects/` or `sessions/`. That is the
  gap this issue lands in.
- **#643** (closed, PR #647): unblocked removal from dead conversations and
  introduced retain-in-place: the home keeps its `projects`/`sessions` tree and
  becomes a retired archive the scanner keeps reading (`claude.ts:337-349`,
  `retiredClaudeProjectRoots` `:178`, `retiredCodexSessionRoots` `codex.ts:371`).
  Retired R1/R2 were removed this way before #1401.
- **#891** (open): the shared transcript store. Phase 1 (Claude) is live on
  this machine: every Claude home links `projects` into
  `shared/claude/projects`. Phase 2 (Codex) was never done, and the issue
  records that Codex's handling of a symlinked `sessions/` was never verified.
  `mirroredClaudeTranscriptPath` (`claude.ts:258-280`, #1026) already
  translates a home-addressed Claude path into its shared-store form.
- **#1408** (open): identity-bound unlink. The fd-anchored staging in
  `removal.ts` now implements most of it. It is not what refuses here.
- **#1595** (closed) and **#1600** (open): the queued-pin fence. Not firing on
  this machine; #1600's own proposal (scope the pin to the account it names) is
  independent of this fix.
- `search_transcripts` for "filesystem_history", "removeHistoryBlocked" and
  "failed-recoverable removal blocker" found nothing: the dead-end refusal and
  the migration-phase disagreement have not been discussed before.

## 5. Root cause

1. **The #314 fence shipped without the path out of it.** The inventory refuses
   on any unowned or unknown entry, and removal has no step that archives
   those entries. The classifier also does not recognise the shared-store link
   `projects -> shared/claude/projects` as the Viewer's own, so it refuses
   Claude homes that hold no transcripts at all.
2. **The removal fence and the migration coordinator disagree on
   `failed-recoverable`.** `terminalMigrationPhase` treats it as terminal
   (`src/lib/accounts/migration/coordinator.ts:509-511`), while
   `SETTLED_MIGRATION_PHASES` (`accountLiveness.ts:64`) does not. Such a
   conversation is "current" on its source account for ever. Owed held
   deliveries with no host able to take them do the same.
3. **The dialog hides the reason.** Two different fences share one message,
   and the offending paths never reach the screen.

## 6. Safe removal sequence

Decision: **move the leftovers out of the home into a Viewer-owned archive
under `shared/`, rewrite the registry paths, then delete the home.** Credentials
are the only thing deleted; everything else is moved. This follows the
requirement ("move them … then remove the account") and replaces the
per-entry judgement that refuses today with one rule that loses nothing.

Target layout, per engine:

- Claude: transcripts are already in `shared/claude/projects`. The leftover
  runtime state (prompt history, shell snapshots, backups, statistics) goes to
  `shared/claude/retired/<id>/`.
- Codex: the home minus credentials goes to `shared/codex/retired/<id>/`,
  rollouts included (`shared/codex/retired/<id>/sessions/…`). The retired
  accounts record points `retiredCodexSessionRoots()` there.

Steps, under the existing account mutation lock
(`withAccountMutationLockAsync`):

1. **Preflight, no writes.** Home is a safe directory of this uid (row g),
   not a mount, on the same device as `shared/`; the archive destination does
   not exist; no live host, no live receipt, no queued pin for this account,
   no sign-in in progress (rows c and e, unchanged). Liveness drops two false
   positives: a migration in `failed-recoverable` is settled, and an owed
   delivery on a conversation that has no live host and no live receipt is
   treated as undeliverable (it is terminalized in step 4 and listed in the
   result).
2. **Journal the intent** in the accounts registry: `{ id, phase:
   "archiving", archive }`. Startup recovery reads this record, which removes
   the in-memory-only staging risk the #1401 review flagged.
3. **Move the home** with one `rename(2)` of the home directory to the archive
   path (same device, so atomic). A process that opens the home after this
   point finds nothing. Credentials move with it and are deleted in step 6, so
   a failure before step 5 can still put the home back byte for byte.
4. **One agent-registry mutation**, the existing `retireAccount` extended:
   - rewrite every path under `accounts/<engine>/<id>/` in generations,
     continuity, abandoned-continuity, provider-fork and migration paths and
     `entries[].artifactPath`: Claude `…/projects/<rel>` becomes
     `shared/claude/projects/<rel>` (the `mirroredClaudeTranscriptPath` rule),
     Codex `…/<rel>` becomes `shared/codex/retired/<id>/<rel>`;
   - clear `pinnedAccountId` where it names the account;
   - settle `failed-recoverable` migration records on conversations whose
     latest generation is on the account (same cleanup `retireAccount` already
     runs for stopped intents);
   - terminalize owed deliveries on those conversations with reason
     "account removed";
   - reset the engine default (existing).
   The mutation re-runs the liveness check inside the transaction (row f).
5. **Commit the accounts registry**: drop the account, add a `retired` record
   `{ id, label, retiredAt, archive }`, clear the journal phase.
6. **Delete credentials from the archive**: `.credentials.json` (Claude) or
   `auth.json` (Codex), by exact name through the directory's fd. Unlink the
   capability symlinks and the Claude `projects` link the same way (never
   followed). Remove the empty lock sidecar `<id>.lock`.
7. **Answer the dialog** with what happened: files and bytes moved, archive
   path, conversations rewritten, pins cleared, deliveries dropped.

### Failure cases

| Failure | Where | Outcome |
|---|---|---|
| Account live, sign-in pending, queued pin | 1 | 409 with the blocker, nothing changed (as today). |
| Home unsafe, a mount, other device, archive path already exists | 1 | 409 `unsafe_home` / new `archive_unavailable`, naming the path; nothing changed. |
| Group-writable files inside the home (Codex A today) | 1 | Allowed: the move is one rename of the home and does not traverse, so the safety check applies to the home directory alone. |
| Rename fails | 3 | Journal cleared, 500 with the errno, home untouched. |
| Liveness turns true inside the registry mutation | 4 | Rename the archive back, clear the journal, 409. |
| Agent-registry write fails | 4 | Rename back, clear the journal, 500. |
| Accounts-registry write fails | 5 | Restore the agent-registry snapshot (the route already does this, `claude/route.ts:119-121`), rename back, 500. |
| Credential unlink fails | 6 | Account is gone and the archive holds a credential file. Answer `cleanupPending: true` with the path, and retry on the existing orphan cleanup action. The account cannot be selected, since it left the registry in step 5. |
| Process dies between 2 and 5 | any | Startup reads the journal: if the home still exists, clear the journal; if only the archive exists and the accounts registry still lists the account, rename it back; if the account is already retired, finish step 6. |
| Something writes into the home during the move | 3 | The write lands in the archive (same inode), so nothing is lost. The liveness preflight is what keeps writers out. |

### Retired archives already on disk

R1 and R2 are retired with their home as the archive. The same step 6 applies
(unlink `projects`, move the rest to `shared/claude/retired/<id>/`, rewrite
their registry paths), run from the existing "clean up leftovers" action.
All 98 of their current generation paths already fail to resolve on disk
today, so the rewrite restores nothing for them; see below.

## 7. Tests the fix needs

All in temp homes with isolated `LLV_STATE_DIR`, `LLV_CLAUDE_HOME`,
`LLV_CODEX_HOME`, run by path (never a sweep of the live registry):

- `src/lib/accounts/removal.test.ts`
  - a Claude home shaped like Claude B (`projects` link into the shared store,
    `history.jsonl`, `shell-snapshots/`, `.llv/`, `statsig/`, `.claude.json`
    backups, credentials) is removed; the archive holds every non-credential
    file byte for byte; no credential remains; the shared store is untouched.
  - a Codex home shaped like Codex D (registered and unregistered rollouts,
    `*.sqlite` + WAL/SHM, `log/`, `history.jsonl`, group-writable plugin staging
    files, `auth.json`) is removed; every rollout is readable at its new path.
  - the archive destination already exists → refused, home untouched.
  - the rename fails (fault seam) → nothing changed, journal cleared.
- `src/lib/accounts/claude.test.ts`, `codex.test.ts`: journal recovery at each
  boundary, run in a child process that is killed between steps 2–3, 3–4,
  4–5 and 5–6.
- `src/lib/agent/registry` tests (the file that covers `retireAccount`):
  paths rewritten in every field listed in step 4; pins cleared; a
  `failed-recoverable` record settled; owed deliveries terminalized with the
  reason; a conversation on another account untouched.
- `accountLiveness` tests: `failed-recoverable` no longer counts as current;
  a `held` delivery on a conversation with no live host or receipt no longer
  blocks; a live host still blocks.
- Route tests (`src/app/api/accounts/route.test.ts` or the engine route
  tests): the 200 body carries moved counts, bytes and archive path; each
  refusal maps to its own code.
- `claudeTranscriptOwnership.test.ts` and the scanner roots test: after
  removal the Claude conversation resolves in the shared store; the Codex
  rollout is listed from the retired archive root.
- `useEngineAccounts` test: `live_sessions`, `current_conversations` and
  `filesystem_history` render distinct messages, and a success shows what was
  moved.

## 8. Fix slices

**Slice 1: removal succeeds and moves the leftovers (backend).**
Fence: `src/lib/accounts/removal.ts`, `src/lib/accounts/claude.ts`,
`src/lib/accounts/codex.ts`, `src/lib/agent/accountLiveness.ts`,
`src/lib/agent/registry.ts` (`retireAccount` and its path rewrite only),
`src/app/api/accounts/claude/route.ts`, `src/app/api/accounts/codex/route.ts`,
and their tests. Replaces the refusing inventory on the removal path with the
move-then-commit sequence; the inventory stays as the *report* of what moved.

**Slice 2: the dialog says what happened.**
Fence: `src/hooks/useEngineAccounts.ts`, the accounts dialog component,
`src/lib/i18n/en.ts`, `src/lib/i18n/uk.ts`, and their tests. Distinct messages
per blocker, the moved counts and archive location on success, and the
leftover-cleanup action for R1/R2. Rendered evidence through the existing
board or phone driver, per the repository rule.

Slice 1 alone makes removal work; slice 2 is what the requirement's "the
dialog says what was moved" needs.

## Options considered

- **Retain in place, relax the fence** (keep the home as the retired archive,
  delete only credentials, stop refusing on unknown entries). Smallest diff,
  no path rewrite for Codex. Rejected because the requirement asks for the
  leftovers to move, the Claude home would keep a live symlink into the shared
  store, and the per-entry deletion judgement that caused this issue would
  stay in the code.
- **Merge Codex rollouts into the Main account's `~/.codex/sessions`.** This
  is the other target the issue names. Rejected for now: 710 of the managed
  rollouts have a same-named file in the Main home (Codex A 695, Codex B 15),
  left by the copy-based migration. Byte comparison shows each pair is
  identical or one is a prefix of the other, so a merge needs a
  keep-the-longer rule and a registry repoint for each pair. It also would not
  make them resumable unless Main's Codex state database indexes them, which
  was not checked.

## Deferred — not currently justified

- **Resuming a removed Codex account's conversations** under another account.
  They stay readable. Resume needs the rollout inside a live `CODEX_HOME`,
  which is the #891 phase 2 question and was never verified.
- **Card pill naming the removed account.** The pill is path-derived and will
  show Main for archived conversations, as it already does for every
  shared-store Claude conversation. A registry-derived pill is #891 phase 0
  work.
- **Pruning archives** (e.g. dropping provider SQLite, 5.2 GB on Codex A–D).
  Nothing asks for disk reclamation; moving keeps the no-loss promise.
- **#1600** (queued pin scoped to its account) and **#1408** hardening: not
  on this failure path.
- **Project → account bindings** naming a removed account: not examined; the
  engine default reset covers new spawns.

## What I could not confirm

- **Liveness verdicts** come from the registry's JSON mirror plus `/proc`
  checks, not from running `accountRemovalBlockers` against the live registry
  (that would touch the shared state this repository forbids sweeping).
  Receipt liveness was approximated by pid checks. The classes named in §2
  (`failed-recoverable` migrations, `held`/`assigned` deliveries, live hosts on
  the active account) are read directly from the registry; the exact first
  blocker for Codex C and D (none found) is inferred.
- **Why all 98 current generation paths of the retired Claude R1/R2 no longer
  resolve.** The files are gone from the shared store as well. The Claude
  CLI's age-based transcript cleanup is a plausible cause; not verified.
- **Whether the Viewer's Codex scanner and `/api/log` admit a root under
  `shared/codex/retired/`.** Retired roots are admitted today through
  `codexSessionRoots()`; the new location has to be wired and tested in
  slice 1.
- **Registry path counts.** "Cur@home" and pin counts are from the JSON
  mirror, which was written in the same minute as the SQLite store; the SQLite
  store itself was not read.
