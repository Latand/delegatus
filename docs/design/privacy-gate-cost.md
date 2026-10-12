> «запускай розбір, чому перевірки приватності їдять 4 ядра. їх точно треба оптимізувати, не треба там такх перевірок, мільон регулярок походу»

Origin: operator, 2026-10-12 approximately 12:35Z, pinned task specification.

# Privacy gate CPU cost and change plan

Two changes to the existing plaintext matching path reached the requested 5× CPU reduction in a scratch export, with the full hook configuration and fresh scanner processes. The builder should implement those changes and prove corpus equivalence before enabling them. Every detection family stays in place.

## Baseline and measurement method

The measured branch commit is `0846ab8fbdbcdccb60ee5d08c3989ccb87f83893`. It includes #2774, commit `e8e0992d98e1bf17805369f248e0450849a28084`. The scanner, canonical decoder and text preparation have no subsequent changes between #2774 and this head. All source anchors below refer to this head.

The realistic publication input is the existing historical lane `2703f64dfca51141de9ed1b195a94c2e99f06f36..8fb84d9275e97c9051999ed5016678f6508629f7`: 9 commits, 11 selected text files, 125,094 bytes. Its detached input snapshot is 14 commits behind the measured main head. The scanner runs from an export of this branch; input files and Git objects come from that lane. No pipeline branch, index, commit or production state was changed. The pre-commit measurement supplies the same selected paths through the hook's explicit-path API. The pre-push measurement uses the real changed-path, commit-message and merge-boundary APIs. This measures the privacy step, excluding unrelated whitespace, lint, types and test steps.

The hook has more configuration than its two mandatory variables. Agent launches inherit `LLV_PRIVACY_KNOWN_VALUES_FILE`; controller publication supplies it too (`src/lib/memory/roleStore.ts:634`, `src/lib/pipelines/git.ts:2032`). I read that file without invoking its writer and froze a private snapshot at **2026-10-12 13:31:06Z**. It contained 922 eligible strings, 153,844 characters and 35 strings containing non-ASCII characters. Twenty-eight produce non-ASCII compact fingerprints across 26 lengths. With the committed catalog, the scanner hashes 33 length groups. The catalog alone contains 10 entries, six compact length groups and one exact group. The private strings, their fingerprints and their source paths are absent from this document.

Both mandatory hook variables were present: `LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE` selected the committed catalog, and `LLV_PRIVACY_OCR_LANGUAGES` was `eng+ukr`. The full-hook measurements additionally used the frozen inherited plaintext file. Clearing that third input produces a useful control and substantially understates the cost of an agent's actual hook.

All heavy measurements ran through `scripts/gate-slot.sh`, with its admission settings unchanged. Timers started after admission. Individual scanner children had a 60-second bound; complete real scans here took under four seconds. Tests used explicit file paths, isolated HOME, XDG, TMPDIR and `LLV_STATE_DIR` under the temporary root, `CLAUDE_CODE_TMPDIR` in that sandbox, and `LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1`. Fixture runs excluded inherited Git configuration and identity variables. Bun was **1.4.0**. Frozen installation installed 481 packages in this worktree; `bun.lock` remained byte-identical.

CPU-seconds in the entry-point tables are the change in the owned command's kernel cgroup `usage_usec`, including scanner threads, Git children and small supervisor overhead. Wall time excludes the slot wait. Function probes in a separate export used nested `process.cpuUsage()` intervals and counted digest calls. Detector intervals include their allocations and GC; nested intervals are removed or combined explicitly. Instrumented full-hook totals were within 2% of the uninstrumented runs. The earlier published measurements in [privacy scanning performance](../verification/privacy-scanning-performance.md) are context; the tables here use my own runs.

## Cost per entry point

