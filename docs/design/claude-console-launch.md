> «Что там не так с Клодом сейчас, у нас на API должно работать на главном, ну, как это, на главном клоде.»
> «Хорошо, ты в курсе, что ты должен быть проактивным, вообще-то, или нет?»
>
> Origin: operator requirements supplied with this task, 2026-11-05.

# Claude Console launches

**Conclusion:** reuse native Claude Code Console OAuth through the existing structured CLI transport. Delegatus has discovery, admission and environment gaps plus a subscription-only host check. A new provider adapter, relay or API key is unnecessary. This document specifies the backend slice; it delivers no product fix or monetary balance.

## Evidence and limits

Inspected revision: `bccb9f1888ceb33f41a1d9fffe77ddbb6d6a7b8e`. The eight audited catalog/admission/host/fence files are byte-identical to the installed `aeded361adde` release source. The earlier auditor identified that release as serving. This stage inspected source on disk; it made no fresh serving-process attestation or provider call.

The earlier billing audit's 15:42–15:50 UTC messages and private handoff were read. Files were rechecked at **16:54:21 UTC**, with identity comparisons at **16:57:35 UTC**: active native profile is Console `user_oauth`, created by Claude Code; access and refresh credentials exist, access is unexpired, inference scope exists and admin scope does not. Profile and credential organization/workspace agree. Ordinary CLI metadata says prepaid and matches the profile organization and credential email. The legacy per-home subscription metadata names another organization; its credentials contain unrelated MCP data and no subscription OAuth. Values and credentials are intentionally omitted. Current Delegatus active routing and running-process credentials were not re-read.

The pinned incident record puts the capacity refusal at **14:45Z**, before the **15:17Z** API-switch discussion. It cannot establish a failed post-switch launch. Likewise, local credentials prove configuration, without proving a paid request succeeded or funds remain.

