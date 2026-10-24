# Agent progress estimate on the task card

Design proposal for board task `4ebe8b81`. Source: Codex Cloud (GPT-6.1 Sol), result `19.diff`, collected 2026-10-23. Code references checked against `adce57649`. Scope: an operator decision and implementation slices.

## The problem, in the operator's words

> Show on each kanban card how far the work is: an agent-reported estimate as a thin bar. Do not add new chrome where an existing control fits. Status stays a dot plus a short popover.

When several tasks are running, the operator wants to scan the board and distinguish work that has barely started from work nearing completion. Activity, time spent, and completed checklist items answer different questions. A task can be working at 20%, waiting at 80%, or almost implemented with substantial verification left. The estimate must describe the whole task, including review, checks, and delivery required by that task.

Success means the operator can compare rough completion at a glance, open the existing status dot for the number and its age, and recognize when no estimate exists. The bar expresses the agent's judgment of task completion. ETA and throughput require separate evidence.

## Options and recommendation

All options keep status as the existing dot and short popover. None adds a progress button, slider, badge, permanent percentage label, or separate disclosure.

| Variant | Concrete presentation | Benefits | Costs |
| --- | --- | --- | --- |
| **A. Inset bottom bar (recommended)** | A 2px track runs inside the card's bottom edge, inset by the card's horizontal padding. Fill represents 0–100%. The existing status dot reveals the estimate. | Visible on folded and open cards; independent of title wrapping and state-line width; consumes no extra row. | Must clear rounded corners, focus outlines, and resize/drag affordances. A missing estimate needs a distinct track treatment. |
| B. Bar under the title | The same 2px track sits immediately below the title, within existing spacing. The dot still owns the explanation. | Close to the task identity and easy to compare across short cards. | Competes with title editing, descriptions, and variable title height; can read as a title underline. |
| C. Bar within the state line | A short, fixed-width 2px track sits beside the dot in the existing state line. | Progress and its explanation are adjacent; small visual footprint. | Crowds spend and priority, has less useful resolution, and requires a placement fallback on cards with no state line. |

Choose **A**. It provides a consistent scan position and avoids an additional control. The progress track is separate from the colored card edge and the provider spend marks. Use one neutral foreground tone with sufficient contrast in each theme. Reserve status colors for the dot. No stripes, pulsing, automatic advance, or indeterminate animation.

Example: a waiting card with an estimate of 65% retains its waiting dot and shows a roughly two-thirds-filled bar. Opening the dot reads “Waiting for review · Agent estimate ≈65% · reported 12m ago.” Keep the existing status explanation first. Do not copy the agent's working notes into this popover.

## Interaction and state rules

- **Known estimate:** show the track and proportional fill on both folded and open task cards. Do not add a tab stop or pointer handler to the bar. Keep enough inset that it never replaces the card border or intercepts dragging.
- **Unknown estimate:** show a faint dashed track with no fill; the dot says “No agent estimate yet.” A reported 0% has a solid empty track and says “Agent estimate ≈0%.” Unknown is never silently converted to zero.
- **Status remains independent:** progress writes do not move columns, change the dot, clear a hold, mark steps done, or finish a task. A report of 100% means the reporter believes the work is complete; only the existing completion action sets Done. Done with no report still has an unknown estimate, with Done stated first in the popover.
- **Reopen and scope change:** a transition out of Done clears the estimate in the same task mutation. Other scope changes allow the responsible agent to lower or clear it. Never enforce monotonic progress; discovering more work is legitimate.
- **Age:** retain the last reported value while work is paused, blocked, or reassigned. Always show its report age in the popover. After 24 hours, qualify it as “Last agent estimate” and soften the fill without hiding it. The warning describes report age; the estimate may still be valid. No timer writes to storage.
- **No existing state:** for a persisted task lacking a derived state line, reuse the same dot component beside the title controls, with its short task-status fallback plus estimate. Render exactly one status dot; do not introduce a progress-specific icon. Cards without a persisted task, such as drafts, cannot receive a task estimate and omit the track.
- **Phone:** use the same bar. The current phone card is one button, so its inner dot stays passive. Include estimate and age in the card's accessible description, and expose the short explanation through the existing opened task surface. Do not nest an interactive dot in that button.
- **Accessibility:** a known estimate has a non-focusable progressbar semantic with task-specific name, minimum 0, maximum 100, and “Agent estimate, approximately …” value text. Describe unknown progress in text and omit a determinate progressbar value. Avoid duplicate screen-reader announcements between the card description and bar. The existing dot remains keyboard accessible on desktop; Escape closes its popover. No live announcement on every update.
- **Precision:** accept integer percentages, encourage agents to report in roughly 5-point increments, and prefix the displayed number with ≈. Use the reported number for fill; do not manufacture a more precise percentage from activity.

