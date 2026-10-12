# Privacy scanning performance

The subject range gets a complete verdict inside its 839-second push budget.
The scanner covers every selected file and fingerprint window, and reads every
commit message and merge-boundary identity. Media policy and hosted workflow
policy are unchanged.

Measurements on 2026-10-12 used Bun 1.4.0, isolated repository snapshots and
`scripts/gate-slot.sh`. Timing starts after slot and CPU admission. Both hook
variables were set: `LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE` pointed to the
committed catalog and `LLV_PRIVACY_OCR_LANGUAGES` was `eng+ukr`. The full-range
commands included `--require-known-values --check-commits`.

| Input | Before | After | Verdict |
| --- | ---: | ---: | --- |
| Subject, 9 commits / 26 files / 3.54 MB | 900.19 s timeout (original verifier); reproduced at the 900 s owned deadline | 268.05 s | PASS |
| Control | 28.30 s | 4.01 s | PASS |

The subject was `05d66b736e182b84e22a17888b20d346f6aae8a6..35f99d6603deb0a807e121f468254647e0af6674`.
The control was `2703f64dfca51141de9ed1b195a94c2e99f06f36..8fb84d9275e97c9051999ed5016678f6508629f7`.
The verifier's earlier control measurement was 20.72 s; the table uses this
implementation run's measurements for both control samples.

The first two changes hoist the whole-string offset comparison and use Bun's
static SHA-256 API for fingerprint windows. With those changes alone, a CPU
profile of the 2.09 MB browser test took 324.70 s. Hashing remained the largest
cost. Repeated views and a repeatedly cleared 4,096-window cache caused
redundant hashes. The matcher now caches negative blocks and more negative
windows. The window cache holds at most 262,144 windows and four million
characters; the block cache holds at most sixteen million characters.
Each block owns up to 16,384 starting positions and includes the following
`length - 1` characters. This preserves every separator and block-crossing
window. Only an identical block with a proven negative verdict can be skipped.
Increasing those bounded capacities reduced the browser scan from 311.51 s to
159.98 s, with peak RSS of 929,268 KiB. The unprofiled full-range run is the after
measurement in the table.

`scripts/privacy-large-file.test.ts` builds a synthetic 2,016,010-byte changed
file and a synthetic fingerprint catalog. An accepted package version forces
RAW email ownership preparation across the entire encoded Unicode input.
The final test's Bun 1.3.3 gate run passed in 15.63 s against a 60 s bound.
The same synthetic fixture with the original scanner exceeded that bound and
failed at 60.04 s without a verdict.
That bound leaves 3.8 times the observed runtime for CI variation
and uses less than 8% of the failed push budget.

Equivalence checks compare canonical text and source offsets with a frozen
original decoder, compare sliding-window SHA-256 digests with node crypto,
and compare fingerprint verdicts with exhaustive window hashing. They cover
mapped and unmapped text, escapes, Unicode, lone surrogates, short inputs,
final windows, separator crossings, block crossings and both cache evictions.
All 642 existing gate fixtures pass under the hosted workflow's Bun 1.3.3 with
English and Ukrainian OCR. The privacy media workflow tests and shared static
detector tests pass too.

The complete privacy run passed 647 tests across four test files.
The default-runtime hook comparison reported 150 failures shared with main
and no new failures; the clean fixture environment under the privacy CI pin
passed all existing fixtures.

No production deployment was performed.

## Local gate CPU optimization and negative fingerprint cache

Implementation: `e6b79401237828ef1c2fa31350ea33f6fde4889d`, with the preceding
Unicode/plaintext and markup changes in `d4e6c5e68b7513cea15838059909bc5494deb925`.
The baseline scanner is the unchanged scanner at
`0846ab8fbdbcdccb60ee5d08c3989ccb87f83893`. The design and entry-point/family
profile are in [privacy gate CPU cost](../design/privacy-gate-cost.md).

Known-value needles and fingerprints are prepared once per inspector. Verified
well-formed Unicode plaintext uses the existing substring path; replacement
characters, surrogate aliases and opaque fingerprints retain exhaustive
window hashing. The window matcher compares complete 32-byte SHA-256 digests
through a reusable buffer. A forward markup walk preserves the original spans
and source offsets while avoiding repeated searches through an unclosed suffix.

The optional local Linux cache stores authenticated records of negative opaque
fingerprint scans. Every cache hit binds the exact UTF-16 input, the complete
opaque hash policy and exact/compact mode, scanner/helper file bytes, loaded
code and constants, and Bun version/revision/platform/architecture. Plaintext
matching, generic detectors, file selection, commit messages, merge identities,
media, provenance and configuration failures retain their existing checks.