| Entry point / privacy step | Input and cadence | CPU-s | Wall-s | Result |
| --- | --- | ---: | ---: | --- |
| Pre-commit, full hook configuration | Whole contents of the 11 selected paths; once per nonempty staged selection | 3.732 | 3.424 | PASS |
| Pre-push, full hook configuration | Changed paths, working/index/untracked changes, 9 branch messages and their merge-boundary identities; once per push, including an empty file diff | 3.850 | 3.561 | PASS |
| Pre-commit, catalog-only control, two fresh processes | Same files, inherited plaintext omitted | 0.554–0.560 | 0.502–0.505 | PASS |
| Pre-push, catalog-only control, two fresh processes | Same files and commits, inherited plaintext omitted | 0.595–0.650 | 0.592–0.594 | PASS |
| Gate startup / empty selection control | No publication files, base equals input HEAD; still performs repository discovery and four selection queries | 0.064 | 0.055 | PASS |
| Main privacy corpus, explicit test file | 642 tests with synthetic repositories, text, messages, identities and media; local touched-test selection or an explicit stage check | 89.820 | 60.600 | 625 pass; 17 environment failures |
| Canonical decoder test file | Decoder and offset reference comparisons | 0.280 | 0.332 | PASS |
| Fingerprint-window test file | Digest, boundary and eviction reference comparisons | 4.025 | 3.993 | PASS |
| Large-file test file | Real CLI over a synthetic file larger than 2 MB | 11.915 | 11.001 | PASS |
| Workflow test file | Trusted/candidate ordering and provisioning contracts | 0.358 | 0.700 | PASS |
| Engine history-repair predicate | Exact `publicationTextSafe` body, 320 real message-paragraph calls / 21,100 characters | 0.143 total | 0.133 | Completed; 0.445 ms CPU per call |

The engine predicate measurement exercises its exact extracted function, excluding history mutation and orchestration. It is invoked for restored messages and identities during history reconciliation (`src/lib/pipelines/git.ts:1118`); it is outside this lane's edit scope. Normal stage settlement uses `git commit` and therefore the same pre-commit hook (`:695`). Normal engine publication uses `git push` and therefore the same pre-push hook. There is no additional unconditional whole-tree privacy CLI in these paths.

Test CPU counters were read in the actual owned test scope at `afterAll`, after assertions and the corpus's serial fixture cleanup; remaining global teardown is excluded. Wall time includes the caller's launch and return.

The 17 corpus failures were two Bun-1.3.3 source-bound generator cases and fifteen cases requiring unavailable Tesseract tooling. The proper isolated corpus run unset the inherited private configuration and Git guard variables. Its own test process consumed 13.818 CPU-seconds; descendants and supervision consumed the remaining 76.002. This is a measured failing-environment cost, not a green corpus certificate. The builder must provision the workflow's Bun 1.3.3 and OCR dependencies and run the complete corpus.

The hooks plan their privacy step in `scripts/local-gate.ts:45`, discover files at `:592`, inject configuration at `:623`, and launch privacy without the step's heavy-work wrapper at `:652`. Local self-tests are selected when the corresponding files are touched; they do not run on every ordinary push. `scripts/privacy-test-process.ts:5` allows up to four CLI children inside the suite.

Other executable consumers share these same detectors:

- `bun run privacy:check` is the pre-push-style CLI, including untracked and unstaged input. A stage running it adds another complete scan.
- `scripts/merge-batch.ts:993` runs a pinned trusted scanner through the gate; publication separately scans the candidate and its PR body at `:1024`. Its scan cost follows the selected bytes and configuration above; export/setup adds work outside this scanner measurement.
- `.github/workflows/privacy-publication.yml:157` runs one trusted self-test suite, one trusted changed-surface/message/identity scan, then one candidate suite. The trusted suite has a three-minute limit and warning behavior; the candidate suite has its separate 130-second limit and remains last. These hosted invocations were read from code; no hosted run was started or awaited.
- `scripts/privacy-github-audit.ts:418` validates configuration, scans fetched publication text at `:490` and downloaded media at `:534`. Network fetching and real OCR were not measured. `scripts/capture-readme-media.ts` also calls the shared inspectors on its generated input. Neither adds an unconditional local hook scan.

There is no whole-tree text pass in the measured hooks. They select changed files and read their whole contents. Vendor-tree hashing and media provenance are conditional on selected inputs; this text lane triggered neither.

## Concurrent lanes and invocation frequency

I sampled privacy Bun processes every five seconds from **12:54:48Z to 12:56:50Z**, 25 samples over 121.960 seconds, before the full-hook benchmark. Parent ancestry distinguishes hooks from other CLI calls. Counts are lower bounds: a process that starts and exits between samples is missed, as is its final CPU interval.

