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
before the first asynchronous observation. Failed or deferred roots move behind
the rest of the inventory. A finite unchanged inventory of N roots is visited in
at most N pressure passes when each pass can admit one root; when a page fits,
the bound is ceil(N/32). Newer arrivals join behind older inventory. Each root
gets at most five seconds of the existing 40-second work budget. Physical I/O or
a protection refusal can defer deletion; reports retain that reason.
If the first page completes no deletion, the default pressure sweep searches
further pages, up to 1,024 distinct roots and the same deadline, until a page
removes something. Explicit diagnostic page limits still apply. A cleared
pressure episode resets the cursor so the next episode starts oldest first.

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
