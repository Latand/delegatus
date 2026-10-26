# Privacy gate and per-PR test runs: cost, catches, cuts (audit, 2026-10-25)

Read-only audit. Code at `main` `b027e190da6a4cb1ce1a38cf10c87d198ae3bc39`
(2026-10-25 19:29 UTC); line numbers in §1–§4 refer to it. Measured 2026-10-25
21:30–22:35 UTC on this 24-CPU machine. Main then moved to `9b610803`
(2026-10-25 22:39 UTC). Of the cited lines, only working rule 12 in
`src/lib/roles/defaults.ts` moved (`:54` to `:56`). §6 cites `9b610803`.

## Decisions (2026-10-26)

The orchestrator seat decided these under full autonomy, because on 2026-10-25 the operator asked for the gate and per-PR tests to be cut urgently. Each decision accepts the recommendation in §5. §6 splits the work into slices.

| # | Decision | Not chosen |
| --- | --- | --- |
| 1 | Local privacy runs only at pre-push. It scans the lines each pushed commit adds, plus commit messages and identities. The hosted check keeps reading whole files. Pre-commit runs no privacy check. This closes the added-then-removed gap (§2). | whole files with an indexed rule search; hosted only; remove everywhere |
| 2 | Keep the learned-rule texts in the pre-push scan. | stop passing them |
| 3 | The local runtime lane runs only when `Dockerfile` changes; the Bun pin is in that file. Other `bin/` and `src/runtime-host/` changes rely on the hosted `runtime-gate`. | keep the current AGENTS.md rule |
| 4 | Stages run only their own tests, without whole-program `tsc`. The pre-push at publication stays the one full check, and a nightly full run is added. Stage check runs are counted for one day first. | keep the current practice |

## Originating requirement

Operator, 2026-10-25 about 21:05 UTC, orchestrator chat, voice, Russian, verbatim:

> «Так, надо срочно резать privacy publication gate. Мне кажется, что он... он
> прям сильно. Много занимает ресурсов. Мне кажется, нахуй не нужно. Только
> гонять. Также тесты: нет смысла гонять все тесты для каждого pull request, а
> только те, которые затрагивают. Этот pull request в те файлы. Что-то такое
> нужно сделать. А privacy gate вообще нужно глянуть. Есть ли вообще в нём
> смысл? Он ебанутый какой-то. Там, скорее всего, какие-то регулярки или что.»

## Answers

| Question | Answer |
| --- | --- |
| Is the privacy gate expensive? | Per run, yes. A pre-push scan of a typical lane (11 files, 5 commits) took **145, 190 and 223 CPU-seconds** at load 12–31, and **442** at load up to 100. It used 1.2–1.4 GiB and runs outside the CPU queue. Machine-wide it was **about 1.1 of 24 cores**; checks run through the gate wrapper used **7.8 cores**. |
| Is it the regexes? | No: all regex detectors together cost **under 1%**. **73%** is an exact search for each of the 5,850 stored learned-rule texts, one at a time, through every decoded view of every changed file. **18%** is hashing for the 9-entry committed catalog. |
| Why so much input? | Every changed file is read whole: 737 changed lines meant 4.39 MB. A 2.9 MB browser test and the 1 MB `engine.ts` are touched often. Decoded views are 11–26× the file size. |
| Does it catch anything? | Yes: **about 8 real catches** in October, all identities or account labels in commit metadata or fixtures. **No real credential**: the 5 credential hits were test fixtures. No retained record shows a learned-rule hit. 24 commits changed the gate itself in October; about 8 of them fixed false alarms. |
| Cheapest big cut | Scan only the lines each pushed commit adds (3 lines of context), plus messages and identities: **0.80–0.94 CPU-seconds** on the same lane. It also closes a gap: content added and then removed within one push is never scanned today. |
| Do all tests run on every PR? | No. Pre-push runs the changed tests plus tests sharing a changed file's name stem: **11–115 of about 2,290 files** on seven lanes. CI has no full suite and nothing runs nightly. The CPU goes elsewhere: stage agents' own runs **63%** of gate CPU, branch/base re-runs **22%**, whole-program `tsc` **44%** of a 15-minute sample. The runtime lane fires on any `bin/` or `src/runtime-host/` change, and an `engine.ts` edit pulls in 48 test files. |

