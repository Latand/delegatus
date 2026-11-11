# Report picture store

A stage report, a bridge report or a task names a picture by the path it has
in a lane checkout, a stage's scratch directory or a temp directory. All of
those are swept, and the picture went with them. The report picture store
keeps the pictures that a text the operator reads actually names, and nothing
else.

## Where such a text enters the state

| Text | Written by | Hook |
| --- | --- | --- |
| Stage report: summary, result, task summary, verdict findings | `stage_report` → `reportStageCompletion` (`src/lib/pipelines/engine.ts`) | yes, with the lane's id |
| Bridge report: body, complete copy, cards | `bridge_report` → `appendBridgeReports` (`src/lib/bridge/store.ts`) | yes |
| Task text and details | MCP `create_task` / `update_task` (`src/lib/mcp/bindings.ts`), the board's `POST /api/tasks` and `PATCH /api/tasks/[id]` | yes |
| Finished-work items | a projection of the above; its frame is copied into `done-media` | has its own store |
| Prototype reviews | `publish_prototype_review` copies its frames into `prototype-reviews` | has its own store |
| Tasks written by the service itself (monitor ticks, maintenance, release) | internal callers of `createTask` / `patchTask` | not hooked |

## What is kept

When one of the hooked texts is written, every absolute or `~/` picture path
in it is looked at. A picture is copied to `<state>/report-media/` when:

- it lies, as written and with its links resolved, under a root the path
  routes already serve (a known project or checkout, the stage scratch, an
  evidence root), or under a named temp root: the service's own temp directory
  and `/tmp`, or the list in `LLV_REPORT_MEDIA_TEMP_ROOTS`. Nothing else an
  agent's text names is read;
- it is a raster (PNG, JPEG, GIF, WebP, AVIF, BMP) whose bytes agree with its
  extension, within the per-picture size.

Copies are named by content hash; `index.json` maps each written path to its
copy, to the lane whose report named it and to the project the picture lay
in. A picture whose copy is already of the same file (size and modification
time) is not copied again. Pictures are streamed one at a time. One record
adds at most 64 pictures and 64 MiB. Video is not kept. The copy is made
beside the write and never delays or fails it; a task update that changes
neither text nor details does nothing.

## How it is read

`/api/image`, `/api/artifact` and the task album read a path where it lies
while a file is there under a root they serve. Otherwise they read the kept
copy, through the usual raster admission: after the picture was swept, and
for a picture in a named temp root. A copy reaches no further than the roots
it may be copied from. A workspace member reads a kept copy when the member
may read the project the picture lay in. A picture with no copy answers as
missing, and the text shows a frame that says the picture is not available.

The store is read for rasters and is no evidence root: agents are never told
to render into it.

## Limits

| Variable | Default | Meaning |
| --- | --- | --- |
| `LLV_REPORT_MEDIA_MAX_BYTES` | 1 GiB | The whole store. Past it, the pictures named longest ago leave first. |
| `LLV_REPORT_MEDIA_MAX_FILE_BYTES` | 16 MiB | One picture. A larger one is not copied. |
| `LLV_REPORT_MEDIA_RETENTION_DAYS` | 7 | How long a copy stays after its clock starts. |
| `LLV_REPORT_MEDIA_TEMP_ROOTS` | the service temp directory and `/tmp` | Colon-separated temp roots a named picture may be copied from; empty for none. |

The clock of a picture named by a lane's report starts when the lane
finished: its record is closed and nothing of it is still running. While the
lane runs, its pictures stay.

A picture that belongs to no lane (a task, a bridge report) is looked at once
the retention has passed since it was last named. While it still lies at its
own path it stays. When it is first found gone, that moment is recorded, and
the copy stays the full retention after it.

The index holds at most 10,000 paths. An index that cannot be read is set
aside as `index.unreadable` and rebuilt by the writes that follow; the copies
stay, and one that no path names is removed once it is older than the
retention.

The limits are applied on a write that changes the store; with nothing
written, nothing grows.

## Other stores

- Finished-work frames (`<state>/done-media/`) keep 128 pairs or 64 MiB,
  oldest first.
- Prototype reviews (`<state>/prototype-reviews/`) keep 200 rounds or 2 GiB,
  4 MiB a picture and 64 MiB a video, and drop a round's media 30 days after
  its task is done.
- Worktree backup evidence (`<state>/evidence/<lane>/worktree/`) copies every
  ignored media file of a retired checkout and has no limit. Reports no
  longer read from it; removing that copy is a separate change.
