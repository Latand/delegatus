`owner-progress-heartbeats.json` records the POST bodies received by a loopback
relay during one synthetic owner run through `runClaimedRequest` and
`runOwnerAgent`. The owner observation port supplies thinking, a viewer board
read, other tool work, and the final-message boundary. The real heartbeat
scheduler, HTTP client, lease handling, and completion path run unchanged.
The synthetic lease is shared by all six bodies; no installation or provider
data is captured. This is a local wire capture, with a fixture owner agent.

The descriptor advertises `progress_steps`; the request sets legacy progress
to `none`. Sequence one is `accepted`. The remaining changed steps are at
least three seconds apart; the final regular heartbeat has `progress: null`.
The service's response remains `{ "status": "ok" }`.

| File | Bytes | SHA-256 |
|---|---:|---|
| `owner-progress-heartbeats.json` | 1212 | `5bdb8014cb9568dc18b0064c000340c2d37d9379eed73b27e7f8a62aa0e2a95b` |

Replay: run `src/lib/externalRelay/progressSteps.runner.test.ts` by explicit
path through `scripts/gate-slot.sh`, with isolated HOME, XDG_CONFIG_HOME,
TMPDIR, and LLV_STATE_DIR. The test checks the committed capture's bodies and
sequence against a fresh run, excluding only the UTC timestamps. To record
fresh bytes, set `LLV_RELAY_STEPS_CAPTURE` to a chosen output file during that
same test, then update the size and digest above.