## 1. Privacy gate cost

### 1.1 Measurements

Runs used the scanner at `b027e190` inside `scripts/gate-slot.sh`, timed by `/usr/bin/time` after admission. Each run had a private HOME, XDG, TMPDIR, `LLV_STATE_DIR` and a fresh fingerprint cache, under Bun 1.4.0. Input: lane head `785468d0`, base `7a792516`, 11 files, 5 commits, 4,391,660 bytes. "Rules file" is a frozen copy of the learned-rules file that agents and the publication push pass to the gate. It held 5,850 lines and 1.14 M characters; on 2026-10-12 it held 922 lines (`docs/design/privacy-gate-cost.md`).

| Run | Scanned | Rules file | CPU-s | Wall s | Peak RSS MiB | Load 1/5/15 before → after |
| --- | --- | --- | ---: | ---: | ---: | --- |
| r1 | pre-push mode | on | 190.2 | 189.7 | 1,241 | 31.4/42.0/49.1 → 12.7/29.0/42.7 |
| r2 | pre-push mode | on | 223.4 | 222.3 | 1,441 | 12.7/29.0/42.7 → 17.3/22.8/37.2 |
| r3 | pre-push mode | on | 145.2 | 143.9 | 1,332 | 17.3/22.8/37.2 → 19.0/19.8/33.7 |
| r0 | pre-push mode, heavy load | on | 442.3 | 561.1 | 1,435 | 25.9/32.9/44.2 → 69.8/69.0/57.6 |
| c1, c1b | pre-push mode | off | 63.5, 43.1 | 67.2, 41.1 | 1,391, 1,228 | 48.5 → 47.7; 15.9 → 15.2 |
| c2 | messages and identities only | on | 0.21 | 0.21 | 88 | 47.7 → 38.0 |
| c4 | 10 files, without the 2.9 MB test | on | 114.9 | 123.6 | 439 | 35.6 → 53.3 |
| k1 | the 2.9 MB test alone | off | 26.1 | 25.0 | 1,019 | 18.1 → 15.9 |
| p1 | `journal.ts` alone (203 KB), profiled | on | 45.9 | 47.4 | 686 | 31.9 → 33.0 |
| h1–h3 | the lane's diff hunks, 3 context lines (49 KB) | on | 0.80–0.94 | 0.75–0.99 | 117 | 52.7 → 28.2 |

Every run passed. CPU time for identical work varied 1.5× at similar load and 3× near load 100, so the load is recorded beside each row.

### 1.2 Where the time goes

| p1 profile share | Code | Work |
| ---: | --- | --- |
| 36.7% | `scripts/privacy-publication-gate.ts:1849-1852` | each rule text searched separately through the normalized text |
| 36.5% | `scripts/privacy-publication-gate.ts:1462` | each compacted rule text searched separately through the compact text |
| 18.1% | `scripts/privacy-publication-gate.ts:1376-1427` | SHA-256 of every window for the catalog |
| < 1% together | `src/lib/privacy/staticDetectors.ts` and helpers | every regex detector |

Whole files are read (`:1237-1254`, `:1862`). NUL bytes add UTF-16 views (`:1898`), so `journal.ts` (203 KB) becomes 5.24 M normalized characters, and the 2.9 MB test becomes 32.1 M. A scratch benchmark of the same 5,850 texts over raw text took 110 ms and 1,752 ms as a plain loop. A 22-character window index took 14 ms and 148 ms, with identical results.

### 1.3 Where it runs

| Place | Code | Reads | Rules file | Runs per lane |
| --- | --- | --- | --- | --- |
| Pre-commit hook | `scripts/local-gate.ts:58-64` | whole staged files | agent commits yes (`src/lib/git/agentPublicationIdentity.ts:29`); engine commits no (`src/lib/pipelines/git.ts:799`; 0 of 167 Viewer processes carry it) | one per commit; median 8 commits (36 branches) |
| Pre-push at publication | `scripts/local-gate.ts:917-951`, `src/lib/pipelines/git.ts:2248-2259` | whole changed files, all messages, merge identities | yes | 1.79 attempts plus 0.62 retries (mean, 270 lanes, 10-22 to 10-25) |
| Manual `privacy:check` or direct run | `package.json:43`, working rule 12 (`src/lib/roles/defaults.ts:54`) | as pre-push | inherited | 1 of 13 sampled runs (413 CPU-s) |
| PR title and body | `src/lib/pipelines/stagePullRequest.ts:170-178` | two small files | no | 2 per PR write |
| Merge batch | `scripts/merge-batch.ts:361`, `:1006-1024` | batch diff, messages, body | no | 3 per batch |
| Hosted required check | `.github/workflows/privacy-publication.yml:180-185` | whole changed files, messages, identities, media OCR | no | 1 per PR push (2,500 in October, p50 161 s on GitHub) |

