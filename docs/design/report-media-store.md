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
in it is copied to `<state>/report-media/`. A path is copied when the service
can read it and it is a raster (PNG, JPEG, GIF, WebP, AVIF, BMP) whose bytes
agree with its extension, within the per-picture size. It may lie anywhere
outside the stores that answer through their own routes: a checkout, the
stage scratch, `/tmp`, `/var/tmp`, a handoff directory. The text is written
by the operator or by an agent the operator runs, and the operator reads it.
The copy is made beside the write and never delays or fails it.

Copies are named by content hash; `index.json` maps each written path to its
copy and to the lane whose report named it. Video is not kept: a report's
text draws pictures only. At most 64 pictures are taken from one text.

## How it is read

`/api/image`, `/api/artifact` and the task album read a path where it lies
while a file is there under a root they serve. Otherwise they read the kept
copy, through the same admission as any evidence picture: after the picture
was swept, and also for a picture in a place those routes never read, such as
`/tmp`. A picture with no copy answers as missing, and the text shows a frame
that says the picture is not available.

## Limits

| Variable | Default | Meaning |
| --- | --- | --- |
| `LLV_REPORT_MEDIA_MAX_BYTES` | 1 GiB | The whole store. Past it, the pictures named longest ago leave first. |
| `LLV_REPORT_MEDIA_MAX_FILE_BYTES` | 16 MiB | One picture. A larger one is not copied. |
| `LLV_REPORT_MEDIA_RETENTION_DAYS` | 7 | How long a copy stays after its clock starts. |

The clock of a picture named by a lane's report starts when the lane
finished: its record is closed and nothing of it is still running. While the
lane runs, its pictures stay. The clock of a picture that belongs to no lane
(a task, a bridge report) starts when it was last named, and starts again
whenever the picture is still found at its own path, so it runs out the
retention after the picture is gone.

The limits are applied on every write to the store; with nothing written,
nothing grows.

## Other stores

- Finished-work frames (`<state>/done-media/`) keep 128 pairs or 64 MiB,
  oldest first.
- Prototype reviews (`<state>/prototype-reviews/`) keep 200 rounds or 2 GiB,
  4 MiB a picture and 64 MiB a video, and drop a round's media 30 days after
  its task is done.
- Worktree backup evidence (`<state>/evidence/<lane>/worktree/`) copies every
  ignored media file of a retired checkout and has no limit. Reports no
  longer read from it; removing that copy is a separate change.
