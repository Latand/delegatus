# Rename to Delegatus: sliced plan with migration

Status: design. Slices 1, 3 and 4 are implemented; §12, §13 and §14 record
where the code on `main` differed from this plan and what each slice did
about it. Counted at `main`
7374c5d4 (2026-09-23); every count below comes from `git grep` on that tree
unless it says otherwise.

**Name claims, decided 2026-09-23 (supersedes the requirement below on these
points).** npm refused the unscoped name `delegatus` (403: too similar to the
existing package `delegates`), so the package is **`delegatus-cli`**, claimed
with a placeholder 0.0.0. The commands keep their names. No paid domain for
now and no new GitHub organisation: the repository stays under the owner's
personal account and is renamed there. §3 and §8 are updated to match.

## The requirement

The pinned task for this stage, verbatim. Two absolute local paths are
redacted to the lane they point at; nothing else is changed.

> Operator decision (2026-09-23): the product (today "Agent Log Viewer" /
> "Live Log Viewer" / repo live-log-viewer-next) is renamed Delegatus. Inputs:
> round 1 [round-1 lane worktree]/docs/brand/naming-study.md (§5 rename
> inventory and migration plan) and round 2 [round-2 lane
> worktree]/docs/brand/naming-round-2.md (decision at the top, checks in §5).
> Name claims (npm placeholder, delegatus.dev, a GitHub org such as
> delegatus-dev) are the operator's steps and are NOT done yet. Nothing in this
> stage may be pushed or published: the name must not appear publicly before it
> is claimed.
>
> Deliverable: docs/design/rename-delegatus.md, a concrete, sliced rename plan
> grounded in current main (count and list the real occurrences):
> 1. Identity continuity first: the project key (repo-<hash>) derives from the
>    git remote; renaming the GitHub repo must not fork this project's board,
>    tasks, seat, worktree grouping (see AGENTS.md worktree rules) or state.
>    Design the alias so old and new remotes map to the same project, and say
>    exactly where it lives.
> 2. Package and CLI: npm package `delegatus`, bins `delegatus` and `dlg`, old
>    bins (`agent-log-viewer`, etc.) kept as shims that print a one-line
>    notice. Check `dlg` for clashes you can observe.
> 3. Config dir: ~/.config/delegatus preferred, ~/.config/agent-log-viewer read
>    as fallback, with a one-time move plan that keeps running installs,
>    accounts, transcripts mirrors and the runtime-host socket working; no data
>    copy that doubles disk use.
> 4. Env: DELEGATUS_ prefix accepted alongside LLV_ for a deprecation period;
>    which wins when both are set.
> 5. UI and i18n (en, uk), README/docs, agent prompts and the orchestrator
>    mandate, MCP server name, skills (llv-conveyor etc.), Docker
>    image/compose/service names (next release), GitHub repo rename +
>    redirects, the npm deprecation of the old package.
> 6. Slices in merge order, each independently shippable and reversible, with
>    acceptance tests; slice 1 = the naming docs committed
>    (docs/brand/naming-study.md + naming-round-2.md, public-safe) + identity
>    alias + package/bins + config-dir precedence + env alias.
> 7. A checklist of operator steps (claims, repo rename timing) and when each
>    slice may be published relative to them.
> Public-safe document: no personal identifiers, hostnames or transcript
> quotes.

Source: the pinned specification of this pipeline's board task, written by
the project's orchestrator seat from the operator's decision of 2026-09-23.

**Prior work.** Transcript searches (project-scoped, then unscoped; phrasings
about renamed-repository aliases, config-dir moves, npm bin shims and env
prefix aliases) found only the two naming rounds and this lane's own spec.
The closest existing mechanism is the #1874 project succession
(`src/lib/projects/succession.ts`), which this plan extends. Its current
behaviour was checked against `main` (§2.1).

**Publication fence.** None of the naming branches is on `origin`, and no
issue or pull request mentions the new name (checked with `git ls-remote` and
`gh issue/pr list --search delegatus`). This document names Delegatus, so it
becomes public only when the name is claimed (§8).

---

## 1. Decisions at a glance

| Question | Decision | Where |
| --- | --- | --- |
| Project identity across the repo rename | Alias the old `repo-<hash>` to the new one when GitHub proves both names are the same repository (same numeric repository id). The alias goes in the existing `state/project-aliases.json`; a new per-machine ledger supplies the old remote string | §2 |
| Package | `delegatus-cli`; bins `delegatus` (first in the bin map), `dlg`, `delegatus-mcp`; `agent-log-viewer` and `agent-log-viewer-mcp` stay as shims that print one line on stderr | §3 |
| `dlg` | Ship it as a convenience alias. `/usr/bin/dlg` exists in Debian's `pccts`, and npm `dlg` is someone else's package, so docs never put `dlg` after a package runner | §3.2 |
| Config dir | New installs: `~/.config/delegatus`. Existing installs: the data stays where it is, `~/.config/delegatus` becomes a link to it, and the process keeps the spelling its recorded paths use | §4 |
| Env | `DELEGATUS_X` wins over `LLV_X` when both are set. It is folded into `LLV_X` and removed at each entry point, before the module graph loads | §5 |
| MCP server key | Stays `viewer`; the text agents read says Delegatus | §6.4 |
| Docker names | Recognize both names in one release, switch in the next | §6.6 |
| Old npm package | A final `agent-log-viewer` that forwards to `delegatus-cli`, then `npm deprecate` | §6.8 |

---

## 2. Identity continuity

### 2.1 How the key is minted, and what a rename does today

`projectIdentityFromRepositoryRoot` (`src/lib/projects/identity.ts:205`)
hashes the canonical `origin` remote: `repo-` plus the first 32 hex digits of
the SHA-256 of `host/owner/name`. Every store reads project keys through
`canonicalProject` (`src/lib/projects/aliases.ts:89`), which follows the alias
map in `state/project-aliases.json`.

GitHub redirects a renamed or transferred repository, so a checkout whose
`origin` still names the old repository keeps minting the old key. A new key
appears when a checkout's `origin` is updated, or when the repository is
cloned fresh on a machine that has state.

Current `main` handles that change in two places, and they disagree:

