# Pre-push and publication gates: duplication audit

> Operator request 2026-10-22 (voice; paraphrased, agents only): optimize the
> verification gates — remove duplicated checks and turn gates off where they
> are not needed and do unnecessary work; expected result: faster checks
> without needless duplication and runs.

Source: the pinned task specification. Sections 1–5 record the initial audit
and ranked proposals for acceptance item 1. Section 6 records the implementation
and its verification. Every measurement is an aggregate.

## Method

- Gate code: main `e12215c01`. Main moved to `677ed4978` during the audit.
  Since then, the only change among the gate's files (`scripts/`, `.githooks/`,
  `src/lib/pipelines/git.ts`, `gateBudget.ts`, `stageAttemptPush.ts`,
  `.github/`) is the npm package smoke script, which the gate does not run.
- Machine: 24 CPUs shared with live lanes. A sampler recorded load1 and CPU
  pressure (`some avg10`, "PSI") every 5 s; tables give the median for each run.
- Runs: scratch clones of the shared object store, each with origin pinned to
  the push's own `main`. Each had its own HOME, XDG directories, TMPDIR and
  `LLV_STATE_DIR`, and the Viewer control URL on a closed port. Heavy commands
  ran through `scripts/gate-slot.sh`. "Hook" means the clone's own
  `.githooks/pre-push`, run the way git runs it.
- Sessions on 2026-10-22: 12:40–13:21Z and 13:48–14:48Z.
- Lane history: a read-only `VACUUM INTO` copy of the state store taken at
  13:46Z. It covers attempts started from 2026-10-15T00:00Z, a window of 7.6
  days. The stage push receipts were read beside it. Main-branch figures
  cover the 233–234 changes merged between 2026-10-15 and 12:41Z.
- Three representative pushes:
  - **docs**: one design document (`99211e151`).
  - **small**: `worktreeSweep.ts` and its test (`db528f4d8`).
  - **merge**: a lane head that merged main (`89bd9a9cf`). It has 60 changed
    files, 50 of them linted, and selects 94 touched tests and 17 Linux tests.

  The docs and small commits were replayed with the agent identity. Tree and
  parent are unchanged; the replay only lets the local merge-boundary privacy
  check pass.

## 1. Cost of one hook run, cold and repeated

Run 1 is the first run in a fresh checkout. Run 2 repeats it in the same
checkout without changing anything, which is what the publication pays when a
producer already ran the full gate on that head (section 2.1).

| Push | Run | Wall | types | eslint | touched tests | Linux tests | CPU wait | load1 / PSI |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| docs | 1 and 2, both sessions | 0.7–1.0 s | skipped | — | — | — | — | — |
| small | 1, session 1 | 269 s | 247 s | 4 s | 89 s | 6 s | 17 s | 24.7 / 16.4 |
| small | 1 | 273 s | 266 s | 5 s | 83 s | 6 s | 0.2 s | 26.5 / 18.1 |
| small | 2 | 57 s | 22 s | 4 s | 50 s | 5 s | 0.2 s | 19.6 / 10.4 |
| merge | 1 | 578 s | 298 s | 44 s | 571 s | 4 s | 41 s | 26.2 / 14.1 |
| merge | 2 | 870 s | 34 s | 51 s | 862 s | 5 s | 39 s | 39.6 / 35.3 |

types and eslint share one lane, and touched tests and the Linux checks share
another. The two lanes overlap, so a push takes as long as the longer lane
plus privacy. The cold types step is the long pole of the small push (266 of
273 s), and the tests lane is the long pole of the merge push. On the merge
push, run 2 checked nothing new: its touched tests took 862 s against 571 s,
under a higher load. It also drew a different sample, with 16 base files and
12 flaky assertions against 14 and 2 in run 1. A repeat on the same tree
spends the same work again and can fail on a flake.

Step timings, each run on its own (execution time, admission excluded):