| Observed caller | Mean concurrent processes | Maximum | Starts after first sample | Observed CPU-s |
| --- | ---: | ---: | ---: | ---: |
| Pre-commit hook | 1.80 | 3 | 2 | 216.110 |
| Pre-push hook | 1.00 | 1 | 0 | 119.510 |
| Other `--check-commits` CLIs | 2.40 | 3 | 1 | 164.140 |
| Total | 5.20 | Individual maxima are not additive | 3 | 499.760 |

That is **4.10 average cores** in named privacy processes after #2774, consistent with the originating four-core complaint. No self-test runner or self-test child was present in this sample. The unclassified CLI calls cannot safely be assigned to a particular stage or batch engine. The absence of a new pre-push start means its already-running process occupied the whole window. The input sizes, scanner revisions and runtime versions of those other processes were not captured; their CPU is not an extrapolation from the 125 KB lane. The sample is chronologically after the merge of #2774 and does not prove that every running checkout contains it.

## Cost per rule family

These are function-probe CPU-seconds on the full inherited configuration. Each column totals its instrumented owned-command cost. The residual includes process/module startup, Git, file/path checks, reporting and measurement bookkeeping; it is not an independently isolated detector.

| Rule family or phase | Pre-commit CPU-s | Pre-push CPU-s | Work |
| --- | ---: | ---: | --- |
| Known values: compact fingerprint windows | 3.238477 | 3.312795 | Ordinary catalog and non-ASCII plaintext-derived length groups |
| Known values: exact fingerprint windows | 0.071260 | 0.068912 | Exact source-view matching |
| Known values: plaintext matching and plan work | 0.135015 | 0.138615 | Repeated lowercasing / normalization, raw substring searches, plan construction |
| Configuration loading | 0.010530 | 0.012551 | Read/parse private input, normalize and fingerprint values |
| Shared source preparation and public-value ownership | 0.055664 | 0.052500 | Four canonical variants, Markdown/HTML projections, compact views, raw approval graph |
| Email detection and ownership views | 0.052199 | 0.055963 | Decoded views, raw offsets, mailbox and package/trailer context |
| Credentials | 0.017543 | 0.018271 | Assignment, direct/split token, authorization, URI and input-field shapes |
| Home paths | 0.003624 | 0.004024 | Unix and Windows shapes |
| Private networks | 0.000148 | 0.000149 | Private address ranges |
| Resource identifiers | 0.000142 | 0.000152 | Identifier shape |
| Transcript content | 0.001419 | 0.001134 | Role-labelled text |
| Generic detector bookkeeping | 0.001070 | 0.001166 | Remaining static-detector interval |
| Other CLI overhead / residual | 0.083208 | 0.140678 | Startup, Git, files/paths, reporting and probe overhead |
| Total | **3.670299** | **3.806910** | Instrumented scans; both PASS |

The three largest causes by combined pre-commit plus pre-push cost are:

1. **Fingerprint window hashing and its negative-cache bookkeeping: 6.691444 CPU-seconds across the two scans**, including 3.381707 seconds in pre-push. The pre-push process computed **2,985,365 SHA-256 digests**. Its corresponding catalog-only control computed 483,862. Twenty-six private plaintext length groups add most of the remaining work. The slowest pre-push groups had lengths 180, 141 and 156, costing 0.150, 0.125 and 0.123 seconds respectively; these are lengths and timings, with no fingerprint values disclosed.
2. **Repeated preparation/search of supplied plaintext and plan construction: 0.273630 CPU-seconds across the two scans**. Pre-push prepares 23 distinct text inputs; repeatedly lowercasing 922 configured strings adds up to 21,206 per-text transformations before accounting for plan construction.
3. **CLI work outside the timed detector families: 0.223886 CPU-seconds across the scans**. The empty-input run alone costs 0.064 seconds. Pre-push also starts four Git selection queries and three commit/message/identity queries. This residual is an upper bound on startup/Git/file overhead. Shared text preparation plus email is close behind at 0.216326 seconds across the scans.

An AST count found **193 regex-literal sites and 13 `new RegExp` sites** across the gate, static detectors, canonical decoder and mailbox helper. These are source counts, not a million independent rules. Static detectors have 18 literal sites and two constructors; the split-token constructor executes once per static scan, 23 times in this pre-push. All generic static checks together cost 0.025 seconds. Hoisting those regexes alone cannot reach 5×.

