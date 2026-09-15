# Kanban desktop board (#1695): open parity items

The implementation plan on #1695 carries the full parity ledger, capability by capability. This file keeps
the items that a merged or open slice left unfinished, so none is lost between slices. An item leaves this
list only when the change that closes it lands on `main`.

| Item | Where it shows | Why it is open | Closes in |
| --- | --- | --- | --- |
| Receipt cap drops Retry receipts | A bulk Undo refused for more than two tasks at once: the board shows at most three receipts, so the oldest error receipt and its Retry scroll away | Found after K4b review; the groups stay hidden and are listed in the Hidden tray | A later board slice |
| Conflict after a blur-save takes focus | A same-field conflict found after the operator left the field reopens the editor, which takes focus from where they went | Recorded with the K4b follow-ups | A later board slice |
| Escape on an edit notice | Escape on a focused Use theirs or Keep mine button does not cancel the edit; Escape works from the field | Recorded with the K4b follow-ups | A later board slice |
| C7 stage digest guard | Saving a waiting stage's first message sends the digest of the stage configuration the save read (`expectedStageDigest`, from `GET /api/pipelines/:id` `stageDigests`). The engine checks it inside the same mutation that writes, after its own "stage not found" and "already started" answers, and a stage another client changed after the read answers 409 `STAGE_CHANGED` with nothing overwritten. The board reads again and shows the stage's words, or says only its account, role or runtime changed. The client comparison of words stays for the time the operator spent editing. | Implemented in K5c: `src/lib/pipelines/stageDigest.ts`, `override-stage` in `engine.ts`, the request and result types, and the route's `GET`. | K5c, when it merges |
| Server guard for retry and skip | `retry-stage` and `skip-stage` accept `expectedStageId` and `expectedAttempt` (the waiting stage's latest own attempt). The engine checks them inside the mutation, before any flow close, pane check, worktree reset or spawn, and a pipeline that no longer waits on exactly that answers 409 `STAGE_CHANGED`. The board sends the stage and attempt its menu showed; a refusal is explained from a fresh read and never resent. `stageId` keeps its launch-receipt meaning. The guard refuses a second retry whose first already moved the pipeline on. It checks a stated expectation only: a caller that states none, or reads again and states the newer attempt, is not held back. | Implemented in K5c, beside C7. Callers that state no expectation (VerdictPopover, mobile, MCP) keep today's behaviour. | K5c, when it merges |
| Stages button and pipeline actions on the card | The prototype's card pipeline header has **Stages** and a ⋯ menu | K5a shipped the graph, summary and Past attempts. The K5b PR adds Stages, the pipeline menu, the Stages sheet and waiting stages' first messages. | K5b, when it merges |
| An undelivered edit cannot be sent to the started conversation | A first message edited while its stage started stays beside the stage, marked not delivered, with Copy text, Open conversation and Discard | No route puts text into a conversation's composer from outside it, and sending it at once would speak for the operator without their say | A later board slice |
| Account, role, engine and model of a waiting stage | The prototype's waiting stage has an account chip, "Run on account…" and "Change role or engine…" in its menu, and a model pill in its closed composer | The board's waiting stage shows its engine and model and edits only its first message. The scheme board's stage placeholder changes the rest today. | K6 for the account; a later slice for role, engine and model |
| Conversation actions in a pane's ⋯ | The prototype's pane ⋯ lists Interrupt the turn and Open as a full pane beside the stage actions | On the board a pane's ⋯ holds the stage actions. The conversation's own ⋯ (full pane, link, Link/Unlink, Stop host) sits at the end of its identity row, and Interrupt is in its control strip. | Open decision |
| Stage names | Graph nodes and chips name a stage by its role (Builder, Reviewer…), or by its id when two stages share a role. The prototype's fixture gives stages their own labels (Implement, Review…). | Production stages carry no label field. The naming follows K2. | Open decision |

## Accepted corrections that supersede the prototype

Where the operator accepted a correction to the approved prototype, the correction is the requirement, and
the board follows it even where the prototype's own code does something else.

| Correction | Prototype behaviour it supersedes | What the board does |
| --- | --- | --- |
| #1695 binding correction 4, accepted 2026-09-14: "compact pipeline summary in cards, detailed graph in Stages" | `renderPipeline` opens the stage graph by default on an active workspace card with up to four stages | Every card starts on the compact summary. The toggle opens the graph and is remembered per card while the board is open. The detailed graph's full home is the Stages sheet (K5b). |

## Product rules the prototype had no case for

| Rule | Why | What the board does |
| --- | --- | --- |
| Retry and skip act on the stage the pipeline waits on | The engine's `retry-stage` and `skip-stage` apply to the cursor stage of a `needs_decision` pipeline; a stage id on `retry-stage` asks for a launch-receipt retry instead. | The pipeline menu names that stage ("Retry Verifier") and sends the action with the stage and attempt it showed (`expectedStageId`, `expectedAttempt`). The engine refuses when another stage or a newer attempt waits now, and the receipt names what waits. Elsewhere, and in the pane of any other stage, both are disabled with the engine's reason. The prototype's "Retry a stage…" chooser has no engine action behind it. |
| A write with no answer is not a refusal | A request that failed on its way back, or an answer without the route's error, may or may not have run. | Pipeline actions say "not confirmed" with a Check again that only reads and reports what the pipeline shows; nothing is resent. A stage message save says "Not confirmed", keeps the text, and settles only on what the stage holds. |
| Lineage-adopted (`historical`) attempts are evidence, not stage attempts | The engine appends them when a stage agent brings in a conversation. It copies the source attempt's provenance onto them and excludes them from the fail budget. `latestOperationalStageAttempt` is the canonical selector. | Graph counts, fail budgets, the current attempt, node selection and live-edge marks all ignore them. Their conversations stay reachable in Past attempts, under "Helper conversations", labelled as helpers. |
