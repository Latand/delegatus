# Privacy-safe publication

Every pull request runs `privacy-publication` from the default branch through
`pull_request_target`. The job checks out trusted scanner, test, workflow, and
fingerprint files separately, then handles the pull-request checkout as opaque
inspection input. Candidate code is never executed. The scan covers committed,
staged, unstaged, and untracked changes relative to the exact base SHA.
Diagnostics expose finding classes and counts. Matched values, OCR text,
metadata values, and file paths remain suppressed.

Run the same check locally:

```sh
bun run privacy:check
```

The gate requires Tesseract plus FFmpeg and FFprobe. CI installs English and
Ukrainian OCR data and configures `eng+ukr`; operators can set
`LLV_PRIVACY_OCR_LANGUAGES` to another Tesseract language expression. Missing
tools, missing language data, failed inspection, and malformed configuration
fail closed.

Text inspection applies bounded fixed-point decoding to nested percent encoding
and the complete GFM HTML5 named-entity table. It normalizes CommonMark escapes,
emphasis delimiters, and zero-width separators, then inspects Markdown
destinations, HTML attributes, credential-bearing forms, URI authentication,
authorization headers, bare fine-grained GitHub PATs, and split token shapes.
Fine-grained PAT detection also covers nested encoding and separator-split
prefixes. Text-like files remain inspectable with NUL bytes or UTF-16 encoding.
Unsupported binary inputs fail closed. Publication inputs and supporting files
with symlinks in any path component are rejected before their targets are read.

