# Update drain liveness: one verdict per recorded process — design

R8 defines the current release condition. Earlier revision narratives preserve
the evidence that led here; their release and timeout rules are superseded by R8.

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

No new store, no new age rule, no change to the Update dialog. The work is one
pure census function, one decision table, three small writes that make a
journal row say whose statement it carries (R5: a copy of the registry names
no writer, a host publishes only under the claim it was registered with, and
the journal records beside a row's status what its writer published, which
the drain reads as that writer's statement), and the removal of most of the
selection code #2555 added (its source diff is under 300 lines). The record
is one optional field on a row the journal already keeps. An ADR is not needed: the change is internal and reversible.

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
- **Status** of a journal row: its `host`, `turn` and `activeTurnId`, the
  three fields a turn claim is read from (`sessionClaimsOpenTurn`). The row's
  **status mark**, `writerStatus`, is the journal's record of what the row's
  writer last published: its session key, its fence and those three values.
  The mark **stands** for the owner its own key and writer epoch name,
  independently of the row's current fence. While that owner lives,
  the three values in the mark are that writer's statement, whatever later
  writes did to the row's own status (R5, "Whose statement a row's status
  is").
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

R8 adds ordered engine events to the journal source and governs settlement
across all four sources. The retained mark alone supplies no ordering proof.

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
3. **Journal row**: the status mark of the session row **whose mark names
   the owner's entry key and the entry's writer**: the entry has a
   writer, the mark's `sessionKey` is the entry's key, the mark's
   `writerClaim` is a string ending in that writer's epoch. The `host`, `turn` and `activeTurnId`
   read are the ones in the mark, which its writer published; the row's own
   three fields are not read for the owner. It counts when the mark claims a
   turn (`sessionClaimsOpenTurn`, `structuredDeliveryController.ts:544`: a
   running or interrupt-requested turn, an active turn id, a registering or
   recovering host). A mark under
   another key or at another writer epoch says nothing about this owner. A
   row with no mark and no writer says nothing either. A retained mark
   survives a foreign publication that changes or clears the row's fence. A
   write that changed the row's
   status and named no writer leaves the mark as the writer published it, so
   it neither adds a turn to the owner nor takes one away. An owner whose
   entry has no writer reads no row. A row under the owner's key at the
   owner's fence that claims a turn and carries no mark at all was written by
   a journal that kept none; who set its turn is unknown (R7, R8).
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
(`structuredDeliveryController.ts:1485`) replaces the placeholder. A fence
kept this way vouches for nothing the keeping write set: the writer's
statement is read from the status mark, which such a write leaves as the
writer published it ("Whose statement a row's status is", below).

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
  owner, whatever its turn id says. One that lands on a host's own row leaves
  that host's status mark as the host published it, so it adds no turn to the
  host and takes none away (below);
- the fallback's "already says this" check (`:1250`) also requires the row
  to carry no fence. Each Viewer start runs the fallback for every
  conversation it does not host whose current entry has structured columns
  or a tmux host (`:1769`), so the startup work of the build's first start
  rewrites every row that an earlier copy left with a fence. A row mixed
  before the build can hold its successor only until that pass reaches it.

This change lives in the Viewer, beside the drain that relies on it. An
incumbent runtime host merges the field as it merges any other, so the rule
holds from the first start of the build, whatever runtime host generation
serves it. The status mark is the one part the runtime host writes ("Rows
without a mark", below).

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

**Whose statement a row's status is.** A fence says who last published the
row. Who last changed its turn is a separate fact: five kinds of write change
`host`, `turn` or `activeTurnId`, and only the first names a writer.

| Write | Where | Names |
| --- | --- | --- |
| a host's own publication | `publishHostState`, `structuredDeliveryController.ts:593` | its writer and its key (`:666`) |
| a copy of the registry | the fallback, the tmux-host publication, the failed-spawn projection | no writer: `null` after the build |
| a turn event a host's pump forwards | `projectEngineHostEvent`, `src/lib/runtime/engineHostEvents.ts:286` and `:335`, appended at `structuredDeliveryController.ts:1544` | a conversation id and a turn id |
| the turn a send's outcome records | `journal.ts:2466` | a conversation id and a turn id |
| the runtime host's own rows: an interrupt request, the spawn placeholder, the `dead` row of a failed spawn or of a delivered kill | `journal.ts:2250`, `:2286`, `:2411`, `:2441` | a conversation id; the delivered kill also compares the session key |

The journal applies the last three kinds to whatever row the conversation has
(`journal.ts:2480`, `:2488`) and keeps that row's fence. A pump's append that
was in flight when its host was released (`stopEvents`,
`structuredDeliveryController.ts:1558`, does not wait for it), a send outcome
reported late, or an interrupt request then sets `running`, a turn id or
`interrupt_requested` on a row that carries the successor's fence. Read by key
and epoch alone, that row held a finished successor as `turn-claimed` with no
bound: a predecessor's turn under the successor's name. The case map has it
as "The delayed predecessor write".

**The journal records what a writer published, and the reader reads that
record.** One write and one read:

- when a publication names a writer and carries all three status fields, the
  journal sets the row's `writerStatus` to the session key, the fence and the
  `host`, `turn` and `activeTurnId` that publication left on the row. Every
  other write keeps the record as it finds it, and a `writerStatus` sent in a
  payload is discarded;
- the reader takes a writer's statement from the record by the key and writer epoch recorded in the mark, and
  gives it to the owner whose entry key and writer epoch the record names.
  The row's own `host`, `turn` and `activeTurnId` are not read for that
  owner.

A writer's statement therefore changes only when a publication replaces it:

- the same writer's next publication records its next statement. A host
  publishes on every change of its turn (below), so its own idle publication
  is what ends its own turn claim;
- a publication that names no writer, a copy of the registry or a host's own
  publication after its claim was released, writes `null`; the row no longer
  carries the record's fence. The retained mark still speaks for the owner
  its own key and writer epoch name; that copy cannot withdraw its claim;
- another writer's publication records that writer's statement in place of
  the first one, since the journal keeps one row per conversation (R12).

Turn events, send outcomes, interrupt requests, spawn placeholders and the
runtime host's `dead` rows get no field of their own and need no change. They
change the row the board reads and leave the record, so a predecessor's
delayed `turn-started` adds no turn to a successor that published idle, and a
predecessor's delayed `turn-ended`, or its `turn-started` under another turn
id, takes nothing from a successor that published a running turn. A host's own
turn event is read directly in journal order under R8, including the interval
before its queued status publication lands. The fence is untouched, so the
injection admission and the idle kill
fence read what they read before.

The record sits in the journal, and the reading in the reader, on purpose. A
record that carries the published values needs no cooperation from the
writes that follow it: a writer added later, or a runtime host from before
the build that projects a turn event over a row the build marked, changes the
row and leaves the record. The record carries the key because a writer is a
key and an epoch: the spawn placeholder moves a row to the key of a resume it
admits and keeps the fence (`journal.ts:2286`), and the record goes on naming
the key whose writer published it, so the epoch on the row never speaks for
the new key's writer.

A host's own turn reaches the row through its publication, which the
controller makes on every change of the host's `activeTurnRef`
(`hostProjectionKey`, `:211`; the listener at `:1503`). The persistence
binding writes the same change to the registry row under the claim
(`bindStructuredHostPersistence`, `src/lib/runtime/registry.ts:154`), so the
row reference (source 2) shows a turn whose publication has not landed.

**A host publishes only under the claim it was registered with.**
`publishHostState` finds its entry by session key at each publication and
reads the fence there (`entryForHost`, `:189`; `:666`). A registration that
outlives its claim, with a successor already claimed under the same key,
therefore published its own host's turn under the successor's fence. The build
records the entry's writer epoch on the seat when a host is registered,
carries it through a controller swap (`activeRegistrations`, `:1627`), and
publishes nothing for a seat whose entry has moved to another epoch. Epochs
only grow under a key, and a host object is bound to one claim for its life
(`setWriterFence`, `src/lib/runtime/registry.ts:164`), so the recorded epoch
names that host's writer for as long as the seat exists. The fence a
publication writes comes from the same read of the entry as that check, so a
publication that passes it carries its own writer's fence even when a
successor claims the row a moment later; such a row is the predecessor's by
its epoch, and the successor reads nothing from it. A released claim keeps its
epoch: such a host keeps publishing, with a `null` fence, as today. An entry
with a tmux host publishes the copy, as today.

**Rows without a mark.** The runtime host writes the mark. A runtime host
from before the build writes none and drops one when it merges a publication
(`baseSession` builds the row from the fields it knows), and a web-first
succession runs the new Viewer over the old host until the host hands over
(`docs/design/self-update-auto.md`, "The succession in a checkout install").
A row last published in that state, or before the build, carries a fence and
no mark, so nothing recorded who set its turn. An answering owner holds this
claim as `turn-unattributed` under R8. Only an ownerless launch that never
proved work receives bounded grace. The Viewer start's fallback pass rewrites
such a row for every
conversation that Viewer does not host (above), and a hosted one is judged by
its handle.

**Rows that name no writer, and hosts that have none.** A row that names no
writer speaks for no owner under any key, and an owner whose entry has no
writer reads no row. No production host loses its own evidence by this:

- a structured host under a claim publishes its fence and its status
  together, on every change of its turn, and the mark keeps that statement
  until its next publication;
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

Binding such a row by key to an entry at epoch 0, as the third revision
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

### R7 — The conservative verdict table

R8 supplies the single release condition. Each source reaches that condition
through the same owner census and verdict, before display deduplication.

| Process | Role | Own evidence | Verdict | Reason code |
| --- | --- | --- | --- | --- |
| proven gone or reused | any | irrelevant | released | `process-gone` |
| answering | setup | admitted setup still owned | holds | `setup` |
| answering | reviewer | recorded review process still owned | holds | `reviewer` |
| answering | host | busy handle | holds | `host-turn` |
| answering | host | row reference or ordered journal claim | holds | `turn-claimed` |
| answering | host | busy own tail | holds | `turn-open` |
| answering | host | journal evidence whose author/order is missing | holds | `turn-unattributed` |
| answering | host | own newer completion/idle, all other own sources settled | released | `turn-settled` |
| answering | host | missing, torn or unknown evidence | holds | `turn-unread` |
| no recorded process | launch | work has never been proved | unknown within launch grace | `launch-unproven` |
| no recorded process | launch | own transcript proves an open turn | holds | `turn-open` |

An idle handle without ordering proof cannot supersede a positive source.
A read that throws holds admission through `blockers.unreadable` and is retried
on the next probe. A claim under another key or a turn proved to belong to an
earlier writer supplies no evidence for this owner.

### R8 — Single release condition: own newer settlement or proven death

**An owner whose process still answers at its saved pid, and at its saved start
identity when one was recorded, stays HELD while any of its own evidence says
it might be working. The drain releases it only after its own completion or
idle that is strictly newer than its newest own turn-start or claim, or after
proven death or PID reuse.** Holding longer is acceptable.

Missing or unreadable records, a saved null start identity, replacing the ports
object, reopening the registry and restarting the Viewer supply no release
proof. The responding recorded process holds through all of them, on a cold
probe too. The ports-local remembered reason is only a display aid. Process
protection comes from the recorded responding pid itself and survives reader
replacement independently of that memory.

**Journal order is part of an owner's evidence.** The drain reads the existing
journal replay and compares each owner's publications and engine turn events
in journal sequence order. Publications also carry their sampled engine cursor
in `structured-host:<key>:<epoch>:<cursor>:...`. An idle publication must carry
a cursor strictly newer than the claim it settles. Appending a queued older
sample later gives it no authority over a newer start; a missing source cursor
keeps the claim held. Matching turn-end events must also be newer at the
engine cursor. It selects publications by their session key and
writer epoch and engine events by their existing `engine-host:<key>:<seq>`
producer identity. A turn already attributed to an earlier writer remains
that writer's. Foreign keys and known predecessor turns cannot grant or
withdraw the owner's claim. A turn under the owner's key with uncertain epoch
attribution conservatively holds the answering owner. Each open claim remains
held until that turn's own later end or its writer's later idle publication;
another turn's end supplies no settlement for it. An idle statement on another
row cannot erase an open statement on the first row.

A native send outcome can admit a turn before either the event pump or the
running publication arrives. Its turn-start has no engine cursor, so it holds
the answering owner until own keyed evidence supplies ordering and newer
settlement. A turn explicitly attributed to another key or writer remains
foreign; absent that proof, the outcome cannot make an earlier idle release
newly admitted work.

Native custody also survives retention. The journal's optional
`nativeTurnClaims` projection retains unresolved admissions by turn id,
session key, writer claim and session revision. It keeps known predecessor
attribution before the deciding publications are pruned. Publishers cannot
replace this projection; a matching engine terminal under that writer clears
its claim. A later keyed running publication can attribute an initially
unfenced admission. An older turn's terminal and an idle engine cursor supply
no settlement for another native turn. An absent or null legacy checkpoint
keeps custody when replay is incomplete.

Before accepting idle journal evidence, the reader validates fresh revisions
for every conversation that supplied its own replay statements, together with
its listed and keyed rows. The snapshot's inactive-row cap does not bound that
proof population. Missing rows, uncovered revisions and unresolved own native
claims hold the answering owner; proven process death still releases it.

A retained `writerStatus` is a publication checkpoint. An older own idle mark
cannot outrank a newer own `turn-started`, even while the registry reference
and queued running publication lag. `captureStructuredTerminationSurvivors`
can legally defer that registry checkpoint while the controller's independent
event pump has already journaled newly admitted work. The answering owner
holds across handle retirement and reconnect during that interval. The same
ordering applies to the completion path. If replay or its deciding checkpoint
is missing, the drain holds rather than inventing a newer settlement.

An unordered positive handle, registry reference or transcript tail keeps its
hold until its own evidence settles. A standalone host without a journal
writer releases on its own completed transcript when no own positive source
remains. Setup and reviewer custody continue to hold while their processes
answer.

**Bounded grace covers a launch that never proved work.** An ownerless hosted
row, an open receipt with no admission process or an unregistered claim may
expire under the existing five-minute `UNRESOLVED_TURN_GRACE_MS`. An open own
transcript has proved work and holds. An answering recorded process receives
no timeout, even with a null saved start identity. Unproved launches remain
visible in `blockers.unresolved` after grace. The clocks remain:

1. an ownerless hosted row's `updatedAt`;
2. the newest readable record of its own transcript;
3. the first probe when neither timestamp is available.

The two handed production-seam regressions are committed in
`src/lib/selfUpdate/quietOwners.test.ts`: `independent controller ordering` and
`proved standalone turn remains protected` (including the missing-identity
variant). They exercise `AgentRegistry`, `bindCodexHostPersistence`, the actual
`bindStructuredDeliveryQueue` event pump, `projectEngineHostEvent`,
`RuntimeJournal`, the production census and `probeQuiet`. The fifteen decisive
cases and successor/foreign-write isolation remain required. Earlier revision
narratives and case-map timeout expectations below are historical where R8
revises them; this section governs every release path.

### R9 — A journal row is a claim

A journal session row does two things and no more:

- through its status mark, while the mark stands, it is turn evidence for
  the host that the entry under the mark's key records under the writer the
  mark names (R5, source 3), and for no other owner. What it says is what that
  writer published, whatever a later write that named no writer did to the
  row's own status. A row that names no writer is turn evidence for nobody;
- when it claims a turn and the registry holds nothing it names (no entry
  under its key, no conversation or receipt under its id, no entry or
  generation at its path), it is an unresolved claim, judged by R8.

When the registry does hold what the row names, the census has already asked
every process recorded there. A row at another writer epoch than its entry's
did not come from the writer of the host the entry records now, and a row
that names no writer, or whose own status claims a turn its writer's mark
does not (R5), sits over an entry the census has already read: that host is
judged on its own sources, and the row, while its own status still claims a
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
and artifact, its own transcript, its own handle and its own ordered journal
evidence (R8). An owner with no writer reads no row. Adding, removing or
changing a record proved to belong to a different process leaves the verdict
unchanged, including another generation, an earlier writer of the same key,
another key relabelled onto its row, or a delayed turn already attributed to
that other writer. An interrupt request, spawn placeholder or registry copy
supplies no settlement. An unfamiliar start under the owner's key, or a native
start on its own row without proof of a foreign writer, remains ambiguous and
holds under R8.

A later fenced host publication replaces the row's retained mark. Its key
and writer epoch still prevent it speaking for another owner. A registry
fallback or late event keeps the owner's retained statement, even when it
clears the row's fence. The registry checkpoint may legally lag behind
captured termination, so the row reference need not carry the later running
turn yet. That owner's retained running statement holds over an older
settled tail until its own idle evidence or proven death/PID reuse (R8).
No write by another process can add a sign of work to an owner.

This is the property the last fourteen rounds attacked one instance at a
time. It is checked directly: for a fixture owner, every verdict in R7 is
recomputed after a sibling row, an earlier generation, a successor generation,
an alias, a receipt and a foreign journal row are added in turn, and after
the conversation's journal row is set to a turn claim published under an
earlier writer epoch of the owner's own entry, or under another key at the
owner's epoch and then relabelled by the real fallback, or to a copy of the
registry that a predecessor's late turn event marks running, or to the
owner's own idle publication followed by a predecessor's delayed
`turn-started`, a late send outcome or an interrupt request, or to the
owner's own running publication followed by a predecessor's delayed
`turn-ended`, its `turn-started` under another turn id, a late send outcome
or an interrupt request, in each process state, and must equal the verdict
without that record. The fixture owners
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
verdicts rests on one. The status mark moves none of them for the same
reason: a mark is read only while the row carries its fence and only for the
writer it names. No
case in the suite records a tmux host.

### The four findings

| Finding | Rule that removes it |
| --- | --- |
| 1. Synthesized owner hides the real entry's artifact | R2 (no synthesized owner), R3 (own artifact) |
| 2. A finished host's own writer claim held as setup | R6a for the reproduced shape, R6b for the production shape |
| 3. A finished sibling inherits the first row's gone host | R1, R5; the shared record through the `agent_activity` section |
| 4. A dead generation's journal claim attributed to its successor | R4, R5 source 3, R9; under one session key the writer epoch, across a relabel to another key the copies' `null` fence, for a successor with no writer, a tmux host, the rule that such a host reads no row, and for a write that lands on the successor's own row, the status mark, which such a write leaves as the successor published it (all in R5; the next three sections) |

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
| B's writer publishes its own row under key B at epoch 1 with a turn id, tail settled | holds, `turn-claimed`, with no bound | R5 source 3: B's own key, epoch and status mark |
| B's own idle publication, then a copy of the registry over it, then a late turn event; no row reference, settled tail | released at once | B's retained mark still reports its own idle state (R5, R7). A retained running publication instead holds (R8) |
| B's handle reports a turn | holds, `host-turn` | R5 source 1, R7 |
| B's row reference names a turn | holds, `turn-claimed` | R5 source 2, R7 |
| B's tail is open | holds, `turn-open` | R5 source 4, R7 |
| B's writer republishes the row at epoch 2 with a turn id, tail settled | holds, `turn-claimed`, with no bound | R5 source 3 at B's epoch, with B's mark, R7 |
| B's writer publishes its own running row at epoch 2 with B's turn id; A's delayed `turn-ended`, or A's `turn-started` under A's turn id, then lands on it; no handle, no row reference, settled tail | holds, `turn-claimed`, until B publishes again or B's process is gone | R5 source 3: the event changes the row and leaves B's mark, which still records B's running publication. R7, R12 |
| the same, then B's own idle publication | released at once, `turn-settled` | R5 source 3: B's idle statement replaces its running one. R7 |
| B's writer publishes its own idle row at epoch 2, then A's delayed `turn-started` lands on it; no handle, no row reference, settled tail | released at once, `turn-settled`; the row counts in `blockers.discounted` | R5 source 3: B's mark records idle, whatever the row now says. R7, R9 |
| B's claim is released while B lives, and the row is B's at epoch 2 | holds while B's own mark claims a turn | R5/R8: a release keeps the epoch. A later publication without a writer cannot prove B's turn ended |
| a claim at epoch 2 with no live host process, setup in flight | holds, `setup`, while the claimant lives | R6 |
| A is still alive at epoch 1 under the same key (no successor) | A's row is A's evidence: holds, `turn-claimed` | R5 source 3 at A's epoch, with A's mark |
| B is the same process as A, adopted from a terminal row at epoch 2 | judged on B's handle, the row reference the claim carried over, and the tail | R5, "An adopted wrapper" |

The four different-key rows and the late-turn-event row above were run
through the real registry, fallback and journal, on this lane's base and with
the build's change applied, and the three rows of B's own publication under
A's delayed event through the real journal and event projector with the
status mark applied; "What this pass verified" gives the results.

### The tmux successor

Raised by the critique of the third revision, and confirmed there and in this
pass against the real `AgentRegistry`, fallback and `RuntimeJournal`, with
the copies' `null` field applied. A publishes a structured running row at
epoch 1, releases its claim and exits. B is a live tmux host, with no
structured turn reference and no handle, whose transcript ends in
`task_complete`. The fallback publishes B's key, a hosted host and a
`null` fence; a late turn event from A sets `running` and a turn id and keeps
both. The third revision read the `null` fence as epoch 0 and gave B, a
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

### The delayed predecessor write

Raised by the critique of the fourth revision, and confirmed there and in
this pass against the real `AgentRegistry`, `projectEngineHostEvent` and
`RuntimeJournal`. A publishes under a key at epoch 1, releases its claim and
exits. B is recorded under the same key at epoch 2, `idle`, with no row
reference, no handle and a transcript that ends in `task_complete`. B
publishes its own idle row with its epoch-2 fence. A turn event of A's that
was still on its way then lands: the journal sets `running` and A's turn id
and keeps B's fence. Key and epoch both match B, so the fence rule alone held
B as `turn-claimed` with no bound. A send outcome reported late and an
interrupt request leave the same row, and so does A's registration when it
publishes after the registry moved to B's claim, which this pass found while
listing every write that changes a row's status.

The critique of the fifth revision found the mirror case. That revision
counted B's mark only while the row's status still equalled it, so when B had
published its own running turn, A's delayed `turn-ended`, or its
`turn-started` under A's turn id, changed the row, withdrew B's statement and
released B with no idle statement from B. The reader now takes B's statement
from the mark itself, which no write of A's touches.

| Variant | Expected | Decided by |
| --- | --- | --- |
| B's own idle publication at epoch 2, then A's delayed `turn-started`; B idle, no row reference, settled tail, no handle | released at once, `turn-settled`; the row counts in `blockers.discounted` | R5, "The journal records what a writer published, and the reader reads that record": the event changed the row and left B's mark, which records B's idle publication, so B's own statement claims no turn. R7 on the tail. R9 counts the row |
| the same with a late send outcome, the `turn-started` the journal records itself | released at once | the same rule |
| an interrupt command over B's own idle publication, which writes `interrupt_requested` whatever the row's turn was; no predecessor is needed | released at once | the same rule |
| a spawn placeholder over B's own idle publication, which writes a `registering` host | released at once by this rule; a launch in flight holds through its receipt's admission owner | R5; R2 |
| A's registration, still seated in this Viewer after B's claim, sees a state change of its host | nothing is published; the row stays B's own | R5, "A host publishes only under the claim it was registered with" |
| control: B's own publication with a turn id, tail settled, no handle | holds, `turn-claimed`, with no bound | R5 source 3: B's key, fence and mark |
| control: the same, then B's own `turn-started` for that turn | holds, `turn-claimed` | the event leaves the mark, which records B's running publication |
| B's own `turn-started` over its idle publication, before the publication for that turn | B holds on its own newer event even when its handle, row reference and queued publication are unavailable (R8) | R5 sources 1 and 2; Known limits |
| B's own running publication, then A's delayed `turn-ended`, or A's `turn-started` with another turn id; no handle, no row reference, settled tail | holds, `turn-claimed`, until B publishes again or B's process is gone | R5 source 3: the mark still records B's running publication. R12 |
| the same, then B's own idle publication | released at once, `turn-settled` | R5 source 3: B's own idle statement replaces its running one |
| B's own running publication, then an interrupt command, or a late send outcome for A's turn | holds, `turn-claimed` | the same rule: the mark still records B's running publication |
| B's own running publication, then a spawn placeholder that moves the row to the key of a resume it admits | B holds, `turn-claimed`; the mark gives nothing to an owner under the new key | R5: the mark names B's key and keeps its fence |
| B's own running publication, then a copy of the registry, then A's late event; no handle, no row reference, older settled tail | holds | R5/R8: B's retained mark still names B's key and epoch. A captured termination can legally defer the registry checkpoint; a copy or late event cannot withdraw B's running statement |
| the carried fixture shape: a publication with idle labels, a turn id and the fixture's fence | holds, `turn-claimed` | R5 source 3 |
| the same, then a foreign `turn-started` | holds, `turn-claimed` | R5 source 3: the mark records the fixture's publication |
| a row at B's fence that claims a turn and carries no mark (a runtime host from before the build, or a row last published before it); no handle, settled tail | unknown, `turn-unattributed`: held until five minutes after the transcript's newest record, then released and counted in `blockers.unresolved`; released on the first probe when that record is older | R5 "Rows without a mark", R7, R8 |
| the same with a handle that says idle | released at once | R5 source 1, R7 |
| the same with an open tail | holds, `turn-open` | R5 source 4, R7 |

Every row but the last three was run through the real journal and event
projector with the status mark applied, and those of the fourth revision's
critique also through the real registry and controller, on this lane's base
and with the build's change applied; "What this pass verified" gives the
results. The last three follow from the base run, where no row carries a
mark; their clock was not run.

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
| A turn id on idle journal labels over a settled transcript | R5 source 3, R7 `turn-claimed`, when the row's status mark names the host's writer and stands. In production the row carries the fence and the mark of the host that admitted the turn until the next publication for the conversation. The two fixture cases of this shape publish it with no field, one over the copy's `null`, so they gain the fixture host's fence (build step 4) and keep their expectation |
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
   only, the handle by session key, the row reference, the status mark
   matched by key and writer, and the tail. One small function beside the
   reader returns a fence's writer epoch, the number a `writerClaim` string
   ends with, or none when the field is `null` or missing; another returns an
   entry's, `structuredHost.writerClaimEpoch`, or none when the entry has a
   tmux host or no structured columns. A row's `writerStatus` is the owner's
   statement only when the entry's epoch is a number, the record's
   `sessionKey` is the entry's key, the record's `writerClaim` ends in that
   epoch, and the row's own `writerClaim` equals the record's; the turn
   check (`sessionClaimsOpenTurn`) then reads the record's `host`, `turn` and
   `activeTurnId`, never the row's. The reader finds that row in the snapshot
   by the key its record names. A row under the entry's key whose own fence
   ends in that epoch and that has no `writerStatus` is reported as
   unattributed. One three-line accessor in
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
   A host publishes under the claim it was registered with (R5):
   `HostRegistration` gains the writer epoch of its entry, read once when the
   host is registered; `activeRegistrations` (`:1627`) returns it, so a seat
   carried through a controller swap keeps the epoch it had; and
   `publishHostState` returns before publishing when the entry has no tmux
   host and its `writerClaimEpoch` differs from the seat's. About ten lines,
   in `register`, `seatRegistration` and `publishHostState`.
   The status mark (R5), in the runtime host: `RuntimeSession` gains
   `writerStatus?: { sessionKey, writerClaim, host, turn, activeTurnId }`
   (`src/lib/runtime/contracts.ts:580`). In `src/runtime-host/journal.ts` the
   session-status branch (`:2480`) sets it from the merged row when the
   payload names a writer and carries `host`, `turn` and `activeTurnId`, and
   otherwise copies the previous row's record, so a value a payload sent is
   discarded. The eleven other writes of a session row spread the previous
   row and keep the record with no change. Five lines in the journal, one
   field in the contract.
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
     or a later copy replaces the row. The helper's payload carries `host`,
     `turn` and `activeTurnId`, so the journal records each of its rows under
     the same fence;
   - the R12 property test, with the earlier-epoch journal row, the row
     relabelled from another key, the copy marked running by a late turn
     event, the owner's own idle publication followed by a delayed
     `turn-started`, a send outcome or an interrupt request, and the owner's
     own running publication followed by a delayed `turn-ended`, a
     `turn-started` under another turn id, a send outcome or an interrupt
     request among its perturbations, over a structured owner and a tmux
     owner;
   - the successor-epoch cases of the case map, built through the real
     `claimStructuredHost`, `setStructuredHostClaimed` and
     `releaseStructuredHostClaim`, with the journal row published in the shape
     production writes, `writerClaim` included. The acceptance is the first
     row of that table: B idle with a settled tail is released on the first
     probe, with no five-minute wait, while A's row still claims a turn. The
     busy and current-epoch variants hold, and the turn-event variant
     releases. B's own running publication at epoch 2, followed by A's
     `turn-ended` and, in a second case, A's `turn-started` under A's turn id
     through the real projector, holds while B's process lives, and B's own
     idle publication after it releases on the next probe; B's own idle
     publication followed by A's `turn-started` releases on the first probe;
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
   - the delayed-write table of the case map, over the real registry,
     journal, `projectEngineHostEvent` and controller: A and B claimed under
     one key at epochs 1 and 2 through `claimStructuredHost` and
     `setStructuredHostClaimed`, B's own idle publication in the shape
     `publishHostState` writes, then A's `turn-started` through the real
     projector. The acceptance is the first row: B is released on the first
     probe while the row still says `running` under B's fence. The send
     outcome goes through the journal's own commands: a send admitted while
     A's row is hosted, completed `turn-started` after B's publication. The
     interrupt request goes through the real command over B's idle row, with
     no predecessor in the case. B's own publication with a turn id holds,
     before and after B's own `turn-started` for that turn, and after A's
     delayed `turn-ended`, A's `turn-started` under another turn id, an
     interrupt request and a spawn placeholder that moves the row to another
     key; a copy of the registry over it keeps B's retained running mark,
     including when captured termination defers its registry checkpoint and
     the tail contains an older completion (R8). A registration
     seated for A publishes nothing after B's claim, driven through the real
     controller with a host whose state listener the test fires, and a seat
     carried through a controller swap keeps the epoch it was seated at;
   - the mark in the journal's own test file: a named publication with all
     three fields records its key, its fence and the three values; one that
     omits a status field leaves the previous record; a turn event, a
     publication with no fence and a `null` publication keep the record
     whatever they do to the status; a `writerStatus` sent in a payload is
     discarded; a keyed read and the snapshot both return the record;
   - the reader's reading as a pure case: the mark speaks for the owner whose
     key and writer epoch it names while the row's `writerClaim` equals the
     mark's, whatever the row's own `host`, `turn` and `activeTurnId` say;
     it speaks for nobody once the row's `writerClaim` is `null` or another
     writer's; it never speaks for an owner under the key a row moved to, or
     at another epoch;
   - one pure case for `turn-unattributed`, on a literal row with a fence and
     no mark, since the build's journal writes one for every named
     publication: no handle and a settled tail hold while the tail's newest
     record is younger than five minutes and release, counted, once it is
     older; a handle that says idle releases; an open tail holds as
     `turn-open`;
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
   because the drain reads the runtime host over its socket and the status
   mark changes the journal that process owns.

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
field and the seat's epoch touch, and those of `journal.ts` for the mark; a
review
finding that shows evidence of one process reaching another owner's verdict
is a failure of R12 and is fixed in the census or the reader, never by a new
selection rule in `quiet.ts`.

## Validation against the requirement

| The requirement asks | Where it is met |
| --- | --- |
| one question per physical process, keyed by pid, start identity and artifact path | R1, R2 |
| each answered from that owner's own evidence | R3, R4, R5, R12 |
| deduplication only after verdicts | R11; R1 pools records of the same process and nothing else |
| a finished or idle owner releases immediately | R4, R7 `process-gone` and `turn-settled`; R5 for a tmux host, for a successor under a copy that names no writer, and for a successor that published idle and whose row another write changed |
| a busy one holds | R7 `host-turn`, `turn-claimed`, `turn-open`, `setup`, `reviewer`; R5 source 3 keeps a host's own published turn whatever a write that names no writer does to its row |
| unknown holds with a bounded timeout and a visible reason | R8, reason codes in R11; a turn claim with no recorded author is one of the unknowns |
| every repro case and the four findings mapped to a rule | Case map, including the successor-epoch, tmux successor and delayed-write cases |
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
is computed twice, with the rule of the third revision (a `null` or
missing fence and a tmux host both at epoch 0) and with the fourth's (a
row names a writer only through a fence, and a tmux host has none). B has no
handle and no row reference throughout:

| Variant | Row with the change | Third revision | Fourth revision |
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
holds under the third revision's rule (its row has no field, read as epoch
0), and the structured epoch-1 control with A's late event holds under both,
which is the
different-key finding the copies' `null` closes. The copy-only pane was also
run through `main`'s own `probeQuiet` with the production liveness reader:
its row read `hosted`/`running`, `agent_activity` reported the host alive and
idle, and the drain held one turn on the first probe and twelve hours later.
No file in the worktree other than this document was written.

