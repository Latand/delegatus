# Automatic Codex Cloud environments

Cloud stages resolve an environment for the selected Codex subscription account.
The project runtime preference still defaults to local. Enabling Cloud needs no
environment ID. Existing explicit IDs keep their precedence:

1. An account override stored by `codex_cloud_environment`.
2. The legacy project-wide `codexCloudEnvironmentId`.
3. A verified automatic binding for the account, GitHub repository and base ref.

Legacy scalar choices resolve across the canonical project's predecessor keys.
An explicit canonical value wins, including an empty value that clears the
manual choice. Otherwise the first stored value in lexical predecessor-key
order wins. Every project name uses this same precedence without rewriting
the settings file.

`src/lib/projects/codexCloudEnvironments.ts` owns the installation-local SQLite
collection. Settings transfers retain the legacy scalar; automatic bindings and
setup receipts stay local. Reads resolve the canonical project and its alias
predecessors, retaining each binding's original storage key and revision.
Account pages merge indexed predecessor ranges with canonical cursors. Setup
custody and manual choices survive alias registration and process restart.
Manual overrides occupy separate rows and automatic updates use explicit keyed
upserts. Compare-and-set writes return the current override on conflict.

## Provider boundary

`src/lib/pipelines/cloudEnvironmentClient.ts` implements the observed desktop
protocol behind injected authentication, HTTP and WebSocket transports. This is
an undocumented provider interface. It uses the account's native ChatGPT login,
keeps credentials in memory, refuses HTTP redirects, limits JSON responses to
one MiB and owns a 25-second session deadline. Provider bodies never become
persisted failure messages.

Both user and workspace configuration catalogs are read in picker and ordinary
views. Each view follows up to 20 pages of 100 configurations. Repository lookup
uses the desktop's numbered `wham/github/list-repositories` pages, at most 20
pages of 20 repositories, and verifies the result through repository metadata.
An incomplete catalog refuses creation. Repository identity and base ref are
checked even when a configuration supplies a mount path. Display names do not
establish repository ownership. Submission rereads repository metadata and the
base ref before starting a thread, including configurations with a mount path;
a changed configuration stops the requested Cloud stage before model work.

An existing ready configuration is preferred, with private configurations first
and configuration ID breaking ties. A new private configuration contains the
account's repository ID and base ref. Previously verified setup/start scripts
and network policy can supply the project template. Otherwise networking uses
the restricted package-manager preset. Secrets, VPN connections and other
account-specific requirements are excluded.

Creation persists intent before its POST, then checkpoints the configuration,
draft, draft revision and approval-operation identifiers. Approval initiation
reuses the saved idempotency key. Completion follows a successful operation and
is followed by a configuration readiness check. Runtime setup failure remains
decisive even when the operation still says RUNNING. A missing GitHub connector
therefore reports `github_connector_not_configured` explicitly.

A received HTTP 401 or 403 rejection releases only the refused creation or
draft dispatch marker, so preparation can retry after access returns. The
rejection survives process restarts through the existing retry and cooldown
checkpoints. If a peer advances the row revision, the refusal clears its marker
against the latest matching setup receipt under the keyed write lease. A newer
receipt is preserved. Failures of later reads never release an earlier
mutation's marker.

After a lost creation reply, recovery searches verified catalog metadata for
the saved creation intent. It refuses another creation if the outcome remains
uncertain. Draft recovery rereads the saved configuration; approval recovery
reuses its operation or idempotency key. The optional legacy setup reader imports
only recovery identifiers for an account-verified configuration and never writes
to the source directory. A changed authenticated principal retires its old setup
receipt before discovery under the new login. A changed repository or ref on an
automatic configuration retires that configuration's receipts before discovering
or creating a replacement. An explicit manual mismatch remains authoritative.

## Scheduling and execution

The serving release starts one background preparation worker after controller
admission and stops it on demotion. It consumes the completed project catalog,
walks a project/account cursor and dispatches one account at a time. The cursor
is persisted after a pass that reached the provider, so a restarted release
continues from there; a pass that had nothing due writes nothing.
Catalog sorting is refreshed when that catalog changes; account membership is
sampled every 30 seconds. Each scheduling pass considers at most eight project
positions. Preparation failures retry after two and four seconds; three failures
or a setup deadline enter a persisted 15-minute cooldown. Each reconciliation
window has a ten-minute deadline and a three-failure budget. A binding that
ended a window unavailable is terminal for the background worker: time alone
never retries it. After its cooldown, a trigger opens another bounded window
that reuses all setup receipts and the original creation intent. The triggers
are a pipeline stage that asks for that project/account environment, an
operator's environment choice, changed account credential metadata, and the
first look of a newly started release. A trigger that arrives inside the
cooldown stays outstanding and is served once when the cooldown ends. The
first look of a new release spends a single attempt, since releases start
several times a day; the other triggers open a full window. Stage
admission itself still prepares its binding under the same cooldown.

