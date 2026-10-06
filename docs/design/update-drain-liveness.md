# Update drain liveness: one verdict per recorded process — design

## Originating requirement

Source: the pinned specification of this pipeline's architect stage, filed
2026-10-06 after the independent review of #2555 returned `fail` and the lane's
stop rule sent it to an architect. Verbatim; the one redaction is the
machine-local scratch directory of the review, which is written here as
`<review scratch>`:

> PR #2555 (update drain keeps a live standalone turn when the registry lags
> the journal) went through four review rounds; each round found new seams in
> how the drain aggregates owners across registry entries, generations,
> transcript paths and journal rows (latest: synthetic owner collision hides a
> busy artifact path; a finished host's own writer claim held as setup; a
> sibling row inherits another row's dead-host reason; a dead prior
> generation's journal turn attributed to a live successor). The independent
> review's full report and repro suite: `<review scratch>`/REPORT.md and
> decisive.test.ts (read them first). Auto-updates are off on the operator's
> machine, so this is a design pass, not a hot fix.
>
> Deliverable: docs/design/update-drain-liveness.md with a pinned
> specification that removes the class of bugs, not each instance: the drain
> asks one question per physical process/owner (keyed by pid + start identity +
> artifact path), each answered from that owner's own evidence; deduplication
> happens only after verdicts; a finished/idle owner releases immediately; a
> busy one holds; unknown holds with a bounded timeout and a visible reason.
> Map every case in decisive.test.ts and the four findings to the rule that
> decides it. Say which parts of #2555 to keep, which to delete, and the
> smallest build plan. No code changes beyond the doc. Public repo: no
> identities or absolute home paths. No "not X, but Y" antithesis phrasing.

The requirement behind that one is issue #2515 (2026-10-05): the automatic
update drain counted ninety-three "running turns" while `agent_activity` with
`liveOnly` reported three, and every launch on the machine was refused for
hours. Its outcome, as #2555's brief restates it: a turn that is really running
always holds the drain, whatever the registry row says, and nothing that is
really finished holds it.

## Answer in short

Build it. The requirement asks for the removal of a class, and the class has
one cause that a further patch keeps: the drain asks about an *identifier* (a
conversation id, a transcript path, a session key), resolves that identifier to
evidence through four separate lookups, and each lookup picks one row from
several candidates. Evidence about one process is then judged together with
evidence about another.

The design replaces the identifier with the thing a restart lands on: a
recorded process and the transcript it writes. The drain lists every such
process the durable records name, judges each from the records that name that
same process, and groups the results by conversation afterwards. A conversation
id, a generation, a journal row, a stage and a flow name no process, so they
never select, replace or hide one.

No new store, no new persisted state, no new age rule, no change to the Update
dialog. The work is one pure census function, one decision table, one field
that the journal publications copied from the registry write (R5), and the
removal of most of the selection code #2555 added (its source diff is under
300 lines). An ADR is not needed: the change is internal and reversible.

## What the drain does today

Line numbers are on `main` at the base of this lane unless a section says
"#2555 head", which is the reviewed head of that pull request.

`probeQuiet` (`src/lib/selfUpdate/quiet.ts:222`) walks three populations:
running pipeline stages, review flows, and the session rows of the runtime
journal snapshot (`:347`). For each one it calls `turnLiveness`
(`src/lib/selfUpdate/instance.ts:92`), which returns four facts, each found by
its own lookup:

| Fact | Lookup | Row it picks |
| --- | --- | --- |
| `record` (turn state and a host) | `agentLivenessSnapshot({ conversationId })`, then by path (`instance.ts:105`) | the conversation's **current generation** path (`src/lib/lifecycle/liveness.ts:992`), then the **first** registry entry recorded at that path (`entryForPath`, `liveness.ts:352`, used at `:1164`) |
| `registryHost` | `conversationRegistryHost` (`liveness.ts:640`) | the entry under the **current generation's** key, else the first entry at its path, else any receipt of the conversation |
| `headlessReviewerProcess` | `headlessHostEvidence` (`liveness.ts:413`) | the first live flow round matching the path **or** the conversation |
| `currentTurnIdle` | `structuredDeliveryHostForConversation` (`src/lib/runtime/structuredDeliveryController.ts:1856`) | the host this Viewer holds under the **current generation's** key (`hostResolver`, `:223`) |

`judgeTurn` (`quiet.ts:105`) then combines the four. Nothing checks that they
describe the same process. They do when a conversation has exactly one
registry row, one generation, one transcript and one host. Every finding of
the last four rounds is a conversation where that does not hold.

Three more selections sit in front of the lookups:

- the journal snapshot returns every active session and the newest 128
  inactive ones (`RUNTIME_SNAPSHOT_INACTIVE_SESSION_LIMIT`,
  `src/runtime-host/journal.ts:77`), and a delivery fallback writes
  `unhosted`/`dead` labels over a row whose registry status lags
  (`registrySessionProjection`, `structuredDeliveryController.ts:497`), so a
  live turn can sit in the capped inactive set;
- on `main` the turn loop asks only rows whose journal labels claim a turn
  (`quiet.ts:348`), so a row the fallback relabelled is never asked;
- the journal keeps one row per conversation, so a conversation with two
  generations has one set of labels for two processes.

### What #2555 added