| Check | Result | load1 median |
| --- | --- | --- |
| `tsc --noEmit`, no `tsbuildinfo` (merge head three times, small main, merge main) | 169 s, 274 s, 259 s, 255 s, 232 s | 15.5, 27.2, 29.7, 29.8, 27.1 |
| same, warm, nothing changed | 16 s; 22–34 s inside hooks | 17.6 |
| same, warm, one function body edited in `engine.ts` | 20 s | 12.6 |
| same, warm, one export added to `engine.ts` | 172 s, 158 s | 15.5, 13.8 |
| `tsbuildinfo` copied from another checkout of the same tree | 19 s | 13.3 |
| `tsbuildinfo` copied from main into the small head (2 changed compiler inputs) | 248 s, 247 s | 25.0, 24.4 |
| `tsbuildinfo` copied from main into the merge head (49 changed compiler inputs) | 159 s, 185 s | 13.8, 14.1 |
| `eslint-changes.ts` on the merge push (50 files, head and base) | 46 s, 30 s | 29.1, 19.0 |
| head half only, same 50 files | 15 s, 16 s | 25.1, 15.7 |
| privacy on the merge push | 81 s, 21 s | 19.1, 18.7 |
| touched tests on the merge push (94 files) | 673 s: head 596 s, base sample 76 s; 40.5 s CPU admission besides | 33.9 |

On the hosted runners, the required `typecheck` job (a full `tsc --noEmit`)
took 114–209 s over 9 successful pull-request runs.

## 2. The same check on the same tree, more than once

### 2.1 The producer's own gate, then the publication's hook on the identical commit

271 of the 715 producing passes in the window say, in their report or final
message, that they ran the full pre-push gate. 169 of the 408 pipelines in the
window ask for it in their specification or a stage prompt. The controller then publishes from
the same worktree and runs the hook again. It skips the hook only when the
remote branch already holds the head (`src/lib/pipelines/git.ts:2124`,
`:2134`), that is, when the agent pushed the head itself, and the receipts
record only 98 such agent pushes in the window. The repeat costs run 2 of
section 1: 57 s on the small push and 870 s on the merge push. The types step
gets cheaper because the worktree keeps the producer's `tsconfig.tsbuildinfo`
and the step runs in the worktree itself (`scripts/local-gate.ts:579`, `:827`).
eslint, the touched tests, the Linux tests and privacy all run again in full.

### 2.2 Read-only stages that rerun the gate on a head already produced

94 read-only attempts say they ran the gate on a head an earlier stage had
already produced. This text match is an upper bound, because a reviewer may be
quoting the producer's result. Read-only stages are told to run checks in a
scratch export, so such a run also pays the cold types step (run 1 of section
1, 273–578 s).

### 2.3 Publication retries of an unchanged head

A retry after a deadline stop, a refusal or an interrupted push starts every
check over, because no step verdict outlives the hook process. 7 attempts in
the window carry retry records, with 18 recorded failed tries between them.

### 2.4 Later pushes of a lane check the lane's whole diff again

Each push is judged against `merge-base(HEAD, origin/main)`, so every later
stage re-checks everything the lane changed so far. Today's selection was
replayed over all 355 later pushes in the window, using git only and leaving
out platform scope:

- The median later push changed 5 files since the previous push, while its
  cumulative diff has 17.
- 6 729 of its 7 089 touched-test file runs (95 %) had already run at the
  previous push.
- 307 of the 355 kept the previous push's merge base. In those pushes, 1 615 of
  5 772 file runs (28 %) have an executed closure that nothing changed since
  the previous push reaches. The closure was taken from `executedPaths` on
  current main, so this figure is approximate.
- In the same 307 pushes, 4 391 of 5 678 linted files (77 %) were
  byte-identical to the previous push.
- 3 later pushes had exactly the previous push's tree.

### 2.5 Head and base runs

- **Touched tests.** The base sample runs only for files that fail on head,
  filtered to the failing tests (`scripts/local-gate-tests.ts:421`). On the
  merge push, 13–16 of the 94 files fail on head, holding 139–140 failures that
  are pre-existing on main, and the base sample takes 73–87 s. Every push
  samples again, although 307 of the 355 later pushes kept the previous
  push's merge base.
