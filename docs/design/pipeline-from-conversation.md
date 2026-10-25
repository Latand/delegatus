# Start a pipeline from this conversation

Design and prototype plan for board task `011cf8ec`. Source: Codex Cloud (GPT-6.1 Sol), result `21.diff`, collected 2026-10-23. Code references checked against `adce57649`.

## The operator's problem

“I have already explained the work here. The agent has investigated it and may
have started changing files. Let me turn this conversation into a pipeline that
builds, reviews and fixes the work on this branch, without making me write the
spec again or move the changes myself.”

The conversation is the source of intent; the current checkout is the source of
work. Starting from a generic board action loses that connection. Copying the
last message loses earlier constraints, corrections and decisions. Starting a
fresh worktree from the base branch also loses uncommitted changes.

Success means the operator can open the conversation menu, choose **Start
pipeline**, inspect the captured brief and target branch, and start a normal
pipeline. The resulting lane links back to this conversation and keeps its
context through review and fix rounds. This document proposes behavior; none of
the new request fields or ownership states below exists yet.

## Current code and the gap

References name the current implementation, before this proposal.

| Surface or state | Current evidence | Consequence for this design |
| --- | --- | --- |
| Creation and caller authority | `src/app/api/pipelines/route.ts:117` resolves operator/agent origin; `src/app/api/pipelines/route.ts:159` handles POST. | Reuse admission and same-origin checks. Resolve caller authority independently of source context. |
| Creation contract | `src/lib/pipelines/types.ts:1320` defines `CreatePipelineRequest`, including `spec`, `src`, stages, base and delivery. | There is no explicit conversation snapshot or current-checkout handoff contract. `src` alone is not context capture. |
| Validation and lineage | `src/lib/pipelines/engine.ts:12760` creates pipelines; `src/lib/pipelines/engine.ts:12818` resolves lineage; `src/lib/pipelines/engine.ts:12894` records it. | Preserve creator lineage separately from the immutable source snapshot, including when lineage resolves through a deputy. |
| Pipeline state | `src/lib/pipelines/types.ts:1115` stores spec, project, repository, checkout, branch and base; `src/lib/pipelines/types.ts:1160` stores source conversation identity. | Add explicit context and checkout-custody evidence; do not infer custody from the source link. |
| Durable storage and retries | `src/lib/pipelines/store.ts:42` identifies schema and storage; `src/lib/pipelines/engine.ts:12765` checks creation-key replays; `src/lib/pipelines/creationQueue.ts:44` queues creates. | Carry the same snapshot and request identity through queueing, retries and restarts. The current HTTP route does not supply the engine's creation-key option. |
| Transcript resolution | `src/app/api/session/route.ts:19` resolves the current transcript and `src/app/api/session/route.ts:27` checks allowed roots. That route admits Claude/Codex paths; `src/lib/session/reader.ts:21` separates messages, reasoning, tools and traces and also types Copilot results. | Resolve and capture on the server, with explicit support for each native format. Do not trust a browser-supplied transcript path or copy private reasoning. |
| Stage input | `src/lib/pipelines/prompts.ts:108` renders pinned task/spec; `src/lib/pipelines/stageInput.ts:22` composes input and materializes oversized text. `src/lib/pipelines/limits.ts:6` limits spec to 16,000 characters. | Keep a concise spec plus a separately retained context artifact; never silently truncate the conversation to fit `spec`. |
| Checkout provisioning | `src/lib/pipelines/git.ts:196` creates a worktree; `src/lib/pipelines/git.ts:257` implements asynchronous provisioning and checks branch ownership. | Passing a delivery branch does not promise reuse of the conversation's checkout. Borrowing an existing checkout needs a distinct path. |
| Cleanup ownership | `src/lib/pipelines/worktreeProvenance.ts:25` records creation provenance; `src/lib/pipelines/worktreeSweep.ts:44` describes checkout ownership and sweep guards. | A borrowed checkout must not become deletable merely because a pipeline names it. Audit provisioning and every cleanup path. |
| Project grouping | `src/lib/scanner/describe.ts:861` resolves parent-project identity, including retained worktree mappings. | Resolve the project through the existing algorithm. Preserve grouping after a checkout disappears. |
| Conversation menu | `src/components/mobile/MobileConversationMenu.tsx:50` defines the phone menu; `src/components/mobile/MobileConversationMenu.tsx:226` presents pipeline navigation. | Add the start action alongside existing navigation; an existing lane should offer opening that lane. |

## Three concrete variants