#2555 removed the label prefilter and added an inventory of registry owners
(`registeredTurnOwnerReader`, `instance.ts:164` at #2555 head) so the snapshot
cap no longer hides anyone. Both are correct in intent. The inventory, though,
is keyed by session key, falls back to path and then to conversation id, and
adds one *synthesized* owner per conversation before it adds the real entries
(`:175`–`:194`). The reader gained `separateEntry` (`liveness.ts:654` at #2555
head), which decides when a request names "a row other than the current
generation's" and substitutes the current row once that one's process is gone.
`hostEvidence` gained a setup flag derived from the row's status word
(`liveness.ts:397`).
`judgeTurn` gained a second argument, the journal row of the *conversation*
(`quiet.ts:112`).

Each addition is another place where one row is chosen for another. That is
where the four findings come from.

## The four findings are one defect

| # | Finding | Evidence that was joined across processes |
| --- | --- | --- |
| 1 | A synthesized conversation owner shares its key with the real entry, whose artifact has advanced; the real entry is refused as a duplicate and its busy transcript is never read | the entry's live process with the generation's settled path |
| 2 | A terminal status word turns a finished host's own writer claim into setup custody | one process counted as two owners, a host and a claimant |
| 3 | Two rows record the same transcript; the record is built from the first row, so the live idle second row reads `host_gone_turn_settled` and is held | the second row's process with the first row's host verdict |
| 4 | A journal row keyed to a dead earlier generation claims a turn; the helper substitutes the live successor and the claim is applied to it | the successor's process with the predecessor's journal claim |

Rounds one to three of #2555 and the last three rounds of #2532 found the same
shape: the 128-row cap, the label prefilter, the current generation standing in
for a live earlier one, a living previous host hiding a writer's setup.

## Options

**A. Patch the four findings on #2555.** About sixty lines: keep the entry's
artifact on a key collision, exempt a claim whose identity equals the host's,
prefer a live row in `entryForPath`, scope a journal claim to its key. It
leaves the identifier-keyed lookups in place. Each fix is one more rule for
which row stands in for which, and the review history is fourteen rounds of
exactly those rules. It also leaves #2555's cost: one keyed runtime read per
registered conversation the snapshot omits and one targeted liveness reading
(a `stat` and a tail read) per registered conversation, on every probe.
Rejected: it serves the instances and keeps the class.

**B. Trust the journal again and stop the fallback from relabelling.** Restore
the label prefilter and make `registrySessionProjection` keep a hosted/running
row. Small, and #2555's own brief named it as an alternative. The journal
still holds one row per conversation, a display cap, and labels that are
copies of what a host said earlier, so findings 3 and 4 stay and the cap
returns. Rejected.

**C. A census of recorded processes, each judged on its own records
(recommended).** Specified below. Roughly size-neutral against #2555: it adds a
census and a decision table and deletes the inventory, the substitution helper
and the combined judgment.

**D. Make the runtime host the authority on owners.** A durable owner table in
the journal, maintained by events. It would answer the same question from one
place, at the price of a new persisted model, a migration and a second writer
to keep honest. OVER-BUILT for a read-only admission check whose inputs are
already durable; kept under Deferred.

## Specification

### Terms

- **Owner**: one recorded process together with the transcript its record
  names. Its key is the process identity (pid and start identity, as
  `ProcessIdentity` in `src/lib/processIdentity.ts` records them) plus the
  artifact path.
- **Record**: a durable row that names a process: a registry entry, a launch
  receipt, a flow round, or a host this Viewer holds.
- **Claim**: a statement that work exists which names no process: a journal
  session row, a pipeline stage, a review flow.
- **Writer**: the structured claim an entry's host columns were written under;
  its **writer epoch** is `structuredHost.writerClaimEpoch`. An entry with a
  tmux host has no writer, whatever structured columns it keeps beside that
  host, and neither has an entry with no structured columns. A journal row
  names a writer only through a `writerClaim` string, whose epoch is the
  number the string ends with; a row whose `writerClaim` is `null` or missing
  names none (R5, source 3). Epochs count per session key.
- **Binding**: the conversation an owner is shown under and found by. Binding
  is used for display and for custody lookups. It never chooses evidence.

### R1 — One owner per recorded process and artifact

A registry entry is the durable record of where a process writes, so each
pair of a process and the artifact of an entry that records it is one owner.
A process that two entries record is two owners, one per artifact.

A launch receipt and a flow round record a process at launch time. When an
entry also records that process, the receipt or round describes the same
owner and adds only what it says about it; the artifact stays the entry's.
When no entry records it, the process is an owner at the receipt's or the
round's own path.

Nothing else is merged before a verdict: two processes that share a
conversation, a session key or a transcript are two owners.

### R2 — The census reads every record that names a process

| Record | Process it names | Role | Artifact |
| --- | --- | --- | --- |
| registry entry, `host` (tmux) | the agent and the pane process, one owner, alive while either answers | host | `entry.artifactPath` |
| registry entry, `structuredHost.process` | the engine host wrapper | host | `entry.artifactPath` |
| registry entry, each of `structuredTerminationSurvivors` | a child that outlived a kill | host | `entry.artifactPath` |
| registry entry, writer claim (`claimOwner` at the current `writerClaimEpoch`) | the claimant, when R6 makes it an owner | setup | `entry.artifactPath` |
| launch receipt, `admissionOwner` while the receipt is open | the admitting process | setup | `receipt.artifactPath` |
| launch receipt, `verifiedHost.agent` and `pane.panePid`, when no entry records that process (R1) | the launched host | host | `receipt.artifactPath` |
| flow round, `reviewerPid` with `reviewerIdentity` | the headless reviewer | reviewer | `round.reviewerPath` |
| a host this Viewer holds whose health reports a hosted status | the engine host, under the pid its health names when it names one | host | the artifact of the entry under the same session key |

The census has no status filter, no age filter and no size cap. A
conversation, a generation, a journal row, a stage and a flow name no process
and add no owner. In particular there is no synthesized owner: finding 1 has
nothing to collide with.

A row that claims a host and records no process (a hosted status with no host
columns, an open receipt with no admission owner) is listed as an **ownerless
record** and judged by R8.

### R3 — An owner's transcript is the one its own record names

The tail that is read for an owner is at the artifact path of the record that
names its process. A generation's path, a journal row's path and a sibling
row's path are never used in its place. When `AgentRegistry.upsert`
(`src/lib/agent/registry.ts:6649`) has advanced an entry's artifact past the
generation's, the entry's path is the one read.

### R4 — Process state comes from the owner's own identity

`identityAlive` (`src/lib/agent/accountLiveness.ts:112`) on the owner's own
recorded identity, and `headlessRoundProcess` for a reviewer:

- **gone**: the pid does not answer, or answers under another start identity;
- **alive**: the pid answers under the recorded start identity, or answers and
  the start identity cannot be compared. `identityAlive` already reads that
  as alive; `headlessRoundProcess` names it `unproven`, and the drain already
  holds on it.

A gone owner is released at once, whatever any claim or status word says. No
other record is consulted for it and no other row stands in for it.

### R5 — A host's turn is read from four sources, all its own

For a live owner in the host role:

1. **Handle**: the host this Viewer holds under the same session key as the
   owner's entry (`state.activeHosts`, by key; the existing
   `structuredDeliveryHostForConversation` resolves through the current
   generation and is not used here). Its health gives `busy` or `idle`; a
   health that reports `dead` or `unhosted` counts as no handle. The handle
   speaks for the structured host that entry records. When its health names
   another pid, or the entry records no process, the handle is the owner
   (R2) and a recorded process is judged without a handle.
2. **Row reference**: `structuredHost.activeTurnRef` of the owner's own entry,
   for an entry without a tmux host.
3. **Journal row**: the session row whose `sessionKey` equals the owner's
   entry key **and whose fence names the entry's writer**: the entry has a
   writer, and the row's `writerClaim` is a string ending in that writer's
   epoch. It counts when it claims a turn (`sessionClaimsOpenTurn`,
   `structuredDeliveryController.ts:544`: a running or interrupt-requested
   turn, an active turn id, a registering or recovering host). A row under
   another key, at another writer epoch, or naming no writer says nothing
   about this owner, and an owner whose entry has no writer reads no row.
   Production rows carry the full key: a host publishes under its entry's key
   and the fallback under the current generation's. After the build a row's
   fence always belongs to the row's own key (below), so the key and the
   epoch together name one writer. When the snapshot omits the conversation,
   one keyed read fetches it, for live owners with a writer only.
4. **Tail**: the turn state of the owner's own transcript (R3): `busy`, `idle`,
   or unknown when the file is missing, has no turn marker, or its tail was
   torn.

No source is reached through a conversation id, through a path another row
shares, through another row's key, or through another writer's epoch.

**How a journal row names its writer.** A host's own publication carries
`writerClaim`, the `<claimOwner>:<writerClaimEpoch>` of its entry, together
with that entry's key (`structuredDeliveryController.ts:666`; `null` once the
claim is released). The journal merges each publication over the row it
replaces (`src/runtime-host/journal.ts:2480`), so a field that a publication
omits survives from the row before it. A row whose `writerClaim` is `null` or
missing names no writer and is turn evidence for no owner:

- `null` is what every copy of the registry writes after the build (below),
  and what a host's own publication writes once its claim is released, when
  its handle speaks for it ("Rows that name no writer", below);
- a missing field is a legacy row. Every host's own publication has written
  the field since #1690 (2026-09-14), so a row without it was last written by
  a copy before the build or before #1690. A turn event that finds no row
  creates one without the field (`journal.ts:2489`), under a key that names
  the conversation id and no entry.

The runtime host's own session publications, the operation outcomes and the
spawn placeholder (`journal.ts:2288`), write no fence and keep the row's.
The placeholder also writes the key of a resume it admits, under a
`registering` host; that launch holds through its receipt (R2), and the
launched host's first publication when this Viewer registers it
(`structuredDeliveryController.ts:1485`) replaces the placeholder.

On `main`, three publications copy the registry and omit the field: the
fallback (`registrySessionProjection`, `:497`, published at `:1265`), the
publication for an entry with a tmux host, which reuses that projection
(`:610`), and the projection of a failed spawn (`projectDeadStructuredSpawn`,
`structuredSpawn.ts:1068`). Each writes its own session key. A fence that one
key's writer published therefore survives onto a row relabelled to another
key, and a successor recorded under that other key at its first claim, epoch
1, reads a predecessor's epoch-1 fence as its own. Epochs count per key, so
the epoch cannot tell the two apart.

**The build makes every copy of the registry name no writer.** The three
publications write `writerClaim: null`, which the merge applies like any other
field (`baseSession`, `journal.ts:282`, admits `null`). From then on:

- a row carries a fence only after a host's own publication, which wrote it
  together with the row's key, and loses it at the next copy. What lands in
  between keeps the fence, and of that only the spawn placeholder writes a
  key, for the span of a launch its receipt already holds (above). Outside
  that span a fence belongs to the row's current key, and the key and the
  epoch together name one writer;
- a turn event carries no key and no fence, and keeps both. A turn event that
  lands on a copy of the registry is attributed to no writer, and holds no
  owner, whatever its turn id says;
- the fallback's "already says this" check (`:1250`) also requires the row
  to carry no fence. Each Viewer start runs the fallback for every
  conversation it does not host whose current entry has structured columns
  or a tmux host (`:1769`), so the startup work of the build's first start
  rewrites every row that an earlier copy left with a fence. A row mixed
  before the build can hold its successor only until that pass reaches it.

The change lives in the Viewer, beside the drain that relies on it. An
incumbent runtime host merges the field as it merges any other, so the rule
holds from the first start of the build, whatever runtime host generation
serves it.

Two other readers of a row's fence keep their answers. The injection
admission (`journal.ts:2048`) and the idle kill fence
(`runtimeIdleKillMatches`, `src/lib/runtime/contracts.ts:410`) both require a
hosted row, and the idle kill fence also requires the revision it read, which
every publication moves. A copy publishes `hosted` only for a tmux entry,
which advertises no injection; its refusal reads `stale-generation` where it
read `unsupported-injection`.

Under one key, the epoch alone tells writers apart:

- the claim owner in the fence is the Viewer that controls the host (R6), so a
  successor claimed by the same Viewer carries the same owner string;
- `claimStructuredHost` (`registry.ts:7021`) raises the epoch for every new
  claim and writes it into the host columns, and only a writer that holds the
  claim at that epoch can change those columns afterwards
  (`setStructuredHostClaimed`, `registry.ts:6924`). A row at the entry's epoch
  was therefore published by the writer that recorded the entry's current
  host;
- a release (`releaseStructuredHostClaim`, `registry.ts:7119`) clears the owner
  and keeps the epoch, so a host whose claim was released still matches the
  row its last writer published, until the next publication for the
  conversation replaces it with one that names no writer. This pass found no
  path that removes an entry, so an epoch is never reused under one key.

**Rows that name no writer, and hosts that have none.** A row that names no
writer speaks for no owner under any key, and an owner whose entry has no
writer reads no row. No production host loses its own evidence by this:

- a structured host under a claim publishes its fence, and the turn events
  that follow keep it;
- a structured host whose claim was released publishes `null`, and only the
  Viewer that holds its handle publishes for it, so the handle (source 1)
  speaks for it;
- a structured host is recorded with a process only through a claim, at
  epoch 1 or later (`claimStructuredHost` raises the epoch before it writes
  the columns); the epoch-0 columns that production seeds
  (`pendingColumns`, `structuredSpawn.ts:1505`, and the recovery at `:668`)
  carry no process. Only a test's `upsert` records a structured process at
  epoch 0; such a host reads only a row fenced at epoch 0, which no
  production publication writes;
- a tmux host has no writer. Every row published under its entry is a copy
  of the registry: the tmux-host publication (`:610`) and the fallback. The
  copy turns the entry's status `live` into `turn: running`
  (`registrySessionProjection`, `:513`), and `live` is what the tmux observer
  writes whenever the pane answers (`src/lib/agent/transcriptHost.ts:718`,
  `:743`), so the copy's `running` records that the pane answers. A tmux
  host's turn is read from its tail (source 4). An entry that keeps a
  predecessor's structured columns beside a tmux host (`upsert` keeps columns
  a write omits, `registry.ts:6659`) has no writer either, so a
  predecessor's fence at the epoch of those columns does not reach it.

Binding such a row by key to an entry at epoch 0, as the previous revision
did, held a finished tmux host with no bound twice over: through a
predecessor's late turn event on the copy, and through the copy alone,
because of `live`. Both are in the case map ("The tmux successor").

**An adopted wrapper** is the one case where a new epoch records the same
process as the old one. The old row then says nothing about it, and the host
loses no evidence: the claim copies the host columns, `activeTurnRef`
included, into the new epoch, and the new writer's handle and publications
speak from then on.

### R6 — A writer claim is an owner only when it is doing setup

In production the claimant is the Viewer process that controls the host
(`captureProcessIdentity(process.pid)` at
`src/lib/runtime/structuredSpawn.ts:2100` and `:2155`,
`src/lib/runtime/registry.ts:516`), never the engine host itself. A live claim
at the current writer epoch is therefore the normal state of a hosted row this
Viewer controls, and it is the host's writer there. It adds **no owner** when
any of these holds:

- a. the claimant is the same process as a host the row records;
- b. the claimant is this Viewer process and this Viewer holds a handle under
  the row's session key;
- c. the row has a hosted status and records a live host process. The
  registry refuses a new claim over such a row (`claimStructuredHost`,
  `registry.ts:7021`), so the claim belongs to that host.

Otherwise the claimant is a **setup owner** for the row's artifact: the row is
terminal, where the registry admits a claim over an orphaned wrapper, or it
records no live host. It holds while its process lives and is released when
that process is gone.

Clause a decides finding 2 as the review reproduced it. Clause b decides the
same state as it occurs in production, where the claimant is the Viewer: a
host that this Viewer still holds, under a status word that lagged to `dead`
or `unhosted`, is judged by its handle and its tail.

### R7 — The verdict table

| Process | Role | Turn sources | Verdict | Reason code |
| --- | --- | --- | --- | --- |
| gone | any | not read | released | `process-gone` |
| alive | setup | not read | holds | `setup` |
| alive | reviewer | not read | holds | `reviewer` |
| alive | host | handle busy | holds | `host-turn` |
| alive | host | no handle, and the row reference or the owner's journal row (R5 source 3: a row whose fence names the owner's writer) claims a turn | holds | `turn-claimed` |
| alive | host | tail busy | holds | `turn-open` |
| alive | host | none of the above, tail idle | released | `turn-settled` |
| alive | host | none of the above, tail unknown | unknown | `turn-unread` |

Read top to bottom; the first matching row decides. Three consequences worth
stating:

- a handle that says idle supersedes the row reference and the journal row,
  both of which are copies of what the host said earlier. A settled tail
  under a live host whose own writer's row claims a turn, with no handle,
  still holds, as `main` pins it: only the host that would run the turn can
  say none was admitted;
- a busy verdict needs one positive sign from the owner's own sources, and an
  idle verdict needs a settled tail and no sign of a turn. A live process with
  neither is unknown;
- a row that an earlier writer published, under the same key or under the key
  a relabel replaced, is no sign of a turn for the host recorded now, and
  neither is a row that names no writer: a copy of the registry, or a late
  turn event on one. A successor host that is idle, with no row reference
  and a settled tail, is released at once, whatever its predecessor's row
  still says. A tmux host has no row reference and reads no row, so without
  a handle it is judged on its tail: busy holds, settled releases,
  unreadable is `turn-unread`.

A reading that throws is no verdict. It holds admission through
`blockers.unreadable`, as today, and is read again by the next probe.

### R8 — Unknown is bounded and visible

Three things are unknown:

- a live host owner with no sign of a turn and no settled tail (`turn-unread`);
- an ownerless record: a hosted row with no process, an open receipt with no
  admission owner (`launch-unproven`);
- a claim the registry knows nothing about (`unresolved`, R9).

Each holds for the launch grace, `UNRESOLVED_TURN_GRACE_MS`
(`quiet.ts:59`, five minutes), and is then released while it stays counted in
`blockers.unresolved`. The grace runs on the clocks the code already has, in
this order:

1. a hosted registry row with no process whose `updatedAt` is older than the
   grace is released at once, as `hostEvidence` decides today;
2. otherwise, when the item names a transcript whose newest record can be
   read, the grace runs from that record, as `evaluateLiveness`
   (`liveness.ts:525`) ages a host it cannot see;
3. otherwise it runs from the first probe that saw the item
   (`firstUnresolved`, `quiet.ts:220`).

