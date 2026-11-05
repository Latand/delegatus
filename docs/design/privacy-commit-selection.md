# Local privacy inspection of commit additions

Commit the intended changes, then run `bun run privacy:check`. A normal push
runs the same selection through the pre-push hook. Pre-commit checks whitespace
and lint. Local privacy requires the committed fingerprint catalog and retains
any supplied `LLV_PRIVACY_KNOWN_VALUES_FILE`; malformed or missing required
configuration refuses publication.

This implements slice S1 of
[the accepted audit](../audits/privacy-gate-and-test-cost.md#6-implementation-slices).
The audit's earlier line numbers describe its dated revisions. At the measured
base, `6e8b65d9b`, whole-file selection was `changedPaths` at
`scripts/privacy-publication-gate.ts:1232`, chosen by the CLI at `:2911`;
local planning was `scripts/local-gate.ts:63`. Only #3584 had changed the scanner
since the audit. The narrower selection had not shipped.

## Input boundaries

`--added-lines` reads every commit in the resolved publication range. Each
commit is compared with its first parent, including merge resolutions. Text
inspection receives the new side of each hunk with three context lines. Removed
lines, diff headers and working-tree state are excluded. Newly added files
contribute every line. Git paths are literal and NUL-framed, so pathspec syntax,
newlines and leading dashes cannot change selection. Unreadable input refuses
inspection with redacted diagnostics.

A value outside these hunks can pass locally when the branch did not touch it.
A value in the three context lines still refuses. A value split between an
addition and nearby context remains detectable. Every commit is inspected even
when a later commit removes its content.

Binary attributes, media signatures, control bytes and unsupported UTF-8 select
whole blobs. Their detector results are cached by blob id and media kind;
provenance is checked at every path and commit. A private snapshot supplies that
commit's manifest and generator. Snapshot checkout disables inherited global
Git configuration and hooks. Symbolic links, unsupported data, oversize blobs,
invalid provenance and inspection errors remain refusals. The hook may defer
unavailable OCR tooling to the required hosted check; metadata and provenance
still run. Direct `privacy:check` keeps missing tools decisive.

Messages and merge identities retain their existing readers and detectors.
`--paths` cannot override `--added-lines`. Explicit-path consumers, merge-batch
inspection, PR-text checks and the required hosted `privacy-publication` workflow
retain their existing whole-file behavior. The gate runner shipment scan also
retains its whole-file selection. The workflow is unchanged.

## Measurement

Measurements were taken on 2026-11-05 with Bun 1.4.0 through the project gate
wrapper. Each sample had fresh HOME, configuration, state, temporary directory
and fingerprint cache. A frozen 2,196,161-byte rules file and the committed
catalog were supplied. Inputs were detached snapshots; the scanner and input
repositories were separate. `/usr/bin/time` measured the gate after admission.
The second sample on each side enabled Bun's one-millisecond CPU profiler.
CPU seconds include user and system time. Load is the machine's 1/5/15-minute
average immediately before and after the sample.

The smaller real lane was
`f941d3ee0b53e6757dc14691e73f701621a4956c..3cedb175331c67e654c3a22addba10cc7bf38d2b`:
two commits, ten net changed files, 130,297 whole-file bytes. The expensive lane
was `aeded361adde078d895a7d71dfe2fe64e800c24d..b0db7a5cf7a00ab18fe9018a3d7aebbe5bbd10d2`:
six commits, nineteen net changed files, 7,150,527 whole-file bytes.

Measurement rows are retained in `evidence/privacy-commit-selection.json`.

| Range / selection | Run | CPU s | Wall s | RSS MiB | Load before → after (1/5/15) |
| --- | ---: | ---: | ---: | ---: | --- |
| small / whole-files | 1 | 3.75 | 3.76 | 151.7 | 21.1/26.2/25.6 → 21.4/26.2/25.6 |
| small / whole-files | 2 | 4.01 | 4.05 | 177.3 | 21.4/26.2/25.6 → 21.0/26.0/25.5 |
| small / whole-files | 3 | 3.79 | 4.24 | 154.4 | 51.5/46.8/35.7 → 51.7/46.9/35.8 |
| small / commit-additions | 1 | 2.21 | 3.04 | 117.5 | 51.5/73.8/56.1 → 51.5/73.8/56.1 |
| small / commit-additions | 2 | 2.37 | 4.20 | 123.6 | 51.5/73.8/56.1 → 50.6/73.3/56.0 |
| small / commit-additions | 3 | 2.18 | 3.16 | 119.0 | 50.6/73.3/56.0 → 48.7/72.5/55.9 |
| large / commit-additions | 1 | 9.63 | 10.00 | 151.4 | 30.2/47.2/50.3 → 28.4/46.3/49.9 |
| large / commit-additions | 2 | 9.62 | 10.77 | 189.1 | 28.4/46.3/49.9 → 27.0/45.4/49.6 |
| large / commit-additions | 3 | 6.62 | 6.39 | 156.3 | 27.0/45.4/49.6 → 25.5/44.8/49.4 |

The smaller lane median fell from 3.79 to 2.21 CPU-seconds. The expensive lane
passed all three runs at 6.62–9.63 CPU-seconds, below the sixty-second target.
Shared load varied; the table records it alongside each sample. These timings
cover the local privacy command; other publication checks retain their own cost.

The baseline profile of the smaller lane attributes 67.6% of sampled self time
to the primary and compacted learned-rule substring searches (30.6% and 37.0%).
Native SHA-256 work accounts for 2.4%, Git calls 5.9%, and lowercasing plus compact
normalization 2.1%. The remaining 22.0% includes set/cache work, other text
preparation, detection and startup. These shares use sampled self time; inclusive stack times overlap. They
confirm that repeated learned-rule
searches dominate this real range.

The expensive baseline reached the wrapper's 900-second deadline without a
verdict. Its interrupted scan has no completed CPU/RSS measurement and is kept
separate from completed samples. No speed ratio is inferred from that timeout.
The target is under sixty CPU-seconds for a typical lane; entirely new large
text or binary/media blobs still require proportional inspection and OCR.

To repeat a sample, freeze the rules file and catalog, check out the named input
head in a private clone, and run from a separate scanner export:

```sh
bash scripts/gate-slot.sh /usr/bin/time bun scripts/privacy-publication-gate.ts \
  --repository "$INPUT_REPOSITORY" --base "$BASE_SHA" \
  --require-known-values --check-commits --added-lines
```

Supply the existing rules-file and fingerprint-file environment variables.
For the baseline scanner, omit `--added-lines`. Keep identical input commits,
rules, catalog, runtime and fresh cache conditions; record load with each run.

## Verification and rollout

The new CLI tests cover each content detector, plaintext rules, fingerprints,
messages, identities, three-line context, dirty working trees, literal paths,
merge resolutions and historical binary/media content. They exercise metadata,
OCR, missing and invalid provenance, missing tools and unsupported data.
All twenty independent mutation checks failed the intended assertions. The
new file passes 31 cases; 23 of them fail on the baseline scanner. The existing
privacy suite passes 652 cases with its pinned generator and OCR dependencies.
The local planning and hook files pass 63 and 34 cases. Each file ran directly
in its own isolated command with a fresh log and exit status. The whole-project
typecheck passed through the gate wrapper before commit. Mutation checks
independently remove selection or enforcement and require the corresponding
assertions to fail. The hosted/default whole-file path is checked
beside the local path on the same fixture.

An already running lane picks up this gate after merging the landed main commit
into its checkout and starting a fresh publication attempt. An in-flight scan
has already loaded its scanner and continues with those bytes. No Viewer deploy
is needed: publication executes the scripts in the lane's checkout. Publication
retry and deadline code is unchanged.
