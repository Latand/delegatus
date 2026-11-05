# Read an operation's delivery timing

After deployment, choose an ordinary send's operation id from the existing
delivery records. Open the progress database read-only, then run this query
with `:operation_id` bound to that id:

```sh
sqlite3 -readonly "$LLV_STATE_DIR/delivery-progress.sqlite"
```

```sql
PRAGMA query_only = ON;
WITH marks AS (
  SELECT operation_id,
    CAST(m.key AS INTEGER) AS seq,
    json_extract(m.value, '$.mark') AS mark,
    json_extract(m.value, '$.at') AS at,
    json_extract(m.value, '$.attempt') AS attempt,
    COALESCE(json_extract(record_json, '$.timingMarksDropped'), 0) AS dropped
  FROM delivery_progress, json_each(record_json, '$.timingMarks') AS m
  WHERE operation_id = :operation_id
), ordered AS (
  SELECT *, lag(at) OVER (ORDER BY at, seq) AS previous_at
  FROM marks
)
SELECT operation_id, attempt, mark, at,
  round((julianday(at) - julianday(previous_at)) * 86400000, 3) AS elapsed_ms,
  dropped
FROM ordered ORDER BY at, seq;
```

The interval ending at each mark measures:

| Mark | Boundary |
| --- | --- |
| `queue-kick` | Queue pass starts, before journal listing; correlated after the listing resolves. |
| `host-send` | Queue enters the host, including one mark per read retry. Batch members each retain it. |
| `codex-prepare` | Codex starts preparing the normalized input. |
| `codex-confirmed-read` | Image capability and delivery preparation finished; confirmation lookup starts. |
| `codex-confirmed` | Confirmation lookup finishes. An existing confirmation can end this send here. |
| `codex-input-ready` | Structured input encoding finishes. |
| `codex-rpc-start` | `turn/start` or `turn/steer` is called. |
| `codex-rpc-end` | The RPC resolves successfully. A refusal leaves this mark absent. |
| `claude-prepare-start` | Claude begins converting the normalized entry into stream-json content. |
| `claude-prepare-end` | Claude finishes content and image preparation, before dispatch authorization. |
| `claude-write-start` | Claude is about to write the prepared user frame to child stdin. |
| `claude-write-end` | The child stdin accepts the frame write. |
| `echo-received` | The host receives the live native user item frame. |
| `echo-attached` | The host attaches that frame's operation identity to its emitted item. `attachedAt` is captured after matching and delivery-ledger confirmation. |

Native notifications can arrive before the RPC response. The query sorts by
observation time; array order records the order in which the progress sink
received marks. `attempt` is the progress record's dispatch counter when the
mark was recorded. A queue kick can precede its increment. Existing
`phaseHistory`, `ingressAt`, `engineEchoAt` and terminal times supply the outer
phase boundaries and confirmation lag.

These observations are enabled by default. Each resident progress record keeps
at most 32 marks and a dropped count. Marking does no database hydration,
dirtying, scheduling or I/O. The next existing progress write persists them
through the existing batched writer. A crash before that write can lose the
unflushed marks; a cold or absent record supplies none. Old records have no
marks. Missing or dropped marks mean incomplete measurement. Marks contain
only fixed names, timestamps and the attempt counter.

Echo timestamps travel through the existing engine event and the controller's
operation/conversation check. Batch members receive the same echo observations.
Claude preparation/write marks use the existing observer callback; callback
failure cannot affect delivery. Replayed history without a live arrival time
contributes none. No profiler or
diagnostic switch is added. Delivery phase, deadlines, wake decisions and
confirmation rules retain their existing owners.

This change measures the dispatch-to-echo delay. It claims no latency gain.
Measure ordinary sends after deployment before choosing a causal repair.
