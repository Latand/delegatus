Cause at the parent revision: `scripts/gate-wait.ts:15` caps a foreground wait
at nine minutes. The shared guidance in `src/lib/pipelines/testGuidance.ts:13`
sent longer Codex checks through recorded-check custody. That guidance reached
the merger through `src/lib/pipelines/prompts.ts:155`. When custody refused,
there was no native completion wait to keep the stage suspended. The audited
merger called `write_stdin` 59 times against one progress-observer session while
a 106-file comparator ran. PR #3507 had shipped the recorder, bounded waiter
and custody handoff; it had not added a native Codex wait tool.

## Run a long check

1. Start `bash scripts/gate-slot.sh --record "$TMPDIR/check.log" <command>`
   once, with the project's isolated environment. Use a fresh log path.
2. After `recording started`, call `wait_for_check` once with the absolute
   `log` path and a short `reason`. Keep the stage alive until it returns.
3. Read `terminal`, `code`, `state` and `tail`. A terminal exit of 124 is a
   command result. A nonterminal 124 is an unfinished check; retain its original
   run and evidence and report the gap. Never restart it from PID absence.

This applies to every native Codex host, including builders, reviewers and
mergers. Shared stage guidance tells Claude stages to await their engine's
background completion notification. A stage that must exit while a check runs
still needs the manifest-bound custody handoff and its accepted receipt.
The foreground wait makes no survival claim across that exit.

## Mechanism

The recorder persists `completion.json` beside its owner and exit records.
It pins the recorder identity, directory identity and original monotonic
deadline. Manifest recordings retain their declared deadline; other recordings
receive a four-hour total bound. Execution admission, the execution allowance
and owned descendant cleanup stay in the gate. The completion wait allows the
existing bounded cleanup window after the deadline.

`gateCheckTool.ts` supplies a native dynamic tool on `thread/start` and handles
its `item/tool/call` callback. It reads only a recorded log beneath that native
stage's temporary root. The waiter subscribes before inspecting exit, uses one
timer and one filesystem watcher, and reads the bounded tail at settlement.
It takes no gate slot and consumes no custody capacity. Host release or turn
completion cancels the watcher; a changed owner or directory refuses the result.
The host rechecks thread, turn and writer ownership before returning a result.
Resumed native threads retain their original dynamic tool declaration.

## Verification

`scripts/gate-completion.native.test.ts` drives a credential-free local provider
through the installed Codex interpreter and real gate recorder. Each replay
uses one exec call and one native wait call, with zero `write_stdin` calls.
The model remains suspended while a held check receives 1,000 progress events,
then receives the persisted success or failure exit after cleanup.

`scripts/gate-wait.test.ts` covers a real queued recording and later result
reads. `gateCheckTool.test.ts` covers progress, expiry, cancellation, changed
proof, foreign paths and indirect paths. `codexAppServerHost.test.ts` covers
tool registration and callback routing without operator attention, including
duplicate pending requests and foreign-thread refusal.
