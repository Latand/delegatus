# Prototype review Telegram delivery

## Incident observation, before implementation

Read-only inspection covered the live journal, the review collection, the
deployment ledger, the bot's send journal and the source at the serving release.
All four rounds were published on 2026-10-12 while `0ef6ec497f65` was serving.

| Published (UTC) | Review | Variants / frames | Exact reason it was never posted |
| --- | --- | --- | --- |
| 19:29:23.363 | `pr_9e25a20dec04df9de5e296251b2711b4` | 1 / 69 | Serving release `0ef6ec497f65` saved the round in `publishPOST` and returned without invoking a Telegram poster. No send was attempted. |
| 21:20:27.829 | `pr_125e242328198ce5cb9e7b9c9d964dc6` | 3 / 159 | Serving release `0ef6ec497f65` saved the round in `publishPOST` and returned without invoking a Telegram poster. No send was attempted. |
| 21:22:54.418 | `pr_e914ff94867dbda31010fe4ed98f4a62` | 9 / 238 | Serving release `0ef6ec497f65` saved the round in `publishPOST` and returned without invoking a Telegram poster. No send was attempted. |
| 22:49:05.920 | `pr_360e35856f9aca7584d32e6fda8395a7` | 3 / 239 | Serving release `0ef6ec497f65` saved the round in `publishPOST` and returned without invoking a Telegram poster. No send was attempted. |

The MCP binding at that release posts to `/api/prototype-reviews`, reaching
the same HTTP handler. Its separate process does not bypass that route.
Journal stack paths for 19:00–23:00Z name `0ef6ec497f65`; there are no
`prototype Telegram post refused` lines in the examined 19:00–00:20Z window.
The bot journal contains zero `prototype-review` send claims during 19:00–23:00Z.
Ordinary text sends are present, so the earlier assertion that there were no
outgoing bot messages in that entire window was broader than the store shows.

Rich posting landed with `f2be68223` (#2751) at 05:51Z on 2026-10-12, after
the serving release was built. The installation first received that code
in `8f1cfd530` at 23:05:39.638Z, after every round above. Publication does
not replay historical rounds on deploy. The escaped-Markdown refusal flagged
in that PR had already been removed in the starting branch. It cannot
explain a send the serving release never attempted. `webhook_elsewhere`
describes update reception; the owner send path performs `getChat` and a
rich send without using that receiving state as a posting refusal.

## Delivery and resend

Publication saves a pending Telegram record with the round, then awaits its
send result. A failed or unconfirmed attempt records a reason code on the
review. Missing pairing and paused or unconfigured destinations also produce
records. Pending records survive restart and the existing delivery worker
reconciles them through the bot's original idempotency key. Ambiguous sends
retain their claim; they are never automatically repeated under a new key.

Carousels include up to 50 previews, prioritize coverage of each variant and
link to the full review. A definitive Telegram limit refusal triggers a
bounded rich summary, preserving preview coverage and answer copy buttons.
Definitive media failures permit a text-only rich fallback with the link.
These retries use the same durable claim. See the official
[Telegram rich-message API](https://core.telegram.org/bots/api#sendrichmessage).

`resend_prototype_review_telegram` takes `reviewId` and `clientRequestId`.
Its project fence runs before MCP receipt replay and covers taskless rounds.
The same key replays its result; a fresh key intentionally posts another
copy. Failed records join the seat's existing wake agenda as actionable
items carrying their reason and review ID. The review and taskless decision
forms share the resend action in their existing action areas.

## Verification

Failing-first regressions observed a missing durable failure record, an
unhandled size refusal, an unknown resend tool and an absent UI action.
Focused tests use fake bot transport and the production MCP/HTTP handlers
against isolated state. No test posts to a real Telegram chat.

The existing `kanbanBoard.browser.test.tsx` driver owns the new case. Variant
1, **Existing review action area**, places the failure reason and resend
action above the existing answer controls. It covers the task review and the
seat form, light and dark themes, desktop 1440px and phone 390px. Captures
live in `.artifacts/prototype-telegram`; committed geometry is in
`evidence/prototype-telegram/resend.json`. The case clicks or taps resend and
checks draft preservation, action visibility, clipping and overlap.

## Deployment handoff

No live resend or deploy is part of this change. After an approved deploy,
the project's seat uses the new tool for the four review IDs above with a
fresh request key for each, then confirms their receipts and arrival.
