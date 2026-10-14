# Learned rules and shared memory

Delegatus keeps two kinds of memory for agents. Learned rules are short
instructions that the stages of a pipeline leave for the next agents. Shared
memory lets Claude and Codex agents look up what either engine learned. This
page covers both; [Core concepts](concepts.md#learned-rules) gives the short
definition.

## Learned rules

When a stage reports, its agent gives one answer about learned rules, and
the default is none. It can instead rewrite a rule it was given, by its id,
with sharper or more general text; the rule keeps its id and level, and the
earlier text is kept as a version that can be restored. Or it can leave one
new rule, when that rule would change what an agent does on a different
task, at the narrowest level that holds: the agents of its role, every role
in the project, or every project on the machine. A rule that names a pull
request, an issue, a commit or another id of one task is refused, and that
detail belongs in the stage report. Agents of that level read the rules in
their engine instructions at every start. Review and verification stages get
none and leave none. **Learned rules** on the board's ⋯ menu opens a memory
profile of the project, a summary you refresh with **Summarize**, and lists
the rules by group with × to remove one. A curator merges, ranks and
archives rules from the orchestrator's wakes; the window shows each rule's
earlier texts with **Return** and an **Undo** for a whole curator pass.

## Shared memory

Claude and Codex keep separate memories. `search_memory` lets an agent on
either engine query what both have learned. With shared memory switched on
for a project, each message you send to a Claude or Codex agent also carries
the memories selected as relevant to it. The switch is on the **Shared
memory** page under **Settings** in the sidebar's ⋯ menu, and the Settings
row names memory's state in a word: working, off, key needed or capped.
Selection needs an OpenRouter key, entered on its own page beside it, sends
redacted context to that provider and shares the Asks-you monthly cap. The
memory page shows the month's counts and says why memory is not added, with
the action beside the reason. Under a message that
received memories, a chip such as **Memory · 3** opens to their titles, and
each title opens that memory's file. When memory found nothing that fits, a
quiet line says **Memory: nothing relevant**.
