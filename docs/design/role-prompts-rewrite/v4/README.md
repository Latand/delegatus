# Variant 4 as shipped

The operator chose variant 4 on 2026-10-15: variant 2 of
`../../role-prompts-rewrite.md` (a universal core of twelve principles, thin
roles, Delegatus mechanics once per launch path) plus the memory delta of
`../../role-memory-to-prompts.md` §4 (principles 13 to 16, the sharpened
principles 6, 8 and 12, the conditional blocks, the seat block and the merger
default). "Who you are" and the reviewer labels WRONG-PREMISE and OVER-BUILT
stay word for word, and this repository's own procedures moved to
`AGENTS.md` and `CONTRIBUTING.md`.

The files here are the texts the code produces, rendered by the real
functions (`roleScaffoldBody`, `roleFenceBlock`, `orchestratorMandateForDelivery`,
`renderStagePrompt`, `renderLearnedRules`) with role parameters left as their
`{{tokens}}`. Each `roles/*.txt` is the scaffold layer as delivered (body,
blocks, working rules, fences); `builder.prototype.txt` is the builder in
prototype mode. `blocks.txt` lists the conditional blocks and where each goes.

## Where the shipped text departs from the two documents

Three limits in the code shaped the final text. Each departure keeps the
rule and changes only where or how long it is said.

- **The stage cap.** A stage stores its scaffold within 12,000 characters
  (`MAX_SCAFFOLD_LENGTH`), and an older release refuses to load a longer one.
  The reviewer therefore reads the TESTS, SHARED PATHS and SERVER classes in
  their judging form (`role-memory-to-prompts.md` §2.4) and the RENDERED block
  whole after its intro line. The fifth judging line of §2.4 (evidence without
  its revision, a date from a report's arrival, an ignored open pull request)
  is left out: principles 6, 8 and 14 of the working rules state it. The
  reviewer is 11,744 characters; a test keeps every role and variant at least
  200 characters under the cap. A text parameter value that would still push
  a stage's scaffold past the cap refuses the stage before it is stored,
  naming the parameter and how much to cut, so no stored scaffold loses the
  end of its rules; the reviewer has room for a diff source of about 300
  characters. An operator override stored near the cap is trimmed as before.
- **The seat's envelope.** A seat's first message, its scaffold plus the
  delivered mandate, shares one 32,000-byte structured envelope with its
  rotation history. The full working rules beside the v4 mandate come to
  33,177 bytes before any history, and a seat still holding a v54 mandate
  could no longer be respawned if the scaffold grew. So the orchestrator
  scaffold stays as small as it shipped (213 characters), and the seat reads
  all sixteen principles in a short form (`core.seat.txt`) inside its mandate,
  before "Before you decide". The short form keeps what the memory delta added
  to principles 6 and 12 (evidence from the final state with its revision,
  regenerated after a change and looked at before it is cited; repeated
  before/after measurements on identical load; publication checks before
  text leaves the machine; one attribution block). It pays for them with
  shorter wording elsewhere and two details of "Before you decide" that the
  search tool's own description carries (what is indexed, and the line a
  hit's byte offset pins). Seat scaffold and delivered mandate together
  are 30,037 bytes as sent, the room v54 left (30,007). An orchestrator stage or child
  reads the full working rules after its scaffold (`orchestrator.stage.txt`).
- **Who you are.** Kept word for word as v54 shipped it, so the two
  sentences variant 2 had folded into its rewritten version stay where they
  were: the clock's "Your drive to keep going works inside a turn" and the
  start-by-default bullet's "Proactive means carrying accepted work to its
  merge bar". The seat block follows as its own section, "Doing what was
  asked", and the delivered decision directive opens "Decisions." inside
  "Reaching the operator".

The merger's default for a project without a batch procedure has its own
paragraph: a plain squash of each exact reviewed head, with its own rows and
pass condition. The tuple, the full-validation receipt, the rebase landing
and the batch URL sit in the batch paragraph and bind only that path.

## How a stored seat or lane receives it

- Seats on v54 keep their mandate until they rotate. Delivery replaces each
  v54 directive that v55 rewrote by exact match: the clock section, the task
  section and the decision directive (`SHIPPED_*` in `prompt.ts`;
  `src/lib/orchestrator/fixtures/mandate-v54.txt` is the v54 default the
  test replays).
- A pipeline stage keeps the scaffold it was created with. The stage wrapper
  renders at every launch, and it shows the blocked fix-stage rule to a fix
  stage by its params (builder `mode=apply-fixes`) or by the fail edge that
  leads to it, so a lane created before this change still reads it.
