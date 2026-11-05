# Pipeline format six rollback reader

Install and verify this compatibility release as the immediate rollback target before upgrading an existing pipeline database to format six. This release continues to create format-five collections. It can open existing format-six collections without changing their markers or importing legacy JSON again.

The rollback reader keeps ordinary pipelines available. Records with integration state or adopted creation receipts remain opaque and preserved. They are excluded from controller and publication projections; queued host and native input is deferred, and paid-credit recovery cannot resume it. Ordinary pipelines may still use an integration-like stage name. Existing accepted native work is not undone by this guard.

Original and adopted request keys use the retained receipt projection. A matching opaque record refuses replay admission instead of creating another outcome. Installing the projection backfills authoritative SQLite rows in the startup transaction, using bounded key pages and a 30-second execution bound. Conflicting owners or contradictory projection evidence abort that transaction. The projection accepts unknown record fields without rewriting them. An existing format-six marker with a missing receipt table refuses startup rather than inventing an empty replay history.

Collection compatibility is explicit and leaves unrelated versions and migration identities strict. A format-six legacy JSON import is refused when no compatible SQLite collection exists; recovery from that source requires the full format-six reader. Rollback mirrors carry the actual stored collection version. Writes by this reader retain format-six markers; old format-five-only binaries cannot be used as the next backout after six-format writes.

The subsequent feature release must perform the joint active/archive five-to-six marker transition under startup authority, preserve rows, revisions and replay evidence, and retain this compatible backout target. Restoring a pre-upgrade snapshot or stale JSON over newer accepted writes is outside this rollout.

The focused regressions exercise retained format-six reads and writes, opaque records, original/adopted replay refusal, projection installation and conflicts, unknown versions, and real journal-to-host/native dispatch. Host/native controls remain deliverable; unsupported input stays retained across controller reconstruction and changes during preparation.
