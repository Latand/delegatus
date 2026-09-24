# Settling the «Untitled task» backlog

Some placeholder tasks waited for a name that nothing would ever give them.
They showed up as «Untitled task» cards with one conversation that would not
open. Four sources created them:

- a leaked test fixture wrote two launch placeholders into the live store;
- a backfill on 2026-09-20 adopted months-old sessions as unnamed placeholders;
- every seat rotation's handoff-digest summarizer, and every one-line "reply
  with ok" probe, was admitted as a conversation of its own;
- orchestrator seat launches and launches that never produced a transcript.

Those sources are now closed (see `src/lib/stateOwnership.ts`,
`src/lib/tasks/internalConversations.ts`, `src/lib/tasks/membership.ts`), and a
card whose placeholder no agent will name borrows its conversation's title.
`scripts/settle-ghost-tasks.ts` deals with the tasks already in the store.

## What it settles

A task is marked **done** when all of the following hold:

- it is still open and still waits for its first name. No agent named it and
  no operator edited it: no rename, notes, colour, icon, deadline or attached
  link;
- no pipeline names it, and it is not a pipeline's or review flow's own
  container task;
- every conversation it holds has ended. Its transcript has been quiet for
  `--idle-hours` (6 by default) or does not exist, and the row itself is at
  least that old.

The fixture's placeholders (titled "Exercise legacy spawn fixture") are
settled whatever their age.

Nothing is ever deleted. Deleting a task mints a replacement placeholder for
each conversation it held, and that placeholder is the same ghost card again.
A task that changes between the plan and the write is decided again against
the store as it is then. That covers a task named, edited, closed or given a
pipeline in the meantime.

## Running it

A dry run is the default. It prints counts per project key and kind, and
counts per reason for the tasks it keeps. It prints no titles or paths.

```sh
bun scripts/settle-ghost-tasks.ts --state-dir "$STATE_DIR"            # dry run
bun scripts/settle-ghost-tasks.ts --state-dir "$STATE_DIR" --apply    # mark done
```

`--state-dir` is required: the script never assumes which store it settles.
Kinds in the report are `fixture`, `handoff-digest`, `probe`, `orchestrator`,
`launch-not-started`, `launch` and `conversation`. Reasons for keeping a task
are `still-running`, `operator-edit`, `pipeline` and `container`.

Run the dry run first and read it. Then run `--apply` with the same arguments.
A second dry run should report `settle: 0`.
