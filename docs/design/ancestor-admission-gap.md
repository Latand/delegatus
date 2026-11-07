> “A cross-account switch stages every ancestor rollout the fork's lineage needs on the target account, or refuses at admission, before the incumbent host is stopped, naming which ancestor is missing. A conversation with any number of fork levels switches the same way a one-level conversation does.”
>
> Originating public requirement: issue #3675, 5 November 2026, [Expected behaviour](https://github.com/Latand/delegatus/issues/3675). The 6 November intake request authorized investigating recent issues; the accepted continuation limits this design to its verified source remainder.

# Missing Codex ancestry at admission

## Decision and evidence boundary

Implement the two reproduced gaps: reject a provably missing ancestor during initial account-switch admission, and retain a privacy-safe reference to that ancestor through the refusal. Preserve the existing staging traversal and successor-before-stop sequence. This document completes source design only. Historical incident causality and installed acceptance remain UNKNOWN.

The complete accepted `docs/audits/recent-issue-remaining-evidence.md` was read from its declared predecessor output, together with its primary final message dated 7 November, 11:07:59 UTC. Current issue body and the complete comments endpoint were read again: open, updated 5 November 06:12:49 UTC, zero comments. Its one-parent description conflicts with current source; it cannot establish the revision involved in the incident.

Assigned source is `d40964608220516dc848a51d3df0e9bc12ba6380`. During this stage main advanced to `8d0239d660c051f0cdd20804d3492e3491c644e3` through the adjacent MCP change. The four proposed production files below are identical across these revisions. The final probe ran against fresh exports of both, without changing production source.

## Ownership and overlap

The current native task explicitly assigns this residual outcome to this lane. Its primary creator message at 7 November 11:18:10 UTC and later confirmation at 11:21:11 UTC agree. All-status, canonical-project searches for `3675`, `3522`, `unsafe-source` and the ancestor term found this task and no competing residual reservation. Completed semantic inventories covered 88 history rows, 69 account rows, 35 switching rows, 35 shared-work rows and nine migration rows. These bounded searches do not establish absence from hidden archives.

