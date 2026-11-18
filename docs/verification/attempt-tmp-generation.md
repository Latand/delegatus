# Reduce temporary repository generation

## Inventory

Read-only inspection on 2026-11-17 covered one reported attempt's temporary
directories and its saved verification and probe drivers. No inspected root
was modified or removed. The six repeated final-check directories occupied
93,224,960–1,267,412,992 allocated bytes each. They were environments containing
test fixtures and caches. Two source checkouts each occupied about 246 MB and
already linked the same installed dependencies. One final-check environment
contained 917,430,272 bytes of probe fixtures; an inspected fixture included
24,031,232 bytes of TypeScript and generated compiler bundles. Its saved probe
driver explicitly copied TypeScript for each launch shape. That driver was
agent-created scratch, absent from the tracked project. The observed gigabyte
directories cannot all be attributed to copying the entire repository.

The initial code baseline is `a63693d9f75645725ec7b68fd7b500dfcdd32ab1`.

| Producer or instruction | Creation frequency and previous behavior | Result |
| --- | --- | --- |
| `scripts/check-source.ts`, `createRuntimeCheckTree` in `scripts/local-gate.ts` | One source copy per helper invocation; one tree shared by all build consumers of a publication hook. Dependencies were already linked. | Detached clone shares Git objects and keeps a private index and refs. Current staged, unstaged and untracked inputs overlay the checkout; deletions and executable modes survive. The helper releases its owned tree after consumers settle. |
| `scripts/review-export.ts` | One full source archive plus its extraction per invocation; matching dependencies already linked. Repeated agent invocations accumulated exports. | Shared clone removes the intermediate archive, retains the requested commit and upstream identity, and links dependencies only when manifests, lockfile, Bun configuration and patches match. |
| `scripts/local-gate-tests.ts` | Zero baseline checkouts for a green head; at most one shared clone per comparator invocation for a red head. One private environment per explicit test file. Matching dependencies linked; incompatible graphs installed privately. | Existing object/dependency sharing and comparison semantics preserved. |
| `scripts/merge-batch.ts` | Existing Git worktrees for batch, baseline, attribution and trusted privacy subjects. Dependency gates installed separately for repeated subjects. | Dependency gates use the trusted driver's preparation helper. Linked Delegatus worktrees reuse the fenced dependency store keyed by the full input graph; unmanaged subjects retain frozen installation and failure propagation. |
| `scripts/cloud-check-dependencies.ts` | One independent dependency copy per Cloud setup reuse; checks can write into it. | Prefer filesystem copy-on-write extents, with an independent-copy fallback. Preserve private writes and internal executable links. Hardlinks would violate this writer contract. |
| `scripts/gate-runner/client.ts`, `scripts/gate-runner/serve.ts` | Bundle transport verifies the working-tree identity before remote execution. | Existing transport retained; shared-clone review exports retain their export metadata. |
| Capture and browser drivers named in `AGENTS.md` | Consume a prepared tree and isolated state; no recursive repository/dependency copy found in those drivers. | Existing drivers retained. |
| `scripts/pipeline-park-proof.ts` | Explicit preservation/restore proof copies checkout files and artifacts to independently retained evidence. | Preservation semantics retained; this is a backup contract, outside check scratch generation. |
| Working rule 16 and reviewer dependency guidance in `src/lib/roles/defaults.ts`; source-check instructions in `AGENTS.md` | Required scratch isolation without specifying a bounded sharing/reuse procedure. Agent-created probe matrices could copy a compiler for every case and repeat whole environments. | Require the project helper or a shared clone/worktree, reuse the same tree across checks, link matching read-only dependencies, and release owned exports after consumers settle. Writable fixtures require private installation or filesystem copy-on-write. |
| Agent-created Python review commands | The operator's later allocation report identified a 6.60 GB uv artifact cache plus a 1.03 GB venv in one attempt, and two further venvs of about 1 GB each. No tracked producer of those review cache/venv directories was found. Repeated isolated HOME/XDG values and explicit scratch cache overrides permit a fresh installation for every review invocation. | Pin original uv and Bun artifact cache locations at the common agent environment boundary. The gate preserves these locally and treats them as machine-local on remote dispatch. Instructions require reuse of a verified matching Python environment without syncing, or one private writable environment per attempt and graph. |

## Per-attempt budget