## Current code and data touched

References below describe the current implementation. Proposed additions are identified separately.

| Current location | What exists and what implementation must address |
| --- | --- |
| `src/lib/tasks/types.ts:181`, `src/lib/tasks/types.ts:206` | `BoardTask` owns persisted task data. Status, hold, and steps are separate fields; add an optional estimate record beside them. There is no overall progress estimate today. |
| `src/lib/tasks/commands.ts:551`, `src/lib/tasks/commands.ts:563` | `patchTask` validates mutations and supports project/revision guards. Add percentage validation, clear semantics, and atomic reopen clearing here, shared by all writers. |
| `src/lib/tasks/commands.ts:744` | Presentation-only writes preserve `updatedAt`; ordinary writes advance it. Estimate-only reporting needs an explicit equivalent rule so frequent reports do not reset task age, quiet-work guards, or ranking. |
| `src/lib/tasks/store.ts:195`, `src/lib/tasks/store.ts:658` | Stored optional fields are normalized on read; the immutable task source refreshes by revision. Add estimate normalization and verify persistence/reload and revision propagation. |
| `src/lib/mcp/server.ts:4099`, `src/lib/mcp/bindings.ts:2273`, `src/lib/mcp/bindings.ts:2316` | `update_task` publishes input fields, derives caller attribution, and invokes the shared command inside a mutation. Extend this route rather than creating a progress tool. Include the new field in compact read/acknowledgment handling as needed. |
| `src/app/api/tasks/[id]/route.ts:23` | HTTP mutation field lists include task content, status, hold, and steps. Review the request and team field lists together; do not let one transport bypass the estimate rules. |
| `src/components/kanban/kanbanModel.ts:84`, `src/components/kanban/kanbanModel.ts:941` | The card retains its `BoardTask`, while checklist projection is derived separately. Read the estimate from the task; do not derive it from the checklist or pipelines. |
| `src/components/kanban/KanbanCard.tsx:656`, `src/components/kanban/KanbanCard.tsx:700` | The card passes state, spend, and priority to `CardStateLine`; checklist summary appears separately when open. Add the passive bar at the card boundary and pass estimate context into the existing dot. |
| `src/components/kanban/CardStateLine.tsx:24`, `src/components/kanban/CardStateLine.tsx:111`, `src/components/kanban/cardState.ts:230` | `CardStateDot` already opens on hover, focus, or tap; its words come from `cardStatePopover`. Extend the short explanation while preserving its interaction and status priority. |
| `src/components/kanban/kanbanBoard.css:1961`, `src/components/kanban/kanbanBoard.css:2052` | State layout and spend wrapping already share limited space. Keep the track outside that flex row; verify card clipping, themes, and focus visibility. |
| `src/components/mobile/MobileKanban.tsx:578` | The phone reuses `CardStateLine` with a passive dot. Preserve that interaction contract. |
| `src/lib/links/taskWire.ts:18`, `src/lib/links/taskWire.ts:60` | Linked tasks use an explicit wire shape and encoder that do not carry an estimate. Version one keeps estimates local; remote cards show unknown instead of inferring progress. Cross-install reporting requires a later explicit wire contract. |

### Proposed record and mutation contract

Persist optional `progressEstimate: { percent: number; reportedAt: string; reporter: { kind: "agent" | "orchestrator"; conversationId: string | null } }` on `BoardTask`. Reporter identifiers are internal provenance, never displayed in public copy. `reportedAt` and reporter are server-derived. Do not accept them from agent input. A caller without reliable attribution records a null conversation identifier, never a fabricated one.

Extend `update_task` with `progressEstimate: { percent: integer } | null`. Omission preserves the record; null clears it. Reject fractions, non-numbers, non-finite values, and values outside 0–100, atomically with other fields in the request. Do not clamp. Existing tasks need no backfill; absent means unknown. Malformed legacy records normalize to absent. Persist the estimate in the existing task row.

