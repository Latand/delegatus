# Memory delivery evidence

The delivery ledger implements items 1 and 2 of
[memory-quality-benchmark.md](memory-quality-benchmark.md#5-conclusions-and-improvement-plan).
It records prepared engine starts, including starts whose native engine later
refuses to open. It makes no claim that an engine used the instructions.

## Contract and ownership

`learnedRulesForLaunchProfile(profile, start)` selects the text and commits a
`MemoryDelivery` before returning the engine instructions. Production callers
supply `MemoryEngineStart`: engine, durable conversation id, account home,
working directory, environment, and pipeline/stage/attempt when durable
membership provides it. A ledger failure refuses the start. A rule-store
failure retains the existing empty-delivery fallback and records that empty
set. Clean and role-free starts also get a row. Reconnection to a surviving
Codex process keeps its original delivery and creates no start row.

Producers are the fresh/resumed builders in `runtime/structuredSpawn.ts`, the
boot adoption builders in `runtime/startup.ts`, and both successor builders
in `accounts/migration/provider.ts`. Each engine start goes through one of
these builders. Launch profiles and receipts retain their text-free selector;
no ledger fields are added to those launch contracts. Optional `applied` and
`misled` ids on MCP lesson answers are checked against this attempt and
conversation's indexed delivery records, never against current readability
or shadow membership. The answer and its measurement commit together.
Legacy boot rows first acquire a durable conversation through the existing
registry method under asynchronous state admission.

`memory/deliveryLedger.ts` owns the private `role-memory/delivery.sqlite`
beneath the state directory. It opens and closes its connection per operation,
uses asynchronous lock admission, and registers `memory.engine-start` with
the loop monitor. No payload cache exists. The database is mode 0600, and its
parent is created with mode 0700. A canonical state path inside a git checkout,
including a symlinked state path, is refused before any private content is
written. An existing archive database must be a regular file with one link;
file symlinks and hardlinks are refused. Transactions commit the row, file copies,
references and eviction together. The private read seams are
`memoryDeliveries(afterSequence, limit)` (at most 100 rows) and
`engineMemoryVersion(hash)`; they are server-side analysis tools, with no
public HTTP or MCP endpoint.

Each schema-version-1 row contains the conversation, optional attempt,
engine, timestamp, physical scope revisions and their revision namespaces,
ordered rule ids with SHA-256 hashes, exact UTF-8 instruction bytes, and native
memory descriptors (`kind`, full-file SHA-256, file bytes, loaded-prefix bytes).
The renderer supplies both text and ordered metadata after the byte ceiling.
Stage attempts freeze that block in `role_memory_selection` on their first
start; resumes, boot adoption and account migration replay it. Shadow
selection adds its reason and ids to the ledger without changing delivered
membership. Later starts record `frozen`; their scope keys stay fixed and
their revision arrays are empty, since no current scope revision rendered
that replay. Operator deletion or an unresolved exact version removes the
corresponding line and records the removal on both records. See
[role-memory-layers.md §5.4](role-memory-layers.md#54-where-it-runs).
To recover a rule text, match its hash against the permanent current rule and
its version rows; timestamps cannot distinguish same-instant rewrites.
No rule text or explanation is duplicated into the ledger. Existing rule
egress checks and known-value sources keep their current contracts.

Native inputs are captured immediately before selection: Codex
`memories/memory_summary.md`, and the Claude repository auto-memory
`MEMORY.md` index (the parent repository for linked worktrees), honoring clean
launches and native memory settings (including the native home default and
the spawn policy fallback settings file). Claude index prefix accounting uses the
200-line/25,000-byte ceiling. Distinct full-file versions are stored as private
content-addressed BLOBs in the same transaction, outside every checkout;
reads verify the content hash. Topic files read later by an engine are outside
this start snapshot. The engine still owns its file read: a concurrent native
writer after capture can change what that later read sees. The hash identifies
the captured launch input.

## Retention and reconstruction window

Keep at most 10,000 starts and 64 MiB of referenced native file content,
evicting oldest starts until both limits hold. Collect a file version only
when no retained row references it. A native input over 1 MiB or ledger row
over 256 KiB refuses preparation, preventing an unbounded allocation. SQLite
reuses freed pages; physical file size includes its reusable high-water pages.
Sequence gaps before the oldest retained row represent expired evidence.
Reconstruction covers every retained start after activation; analysis must
report the retained sequence/time window and count expired starts separately.
It cannot reconstruct attempts before activation or after their evidence expires.

Frozen selection rows become eligible for deletion one day after their
attempt settles. The serving Viewer sweeps 32 rows per minute, with a
settlement recheck inside the writer transaction. A current stage awaiting
publication or repair, an unsettled activation or unconfirmed termination
retains its row. Close, delivery release and recorded host-settlement times
extend the grace clock. Missing or unreadable settlement proof retains the
row; the delivery ledger keeps its own retention policy.

Scope history now keeps the last 10,000 ordinary changes independently of all
curator-pass records, which stay for Undo. At the measured upper rate of 141
ordinary changes per day this covers over 70 days. Ordinary history remains a
bounded browsing/reconstruction aid for older attempts; post-activation delivery
reconstruction uses the ledger plus permanent rule versions and native copies,
so ordinary writes cannot displace its evidence.

## Curation admission and budget

Only curated rules can leave for budget. Every ordinary append, rewrite,
operator Return and project succession uses this same retention function.
Never-curated lessons can temporarily exceed 10,000 code points. Failed or
stale curator calls change no eligibility. A successful complete partition
marks its rules curated and must finish within 10,000 code points; it cannot
simply bless an existing overflow. Explicit operator removal and exact duplicate
merging retain their existing behavior.

A scope at 90% with unseen lessons makes curation due even below ten new
lessons. The machine singleton, eligible-seat checks and 30-minute cooldown
still apply. A full scope with no unseen lessons does not keep triggering.
Status reads only scope keys and their active rules, excluding the cold archive;
one shared LRU retains at most 32 tiny summaries, invalidated by durable state
and alias changes. Work is labelled `memory.curation-status`. This change
claims no measured latency improvement.
