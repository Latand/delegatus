# Publication repair custody verification

A producer lost after publication repair can hand its committed or staged
descendant to the next review. Custody preserves the original report and
creation receipts. Live producers retain the existing repair protocol.

Receipt verification also recognizes previously accepted prefixes. The repair
handoff therefore checks accepted ancestry independently before changing files
and before adopting its result. A checkout rolled back from accepted B to an
older receipted A parks with B still accepted, without publishing or changing
the checkout. The same check applies when recovering a saved commit intent.

The verification source was merge commit `2b19c4a93`, including current main
`d715e74a3`. The final follow-up clarifies the receipt verifier's comment and
records this evidence; it changes no executable behavior.

| Check | Observed result |
| --- | --- |
| Full `tsc --noEmit --incremental false` | Passed |
| `src/lib/pipelines/publicationRepairHandoff.test.ts` | 51 passed |
| `src/lib/pipelines/publicationRecovery.test.ts` | 121 passed |
| `src/lib/pipelines/stageAttemptPush.test.ts` | 206 passed |
| Accepted-ancestry control with the fix removed | Three rollback cases failed; saved-intent case passed |
| Original-defect control using main production | Committed and staged dead-producer cases failed; live-producer case passed |
| Publication privacy, including commit history | Passed |

The rollback matrix covers clean, staged, mixed staged/unstaged and saved-intent
checkouts. It checks the accepted head, publication state, original report,
creation receipts, index tree and working files. The broader handoff matrix
also covers reviewer launch receipts, controller restarts, producer revival,
foreign heads, missing receipts and index/worktree races.

The importer selection contains 306 explicit files: direct consumers of the
engine, receipt verifier, pipeline types and shared publication fixture,
recursive fixture consumers, and the changed suites and Git controls. Each file
ran serially through the prescribed gate wrapper in a separate owned runner,
with fresh HOME, XDG roots, TMPDIR and LLV_STATE_DIR. The Viewer control URL used
a closed loopback port. Bun was 1.4.0. No build or directory-wide suite ran.

Of those files, 251 exited zero, 53 exited one, and two reached the five-minute
execution bound. Every nonzero file received two fresh whole-file runs against
clean main, giving 110 main comparisons. All failing branch cases also appeared
on main. Raw expected/received diagnostics were compared; generated identities,
wall times and measured durations differ between independent runs.

`engine.providerReset.test.ts` alternated between pass and its 60-second case
timeout on main. `remoteActions.test.ts` and `terminalReap.test.ts` reached the
five-minute bound on both sources and both main rounds. Their bounded results
remain unverified test evidence. The importer campaign is therefore not a green
suite; it identified no branch-only failing assertion. Original logs, command
exits, source hashes, manifests and per-case comparisons are retained privately.

The mechanical settlement recovery changes merged from main remain intact.
Provider-capacity and release-tag work uses separate paths. Hooks remained
enabled and their configured path was unchanged. Publication is owned by the
pipeline.