- **ESLint.** `scripts/eslint-changes.ts:47-56` lints every changed file twice,
  once on head and once on base, even when head has no error. A head with no
  errors cannot introduce one, so in that case the base half decides nothing.
  On the merge push it took 14–31 s of 30–46 s.

### 2.6 Local gate and hosted CI

| Check | Where it runs locally | Hosted |
| --- | --- | --- |
| full type check | `types`, every push that is not all prose | `typecheck` (required), every PR push |
| privacy | `privacy`, every push | `privacy-publication` (required), every PR push |
| runtime chain (`next build`, host rehearsal, native Codex) | only when `Dockerfile`, `src/runtime-host/**` or `bin/**` change (28 of 233 main changes) | `runtime-gate` (required), every PR |
| touched tests | every push that changes code | none |
| merge batch: tsc, eslint, sibling tests, privacy (`scripts/merge-batch.ts:350`) | one merge-batch PR since 2026-10-15; landings go through the forge | — |

Privacy runs locally before the push because a push is public. The hosted
required checks enforce what a skipped hook would miss, so their names and
inputs stay as they are.

## 3. Checks that run on changes they cannot be affected by

- **Types on prose.** These are already skipped when the whole push is prose
  (`scripts/local-gate.ts:66`), which was 8 of 234 main changes. A later push
  whose own change is prose only still re-runs types over the lane's
  cumulative diff: 2 of 355 later pushes.
- **Main-only files after a merge of main.** They are not counted while the
  fetch succeeds. The merge push selects the same 60 files and 94 tests as the
  lane's pre-merge head, because `merge-base` moves to the merged main. They
  leak in only when `origin/main` is stale, after a fetch that failed or
  stopped at the deadline (`scripts/local-gate.ts:760-763`). With `origin/main`
  two commits behind, the same push selects 80 files, 100 tests and 65 lint
  files. The 94 tests come from the sibling rule
  (`scripts/local-gate.ts:77-81`): `engine.ts` alone selects 46
  `engine.*.test.ts` files, 3 471 of the 4 459 file-seconds (78 %), and all
  94 import a changed file.
- **Base reruns of files the branch did not change.** None on the merge push:
  every one of the 94 tests reaches a changed file through its executed
  closure.
- **Linux tests.** They ran for 193 of the 233 main changes, as 3 281 file
  runs. Only 373 of those reach a changed file through the executed closure,
  and 53 of the 193 runs reach none at all. The step costs 4–6 s.
- **Test-only diffs.** 13 of 234 main changes touched only tests among their
  TypeScript files. Tests are part of the program, so types still has to run.
  The only waste is the cold start below.
- **Cold `tsc` in a fresh worktree.** Every lane starts in a new worktree, so
  its first gate run pays 169–298 s for the whole program, whether the
  producer or the publication runs it. The next run in the same worktree
  costs 16–34 s. Copying main's build info into the fresh checkout did not help
  (section 4).

## 4. Deferred — not currently justified

- **Dropping local `types` in favour of hosted `typecheck`.** The local run is
  what gives the producing stage a repair turn before publication; the engine
  does not read hosted results for stage transitions.
- **Dropping local privacy or the local runtime chain.** A push is public, and
  `AGENTS.md` requires a moved pin to exercise both processes locally.
- **Narrowing the `engine.ts` sibling rule.** It accounts for 78 % of the
  merge push's test time, but every file it selects imports `engine.ts`.
  Narrowing it changes what the gate catches, which puts it outside this
  task.
- **Reusing a test file's verdict across different trees by import closure**
  (the 28 % in section 2.4), **and narrowing Linux tests the same way**
  (4–6 s off the critical path). `executedPaths` does not follow fixtures read
  through computed paths, so the key would not cover a test's real inputs.