The revision for the delayed predecessor write read every write of a session
row's `host`, `turn` and `activeTurnId` on `main`: the publications R5 lists,
the pump's append (`structuredDeliveryController.ts:1544`), the journal's
projection of turn events (`journal.ts:2488`) and the outcomes the journal
appends itself (`:2235`–`:2475`). It ran one probe under the same isolation,
against the real `AgentRegistry`, `RuntimeJournal`, `projectEngineHostEvent`,
journal commands and delivery controller, on an export of this lane's head
and on an export with the change applied: the fallback's part of build step
2, the seat's epoch and the status mark, about twenty lines in three files.
Both exports sat under the stage's temporary directory. A and B were claimed
by the probe under one key at epochs 1 and 2 through `claimStructuredHost` and
`setStructuredHostClaimed`. B has no handle, no row reference and a
`task_complete` tail throughout. The send outcome and the interrupt request
went through the journal's own commands; the placeholder was appended in the
shape `journal.ts:2286` writes. The verdict is computed with the rule of the
fourth revision (key and epoch match, the row claims a turn) and with the
fifth revision's (the status mark names the same writer, and the row's status
still equals it). "Mark broken" below is that revision's term for a row whose
status no longer equals its mark; the table of the next revision gives this
specification's verdicts for the same sequences:

| Variant | Row on the base | Fourth revision | Row with the change | Fifth revision |
| --- | --- | --- | --- | --- |
| B's own idle publication, then A's delayed `turn-started` through the real projector | epoch 2, running, A's turn id | holds, `turn-claimed` | the same, mark broken | released |
| a send admitted to A through the journal's command and completed `turn-started` after B's own idle publication | epoch 2, running, A's turn id | holds, `turn-claimed` | the same, mark broken | released |
| an interrupt command over B's own idle publication | epoch 2, `interrupt_requested` | holds, `turn-claimed` | the same, mark broken | released |
| a spawn placeholder over B's own idle publication | epoch 2, `registering` | holds, `turn-claimed` | the same, mark broken | released |
| A registered with the real controller, the registry moves to B, A's host reports a state change with a turn | epoch 2, running, A's turn id, published by A's registration | holds, `turn-claimed` | B's own idle publication untouched, its mark standing | released |
| control: B's own publication with a turn id | epoch 2, running | holds, `turn-claimed` | the same, mark at epoch 2 stands | holds, `turn-claimed` |
| control: the same, then B's own `turn-started` for that turn | epoch 2, running | holds, `turn-claimed` | the same, mark at epoch 2 stands | holds, `turn-claimed` |
| B's own `turn-started` over its idle publication | epoch 2, running | holds, `turn-claimed` | the same, mark broken | the row holds nobody |
| the same, then B's publication for that turn | epoch 2, running | holds, `turn-claimed` | the same, mark at epoch 2 stands | holds, `turn-claimed` |
| B's own running publication, then A's delayed `turn-ended` | epoch 2, idle | released | the same, mark broken | released |
| B's own running publication, then A's `turn-started` with another turn id | epoch 2, running, A's turn id | holds on A's turn | the same, mark broken | the row holds nobody |
| B's own running publication, then an interrupt command | epoch 2, `interrupt_requested` | holds, `turn-claimed` | the same, mark broken | the row holds nobody |
| B's own running publication, a controller start's copy, then A's late event | epoch 2 kept by the copy, running | holds, `turn-claimed` | no fence, running, B's mark broken | released |
| the carried fixture shape: a publication with idle labels, a turn id and the fence `fixture:0`, over an entry at epoch 0 | epoch 0, the turn id | holds, `turn-claimed` | the same, mark at epoch 0 stands | holds, `turn-claimed` |
| the same, then a foreign `turn-started` | epoch 0, running | holds, `turn-claimed` | the same, mark broken | released |