The privacy step has no `capped` flag (`scripts/local-gate.ts:58-64` against `:912`), so it bypasses CPU admission. Media OCR is deferred locally because `tesseract` is absent (`:170-171`).

### 1.4 Machine share

A process sampler (1 s, 21:42–22:12 UTC) saw 13 runs: 7 pre-push, 4 pre-commit, 2 manual. They used about 1,920 CPU-s inside the window, **about 1.1 cores**, with up to 4 at once; one pre-commit reached 1,120 CPU-s. Gate-wrapper units used 676,418 CPU-s over 24 hours (**7.8 cores**, all projects, from the systemd journal), and `sar` shows 13 busy cores on average. About 66 lanes start a day, so privacy is roughly 1,400 CPU-s per lane and **about 12% of check CPU**.

## 2. What it catches

| Hosted `privacy-publication` | Runs | Failed | Failures with a content finding |
| --- | ---: | ---: | --- |
| 2026-10-01 to 10-25 | 2,500 | 138 | 31 on 16 branches. The rest: 82 self-tests, 17 "range unreadable", 4 provisioning, 2 with no class, 2 cancelled |
| 2026-10-19 to 10-25 | 1,214 | 10 | 0 |

Real catches, 2026-10-01 to 10-25, from hosted logs and pipeline records (1,393 Delegatus lanes retained):

| Catch (no values) | By | Before the branch was public? |
| --- | --- | --- |
| Engine commits carried a personal mailbox identity | local pre-push, 10-01 | yes |
| A co-author trailer named a personal domain | merge batch, 10-02 | no |
| An inherited author identity on a pushed commit | local and hosted, 10-02 | no |
| An account label in test fixtures, already on main | local and hosted, 10-02 | no |
| Attributable mailboxes and a known value in merge identities | hosted, 10-03 | branch yes, main no |
| An author identity with a known value (3 runs) | hosted, 10-02 | branch yes, main no |
| An identity that would compose an attributable trailer | hosted, 10-13 | branch yes, main no |
| Known values in commit messages (2 branches) | hosted, 10-01 to 10-02 | branch yes, main no |

Three more are unconfirmed (10-09, 10-21, and one test line). Nearly all real catches sit in commit metadata, which the 0.2 s message and identity check reads.

| False alarm or gate defect | Effect | Fixed by |
| --- | --- | --- |
| An approved public relay origin read as a known value | 6 runs, 2 PRs blocked | #2414, #2479 |
| systemd unit names, then versioned package names, read as emails | a lane and PR #2421 blocked | #2429, #2456, #2464 |
| A common phrase read as a known value | issue #2261 | #3282 |
| Credential-shaped test fixtures | 5 runs, 4 lanes | #2701, lanes for #2729, #2730 |
| "range unreadable" when the base is not an ancestor | 17 runs, 10-02 to 10-23 | a lane on 10-23 |
| Self-test failures | 82 hosted runs | #2457, #2503, #2745, #2874, #3300 |

| Surface | Pre-commit | Pre-push | Hosted |
| --- | --- | --- | --- |
| Changed files: catalog and regex detectors | staged | whole files | whole files |
| Learned-rule texts | agent commits | yes | no |
| Messages and merge identities | no | yes | yes |
| Media OCR | deferred | deferred | yes |
| Content added then removed within one push | no | no | no |
| Runs before the branch is public | n/a | yes | no; it blocks the merge |

Gap, shown in scratch. The first commit of a two-commit push added a home-directory path and the second removed it. Pre-push mode answered `PRIVACY GATE: PASS`; the first commit's file alone gave `home_path: 1`. GitHub keeps a PR's commits reachable after the branch is deleted. This repository is public: only the local gate runs before a push publishes.