- **Succession (#1874)** refuses it. `projectSuccessionFor` moves only a
  path-derived key (`dir-…`, or a repository with no origin). AGENTS.md
  states the rule: "A remote that changes (renamed or re-pointed origin) is
  never aliased."
- **The durable-candidate pass** allows it. `durableProjectAliasCandidates`
  (`aliases.ts:197`) is run by every complete catalog scan
  (`src/lib/scanner/projectCatalog.ts:634`). It re-resolves the `repoDir` of
  each flow, pipeline and workflow record and aliases the recorded key to
  whatever the checkout resolves to now. I ran that function against an
  isolated state dir holding one pipeline record, then changed the checkout's
  `origin`:

  | `origin` after the change | Registration produced |
  | --- | --- |
  | same owner, new name (a rename) | old key → new key |
  | different owner, different repository (a fork) | old key → fork's key |

So on a machine with pipeline records, the rename happens to be absorbed
today, and a re-point to an unrelated repository is absorbed the same way,
with no evidence that the two remotes are one repository. On a machine where
the project has only a seat and conversations, nothing aliases, and the seat
stays under the old key while new pipelines get the new one. The rename has
to work by design, and it has to be the only kind of remote change that gets
aliased.

### 2.2 Options

| Option | Proof that the two remotes are one repository | Cost | Verdict |
| --- | --- | --- | --- |
| A. Keep relying on the durable pass | none | 0 | Rejected: it misses seat-only machines and also aliases forks |
| B. An operator command (`delegatus project renamed --from <url>`) on each machine | the operator's word | small code, one manual step per machine, forgotten on some machine | Rejected: a manual step on every machine, and the gap stays open until someone runs it |
| C. Ledger plus a forge check | GitHub answers the old name with the same numeric repository id as the new name | a small ledger file and two REST calls, once per rename | **Chosen** |

The forge check was verified against the live API. `gh api repos/joyent/node`
(a repository that was transferred) answers `200` with `id` 211666 and
`full_name` `nodejs/node-v0.x-archive`, which is the current repository. A
rename and a transfer both keep the id; a fork has its own id.

### 2.3 The design (option C)

**Where the alias lives.** In `state/project-aliases.json`, the same map
`canonicalProject` reads: one entry `repo-<old> → repo-<new>`, and
`displayNames[repo-<new>] = "delegatus"`. It is written by
`recordProjectSuccessions` (`succession.ts:99`), which already migrates the
board layout, publishes the alias and writes one `project_moved` lifecycle
line. The seat store, tasks, the board, account bindings, attention and the
scanner's grouping all read old keys through that map, so no stored record is
rewritten.

**What supplies the old remote.** The old key is a hash and cannot be reversed,
and GitHub publishes no list of a repository's former names. So each machine
records what it has already seen, in a new file `state/project-remotes.json`
(`{ "repo-<hash>": "github.com/<owner>/<name>" }`). The writer is a new
`recordProjectRemote(identity)` in `src/lib/projects/aliases.ts`, called where
identities are already resolved:

- the catalog scan, for each group's `projectRoot`;
- `durableProjectAliasCandidates`, for each record whose checkout still
  resolves to its recorded key. This fills the ledger from existing pipelines
  on the first scan;
- `currentIdentity` in `succession.ts` (seat tick boot and sweep, designation).

It writes only when an entry is missing or has changed, using the same
temp-file-and-rename write as `persistProjectAliases`.

**The recognizer.** A new `src/lib/projects/forgeRename.ts`:

1. Candidates are `(oldKey, folder)` pairs where the old key is a remote
   repository id and the folder now resolves to a different remote id. They
   come from two places: the catalog's one-cwd-two-keys signal (the same one
   #1874 uses, `projectCatalog.ts:664`), and remote-to-remote registrations,
   which `durableProjectAliasCandidates` stops returning (§2.4).
2. Look up the old key in the ledger. No entry means no alias, which is why
   operator step O5 comes before the rename.
3. Both remotes must be on `github.com`. Other forges are deferred.
4. Ask GitHub `repos/<old owner>/<old name>` and
   `repos/<new owner>/<new name>`. Use `gh api` when `gh` is on `PATH` and
   authenticated (this covers private repositories), otherwise an
   unauthenticated REST `fetch`, which is enough for a public repository
   like this one. Equal `id` means a proven rename. Different ids, or a `404`
   for the old name, means refused. A network error means no decision yet,
   and the next scan asks again.
5. A proven pair becomes a `ProjectSuccession { source: old, target: new }`
   passed to `recordProjectSuccessions`. The call runs as a detached promise
   after the scan's persist phase and never under a pipeline lease (the
   network rule in AGENTS.md). Results are memoized per process, so each pair
   costs at most two requests per boot.

**Worktree grouping.** The recognizers in `projectInfoFromCwd` find the
parent repository by path and folder name (`.claude/worktrees`, `worktrees/`,
`~/.codex/worktrees/<hash>/<Repo>`, Claude-encoded cwds), and
`state/worktree-map.json` stores repository paths. None of that
depends on the remote name. A live or deleted worktree resolves to the parent
checkout, then to whatever key that checkout mints now, then through the
alias. The checkout folder keeps its name (renaming it is deferred), so
`<checkout>-pipeline-<id>` lane folders are unchanged.

**The release's own project.** `viewerOwnProject` (`src/lib/mcp/bindings.ts:751`)
and `viewerProject` (`src/lib/state/durability.ts:1023`) derive the Viewer's
own key from `LLV_VIEWER_CANONICAL_REMOTE` or `package.json`
`repository.url`, then fold it through the aliases. If the remote strings
change before the alias exists, `deploy_exact_sha` refuses the product's own
deploy (seat key ≠ release key). The remote strings therefore move in
slice 4, and only after the alias is confirmed on each deploying machine.
They are `package.json:82`, the `LLV_VIEWER_CANONICAL_REMOTE` defaults in
`scripts/bootstrap-runtime-host.ts:62`, `scripts/deploy-staging.ts:286`,
`scripts/rebuild.sh:11` and `scripts/runtime-host-viewer-adapter.ts:112`, and
the links in `src/components/onboarding/TourStep.tsx:25`, `VoiceStep.tsx:37`
and `scripts/demo-motion.ts:287`.

### 2.4 The one behaviour change

`durableProjectAliasCandidates` stops registering an alias when both source
and target are remote repository ids. It hands the pair to the recognizer
instead. This removes the unproven fork aliasing shown in §2.1. It changes
nothing for path-derived sources, which is what that pass was built for. It
also makes AGENTS.md's worktree section true, amended to say "a remote change
is aliased only when the forge proves a rename". The unproven fork aliasing
exists on `main` today independently of this rename. It should get its own
issue now (§10).

---

## 3. Package and CLI

### 3.1 What exists

`package.json`: `"name": "agent-log-viewer"` (1.2.2); bins `agent-log-viewer`
→ `bin/cli.mjs` and `agent-log-viewer-mcp` → `bin/mcp-server.mjs`. The CLI's
usage text and messages name the old bin 10 times in `bin/cli.mjs` (en and
uk), plus the banner `✳ Agent Log Viewer` at `bin/cli.mjs:731`. The publish
workflow's smoke check expects `Usage: agent-log-viewer`
(`.github/workflows/publish.yml:235`). `scripts/install-mcp.sh` registers
the MCP launcher by absolute path under the name `viewer`, and skips any
config that already has a `viewer` entry.

