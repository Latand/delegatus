# Destructive-operation guard for Claude and Codex agents

Status: slice 1 implementation and successor design, 2026-11-17, for issue #4141.
Every code anchor below was read at `31eaf5edd5` (main, 2026-11-17). Engine
behaviour was observed on this machine with Codex CLI 0.166.0 (the native
`x86_64-unknown-linux-musl` binary of the npm package `@openai/codex`
0.166.0), Claude Code 2.1.325, Bun 1.4.0 and Linux 6.8 (section 3).

## 1. Originating requirement

Operator decision of 2026-11-17, relayed to this lane by the project's
orchestrator seat, paraphrased; the source of truth is issue #4141 (opened
2026-11-17), which carries the incident, seven proposal items, four repository
audit findings and the acceptance list.

> Agents get no full sandbox, because a sandbox keeps getting in the way.
> Delegatus owns hooks for both engines: one policy of protected paths;
> a PreToolUse hook for Claude and for Codex (Codex 0.166 has PreToolUse with
> the same JSON contract), which Delegatus itself installs and verifies in every
> account on every machine; a layer for nested commands that arrives through
> the agent's launch environment (wrappers first in the agent `PATH`, optionally
> a preload on unlink and rename), because in the incident the `rm` was born
> three processes below the agent's command; every refusal visible on the
> board; a stop that freezes agent scopes when state files disappear; state
> snapshots to the linked machine; role rules: test doubles never execute what
> they receive, the "run the test on the base" rule does not apply to
> destructive code, and a reviewer treats either as P0.

The pinned specification splits the work. Slice 1 (this lane) builds items 1–4
and 7 plus the four audit findings. A successor lane on the same task builds
item 5 (mass-deletion stop), item 6 (snapshots) and the preload library.
Section 13 and section 14 mark the split; section 17 validates the design
against the requirement.

### What happened, in one paragraph

A builder on a linked machine ran the tests of a data-migration script. The
test put an `ssh` stub first in `PATH`; the stub executed the "remote" command
locally with `bash -c`. To show its new tests mattered, the agent ran them
against the previous script version, which accepted `/..` as a target. The
cleanup `rm -rf '/..'/* …` then ran as the operator's user and recursed into
the home directory: Delegatus state, account credentials, most transcripts,
the secrets directory, cached releases and service files were lost. The
engine's own tool check saw only `uv run pytest …`.

### Threat model

The guard protects against cooperative agents running buggy code: test doubles
that execute what they receive, cleanup code with unvalidated targets, scripts
whose variables come out empty. It is no defence against an agent that sets
out to destroy data: such an agent can call `/usr/bin/rm` directly, start a
child with an empty environment, or write a static binary. Section 15 lists
every path neither layer covers. The guard restricts nothing except deleting,
moving and truncating the protected set; every other command runs as before.
The operator's own terminal and the commands they type are outside it: hooks
fire only on an agent's tool call, and the wrappers reach only processes that
Delegatus launched.

## 2. Earlier answers and the code this builds on