The source does contain a quadratic negative case: HTML stripping with `/<[^>]*>/g` retries from each unmatched opening angle bracket (`sensitiveTextViews`, `:1210`; `markdownEmailView`, `:1537`). Synthetic 4,096- and 8,192-character open-bracket inputs took 4.25 and 18.13 ms. Unclosed square brackets, underscore runs and incomplete mailbox tails completed the 2/4/8 KB probes without evidence of exponential growth. This bounded probe identifies a quadratic case; it does not prove every regex safe on every adversarial input.

## What #2774 already saved

Reverting #2774's scanner/decoder changes in a scratch export, retaining the same runtime and lane, increased the catalog-only pre-push cost from **0.595–0.650 to 1.949 CPU-seconds** and wall time from 0.594 to 1.750 seconds. That is approximately **3.1× less CPU** already, with PASS preserved. This comparison deliberately omits the private plaintext configuration on both sides; it must not be presented as a full-hook before/after.

The prior investigation was recovered through transcript search and its 2026-10-12 05:01Z report: a 900-second subject timeout, repeated whole-string offset comparisons and per-window hasher construction. Current code verifies that #2774 hoisted the offset comparison (`src/lib/privacy/canonicalText.ts:86`), uses Bun's static SHA-256 API and reuses negative windows/blocks (`scripts/privacy-publication-gate.ts:1232`). Prepared text and configuration-specific match caches also avoid repeated in-process work. Their lifetimes end with each CLI. The remaining costly path is the ASCII-only eligibility restriction at `:1281`: supplied non-ASCII plaintext still becomes an opaque sliding-window search.

## Measured change plan for the builder

### 1. Use verified Unicode plaintext in the existing substring plan

Edit `scripts/privacy-publication-gate.ts:1270`, `matchesKnownFingerprint`. Rename the ASCII-specific map to describe its plaintext role. Permit the normalized supplied value when it is well-formed UTF-16 and contains no replacement character. Keep matching it to its configured fingerprint by the existing length, digest and exact/compact policy key. Opaque catalog entries and ineligible plaintext retain the complete current hashing path.

The justification is UTF-8 encoding: for well-formed strings without the replacement character, the encoded bytes cannot be reproduced by a different UTF-16 window through lone-surrogate replacement. Substring lookup therefore covers the same normalized plaintext windows under the collision assumption already used by the ASCII fast path. Values containing the replacement character or lone surrogates must retain hashing because different UTF-16 windows can share replacement bytes. Keep the original source-view, compact-view, approval-boundary and error rules.

**Measured incremental saving:** this single predicate change reduced full-hook pre-commit from 3.732 to 0.781–0.886 CPU-seconds and pre-push from 3.850 to 0.808–0.851. It saves approximately **2.85–3.04 seconds per scan**, but alone falls short of 5×. The committed catalog still requires its seven hashed groups. No private catalog or plaintext contents change.

### 2. Prepare configured needles and fingerprints once per inspector

Edit `scripts/privacy-publication-gate.ts:962`, `:1018`, `:1270` and `:1650`. Build one immutable per-inspector representation after configuration loading. Retain the exact current primary needle, compact needle, exact source needle, fingerprint and matching policy. Reuse these fields in both the primary plaintext lookup and the two fingerprint plans. The ordinary primary lookup currently lowercases without NFKC; the exact lookup performs NFKC first. Preserve that distinction. Reuse fingerprints computed during loading where practical.

**Measured incremental saving over step 1:** approximately **0.10–0.16 CPU-seconds** on this lane. The combined scratch implementation used two fresh processes per mode, with no persistent cache and identical publication/configuration inputs:

| Full inherited hook configuration | Current CPU-s | Combined plan CPU-s | Combined wall-s | Conservative speedup |
| --- | ---: | ---: | ---: | ---: |
| Pre-commit | 3.732 | 0.645–0.730 | 0.558–0.635 | **5.12×** |
| Pre-push | 3.850 | 0.686–0.702 | 0.597–0.628 | **5.49×** |

Conservative speedup divides the uninstrumented baseline by the slower optimized sample. The source export's stdout remained exactly `PRIVACY GATE: PASS` with exit 0 on every lane run. The reduction also holds against the instrumented baseline samples. This is a cold-process improvement; it does not rely on an earlier hook filling a disk cache. Catalog-only runs already cost roughly half a CPU-second and are not expected to gain 5× from optimizing private plaintext they do not contain.

