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
