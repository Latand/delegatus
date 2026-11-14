# Arm the serving stack profiler

Set `STATE_DIRECTORY` to the installation's state directory. To request one
capture on the running Viewer, merge a timestamp into its existing small
`loop-profiler.json` file:

```sh
node -e '
  const fs = require("node:fs"), file = process.argv[1];
  const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  if (settings.enabled === false) throw new Error("Clear the kill switch first");
  settings.manualUntil = Date.now() + 60000;
  fs.writeFileSync(file + ".next", JSON.stringify(settings), { mode: 0o600 });
  fs.renameSync(file + ".next", file);
' "$STATE_DIRECTORY/loop-profiler.json"
```

No deploy or restart is required. The request expires after sixty seconds and
admits one five-second capture, subject to the shared ten-minute cooldown.
`manualUntil` is an absolute Unix timestamp in milliseconds; expired values,
non-numbers and requests more than sixty seconds ahead are ignored. Existing
manual requests cannot bypass cooldown by restarting the process.

Set `automatic` to `false` in the same file to suppress automatic arming while
keeping manual requests available. Set `enabled` to `false` to suppress both
sources. Clear that explicit kill switch with `enabled: true` when collection
is wanted again. Preserve other fields when editing. The file must fit in
512 bytes. Missing, unreadable, malformed and oversized settings preserve the
existing default-on policy; an explicit boolean false is required to disable.

The running process polls asynchronously every `LOOP_PROFILE_POLL_MS` (one
second). During collection it observes the next change after the current
five-second window and the next poll, normally within six seconds. Blocked
main-loop turns and slow filesystem operations delay observation. The kill
switch is checked again after admission and immediately before native sampling;
it prevents new windows. An already running native collection ends when its
timer can run. Each changed arming decision writes one `[loop-profiler]` line
with a fixed reason: waiting for a stall, automatic disabled, kill switch,
armed automatic/manual, cooldown, manual expiry, failure or stopped. Repeated decisions are
silent; raw exceptions and paths never enter these lines. Delivery uses the
existing bounded nonblocking log sink, which may drop lines under backpressure.

## What it captures automatically

The existing gap detector calls the profiler on its first turn after a main-loop
pause exceeding `LOOP_PROFILE_STALL_MS` (5,000 ms). It remains installed for the
whole serving process lifetime, including after a same-revision restart and
after the kill switch is cleared. The earlier per-revision startup window is
folded into this rule: serving no longer reads or consumes
`loop-profiler-deploy.json`, and `armMinutes` has no effect on serving.

This is recovery-triggered collection. It cannot reconstruct stacks from the
pause that triggered it. It samples the following work and any subsequent
pause overlapping the collection. Manual arming before a suspected operation
can capture that operation directly. No worker is added to sample the blocked
main thread.

`LOOP_PROFILE_CAPTURE_MS` is 5,000 ms, with the existing 10,000 microsecond
sampling interval. `LOOP_PROFILE_COOLDOWN_MS` is ten minutes between capture
starts, shared by automatic and manual requests. Admission is persisted before
collection, including failed or interrupted attempts, so restarts do not reset
the limit. A malformed capture ledger refuses admission. File operations and
the existing transaction lock are asynchronous, with a 100 ms lock-admission
deadline, and carry the `loop-profiler.settings` monitoring label.

The latest `LOOP_PROFILE_STORED_CAP` (twelve) sanitized summaries replace a single
`loop-profiler-captures.json` file atomically, alongside each capture's serving
revision and wall-clock completion timestamp. Each summary fits within
`LOOP_PROFILE_BYTES` (8,192 bytes); the bounded reader and writer use
`LOOP_PROFILE_STORE_BYTES` for the complete file. Replacement temporarily keeps
one additional file of the same maximum size. Captures are saved even when the
post-trigger window has no further gap. Overlapping gaps also retain their
existing correlated journal records, bounded to four long and eight short
gaps per capture.

Only repository-relative source/chunk paths, source-verified identifier names,
numeric sample weights and allowlisted native categories survive conversion.
Board rows, raw stacks, dynamic function names and external paths are omitted.
Conversion inspects at most 4,096 samples and 32 frames per sample; the journal
uses the existing bounded nonblocking sink. No captured production data belongs
in a commit.

The native Bun collector has a timer-based window. Another main-loop stall
during sampling extends collection until the timer can run. These constants
bound admission frequency and retained output; they do not impose a hard native
memory or stop-time limit during an unresponsive turn. Idle automatic arming
performs no native collection or source reads. Development, builds, runtime-host
processes and starts lacking a valid serving revision remain excluded.

## Isolated verification

Run each file separately through the installed `scripts/gate-slot.sh`, with
private HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR and
`LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1`:

```sh
bash "$GATE" bun test --timeout=60000 ./src/lib/loopProfilerSupervisor.test.ts
bash "$GATE" bun test --timeout=60000 ./src/lib/loopProfiler.test.ts
bash "$GATE" bun src/lib/loopProfiler.fixture.ts idle-arm-cost
```

The acceptance controls inject clocks, stalls and a collector. Fresh child
processes use the real serving adapter and persisted store to test same-revision
restarts, cooldown and the twelve-profile cap. Native privacy/correlation
controls run only in disposable child processes. The idle probe alternates
enabled/disabled order over eight pairs with identical load: 100,000 healthy
monitor ticks, 1,000 settings polls and 5,000 integer additions per poll. It
reports wall time and process CPU per run; process CPU includes filesystem
worker activity and is a conservative measure of main-loop cost. The eight-pair
run on Bun 1.4.0 used 122.308 ms median CPU with automatic arming enabled and
126.059 ms disabled, with zero captures. Run-to-run variation dominates that
difference; it establishes no performance gain. The
[verification record](../../evidence/loop-profiler-lifetime/verification.json)
contains every run, commands, exit statuses and counts. Final-commit hook
results are reported in the handover.
