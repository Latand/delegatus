# Security audit low findings

The 2026-10-21 audit findings 6–9 were reconfirmed against main on
2026-10-22. The four implementation files were unchanged between the task
base and main at the time of inspection. None was already fixed.

## 6. Local previews

Before the fix, `src/lib/artifact/localFile.ts:78` admitted the entire home
folder. `src/lib/artifact/classify.ts:55` only restricted filename types.
The new route regression returned 200 for an unrelated home image before
production edits; it now returns 403.

Preview roots come from the persisted project catalog, flow/pipeline/workflow
launch directories, worktree mappings, manually registered projects and the
product-owned stage scratch. A cwd below a linked checkout admits that whole
checkout on the first read. Home and its ancestors never become preview roots,
even when scanner history records a session there. Configured evidence roots retain raster-only
access. Lexical paths, resolved paths and pinned descriptors are checked;
prototype-review and done-media stores retain their separate access fences.

Callers checked: artifact body/download/meta, inline image, report frame and
relative assets, task album path filtering, prototype source publication,
and done-media evidence discovery. Prototype publication retains its own
source/copy authorization; only the path-serving routes gain narrower roots.

Validation: `gate-remote -- bun run test` with explicit paths for
`src/app/api/artifact/route.test.ts`, `src/app/api/image/route.test.ts`,
`src/app/api/artifact/frame/[...rest]/route.test.ts`,
`src/lib/artifact/localFile.test.ts`, `src/lib/taskAlbum/album.test.ts` and
`src/lib/scanner/projectDirectories.test.ts`: 63 passed. Remote gate runs
isolate HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR and use a closed
Viewer control port. No performance improvement is claimed.

## 7. Operator authority

Before the fix, `src/lib/agent/operatorAuthority.ts:176` admitted any caller
that named no conversation. `:125` used Fetch Metadata to attribute browser
activity. A forged same-origin request passed the new negative test before
production edits.

The authority gate now accepts verified member cookies, the existing access
cookie or a separately configured operator token. Browser attribution requires a verified
cookie. Cookie values use the proxy’s encoding, including access keys with reserved characters; malformed values are refused. A keyless solo page navigation automatically sets a separate HttpOnly,
SameSite=Strict session cookie; API calls cannot mint it. The bounded process
session map has eight scopes, a thirty-day lifetime and revocation by eviction
or process restart. Reloading the page establishes the next solo session.
Claiming a team disables solo sessions. Keyed installs use their existing
cookie path. Scripts can present the separately configured
`DELEGATUS_OPERATOR_TOKEN` (legacy `LLV_OPERATOR_TOKEN`) in
`x-llv-operator-token`; the perimeter bearer cannot grant operator authority,
because the gateway injects it. A trusted local gateway navigation, authenticated by its
injected bearer token, also establishes the browser cookie. Solo cookies are
bound to the current access-key generation, so rotation revokes them. The
existing signed MCP service token also retains backend dispatch authority;
designation still refuses a forwarded agent identity, and direct browser
activity still refuses every service tag. Other service tags grant no operator
authority. Structured launch allowlists exclude the optional operator token. Legacy headless and terminal launches and native config/feature probes explicitly remove both access-key and operator-token aliases. Fetch Metadata supplies no authority. On a keyless install,
a local client able to open a permitted page can establish a session too;
this change binds actions to that session and preserves automatic browser entry.

Callers inspected: seat designation, worker limits, bridge, role memory,
onboarding health, project settings, Telegram bot settings, asks-you, memory
settings/source, external relay, self-update, voice transport, voice companion,
key access, subscription consent, seat-tick settings, orchestrator relay,
native queue, runtime HTTP and conversation-host attribution. Direct-activity
consumers (team actor, spawn, deputy asker, prototype review, answer, tasks and
pipelines) inherit the same verified boundary. Rotation retains its separate
attribution contract. The host-allowlist PR and voice-tool authority PR were
read; neither fenced host/origin file was edited.