### 3. Remove the demonstrated quadratic HTML retry

In `scripts/privacy-publication-gate.ts`, replace HTML-span discovery in `sensitiveTextViews` and `markdownEmailView` with a forward walk that finds the next closing angle bracket once. Preserve exactly the regex's first-opening/next-closing semantics, all unmatched suffix text, punctuation removal and source-offset mapping. After proving no closer remains, continue email punctuation processing without retrying HTML searches.

**Expected saving:** almost all of the 18 ms observed on the 8 KB pathological case; ordinary-lane saving is at most a few milliseconds and is not needed for the measured 5× result. This step has not been implemented in the export. Compare its output and offsets with the original regex on generated short inputs, then require bounded near-linear growth on larger unmatched markup. Keep the 5× benchmark separate so this fix cannot mask a regression in steps 1–2.

### 4. Add equivalence coverage and record actual implementation measurements

Add a topic test such as `scripts/privacy-known-plaintext.test.ts`; extend `scripts/privacy-fingerprint-windows.test.ts` only where its independent digest/window oracle is needed. Keep the existing corpus intact. Add markup/offset regression coverage for step 3 in a topic test. Update [privacy scanning performance](../verification/privacy-scanning-performance.md) with the implemented head and measurements. These files add verification; they promise no scanner runtime saving.

The scratch comparison already exercised **20 pairs of real CLI invocations**, covering 120 publication-file variants with ASCII, BMP Unicode, astral letters, replacement characters and lone surrogates; ordinary/exact policy; plaintext present/absent; case, entities, percent/JSON escapes, markup, line splits, NULs, short and missing matches. Exit codes, complete finding reports and file/line notices were byte-identical. This supplements the lane PASS comparison; it does not replace the complete existing corpus.

The builder's equivalence gate must prove:

- Original and revised inspectors return identical class sets, aggregate counts, notice locations/order and exit codes on the existing corpus and generated Unicode cases. Include false positives, fail-closed inputs and PASS inputs.
- Opaque fingerprint-only configurations continue to compare against the independent SHA-256 sliding-window oracle, including final windows, surrogate boundaries, NUL/view separators, block crossings and cache eviction.
- Replacement-character and malformed-surrogate aliases take the fallback and retain findings. Plaintext/fingerprint policy disagreement cannot confer a fast-path match or exemption.
- Exact and compact normalization stay distinct; approvals, raw ownership, package/trailer exemptions and per-inspector configuration independence retain their current behavior.
- Missing/invalid private files, malformed catalogs and empty required configuration still fail closed. Every selected publication file and every required branch message/identity remains inspected.
- The shared generic classes agree with the trusted CI inspector. Run the full suite with Bun 1.3.3 and OCR dependencies; preserve trusted/candidate separation, credentials isolation, warning/failure behavior and candidate-last ordering in the workflow. No workflow change is necessary for steps 1–2.

Run each touched test by its explicit path through `scripts/gate-slot.sh` under isolated state. Benchmark both real CLI modes with the two mandatory variables **and the inherited private file**, freezing the latter once and withholding its contents. Keep the same lane and record the implemented commit, CPU, wall time, configuration counts, verdict and complete-report equality. A fivefold claim must name its configuration and cold/warm status.

A reproducible pre-push scanner command after preparing private exports is:

```sh
LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE="$SCANNER/scripts/privacy-known-value-fingerprints.json" \
LLV_PRIVACY_OCR_LANGUAGES=eng+ukr \
LLV_PRIVACY_KNOWN_VALUES_FILE="$PRIVATE_SNAPSHOT" \
bash scripts/gate-slot.sh bun "$SCANNER/scripts/privacy-publication-gate.ts" \
  --repository "$INPUT" --base 2703f64dfca51141de9ed1b195a94c2e99f06f36 \
  --require-known-values --check-commits
```

For pre-commit, use `--base HEAD --require-known-values --paths` followed by the 11 changed paths from that range. Time the command inside the admitted scope. Neither its private configuration nor its export is a publication path.

## Candidates that remove or narrow detection

These candidates are separate from the implementation plan. **None is needed for the measured 5× target; none is authorized by this design.** Costs overlap where they share preparation, so savings cannot be added blindly.

