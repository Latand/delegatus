# Role-memory privacy without Viewer stalls

Stage prompts, stage artifacts, runtime handoffs, cross-install seat messages,
bridge reports, issue-report hints and linked-agent titles use the leased worker
introduced for linked-board task export in #3014. Task pages continue to use that
same resident process. Its global owner spans Next server bundles; its queue is
limited to 16 jobs, each with a 60-second deadline including queue time. Privacy requests
and worker responses are limited to 2 MiB. The worker retires after ten idle minutes.

The worker keeps one role-memory revision in its matcher cache. A changed
revision replaces the entry. Stage replacements and report lesson classes share
the same compiled chunks. Issue-report hints retain the original per-lesson
occurrence order and overlapping spans through exact patterns cached alongside
those chunks under the same revision. Original records remain untouched. An affirmatively absent role-memory collection
returns filter inputs directly after the revision read; later collection creation
immediately restores the worker privacy fence.

An unreadable store, incomplete matcher, unavailable worker, expired deadline,
overfull queue or changed revision refuses filtering with
`LESSON_PRIVACY_UNAVAILABLE`. Explicit report deny lists supplement the stored
rules. The parent validates the revision before accepting a worker result.
Linked-agent exports also revalidate privacy at serialization and sharing after
filtering yields; new lesson revisions republish affected titles. Stage artifact
composition checks its revision again before writing files.

`memory.privacy.worker`, `memory.privacy.compile` and `memory.privacy.match`
register operations with the loop monitor. Static `privacy.compile` and
`privacy.match` spans enclose synchronous compilation and matching in the
worker; phase frames keep corresponding awaited operations visible in the
Viewer. No text or learned rule enters those frames.

## Verification procedure

The baseline is `7367fd9f3658671f9b5581bb046c1c0d752f7134`. The launch regression
executes the real stage composer with a caller-thread regex guard: it fails on
the baseline and passes after filtering moves to the worker. Worker tests cover
nested replacement bytes, Unicode and overlapping lessons, bridge-render bytes,
issue spans, compile reuse across callers, revision invalidation, actual worker
restarts, corrupt rows, queue refusal, a stuck worker and stale replies.

The offline measurement uses a read-only snapshot of the `role_memory`
collection, the recorded 20,721-character launch prompt and one recorded bridge
report. Private inputs remain outside the repository. Both revisions receive
identical copies. State opening is primed before timing, as in a serving Viewer;
matcher compilation remains cold in each fresh process. Two alternating
baseline/worker pairs each perform three prompt calls and three report calls.
The worker runs the production build's existing task-page worker entry.

Run `scripts/measure-privacy.ts baseline` from the baseline export and
`scripts/measure-privacy.ts worker` from the candidate export. Each command needs
isolated HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR. That state directory
must contain `.privacy-replay-copy`, copied `state.sqlite` and private
`inputs.json` with `prompt` and `report` fields. Run through the project's
`scripts/gate-slot.sh`. Output contains digests and measurements only.

The 5 ms timer records excess time beyond its nominal interval, used here as
the main-loop gap; it includes scheduling delays.
Linux main-thread CPU comes from `/proc` at the host's clock-tick resolution.
Those CPU measurements distinguish caller work from worker CPU; neither metric
claims an end-to-end production latency guarantee.


## Recorded result

`evidence/role-privacy.json` records all 24 observations, input/output digests,
collection digest, explicit test paths and the candidate source digest. The
workload contained 3,615 role-memory rows yielding 3,027 lesson texts, a
20,721-character prompt and a 783-byte report payload. Bun 1.4.0 ran the four
processes sequentially under the project resource gate after the production
build. Other machine activity was uncontrolled. Each operation has six samples
per revision, including two fresh-process prompt calls.

| Path | Baseline main-loop gap, ms | Worker main-loop gap, ms | Baseline largest main-thread CPU window, ms | Worker largest main-thread CPU window, ms |
| --- | ---: | ---: | ---: | ---: |
| Stage prompt | 982.690–4,415.341 | 0.498–4.229 | 980–4,420 | 10 |
| Bridge report | 12,058.004–19,438.040 | 0.069–0.742 | 12,060–19,420 | 0 |

The CPU probe resolves 10 ms ticks. Total caller CPU for a worker prompt was
10–80 ms spread over 982.264–4,724.423 ms of asynchronous waiting and sampling;
the largest sampled CPU window was 10 ms. Worker report calls took
3.122–18.284 ms wall time. Input and output hashes matched across every baseline
and worker repetition. These observations demonstrate that the privacy work
leaves the caller loop responsive while the worker performs matching.

## Checks

The final source passed `node node_modules/typescript/bin/tsc --noEmit`, the
required-known-values privacy gate, changed-file ESLint and `bun run build`.
The pre-push hook's full touched-test runner received all 43 explicit paths
listed in the evidence, using its default concurrency and unchanged budgets:
567,311 ms for the branch, 1,594 ms for baseline classification, **zero new
failures** and six confirmed pre-existing failures. The 17-file Linux gate was
green in 1,398 ms; `verify-platform-backend.ts --expect linux` also passed.
After removing trailing blank lines from the three new recovery files, their
explicit-path gate was green again in 110,855 ms and typecheck passed again.
The replay was repeated against that final source. Every run used isolated HOME,
XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR through
`scripts/gate-slot.sh`.

The shared pipeline fixture now closes its owned privacy worker before removing
state. Two existing large test matrices were divided into files so every file
fits the hook's existing budget: publication/recovery registration bodies are
preserved across four files; the 32 provider-output cases use one shared
registration function in two files. All assertions and timeout budgets remain.
The new privacy tests also prove the absent-collection transition, corrupt-store
refusal on all three operations, missing worker, compile refusal, queue overflow,
stuck-worker cleanup, stale-revision refusal and linked-title invalidation.

To repeat the full touched-test gate from a source export with dependencies,
first set the four isolated directory variables, then pass the recorded manifest:

```python
import json
import subprocess
with open("evidence/role-privacy.json") as source:
    evidence = json.load(source)
subprocess.run([
    "bash", "scripts/gate-slot.sh", "bun", "scripts/local-gate-tests.ts",
    "--base", evidence["baselineCommit"], *evidence["touchedTests"],
], check=True)
```
