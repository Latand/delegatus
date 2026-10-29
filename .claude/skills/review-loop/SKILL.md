---
name: review-loop
description: Retired. Implement→review work now runs as pipeline run stages (builder, reviewer with a finite fail edge to an apply-fixes stage). Load this only to find where review loops moved; it points to the pipeline docs.
---

# Review loops moved to pipelines

Review flows are retired (`docs/design/retire-flows.md`). The server refuses
to start or drive one, so do not call `POST /api/flows`, `PATCH /api/flows/<id>`
or `flow_action`. Stored flows stay readable as history through `list_flows`,
`get_flow` and `GET /api/flows`.

Run implement→review work as one pipeline (`create_pipeline`) on the board task:

- a **builder** run stage writes the change;
- a read-only **reviewer** run stage with a finite fail edge,
  `onFail: { to: "fix", maxRounds: N, onExhausted: "advance" }`, N from 1 to 9;
- a **fix** stage (builder, `mode: "apply-fixes"`) whose `next` returns to the
  reviewer, so every round gets a fresh reviewer on the new head.

Do not compose a `review-loop` stage kind; it exists only for stored lanes.

An approval counts for the exact head the reviewer saw. A later commit needs a
new review. A parked stage is answered with `pipeline_action resolve-decision`.
`continue-review` is always refused: the review budget is fixed when the
pipeline is created, so a budget that was too small needs a new pipeline. A
terminal `advance` gate re-checks the last budget fix once before the lane
completes; a failed re-check parks the lane.

Read next:

- `docs/review-loop.md`: how a round runs and what happens when the budget is spent;
- `docs/pipelines.md`: the stage contract, edges and actions;
- the `delegatus-orchestration` and `delegatus-conveyor` skills for spawning and lanes.

This pointer stays for the compatibility window and is removed with the flow
tools (S9 of the retirement plan).
