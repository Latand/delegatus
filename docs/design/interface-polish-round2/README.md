# Interface polish, round 2: patches

Prototype patches for issue #2148, described and ranked in
[`../interface-polish-round2.md`](../interface-polish-round2.md). All twelve
are built into the product now. The patches stay as the prototype record, and
"Built" in the design document says where the build departs from them.

Each patch applied on its own, and all twelve in numeric order, to the round-2
lane's head and to main before the build, for example:

```
git apply docs/design/interface-polish-round2/01-prose-measure.patch
```

The number is the critique's change number
(`../interface-polish-critique.md`); the design document ranks them.

Patch 06 contains round 1's ghost copy button
(`../interface-polish/02-ghost-copy-button.patch`), because its moved controls
depend on it. Apply only one of the two: they change the same line.