`scripts/attempt-tmp-budget.ts` measures allocated tmp blocks with `du -P -x -sk`,
without following dependency symlinks and with hardlink deduplication. The
default admission limit is 8 GiB, configurable through
`LLV_ATTEMPT_TMP_MAX_BYTES`. A 90% warning names usage and limit. Exceeding the
limit refuses another gate/export; the standalone guard and owned runner exit
73. Invalid configuration, changed directory identity and unavailable
measurement also produce explicit refusals.

`materializeStructuredHostAccess` supplies the scratch-root identity.
`withAgentConfigSandbox` forwards it through the common boundary used by Codex,
Claude and Copilot; `checkEnvironment` preserves it through gate isolation.
The owned runner measures before dispatch. The remote client also measures
before SSH or bundle capture, because that route bypasses the local runner.
Its regression requires exit 73 with no SSH contact, scratch capture or local
fallback. Source-check and review-export
also measure before and after creating a tree, and source-check measures on
successful command completion. Each measurement reads disk anew, including
after a process restart. No in-memory allowance grants a new budget.

This is an admission guard. A running command can exceed the threshold before
the next measurement. It neither deletes data nor interrupts existing
consumers. Cleanup and retention code are unchanged.

## Dependency artifact caches and Python environments

`withAgentConfigSandbox` is the common consumer boundary after the Codex,
Claude and Copilot host environment allowlists. It now supplies `UV_CACHE_DIR`
and `BUN_INSTALL_CACHE_DIR` from explicit original values, or their original
HOME/XDG/Bun defaults. It creates no cache itself. Subsequent private HOME/XDG
replacement preserves these locations. `checkEnvironment` admits them and
includes their values in receipt fingerprints; the remote environment table
classifies them as isolated so a local absolute cache path never travels to
another machine. Package tools own concurrent cache access. uv documents its
cache's reader/writer locking in its [cache safety guide](https://docs.astral.sh/uv/concepts/cache/#cache-safety).
The remote server supplies its own persistent uv/Bun artifact directories,
so nested check isolation there also preserves reuse across run directories.

The shared directories contain package artifacts. A Python virtual environment
is selected explicitly per check after verifying the dependency inputs,
interpreter, platform and imports. Reused environments run without syncing,
network access or bytecode writes; source imports must resolve to the export.
Editable paths into a different checkout prohibit reuse. Writable fixtures
use a private venv with `UV_LINK_MODE=copy`, or independent copy-on-write
files; installing into a borrowed environment is prohibited. Reuse cannot
make an incompatible dependency graph valid. No package cache is pruned or
existing environment removed by this change.

The allocation report also observed zero registry-cached bytes for newly
registered roots. Registry byte-accounting repair is outside this allocation
prevention change; the admission guard measures the filesystem directly.

The merge-batch regression suite is split into core and revalidation files,
sharing Git fixture helpers. Its combined case registrations are unchanged.
This keeps each file under the existing five-minute comparator budget:
the original full file timed out on the candidate while its baseline took
278–294 seconds. No timeout or comparison policy was relaxed. Fixture cleanup
also releases the list of retired roots after each case.

## Permission and ownership boundaries

Scratch exports link dependency directories; removing an export unlinks that
entry without traversing the shared installation. The source-checkout regression
creates two exports of sealed dependencies, removes both without chmod, and
checks the surviving installation's bytes, mode and inode. Git objects are
borrowed through alternates; each export owns its writable Git metadata.

Cloud checks require writable dependencies. Their copy now creates directories
with owner write/search permissions before descending, and gives copied files
owner read/write permissions. Copy-on-write files have independent inodes;
fallback copies retain that independence. A regression copies the same sealed
installation twice, chmods a file in one copy, removes that copy without chmod,
writes into and removes the other, and checks the source's bytes and modes.
Hardlinked writable dependency trees are never created by these helpers.

The unmanaged stage-dependency fallback installs with `--backend=copyfile`.
Its regression installs one loopback-registry package into two subjects with
separate HOME directories and a shared artifact cache. The second install
needs no registry requests. Payloads have independent inodes; changing the
first payload's bytes and mode preserves the second install and cached files.

Borrowed dependency symlinks retain the existing read-only consumer contract.
They do not create an operating-system isolation boundary: a process with the
same Unix owner and full host access can explicitly chmod or write through the
link into the shared installation. File modes cannot enforce protection from
that owner. Enforcing that stronger property needs a separate mount/identity
boundary or private dependency installations per attempt. The tests above
prove creation and removal safety, and private-copy independence; they do not
claim protection against an unrestricted process mutating a borrowed link.