Validation covers forged metadata, missing/invalid cookies, separate operator
and cookie tokens, token rotation, agent/service refusals, live member sessions
and revocation, automatic solo entry on loopback and configured names,
expiration and a fresh-process refusal. The real worker-limit route refuses an
unauthenticated write and accepts session-authenticated writes. Existing proxy
and team-perimeter tests were also run remotely in isolated state. Browser
fixtures in the bridge, key catalog and compatibility writers, memory,
project/seat settings, Telegram and self-update suites now carry the actual
session cookie. Refusal fixtures remain unauthenticated. The scoped publication
comparator also checks these callers against the task base and retains existing
failures separately from regressions. Five additional credential-inheritance regressions failed before the launcher edits and now pass, including real terminal children with unchanged arguments and stdin.

## 8. Package update provenance

Before the fix, `src/lib/selfUpdate/package.ts:95` installed a registry version
without verifying its build attestation. The new runner test observed an
installer call for an unsigned release before production edits.

The fetch step now verifies the npm SLSA attestation with Sigstore, pins the
issuer and release workflow identity, checks the attested repository and
revision, and compares both the signed SHA-512 subject and registry integrity
to the downloaded archive. Metadata, attestation and archive reads have size
limits, a deadline and refused redirects. The installer receives that local
archive, closing a second registry lookup between verification and install.
Missing provenance, invalid signatures, identity mismatches and changed bytes
refuse before installation. The existing failed-step log carries the reason.

The official Sigstore bundle, trust-root and verifier packages are pinned to
compatible releases supporting the Node versions declared by this package.
The Node child applies the issuer and subject policy directly to the verifier.
Cryptographic verification runs in an owned
Node child with a 45-second limit: the pinned Bun rejected TUF root signatures
that Node verified. The server keeps this dependency external so the child
reads the installed dependency graph. Archive handling remains in the updater.

Callers checked: package registry discovery, automatic/operator/seat update
start, retry, release-pointer publication and the packaged runtime checks.
Checkout and managed deployment runners retain their existing mechanisms.

Validation: 19 package/provenance tests passed remotely. They cover signature
refusal, absent attestation, altered revision/workflow/subject/digest/integrity,
foreign attestation URLs, registry refusal, oversized metadata, archive cleanup
and successful installer/runtime verification with the real Bun installer.
A separate isolated live probe
verified the published 1.15.0 attestation and complete archive through the
production function; it installed nothing. A tampered-signature probe was
refused by the same production function. Verification follows the
[npm provenance model](https://github.com/npm/provenance#verifying-attestations-with-npm-audit-signatures).

## 9. Telemetry opt-outs

Before the fix, `src/lib/telemetry/store.ts:41` recognized only the exact
telemetry value 0 and DO_NOT_TRACK value 1. `sender.ts:45` printed a notice
before checking the environment lock; the settings host displayed both its
automatic notice and settings disclosure while locked off. All eight new
opt-out/notice regressions failed before production edits.

Telemetry values 0, false, off and no now disable telemetry, with case and
surrounding whitespace normalized. Canonical and legacy variables and their
overrides share this decision. DO_NOT_TRACK=1 retains its existing meaning.
Locked-off startup prints no notice and creates no notice marker. The UI
suppresses the notice and disclosure while retaining the disabled switch and
its environment explanation. Stored preferences are retained.

Callers checked: telemetry status and preference API, sender admission before
and after mode discovery, production startup notice, settings host notice and
dialog, and the independent subscription-consent control in that dialog.

Rendered evidence is `evidence/telemetry/opt-outs.json`, generated by the
existing kanban browser driver: 16 states and 80 assertions across EN/UK,
light/dark, desktop/phone and on/off. All 32 page/settings frames were visually
inspected. The record pins the rendered source hashes. CLI notice checks run
in real isolated production-mode children. Four existing Compose-only cases
need Docker, which the remote test server lacks; the publication comparator
checks those failures against the base.