The base run reproduces the critique's finding in its first row. The third
row needs no predecessor: an interrupt request over an idle hosted row writes
`interrupt_requested` (`journal.ts:2250`), and the fence rule held that host
with no bound. Read with the fifth revision's rule, and with this one's,
every base row that claims a turn under B's fence is `turn-unattributed`,
since the base journal writes no mark: that is the new Viewer over a runtime
host from before the build.

The test files beside the change were run on both exports, one file per
process under the same isolation: `journal.test.ts`, `journal.inject.test.ts`,
`journal.sessionRead.test.ts`, `engineHostEvents.test.ts`,
`hostlessSessionSettlement.test.ts`, `structuredDeliveryController.test.ts`
with its `.migration` and `.nativeSwitch` files,
`structuredDeliveryRebind.test.ts`, `structuredDelivery.integration.test.ts`,
`structuredDeliveryLegacyVerdict.integration.test.ts`,
`releaseInterruption.test.ts` and `structuredHostControl.test.ts`, 327 cases.
All pass on both. A first variant of the mark, a flag the journal cleared at
every write that changed the status, was applied and run the same way before
this one: it decided the table identically and moved one case of
`journal.test.ts` that pins a whole projected row. "Decisions" says why it
was dropped. The runtime host rehearsal (`scripts/verify-runtime-host.ts`) was
not run on the change; build step 5 owns it. No file in the worktree other
than this document was written.

