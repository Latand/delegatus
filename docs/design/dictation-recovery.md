# Dictation recovery and diagnostics

To investigate a reported dictation interruption, read the last 100 records in
`$LLV_STATE_DIR/diagnostics/dictation.json` on the serving Viewer. An unfinished
record (`endedAt: null`) identifies a browser that stopped reporting. Match the
numeric start/stop times to the incident window, then inspect the token,
connection, drain and batch outcomes, audio sample counters, final segment and
commit counters, and the normalized WebSocket close code/reason. The record
contains no recording or recognized text. It cannot establish which words were
spoken or whether a recognition mistake was made.

The browser posts strict diagnostic checkpoints to
`POST /api/transcribe/diagnostics` at start, token resolution, connection,
segment commits and completion. The existing Viewer access/team perimeter and
same-origin write guard apply. Unknown fields and free-form close reasons are
rejected. Bodies are capped at 4 KiB. The asynchronous file writer retains 100
sessions and admits at most 32 pending writes. Per-session revisions prevent
late checkpoints from replacing a newer one, including after a Viewer restart.
The browser keeps up to eight undelivered snapshots under local storage key
`delegatus.dictation.diagnostics` and retries them at the next checkpoint.
An acknowledgement removes only the delivered revision.
A browser that cannot reach the Viewer leaves only its last delivered checkpoint
on the server. There is no diagnostics UI or command-line command.

Capture starts after microphone permission, while the temporary key and socket
are still pending. The PCM16 buffer holds at most 1,920,000 samples (3,840,000
bytes, 120 seconds at 16 kHz; less time at a higher actual context rate). A full
buffer stops capture, uploads the retained audio and reports the stop through
the existing dictation error surface. It never evicts the oldest words silently.
When the buffer fills, the microphone stops while the result is recovered;
the user reviews the draft and starts another dictation to continue.

The token wait and socket connect each have a 10-second client deadline. A token
deadline or connection failure switches to batch capture until Stop. Capture
continues through the failure, preserving words spoken after the socket drops. Batch uses the existing `/api/transcribe`
route with a WAV file and a 120-second client deadline. This avoids a second
live connection and its replay protocol. A failed recovery preserves committed
text, reports the missing tail and returns an incomplete result that blocks
one-tap voice send.

Soniox Stop sends end of input and keeps the socket callbacks alive for up to
eight seconds. Endpoint-final segments enter the draft once; `finished` also
flushes final tokens without an endpoint. Deadline expiry preserves committed
text, reports the missing tail and blocks voice send. Partial hypotheses are
never treated as a successful final tail. Recovery after a close during live
Stop shares that Stop's original deadline.

Final token identities use provider audio timestamp ranges; the last committed
segment boundary is a monotone watermark. Replaying those finals does not
insert another segment. Identical words at later timestamps remain intact.
Recovery uploads PCM strictly after the last committed token end, so previously
committed speech is excluded. Missing, impossible or ambiguous timestamps trigger batch recovery before that
segment is committed. Distinct subwords sharing a range are recovered from
retained audio; their recognized words are never compared to decide uniqueness. The active token identity set is
bounded to 8,192 entries. The protocol contracts are the Soniox
[WebSocket API](https://docs.soniox.com/api-reference/stt/websocket-api),
[timestamps](https://docs.soniox.com/stt/concepts/timestamps) and
[endpoint detection](https://docs.soniox.com/stt/rt/endpoint-detection).

This change makes no performance claim. Browser main-thread stalls and the
voice-companion path remain separate work. No paid recognition is used by the
fake socket/token and batch route tests.
