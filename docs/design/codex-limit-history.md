# Codex limit history attribution

Codex session directories can contain rollouts from several accounts. A path
under an account home and a `plan_type` label do not identify the account that
produced a quota event.

`src/lib/limits.ts` accepts a transcript reading only when its exact path has a
Codex registry generation with verified app-server host custody. The event must
fall at or after that generation's creation and host verification and before its
archive time. An unverified same-path account rebind quarantines the whole old
custody interval, including events before discovery: inventory's observation
time cannot prove when the account changed. The durable `endedAt` marker records
discovery; readers reject marked custody even if the binding later returns to
the original account. Verified generation succession retains its proven
creation, verification and archive boundaries. All
eligible custody claims are counted before selecting the requested account, so
overlapping claims from different accounts quarantine the event for both.
Unknown ownership, registry read failure and continuity copies contribute no
quota samples. The same check
covers quota readings, paid-credit metadata and usage-limit rejections used in
live reconciliation and offline fallback, as well as burndown backfill.

Live provider reads use the runtime selected for the requested account. The
existing quota controller records its accepted, authenticated live or transcript
observations through `recordLimitSamples`; repeated observations share the
store's five-minute sampling interval. This recording path shipped in #3151.

History files carry `codexAttributionVersion: 1`. A reader excludes Codex series
without that marker. The next successful history write preserves those values
in `unattributedCodexSeries`, alongside the new attributable series; Claude
history remains available. Earlier Codex cache snapshots also require a fresh
read. No rollout or account file is rewritten by this correction.

Task-spend rate schema 4 retires the derived Codex rates from the earlier
history, including frozen own rates and borrowed plan rates. The background
activity pass removes at most 200 rates at a time, with durable task
invalidation in the same transaction. A `*` day in the rate-change queue
invalidates every task for the account, including tasks that borrowed a
neighbouring day's rate; the consumer advances at most 100 tasks per queue row.
Remaining rows carry progress across a restart. Once invalidation finishes, the existing calibration pass recomputes
at most nine retained UTC days and commits the schema marker only after success.
Unsupported history yields an unknown rate. Task recomputation uses the
existing bounded queue, outside board requests. This change claims no latency
improvement.

Regression coverage lives in `src/lib/limitsBurndown.test.ts`,
`src/lib/limits.test.ts`, `src/lib/limitsHistoryStore.test.ts`,
`src/lib/accounts/migration/quotaController.test.ts` and
`src/lib/activity/taskLimitSpend.test.ts`.
