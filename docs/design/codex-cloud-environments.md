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
a changed configuration produces a confirmed local fallback before model work.

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
checkpoints. Failures of later reads never release an earlier mutation's marker.

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
uses a persisted project/account cursor and dispatches one account at a time.
Catalog sorting is refreshed when that catalog changes; account membership is
sampled every 30 seconds. Each scheduling pass considers at most eight project
positions. Preparation failures retry after two and four seconds; three failures
or a setup deadline enter a persisted 15-minute cooldown. Each reconciliation
window has a ten-minute deadline and a three-failure budget. After cooldown,
another bounded window reuses all setup receipts and the original creation
intent. Account credential metadata or manual-selection changes permit earlier
revalidation. Pending approval is
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

Network work runs outside storage leases. Every effect rechecks the caller's
selection, account credential-file version, project remote and account eligibility.
Only the current release can write live state. Late mutation replies retain
custody receipts without activating a superseded binding. Principal hashes and
setup receipts stay out of the public readiness projection.

The pipeline selects account/environment pairs, checkpoints the pair before
submission and supplies the principal fingerprint to the hosted client. A
different subscription principal cannot start a thread or turn. Preparation
failures can use the existing durable local-fallback transition once. Ambiguous
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
visible in saved readiness and the pipeline's local-fallback reason.

## Verification

The Cloud transport fixtures remap all provider HTTP to an owned loopback server
and use its WebSocket listener. They never authenticate against the real service.
Coverage includes empty-ID pipeline execution, creation/approval, account
separation, manual precedence, pagination, redaction, interrupted setup across
real process restarts, persisted deadlines, release demotion and SDK MCP calls
through the actual server, tool service, binding, HTTP route and SQLite store.
