# Delivery phase history

Each send's existing `delivery-progress.sqlite` record keeps up to 128 entries
in `phaseHistory`: `{ phase, reason, at }`. A phase is the wait reason or the
terminal state; `reason` is the bounded machine detail. Changes within a wait
reason, dispatch attempts, explicit retries and terminal corrections also leave
entries. Unchanged polling, deadline updates and wake scheduling do not create
phases. `phaseHistoryDropped` counts entries removed from the beginning.

The existing current reason, phase clock, attempts and terminal fields keep
their meaning. The history is written with the record through the existing
batched transaction. Terminal records remain for at least seven days even when
the row limit is exceeded; normal age retention is fourteen days. The row limit
can retire older records between those two bounds.

`ingressAt` is captured on entering the conversation, runtime send or native
queue handler, before body validation and
the request ledger, and attached once the operation is identified. A repeated
request retains the first timestamp. `engineEchoAt` comes from the first live
user echo produced by the engine host, before its event reaches the runtime
journal or the registry confirms delivery. It is carried by the host's durable
event ledger, so reconnects retain its observation time. Historical transcript
reconciliation cannot reconstruct raw arrival and leaves that field absent.
These observations add `ingress` and `engine-echo` boundaries to the history;
they leave the current delivery phase and outcome unchanged.

Records written by older releases can lack history and observation timestamps.
Only new observations are added; missing historical phases are never invented.

Run the read-only report with an explicit state directory:

```sh
LLV_STATE_DIR="$HOME/.config/delegatus/state" bun scripts/delivery-phase-report.ts \
  --since 2026-10-10T00:00:00Z --until 2026-10-11T00:00:00Z
```

The script also accepts an inherited valid `LLV_STATE_OWNER`; it never declares
one itself. `--since` is required and `--until` defaults to the current time.
Both times require an explicit time zone. The selected sends entered during
the half-open window, using ingress, admission or the first retained phase as
available. Each table row groups completed adjacent phase spans by phase and
reason and reports count, p50 and p95 in milliseconds using linear interpolation.
Separate totals show ingress to echo and echo to delivery confirmation when
both endpoints exist. Open spans and endpoints outside the window are omitted.
The report names records with missing or truncated history, so absent phases
remain visible as a measurement limit. It opens SQLite read-only, streams rows
and performs no migration, cleanup or delivery-record write. SQLite can create
its usual WAL coordination sidecars when opening a read-only connection.
