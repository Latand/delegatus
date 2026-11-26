# Sign in with ChatGPT for Delegatus's API-key features

## 1. Scope

Delegatus uses the open-source Sign in with ChatGPT flow to register a
client named Delegatus for the operator who signs in. The first slice
covers the API backend's text delegation turns in Voice Delegatus calls
started by the operator. It uses loopback OAuth with PKCE, a stable
`ext_agent_host_id`, private token storage and streamed Responses requests
with `store: false`.

Team members' voice calls use the API key. The key also covers audio, the
Decisions API and in-call fallback. Agent launching and the Codex and
Claude accounts keep their existing authentication.

## 2. Verdict

- **No client ID application is needed for the open-source path.** Delegatus is
  an MIT-licensed app each user runs on their own machine. An owner explicitly
  enables that flow with `LLV_CHATGPT_PLAN_CLIENT_ID=dynamic_agent_client`;
  with the setting absent, sign-in, discovery and credential writes stay off.
  OpenAI issues each user a client ID at first sign-in through the documented
  bootstrap entry point with `agent_name_hint` "Delegatus". A read-only probe
  (§4.3) showed the authorize endpoint accepts it. The commercial interest
  form fields are recorded for reference in §10.2.
- **One of Delegatus's OpenAI API-key calls is on the supported route:** the
  text turns of Voice Delegatus's API backend. The other API-key features are
  audio (dictation, read aloud, the live voice session) or use the Decisions
  endpoint (the asks, memory and learned-rules classifiers). Neither audio nor
  Decisions is served by this flow (§5).
- **First slice:** build the Sign in with ChatGPT core (sign-in, host ID,
  credential file, refresh, sign-out, a streamed Responses client, error
  mapping, one row in the Keys section). Then bill the backend turns of voice
  calls the owner starts to the ChatGPT plan. Everything else keeps the API key.
  Retryable errors may fall back to the API key; policy refusals block further
  paid dispatch in that call, while ineligible accounts and unsupported
  capabilities disable plan use for that registration until owner recovery.
- **The devkit is reference material only.** Its licence allows noncommercial
  use only, so Delegatus (MIT) implements the flow from the public
  documentation and copies no devkit code or brand assets (§4.12).

## 3. Evidence boundary

- **Documentation**, fetched 2026-11-24 08:56 UTC as the Markdown twins the docs
  publish (append `.md` to each URL). All 15 pages answered HTTP 200 and were
  read whole: the overview, sign-in, accounts and sessions, token reference,
  models and inference, Codex app-server, errors and recovery, preview
  limitations, self-hosted VMs, request a client ID, quickstart, UI/UX
  guidelines, website, account security notification, and the docs index.
  Quotes below come from those copies.
- **Devkit**: `github.com/openai/sign-in-with-chatgpt-devkit`, commit
  `0a36fefeb913055c8c7a1a29b63d82b96b2e841a` (2026-10-07), cloned into stage
  scratch. Read: `README.md`, `docs/security.md`, `LICENSE`, and the six source
  files under `packages/local/src/`.
- **Interest form**: `openai.com/form/sign-in-with-chatgpt-interest/`, page HTML
  fetched 2026-11-24 08:58 UTC. Fields come from the rendered form markup and
  its embedded form definition (§10).
- **OIDC discovery**: `https://auth.openai.com/.well-known/openid-configuration`,
  fetched 2026-11-24 09:00 UTC (§4.11).
- **Probe**, 2026-11-24 09:06 UTC: two unauthenticated `GET`s to the authorize
  endpoint carrying a fresh random host ID, the name `probe`, a 127.0.0.1
  callback and a PKCE challenge (§4.3). No account was signed in, no
  registration or token was created, and no Responses or model request was
  sent.
- **Code**: `main` at `43fab846adb9`, the commit this lane started from. Every
  `file:line` below is on that commit. Inventory search, run from the
  repository root:
  `rg -n --glob '!*.test.*' --glob '!*.fixture.*' -e 'api\.openai\.com' -e '/v1/responses' -e 'chat/completions' -e 'OPENAI_API_KEY' -e 'openai-api-key' -e 'readApiKey\(' src/`,
  plus a search for every `Bearer` header in `src/`. Each hit was then read at
  its call site.
- **Earlier answers**: `search_transcripts` (project-scoped, then unscoped) for
  "Sign in with ChatGPT ext_agent_host_id dynamic_agent_client" and "token
  sharing ChatGPT plan usage Responses store false subscription_sharing", and
  `search_memory` for "Sign in with ChatGPT subscription credits OAuth client
  ID". Nothing turned up beyond this lane's own brief. Earlier designs this one
  builds on: `docs/design/openai-key-services.md` (the six OpenAI-key features
  and their provider policy), `docs/design/keys-settings.md` (the Keys
  section), and `docs/design/voice-codex-subscription.md` (voice on the Codex
  subscription).

## 4. What the documentation and the devkit require

### 4.1 Eligibility and the client ID

