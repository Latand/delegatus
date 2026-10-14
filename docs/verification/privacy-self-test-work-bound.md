# Privacy self-test work bound

## Trusted publication budget (2026-10-15)

[The merge-batch job](https://github.com/Latand/delegatus/actions/runs/38649189612/job/116143494762)
returned 124 in the candidate self-test step. Its trusted default-branch command
is `timeout --kill-after=5s 130s bun test scripts/privacy-*.test.ts`, under Bun
1.3.3. The workflow and its contract tests retain that command and budget.

The table measures that command after gate admission, serially on one machine,
with `CI=true`, private frozen-lockfile dependencies, installed OCR tools and
fresh isolated home/config/cache/tmp/state directories. The control URL points to a closed loopback port. The base is main
at `083158989fbdccb1f5fa21c39fdcd068c8b8a943`; the unmodified PR is the merged
`ecc7d6ef3a57ffd41a85e04567c51b00404b0d6e`. Later merged main commits leave the
privacy command and scanner unchanged.

| Version | Wall seconds | Exit | Margin under 130 seconds |
| --- | ---: | ---: | ---: |
| Main | 77.42 | 0 | 52.58 |
| Unmodified PR | 130.02 | 124 | 0 (timed out) |
| Reduced probes with independent concurrent cases | 74.72 | 0 | 55.28 |

Main passes 681 tests; the optimized PR passes all 684 tests. Repeating the
large escaped-string scans accounts for most of the added cost: the unmodified
PR completes only 13 bounded cases before cancellation. The smaller probes
reduce that CPU work, and independent children overlap through the existing
four-child cap. Every case retains its own result and cancellation guard.

All 135 shape/source pairs retain three CPU pairs, the 8x input ratio, the 32x
CPU growth limit, and finding/report assertions at both sizes. The final local
ratio range is 0.29x–20.54x. An 800/6,400 escaped-quote experiment failed the
unchanged limit (39.91x–55.80x under throttling) and was discarded. The retained counts are
3,200/25,600. Wall duration never decides a passing work-bound assertion.

The induced quadratic control rejects 43.92x CPU growth, with no guard
expiration. The reduced JSON inputs exposed overlapping whitespace suffixes
in that control: later samples reused preparation and incorrectly passed with
`CI=true`. Disjoint suffix ranges now keep each sample fresh. The same control
then exits 1. Cancelling the block-comment child still leaves the JSON peer
passing; the suite reports the induced failure.

At a kernel-verified 25% CPU quota (`cpu.max` 5000/20000), the same explicit
bounded-case filter reproduces main's 60-second batch cancellation and 15-case
cascade (61.90 seconds, exit 1). The optimized branch passes all 15 cases and
135 shape/source pairs in 314.47 seconds; its single-quote case passes after
312.34 seconds. The slow control uses a separate 600-second infrastructure
allowance, while the normal candidate command above retains 130 seconds.
Its CPU growth range is 0.48x–11.40x; descheduling does not supply the passing verdict.

## Original failure diagnosis (2026-10-14)

Both failed logs were read with `gh run view <run> --log-failed`. The baseline
for this comparison is `cff9cc6c461a2e6659ea03fdb99e87a1434e4c50`.

- [Run 38606903130](https://github.com/Latand/delegatus/actions/runs/38606903130),
  PR #2863: the candidate step started at 17:29:17.543Z and returned 124 at
  17:31:27.860Z. Tests were still completing at 17:31:27; there was no suite
  summary. The old `.github/workflows/privacy-publication.yml:212` wrapped the
  entire suite in a 130-second wall deadline based on an older 44.90-second
  measurement. Passing visible assertions did not mean the suite had ended.
  `test-preload.ts:19` forwards the run into the owned supervisor.
  `scripts/owned-runner.ts:91` lists live cgroup members before its exit causes
  systemd to stop the group. Those PIDs were active work at cancellation. The
  message is not an observation of survivors after cleanup. The outer timeout
  decided the step's result before the suite returned its own verdict.
- [Run 38613533863](https://github.com/Latand/delegatus/actions/runs/38613533863),
  PR #2865: the first bounded test returned child exit 137 after 60122.56 ms.
  In the baseline, `scripts/privacy-publication-gate.test.ts:2315` caches one
  promise for every specimen and source, and line 2355 kills that entire batch
  after 60 seconds. The first test's name describes one specimen, although its
  child runs all 15 specimens across all nine sources. Line 2368 gives every
  later test the same cached exit 137 and empty results, explaining their
  immediate `Expected: 0` failures. This is a harness cascade.

The hosted logs contain no CPU scheduling counters or scan profiles. They
establish the deadlines and cascade, without measuring the hosted machine's
CPU starvation directly. Controlled CPU contention reproduces the same batch
exit and cascade on unchanged baseline code. All 135 specimen/source pairs
pass CPU scaling on the head, including the expensive escaped-quote inputs.
The evidence supports expensive bounded work exceeding fixed wall allowances;
it supplies no evidence of a new quadratic scanner path in either incident.

## New contract

Each specimen has its own child and result in
`scripts/privacy-publication-gate.test.ts:2314`. Each source inspects a 1x input
and an 8x input. The probes use 3,200 repetitions for delimiter/string runs,
1,600 for regex classes and chained calls, 480 declarations, 64 unquoted
literals, and 160 JSON entries at 1x. These counts are 12.8% of the original
calibration counts, retaining the same input ratio and all 135 shape/source
pairs. Independent cases overlap through the existing four-child cap; process
CPU samples exclude CPU consumed by peer children. The original stress sizes
and results remain recorded below. Three paired CPU samples follow a discarded
small-input warm-up. Input shapes, findings and value-free reports are checked
at both sizes. Fresh bytes keep preparation cold for the first source and shared
for later sources at both sizes, preserving the production cache behavior.

`scripts/privacy-work-bound.ts:11` compares median process CPU consumption.
The 8x input must stay below 32x CPU growth. The multiplier permits overhead
above linear growth and rejects quadratic growth, which tends toward 64x.
Descheduling contributes no process CPU time. The original stress-size ordinary
ratios ranged from 0.69x to 12.70x. This is a growth bound on the retained specimens;
it is not a proof about every possible input or an absolute latency guarantee.

The Linux child guard samples process CPU ticks from `/proc/<pid>/stat`, binds
those observations to the captured kernel start time, and cancels after 120
CPU seconds. Its CPU accounting excludes descheduling. A ten-minute wall guard
and eleven-minute test guard provide infrastructure cancellation; other
platforms retain that wall guard. The CPU ratio decides bounded work. The
workflow retains main's 130-second candidate suite cancellation and three-minute
step deadline. The existing preload enters the owned runner; a timeout remains
a failure. This change requires no increase in the trusted workflow budget.

## Original negative controls and cleanup (2026-10-14)

With `LLV_PRIVACY_TEST_QUADRATIC=1`, the test wrapper rescans in proportion to
input size: one scan for 1x, eight for 8x, with fresh equivalent bytes to keep
preparation work present. It drives real `inspectPaths` calls. The JSON
specimen failed with **43.79x CPU growth**, against 32x, and suite exit 1.
Its child completed normally; the cancellation guard did not cause the failure.

With `LLV_PRIVACY_TEST_STALL_CASE='unclosed block comments'`, that child's
100-ms induced cancellation returned 137. The following JSON test passed and
the suite returned 1. `scripts/privacy-test-process.test.ts:5` also verifies
that cancellation releases queue capacity for five independent passing children.

A guard control verifies that a sleeping child completes within the CPU
allowance, while a spinning child is stopped specifically by the CPU guard.
It asserts the cancellation reason so the wall guard cannot satisfy that check.

The existing `scripts/owned-runner.integration.test.ts` probes for `exit` and
`deadline` both passed. They observe the fixture and detached child becoming
dead, drain the owning scope, and preserve recorded bystanders. The stronger
stress run also found zero extra live owned processes after every base and head
invocation, and zero load-worker survivors after cleanup.

## Original stress comparison (2026-10-14)

The final comparison used Bun 1.3.3 and two fresh isolated executions per side,
alternating base and head. An outer `scripts/gate-slot.sh` admission contained
the collector and its recorded busy worker. Each test execution entered its own
owned runner before `taskset` pinned it to CPU 2, together with that busy worker.
All **15 bounded specimens and nine sources** ran on each head invocation.
The scanner/test sources were frozen in a separate archive before comparison.

The same explicit path and filter were used on both sides:

```sh
bun scripts/owned-runner.ts taskset -c 2 bun test \
  scripts/privacy-publication-gate.test.ts \
  --test-name-pattern 'all sources stay bounded'
```

Each invocation set fresh `HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `TMPDIR`
and `LLV_STATE_DIR`. The collector's safety guard was thirty minutes, allowing
CPU contention to slow the whole matrix while its per-case CPU guard remained
active. The baseline was an archive of the pinned commit with the same
installed dependencies. The worker used `for (;;) { Math.sqrt(Math.random()); }`
under the same affinity, and was killed and awaited by its recorded handle.

| Repetition | Base exit | Head exit | Base wall seconds | Head wall seconds | Extra live owned processes |
| --- | --- | --- | --- | --- | --- |
| 1 | 0 | 0 | 59.723 | 271.131 | 0 on both sides |
| 2 | 1 | 0 | 60.894 | 264.950 | 0 on both sides |

The complete-matrix failure rates are **base 1/2 (50%), head 0/2 (0%)**.
The red base run reproduces child exit 137 near its 60-second batch cap and
immediate failures for every following specimen. Both head runs pass all 15
cases, with zero extra live owned processes after each invocation and zero
load-worker survivors after the collector returns. Small samples describe
this reproduction and do not estimate a general hosted-runner probability.

### Earlier focused comparisons, 2026-10-14

Before refining the CPU cancellation guard, two collectors each ran five
alternating base/head pairs with the filter
`(unclosed block comments|large quoted JSON): all sources stay bounded`.
Their own recorded load workers were pinned with the tests to CPU 0. The
collectors overlapped for part of the experiment, and background load varied.

| Owned load workers | Base failures | Head failures |
| --- | --- | --- |
| 2 | 3/5 (60%) | 0/5 (0%) |
| 4 | 3/5 (60%) | 0/5 (0%) |

The subsequent whole-matrix run exposed the initial 120-second wall guard:
a single-quote case was cancelled while the following case passed. Charging
that guard in CPU seconds removed this additional scheduling dependency.
Overlapping experiments also exhausted an overall ten-minute collector
limit; those incomplete invocations prompted the longer safety allowance and
separate CPU affinity in the final complete-matrix comparison above.

Per-run exits/timings, CPU samples, guard controls and source hashes are in
[the samples file](privacy-self-test-work-bound.samples.json). Earlier focused
rows are labelled separately from the final full matrix. The full touched
files are verified separately from the stress filter.

## Original verification (2026-10-14) and workflow provenance

Touched files are run by explicit path through `scripts/gate-slot.sh`, with
isolated home, config, temporary and state directories. The full run needs the
workflow's OCR tools and language data. Test-only environments also clear
inherited Git author/committer overrides and hook configuration so fixture
identities come from each fixture's own configuration. Publication commands
retain the launched agent's credentials, identity and hooks.

The three touched files passed 663 tests in a clean isolated environment.
After reducing warm-up to the small input, the latest bounded-only run also
passed all 15 specimens. The two existing owned-runner probes, typecheck,
changed-file lint and privacy gate passed. The gate uses
`LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE` pointing to the committed catalog
and `--require-known-values --base <merge-base>`.

`pull_request_target` reads main's workflow and trusted scanner. The candidate
command remains `timeout --kill-after=5s 130s bun test scripts/privacy-*.test.ts`.
The candidate suite must pass under that command before merge. A larger
workflow cancellation budget would need its own follow-up and is unnecessary
for the reduced probes.