- **Seeding a fresh worktree's `tsbuildinfo` from main.** Build info is
  portable between checkouts: 19 s on the same tree. Yet a seeded head was no
  faster than a cold one at comparable load: 159–185 s against 169 s on the
  merge head, and 247–248 s against 255–266 s on the small head. Both changes
  edit exports that much of the program depends on, so tsc re-checks most of
  it anyway.
- **A base for a stale `origin/main`.** Only main's ref can tell a merged main
  from another merged branch. How often the fetch fails is unknown, because the
  hook output of passing publications is not kept.
- **Telling producers to stop running the full gate.** R1 below makes their
  run count instead. Publication refusals caused 43 repair turns in the window,
  32 of them in touched tests, so the gate's own run is useful work.
- **The merge-batch gate.** One merge-batch PR since 2026-10-15; it is not a
  current cost.

## 5. Removals that keep every guarantee, ranked by expected saving

Every removal prints, in the gate output, what it skipped and why. A changed
input runs the full check.

**R1. Reuse a passed step when the gate runs again on identical inputs.**
After a step exits 0 in a run that was not stopped, deferred or left with live
processes, `scripts/local-gate.ts` records the pass under the repository's git
common directory, which every worktree of the clone shares. The record is
keyed by HEAD's tree id, a clean worktree (no staged, unstaged or untracked
file: the gate checks those too, `scripts/local-gate.ts:772-774`), the
merge-base commit, the Bun version and platform, and, for pinned steps, the
pinned runtime. A later run with the same key prints `pre-push: <step>: reused
the pass recorded <time> for tree <id> against base <id>; not run again`.
Privacy is never reused, because commits and role-memory known values change.
Neither are the frozen install and the supply-chain audit, because advisory
data changes. The types step may key on its compiler inputs alone (TypeScript,
JavaScript, JSON, tsconfig, package and lock files), which also covers the
prose-only later pushes. *Saving:* run 2 of section 1
less privacy: 55 s on the small push and 560–850 s on the merge push,
depending on load. The
window had up to 271 producer runs repeated by publication (98 agent pushes
skipped it), up to 94 read-only reruns and 18 retry tries: 280–380 repeats,
37–50 a day. Retries keep the steps that had passed. *Guarantee:* a step's
verdict is a function of these inputs, so reuse returns the verdict the gate
gave on them. The only loss is a second sample of a flaky test on the same
tree. Trust does not grow: the controller already skips its hook when the agent
pushed the head itself (`git.ts:2134`), and that push can bypass the hook
(`src/lib/pipelines/stageAttemptPush.ts:468`). *Proved by*
`scripts/local-gate.test.ts`, on its hook fixture:

- Pushing the same clean commit twice reuses each recorded step, and the
  shims record no tsc, eslint or `bun test` call.
- Each of these forces the full run: one changed byte in a tracked file; an
  untracked or staged file; another merge base; another Bun version; a changed
  `scripts/local-gate.ts`.
- A record for tree A is never used for tree B with the same changed-file list.
- Failed, stopped and deferred steps leave no record, and the retry runs them.
- Privacy runs on every push.

