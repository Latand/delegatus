# Fenced first-message recovery

The controller automatically replaces a stage launch only after the journal
proves its first message never executed. This implements the requirement to
repair mechanical stage failures without waiting for a seat to run retry-stage.

## Investigation on 2026-10-20

The investigation started after merging main at `6b2bc7b3e`. User-journal reads
used `journalctl --user` with `grep -a`. Read-only SQLite connections copied the
runtime journal, agent registry and pipeline store into the stage's scratch
directory with SQLite backup. All SQL analysis ran against those copies.
Private records and raw logs remain outside the repository.

The two retained pipeline attempts and their original first-message receipt
events show:

| Stage | Attempt started (UTC) | Message admitted (UTC) | Journal fence (UTC) | Pre-dispatch privacy retries |
| --- | --- | --- | --- | --- |
| Review | 16:15:35.956 | 16:15:49.819 | 16:25:51.153 | 77 |
| Fix | 16:17:03.144 | 16:17:31.695 | 16:27:38.223 | 76 |

Both messages repeatedly returned from delivering to queued with the reason
`Role-memory privacy changed; retrying before dispatch`. Their final receipt
was failed with `SEND_LOST_REASON`. The original spawn operations remained
queued. The pipeline retained the same failure reason until a manual retry.

The user journal between 16:10Z and 16:30Z contains 400 gate-service starts,
286 Viewer loop gaps ranging from 351 to 3,548 ms, and request timeout reports
at 16:19:34Z and 16:21:36Z. The broader 16:00Z to 16:38Z capture shows the same
runtime-host process identity in its performance summaries. No runtime-host
restart was observed. The captures contain no historical load-average samples.
These are observations of concurrent work and stalls; they do not establish
that CPU pressure caused the privacy retries.

To reproduce the evidence query, select each retained pipeline attempt from
`state_rows`, join its launch id to `operations` and the original
`spawn_message_<launch id>` operation, then order its receipt events by `seq`.
Count receipt reasons and compare their `occurred_at` timestamps with the
attempt's `startedAt`. Inspect lifecycle and timeout entries in the user
journal over the same UTC interval. This uses retained primary records and
avoids interpreting a seat wake's arrival time as the failure time.

## Cause and recovery

`src/lib/runtime/sendSettlement.ts:108` produces the safe terminal
reason. `spawnRunStage` and the spawning/running branches of `tickRunStage` in
`src/lib/pipelines/engine.ts` formerly sent it to `park`: the transient spawn
classifier omitted this reason. `src/lib/attention/seatAgenda.ts:60`
renders the resulting “asks stopped” message.

`src/lib/pipelines/engine.fencedMessage.test.ts` reproduces the park with an
isolated fake transport. Its first case failed on merged main with one spawn
call, `needs_decision`, and the exact journal failure reason before the fix.

The controller now verifies the journal identity through
`src/lib/pipelines/fencedFirstMessage.ts`, claims the failed launch using the
existing retry-stage claim key, stops its recorded host and retires that launch.
The same attempt reserves its next launch after 1, 5 or 15 seconds. Three
recorded retries exhaust the bound. Native dispatch keeps the existing durable
activation key, so recovery adopts a committed dispatch after an interrupted
acknowledgement. Unknown delivery outcomes retain the existing handling.

The added optional counter defaults to zero in the recovery path. Attempt
construction leaves it absent; the retry path increments it. Store validation
accepts a nonnegative safe integer, and normalization and structured copies
preserve it. Full pipeline records expose the counter and retirement history;
compact board projections continue to expose the stage state and retry detail.
A manual retry creates a fresh attempt. Runtime switches on the same attempt
retain its counter. The counter is independent of bounded retirement-history
retention and of the wait record cleared by a successful spawn handshake.

No runtime-host, publication, CPU-priority or hook behavior changes here. This
change makes no performance improvement claim.
