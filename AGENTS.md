<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
# The product is Delegatus

This repository is Delegatus, called Agent Log Viewer before the rename
(`docs/design/rename-delegatus.md`). Text a person or an agent reads names it
Delegatus. In code, and in these notes, "the Viewer" still names the web server
process as distinct from the runtime host, and the MCP server keeps the key
`viewer`, so its tools stay `mcp__viewer__*`.

<!-- BEGIN:worktree-grouping -->
# Worktree → project grouping (canonical — do not re-break)

Agents run tasks inside **worktree checkouts**. Every session that runs from a
worktree MUST group in the sidebar under its **parent repo's** project — never
as its own lookalike project. This is one algorithm, enforced in
`src/lib/scanner/describe.ts` by `projectInfoFromCwd(cwd)`, which resolves the
parent repo by trying these recognizers in order:

The **pure path recognizers** run first — they need nothing on disk, so they
work identically for live and deleted checkouts:

1. `projectInfoFromClaudeTaskCwd` — Claude scratchpad descendants at
   `<tmp>/claude-<uid>/<encoded-cwd>/<session>/scratchpad/…`; dotted worktree
   containers survive in the encoded cwd and recover the parent project.
2. `worktreeFromPath` — Claude worktrees at `<repo>/.claude/worktrees/<name>/…`
3. `worktreeFromNested` — the `git worktree add worktrees/<name>` (and dotted
   `.worktrees/<name>`) convention: the checkout nests inside the repo, so the
   repo is the path prefix before the first `worktrees`/`.worktrees` segment;
   specialized `.claude`/`.codex` containers are left to #2/#4. The
   first container wins, so a worktree-of-a-worktree groups under the outermost repo.
4. `worktreeFromCodexPath` — Codex worktrees at `~/.codex/worktrees/<hash>/<Repo>`

Only then the **disk-dependent** resolvers, as fallbacks:

5. `worktreeFromGitFile` — any linked git worktree, resolved from its `.git`
   **file** (`gitdir:` pointer) — works **only while the checkout exists on
   disk**. Every live resolution here is written to a persistent map (below).
6. `worktreeFromMemory` — replays a `worktreeFromGitFile` resolution recorded
   (to `state/worktree-map.json`) while the checkout was alive. This is the only
   thing that saves an **arbitrary-path** `git worktree add ../sibling` checkout
   (e.g. `~/.agents/tools/live-log-viewer-<branch>`), which has NO recognizable
   path layout, once it is deleted. Consulted only when no path recognizer
   matched and the cwd is gone. Automatic recovery of older directory projects
   supplies the same lookup with atomic recovery rows in `state.sqlite`; those
   rows commit their mappings, aliases, board migration and lifecycle reason
   together. Recovery runs at Viewer startup under the release fence and after
   a complete catalog rescan. A recorded mapping, agreeing native repository
   hint or branch hint confirmed against refs must prove the match; a sibling
   name alone never folds, and conflicts or ambiguity keep the project separate.