The revision for the writer's current claim changed the reader only: the
journal writes the mark as the fifth revision specified. It ran one probe
under the same isolation, through the real `RuntimeJournal` and
`projectEngineHostEvent`, on an export of this lane's head under the stage's
temporary directory with the mark applied to the journal (the contract field
and the session-status branch, six lines in two files). Every case starts from
A's own running publication with the fence `viewer:1`. B's publications carry
`viewer:2`, the fence a claim by the same Viewer at epoch 2 writes; the
registry's part of that sequence, B claimed under A's key at epoch 2, is what
the earlier probes of this lane and the critique ran, and was not run again.
The copy and the released host's publication are appended in the shape the
build publishes them, with `writerClaim: null`. B has no handle, no row
reference and a settled tail throughout. The verdict is computed with the
fifth revision's rule and with this one's (the mark names the owner's key and
writer and the row still carries its fence; the mark's three values are
read):

| Variant | Row with the change | Mark | Fifth revision | This revision |
| --- | --- | --- | --- | --- |
| B's own idle publication, then A's delayed `turn-started` | B's fence, running, A's turn id | B's fence, idle | released | released |
| B's own idle publication, then a late send outcome | B's fence, running, A's turn id | B's fence, idle | released | released |
| B's own idle publication, then an interrupt request | B's fence, `interrupt_requested` | B's fence, idle | released | released |
| B's own idle publication, then a spawn placeholder | B's fence, `registering` | B's fence, idle | released | released |
| B's own running publication, then A's delayed `turn-ended` | B's fence, idle | B's fence, running, B's turn id | released | holds, `turn-claimed` |
| B's own running publication, then A's `turn-started` under A's turn id | B's fence, running, A's turn id | B's fence, running, B's turn id | released | holds, `turn-claimed` |
| B's own running publication, then A's `turn-ended` and a second `turn-started` of A's | B's fence, running, A's second turn id | B's fence, running, B's turn id | released | holds, `turn-claimed` |
| B's own running publication, then an interrupt request | B's fence, `interrupt_requested`, no turn id | B's fence, running, B's turn id | released | holds, `turn-claimed` |
| B's own running publication, A's delayed `turn-ended`, then B's own idle publication | B's fence, idle | B's fence, idle | released | released |
| control: B's own running publication, then B's own `turn-started` for that turn | B's fence, running, B's turn id | the same | holds, `turn-claimed` | holds, `turn-claimed` |
| B's own `turn-started` over its idle publication | B's fence, running, B's turn id | B's fence, idle | released | released |
| the same, then B's publication for that turn | B's fence, running, B's turn id | the same | holds, `turn-claimed` | holds, `turn-claimed` |
| B's own running publication, a copy, then A's late `turn-started` | `null`, running, A's turn id | B's fence, running | released | released |
| B's own running publication, then its publication after the claim was released | `null`, idle | B's fence, running | released | released |
| B's own running publication, then a placeholder under a resume's key | the resume's key, B's fence, `registering` | B's key and fence, running | released | holds for B; an owner under the resume's key at epoch 2 reads nothing |
| A's own running publication only, read for B at epoch 2 | A's fence, running | A's fence, running | released | released |
| the same, read for A alive at epoch 1 | A's fence, running | A's fence, running | holds, `turn-claimed` | holds, `turn-claimed` |
| the carried fixture shape, `fixture:0` over an entry at epoch 0 | `fixture:0`, idle, the fixture's turn id | the same | holds, `turn-claimed` | holds, `turn-claimed` |
| the same, then a foreign `turn-started` | `fixture:0`, running, A's turn id | `fixture:0`, idle, the fixture's turn id | released | holds, `turn-claimed` |

