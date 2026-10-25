# Task size on the card

Design proposal for board task `f6f79cd1`. Source: Codex Cloud (GPT-6.1 Sol), result `20.diff`, collected 2026-10-23. Code references checked against `adce57649`. Implementation is separate work.

## The problem, in the operator's words

> An estimate of a task's size (effort/complexity) shown on the card and usable by the seat for scheduling and due dates.

The operator should be able to distinguish a small correction from a substantial change without opening every card. The seat needs the same information when deciding what to start, what to split, and whether a commitment fits before its due date. Priority says how soon to take something; size says how much work it contains. A large task can be urgent and a small task can wait.

The requested companion, `docs/design/task-due-dates.md`, is absent from this checkout. The available implementation at `src/lib/monitor/seatTick.ts:1497` supplies the baseline: high-priority overdue work moves to the next day, normal work by three days, low work by seven days. Work open over seven days gets the next shorter horizon and a one-level priority increase. Reconcile the companion document before implementation if it becomes available. This proposal preserves the implemented horizons and does not substitute for that document.

## Three variants and a recommendation

| Variant | On the card | Scheduling value | Trade-off |
| --- | --- | --- | --- |
| **A. Four effort bands** | `Size M`, with S/M/L/XL available | Shared vocabulary for sequencing, capacity checks and splitting | Quick to estimate and easy to scan. Requires judgment; letters cannot calculate a finish date. |
| **B. Active effort range** | `Effort 2–4 h` | Numeric input for capacity and latest-start calculations | More direct date planning, but agent speed, retries and parallel work make ranges volatile. Needs active-time definitions and calibration first. |
| **C. Effort and complexity separately** | `Effort M · Complexity high` | Distinguishes long routine work from a short uncertain investigation | More expressive, but doubles editing and visual burden. Two estimates can age independently. |

**Recommend A:** one optional estimate with four defined bands. Include uncertainty when estimating, or split off discovery when the scope cannot yet be judged. Do not display hours, a completion percentage or a calculated finish date until measurements support them. Size must never silently change priority or extend a deadline.

## What the estimate means

Estimate the effort to finish the **current agreed scope**, including implementation, review, verification and any delivery work the task requires. Exclude waiting for dependencies, approvals, quotas or a calendar date; those belong in a hold. The estimate describes scope and remains stable as work progresses. Completed steps do not mechanically reduce it.

| Band | Definition | Example | Planning implication |
| --- | --- | --- | --- |
| S (Small) | One bounded change, known approach, focused verification | Correct a label and verify the affected views | Fits a short opening after higher-priority commitments are covered. |
| M (Medium) | One coherent change across related surfaces with ordinary review and tests | Add a field through storage, API and an editor | Reserve a complete lane including review and verification. |
| L (Large) | Several coordinated changes, meaningful investigation or substantial verification | Change task admission across several entry points | Plan milestones and check capacity before promising completion. |
| XL (Extra large) | Scope or uncertainty prevents a credible single-lane plan | Redesign a workflow across several subsystems | Discover or decompose before making a completion commitment. |

Examples anchor judgment; they are not an automatic classifier. File count, token count, task age and priority do not determine size. An absent estimate means **Unestimated**, never Small or zero effort. A large, well-understood task can remain Large even when its risk is low.

## Card, editor and ownership

Show a neutral `Size S`, `Size M`, `Size L` or `Size XL` label in the existing metadata line beside the due date, including on collapsed task cards. Do not reuse priority color, overdue styling or the status icon. Narrow layouts wrap metadata without hiding the title or covering actions. An accessible label spells out the value, for example “Task size: Medium.”

The task editor offers Unestimated and all four named bands with their definitions. Its expanded view shows “Operator” or “Seat,” the estimation time and an optional short rationale. It supports keyboard and touch. The collapsed card shows only the size and, when needed, “Review size.” Unestimated is visible in the editor; old cards need no permanent extra badge.

The operator may set, change or clear any estimate. The seat may fill a missing estimate and revise its own, with a rationale. It must preserve an operator estimate unless the operator explicitly requests a change. If it disagrees, it records the concern in the existing task note and plans conservatively.

A text or details edit marks an existing estimate for review. Reopening a completed task does likewise. Preserve the value so the operator can see what was previously assumed. A status change other than reopen, hold, priority, assignment or due-date edit does not itself invalidate size. A stale estimate must be checked against current scope before a new commitment uses it.

A size-only edit advances the revision but preserves `updatedAt`: planning metadata must not make an idle task look active. Scope edits retain their existing activity semantics. Preserve estimates on completion; do not turn them into actual-duration measurements.

