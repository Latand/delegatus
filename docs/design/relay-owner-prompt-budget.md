# Owner relay first-message budget

Reply normally to the assistant message. When its context is too large for the
structured envelope, the agent receives a labelled excerpt containing the
beginning and end. The current owner request remains complete. If that request
itself cannot fit, the reply asks for a shorter message or an attached file;
resending the same request cannot make it fit.

## Composition

`ownerRun.ts` uses one renderer budget for fresh and resumed owner turns.
`promptBudget.ts` measures the final escaped UTF-8 message against 32,000 bytes.
It first tries the complete context, then clips quotations to 4,096, 2,048,
1,024 and 512 bytes as needed. Each excerpt reserves room for its truncation
notice, respects UTF-8 boundaries, and retains both ends. The reply target stays
present with its original identity and reply links. Bridge report routing fields
stay intact while its report text can be excerpted. Local outbound origins and
question identities follow retained conversation rows; an ambiguous resolution
stays ambiguous.

The existing optional-history and service-context reductions remain available
when excerpts alone do not fit. Trusted framing and the current owner request
are never sliced. A shortened message is excluded from the conversation's
newly seen identities so a later reply can receive its context again. Optional
inbound context on a resumed dispatch cannot push the composed base over the
bound. Authorization, publication references, reply binding and output scrubbing
use the existing checks.

## Read-only incident measurements

On 2026-11-05, two retained failed requests were read without modifying their
records. Rendering their stored inputs on the starting main revision gave:

| UTF-8 section or render | Sample A | Sample B |
| --- | ---: | ---: |
| Raw owner prompt | 61,094 | 61,179 |
| Owner request section | 226 | 226 |
| Explicit reply context section | 2,841 | 2,841 |
| Reply target text | 2,466 | 2,466 |
| Service instructions section | 3,074 | 3,074 |
| Owner instructions section | 15,537 | 15,537 |
| Conversation section | 14,742 | 14,827 |
| Short-term memory section | 6,407 | 6,407 |
| Compact tool index section | 11,884 | 11,884 |
| Existing budgeted fresh prompt | 31,539 | 31,539 |

The retained inputs alone fit after the existing reductions. They do not prove
which additional hydrated or launch-time context caused the historical refusal.
The historical attribution to an oversized explicit reply section remains
unproven. Independently, synthetic route tests reproduce the whole protected
reply target bypassing the existing excerpt cap, and unbounded report text.
No private message text or identities are needed for those regressions.

## Verification

`src/lib/externalRelay/ownerEnvelope.test.ts` exercises the real owner runner and
local HTTP completion route with a deterministic test agent. It measures exact
32,000- and 32,004-byte messages containing multibyte quotations; the test agent
answers from facts at both ends. It also covers resumed dispatch, local outbound
metadata, report routing, escaped text, actionable refusal, and duplicate replay
in a fresh process. It makes no claim about a deployed Telegram session or a
live model run. Baseline and mutation runs use the same explicit test file in
isolated source exports.