Six rows move, all from released to held, and in each the owner's own last
publication claims a turn while no write of its own has followed: the
critique's two, A's two events in a row, an interrupt request on a running
turn, a placeholder that moves the row to another key, and the carried
fixture shape under a foreign event. No row moves the other way, so every
idle successor the fifth revision released is still released at once. The
fifteen repro cases read no mark (above), and the send outcome over a running
publication follows from the `turn-started` projection the table ran. No file
in the worktree other than this document was written.

## Decisions taken in this pass

- **A live process is released by a clock only when nothing shows work.** The
  requirement bounds "unknown". R8 reads that as an owner with no positive
  sign of a turn and no settled tail. #2555 holds such an owner for as long as
  its process lives, and `main` releases it at once when its journal row
  claims nothing. The bound sits between the two and follows the
  requirement's wording.
- **The journal row stays as turn evidence, scoped to its own key and the
  writer its fence and its status mark name.** Dropping it would simplify the
  reader, and `main`
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
- **The journal records the status a writer published, and the reader reads
  that record as the writer's statement.** The fence cannot carry this:
  publications set it and every other write keeps it. Six other ways were
  weighed:
  - the reader counting the row's own status while it still equals the
    record, as the fifth revision specified. It releases an idle successor
    under a predecessor's delayed `turn-started` exactly as this rule does,
    and it also withdraws a writer's statement whenever another process
    changes the row: a predecessor's delayed `turn-ended`, or its
    `turn-started` under another turn id, released a successor whose own last
    publication claimed a turn and who had published nothing idle (the
    critique of the fifth revision). Read from the record, a write that
    names no writer moves the writer's statement in neither direction;
  - a flag beside the fence that the journal clears at every write that
    changes the status. It withdraws a statement the same way, and it holds
    only while every writer of the row, in every journal generation,
    maintains it: a runtime host from before the build that projects a turn
    event copies a flag it does not know and changes the status under it,
    which a rollback of the runtime host would reach. It also touches every
    write of a session row. The record of the published values is read by the
    reader and asks nothing of later writes;
  - the journal refusing a turn event that does not come from the row's
    writer would keep a foreign write off the row the board reads as well.
    Every event would have to name its writer, and the change reaches every
    reader of the row: a turn event from a Viewer built before the change, or
    a send outcome, would stop moving the row the board shows. The drain gets
    the same protection from the record. It is under Deferred;
  - each turn event naming its writer, so that a host's own event updates the
    record when it changes the status. The pump knows its seat's claim; the
    send outcome would need it carried through the delivery queue. It covers
    the span between a host's turn event and its publication for the same
    turn, which the row reference already covers. It is under Deferred;
  - a turn event clearing the fence itself, with no new field. The injection
    admission and the idle kill fence read the fence (`journal.ts:2048`,
    `contracts.ts:410`) and would refuse a host until its next publication;
  - the Viewer alone. Its pump could append turn events through the
    revision-fenced RPC after reading the row, at one keyed read per turn
    event and a retry whenever the row moves. The send outcome and the
    interrupt request are written by the runtime host itself and stay out of
    its reach, and afterwards no reader can tell who set a row's turn unless
    the row records it.

  A writer added later that names nobody leaves the record like the ones that
  exist, with no line written for it. A publication still replaces it, which
  is the one-row limit R12 states: a copy of the registry or another writer's
  publication takes the owner's statement away and never adds one.
