# Test hooks and inherited launch guards

Verified against main `917189ae562def76980341620987479ab2813cfc` on
2026-10-16. The live guard directory was inspected read-only.

## Writer and cause

A recorded repair-stage patch at 01:44:20 UTC added a temporary case named
`attempt Git custody refuses an unconfirmed recorded candidate` to
`src/lib/pipelines/engine.ports.test.ts`. In that temporary revision, line 2606
resolved the hook directory and line 2611 wrote `pre-push`. It called
`f.git(worktree, "rev-parse", "--git-path", "hooks")`, joined `pre-push` to the
returned directory, and wrote a shell refusal there. The recorded run reached
that case around 01:48:08 UTC. The shared hook's modification time was
01:48:07.985029 UTC. Its body was the fixture's three-line shell script,
which printed a transport refusal and exited with status 1.

The patch was changed at 01:48:27 UTC to use an explicit fixture directory,
then removed at 01:48:56 UTC in favour of a synthetic push receipt. It never
entered the committed source. The private investigation record retains the
transcript file and exact record lines; no transcript or account paths are
published here.

The surviving call path is `realWorktreeLane` in
`src/lib/pipelines/engine.fixture.ts:306`: its `git` helper calls `realExec`
without environment overrides. On the baseline, `test-preload.ts:48` creates
a temporary root and later isolates state, while keeping the launch's HOME and
`GIT_CONFIG_*` entries. `core.hooksPath` supplied through those entries overrides
repository configuration and changes `rev-parse --git-path hooks`. Isolating
HOME and state in the shell command alone therefore did not contain this write.

The observed `pre-push` SHA-256 was
`5fb87cd48af86ec7ac72cab3122967d7c03b5632b97cbb9fbf19268c29fae352`.
The intact `pre-commit` SHA-256 was
`9dd53c7b63846c0ca8787b487ad612c01bbd61438da95df5fc253d6e5fdc6d29`,
whose first 24 hex digits matched its generated directory name. No live hook
was changed during investigation or regression testing.

## Paths covered

`agentPublicationIdentityEnv` is the producer of the history guard configuration.
It appends the guard after App credential entries. Reapplication removes only
its previous final hooks entry, preserving preceding Git configuration.
`agentCodexPublicationPolicy` and `agentCodexPublicationArgs` copy that result
into native Codex settings. `applyClaudeSpawnPolicy` copies it into Claude
settings and defaults its source to `process.env`. `withAgentConfigSandbox`
copies the same policy into the child environment. The CLI, headless and
ephemeral launchers, tmux launch boundary, Claude stream host and flow engine
use these producers. The controller's commit identity supplies author fields
without installing hooks.

The local publication gate already strips inherited Git configuration in
`isolatedEnvironment`; direct test runs through `gate-slot.sh` still needed
the preload fence. The preload now clears Git repository/configuration and
stage receipt bindings before test files load, creates HOME and XDG config/cache
under the run root, and disables system Git config. Newly generated guards
therefore live inside the same temporary root. A source with no HOME uses the
runner's private HOME before the OS home fallback. Node children inherit the cleaned
environment. Both Bun spawn forms supply it explicitly, including synchronous
calls whose native default otherwise uses the startup environment. Explicit
fixture environments still take precedence.

The preload also sets `GIT_TEMPLATE_DIR` to an empty directory in the run
root. `git init` copies template hooks, including symlinks, into a fixture
repository; an inherited template could otherwise point a fixture hook write
back at a shared generated hook. The isolation regression supplies that
symlink and checks the inherited hook body byte-for-byte after each nested
runner finishes.

Every reused generated hook is checked against the SHA-256 of its expected
body, with a bounded read and executable-mode validation. Invalid bodies,
links and missing hooks are atomically replaced and logged by hook name and
expected digest. An unreplaceable hook refuses the launch. A fresh process can
reuse and repair an inherited directory only in the expected generated layout
under that launch's HOME with the expected digest. Repository hook forwarding
and identity/stage policy continue to use the generated script unchanged.

## Reproduction and verification

Run each file through the required gate wrapper, with isolated HOME,
XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR:

```sh
bun test src/lib/testing/testGitIsolation.test.ts
bun test src/lib/git/agentHistoryGuard.test.ts
bun test src/lib/testing/testChildren.test.ts
```

The isolation file replays the removed fixture's discovery and write against a
synthetic inherited guard for Node and both Bun spawn forms. It also checks a
missing HOME and that a newly generated guard stays within the test root. Its
template case checks that a copied hook symlink cannot redirect the fixture
write.
The guard file covers foreign and same-size bodies, oversized files, missing
hooks, symlinks (including generated roots), executable mode, failed replacement cleanup and repair in a
fresh process. Existing cases exercise native policy copies, identity refusal,
stage receipts, and repository-hook forwarding and rejection.

On unchanged main with the new regression files, all seven isolation cases
and all eleven new guard cases fail. On the fixed source they pass. The full
history-guard file and lifecycle file pass. Type checking and changed-source
ESLint pass. These checks assert correctness; they make no performance claim.

The [recorded readings](../../evidence/test-hook-isolation.json) include source
digests, check commands and results, and the read-only hook observation.