### 3.2 `dlg` clash check (2026-09-23)

| Where | Result |
| --- | --- |
| This machine (`command -v dlg`) | not found |
| Homebrew formula and cask `dlg` | `404` for both |
| Arch official repositories, package-name search | 0 results (the file index was not checked) |
| Debian stable, file search `usr/bin/dlg` | **present**: shipped by `pccts` (DLG, the lexer generator of PCCTS, the predecessor of ANTLR) |
| npm package `dlg` | **exists**: 1.0.0, an empty test package from another publisher, with no bin |

What follows from this:

- `delegatus` is the canonical bin, and every doc and message uses it.
  `dlg` is a typing shortcut. On a Debian machine with `pccts` installed,
  whichever directory comes first in `PATH` decides which `dlg` runs. The
  README says so in one line.
- Docs never put `dlg` after `bunx` or `npx`: a package runner resolves it
  as the npm package `dlg`, which belongs to a stranger. The install is
  `npm i -g delegatus-cli`, the one-shot form is `bunx delegatus-cli`, and
  the command after either is `delegatus`.

### 3.3 Bins after slice 1

The package is `delegatus-cli` (npm refused `delegatus`, see Status). None of
its bins is named after it, so the order of the bin map matters:

- **`bunx delegatus-cli` runs the first bin.** Observed on Bun 1.4.0 against
  a local registry: a package whose bin map is `zeta`, `alpha`, `mcp` ran
  `zeta` (not the alphabetically first), and a package named `delegatus-cli`
  with this bin map ran `delegatus` with the arguments passed through
  (`bunx delegatus-cli --port 9000`). `bunx typescript` from the public
  registry runs `tsc` the same way. So `delegatus` stays first in the map and
  no `delegatus-cli` bin alias is needed; the package smoke asserts the
  order.
- `npx delegatus-cli` is not a documented form: npm's runner does not pick
  among several bins when none matches the package name.

| Bin | Target | Behaviour |
| --- | --- | --- |
| `delegatus` | `bin/cli.mjs` | the CLI |
| `dlg` | `bin/cli.mjs` | same CLI |
| `delegatus-mcp` | `bin/mcp-server.mjs` | the MCP launcher |
| `agent-log-viewer` | `bin/legacy-cli.mjs` | prints `agent-log-viewer is now delegatus; this command keeps working.` on **stderr**, then runs the CLI with the same argv |
| `agent-log-viewer-mcp` | `bin/legacy-mcp-server.mjs` | the same notice on **stderr** only, then the launcher. stdout is the MCP protocol channel, so a byte written there breaks every client that registered the old command |

Existing MCP registrations keep working. They point at an absolute launcher
path, and the launcher (`bin/mcp-server.mjs`) loads the active release's
managed MCP runtime from `viewer-release.json` whatever its own location. A
registration left on an old install's path keeps loading current code while
that file exists. `install-mcp.sh` is changed to repoint a `viewer` entry
whose command runs an `agent-log-viewer` package path, and still to leave
every other existing entry alone.

The old bin names have no removal date. Each costs one file, and old agent
configs, memories and scripts call them.

---

## 4. Config directory

### 4.1 What an existing install holds

The directory is computed in `src/lib/configDir.ts` (`APP_DIR =
"agent-log-viewer"`, with `live-log-viewer` as a fallback for config files)
and again, independently, in 21 other production files: `bin/mcp-server.mjs`,
`bin/provision-telegram-connector.mjs`, `bin/self-update-supervisor.mjs`
(cache), `bin/server-runtime.mjs`, `bin/tailscale.mjs`, `docker-compose.yml`
(5 lines), `scripts/bootstrap-runtime-host.ts`, `scripts/deploy-staging.ts`,
`scripts/install-mcp.sh`, `scripts/runtime-host-healthcheck.ts`,
`scripts/runtime-host-viewer-adapter.ts`, `scripts/transcript-search-bench.ts`,
`src/lib/access/phoneAccessBootGate.ts`, `src/lib/agent/spawnPolicy.ts`,
`src/lib/mcp/controlEndpoint.ts`, `src/lib/reviewHistory/archiveArtifacts.ts`,
`src/lib/reviewHistory/reader.ts`, `src/lib/runtime/agentConfigSandbox.ts`,
`src/lib/state/stateMutationBarrier.ts`, `src/lib/stateOwnership.ts` and
`src/runtime-host/stagingContainer.ts`. Capture and demo drivers build their
own sandbox homes and are left out of that count.

A long-running install was measured read-only, in aggregate:

- The `state/` directory is about 42 GB.
- About 540,000 occurrences of the absolute config-dir prefix are recorded in
  its stores: the transcript-search index about 386,000, the agent registry
  about 60,000, the runtime journal about 26,000, `state.sqlite` about
  21,000, MCP receipts about 23,000, and the rest in about 25 JSON stores.
- Account homes link into the shared transcript store (`shared/claude/…`)
  through **absolute** symlinks.
- The runtime-host socket, the journal and the deploy target are passed to
  the runtime host as absolute paths (`docker-compose.yml:58–71`).
- The config dir and its parent are on the same filesystem.

Registry lookups compare transcript paths as strings. If new code resolved
the directory under a different spelling, every recorded conversation would
stop matching the file the scanner finds, and it would lose its identity. A
copy would double 42 GB. A move-and-rewrite would have to rewrite 540,000
strings in live SQLite stores while agents are writing to them.

### 4.2 The one-time move: move the name, keep the data where it is

**Precedence**, in one resolver `bin/appDir.mjs`. It is plain ESM, so
`bin/*.mjs`, the TypeScript sources and the shell entry points (through a
one-line `bun -e`) all read the same answer.

1. `LLV_STATE_DIR` / `DELEGATUS_STATE_DIR` still override the state dir, as
   today (§5 says which wins).
2. `<config>/delegatus` is a real directory → use `<config>/delegatus`. This
   is a new install. If a real `<config>/agent-log-viewer` also exists, log
   one line naming it: two real directories mean two installs, and the new
   name wins.
3. `<config>/agent-log-viewer` exists → use it, spelled
   `<config>/agent-log-viewer`, because that is the spelling every recorded
   path uses. This is an existing install. `<config>/delegatus` exists here
   only as the link from step 4, so it is not "a real directory".