No further age rule is added.

A process that shows a positive sign of work is never released by a clock. A
turn that is really running shows one well inside five minutes: its host's
handle, its row reference, its journal row or an open tail. A host that keeps
writing records with no turn marker in them stays held by clock 2 for as long
as it writes.

### R9 — A journal row is a claim

A journal session row does two things and no more:

- it is turn evidence for the host its session key's entry records under the
  writer its fence names (R5, source 3), and for no other owner. A row that
  names no writer is turn evidence for nobody;
- when it claims a turn and the registry holds nothing it names (no entry
  under its key, no conversation or receipt under its id, no entry or
  generation at its path), it is an unresolved claim, judged by R8.

When the registry does hold what the row names, the census has already asked
every process recorded there. A row at another writer epoch than its entry's
did not come from the writer of the host the entry records now, and a row
that names no writer (R5) sits over an entry the census has already read:
that host is judged on its own sources, and the row, while it still claims a
turn, counts in `blockers.discounted`. A
registry row that records no live process and is past its launch grace proves
that nothing owns the conversation, and the journal's labels do not reopen
it. The snapshot's inactive cap therefore bounds display only.

### R10 — A stage or a flow holds through every owner bound to it

A stage attempt, a flow implementer and a flow reviewer name a conversation
id, a path, or both. Their custody is decided on the **set** of owners bound
to that reference: every entry of every generation and alias of the
conversation, every entry and receipt at the path, every round that names
either. The existing stage rules then apply to the set:

- any bound owner whose process is alive: the stage holds;
- an ownerless record or an unresolved reference: R8;
- no live owner, and the reference's own transcript settled: `settled`, held
  for the bound while the controller collects the verdict;
- no live owner and no settled transcript: released.

The reference's transcript is the attempt's path, or the conversation's
current generation path when it names only an id. A reference to a deleted
earlier path still reaches the conversation's current process, because the
lookup returns the whole set. Dispatch markers, relay custody and the
reservation exemption in `flowCustody` and `reviewRoundOwner` are unchanged.

### R11 — Deduplication happens after verdicts

Owners that hold, or are unknown inside their bound, are grouped by display
id: the canonical conversation id of their binding, else their session key,
else their path, else their launch id. One group is one entry in
`blockers.turnList` and one in `blockers.turns`. Each entry carries the reason
code of its first holding owner. `blockers.discounted` keeps its meaning: the
journal rows that claim a turn while every owner they name is released.

`quietDispatchVersion`, the operator window, the memory gate, the busy reasons
and registry health are unchanged.

### R12 — Independence, as a testable property

The verdict of an owner is a function of the records that name its process
and artifact, its own transcript, its own handle and the journal row its own
writer published under its own key at its own writer epoch; an owner with no
writer reads no row. Adding, removing or changing any record that names a
different process leaves it unchanged, including records under the same
conversation, the same session key or the same transcript path, a journal
row that an earlier writer of the same entry published, a row that another
key's writer published and a relabel moved to the owner's key, and a row
that names no writer, whatever turn a late event wrote onto it.

This is the property the last fourteen rounds attacked one instance at a
time. It is checked directly: for a fixture owner, every verdict in R7 is
recomputed after a sibling row, an earlier generation, a successor generation,
an alias, a receipt and a foreign journal row are added in turn, and after
the conversation's journal row is set to a turn claim published under an
earlier writer epoch of the owner's own entry, or under another key at the
owner's epoch and then relabelled by the real fallback, or to a copy of the
registry that a predecessor's late turn event marks running, in each process
state, and must equal the verdict without that record. The fixture owners
include a structured host claimed at epoch 1 and a tmux host, the second
recorded both under its own key and under its predecessor's.

### `agent_activity` reads the same primitive

`hostEvidence` (`liveness.ts:362`) becomes a fold over the owners of one entry
from the R2 census, so the process rule has one implementation. A liveness
record stays one per transcript. Its host is chosen from every owner at that
path, a live one first, where `entryForPath` took the first row. A transcript
with a dead row and a live row then reports the live host in `agent_activity`
too, which is finding 3 at its source.

## Case map

### The repro suite

`decisive.test.ts` has fifteen cases over the real delivery controller and
`RuntimeJournal`. Its recorded run at #2555 head is 7 pass and 8 fail. Every
case starts from one conversation with one registry entry, a live process and
a transcript.

| Cases | Setup | Expected | #2555 head | Decided by |
| --- | --- | --- | --- | --- |
| self-claim × 2 (status `dead`, `unhosted`) | transcript settled, no row reference; the claim owner is the host process itself; the fallback relabels the journal row | quiet, 0 turns | fail: held as setup, past five minutes | R6a: the claimant is the recorded host, so there is one owner. R7: alive, no sign of a turn, tail idle, released |
| sibling × 2 (first row `dead`, `reused`) | a second entry under its own key at the same settled transcript, live and idle; the first row's process is dead or its pid was reused | quiet, 0 turns | fail: the second row inherits `host_gone_turn_settled` | R1: two owners at one path. R4 releases the first. R5 and R7 judge the second on its own entry and tail: released |
| sibling × 1 (first row idle) | as above with the first row live and idle | quiet, 0 turns | pass | R7 for each owner |
| stale journal × 2 (prior `dead`, `reused`) | the journal row keeps hosted/running and a turn id under the first generation's key; a successor generation is live and idle on a settled transcript | quiet, 0 turns | fail: the claim is applied to the successor | R4 releases the first generation's owner. R5 source 3: the row is keyed to that entry and says nothing about the successor. R7 releases the successor |
| collision, busy × 2 (with and without a journal row) | the entry's artifact has advanced to a second transcript with an open turn while the generation still names the settled one; another idle row sits at the settled path | held, 1 turn | fail: quiet, the busy path is never read | R2: no synthesized owner. R3: the entry's own path is read. R7: tail busy, holds. R11: one turn |
| collision, idle × 2 | as above with the second transcript settled | quiet | pass | R3 and R7: both owners settled |
| collision, dead × 2 | as above with the entry's process killed | quiet | pass | R4 |
| collision, reused × 2 | as above with the pid under another start identity | quiet | pass | R4 |

R5 source 3 leaves all fifteen as decided above. Only one pair has a journal
row that claims a turn, the stale-journal pair, and that row is keyed to the
first generation, whose owner R4 releases. Every other row in the suite is
the fallback's relabel, which claims no turn: it writes a null turn id and an
`unknown` or `idle` turn under a `dead` or `unhosted` host. No row in the
suite carries a fence, so no row names a writer, and none of the fifteen
verdicts rests on one. No case in the suite records a tmux host.

### The four findings

| Finding | Rule that removes it |
| --- | --- |
| 1. Synthesized owner hides the real entry's artifact | R2 (no synthesized owner), R3 (own artifact) |
| 2. A finished host's own writer claim held as setup | R6a for the reproduced shape, R6b for the production shape |
| 3. A finished sibling inherits the first row's gone host | R1, R5; the shared record through the `agent_activity` section |
| 4. A dead generation's journal claim attributed to its successor | R4, R5 source 3, R9; under one session key the writer epoch, across a relabel to another key the copies' `null` fence, and for a successor with no writer, a tmux host, the rule that such a host reads no row (all in R5; the next two sections) |

### The successor-epoch case

Raised by the critique of the first revision of this document, and confirmed
there against the real `AgentRegistry` and `RuntimeJournal`. It is finding 4
under one session key: process A publishes a running turn and a turn id with
writer epoch 1; its claim is released and it exits; `claimStructuredHost` and
`setStructuredHostClaimed` record a live process B under the same key at
epoch 2, `idle`, with no row reference. B's transcript ends in
`task_complete`, this Viewer holds no handle, and the journal row is still
A's. Keyed by session key alone, that row held B as `turn-claimed` with no
bound, so B inherited A's evidence. B's claim carries the same owner string as
A's when one Viewer makes both, with epoch 2 in place of 1.

