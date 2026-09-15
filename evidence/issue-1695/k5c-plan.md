# K5c plan: server guards for stage edits, retry and skip (#1695)

Status: implemented in the K5c pull request, after #1694 merged and the root granted ownership of the
scoped handlers, the request and result types, the route's `GET` and `stageDigest.ts`. This file is the
design it was built from; the tests and the parity ledger record what shipped.

## Why

K5b ships the Stages sheet with client checks that are two requests each:

- Saving a waiting stage's first message reads the pipeline, compares the stage's words, then sends
  `override-stage`. A save from another client between the read and the write is overwritten.
- Retry and skip read the pipeline, check the stage it waits on, then send the action. The engine applies
  `retry-stage`/`skip-stage` to whatever stage waits when the PATCH lands. Another client acting in
  between can make it retry or skip a different stage, or retry the same stage twice.

K5 is not complete until the server refuses both atomically.

## Integration order

1. #1694 (publication policy) lands first. It rewrites `engine.ts` and `types.ts` (13 files, +712/−114),
   merges onto current `main` without conflicts, and the K5c handlers sit beside code it changes
   (`retry-stage` on review stages, the mutation result type).
2. K5c branches from the `main` that contains #1694 and adds, in one commit series:
   - `src/lib/pipelines/stageDigest.ts` (new, pure): `stageDigest(stage)`.
   - `types.ts`: optional request fields and the result code/field members below.
   - `engine.ts`: the three guards, each checked inside `withPipelineMutation` before any effect.
   - `src/app/api/pipelines/[id]/route.ts`: `GET` also answers `stageDigests`.
   - Kanban client: send the expectations, handle `STAGE_CHANGED`.
3. Other open PRs touching `engine.ts`/`types.ts` were checked line by line: every line #1677, #1679 and
   #1686 add is already on `main`, and #859 is dormant since 2026-08-02. None is an active owner.

## Contract

### `override-stage`

- Request: optional `expectedStageDigest: string`.
- Digest: SHA-256 (hex) over the canonical JSON of the target stage's
  `{ prompt, account, role, runtime: { engine, model, effort, access } }` as stored, with keys in a fixed
  order and absent values as `null`. `stageDigest.ts` is the one definition; the route and the engine use it.
- Answer when it does not match: `409 { code: "STAGE_CHANGED", field: "expectedStageDigest", error }`,
  checked after the existing "stage not found" and "stage has already started" refusals, so a started stage
  still answers the existing 409 unchanged.
- `GET /api/pipelines/:id` answers `{ ok, pipeline, stageDigests: { [stageId]: digest } }`. The client takes
  the digest from the same read it compares words against, so no client-side hashing (and no dependency on
  `crypto.subtle`, which a plain-HTTP LAN origin does not have).
- Absent `expectedStageDigest` keeps today's behaviour for every existing caller (scheme placeholder, MCP).

### `retry-stage` and `skip-stage`

- Request: optional `expectedStageId: string` and `expectedAttempt: number` (the `n` of the waiting stage's
  latest own attempt, as the caller saw it). `stageId` keeps its existing meaning on `retry-stage` (the
  launch-receipt retry, paired with `launchId`) and is not reused.
- Checked inside the mutation, before the survivor, orphan, flow-close and reset steps:
  `pipeline.state === "needs_decision"`, `cursor.stageId === expectedStageId`, and the cursor stage's latest
  operational attempt `n === expectedAttempt`.
- Answer when it does not match: `409 { code: "STAGE_CHANGED", field: "expectedStageId" | "expectedAttempt", error }`.
- With `expectedAttempt`, a second retry naming the attempt a first retry already moved past is refused, as
  the engine tests show for that sequence. It checks a stated expectation only: a caller that states nothing,
  or reads again and states the new attempt, is not held back.
- Absent expectations keep today's behaviour (VerdictPopover, mobile, MCP).

### Result typing

`PipelineMutationResult.code` gains `"STAGE_CHANGED"`; `field` gains the three field names. The route
already forwards `code`/`field`.

## Client changes (kanban)

- `stageDrafts.save`: send `expectedStageDigest` from the read's `stageDigests`. On `STAGE_CHANGED`, read again
  and settle as today: "Changed elsewhere · Use theirs / Keep mine" with the new words, or the started/ended
  outcomes. The ledger's C7 row closes; the words comparison stays for the edit-began-from window.
- `usePipelineActions`: send `expectedStageId` and `expectedAttempt` with retry and skip. `STAGE_CHANGED` reads
  and says what waits now; nothing is resent. The receipt stage name is then backed by the server's own
  check. With the guard in place, "Check again" after a lost answer could offer a guarded send; that is a
  separate decision and stays read-only in K5c.
- The ledger's "Server guard for retry and skip" row closes.

## Tests

Server (`src/lib/pipelines/engine.test.ts`, isolated state):

- `override-stage` with the current digest saves; with a digest from before another write answers 409
  `STAGE_CHANGED` and leaves the stage untouched (prompt, account, role, runtime each changed in turn).
- A started stage with a stale digest still answers "stage has already started".
- No `expectedStageDigest`: unchanged behaviour (existing tests stay green).
- `retry-stage` with matching expectations retries; with the cursor on another stage, or with a newer attempt
  on the same stage, answers 409 `STAGE_CHANGED` before any flow close, pane check or worktree reset (ports record
  no `closeFlow`, `exec` reset or spawn).
- Two retries with the same `expectedAttempt`: the second is refused.
- Same for `skip-stage`, including that the worktree reset never runs on a refusal.
- Receipt retry (`stageId` + `launchId`) unchanged, with and without expectations.

`stageDigest.test.ts`: stable across key order and absent-vs-null, and different for each field change.

Route (`src/app/api/pipelines/[id]/route.test.ts`): `GET` answers `stageDigests` matching `stageDigest`;
`PATCH` forwards `code` and `field` on `STAGE_CHANGED`.

Client:

- `stagesModel.test.ts`: the save sends the read's digest; `STAGE_CHANGED` re-reads and lands in "changed"
  with the new words; no second write.
- `KanbanStages.dom.test.tsx`: retry/skip bodies carry the expectations; `STAGE_CHANGED` reads and names the
  waiting stage; unknown outcomes still never resend.
- Browser (`issue1695Stages.browser.test.tsx`): the fixture answers `stageDigests` and `STAGE_CHANGED` like the
  engine; a stage changed by another client between read and write is refused by the server and keeps that
  client's words.

Red checks: remove each guard and each client expectation in turn; the named tests fail.