## How the seat uses size and dates

1. Respect eligibility, holds, existing commitments and priority first. Size does not authorize otherwise blocked work.
2. When planning an unestimated or stale task, read its scope and estimate or confirm it. Use normal planning to handle missing estimates. Avoid extra wakes and bulk rewrites of old tasks. When discovery is needed, plan that bounded step explicitly.
3. Within otherwise equal priority and deadline pressure, prefer a smaller task that fits available capacity. Do not interrupt a running lane for this tie-break. Retain existing oldest-first fairness so large tasks do not starve.
4. Check that the proposed work, review and verification fit the available lanes before the deadline. Use actual capacity and a work plan; never translate letters into fixed calendar days. An XL task needs bounded discovery or separately tracked deliverables before claiming it can finish.
5. If work does not fit, start earlier, reserve capacity or propose a split. A high-priority L task due tomorrow stays high-priority and due tomorrow: produce a credible plan or explain the conflict. A low-priority S task can fill spare capacity without displacing urgent work.
6. On overdue work, keep the existing next-day / three-day / seven-day horizons and aging rule. Size informs whether a plan fits **inside** that horizon; it never multiplies it. If no plan fits, use the existing hold, split or close paths with a reason instead of promising an unsupported date.

Existing date authority remains intact: only the operator can clear a date; an agent must choose a future date; moving an already-overdue date requires `dueReason`. The existing three-slip reminder remains. Changing size alone neither writes a date nor increments or resets slip history.

This first version gives the seat planning evidence. It does not introduce a new automatic dispatch scheduler or claim a mathematical finish-date forecast.

## Data and state touched

References describe current code. Field names proposed in the last column do not exist yet.

| Surface | Current evidence | Proposed change |
| --- | --- | --- |
| Task record | `src/lib/tasks/types.ts:181` defines `BoardTask`; dates/history start at `src/lib/tasks/types.ts:239`; priority is at `src/lib/tasks/types.ts:272` | Add optional `sizeEstimate: { size: "s" \| "m" \| "l" \| "xl"; by: "operator" \| "agent"; at: string; reason?: string; needsReview?: true }`. No separate complexity field or personal identity. |
| Storage and legacy reads | `src/lib/tasks/store.ts:195` coerces records, including raw extension fields; `src/lib/tasks/store.ts:363` opens the SQLite collection | Validate the entire estimate. Invalid stored values become absent without losing the task. Use the existing payload and rollback export path; no second store, SQL index or bulk backfill. |
| Revision and activity | `src/lib/tasks/revision.ts:15` fingerprints persisted content; `src/lib/tasks/revision.ts:42` stamps revisions; `src/lib/tasks/commands.ts:517` defines presentation keys and `src/lib/tasks/commands.ts:744` preserves their activity time | Include size in revision protection; preserve activity time for size-only writes. Scope edits and reopen atomically mark review. |
| Shared writes | Create/patch inputs are in `src/lib/tasks/commands.ts:65` and `src/lib/tasks/commands.ts:97`; date admission starts at `src/lib/tasks/commands.ts:297` | Add size input with exact enum validation, rationale capped at 200 characters and `null` for clear. Derive provenance/time on the server; enforce operator ownership inside the locked mutation. |
| HTTP and typed client | `src/app/api/tasks/[id]/route.ts:23` identifies work instructions and `src/app/api/tasks/[id]/route.ts:26` identifies team-event fields; `src/components/tasks/taskApi.ts:68` and `src/components/tasks/taskApi.ts:138` type writes | Carry size through requests/responses and changed-field events. Keep project/revision conflict checks. Do not count size alone as an instruction to active workers. |
| Card and edits | `src/components/kanban/TaskMeta.tsx:14` decides metadata presence; `src/components/kanban/KanbanCard.tsx:672` renders it; `src/components/kanban/useTaskMutations.ts:78` defines field edits | Extend metadata and existing optimistic edits, including clear, conflict and rollback. Add localized editor controls. |
| Agent tools | `src/lib/mcp/server.ts:4066` and `src/lib/mcp/server.ts:4099` declare task tool fields; `src/lib/mcp/listAnswers.ts:21` constructs compact tasks | Add size to create/update schemas, compact lists, acknowledgements and full records. No full-task fetch solely to discover size. |
| Seat context | `src/lib/monitor/types.ts:615` defines task inputs; `src/lib/monitor/seatTickSources.ts:466` constructs overdue inputs; `src/lib/monitor/seatTickReminders.ts:98` orders overdue work | Carry size/provenance/staleness through relevant task projections and bounded reminder text. Preserve overdue selection/fairness; do not sort the sweep by size. Add the planning policy to seat instructions. |
| Date constraints | `src/lib/monitor/seatTick.ts:1497` supplies horizons; `src/lib/tasks/commands.ts:311` protects date changes; `src/lib/monitor/seatTickReminders.ts:105` adds the repeated-slip action | Preserve constraints. Use size to inform the plan and reason while preserving deadline admission and slip counting. |
| Linked boards | `src/lib/links/taskWire.ts:19` defines wire fields; `src/lib/links/taskWire.ts:105` restricts accepted keys | Keep estimates local initially, alongside local capacity assumptions. Do not add a wire field/version. Preserve receiver-local size on merge; received text/details changes mark it for review. |