4. The one-time step, for an existing install with no `<config>/delegatus`:
   create `<config>/delegatus` as a symlink to `agent-log-viewer` (relative
   target, one `symlink(2)`, no copy). It is a state-mutating startup step,
   so it goes through `assertStateStartupMutation`: only `viewer` and
   `runtime-host` perform it against the operator's directories, as with
   every migration since #1905.
5. Neither exists → create `<config>/delegatus`.
6. `<config>/live-log-viewer` stays a read fallback for config files, exactly
   as `configFilePath` does today.

The cache dir (`~/.cache/agent-log-viewer`: the whisper venv and
self-update releases) follows the same rule under `XDG_CACHE_HOME`.

After step 4, the name users see and docs print is `~/.config/delegatus`.
Every file is reachable through it, and nothing was copied or moved.

| Must keep working | Why it does |
| --- | --- |
| Running installs | Nothing is renamed on disk. Processes started before the upgrade keep their paths, and processes started after it resolve the same spelling (step 3) |
| Accounts | Account homes stay at `…/agent-log-viewer/accounts/…`. `CLAUDE_CONFIG_DIR`/`CODEX_HOME` values and the recorded account roots are unchanged |
| Transcript mirrors | The absolute symlinks into `shared/` keep resolving, and `realpath` of any recorded path still returns the recorded spelling. The resolver never introduces a second spelling, so the realpath-vs-string comparisons in `src/lib/accounts/claude.ts`, `codex.ts` and `migration/provider.ts` see what they see today |
| Runtime-host socket | Same path, same inode. `LLV_RUNTIME_HOST_SOCKET` keeps its value. Through the link the path is shorter, which only helps the 108-byte `sun_path` limit |
| Docker | Compose bind-mounts all of `$HOME`, so the link resolves identically inside the container |

**Must land in the same slice:** `operatorOwnedRoots`
(`src/lib/stateOwnership.ts`) and `CONFIG_APP_DIRS`
(`src/lib/state/stateMutationBarrier.ts:88`) must list `delegatus`.
Otherwise a lane's `bun run build` could resolve `~/.config/delegatus` as an
unguarded directory, which is the #1905 incident with a new name.

**Reversal.** Remove the symlink. Nothing else changed on disk.

A physical move of the data into a directory named `delegatus` is a separate
operation, and §9 explains why it is not planned.

---

## 5. Environment prefix

`LLV_` is 255 distinct names across 617 tracked files. Of those, 159 are read
as `process.env.LLV_*` / `env.LLV_*` in non-test code, 7 are documented in the
README, 20 appear in `docker-compose.yml` and 3 in the `Dockerfile`.
Internal code keeps reading `LLV_`, and nothing is renamed inside it.

**Rule, applied once per process.** A module `bin/envAlias.mjs` goes through
`process.env`. For every `DELEGATUS_X`:

- if `LLV_X` is unset or equal, set `LLV_X` to the value;
- if `LLV_X` is set and differs, **`DELEGATUS_X` wins**: set `LLV_X` to it and
  print one stderr line per process naming both variables. The line carries
  the names alone, because some values are credentials;
- then delete `DELEGATUS_X`.

**Why the new name wins.** The new prefix is the documented one, so an
operator who adds a `DELEGATUS_` line next to a stale `LLV_` line means the
new value.

**Why it is deleted after folding.** The Viewer writes `LLV_` names into
children's environments on purpose. `withAgentConfigSandbox` sets
`LLV_STATE_DIR` to a sandbox (`src/lib/runtime/agentConfigSandbox.ts:92`), and
`viewerMcpServerEnv` pins the real one for the MCP link
(`src/lib/agent/spawnPolicy.ts:63`). If an inherited `DELEGATUS_STATE_DIR`
reached a spawned agent's own entry point, the "new name wins" rule would put
that agent back on the operator's live state. Folding and deleting at the
root means children only ever see `LLV_`, so the sandbox holds.