| Variant | Example | Benefit | Cost and limitation |
| --- | --- | --- | --- |
| A. Snapshot into a fresh lane | Capture this conversation, start Build → Review on a new branch from its committed head. | Smallest extension to existing provisioning; original conversation can continue separately. | Does not meet “on this branch/worktree.” Dirty work needs an explicit transfer; parallel conversations can diverge. Offer later as a separate choice, never as a silent fallback. |
| B. Snapshot and hand off the current checkout | Capture this conversation, reserve its checkout, run fresh Build → Review agents there with Review failure returning to Build. | Keeps files, branch and intent; uses normal stage verdicts and independent review. | Requires durable custody, quiescence checks, changed-state detection and cleanup protections. **Recommended.** |
| C. Make this agent the first pipeline stage | Attach the current conversation as Build, then start Review when it reports completion. | Preserves the agent's native working context and minimizes repeated investigation. | Existing agents were not launched with stage contracts, access policy or verdict obligations. Attempt adoption in `src/lib/pipelines/engine.ts:3667` is not evidence that arbitrary conversations can safely become stages. Most complex recovery and role transition. Defer. |

Choose B because the requested invariant is preserving the current branch and
files. Fresh stage agents receive an explicit, inspectable snapshot. The source
conversation remains readable but gives up its right to write while the lane
holds the checkout. No native session migration is required.

## Operator flow

1. From an open conversation, choose **Start pipeline**. Resolve its canonical
   conversation identity and current generation on the server.
2. Show a preview containing the task title, editable brief, source cutoff,
   project, repository-relative checkout label, branch, changed-file count,
   starting stage and publication setting. Default to **Build → Review**, with a
   fail edge back to Build using the existing review budget and exhaustion policy.
   Offer **Review current work** when the operator says implementation is ready;
   its failed review routes to a configured Fix stage, then back to Review.
3. Capture visible user and assistant messages through the last completed turn.
   Preserve corrections and their order. An unsent composer draft is excluded
   and named as excluded. For a running turn, offer **Wait for this turn** and wait for completion. Rebuild the preview after the turn settles.
4. The operator presses **Start pipeline** after inspecting the preview. The
   server revalidates the source revision and checkout, durably records the
   request, then obtains custody before launching any stage.
5. Open the lane and show **Continued from this conversation**. In the source,
   show **Pipeline is using this checkout** with an **Open pipeline** action.
   Source text can still be read. Sending another write-capable turn is blocked
   while custody is held; changes to the lane brief use existing lane controls.

Default this entry point to local-only publication (`internal`) and show that
setting plainly. Starting a pipeline is not implicit permission to publish the
conversation or its dirty files. The operator can select the existing remote
publication policy before starting. Completion uses existing pipeline behavior;
linking a board task does not automatically mark it as finished by this lane.

## Context and state contract

Proposed names below illustrate the contract and may change during implementation.

**Context snapshot.** Store an immutable `conversationSource` reference with
canonical conversation ID, captured generation, completed-turn cutoff, capture
time, content digest, and a versioned artifact reference. Include an editable
brief and acceptance criteria in `spec`. Retain normalized visible messages in
order in a private pipeline artifact. Exclude reasoning, credentials and raw
tool dumps; include selected tool evidence only with a visible provenance link
and explicit inclusion in the preview. State which attachments are available,
unavailable or omitted. Do not claim an inaccessible attachment was captured.

The editable brief is a concise account of the requested result, constraints,
decisions, work completed and work remaining. It can initially be deterministic
text selected from the conversation; automated synthesis is optional and must
not delay the basic handoff. Conflicting instructions remain visible for the
operator to resolve. Later conversation messages do not mutate a running lane's
spec. A revision creates an explicit new immutable snapshot.

All stages receive the pinned brief and access to the same captured context.
Reviewers still start fresh and judge the diff independently; previous assistant
claims and tool output require independent verification. Reuse stage-input
artifact handling, but ensure context is retained independently of the original
transcript and works within restricted stage sandboxes. Artifacts stay outside
tracked source files and out of PR descriptions. Missing or oversized context
must produce a clear preview error or explicit exclusion, never silent loss.

**Checkout custody.** Add an explicit mode such as `borrowed-conversation`,
separate from “created by pipeline.” Persist repository identity, checkout
registration identity, branch, starting HEAD, dirty-file inventory digest,
comparison base, source generation and custody operation ID. Full paths are
internal state only. The UI and public evidence use relative labels.

Resolve the actual checkout from source execution metadata and verify it with
Git; a transcript's old cwd is only a hint. The prototype accepts an existing
linked worktree on a named feature branch. Refuse the main checkout, detached
HEAD, protected/base branches, missing checkout, ambiguous repository, another
owning pipeline, unresolved merge and unknown source ownership. Explain the
specific blocker. Supporting the main checkout can be a later explicit mode.

Preserve tracked, staged, unstaged and untracked files in place. Never stash,
reset, commit or recreate them as part of admission. Ignored files remain in
place and are not claimed as captured context. Dirty state is shown before
handoff; changed HEAD, branch, index or file inventory invalidates that preview.
The comparison base must be resolved separately from starting HEAD: Review must
see the existing feature diff as well as subsequent fixes. Show the selected
base and require resolution when it is ambiguous; do not assume HEAD is the base.