The critique of the second revision found the same inheritance across keys.
There B is a new generation under its own key, recorded through the
registry's spawn request and settlement and claimed for the first time, so at
epoch 1, like A. The fallback (`bindStructuredDeliveryQueue([])`) relabels
A's row to key B and keeps A's fence, and a late turn event writes a turn id
onto it. Key B and epoch 1 both match B, so the epoch rule alone held B as
`turn-claimed` with no bound. The copies' `null` fence (R5) removes it.

| Variant | Expected | Decided by |
| --- | --- | --- |
| B idle, no row reference, settled tail, no handle; the row is A's at epoch 1 | released at once, `turn-settled`; the row counts in `blockers.discounted` | R5 source 3: epoch 1 is not B's epoch 2, so the row says nothing about B. R7 releases B. R9 counts the row |
| as above, with A's turn id written by a later turn event, which carries no fence | released at once | the row carries no fence at B's epoch: epoch 1 while nothing relabelled it, none after a copy; same rules |
| B under its own key at its first claim, epoch 1, idle, no row reference, settled tail, no handle; the fallback relabels A's row to key B, and a late turn event writes a turn id | released at once, `turn-settled`; the row counts in `blockers.discounted` | R5, "How a journal row names its writer": the copy wrote `null`, so the row names no writer and speaks for no owner. R7 releases B. R9 counts the row |
| as above, with the row relabelled before the build (key B, A's fence) and the build's Viewer started over it | released at once | the start's fallback pass rewrites a copy that still carries a fence (R5) |
| B's writer publishes its own row under key B at epoch 1 with a turn id, tail settled | holds, `turn-claimed`, with no bound | R5 source 3: B's own key and epoch |
| B's own row, then a copy of the registry over it, then a late turn event; B idle, no row reference, settled tail | released at once | the copy names no writer, so B is judged on its handle, row reference and tail (R7). The fence rule alone held B here |
| B's handle reports a turn | holds, `host-turn` | R5 source 1, R7 |
| B's row reference names a turn | holds, `turn-claimed` | R5 source 2, R7 |
| B's tail is open | holds, `turn-open` | R5 source 4, R7 |
| B's writer republishes the row at epoch 2 with a turn id, tail settled | holds, `turn-claimed`, with no bound | R5 source 3 at B's epoch, R7 |
| B's claim is released while B lives, and the row is B's at epoch 2 | holds while that row stands and claims a turn | R5 source 3: a release keeps the epoch. The next publication for the conversation names no writer (`:666` writes `null` without a claim owner, a copy writes `null`), and B is judged on its own sources from then |
| a claim at epoch 2 with no live host process, setup in flight | holds, `setup`, while the claimant lives | R6 |
| A is still alive at epoch 1 under the same key (no successor) | A's row is A's evidence: holds, `turn-claimed` | R5 source 3 at A's epoch |
| B is the same process as A, adopted from a terminal row at epoch 2 | judged on B's handle, the row reference the claim carried over, and the tail | R5, "An adopted wrapper" |

The four different-key rows and the late-turn-event row above were run
through the real registry, fallback and journal, on this lane's base and with
the build's change applied; "What this pass verified" gives the results.

### The tmux successor

Raised by the critique of the third revision, and confirmed there and in this
pass against the real `AgentRegistry`, fallback and `RuntimeJournal`, with
the copies' `null` field applied. A publishes a structured running row at
epoch 1, releases its claim and exits. B is a live tmux host, with no
structured turn reference and no handle, whose transcript ends in
`task_complete`. The fallback publishes B's key, a hosted host and a
`null` fence; a late turn event from A sets `running` and a turn id and keeps
both. The previous revision read the `null` fence as epoch 0 and gave B, a
tmux host, epoch 0, so the row held B as `turn-claimed` with no bound. The
same holds without A: the copy of a live tmux entry already says `running`
(R5, "Rows that name no writer, and hosts that have none"), and `main` holds
such a pane for as long as it lives.

| Variant | Expected | Decided by |
| --- | --- | --- |
| B a new generation under its own key, recorded with a tmux host at claim epoch 0 as a tmux launch records it (`spawnCommand.ts:1366`), status `idle`; the copy relabels A's row to key B; a late turn event from A; B's tail settled | released at once, `turn-settled`; the row counts in `blockers.discounted` | R5: B has no writer, so it reads no row, and the row names none. R7 on the tail |
| B recorded under A's key, as the tmux observer's `upsert` records it, which keeps A's structured columns at epoch 1 beside the tmux host, status `idle`; copy, late turn event, settled tail | released at once | R5: an entry with a tmux host has no writer, whatever columns it keeps |
| either B, with B's entry status `live` as the tmux observer writes it, in place of `idle` | released at once | as above; the copy's `running` comes from `live` and names no writer |
| a live tmux pane over a settled transcript, no predecessor, only the copy of its own entry | released at once, `turn-settled` | R5, R7. `main` holds it with no bound (probe below) |
| B under either key with A's fence still on the row (A's own row before any copy, or a copy made before the build), running, settled tail | released at once | R5: B has no writer, so A's fence does not reach it |
| B's own tail is open, under either key, with or without A's late event | holds, `turn-open` | R5 source 4, R7 |
| B's transcript has no turn marker | unknown, `turn-unread`, five minutes | R8 |
| a handle this Viewer holds under B's key reports a turn | holds, `host-turn` | R5 source 1 |
| control: B structured, claimed at epoch 1 under its own key; copy and A's late turn event | released at once | R5: the copy names no writer |
| control: B structured at epoch 1 publishes its own row with a turn id, tail settled | holds, `turn-claimed`, with no bound | R5 source 3: B's key and B's writer |

Release of a tmux host over a settled tail is the requirement's own case,
a finished owner. What it gives up is a message typed into a pane before the
CLI writes its first record of it: no source shows that turn until the tail
does. Known limits names it.

### Earlier rounds and the standing controls

