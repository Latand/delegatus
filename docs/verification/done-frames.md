# Finished frames remain viewable

Origin: the 2026-10-18 07:58Z report that the «Готово» thumbnails for merged
PRs #2998 and #2990 disappeared. Production was inspected read-only. No live
row, file, process or setting was changed.

## Production diagnosis

The three stored URLs below returned authenticated HTTP 404 with
`image not found` during this investigation on 2026-10-18. Paths below use
`$STATE` for the installation's state directory. The records were read with a
read-only SQLite connection (`mode=ro`, collection `done_items`), and the
album ids were matched against the stage transcripts using `albumImageId` and
the existing transcript index in an isolated scratch process.

| Card | Stored thumbnail URL | Original file | Read-only recovery |
| --- | --- | --- | --- |
| #2998 | `/api/tasks/<task-A>/album/image?id=<image-A>` | `$STATE/scratch/llv-stage-yWfTtj/tmp/out/voice/tri-voice-enable-1440-en-light.png`, absent | The visual critic's transcript still contains the exact keyed image: JPEG, 167,937 bytes, viewed 2026-10-16 22:28:28.183Z. |
| #2990 | `/api/tasks/<task-B>/album/image?id=<image-B>` | `$STATE/scratch/llv-stage-hJFp1R/tmp/frames/vert/after-1440-narrow-light.png`, absent | The critic's transcript retains PNG, 54,215 bytes, viewed 2026-10-16 16:07:56.616Z. |
| #3028 | `/api/tasks/<task-C>/album/image?id=<image-C>` | `$STATE/scratch/llv-stage-PDc1NR/tmp/export/.artifacts/decision-form-draft/seat-1440-en-dark-refused.png`, absent | The critic's transcript retains PNG, 154,432 bytes, viewed 2026-10-17 15:26:45.126Z. |

The recovered bytes for the reported two cards were decoded and visually
inspected. Both corresponding lane worktrees still existed. Their PR merge
records say 2026-10-16 23:06:59Z (#2998) and 2026-10-16 17:09:13Z (#2990).
Those primary timestamps differ from the report's estimated calendar dates.
Task and image ids in this public table are aliases: the publication gate
refuses the installation's live resource identifiers. Exact URLs were checked
locally and are retained only in this stage's private diagnosis output.

Two mechanisms explain the failure:

1. `src/lib/runtime/structuredSpawn.ts:198` creates the stage-scratch removal
   callback; its `host.releaseCleanup` binding is at line 209. For these Claude
   stages, `src/lib/runtime/claudeStreamBrokerHost.ts:1738` calls it during host
   release. The corresponding critic attempts completed at 2026-10-16
   22:29:45.180Z, 2026-10-16 16:09:32.242Z and 2026-10-17 15:27:42.987Z.
   Scratch removal at host release is the code's lifecycle; these are stage
   completion timestamps, not an audited per-file deletion clock. No per-file
   deletion timestamp was retained, so the exact unlink instant is unknown.
2. `src/lib/taskAlbum/transcriptIndex.ts:68` keeps its index in process memory.
   `src/lib/taskAlbum/album.ts:218` serves an inline image by collecting with a
   zero-byte indexing budget. The done row had persisted that transient album
   URL and a settled `frameCheckedAt`. After a restart, the thumbnail request
   cannot find its id until another caller reindexes the task. The frame still
   existed in its transcript: the scratch file's disappearance did not make it
   unrecoverable.

Worktree sweep removes eligible checkouts at
`src/lib/pipelines/worktreeSweep.ts:1199`; it did not remove the two still-live
checkouts examined here. No sweep was run during diagnosis. The fix removes
both the scratch-path dependency and the memory-index dependency.

## Verification contract

- `src/lib/done/media.test.ts`: real file copy and production image route after
  source removal, real-process restart, persisted count and byte caps, owned
  removal, malformed/oversized sources, manifest ids, cross-origin/capability
  refusal and path-route/symlink fences.
- `src/lib/done/source.test.ts`: a legacy album id recovers its exact inline
  transcript bytes in a fresh process and keeps serving after transcript removal.
- `src/lib/done/recover.test.ts`: PR attachment allowlist, malformed media and
  a real local git remote ref containing the named frame; no production writes.
- `src/lib/done/project.test.ts`: capture at outcome recording, lane removal,
  acknowledgement Undo and item retention, bounded legacy progress beyond the
  source candidate window.
- `src/app/api/attention/done/route.test.ts`: the persisted response completes
  while a copy is explicitly held, then returns the refined URL.
- Existing kanban and phone drivers, case `done frames retained in state`:
  1440, 800 and 390 px; en/uk; light/dark; retained, missing and evicted images;
  the retained pair opens in the existing lightbox after source removal.

No performance improvement is claimed. New media work is bounded and carries
`done.media` / `done.frame-source` loop-monitor labels. Production recovery
will run after deployment through the existing background sweep; this lane
does not deploy or backfill live state during read-only diagnosis.