Searches of transcripts and memory ("destructive rm -rf guard PreToolUse
protected paths", the Ukrainian phrasing of the decision, "mass deletion
snapshots SIGSTOP") found the seat's relay of the decision and nothing older:
no protected-path guard existed before this issue. The closest mechanisms in
the code, each reused below:

| Mechanism | Where | What this design takes from it |
| --- | --- | --- |
| PID-only process-cleanup PreToolUse hook (#2729), both engines | `src/lib/agent/processCleanupPolicy.ts:11-252` | The hook boundary for both engines, the shell lexer for literal commands, the Codex trust-hash normalisation (`:233-243`) and session-flag form (`:245-252`) |
| Claude per-launch settings with managed hooks | `src/lib/agent/spawnPolicy.ts:425-438`, `:442-546` (`applyClaudeSpawnPolicy`, Bash hook at `:493`, `settings.env` at `:537`) | Where the Claude hook and the guard env enter every Claude launch |
| Codex app-server hooks and shell policy | `src/lib/runtime/codexAppServerHost.ts:1637`, `:1779-1784` | Where the Codex hook (fallback) and the guard env enter every structured Codex launch |
| Agent forge directory first in `PATH` | `src/lib/git/agentForgeCredentials.ts:160-169` (content-addressed dir under `$HOME/.cache/delegatus`), `:99-131` (real-binary walk that skips itself), `:203-219` (login-shell probe), `:260-298` (env) | The layout, the `PATH` walk and the login-shell probe of the wrappers |
| Agent git guard | `src/lib/git/agentHistoryGuard.ts:21-42` (`verifiedHook`: lstat, size, mode, `O_NOFOLLOW`, sha256, repair), `:240-241` (`PATH` prepend) | Verify-and-repair of installed files at each launch |
| Launch identity env, the one composition point | `src/lib/git/agentPublicationIdentity.ts:10-50`, `:52-86`; `src/lib/runtime/agentConfigSandbox.ts:86-127` | Where the guard env is composed, last, for every launch |
| Codex memory hook moved out of account files (#3187) | `src/lib/memory/hookMigration.ts:146-287` | Byte-preserving edits of `hooks.json` and the shared `config.toml`, backups in state, the startup call site (`src/lib/viewerInstrumentation.ts:911`) |
| Permission guard recorder (#2215) | `src/lib/runtime/permissionDenials.ts:125-180` | Refusal recording on the stage attempt and in the lifecycle journal |
| Sub-agent policy event | `src/lib/runtime/codexSubagentDetection.ts:123-153`, `src/lib/lifecycle/vocabulary.ts:73,108,132` | A high-signal lifecycle event per policy violation |
| Agent signal sandbox and the 2026-10-20 decision | `docs/design/agent-signal-sandbox.md` § "Boundary availability and known gaps, 2026-10-20" | A launch is never refused for a missing boundary; the launch reports the boundary off |
| Seat notice delivery | `src/lib/monitor/turboRuntime.ts:293-305` (`enqueueStructuredMessage`, `delegatusMessageOrigin`, policy `steer-or-queue`) | The plain message to an agent whose nested command was refused |

The decision recorded in #3187 matters here. The memory hook was taken out of
`~/.codex/hooks.json` so that it reached Delegatus agents only. The guard is
the opposite case: the operator wants it in every account, including sessions
the operator starts by hand on those accounts. Section 6 installs it into the
account files on purpose and explains why that is safe for the owner.

## 3. Engine contracts, as observed

Method: each installed CLI ran against a model stub
on an ephemeral loopback port, with `HOME`, `CODEX_HOME` or
`CLAUDE_CONFIG_DIR`, `XDG_*`, `TMPDIR` and `LLV_STATE_DIR` in a fresh directory
under the stage's own scratch, `LLV_VIEWER_CONTROL_URL` on a closed port, no
credentials, and a victim file the probe created itself. The Codex probes used
a private `model_catalog_json` with one entry copied from this machine's
catalog; every model in that catalog is `tool_mode: code_mode_only` with
`shell_type: unified_exec`, so both the code-mode path (`exec` running
`tools.exec_command`) and the direct `exec_command` path were driven. The
Claude probe answered the Messages API with a Bash `tool_use` (streaming and
non-streaming). Probe scripts and outputs were scratch-only and are gone with
the stage; the facts:

| Fact | Codex CLI 0.166.0 | Claude Code 2.1.325 |
| --- | --- | --- |
| Declaration | `hooks.PreToolUse = [{ matcher, hooks: [{ type: "command", command, timeout }] }]` in `$CODEX_HOME/hooks.json`, in `config.toml`, or as `-c` session flags | `hooks.PreToolUse` in `$CLAUDE_CONFIG_DIR/settings.json` or a `--settings` file |
| Trust | Required. `[hooks.state."<source>:pre_tool_use:<group>:<handler>"]` with `enabled = true` and `trusted_hash = "sha256:<hex>"`; the hash is the one `codexProcessCleanupConfig` computes (`processCleanupPolicy.ts:236-237`, handler normalised with `async: false`) | None |
| Trust key spelling | The **canonical** path: with `CODEX_HOME` reached through a symlinked ancestor, a key spelled with the logical path was ignored and the hook never ran; the realpath key worked. Trust was read through a `config.toml` that is itself a symlink to a shared file | — |
| Untrusted declaration | Skipped silently: no hook call, no warning to the model | — |
| Feature flag | `hooks` is `stable`, default `true` (`codex features list`) | — |
| Input on stdin | `session_id`, `turn_id`, `transcript_path`, `cwd`, `hook_event_name: "PreToolUse"`, `model`, `permission_mode`, `tool_name: "Bash"`, `tool_input: { command }`, `tool_use_id` (schema `pre-tool-use.command.input` embedded in the binary) | `session_id`, `transcript_path`, `cwd`, `prompt_id`, `permission_mode`, `effort`, `hook_event_name: "PreToolUse"`, `tool_name: "Bash"`, `tool_input: { command, description }`, `tool_use_id` |
| Tool name and command field | `tool_name` is `"Bash"` and the command is `tool_input.command` for `exec_command`, in direct mode and when code mode calls `tools.exec_command`; `exec_command`'s `workdir` arrives as the input's `cwd` | `"Bash"`, `tool_input.command` |
| Deny, JSON | stdout `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}` blocks; the model receives `Command blocked by PreToolUse hook: <reason>. Command: <cmd>` (code mode: as a script error) | Same object blocks; the model receives `PreToolUse:Bash hook error: <reason>` |
| Deny, exit 2 | Exit 2 with the reason on stderr blocks (exit 2 with empty stderr is an error) | Exit 2 with stderr blocks |
| Under bypass | Blocks under `--dangerously-bypass-approvals-and-sandbox` (`permission_mode: bypassPermissions`) | Blocks under `--permission-mode bypassPermissions` |
| Same handler declared twice | **Runs twice** (session flags plus `hooks.json`) | Runs once (account `settings.json` plus `--settings`) |
| Can a hook change the environment | No: `PreToolUse hook cannot change the tool environment` | — |
| Nested `PATH` reach | With `shell_environment_policy.set.PATH = <guard dir>:…`, `uv run --no-project sh -c 'rm -r …'` resolved `rm` to the guard directory, in direct and in code mode | With `env.PATH = <guard dir>:…` in a `--settings` file, the same command resolved `rm` to the guard directory |
| Engine's own rule | A built-in check rejects a top-level `rm -f…` and `bash -c 'rm -rf …'` ("rm -f style commands are not permitted"), even with no hook; `rm -r`, `find -delete` and `uv run sh -c 'rm -rf …'` ran | None observed |

What the probes did not establish, and which test must:

- The structured Codex host passes hooks as thread-level config
  (`codexAppServerHost.ts:1780-1784`); the probes used `codex exec` with `-c`
  flags. That account `hooks.json` hooks stay active beside thread-level hooks
  in `app-server` is the first assertion of the native test in section 12.
- `write_stdin` into an interactive shell, and deletions through
  `apply_patch` (`*** Delete File:`), were not probed. The nested layer covers
  the first; the second is out of scope (section 16).
- Real login profiles were not used (isolation forbids the real `HOME`). A
  profile that puts another `rm` ahead of the guard is detected at launch
  (section 7.4).
- Codex's built-in `rm -f` rule is version behaviour of the engine; the guard
  never relies on it.

## 4. Layers

```
agent tool call (Bash / exec_command)
 └─ PreToolUse hook  ── literal command: protected targets, globs, empty-variable
 │   (item 2)           forms ("$X"/*), --no-preserve-root  → deny + message
 └─ shell, runners, test frameworks, stubs, any depth
     └─ rm / find -delete / rsync --delete* / mv   (item 3: wrappers first in PATH)
         └─ same policy on the expanded, resolved targets → refuse whole call
     └─ unlink/unlinkat/rmdir/rename from Python, Node, coreutils by absolute path
         (successor: preload library)
 every refusal → journal → lifecycle event, stage attempt, Needs-you row,
                 message to the agent (item 4)
 state files vanishing anyway → freeze agent scopes (successor, item 5)
 data lost anyway → snapshots elsewhere (successor, item 6)
```

One program implements the policy for every layer: `bin/destructive-guard.mjs`
(section 6.1). The hook, the wrappers and the Viewer's own computations call
the same `evaluate` function, so the layers cannot disagree.

## 5. Item 1: the policy

### 5.1 Classes of protected paths

| Class | Members | Refused when the resolved target T is |
| --- | --- | --- |
| Structural | `/` and every path whose parent is `/` (decided by the program at run time, so a policy computed inside the container still protects the host's top level) | equal to it |
| Home | the agent user's passwd home, lexical and real path | equal to it, or an ancestor of it |
| Sealed | Delegatus config and state, release cache, runtime, account homes and credentials, transcripts, secrets, systemd user units, every project root and open lane worktree except the agent's own (table 5.2) | equal to it, an ancestor of it, or inside it, unless T is inside one of the agent's own roots |
| Own | the agent's worktree, its `TMPDIR`, its sandbox config root, its evidence directory | — (strictly inside an own root is admitted, after the ancestor check) |

### 5.2 Sources of the sealed set

All entries are stored both as written and as `realpath`; a symlinked entry
(the `delegatus` → `agent-log-viewer` app-dir link, a dotfile-managed
`~/.ssh`) protects both its link path and its target.

| Kind | Source in code |
| --- | --- |
| Delegatus config and state | `appConfigDir()` and every `APP_DIR_NAMES` spelling under the config root (`src/lib/configDir.ts:10-36`, `bin/appDir.mjs:21-27`); this contains state, managed account homes and the shared transcript store |
| Release cache and agent files | `$XDG_CACHE_HOME/delegatus` (`configDir.ts:15`), which holds the self-update releases, `agent-forge`, `agent-git-hooks` and the guard directory itself |
| Stable runtime | `stableMcpRuntimeRoot()` (`src/runtime-host/mcpRuntimeRelease.ts:26-29`) |
| Account homes | `listClaudeAccounts()`, `legacyClaudeHome()`, `$HOME/.claude.json`, `listCodexAccounts()`, the legacy Codex home, `claudeCapabilitiesRoot()` (`src/lib/accounts/claude.ts:56-69`, `src/lib/accounts/codex.ts:111-117`), plus any per-conversation `CODEX_HOME` a launch uses (external relay conversations keep theirs under state) |
| Secrets | defaults `~/.ssh`, `~/.gnupg`, `$XDG_CONFIG_HOME/gh`, `~/.git-credentials`, `~/.netrc`; plus the operator's list (5.5) |
| Service files | `$XDG_CONFIG_HOME/systemd/user` |
| Projects | every root from `localProjectDirectories()` (`src/lib/scanner/projectDirectories.ts:92`; `knownProjectRoots` caps at 40, so a new uncapped export is needed), the curation store's manual projects, and the `worktreeDir` of every open pipeline |

A project root is sealed only when it is narrower than the places every agent
legitimately writes: never `/`, a top-level directory, the home or one of its
ancestors, or a temp root (`/tmp`, `/var/tmp`, the temp directory) or one of its
ancestors. The catalog records sessions whose working directory was the home,
and sealing that entry would refuse every delete under the home
(`sealableProject` in `bin/destructive-guard.mjs`; `readPolicy` applies the same
filter to a policy file written before it existed).

The agent's own worktree is removed from the project entries for that agent
only. Ancestors need no list of their own: the evaluator refuses any T that is
a prefix of a home or sealed entry, which covers `~/.config`, `~/Projects`,
the worktree container directory and `/home`.

### 5.3 Evaluation of one target

For each resolved target T, in this order:

1. The call carries `--no-preserve-root` (any `rm` argument): refuse.
2. T is structural, the home, a sealed entry, or an ancestor of the home or of
   a sealed entry: refuse.
3. T is strictly inside an own root: admit.
4. T is inside a sealed entry: refuse.
5. Admit.

A call is refused whole when any one of its targets is refused: the wrapper
deletes nothing and the real binary never starts. Step 3 is what keeps an
agent's scratch working: a stage's `TMPDIR` lives under
`statePath("scratch")` (`agentConfigSandbox.ts:65-79`), inside the sealed
state directory, and its contents stay deletable while `state/scratch` and
`state` stay protected by step 2 and step 4.

Own roots are computed by the launch and passed in the environment (section
7.2). An own root that is a home or sealed entry, or an ancestor of one, is
dropped (an agent launched in `$HOME` gets no own root there). An own root
that contains a sealed entry, such as a primary checkout with another lane's
worktree nested inside it, stays an own root for step 3 but loses the shell
fast path (section 7.5), so the nested entry is still caught by step 2.

### 5.4 Resolving a target

The kernel resolves `..` after following symlinks, so lexical normalisation is
wrong for `/..` behind a link. T is therefore built from the filesystem:

- `rm` operands, `mv` sources and `find` start points under `-P` (the
  default): T = `realpath(dirname(operand))` joined with the operand's last
  component, resolved against the call's working directory. A final symlink
  stays the link itself, because these tools remove or rename the link. An
  operand ending in `/`, or whose last component is `.` or `..`, resolves
  fully: T = `realpath(operand)`. A missing parent means nothing exists to
  delete: admitted.
- `find` with `-H`, `-L` or `-follow`, an `rsync` destination, and a
  `truncate` target follow the final link: T = `realpath(operand)`, or the
  parent's realpath plus the name when the target does not exist yet.
- `mv` destination: when it is an existing directory, T is that directory's
  realpath plus each source's basename; otherwise the parent's realpath plus
  the name. A destination inside a sealed entry is refused like a source
  there, because a move over a credential file destroys it.

The incident's targets show why this matters. The wrapper received `/../bin`,
`/../boot`, `/../home` and the rest. `realpath("/..")` is `/`, so T is
`/boot` (structural) and `/home` (an ancestor of the home): the whole call is
refused before anything is deleted.

### 5.5 Operator-configured secrets and other roots

`statePath("destructive-guard-protected.json")`: a JSON array of absolute or
`~/`-prefixed paths, read at every policy computation, following the
precedent of `forge-app-repositories.json`
(`agentForgeCredentials.ts:27-48`). Each entry is sealed. A file that cannot
be read as such an array keeps the last valid list (held in `policy.json`) and
raises a `destructive_guard_off`-class lifecycle event naming the file; the
launch goes on, in line with the 2026-10-20 decision. A settings screen for the
list is deferred (section 16); the file sits inside sealed state, so an agent
cannot edit it away with the wrapped tools.

### 5.6 The policy file

The Viewer computes the set and writes
`$HOME/.cache/delegatus/agent-guard/policy.json` atomically (temporary file,
`fsync`, rename) whenever its digest changes; computation runs at Viewer
startup and at each launch (a few hundred `realpath` calls at most). Content:
`{ v: 1, digest, computedAt, home: [..], sealed: [{ path, kind }] }`, mode
0600. Running agents read the current file on each slow-path check, so a
project added after their launch is protected for them too.

When the file is missing or unreadable at check time, the program falls back
to a built-in set derived from the passwd home (never from `$HOME`, which
tests and scripts repoint): structural roots, the home, the three app-dir
spellings under `~/.config`, `~/.cache/delegatus`, `~/.claude`,
`~/.claude.json`, `~/.codex`, `~/.ssh`, `~/.gnupg`; and the journal line
records `policy: "fallback"`. A vanished policy file is itself a symptom the
successor's watcher counts.

## 6. Item 2: one hook program, installed and verified everywhere

### 6.1 The program

`bin/destructive-guard.mjs`, a single dependency-free ES module that runs
under Bun or Node, shipped in `bin/` like `bin/forge-app-token.mjs` and found
the same way (`agentForgeCredentials.ts:137-148`: the checkout's `bin/`, the
standalone server's `../../bin/`, the stable runtime's `bin/`). It exports
`evaluate` for the Viewer and the tests, and has three entry modes:

- `hook`: reads the engine's PreToolUse JSON on stdin, analyses
  `tool_input.command` (section 6.2), writes a JSON deny on stdout or nothing.
- `check <tool> -- <argv…>`: called by a wrapper on its slow path; exit 0
  admits, exit 1 refuses after printing the message on stderr.
- `version`: prints the protocol number and its own sha256.

The Viewer publishes it, together with the four wrappers, into a
content-addressed directory `$HOME/.cache/delegatus/agent-guard/<24-hex>/`
(hash over all file bodies, as `agentForgeDir` does), under `HOME` because the
Docker build runs agent CLIs in the host namespace through the nsenter shim and
only `HOME` is shared at the same path (`agentHistoryGuard.ts:189-190`). A
release that changes the program gets a new directory; a running agent keeps
the files its environment names. The version of the guard is that hash.

The hook command, identical for both engines:

```
LLV_MANAGED_DESTRUCTIVE_GUARD=1 bun '<guard dir>/destructive-guard.mjs' hook
```

The prefix marks the handler as Delegatus-owned, as `MANAGED_HOOK_PREFIX` and
`PROCESS_CLEANUP_HOOK_PREFIX` do (`spawnPolicy.ts:37`, `processCleanupPolicy.ts:6`).
Timeout 10 s on both engines.

Failure behaviour: an internal error in the program, or a command its lexer
cannot parse, admits the call and appends an `error` line to the journal; the
nested layer still stands, and a hook that denied every command on a bug would
stop every agent on the machine. A missing policy file uses the fallback set
(5.6).

### 6.2 What the hook checks

The hook parses the literal command with a shell lexer built to the contract of
`forbiddenProcessCleanup` (`processCleanupPolicy.ts:11-206`: quotes, escapes,
line continuations, `$(…)`, backticks, process substitution, heredocs, arrays,
`sh|bash|zsh|dash|ksh -c` and stdin shells, wrappers `sudo`, `env`, `exec`,
`command`, `builtin`, `nohup`, `timeout`, `xargs`, `rtk proxy`), extended with
`nice`, `ionice`, `time`, `uv run`, `poetry run`. For each simple command it
inspects:

- `rm` (any `-r`, `-R`, `--recursive`, and plain file deletes inside sealed
  entries), `rmdir`, `unlink`, `shred -u`, `truncate`, `find … -delete`,
  `rsync` with `--delete*`, `--del` or `--remove-source-files`, `mv`;
- `cp` destinations and `dd of=` targets, including followed final links;
- truncating redirections (`>`, `>|`, `&>`) whose target is inside a sealed
  entry.

Words are expanded the way the shell would, as far as the hook can know:
`~` and `~user`; variables assigned earlier in the same command text; `HOME`,
`TMPDIR` and `PWD` from the hook's environment; relative paths against the
input's `cwd` (which Codex sets to the effective `workdir`, section 3), moved
by literal `cd`, `pushd` and `popd` earlier in the same command list; a
subshell's directory changes end with it. A directory the hook cannot resolve
takes its empty-expansion form (an empty unquoted operand is the home, a quoted
one stays), and a refusal under it is reported as that expansion. ANSI-C
quoting (`$'…'`) is decoded with its backslash escapes, and `$"…"` is read as
`"…"`.
Unquoted glob words are enumerated with the filesystem (at most 10 000
matches; more is refused as too broad), and each match is evaluated.

Unresolvable targets (the issue's `rm -rf "$X"/*`): every expansion the hook
cannot resolve, including `$(…)`, is replaced by the empty string, and the
resulting target is evaluated. When that empty form is refused, the command is
refused with a message naming the variable. `"$X"/*` becomes `/*`, which
enumerates the structural roots; `"$HOME/$SUB"` becomes the home. A word
written `${X:?…}` fails in the shell when `X` is empty, so it is left to the
nested layer. This is ShellCheck's SC2115 rule, applied where it costs a life.

The deny reason is the agent's message; section 8.3 gives the text.

### 6.3 Claude installation

Two places, both with the same handler, `{ matcher: "Bash", hooks: [handler] }`:

1. **Per launch.** `applyClaudeSpawnPolicy` adds the guard handler beside the
   cleanup handler (`spawnPolicy.ts:493`), and `managedCommand`
   (`spawnPolicy.ts:425-428`) learns the guard prefix, so a copy taken from the
   account's own hooks is stripped and re-added once. Every Delegatus Claude
   launch goes through this function: `cli.ts:200,463,674`,
   `headless.ts:378`, `claudeStreamBrokerHost.ts:1266`,
   `accounts/terminalLaunch.ts:34`. The existing refusal of
   `disableAllHooks` and `allowManagedHooksOnly` (`spawnPolicy.ts:483-488`)
   already stops a launch whose account would switch the hook off.
2. **Account file.** `<account home>/settings.json`, where that file exists:
   the legacy home (`legacyClaudeHome()`, honouring `LLV_CLAUDE_HOME`) and any
   managed home that has one. A managed home without `settings.json` gets none:
   `applyClaudeSpawnPolicy` treats a missing file as "use the shared capability
   snapshot" (`spawnPolicy.ts:467-470`), so creating one would change every
   launch of that account. The snapshot is copied from the legacy home
   (`claude.ts:498-512`), so the legacy install reaches it on the next sync.
   The edit is byte-preserving (the span editor of `hookMigration.ts:12-37`),
   preserves every personal handler, removes older guard handlers, and writes
   through a symlinked `settings.json` only when its target is a regular file
   under the passwd home; otherwise the account is reported (6.6).

Claude ran the identical handler once when both the account file and
`--settings` declared it (section 3), so the two places cost one hook run.

### 6.4 Codex installation

1. **Account file.** `realpath(<CODEX_HOME>)/hooks.json` gets a Delegatus group
   `{ matcher: "Bash", hooks: [handler] }` in `hooks.PreToolUse`, appended after
   any personal groups and replaced in place on later versions; personal groups
   are never reordered, because their trust keys carry group and handler
   indices.
2. **Trust.** `realpath(<CODEX_HOME>/config.toml)` gets
   `[hooks.state."<realpath(CODEX_HOME)>/hooks.json:pre_tool_use:<g>:<h>"]`
   with `enabled = true` and the `trusted_hash` computed as in
   `processCleanupPolicy.ts:236-237`. The key uses the canonical path, because
   Codex 0.166.0 ignored a logically spelled key (section 3). Managed Codex
   homes link `config.toml` to the legacy home's file (`codex.ts:22,646`), so
   all accounts' trust tables live in one shared file; each key names its own
   home, so they coexist. Stale guard trust tables (a guard key whose hash is
   not the current one) are removed. Edits follow `hookMigration.ts:130-143`:
   validate first, compare the bytes read with the bytes at the swap, back up
   to `statePath("migrations", "destructive-guard")`, atomic replace, every
   personal byte kept.
3. **No double run.** Codex ran the same handler twice when both session
   flags and `hooks.json` declared it (section 3). So a Delegatus Codex launch
   uses the account install when its verification passed, and adds the guard
   group to its session flags (group index 1, key
   `/<session-flags>/config.toml:pre_tool_use:1:0`) only when it did not. The
   sites are those that already add the cleanup group: `cli.ts:206,565,734`,
   `headless.ts:402`, `codexAppServerHost.ts:1637,1780`,
   `operatorQuestionPolicy.ts:13`.
4. **Why `hooks.json`.** A guard group declared in `config.toml` would be
   replaced by the `-c hooks.PreToolUse=[…]` flag every Delegatus launch
   already passes for the cleanup hook, since a config layer replaces arrays;
   `hooks.json` is a separate source and stayed active beside the flags in the
   probe.

`features.hooks` is stable and on by default in 0.166.0; an account config
that sets it (or the alias `codex_hooks`) to `false` keeps Delegatus launches
guarded (they pass `-c features.hooks=true`) and is reported for manual
sessions.

### 6.5 Verify at each launch, install everywhere

`ensureDestructiveGuard({ engine, home })`, called by every launch path above
for the launching home (including per-conversation Codex homes of the external
relay), before the engine starts:

1. Publish or verify the guard directory: each file checked as
   `verifiedHook` does (`agentHistoryGuard.ts:21-42`: regular file, size,
   mode, `O_NOFOLLOW` read, sha256), republished atomically on mismatch with a
   `console.warn` naming the expected digest.
2. Refresh `policy.json` when its digest changed.
3. Read the account file(s) of section 6.3 or 6.4, compare with the expected
   handler (and for Codex the expected trust table under the canonical key),
   repair once on drift, re-read to confirm.
4. Return `{ hook: "account" | "session" | "per-launch", nested: "on" | "off" }`
   for the launch receipt.

Cost budget: under 20 ms (two small file reads and one hash of a file of tens
of kilobytes). A verification that still fails after one repair does not stop
the launch: Claude is covered by its per-launch settings regardless, Codex
falls back to session flags, and a `destructive_guard_off` lifecycle event
names the account and the reason.

At startup the serving Viewer runs `installDestructiveGuardForAccounts()` next
to `retireLegacyCodexMemoryHooksAtStartup()` (`viewerInstrumentation.ts:911`):
every listed Claude and Codex account plus the legacy homes. It first calls
`assertStateStartupMutation(stateDir(), "install destructive guard hooks")`
(`src/lib/stateOwnership.ts`), so a build, a test run or an unowned process
never installs into the operator's account homes; a test passes explicit fake
homes under a sandboxed state, which the fence admits. Account creation and
login go through the next launch's verification.

Linked machines: each linked machine runs its own Delegatus, so its startup
and its launches install and verify its own accounts through this same path.
Nothing crosses machines for item 2.

### 6.6 The operator's own sessions

The account-file install also guards sessions the operator starts by hand on
those accounts (the requirement says every account). Such a session has no
guard environment, and an operator terminal launch names no working tree
(it marks itself with `LLV_DESTRUCTIVE_GUARD_SESSION_ROOT=1`). In both cases
the hook owns the project the session reports working in: the checkout top
level of the input's `cwd`, else the deepest recorded project containing it,
else that directory, never the home, `/` or anything inside a protected
non-project entry. Everything else is evaluated against the policy file as
for a launched agent, so another project, account directories and state stay
refused. The wrappers of a marked terminal launch do the same from their own
working directory. A launched agent never gains the project its tool call runs
in. The operator's own commands in a terminal are untouched: hooks fire on
agent tool calls and the wrappers exist only in Delegatus launch environments.
This keeps the owner's manual tier unrestricted.

## 7. Item 3: the nested-command layer

### 7.1 Why the environment, and why the forge directory alone is not enough

Codex hooks cannot change the tool environment (section 3), and the incident's
`rm` ran three processes below the tool call, so only the environment the
launch hands the engine reaches it. The issue assumed the agent-forge
directory is always first in `PATH`; in the code it exists only when a
repository is declared (`agentForgeWriteEnv` returns `{}` otherwise,
`agentForgeCredentials.ts:262`), and the stage git guard puts its own directory
first when a stage receipt is present (`agentHistoryGuard.ts:240-241`). The
guard therefore gets its own directory (6.1), always present, and placed
before both.

### 7.2 Environment

| Variable | Value |
| --- | --- |
| `PATH` | `<guard dir>:` followed by the `PATH` the identity env produced, minus any other `*/delegatus/agent-guard/*` entry |
| `LLV_DESTRUCTIVE_GUARD_DIR` | the guard directory |
| `LLV_DESTRUCTIVE_GUARD_POLICY` | absolute path of `policy.json` |
| `LLV_DESTRUCTIVE_GUARD_OWN` | own roots, real paths joined by `:` (a root containing `:` is dropped) |
| `LLV_DESTRUCTIVE_GUARD_FAST` | the own roots that contain no sealed entry (fast path) |
| `LLV_DESTRUCTIVE_GUARD_SESSION_ROOT` | `1` when the launch named no working tree (section 6.6) |
| `LLV_DESTRUCTIVE_GUARD_JOURNAL` | absolute path of the refusal journal in the real state directory |
| `LLV_DESTRUCTIVE_GUARD_CALLER` | sha256 of the launch's spawn capability, when it has one (never the capability itself) |
| `LLV_DESTRUCTIVE_GUARD_BUN` | the host interpreter for the slow path; the wrapper falls back to `command -v bun`, then `node` |

The names use the `LLV_` prefix because `withAgentConfigSandbox` deletes every
`DELEGATUS_`-prefixed name before an agent sees it
(`agentConfigSandbox.ts:112-114`). The journal path names the real state
directory the way `FORGE_AUDIT_ENV` already does (`agentForgeCredentials.ts:289`).

Own roots: the launch's working tree (its git top level when it is a linked
worktree or a lane worktree; the launch directory otherwise), the agent's
`TMPDIR`, `agentConfigSandboxRoot()` (`agentConfigSandbox.ts:58-63`) and
`LLV_EVIDENCE_DIR` when set, each `realpath`'d and filtered by 5.3.

### 7.3 One composition point, every launch site

The guard env is computed by one function,
`agentDestructiveGuardEnv(source, { cwd })`, applied last over the launch
identity env so its `PATH` entry ends up first. `cwd` is a required parameter
so no site can skip it. The sites are those that apply
`agentPublicationIdentityEnv` today:

| Site | Engine and path |
| --- | --- |
| `runtime/agentConfigSandbox.ts:91` | child env of both structured hosts (Codex app-server, Claude stream broker, Copilot ACP) |
| `runtime/codexAppServerHost.ts:1779` | `shell_environment_policy.set` of a Codex thread (the env every exec tool gets) |
| `agent/spawnPolicy.ts:537` | `settings.env` of every Claude launch (Claude re-applies it over the child env) |
| `agent/cli.ts:174,192,475` | tmux and terminal launch commands |
| `agent/headless.ts:82,324` | one-shot reviewer, flow and relay runs |
| `agent/ephemeral.ts:225` | ephemeral runs (Claude ones have no Bash tool; the env still applies) |
| `runtime/claudeStreamBrokerHost.ts:1286` | Claude structured host |
| `pipelines/stageAttemptPush.ts:332`, `pipelines/git.ts:2477` | the engine's own push of a lane, whose pre-push hook runs the repository's tests |

The last row closes a gap the issue did not name. The publication pre-push
samples a failing test file on the merge base automatically (AGENTS.md
"Touched tests"); that is the "run it on the base" step of the incident, done
by the controller under the Viewer's environment, with no agent wrapper in it.
With the guard env on the publication push, that base run is protected by the
same nested layer. Own roots there: the lane worktree and the push's
temporary directories.

Gate commands keep the layer:

- `checkEnvironment` (`scripts/gate-cache.ts:110-123`) keeps only listed
  variables. `LLV_DESTRUCTIVE_GUARD_[A-Z_]+` joins the `TRANSPORT` pattern
  (`:101`), which decides where a check runs and never what it checks, and the
  guard directory must not join the forge-directory filter at `:121`.
- `scripts/owned-runner.ts:332` writes the caller's whole environment into the
  unit's launch file, so `gate-slot.sh` keeps `PATH` and the guard variables.

### 7.4 Login shells

Both engines run commands through a login shell (`/bin/bash -lc` for Codex,
section 3), and a profile may put directories ahead of the `PATH` it was given.
`toolsInLoginShell` (`agentForgeCredentials.ts:180-192`) already asks the
launch's shells which `gh` and `git` they find; it also asks for `rm`, `find`,
`mv` and `rsync`. When any of them resolves outside the guard directory the
launch still starts, in line with the 2026-10-20 decision; the receipt records
`nested: "off"` with the shell and the path found, and a
`destructive_guard_off` lifecycle event (high signal) names the profile line to
fix. The probe result is cached for 30 s as today, so the extra cost is one
cached login-shell run per launch.

### 7.5 The wrappers

Four POSIX `sh` scripts in the guard directory: `rm`, `find`, `rsync`, `mv`.
Each one:

1. **Finds the real binary** as the forge `git` shim does
   (`agentForgeCredentials.ts:99-116`): walk `PATH` with `IFS=:` and globbing
   off, skip empty entries, its own directory, any `*/delegatus/agent-guard/*`
   directory (an older generation) and any candidate that `-ef` the wrapper
   itself, take the first regular executable; fall back to `/usr/bin/<tool>`,
   then `/bin/<tool>`; none found exits 127. The program never starts a tool
   itself (it uses `fs` only), so no wrapper can recurse into another.
2. **Passes untouched what the policy never refuses**: `find` without
   `-delete`, `rsync` without a delete option. `find … -exec rm …` needs no
   `find` check: `find` starts `rm` through `PATH`, which reaches the `rm`
   wrapper.
3. **Fast path, shell builtins only, no fork.** Admit and `exec` the real
   binary when every operand passes: no `--no-preserve-root`; no `.` or `..`
   component and no trailing `/`; the absolute path (`pwd -P` for relative
   operands) lies strictly inside one of `LLV_DESTRUCTIVE_GUARD_FAST`; and no
   path component between that root and the operand's parent is a symlink
   (`[ -L ]`). For `find`, any of `-H`, `-L`, `-follow` sends the call to the
   slow path; for `mv`, sources and destination all have to pass. The fast path
   only admits; anything it cannot decide goes to the slow path.
4. **Slow path.** `"$LLV_DESTRUCTIVE_GUARD_BUN" "$dir/destructive-guard.mjs"
   check <tool> -- "$@"`; exit 0 → `exec "$real" "$@"`; otherwise exit with its
   status. The program parses the tool's argument grammar (GNU option
   bundling, options after operands unless `--`, `rm -d`, `mv -t`/`-T`,
   `rsync` local versus `host:path` operands, `find` leading options and start
   points), resolves each target (5.4), evaluates (5.3), and on refusal writes
   the journal line (section 8) and prints the message.

`rsync` to a remote `host:path` is that host's business; the guard on the
remote side covers it when that host runs Delegatus, and the script's own
validation has to hold (issue comment).

Windows keeps the environment it had, as the forge shims do
(`agentForgeCredentials.ts:262`). macOS uses the same scripts; the parent chain
comes from one `ps` call on refusal (section 8).

## 8. Item 4: every refusal is visible

### 8.1 The journal

`statePath("destructive-guard", "refusals.ndjson")`, mode 0600, one `write` of
one line per refusal with `O_APPEND`, each line under 4 KiB:

```
{ v: 1, id, at, layer: "hook" | "wrapper", engine?, tool, command (≤ 2 KiB),
  cwd, targets: [{ given, resolved, rule, entry }], caller: { capabilityDigest?,
  sessionId?, transcriptPath?, toolUseId? }, parents: [{ pid, startTime, comm,
  args (≤ 200 chars) }] (≤ 12, read from /proc up to the engine or pid 1),
  guard: { version, policyDigest, policy: "file" | "fallback" } }
```

`rule` is one of `structural`, `home`, `ancestor`, `sealed`,
`no-preserve-root`, `empty-expansion`, `too-broad`. `error` lines (6.1) use the
same file with `layer: "error"`.

### 8.2 Ingest

The serving Viewer watches the directory (`fs.watch`, with a 5 s poll as a
fallback) and reads only the bytes after its persisted cursor
(`refusals.cursor.json`), so the work scales with new lines and a restart
resumes where it stopped. The journal is rotated at 5 MiB by the ingester.
For each new line:

1. **Conversation**: `capabilityDigest` through
   `conversationIdForSpawnCapabilityDigest` (`src/lib/agent/registry.ts:7128`);
   else `transcriptPath` through `conversationForPath`; else the first parent
   whose pid and start time match a recorded host process; else unattributed,
   with the project from `projectInfoFromCwd(cwd)`.
2. **Lifecycle**: event `destructive_refused`, key
   `destructive-refused:<id>`, with conversation, project, pipeline, stage,
   attempt, role and a one-line summary; added to `LIFECYCLE_EVENT_TYPES` with
   state `running` and to `TERMINAL_HIGH_SIGNAL_EVENT_TYPES`
   (`vocabulary.ts:73,108,132`), so it bypasses the digest rate limit and
   reaches the seat the way `subagent_policy_violation` does.
3. **Stage attempt**: `attempt.guardRefusals`, capacity 20, written with the
   same lease retries as `appendDenial` (`permissionDenials.ts:83-96,146-165`).
4. **Board**: a new conversation reason kind `refusal` in
   `ConversationReasonKind` (`src/lib/attention/dismissalTypes.ts:57`), derived
   in `undismissedReason` (`src/components/attention.ts:293-…`) from a
   `guardRefusal` field the `/api/files` projection adds to the conversation's
   entry (latest undismissed refusal, 24 h like `DELIVERY_ATTENTION_TTL`). Tier
   `blocked`. It joins the Needs-you rows (`NEEDS_YOU_ROW_KINDS`,
   `src/lib/attention/needsYouProjection.ts:19`) and is dismissed with the
   existing dismissal control. Row text, en: "Delegatus stopped a delete: <tool>
   would remove <entry> (<kind>)."; uk: "Delegatus зупинив видалення: <tool>
   прибрав би <entry> (<kind>)." An unattributed refusal, or one from a
   publication push, appears through its lane: the push fails, and the lane's
   refusal text names the guard on its first line.
5. **Agent message** (nested refusals; a hook refusal already reached the model
   as its deny reason): one message per conversation per minute through
   `enqueueStructuredMessage` with origin
   `delegatusMessageOrigin("guard", project)`, `clientMessageId`
   `destructive-guard:<id>` and policy `steer-or-queue`, the path
   `deliverTurboSeatNotice` uses (`turboRuntime.ts:293-305`); a conversation
   without a structured host gets the same text through
   `deliverConversationMessage` (`src/lib/delivery.ts:273`).

### 8.3 The message

Wrapper stderr, hook deny reason and the delivered message share one text:

> Delegatus stopped this command: `<excerpt>` would delete `<entry>`
> (<kind: a top-level system directory | your home directory | the Delegatus
> state directory | an account's credentials | another project | …>). Nothing
> was deleted by it. Stop and ask the operator before you delete, move or
> overwrite anything outside your worktree and your temp directory. Do not
> retry it another way.

For an empty-expansion refusal the second sentence names the variable: "If
`$X` is empty this deletes `/`. Guard it with `${X:?}` or use a literal path
inside your worktree or temp directory."

### 8.4 Rendered evidence

The Needs-you row is a rendered change. Per AGENTS.md "Rendered evidence", it
gets a `describe` block in the existing kanban board driver
(`src/components/kanban/kanbanBoard.browser.test.tsx`) and the phone driver
(`src/components/mobile/issue1671Evidence.browser.test.tsx`), en and uk, light
and dark, run in isolated state; no new driver.

## 9. Performance

Prototype measurements on this machine (Linux 6.8, 24 CPUs, Bun 1.4.0), one
run each in the stage's scratch directory on files the run created; they size
the budgets and are no acceptance evidence:

| Case | Time |
| --- | --- |
| plain `rm -f` of 3 000 files, one call | 24 ms |
| Bun check of 3 000 operands (`realpath` of each parent) then `rm`, one call | 63 ms |
| `bun -e 0` | ≈ 5 ms per start |
| `sh` wrapper that only `exec`s `rm` | ≈ 1.1 ms per call |
| `realpath -m` of 3 000 operands | 10 ms |

Budgets for slice 1, each measured as the median and maximum of five runs on
fresh files and reported in the stage evidence:

| Case | Budget |
| --- | --- |
| Fast path, added per call (200 calls of `rm <file>` in own `TMPDIR`) | ≤ 2 ms |
| 3 000 relative operands in an own directory, one `rm` call (fast path) | total ≤ 1.5 × plain |
| 3 000 absolute operands, one `rm` call (slow path) | total ≤ 250 ms (target 150) |
| `find <own dir> -delete` over 3 000 files | ≤ plain + 60 ms |
| 3 000 separate `rm <absolute path>` calls in own `TMPDIR` | ≤ 1.5 × plain |
| Hook, p95 of 100 Bash calls with the real program | ≤ 60 ms |
| Launch-time verification (section 6.5) | ≤ 20 ms, login-shell probe excluded (cached) |
| Journal ingest per line | ≤ 5 ms, no whole-journal read per tick |

`destructiveGuard.performance.test.ts` and, for the 3 000 separate calls,
`destructiveGuard.performanceSeparate.test.ts` run inside the publication gate
beside other test files, under a CPU quota and uncontrolled host load. Each
file stays well inside the gate's five-minute file deadline. They hold each
time budget scaled by a host factor taken from the same run:
max(1, median plain `rm -f` of 3 000 files ÷ 24 ms), the idle measurement
above; the separate-calls file takes that sample in each of its rounds.
Contention slows both sides of every pair, and the factor loosens the
absolute bounds in the same proportion. The hook and the launch-time check
are CPU-bound process work measured after the rm rounds, so a load change
there would escape the rm factor. Each of their calls is interleaved with a
`bun -e 0` start, and their bounds scale by the larger of the host factor and
max(1, median start ÷ 5 ms), the idle start above. The one-call fast path is
held to 1.5 × plain plus one wrapper start (30 ms), because a 24 ms baseline
cannot absorb a fixed start cost as a ratio. The 3 000 separate calls are held
to the fast path's 2 ms added per call. The slow path is judged on its median.
The "well under a second" bound for 3 000 targets stays unscaled. A cost
regression exceeds its budget in every campaign, while a load spike in the
shared gate rarely hits two in a row, so the main file runs up to three fresh
campaigns and passes on the first that meets every budget. When none does,
the failure lists each campaign's exceeded bounds with their measured values
and limits. The report
lines `guard-performance` and `guard-performance-separate` carry the factors
with the raw runs.

## 10. Item 7: role rules

All in `src/lib/roles/defaults.ts`. One constant carries the rule so every role
that runs tests reads the same text:

`DESTRUCTIVE_TEST_RULE` = "Destructive code (anything that deletes, moves,
truncates or overwrites paths): a test double records what it receives and
asserts on it, and never executes it; a test of destructive code touches only
paths it created under its own temp directory, and asserts that before it acts;
never run such a test, or the code, against the base or any older version of
that code."

| Role text | Change |
| --- | --- |
| Builder, `TESTS_RULES` (`:125`, carried by `BUILDER_WORK_RULES` at `:150`) | The last sentence ("Before you blame a change for a failing test, run the same test on the base…") gains "…except a test of destructive code, which never runs against the base"; `DESTRUCTIVE_TEST_RULE` is appended |
| Reviewer, `TESTS_JUDGING` (`:126`, scaffold at `:279`) | "A test double that executes what it receives, and a recursive delete or move whose target the code does not validate (resolved path, inside a root the code owns, refusing protected paths), are P0 findings." |
| Reviewer, `REVIEW_BASELINE_RULE` (`:108`) | "Never run a test of destructive code at the base; judge its head-only failures on the head." |
| Merger (`:363`) | `DESTRUCTIVE_TEST_RULE`: its culprit-by-removal probes keep a PR's tests while removing its code, which is the incident's combination of a new test and old code |
| Verifier (`:284`) | `DESTRUCTIVE_TEST_RULE` |

Per AGENTS.md, no test asserts the presence or absence of these phrases; the
reviewer of this lane reads the rendered scaffolds.

## 11. The four audit findings

| Finding | Fix | Acceptance (focused test) |
| --- | --- | --- |
| **High** `scripts/gate-runner/harness.fixture.ts:65,82`: the `ssh` stub runs the received command with `/bin/bash -c` on this host | The stub never hands received text to a shell. It matches the command against the closed set the client sends (`client.ts:175-181` probe, `:734` `serve.ts run`, `:816` `remove`, `:874` `mkdir -p ~/runs/<id> && tar -xf - -C ~/runs/<id>`, `:934` `pack-outputs`), with `<id>` limited to the client's id alphabet, maps `~` to the harness's runner home, and dispatches to a fixed action: `spawn(argv)` without a shell for `serve.ts` from the run directory, `fs.mkdirSync` plus `tar` with an argv for the upload, a probe answer computed by the stub. Anything else is recorded and answered with exit 255. The `systemd-run` branch (`:80-82`) runs the same fixed argv. | Sending `touch <marker>` through the stub leaves no marker and records the refusal; every `scripts/gate-runner/remote*.test.ts` passes |
| **Medium** `scripts/gateSandboxRecords.ts:31`: without an allocation record, `releaseGateSandbox` removes the directory with no prefix, realpath or symlink check | `recordGateSandbox` always keeps the identity (realpath, dev, ino) in memory and journals it only when `LLV_GATE_SANDBOX_RECORD` is set; `releaseGateSandbox` of a directory with no identity throws and deletes nothing; with one, the existing identity checks (`:35-37`) apply | Releasing a never-recorded directory throws and the directory survives; a recorded directory replaced by a symlink throws and the link target survives; a recorded directory is removed |
| **Medium** `scripts/gate-runner/serve.ts:390`: production code runs `LLV_GATE_RUNNER_TEST_AFTER_INSTALL` as a shell command | The shell seam is removed. The two tests that need it (`remoteTree.test.ts:22` appends to a file after install; `remoteLifecycle.test.ts:193` holds a lock during install) use a typed seam, `LLV_GATE_RUNNER_TEST_AFTER_INSTALL_ACTION`, a JSON object with exactly one of `{ append: { file, text } }` (file relative, inside the materialised tree) or `{ hold: { lock, mark } }` (both inside the run directory); anything else fails setup with step `manifest` | Setting the old variable to `touch <marker>` creates no marker; an action naming `../x` or an absolute path outside the run directory fails setup; both tests pass with the typed seam |
| **Low** `src/lib/externalRelay/conversations.ts:227-241`: the recursive delete checks only the basename | Both delete functions also require that `realpath(dirname(cwd))` equals the realpath of a root the module mints under (`os.tmpdir()`, or `/tmp` when the temp root is under home, `:353-356`), that the cwd is exactly one segment below it, and that `lstat(cwd)` is a directory; a record that fails is left on disk and logged, and the pass continues: the record is still dropped (or, when refreshed, re-minted under the current root) and its id-named state directory removed | A record whose cwd is `<other dir>/llv-relay-conv-<id>`, or `<tmp>/x/../llv-relay-conv-<id>` resolving elsewhere, or a symlink with the right name, is refused and the target survives; a minted directory is removed; a maintenance pass or a capacity eviction that meets a record from another temp root completes |

## 12. The safe test harness

Every test of this work obeys these rules, which the brief's safety fences
also impose:

1. **A fake tree.** Each test creates its root with `fs.mkdtempSync` under its
   own `TMPDIR` and builds inside it: `home/` (as `HOME`), `home/.config`
   (`XDG_CONFIG_HOME`) with `delegatus/state` (`LLV_STATE_DIR`) and
   `delegatus/accounts/{claude,codex}/<id>`, `home/.cache` (`XDG_CACHE_HOME`),
   `home/.claude`, `home/.codex` (`LLV_CLAUDE_HOME`, `LLV_CODEX_HOME`,
   `CLAUDE_CONFIG_DIR`, `CODEX_HOME`), `home/.ssh`, `home/Projects/{a,b}`, a
   lane worktree, an own `tmp/`. The policy is computed by the production
   function against that environment. `LLV_VIEWER_CONTROL_URL` points at a
   closed port. One test file per command, through `gate-slot.sh`.
2. **A precondition before any destructive step.** Before anything that can
   delete runs, the test asserts that the realpath of every target it built
   lies inside its own root. A typo then fails the test before any process
   starts.
3. **Real top-level targets only through `evaluate`.** Refusal of `/..`,
   `/boot` or the real home is tested by calling the pure `evaluate` function,
   which reads the filesystem and cannot delete. No wrapper or engine is ever
   started with a target outside the fake tree.
4. **Recorders for the refusal matrix.** Wrapper refusal tests put a recording
   `rm` (records argv, deletes nothing) after the guard directory in `PATH`; if
   the guard admitted by mistake, the recorder shows it and nothing is lost.
   Real `rm` runs only on fake-tree targets: admitted worktree deletes, the
   performance test, and the incident test.
5. **Doubles never execute what they receive.** The incident test's stub runs
   a fixed command built from the fake root; no stub in this work runs text it
   was handed.
6. **Real engines, no credentials.** Native tests drive the installed `codex`
   and `claude` against a model stub on port 0, as
   `src/lib/agent/operatorQuestionPolicy.native.test.ts` and
   `src/lib/mcp/modelInput.native.test.ts` do. They skip when the binary is
   absent and run in the native Codex gate on each pin bump, which re-checks the
   trust format.
7. **No installs into real homes.** Installation tests pass fake homes
   explicitly; the startup installer's ownership fence (6.5) keeps a test from
   reaching the operator's.
8. **Never against a base.** No test of this work is run against an earlier
   version of the code it covers.

The implementation also binds `LLV_GATE_TEMP_ROOT` to each check's private
`TMPDIR`. This explicit binding survives router children that need a production
`NODE_ENV`; inheriting `TMPDIR` alone still leaves the normal gate default
unchanged. The fake runner binds its own command temp root. This keeps both
comparison sandboxes and their cleanup inside the test's created tree.

For repeated Bash calls, `BASH_ENV` parses the same admit-only `rm` wrapper
once. Its function keeps all working variables local, preserves the caller's
globbing option, and starts the real binary once per admitted call. Other
shells and nested executables continue through the PATH wrappers. Every call
still checks the current policy stamp before using an own-root fast path.

Test files (by path; none named after the issue):

| File | Covers |
| --- | --- |
| `src/lib/agent/destructiveGuard.policy.test.ts` | `evaluate` and the argument grammars: structural, home, ancestors, sealed, own roots inside sealed, symlinked parents and finals, trailing `/`, `..` behind links, `find -H/-L`, `mv` into sealed, `rsync` delete options, `--no-preserve-root`, globs, empty-expansion forms, `${X:?}`, fallback policy |
| `src/lib/agent/destructiveGuard.hook.test.ts` | the program in `hook` mode fed the recorded payload shapes of section 3 for both engines; deny JSON; internal-error admission plus journal line |
| `src/lib/agent/destructiveGuard.install.test.ts` | fake account homes for both engines (legacy, managed, managed with linked `config.toml`, a home behind a symlinked ancestor, a personal PreToolUse group present); install; drift cases: handler removed, command edited, trust hash wrong, trust key under the logical path, guard file bytes changed, guard file replaced by a symlink; each repaired by a launch-time verification; personal bytes preserved |
| `src/lib/agent/destructiveGuard.native.test.ts` | real CLIs: literal refusal for both engines; the incident shape for both engines; the Codex `app-server` path with thread-level hooks plus account `hooks.json`; a trusted account install runs exactly once per Bash call |
| `src/lib/agent/destructiveGuard.refusals.test.ts` | journal → lifecycle event, stage attempt record, Needs-you `refusal` row, delivered message, cursor resume after restart, rotation |
| `src/lib/agent/destructiveGuard.performance.test.ts`, `destructiveGuard.performanceSeparate.test.ts` | the budgets of section 9 |
| existing: `spawnPolicy.test.ts`, `codexAppServerHost.test.ts`, `scripts/gate-cache.test.ts`, `scripts/gateSandboxRecords.test.ts`, `scripts/gate-runner/remote*.test.ts`, the external relay conversation tests, the two browser drivers | the changed contracts |

The incident test, for each engine: the model stub issues one tool call,
`bash <fake root>/run-tests.sh`. That script builds
`PATH=<fake stub dir>:$PATH`, where the stub directory holds `ssh`, `docker`
and `rg`, and runs `ssh fake-host cleanup`; the `ssh` stub runs the fixed
command `bash -c "rm -rf '<fake home>/Projects/a/..'/*"`. Assertions: the hook
admitted the top-level call; the `rm` wrapper refused (stderr carries the
message, the journal carries one line with `layer: "wrapper"` and the parent
chain up to the engine); every file of `<fake home>/Projects/a` and
`<fake home>/Projects/b` still exists; the ingester, run in the test against
the fake state, produced the `destructive_refused` event and the Needs-you
`refusal` row for the test's registered conversation.

## 13. Slice 1: what this lane builds

1. `bin/destructive-guard.mjs` and `src/lib/agent/destructiveGuard.ts`: policy
   computation (5.2, 5.5, 5.6), guard directory publication and verification,
   `agentDestructiveGuardEnv`, account install and verification for both
   engines (6.3–6.5), startup install.
2. The four wrappers (7.5) and the login-shell probe extension (7.4).
3. Env composition at every site of 7.3, including the publication push, and
   the `checkEnvironment` pattern.
4. Hooks: Claude per-launch and account file; Codex account `hooks.json` with
   canonical trust, and the session-flag fallback without double runs.
5. Refusal ingest (8.2), the lifecycle event, the attempt record, the Needs-you
   `refusal` row with en/uk text and rendered evidence, the agent message.
6. Role texts (section 10).
7. The four audit fixes (section 11).
8. Tests (section 12).

Acceptance for slice 1, from the pinned specification:

| Pinned acceptance | Shown by |
| --- | --- |
| Incident shape refused at the nested layer for both engines, protected paths survive, refusal reaches the board record; fake tree, fake roots | `destructiveGuard.native.test.ts` incident cases (section 12) |
| The hook refuses literal destructive forms for both engines with the real JSON contract | `destructiveGuard.hook.test.ts` (recorded payloads) and the native literal cases |
| Hooks installed for every account; a launch re-installs a drifted hook | `destructiveGuard.install.test.ts`, plus the native case proving the installed trust is accepted |
| Ordinary worktree deletes keep working; 3 000 targets well under a second, measured and reported | admitted cases in the policy test; `destructiveGuard.performance.test.ts` and `destructiveGuard.performanceSeparate.test.ts` with the numbers in the stage report |
| Four findings fixed with focused tests | section 11 |
| Builder and reviewer role texts carry the item-7 rules | section 10, read in review |
| Project checks pass; the pre-push touched-tests selection shows zero new failures against main | the publication gate |

## 14. Successor slice: what the next lane builds

### 14.1 Mass-deletion stop (item 5)

- **Watcher.** A small process supervised by the runtime host, so it survives
  Viewer deploys, using inotify watches over the sealed entries of the highest
  value: the state directory (excluding `scratch/`), account homes and their
  credential files, the shared transcript store, the secrets entries. It counts
  deletions and renames-away of protected files per sliding window. It trips
  on a deletion of a credential file that no Delegatus-owned write announced,
  on a vanished `policy.json`, or on more than a set number of protected
  deletions in a short window (thresholds tuned by the lane against measured
  normal churn, e.g. transcript rotation).
- **Freeze.** Every agent scope: write `1` to `cgroup.freeze` of each agent's
  delegated cgroup (or `systemctl --user freeze <unit>`), which stops the whole
  tree at once, forks included; `SIGSTOP` to recorded process groups only
  where no cgroup exists. The Viewer, the runtime host, the watcher and the
  operator's own sessions sit outside agent scopes and keep running. Agent
  scopes come from `src/lib/runtime/cpuPlacement.ts`, the memory units of
  `agentMemory.ts` and the signal sandbox's delegated cgroups.
- **Alert.** Lifecycle event, a Needs-you row with a thaw action, and the
  existing high-signal path to the operator's phone. Thawing is the operator's
  act.
- **Acceptance.** In a fake tree with its own state and account homes, a
  stand-in agent process tree in its own transient scope deletes fake
  protected files: the watcher trips within one second of the first deletion
  past the threshold, every process of that scope is frozen (`cgroup.freeze`
  reads 1, process states `T`/frozen), no Viewer or runtime-host process is
  frozen, the alert row appears, and thaw resumes the tree. Deleting 10 000
  files inside own roots never trips.

### 14.2 Snapshots outside the agents' reach (item 6)

- **Source.** The existing `VACUUM INTO` generations
  (`src/lib/state/durability.ts`, `BACKUP_DIRECTORY` at `:46`), which today live
  inside the state directory and died with it in the incident, plus account
  credential files.
- **Destination.** The linked machine over the paired link
  (`docs/design/linked-installs.md`), or a location the operator provides that
  the agent user cannot write.
- **Cadence.** On change, at most every 15 minutes, a bounded number of
  generations, incremental in line with the linked-install performance rule.
- **Restore.** One documented command that writes the generations back and
  runs `integrity_check`.
- **Open decision for that lane (D1, operator's):** who can read credential
  snapshots on the receiving machine. Options: (a) encrypted with a key derived
  from an operator recovery passphrase, so the peer stores ciphertext it cannot
  read; (b) readable by the peer, which is the operator's own machine; (c)
  state databases only, credentials excluded, with re-login after a loss.
  Recommendation: (a). Also whether the operator's own secrets directory is
  included; recommendation: only on explicit opt-in.
- **Acceptance.** With fake state and fake credentials, a peer stub on port 0
  receives a bundle it cannot read under option (a); deleting the fake source
  tree and restoring yields byte-identical databases that pass
  `integrity_check`, and the credential files back.

### 14.3 Preload library

- **What.** A shared object that wraps `unlink`, `unlinkat`, `rmdir`,
  `rename`, `renameat` and `renameat2` and applies the policy (loaded once from
  a compact form of `policy.json` and the own-roots variable) for dynamically
  linked children: Python's `shutil.rmtree`, Node's and Bun's `fs.rm`,
  coreutils called by absolute path, children that replace `PATH`.
- **Why a slice of its own.** Claude re-applies `settings.env` to its own
  process (`spawnPolicy.ts:537`), so `LD_PRELOAD` there would also load into
  the Claude CLI, which deletes and renames its own files inside its account
  home, a sealed entry; the library must exempt the engine process or be set
  only for tool children. Codex's `shell_environment_policy` reaches only exec
  tools, which suits it. It also needs a prebuilt object per architecture and C
  library, a per-call cost check (a cache of verdicts per parent directory),
  and Linux only (macOS restricts `DYLD_INSERT_LIBRARIES` for system binaries).
  None of that is small enough to ride in slice 1.
- **Acceptance.** The issue comment's cases, in the fake tree: `rm` by absolute
  path, a child that resets `PATH` while keeping the environment, Python
  `shutil.rmtree` and Node `fs.rmSync` against a fake protected root are
  refused and journaled; the engine processes themselves keep working;
  `rm -rf node_modules` of 50 000 files inside a worktree slows by at most 30 %.

### 14.4 The gate runner host

The remote gate runner (`docs/design/remote-gate-runner.md`) runs the same
agent-written tests on another host, and that host need not run Delegatus.
The successor ships the guard program and wrappers in the run upload
(`client.ts:870-871`) and prepends them in `serve.ts`'s command environment
with a runner-side policy: the runner home path-only, `~/mirror`, every
`~/runs/*` except the run's own, `~/.ssh` sealed. Acceptance through the
corrected harness of section 11: a run whose test deletes another run's
directory is refused and the directory survives.

## 15. Paths no layer covers

- A child started with an empty environment (`env -i`), a static binary, or
  `sudo`: neither the wrappers nor the preload reach it. The mass-deletion stop
  and the snapshots limit the damage.
- In slice 1, deletion through language runtimes (`shutil.rmtree`, `fs.rm`)
  and `rm` by absolute path: the preload covers them in the successor slice.
- A command sent over real `ssh` to another host: covered there only when that
  host runs Delegatus (or is the gate runner, 14.4), and by the script's own
  validation.
- An agent that deliberately goes around the guard (section 1, threat model).
- Deletes from engine-native tools other than Bash (`apply_patch` file
  deletion): out of scope (section 16).

## 16. Deferred — not currently justified

- A settings screen for the operator's protected list; the state file of 5.5
  is enough until the operator asks for one, and no existing control fits.
- Wrappers for `truncate`, `shred`, `unlink`, `rmdir`, `dd` and `cp` over a
  file: the hook checks their literal forms; the incident's shape was a
  recursive `rm`, and the preload covers `unlink` and `rmdir` in the successor.
- Protecting other agents' directories under `/tmp`: their stage scratch is in
  sealed state already; nothing in the incident touched `/tmp`.
- A matcher for Codex `apply_patch` deletions and Claude's `Write` over sealed
  files.
- Folding the process-cleanup hook into the guard program: it works today and
  the merge would change a tested surface for no new protection.
- Propagating refusal rows to linked boards: each machine's board shows its own.
- Read-only bind mounts of sealed paths in the signal sandbox's mount
  namespace: the engines write their own account homes (credential refresh,
  transcripts) and stage scratch lives in state, so the binds would need the
  very carve-outs that make a sandbox get in the way, which the operator
  rejected.
- Refusing a launch when the nested layer is off: the 2026-10-20 decision
  stands; the launch reports it.
- Windows support for the wrappers.

## 17. Validation against the requirement

| Requirement element | Where |
| --- | --- |
| No full sandbox; nothing else restricted | sections 1, 5.3, 16 (bind mounts rejected) |
| One protected-path policy, owned by Delegatus | section 5, one program for every layer (6.1) |
| PreToolUse hook for Claude and Codex with Codex 0.166's contract | sections 3, 6.2–6.4, observed on 0.166.0 and 2.1.325 |
| Installed and verified by Delegatus in every account on every machine | 6.3–6.5: startup install of every account, verification and repair at every launch, linked machines through their own Delegatus |
| Nested layer through the launch environment, wrappers first in `PATH` | section 7, every launch site and the publication push |
| Optional preload on unlink and rename | 14.3, with the reason it is a separate slice |
| Every refusal visible on the board, logged with conversation, command, cwd and parent chain, agent told to stop and ask | section 8 |
| Stop that freezes agent scopes when state files disappear | 14.1 |
| Snapshots to the linked machine | 14.2, with decision D1 for that lane |
| Role rules (doubles never execute; no base run for destructive code; reviewer P0) | section 10 |
| Four audit findings | section 11 |
| Safe tests on a fake tree | section 12 |
