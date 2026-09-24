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
   matched and the cwd is gone.

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
every clone shares a remote id.
<!-- END:worktree-grouping -->

<!-- BEGIN:live-state-and-publication -->
# Local hooks mirror the publication gate

Run `git config core.hooksPath .githooks` once per clone (worktrees inherit it
from their parent repo's config). `pre-push` runs the real
`privacy-publication-gate` (sub-second) from the merge base with commit
checking, and warns when the branch is behind `origin/main` — the state in
which the hosted gate flags main-only commits. `LLV_SKIP_HOOKS=1` skips it
for a false positive.

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

`privacy-publication` on CI enforces this with a fingerprint list the repo does
not carry, so it fails **after** you have pushed. Scrub before the push:
`bun scripts/privacy-publication-gate.ts --base <merge-base>` locally catches the
generic classes, and re-read every table and quote you lifted out of logs.
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

**Both halves now run on CI**, in the `bun-runtime` job, at the pull request's
own commit. `scripts/verify-viewer-runtime.ts` is the Viewer half: it loads
every compiled server runtime the build produced — `app-page.runtime.prod.js`
among them, the module whose load failure answered 500 on every route — and
then serves the build and requires `GET /` to answer 200. The job reads its Bun
version out of the `Dockerfile`, so moving the pin is itself what re-runs the
verification, and a rehearsal or a load that fails ends the job. The job also
proves each of those checks can go red rather than only reporting that it went
green: the tests holding both verdicts run inside it, and then each half is
handed a subject that does not hold — no build at all, the incident's own
`app-page.runtime.prod.js` made unloadable on purpose, a root with no runtime
host in it — and a check that stays green against one of those fails the job.
A green check whose red path nobody has seen is the same unattributable claim
one level up. Run both locally to find out early; the job is what a reviewer
can point at, which three rounds of #1248 spent on a local claim nobody could
reproduce. What the job deliberately leaves out is the image build — the
runtime stage installs apt packages and a Python whisper environment and sets
the setuid bit on nsenter, which is far heavier than a pull request check — so
the in-image rehearsal under `bun-container` stays where it is, in
`verify-candidate`, before any promotion.

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
