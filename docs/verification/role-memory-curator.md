# Role memory curator timer

## Diagnosis for the pull request

The reproduction uses synthetic role-memory rows in isolated state. It does not classify individual production passes. Before this change, `curationStatus` selected a pass whenever active rules satisfied any of `!lastAt`, pressure, ten new lessons, or six elapsed hours. `claimPass` independently imposed only a 30-minute claim cooldown. A scope at least 90% full with one unseen rule therefore remained immediately due after a failed or successful no-op pass, and could claim again after 30 minutes. In the reproduction, the first pass takes the initial branch; subsequent passes take the pressure branch while the elapsed-time branch is false.

Pressure survives because ending a curator turn only settles its pass and advances `lastAt`. `applyCuration` stamps `curatedAt` on rules in the submitted scope orders. A failed turn, a successful turn that submits no scope changes, a partially processed scope, or rules added after a submitted scope leave unseen rules. As long as that scope remains at least 90% full, pressure stays true. The existing pressure regression on the base explicitly expected the restarted process to report `due: true` and another claim after the cooldown.

Every trigger now waits for the configured interval after the later persisted claim/end time. The claim transaction repeats that bound against the current project row, including aliased project history. Failure and no-op completion consume the interval; a restart cannot reset it. New lessons and pressure remain diagnostic facts and obey the same interval. There is no claim of a performance improvement.

## Behavior

The curator has an independent per-project `curation` block in `seat_tick_settings`: enabled by default, six hours by default, bounded to 1–168 whole hours. Its controls appear immediately after board maintenance in the existing tick panel. Both controls save through the same request as the rest of the panel. Last-run time, state, result counts and the conversation link come from persisted curation records. Turning wakes or role memory off also pauses curation.

## Contract paths checked

The stored block follows the settings normalizer, effective defaults, expiry reset, writes to other blocks, HTTP change parsing, MCP input schema and binding, and client draft/save/rollback. Maintenance and curator read-only MCP callers cannot use the new block to mutate scheduling. Runtime admission reads the chosen host project's switch again after liveness and at deferred spawn/recovery fences. The small admission edit is separate from the concurrent lane's registry snapshot changes; the launch edit is separate from the concurrent card-free system-run change.

Compact MCP reads omit untouched curator defaults to preserve the existing answer budget; `verbose: true` includes them. Configured timers, run results and errors are included in compact reads.

The panel reads the latest completed pass separately from a live pass without materializing every retained pass. A live pass has its own start-time row and conversation link; the previous completed result remains under “Last run.” Its operation is registered as `memory.curation-panel`. English and Ukrainian share the existing timer controls and layout.

## Verification

The original-base negative control at `de3b2e2c5` reports `due: true` at 31 minutes after a successful no-op pass, with zero new lessons. The fixed test refuses that claim and verifies the interval boundary in a restarted process. Failed-pass restart, disabled-timer restart, twelve-hour restart, deferred-launch revocation, result counts, HTTP/MCP parity, schema parity and panel DOM cases also pass.

Typecheck passes on the tree merged with `32e5a6e91824659604d54ac00dce19977f666c0e`. The full touched-tests comparator reports zero new failures; existing route/binding assertions reproduce on the base or are classified as flaky by its retries. All checks run in a scratch source export with frozen dependencies and private HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR. The Viewer control URL points to a closed port. `GATE_SLOT` names the installed gate wrapper.

```sh
bash "$GATE_SLOT" bun node_modules/typescript/bin/tsc --noEmit
bash "$GATE_SLOT" bun scripts/local-gate-tests.ts --base 32e5a6e91824659604d54ac00dce19977f666c0e \
  src/app/api/monitor/seat-tick/settings/route.test.ts \
  src/components/orchestrator/SeatTickChip.dom.test.tsx \
  src/lib/mcp/bindings.test.ts \
  src/lib/mcp/schemaParity.test.ts \
  src/lib/mcp/server.test.ts \
  src/lib/mcp/toolAllowlist.service.test.ts \
  src/lib/mcp/toolAllowlist.test.ts \
  src/lib/memory/curation/curation.test.ts \
  src/lib/monitor/seatTickSettings.sqlite.test.ts \
  src/lib/monitor/seatTickSettings.test.ts \
  src/lib/viewerLoopMonitor.test.ts
```

The existing kanban driver case `role memory curator in the seat tick panel` passes 444 expect calls across 72 frames: 1440×900, 1000×700 and 390×844, all six states, English and Ukrainian, light and dark. Every frame was visually inspected; each reading fits and records no page errors. Its record is `evidence/role-memory-curator/rendered.json`; frames stay in `.artifacts/role-memory-curator/panel/` for local review. Set `LLV_KANBAN_BROWSER_TEST=1` and `CHROME_BIN`, then run that driver by path with `--test-name-pattern "curation status and controls fit"` through the same wrapper. Chromium needs a short temporary path; this run used an owned cache temp directory.

The implementation commit passed the enabled pre-commit whitespace, privacy and lint hooks. Publication belongs to the pipeline.
