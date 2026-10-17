# Role memory curator timer

The curator has an independent per-project `curation` block in `seat_tick_settings`: enabled by default, six hours by default, bounded to 1–168 whole hours. Its controls appear immediately after board maintenance in the existing tick panel. Both controls save through the same request as the rest of the panel. Last-run time, state, result counts and the conversation link come from persisted curation records. Turning wakes or role memory off also pauses curation.

## Diagnosis for the pull request

The reproduction uses synthetic role-memory rows in isolated state. It does not classify individual production passes. Before this change, `curationStatus` selected a pass whenever active rules satisfied any of `!lastAt`, pressure, ten new lessons, or six elapsed hours. `claimPass` independently imposed only a 30-minute claim cooldown. A scope at least 90% full with one unseen rule therefore remained immediately due after a failed or successful no-op pass, and could claim again after 30 minutes. In the reproduction, the first pass takes the initial branch; subsequent passes take the pressure branch while the elapsed-time branch is false.

Pressure survives because ending a curator turn only settles its pass and advances `lastAt`. `applyCuration` stamps `curatedAt` on rules in the submitted scope orders. A failed turn, a successful turn that submits no scope changes, a partially processed scope, or rules added after a submitted scope leave unseen rules. As long as that scope remains at least 90% full, pressure stays true. The existing pressure regression on the base explicitly expected the restarted process to report `due: true` and another claim after the cooldown.

Every trigger now waits for the configured interval after the later persisted claim/end time. The claim transaction repeats that bound against the current project row, including aliased project history. Failure and no-op completion consume the interval; a restart cannot reset it. New lessons and pressure remain diagnostic facts and obey the same interval. There is no claim of a performance improvement.

## Contract paths checked

The stored block follows the settings normalizer, effective defaults, expiry reset, writes to other blocks, HTTP change parsing, MCP input schema and binding, and client draft/save/rollback. Maintenance and curator read-only MCP callers cannot use the new block to mutate scheduling. Runtime admission reads the chosen host project's switch again after liveness and at deferred spawn/recovery fences. The small admission edit is separate from the concurrent lane's registry snapshot changes; the launch edit is separate from the concurrent card-free system-run change.

Compact MCP reads omit untouched curator defaults to preserve the existing answer budget; `verbose: true` includes them. Configured timers, run results and errors are included in compact reads.

The panel reads the latest and current pass records without materializing every retained pass. Its operation is registered as `memory.curation-panel`. English and Ukrainian share the existing timer controls and layout.

## Verification

Pending final isolated touched-tests gate, typecheck, privacy/lint and rendered frames from the existing kanban browser driver.
