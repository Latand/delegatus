# Onboarding v2: ChatGPT subscription and API routes

On 2026-11-25 the operator chose the ChatGPT plan screen with six named
features and individual switches, alongside sign-in and an API key field.
The operator asked whether signing in also supplies a key for Decisions and
whether all or nearly all six features could use the subscription. The request
comes from the onboarding v2 prototype decision and the originating design
at `55390669`. [Onboarding v2 design](onboarding-v2.md)

## What onboarding can offer

Two features can already run without an OpenAI API key using a Codex
ChatGPT login: **Voice Delegatus** and **recorded dictation**. PR #4416 adds
a way to fund just the text delegation turns of the API voice backend.
**Read aloud, Asks you, Memory in chats and Learned rules** need an API key
for their current OpenAI implementations. For eligible Pro and Business
subscribers, a project key from a linked API organization can draw on claimed
monthly subscription API credits. OpenAI explicitly includes Decisions and
Realtime in that benefit. This is the shortest route to subscription-funded
use of the four key-backed features and preserves their behavior. A qualified
Responses rewrite could eventually give an eligible solo user a route without
a key for five of the six features, counting the two existing Codex routes.
Read aloud would still require a speech provider outside direct plan usage.

| Feature | Today at `55390669` | With #4416 at `2baf3151e4d6` | With a Responses rewrite of the three classifiers | Recommended onboarding route |
| --- | --- | --- | --- | --- |
| **Voice Delegatus** (`voice`) | The `codex` backend uses a managed, ChatGPT-signed-in Codex account via app-server for the call. The default `api` backend uses an OpenAI key for both the live session and text delegation. | In an eligible owner-started API call, the text delegation turns can use Sign in with ChatGPT. Live audio on `/v1/live/sessions` still needs the key, as do member API calls and eligible key fallbacks. The Codex call remains available independently. | The same two voice backends. The classifier rewrite adds no audio capability. | Offer **Codex via ChatGPT** for a whole call without a key. For the API backend, show **ChatGPT plan for delegation · API key for audio** when eligible. |
| **Dictation** (`dictation`) | The opt-in `chatgpt` backend runs recorded clips through the local Codex sign-in. The `openai` backend uses an API key for recorded `/v1/audio/transcriptions` and live `/v1/realtime` dictation. Local Whisper and other configured providers are available independently. | The same choices. Sign in with ChatGPT has no transcription or live audio route. | Recorded Codex dictation remains the available subscription option. | Offer **ChatGPT via Codex · recorded** when the Viewer can read the local Codex auth, subject to the existing backend lock. Keep local Whisper available. Live OpenAI dictation needs a key. |
| **Read aloud** (`read`) | The OpenAI backend generates speech over Realtime with an API key. Existing other speech providers use their own credentials. | Realtime speech remains on the key. | No direct plan route for audio output. | Show **API key** for OpenAI speech. Eligible linked API credits can cover Realtime. |
| **Asks you** (`asks`) | OpenAI Decisions with a key, or the separately configured OpenRouter classifier. | Same provider choices. The plan credential cannot call `/v1/decisions`. | An owner-only, expressly authorized background classifier is possible as text inference. It needs its own classification contract and quota controls. | Keep **API key** for OpenAI Decisions. |
| **Memory in chats** (`memory`) | OpenAI Decisions with a key, or OpenRouter, on eligible chat turns. | Same provider choices. The plan credential cannot call `/v1/decisions`. | An authenticated user's own turn could use text inference. Completion inside the existing 1.5 s deadline and selection quality are unverified. | Keep **API key** for OpenAI Decisions. |
| **Learned rules** (`rules`) | OpenAI Decisions with a usable key by default when no choice was saved. OpenRouter is the other remote provider, with local selection on refusal or unavailability. | Same provider choices. The plan credential cannot call `/v1/decisions`. | A user's own launches and expressly authorized automations could use text inference. Shared or unattributed starts need the existing route or local selection. | Keep **API key** for OpenAI Decisions and retain the local fallback. |