**The invariant that keeps biting:** a worktree's grouping must survive the
checkout being **deleted**. Any mapping that finds the parent repo only by
reading on-disk git metadata (#5) silently fails afterward and the session
fragments into a phantom lookalike project (`-codex-worktrees-<hash>-<Repo>`,
`…-Projects-<Repo>-worktrees-<name>`, `…-<branch>`, …). Recognize each layout by
**path** (#1–#4) wherever the path reveals the repo; fall back to the persisted
resolution (#6) only for arbitrary sibling paths that cannot. Live and dead
checkouts of the same repo must resolve to the **same** project name.

When adding a new agent/worktree layout: prefer a pure path recognizer beside
#1–#4 and wire it into `projectInfoFromCwd`; only reach for the persisted map
when the path genuinely cannot name the repo. Add a "deleted worktree still
groups under its parent repo" case to `describe.test.ts`. Don't rely on the
checkout being present, and don't invent a second naming scheme.

**The same folder can change key over time.** A plain folder is `dir-<path>`, a
repository with no `origin` is `repo-<local path>`, and the same repository
once an origin is added is `repo-<remote>`. Anything recorded before the move
(an orchestrator seat, its tasks and conversations) keeps the old key while
new pipelines get the new one. `src/lib/projects/succession.ts` records that
move once as an alias in the same map `canonicalProject` reads, and only for a
path-derived source verified against the folder. It runs on scan, at seat tick
boot and sweep, and at designation. A remote change is aliased only when the
forge proves a rename: `src/lib/projects/forgeRename.ts` asks GitHub for the
old and the new name, and only the same numeric repository id joins them. The
old remote comes from `state/project-remotes.json`, which each machine fills
with the remote behind every repository key it resolves, because a key's hash
cannot be reversed. A re-pointed origin (a fork, an unrelated repository) is
never aliased, and neither is a remote this machine never recorded, because
every clone shares a remote id. Shared recorded GitHub remotes also check the forge's current full name once per key per 24 hours, so an unchanged clone origin canonicalizes only after matching numeric repository ids prove the rename.
<!-- END:worktree-grouping -->

<!-- BEGIN:live-state-and-publication -->
# Local hooks mirror the publication gate

Run `git config core.hooksPath .githooks` once per clone. Worktrees inherit
that config and run the hooks from their own checkout. Pre-commit runs staged
whitespace, privacy with the committed fingerprints, and eslint. Pre-push checks
commit publication, types, changed-file lint, touched tests, and scoped Linux,
pinned Bun runtime, native Codex and supply-chain gates. Tests and builds use
isolated state roots; heavy commands go through `scripts/gate-slot.sh`.
Touched tests run one file per process on head and on the merge base with
`origin/main`, each with fresh state, HOME and TMPDIR under the OS temp root.
Only new failures block; output lists pre-existing and fixed failures by file,
describe ancestry and test name, and retains between-tests errors. An incomplete
baseline blocks as a gate error and an incomplete head names its file and blocks,
unless both are broken the same way, which lists as pre-existing.
Baseline results are cached by commit, sorted file set, origin URL, Bun version, dependency
graph and execution environment under the private temp directory
`delegatus-test-baselines-<uid>` (32 entries, 4 MiB each, seven days). A SHA-256
digest covers each cached baseline payload; missing or mismatched integrity
rebuilds the baseline. Local dependencies, including relative directory paths
and Bun lockfile directory resolutions, install independently in the baseline.
Cache versions invalidate results from earlier dependency isolation rules.
Deleting that cache is safe. Both runs report elapsed
time; a warm baseline needs no checkout or test rerun. Budgets are five minutes per file and fifteen minutes
per baseline/head test run. Privacy, types and ESLint retain their own checks.
A push with no changed file against the merge base runs privacy with
`--check-commits` and nothing else; a prose-only push (`.md`, `.mdx`, `.txt`)
skips types; scoped Linux tests are compared against the merge base like touched
tests. A pipeline's publication runs this hook without the Viewer's own
settings (`pipelinePublicationHookEnv`): on 2026-10-04 the Viewer's `LLV_LANG`
reached a CLI test through the hook and parked five lanes that had changed
nothing. A refused publication of an unchanged head retries after 1, 5 and 15
minutes, then parks with the cause on its first line. A push that was
interrupted before it reached the remote (a signal, its time limit, a stopped
Viewer) is counted the same way, whatever the stage changed.
`LLV_SKIP_HOOKS=1` is the escape hatch for a false positive. Pre-push warns if
the branch is behind `origin/main`. Missing local media tools defer named media
files to the required CI OCR gate. See CONTRIBUTING.md for slot settings.

# Two ways to do real damage here (both happened, 2026-07-24)

## Never run this repo's suites against the operator's live state

`bun test src/lib/agent/ src/app/api/runtime/` and anything else that sweeps
whole runtime/registry directories exercises host lifecycle code against the
**shared** registry under `$XDG_CONFIG_HOME/agent-log-viewer/state`. Running it
on the operator's machine killed the structured host that owned the session the
operator was talking to. Their composer started answering `structured host
ownership is unavailable` and they had to recover the conversation by pasting an
attach command into a terminal.

Run the specific test files you touched, by path. If a change genuinely needs a
broad sweep, point the run at an isolated state directory first and say so; do
not sweep the live one. The same applies to any command that enumerates and acts
on runtime processes — `pgrep -f <pattern>` matches your own command line too.

## This repository is public — publication surfaces carry no identities

Docs, issues, PR bodies, commit messages, fixtures, and test data are public the
moment they are pushed. Never put an account handle, email, account id, token,
or absolute home path into any of them, including evidence tables pasted from a
live investigation. Distinguish accounts as "account A / account B" with their
plan tier, and keep paths repo-relative or `$HOME`-relative.

One exemption, and only in a trailer: a `Co-Authored-By:` / `Signed-Off-By:`
whose address has the local part exactly `noreply` or `no-reply` names a tool
and identifies nobody, so agent attribution stays and the gate passes it
(`MACHINE_ATTRIBUTION_TRAILER`). It is the standing attribution trailer on
agent-written commits here — do not strip it, from your own commit or anyone
else's. The exemption is that narrow on purpose: a GitHub `users.noreply`
address reads as a no-reply address and is an account handle with a number in
front of it, and the same address written into prose is not attribution, so
both are still violations.

The identity git records on a commit is read by a separate rule. A squash merge
composes those identities into a `Co-authored-by:` trailer on the default
branch, and there an address on the `users.noreply` host of the forge passes:
the forge issues it so an account's own address is not what its commits carry.
That reading is the merge boundary only — it changes nothing about what you may
write into a message, a doc or a fixture, where the paragraph above still holds.

`privacy-publication` on CI uses the committed
`scripts/privacy-known-value-fingerprints.json` from its trusted checkout.
The local hooks use the same fingerprints with `--require-known-values`.
The required CI checks stay as enforcement for skipped hooks and media OCR.
Scrub before the push, and re-read every table and quote lifted out of logs.
<!-- END:live-state-and-publication -->

<!-- BEGIN:runtime-host-verification -->
# Two processes run under Bun here, and only one of them was ever checked

The Viewer and the **runtime host** (`src/runtime-host/`) both run under the
Bun pinned in the `Dockerfile`. The runtime host owns the stable listener and
performs the release succession, so when it crash-loops, that is an outage no
Viewer health check can see. Moving the pin to 1.4.0 was verified thoroughly
and only on the Viewer; the host had never been started under the new runtime
when it was promoted, and it died on its first failing socket write (#1254).

**A change to a Bun pin is not verified until the runtime host has run under
it.** Before such a change is proposed for promotion, run:

```
bun scripts/verify-runtime-host.ts --runtime <the bun binary being pinned>
```

It starts two runtime-host generations under that interpreter, drives one
singleton-fence succession, and holds both endpoints the succession handed
over while peers come and go — in a private state directory on an ephemeral
port, never the stable one. Half the callers walk away mid-answer without
reading a byte of a snapshot-sized reply, which is the write that took
production down: run against the host as it was, the rehearsal kills it
within a second under 1.4.0 and passes under 1.3.3, exactly as the incident
did. The same rehearsal runs inside a container built from the candidate image
during `verify-candidate`, so a candidate whose host cannot boot, cannot take
the fence, or cannot hold what it took is refused before promotion rather than
after.

**Both halves run on scoped pre-push and by CI dispatch** under the pin read
from the Dockerfile. `scripts/verify-viewer-runtime.ts` loads every compiled
server runtime, then serves the build and requires `GET /` to answer 200.
`scripts/verify-runtime-host.ts` drives two runtime-host generations through
succession and holds both endpoints. Held verdict tests cover their red paths;
the dispatch job also runs the induced end-to-end failure controls. A moved
pin must exercise both processes locally before publication. The image's
in-container rehearsal under `bun-container` remains in `verify-candidate`
before promotion. Docker images still build and publish on main and v* tags;
PRs build only when image install, build or runtime inputs change.

Three consequences worth keeping:

- **A failing socket write is a connection event, never a process event.**
  Every long-lived listener in the runtime host attaches its `error` handler
  to a connection before the first byte can be written to it. Bun 1.3.3 dropped
  failed writes silently, which is why the missing handlers survived so long;
  1.4.0 reports them, and an unhandled `error` on a connection kills the
  process that owns 8898. Tests must not paper over this: a test harness that
  attaches its own listener to each accepted connection hides exactly the
  defect the production server has.
- **Verification has to name the process it exercised.** "Loaded every built
  server module and requested real routes" is a statement about the Viewer. Say
  which process, or the gap comes back.
- **Inside the image, the interpreter is `bun-container`.** `bun` there is an
  nsenter shim onto the operator's own bun, for the agent CLIs; in a container
  without the host PID namespace it cannot run at all, and it is never the
  interpreter being promoted. Anything that starts a first-party process inside
  the image names `bun-container`, and the rehearsal passes that name down to
  the generations it starts.
<!-- END:runtime-host-verification -->

# Host deploy command and team authentication

`scripts/rebuild.sh [full-commit-sha]` uses `scripts/rebuild-http.ts` for both
admission and status polling. The client reads the existing host control key to
authenticate as `controller`, plus the Viewer access key when required. It
creates no key, sends no member cookie or agent identity, validates and pins a
resolved loopback address, and refuses redirects. Keep secrets inside that
process and out of arguments and output. Tests run the real command against an
isolated port-0 server; never use a live installation for a regression test.

# Rendered evidence: call the driver that exists, do not write a new one

A rendered surface is part of correctness, so new UI work still owes rendered
evidence. What it does not owe is a new one-shot driver: #1761 deleted about
22 000 lines of per-issue capture scripts and browser drivers that no workflow
ran and no second issue reused. There is exactly one driver of each kind, and
an issue adds a case to it:

- board geometry in a real browser — `scripts/capture-board-geometry.ts`
- run directories — `scripts/capture-directory.ts`
- the kanban board — `src/components/kanban/kanbanBoard.browser.test.tsx`, one
  `describe` block per issue over `issue1695Evidence.fixture.tsx`, gated by
  `LLV_KANBAN_BROWSER_TEST=1` plus `CHROME_BIN`
- the phone — `src/components/mobile/issue1671Evidence.browser.test.tsx`, gated
  by `LLV_SWIPE_BROWSER_TEST=1`

The committed `evidence/**/*.json` files are the record and stay, including the
ones whose driver is gone. Do not name a new file after your issue number; a
driver whose only caller is the issue that wrote it is dead the day it merges.

# Only a declared owner resolves the operator's state directory

`bun run build` in a lane once migrated the operator's live account files and
stopped every spawn on the machine for seventy minutes (#1905). Nothing in that
build meant to touch state: a route module loaded, it reached a store, the store
ran its first-boot import, and the import resolved
`~/.config/agent-log-viewer/state` because that is what an unset environment
resolves to. The mechanism, in `src/lib/stateOwnership.ts`, is three rules:

1. **Resolution asks who is calling.** `stateDir()` and `inboxDir()` hand back
   the operator's own directory only to a process that declares
   `LLV_STATE_OWNER` — `viewer`, `runtime-host`, `launcher`, `deploy-adapter`,
   `mcp` or `tool`. A production build (`NEXT_PHASE=…build`) and a test run get
   a throw-away directory under the temp root, stable for the life of the
   process; anything else is refused with an error naming what to set. A
   directory the caller chose (`LLV_STATE_DIR`, a sandboxed `XDG_CONFIG_HOME`,
   a `$HOME` under the temp root) is admitted untouched — that is how every
   test and capture driver isolates itself, and none of it changed.
2. **A state-mutating startup step needs the release fence.** Imports,
   migrations, backups, integrity swaps and cleanups call
   `assertStateStartupMutation(directory, step)`, which admits only `viewer`
   and `runtime-host` against the operator's directories and admits everything
   against a sandbox. A launcher or an MCP server reads what the Viewer already
   migrated.
3. **A spawned agent gets its own root.** Both structured hosts run their child
   environment through `withAgentConfigSandbox`, so the commands an agent runs
   resolve `<tmp>/llv-spawn-sandbox/<account>/config` and never the operator's.
   Its account home, its transcript root and its Viewer MCP link keep pointing
   at the real installation — the MCP link because `viewerMcpServerEnv()` pins
   the real state directory into the server definition itself, not into the
   agent's environment — and `GH_CONFIG_DIR` is pinned because `gh` used to
   read `XDG_CONFIG_HOME`. A restricted stage is handed a `TMPDIR` under
   `statePath("scratch")`: the sandbox ignores such a `TMPDIR` and builds under
   the process temp root instead, and a path under the process temp root is
   never classified as the operator's, so the suites that agent runs keep
   driving imports and backups against their own temp directories.

**The claim has to run before the entry point's own imports.** An `import` is
evaluated before every statement in the file that wrote it, so
`process.env.LLV_STATE_OWNER = …` in an entry's body runs AFTER its whole
module graph — and a module that resolves state while it loads (`export const
INBOX_DIR = inboxDir()`, `const TASKS_FILE = statePath("tasks.json")`) has
already been refused by then. The first round of this change claimed that way
in five entry points, and every one of them was dead code: the MCP server threw
before it could connect, which would have taken the Viewer tools away from every
spawned agent, and two operator scripts ran only when the variable was already
in the environment. An entry point claims one of two ways:

- `import "@/lib/state/owner/<kind>";` as its **first** import — one of the
  side-effect modules beside `stateOwnership.ts` (`mcp`, `tool`,
  `deployAdapter`), which is what `src/lib/mcp/entry.ts` and the operator
  scripts do;
- or a claim in the body followed by `await import(...)` for everything else,
  which is what `src/runtime-host/main.ts` does.

`bin/cli.mjs` and `src/instrumentation.ts` claim in their bodies and are safe
for a different reason: neither reaches a module that resolves state until
after the claim. Check that before copying them.

When you add a process that legitimately owns live state, give it an owner
token at its entry point (see `bin/cli.mjs`, `src/runtime-host/main.ts`,
`src/instrumentation.ts`, `src/lib/mcp/entry.ts`, the `runtime` stage of the
`Dockerfile`, and the `dev`/`start` scripts), and add it to
`stateOwnership.entryPoints.test.ts`, which starts each real entry point under
an operator-shaped home with nothing preset. When you add a script that only
needs *a* state directory, set `LLV_STATE_DIR` instead — claiming an owner
token to silence a refusal is how the seventy minutes come back.