The cache uses an owner-only directory and 32-byte seal, HMAC-SHA-256 records,
atomic writes and 1,024 fixed slots. Each accepted record is at most 1 KiB and
expires after seven days. Collisions require the complete key and fall back to
scanning. Readers recheck directory/key ownership, permissions, symlinks and
seal contents on every access. Invalid or inaccessible storage causes a full
scan. Unknown files are preserved; cleanup removes only the writer's own
temporary path. The default directory is under the caller's temporary root;
`LLV_PRIVACY_FINGERPRINT_CACHE_DIR` can choose an isolated cache explicitly.
The cache is disabled whenever `CI` is present and on platforms other than
Linux. Hosted trusted scans always run the complete detectors.

### Measurement method

The input is the same realistic lane used by the design:
`2703f64dfca51141de9ed1b195a94c2e99f06f36..8fb84d9275e97c9051999ed5016678f6508629f7`,
9 commits, 11 text files and 125,094 bytes, 14 commits behind the measured base.
Pre-commit supplies those paths through the hook's explicit-path API; pre-push
uses the actual changed-path, message and merge-boundary APIs. These numbers
measure the hooks' privacy steps, excluding lint, whitespace, types and tests.

Seven repetitions per mode run four fresh Bun 1.4.0 processes: original cold,
original repeated input, new cold, new repeated input. Each repetition has a
separate cache directory; only its new cold scan primes its new warm scan.
Both implementations receive the committed fingerprint catalog,
`LLV_PRIVACY_OCR_LANGUAGES=eng+ukr` and the same frozen inherited plaintext
snapshot (922 eligible strings, 153,844 characters). Private values are withheld.
CPU is the admitted owned scope's kernel `usage_usec` delta, including scanner
threads and Git children. Wall time and CPU exclude gate-slot admission.
The table reports medians and names cold and warm cache states explicitly.

| Privacy step | Cache state | Before CPU-s | After CPU-s | Reduction | Before wall-s | After wall-s |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Pre-commit | Cold | 3.776 | 0.816 | 4.63× | 3.502 | 0.741 |
| Pre-commit | Repeated input / warm cache | 4.096 | 0.362 | 11.33× | 3.826 | 0.301 |
| Pre-push | Cold | 4.022 | 0.860 | 4.68× | 3.768 | 0.752 |
| Pre-push | Repeated input / warm cache | 3.967 | 0.414 | 9.58× | 3.658 | 0.337 |

The 5× target is met for repeat local scans with a populated content/policy cache. Cold scans still run every detector; their measured reductions are shown separately and remain below 5× when the corresponding row says so. The warm reduction also exceeds 5× when dividing the smallest baseline sample by the largest revised sample.

### Equivalence and checks

Reference comparisons were added and passed against the original implementation
before enabling its Unicode plaintext replacement. The complete original corpus
passes 642 tests with the workflow's Bun 1.3.3 and English/Ukrainian OCR.
The revised corpus passes 642 tests in local-cache mode and CI mode; 537 real
CLI invocations in each paired corpus run preserve exit codes, complete class
counts and every file/line notice byte for byte. All 56 benchmark CLI reports
are byte-identical too.

The focused files run individually under isolated HOME, XDG, TMPDIR,
`CLAUDE_CODE_TMPDIR`, `LLV_STATE_DIR` and a closed Viewer control port:

- `scripts/privacy-known-plaintext.test.ts` — Unicode, exact/compact policy,
  replacement-byte aliases and configuration independence.
- `scripts/privacy-fingerprint-windows.test.ts` — independent node-crypto
  digests and exhaustive window oracle, full-digest mismatch, exact catalog
  spelling, surrogate/block/separator boundaries and eviction.
- `scripts/privacy-markup.test.ts` — original-regex spans, text and offsets,
  plus bounded CPU growth on unmatched markup.
- `scripts/privacy-fingerprint-cache.test.ts` — fresh readers, complete binding,
  corruption, unsafe storage, CI refusal, bounded collisions, expiry and
  permissions/seal changes after initialization.
- `scripts/privacy-canonical-text.test.ts`, `scripts/privacy-large-file.test.ts`,
  `scripts/privacy-media-workflow.test.ts` and
  `src/lib/privacy/staticDetectors.test.ts`.

All 682 tests pass across the corpus and these eight files. TypeScript, ESLint,
staged whitespace and the manual local privacy CLI with both hook variables
and inherited plaintext pass. The lockfile is unchanged. The existing hosted
workflow retains trusted/candidate separation and candidate-last ordering;
its contract tests pass. Hosted checks were not awaited.

The cold allocation changes alone varied around the 5× target in repeated
measurements. Per-file negative-window reuse, larger local caches, compiled
literal unions and block UTF-8 preparation did not consistently improve both
paths on this input and were left out. The persistent negative cache gives
repeat local scans a clear margin while preserving fresh hosted inspection.
No detection class or publication surface was removed or narrowed.