Full candidate reads distinguish shared transcript storage (#891/#912/#971), post-deployment switching measurements (#2597/#2572), completed switch recovery (#2914), and completed pipeline continuation preflight (#2935). None reserves this missing-ancestor outcome. Those owners retain their scopes. #3641 retains its separate ownership hold.

Project-scoped and unscoped transcript searches were opened through primary conversation records. Numeric/ancestor memory searches returned no relevant memory. A discarded quoted query was ignored by the tokenizer and supplies no absence evidence.

| Adjacent work | Observed forge head | Relevant difference and boundary |
| --- | --- | --- |
| #3710 | `edb2bf06` | Spawn admission, registry lookup, MCP recovery and pipeline creation. No proposed-file overlap. Its budgets remain owned there. |
| #3728 | `0a763568` | Pipeline source mutation, MCP schema and integration tests. Source-lineage readers remain unchanged here. |
| #3734 | `cfd43840` | MCP health, host observations and queue dispatch origin. Subsequently merged as `8d0239d6`; final probe also passes there. |
| #3663 | `70687206` | Worktree recovery and provisioning. No proposed-file overlap. |
| #3668 | `25783bad` | Integration authority, replay, publication, native dispatch and gate handling. No proposed-file overlap. |

Read the actual downloaded diffs, their file lists and relevant registry/queue/dispatch hunks. Native records also identify successor delivery ownership for #3663 and #3668; the original lane name alone is insufficient. Seven available relevant worktrees had no uncommitted change in the proposed files or migration coordinator/contracts. Some local heads differ from forge heads; both observations are retained, without claiming them equal. No merge-file rehearsal is required for the current disjoint file set. Recheck exact final hunks and owner records before implementation; a newly shared file requires composition and the other owner's relevant tests before proceeding.

## Reproduction

Private evidence is retained under the stage's `LLV_EVIDENCE_DIR`: `ancestor-manifest.json`, `ancestorAdmission.probe.test.ts`, `ancestor-probe-5.log`, and `ancestor-main.log`. Probe SHA-256 is `c7d521f6d83d14b002626225cd77af5ebaf378a9ebba5bce5de31d4367464898`.

Each run used one explicit file through the installed gate wrapper:

```sh
bash "$STAGE_GATE" bun run test src/lib/accounts/migration/ancestorAdmission.probe.test.ts
```

`STAGE_GATE` denotes the wrapper supplied by the stage brief. Run from a fresh tracked-file export under the stage scratch root, with separate HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR, `LLV_GATE_RUNNER=off`, and a closed `LLV_VIEWER_CONTROL_URL`. The logs retain the actual command, runner banner, counts and exit. No recorded-check custody, live service, provider CLI, paid request, account change or production history was used.

The final harness uses production launch-profile builders and registry admission/settlement, then `applyConversationMigration(select-account)` → `dispatchStructuredControl` → real `RuntimeJournal` → `StructuredDeliveryQueue` → `applyStructuredReconfigure` → `advanceConversationMigration` → `RegisteredSuccessorProvider`. Commands and effects pass through unchanged. Real `CodexAppServerClient` requests use the repository's versioned protocol and JSON-RPC envelopes. The local transport supplies the reply shapes already exercised by `codexAppServer.test.ts:334`; this verifies the adapter contract, and makes no claim about a live vendor. Host publication/release/termination are instrumented boundaries. File validation, copying, journals and migration transitions execute normally.

| Case | Observed result on both revisions |
| --- | --- |
| Source → parent → missing root | Initial response 202 with queued receipt. On engagement: account preflight, source-client start, initialize, account/read, thread/fork. A fork and target source copy exist before refusal. |
| Missing-root diagnostic | Raw `unsafe-source`; durable migration `failed-recoverable`; queue receipt `failed`; message `source history failed safety checks`; missing identity absent. |
| Incumbent preservation on missing root | Zero releases, zero termination calls, one generation; target client never starts. |
| Same chain with root present | Initial 202, final applied/committed, two generations. Target resume and both thread reads precede successor publication; committed successor precedes the sole incumbent release and termination call. |
| Existing provider controls | Zero older ancestors, two older ancestors, and a cycle all retain their expected outcomes. |

Final execution: 7 November 11:26:01 UTC on assigned source and 11:26:23 UTC on captured main; each **5 pass, 0 fail, 44 assertions, actual exit 0**. These are characterization assertions that confirm the gaps; implementation acceptance must reverse the missing-chain expectations. Earlier scratch attempts exposed harness-only issues (retired model, omitted terminal-turn port, missing config/read reply); they are retained in the manifest and superseded by the complete runs. No production failure is inferred from those attempts.

## Existing contracts to preserve

- `migration/provider.ts:144`: asynchronous source-root lookup; six directory levels, 20,000 visited entries, symlinks skipped. `readCodexSessionMeta` at 721 reads at most 256 KiB. Metadata accepts nonempty strings; it does not establish that arbitrary text is safe to echo.
- `provider.ts:1851`: staging loop checks identity at every copied hop, rejects cycles, allows at most 128 copied source ancestors, uses per-ancestor copy identities, and records continuity. Keep this loop's semantics and receipt ordering.
- `safeHistoryCopy.ts:611`: sanitizer returns `{code, message}`; the coordinator at 1257 persists both. Structured reconfigure at 403 propagates the message; the queue stores its failure reason. Existing `target-history-unreadable` and uncertain-fork handling remain distinct.
- `structuredControls.ts:423–568`: normalizes the account pick, carries forward a waiting pick into later profile changes, builds a generation-bound command, and submits it to the runtime journal. A same-account withdrawal must remain available even when history is incomplete.
- `structuredReconfigure.ts:245`: execution preflight currently checks target authorization/authentication. It precedes reseat and held-send transfer, but has no ancestry check. Migration completion at 387–415 gates predecessor release.

Other producers include automatic reseat in `delivery.ts:199`, account-credit recovery, pipeline reseat, explicit reseat/retry in `conversationCommand.ts`, and controller reconciliation. They converge through the coordinator into `RegisteredSuccessorProvider.create`. Its default provider is constructed in the coordinator/controller and structured executor; injected test providers and the legacy copy adapter retain their existing contracts. Runtime journal payloads, migration schemas, continuity receipts, copied launch permissions and target-selection defaults need no new fields.

## Smallest implementation

### 1. A bounded read-only Codex preflight beside the current provider

Add a Codex-specific source-check function in `migration/provider.ts`, using registered source ownership, `validateHistorySource`, `readCodexSessionMeta` and the existing lineage lookup. Start from the captured generation ID/path, validate each file and metadata identity, and follow parent IDs with a visited set and the existing 128-ancestor limit. Yield between hops; directory enumeration stays asynchronous. The helper writes no history, journal or receipt and starts no client. Keep it local to this domain; the copy traversal continues to validate the actual staged bytes independently.

Only a completed search of the permitted root can establish absence. A scan-entry limit, pruned depth, unreadable directory, unsafe file, malformed metadata or identity mismatch must retain a bounded safety/unverified refusal; none may become a definite missing-ancestor claim. Do not widen roots, follow symlinks or search retired accounts. No cache, global index, whole-registry inventory, retry loop or background scan is justified. Work is bounded by the existing per-hop limits; no performance improvement is claimed. Instrument the operation with its existing correlation and elapsed time, without logging paths.

The existing copy-only check is too late for initial admission. Moving the staging loop into admission would write history before the runtime command is accepted and entangle copy receipts with a new lifecycle. The additive read-only check costs extra bounded metadata reads; it keeps those durable contracts intact.

### 2. One safe missing-ancestor error

In `migration/safeHistoryCopy.ts`, add a typed missing-ancestor failure and explicit sanitizer branch. Recommended code: `source-ancestor-missing`. Its public reference is the full SHA-256 digest of the exact missing native ID, with a fixed prefix and optional numeric hop. Construct the fixed message from those allowlisted fields only, for example `source ancestor <reference> is missing`. Retain the same safe reference in the error detail so admission, queue and migration diagnostics correlate. This names the failed link without exposing transcript paths, account identifiers or arbitrary metadata. Tests compare the reference against the known fixture ID and distinguish two different missing ancestors.

Do not echo the metadata string or raw filesystem/vendor exception. Sanitize structured admission explicitly, since its general catch currently returns `error.message`. Preserve generic safety failures, `target-history-unreadable`, and `codex-fork-outcome-unknown` semantics. The existing string code/message storage needs no schema change.

### 3. Check at admission and recheck at execution

In `runtime/structuredControls.ts`, run the read-only check after determining the effective account pick, including a carried waiting pick, and before `client.command` or account-choice attribution. Apply only to a Codex move between accounts. Return a normal conflict refusal with the safe code/message when the required ancestor is missing. Same-account withdrawal, profile-only changes with no carried move, Claude and Copilot retain current behavior. Use a lazy provider import if necessary to avoid a new initialization cycle.

In `runtime/structuredReconfigure.ts`, repeat preflight for a queued Codex account move before target authentication, reseat, held-send transfer or provider effects. This covers history removed after admission and already-persisted commands. In `RegisteredSuccessorProvider.create`, perform the same source check before provider setup/forking, covering automatic reseat, direct coordinator calls and recovery that bypass the browser command path. Retain the existing copy-time walk to catch filesystem changes after preflight. Do not claim a read-only check can freeze files against later external deletion.

Every new await invalidates a previously captured admission decision. Re-read the named conversation/generation, source ownership and target intent, and synchronously check the relevant claim owner, claim epoch and host writer epoch at the immediately following effect boundary. At execution, retain operation/revision cancellation and pipeline authorization checks, including a synchronous check inside the registry write callback. An earlier awaited ownership answer cannot authorize a later effect. Preserve existing target selection and unknown-outcome recovery; never select a replacement target while retrying this operation.

Keep these additions within the four named production files where possible. Coordinator/contracts changes are justified only by a demonstrated inability to carry the required existing authority fence through the provider boundary. Before adding such a contract, enumerate its real producers and adapters and run the race that requires it; extend the existing operation fence narrowly. If that authority contract remains unresolved, stop the extension and report the exact missing contract.

## Implementation acceptance and review

Convert the characterization into regressions in the existing provider, structured-controls and structured-reconfigure test files; sanitizer cases belong in `safeHistoryCopy.test.ts`. Preserve the full production producer chain above and all supplied fields when wrapping a seam. Keep protocol reply envelopes intact. Add coordinator coverage only if its contract changes.

1. With an absent parent or grandparent already missing at selection, initial admission refuses with the specific safe reference. No runtime command, account attribution, provider start/fork, target copy, successor publication or incumbent release/termination occurs. The incumbent profile and generation remain unchanged.
2. A valid chain still admits, resumes with every ancestor present and commits before predecessor release. Assert order through the real coordinator. Preserve exact continuity-path and receipt behavior.
3. Admit a valid pick, remove an ancestor in the isolated fixture before execution, then drive the real queued command. It fails before source-client start and retains ordinary failure/hold semantics. Exercise the provider directly for automatic/recovery bypasses; explicit unknown-fork retry remains unchanged.
4. Retain cycle, wrong metadata ID, unsafe/symlink source, search/depth bounds and 128/129-ancestor boundary controls. Test malformed IDs containing path, newline and secret-shaped material against every new refusal surface; only the digest and fixed reason may leave it. A bound exceeded yields unverified/safety failure rather than a fabricated absence.
5. Replace authority after each asynchronous preflight boundary, and after the subsequent authentication, journal/registry, provider-read and publication waits that separate approval from an effect. Cover owner, generation, operation revision, claim/writer epochs and pipeline permission independently. The displaced attempt must produce no further authorized effect. Remove each final guard in a disposable implementation mutation run and require the corresponding regression to fail. These race/mutation checks are required future acceptance; this design-stage characterization does not claim they passed.
6. Run each affected test file in its own isolated gate command, with fresh logs and actual exit. Compare any red result with the same captured main. Do not run a full suite, typecheck or build from this design stage. Normal required publication hooks/privacy gates and three independent runtime-risk review rounds remain mandatory in the later authorized stages.

No component or layout change is planned. If diagnostic presentation requires a rendered change, use the existing conversation driver and both shipped locales/themes, with the complete reason visible; do not introduce a capture driver for this issue.

## Deferred — not currently justified

- Replacing the full staging traversal, changing successor-before-stop ordering, relaxing bounds or permissions, or adopting UNKNOWN outcomes.
- Shared transcript storage, removal of copy/fork migration, #3641 alias repair, MCP/source-lineage changes, checkout recovery, publication/gate-budget changes and other owners' remaining work.
- Explaining the historical incident. It still needs the original running revision, ancestry/root inventory, provider/operation receipt and stop/commit envelope. Current source cannot reconstruct these facts.
- Installed acceptance, timing measurements, live switches, deployment, cleanup and provider canaries. They retain separate owners and permissions.
- New generic ancestry infrastructure, a persistent preflight cache, speculative schema fields, or an ADR for these reversible local changes.

Final document checks: the project privacy-publication gate with required known-value fingerprints passed (exit 0); whitespace check emitted no diagnostics. Final issue/comment and main reads remained unchanged. Worktree status contains only this declared document. No source, index, branch, commit, forge, board or production mutation was performed.

The requirement is served by early, attributable refusal plus preservation of the verified successful path. This stage changes only this design document; source implementation and its acceptance remain owed.


## Implementation verification

The source repair now runs the same bounded, read-only Codex preflight at effective account selection, queued execution, and provider creation. A confirmed absent ancestor returns `source-ancestor-missing` and the full SHA-256 reference of its native ID. Incomplete scans, unsafe metadata and ownership changes retain safety refusals. Initial refusal precedes runtime command submission, attribution, provider startup and copying. Same-account withdrawal remains available.

The original staging traversal, continuity receipts, permissions and successful successor-before-stop ordering remain in place. The reproduced cancellation race required a narrow optional synchronous assertion on the existing provider contract: source generation, claim owner/epoch, writer epoch, operation/revision and pipeline authorization are rechecked at provider, copy, publication, registry commit and predecessor-release boundaries. The real client carries the assertion locally across launch preparation and resume fallback; it never sends that callback to the provider. Existing late-artifact receipt reconciliation remains intact.

`src/lib/accounts/migration/ancestorAdmission.test.ts` drives selection through the real journal, queue, reconfigure executor, coordinator and provider, with the real Codex JSON-RPC client over a local transport. Its 37 passing cases include hostile missing identifiers on admission, execution and direct-provider paths; carried picks and withdrawal; source/target authentication and resume waits; goal and verification waits; replacement of owner, generation, claim/writer epochs and operation revision; pipeline refusal; and publication, commit and release races. Host publication and termination remain instrumented test boundaries. Installed acceptance is still UNKNOWN.

Each command used `bun run test` with one explicit file, the supplied gate wrapper, a fresh isolated HOME/config/state/temp root and an actual exit record. Final results:

| Test file | Pass / fail | Assertions | Exit |
| --- | --- | --- | --- |
| `src/lib/accounts/migration/ancestorAdmission.test.ts` | 37 / 0 | 394 | 0 |
| `src/lib/runtime/structuredControls.test.ts` | 77 / 0 | 262 | 0 |
| `src/lib/runtime/structuredReconfigure.test.ts` | 41 / 0 | 210 | 0 |
| `src/lib/accounts/codexAppServer.test.ts` | 45 / 0 | 221 | 0 |
| `src/lib/accounts/migration/safeHistoryCopy.test.ts` | 24 / 0 | 109 | 0 |
| `src/lib/accounts/migration/provider.test.ts` | 63 / 2 | 274 | 1 |
| `src/lib/accounts/migration/coordinator.test.ts` | 122 / 2 | 661 | 1 |

The four failures also occur on unchanged main `8d0239d6` under the same isolation. Provider baseline: 50 pass, 2 fail, 252 assertions, exit 1; both failures expect rejection of an owned writable transcript root inside a private home, once per engine. Coordinator baseline: 122 pass, 2 fail, 661 assertions, exit 1; both failures concern legacy held-delivery dispatch timing, including the inventory-sidecar case. They are outside this repair. No new failing assertion remains.

Nine disposable mutation controls each exit 1 with the expected regression: removing admission preflight (7 failures); admission authority (5); execution authority (5); provider authority (11); post-authorization publication authority (1); final registry commit authority (1); final copy publication authority (1); client launch/resume authority (3); predecessor release authority (1). The seven production-chain controls used the 34-case corpus before the three additional goal/verification cases. The restored final corpus passes all 37. Each mutation has its exact substitution, hashes and separate log retained in private evidence; no mutant enters the commit.

The final source export matches all 13 changed source/test files byte for byte. Changed-file lint passes with one existing unused-variable warning in structured controls; whitespace passes. Whole-file publication privacy and normal commit hooks are required before handoff. The remote pull request title/body are separately updated and read back for the implementation.

Final overlap review inspected all 29 open pull requests and found no changed-source file overlap. Main remains `8d0239d6`; the named adjacent diffs and source-lineage ownership remain outside these changes. This bounded search does not establish absence in hidden archives. Historical incident cause remains UNKNOWN. There were no live host/provider effects, deployment, manual push/merge, account or policy changes. Three independent runtime-risk review rounds and pipeline publication remain outstanding.


## First review repair

The first independent review identified two remaining source defects: the migration authority assertion stopped outside runtime adoption, and a refusal after publication could lose the acquired cleanup callback. The follow-up carries source/operation/policy authority and the successor's claim owner, claim epoch and writer epoch into `CodexAppServerHost.adopt`. The optional assertion follows protocol and environment preparation, the socket drain wait, managed spawn and the sandbox exec handoff. Startup RPCs, notifications and hydrated-resume fallback also check it; successful adoption releases this temporary assertion and ordinary host writer authority continues to govern the host.

Publication now records the exact cleanup callback before awaiting ownership. Failed assertions and thrown ownership checks clean that resource. A cleanup failure retains the callback for another cleanup attempt, preserves both errors and the original cause, and cannot be mistaken for an admitted publication. Concurrent callers still await the existing publication and recheck their own assertion before returning.

The new regressions use the real default publisher and runtime adoption, forwarding all production options. The production-chain controls independently replace source and successor claims, epochs, writer epochs, operation revision and pipeline authorization during protocol preparation. Separate host controls revoke authority at publication-environment and Telegram preparation, initial RPC replies, resume fallback and the actual socket drain wait. The unchanged controls reach the same spawn boundary or finish adoption. Native-spawn probes record and refuse before starting a vendor process. Cleanup controls cover success, late revocation, a thrown ownership check and failed cleanup followed by retry.

Shared-contract inventory: the migration provider is the new producer of the optional adoption assertion; startup, structured spawn and structured recovery retain their existing optional-host-options contract. The host forwards it into both direct managed spawn and the socket launch callback. Claude and Copilot managed-spawn callers, the socket fixture and direct sandbox callers omit the new trailing argument and retain their behavior. No serialized command, receipt, traversal, schema, retry budget or controller policy changes.

The final overlap check read the current issue and empty comments, native residual ownership, and actual diffs of #3710, #3728, #3734, #3663 and #3668. Captured main was `c35246e3`. Its MCP host observation hunks are separate from adoption. The older #2926 signal-sandbox PR also touches the host and sandbox files; this repair preserves its launcher, cleanup, signal and budget behavior and adds only the optional assertion. A scratch composition with main retains both sets of tests; the sole textual conflict combines independent test imports. No branch integration or publication was performed here. Hidden archive ownership, historical incident causality and installed acceptance retain their previous UNKNOWN status. The existing three-round review budget and source owner are unchanged.


Final repair checks run one explicit file per isolated gate invocation:

| File | Pass / fail | Assertions | Exit |
| --- | --- | --- | --- |
| `src/lib/accounts/migration/ancestorAdmission.test.ts` | 47 / 0 | 524 | 0 |
| `src/lib/runtime/codexAppServerHost.test.ts` | 324 / 0 | 1738 | 0 |
| `src/lib/accounts/migration/provider.test.ts` | 67 / 2 | 293 | 1 |
| `src/lib/runtime/agentSignalSandbox.test.ts` | 53 / 1 | 402 | 1 |
| `src/lib/accounts/migration/coordinator.test.ts` | 122 / 2 | 661 | 1 |

The two provider assertions also fail on captured main (50 / 2, 252 assertions). The sandbox assertion also fails there (50 / 1, 396 assertions), with the same fixture Git-identity read refusal. All new regressions pass. A separate scratch composition with main passes the complete host file, including that revision's MCP regressions: 367 / 0, 2176 assertions, exit 0.

Four disposable mutations return the expected failures: omitting the provider's adoption assertion fails nine production-chain controls; removing the managed-spawn assertion fails the real socket-drain race; removing the startup RPC assertion fails the hydrated-resume retry control; retaining cleanup only after final approval fails all three new refusal controls and three existing cleanup controls. The RPC mutation initially exposed a test defect: repeated revocation reset the observation count. The corrected regression fixes the count at the first revocation, then detects the extra request. No mutant is committed. Earlier exploratory harness failures remain in private evidence; final exported source/test bytes match the working tree.

The coordinator's two legacy held-delivery timing assertions reproduce on captured main with identical counts (122 / 2, 661 assertions, exit 1). Across the five repair files, 613 tests pass and five existing assertions fail on both sides. The reviewer's identical cleanup invariant probe passes on both base and repaired source (2 / 0, four assertions each): late revocation now retains one publication and exactly one owned cleanup, while returning the refusal on repaired source.

No full typecheck or build was run in this repair stage; the ordinary pipeline publication owns those checks. The check logs, exact mutation patches, composition evidence and source hashes are retained in the stage evidence directory. Historical incident causality and installed acceptance remain open.

Before commit, main advanced to `5995ba0b5a` through #3743. Its three changed files concern pipeline publication receipts and have no source/test hunk overlap with this repair; the compared migration, host and sandbox files remain byte-identical to the captured base. Whole-file publication privacy passed for all repair files.