- Quickstart (https://developers.openai.com/siwc/quickstart): "Sign in with
  ChatGPT is currently available to selected commercial partners through a
  limited trial. ChatGPT plan usage is available to all open-source partners
  and selected private clients." Also: "The open-source sign-in flow
  registers your client and issues OAuth credentials for eligible Responses
  API requests, without a client secret or partner API key." And: "Eligible
  ChatGPT Plus and Pro users can use their ChatGPT plan for AI requests".
- Overview (https://developers.openai.com/siwc/token-sharing-open-source):
  "These docs explain ChatGPT plan usage for open-source and locally hosted
  apps. If you're interested in offering it in a paid or remotely hosted app,
  complete the interest form". And: "In this dynamic-registration flow, each
  issued `client_id` is bound to the authenticated user and the workspace
  selected during registration."
- Request a client ID (https://developers.openai.com/siwc/request-client-id),
  the whole page: "Sign in with ChatGPT is currently offered to a select group
  of commercial partners. To join the waitlist, complete the Sign in with
  ChatGPT interest form."
- The form page itself
  (https://openai.com/form/sign-in-with-chatgpt-interest/): "If you're an open
  source developer, explore our developer docs. If you're a commercial partner
  interested in integrating Sign in with ChatGPT, complete the form below."
  The success message it carries says OpenAI will "reach out if your product
  is a fit".
- Sign-in (https://developers.openai.com/siwc/token-sharing-open-source/sign-in):
  "`dynamic_agent_client` is the first-time registration entrypoint, not the
  client ID to save or use for token exchange. This direct flow needs neither a
  client secret nor a partner API key."

So no application is needed for Delegatus's open-source flow. An owner may
configure either the documented bootstrap value or an issued client ID with
`LLV_CHATGPT_PLAN_CLIENT_ID`. The issued client ID (an `oaiapp_…` value in the
docs' example) is per-user state returned by the sign-in callback and stored
under the operator's state directory.

### 4.2 Client, host and `ext_agent_host_id`

From the overview (https://developers.openai.com/siwc/token-sharing-open-source):

- "An agent host is the environment where an instance of your tool runs, such
  as a laptop installation or a self-hosted VM. Your app defines what counts as
  one host and when its lifecycle begins and ends. Restarting the tool or
  signing in again does not by itself create a new host."
- "An issued `client_id` can be reused across different agent hosts for the
  same user and workspace, but each host must have its own distinct host
  identifier."
- "Generate and persist a stable `ext_agent_host_id` for each host separately.
  Choose and persist the host ID before its first sign-in. Use an opaque value,
  not an email, user ID, or other user-identifying value. A host ID is not an
  authentication credential."
- Accepted formats: `urn:ietf:params:oauth:jwk-thumbprint:…` (recommended,
  RFC 9278), `urn:uuid:…` ("Supported alternative. Generate a UUID and store
  its URI once for the host's lifecycle"), and `did:key:<key>`. "A
  public-key-derived host ID is currently an identifier only. OpenAI does not
  verify possession of the private key as part of this flow."
- Self-hosted VMs
  (https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms):
  "A `127.0.0.1` callback reaches the computer running the browser, not the
  remote VM." Credentials may be moved to a VM over a secure channel, and the
  page adds: "Preserve the host ID assigned to the VM when importing the
  credentials so a copied laptop ID does not overwrite it."

### 4.3 Authorization request

From sign-in (https://developers.openai.com/siwc/token-sharing-open-source/sign-in):

- Endpoint: "Open the system browser at
  `https://auth.openai.com/api/accounts/authorize` and URL-encode each query
  parameter value."
- Per attempt: "generate a fresh random `state`, OIDC `nonce`, and PKCE
  verifier for each attempt. Keep those values and the exact callback URI until
  the callback completes."

| Parameter | Requirement (quoted or condensed from the parameter table) |
| --- | --- |
| `client_id` | "`dynamic_agent_client` when the user registers their client for the first time." Afterwards "reuse the same issued client ID returned during registration." |
| `agent_name_hint` | "Your app's actual name … Use it consistently across installations and include it only on initial dynamic-registration requests. Omit it from reauthorization with an issued client ID." |
| `ext_agent_host_id` | "Required host identifier, distinct for each host." |
| `id_token_hint`, `login_hint` | Optional on reauthorization. |
| `response_type` | `code` |
| `redirect_uri` | "Use an HTTP loopback callback on `127.0.0.1` from initial registration onward … Later sign-ins may use another available port … only the port may vary. Keep the scheme, host, and path unchanged … Within each authorization attempt, send the exact same URI … Do not substitute with `localhost`." |
| `scope` | "Identity scopes: `openid profile email`. ChatGPT plan usage scopes: `offline_access resource.invoke chatgpt.tokens.use.direct`." |
| `resource` | `https://api.openai.com/v1` |
| `state`, `nonce` | Fresh random values; validate `state` on return and `nonce` in the ID token. |
| `code_challenge_method`, `code_challenge` | `S256`; "The base64url-encoded SHA-256 digest of the PKCE verifier, without padding." |

**Probe, 2026-11-24 09:06 UTC.** This was an unauthenticated `GET` of the
authorize endpoint. The request used the parameters above, a fresh random
`urn:uuid:` host ID, `agent_name_hint=probe` and
`redirect_uri=http://127.0.0.1:1455/auth/callback`:

| `client_id` | Answer |
| --- | --- |
| `dynamic_agent_client` | HTTP 302 to `https://auth.openai.com/log-in` |
| `not_a_registered_client` | HTTP 400, JSON `error.code` `invalid_authorize_client` ("Check that client_id and redirect_uri match your app's registration.") |

The entry point and the host-ID parameter are accepted before login.
Registration, consent and the scope grant after login were not observed,
because that takes a person signing in. The production check (§8.12) is the
first observation of them.

### 4.4 Callback and code exchange

From sign-in (https://developers.openai.com/siwc/token-sharing-open-source/sign-in):

- "If the callback contains `error=access_denied`, validate `state`, stop the
  attempt, and do not exchange a code."
- "A successful **new registration** returns `code`, `state`, and the issued
  `client_id`." On reauthorization "the callback may omit `client_id`; retain
  the exact client ID already associated with the pending request. If the
  callback supplies a different client ID, reject the result".
- "Do not save `dynamic_agent_client` as the connection's issued ID. If a
  new-registration callback does not include an issued ID, treat registration
  as incomplete."
- Exchange: "POST a form-encoded `authorization_code` grant to
  `https://auth.openai.com/api/accounts/oauth/token` with the issued
  `client_id`, `code`, `code_verifier`, the same `redirect_uri`, and the same
  `resource`. No client secret is required."
- "If code exchange returns `invalid_grant`, discard that code and start a
  fresh authorization with the issued client ID retained for this attempt."

### 4.5 ID token and plan permission

- "Verify its signature against OpenAI's published JWKS. Check the issuer,
  audience against the issued client ID, expiration, and the nonce saved for
  this attempt. Use its validated `sub` as the account identity."
- "For a returning account, confirm the new ID token's verified identity
  matches the selected account before replacing credentials. Check the token
  response's granted scopes for `chatgpt.tokens.use.direct` before proceeding
  to inference. A valid ID token alone does not authorize ChatGPT plan usage."

### 4.6 Credential storage

- Sign-in §5: "Keep a separate protected credential record for each issued
  client ID and its verified account identity. Save the validated identity,
  tokens, granted scopes, and expiry information … Retain the ID token so your
  tool can provide `id_token_hint` on a later sign-in. Keep the stable host ID
  with the runtime it identifies."
- "Write files atomically with owner-only permissions (`0600` on Unix), and
  never commit or log them. Replace the access token, expiry, granted scopes,
  and rotating refresh token together after a successful refresh."
- Accounts and sessions
  (https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions):
  "Keep tokens out of browser storage, source control, logs, analytics, and
  support transcripts. Never put access or refresh tokens in URLs. … redact
  authorization URLs containing that hint from logs and diagnostics." And: "If
  credentials are compromised, instruct the user to disconnect the app in
  ChatGPT Settings."

### 4.7 Token lifetimes and refresh

- Token reference
  (https://developers.openai.com/siwc/token-sharing-open-source/token-reference):
  the token response carries "`access_token`, `refresh_token`, `id_token`,
  `token_type`, `expires_in`, `scope`, and `earliest_refresh_at`". "Access
  tokens are valid for one hour (`expires_in: 3600`). Refresh tokens are valid
  for 30 days. Each successful refresh returns a replacement refresh token with
  a fresh 30-day lifetime." The access-token claims (`aud`
  `https://api.openai.com/v1`, `client_id`, `scope`, an opaque
  `https://api.openai.com/auth` object) are opaque to the app: "your app does
  not need to interpret it".
- Accounts and sessions: "POST form-encoded `grant_type=refresh_token`, the
  issued `client_id` … the saved `refresh_token`, and
  `resource=https://api.openai.com/v1` to
  `https://auth.openai.com/api/accounts/oauth/token`; omit `scope` to retain
  the grant. Store and use the latest replacement, and serialize refreshes for
  the same session so two processes do not race a rotating token."

### 4.8 Sign-out and revocation

Accounts and sessions: "revoke the renewable session using the
`revocation_endpoint` from
`https://auth.openai.com/.well-known/openid-configuration`. Send a
form-encoded `POST` with `token=<REFRESH_TOKEN>`,
`token_type_hint=refresh_token`, and the issued `client_id`. An empty HTTP
`200` is the revocation success response, including for an already-invalid
token." "For a network failure or `5xx`, retry with backoff while the refresh
token is still available. If you finish signing out locally without
confirming revocation, clear the local tokens and tell the user that remote
revocation was not confirmed." "Revoking this session does not delete the
registered client." Signing out keeps "its account/client mapping and this
host's ID for a later sign-in."

### 4.9 Models and inference

From models and inference
(https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference):

- Model catalog: `GET https://api.openai.com/v1/models` with the same bearer
  token; keep `models[]` entries with `visibility == "list"`; show
  `display_name`, send `slug`.
- "send the OAuth access token as `Authorization: Bearer <ACCESS_TOKEN>` to
  `POST https://api.openai.com/v1/responses`." "do not point it at ChatGPT's
  `backend-api` endpoints."
- "**Set `store` to `false` and `stream` to `true` on each HTTP inference
  request in this flow.**"
- "Treat inference as successful only after receiving `response.completed`. …
  A usage-limit error can arrive as `response.failed` with
  `subscription_sharing_usage_limit_exceeded` or
  `subscription_sharing_usage_unavailable` after streaming has begun. … Handle
  `response.incomplete`, explicit errors, and interrupted streams separately
  from `response.completed`."

### 4.10 Preview limitations

From preview limitations
(https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations):

- "Set `store: false` and `stream: true`. Send `input` as an array containing
  the context needed for each request. Use `instructions` or developer
  messages; explicit `{type: "message", role: "system"}` items are rejected."
- "**Unsupported fields:** Omit `background`, `conversation`,
  `max_output_tokens`, `max_tool_calls`, `metadata`, `moderation`,
  `multi_agent`, `prompt`, `prompt_cache_retention`, `safety_identifier`,
  `temperature`, `top_logprobs`, `top_p`, `truncation`, and `user`."
- "Omit `previous_response_id` over HTTP and send the required history in
  `input`."
- "**Supported tools:** Group function/custom tools in namespaces or supply
  them through `additional_tools` input items." "**Unsupported tools:** Image
  generation, file search, Code Interpreter, native computer use, hosted
  MCP/connectors, and Responses `tool_search`."
- "**Inputs:** Text, images, and files are supported when the selected model
  accepts them. Audio/video input, the Files upload API, and the transcription
  API are not supported by this flow."
- Errors and recovery lists the `service-tier override` among the things
  `subscription_sharing_unsupported_capability` rejects.

### 4.11 Errors and recovery

From errors and recovery
(https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery):

- Plan use not granted: "If the result contains a valid ID token without that
  permission, retain the sign-in but mark ChatGPT plan usage as disabled." To
  enable it later, "repeat OAuth with the saved client ID and the **complete
  requested scope set**". Use `prompt=consent` until OpenAI confirms
  `force_reconsent=true` for the integration, and do not "force consent on
  every ordinary sign-in".
- "ChatGPT plan usage errors stop inference. OpenAI does not silently switch
  the request to another billing path. Preserve the actual HTTP status,
  response body shape, error code when present, and request ID."
- Before a stream opens, admission can answer `{"detail":"..."}`: "Treat the
  message as diagnostic text, not a stable machine-readable code." Status
  `401`: identity or permission not accepted. `403`: "A policy or permission
  check, such as the permitted serving region, prevented admission." `503`:
  "Direct routing is unavailable or not enabled. Preserve credentials and use
  bounded backoff".
- Structured codes: `subscription_sharing_user_not_eligible` (403, "do not
  repeat the same request or loop through OAuth");
  `subscription_sharing_usage_limit_exceeded` (429, "Pause new requests that
  use the user's ChatGPT plan and link to ChatGPT settings → Usage … an
  app-specific limit can also apply");
  `subscription_sharing_usage_unavailable` (503, retry later with bounded
  backoff); `subscription_sharing_unsupported_capability` (400, "Inspect
  `error.param` … Do not retry the same invalid body");
  `subscription_sharing_route_not_supported` (403, "support for another client
  type or route is not permission to use it here");
  `subscription_sharing_invalid_user` (401); `chatpass_v2_scope_not_authorized`
  and `chatpass_v2_invalid_authorization_context` (403, "Check the client and
  grant configuration rather than retrying or changing billing");
  `subscription_sharing_user_unavailable` (503, bounded backoff).
- "OpenAI does not currently notify your tool when a user disconnects the app
  in ChatGPT settings. … Do not erase credentials solely because of a temporary
  network or infrastructure failure."
- Refresh errors: "`invalid_grant` on refresh, `invalid_refresh_token`,
  `token_expired`, `refresh_token_expired`, `refresh_token_invalidated`, or
  `refresh_token_reused`. Clear unusable tokens and repeat OAuth with the saved
  issued client ID." "`invalid_client`. Fix the client configuration."

OIDC discovery, observed 2026-11-24: issuer `https://auth.openai.com`;
`authorization_endpoint` `…/api/accounts/authorize`; `token_endpoint`
`…/api/accounts/oauth/token`; `revocation_endpoint`
`…/api/accounts/oauth/revoke`; `jwks_uri` `…/.well-known/jwks.json`;
`code_challenge_methods_supported` `["S256"]`;
`id_token_signing_alg_values_supported` `["RS256"]`;
`token_endpoint_auth_methods_supported` includes `none`. There is no
`registration_endpoint`, because registration happens inside the authorize
flow.

### 4.12 Codex app-server, usage limits, UI guidelines, devkit

- Codex app-server
  (https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server):
  Codex can be driven with a plan token through a custom `model_provider` with
  `env_key="ACCESS_TOKEN"`, `wire_api="responses"` and
  `supports_websockets=false`. The app must refresh the token itself and
  "Restart app-server with the updated `ACCESS_TOKEN` … and resume the
  conversation using `thread/resume`". This is agent launching, which the
  owner excluded, so Delegatus does not adopt it (Deferred).
- Shared limits (accounts and sessions): "For ChatGPT Plus users, the
  five-hour usage limit is shared across all apps where they use their ChatGPT
  plan, including private and open-source clients. … The five-hour usage limit
  does not apply for Pro users." Users can set an app's weekly limit from 10%
  to 100% and choose whether it may use credits.
- UI/UX guidelines (https://developers.openai.com/siwc/ui-ux-guidelines):
  - Use the labels "Continue with ChatGPT" and "Sign in with ChatGPT".
  - Show a one-time confirmation "You're using your ChatGPT plan" with a "Got
    it" action.
  - Show "Using ChatGPT plan" near the composer or model selector, with a
    "Manage usage" link to `https://chatgpt.com/settings/usage`.
  - On a usage-limit error, make "Manage usage" the primary action.
  - Make clear which of the app's plans support plan usage. Delegatus has no
    paid plans, so this item does not apply.
- Devkit (commit `0a36fefe`). It is a Node SDK (`packages/local`), React
  components, brand assets and a macOS example. What it adds to the docs:
  - It refuses to persist credentials without an OS-backed encryption provider
    ("There is no plaintext fallback"). Its `chatgpt-host.json` holds the host
    ID unencrypted.
  - Before the one-time code exchange, it saves the issued client ID as a
    pending registration, so a failed exchange does not register a second
    client.
  - On refresh, it saves the rotated tokens as a pending checkpoint before it
    verifies a returned ID token. This avoids losing the only valid refresh
    token when the signing keys are unreachable.
  - Its callback listener checks the method, the exact `Host` and the path. A
    request with a wrong `state` does not consume the attempt.
  - Its Responses client sets `maxRetries: 0`, `redirect: "error"`, no
    organization or project headers and a 180 s deadline.
  - Its `sendHostId` option defaults to `false` ("Enable only when the
    authorization provider supports ext_agent_host_id"). The docs read later
    call the host ID required, and the probe in §4.3 shows the authorize
    endpoint accepts it. This design follows the docs and always sends it.
  - **Licence**: "Sign-in with ChatGPT DevKit Noncommercial License v1.0".
    Its terms read: "solely for Noncommercial Purposes" and "This License
    grants no rights to OpenAI names, trademarks, logos, or branded visual
    assets". Delegatus is MIT-licensed and used commercially, so the
    implementation is written from the public docs, imports no devkit package
    and copies no devkit source or SVG. The licence also says "Independently
    authored software does not become a Modified Work merely by calling …
    through an interface", which covers calling OpenAI's endpoints directly.

## 5. Inventory: every place a Delegatus feature calls OpenAI with an API key

The OpenAI key is read from `OPENAI_API_KEY` or the `openai-api-key` config
file (`src/lib/keys/reading.ts:18-27`, `src/lib/keys/shared.ts:33`; written at
`src/lib/keys/store.ts:31`). The per-feature choice of provider is
`resolveService` (`src/lib/openaiServices/policy.ts:64-86`, key read `:66`,
voice options `:60`). The table lists each outbound call that presents that
key. It is ordered by feature and then by request.

| # | Feature: what it does | Call site | Endpoint, model | Modality | Eligible for Sign in with ChatGPT |
| --- | --- | --- | --- | --- | --- |
| 1 | **Asks you** (when OpenAI is chosen): scores each agent message for "asks the operator / waiting / needs a decision" | `src/lib/asks/controller.ts:114` (resolve), `:120` → `src/lib/openaiServices/decisions.ts:57-60` → `:33-38` | `POST /v1/decisions`, `gpt-6-luna` (`decisions.ts:4-5`) | text in, probabilities out | **No.** The plan route serves `POST /v1/responses`; any other route answers `subscription_sharing_route_not_supported` (§4.11). A Responses rewrite cannot return calibrated probabilities (`top_logprobs` is unsupported, §4.10), while the threshold 0.85 is set on probabilities. |
| 2 | **Memory in chats** (when OpenAI is chosen): picks which stored memories to inject into an agent prompt | `src/lib/memory/controller.ts:161`, `:188-190` → `src/lib/memory/injection.ts:89-90` → `decisions.ts:33` | `POST /v1/decisions`, `gpt-6-luna` | text | **No**, same reasons; this also runs inside a 1.5 s injection budget. |
| 3 | **Learned rules selection** (when OpenAI is chosen): picks role rules for a stage launch | `src/lib/memory/roleSelectionProvider.ts:85-93`, `:96-126` (`decideWithOpenAi` at `:126`) | `POST /v1/decisions`, `gpt-6-luna` | text | **No**, same reasons (threshold 0.3 on probabilities). |
| 4 | **Dictation, recorded**: transcribes a recorded clip | `src/app/api/transcribe/route.ts:56-60` → `src/lib/transcribe/openai.ts:4-16` | `POST /v1/audio/transcriptions`, `gpt-transcribe` | audio in | **No**: "Audio/video input … and the transcription API are not supported by this flow." |
| 5 | **Dictation, live**: mints a short-lived client secret; the browser streams the microphone | `src/app/api/transcribe/token/route.ts:39`, `:120-134` (mint); `src/hooks/useDictation.ts:52`, `:246` (browser call with the minted secret) | `POST /v1/realtime/client_secrets`, then `POST /v1/realtime/calls`; `gpt-live-transcribe` | audio in, realtime | **No**: audio, and a realtime route. |
| 6 | **Read aloud** (OpenAI voice): speaks agent text | `src/app/api/tts/route.ts:184-193` → `src/lib/ttsOpenAiRealtime.ts:10-13`; model and voice from `src/lib/ttsBackend.ts:125-133`, `:178`; key `src/lib/ttsBackend.ts:93-95` | `wss://api.openai.com/v1/realtime`, `gpt-realtime-2.1-mini` | audio out, realtime | **No**: audio output, realtime route. |
| 7 | **Voice Delegatus, API backend: the live session**: the spoken conversation | `src/lib/voiceCompanion/provider.ts:59-75` (create), `:77-78` (attach), `:42-48` (hang up); model `src/lib/voiceCompanion/sessionConfig.ts:11`; key `src/lib/voiceCompanion/storage.ts:339-346` read at `src/lib/voiceCompanion/liveSession.ts:360` | `POST /v1/live/sessions` (WebRTC), `wss …/live/sessions/{id}/attach`, `POST …/hangup`; `gpt-live-1.1` | audio, realtime | **No**: audio. |
| 8 | **Voice Delegatus, API backend: the delegation turn**: when the voice delegates, the server asks a text model to read the board, call Delegatus tools and write the answer the voice speaks | `src/lib/voiceCompanion/liveSession.ts:796-813` → `src/lib/voiceCompanion/provider.ts:50-58`; body `src/lib/voiceCompanion/sessionConfig.ts:92-98`; tools `src/lib/voiceCompanion/tools.ts:212-213`, `src/lib/voiceTools/snapshot.ts:61-63` | `POST /v1/responses`, `gpt-6-luna` (`sessionConfig.ts:12`) | text and function tools | **Yes, after body changes** (§8.9): `stream: true`; drop `max_output_tokens` and `service_tier`; group the function tools in a namespace; the model must be in the account's catalog. |

Voice Delegatus defaults to the API backend when nothing is saved
(`src/lib/voiceCompanion/storage.ts:325`). Rows 7 and 8 are therefore the
default voice path for a new install.

Not in scope, listed so the inventory is complete:

- **OpenRouter-key features.** Asks, memory and learned-rules selection
  default to OpenRouter's Jev endpoint (`src/lib/asks/jev.ts:15`,
  `src/lib/memory/injection.ts:91-94`,
  `src/lib/memory/roleSelectionProvider.ts:158`, `:182`). That is an OpenRouter
  key on an OpenRouter route. The relay names the OpenAI key, and the plan
  route cannot serve these calls either.
- **Subscription paths that already exist.** These use the Codex or ChatGPT
  sign-in, which the owner excluded: the `codex` voice backend
  (`docs/design/voice-codex-subscription.md`), the `chatgpt` dictation backend
  (`src/lib/transcribe/chatgpt.ts:13`), Codex cloud
  (`src/lib/pipelines/cloudHostedClient.ts`), and the Claude provider catalog
  (`src/lib/accounts/claude.ts:679`).
- **Other providers' keys**: ElevenLabs, Soniox and Fish Audio (dictation and
  read aloud).
- **No API key involved.** Titles, summaries and the external relay send no
  OpenAI request with an API key: task titles are written by agents, and the
  relay presents Delegatus's own relay credential
  (`src/lib/externalRelay/client.ts:131`).
- **Manual scripts**: `scripts/role-selection-eval.ts:122` is a research
  script; it is not a product feature.

## 6. Recommendation: what moves, and in which order

**Slice 1 (the smallest safe slice that moves an API-key call): the core plus
row 8 for owner-started calls.**

1. Build the Sign in with ChatGPT core (§8.1–§8.8): host ID, loopback PKCE
   sign-in, credential file, refresh, sign-out, a streamed Responses client
   and error mapping. Add one Keys row to connect, show status and sign out
   (§8.10).
2. When the plan is connected with `chatgpt.tokens.use.direct`, bill a voice
   delegation turn (row 8) to the plan. This applies only when the call runs
   on the API backend and the owner started it.
3. The live audio session of the same call (row 7) keeps the API key. So does
   every other row. Retryable errors may use the API key; policy refusals block
   further paid dispatch for that call, and terminal account or capability
   restrictions remain visible until owner recovery (§8.9).

Why this slice:

- Row 8 is the only API-key call on the documented route.
- It runs a few times per call, so it adds little to the plan's shared limits.
  Background classifiers (rows 1–3) would run on every agent message, every
  memory lookup and every stage launch. On a Plus plan that usage would come
  out of the same five-hour pool as other apps (§4.12). The docs do not say
  whether Codex agents draw from that pool. If they do, background
  classification on the plan would compete with the agents that are
  Delegatus's main work. This is an inference; it was not observed.
- A failure costs one spoken turn, and the call's API key already covers the
  fallback.

What the owner gets: on the API backend, the backend turns of their own voice
calls stop spending API money; the live audio keeps spending it. No cost was
measured. This document claims no amount, and the share of a call's cost the
backend turns make up is unmeasured.

**Not moved, with the reason** (see Deferred):

- Rows 1–3 keep their existing Decisions API requests and API-key billing.
  Revisit if OpenAI lists `/v1/decisions` for plan usage.
- Rows 4–7 are audio, which the flow does not serve.

## 7. How a signed-in ChatGPT account relates to the Codex accounts

- **Separate registrations.** The Codex accounts Delegatus manages are
  ChatGPT sign-ins of OpenAI's own Codex client (`auth.json` per account
  directory). A Sign in with ChatGPT connection is a different OAuth client:
  a "user-defined agent" named Delegatus, issued to the person who signs in,
  bound to the workspace they chose, with its own tokens. The same ChatGPT
  account can back both.
- **No crossing in either direction.** The plan path never reads a Codex
  `auth.json`. Codex tokens belong to another client, and the docs forbid
  pointing plan usage at `backend-api`. Codex agents, account selection,
  launching and the `codex` voice backend never read the plan credentials,
  and the owner excluded them from this work. The plan module imports nothing
  from `src/lib/accounts/` and nothing there imports it.
- **Shared limits.** For a Plus account the five-hour limit is shared across
  apps (§4.12), so plan usage by Delegatus may reduce the headroom the same
  account has elsewhere. That is the reason slice 1 keeps background work off
  the plan. The Keys row links to ChatGPT usage settings, where the owner can
  cap Delegatus's share.
- **Display.** The Keys row shows the signed-in email to the owner only, from
  the validated ID token. It never matches that email against Codex accounts
  or shows one next to the other, because the email does not identify a
  workspace (§4.5).

## 8. Design

### 8.1 Files and ownership

New module `src/lib/chatgptPlan/`, one concern per file:

- `constants.ts` — issuer, resource, scopes, the registration entry
  `dynamic_agent_client`, `agent_name_hint` "Delegatus", callback path
  `/auth/callback`.
- `hostId.ts` — §8.3.
- `store.ts` — credential file, §8.5.
- `oauth.ts` — authorize URL, loopback listener, code exchange, §8.4.
- `idToken.ts` — RS256 verification against JWKS with `node:crypto`
  (`createPublicKey({ format: "jwk" })`, `verify("RSA-SHA256", …)`), with no
  new dependency.
- `session.ts` — access token for a request, refresh, sign-out, §8.6–§8.7.
- `responses.ts` — streamed Responses client and model list, §8.8.
- `errors.ts` — mapping, §8.11.

There is one route file, `src/app/api/chatgpt-plan/route.ts` (§8.10).

**Who touches the files.** Only the Viewer process (state owner `viewer`)
reads or writes the credential file. The runtime host, the MCP server,
launchers and agents never do. No module resolves a state path at import
time: every path is computed inside the function that uses it, so builds and
tests never reach the operator's directory (AGENTS.md, "Only a declared owner
resolves the operator's state directory"). Before writing route code, the
builder reads the route-handler guide under `node_modules/next/dist/docs/`.

### 8.2 Configuration, and the "client ID is configuration" criterion

The pinned acceptance asks that "the client ID is configuration (not
hard-coded); with no client ID configured the feature stays off and says so".
The criterion assumes a project-level client ID. §4.1 shows the open-source
flow has none:

- `dynamic_agent_client` is the documented registration entry point and is
  the same for every app. `agent_name_hint` "Delegatus" is required to be
  "consistent across installations". Both are protocol constants in
  `constants.ts`, and neither is a credential.
- The issued client ID is per-account state. It is saved with the credential
  record at sign-in (§8.5) and never set by hand.
- **The outcome the criterion protects holds.** No credential is in the source.
  The plan path is off until the owner completes a sign-in that returns a
  validated identity and the `chatgpt.tokens.use.direct` scope. While off, the
  Keys row and the status route say why: "Not connected", "Plan use not
  enabled", "Reconnect needed", or "Not available on a staging Viewer". No
  feature changes its provider while off, so existing tests never enter the
  plan path: their state directories hold no credential file.
- The owner explicitly opts in by setting `LLV_CHATGPT_PLAN_CLIENT_ID` to the
  documented OSS registration value or to an issued client ID. With the value
  absent, status is `off_unconfigured`; discovery, storage, sign-in and plan
  billing remain disabled. OSS registration belongs to the installation owner.

### 8.3 Host ID

- Value: `urn:uuid:<UUIDv4>`, generated once with `crypto.randomUUID()`. The
  JWK-thumbprint format is optional in the docs, and a key pair here would
  prove nothing because "OpenAI does not verify possession of the private
  key" (Deferred).
- File: `statePath("chatgpt-plan", "host.json")`, holding
  `{ "version": 1, "id": "urn:uuid:…" }`. The plan store creates a private
  `0700` directory and uses `writeTextDurably` for exclusive `0600` writes,
  fsync and atomic rename under `withFileTransactionAsync`. Delegatus creates
  the host ID before opening the first sign-in page and reuses it thereafter.
- One host per state directory. Release succession keeps the directory, so it
  keeps the host. A staging Viewer refuses sign-in, so it has no host.
- A malformed `host.json` refuses sign-in with "Restore the host identity
  file". It is never silently regenerated, because a new host for the same
  installation breaks the documented lifecycle.
- Install transfer: the transfer exporter copies only the sections it lists
  (`src/lib/transfer/sections.ts`). `chatgpt-plan/` is never added, so a
  transfer carries neither the host ID nor the credentials. The self-hosted
  VM procedure is Deferred.

### 8.4 Sign-in flow

1. The owner presses **Continue with ChatGPT** in the Keys row. This sends
   `POST /api/chatgpt-plan { "action": "sign-in" }`. The gate is the existing
   `keysOwnerGate` (`src/lib/keys/access.ts:41-49`): same origin, no spawn
   capability, a Delegatus page session, and the team owner only. A staging
   Viewer answers 409 `staging`.
2. Only one attempt can be pending. A second start answers 409 `busy` with the
   existing attempt's state.
3. The server reads or creates the host ID (§8.3). It reads discovery once per
   process and checks that `issuer` equals `https://auth.openai.com` and that
   every endpoint has that origin. It then generates `state`, `nonce` and a
   PKCE verifier, each 32 random bytes in base64url. The challenge is
   base64url(SHA-256(verifier)) without padding.
4. It binds a `node:http` server on host `127.0.0.1`, port `0`, and reads the
   assigned port back. The redirect URI is
   `http://127.0.0.1:<port>/auth/callback`. Docker Compose runs the image with
   `network_mode: host` (`docker-compose.yml:10`), so the listener is the
   host's loopback.
5. It answers `{ authorizeUrl }` with `Cache-Control: no-store`. The page
   opens that URL in a new tab with `noopener`; no process is spawned, so the
   URL never appears in process arguments. The URL carries:
   - `client_id`: `dynamic_agent_client` for a new registration, or the saved
     issued client ID otherwise;
   - `agent_name_hint=Delegatus` on a new registration only;
   - `ext_agent_host_id`, `response_type=code`, `redirect_uri`, the six
     scopes, `resource`, `state`, `nonce` and `code_challenge_method=S256`
     with `code_challenge`;
   - `prompt=consent` only when the owner explicitly enables plan use after a
     decline.
   It carries no `id_token_hint` and no `login_hint`, so it carries no token or
   email. The owner sees the account selector, which the docs describe for
   that case.
6. The listener answers only a `GET` whose `Host` equals
   `127.0.0.1:<port>`, whose path is `/auth/callback`, and that carries exactly
   one `state` equal to the attempt's, compared timing-safely. Anything else
   gets 404 or 400 and leaves the attempt pending. The `Host` check stops a
   DNS-rebinding page from reaching the listener. A matching request gets a
   static page, "Return to Delegatus. You can close this tab.", sent with
   `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and
   `Content-Security-Policy: default-src 'none'`. The page has no script.
7. Then, in order:
   - `error=access_denied` (or any `error`): the attempt ends with that code
     and no exchange is made.
   - New registration: the callback must carry one `client_id` matching
     `^[A-Za-z0-9_-]{1,200}$` that is not `dynamic_agent_client`. Otherwise
     the result is `registration_incomplete`. The issued ID is written to the
     credential file as a pending registration **before** the exchange (§4.4,
     devkit pattern), so a failed exchange never registers again.
   - Reauthorization: a `client_id` in the callback that differs from the
     saved one rejects the result.
8. Exchange: `POST` to the token endpoint, form-encoded, with the fields in
   §4.4. Deadline 15 s, `redirect: "error"`. An `invalid_grant` answer starts
   one fresh authorization with the retained issued client ID, never a new
   registration.
9. The token response must carry `token_type` bearer, `expires_in` > 0, a
   non-empty `access_token`, an `id_token` and a `scope` string. Plan-enabled
   grants also require a `refresh_token`. Verify the ID token
   as in §4.5: RS256 with a key from `jwks_uri`, `iss`, `aud` (and `azp` when
   `aud` has several entries), `exp` with 5 s tolerance, `nonce` and a
   non-empty `sub`. On reauthorization, `sub` must equal the saved subject;
   otherwise the result is `account_mismatch` and nothing is replaced.
   Without `chatgpt.tokens.use.direct` the state becomes "Plan use not
   enabled" (§4.11).
10. Read `GET /v1/models` once with the new access token. Store the slugs with
    `visibility: "list"` (at most 200 entries; they are not secret) to tell
    the owner whether the voice backend model is offered (§8.9).
11. The listener closes when the attempt completes, fails, is cancelled
    (`{ "action": "cancel" }`) or reaches its 10-minute deadline, and when the
    process exits. The page polls `GET /api/chatgpt-plan` once per 2 s while
    the attempt is pending and stops when it settles.

If the Viewer generation that owns an attempt is demoted during succession,
the attempt is lost and the owner presses the button again. The issued client
ID, if already saved, is reused.

**The browser must run on the same machine as Delegatus.** A 127.0.0.1
callback reaches the machine running the browser (§4.2). When the Keys page is
served under a Host that is not loopback (a phone, a remote team URL), the row
says "Sign in from a browser on the computer that runs Delegatus" and offers
no button. Pasting the callback address back into the page is Deferred.

### 8.5 Credential file

`statePath("chatgpt-plan", "credentials.json")` holds one connection: one
ChatGPT account per installation in slice 1 (several accounts are Deferred).
Its fields:

- identity and version: `version: 1`, `issuer`, `clientId` (issued), `subject`;
- `email`: a display label for the owner only;
- tokens and expiry: `idToken`, `accessToken`, `refreshToken`, `expiresAt`
  (epoch ms), `earliestRefreshAt` when present;
- grant and catalog: `scopes` (an array), `models` (an array of slugs);
- `savedAt`;
- `pendingRegistration` while a first exchange is open, and
  `pendingRotation` while a refreshed ID token is unverified (§8.6);
- `signedOut` with `revocationConfirmed` after a sign-out (§8.7).

Writes use the host ID's durable writer (§8.3) under
`withFileTransactionAsync`. Reads use `O_NOFOLLOW` and refuse a file that is not a regular file,
that exceeds 64 KiB, or whose mode lets group or other read it. They also
refuse a directory or file owned by another uid. A refused or corrupt file
leaves its bytes in place and reports "Restore the credential file or sign in
again"; it is never overwritten by a read. A one-time "Got it" flag for the
first-use confirmation (§8.10) lives in the same record.

The tokens are stored without encryption, at the same trust level as
`openai-api-key` and the Codex `auth.json` files. The devkit encrypts with an
OS keychain, which a headless Linux host or the container usually lacks
(Deferred).

**Threat model** (each row names the check that holds it):

| Threat | Holds because |
| --- | --- |
| Another local user reads the tokens | Directory `0700`, file `0600`, uid and mode checked on every read |
| Same-uid code reads the tokens: agents Delegatus launches, other tools | Not prevented, as with the existing API keys and Codex `auth.json`. Spawned agents get a sandboxed config root (`withAgentConfigSandbox`), so default path resolution misses this file, but an absolute path still reaches it. Limits: the access token serves only plan inference ("does not grant access to their ChatGPT conversations") and lives one hour; the 30-day refresh token is the sensitive part, and sign-out revokes it. |
| A token reaches a browser | No route answer carries a token, code, verifier or ID token; the status answer is an allowlisted object (§8.10). The authorize URL carries none. |
| A token or code reaches a log | No line includes a token, code, `state`, an authorize or callback URL, or an upstream message. Logs carry a fixed event name, the HTTP status, an allowlisted error code and a request ID matching `^[A-Za-z0-9_.:-]{1,160}$` (§8.11). Tests capture console output and assert that the synthetic tokens never appear. |
| A local process forges the callback | 256-bit `state` compared timing-safely; the PKCE verifier exists only in the Viewer's memory; port 0; the listener binds 127.0.0.1 only and accepts only `Host: 127.0.0.1:<port>`. |
| The authorization code is intercepted (browser history, another local process) | PKCE S256, single-use code exchanged at once. |
| Refresh-token race between processes (two Viewer generations during succession, a stray second instance) | Refresh runs under the file lock, re-reads inside it and reuses a newer token another process already saved (§8.6). A staging Viewer refuses to sign in, so it never shares the rotating token. |
| Credentials leave the machine | Excluded from install transfer and from the Keys export («Copy all keys» covers `KEY_IDS` only). |
| Team members spend the owner's plan | Only the team owner can sign in, sign out or see the email. Only owner-started voice calls use the plan (§8.9). |
| Compromise suspected | Sign out revokes the refresh token. The row links to ChatGPT settings, where the app can be disconnected (§4.6). |

### 8.6 Access token for a request, and refresh

`planAccess(signal)` returns either `{ accessToken }` or a typed refusal
(`not_connected`, `plan_disabled`, `reconnect_required`, `retry_later`).
Steps:

1. Read the file. If `expiresAt - now > 60 s` and there is no
   `pendingRotation`, return the token. The file is a few KB, read per
   request; it is not cached.
2. Otherwise check refresh eligibility. If `earliestRefreshAt` is in the
   future, use the current access token while it remains valid and answer
   `retry_later` after it expires. Take the file transaction on
   `credentials.json` with a 15 s wait bound. Re-read inside the lock: a newer `expiresAt`
   means another process refreshed, so use its token.
3. `POST` the refresh grant (§4.7) with no `scope`. Deadline 15 s, below the
   lock's 30 s staleness bound (`src/lib/state/fileTransaction.ts:12`).
4. On HTTP 200, replace the access token, refresh token, expiry and scopes
   together in one atomic write before anything else. A missing `scope`
   keeps the previous scopes. If the answer carries an `id_token`, write it
   as `pendingRotation` in the same write, then verify it. Its `sub` must
   equal the saved subject; a mismatch clears the tokens and sets
   `reconnect_required`. If the signing keys cannot be reached, keep
   `pendingRotation` and answer `retry_later`; the next call resumes
   verification and never re-sends the consumed refresh token.
5. Error codes:
   - The six "unusable refresh token" codes (§4.11) clear the access, refresh
     and ID tokens, keep `clientId`, `subject`, `email` and the host ID, and
     set `reconnect_required`.
   - `invalid_client` sets `reconnect_required` with the reason
     `client_rejected`, and the row says "OpenAI rejected this registration;
     sign in again".
   - A network error, a timeout or any 5xx keeps everything and answers
     `retry_later`.

Refresh happens on use; nothing refreshes in the background. A connection idle
for 30 days expires and the row asks to reconnect (keep-alive is Deferred).
Each step is asynchronous under one deadline. No request path waits
synchronously on the lock.

### 8.7 Sign-out and revocation

`DELETE /api/chatgpt-plan` (owner gate) runs these steps:

1. Mark the record `signedOut`, clear the persisted access, refresh and ID
   tokens, and keep the issued client ID, subject, email label and host ID.
   New plan requests stop. Keep the refresh token in memory for revocation
   and record remote revocation as unconfirmed.
2. `POST` the discovery `revocation_endpoint` with `token=<refresh token>`,
   `token_type_hint=refresh_token` and `client_id`. HTTP 200 is success. A
   5xx or network error is retried twice with 300 ms and 1 s backoff, about
   10 s in total.
3. Record confirmation on success. If the process exits during revocation,
   the record remains signed out with remote revocation unconfirmed.
4. Answer `{ revocationConfirmed }`. When it is false, the row says "Signed
   out here. OpenAI did not confirm the sign-out; disconnect Delegatus in
   ChatGPT settings." and links to ChatGPT settings.

A turn already in flight finishes with the token it holds.

### 8.8 Responses client

`streamPlanResponse(body, signal)` behaves as follows:

- **Request.** `POST https://api.openai.com/v1/responses` with
  `Authorization: Bearer <access token>`, `Content-Type: application/json` and
  `Accept: text/event-stream`. It sends no organization or project header and
  uses `redirect: "error"`, plain `fetch` and no SDK (rule 9). The deadline is
  the caller's signal combined with the caller's timeout (20 s for voice,
  unchanged).
- **Body.** The client sets `store: false` and `stream: true` itself. It
  refuses to send a body that carries any field from §4.10's unsupported list,
  `service_tier`, `previous_response_id`, or an `input` item with role
  `system`. The refusal throws locally before any network call, and a test
  asserts it.
- **Before the stream.** A non-2xx answer is read up to 64 KiB, as JSON when
  possible, and mapped (§8.11).
- **The stream.** Server-sent events are parsed line by line, up to 4 MiB per
  response.
  - `response.output_text.delta` goes to an optional `onDelta`.
  - `response.failed` and `error` are mapped from their `error.code` and
    `error.param`.
  - `response.incomplete` becomes `incomplete`.
  - `response.completed` returns `event.response`, the complete response
    object, so a caller that parsed a non-streamed JSON response can read it
    the same way.
  - A stream that ends without `response.completed` is `stream_interrupted`.
- **Errors.** No message, body or submitted text from an SDK or upstream
  enters an error, a log line or a route answer.
- **Model list.** `listPlanModels(signal)` sends `GET /v1/models`, keeps
  entries with `visibility === "list"` and returns their slugs.

### 8.9 Voice Delegatus delegation turns on the plan (the slice-1 feature)

When a voice call starts, `liveSession` (around `:355-361`, where the backend
and key are chosen) records which way its backend turns are billed. The plan
is chosen when all of these hold:

- the effective voice backend is `api`;
- the call's `startedBy` is the local operator or the active team owner;
- `planAccess` reports connected with `chatgpt.tokens.use.direct`;
- when a model catalog was stored, it contains `LIVE_BACKEND_MODEL`.

Otherwise the call bills the API key, as today. The live session (row 7)
always uses the API key; on this backend the call needs the key anyway.

For each plan-billed delegation turn (the loop at `liveSession.ts:799-813`):

- **Request.** `planBackendRequest(input, options)` in `sessionConfig.ts`
  builds today's `backendRequest` body and then changes four things:
  - it removes `max_output_tokens` and `service_tier`;
  - it moves the function tools into one namespace,
    `{ "type": "namespace", "name": "delegatus", "description": …, "tools": […] }`;
  - it keeps `tool_choice`, `parallel_tool_calls`, `reasoning` and
    `instructions`;
  - `input` already uses only `developer` and `user` roles
    (`liveSession.ts:796`).
- **Output.** Function-call output items carry the tool's `name` and an
  optional `namespace` (Responses create reference, function call item). The
  parser at `liveSession.ts:820-821` keeps matching on `name`, and accepts
  `namespace` only when it is absent or equal to `delegatus`.
- **Sending.** The provider gains `respondOnPlan(request, signal)`, which calls
  `planAccess` and then `streamPlanResponse`. It returns the completed
  response object, which the existing loop reads unchanged.
- **Spend ledger.** A plan-billed turn neither extends the call's USD
  reservation (`liveSession.ts:805`) nor writes a `usage.responses` row
  (`:807`, `:813`). The readers of those rows are `sessionValidation.ts:38`
  and `liveSession.ts:1145`, `:1331`, `:1484` and `:1513-1514`. They keep
  seeing only API-key turns, so the ledger schema and the monthly cap are
  unchanged. An older release that reads the document sees nothing new.
- **Fallback.** Transient and request-specific errors may switch this call's
  remaining turns to the API key. Authorization policy refusals block further
  plan and key dispatch for the rest of this call. Ineligibility and unsupported
  capabilities are persisted against the registration and remain visible until
  owner recovery restores plan use. The same turn is retried on the key only for
  retryable fallback classes, through today's path with its reservation. Asking
  again is safe because
  tools run only from a completed response's output: a plan stream that failed
  or broke before `response.completed` executed nothing, so asking again cannot
  send to the orchestrator twice. The plan turn may still have consumed plan
  usage, and the key turn is billed as today. The docs require no silent
  switch (§4.11). In this design the owner chose the API backend, which
  already bills the key, and the voice settings row shows when a call fell
  back and why (§8.10). Later calls retry the plan only when no registration
  restriction was recorded.

Existing voice tests never reach this path: their state directories hold no
credential file, so `planAccess` answers `not_connected` and the call bills
the key as today.

### 8.10 Routes and UI (existing controls only)

**Route** `src/app/api/chatgpt-plan/route.ts`:

- `GET` returns the status
  `{ state, reason?, account?: { email }, planModels?: { voiceBackend: boolean }, revocationConfirmed?, acknowledged, usageUrl }`.
  The `state` values are `off_staging`, `not_connected`, `connecting`,
  `connected`, `plan_disabled`, `reconnect_required`, `remote_browser` and
  `error`.
  - `account` goes to the owner only. A team member gets `state` only. A
    caller with a spawn capability is refused, using the gates of
    `src/lib/keys/access.ts`.
  - The answer is built from an allowlist of fields, and the response is
    `no-store`.
- `POST { action: "sign-in" | "enable-plan" | "cancel" | "acknowledge" }` and
  `DELETE` (sign out) run behind `keysOwnerGate` and accept a bounded body
  (`readBoundedJson`, 1 KiB). Each writes one audit line, in the style of
  `auditKeyAction`: `[chatgpt-plan] sign-in-started|connected|declined|signed-out|revocation-unconfirmed`,
  with no value.

**Keys section**: one row, **ChatGPT plan**, directly under the OpenAI key row.
It uses the existing `KeyRow` layout and the row menu of
`src/components/keys/KeysSection.tsx`. Its states, with distinct words:

| State | Row text | Action |
| --- | --- | --- |
| Not connected | "Use your ChatGPT plan for Voice Delegatus's text turns." | **Continue with ChatGPT** |
| Connecting | "Finish signing in in the browser tab." | Cancel |
| Connected | email (owner only) and "Using ChatGPT plan" | Menu: Manage usage (opens `https://chatgpt.com/settings/usage`), Sign out |
| Connected, model not offered | "Your plan does not offer the voice backend model; voice keeps the API key." | Manage usage, Sign out |
| Plan use not enabled | "Signed in. ChatGPT plan use is not enabled." | **Enable ChatGPT plan use** (sends `prompt=consent`) |
| Reconnect needed | "Sign in again to keep using your ChatGPT plan." | **Continue with ChatGPT** |
| Remote browser | "Sign in from a browser on the computer that runs Delegatus." | none |
| Staging | "Not available on a staging Viewer." | none |
| Team member | "The ChatGPT plan is available to the owner." | none |

- **First use.** After the first successful connection, the row shows once:
  "You're using your ChatGPT plan. Eligible requests in Delegatus use your
  ChatGPT plan; manage usage in ChatGPT settings." with **Got it**. The docs'
  modal is shown inline in the row's existing status line, so no new dialog
  is added.
- **Under the OpenAI key row.** In `OpenAiServicesList`
  (`src/components/keys/OpenAiServices.tsx:186`), the voice entry reads "API ·
  text turns on ChatGPT plan" while the plan is in use.
- **Voice settings.** One detail row in `src/components/settings/VoiceSection.tsx`
  (the detail list near `:163`) reads "Backend turns: ChatGPT plan · Manage
  usage". After a fallback it reads "Backend turns: API key (ChatGPT plan
  limit reached) · Manage usage".
- **Language.** Strings are added in English and Ukrainian
  (`src/lib/i18n/en.ts`, `uk.ts`).
- **Branding.** The button uses the guideline label as text in Delegatus's
  existing primary button style. The ChatGPT mark is shown only if taken from
  OpenAI's brand resources under their terms; no devkit SVG is copied.

**Rendered evidence** goes through the existing drivers named in AGENTS.md.
Each state above is captured in en and uk, light and dark:

- the Keys row and the voice detail row through the kanban board driver
  (`src/components/kanban/kanbanBoard.browser.test.tsx`, one new `describe`
  block over `issue1695Evidence.fixture.tsx`, which already renders the Keys
  scenes);
- the phone width through `src/components/mobile/issue1671Evidence.browser.test.tsx`.

### 8.11 Error mapping

Each documented code maps to one outcome class. Upstream messages, including
admission `detail` text, are never stored or shown. Only the status, the
allowlisted code, `param` when it is identifier-shaped, and the request ID are
kept.

| Source | Code or status | Class | Delegatus does |
| --- | --- | --- | --- |
| Callback | `access_denied` | `declined` | Ends the attempt; row "Sign-in was not completed." |
| Token exchange | `invalid_grant` | `retry_auth` | One fresh authorization with the issued client ID |
| Token, ID token | invalid shape or signature, nonce or `sub` mismatch | `reconnect_required` | Nothing replaced; row asks to sign in again |
| Token | scope lacks `chatgpt.tokens.use.direct` | `plan_disabled` | Signed in, plan off; **Enable ChatGPT plan use** |
| Refresh | the six unusable-token codes | `reconnect_required` | Clear tokens, keep registration (§8.6) |
| Refresh, token | `invalid_client` | `client_rejected` | Reconnect needed, reason shown |
| Responses | `subscription_sharing_usage_limit_exceeded` (429) | `plan_limit` | Plan paused for this call; key fallback; "Manage usage" primary in the voice row |
| Responses | `subscription_sharing_usage_unavailable`, `subscription_sharing_user_unavailable` (503); admission 503 | `retry_later` | Credentials kept; key fallback for this call; the next call tries again |
| Responses | `subscription_sharing_user_not_eligible` (403) | `not_eligible` | Persist plan restriction for the registration; show owner recovery reason; key may serve the current call |
| Responses | `subscription_sharing_unsupported_capability` (400) | `request_invalid` | Persist restriction so the capability is never resubmitted; show owner recovery reason; key may serve the current call |
| Responses | `subscription_sharing_route_not_supported`, `chatpass_v2_scope_not_authorized`, `chatpass_v2_invalid_authorization_context` (403); admission 403 | `policy_denied` | Plan and key dispatch blocked; show owner recovery reason |
| Responses | `subscription_sharing_invalid_user` (401); admission 401 | `credential_rejected` | Key fallback; credentials kept until a refresh or revocation confirms. The docs say not to erase on a single failure. |
| Responses | `response.incomplete`, stream ended early, network, timeout | `interrupted` | Key fallback for this turn (§8.9) |
| Revocation | non-200 after retries | `revocation_unconfirmed` | Local tokens cleared; row says so |

### 8.12 Tests and checks

All tests use a fake `fetch` and a fake JWKS signed by an RSA key generated
in the test. They use no real credential and no email-shaped value unless the
privacy gate passes it. Every test runs with `LLV_STATE_DIR`, `HOME`,
`XDG_CONFIG_HOME` and `TMPDIR` under its own temp root, and with
`LLV_VIEWER_CONTROL_URL` on a closed port. Each file named in the cases below
runs by path through `scripts/gate-slot.sh`.

- `oauth.test.ts`:
  - the verifier is 43 base64url characters; the challenge equals
    base64url(SHA-256(verifier)) and the method is `S256`;
  - `state`, `nonce` and verifier are fresh per attempt;
  - the listener binds 127.0.0.1 on an assigned port and the redirect URI
    uses that port;
  - a wrong `Host`, a wrong path, a second `state` or a mismatched `state`
    returns 4xx and leaves the attempt pending;
  - `error=access_denied` sends no exchange;
  - the issued client ID is saved before the exchange; `invalid_grant` leads
    to a second authorize URL with the issued ID and no `agent_name_hint`;
  - a callback `client_id` that differs from the saved one is rejected;
  - a new registration with no `client_id`, or `dynamic_agent_client`, is
    incomplete;
  - authorize URL parameters: first time versus reauthorization;
    `ext_agent_host_id` always present; no `id_token_hint`, `login_hint` or
    token in the URL;
  - the listener closes on completion, cancellation and its deadline.
- `idToken.test.ts`: valid; wrong `iss`, `aud`, `azp`, `nonce`; expired; bad
  signature; unknown `kid`; JWKS unreachable gives `retry_later` and is never
  treated as an invalid identity.
- `store.test.ts`:
  - files `0600` and directory `0700`; writes are atomic;
  - group-readable, symlinked or foreign-uid files are refused and left
    untouched;
  - the host ID is created once and stable across module reloads, and a
    malformed host file refuses sign-in.
- `session.test.ts`:
  - no refresh above 60 s of remaining life, refresh below it;
  - two concurrent callers send one refresh request;
  - a newer token written by another "process" (a second store instance) is
    reused;
  - the rotation is persisted before ID-token verification, and verification
    resumes after an injected JWKS outage without a second refresh;
  - each of the six refresh codes leads to `reconnect_required`, with the
    registration kept;
  - `invalid_client` leads to `client_rejected`; a 5xx or network error keeps
    the tokens;
  - revocation: 200 is confirmed; 5xx is retried and then reported
    unconfirmed with the tokens cleared and the client ID kept.
- `responses.test.ts`:
  - the body carries `store: false` and `stream: true`; a body with any
    unsupported field, `service_tier` or a `system` item throws locally and
    sends nothing;
  - `response.completed` returns the response object;
  - `response.failed` maps each documented code;
  - admission `{detail}` with status 401, 403 or 503 maps to its class and the
    detail text never appears in the error;
  - incomplete, early end and the size bound are covered.
- `route.test.ts`:
  - with no credentials the status is `not_connected`; staging gives
    `off_staging`;
  - an agent capability header or a member session is refused for write
    actions, and members see no `account`;
  - no answer body and no captured console line contains any synthetic token,
    code or verifier.
- Voice: a fixture call started by the owner with a connected fake plan sends
  its turn to the plan with the namespace body and no USD row. A member's call
  uses the key. A plan `subscription_sharing_usage_limit_exceeded` falls back
  to the key once, with the reservation extended. Without credentials, the
  existing voice tests stay as they are.

Checks the builder runs:

- the touched test files by path;
- full types with `bun scripts/local-gate.ts check-step types`;
- the privacy gate from the merge base, as a recorded run through
  `scripts/gate-slot.sh --record`, with the two `LLV_PRIVACY_*` variables the
  pre-push hook sets;
- the rendered-evidence drivers (§8.10).

**Production check** after merge and deploy. These steps need no account:

- with no owner configuration, status is `off_unconfigured`, the Keys row
  explains that setup is disabled, and it shows no sign-in action;
- with explicit owner configuration, the Keys row starts `not_connected` and
  offers sign-in;
- `POST sign-in` returns an authorize URL whose host is `auth.openai.com`, and
  that URL answers 302 to the login page (the §4.3 probe);
- cancel closes the listener (its port refuses connections).

The end-to-end check needs the owner, once, in a browser on the Delegatus
machine:

- sign in;
- the row shows "Using ChatGPT plan";
- one owner voice call on the API backend shows "Backend turns: ChatGPT plan";
- ChatGPT settings, Usage, lists Delegatus.

That is the first observation of registration, consent, the plan scope, the
model catalog and a tool-calling turn on the plan route (§4.3).

## 9. Where the pinned specification meets the documentation

| Pinned item | What the docs say | This design |
| --- | --- | --- |
| Apply for a client ID | Open-source apps register at first sign-in; the form is for commercial partners (§4.1) | Delegatus registers as "Delegatus" at the owner's first sign-in (§10.1) |
| Client ID is configuration; off without it | The client ID is issued per account | Protocol constants in code; issued ID saved per account; off until a validated sign-in, and the row says why (§8.2) |
| Loopback on 127.0.0.1, ephemeral port | "only the port may vary", never `localhost` | Port 0 on 127.0.0.1, path `/auth/callback` (§8.4) |
| Stable `ext_agent_host_id` per installation | Required; opaque; one per host | `urn:uuid:` in the state directory, never regenerated (§8.3) |
| Tokens under the state directory, `0600`, never logged or sent to the browser | Same, plus "never put tokens in URLs" | §8.5 |
| Refresh and revocation | Rotating refresh, serialized; revoke the refresh token | §8.6, §8.7 |
| Responses with `store: false`, `stream: true` | Same, plus the field and tool limits | §8.8 |
| Errors mapped per the errors page | Codes and recovery as quoted | §8.11 |
| Inference on subscription credits | Text on `/v1/responses` only | Row 8 moves; rows 1–7 keep the API key (§5, §6) |

## 10. Client registration

### 10.1 Open-source registration

When `LLV_CHATGPT_PLAN_CLIENT_ID=dynamic_agent_client` is configured, the first
authorize request carries that bootstrap value and `agent_name_hint=Delegatus`.
OpenAI shows the operator the agent name and permissions. The callback returns
the issued client ID, which Delegatus retains for reauthorization. An owner can
replace a rejected saved registration from Settings after configuring its
replacement client ID; the stable installation host ID remains in place.

### 10.2 Commercial interest form reference

OpenAI's commercial interest form has the following fields as of
2026-11-24. [OpenAI interest form](https://openai.com/form/sign-in-with-chatgpt-interest/)

| Field (label and internal name) | Required | Source |
| --- | --- | --- |
| Work email (`Email`) | Yes | Owner only |
| First name (`FirstName`) | Yes | Owner only |
| Last name (`LastName`) | Yes | Owner only |
| Company name (`Company`) | Yes | Owner only |
| Website URL (`mkto_website_form_fill`) | Yes | Owner only |
| Job title (`Title`) | No | Owner only |
| What capabilities would you like to implement? (`mkto_sign_in_use_case[]`, radio) | Yes | Proposed selection: **Sign in and ChatGPT plan use for AI requests** (exact form option) |
| Which of your products would use Sign in with ChatGPT? (Briefly describe each product) (`mkto_describe_use_case`, up to 2,000 characters) | Yes | Proposed: Delegatus is an open-source, locally hosted agent orchestration workspace. An operator may sign in with ChatGPT to use eligible subscription credits for text-only Responses API inference. The account is used only by the local operator; agent accounts, workspace members, credentials and account details remain owner-only. |

## Deferred

- **Several ChatGPT accounts and an account picker.** The docs describe one;
  one account per installation serves the requirement.
- **Encrypting the credential file with an OS keychain** (the devkit's
  pattern). A headless host or the container has no keychain; the file keeps
  the existing API keys' protection.
- **Pasting the callback address back** for a browser on another device, and
  the self-hosted VM import procedure.
- **Background keep-alive refresh** before the 30-day refresh-token expiry.
- **Codex app-server with a plan token** (the `model_provider` setup): agent
  launching, excluded by the owner.
- **JWK-thumbprint host ID**: optional, and adds a key pair OpenAI does not
  check.
- **A plan usage summary page**: Delegatus links to ChatGPT settings instead.
- **`force_reconsent=true`**: only after OpenAI confirms it for the
  integration; `prompt=consent` is used meanwhile.
- **A model picker for plan models**: the voice backend keeps its fixed model.
- **A configurable partner client ID** for a future commercial integration.

## Validation against the originating requirement

- *Apply as Delegatus*: the open-source registration names the agent
  "Delegatus" at the owner's first sign-in (§10.1).
- *Build it in, only where Delegatus uses an OpenAI API key for its own
  features*: §5 lists every such call, and §6 moves the one the documented
  route can serve. The API key stays wherever the plan cannot serve,
  including as the in-call fallback.
- *Loopback PKCE, stable host ID, token storage, Responses with store false and
  stream true, errors per the docs*: §8.3–§8.8 and §8.11.
- *Agent launching, Codex and Claude accounts untouched*: the plan module
  reads no account directory, changes no launch path and is used by no agent
  (§7).
