# Delivery outcome settlement

## Confirmed cause

The incident was traced using an isolated SQLite backup, recipient transcript
and delivery ledger. The affected reservation had timed out after 30 seconds
and was persisted as failed/unverified. Its canonical user turn already existed;
the broker's durable confirmation arrived about 110 seconds after the timeout.
The reservation remained unverified because receipt reads returned terminal
failures immediately and Viewer startup reconciled against the runtime journal
without consulting recipient evidence. The old journal record was no longer
available in the captured journal. The composer then appended the English
transport reason to its Ukrainian status.

The isolated incident copy now resolves that original operation as delivered.
No operator state was changed during diagnosis or verification.

## Settlement contract

- Claude confirmation binds the queued operation and content digest to its
  generation's durable echo, or allocates a canonical user UUID to the pending
  ledger entry using the broker's digest, timestamp and consumption rules.
- Codex confirmation requires the exact structured delivery token and payload
  digest in a stable canonical rollout read. Equal text or an assistant answer
  alone cannot confirm another operation.
- Positive evidence settles unknown attempts during status reads, explicit
  recovery and Viewer startup. It never writes another engine input. Compacted
  Claude owner records retain the delivered result.
- A queued operation is declared lost only after a compare-and-set journal
  fence succeeds. Acceptance winning that race keeps its actual outcome.
  Existing settlement deadlines and explicit resend identity remain intact.
- Unreadable or missing evidence preserves checking and duplicate protection.
  Readable checking receipts are queried every 30 seconds while the composer
  is active; the checking icon queries the original operation immediately.
  Failed reads retain the existing bounded backoff.
- The Ukrainian lines are “Доставлено”, “Не доставлено — надіслати ще раз” and
  “Перевіряємо доставку…”. Delivery removes the composer banner; proven loss
  offers the existing one-tap resend.

## Verification

All tests used isolated state through the shared heavy gate. The five new
restart/canonical/recovery cases fail against pinned base
`473c9371fc524ebb5cd903955aad4b976dd3702c` and pass with the change.

Backend settlement, HTTP, structured queue integration and indexed registry
checks passed (119 tests, including compaction/discard regressions). Engine
transcript and deduplication checks passed (94 tests). Composer, outbox and
delivery wait checks passed (212 tests), including production status
readback clearing the banner in both languages. TypeScript passed.

The existing conversation browser driver checked checking, delivery disappearance
and one-tap resend in English/Ukrainian at 390 px and 1440 px. All 32 assertions
passed. Each captured state was visually inspected. Geometry is recorded in
`evidence/delivery-outcome/receipts.json`.

ESLint on changed files retains the pinned base's 19 errors and seven warnings;
no new rule/file findings were introduced. The broader feed uncertainty suite
has the same 39 passes, one skip and 48 failures on base and head, with exactly
the same failing cases. These existing failures are separate from the focused
passing settlement/composer regressions.

The pipeline restart lane and merged MCP reconnect change were read. Pipeline,
seat orchestration and MCP reconnect source remain outside this change. The
runtime-host process and Bun pin are unchanged.
