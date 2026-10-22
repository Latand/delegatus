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
