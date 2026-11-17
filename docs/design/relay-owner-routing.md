# Owner relay routing

Set `LLV_RELAY_ROUTING=1` in the Viewer environment to enable paid routing.
It defaults to **off**; unset it or set it to `0` to use the full agent for
every owner turn. This follows the explicit paid-provider selection in
[OpenAI key services](openai-key-services.md#requirement-and-settled-decisions),
implemented by `src/lib/openaiServices/policy.ts`. A saved API key
alone does not authorize a new source of charges. This environment setting
has no settings-page control or dedicated CLI command.

After the existing owner verification and durable admission, ordinary owner
turns use the shared `decisionsRequest` / `decideWithOpenAi` adapter. Any score
at or above its threshold selects the existing full agent:

| Predicate | Threshold | Reason |
| --- | --- | --- |
| Machine, file, command, tool or live-state access | 0.35 | Prefer a full turn when access may be needed. |
| Perform an action, change a project, approve or continue work | 0.35 | Avoid treating a work instruction as a general question. |
| Deep reasoning or sustained investigation | 0.50 | Send substantial analysis to the thinking agent. |

These are conservative policy thresholds, without a claim of measured
classifier calibration. Short approvals are classified with their supplied
chat context. Prototype decisions and recovery retain their existing paths.
Media and locally resolved bridge reports require the full agent directly.
Inputs over 48,000 UTF-8 bytes also retain the full path with complete context.

Below every threshold, the Responses API answers with `gpt-6.1-terra`, effort
`low`, default service tier, no tools and `store: false`. It receives scrubbed
chat data and no local recovered conversation, transcript or machine context.
Its answer passes through `ownerAnswer` and the existing completion path for
privacy filtering, rich/plain formatting, reply threading, durable delivery
and acknowledgment. Fast answers do not require a subscription account.

The classifier has a five-second bound and the fast answer a twenty-second
bound, including response decoding. Each also respects the remaining service
window with one second reserved for completion. Missing credentials, invalid
responses, HTTP/network errors and timeouts select the existing full path.
An adapter ignoring abort is still bounded. Revoked authority or replaced
request custody cancels the request instead of dispatching another path.

The existing per-request activity record gains optional `routing` evidence:
route, reason, scores, thresholds, classifier model/tokens/USD, and fast-answer
model/tokens/USD. Evidence is written before dispatch and updated after each
call; old records remain readable. Skipped calls cost zero, and an unknown
bill remains `null`. Classifier pricing comes from the Decisions adapter.
Fast-answer pricing uses `src/lib/activity/tokenPrices.ts`; Terra currently
has no entry, so its token receipt is retained with `costUsd: null`. This
prevents inventing a rate or reporting an unpriced call as free.

Tests in `src/lib/externalRelay/ownerRouting.test.ts` use fake HTTP responses
and the real relay runner against a port-zero service double. They exercise
threshold boundaries, real full-agent fallback, missing credentials, malformed
answers, timeouts, cancellation, privacy, delivery and activity persistence.
They make no paid requests. No latency or cost reduction is claimed.