`src/lib/openaiServices/policy.ts:15–18,51–85,101–135` defines all six
features, their availability and their saved provider choices. A key field
can serve multiple explicit choices. Saving the key is separate from
choosing a provider. Show the effective route and any environment lock, and
leave an existing choice in place until the user applies the corresponding
switch. The voice and dictation entries should distinguish these two checks:

- Voice finds a managed account and verifies ChatGPT auth via Codex app-server
  (`src/lib/voiceCompanion/codexProvider.ts:48–59,113–148`). In #4416,
  `src/lib/voiceCompanion/server.ts:19–29` checks the solo operator or active
  team owner, and `liveSession.ts:325–331,374–378,821–874` separates plan
  eligibility, the audio key, and the text turn's admission and billing.
  Policy denial or account ineligibility blocks further backend dispatch
  in that call. If the call falls back to key billing, that state is visible.
- Dictation reads the Viewer's local Codex auth file
  (`src/lib/codexAuth.ts:15–25`, `src/lib/transcribeBackend.ts:115–135`).
  A managed account appearing in Accounts does not prove this file is
  available or its token current. `src/app/api/transcribe/route.ts:56–61,104–124`
  distinguishes the API, local and Codex paths. The existing Codex path uses
  a private ChatGPT transcription endpoint
  (`src/lib/transcribe/chatgpt.ts:9–16`). Describe it as the existing opt-in
  recorded backend. Its continued availability is separate from the published
  plan integration. Live dictation mints a Realtime credential in
  `src/app/api/transcribe/token/route.ts:120–134`. Read aloud uses
  `src/app/api/tts/route.ts:184–193` and `src/lib/ttsOpenAiRealtime.ts:10–13`.

## What OpenAI documents

