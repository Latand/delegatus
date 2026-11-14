# Attempt temp under disk pressure

This change is stacked on #4033. Its base already carries the shared parent/helper
deadline; #4033 leaves deletion policy and the four/32-root page sizes unchanged.

## Base causes

These citations name `47fbd4a6`, the #4033 head used for the cause analysis,
before the subsequent merge of main:

- `src/lib/runtime/attemptTempRetention.ts:333` raises the page size from four to
  32 above the cap. It does not change the evidence-hold admission at lines
  423–442 or its required expiry at lines 374–376. Closed-lane roots without a
  hold already qualify at line 522, but take the evidence-preservation path at
  lines 532–542 until expiry. A retained copy can consume the reclaimed space.
- Lines 350–358 spend the shared inventory budget reading authority before
  visiting a root; lines 509 and 550 read it again. Authority for an ended stage
  in an open lane walks its producer checkout
  (`src/lib/runtime/attemptTempProduction.ts:38–54`). Consumer checkouts and the
  protection snapshot add their own work. Hence a bounded page can remove none.
- Lines 360–365 restore unvisited candidates' old scheduling positions when the
  budget ends. `AttemptTempStore.due` at lines 141–166 combines expired and
  released prefixes. An inventory cursor is missing, so the same expensive
  roots can lead subsequent passes.
- The helper gives root work 40 seconds
  (`src/lib/runtime/attemptTempProduction.ts:97`); the parent allows 60 seconds
  (`src/lib/pipelines/worktreeSweepWorker.ts:16`). #4033 clips work to the
  shared deadline with a one-second reply margin. Checkout inventory gets up
  to 30 seconds (`attemptTempRetention.ts:338`); protection snapshots get up to
  30 seconds and 10,000 directories (`attemptTempFilesystem.ts:839–858`).

## Safety and scheduling

Recorded custody, explicit keep markers, linked report evidence, running
attempts, process references, checkout links, sockets and container mounts remain
deletion fences. An ended stage alone cannot prove an idle producer checkout
has stopped using its scratch: its link inventory is still necessary. All
asynchronous observations are revalidated at quarantine and deletion dispatch.

The pressure cursor is durable, ordered by creation time and path, and advances
before a candidate's full-window asynchronous observation. Fractional probes
and the reserved tail do not advance it: after restart, the roots they passed
receive full windows in turn. The default search finishes the suffix after the
cursor before wrapping on a subsequent pass, so previous timeout roots cannot
take its reserved tail window. After retirement makes progress, a partial page
can fill from the wrapped inventory within the same deadline and page limit.
Explicit diagnostic pages keep their existing
wrapping behaviour. Failed or deferred full-window roots move behind
the rest of the inventory. A finite unchanged inventory of N roots is visited in
at most N pressure passes when each pass can admit one root; when a page fits,
the bound is ceil(N/32). Newer arrivals join behind older inventory. Each root
gets at most five seconds of the existing 40-second work budget. The first
candidate gets the full five-second window, clipped to the remaining tick.
Completed holds leave that window available to the next candidate. After a
retirement, subsequent candidates also get full windows. Once a proof exhausts
its window, half the remaining tick is reserved for subsequent full proofs;
the other half funds traversal past further timeouts. Full proofs spend that
credit by their actual elapsed time. Once it cannot fund another full window,
visits share the traversal time, retaining up to five seconds for the last
candidate in the bounded search. Thus one timeout leaves full windows for
finite checks, while a long timeout prefix still leaves time to reach later
roots. Unused time stays available to later roots.
Physical I/O or a protection refusal can defer deletion; reports
retain that reason.
If the first page completes no deletion, the default pressure sweep searches
further pages, up to 1,024 distinct roots and the same deadline, until a page
removes something. One bounded indexed selection chooses that search before visits
start, so its last candidate can retain a full window across page boundaries.
Explicit diagnostic page limits still apply. A cleared
pressure episode resets the cursor so the next episode starts oldest first.

