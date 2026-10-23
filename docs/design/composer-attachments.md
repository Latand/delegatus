# Composer file uploads

## Observed path before the change

Observed at base `f5fd6a2c` with Bun 1.4.0 and Next 16.3.8.

Desktop `BranchPane` and phone `MobileFocusView` both mount `TmuxComposer`
(`src/components/BranchPane.tsx:541`,
`src/components/mobile/MobileFocusView.tsx:695`). Its `useComposer` enables
general files (`src/components/TmuxComposer.tsx:2153`). Pick, drop and paste
all screen through `src/lib/attachmentIntake.ts`, then
`src/components/imageAttachments.tsx` reads each file into base64. The composer
captures that payload in its durable submission before POSTing JSON to
`/api/runtime/send`, `/api/runtime/inject`, `/api/runtime/steer`, the native queue,
or the legacy `/api/tmux` alias of `/api/conversation-host`.

| Hop | Cap at the observed base |
| --- | --- |
| File intake and server admission | 20 MiB/file, five files, 40 MiB/batch: `src/lib/filePolicy.ts:12`; client applies these in `src/lib/attachmentIntake.ts:132`, server in `src/lib/inboxFiles.ts:84` |
| Long message converted to a file | Reuses file and batch bounds: `src/lib/longMessageFile.ts:15` |
| Image intake (separate surface) | 10 MiB/image: `src/lib/imagePolicy.ts:14`; negotiated runtime limits also apply |
| Runtime images | 16 images, 10 MiB/image, 18 MiB decoded total, 24 MiB encoded: `src/lib/runtime/runtimeImageStore.ts:22` |
| Stable HTTP listener | TCP pipes: `src/runtime-host/deploymentProxy.ts:84`; trusted local HTTP entry pipes the request: `src/runtime-host/deploymentProxy.ts:373`. Neither applies a body byte cap |
| Next proxy | 80 MiB body clone: `next.config.ts:18`. Installed `next/dist/server/body-streams.js` (`getCloneableBody`) truncates the clone beyond this bound; the installed `proxyClientMaxBodySize.md` documents this behavior |
| Next App Router handlers | `request.json()` at `src/lib/runtime/http.ts:220`, `src/app/api/conversation-host/handlers.ts:248`, and `src/lib/runtime/nativeQueueHttp.ts:96`; no separate Pages Router body parser is on this path |
| Bun HTTP transport | Isolated `node:http` probe on Bun 1.4.0 accepted 100, 200 and 280 MiB streamed bodies, with exact received byte counts and HTTP 200. No smaller runtime body cap applies to these sizes |
| Runtime command | 256 KiB serialized command: `src/lib/runtime/commands.ts:8`, after files become paths; text is bounded at 32,000 UTF-8 bytes in `src/lib/runtime/structuredContent.ts:40` |
| Runtime host socket | 512 KiB request frame: `src/runtime-host/socket.ts:13`; attachment bytes never cross it. Client response frames have a separate 64 MiB cap in `src/lib/runtime/client.ts:25` |
| Stream mux | 256 KiB control messages at `src/lib/streamMux/protocol.ts:42`. Uploads use ordinary HTTP POSTs and never enter this mux |

The server admits file payloads before writing. `stageInboxFiles` publishes a
completed temporary file by linking it into `inbox/files/<batch>/<name>`.
`prepareMessageFiles` folds those paths into the text before command validation;
only that text reaches runtime admission and the agent. The legacy route and
native queue use the same policy and inbox writer. Refusal releases only files
created by that request; uncertain delivery retains them.

The Telegram document and MCP document limits are separate policies.

Related lanes inspected: relay owner attachment fetching changes only
`src/lib/externalRelay/ownerRun.ts`; the Host allowlist lane changes the proxy
perimeter and matcher; voice tools add worker entries to Next configuration
and startup instrumentation. Their implementations remain owned by those lanes.


## Delivery contract

The shared policy admits 100 MiB per general file, 200 MiB per batch and five
operator files. Images retain their negotiated engine bounds. Files larger
than 1 MiB upload as a raw `File` through `/api/composer-upload`; smaller files
retain their inline base64 representation. Existing clients can still submit
20 MiB inline files and 40 MiB inline batches. Both transports use
`src/lib/filePolicy.ts`.

The raw route runs the real perimeter and same-origin checks itself, including
Host validation, before reading. It is excluded from Next's automatic body
clone, as the stream mux already is. Each read and disk write yields, size is
checked while reading, and authorization is checked again after awaited work.
A fifteen-minute deadline and client cancellation terminate an interrupted
upload. Private partials have no reference and never become agent paths.

A completed upload returns an opaque id, byte count and SHA-256. Its persisted
manifest binds that reference to the operator, member or agent who uploaded it.
Admission resolves the reference in that actor's scope and weighs the full
batch, including inline files. Source bytes are copied asynchronously to a
private temporary inbox name, verified against the retained digest, and linked
atomically into the final name. A reflink is used when supported. The retained
source has its own inode, so editing an agent's inbox file cannot change the
original upload used by recovery. Conflicting existing paths refuse without
replacement. Existing delivery retention decides when a newly created final
file may be released.

The producer is `useImageAttachments`. `composerFilePayload` preserves the
reference through direct send, steer, inject and native queue. Draft storage,
restored trays, queue admissions and the durable submission store preserve it
as well. The three server consumers are runtime HTTP, native queue HTTP and
conversation-host (including its tmux alias). Long-message conversion weighs
stored references by their original byte count. A retry rechecks the current
tray's aggregate budget.

