# Checkpoints for completed test files

A touched-test selection can exceed its aggregate execution budget after many
individual files have passed. Retrying the same selection previously repeated
those files before reaching the unfinished work.

The local comparator records each complete file sample in the bounded gate
receipt store. A retry reuses matching head and baseline evidence and executes
the remaining files. Only a completed comparison can pass the whole selection.

## Input and completion boundaries

- Head file reuse requires the same clean worktree, commit, tree and branch,
  full working inputs (including ignored files), installed dependency bytes,
  gate and runtime bytes, Git configuration, execution environment and
  individual file limit. The head key also binds the physical checkout
  directory. Each worker receives one file. Changing the other selected files,
  the comparison base or the phase allowance leaves that head sample valid.
  A comparison step still binds the base and full selection.
- Whole-step receipts bind explicit `LLV_GATE_CHECK_ENV` values, including
  names that match a transport prefix. The local hook supplies fresh isolation
  directories, so caller values for those directories do not key its receipts.
- The comparator also binds its unfiltered caller environment: it retains
  custom variables that the publication wrapper normally strips. Identity,
  privacy and proxy/certificate values consumed by direct calls are bound too.
  Whole-step and head-file receipts bind the `BASH_ENV` startup file by its
  path, resolved file identity and content digest. The `bash` wrappers in
  `gate-slot.sh` read it before launching the comparator; its bytes stand for
  startup effects outside the environment, such as umask, resource limits, and
  working directory. A named `BASH_ENV` file that cannot be read keeps
  reusable receipts cold. A change during the run invalidates checkpoint
  sealing or refuses reuse after a prior hit.
  For head checkpoints only, an active sandbox journal entry binds the local
  gate allocation to its device and inode. Both environment fingerprints omit
  paths generated from that allocation, including declared inputs such as
  `XDG_STATE_HOME` and `XDG_RUNTIME_DIR`. Every file receives its own directories.
  The selected temporary parent and external inputs keep their identities.
  The Linux worker entry issues fresh process and supervisor IDs for each
  file, so the parent invocation's IDs do not key these checkpoints.
- Dirty trees, index flags and unreadable input identities receive fresh runs.
- A head sample requires a complete report with assertions and confirmed owned
  cleanup. A head sample with failed assertions is reusable while the
  comparison is unfinished. A completed verdict retires it so a later
  invocation can observe the failures afresh.
- Reusable files use Linux service cgroup cleanup. The portable fallback is
  best effort; its samples never become head checkpoints. Other platforms
  retain their existing fresh-file execution and whole-step receipt rules.
  Before reading or sealing receipts, the comparator probes the same user
  service route as a file worker from a fresh runtime directory. A local Unix
  socket, its D-Bus instance and its systemd manager's unique connection must
  be identifiable. The route and launcher/probe executable bytes are part of
  the key. An unknown manager leaves the head files cold.
- A baseline sample binds the base commit, file, assertion filter, environment,
  tools, dependency inputs and file allowance. A retry of the same verified
  candidate can reuse its first complete baseline sample. Sharing that sample
  with other candidates still requires two matching independent observations.
  Diagnostic and flaky confirmation rounds take fresh samples.
- The comparator seals each receipt after its file runner has confirmed
  owned cleanup, the file sandbox has been removed and the input snapshot
  still matches. It writes eligible receipts before reporting file completion,
  so a hook deadline can stop the comparator while leaving earlier receipts
  available. Input drift prevents further sealing. Reused checkpoints also
  require a final input check.

The comparator snapshots inputs before selecting reusable results and again
before writing each new head receipt. An owned hook does this even for a
single file, which can reach its deadline during comparison.
The head samples, baseline samples and deadline hints each use a namespace
limited to 8192 entries and 256 MiB. Records are limited to 1 MiB, expire after
24 hours and are skipped when malformed or unavailable.

Head and baseline phases get 15 execution minutes for selections of up to
30 files and one extra minute for every additional four files, rounded up.
The comparison shares a 40-minute ceiling across phases, including baseline
setup and confirmations. Each file retains its five-minute limit.
A file deadline with confirmed owned cleanup leaves the comparison without a
verdict. A matching retry runs the unfinished files in that phase one at a
time, within the existing budget. The hook returns capacity status 75 and
allows independent checks to record passes. An observed assertion refusal or
failed cleanup retains its blocking result.
The publisher gives retries of the same accepted head one fixed 45-minute
push budget after a recorded deadline, including one minute for the pack.
CPU admission is credited separately. A persistent assertion failure still
blocks publication after unrelated green files are reused.

## Verification

`scripts/local-gate.checkpoints.test.ts` uses separate comparator processes and
synthetic repositories. It demonstrates retained green files beside an
incomplete file, source/environment/ignored-input invalidation, malformed
receipts, and three budget limits after eight of twelve files. The phase and
comparison deadlines can expire, or the remaining time can be too short for
a full file and its cleanup. The next invocation runs only the remaining four
files. The parent clock controls the simulated deadline, and the workers keep
their real clocks and execution bounds. A hung file reaches its individual
limit on both the initial run and the serial retry that reuses a green peer.
The baseline control uses a port-zero rendezvous and a peer deadline. After
restart it reuses the completed head and base samples, then refreshes the
baseline when its commit changes.
`scripts/local-gate.checkpoints.hook.test.ts` expires the native pre-push hook
after one file completes while another is still running. It checks that the services and directories
were removed, the retry runs only the interrupted file, and a manager change
before file completion prevents sealing. It also checks receipt bytes, fresh
declared directories, input and runner replacement, and manager identity loss
or drift after reuse. In `scripts/local-gate.checkpoints.stepPasses.test.ts`,
the `check-step "touched tests"` regression covers warm and cold retries after
changing only the external `BASH_ENV` bytes. The native hook also declines
stale whole-step receipts after changes to a declared variable or the startup
file. Warm retries report the same assertion
failure as cold runs and reuse the pass when only private allocations change.

This repairs the Delegatus repository's publication integration. The generic
cross-project execution contract remains tracked in #3622.

The comparator's existing 67 cases are split into core, retry, rendezvous and
baseline files around one shared fixture. Their test statements are unchanged.
The gate selects every group when comparator or shared fixture inputs change;
comparator and cache changes also select the checkpoint controls. This keeps individual files
below the existing five-minute budget without changing that budget.
