> «15 минут — это дофига, и не совсем понял, что за сравнение тестов. Это что, что, зачем сравнивать? И вообще, тесты не должны занимать. Тесты, CI, и всё такое не должно занимать больше, чем там, не знаю, 5 минут, 3 минуты.»

Origin: operator, 2026-10-12 ~20:45Z (Russian), pinned task specification.

# Local hooks and CI in 3–5 minutes

Status: design complete. Step one (measurement) is done, and the operator settled both open questions on 2026-10-12 ~23:30Z (section 6). The build stage implements C1–C10 and measures the after-times.

Baseline: measurements and line anchors were taken at main f2e3c3858. Main was at 40451576b when this document was finished. Between the two, none of the gate scripts, workflows, `package.json`, `scripts/merge-batch.ts` or the two split test files changed. `src/lib/forge/autoMerge.ts` and `AGENTS.md` did, and their anchors below are from 40451576b.

## 1. What the "test comparison" is, in plain words

Before a push, the hook runs the test files the change touches. If one fails, the hook has to answer one question: did this change break it, or was it already broken on main? To answer, it checks out the merge base (main at the point the branch started) in a scratch copy and runs the same test files there. A test that fails on both sides is `PRE-EXISTING` and does not block. A test that fails only on the branch is `NEW` and blocks. Without the comparison, a test someone else broke on main would block every lane that touches its file.

Today the hook runs the main side first, always, for every touched file, even when the branch side is entirely green and there is nothing to classify. On the lane that stalled today, the main side alone took 8.5 minutes and then failed on its own (section 3, F3). Change C1 runs the main side only for files that actually fail on the branch, which is the only case where the answer is needed.

## 2. Measurements

### 2.1 Method

Local runs, 2026-10-12, 20:58Z–22:15Z, on the machine the lanes use: 24 CPUs, load average 11–16, CPU pressure `some avg10` 4–10 %, all six heavy-gate slots repeatedly held by other lanes. That is a normally loaded evening for this machine.

