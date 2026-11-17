# Installed package import completeness

## Cause

PR #4146 at `5fb16bba` adds dynamic filesystem traversal to
`src/lib/selfUpdate/steps.ts`. Next's file trace consequently includes the
checkout's `.gitignore` and a partial source tree in standalone output.
The packed file list in CI run `44130095887`, job `134204482544`, includes
`dist/standalone/src/lib/mcp/entry.ts` and `dist/standalone/tsconfig.json`,
but omits `dist/standalone/src/lib/environmentIsolation.ts` and
`dist/standalone/dist/mcp-server.mjs`.

The packaging change `d13e10bb27` introduced the nested runtime bundles without
protecting them from npm's nested ignore rules. npm applies the traced
`.gitignore` inside standalone, including `/dist` and `/.next/`, despite the
outer package's `files: ["bin", "dist", ...]`. The MCP launcher then falls back
to the partial source entry. Its alias configuration is present; its imported
module is absent. The import itself needs no change.

The isolated local reproduction at `5fb16bba` confirms the boundary: both nested
bundles and `.next/server/app/page.js` exist before npm pack and disappear from
the tarball. The standalone ignore file is byte-identical to the checkout's.
Installing that tarball reproduces the original missing `environmentIsolation` error.

`scripts/package-standalone.mjs` now assembles the runtime and writes an explicit
`.npmignore`. It preserves the checkout's other exclusions while admitting the
generated `dist`, `.next`, and traced `node_modules` trees. Compiler caches stay
excluded even when the broad trace collected them.

## Guard

`scripts/npm-package-smoke.mjs` audits installed first-party entry imports before
starting any entry. It covers both copies of the package bins and MCP/runtime
host bundles, including literal lazy imports, aliases, `require` and
`require.resolve`. External dependencies must resolve. The only CommonJS
exceptions are `bufferutil` and `utf-8-validate` in the two runtime bundles:
`ws` declares these native accelerators as optional peers and catches load
failures in `lib/buffer-util.js` and `lib/validation.js`. ESM imports, relative
imports and other package entries receive no optional-peer exemption.
CommonJS dependencies resolve with their `require` export condition, so an
existing ESM target cannot hide a missing CommonJS target.
The existing real stdio discovery and HTTP/audio probes still run afterward.

`scripts/package-standalone.test.ts` uses real npm pack/install with a traced
ignore file, verifies successful discovery, and removes the installed MCP bundle
to prove refusal. `scripts/npm-package-smoke.test.ts` removes each module from a
transitive import graph, including the original alias target and lazy imports.
It also checks deferred required CommonJS calls in both bundles at both package
roots, installed required dependencies, and the optional `ws` peer fallbacks.
The regression fails on the earlier blanket exemption before any entry runs.
The existing required packed smoke in `bun-runtime.yml` and `publish.yml`
executes the guard.

The Docker input list includes the new helper and three previously omitted
JS/JSON dependencies. Its direct test reproduced those omissions on unchanged
`cb1dcf9c`; the corrected list passes. The focused packaging, import/lifecycle
and Docker input suites cover packaging, import completeness and launch cleanup.

## Reviewed release head: acceptance item 4

**`823155d9` (v2.2.0) does not produce the reported broken package.** Its exact
CI run `44082070739`, job `134034907262`, packed the nested MCP bundle and passed
the installed smoke on 2026-11-17: 65 tools, 147 matching runtime assets, and
successful file/audio requests. The smoke step completed at 12:24:36 UTC.
The relevant packaging, ignore, Next configuration, MCP entry and self-update
source files are unchanged between release cut `6b5f69a7` and `823155d9`.
It retains the vulnerable packaging logic; the filesystem traversal trigger
from PR #4146 is absent.

Main's push run `44125720939` at `e43fe092` also ran the packed smoke and returned
65 tools and 149 matching assets. The smoke runs on both PRs and main pushes.
Both revisions retain the latent packaging weakness exposed when the
PR's broader trace copies `.gitignore`.

The isolated local CI-command reproduction on unmodified `origin/main`
`cb1dcf9c` also passes: 65 tools, 149 matching assets, HTTP 200 and audio bytes.
Both local reproductions use Bun 1.4.0, private homes, state roots, temporary
directories and npm prefixes, with the Viewer control URL on closed port 1.

Reassembling the same compiled PR output with the corrected helper passes the
installed smoke: 80 entry modules, 65 tools, 149 matching assets, HTTP 200 and
audio bytes. In a separate process the new guard rejects the original tarball
with `packaged entry module missing: dist/standalone/dist/runtime-host.mjs`
before MCP startup. The compiled app is reused only for this paired control;
the final branch verification runs the full prepack build.