**R2. Cache the touched-test base sample per base commit.** The key is the
base commit, the test file, the failing-test filter (the whole file for runner
errors), the Bun version, the comparator's blob id and the dependency-graph
fingerprint. The value is the per-test pass and fail counts. Only the first
base sample is served from the cache; confirmation rounds stay fresh. A base
failure enters the cache only after two fresh samples agree, so a flake is
never frozen. The cache is bounded and owned by `scripts/local-gate-tests.ts`.
`AGENTS.md` and `docs/verification/pre-push-touched-tests.md` ("no baseline
result is cached") change with it. The cache that C5
(`docs/design/checks-under-five-minutes.md`) deleted never hit, because its
key held the per-step random token; this key holds no per-invocation value.
*Saving:* 73–87 s on every push whose head fails a file main already fails;
the merge push has 13–16 such files. 86 % of later pushes keep the previous
base. *Proved by* `scripts/local-gate-tests.test.ts`:

- A second comparison on the same base and failing names logs the cache hit
  and starts no base process.
- A different base, file, filter, comparator blob or Bun version samples
  fresh.
- A single base failure is not cached.
- Head-only failures still get their confirmation rounds, with fresh base
  runs.

**R3. ESLint: lint base only for files where head has an error.**
`scripts/eslint-changes.ts` lints head first. It skips base when head has no
error, and otherwise lints only those files' base versions. The removal is
exact: `compareErrors` (`scripts/eslint-changes.ts:20-32`) reports only head
errors, and matches a base error to one only on the same file, rule and
message. The one change is that the "already on the base" line then counts
only files with head errors, and its wording says so. *Saving:* 14–31 s on the
50-file merge push, about 0.3–0.6 s per linted file. The median main change
lints 9 files and p90 32. The step sits in the types lane, the long pole of
cold runs. *Proved by* `scripts/eslint-changes.test.ts`:

- The existing cases are unchanged.
- A clean head reads no base blob.
- A head error in A beside base errors in B lints only A's base.
- On every fixture, the result equals the two-sided run's.

**R4. ESLint's own content cache for unchanged files.** ESLint 10.9.1 caches
results with `cache: true, cacheStrategy: "content"`, keyed by file content and
resolved configuration. The cache file lives under the gate's XDG cache, and
its name carries the digests of `bun.lock` and `eslint.config.mjs`. The
configuration has no type-aware rules (no `parserOptions.project`), so a file's
messages depend on its content and the configuration alone. *Saving:* about
0.3 s for each unchanged file, and 77 % of the files linted on later pushes
are unchanged. *Proved by* `scripts/eslint-changes.test.ts`:

- An unchanged file returns the cached messages.
- An edited file, an edited configuration or another lockfile digest forces a
  fresh lint.
- The base half never reads the cache.

## 6. Implemented removals and verification

All four ranked removals are implemented. The merge-base selection, sibling
test rule, hosted required checks and local privacy/runtime requirements stay
as measured in the audit.

- **Step passes:** `scripts/local-gate.ts` records successful, completed
  steps in the clone's common Git directory. The key binds the head commit,
  branch, tree, merge base, command, executable bytes, installed dependency
  bytes, gate source closure and effective environment. It also hashes ignored
  checkout inputs, including generated declarations and symlink destinations.
  Git metadata and the compiler's incremental output are excluded. A dirty
  tree or a Git index concealment flag disables reuse. Inputs are rechecked
  before reuse and after a check finishes. Failed, stopped, deferred,
  cancelled or leaking checks certify no pass. The runtime build and its
  consumers reuse as a complete group. Privacy, frozen install and advisory
  checks always run fresh. Inert caller metadata and private isolation roots
  do not distinguish producer from publication. Authority, Viewer endpoint,
  structured-host stamp, signal-domain and configuration inputs do: differing
  execution contexts require fresh checks even on one commit.
- **Baseline samples:** `scripts/local-gate-tests.ts` needs two matching
  fresh complete assertion observations before a third comparison can reuse
  an initial base sample. Confirmation rounds stay fresh. Runner errors,
  incomplete samples and local/workspace dependencies receive no cached
  allowance. An observed flaky result invalidates its entry. Base commit,
  selected file, failing-name filter, origin, dependency inputs, comparator
  sources, Bun bytes, environment and budgets bind each entry.
- **Lint:** `scripts/eslint-changes.ts` reads base text only for files with
  head errors. Its native content cache uses separate generations for
  dependency and configuration bytes. Corrupt or unavailable optional cache
  storage falls back to fresh checks; source and configuration failures still
  refuse publication.
- **Bounds:** `scripts/gate-cache.ts` owns pass and baseline records under
  `delegatus-gate` in the common Git directory. Each family retains at most
  256 entries and 32 MiB, including abandoned atomic writes; pass entries
  expire after seven days and baseline entries after 24 hours. ESLint retains
  eight generations of at most 4 MiB. Concurrent writers can briefly exceed a
  bound until the next write. Existing gate sandbox cleanup is preserved.

Red tests preceded each behavior change. The real hook fixtures in
`scripts/local-gate.receipts.test.ts` exercise fresh processes for reuse,
different trees, dirty/index-hidden inputs, ignored declarations, base/tool
and environment changes, malformed records, failed checks and always-fresh
privacy/install/advisory checks. `scripts/local-gate-tests.test.ts` covers
independent baseline observations, filters, dependency/origin/source changes
and flaky/error refusal. `scripts/eslint-changes.test.ts` covers both sides
of the lint skip and content-cache invalidation. `scripts/gate-cache.test.ts`
covers restart, corruption, expiry, bounds and unavailable storage.

### Execution-phase comparison on fixed product inputs

The implemented gate at `f61c6aa84` was compared with `e12215c01` on the
remote test runner on 2026-10-22. Both arms ran in the same admitted scope,
with the same CPU/memory limits and separate isolated check roots. The
procedure was `scripts/measure-local-gate.ts`: export the old gate source,
use immutable product commits, run the old and new planner/runner twice in
separate clones, and sample host load1 and CPU PSI every five seconds.
Fetch and outer CPU admission are excluded. File privacy remains enabled;
the commit-history scan is excluded from both arms so the original historical
commits can be used without rewriting identities. The normal pre-push hook
is verified separately, including commit history.

Product inputs: docs `99211e151` against its parent; small product change
`db528f4d8` against its parent; merge of main `5a3442aa0` against its second
parent, which is its merge base with main. The merge changes two files and
selects four test files. It is separate from the audit's 60-file merge.
Each before/after pair uses the exact same product commit, tree, base and
installed dependencies. No scratch commit is created.

| Input | Version | First / repeat, seconds | Median load1, first / repeat | Median PSI, first / repeat | Repeat passes reused |
| --- | --- | --- | --- | --- | --- |
| Docs | Before | 1.08 / 0.85 | 23.7 / 23.7 | 11.3 / 11.3 | 0 |
| Docs | After | 1.62 / 1.18 | 23.2 / 23.2 | 11.6 / 12.2 | 0 |
| Small product change | Before | 170.24 / 63.47 | 22.0 / 15.6 | 16.8 / 6.1 | 0 |
| Small product change | After | 159.88 / 11.35 | 14.5 / 11.1 | 6.3 / 2.2 | 5 |
| Merge of main | Before | 92.02 / 16.50 | 9.6 / 9.7 | 2.2 / 4.0 | 0 |
| Merge of main | After | 145.52 / 8.42 | 19.9 / 36.1 | 43.5 / 52.5 | 3 |

All twelve runs exited zero. The new repeats logged the reused step, tree,
base and reason; every run logged a privacy pass. The cold measurements have
uneven load and establish no cold-run speedup. Docs-only execution remains
about one second. The small repeat reused types, lint, touched tests and both
Linux checks; the merge repeat reused types, lint and touched tests.

A previous probe of the audit's 60-file merge using the old gate refused:
1,284 seconds, median load1 11.8 and PSI 34.1, with 167 pre-existing failures,
61 flaky cases, a surviving-child diagnostic and a runner timeout. It is a
refused measurement, not evidence of a successful speed comparison.

### Correctness checks

The focused command, through `gate-remote` and `scripts/gate-slot.sh`, was:

```sh
bun run test ./scripts/local-gate.test.ts ./scripts/local-gate.receipts.test.ts ./scripts/local-gate-tests.test.ts ./scripts/eslint-changes.test.ts ./scripts/gate-cache.test.ts
```

It passed 161 tests with zero failures in 390 seconds. A further prose-only
output test was run red, then green through the same wrapper: one pass, zero
failures. It proves both the skip explanation and that a following source
change executes types, lint and touched tests. The runtime-group eviction
regression was also observed red before its fix and passed in the focused
suite. Commit hooks ran whitespace, privacy and lint with no bypass.

The runtime group retains its complete validated verdict for one invocation,
so optional cache eviction cannot run a consumer after its build was skipped.
All existing gate temp-root prefixes and cleanup behavior are preserved.