The worker prepares only the repository's default branch, so one binding
decides whether a pair is due: the unresolved-ref binding while the
default-branch lookup is failing, otherwise the default branch's own binding.
Bindings of other refs belong to the stages that prepared them and never make
the pair due. The default branch of each pair is remembered from the last
successful lookup and stored beside the cursor; a pair with no remembered
branch and no recorded failure owes one lookup. A failed lookup has the same
budget as a preparation: a ten-minute window of three failures, two and four
seconds apart, then the cooldown. A changed sign-in or choice opens a new
window, so the pair stays due until its binding is revalidated or that budget
is spent. Pending approval is
scheduled two seconds later. A confirmed terminal FAILED approval clears its
active operation receipt and advances a persisted approval-attempt counter. The
next permitted attempt uses a fresh idempotency key with the same configuration
and draft; a lost initiation reply reuses that attempt's key. Terminal failures
consume the same three-failure budget and cooldown across restarts. A failed
runtime observation with a running or uncertain operation keeps its receipt.
A confirmed terminal failure retires its operation even if runtime status is
missing, malformed or unavailable. Available matching runtime diagnostics can
refine the failure reason; operation identity and caller authority remain required.
Ready bindings are due for background validation
after 24 hours. Stage admission validates its selected binding again.

When a whole walk finds nothing due the worker goes quiet. Every 30 seconds it
compares the project list, the accounts' credential metadata and the bindings
revision with what the walk saw (a change of project or account during a walk
starts that walk's count again), and it walks again when one of them changed,
when the earliest binding timer arrives, when a trigger names a pair, or after
ten minutes (for a changed remote, account pool or legacy project choice).

Network work runs outside storage leases. Every effect rechecks the caller's
selection, account credential-file version, project remote and account eligibility.
Only the current release can write live state. Late mutation replies retain
custody receipts without activating a superseded binding. Principal hashes and
setup receipts stay out of the public readiness projection.

The pipeline selects account/environment pairs, checkpoints the pair before
submission and supplies the principal fingerprint to the hosted client. A
different subscription principal cannot start a thread or turn. A failed Codex
Cloud preparation or connect stops a Cloud-required stage with its reason. Local execution requires an explicit runtime override. Ambiguous
turn submissions retain remote custody. Known tasks retain their frozen account
and environment when later settings change. Publication checks use the frozen
task receipt or the selected account's prepared binding; hooks create no
environments.

## Read and manual override surfaces

`GET /api/projects/cloud-environments` returns a bounded saved-state page without
provider requests. `POST` sets or clears an account override using
`expectedRevision`. The MCP `codex_cloud_environment` tool uses these handlers;
reads accept `after` and `limit`, and writes require `clientRequestId` for durable
receipt replay. The response includes the override revision needed for a later
write. Setting an ID schedules validation and initially reports discovering.

Workspace checks and operator/designated-project-seat authority run on the
server. Actor attribution comes from the request capability. The MCP binding
also rechecks mutation authority before dispatch and receipt replay. Other
project-settings writes retain their operator gate.

The settings response includes saved account readiness for a separate frontend
lane. This change adds no UI. The backend neither authorizes third-party GitHub
connections nor deletes remote environments. A missing prerequisite remains
visible in saved readiness and the pipeline's failure reason.

## Verification

The Cloud transport fixtures remap all provider HTTP to an owned loopback server
and use its WebSocket listener. They never authenticate against the real service.
Coverage includes empty-ID pipeline execution, creation/approval, account
separation, manual precedence, pagination, redaction, interrupted setup across
real process restarts, persisted deadlines, release demotion and SDK MCP calls
through the actual server, tool service, binding, HTTP route and SQLite store.

A configuration's ready version does not establish that a new deferred runtime
has connected to the environment registry. The stage client waits for a confirmed
`environment_offline` connect refusal within its startup retry budget. An
exhausted connect or another registry 409 records `unavailable` against that exact
binding revision, with `environment_offline` or `environment_connect_failed`.
A configuration that disappears after preparation records `environment_missing`.
These outcomes keep their reason across process restarts and never leave the
failed binding ready. See [the runtime contract](cloud-stage-runtime.md#deferred-registry-connect-and-execution-identity).