A pressure pass in removal mode guarantees at least one completed retirement
when its bounded search reaches an ended, unpinned root whose measurement,
authority, reference and protection checks, quarantine, removal and receipt can
finish inside its assigned window, while all fences remain current. The window
is `min(5000 ms, remaining tick)` before a timeout, while full-proof credit
remains, for the last search candidate, and after a retirement; other visits
share the traversal budget described above. The original deadline clips every
window, including the last one. Earlier checks that respect their bounds
cannot consume the reserved traversal budget.
In particular, a page of 33 ended roots with identical 1,500 ms allocation or
protection checks makes progress on every nonempty pass across helper restarts,
including when a completed operator hold precedes the removable roots or an
exhausted proof precedes finite checks. Mixed timeout prefixes of one, eight
and 32 roots before 32 finite checks also make progress across restarts in
over-cap and low-space modes. This covers eight exhausted checks followed by
an available ninth root and a full exhausted page followed by an available
root. Zero removals remain valid
in dry-run mode, if fresh measurements clear cap pressure before a retirement,
if admission/recovery or unavoidable I/O/cleanup exhausts the
deadline, if every visited root is protected or fails to finish in its share,
or if the only eligible roots lie beyond the 1,024-root search ceiling (or an
explicit smaller page limit). Those roots retain their reasons and durable
cursor position for a later pass; no proof or deadline is relaxed.

Above the cap, closed lanes and ended stages without an explicit evidence hold
qualify at any age. Pressure removes unlinked scratch captures with their root.
Linked report evidence
and recorded-check holds stay protected. Below the cap, the existing evidence
preservation and retention policy continues. A pressure pass stops at the cap,
unless the filesystem is low on space.

`AttemptTempStore.register` and legacy adoption produce root ownership rows;
release is only a scheduling hint. The sweep reads the binding again at every
dispatch. `pressure_cursor` has one writer (`checkpointPressure`) and one reader
(`pressurePage`), under the existing process-shared sweep lock. It stores the
last visited creation time and path, so deleting that root needs no cursor
cascade. Older ledgers start without a cursor. Neither evidence copies nor
recorded-check manifests inherit or write the cursor. Space observation uses
`statfs.bavail * statfs.bsize` on scratch, never the checkout's filesystem.
Cap accounting uses the ledger's measurements; unvisited roots retain their
last measurement. The low-space switch observes filesystem availability directly.
An unreadable measurement is a lower bound: it can increase a recorded size,
and cannot reduce it. Only a complete measurement or physical removal can
reduce that root's pressure accounting. Outcomes retain the unreadable flag.

Standalone roots resolve their launch through keyed registry facts. Starting,
live, pending-resume and incompletely terminated hosts remain protected even
when the process snapshot is empty. The existing `finishedAgent` proof checks
pending actions, claims, exits, termination survivors and recorded process
identities. A proven ended host receives the usual retention deadline and
qualifies immediately under pressure. The exact observed facts must still
match at quarantine and deletion dispatch; registry files participate in the
mutation fence. Missing receipts retain the existing orphan grace period.

The existing ownership producers are `structuredSpawn.ts` (scratch and config
roots with the same owner and a creation timestamp) and legacy adoption.
`structuredSpawn` cleanup marks release. `viewerInstrumentation.ts` initializes
the ledger at startup. Recorded-check admission validates `owner`; the generic
temp sweep treats registered roots as held by this sweep. Automatic evidence
copies and temporary-data retention read `owner`/`copy` and keep their separate
lifetimes. None copies the pressure cursor. The report writer remains
`attemptTempProduction.ts`; `state/diskPressure.ts` reads its allocation and
retention forecast and tolerates the additional pressure fields.

Main's W5 recovery is preserved. Restored trash keeps its existing owner and
expiry proof, plus the recovery watches at dispatch. Recovery retry timestamps
remain calendar values; its enumeration window is clipped to the shared
monotonic remainder. Pressure scheduling uses the same restored ownership rows.

Below 20 GiB available to the current user on the scratch filesystem, pressure
cleanup continues below the cap. This fixed default reserves working space for
checks, SQLite and recovery writes without a new setting. It also activates
before available space falls into the low tens of GiB. A failed filesystem
space observation is reported explicitly and leaves low-space mode disabled.