[Official authentication guidance](https://code.claude.com/docs/en/authentication#sign-in-without-an-api-key), checked 2026-11-05, supports keyless Console login since 2.1.242. It creates a `user_oauth` profile outside `CLAUDE_CONFIG_DIR`. Named profiles outrank subscription login; an implicit user OAuth profile ranks below working subscription credentials. Console OAuth is distinct from subscription OAuth. Separate CLI homes alone cannot isolate Console profiles. [Profile storage](https://platform.claude.com/docs/en/manage-claude/wif-reference#profile-configuration-file) defines config, credentials and active-profile files. [Programmatic CLI guidance](https://code.claude.com/docs/en/headless) supports `-p` with structured output; bare mode excludes profile credentials. Retain the existing non-bare transport.

Installed Claude Code **2.1.318** was inspected as package metadata and embedded source, without executing it. Its profile-directory resolver checks `ANTHROPIC_CONFIG_DIR`, then `XDG_CONFIG_HOME/anthropic`, then the home config directory. For a profile with no key override, its auth-status code yields `loggedIn: true`, generic `authMethod: oauth_token`, first-party provider, and no subscription type. Its stream initialization obtains `apiKeySource` from the API-key resolver: a keyless profile can emit `none`. These are source-derived envelopes, not captured live replies; `none` cannot prove subscription identity.

## Actual path and reproduced defects

| Consumer | Observed source at inspected revision |
| --- | --- |
| Discovery | `claudeCredentials.ts:59–68` accepts any object as a present file credential; `claude.ts:317–321` turns that into `authPresent`. MCP-only data can appear authenticated, while a profile-only login with no file appears absent. |
| Selection | `manager.ts:147–186,622–710` supplies catalog and durable quota to project selection. `headlessSelection.ts:33–45` already ages old percentages to unknown after five minutes. Fresh subscription observations have no funding-source distinction. |
| Fresh admission | `manager.ts:261` calls `selectHealthyClaudeAccount`; `spawnHealth.ts:294–303,345–378` considers subscription metadata or explicit provider accounts. `claudeOauth.ts:49–60` never reads native profiles. Console is skipped before its health probe. With a healthy competitor, the requested Console account can be replaced. |
| Identity fence | `accountMutation.ts:445–465` covers per-home credentials/provider files and credential content. It covers neither native profile selection nor profile credential revisions. |
| Host construction | `structuredSpawn.ts:2095–2107,2163–2199,2290–2298` builds the same options for fresh/resumed hosts. Legacy metadata/MCP state uses the **parent** CLI metadata file; managed metadata uses the per-home file. |
| Process consumption | `claudeStreamBrokerHost.ts:474–498` drops native profile selectors; `agentConfigSandbox.ts:104–124` replaces `XDG_CONFIG_HOME`. Therefore the implicit profile directory changes. `claudeStreamBrokerHost.ts:896–899` rejects generic profile OAuth before model-process spawn. Its `:1588–1589` initialization guard checks API-key source, without identifying the account. |

Four diagnostic cases passed in a fresh tracked export, extending existing test files there. They used production catalog/selection/options/parser functions with fake model streams or a forbidden model spawn. A local auth-status fixture emitted the source-derived envelope above.

| File / isolated result | Observation |
| --- | --- |
| `src/lib/accounts/headlessSelection.test.ts` — 1 pass, exit 0 | Production catalog with MCP-only credentials: old 100% observation → available; fresh wrong-source 100% → exhausted; absent home credential → unavailable. |
| `src/lib/accounts/spawnHealth.test.ts` — 1 pass, exit 0 | Valid synthetic native profile, Console candidate alone → `NoHealthyClaudeAccountError`, zero probes; add subscription account B immediately before selection → B selected, requested admission absent. This exposes an identity failure. |
| `src/lib/runtime/claudeStreamBrokerHost.test.ts` — 2 pass, exit 0 | Real builder retains selected home and uses parent legacy metadata; child environment drops explicit profile selectors and sandboxes the root. Real parser receives profile OAuth envelope; host rejects before model-process spawn. |

Each file ran separately with private `HOME`, `XDG_CONFIG_HOME`, `TMPDIR`, `LLV_STATE_DIR`, closed `LLV_VIEWER_CONTROL_URL`, and `LLV_GATE_RUNNER=off`. Exact runner form, from the scratch export:

```sh
bash "$GATE" --record "$TMPDIR/selection.log" bun run test src/lib/accounts/headlessSelection.test.ts --test-name-pattern 'Console audit:'
bash "$GATE" --record "$TMPDIR/health.log" bun run test src/lib/accounts/spawnHealth.test.ts --test-name-pattern 'Console audit:'
bash "$GATE" --record "$TMPDIR/host.log" bun run test src/lib/runtime/claudeStreamBrokerHost.test.ts --test-name-pattern 'Console audit:'
```

`GATE` was the stage-provided installed wrapper at release `aeded361adde`. Each recording received one `wait_for_check`; all returned terminal exit 0. These green diagnostics assert current failures; they do not certify Console launch support.

## Smallest integration and identity contract

1. **Resolve one launch source.** Extend the existing credential module with one bounded local source resolver, shared by admission and host construction. Return subscription, Console profile, provider, or an explicit unavailable/unsupported reason; keep private source identity and revision alongside the chosen account. For this Console slice, accept only the existing first-party `user_oauth` profile with inference scope, readable private regular credential file, matching organization/workspace, and valid expiry. Associate it with the legacy account using its canonical parent CLI metadata. Ignore the obsolete per-home subscription organization for that association. Managed homes must never acquire the global profile merely because their subscription is missing. Ambiguous identity, unsupported source or expiry gives an actionable refusal without fallback to another billed account.
2. **Use that source before quota and health selection.** Prepare it asynchronously at launch admission, outside account mutation leases, and pass the prepared input into synchronous selection. Carry it through `AccountContext` and host options; re-resolve on process reconstruction. For validated Console, subscription percentages, subscription auth failures and subscription retry dates are inapplicable, including fresh readings. Preserve unknown API capacity; do not translate unknown funds into exhaustion or claim available money. Skip subscription usage/refresh probes for Console. Keep subscription probing, consent and provider behavior intact. Keep a named `ClaudeLaunchAuth` preparation record, including configured-at time, account, source revision and refusal reason even when no quota sample exists; the host consumes that same record. No new accounting store is required.
3. **Pin the native source at consumption.** Keep the agent state sandbox; put only the selected, validated profile directory/name into the Claude process environment after its allowlist. Never forward ambient selectors globally. Revalidate account identity plus profile/config/credential revisions after asynchronous waits, immediately before auth-probe consumption and the final spawn inside `agentSignalSandbox.spawnManagedEngine`. Preserve existing account claim/receipt ownership. A replacement yields retryable admission-changed without creating a terminal receipt or selecting B. Have `claudeCliAuthStatus` retain `apiProvider`; permit generic profile OAuth only with that validated Console source and first-party provider evidence. Retain the keyless `apiKeySource: none` stream guard; reject unexpected key/provider sources with an explicit source-mismatch reason. Do not relabel every `oauth_token` as Console.

Producer/consumer coverage for the prepared source: `manager.ts` direct, project and headless resolution; project selection and its migration capacity path; pipeline engine selection/quota/reset/recovery ports; flow, workflow, relay and memory-model launch adapters; seat auth/quota recovery; `structuredSpawn.ts` fresh/resume; `startup.ts` adoption; migration provider host construction. Inventory found these callers through symbol searches. Defaults and copies must preserve the selected source or return a clear unsupported-source reason; existing subscription-only and Cloud paths keep their contract. No synchronous provider/file refresh belongs in a pipeline tick. Source preparation is bounded to selected candidates under one deadline; a missing prepared source cannot authorize Console. Historical parked lanes remain parked until a selective seat retry.

## Overlap and direct acceptance tests

The protected billing worktree's actual diff and new resolver were read at its unchanged `bccb9f18` head. It adds `ClaudeBilling`, projection/list/status/refresh and UI handling; it makes no admission/host repair. Its reader uses home-based global profile lookup and per-home metadata for every account. The native CLI's XDG precedence and the legacy parent's metadata are concrete integration differences. Its public `billing.mode` must never authorize a launch. Share only a sanitized projection of the canonical launch-source result, preserving null balance/cost. Leave its uncommitted files and AccountsPanel/settings design untouched.

Required direct tests for implementation:

- `claudeCredentials.test.ts`, `claude.test.ts`: production catalog inputs; profile-only and MCP-only cases; correct legacy metadata; config/credential organization, workspace and account mismatch; unsafe/expired/malformed sources; managed account B never borrows A. No secrets in projection or diagnostics.
- `projectSelection.test.ts`, `headlessSelection.test.ts`, `spawnHealth.test.ts`: prepared Console with fresh/stale 100% subscription samples and no sample; no subscription probe/refresh; exact account retained with competing B. Preserve subscription tiers, bindings, exclusions, pin/preference semantics and Codex credit guards.
- Existing `structuredSpawn` and `claudeStreamBrokerHost` test files: actual options builders for fresh/resume/adoption/migration; forward every option into the real adapter. Install competing B immediately before each selection, reservation, auth probe and final spawn consumer. Assert A's identity/claim remains valid and B survives untouched. Replace selected profile/credential with B at each fence and require admission-changed before dispatch. Use original-envelope fixtures; label synthetic/source-derived envelopes honestly. Remove the final production identity expectation in a scratch mutation control and require the identity test to fail.
- `subscriptionApiConsent.test.ts` and relevant existing limits tests: consent-off still causes zero direct subscription API calls; Console recognition performs no `/usage`, inference or refresh request. Unsupported mode/version produces a source-specific actionable reason, never false subscription quota/auth failure.

Implementation remains high risk: three independent read-only review rounds and a fix loop belong to the seat's declared stages. Run directly touched files separately under isolated owned runners. Before any build, cold-typecheck a fresh tracked export; before any push, run the real publication gate and required CI (`privacy-publication`, `privacy-tracker-audit`, `runtime-gate`, `typecheck`). This document-only stage runs no typecheck, build, browser campaign or broad suite. The seat owns controlled deployment and selective live validation afterwards.

## Deferred — not currently justified

Exact money balance, cost reporting rights, UI redesign, new provider credentials, direct subscription-token reuse, generalized federation support, Cloud Console support, automatic queue resumption, runtime/auth/account/settings mutation and deployment. No inference, cost, performance or running-process authentication claim is made. The originating request is served by repairing existing native Console launch recognition while preserving account ownership and selective use.