- Every run happened in a stage-scratch clone. Product files and the pipeline worktree were not changed. Dependencies came from `bun install --frozen-lockfile` through `scripts/gate-slot.sh` in the clone.
- Each run had a private `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `TMPDIR`, `CLAUDE_CODE_TMPDIR`, `LLV_STATE_DIR`, `LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1`, `DELEGATUS_TELEMETRY=0`. Only the gate's own Bun/Codex fixture cache (`delegatus-gate`) was linked in warm, as a real push finds it. The CPU queue and the six slots are machine-wide by design (`src/lib/runtime/cpuAdmission.ts:79-89`), so the runs queued with the real lanes, which is the condition being measured.
- The gate code was main's (`scripts/local-gate*.ts`, `gate-slot.sh`, `owned-runner.ts`, `cpu-admission.ts`, privacy gate, `src/lib/runtime/cpu*.ts` at f2e3c3858; main has not touched them since). It was overlaid on the measured branch tree and hidden from the change set, so the plan matched what main's hook would run for that branch.
- A measuring copy of `local-gate.ts` timed each step and kept going after a failure, so every step got a number. A measuring copy of `local-gate-tests.ts` timed each test file. Neither changes what is executed. The outer owned-runner limit was raised to 60 minutes so the steps could finish. Real pushes stop at 15 minutes.
- Queue time per step is read from `gate-slot`'s "Waiting for the CPU queue / for a heavy command slot" lines (last line + 2 s, minus step start). It is accurate to about ±4 s.

Scenarios:

- **L** is the branch of lane 5828eced at 7199cd4bb, the one whose push failed four times today: 45 changed files, 22 touched test files, every heavy set in scope. The worktree was cold (no `tsconfig.tsbuildinfo`).
- **S** is the change of #2785, a small PR (5 files, 4 touched test files), measured against its parent. Its privacy step fails in this replay because the squash commit on main carries the forge's committer identity. That is an artefact of the replay; the 9 s is the real scan time.
- **C** is the pre-commit hook on the same five files staged.

CI comes from `gh` job and step timings of every pull-request run created 2026-10-11 and 2026-10-12 (334 runs, 556 jobs), plus the last successful dispatches of `bun-runtime.yml` (2026-10-02, the newest that exist).

### 2.2 Local pre-push, step by step (seconds)

| Step | L total | L of which queue | S total | S of which queue |
| --- | ---: | ---: | ---: | ---: |
| privacy (uncapped) | 38.3 | 0 | 9.0 | 0 |
| types (`tsc --noEmit`, cold) | 234.6 | ~68 | 193.5 | ~58 |
| eslint (changed files, head + base) | 18.2 | 0 | 145.5 | ~142 |
| touched tests | **963.7, gate error** | ~2 | 110.2 | ~6 |
| · main side (merge base) | 511.9 | | 39.9 | |
| · branch side | 449.2 | | 37.8 | |
| Linux backend | 12.3 | ~12 | not in scope | |
| Linux tests (main 5.3 + branch 4.6) | 22.4 | ~6 | not in scope | |
| runtime verdict tests | 93.5 | ~38 | 146.0 | ~84 |
| build MCP | 28.6 | ~28 | 194.8 | ~190 |
| MCP size budgets | 16.7 | ~12 | 208.0 | ~190 |
| Viewer build (`next build` + MCP) | 260.9 | ~6 | 292.0 | ~120 |
| Viewer runtime (`GET /` under the pin) | 77.2 | ~62 | 39.2 | ~36 |
| runtime host rehearsal | 28.6 | ~12 | 24.6 | ~6 |
| runtime negative controls | 68.8 | ~8 | 64.7 | ~4 |
| native Codex ×3 (run at once) | 243 | n/a | 91 | n/a |
| **Whole pre-push** | **2109 (35.1 min)** | **~254** | **1520 (25.3 min)** | **~836** |

For S, 14 of the 25 minutes were spent waiting for admission. Waiting happened even while pressure stayed below the hold threshold, because every capped step queues for one of six shared slots on its own: 13 separate admissions per push.

### 2.3 Local pre-commit (scenario C, seconds)

| Step | Total | Of which queue |
| --- | ---: | ---: |
| staged whitespace | 0.0 | 0 |
| privacy (staged paths) | 7.5 | 0 |
| eslint (5 files) | 45.5 | ~42 (lint itself ~4) |
| **Whole pre-commit** | **54.3** | **~42** |

### 2.4 Touched tests: why the branch side is slow, per file (seconds)

| File | main side | branch side |
| --- | ---: | ---: |
| `src/lib/pipelines/engine.test.ts` (25,847 lines, 1,607 tests) | **300.3, killed at the 300 s per-file budget** | 277.7 |
| `src/lib/monitor/seatTickController.test.ts` (9,789 lines) | 147.4 | 117.0 |
| `src/lib/mcp/server.test.ts` | 42.9 | 37.2 |
| `src/lib/mcp/bindings.test.ts` | 8.8 | 7.7 |
| `src/lib/monitor/seatTickSources.test.ts` | 8.8 | 5.1 |
| 17 other files (9 new on the branch) | under 1.2 each | under 1 each |

Separate probes on the same tree:

- `engine.test.ts` alone through `gate-slot`: 232 s at the default 300 % scope quota, 257 s at 1200 %, 299 s on a third run. Four times the CPU did not make it faster: the file is bound by its own serial work (about 280 git subprocess call sites, real child processes, timers), and the quota is not the limit.
- A second `tsc --noEmit` in the same worktree, with `tsconfig.tsbuildinfo` present: 97.5 s, against about 165 s cold. Types cost 1.5–3 minutes whatever else changes.
- Baseline cache key: `local-gate-tests.ts` run three times on one file with `LLV_GATE_STEP` set to A, A, B gave "baseline run", "baseline cache hit", "baseline run".

The four failed pushes of lane 5828eced today all logged `baseline run 479–511 s`, then `owned runner: deadline expired` and `bash failed (124)`.

### 2.5 How often each heavy set is in scope

`discover()` and `plan()` from `scripts/local-gate.ts` were run against each of the last 40 merged PRs (#2735–#2799), each against its parent:

| Set | Pushes in scope | Why |
| --- | ---: | --- |
| runtime chain (Viewer build, `GET /`, host rehearsal, controls) | 37 / 40 | Its import closure holds 996 of 2,301 non-test source files, including `engine.ts`, `mcp/server.ts`, `mcp/bindings.ts` and the i18n tables. |
| native Codex ×3 | 36 / 40 | similar closure |
| Linux tests | 31 / 40 | platform closure |
| Only Bun pin, Dockerfile, `package.json`/`bun.lock`, `next.config`, `src/instrumentation.ts`, `src/runtime-host/**`, `bin/**` | 3 / 40 | |

So the "scoped" heavy checks run on nine pushes out of ten.

### 2.6 CI, pull-request runs 2026-10-11 and 2026-10-12 (minutes)

| Job | Merge-required | n | run p50 | run p90 | run max | queue p50 | queue p90 | queue max |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| privacy-publication | yes | 63 | 5.2 | 5.7 | 6.1 | 0.0 | 0.0 | 0.1 |
| privacy-tracker-audit | yes | 72 | 0.6 | 0.8 | 1.5 | 0.0 | 0.0 | 0.1 |
| Docker image / scope | no | 61 | 0.3 | 0.3 | 0.5 | 0.0 | 0.1 | 0.1 |
| Docker image / build | no | 38 | 5.1 | 5.7 | **30.5** | **5.0** | **22.3** | **39.6** |
| Scope (Windows) | no | 50 | 0.2 | 0.2 | 0.3 | 0.0 | 0.0 | 0.3 |
| Windows (native) | no | 34 | 5.6 | 6.2 | 6.5 | 0.0 | 0.0 | 0.1 |
| Journal startup | no | 48 | 2.3 | 2.5 | 3.0 | 0.0 | 0.0 | 0.1 |
| Scope (macOS) | no | 50 | 0.2 | 0.2 | 0.2 | 0.0 | 0.0 | 0.1 |
| darwin-identity | no | 41 | 1.6 | 1.8 | 2.1 | 0.1 | 0.2 | 0.4 |

Wall time per pushed PR head, from the first job created to the last one finished (heads with a cancelled run excluded):

| Set of jobs | n | p50 | p90 | max |
| --- | ---: | ---: | ---: | ---: |
| the two merge-required checks | 49 | 5.3 | 5.8 | 28.5 |
| all named checks except Docker build | 49 | 5.7 | 7.4 | 28.5 |
| all named checks, heads where Docker build ran | 35 | 11.3 | 35.1 | 45.5 |

Step breakdown of the long jobs (seconds, p50 / p90):

- **privacy-publication.** Two checkouts 13 + 12; install 3; media tools 16 / 26; **trusted self-test suite 115 / 120** (`continue-on-error: true`, `.github/workflows/privacy-publication.yml:157-161`, it cannot fail the check); scan of changed surfaces, messages and merge boundary 31 / 52; **candidate self-test suite 115 / 120** (`:190`).
- **Docker build.** "Verify PR image" 271 / 304. #2762's 30.5 minutes is run 38287812083: QEMU was set up and both architectures were built (1,777 s), because `bin/`, `src/runtime-host/` and `src/lib/platform/` count as multi-architecture inputs (`scripts/docker-image-scope.cjs:38`). All PR image builds share one global slot (`.github/workflows/docker-image.yml:111-113`), which is where the 22-minute p90 queue comes from.
- **Windows (native).** `bun install` 83 / 144 with no cache; platform tests 15; terminal bootstrap custody 153 / 167; transcript worker 53.
- **Journal startup.** Verification 122 / 129.
- **darwin-identity.** Verification 58 / 68.
- **Bun runtime pin** (`bun-runtime.yml`, dispatch only, last runs 2026-10-02). The `bun-runtime` job took 4.9–5.4 min (Viewer build 196 s, negative controls 61 s, host rehearsal 17 s). Each `native-codex-runtime` job took 2.3–2.8 min, and the matrix runs in parallel.

Branch protection requires only `privacy-publication` and `privacy-tracker-audit`. Auto-merge waits only for required contexts and refuses on any check already red (`src/lib/forge/autoMerge.ts:329-330`, `:342-346`). So the merge wait is about 5.3 minutes, set by privacy-publication. The other jobs only block when they turn red before the merge.

## 3. Where the time goes

- **F1. Thirteen admissions per push.** Every capped step goes through `scripts/gate-slot.sh` on its own (`scripts/local-gate.ts:667`), queues in the machine FIFO and competes for one of six slots, then gives the slot back. Measured cost: about 254 s on L and about 836 s on S, more than half of S.
- **F2. The main side always runs, and before the branch side.** `scripts/local-gate-tests.ts:364-366` runs the merge-base sample for every old touched file before the branch sample (`:379`), whether or not the branch fails. L: 512 s spent before any branch result. S: 40 s plus about 26 s to clone and check out the base.
- **F3. A main-side timeout blocks a green branch.** `engine.test.ts` needs 232–300 s, and the per-file budget is 300 s (`:28`). On L the main side was killed at 300.3 s and the branch side passed in 277.7 s. The comparison then ends in `baseline: …engine.test.ts: runner did not finish (124); gate error (blocking)` even with unlimited outer time. In normal pushes the outer `gate-slot` owned runner's default 15-minute limit (`scripts/owned-runner.ts:16`) covers main side + branch side + reruns together. It killed the step first, which is the "head side missed the deadline" the lanes reported.
- **F4. The baseline cache never hits from the hook.** Its key includes the environment (`scripts/local-gate-tests.ts:328-329`), and that environment carries `LLV_GATE_STEP`, a random token the hook gives every step (`scripts/local-gate.ts:454`). The A/A/B probe shows the effect. The cache also never stores a main side with any failure, and L's main side always has the engine timeout. Across lanes the key differs anyway, because every lane has its own merge base.
- **F5. Steps run strictly one after another.** Types, lint, tests, platform tests, the runtime chain and native Codex do not depend on each other's results. Only the runtime chain has internal order (build before serve).
- **F6. The heavy sets run on nine pushes out of ten** (section 2.5). The runtime chain plus native Codex cost about 820 s on L and about 650 s on S, of which `next build` alone is 230–290 s.
- **F7. Two test files dominate the branch side.** `engine.test.ts` (278 s) and `seatTickController.test.ts` (117 s) are 395 of L's 449 s. Neither speeds up with more CPU.
- **F8. Duplicate work.** `bun run build` already ends with `bun run build:mcp` (`package.json:32`) after a separate "build MCP" step; `next build` re-checks types with the production tsconfig (54 s on L) after the full `tsc`; the PR Docker image runs `next build` again on CI.
- **F9. CI's long pole is a self-test run twice.** privacy-publication runs the privacy self-test suite once on main's code (warning only) and once on the candidate's code, 115 s each, back to back. Most PRs change no privacy code, so both runs test the same thing.
- **F10. The Docker PR build waits in a one-slot queue** (p50 5 min, p90 22 min), and it builds arm64 under emulation (30 min) for architecture-neutral TypeScript directories.

## 4. Changes, ranked by saving

The savings are measured numbers from section 2. The after-times in section 5 are estimates until the build stage measures them.

### C1. Branch side first; main side only for failing files

`touchedTests` runs the branch side first. If it has no failures, there is nothing to classify, and the merge base is never cloned. If some files fail, it clones the base once and samples only those files, filtered to the failing tests with the existing `testNameFilter`, then runs today's confirmation (three reruns per side, shared five-minute budget) unchanged.

- Saves 512 s and the false gate error on L, and about 66 s on S. It also applies to "Linux tests", which use the same tool.
- Keeps: the `NEW` verdict is computed exactly as today. Only branch-side failures can be `NEW`, and each one still gets its main-side sample before it is judged. `PRE-EXISTING`, `FLAKY`, and "broken the same way" all keep their meaning.
- Changes: on a green branch, the informational `FIXED` and `REMOVED/SKIPPED` lines are no longer printed, because those need a main-side sample. A branch failure whose main side cannot be sampled is still a blocking gate error. The spec's "degrade to a warning when only the base side is missing" is met by the stronger form: a green branch needs no base side at all. A red branch with no base keeps blocking, so new-failure detection stays.

### C2. One admission per push; independent checks run side by side

`pre-push` starts mandatory privacy inspection and the isolated checks concurrently. Privacy keeps its uncapped execution and existing refusal text and exit behaviour. The checks take one `gate-slot` admission for their whole heavy phase. Nested `gate-slot` calls reuse that slot and get their own scope and quota without queueing again.

The operator approved this revised order on 2026-10-13 after cold L privacy inspection measured 120–188 seconds. Both halves must return a passing verdict before the hook permits publication. A failure or timeout in either half refuses the push and cancels the other half, waiting for owned process cleanup before returning. A surviving helper is itself a refusal. Git sends the candidate only after both verdicts pass. Neither half publishes it or can authorize a push alone, so their execution order does not change protection. A push with no checks beyond privacy still runs privacy alone; pre-commit keeps its existing order.

Inside the admission, steps run in lanes at the same time. A lane runs its steps in order, and a failure in one lane stops the others through the existing group cancel in `runSteps`:

- lane A: types → eslint;
- lane B: touched tests → Linux backend → Linux tests;
- lane C (only on a push that changes the runtime set of C3): runtime verdict tests → Viewer build → MCP size budgets → Viewer runtime → runtime host → negative controls;
- lane D (same condition): native Codex ×3.

The outer owned-runner limit for the admitted phase is taken from `LLV_GATE_PUSH_DEADLINE` when the controller sets it. A manual push gets 15 minutes.

- Saves the queue waits, about 254 s on L and about 836 s on S, down to one wait per push. It also overlaps types (100–165 s) with tests.
- Keeps every check and both mandatory verdicts. The slot count still bounds how many pushes run heavy work at once. Each step keeps its 300 % scope and 8 GB cap.

### C3. Runtime chain and native Codex move to PR CI as a required check (decided, section 6)

Locally, `plan()` puts the runtime chain and native Codex in scope only when the push changes the `Dockerfile` (which carries the Bun pin), `src/runtime-host/**` or `bin/**`. Today's import-closure scope (37 of 40 pushes) leaves the local hook and is not carried to CI: on CI the jobs run for every PR.

On CI, `.github/workflows/bun-runtime.yml` gains a `pull_request` trigger beside `workflow_dispatch`. Its two jobs run unchanged on every PR: `bun-runtime` (verdict controls, MCP size budgets, Viewer build, `GET /` under the pin, runtime-host rehearsal, induced-failure controls) and the `native-codex-runtime` matrix. A new last job, `runtime-gate`, has `needs: [bun-runtime, native-codex-runtime]` and `if: always()`, and fails unless both results are `success`. Branch protection requires the one context `runtime-gate`.

- Why one gate job: matrix check names carry the Codex version (`native-codex-runtime (0.154.0)`). Required contexts named that way would have to be edited in branch protection on every supported-version change, and a forgotten edit leaves every PR waiting on a context that never reports. `runtime-gate` keeps one stable name.
- The `native-queue-campaign` job stays dispatch-only, as its `if` already says.
- The workflow's concurrency group already cancels a superseded head's run. A dispatch run uses the branch ref and a PR run uses `refs/pull/<n>/merge`, so they do not cancel each other.
- Auto-merge needs no code change: it reads required contexts from branch protection and holds the merge until each has reported green (`src/lib/forge/autoMerge.ts:342-346`).
- Saves about 820 s on L and about 650 s on S locally, measured serial.
- Costs: the merge wait is set by `bun-runtime` (4.9–5.4 min on its last dispatch runs) in place of privacy-publication, and each PR head uses about 10 more runner-minutes.
- Keeps every runtime protection, and widens it: the chain now runs for every PR, including the 3 of 40 that today's closure left out.

### C4. Split the two slow test files, and run branch-side files three at a time

Split `src/lib/pipelines/engine.test.ts` into `engine.<topic>.test.ts` files, cut at its top-level `describe` blocks, each under about 80 s. Do the same for `src/lib/monitor/seatTickController.test.ts`. The hook's stem rule (`scripts/local-gate.ts:75-77`) already selects every `engine.*.test.ts` when `engine.ts` changes, so selection does not change. `runFiles` then runs up to three files at once, each still in its own owned runner with a private HOME, TMPDIR, state and lock directory. A failure caused by running side by side recovers on the existing filtered reruns and ends as `FLAKY`, so it does not block.

- Saves: L's branch side goes from 449 s to about 120 s. Without the split, any push that touches `engine.ts` keeps a single 232–300 s file and lands at about 6 minutes.
- Keeps: the same tests and assertions, and the same five-minute budget per file.

### C5. Delete the baseline cache

After C1, a main-side sample only runs for failing files, filtered to the failing tests. That is seconds of work, and its key would differ on almost every push anyway. The cache (`prepareCache`, `validRun`, the integrity digest, the 32-entry eviction, the environment key, about 100 lines) is machinery with no remaining job. `dependencyGraph` stays for its node_modules link decision. If the reviewers want the cache kept, the minimum fix is to add `LLV_GATE_STEP` and `LLV_GATE_PUSH_DEADLINE` to the key's excluded variables at `scripts/local-gate-tests.ts:328`.

### C6. Pre-commit lints small selections without admission

ESLint on up to 40 staged files runs directly. Larger selections stay capped.

- Saves about 42 of 54 s on every commit. Lint itself takes about 4 s.
- Keeps the same rules and the same base comparison.

### C7. privacy-publication: run each self-test suite only where it can differ

- Trusted (main's) self-test suite: runs on `push` to main only. On a PR it is warning-only (`continue-on-error`) and identical for every PR at the same main commit.
- Candidate self-test suite: runs when the PR changes a file in the import closure of `scripts/privacy-*.test.ts` (computed by trusted code over the PR's file list with `executedPaths`, the same helper the platform scope uses), or the workflow itself.
- Saves about 230 s on a typical PR (5.2 → about 1.5 min) and about 115 s on a privacy PR (→ about 3.4 min).
- Keeps the trusted scan of every changed surface, commit message and merge boundary on every PR, unchanged. The candidate suite still runs whenever the candidate's privacy code differs from main's.

### C8. Docker PR image: arm64 only for install-recipe changes

`isMultiArchInput` drops `bin/`, `src/runtime-host/` and `src/lib/platform/`. These are TypeScript, `.mjs` and Python sources that the image build copies and does not compile per architecture. It keeps `Dockerfile`, the ignore files, `package.json`, `bun.lock`, `bunfig.toml`, `patches/`, `vendor/` and the entrypoint and install scripts.

- Saves about 25 min on PRs like #2762.
- Keeps: arm64 is still built for every recipe change and on every publication from main.

### C9. Windows (native): cache Bun's install cache

`actions/cache` on Bun's install cache, keyed by `bun.lock`.

- Saves about 60–120 s of the 83–144 s install (5.6 → about 4.6 min).
- Keeps everything.

### C10. One MCP build in the runtime chain

Order the chain as Viewer build (which builds MCP) → MCP size budgets, and drop the separate "build MCP" step.

- Saves 5–29 s of work plus one admission when the chain runs locally.

## 5. Expected after-times (estimates; the build stage measures them)

Local, normally loaded, C1–C6 and C10 applied:

| Push | Before (measured) | After, estimated | How |
| --- | ---: | ---: | --- |
| S, small app change | 25.3 min | about 3–4 min (about 2.5 with a warm `tsbuildinfo`) | privacy 9 s + one wait (single waits measured 6–190 s, typically about 40) + max(lane A ≈ 100–170 s, lane B ≈ 45 s) |
| L, touches `engine.ts` | 35.1 min, refused | about 4 min with C4, about 6 min without | privacy 38 s + wait + max(lane A ≈ 170 s, lane B ≈ 120 s with the split + 17 s platform) |
| `Dockerfile` (Bun pin), `src/runtime-host/**` or `bin/**` change (at most 3 of 40) | as L/S | about 8–9 min | lanes C and D run, because this is where the runtime check matters locally. The 5-minute target does not cover these pushes; the operator accepted that with option 1. |
| Pre-commit, 5 files | 54 s | about 12 s | |
| Push with no changed file | privacy only | unchanged | |

CI:

| Check | Before p50 / p90 | After, estimated |
| --- | --- | --- |
| privacy-publication | 5.2 / 5.7 min | about 1.5 min; about 3.4 min when privacy code changes |
| privacy-tracker-audit | 0.6 / 0.8 min | unchanged |
| `runtime-gate` (new, required): `bun-runtime` and `native-codex-runtime` ×2 in parallel | dispatch only; 4.9–5.4 and 2.3–2.8 min | about 5–5.5 min on every PR |
| Merge wait (required checks) | 5.3 / 5.8 min | about 5–5.5 min, set by `bun-runtime` |
| Windows (native) | 5.6 / 6.2 min | about 4.6 min |
| Journal startup, darwin-identity, scopes | 2.3, 1.6, 0.2–0.3 min | unchanged |
| Docker build | 5.1 min run, 30.5 min with arm64; queue p50 5.0, p90 22.3 | about 5 min run on every PR; the queue is unchanged (deferred, section 9) |

## 6. Decisions (operator, 2026-10-12 ~23:30Z, form «Перевірки за 3–5 хв · рішення»)

**Decision 1: where the runtime chain and native Codex run. Chosen: option 1.**

The current hook runs them on nine pushes out of ten, so they cannot stay there under 5 minutes. The options were:

1. **PR CI, as required jobs for every PR; locally only when the Bun pin, the Dockerfile, the runtime host or `bin/` change.** Local 3–4 min, merge wait about 5 min, every protection kept. **Chosen.** This explicitly supersedes the 2026-10-02 rule that a merge does not wait for the `bun-runtime` and native Codex jobs.
2. Only for pin, Dockerfile, runtime-host and `bin/` changes, plus the release rehearsal. Shortest merge (about 1.5–2 min), but an ordinary change that breaks serving the build is found only at the release candidate. Not chosen.
3. Keep them local as parallel lanes. About 8–9 min on nine pushes out of ten. Not chosen.

C3 describes the chosen form.

**Decision 2: what "a new failing test is caught on CI" means. Chosen: the batch merger's gate.**

Hosted CI has never run touched unit tests. A deliberately failing new test is caught by the local pre-push and, a second time, by the batch merger's tests gate before landing (`scripts/merge-batch.ts:352-358`). The acceptance check reads "on CI" as that gate. A hosted unit-test job is not added (section 9).

**The rest of the plan: approved in full.** C1 (branch first, main only for failing files), C2 (one admission, parallel lanes), C4 (split `engine` and `seatTickController` tests), C5 (delete the baseline cache), C6, C7 (privacy self-test on a PR only when privacy code changes), C8 (arm64 only for recipe changes), C9 (Bun cache on Windows), C10.

## 7. What each protection class keeps

| Protection | After this design |
| --- | --- |
| Privacy: files, commit messages, identities, merge boundary | Pre-commit privacy remains first. Pre-push privacy runs concurrently with isolated checks, retaining its mandatory verdict, refusal text and exit behaviour. The hosted trusted scan is unchanged on every PR. The candidate self-tests run whenever privacy code changes (C7). |
| New-failure detection | Every touched test file runs on the branch side. Every branch failure is sampled on the main side and confirmed exactly as today (C1). A red branch with no base sample blocks. The batch merger's tests gate is unchanged. |
| Bun pin: Viewer runtime and runtime host | Runs locally for every `Dockerfile` (pin), `src/runtime-host/**` and `bin/**` change, on CI for every PR as the merge-required `runtime-gate`, and in the candidate image at release (`verify-candidate`). |
| Native Codex contracts | On CI for every PR inside `runtime-gate`; locally with the runtime chain. |
| Types, lint | Unchanged; types still absolute, lint still compared with the merge base. |
| Platform (Linux locally; Windows and macOS on CI) | Unchanged selection; Linux tests also go branch side first (C1). |
| Image build | amd64 on every PR with image inputs. arm64 for recipe changes and every publication from main (C8). |

## 8. Files to change and tests

Fences: no open PR touches `scripts/local-gate*.ts`, `gate-slot.sh`, `owned-runner.ts`, `cpu-admission.ts` or `ci-platform-scope.ts`. #2792 changes `.github/workflows/publish.yml` and `.github/workflows/macos-newcomer.yml`, and this design changes neither.

| File | Change |
| --- | --- |
| `scripts/local-gate-tests.ts` | C1 branch side first, main side for failing files only. C4 up to three branch-side files at once. C5 delete the cache. |
| `scripts/local-gate.ts` | C2 one admission and lanes in `runSteps`/`plan`. C3 runtime and native scope narrowed to `Dockerfile`, `src/runtime-host/**`, `bin/**`. C6 uncapped small pre-commit lint. C10 chain order. |
| `src/lib/pipelines/engine.test.ts`, `src/lib/monitor/seatTickController.test.ts` | C4 split into `<stem>.<topic>.test.ts` files, assertions unchanged. |
| `.github/workflows/privacy-publication.yml` | C7 trusted suite on `push` only; candidate suite behind a trusted scope step. |
| `scripts/docker-image-scope.cjs` | C8 narrower `isMultiArchInput`. |
| `.github/workflows/platform-tests.yml` | C9 Bun cache on the Windows job. |
| `.github/workflows/bun-runtime.yml` | C3 `pull_request` trigger and the `runtime-gate` job; header comment updated (the job no longer runs by dispatch only). |
| Branch protection on main (a setting, changed by the seat after the workflow is on main) | C3 add `runtime-gate` to the required contexts. See the rollout order below. |
| `AGENTS.md` ("Local hooks mirror the publication gate"), `CONTRIBUTING.md` (touched-tests and cache paragraphs) | Describe branch-side-first, one admission, lanes, no baseline cache, and the new runtime placement: "Both halves run on scoped pre-push and by CI dispatch" becomes "on every PR as the required `runtime-gate`, and on pre-push when the pin, the Dockerfile, the runtime host or `bin/` change". #2641 edits one line of `AGENTS.md` near line 75, far from both sections. |

Rollout order for C3, so no PR waits on a context that cannot report:

1. Merge the PR that carries the workflow change. On that PR the new `pull_request` run reports `runtime-gate`; check its name and time there.
2. Then add `runtime-gate` to main's required contexts. Auto-merge caches the list per repository and base and picks the change up on its next read.
3. A PR whose head was pushed before step 1 has no `runtime-gate` run. It gets one on its next push, or on close and reopen (which keeps the head).

Tests (all by explicit path under `scripts/gate-slot.sh` with private HOME, XDG, TMPDIR and `LLV_STATE_DIR`):

- `scripts/local-gate-tests.test.ts`:
  - a green branch never clones the base (no `baseline` checkout in the sandbox, no base log line);
  - a base file that cannot finish, with a green branch, passes. This replaces "a baseline that exits without a complete report blocks";
  - a red branch samples only its failing files on the base: `NEW` blocks, `PRE-EXISTING` passes, and `FLAKY` confirmation keeps its counts;
  - a red branch with an unobtainable base is a blocking gate error;
  - three branch-side files run at once, measured with sleeping fixtures (wall below the sum) and each with its private roots;
  - the cache tests (`:26`, `:91`, `:222`, `:278`, `:287`, `:320`, `:335`) go with the cache.
- `scripts/local-gate.test.ts` and `scripts/local-gate.cpuQueue.test.ts`:
  - one queue ticket per push, with nested capped steps reusing the slot;
  - lanes run at once, and a failing lane stops the others and names itself;
  - privacy and admitted checks overlap; each refusal and timeout blocks when its peer passes;
  - privacy refusal while admitted checks run stops their detached helpers and preserves the privacy refusal text and exit code;
  - deadline handling and `NO_VERDICT` still hold per lane;
  - pre-commit lint is uncapped at 40 files and capped at 41;
  - the runtime chain and native Codex are planned for a push touching `Dockerfile`, `src/runtime-host/x.ts` or `bin/cli.mjs`, and absent for one touching only `src/lib/pipelines/engine.ts`.
- Privacy workflow contract test (the trusted/candidate ordering file): the trusted suite only on `push`; the candidate suite runs for a PR touching `scripts/privacy-publication-gate.ts` and is skipped for one touching only `src/components/**`.
- `scripts/docker-image-scope` test: `src/runtime-host/x.ts` gives `linux/amd64`, and `bun.lock` gives both.
- `scripts/local-gate.workflows.test.ts`, `scripts/bun-runtime-workflow.test.ts`: the workflow triggers on `pull_request` and `workflow_dispatch`; `runtime-gate` needs both jobs, runs with `if: always()` and fails on any result other than `success`; `native-queue-campaign` stays dispatch-only.
- Acceptance, measured by the build stage on this machine:
  - the before/after table of section 2 rerun for L, S and C, and CI timings from the PR's own runs, including `runtime-gate`;
  - a PR-shaped control for `runtime-gate`: the workflow's own "Prove each check goes red" step already shows the verifiers fail when their subject does not hold;
  - `scripts/local-gate*.test.ts` pass;
  - a branch adding `scripts/zz-red.test.ts` with `expect(1).toBe(2)` is refused by pre-push with `NEW` and by the batch merger's tests gate;
  - a doc line carrying a synthetic e-mail address is refused by pre-commit, pre-push and the hosted privacy-publication check.

## 9. Deferred — not currently justified

- **A cached main baseline shared across lanes.** After C1 the main side only runs for failing files, so there is little left to cache, and lanes rarely share a merge base.
- **Raising the gate scope's CPU quota.** `engine.test.ts` was no faster at 1200 %.
- **TypeScript's native compiler for the types step.** Types stay at 100–165 s, the floor of lane A. Revisit only if lane A becomes the long pole after C1–C4.
- **Restoring `.next/cache` in the CI runtime job.** Measure the job on PRs first; at about 5 min it meets the target. It is the first thing to try if the measured merge wait is above 5.5 min.
- **Skipping `runtime-gate` for prose-only PRs.** The decision is every PR. A scope step would add a second place that decides what the runtime chain covers.
- **Carrying today's import-closure scope to CI.** It selects 37 of 40 PRs, so it saves little and can only miss.
- **Removing the one-slot Docker PR build queue, or folding the PR image build into the runtime job.** The Docker job is not merge-required. Its queue (p90 22 min) delays no merge. The slot protects runners for the required checks.
- **A hosted touched-tests job.** Decision 2, section 6: not added. It would put 3–5 min on CI.
- **Fixing the baseline cache key alone.** Superseded by C5; kept as the fallback named there.
