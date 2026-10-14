# Review loops

A review loop is a read-only **reviewer** stage whose fail edge leads to a
**fix** stage that returns to the reviewer. Every round starts a brand-new
reviewer on the new head, with no memory of earlier rounds or of the builder's
conversation, so each verdict is an independent look at the whole diff. The
builder fixes what a review found; the loop repeats until a review passes or
the budget is spent.

The mandate tells the orchestrator to compose reviews this way and forbids the
older `review-loop` stage kind (`src/lib/orchestrator/prompt.ts`). The stage
contract, edges and actions are in [docs/pipelines.md](pipelines.md); the
operator's view of a review is in [Pipelines in depth](guide/pipelines.md).

## How a round runs

1. The stage before the review passes, and the pipeline starts the reviewer
   stage in the same worktree on the current head. Its role is read-only.
2. The reviewer reports through `stage_report`: `pass`, `fail` with findings
   ranked `P0` to `P3`, or `needs_decision`. A `needs_decision` that carries
   findings, on a stage with a fail edge, is routed like a `fail`.
3. On `fail`, the fail edge hands the findings to the fix stage. The fix stage
   (a builder in `apply-fixes` mode) repairs the findings and in-spec
   discoveries and adds checks; it fails only when blocked, with `blocked: true`
   and a `blockedReason`.
4. The fix stage's `next` returns to the reviewer, which starts fresh on the new
   head.
5. `pass` follows the reviewer's own pass edge.

## The budget

The number of rounds is fixed when the pipeline is created, on the reviewer's
`onFail` edge as `maxRounds`: three unless chosen, and at most nine
(`src/lib/reviewHistory/limits.ts`, `src/lib/pipelines/limits.ts`). What the
number buys depends on `onExhausted` below: under `advance` and
`stop-after-fix` N rounds are N reviews and N fixes, the last fix repairing the
final review's findings; under `park` N rounds are N fixes and N + 1 reviews.
Nothing adds a round afterwards: `continue-review` and the **One more round**
action are always refused (`src/components/kanban/stagesModel.ts`), so a budget
that was too small needs a new pipeline.

## When the budget is spent

The edge's `onExhausted` decides (`src/lib/pipelines/types.ts`). With
`maxRounds: 2` and a reviewer that fails every time:

- `advance`, the default: two reviews, and the last review's findings go to
  the fix stage once more. When that fix passes the pipeline follows the
  reviewer's own pass edge without a re-review, marking the fix as not
  re-reviewed.
- `stop-after-fix`: two reviews and the same last fix. If that fix wrote a new
  head, nobody reviewed it, and the pipeline waits in `needs_review` on that
  head until you press **Accept as is**. If the fix left the head unchanged
  there is nothing unreviewed to accept: the pipeline follows the reviewer's
  pass edge and completes (or moves on) without your acceptance, exactly as
  under `advance`.
- `park`: the second fix is followed by a third review. If it fails too, the
  pipeline parks in `needs_decision` at the reviewer before any further fix
  and waits for you. A third review that passes follows the pass edge.

## Defining one

A two-stage loop beside the build stage, from the example in
[docs/pipelines.md](pipelines.md#create-and-inspect):

```json
{
  "id": "review",
  "kind": "run",
  "role": { "roleId": "reviewer" },
  "access": "read-only",
  "prompt": "Review the full pinned task and acceptance criteria.",
  "next": null,
  "onFail": { "to": "fix", "maxRounds": 2, "onExhausted": "advance" }
},
{
  "id": "fix",
  "kind": "run",
  "role": { "roleId": "builder", "params": { "mode": "apply-fixes" } },
  "access": "read-write",
  "prompt": "Fix the findings handed to this stage.",
  "next": "review"
}
```

A legacy `review-loop` stage in a new pipeline is converted at creation into
this pair (`src/lib/pipelines/legacyReviewDefinition.ts`) only when the
conversion is provably safe: one read-write stage passes into it, its limit is a
finite number from 1 to 9 and the fix stage fits within the eight-stage limit.
Otherwise the stage is kept as written and the pipeline record carries
`legacyReview` with the refusal codes (for example `stage-count` for a full
eight-stage plan), so compose the pair yourself.

## Troubleshooting

- **A stage reported but nothing moved.** The attempt settles when its turn
  ends; a second `stage_report` before then replaces the first. See
  [Structured stage verdicts](pipelines.md#structured-stage-verdicts).
- **A reviewer turn ended without a readable verdict.** The pipeline checks the
  transcript up to three times and then parks in `needs_decision` naming the
  missing evidence. Continue the same conversation or close the pipeline.
- **A quota banner instead of a review.** The reviewer's engine hit its usage
  limit. Delegatus moves the stage to another allowed account; when none has
  room the stage waits. Or switch the stage's runtime from its conversation's
  runtime pill.

## Retired: review flows

Before pipelines, Delegatus ran implement and review rounds as a **flow**,
started from the **Flow** chip of the scheme view. Flows are retired
([docs/design/retire-flows.md](design/retire-flows.md)): nothing in the
interface starts one, the desktop has a single view, the board, and the phone
shows old flow rounds as history only. Stored flows stay readable. `/api/flows`
and the MCP tools `list_flows`, `get_flow` and `flow_action` still serve
existing flows, and their artifacts live under the state directory's
`flows/<id>/`. `.claude/skills/review-loop/` still describes flows, for agents
that drive old ones.
