# Saved decision delivery

A Telegram answer keeps the verified owner's active member identity on a team
installation. A legacy operator record supplies no member authority by itself;
an authenticated member can explicitly retry its exact saved answer. This keeps
the conversation ingress member gate in force.

| Requirement | Change | Regression and evidence |
| --- | --- | --- |
| A: explain the missing answers | `externalRelay/prototypeAnswer.ts` previously saved Telegram as the solo operator. `conversation-host/handlers.ts` refuses that actor in team mode. `prototypeReview/decision.ts` also let a queued journal override a terminal reservation; retries could stay addressed to a retired seat. | `answerDelivery.test.ts` reproduces both actors and both terminal dispositions; `answerDelivery.integration.test.ts` drives the real ingress, journal and queue through an isolated fake engine, then verifies the destination. |
| B: deliver or carry the saved answer to the seat | The paired Telegram owner is revalidated at save and dispatch. Recovery follows durable retry owners and fences an old execution before following succession. Ten automatic attempts or thirty minutes exhaust the persisted budget. Failures join the seat's next wake with the saved answer and its read reference, ahead of ordinary lane items. | `answerDelivery.test.ts`, `answerDelivery.integration.test.ts`, and the saved-answer case in `monitor/seatTick.test.ts`; `evidence/answer-delivery/regressions.json`. |
| C: agree on the badge and panel | Both readers include seat and task delivery failures, including older decided rounds beside a new unanswered form. The panel shows the saved answer and a retry control. A receipt clears the notice and count. | `DecisionColumn.dom.test.tsx`; the saved-decision case in the existing kanban browser driver; `evidence/answer-delivery/panel.json`. |
| D: keep the task open | Task commands refuse completion with `TASK_DECISION_UNDELIVERED`. The shared completion hook also refuses direct store transitions. Automatic placeholder and ghost settlement retain the obligation. | Command, atomic store and ghost-settlement cases in `answerDelivery.test.ts`. |

Paths in the change column are under `src/lib`. Test paths are under
`src/lib/prototypeReview`, except the monitor test and the component tests under
`src/components/decisions` and `src/components/kanban`.

## Recovery rules

A queued journal cannot reopen the same operation's terminal reservation.
A terminal journal failure can prove non-execution; the retained unknown-outcome reasons still require verification. An admitted retry carries
its own durable owner and outcome. Following a replacement seat requires a
conditional fence of any queued old execution; an accepted, unreadable or
uncertain execution is retained for verification. The saved message bytes and
client message key remain stable. No automatic path resends an uncertain or
discarded execution.

Retention evicts confirmed delivered rounds; undelivered records keep their slot.

Attempt and age bounds survive a worker reset and a new real process. An
explicit retry starts a new bounded cycle. Exhaustion leaves the original
answer on the round, in the Decisions panel, and on the seat's wake agenda.
The wake names the operation to verify and the full-review read for answers
that exceed the wake's text budget. A task's completion gate remains closed
until its decided rounds have confirmed delivery.

## Reproduction

Start from `origin/main` and copy the new tests and the added existing-file
cases into an export before applying the implementation. Run each named file
through `scripts/gate-slot.sh bun test <file>` with isolated `HOME`,
`XDG_CONFIG_HOME`, `TMPDIR` and `LLV_STATE_DIR`. The regression ledger records
the baseline outcomes and the final source digest. Raw logs stay in the private
check scratch directory.

The existing kanban driver case is selected with:

```sh
LLV_KANBAN_BROWSER_TEST=1 bun test src/components/kanban/kanbanBoard.browser.test.tsx --test-name-pattern 'C: the Decisions badge'
```

Run it through the same gate, with `CHROME_BIN` and a short owned
`LLV_CHROME_TMPDIR`. It captures 390-pixel and 1440-pixel viewports, English and
Ukrainian, light and dark. Each of three saved records is opened; all retries
preserve the answer, and the badge and list both clear after confirmed fixture
receipts. Frames are generated under `.artifacts/answer-delivery/frames`.

This change adds narrow, admitted delivery-state reads and writes. It makes no
performance improvement claim. The contention regressions require an independent
timer to advance while another process owns the SQLite write lock.