## External gate allocations

The attempt budget also measures gate sandboxes that production placement
keeps under the OS temporary roots, outside the attempt's original `tmp`.
`recordGateSandbox`, all five merge-batch temporary-directory allocation sites
and its standalone test/privacy worktree paths append their canonical directory,
device and inode to an attempt-owned journal.
Every admission rereads that journal, validates surviving directory identities,
and measures them together with the original tmp. Parent directories subsume
nested allocations, and one `du` invocation counts shared inodes once. Removed
directories no longer spend the budget; changed identities and invalid journals
refuse admission. Cleanup remains with each allocation's existing owner.

The production-placement regression exercises both preferred and fallback
allocation through the existing allocator seam, mapping actual writes into
fixture-owned scratch. It writes 3 MiB under twice-isolated HOME/TMPDIR, checks
the warning threshold, then starts two independent owned runners under a
1 MiB cap. Both refuse with exit 73 before their marker command runs. A batch
regression checks dependency, privacy and other gate environments with nested
4 MiB payloads, including allocation retirement after normal cleanup.

## Repeated measurement on identical source

Three alternating before/after pairs used the baseline commit above, Bun
1.4.0, matching shared dependencies and fresh private HOME, XDG, state and tmp
directories. Remote execution was disabled. Each run exported that commit and
ran `bun test --timeout=60000 ./src/lib/shortIds.test.ts`. All six exports and
all six test runs exited 0 through the heavy-command wrapper.

Linux child `ru_oublock * 512` measured filesystem output bytes for export and
gate execution, including the former intermediate archive. `du -sk` measured
retained allocation without traversing linked dependencies. This is filesystem
output accounting, rather than a count of logical application writes.

| Pair | Before: bytes written | After: bytes written |
| --- | ---: | ---: |
| 1 | 483,721,216 | 249,708,544 |
| 2 | 483,721,216 | 249,708,544 |
| 3 | 483,721,216 | 249,708,544 |

Each pair reduced writes by 234,012,672 bytes (48.4%). Retained allocation was
about 251.2 MB before and 252.6 MB after: the new export retains Git metadata.
The improvement removes duplicate archive writes; it does not claim to shrink
the checked-out source or every fixture workload. Raw paired measurements and
terminal gate logs are retained in the stage's evidence directory.

## Allocated bytes including a Python review environment

On 2026-11-17, three further alternating pairs exported the identical commit
`2d553254782142beaf2eb7ae51dc5221d05f5814`. Each attempt used private HOME,
XDG, state and TMPDIR, a closed control URL, Bun 1.4.0 and uv 0.12.21,
with remote execution disabled. The workload imported a local pure-Python
wheel containing a 32 MiB payload and ran
`bun test --timeout=60000 ./src/lib/shortIds.test.ts`. There was no network.
The before procedure used the original archive exporter and created an
artifact cache and writable venv inside each attempt. The after procedure
used the shared clone exporter and reused an already prepared cache/venv,
with syncing and Python bytecode writes disabled. Both procedures linked
the same matching node_modules installation.

`du -P -x -sk <attempt-root>` before and after the workload, multiplied by
1024, measured the additional allocated bytes, excluding shared symlink
targets. Every export, Python import/prefix assertion and project test
exited 0. The reused venv retained every file's content, inode and mode.

| Pair | Before: new allocated bytes | After: new allocated bytes |
| --- | ---: | ---: |
| 1 | 318,550,016 | 252,649,472 |
| 2 | 318,545,920 | 252,624,896 |
| 3 | 318,545,920 | 252,620,800 |

The reduction was 20.7% in each pair. The shared Python setup initially
allocated 67,362,816 bytes once, outside the measured attempt roots; its
first preparation still costs disk space. This controlled warm-reuse case
demonstrates avoided repeated allocation, without estimating a percentage
for arbitrary production environments. All newly created measurement roots
were retained; no existing scratch data was removed. The successful recorded
measurement and raw results are `allocated-confirmed.log` and
`allocated-pairs-confirmed.json` in retained stage evidence. An earlier
measurement used an overly strict allocation-equality assertion for the
shared setup; the successful run verifies venv bytes, modes and inodes instead.
