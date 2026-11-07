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