| Candidate | Protection removed or narrowed | Measured cost / saving ceiling on full-hook pre-push | Recommendation |
| --- | --- | --- | --- |
| Drop non-ASCII private plaintext fingerprints | Private strings hidden by normalization or formatting when literal searches miss | About 3 seconds; 26 extra length groups | Reject. Step 1 searches their existing verified plaintext with the same window semantics. |
| Drop all known-value matching or stop requiring its configuration | Account/project/private labels, stored private strings, compact and exact aliases; missing-policy refusal | 3.382 seconds of windows plus 0.139 seconds of matching/plan work and configuration work | Reject. Retain opaque hashes and all required-policy failures. |
| Stop decoding, remove compact/visible views, or reduce fixed-point passes | Encoded, Unicode, escaped and visibly reconstructed sensitive text | Shared preparation/public ownership 0.053 seconds; overlaps email's 0.056 and other checks | Reject. The measured target preserves every view and pass. |
| Simplify mailbox ownership by skipping decoded/markup/raw-offset views or broadening exemptions | Encoded/quoted/IDNA addresses and contextual disguised addresses; strict attribution | 0.056 seconds, including necessary preparation | Reject. No material gain toward the target. |
| Remove split credentials or an entire generic family | Formatted tokens, assignments/auth/URI/input credentials, home paths, private networks, identifiers or transcripts | Split credentials 0.016 seconds; all credentials 0.018; home 0.004; network/identifier each under 0.001; transcript 0.001 | Reject every removal. Combined generic checks cost 0.025 seconds. |
| Read only changed lines, restrict extensions, omit untracked/staged/unstaged input, or trust path/mtime without reading bytes | Existing sensitive content in selected files, cross-line reconstructions, extension-disguised content and changed publication surfaces | Can avoid most of a 3.850-second scan, depending on the omissions | Reject. Whole selected contents and every existing selection source stay covered. |
| Skip branch messages or merge-boundary identities | Published message content and identities later composed into merge attribution | Inclusive scanner-process intervals 0.042 seconds for messages and 0.009 for boundary review, plus Git CPU; overlaps family table | Reject. The range remains `base..HEAD`, including empty-file-diff pushes. |
| Skip media OCR, metadata, signature/encoding validation or provenance | Pixels, compressed metadata, animation streams, disguised files and false synthetic-source claims | No media cost on this text lane; complete real OCR cost unavailable because Tesseract is absent | Reject. A zero text-lane cost provides no case for removal. |
| Drop privacy self-tests from publication | Regression verification of all families | Local ordinary pushes already omit unconditional self-tests. Measured main corpus cost 89.820 CPU-seconds in the limited environment; CI costs not measured | Keep touched tests and both hosted suites. This changes verification protection and offers no saving on this lane's normal hook scans. |

If implemented steps 1–2 fail to reach the target on the agreed full configuration, report those measurements before proposing any of these removals. Any narrower detection remains an operator decision.

## Deferred — not currently justified

- Native SHA batching and its compiler/library/FFI integration. A general native batch took 0.885 / 1.052 CPU-seconds on catalog-only pre-commit/pre-push, slower than the current control. A lower-overhead native variant took 0.395 / 0.489, about 1.4× / 1.2×. Neither reached 5× on that control. Both preserved 100 matcher probes and the lane verdict, but retaining the existing JavaScript path avoids unjustified native build machinery.
- Persistent text-result caching. A scratch cache reduced repeated catalog-only pre-commit to 0.061 CPU-seconds and pre-push to 0.121–0.139; cold fill cost 0.685. It adds invalidation and trust requirements: complete policy/configuration/runtime binding, integrity, bounded storage, safe paths and isolation from candidate-controlled CI writes. Steps 1–2 already reach the full-hook cold-process target, so this cache is unnecessary.
- Git-query consolidation, regex-hoisting sweeps and a scanner daemon. Their small ordinary-lane costs do not justify added parsing, lifecycle or cross-process cache policy in this change.
- Engine history-repair matcher consolidation, pipeline commit/publish changes, CPU admission and `gate-slot.sh` thresholds, approval handling and the orchestrator mandate. They remain the named fences, including #2773 and #2780. Engine and hook invocation accounting above creates no ownership of those migrations.

The originating requirement asks for lower privacy CPU while preserving public-repository protection. The measured cold-process plan achieves that requirement with existing inputs and detectors, and leaves every proposed removal to the operator. This stage edits only this document and installs dependencies; the engine owns its commit.