| Case | Rule |
| --- | --- |
| Live turn relabelled by the fallback under a lagging `dead`, `unhosted` or `idle` status (the three cases #2555 started from) | R2 lists the process from the registry; R5 sources 2 and 4 show the turn; the journal labels select nothing |
| Live owner behind 129 newer inactive journal rows | R2: the census reads the registry; R9: the cap bounds display |
| An earlier generation's live busy process after a successor settles | R1, R2, R3: its entry is an owner with its own transcript |
| A second live row at the current transcript; a live row of an aliased conversation | R1; binding through the alias (R11) |
| Setup claimed over a living previous idle host on a terminal row | R6: the claimant is a setup owner and holds; the previous host is released by R7 |
| A settled hosted turn with its host's live writer claim | R6c |
| A writer claim with no host process and no receipt | R6: setup owner |
| An admitted resume with an open receipt over a settled transcript | R2: the receipt's admission owner is a setup owner |
| A receipt judged before its conversation exists: live, unowned, dead, reused | R2 and R7 for live, dead, reused; R8 for unowned |
| A turn id on idle journal labels over a settled transcript | R5 source 3, R7 `turn-claimed`, for a row whose fence names the host's writer. In production the same row carries the fence of the host that admitted the turn for as long as it is that host's own publication. The two fixture cases of this shape publish it with no field, one over the copy's `null`, so they gain the fixture host's fence (build step 4) and keep their expectation |
| A live tmux pane over a settled transcript | R5, R7 `turn-settled`: released. `main` holds it with no bound |
| A dead or reused owner releases at once | R4 |
| A settled idle turn stays quiet while its host lives | R7 `turn-settled` |
| An id nothing resolves releases after five minutes and stays counted | R8, R9 |
| A running stage keeps custody while a process of its conversation lives | R10 |
| A deleted generation, continuity or alias path still reaches the current process | R10: the lookup returns the set |
| An unreadable keyed read holds and recovers on the next probe | R7, last paragraph |

The two residuals #2555 declares in its body, both holds, are closed: a
terminal row whose live host still carries its writer claim (R6a, R6b), and a
second idle row at a shared transcript (R1).

## #2555: what to keep and what to delete

Keep:

- the removal of the journal-label prefilter in the turn loop (`quiet.ts:348`
  on `main`);
- `src/lib/selfUpdate/quietFallback.test.ts` whole: 87 cases over the real
  controller and journal. It is the regression oracle for this design, and
  all of it is expected to stay green with its expectations unchanged; its
  `journalRow` helper gains the fixture host's fence (build step 4);
- the path-bearing reservation change (`heldReservation`, `quiet.ts:307` at
  #2555 head) and its test;
- "first row wins" for a pathless stage owner's journal path (`quiet.ts:276`
  at #2555 head);
- the receipt reading that prefers a receipt still open
  (`receiptHostEvidence`, `liveness.ts:630` at #2555 head), which R2 folds
  into the census;
- the acceptance-4 exclusion inventory in the pull request body, as the
  record of where rows used to be ruled out.

Delete:

- `registeredTurnOwnerReader` and the `turnOwners` port (`instance.ts:164`,
  `quiet.ts:89` at #2555 head): replaced by the census. With it go the
  synthesized conversation owner, the `covered` and `included` sets, and one
  keyed runtime read per omitted conversation;
- `separateEntry`, `separateRowPath` and the `artifactPath` and `sessionKey`
  parameters of `conversationRegistryHost` (`liveness.ts:654`, `:624`):
  there is no current row to substitute for a named one;
- the setup flag derived from a terminal status (`liveness.ts:397`) and
  `turnPending` (`:620`): replaced by R6 and the role column of R7;
- the second argument of `judgeTurn` and the "settled journal and settled
  reading" branch (`quiet.ts:112`–`:124`): the journal row reaches an owner
  through R5 only;
- the per-probe memo of liveness readings in `turnEvidenceReader`
  (`instance.ts:93`): each live owner is read once by construction;
- the helper cases in `liveness.test.ts` that pin substitution (a separate
  row answering while alive and the current row afterwards).

`judgeTurn`, `TurnEvidence` and the `turnLiveness` port on `main` are replaced
by the R7 table and an owner-shaped port. `judgeStageOwner` keeps its outcomes
and takes the bound set of R10.

## Build plan

One pull request from `main` that supersedes #2555 and closes it on merge.
#2555 has spent its review budget, and a reviewer should judge the new reader
against this specification with a fresh one.

1. **Census, pure.** `src/lib/lifecycle/owners.ts`: `registryOwners(registry,
   flows, probe)` returning owners with their role, identities, artifact,
   entry key, writer epoch and binding, plus ownerless records. R6 lives
   here; this Viewer's own identity and the session keys it holds are passed
   in, so the function stays pure.
   `hostEvidence` and `entryForPath` in `liveness.ts` are re-expressed on it.
   No behaviour change for `agent_activity` except the live-row preference.
2. **Owner evidence.** In `src/lib/selfUpdate/instance.ts`, an owner reader
   replaces `turnEvidenceReader`: process state first; for live host owners
   only, the handle by session key, the row reference, the journal row
   matched by key and writer, and the tail. One small function beside the
   reader returns a row's writer epoch, the number a `writerClaim` string ends
   with, or none when the field is `null` or missing; another returns an
   entry's, `structuredHost.writerClaimEpoch`, or none when the entry has a
   tmux host or no structured columns. A row matches only when both are
   numbers and equal. One three-line accessor in
   `structuredDeliveryController.ts` returns the held host for a session key,
   next to `hasStructuredDeliveryHost` (`:1842`).
   The copies of the registry name no writer (R5): `registrySessionProjection`
   returns `writerClaim: null` (its result type gains the field), which covers
   the fallback and the tmux-host publication; `projectDeadStructuredSpawn`
   (`structuredSpawn.ts:1068`) writes the same; and the fallback's "already
   says this" check (`:1250`) adds `(current.writerClaim ?? null) === null`.
   Four lines in two files. #2511 works in `structuredDeliveryController.ts`;
   these edits stay inside `registrySessionProjection` and
   `publishCurrentFallback`.
3. **Verdict and fold.** In `src/lib/selfUpdate/quiet.ts`: the R7 table as one
   pure function, the turn pass over owners, the R9 claims pass, R10 lookups
   for stages and flows, R11 grouping, and `reason` on `BlockingTurn`.
4. **Tests.**
   - the fifteen cases of the repro suite, committed beside
     `quietFallback.test.ts` with repository-relative imports, since the
     scratch copy will not survive;
   - `quietFallback.test.ts` carried over with its cases and expectations
     unchanged; its six sites that wrap or replace the old `turnLiveness`
     port are pointed at the new one, and its `journalRow` helper publishes
     `writerClaim: "fixture:0"`, the fence a host's own publication carries at
     the writer epoch the fixture entry records. Two cases rest on it, "keyed
     reads retain a hidden journal turn hint over a settled transcript" and
     "an active turn id with idle journal labels protects a newly admitted
     turn over a settled transcript": without it the first row has no field
     and the second keeps the copy's `null`, both name no writer, and both
     would release. Every other `journalRow` case keeps its verdict with the
     fence: its tail is open, its process is gone, a handle reports a turn,
     or a later copy replaces the row;
   - the R12 property test, with the earlier-epoch journal row, the row
     relabelled from another key, and the copy marked running by a late turn
     event among its perturbations, over a structured owner and a tmux
     owner;
   - the successor-epoch cases of the case map, built through the real
     `claimStructuredHost`, `setStructuredHostClaimed` and
     `releaseStructuredHostClaim`, with the journal row published in the shape
     production writes, `writerClaim` included. The acceptance is the first
     row of that table: B idle with a settled tail is released on the first
     probe, with no five-minute wait, while A's row still claims a turn. The
     busy and current-epoch variants hold, and the turn-event variant
     releases;
   - the different-key successor of the same table: B settled through the
     registry's spawn request and `settleSpawn` under its own key, claimed at
     epoch 1, the real fallback (`bindStructuredDeliveryQueue([])`) relabelling
     A's row to key B, and a late turn event. The acceptance is that B is
     released on the first probe. With B's own publication at epoch 1 and a
     turn id, B holds. A row relabelled the way `main` relabels it (the
     fallback's publication with the field removed) is rewritten by the next
     controller start and then releases;
   - the tmux successor table, over the real registry, fallback and journal:
     B recorded with a tmux host as a tmux launch settles it (`settleSpawn`,
     claim epoch 0) under its own key, and as the tmux observer's `upsert`
     records it under A's key, keeping A's structured columns; A's own fenced
     row, then the real fallback, then A's late turn event. The acceptance is
     that B over a settled tail is released on the first probe under both
     keys and with B's status `idle` or `live`, that a live tmux pane with
     only the copy of its own entry is released, and that B's open tail
     holds. The structured epoch-1 controls keep their verdicts: a copy with
     A's late event releases, and B's own fenced publication holds;
   - tests that pin the payload of the fallback, the tmux-host publication or
     the failed-spawn projection exactly gain `writerClaim: null`;
   - the fixtures of `quiet.test.ts` and `quietDeadHosts.test.ts` publish
     rows with no `writerClaim`. Under R5 those rows name no writer. Every
     case of `quietDeadHosts.test.ts` that expects a held turn was read for
     this pass, and each rests on a receipt's admission owner, an open tail,
     a reviewer process or stage custody, none on such a row;
     `quiet.test.ts` injects its evidence and reads no row. A carried case
     that would only pass by reading a row that names no writer, or a row at
     another epoch, is a defect in that case, and the pull request names it
     and gives the row the fence its host would publish;
   - one case for R6b that no fixture covers today: a terminal status, a live
     host this Viewer holds, the claim owned by the test process and a
     settled transcript give a release; the same fixture with a handle that
     reports a turn gives a hold;
   - one case for `turn-unread`: a live host whose transcript carries no turn
     marker holds while its newest record is younger than five minutes, is
     released once that record is older, and stays counted; with no readable
     transcript the five minutes run from the first probe;
   - `quiet.test.ts` injects `TurnEvidence` at about twenty-six sites, and
     `quietDeadHosts.test.ts` at six, with seven more that build the
     production reader. Their constants (`RUNNING`, `SETTLED_LIVE`,
     `DEAD_OPEN`, …) become owner fixtures and the reader constructions take
     the new factory. The cases stay. An expectation that moves has to be
     traced to a rule of this document and named in the pull request;
   - the journal-row helper in `quietDeadHosts.test.ts` writes a session key
     with no session id. R5 matches a journal row by its full key, as
     production writes it, so the helper passes the fixture's own key;
   - a check to add before relying on it: a launch queued for account
     capacity (a receipt carrying `queuedPinnedSpawn`) is durable and has
     started nothing. This design pass did not confirm whether such a receipt
     keeps a live admission owner. If it does, R2 leaves that receipt out of
     setup custody, with a test.
5. **Checks.** Touched test files by path, one per process, with private
   `HOME`, `TMPDIR`, `LLV_STATE_DIR` and a closed `LLV_VIEWER_CONTROL_URL`;
   types and changed-file lint; the local privacy-publication gate from the
   merge base; `bun scripts/verify-runtime-host.ts --runtime <the Bun pinned
   in the Dockerfile>`, naming the runtime host as the process it exercised,
   because the drain reads the runtime host over its socket.

Expected cost per probe: one in-memory pass over the registry snapshot, one
pid probe per recorded process (memoized by pid), and a tail read plus at most
one keyed journal read per **live** host owner. This was derived from the code
and has not been measured. #2555 reads a tail for every registered
conversation.

Suggested bar for the build lane: the fifteen repro cases, the 87 carried
cases, the R12 property and the five suites the review ran beside them
(`quiet`, `quietDeadHosts`, `lifecycle/liveness`, `managedAuto`,
`runtime/hostlessSessionSettlement`) are green, with the test files of
`structuredDeliveryController.ts` and `structuredSpawn.ts` that the copies'
field touches; a review
finding that shows evidence of one process reaching another owner's verdict
is a failure of R12 and is fixed in the census or the reader, never by a new
selection rule in `quiet.ts`.

## Validation against the requirement

| The requirement asks | Where it is met |
| --- | --- |
| one question per physical process, keyed by pid, start identity and artifact path | R1, R2 |
| each answered from that owner's own evidence | R3, R4, R5, R12 |
| deduplication only after verdicts | R11; R1 pools records of the same process and nothing else |
| a finished or idle owner releases immediately | R4, R7 `process-gone` and `turn-settled`; R5 for a tmux host and for a successor under a copy that names no writer |
| a busy one holds | R7 `host-turn`, `turn-claimed`, `turn-open`, `setup`, `reviewer` |
| unknown holds with a bounded timeout and a visible reason | R8, reason codes in R11 |
| every repro case and the four findings mapped to a rule | Case map, including the successor-epoch and tmux successor cases |
| what to keep and delete from #2555, and the smallest build | the two sections above |
| no code changes beyond the document | this file is the only change |

Against #2515: the drain and `agent_activity` share one process rule and one
turn reading; a dead host never holds; an unresolvable row is counted and
bounded; a live tmux pane whose transcript settled no longer holds through the
copy of its registry row, which `agent_activity` already reported as idle.

What this pass verified and how: the code was read at the lane's base commit
and at #2555 head; the review report and the recorded run of the repro suite
(7 pass, 8 fail) were read; every repro case and every #2555 regression named
above was traced by hand through R1–R11. Nothing was executed against the
design, since it has no implementation yet.

The revision for the successor-epoch case read the registry's claim, release
and host-write paths and the journal's session merge on `main`, and ran one
probe against the real `AgentRegistry` and `RuntimeJournal` under a private
`HOME`, `TMPDIR`, `LLV_STATE_DIR` and `XDG_CONFIG_HOME`, with
`LLV_VIEWER_CONTROL_URL` on a closed port. The probe confirmed three facts R5
relies on: a fallback-shaped publication with no `writerClaim` leaves the
earlier writer's fence on the row; a release clears the entry's owner and
keeps epoch 1; a successor claim by the same Viewer records the new process at
epoch 2 under the same owner string. The rows that `decisive.test.ts`,
`quietFallback.test.ts` at #2555 head and `quietDeadHosts.test.ts` write were
read for their fence and their entries' epochs.

The revision for the different-key case read every session-status publisher
on `main` (the host's own publication, the fallback, the tmux-host
publication, the failed-spawn projection) and the other readers of a row's
fence (the injection admission, the idle kill fence, the delivery queue,
which compares against the registry's claim). It ran one probe under the same
isolation, against the real `AgentRegistry`, the real fallback
(`bindStructuredDeliveryQueue([])`) and the real `RuntimeJournal`: on this
lane's base, and on an export of it under the stage's temporary directory
with the four lines of build step 2 applied. The drain's verdict is
computed with the R5/R7 rule (key and epoch match, row claims a turn; B has no
handle, no row reference and a `task_complete` tail):

| Variant | Row on the base | Verdict on the base | Row with the change | Verdict with the change |
| --- | --- | --- | --- | --- |
| different key, relabel, late turn event | key B, epoch 1, running | holds, `turn-claimed` | key B, no fence, running | released |
| same key, epoch 2 successor, relabel, late turn event | the shared key, epoch 1, running | released | the shared key, no fence, running | released |
| different key, B's own publication at epoch 1 with a turn id | key B, epoch 1, running | holds, `turn-claimed` | the same | holds, `turn-claimed` |
| B's own publication, then a controller start's copy, then a late turn event | key B, epoch 1, running | holds, `turn-claimed` | key B, no fence, running | released |
| row relabelled the way `main` does it, then a controller start, then a late turn event | key B, epoch 1, running | holds, `turn-claimed` | key B, no fence, running | released |

In both runs A and B were claimed by the same owner string, A at epoch 1, and
B at epoch 1 under its own key or at epoch 2 under A's. The base run
reproduces the critique's finding. A third run with the `null` field and
without the change to the check at `:1250` decided the first four variants as
the change does, and left the last row mixed and B held: a start's fallback
pass skips a row whose labels it already matches, whatever fence the row
carries, which is why the check gains the fence. No file in the worktree other
than this document was written.

The revision for the tmux successor read the tmux observer's registry writes,
the registry's `upsert`, `claimStructuredHost` and the runtime host's own
session publications on `main`. It ran one probe under the same isolation,
against the real `AgentRegistry`, fallback and `RuntimeJournal`, on an export
of this lane's base and on an export with the four lines of build step 2
applied, both under the stage's temporary directory. A was claimed by the
probe at epoch 1, published its own running row with its fence, released its
claim and exited; B was recorded with a tmux host as described in the tmux
successor table; the real fallback ran, then A's late turn event. The verdict
is computed twice, with the rule of the previous revision (a `null` or
missing fence and a tmux host both at epoch 0) and with this revision's (a
row names a writer only through a fence, and a tmux host has none). B has no
handle and no row reference throughout:

| Variant | Row with the change | Previous rule | This revision |
| --- | --- | --- | --- |
| B under A's key (its entry keeps A's columns at epoch 1), status `idle`, settled tail | the shared key, `null`, running, A's late turn id | holds, `turn-claimed` | released |
| the same with status `live` | the shared key, `null`, running, A's late turn id | holds, `turn-claimed` | released |
| B a new generation under its own key, status `idle`, settled tail | key B, `null`, running, A's late turn id | holds, `turn-claimed` | released |
| the same with status `live` | key B, `null`, running, A's late turn id | holds, `turn-claimed` | released |
| a live tmux pane, settled tail, only the copy of its own entry | key B, `null`, running, no turn id | holds, `turn-claimed` | released |
| B a new generation, tmux, open tail, A's late event | key B, `null`, running | holds, `turn-claimed` | holds, `turn-open` |
| control: B structured, claimed at epoch 1 under its own key, copy, A's late event | key B, `null`, running | released | released |
| control: B structured at epoch 1, its own publication with a turn id, settled tail | key B, epoch 1, running | holds, `turn-claimed` | holds, `turn-claimed` |

On the base, where the copies keep A's fence, the four late-event variants
release under both rules (A's epoch 1 does not equal 0), the copy-only pane
holds under the previous rule (its row has no field, read as epoch 0), and the
structured epoch-1 control with A's late event holds under both, which is the
different-key finding the copies' `null` closes. The copy-only pane was also
run through `main`'s own `probeQuiet` with the production liveness reader:
its row read `hosted`/`running`, `agent_activity` reported the host alive and
idle, and the drain held one turn on the first probe and twelve hours later.
No file in the worktree other than this document was written.

## Decisions taken in this pass

- **A live process is released by a clock only when nothing shows work.** The
  requirement bounds "unknown". R8 reads that as an owner with no positive
  sign of a turn and no settled tail. #2555 holds such an owner for as long as
  its process lives, and `main` releases it at once when its journal row
  claims nothing. The bound sits between the two and follows the
  requirement's wording.
- **The journal row stays as turn evidence, scoped to its own key and the
  writer its fence names.** Dropping it would simplify the reader, and `main`
  pins the opposite since #2532: a settled transcript under a live process
  proves nothing until the host says it is idle.
- **Under one key, the writer epoch binds a row to its writer.** Comparing
  the whole `writerClaim` string would fail twice: the owner half is the
  controlling Viewer, the same for A and B when one Viewer claims both, and a
  released claim clears the entry's owner while the host and its epoch stay.
  The epoch is already written on both sides, so the check costs no new
  state.
- **Every copy of the registry names no writer, so no fence crosses a key.**
  Epochs count per key, so only the key can tell A's epoch 1 from B's. Three
  other ways were weighed:
  - a fence that names its key (`<owner>:<key>:<epoch>`) changes a string that
    the injection binding carries from the journal row to the delivery queue,
    where it is compared with the registry's claim
    (`structuredDeliveryQueue.ts:1805`), and fences written before it would
    still need a rule of their own;
  - the journal dropping a fence when a publication changes the row's key
    covers every publisher in one place, but it runs in the runtime host,
    which can serve a newer Viewer as an older generation until a succession
    (the hostless sweep's fenced write exists for that,
    `structuredDeliveryController.ts:1314`), so the drain could not count on
    it from its first start. It is under Deferred;
  - the copies clearing the fence only when they change the key leaves two
    gaps: the fallback reads no row at one of its call sites
    (`refreshCurrentProjection`, `:1278`), and a row mixed before the build
    already carries the new key, so it would stay mixed.

  The projection already says that it observed nothing about injection
  (`inject: false`, `:533`); a copy that keeps a writer's fence vouches for
  labels that writer never published. The rule decides every row of the
  successor table as the epoch rule did until a copy replaces a host's own
  row; from then a late turn event or a `live` status word on that copy no
  longer holds the host on a fence the copy did not write.
- **A row that names no writer speaks for nobody, and a host with no writer
  reads no row.** `null` and a missing field are read alike. Two narrower
  rules were weighed:
  - `null` names no writer while a missing field keeps binding by key at
    epoch 0, as a legacy policy. A copy that a live tmux pane received
    before the build has no field and says `running`; the start's fallback
    pass skips it while its labels match, because its check reads a missing
    field as `null`. The pane would then stay held exactly as on `main`;
  - rows without a fence keep binding at epoch 0 for structured entries and
    a tmux host reads no row. That spares the two fixture cases their fence,
    and keeps a rule that only a test's `upsert` exercises, under which a
    structured host recorded at epoch 0 inherits a predecessor's late event,
    against R12.

  Each narrower rule reads some fenceless row as a host's own report. The
  only host report without a fence is the `null` of a host whose claim was
  released, and its handle speaks for it (R5). The two carried cases that
  relied on such a reading gain the fence their host would publish (build
  step 4).
- **The handle binds by session key.** A health that names another pid makes
  the handle its own owner, which keeps a replacement host visible when the
  registry row lags.
- **`agent_activity` stays one record per transcript.** It gains the live-row
  preference and nothing else.

Known limits of this specification:

- R6c reads a status word. A status that lagged back to hosted while a setup
  claim is in flight would count that claim as the host's writer. A resume or
  a launch in flight also holds through its open receipt (R2), so the lag
  cannot release those. A startup adoption carries no receipt and has no such
  cover.
- A foreign live claimant, a second Viewer generation during a succession,
  cannot be asked what it is doing. It holds as a setup owner while it lives.
- The stage rules of R10 keep a stage while any process of its conversation
  lives, idle or busy, as they do today. Narrowing that is the pipeline
  controller's concern and is outside this requirement.
- A turn event with no fence that lands on a copy holds no host. The
  fallback copies the registry only for a conversation this Viewer does not
  host as a structured host, and such a host neither receives deliveries nor
  publishes events through this Viewer, so the turn events that reach that
  row are late ones. A tmux host publishes no turn events at all. A turn the
  host starts anyway, such as a CLI that continues on a background-command
  notification (Deferred), holds through its open tail from its first
  transcript record and shows nothing before it.
- A tmux host shows a turn only through its transcript. A message delivered
  into a pane holds the drain from the CLI's first transcript record of it;
  between the pane accepting it and that record nothing shows it, and an
  idle pane is released. `main` holds every live pane whose row the snapshot
  carries, idle or busy, with no bound.

## Deferred — not currently justified

- **Reason labels in the Update dialog.** The reason codes ship in
  `blockers.turnList` and in the `auto_updates` answer. Wording them in
  English and Ukrainian in the dialog is interface work with its own rendered
  evidence, and the counts shown today stay correct.
- **A durable owner table in the runtime host** (option D).
- **Stopping the fallback from relabelling a hosted/running journal row.**
  With R9 the labels decide nothing for a conversation the registry knows.
- **Dropping a fence in the journal when a publication changes a row's key.**
  It would also cover a future publisher that copies the registry and forgets
  the field. The three that exist are covered in the Viewer (R5), and the
  runtime host can run a generation behind the Viewer.
- **Releasing a host at once when its handle says idle and its transcript is
  missing.** It goes through the five-minute bound of R8 in the first build.
- **Persisting the first-seen clock across a Viewer restart.** A restart gives
  each unknown item a fresh five minutes, which is still a bound.
- **Comparing the boot epoch in `identityAlive`.** A reused pid after a reboot
  is already caught by its start identity.
- **One `agent_activity` record per owner.**
- **A turn signal for a tmux pane ahead of its transcript.** The Viewer could
  mark a pane's registry row when it types a message in, until the
  transcript records the turn. The window it covers is the time a CLI takes
  to write a prompt it accepted, and the requirement names nothing there.
- **A Claude CLI that continues on a background-command notification after
  its turn ended** (`docs/design/restart-stage-recovery.md`). The drain
  releases an idle host over a settled transcript at once, as it does today.

## Prior answers searched

Project-scoped and unscoped transcript and memory searches for the drain's
liveness verdict, per-process ownership, the owner inventory and the collision
of owners. Memory held nothing relevant. The transcripts hold the #2532 and
#2555 lanes and their reviews, which this document builds on; none of them
proposes a per-process model. The claim about who owns a writer claim was
checked against the code as it is now, as cited in R6.

For the revision: searches for the journal row's writer fence, a successor
under the same session key and a stale row across writer epochs found the
critique that raised the case and nothing earlier that binds journal evidence
to an epoch. Memory held nothing relevant.

For the different-key revision: project-scoped and unscoped searches for a
fallback relabel that keeps a writer claim, a fence carried across session
keys and a registry projection that names no writer found the critique that
raised the case, whose probe this revision extended, and the previous
revision's own reasoning; nothing earlier binds a fence to its key. Memory
held nothing relevant.

For the tmux revision: project-scoped and unscoped searches for a tmux
successor held by a cleared fence, a `null` writer claim read as epoch 0, and
a tmux pane counted as a running turn by the drain found the critique that
raised the case and this lane's earlier revisions, and no earlier decision
that a live idle tmux pane should hold the drain. The critique's conclusion
was read in its transcript and checked against the code and the probe above.
Memory held nothing relevant.
