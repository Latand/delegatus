# Voice tools: slice 1 backend contract

This slice implements the registry, write-only secrets, operator approval,
MCP management and isolated catalog probes from option A in
`voice-extensible-tools.md`, and the Tools section of the voice settings.
Voice calls remain on their existing tools.

## Authority and execution

Every agent may propose a server, including delegated and specialized agents.
The `voice_tools` MCP tool supports `list`, `status`, `propose` and a refused
`remove`. All MCP callers are refused approval and execution. The registry
and catalog are never re-served as callable agent tools.

The operator browser is the existing same-origin voice-settings authority;
team installations additionally require an active owner. Proposing executes
nothing. An operator's **Run dry run** click authorizes one probe of the exact
displayed digest. This ordering applies the design's execution trust boundary
before its discovery flow: a probe runs code as the operator's OS user too.
After inspecting its catalog and selecting tools, the operator approves the
new digest. There are no paid calls.

## Browser API

`GET /api/voice-tools` returns `{ version, revision, servers }` with no-store
caching. Each server includes its configuration, state, approval, selected
tools, catalog, `lastDryRun`, current `digest`, `secretRefs` and
`missingSecrets`. Transport summaries contain:

- stdio: `type`, `command`, `args`, `cwd`, `envNames`;
- HTTP: `type`, `url`, `headerNames`.

Environment and header values are never returned. Secret values have no read
endpoint. The client-safe view type is `VoiceToolsView` in
`src/lib/voiceTools/contracts.ts` (use a type-only import).

`POST /api/voice-tools` accepts these strict action bodies:

| Action | Fields besides `action` |
| --- | --- |
| `propose` | `proposal`, matching `proposalSchema` |
| `dry-run` | `name`, current `digest` |
| `configure` | `name`, current `digest`, optional `tools`, `askBeforeActing` and `reapprove: true` |
| `approve`, `reject`, `disable`, `remove` | `name`, current `digest` |
| `secrets` | `secrets`, a mapping of reference names to values |

Success returns the same view as GET. Failures contain a fixed `code`, never
an exception, peer stderr or credential. A stale digest returns
`STALE_APPROVAL`; refresh the view before another click. Approval requires a
successful matching dry run. Every selected tool entry is
`{ enabled: boolean, acts: boolean }`; newly discovered tools start unselected,
with `acts` derived conservatively from `readOnlyHint`. Changes to pinned
configuration or selections clear approval and return the server to pending.
A `configure` with `reapprove: true` is the operator's change on an approved
server: the change and the approval of its new digest commit in one store
mutation, or a refusal (any approval refusal, or `STALE_APPROVAL` when the
server is no longer approved) leaves the record unchanged.
Secret rotation preserves approval because only reference names are pinned.
`askBeforeActing` defaults to false, matching the operator's explicit-request
policy; the operator can turn it on per server.

`POST /api/voice-tools/proposals` is the internal MCP control transport. It
requires the verified MCP service tag and has only list, status and proposal
branches. The public UI route refuses internal service and agent claims.

## Persistence and bounds

The Viewer owns `voice-tools.json` and `voice-tools-secrets.json` in its state
directory. Both are atomic owner-only files; writes serialize through the
async file transaction. Existing symlinks and permissive file modes are
refused. The boot loader reads validated persisted artifacts asynchronously
without contacting a server. A failure enables no extra tools.

The probe is a leased helper, with at most eight concurrent probes and one
20-second deadline covering preparation and peer work. The helper's lease
also bounds shutdown and reaps its process group. Stdio gets a private HOME
and a platform environment allowlist. A stdio proposal may not name an
environment variable that chooses the launched binary, loader, interpreter,
package, registry or config file (`PATH`, `HOME`, `TMPDIR`, `LD_*`, `DYLD_*`,
`NODE_*` other than `NODE_ENV`, `BUN_*`, `UV_*`, `NPM_CONFIG_*`, `PIP_*`,
`PYTHON*`, `XDG_*`, `GIT_*`, proxy and CA variables; `launchShapingEnv` in
`contracts.ts`), as a literal or a secret reference: the settings show
variable names only, so the command shown must be the command that runs. Such
a proposal is refused with `INVALID_PROPOSAL`, and such a persisted record
fails the load. HTTP redirects are refused. Incoming
wire data is capped at 2 MiB, catalogs at 128 tools, schema JSON at 8 KiB and
10 levels, and descriptions at 1 KiB of UTF-8. Schema compilation runs in the
helper. Approval caps enabled servers at 16, selections at 32 tools and extra
tool JSON at 48 KiB, and refuses normalized name collisions across servers.
Pending proposals are capped at 64 total records, including disabled and
rejected records. A local entry file must be pinned; hashing is streamed and
bounded at 16 MiB.

The monitor sites are `voice-tools.catalog`, `voice-tools.spawn` and
`voice-tools.call` (reserved for the later dispatch slice). No performance
improvement is claimed by this slice.

## Settings section

`src/components/voiceCompanion/VoiceToolsSetting.tsx` is the Tools section of
the existing voice settings dialog, below call memory. It lists each server
(waiting ones first) with what will run: the command and arguments or the URL,
the folder, environment or header names without values, and the pinned file
with its hash. It also shows each secret reference as saved or needed, with a
password field that sends a value once and never shows it again; the last dry
run and its reason in plain words; the catalog's tools with checkboxes, marked
as reading only or acting; the per-server «ask before acting» switch; and Run
dry run, Approve, Reject, Turn off and Remove by state. Every press carries the
digest shown. A refusal reads under the control pressed, and a stale digest
rereads the view. On an approved server, a change to the operator's own
choices (a tool, the switch) is one `configure` with `reapprove: true`, so the
server stays approved under the new digest; a refusal changes nothing, puts the
control back and shows the reason under it. Strings ship in English and Ukrainian. Rendered evidence
comes from the kanban browser driver's «voice tools settings» case
(`evidence/voice-companion/voice-tools.json`); frames are never committed.
