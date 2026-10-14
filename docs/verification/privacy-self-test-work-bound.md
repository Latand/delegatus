# Privacy self-test work bound

## Failure diagnosis

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
`scripts/privacy-publication-gate.test.ts:2308`. Each source inspects a 1x input
and the original full-size 8x input. Three paired CPU samples follow a discarded
warm-up pair. Input shapes, findings and value-free reports are checked at both
sizes. Fresh bytes keep preparation cold for the first source and shared for
later sources at both sizes, preserving the production cache behavior.

`scripts/privacy-work-bound.ts:11` compares median process CPU consumption.
The 8x input must stay below 32x CPU growth. The multiplier permits overhead
above linear growth and rejects quadratic growth, which tends toward 64x.
Descheduling contributes no process CPU time. The observed ordinary ratios
range from 1.12x to 27.46x. This is a growth bound on the retained specimens;
it is not a proof about every possible input or an absolute latency guarantee.

The per-child 120-second guard and per-test 150-second guard are cancellation
limits. The CPU ratio decides bounded work. The workflow gives the existing
owned runner a ten-minute cancellation guard inside a twelve-minute step, in
both trusted and candidate test commands. `systemd-run --wait` and
`KillMode=control-group` in `scripts/owned-runner.ts:128` let cleanup finish
before the command returns. Finite infrastructure cancellation remains a
failure and cannot become a passing work verdict.

## Negative controls and cleanup

With `LLV_PRIVACY_TEST_QUADRATIC=1`, the test wrapper rescans in proportion to
input size: one scan for 1x, eight for 8x, with fresh equivalent bytes to keep
preparation work present. It drives real `inspectPaths` calls. The JSON
specimen failed with **43.10x CPU growth**, against 32x, and suite exit 1.
Its child completed normally; the cancellation guard did not cause the failure.

With `LLV_PRIVACY_TEST_STALL_CASE='unclosed block comments'`, that child's
100-ms induced cancellation returned 137. The following JSON test passed and
the suite returned 1. `scripts/privacy-test-process.test.ts:5` also verifies
that cancellation releases queue capacity for five independent passing children.

The existing `scripts/owned-runner.integration.test.ts` probes for `exit` and
`deadline` both passed. They observe the fixture and detached child becoming
dead, drain the owning scope, and preserve recorded bystanders. The stronger
stress run also found zero extra live owned processes after every base and head
invocation, and zero load-worker survivors after cleanup.

## Stress comparison

Both experiments used Bun 1.3.3 and five fresh isolated executions per side,
alternating base and head. An outer `scripts/gate-slot.sh` admission contained
the collector and load workers. Each test execution entered its own owned
runner before `taskset` pinned it to CPU 0. Load workers were recorded by PID,
pinned to that CPU, and killed and awaited through those recorded handles.
The two collectors overlapped for part of the experiment; unrelated machine
load also varied. The counts below identify each collector's own load workers.

The same explicit test path and filter were used on both sides:

```sh
bun scripts/owned-runner.ts taskset -c 0 bun test \
  scripts/privacy-publication-gate.test.ts \
  --test-name-pattern '(unclosed block comments|large quoted JSON): all sources stay bounded'
```

Each run set fresh `HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `TMPDIR` and
`LLV_STATE_DIR`; its outer owned cancellation guard was 180 seconds. The base
checkout was an archive of the pinned commit with the same dependency tree.
Filtering the baseline still runs its entire cached matrix, exposing the
original first-case timeout and following-case cascade. Head filtering runs
only those two independent specimens. These are stress rates for the selected
regressions; the full touched files are verified separately.

| Owned load workers | Base failures | Head failures | Base wall seconds | Head wall seconds |
| --- | --- | --- | --- | --- |
| 2 | 3/5 (60%) | 0/5 (0%) | 52.017, 57.532, 60.727, 61.165, 60.916 | 9.110, 9.570, 19.543, 17.263, 17.350 |
| 4 | 3/5 (60%) | 0/5 (0%) | 61.136, 61.659, 61.313, 43.690, 42.386 | 19.982, 22.547, 7.624, 7.137, 7.932 |

Every failing base run shows child exit 137 near the batch's 60-second cap,
then an immediate failure for the following JSON case. All head invocations
returned 0. Per-run CPU samples, exit codes and cleanup observations are in
[the samples file](privacy-self-test-work-bound.samples.json). Five observations
per experiment demonstrate this reproduction; they do not estimate a general
hosted-runner failure probability.

## Verification and workflow provenance

Touched files are run by explicit path through `scripts/gate-slot.sh`, with
isolated home, config, temporary and state directories. The full run needs the
workflow's OCR tools and language data. Test-only environments also clear
inherited Git author/committer overrides and hook configuration so fixture
identities come from each fixture's own configuration. Publication commands
retain the launched agent's credentials, identity and hooks.

The checks are the three touched test files, the two existing owned-runner
probes, typecheck, changed-file lint, and the privacy gate with
`LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE` pointing to the committed catalog
and `--require-known-values --base <merge-base>`.

`pull_request_target` reads main's workflow and trusted scanner. This PR's
required check consequently still uses the old workflow and its 130-second
candidate cutoff until the change lands. The current workflow also runs
candidate test files when its trusted import-closure scope selects them;
those files come from the candidate checkout. Thus a PR check cannot prove
the proposed workflow behavior. The new tests and cancellation command are
verified locally, independent of that old workflow definition.