## 3. Tests per PR

| Step | Selection | Code |
| --- | --- | --- |
| touched tests | changed test files plus `<changed stem>.*.test.*`; the branch runs first, then failing files re-run on the merge base | `scripts/local-gate.ts:81-93` |
| Linux tests | the 17-file platform list, when a changed file is in its import closure or under `src/lib/proc/` | `scripts/local-gate.ts:94-99`, `:181` |
| runtime lane | any `Dockerfile`, `bin/` or `src/runtime-host/` change: Viewer build, runtime verifiers, native Codex ×4 | `scripts/local-gate.ts:100-117`, `:176` |
| types | `bunx tsc --noEmit` on every push that is not prose-only | `scripts/local-gate.ts:70` |
| CI | scoped platform and macOS jobs; `runtime-gate` and `typecheck` (`tsc --noEmit`) on every PR, both required on main; no full suite, no nightly run | `.github/workflows/bun-runtime.yml:29-30`, `:341`; `memory-selection.yml:3-7`, `:17-46` |

Seven recent lanes, using `plan` from `scripts/local-gate.ts` at `b027e190` (2,283–2,290 test files that do not run in a browser):

| Head | Changed | Touched tests today | Tests importing a changed file | Transitive reach | Linux list | Runtime lane |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| `2ff2613c` | 8 | 13 | 9 | 1,486 | 17 | yes |
| `785468d0` | 11 | 20 | 131 | 1,501 | 17 | yes |
| `d62bfe94` | 15 | 11 | 54 | 1,560 | 17 | yes |
| `b3802bf5` | 18 | 37 | 348 | 1,505 | 17 | yes |
| `f601fedf` | 20 | 77 | 411 | 1,507 | 17 | no |
| `80bd3d11` | 25 | 62 | 185 | 1,474 | 17 | no |
| `ecda0797` | 42 | 115 | 427 | 1,488 | 17 | yes (one `bin/` script) |

"Changed files plus their direct tests" would run 3–9× more files on six of the seven lanes. Transitive reach covers 65–68% of all tests.

| Gate CPU, 24 h (676,418 CPU-s, all projects) | Share |
| --- | --- |
| Stage agents' own commands (per stage: p50 587, p90 4,288 CPU-s; 283 stages) | 62.8% |
| Branch/base comparator file runs | 22.1% |
| Pre-push admitted checks | 9.6% |
| Other | 5.5% |

A 15-minute sample of live units (22:06–22:21 UTC) split by command. `tsc` was 44%: 10 runs at 190–500 CPU-s each, from hooks, review exports and stages. `bun test` was 27%: 142 runs, median one file each. Non-Delegatus pytest was 25%.

## 4. Options, cheapest first

| Privacy option | CPU saved (basis) | Risk added | Recommendation |
| --- | --- | --- | --- |
| A. No privacy at pre-commit; keep pre-push | about 0.4 core (35% of §1.4) | none for exposure: commits are not public before the push; a refusal surfaces one step later | do |
| B. Pre-push scans the lines each pushed commit adds (`git log -p -U3 base..HEAD`), plus messages and identities | about 99% per scan (0.80–0.94 against 145–442 CPU-s); with A, about the whole 1.1 cores | unchanged lines of touched files are not re-read locally; they are already on main, and hosted still reads whole files. Values split beyond 3 context lines may slip locally. Closes the gap | do; `privacy:check` uses the same mode |
| C. One indexed pass over the rule texts | about 73% of a whole-file scan (profile; 8–12× in the benchmark) | none with an equivalence test | only if whole files stay local |
| D. Cache verdicts by pushed head | up to 26% of pre-push runs | stale verdicts if the key misses an input | not needed after B |
| E. Drop `--check-commits` locally | 0.16 CPU-s (c2) | loses the class with most real catches | reject |
| F. Stop passing the rule texts | about 70–80% of a scan today; under 1 s after B | a rule copied into public text goes out | keep them |
| G. Hosted only, no local gate | about 1.1 cores today, about 0 after A and B | every leak is public at push; rule texts unchecked | reject |
| H. Remove everywhere | as G | 7 of the 8 catches would have reached main | reject |