**Sign in with ChatGPT.** The public Quickstart, read on 2026-11-25, says
the open-source flow “issues OAuth credentials for eligible Responses API
requests”. Its eligibility guidance names eligible Plus and Pro users.
The Help Center, read on the same date, says “it does not share an OpenAI
API key”. Codex's own sign-in has separate credentials. Delegatus needs its own
OAuth grant. Show plan usage as available once the registered connection has
the plan scope and an eligible model. [Quickstart](https://developers.openai.com/siwc/quickstart)
· [Help Center](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites)
· [Codex authentication](https://developers.openai.com/codex/auth)

**Inference.** The Models and inference guide, read on 2026-11-25, identifies
`POST https://api.openai.com/v1/responses` and says “Set `store` to `false`
and `stream` to `true` on each HTTP inference request in this flow.”
The preview guide, read on the same date, says “Audio/video input, the Files
upload API, and the transcription API are not supported by this flow.”
It excludes `top_logprobs`, `max_output_tokens`, `temperature` and
`background`, among other fields. A Viewer task started in the background
would still send an ordinary streaming request. It would never set the
Responses API's `background` field. [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
· [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)

**Permission to classify.** The *Sign in with ChatGPT Terms*, effective
2026-11-04 and read on 2026-11-25, §3.1 says “Obtain express consent before
background use.” It also says “Another user’s activity must not trigger
requests to the authenticated user’s account.” The same section limits use to
the connected app, on the user's local runtime or a remote runtime only that
user controls. Users must be able to use the plan in the app without paying
the app provider or upgrading the app. Section 1 restricts persistent token
storage to local storage under the user's control. The general Terms of Use,
effective 2026-01-01, restrict automated extraction of data or output.
Our reading of the specific SIWC terms is that the three
workloads can be app features using authorized inference over Delegatus data
under §3.1. That permission is conditional on the trigger and consent for each
call. It gives no authority to extract ChatGPT history, use a shared owner
grant for team activity, or provide generic API access.
[Sign in with ChatGPT Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/)
· [Terms of Use](https://openai.com/policies/terms-of-use/)

**Plan usage.** The Help Center says eligible requests use the “included
ChatGPT Work and Codex allowance or applicable credits” (read 2026-11-25).
This describes the allowance that app requests can draw on. It gives no
conversion per model request and no guarantee about how much Codex headroom
a given workload will leave. The open-source guide says “The five-hour usage
limit does not apply for Pro users.” Plus shares that window across apps.
App-specific weekly caps can also stop requests, and ChatGPT credits can
extend usage where the user has allowed it and has a balance. Show
**Manage usage** on plan exhaustion. A plan call creates no API Platform
dollar charge in Delegatus's API ledger, but can consume allowance or ChatGPT
credits. [Help Center](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites)
· [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
· [UI guidelines](https://developers.openai.com/siwc/ui-ux-guidelines)

**API credits included with a subscription.** OpenAI announced the credit
benefit on 2026-10-28. The guide, read on 2026-11-25, says “use one of its
project API keys when making requests”. An eligible paid Pro or Business
subscription at least seven days old can claim credits by linking an API
organization the subscriber owns. The documented Pro tiers grant $100, $200 or
$500 per cycle. Plus is ineligible. Credits expire, and separately billed
usage depends on the organization's billing settings and available credits.
The guide explicitly lists Decisions, GPT-Live and Realtime among covered
API usages. In onboarding, link the claim instructions next to the key field.
The operator claims the benefit and supplies a project key. Delegatus cannot
infer the credit balance from the key. [API credits guide](https://developers.openai.com/api/docs/guides/chatgpt-api-credits)
· [OpenAI API changelog](https://developers.openai.com/api/docs/changelog#october-2026)

## What a classifier move would change

The current adapter `src/lib/openaiServices/decisions.ts:4–64` builds
predicate requests and validates one finite probability per requested name,
plus input-token usage. Decisions explicitly returns predicate probability
estimates. Ordinary Responses generates text. Structured Outputs constrains
its shape. Even token likelihoods would measure text choices rather than give
the old predicate probability, and this plan route excludes `top_logprobs`.
The Decisions guide describes its own endpoint as “about 10x faster than the
Responses API” (read 2026-11-25). That is a vendor comparison, with no
Delegatus tail-latency measurement. [Decisions guide](https://developers.openai.com/api/docs/guides/decisions)
· [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)

If a later experiment is approved, add a classifier adapter beside
`decisions.ts`. Keep the keyed adapter for existing callers. Use the Viewer
plan client from #4416 (`src/lib/chatgptPlan/session.ts:149–181`,
`responses.ts:12–69`) with each caller's abort signal and a catalog model
qualified for that request. Serialize bounded context and candidates as
`input_text` user data. Put the rubric in `instructions`. Use no tools.
Request short strict `text.format` JSON Schema on a plan model shown to
accept it. The general Responses API documents the field, and the public
plan preview does not list it as excluded. Acceptance by the chosen plan
model is unverified. A prompt-only JSON variant would need its own quality
evaluation. Require `response.completed`, parse one expected output, and
reject refusals, partial streams, duplicate or foreign IDs, missing labels,
extra fields, and over-size output. No automatic retry on the hot path.
If a classifier request is rejected as an unsupported capability, hold
that feature/model configuration. #4416 currently persists
`request_invalid` on the whole grant. Scope classifier-specific capability
failures before sharing the client with voice. Keep true authorization and
quota failures governed by the grant.

Extend `policy.ts`, `/api/openai-services`, `asks/view.ts`, `memory/view.ts`
and the Keys/status readers with a distinct opt-in plan route for each
qualified classifier. The two views currently derive key presence from the
provider ID. Report provider availability and quota status for plan use.
Use an internal dispatch type that distinguishes a key from a Viewer-held
plan grant. Keep legacy choices, default selection, transfer and environment
locks compatible. Bind express
consent to the verified grant and feature, with a revocation control.
For a first experiment restrict it to a user-controlled solo install. Check
trusted trigger provenance, the consent and the grant at dispatch and after
awaits, including before any result write. Select an explicitly configured
baseline when no plan dispatch is admitted. After a plan dispatch, the
classifier's failure uses its local outcome for that attempt. Keep
plan request/admission counts and observed tokens separate from USD
reservations. Bound local request rate and context size. Quota and optional
credit consumption are governed by OpenAI's app controls. A timeout or
unusable answer can still consume allowance. No dollar conversion or
per-request plan price is documented for these workloads.

### Asks you

`src/lib/asks/controller.ts:92–128` feeds the traffic-owning Viewer's
15-second sweep. `sweep.ts:104–199` skips working conversations, structured
asks, stale messages and repeats. It scores an eligible final message once
and writes a board ask if `max(asks, waiting, decision) >= 0.85`
(`jev.ts:16–36`, `decisions.ts:57–63`). The request has a two-second limit
and shares its USD cap with Memory in chats.

- Change the `controller.ts` resolver and `sweep.ts` verdict/admission
  contract. Reuse `classifierText` and the three predicates. Return JSON
  `{"asks":false,"waiting":true,"decision":false}` with all three booleans
  required. Qualify a clear-ask rubric on labelled messages. Trigger if any
  qualified label is true. There is no 0.85-to-boolean conversion. Give the
  new route its own model and rubric version in the text-cache key and
  persist the new verdict kind. Keep existing score rows readable and keep
  message-level deduplication, structured signals, and the no-retry behavior.
- This poll is background use. The registry scan proves the conversation and
  generation, rather than who caused the latest answer. Join the final message
  to a trusted initiating user event before plan dispatch. Agent or teammate
  activity without proof of authorized owner origin stays on the old path.
- Most calls would be one short response per fresh, uncached eligible message.
  Cadence still matters because this runs without a browser. Compare precision
  and recall against the current app behavior using the labelled cases in
  `docs/research/attention-classifier.md`. Count missed approvals, duplicate
  asks and false board alerts, including rhetorical questions, FYI messages
  and prompts quoted by agents. Measure terminal completion within two seconds
  and total quota pressure under the same message stream. Keep Decisions for
  onboarding.

### Memory in chats

`src/app/api/memory/inject/route.ts:13` calls
`src/lib/memory/controller.ts:25–29,154–196`. The hook authorizes an operator
turn, finds scoped candidates and prepares evidence the hook later confirms.
`injection.ts:28–83` gives retrieval, reservation, model completion and local
processing one 1,500 ms deadline. `selection.ts:98–138` builds the grounded
rubric and injects at most 15 offers within 10,000 characters, ranked by
probability at or above 0.70.

- Add a route to `controller.ts` and `injection.ts` with a typed result
  for `selection.ts`. Send the same redacted latest request, bounded earlier
  turns and offer summaries, with body excerpts as evidence. Use compact
  request-local candidate IDs. Return
  `{"offers":[{"id":1,"grade":"high"},{"id":2,"grade":"omit"}]}`
  with one grade per candidate. Allow `high`, `useful` and `omit`.
  Include high/useful in that order, breaking ties by retrieval order, only
  after the rubric is evaluated against the 0.70 baseline. Preserve scope,
  deduplication and size limits, and inject only the original stored title
  and summary. Grade and rank are ordinal. The existing priority of a
  probability of 0.70 must be re-established with labelled offers.
- Check authenticated human identity in addition to the current
  `origin === "operator"` check. A launch brief can carry operator origin
  under a different initiator (`controller.ts:84–90`). A proven user's live
  submission can qualify as their activity. An automated trigger would need
  express consent and trusted attribution. Apply the scope and authority
  checks before preparing durable evidence and on confirmation as applicable.
- One call per eligible turn with candidates, often with the longest input of
  these three workloads. By the time ranking can start, identity, context
  lookup and retrieval have already used part of the 1.5 s
  (`index.ts:372–381,501–505` gives retrieval at most 100 ms and 30
  candidates). Add a warm-only admission path to `chatgptPlan/session.ts`
  to skip if the model needs discovery or the grant needs renewal. Stop
  inference before the total deadline, leaving room
  for rendering and evidence, and return an empty block on timeout or
  refusal. No second provider call on that turn. Compare end-to-end p50/p95/p99,
  deadline misses, valid completions and useful versus stale, duplicate or
  wrong-scope injections against the same cases and load. Include cold
  credentials and maximum candidate payloads. `scripts/memory-selection.ts`
  has the offline replay inputs and scoring. Keep Decisions until those
  measurements support the change.

### Learned rules

`src/lib/memory/roleLaunch.ts:60–128` selects from a scoped snapshot, then
rechecks eligible rule text and freezes a pipeline attempt's delivery.
`roleSelectionProvider.ts:70–79,85–139` redacts the brief and rules, uses
opaque names and sends up to 32 predicates per batch. `roleSelect.ts:10–12,60–77,81–196`
prepares BM25 fallback, owns the three-second selector budget and separate
USD cap, rechecks authority, then packs selected rules with operator-kept
rules protected. The actual predicate cutoff is **0.02** at both revisions
(commit `e8e9f5aa8f`). PR #4416's §5 says 0.3.

- Add a plan adapter in `roleSelectionProvider.ts` and a distinct score
  source/version in `roleSelect.ts` and the durable evidence reader in
  `roleSelection.ts`. Reuse the versioned rubric and request digest. Return
  `{"rules":[{"id":"r1","grade":"required"},{"id":"r2","grade":"omit"}]}`
  with one valid grade per opaque batch ID. Rank `required` above
  `relevant` and exclude `omit` using a separate ordinal cutoff in the
  packer. The threshold 0.02 stays on predicate results. Preserve deterministic
  ties, the 9,000-code-point/24,000-byte limits and protected rules. Preserve
  old per-attempt rows and reuse their frozen content on resume. An invalid
  batch or time/usage refusal uses the prepared BM25 fallback, without
  applying a partial ranking.
- Launch, recovery and migration all call `learnedRulesForLaunchProfile`
  in `runtime/structuredSpawn.ts`, `runtime/startup.ts`,
  `accounts/migration/provider.ts` and `pipelines/cloudStageInput.ts`
  under `src/lib/`. These entry points do not supply a plan user's authority
  to the selector. Carry proven originating-user authorization into the
  eligible launch path and use a narrow Viewer operation if the caller
  executes outside the Viewer. Keep credentials in the Viewer. Automatic
  stage starts require expressly authorized automation for that same user.
  Shared, remote-managed and unattributed starts retain existing selection.
- At current batch size, a launch with N eligible candidates needs up to
  `ceil(N / 32)` completions. Each carries the brief, and each can consume
  quota even if the launch falls back. Bound the work by the remaining
  launch deadline. Compare applied-rule recall, retention of misleading
  rules, delivered bytes and fallback rate with Decisions and local BM25 on
  held-out launches. Include large multi-batch cases and context close to
  the live deadline. The committed `evals/role-selection/README.md:16–46`
  reports 362/671 ms p50/p95 for existing OpenAI Decisions v2 on 24 offline
  cases under a 120 s deadline. Those measurements do not qualify Responses
  or the live launch path. Keep Decisions and BM25 for onboarding.

## Deferred — not currently justified

Direct Responses classifiers stay out of onboarding. The current classifiers
already qualify for the linked API-credit route, which keeps their measured
selection behavior and usage controls. If reducing key setup still warrants
a later experiment, start with explicitly authorized solo Asks you. It
runs outside the prompt and launch paths. Reuse the existing classifier
fixtures, and test malformed and truncated streams, quota, revocation in
flight, a different user's trigger, and absence of a key fallback. Include
`src/lib/asks/controller.test.ts`, `src/lib/memory/{controller,selection,roleSelect,roleSelectionProvider,roleSelection}.test.ts`
and `src/lib/chatgptPlan/responses.test.ts` from #4416 where they apply.
Any later plan usage measurement needs separate authorization. Read aloud
and the OpenAI live audio paths need an OpenAI-supported speech capability
on the documented plan route before they can move there.

Evidence for this design is the onboarding decision, the two pinned source
revisions and public pages read on 2026-11-25 UTC. PR #4416's §5 supplies the
API inventory, with the rules cutoff checked against source. This stage
made no paid API or ChatGPT plan calls. Plan-model schema support, live
latency and allowance consumed are unmeasured.