An estimate is one atomic object. The writer supplies the band and optional reason, while trusted actor context supplies `by` and server time supplies `at`. Omitted input means unchanged; `null` clears it when authorized. Identical writes are no-ops. Reject malformed new input rather than silently coercing it to Small.

Confirmation clears `needsReview` only after reading current scope under the revision fence. The seat may confirm an operator value without taking ownership of it: retain that band, provenance and original estimate time. A concurrent scope edit must refuse stale confirmation. Agent attempts to change or clear operator-owned values receive a structured field-specific refusal through both HTTP and MCP.

## Implementation slices and acceptance criteria

### 1. Canonical record and shared contract

Add normalization, trusted provenance, ownership protection, scope/reopen invalidation and create/patch support. Carry the record through HTTP and MCP before seat planning relies on it.

- Old records remain unestimated. Malformed stored estimates do not hide tasks; malformed writes receive field-specific errors.
- Operator set/change/clear and seat set/revise/confirm obey ownership rules across entry points. Agent input cannot spoof operator provenance.
- Size-only writes survive reload, advance revision and preserve activity time. Scope edits/reopen atomically mark review. Concurrent stale writes fail without losing either writer's changes.
- Compact and full responses agree. Existing deadline/slip tests stay green. Linked-board exchange preserves local size and invalidates it after shared scope changes.

### 2. Card and editor

Add the neutral metadata label and controls using the existing task editing flow.

- Each band, Unestimated, clear and Review size can be exercised. Conflicts and failed requests restore the previous value with a readable error.
- Collapsed and expanded cards show assigned size. Size and due date coexist without obscuring priority, title or actions.
- Verify keyboard, touch, accessible labels, English/Ukrainian, light/dark and narrow layouts with synthetic tasks.
- Extend the existing kanban driver, `src/components/kanban/kanbanBoard.browser.test.tsx`, and phone driver, `src/components/mobile/issue1671Evidence.browser.test.tsx`. Retain rendered evidence; create no one-off capture driver.

### 3. Seat planning and due-date use

Expose estimates in seat context and teach the rules without changing deadline enforcement or overdue sweep ordering.

- Scenario checks cover urgent L due tomorrow, low-priority S with spare capacity, XL requiring discovery, stale scope, protected operator size, unavailable capacity and a fourth overdue slip.
- The seat supplies a feasible plan or split, preserves priority horizons and date authority, and never treats unknown effort as zero.
- Existing fairness and hold exclusions remain intact. Size edits alone neither wake the seat as new work nor make an idle task look active.
- Inputs remain bounded; no full-history scan or mass estimation occurs. Missing estimates are handled during ordinary planning.

Implementation tests must use private state directories, including `LLV_STATE_DIR`. Check this document through reference, prose, whitespace and privacy review.

## Questions for the operator

1. **Which scale should ship first?** Recommended: S/M/L/XL with the definitions above. Defer hours and separate complexity until useful calibration exists.
2. **Original scope or remaining work?** Recommended: current agreed scope, including required review and delivery. Track completion with steps; do not decrement size automatically.
3. **May the seat edit estimates?** Recommended: fill missing estimates and revise its own; preserve operator values. Allow confirming an operator value after scope review without changing provenance.
4. **Should size change date horizons?** Recommended: no. Use size to plan starts, capacity and splits inside the existing horizon, never as an automatic extension.
5. **Where should size appear?** Recommended: beside the due date on collapsed and expanded cards; put definitions/provenance in the editor. Avoid another colored status or a permanent Unestimated badge on legacy cards.
6. **Should linked installations share it?** Recommended: keep it local initially. Shared ownership and wire compatibility need an explicit later decision.
7. **What happens after scope changes?** Recommended: retain the band, mark Review size, and require scope review before a new commitment. Do not guess a replacement from the changed text.