**Ownership transition.** Use a durable operation progressing through
`prepared → waiting-for-source → reserved → admitted → released`, with a recorded
failure reason. Reservation requires an idle source, no queued delivery and no
owned background writer still using the checkout. Idle chat alone is not proof.
Integrate with source send admission and pipeline launch admission so neither
can obtain write access between validation and reservation. An external editor
cannot be fenced by Delegatus: disclose concurrent editing as unsupported and
recheck repository state immediately before the first launch.

Bind the reservation to one durable creation key and digest. A retry returns the
same operation/lane; different arguments under that key conflict. Queueing must
not let a stage start before custody is valid. On restart, reconcile operation,
lane and source generation before releasing or launching. Unknown ownership
waits with an explanation. A failed start with no live stage releases custody;
an ambiguous launch retains it until reconciled. Closing or completing releases
custody only after stage hosts, queued turns and owned writers are settled.

**Cleanup and task state.** Borrowed checkout lifetime remains the operator's.
Do not stamp creation provenance, remove its branch or delete its directory on
close, completion or sweep. Existing sweep logic considers a pipeline record
ownership evidence, so simply omitting a provenance file is insufficient. Apply
the borrowed-mode exclusion to archived lanes and every cleanup path. Use the
canonical project resolver and existing task-link rules; retain the source link
after release without converting the source into a stage attempt.

## Prototype slices and acceptance criteria

### 1. Read-only preview and snapshot

Add a server preview operation and a conversation-menu entry. Resolve the source
using the existing session/registry boundary; keep creation unavailable until
preview succeeds.

Acceptance: completed messages and corrections appear once and in order;
reasoning and unsent drafts are absent; missing attachments and omitted evidence
are named; long conversations are not silently truncated. Every supported native
conversation format produces the same snapshot contract. Changing the source
after preview makes the start request stale. This slice spawns nothing and
changes neither Git nor conversation execution state.

### 2. Durable handoff without stage launch

Add borrowed-checkout metadata, operation identity, source write admission and
reservation reconciliation. Exercise the transition with a fake launcher first.

Acceptance: double-click, timeout retry and queued-create replay produce one
operation; a changed branch, HEAD or dirty inventory is rejected; an active
turn, queued message, background writer or competing lane prevents reservation.
Crash each transition and recover to one owner or an explicit wait. Cancellation
before launch restores source write admission. Staged, unstaged, untracked and
ignored files remain byte-for-byte intact.

### 3. Run Build, Review and Fix in the borrowed checkout

Add a provisioning branch that verifies the reservation and uses the existing
checkout without calling worktree creation. Pass pinned context to fresh stage
agents. Keep ordinary pipeline creation unchanged.

Acceptance: the first stage sees the existing dirty work and branch; Review sees
the diff from the selected comparison base; a failed review reaches Fix/Build
with findings and returns under the existing round policy. Every stage receives
the same context digest. Restart does not launch a duplicate stage. Local-only
selection causes no remote publication. Source sends cannot race lane writes.

### 4. Release, cleanup and rendered operator flow

Wire the preview, progress, errors, lane link and source custody banner on
desktop and phone. Audit close, archive and sweep behavior for borrowed mode.

Acceptance: completion, close, failed admission and cancellation each restore
source access only when safe; borrowed checkouts and branches survive cleanup,
including archived-lane sweeps. Deleted-worktree history still groups under its
parent project. Capture the flow in English and Ukrainian, light and dark,
through the existing conversation-window, phone and board drivers. Keyboard and
phone users can inspect the preview, resolve a stale snapshot and open the lane.

Run only the touched tests by explicit path with private `HOME`,
`XDG_CONFIG_HOME`, `TMPDIR` and `LLV_STATE_DIR`; put heavy checks through the
repository's gate wrapper. Use synthetic repositories and transcripts. No test
may reserve a live checkout or act on the operator's runtime. This design-only
change requires reference, Markdown and privacy review.

## Questions for the operator

1. **Must the first version keep this exact checkout?** Recommended: yes, use
   variant B and initially support named feature branches in linked worktrees.
   Refuse unsupported targets visibly; offer fresh-lane variant A later.
2. **Should the current agent become Build?** Recommended: no. Start fresh stage
   agents with pinned context; defer native agent adoption until its role and
   recovery contract is designed.
3. **What happens if the source is still working?** Recommended: wait for its
   completed turn and owned commands, then refresh the preview. Provide cancel;
   do not interrupt or kill it implicitly.
4. **How much conversation should travel?** Recommended: all visible messages
   through a fixed completed-turn cutoff, with an editable brief and explicit
   attachment/evidence selection. Exclude private reasoning and raw tool dumps.
5. **What starts first?** Recommended: Build → Review with the established fail
   edge and budget. Offer Review → Fix for work the operator considers complete;
   always show the comparison base and existing dirty changes.
6. **May this action publish or finish the board task automatically?** Recommended:
   default to local-only publication and no automatic task completion. Make both
   choices explicit in the preview using the existing pipeline settings.
7. **Who owns the checkout after the pipeline ends?** Recommended: the operator
   always owns its lifetime; pipeline custody is temporary write access. Release
   it after writers settle and exclude it from automatic deletion permanently.
