> “Reassess whether this relay is necessary and simplify the provider launch path.”
>
> Origin: [issue #3647](https://github.com/Latand/delegatus/issues/3647), last updated 4 November 2026, 12:01:45 UTC. The complete issue, including its acceptance checklist, was read on 6 November. It has no comments. The private dispatch instruction of 6 November authorizes this diagnosis; its conversation text is excluded from publication.

# Provider relay: diagnosis and implementation brief

Retain the credential-injecting relay and replace its content-block accumulation with bounded incremental redaction. Preserve the current pre-consumer credential protection. Repair cancellation and sanitized error detail in the same response path. Keep account selection, credential storage, launcher arguments and host construction intact.

This is a source diagnosis and a reversible implementation decision. It delivers no product change, installed acceptance or provider compatibility claim. Implementation must first make the delayed-delta regression fail on the captured base, then pass with the proposed repair. No additional ADR or general relay framework is needed.

## Evidence and observations

The assigned checkout and remote main were both `423bf964ed98d9dde744ad0f2c4f2dbf92ae146b` at the initial observation. The accepted dispatch matrix and complete D2 brief were read from `b8c5744b80cfdd21012b932372a844e76d8ed6f8:docs/audits/recent-issue-dispatch-followthrough-2026-11-06.md`, alongside the preceding conversation's final answer. The introduction PR [#2262](https://github.com/Latand/delegatus/pull/2262) reports a local native Messages stub and explicitly leaves real OpenCode Go compatibility unverified. That historical result supplies no current native-CLI verdict.

Current tracked entry points are `bin/claude-provider-relay.mjs`, `bin/claude-provider-launch.mjs` and `bin/claude-provider-health.mjs`. The TypeScript wrapper imports the first directly. The response defect is accumulation **per content block**; a multi-block response can deliver earlier completed blocks. JSON responses separately accumulate up to 8 MiB. These distinctions qualify the earlier brief's broader buffering description.

All executed probes used an exact tracked scratch export of the assigned base, Bun 1.4.0, private HOME/config/state/temp roots and synthetic credentials. HTTP servers bound loopback port 0. The real relay and launcher bytes were unchanged. Logs, scripts, primary snapshots and source digests are retained outside the checkout under the stage evidence directory. Probe timings below are individual observations of event order. They establish no general speed or memory improvement.

| Real path / retained evidence | Observed result |
| --- | --- |
| `relay-diagnostic.mjs`, direct HTTP control | With a 250 ms upstream pause, the ordinary text delta arrived about 1 ms after writing it, before `content_block_stop`. |
| Same producer and HTTP consumer through the production relay | The first response bytes arrived promptly, but the first **text delta** arrived about 252 ms after the upstream write, after block stop. Testing only time to first HTTP byte would miss the defect. |
| Same relay, interrupted upstream | Client observed a read error and incomplete response. The already received provider text delta never reached the client. No success completion was fabricated. |
| Same relay, downstream cancellation | The provider response remained open at the fixture's 350 ms checkpoint after the client disconnected; it ended when the fixture itself finished. |
| Same relay, HTTP 401/403/429/500 | Status and numeric Retry-After survived; the useful synthetic model diagnostic disappeared. Neither the synthetic token nor the provider debug header reached the client. |
| Same relay, redirect to a second loopback origin | Client received 502; the second origin received zero requests. |
| Same relay, attempted 160 × 64 KiB text deltas in one block | The stream failed after the block bound was crossed. The client received 196 bytes of opening metadata and no ordinary text delta. This establishes rejection of a large block, not a bounded-memory streaming result. |
| `relay-supplement.mjs`, clean EOF inside an open block | Client observed a read error. This control distinguishes explicit truncation refusal from the separate cancellation defect. |
| `launcher-diagnostic.mjs`, actual launcher with a synthetic HTTP client, fresh and resume | Both exited 0. The selected prefix, model, custom header and session header survived. Token was absent from the child environment and response; stderr was empty. The same child could read both private credential files. |
| Existing `src/lib/runtime/claudeProviderRelay.test.ts` | 12 passed, 0 failed, 39 assertions, actual exit 0. Existing split-secret, Unicode/slash escape, initial-text, thinking/signature, malformed-SSE and numeric-secret cases passed. |

The first probe's large-payload harness emitted a listener-count warning from its own repeated drain/close race. That warning is retained and is not attributed to production. Its raw RSS samples include the producer and consumer in the same process and are unsuitable for a relay memory claim. The supplementary harness removes the listener accumulation. The test runner reported portable cleanup because no user systemd manager was reachable inside its isolated environment; this was a short relay-only test, with no host lifecycle suite or detached model process.

The native alternative was investigated separately. Installed Claude Code `2.1.318` answered `--version` and `--help`; its help exposes partial stream output, settings-source controls, strict MCP configuration and session-persistence controls. The current host already invokes native `stream-json` with partial messages. A prepared real-CLI/local-stub comparison could not start: `bwrap` failed while configuring isolated loopback with `Failed RTM_NEWADDR: Operation not permitted`. Explicit user/network namespaces produced the same setup failure. The CLI made no model request. No claim about current native delta timing, echoed-token behavior or all supported CLI versions follows from this attempt. The safe next observation is the retained native fixture on a runner with working network namespaces and external egress closed.

The [native gateway documentation](https://code.claude.com/docs/en/llm-gateway-connect), read on 6 November, describes endpoint and credential configuration plus additional headers and a credential helper. Direct configuration gives the credential to Claude; a helper also supplies it to Claude. It does not establish Delegatus's response-redaction or credential-specific health guarantees. This documented difference alone prevents treating native configuration as an equivalent replacement under the present privacy requirement.

## Confirmed causes and scope

1. **Delayed content:** `bin/claude-provider-relay.mjs:143–183` retains block start and every delta, joins each kind at block stop, then emits it. This explains the control/relay timing difference. Network delivery and the upstream fixture are eliminated as causes in that comparison.
2. **Lost diagnostic detail:** `:70–79` drains every upstream error body and substitutes a fixed message. Status classification is already useful and must stay. Restore only bounded, sanitized diagnostic fields.
3. **Uncancelled upstream:** `:196–213` handles incoming request errors and upstream errors, but has no downstream-close cancellation connection. `close()` closes local connections without explicitly owning the associated upstream requests. The disconnected-client probe demonstrates the first omission; shutdown needs a dedicated regression before repair acceptance.
4. **Bound gaps:** `:107–189` limits the pending line and accumulated delta text, while completed lines remain in `eventLines` until a blank separator and block starts remain in a map. Those stores have no aggregate event/active-block limit. `Transform.push()` results are ignored while processing an input chunk. These are source-backed limits to address in the same replacement; this stage did not measure a memory plateau or prove all slow-consumer behavior.

## Credential threat model and option decision

The protected data are the selected provider token, private custom-header values and per-relay alias. The intended upstream is the configured origin plus its path prefix. The protected outputs are Claude's launch arguments/environment, model-visible response content, native transcripts, Delegatus logs and public/API projections. Error output is part of the same boundary.

| Surface / owner | Present protection and residual exposure |
| --- | --- |
| Account storage | `.provider-token`, `.provider-headers` and `.provider-runtime` are private files. The runtime record includes credential values. Private file modes protect against other Unix users; the same-user launcher fixture read them successfully. |
| Viewer/runtime host/launcher | These trusted processes read the real credential. Structured launch preparation temporarily carries it in its internal environment before replacing it with the relay alias at model-process spawn. |
| Claude process and tools | Ordinary launch receives the alias and loopback endpoint. `withAgentConfigSandbox` redirects application state, while deliberately retaining the selected account home. It creates no OS credential isolation. An agent allowed filesystem/process access may deliberately recover same-user credentials. |
| Upstream | Relay overrides bearer authorization, removes the incoming API-key header, inserts configured private/session headers and constrains routing. It does not follow redirects. The upstream necessarily receives the real credential and may reflect it. |
| Responses | Existing redaction acts before Claude can persist content. Preserve known-secret matching across network chunks and logical delta fragments, including escaped tool-input strings. Arbitrary encryption, encodings beyond the supported JSON spellings, and collusion with a hostile same-user process remain outside this guarantee. |
| Public projections and retained transcripts | Existing account projection and retained-secret redaction remain secondary protection. They do not undo a credential already delivered to Claude. No raw upstream body or header dump may become a diagnostic. |

**Decision:** keeping the real credential out of the ordinary Claude launch environment and removing reflected known credentials before Claude receives them are required compatibility guarantees for this repair. This does not claim a malicious-agent sandbox. Direct native transport simplifies protocol ownership, but changes both guarantees and needs a different approved threat boundary. The selected relay retains credential injection, route restriction, incremental redaction and bounded failure handling only.

`providerSecretRedaction.ts` was read in full before considering reuse. Its retained-secret writer creates the redaction key and fingerprint store; its readers enumerate account homes and read durable records synchronously. It returns withheld output on damaged retained records. Importing that machinery into every streamed delta would add cross-account state reads and different failure behavior. Keep it unchanged. The relay already has its own selected-account secret set and needs no new store, cache or framework.

## Exact implementation files and contract

| File | Allowed implementation work |
| --- | --- |
| `bin/claude-provider-relay.mjs` | Replace block-delta arrays and join-at-stop logic; bound event parsing and redaction state; sanitize useful error fields; propagate downstream cancellation and relay shutdown to owned upstream I/O. Keep the exported interface unchanged. |
| `src/lib/runtime/claudeProviderRelay.test.ts` | Extend the existing real local HTTP fixtures with delayed delivery, logical-content equivalence, hostile split encodings, bounded buffering, backpressure, errors, EOF, cancellation and shutdown. Existing assertions that expect coalesced deltas must compare reconstructed content and event order instead. Preserve their privacy coverage. |
| `src/lib/accounts/claudeProvider.test.ts` | Add only integration assertions for the copied launcher/shared relay, account-specific error health, credential revision and fresh/resumed/headless routing. Use the existing production account/builders and fixture-only observations. |

Keep these product files byte-for-byte unless a new reproduction demonstrates a required change and the owner coordinates it: `bin/claude-provider-launch.mjs`, `bin/claude-provider-health.mjs`, `src/lib/runtime/claudeProviderRelay.ts`, `src/lib/runtime/claudeStreamBrokerHost.ts`, `src/lib/runtime/structuredSpawn.ts`, `src/lib/runtime/agentConfigSandbox.ts`, `src/lib/accounts/claude.ts`, `src/lib/accounts/manager.ts`, `src/lib/accounts/headlessSelection.ts`, `src/lib/accounts/spawnHealth.ts`, `src/lib/accounts/providerSecretRedaction.ts`, `src/lib/agent/cli.ts`, `src/lib/agent/headless.ts` and `src/lib/agent/spawnPolicy.ts`. Keep UI, schema, runtime-host, workflow, model/provider settings and billing code outside this change.

### Incremental response rules

- Parse UTF-8 incrementally and frame SSE using its blank-line delimiter, retaining multi-line data and non-data fields. Apply the existing 8 MiB bound to the **whole current event**, including completed lines and metadata. Keep the bounded 8 MiB non-stream JSON path; no claim of incremental non-stream JSON parsing is made.
- Emit safe block metadata promptly. For each logical text/thinking/signature/tool-input channel, retain only the suffix that could still complete a known secret, plus incomplete escape/UTF-8 state. Emit every proven-safe prefix immediately. Holding an unconditional longest-secret-sized tail is insufficient: it could withhold an entire short ordinary delta. Initial block text feeds the same channel as later text deltas.
- Recognize raw, JSON-escaped, slash-escaped and Unicode-escaped secret spans across delta boundaries. Tool-input strings require escape-aware lexical state after the outer SSE JSON is decoded; decoding every individual `partial_json` as a complete JSON document is invalid. Preserve nonmatching raw spans, JSON structure, keys and numeric values. A secret matched as a JSON number becomes a redacted string, as in the existing JSON behavior. Bound incomplete numeric tokens to the existing event budget and refuse overflow instead of storing the entire tool document. Add exhaustive split-position tests before replacing the old full-document scrub.
- Preserve index, event sequence, reconstructed Unicode/text/tool JSON/thinking/signature values and unrelated fields. Delta fragmentation may change. Do not regroup thinking and signature events. Keep a bounded pending-output queue when an unresolved suffix prevents ordered emission; cap it at 8 MiB and 64 events, and active block indices at 64. Bound violations produce an explicit sanitized stream failure. These are proposed implementation bounds, not measured current guarantees. Safe opaque signatures remain byte-equivalent; a reflected credential in a signature fails the stream rather than returning a modified signature as valid.
- Pause reading when downstream backpressure prevents writing. Resume only on drain, with cancellation also resolving the wait. Keep one request-owned cleanup path for downstream abort/close, upstream failure, parser failure and relay shutdown. Cleanup destroys that request's upstream request/response/filter; shutdown cancels every request owned by this relay. It creates no global process monitor or retry.
- Flush safe remaining suffixes before their terminal event. An incomplete event/block, malformed tool JSON or premature Messages termination must fail observably. Once HTTP headers have been sent, preserve sanitized provider SSE errors and terminate on transport/parser failure; never append a success event or attempt a second HTTP status. Distinguish a Messages stream from other admitted `/v1/` event streams before requiring `message_stop`.
- For HTTP errors, read at most 64 KiB before parsing a JSON diagnostic. Retain the status-derived classification and a sanitized `error.message` of at most 2,048 characters. Scrub before truncation. Accept Retry-After only as a bounded numeric value or valid HTTP date, and run known-secret checks on that output too. Oversized, malformed or non-JSON bodies receive a stable diagnostic naming the failure class, without body excerpts. Keep redirects refused and response headers allowlisted. Connection failure before headers returns a sanitized 502 JSON error; interrupted streaming remains an incomplete response.
- Keep Messages health tied to the existing credential revision. Authentication denial records error; a catalog read never changes it. Parser failures, bounded refusals and interrupted streams must not become authenticated merely because a local error response finished. Record successful Messages evidence only after a successfully validated Messages response completes; do not change the health-file format.

The only persistent write in this path remains the existing credential-revision health record. Error diagnostics and transient redaction state introduce no logs or durable body storage.

## Producers, copies and consumers to preserve

`claudeAccountEnvironment` loads the atomic private runtime record. `claudeStructuredHostOptions` carries selected account/model information into fresh/resumed hosts; `ClaudeStreamBrokerHost` revalidates runtime values, starts the shared relay and substitutes its alias before native spawn. Ordinary terminal commands come from `freshSpecFor` / `resumeSpecForSession`; `reviewerCommand` uses the private launcher for headless work. `claudeProviderLauncherPath` copies the same three `.mjs` files into the account's `.llv` directory. The launcher validates sidecars against the runtime record and disables ordinary settings sources. Child-agent selection re-enters the account/builders path and must retain the intended account under competing account fixtures.

No saved-account migration is required because storage and the relay interface stay unchanged. Existing copied launchers refresh through their existing copy path on later launches. Already running relays keep their old in-memory implementation until their normal lifecycle ends. This stage authorizes no restart or rewrite of installed helper copies.

## Acceptance and per-file verification

Every file runs separately through the stage-provided `gate-slot.sh`, with fresh logs and isolated HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR, a closed Viewer control URL and scratch-export cwd. Preserve the original stage TMPDIR. Use direct foreground execution for this lane; do not use recordings, custody handoffs or native check waits. The designated wrapper remains authoritative. Do not alter gate/resource settings to obtain a result.

```sh
bash "$GATE" bun run test src/lib/runtime/claudeProviderRelay.test.ts
bash "$GATE" bun run test src/lib/accounts/claudeProvider.test.ts
```

1. On the captured base, a real delayed stream's first ordinary text delta must fail the before-block-stop assertion. The repaired head must pass; message-start bytes alone do not count. Record upstream-write, first-content and stop times for both paths under identical pauses.
2. Reconstruct exact safe content for text, Unicode byte splits, partial tool JSON, initial text, thinking and signatures. Test secrets split at every boundary, overlapping secrets, escaped keys/values/numbers, literal Unicode escapes, marker collisions and ordering around non-content events. Inspect parsed output and raw bytes. Nothing matching the fixture credentials may reach the consumer, logs or stderr.
3. Stream blocks larger than the old 8 MiB total without growing per-block state with response length. Separately test over-limit individual events, multi-line events, metadata-only events, open-block counts and malformed input. Use a paused downstream and verify upstream consumption stalls, then resumes. Record retained queue/parser bounds and peak memory on repeated identical controlled workloads; omit performance claims if a reliable measurement is unavailable.
4. Exercise 401/403, 429, 5xx, numeric/date Retry-After, malformed/oversized error bodies, connection refusal, partial connection failure, clean early EOF and in-band SSE error. Require actionable sanitized classification and honest incomplete outcomes. Use an ephemeral port bound by the fixture and closed immediately before the connection-refusal case.
5. Cancel after headers and after a content delta; call relay close while requests are active. Observe upstream socket closure within the fixture's one-second bound and no subsequent chunks/health-success write. Stop only fixture-owned objects/processes. Repeat a successful request afterwards to prove one malformed client did not kill the relay.
6. Through existing production account/builders and the actual copied launcher, verify fresh/resume/terminal/headless model and path-prefix/custom/session-header selection, competing account B, child-account selection, poisoned project settings, OAuth unchanged, private files intact and secret-free arguments/projections. Verify Messages denial survives a public model-list success and credential revision changes invalidate old health.
7. Keep the existing provider fresh/adopted/OAuth control in `src/lib/runtime/claudeStreamBrokerHost.test.ts` as an integration check. If that file needs new fixtures, coordinate its actual hunks first and add it explicitly to the builder's changed-file scope. Do not run its directory or the broad runtime suite.
8. Run the retained real native-CLI fixture on an egress-closed runner before claiming installed CLI protocol compatibility. A synthetic launcher client proves launcher behavior only. Real-provider compatibility and installation remain separate later acceptance work requiring their own authority.

Only the relay test file was executed in this diagnostic stage. Account/host checks above are implementation obligations. The implementation's `bin/**` change also activates publication's scoped runtime/native gates. Preserve project hooks and required CI (`privacy-publication`, `privacy-tracker-audit`, `runtime-gate`, `typecheck`); do not run broad build/typecheck campaigns in this read-only stage. Keep the lane's three review rounds for runtime/security behavior and its existing fix budget. Source merge never completes installed acceptance.

## Overlap and conflicts

The initial 23 open PRs were checked by actual file patches. No open PR changed the relay or launcher. The final list added #3728 and #3729; their file records contain only the separate #3698 and #3695 design documents. Historical [#2926](https://github.com/Latand/delegatus/pull/2926), head `9ba35560`, touches broker spawn/signal ownership, which stays on the keep-list. Its existence grants no whole-broker reservation.

The adjacent Console owner `fad13420` / lane `a70ebdac`, [#3696](https://github.com/Latand/delegatus/pull/3696), has a clean local and published head `c5f755b0` containing `docs/design/claude-console-launch.md`. Its complete plan was read. It owns profile discovery, selection and host authentication; its unresolved original launch `219efebd` is preserved. No retry, takeover or budget reset is proposed.

Registered worktrees were checked for committed, staged and unstaged changes in the relay/launcher/account/broker paths. Closed lane `458db22c` has a broker allowlist addition for the evidence-directory variable, outside this repair. Closed lane `665a9861` has staged deletions across the checkout, including these files; these are retained unrelated work, with publication disabled. They were inspected and left untouched. Neither is evidence that this lane may restore, replay or publish those changes. The assigned worktree began clean.

Recheck main, the issue/comments, Console head and these actual hunks before implementation and before final review. A newly overlapping relay writer requires source coordination before editing. Auth/launch changes remain with their owner. No conflict resolution, branch operation or board mutation was performed here.

## Deferred — not currently justified

Direct native transport under a relaxed credential boundary; a general gateway/relay library; new account/auth/profile or billing logic; persistent stream stores; global monitoring; protocol feature expansion; UI work; replay of uncertain launches; changes to existing owners, budgets or settings; paid provider calls; live credential inspection; deployment, hotpatching and restart. A native-fixture environment repair belongs to an appropriate isolated runner, with no system configuration changes from this stage.

## Final validation of this brief

The originating requirement is served by simplifying the retained relay to its demonstrated privacy responsibilities while restoring incremental content, useful sanitized errors and cancellation. The source cause and scope are established independently of a current native-CLI model call. The unavailable native comparison is an explicit implementation-acceptance gap, with a safe next observation, and does not justify weakening the current credential guarantee.

The final recheck at 21:09:26 UTC on 6 November found main unchanged at `423bf964`, the issue body unchanged with zero comments, Console head unchanged at `c5f755b0`, and the same committed/staged/unstaged overlap inventory. The two newly opened documentation PRs do not change this scope.

This stage writes only this document. Publication privacy uses `bun scripts/privacy-publication-gate.ts --repository "$CHECKOUT" --require-known-values --paths docs/design/issue-3647-diagnosis.md`, with the committed fingerprint file selected, from the scratch export. Its final result and source/issue/overlap recheck are retained in stage evidence. No product edit, staging, commit, push, account change, live message or production action is part of this result.