- **A fence with no mark is unknown.** Reading such a row as its writer's
  keeps the finding for every row a runtime host from before the build wrote.
  Reading it as nobody's releases a host whose only sign of a turn is its own
  publication, for as long as the new Viewer runs over the old host. The
  requirement names a third answer for evidence that cannot be attributed,
  and R8 already implements it.
- **A seat's epoch binds a host's publications to its claim.** The host's own
  writer fence (`setWriterFence`) answers a narrower question: it also turns
  false when the claim is released, and a host in that state publishes today,
  with a `null` fence. The epoch tells the two apart: a release keeps it and
  a successor's claim raises it.
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
- A keyed event with uncertain epoch attribution conservatively holds under
  R8. Existing event identities can prove a known predecessor turn foreign,
  but cannot prove that an unfamiliar turn under a reused key is foreign.
  Missing engine cursors can prolong that hold. Own events protect the interval
  before the registry checkpoint or queued publication lands; an older idle
  mark supplies no release proof there.
- A host's own last statement holds for as long as its process lives and
  nothing publishes for it. That is the acceptance of this design (a host's
  own current claim holds until its own idle evidence or its exit), and
  `main` pins the same hold for a turn id over a settled transcript.
- A fenced host publication replaces the retained mark. A registry copy or
  late event keeps it. The row reference may lag under captured termination;
  the retained own running mark protects that turn over an older settled
  tail (R8), with successor isolation still enforced by key and writer epoch.