The assigned lead agent, or the orchestrator coordinating its subtasks, reports the whole-task estimate. Parallel workers report their findings to that lead instead of competing to overwrite the aggregate. Preserve existing task authorization while following this reporting convention. Require existing project/revision guards for estimate updates, so concurrent reports fail with the established conflict response and the caller must read and reconsider. A current authorized lead can supersede a prior reporter; assignment handoff alone retains the old value and its age.

An estimate-only update changes the task revision and report timestamp, but preserves task `updatedAt`, status, status attribution, hold, and checklist. A combined substantive edit keeps the normal substantive timestamp behavior. Exact replay of one `clientRequestId` retains its original report time; a newly submitted report may reaffirm a percentage with a new time. Include the estimate in task reads and changed-field reporting so a successful write becomes visible through the existing board refresh path. Do not add polling dedicated to progress.

Agent guidance should ask for a first estimate after understanding scope, another when a meaningful milestone or discovery changes the estimate, and a final report at handoff. No heartbeat reporting and no automatic percentage from elapsed time, tokens, stage counts, or step counts. For example: implementation ready but required review and checks remain might justify a report of 75%. Existing notes remain the place for an explanation longer than the popover.

## Implementation slices and acceptance criteria

### 1. Store and report an honest estimate

Add the optional record, normalization, shared mutation rules, MCP schema/description, HTTP handling, read projection, and agent reporting guidance. No new endpoint or database table.

Acceptance criteria:

- A guarded agent update persists 0, 65, and 100 across reload; reads return server attribution and time. Omitted fields preserve it and null clears it.
- Invalid input or a stale revision rejects the whole write. Two writers using the same revision cannot both replace the estimate. Receipt replay preserves the original timestamp.
- Estimate-only updates refresh board data without resetting task age or changing status, hold, steps, or assignment. A combined content update retains existing content timestamp behavior.
- Reopening Done clears the estimate atomically. Older records read as unknown. Remote exchange continues to encode its existing supported shape without leaking local provenance.
- Focused command/store tests and MCP/HTTP integration tests cover these behaviors in isolated state.

### 2. Put the estimate on the existing card

Implement variant A on persisted task cards, the shared short popover wording, the no-state dot fallback, and the phone equivalent. Add English and Ukrainian copy.

Acceptance criteria:

- Folded and open cards show proportional fills for 0, 25, 65, and 100; unknown looks different from zero. No permanent number or new progress control appears.
- Status remains the dot and short explanation. A blocked card can show 80% without changing status; a 100% report does not move the task to Done.
- The popover states approximation and report age; old reports use “Last agent estimate.” The phone exposes equivalent information through its existing card/opened view.
- Keyboard, pointer, and touch access remain usable; bar semantics identify the task and estimate, with no added tab stop or duplicate announcement.
- Spend marks, priority, title editing, card menus, drag, resize, and collapse retain their existing behavior. Local and remote unknown cards use the same honest empty state.

### 3. Verify the board as the operator sees it

Use the existing kanban browser driver, phone driver, and board geometry capture named in repository guidance; add cases there rather than another one-off driver. Run captures with isolated state and check both languages and themes.

Acceptance criteria:

- Rendered evidence covers narrow and wide cards, folded/open cards, long titles, spend/priority, no derived state, unknown/zero/full/old estimates, and phone layouts.
- The 2px track is visible without obscuring borders or focus, and creates no extra card row or overlapping hit target. Existing geometry checks remain green.
- A persisted report appears after the existing refresh mechanism; a conflict leaves the prior bar intact. Reopen visibly returns it to unknown.
- Report the specific checks and rendered cases exercised. Check this document through reference, prose, whitespace and privacy review.

## Questions for the operator

1. **Where should the thin bar sit?** Recommended: variant A, inset along the bottom edge. It is the most consistent scan position and leaves the state line available for its existing content.
2. **What should cards without a report show?** Recommended: a faint dashed empty track plus “No agent estimate yet” in the existing explanation. Reserve a solid empty track for a real 0% report.
3. **Should 100% complete the task automatically?** Recommended: no. Keep completion explicit and retain the last agent estimate independently; clear it when Done is reopened.
4. **Who reports when several agents work on one task?** Recommended: the lead agent or coordinating orchestrator reports the aggregate, with revision guards. Do not average worker estimates.
5. **When should an estimate look old?** Recommended: after 24 hours, soften it and say “Last agent estimate,” while always making the actual report age available. Do not erase it simply because work is waiting.
6. **Should linked installations exchange estimates in the first slice?** Recommended: no. Keep the first version local and show remote estimates as unknown; add exchange only with an explicit compatible wire extension.
