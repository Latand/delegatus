# Interface polish, round 2: patches

Prototype patches for issue #2148, described and ranked in
[`../interface-polish-round2.md`](../interface-polish-round2.md). None of them
is applied to the product. Each applies on its own from the repository root,
and all twelve apply together in numeric order:

```
git apply docs/design/interface-polish-round2/01-prose-measure.patch
```

The number is the critique's change number
(`../interface-polish-critique.md`); the design document ranks them.

Patch 06 contains round 1's ghost copy button
(`../interface-polish/02-ghost-copy-button.patch`), because its moved controls
depend on it. Apply only one of the two: they change the same line.