**Where it runs.** It must run before the module graph loads, for the same
reason `LLV_STATE_OWNER` must (AGENTS.md, "The claim has to run before the
entry point's own imports"). It is the first import in `bin/cli.mjs`,
`bin/mcp-server.mjs`, `bin/self-update-supervisor.mjs`, `bin/tailscale.mjs`,
`bin/provision-telegram-connector.mjs`, `src/lib/mcp/entry.ts` and the
`src/lib/state/owner/*` side-effect modules. It runs as a body statement
ahead of the first `await import` in `src/runtime-host/main.ts`, and at the
top of `src/instrumentation.ts` and `next.config.ts` (which reads
`LLV_STANDALONE` and `LLV_DEV_ORIGINS` at build time). Shell entry points
(`scripts/rebuild.sh`, `scripts/install-mcp.sh`, `scripts/setup-whisper.sh`)
get the same rule inline: `LLV_X="${DELEGATUS_X:-${LLV_X:-}}"`. Compose's own
interpolation variables (`LLV_UID`, `LLV_GID`, `LLV_DOCKER_GID`,
`LLV_ENV_FILE`, …) take the form `${DELEGATUS_UID:-${LLV_UID:-1000}}` in
slice 3.

**Deprecation period.** `LLV_` stays accepted through at least two minor
releases and 90 days after the release that ships slice 1. The README
documents only `DELEGATUS_`, with one line saying the old prefix still works.
Removing `LLV_` acceptance is a separate decision with its own issue. It costs
one pass over the environment at boot, so nothing pushes for removal.

---

## 6. Everything else that carries the name

### 6.1 Inventory (counted at 7374c5d4)

| Surface | Occurrences |
| --- | --- |
| `agent-log-viewer` (any case) | 511 in 162 files: 25 Markdown, 62 non-test code files |
| `live-log-viewer` (includes `-next` and `-orchestration`) | 318 in 96 files: 23 Markdown, 27 non-test code files |
| `Agent Log Viewer` | 57 in 33 files: 13 Markdown, 15 non-test code files |
| `Live Log Viewer` | 19 in 3 files |
| Markdown files naming any old name | 39, `README.md` 11 times; `CHANGELOG.md` keeps history as written |
| Product-name UI strings | `onboarding.title`, `onboarding.tour.heading`, `selfUpdate.unsupported.no-launcher`, `selfUpdate.unsupported.not-a-checkout` in `en.ts` and `uk.ts` (8); `src/app/layout.tsx` title and description (2) |
| The noun "Viewer" | `en.ts` 61, `uk.ts` 60; MCP code (`src/lib/mcp/`) 119; orchestrator, pipeline and role prompts 66 (`src/lib/orchestrator/prompt.ts` 17, `src/lib/roles/defaults.ts` 9, `src/lib/pipelines/prompts.ts` 2, …); all non-test `src/` 1,075 |
| Orchestrator mandate | `src/lib/orchestrator/prompt.ts` names Agent Log Viewer 3 times (the retired `## Deploys` section it strips by exact match, and comments) and calls the seat "the viewer's built-in Manager" |
| MCP server | key `viewer` (`MCP_SERVER_NAME`, `src/lib/mcp/server.ts:44`); `isViewerMcpServer` also accepts `agent-log-viewer*` (`presentation.ts:26`); `mcp__viewer__` appears 27 times in 16 tracked files, and in every agent's allowlists, skills and memories outside the repo |
| MCP client names | `"agent-log-viewer"` in `src/lib/telegram/connector.ts:155`, `src/lib/telegram/reportSources.ts:377`; Codex app-server `clientInfo.name` in `src/lib/accounts/codexAppServer.ts:279` |
| Skills | `.claude/skills/live-log-viewer-orchestration` (named in 6 files), `.claude/skills/llv-conveyor` (named in 7 files) |
| Docker | compose `name: agent-log-viewer`; images `agent-log-viewer:node22` (3 references), `:deploy-<rev>-<key>` (`src/runtime-host/deploymentArtifacts.ts:13`), `:staging-<rev>` (`stagingContainer.ts:50`), `:hostboot-<rev>` (`scripts/bootstrap-runtime-host.ts:187`); containers `llv-runtime-host-<rev>-<gen>` (`hostSuccessor.ts:99`), `llv-deploy-<key>` (`deploymentArtifacts.ts:9`), `llv-staging-viewer`, `llv-staging-runtime-host` |
| systemd (legacy) | retired; the CLI's migration notice names the old unit files (`docs/docker.md`, "Moving off the systemd install") |
| Browser storage | 25 distinct `llv:*` / `llvAgent*` / `llv_auth` key literals in non-test `src/` |
| External ids | WakaTime entities `agent-log-viewer/<engine>/…` (`src/lib/wakatime/sync.ts:331`) |
| Canonical remote | `package.json:82` and the 4 script defaults listed in §2.3 |

### 6.2 UI and i18n (en, uk)

Change the 10 product-name strings. Then go through the 61 + 60 "Viewer"
uses in `en.ts` / `uk.ts` one by one: those that name the product ("This
Viewer was installed as a package") become Delegatus, and those naming a UI
surface stay. Ukrainian keeps the Latin «Delegatus» (a brand, like the
current Latin "Viewer" in `uk.ts`). The page title becomes `Delegatus`.
Rendered evidence comes from the drivers that already exist (board geometry,
the phone driver), with no new capture script.

### 6.3 README, docs, prompts, the orchestrator mandate

- README and current guides (`docs/*.md` describing today's behaviour):
  rename. Design records, investigations and CHANGELOG entries are history
  and stay as written.
- Orchestrator prompt: "the viewer's built-in Manager" becomes "Delegatus's
  built-in Manager". Bump the prompt version. Stored mandates keep their
  bytes: delivery only removes text by exact match
  (`orchestratorMandateForDelivery`), and caller-edited mandates must
  survive. The old wording still names the `viewer` MCP server correctly, so
  nothing breaks. Keep `SHIPPED_DEPLOYS_SECTION` byte-for-byte: delivery
  matches it exactly against stored mandates.
- Role defaults and pipeline prompts: product noun → Delegatus.
- AGENTS.md: product name, plus the amended remote-change rule (§2.4).

### 6.4 MCP server name: keep `viewer`

Renaming the key changes every tool from `mcp__viewer__*` to a new prefix.
Permission allowlists in agent configs would stop matching, and tools would
prompt or be refused. Skills and memories that name `mcp__viewer__…` would
point at nothing. Registering both names would put the whole tool list
twice into every agent's context. The server `instructions` and tool
descriptions say "Delegatus" (slice 2), and the instructions say once that
the server's key is `viewer`. `isViewerMcpServer` keeps accepting
`agent-log-viewer*` and gains `delegatus*`, so a user who registers the
server under the new name still gets the rich tool presentation.

### 6.5 Skills

Rename `.claude/skills/live-log-viewer-orchestration` →
`delegatus-orchestration` and `llv-conveyor` → `delegatus-conveyor`. Leave
each old name as a stub `SKILL.md` of two lines pointing at the new one,
because prompts and memories load skills by name. `review-loop` keeps its
name. Copies installed outside the repo are reinstalled from it; the stubs
cover the gap.

### 6.6 Docker image, compose and container names (next release)

The runtime host that performs a deploy is running the previous release, and
it finds rollback targets and cleanup candidates by these names. So the
change takes two releases:

- **Slice 3 (recognize both).** Rollback, cleanup and succession accept
  image repositories `agent-log-viewer` and `delegatus`, and container
  prefixes `llv-runtime-host-`/`llv-deploy-` and
  `delegatus-runtime-host-`/`delegatus-deploy-`. `bootstrap-runtime-host.ts`
  and `rebuild.sh` compute the app dir with `bin/appDir.mjs` and export it
  as `DELEGATUS_CONFIG_DIR`. `docker-compose.yml` defaults read
  `${DELEGATUS_CONFIG_DIR:-${HOME}/.config/delegatus}`. For an existing
  install that exported value keeps the recorded spelling, so the socket,
  journal and deploy-target strings the runtime host receives do not change.
  No name changes in this slice.
- **Slice 5 (switch).** New images are tagged `delegatus:*`, and containers
  get the `delegatus-` prefixes. Compose `name:` becomes `delegatus`. Changing
  the compose project renames the runtime-host container and network, so a
  plain `docker compose up` would start a second host that crash-loops on
  8898. The switch therefore goes through bootstrap's release succession,
  like any change to what the host runs. `/opt/llv-whisper-venv` and the
  legacy systemd unit keep their names (§9).

Both slices are proven with `bun scripts/verify-runtime-host.ts` and the
`bun-runtime` CI job. Slice 5's rehearsal starts one generation per name and
drives a succession across the switch.

### 6.7 GitHub repository rename and redirects

The rename is the operator's step (§8, O6). GitHub redirects git and web
traffic from the old name for as long as no new repository takes that name,
so **the old name must never be reused under the same owner**. Existing
checkouts need no action. `git remote set-url` is optional and safe once the
alias is in place. The self-update check runs `git ls-remote` against the
canonical remote, and the redirect keeps it working until slice 4 moves the
string. npm trusted publishing is configured per package with owner,
repository and workflow file. It has to be updated for both packages when
the repository is renamed (O6). npm also validates `repository.url` against the
provenance statement, so slice 4 lands before the first publish after the
rename.

### 6.8 npm deprecation of `agent-log-viewer`

After `delegatus-cli` is published (slice 1), a final `agent-log-viewer`
release (slice 6) ships a package whose only dependency is `delegatus-cli` at
the same version. Its bins `agent-log-viewer` and `agent-log-viewer-mcp` print the
one-line notice and forward to the dependency's bins. Old
`bunx agent-log-viewer` and `bunx agent-log-viewer@latest` invocations, which
the current self-update copy in `en.ts`/`uk.ts` suggests, keep working and
land on current code. The operator then runs
`npm deprecate agent-log-viewer "Renamed to delegatus-cli: bunx delegatus-cli"`.

---

## 7. Slices in merge order

Every slice is a single pull request that can be reverted cleanly. Slices 1, 2
and 6 put the new name in public, so none of them merges before the npm claim
(O1).

### Slice 1: foundations

Contents:

1. `docs/brand/naming-study.md` and `docs/brand/naming-round-2.md`, copied
   from the two naming lanes. Round 2 refers to the operator as "he" twice
   (the requirement paragraph and §5); both become "they". The files contain
   no handle, path or hostname (checked with `grep`), and the privacy gate
   must pass on them.
2. Identity: the ledger `state/project-remotes.json`,
   `src/lib/projects/forgeRename.ts`, the §2.4 change to
   `durableProjectAliasCandidates`, and the amended AGENTS.md paragraph.
3. Package and bins: `name: "delegatus-cli"`, the bin map of §3.3, the two
   legacy shims, CLI usage and messages (en, uk), the `install-mcp.sh`
   repoint, and the publish smoke expecting `Usage: delegatus`.
4. Config dir: `bin/appDir.mjs`, the 22 files switched to it,
   `operatorOwnedRoots` and `CONFIG_APP_DIRS` extended, and the link step.
5. Env: `bin/envAlias.mjs` wired into every entry point in §5; the shell
   entry points' inline rule.

Acceptance tests (each run by path, under an isolated state dir):

- `src/lib/projects/succession.test.ts`: **a renamed repository keeps its
  board.** The ledger holds the old remote and a stubbed forge answers with
  equal ids. The alias is recorded once, the seat, tasks and board read
  under the new key, and one `project_moved` line is written. A replay
  records nothing.
- Same file: **a re-pointed fork does not merge.** A stubbed forge answers
  with different ids and no alias is written. This is the regression test
  for §2.1's probe.
- Same file: forge unreachable → no alias, and the next scan retries. No
  ledger entry → no alias.
- `src/lib/scanner/describe.test.ts`: **a deleted worktree of the renamed
  repository still groups under the one project**, for a nested worktree and
  for a `worktree-map.json` sibling.
- `src/lib/mcp/bindings` tests: with the alias recorded, `viewerOwnProject`
  equals the seat's project for both the old and the new remote string.
- `scripts/npm-package-smoke.test.ts`: all five bins run. `agent-log-viewer`
  prints the notice on stderr. `agent-log-viewer-mcp` writes zero bytes to
  stdout before the first protocol frame.
- `src/lib/configDir` tests: fresh home → `delegatus` real dir; existing home
  → link created, `stateDir()` keeps the `agent-log-viewer` spelling, and a
  transcript path recorded before the upgrade still matches the scanned one;
  both real → `delegatus` wins with one warning; a temp-root
  `XDG_CONFIG_HOME` is untouched; a `next build` phase is refused the link
  step.
- `src/lib/stateOwnership.entryPoints.test.ts`: every entry point under an
  operator-shaped home holding only `~/.config/delegatus`, and under one
  holding only `~/.config/agent-log-viewer`.
- Env: an entry point started with only `DELEGATUS_STATE_DIR` resolves it.
  With both set and different, `DELEGATUS_` wins and one warning names both
  variables. The child environment has no `DELEGATUS_` names. A sandboxed
  spawn keeps its sandbox `LLV_STATE_DIR` when the parent carried
  `DELEGATUS_STATE_DIR`.
- `bun scripts/verify-runtime-host.ts` with the app dir reached through the
  link. This rehearses the runtime host process as well as the Viewer (the
  `bun-runtime` job).

Reversal: revert the PR. The old bins, directory and prefix never stopped
working. The link and the ledger file can stay; nothing reads them after a
revert. The npm name `delegatus-cli` stays claimed (§8).

### Slice 2: the name in text

UI and i18n (§6.2), README and current docs (§6.3), orchestrator prompt with
a version bump, role defaults, pipeline prompts, MCP instructions and tool
descriptions (§6.4), and the skills rename with stubs (§6.5). It may ship in
the same release as slice 1.

Acceptance: i18n parity tests for `en`/`uk`; the orchestrator prompt tests,
including that `SHIPPED_DEPLOYS_SECTION` is still stripped from a stored v15
mandate; rendered evidence of onboarding and the page title on desktop and
phone from the existing drivers; the privacy gate.

Reversal: revert. Text only.

### Slice 3: Docker recognizes both names

§6.6 first half. Acceptance: `verify-runtime-host.ts` rehearsals with the
host started from an `agent-log-viewer:*` image, finding rollback and
cleanup targets named both ways; `rollback-runtime-host.test.ts`; the
`bun-runtime` job. Reversal: revert (nothing was renamed).

### Slice 4: remote strings (after the repository rename)

`package.json` `repository.url`, the four `LLV_VIEWER_CANONICAL_REMOTE`
defaults, onboarding and README links, and the demo card (§2.3). Merges only
when O7 has confirmed the alias on each deploying machine, and before the
next npm publish (provenance). Acceptance: the `viewerOwnProject` test from
slice 1 against the new default; `deploy_exact_sha` accepted for the
product's own seat in the MCP end-to-end harness; the self-update
`ls-remote` test against the new remote. Reversal: revert. The old URL still
redirects.

### Slice 5: Docker switches names

§6.6 second half, in a release after slice 3 is the running release.
Acceptance: the cross-name succession rehearsal; `verify-candidate` in
image. Reversal: roll back to the previous release, whose host recognizes
both names (slice 3).

### Slice 6: final `agent-log-viewer` package

A `packages/agent-log-viewer/` directory (a `package.json` whose one
dependency is `delegatus-cli`, and two forwarding bins), published by the same
workflow. Acceptance: the package smoke installs the tarball in a temp prefix
and runs both old bins through to `delegatus`. Reversal: publish a follow-up version. npm allows
unpublishing only under narrow conditions, so treat this as the one step
that only moves forward.

---

## 8. Operator checklist

| Step | What | Before it | Unblocks |
| --- | --- | --- | --- |
| O0 (recommended) | Trademark search for Delegatus, classes 9 and 42 (USPTO, EUIPO, Ukraine); round 2 left it undone | — | confidence before claims |
| O1 | Claim the npm package with a placeholder publish (this makes the name public), then configure its trusted publisher for this repository and `publish.yml`. **Claimed 2026-09-23 as `delegatus-cli`** (placeholder 0.0.0; npm refused `delegatus` as too similar to `delegates`). The trusted publisher has to be in place before the first release of slice 1 | O0 | slices 1, 2 may merge and publish |
| O2 | ~~Register `delegatus.dev`~~ Dropped 2026-09-23: no paid domain for now | — | — |
| O3 | ~~Create a GitHub org~~ Dropped 2026-09-23: the repository stays under the owner's personal account | — | — |
| O4 | ~~Confirm O1–O3~~ Dropped with O2 and O3: O1 alone gates slices 1 and 2 | — | — |
| O5 | Deploy the release with slice 1 on every machine that runs a Viewer for this project, and let one complete scan run. `state/project-remotes.json` lists this repository | slice 1 merged | O6 |
| O6 | Rename the GitHub repository under the owner's personal account. Never create a repository at the old name. Update npm trusted publishing for **both** packages to the new repository name | O5 | slice 4 |
| O7 | On each machine: the board shows one project named `delegatus`, and the lifecycle history has one `project_moved` line from the old key | O6 plus one scan | merge slice 4, then publish |
| O8 | Deploy slice 3 and let it run as the current release | slice 3 merged | merge slice 5 |
| O9 | After slice 6 publishes: `npm deprecate agent-log-viewer "Renamed to delegatus-cli: bunx delegatus-cli"` (needs the operator's npm login and 2FA) | slice 6 published | done |

When each slice may be **published** (merged to the public repository or
released to npm):

| Slice | Earliest |
| --- | --- |
| 1 | after O1 (the npm name is claimed; the seat merges) |
| 2 | after O1, with or after 1 |
| 3 | any time after 1; it names no new product string beyond what 1 made public |
| 4 | after O7 |
| 5 | after O8 |
| 6 | after 1 is on npm; O9 follows it |

---

## 9. Deferred: not currently justified

- **Physically moving existing data into `~/.config/delegatus`.** Nothing in
  the requirement needs the bytes to move, and moving them breaks what the
  requirement protects. A directory rename changes what `realpath` returns
  for every recorded path, and about 540,000 recorded paths would have to be
  rewritten inside live SQLite stores while agents write to them (§4.1).
  Swapping a real directory and a link in one atomic step would need
  `renameat2(RENAME_EXCHANGE)`, which Node and Bun do not expose. The swap
  would also have to happen while no link already points the other way,
  which the name-first step of §4.2 creates. If it is ever wanted, it becomes
  a maintenance-window command: stop agents, rewrite the recorded prefix
  store by store (rebuild the transcript-search index instead of rewriting
  it), swap by exchange, restart. It needs its own design.
- **Renaming the MCP server key `viewer`.** §6.4. Revisit only if the old word
  has to go everywhere. That means registering the new key, keeping `viewer`
  resolvable for one alias period, and migrating allowlists.
- **Renaming the 255 internal `LLV_` names.** The boundary fold (§5) gives
  users the new prefix, and an internal rename touches 617 files for no
  user-visible gain.
- **Browser storage keys and the `llv_auth` cookie, `llv-` temp and container
  prefixes other than the two in §6.6, WakaTime entities,
  `/opt/llv-whisper-venv`, the legacy systemd unit name.** They are invisible
  identifiers. Renaming them logs everyone out, resets saved layouts or
  duplicates data already sent elsewhere.
- **MCP client names and Codex `clientInfo.name`** (`agent-log-viewer`).
  They are invisible, and the Codex value may be recorded as the originator
  of threads the Viewer reads. Changing it needs a check of the Codex
  protocol first.
- **The 1,075 uses of "Viewer" in code comments and identifiers.** No user
  or agent reads them as the product name.
- **Renaming the local checkout folder.** Worktree lane folders and
  Claude-encoded project directories derive from it. It stays outside the
  rename.
- **Forge proof for hosts other than GitHub.** This project is on GitHub. A
  renamed GitLab or Gitea repository gets no alias and behaves as it does on
  `main`.
- **An explicit operator "renamed from" command** (option B in §2.2). Keep it
  in reserve for a machine that skipped O5; it is not needed on the planned
  path.

---

## 10. Found while grounding this plan

- **The durable alias pass merges a re-pointed remote without evidence**
  (§2.1). On `main` today, a checkout whose `origin` is re-pointed to a
  different repository gets the old key aliased to the new repository on
  the next complete scan. That contradicts AGENTS.md. This deserves its own
  issue now. The fix is §2.4, and it lands in slice 1 either way.

---

## 11. Validation against the requirement

| Requirement item | Where it is met |
| --- | --- |
| 1. Identity continuity; say where the alias lives | §2: `state/project-aliases.json` via `recordProjectSuccessions`, supplied by `state/project-remotes.json` and proven by GitHub's repository id; worktree grouping unchanged; the fork case refused |
| 2. Package `delegatus`, bins `delegatus`/`dlg`, old bins as one-line shims, `dlg` clash check | §3 |
| 3. `~/.config/delegatus` preferred, old dir as fallback, one-time move keeping installs, accounts, mirrors and the socket working, no doubling copy | §4. The one-time move moves the name (a link, no copy), and the precedence prefers a real `delegatus`. Moving the data itself is deferred in §9 with the numbers that rule it out |
| 4. `DELEGATUS_` alongside `LLV_`; which wins | §5: `DELEGATUS_` wins, folded and removed at the root |
| 5. UI/i18n, docs, prompts and mandate, MCP name, skills, Docker (next release), repo rename and redirects, npm deprecation | §6 |
| 6. Ordered, shippable, reversible slices with tests; slice 1 as specified | §7 |
| 7. Operator steps and publication timing | §8 |
| Public-safe | No handles, account names, hostnames, absolute home paths or transcript quotes; the GitHub owner appears as `<owner>`; install measurements are aggregates |

---

## 12. Slice 1: where the code on `main` differed from this plan

Slice 1 followed the code wherever the two disagreed:

- **npm name.** The package is `delegatus-cli`, not `delegatus` (Status, §3.3).
- **A second unproven alias path.** Besides `durableProjectAliasCandidates`,
  the catalog's own file migration (`migrationPlan` in
  `src/lib/scanner/projectCatalog.ts`) aliases a key when a transcript is
  re-described under a new one. A growing transcript keeps its head metadata
  in memory, but after a Viewer restart an old conversation that is still
  appended to is re-described under the checkout's current key, so a
  re-pointed fork was merged this way too. Slice 1 drops such a migration
  when both keys are remotes in the ledger and hands it to the forge, like
  the durable pass.
- **Where §2.4 applies in the durable pass.** The remote-to-remote check runs
  after the record-majority vote, so a repository id whose records point into
  a foreign checkout is still reported as a conflict, as before.
- **The stable MCP launcher.** `installStableLauncher` copies named files from
  `bin/`, so `appDir.mjs` and `envAlias.mjs` are published with
  `server-runtime.mjs`, before the launcher that imports them. Without that,
  every agent's MCP launcher would fail to load.
- **`docker-compose.yml` keeps its paths.** §4.1 counts it among the files
  that compute the app dir, and §6.6 moves it in slice 3. Slice 1 leaves it
  alone. On an existing install both spell `agent-log-viewer`. On a fresh
  Docker install, compose creates `agent-log-viewer/state` for the socket
  first, so the resolver keeps that spelling unless something created a real
  `~/.config/delegatus` before it. Slice 3 closes that gap with
  `DELEGATUS_CONFIG_DIR`.
- **Who makes the link.** The link step also passes the state-mutation
  barrier, which opens only in the serving Viewer's activation. In practice
  the Viewer makes the link, and the runtime host reads through whichever
  name exists.
- **The cache dir** follows the same precedence, and gets no link.
- **A spawned agent's sandbox** keeps its fixed `…/config/agent-log-viewer/state`.
  §4.1 lists `agentConfigSandbox.ts` among the files to switch, but that path
  is handed to the agent as `LLV_STATE_DIR` inside a throw-away root, and the
  module never probes the disk for what it hands over, so the resolver does
  not apply there.
- **Entry points.** `bin/tailscale.mjs` and `bin/self-update-supervisor.mjs`
  are modules the launcher imports, not entry points; they import
  `envAlias.mjs` first anyway. `src/instrumentation.ts` folds inside its
  Node.js branch, because that shim may reach nothing in the other compilers.
  `scripts/setup-whisper.sh` repeats the resolver's three rules inline, since
  it runs without Bun.
- **New install inbox paths.** The feed recognizes composer images under
  `delegatus/inbox/` as well as `agent-log-viewer/inbox/`.
- **Tests.** `src/lib/projects/succession.test.ts` did not exist and was
  created. `viewerOwnProject` is not exported, so it is tested through
  `productionDomainDependencies.viewerProject`.

---

## 13. Slice 3: where the code on `main` differed from this plan

- **Nothing found its targets by name.** §6.6 says the runtime host finds
  rollback targets and cleanup candidates by these names. It does not.
  Rollback reads the target and intent it recorded, handoff cleanup removes
  the predecessor by the id in the handoff intent, Viewer release cleanup
  lists containers by the `dev.live-log-viewer.managed` label, compose
  snapshots are keyed by a hash of the container name, and succession finds
  its predecessor by the fence owner's pid. Each already works under either
  spelling, so slice 3 changes none of them. What it adds is the proof, and one
  place for the names: `src/runtime-host/dockerNames.ts` holds both spellings,
  and every producer (`llv-deploy-`, `llv-runtime-host-`,
  `agent-log-viewer:deploy-`, `:staging-`, `:hostboot-`, `:node22`) reads it,
  so slice 5 changes one constant. The one real name filter was the running
  container check in `scripts/cutover-shared-claude-projects.ts`, which
  matched `llv-` only and now matches `delegatus-` too.
- **Networks.** Every Compose service uses `network_mode: host`, so Compose
  creates no project network, and a successor copies its predecessor's network
  mode. There is no network name to recognize.
- **`rebuild.sh` and the bootstrap run no Compose command.** `rebuild.sh`
  posts a revision to the running host, and the bootstrap stages a successor
  by cloning the predecessor container, so an exported `DELEGATUS_CONFIG_DIR`
  would reach nothing in either. Compose runs in two places. One is the
  operator's shell, where `docs/docker.md` exports the value printed by
  `scripts/app-config-dir.mjs`, which asks `bin/appDir.mjs`. The other is the
  nested `docker compose config` a deployment runs inside the runtime host.
  The host folds `DELEGATUS_` names into `LLV_` names at boot and deletes the
  originals (§5), so the runtime-host service passes the app dir on as
  `LLV_CONFIG_DIR`, and every default reads
  `${DELEGATUS_CONFIG_DIR:-${LLV_CONFIG_DIR:-${HOME}/.config/delegatus}}`.
  With the value exported, `docker compose config` renders every service
  exactly as before on an existing install, apart from the added
  `LLV_CONFIG_DIR`. A running host keeps the socket, journal, target and env
  file paths its own container was given, because each of them is passed on
  explicitly.
- **The rehearsal.** `verify-runtime-host.ts`, the `bun-runtime` job and the
  in-image gate in `verify-candidate` now rehearse a rollback across the two
  spellings. The first generation is named `delegatus-runtime-host-*` from a
  `delegatus:*` image. It completes a handoff and records an
  `llv-runtime-host-*` rollback target. The second generation is that
  retained one, started from an `agent-log-viewer:*` image as
  `rollback-runtime-host.ts --execute` starts it. It must stop the failed
  generation, take the fence, remove it, clear the rollback and never touch
  itself. Both generations reach Docker only through a stub on their PATH,
  which records every call. The host runs its deployment adapter through the
  adapter's `#!/usr/bin/env bun-container` line, so the rehearsal also links
  `bun-container` to the interpreter under test.

---

## 14. Slice 4: where the code differed from this plan

- **The alias is not a precondition.** GitHub renamed the repository on
  2026-09-23, but a checkout keeps minting the old key until its origin is
  re-pointed, and only then does the forge-proven alias join the keys. So
  that slice 4 can merge before O7, `src/lib/projects/viewerRepository.ts`
  gives the release's own identity both GitHub names: a remote naming
  Delegatus under either name yields the keys of both, and any other remote
  (a fork, a mirror) yields only its own. `deploy_exact_sha` accepts a seat
  under any of them. The incident card of `durability.ts` goes to whichever
  key this machine's `project-remotes.json` holds, the current name first.
  Once the alias exists, both keys fold into one and nothing changes.
- **Pipeline delivery is untouched.** It keys a delivery by the repository
  key its checkout minted, never by comparing URL strings, so a pipeline
  recorded under the old key keeps its owner, and its recorded push remote
  keeps working through the redirect.
- **`homepage` and `bugs`** were added to `package.json` beside
  `repository.url`, and the version moved to 1.3.0 for the first
  `delegatus-cli` release.
