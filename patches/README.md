# Dependency patches

`braces-3.0.3.patch` ports the runtime mitigation from the tree at upstream
commit `28d440b5dd449dbf1fe6f3506cf94ecca4d02660` in
[braces PR 72](https://github.com/micromatch/braces/pull/72). That tip's own
commit adjusts a test shim; the runtime mitigation is already in its tree.

The patch limits parsed brace/parenthesis nesting and caller-supplied AST walks
to 100 levels, honors stricter fractional limits, and refuses cyclic parent
chains during expansion. It preserves the published 3.0.3 quote and invalid-node
behavior; unrelated upstream parser changes and test infrastructure are omitted.

Upstream braces is MIT licensed. Its existing copyright notice and MIT license
remain in the installed package. `scripts/braces-patch.test.ts` exercises the
actual installed braces and micromatch APIs and fails if installation skips the
patch. The publish and supply-chain workflows run that test after installation.

Remove this patch and its advisory metadata once an upstream fixed release is
available. The tracked removal issue is referenced in the audit metadata.
