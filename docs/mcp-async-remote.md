# Async MCP Git and forge checks

Git and GitHub commands in the Viewer use an asynchronous executor with a timeout, output limit and abort signal. Cancelling an owned process group waits for its pipes to close before releasing a publication lock.

Stage reports record the verdict, summary and report sequence before returning. Their provenance starts `pending`, with unknown head, uncommitted paths, pull request and output presence. The controller observes the checkout and forge later and records `complete` or `unknown` on that same report sequence and its journal entry. A new report, replacement attempt or moved cursor fences the observation. An empty successful forge list means `absent`; a failed or malformed answer means `unknown`.

Committing-stage Git, commit hooks and approved-review head checks run after the controller releases the pipeline lease. Settlement holds an inherited lane lock and adopts its result only while the full lane and review-flow fingerprints still match. Review ingress and flow-creation identity use observations collected before the lease. On POSIX platforms, kernel locks use the existing native implementation, so local settlement needs no external locking utility. Task-note effects are applied after the lane and review-flow fence accepts the result. Native Windows refuses inherited-lock operations with a WSL 2 instruction before running Git; its MCP setup uses WSL 2.

Review retries and delivery takeovers record a durable `remoteAction`. The controller runs the original Git safety checks outside the pipeline mutation lease, under an inherited kernel lock, then revalidates the stage, checkout, delivery epoch and any claimed spawn receipt before applying a result. Publication records a queued operation for the existing publication controller. A read or acknowledgement exposes pending and settled outcomes; acceptance does not claim remote publication. Pausing or replacing the lane cancels stale work, and a restart resumes durable pending work after its previous process releases the lock.

`request_attention` retains its default browser-arrival contract. `waitFor: "accepted"` returns after durable acceptance with `accepted: true`, a current arrival state and `handoff: null`; callers can inspect the attention receipt for arrival later.

## Measurement

The audit's integration profile was rerun against main after the MCP answer-slimming merge and against this change. It uses the MCP SDK transport, loopback Viewer route handlers, 107 tasks, 27 pipelines, six attempts per stage and 1,000 transcript messages in private state. A deterministic external port delays each remote command by 1,200 ms. The baseline port blocks as the former production executor did; the candidate port yields while the controller checks remote state. Candidate concurrent reads run while a delayed provenance observation is in flight. Default attention still waits for the simulated browser arrival. These are controlled local measurements, not production percentiles.

| MCP scenario | Before p95 / max | After p95 / max | Samples |
| --- | ---: | ---: | ---: |
| Remote review retry | 3621.77 / 3621.77 ms | 9.53 / 9.53 ms | 2 |
| Stage report with delayed forge | 1226.26 / 1226.26 ms | 17.03 / 17.03 ms | 3 |
| Pipeline read during forge check | 1222.48 / 1222.48 ms | 18.24 / 18.24 ms | 3 |
| Attention, default arrival | 1256.62 / 1256.62 ms | 1255.36 / 1255.36 ms | 2 |
| Attention, accepted-only | New option | 1.15 / 1.15 ms | 2 |

The numeric record is [before-after.json](../evidence/mcp-async-remote/before-after.json). The request-path regressions first failed against the original synchronous implementation. Existing real-Git tests cover preserved history, exact publication SHA, inherited locks and cancellation. Deferred-work tests cover restart recovery, supersession, remote failure and receipt settlement. Tests use explicit files and isolated state; type checking, changed-file lint and the trusted-main publication gate accompany the change.