- A Viewer from before the build that still runs beside the new one
  publishes by session key as `main` does, so its registration can still put
  a predecessor's status under a successor's fence, and the journal records
  that publication like any other. It lasts while that process runs, during
  the first deployment of the build, and the successor it would hold is one
  the new Viewer claimed and holds a handle for.
- A runtime host from before the build records no mark, so its unattributed
  claim holds while its recorded pid answers, including a null start identity.
  Only a launch with no recorded process and no proved work keeps bounded grace.
  Every
  web-first deployment passes through that state until the host hands over. A
  row published then stays without a mark until its host publishes again or a
  Viewer start rewrites it.
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
  runtime host can run a generation behind the Viewer. A copy that forgot the
  field and changed the row's status would break the status mark all the same.
- **The journal refusing a turn event that does not come from the row's
  writer.** It would keep a host's own row whole against a delayed write from
  another process for the board as well; the drain already reads the
  writer's statement from the mark, which such a write leaves alone. It needs
  every turn event and send outcome to name its writer, and it changes what
  the board reads from the row. The requirement names the drain.
- **A turn event that names its writer.** With it a host's own `turn-started`
  or `turn-ended` would update the status mark ahead of the publication for
  the same change. The row reference shows that turn today.
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

For the delayed-write revision: project-scoped and unscoped searches for a
delayed predecessor turn event that keeps a successor's fence, a turn event
with no writer fence, a host publication that reads its fence from the
registry by session key, and who wrote a session row's turn found the critique
that raised the case and this lane's earlier revisions; nothing earlier
attributes a row's turn to a writer. The critique's conclusion was read in its
transcript and reproduced with the probe above. Memory held nothing relevant.

For the revision on the writer's current claim: project-scoped and unscoped
searches for a foreign turn event that withdraws a writer's status mark, and
for preserving a writer's last attributable claim on a shared journal row,
found the critique that raised the case and this lane's earlier revisions.
The critique's conclusion was read in its transcript and reproduced with the
probe above; nothing earlier reads a writer's statement from a record of what
it published. Memory held nothing relevant.