| Test option | CPU saved (basis) | Risk added | Recommendation |
| --- | --- | --- | --- |
| T1. Keep the stem rule | avoids a 3–9× increase | none | do |
| T2. Stages run only their touched tests and no full `tsc`; publication's pre-push is the one full check | part of the 62.8% stage share and of `tsc`'s 44%; the split per stage is unmeasured | errors found at publication, one repair turn later | do after a one-day count |
| T3. Runtime lane locally only for `Dockerfile` or Bun pin changes; hosted `runtime-gate` covers the rest on every PR | fired on 5 of 7 lanes; not measured | runtime-host regressions found after the push; AGENTS.md now requires the local run | operator decides |
| T4. Narrow the Linux-list trigger | ran on 7 of 7 lanes; not measured | Linux behaviour of indirect changes unchecked before push | measure first |
| T5. Nightly full run on main | adds a daily run; not measured | none; red tests already reach main (#3300, #3348) | do with T2 |

## 5. Questions for the operator (settled 2026-10-26, see Decisions)

1. **Local privacy scope.** (a) Pre-push only, scanning the lines each pushed commit adds plus messages and identities; hosted keeps whole files. (b) Keep whole files locally with the indexed rule search (C), and no pre-commit run. (c) Hosted only. (d) Remove everywhere. **Recommended: (a):** about 99% cheaper, still before publication, and it closes the gap.
2. **Learned-rule texts at push.** (a) Keep. (b) Stop. **Recommended: (a);** under a second after 1(a).
3. **Runtime lane for `bin/` and `src/runtime-host/`.** (a) Local only for `Dockerfile` or pin changes. (b) As AGENTS.md says now. **Recommended: (a);** the hosted job runs on every PR.
4. **Stage checks.** (a) Touched tests only in stages, one full check at publication, a nightly full run. (b) As now. **Recommended: (a)** after a one-day count of `tsc`, test and build runs per stage.

## 6. Implementation slices

Lines refer to `main` `9b610803`. S1, S3 and S4a can start now. S4b and S4c land together after S4a. Decision 2 has no slice of its own: S1 keeps `--require-known-values` and the rules-file input.

| Slice | Change and files | Acceptance: hostile input → observable result | CPU saved |
| --- | --- | --- | --- |
| **S1** (decisions 1, 2): pre-push scans added lines | `scripts/privacy-publication-gate.ts`: a new selection reads each commit in `base..HEAD` as its added lines with 3 context lines, and replaces the whole files from `changedPaths` (`:1237-1254`, chosen at `:2915-2920`). A binary file is read as each new blob, once per blob id. Working-tree and untracked files (`:1243-1245`) are never pushed and drop out. The catalog, regex detectors and rule texts run on this text. Messages and merge identities stay as they are (`:2934-2945`). `scripts/local-gate.ts:58-64`: no privacy step at pre-commit; pre-push uses the new selection. `package.json:43`: `privacy:check` uses it too. Tests: `scripts/privacy-publication-gate.test.ts`; `scripts/local-gate.test.ts:80-90`, `:552-560`. Docs: `AGENTS.md:91-92`, `CONTRIBUTING.md:262-263`. Unchanged: the hosted workflow, the PR text check, the merge batch, the publication rules-file env (`src/lib/pipelines/git.ts:2248-2259`) and `src/lib/git/agentPublicationIdentity.ts:29`, which still feeds pushes made outside pipelines. | Each of these is refused with its class: a home path added in commit 1 and removed in commit 2 (this passes today, §2); a stored rule text on an added line; a known value in a message or merge identity; a binary blob holding a value that a later commit removes. A staged credential-shaped line commits with no privacy step, and the push refuses it. Rerun h1–h3 and r1–r3 on `785468d0` against `7a792516` three times each, with the load recorded. | about 1.1 cores, down to about 0 (§1.4; 0.80–0.94 against 145–442 CPU-s per scan) |
| **S3** (decision 3): local runtime lane only on `Dockerfile` | `scripts/local-gate.ts:176`: `runtimeChanged` becomes `Dockerfile` only; it feeds `runtime` and `native` (`:182-183`). `scripts/local-gate.test.ts:809-815`: the `bin/` and `src/runtime-host/` cases become false; `:577-589` is rechecked. `AGENTS.md:242-243` and `.github/workflows/bun-runtime.yml:11-12` (comment). Kept: hosted `runtime-gate` on every PR (`bun-runtime.yml:29-30`, `:341-353`), required on main (branch protection read 2026-10-25 22:58 UTC: privacy-publication, privacy-tracker-audit, runtime-gate, typecheck). The batch merger lands only when every required check is green (`scripts/merge-batch.ts:1107-1139`), and runtime-host changes keep three review rounds. | The plan for `bin/x.mjs` or `src/runtime-host/x.ts` has no runtime or native step; for `Dockerfile` it keeps all of them. A PR that breaks the host turns `runtime-gate` red, and the merger leaves it unmerged. | the lane fired on 5 of 7 sampled lanes; time one run before the change |
| **S4a** (decision 4): one-day count | No repository change. A 24-hour sampler reads live `delegatus-gate-*` units every 5 s: the main process's argv gives the command class (`tsc`, `bun test`, build, other) and the caller's TMPDIR gives the caller (stage, pre-push, merger, reviewer). Per-unit CPU comes from the journal's `Consumed` lines. Unit descriptions name only the runner file (`scripts/owned-runner.ts:184-198`), so the journal alone cannot split by command. Keep the output in a lasting folder outside the repository, named in the task. | A table of runs and CPU-s per caller and command, whose total matches the journal's gate CPU for the same day within 10%. | measures S4b |
| **S4b** (decision 4): stages skip whole-program checks | `AGENTS.md`: stages run, by path, the test files their change touches. They run no `bunx tsc --noEmit`, no full suite and no `bun run build` unless the brief names one. The pre-push at publication is the full check. The seat's briefs say the same. Unchanged, because they ship to every project: `src/lib/pipelines/testGuidance.ts:13` and `src/lib/roles/defaults.ts:133`. Already in place: pre-push types and touched tests at publication (`scripts/local-gate.ts:70`, `:81-93`; `src/lib/pipelines/git.ts:2248-2259`) and the hosted required `typecheck`. | A day counted the S4a way shows stage `tsc` runs near 0. A type error a stage leaves is refused at publication and gets one repair turn. | part of the stage share (62.8%) and of `tsc` (44%); S4a sizes it |
| **S4c** (decision 4): nightly full run | New `.github/workflows/nightly-tests.yml`: `schedule` once a day on main, plus `workflow_dispatch`, with Bun from the Dockerfile pin (as in `memory-selection.yml:25-35`). It runs every `*.test.*` file except `*.browser.test.*` in shards, each with a private HOME, XDG_CONFIG_HOME, TMPDIR and `LLV_STATE_DIR`. It runs no type check, because `typecheck` already runs on every PR and every push to main. It is required nowhere: no lane, merge or wake waits on it, and the seat turns a red night into a fix task. | The first night reports its duration and the reds already on main. A test broken on purpose in a scratch branch run by dispatch turns the run red. | no local CPU; adds hosted time only |

## Deferred — not currently justified

- Indexed rule matching (C) and a verdict cache (D): not needed now that 1(a) is chosen.
- Dropping the local pre-push `tsc` in favour of the hosted required `typecheck`: not decided; it would move type errors past publication.
- Changing the shared stage prompts for every project: decision 4 is a rule for this repository.
- An incremental `tsc` cache: not timed seeded on a real change against a cold run.
- Narrowing the Linux trigger, selecting `engine.*` tests by changed export, and reworking catalog hashing: not measured, or small after B.

## Method

Scanner and input were scratch clones. The rules file was copied once and never printed. The scan command was `scripts/gate-slot.sh /usr/bin/time bun scripts/privacy-publication-gate.ts --repository <input> --base 7a792516 --require-known-values --check-commits`, with the hook's catalog and OCR variables. The profile used `bun --cpu-prof-md`. Text sizes came from a scratch copy with one log line added; its timings, which overlapped r1, are discarded. Lane counts came from a `VACUUM INTO` copy of the state database (21:55 UTC). Hosted results came from `gh run list`, the jobs API and the job logs of every failed October run. Gate CPU came from `journalctl --user` (`Started`/`Consumed` lines of `delegatus-gate-*` units) and a 15-minute cgroup sample. Branch protection and workflow states were read with `gh api` and `gh workflow list` at 22:58 UTC.
