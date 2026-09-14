# Kanban desktop board (#1695): open parity items

The implementation plan on #1695 carries the full parity ledger, capability by capability. This file keeps
the items that a merged or open slice left unfinished, so none is lost between slices. An item leaves this
list only when the change that closes it lands on `main`.

| Item | Where it shows | Why it is open | Closes in |
| --- | --- | --- | --- |
| Receipt cap drops Retry receipts | A bulk Undo refused for more than two tasks at once: the board shows at most three receipts, so the oldest error receipt and its Retry scroll away | Found after K4b review; the groups stay hidden and are listed in the Hidden tray | A later board slice |
| Conflict after a blur-save takes focus | A same-field conflict found after the operator left the field reopens the editor, which takes focus from where they went | Recorded with the K4b follow-ups | A later board slice |
| Escape on an edit notice | Escape on a focused Use theirs or Keep mine button does not cancel the edit; Escape works from the field | Recorded with the K4b follow-ups | A later board slice |
| C7 stage digest guard | Saving an unstarted stage's prompt (K5b) has no atomic server check that the stage is unchanged. Until C7 exists, the board re-reads the stage and compares before it saves. That leaves a race window, and a prompt another client saves inside it is overwritten. | C7 adds `expectedStageDigest` and 409 `STAGE_CHANGED` to `override-stage` in `src/lib/pipelines/{engine,types}.ts`, which open PR #1694 rewrites. It waits for #1694 to merge. K5 is not complete without it. | K5c, after #1694 |
| Stages button and pipeline actions on the card | The prototype's card pipeline header has **Stages** and a ⋯ menu | K5a ships the graph, summary and Past attempts. The Stages sheet and stage drafts come in K5b. | K5b |
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
| Lineage-adopted (`historical`) attempts are evidence, not stage attempts | The engine appends them when a stage agent brings in a conversation. It copies the source attempt's provenance onto them and excludes them from the fail budget. `latestOperationalStageAttempt` is the canonical selector. | Graph counts, fail budgets, the current attempt, node selection and live-edge marks all ignore them. Their conversations stay reachable in Past attempts, under "Helper conversations", labelled as helpers. |
