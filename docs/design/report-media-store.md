# Report picture store

A stage report or a task names a picture by the path it has in the lane
checkout or in a stage's scratch directory. Both are removed when the lane
ends, and the picture went with them. The report picture store keeps the
pictures that a text the operator reads actually names, and nothing else.

## What is kept

When a stage report is accepted (`stage_report`) or a task's text or details
are written (MCP `create_task` / `update_task`, and the board's own task
routes), every absolute or `~/` picture path in that text is copied to
`<state>/report-media/`. A path is copied only when the path routes would
serve it at that moment: it lies under a known project, the stage scratch or
an evidence root, it is a raster (PNG, JPEG, GIF, WebP, AVIF, BMP) whose bytes
agree with its extension, and it is within the per-picture size. The copy is
made beside the write and never delays or fails it.

Copies are named by content hash; `index.json` maps each written path to its
copy. Video is not kept: a report's text draws pictures only.

## How it is read

`/api/image`, `/api/artifact` and the task album read a path as before while a
file lies there. Once it is gone they read the kept copy, through the same
admission as any evidence picture. A picture with no copy answers as missing,
and the text shows a frame that says the picture is not available.

## Limits

| Variable | Default | Meaning |
| --- | --- | --- |
| `LLV_REPORT_MEDIA_MAX_BYTES` | 1 GiB | The whole store. Past it, the pictures named longest ago leave first. |
| `LLV_REPORT_MEDIA_MAX_FILE_BYTES` | 16 MiB | One picture. A larger one is not copied. |
| `LLV_REPORT_MEDIA_RETENTION_DAYS` | 7 | A copy leaves this long after its picture was last named or last seen at its own path. |

The age clock starts when the picture is gone from its own path, so a lane
that runs for weeks keeps its early pictures, and they stay for the retention
after its checkout is removed. The limits are applied on every write to the
store; with nothing written, nothing grows. At most 64 pictures are taken from
one written text.

## Other stores

- Finished-work frames (`<state>/done-media/`) keep 128 pairs or 64 MiB,
  oldest first.
- Prototype reviews (`<state>/prototype-reviews/`) keep 200 rounds or 2 GiB,
  4 MiB a picture and 64 MiB a video, and drop a round's media 30 days after
  its task is done.
- Worktree backup evidence (`<state>/evidence/<lane>/worktree/`) still copies
  every ignored media file of a retired checkout and has no limit. With this
  store in place that media copy is no longer needed for reports; removing it
  is a separate change. Until then a path into a retired checkout that the
  store does not hold is still read from that copy.