Email detection exempts a single ASCII instance label (including systemd hex
escapes) followed by one of the systemd unit types `.service`,
`.socket`, `.scope`, `.slice`, `.timer`, `.mount`, `.automount`, `.path`,
`.device`, and `.swap`. These suffixes are not delegated TLDs; template unit
names and cgroup paths therefore name no mailbox. `.target` remains reportable
because [IANA delegates it as a TLD](https://www.iana.org/domains/root/db/target.html).
This rule also applies to commit messages and merge-boundary identities. The
suffix must end the text or be followed immediately by ASCII whitespace,
`/`, `"`, `'`, a backtick, `)`, `]`, `,`, `;`, or `:`. Every other following
character disqualifies the exemption, including dots, hyphens and all
non-ASCII characters. Extra domain components and delegated TLDs remain
reportable. Original text and a decoded view preserving zero-width characters
are checked alongside canonical text so decoding cannot create an accepted
unit boundary. A Markdown projection keeps the accepted source boundary of
the same unchanged unit before a sentence-ending period; a complete domain
continuation remains reportable. Quoted mailbox local parts remain reportable;
they are not systemd names and can contain a real address.

Media dispatch recognizes PNG, JPEG, GIF, BMP, TIFF, WebP, ISO-BMFF, AVI, and
Matroska signatures before applying the declared-extension fallback. Renamed
media therefore receives the same OCR, container, and provenance checks.
Raster inspection covers pixels and metadata. PNG inspection validates chunk
CRCs and scans `tEXt`, compressed `zTXt` and `iTXt`, `eXIf`, UTF-oriented
metadata strings, and bytes after `IEND`. Live-capture classification runs over
every decoded PNG metadata channel. APNG animation controls produce
`inspection_error` until multi-frame PNG sampling is supported. GIF and video
inspection scans container metadata plus five representative frames from every
video stream. Frame-count sampling keeps that coverage when duration metadata
is unavailable. Missing duration and frame count, malformed stream inventories,
and excessive stream counts produce `inspection_error`.

## Commit surface and merge boundary

`--check-commits` reads the branch commit messages, which publish the moment
the branch is pushed, and the identities git recorded on those commits. The
second is what a squash merge publishes: the forge writes a new message for the
commit that lands on the default branch and lifts every branch author and
committer into a `Co-authored-by:` trailer of its own, so an address on no
message at all can reach the public history. The check runs on the pull request,
before the merge composes that commit.

An identity publishes nobody when its address sits on the forge's
`users.noreply.github.com` host, or when it is one of the machine-attribution
mailboxes the trailer rule already exempts. The forge issues a no-reply address
so that an account's own address is not what its commits carry, and the handle
on it is already public on the pull request, so the composed trailer discloses
nothing the contribution has not. Every other identity is a person and produces
`email_address`, exactly as an address in a file does, with a `merge_boundary:`
line naming the commit, the field and the trailer. The address stays suppressed
there like every other matched value: `git show -s <commit>` names it to whoever
is fixing it.

That reading of the no-reply host belongs to the identity path alone. An address
on it written into a commit message — as a trailer by hand, or anywhere in the
body — is an account handle in text and stays reportable, because the exemption
for written trailers is the local part being exactly `noreply` or `no-reply`,
plus the forge's own `support` role mailbox.

## Known-value fingerprints

CI reads the committed
[`scripts/privacy-known-value-fingerprints.json`](../scripts/privacy-known-value-fingerprints.json)
catalog and passes `--require-known-values`. A missing, empty, or malformed
catalog produces `configuration_error`. The workflow has no dependency on an
Actions secret for this coverage.

Catalog entries contain normalized lengths and SHA-256 fingerprints. Entries
without `exactOnly: true` retain compact matching after NFKC, lowercase, markup,
and separator normalization. Catalog schema version 1 and existing entries
remain supported.

A per-value `exactOnly: true` entry hashes the NFKC, case-folded value with
separators preserved. It matches same-length contiguous windows of decoded
source text after the gate's existing percent/entity decoding and Unicode
normalization. It applies across every inspected context, including resource
strings, HTML attributes, commit messages, composed merge identity names, metadata and OCR output. Spaces,
hyphens and other separators interrupt the match; the flag never exempts a
context containing the contiguous value. Markdown projection cannot join split
spellings for this policy. Generic credential, address and resource checks
continue to run independently.

Keep raw private labels in the ignored `.privacy-known-values` operator file.
Legacy lines contain one value each. A value requiring exact matching uses a
JSON line with `value` and `exactOnly: true`; unflagged JSON entries also work.
For an invented compound, the line shape is:

```json
{"value":"freshwater","exactOnly":true}
```

Opt into JSON lines with the generator's `--json-lines` option and, for the
gate's raw file/environment input, `LLV_PRIVACY_KNOWN_VALUES_FORMAT=jsonl`.
The default `plain` mode preserves every legacy line, including JSON-looking
labels. JSON-lines mode also accepts legacy lines alongside policy entries.
Invalid formats and policy types fail closed. If the same value is configured with
both policies, compact coverage remains active. Refresh the committed
fingerprints after updating the private input:

```sh
bun run privacy:fingerprints -- \
  --json-lines --input .privacy-known-values \
  --output scripts/privacy-known-value-fingerprints.json
```

The generator emits a status and count. Raw labels stay out of its diagnostics
and the generated catalog. Preserve per-value policy in the private input so
regeneration retains it.

The committed catalog is the source of truth for the `exactOnly` policy added
in #2391. Its entry was selected by fingerprint because the original raw input
was generated elsewhere and is unavailable locally. Before the next regeneration
from a raw file, add `exactOnly: true` to that value's JSON line and use
`--json-lines`, as shown above. Never copy the raw value into public evidence.
Regenerating from an unmarked line removes the flag and restores compact
matching. Review the generated catalog diff before committing: retain each
existing `exactOnly: true` entry unless its policy change was explicitly approved.

## Approved public values

The `approvedPublicCatalog` fingerprint allowlist in
[`scripts/privacy-publication-gate.ts`](../scripts/privacy-publication-gate.ts)
is reviewed public data. Only an explicit operator approval permits an entry;
the PR adding or changing an entry must quote that approval and explain the
purpose, exact matching rule, and checks with their results.

The operator approved publishing the Celestia relay on 2026-10-01 at 20:00:
«селестія - дозволяю». At 20:30 the operator requested completion:
«це б доробит». The three sanctioned forms are the bare relay hostname,
its HTTPS origin and its discovery URL at `/.well-known/delegatus-relay.json`.
They are stored as raw lengths and SHA-256 fingerprints with `raw-utf8-v1`
identity normalization. This preserves exact case-sensitive matching without
publishing the literals in source, tests or documentation. Tests assemble the
forms from separate pieces at runtime.

The exemption requires an exact case-sensitive sanctioned spelling in raw text,
before percent/entity/JSON decoding, NFKC, case folding, or Markdown projection.
The preceding character must be start of text, ASCII whitespace (space, tab,
newline, carriage return, vertical tab, form feed), or one of `"`, `'`, backtick,
`(`, `[`, `=`, `:`. The following character must be end of text, ASCII whitespace,
or one of `"`, `'`, backtick, `)`, `]`, `,`, `;`. A trailing slash is not sanctioned.
Every other adjacent character withholds the exemption, including NUL, Unicode
spaces, zero-width characters, a dot, hyphen, letter, percent escape or entity.

Quotes and balanced wrappers retain their raw outer boundaries; quoting a
fragment cannot conceal an adjacent Unicode or encoded continuation. Call and
index envelopes retain their callees across whitespace, default-ignorable code
points and source comments.
These bytes stay inside the raw envelope; its outer boundaries remain strict.
A separator inside that span cannot conceal the raw character before the callee. Source
operand checks and decoded inspection views can revoke a raw-approved candidate
when it belongs to an extended email, host, URI or concatenated expression.
They cannot grant an exemption to a spelling or boundary introduced by decoding.
The former NFKC whitespace-preservation workaround is removed: Unicode
neighbours are rejected before normalization. JSON escapes still receive an
additional inspection view, and other privacy rules still read the original.

The same masking runs for all inspected text, including code, tests, JSON,
commit messages, composed merge identity names, metadata and OCR. Both the committed fingerprint catalog and
private lists supplied through `LLV_PRIVACY_KNOWN_VALUES*` use that masked
known-value input. The catalog stays intact: the bare base domain, private
email addresses and other subdomains still match. Other privacy rules inspect
the complete original text, so an approved occurrence cannot exempt credentials,
email addresses, identifiers or private paths around it. Diagnostics continue
to suppress matched values.

Hosted checks execute the trusted gate from the default branch. A policy-change
PR must pass both that gate and its own candidate gate with the committed
known-value catalog and commit checking. Fingerprints keep the sanctioned
literals out of every published file, so the trusted policy can inspect this
change before the new exemption reaches the default branch.

## Authenticated GitHub publication audit

The `privacy-tracker-audit` workflow audits the event's issue or pull request
through GitHub's authenticated API. Coverage includes issue and pull-request
titles and bodies, issue comments, inline review comments, review bodies,
inline and reference-style Markdown images, HTML image/video/source attributes,
every `srcset` candidate, and raw GitHub media URLs. Rendered media nodes remain
auditable when their URLs have no file extension. Media references use the same
bounded canonical representation as text scanning. Relative, root-relative,
and scheme-relative references resolve from a fixed repository base before the
trusted-host policy runs.

`pull_request_target` events check out the default branch, so the token-bearing
audit always executes trusted code. The checkout excludes persisted Git
credentials. API requests use the automatic read-only `github.token`. Media
downloads accept a fixed GitHub host allowlist, apply redirect and size limits,
and send authorization only to the API origin and `github.com`. Missing auth,
untrusted media origins, API failures, and unsupported media types fail closed.

An operator can run the same audit with `GITHUB_TOKEN` or `GH_TOKEN` already set:

```sh
bun run privacy:github-audit -- --repo OWNER/REPO --number 456
```

## Media provenance

Every changed raster, GIF, or video needs a co-located
`privacy-manifest.json` using schema version 2. Each asset entry binds:

- an allowed classification and source class;
- the exact SHA-256 digest of the published bytes;
- one or more SHA-256 source digests;
- a deterministic generator path and generator version;
- the pinned generator runtime;
- the exact SHA-256 digest of the generator bytes; and
- a useful evidence description.

The gate verifies canonical regular-file paths for manifests and generators,
validates every digest, confirms the declared generator version and exact
supported runtime exist in the bound generator, and requires source digests to
differ from the published output digest. Normal provenance maps the candidate
generator path to the default-branch checkout, requires the trusted generator
digest, and executes those trusted bytes once in an isolated temporary root.
The candidate entry must exactly match the reproduced manifest, source digests,
and output digest. Unsupported generators and reproduction failures produce
`provenance_invalid`.

The normal classifications are `synthetic` and `redacted-placeholder`.
`adversarial-synthetic` is reserved for documented fixture directories. Its
manifest declares the exact synthetic finding classes expected from the
fixture. Finding suppression requires an identical asset entry at the supplied
trusted base revision. Candidate-created exemptions and any checksum, class,
source, version, or generator mismatch fail provenance validation.

## Redacted evidence placeholders

Issue #448 replaces confirmed live-state captures with deterministic raster
placeholders generated by:

```sh
bun run privacy:placeholders
```

Generation requires Bun 1.3.3, the version pinned in both privacy workflows.
The generator fails closed when a different runtime is active.

Each placeholder keeps its path, viewport dimensions, comparison name, and a
synthetic layout skeleton. Generation derives its visual variant from the
original source digest, generator version, and output path. Repeated generation
reproduces identical PNG bytes and manifest bindings.

## Issue #448 remediation record

Two redacted records document the wider audit and cleanup:

- [`docs/acceptance/issue-448/tracker-remediation-inventory.md`](acceptance/issue-448/tracker-remediation-inventory.md)
  lists every sanitized issue, comment, and pull-request body by surface and
  exposure class while omitting private values.
- [`docs/acceptance/issue-448/historical-retention.md`](acceptance/issue-448/historical-retention.md)
  records reachability through ancestor blobs and GitHub edit history, along
  with the operator-owned options for fuller removal. Shared history changes
  require an explicit decision.