The staging store has one filesystem owner, a maximum of 128 uploads (at most
12.5 GiB of bodies), and a seven-day lifetime. Admission counts the persisted
directories, so a Viewer restart does not reset the bound. Expired uploads are
removed during bounded admission; a stale browser reference asks for the file
to be attached again. Already published inbox files retain their existing
lifecycle. These limits are independent of the message's five-file/200 MiB
admission policy.

All asynchronous writers take the existing shared batch turn before staging.
The legacy route joins that turn too, so a link's completion cannot race with
another request taking ownership of the same final path.

## Performance verification

[performance.json](../../evidence/composer-attachments/performance.json) records
the base revision, measured backend source digest, UTC intervals, load averages
and all six trials. The production build completed with Bun 1.4.0 and Next
16.3.8. Each measurement used a fresh isolated Viewer, an empty state store,
the shared gate's three-CPU quota, one client, and exactly 100 MiB of byte 97
named `recording.ogg`. The host's one-minute load average ranged from 14.1 to
15.3. Requests passed through `serveViewerDeploymentProxy` on an ephemeral
port. No engine ran during the performance measurement.

| Pair | JSON loop gap (ms) | Stream loop gap (ms) | JSON peak RSS (MiB) | Stream peak RSS (MiB) |
| --- | ---: | ---: | ---: | ---: |
| 1 | 423.8 | 72.5 | 872.5 | 607.8 |
| 2 | 548.6 | 33.4 | 864.8 | 558.9 |
| 3 | 281.3 | 98.7 | 865.1 | 559.5 |

The JSON path increased RSS by 496.5–497.7 MiB; the streamed path increased it
by 186.8–237.2 MiB. The streamed measurement includes raw admission, an
independent inbox copy, digest verification and final inbox path planning. Its largest measured loop gap stayed below 250 ms. The Viewer's
own monitor also reported a 547 ms gap during JSON pair 2; it reported none
during the streamed intervals. A separate 10 ms loop monitor captured shorter
gaps on both paths. Peak RSS was sampled from another process every 10 ms, so
the blocked Viewer could not hide its peak from the sampler.

Measurement procedure:

1. Export the candidate into private scratch and borrow its matching installed
   dependencies. Preserve `git show f5fd6a2c:src/lib/inboxFiles.ts` as a
   scratch-only baseline module. Its policy imports resolve to the candidate's
   100/200 MiB policy. In this export only, increase Next's clone ceiling to
   320 MiB so the JSON control reaches admission. The shipped ceiling remains
   80 MiB; the raw upload route is excluded from cloning.
2. Add a scratch-only measurement route. Its JSON control calls the preserved
   admission and synchronous inbox writer. Its streamed branch calls current
   asynchronous reference admission and inbox staging. Both return whether one
   complete `recording.ogg` was stored. This route is absent from the product.
3. Run `bun run build` through the shared gate. For each trial, start that
   production build with private HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR,
   `LLV_STAGING=1`, and `LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1`. Bind the
   Viewer and stable proxy on private ephemeral ports and await HTTP readiness.
4. Warm both routes with one byte. Force GC, acknowledge a subsequent loop
   tick, then start the measured interval and external RSS sampler. Alternate
   JSON/streamed, streamed/JSON, JSON/streamed across three pairs, restarting
   with fresh state for every trial.
5. JSON posts one base64 field. Streaming posts raw data in 64 KiB chunks to
   `/api/composer-upload`, then posts its returned reference for inbox staging.
   The timer records the largest lateness beyond its 10 ms interval. Capture
   the final timer sample, HTTP status, stored-file result and RSS, then stop
   the sampler and await teardown of only the listener and processes created
   for that trial.

## Behavioral and rendered verification

The policy boundary tests failed on `f5fd6a2c` with the old limit. The stored
reference aggregate-budget test also failed there, because empty inline
buffers hid stored byte counts. The real legacy-writer regression failed with
`legacy staging bypassed the shared batch turn`; it passes with the shared
turn around asynchronous staging.

Focused checks ran by explicit file path through the assigned gate wrapper:

```sh
bash scripts/gate-slot.sh bun test src/lib/filePolicy.test.ts
bash scripts/gate-slot.sh bun test src/lib/composerUploads.test.ts
bash scripts/gate-slot.sh bun test src/lib/inboxFiles.test.ts
bash scripts/gate-slot.sh bun test src/lib/runtime/http.attachments.test.ts
bash scripts/gate-slot.sh bun test src/lib/runtime/inboxWriters.integration.test.ts
bash scripts/gate-slot.sh bun test src/lib/longMessageFile.test.ts
bash scripts/gate-slot.sh bun test src/lib/proxyBodySize.test.ts
bash scripts/gate-slot.sh bun test src/app/api/composer-upload/route.test.ts
bash scripts/gate-slot.sh bun test src/components/imageAttachments.progressive.dom.test.tsx
bash scripts/gate-slot.sh bun test src/components/ComposerBar.fileAttachments.dom.test.tsx
bash scripts/gate-slot.sh bun test src/lib/composerSubmissionPayloads.dom.test.ts
```

The existing conversation-window browser driver adds the `streamed composer
attachments` case. With `LLV_CONVERSATION_BROWSER_TEST=1` and `CHROME_BIN` set,
run its `100 MiB upload progress` test. It mounts the production composer and
checks progress, failure, retry, the completed reference and the named
100 MiB-plus-one-byte refusal at 1280×700 and 390×844, in en/uk and light/dark.
The upload transport is controlled for these rendered states; the HTTP and
storage checks above exercise real streaming. All 32 rendered frames were
inspected. [rendered.json](../../evidence/composer-attachments/rendered.json)
records geometry and results. Browser temporary files remain inside the
private scratch root through a short directory-descriptor alias on Linux.
