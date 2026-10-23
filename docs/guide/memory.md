# Learned rules and shared memory

Delegatus keeps two kinds of memory for agents. Learned rules are short
instructions that the stages of a pipeline leave for the next agents. Shared
memory lets Claude and Codex agents look up what either engine learned. This
page covers both; [Core concepts](concepts.md#learned-rules) gives the short
definition.

## Learned rules

When a stage reports, its agent gives one answer about learned rules, and the
default is none.

### What an agent can leave

- **Rewrite a rule** it was given, by its id, with sharper or more general
  text. The rule keeps its id and level, and the earlier text is kept as a
  version that can be restored.
- **Leave one new rule**, when that rule would change what an agent does on a
  different task, at the narrowest level that holds: the agents of its role,
  every role in the project, or every project on the machine.
- **Leave none.** A rule that names a pull request, an issue, a commit or
  another id of one task is refused, and that detail belongs in the stage
  report.

Agents of that level read the rules in their engine instructions at every
start. Review and verification stages get none and leave none.

### Manage the rules

- **Learned rules**, on the board's ⋯ menu, opens a memory profile of the
  project: a summary you refresh with **Summarize**, and the rules by group.
- **×** removes a rule.
- A curator merges, ranks and archives rules from the orchestrator's wakes.
  The window shows each rule's earlier texts with **Return**, and an **Undo**
  for a whole curator pass.

## One memory: Delegatus memory or the engines' own

Claude and Codex each keep a memory of their own, and Delegatus keeps learned
rules. The **Delegatus memory** row under **Settings** in the sidebar's ⋯ menu
chooses which one agents launched by Delegatus use. It is set for the whole
installation, so it shows on the overview too. Its line under the title says
where it stands:

- **Off, before any choice.** Agents get both: the engines' own memory and
  Delegatus rules. Turning the switch on starts the import below.
- **Importing.** The curator reads every Claude and Codex note and keeps it as
  a rule at the level its readers need, or drops it with a reason. The line
  counts files done, and parts left when a long file was split. The engines'
  memory stays on until the notes they load at start are all decided.
- **Waiting for earlier agents.** New agent starts use Delegatus rules only.
  Agents that started earlier keep their engine memory until they restart, and
  the notes they write meanwhile are imported too. The line says how many are
  left.
- **On.** Agents remember through Delegatus rules; Claude's and Codex's own
  memory is off for every agent Delegatus launches.
- **Off, after a choice.** Agents use Claude's and Codex's own memory, and
  Delegatus rules are paused; the rules window says so. Once an import has
  run, new engine notes are imported daily by default, and the line says when
  that last ran and how many notes were new.

The switch moves as soon as you press it, and the change is saved in the
background. If the save is refused, the switch goes back and the line says so.
If an import stops, for example because a backup copy did not match its
source, the switch goes back to where it was and the line names the reason.
Delegatus only reads the engines' memory files: before the import it backs
them up privately, and it never edits them or your own engine settings, so
turning the switch off finds them as they were. Reviewers and other clean
stages read neither memory in any position. Notes that the import drops stay
searchable with `search_memory` and in the transcripts.

## Shared memory

Claude and Codex keep separate memories. `search_memory` lets an agent on
either engine query what both have learned.

### Turn it on

With shared memory switched on for a project, each message you send to a
Claude or Codex agent also carries the memories selected as relevant to it.
While **Delegatus memory** is on, or waiting for earlier agents, nothing is
added this way, because those memories come from the engines' own stores; the
project's switch keeps its setting for the other positions.

Automatic memory hooks apply to agents launched by Delegatus. Your own Codex
sessions keep their existing hooks. Delegatus passes its Codex hook through
launch settings; it stores no access key in the generated program. Upgrade
cleanup removes earlier global Delegatus hooks and their trust settings while
preserving your personal entries.

- **Where.** The **Shared memory** page under **Settings** in the sidebar's ⋯
  menu. The Settings row names memory's state in a word: working, off, key
  needed or capped.
- **What it needs.** Selection needs an OpenRouter key, entered in
  **Settings → Keys**; without one, the memory page's **Open Keys** opens that
  page on the OpenRouter key. It sends redacted context to that provider and
  shares the Asks-you monthly cap.
- **What it shows.** The memory page shows the month's counts and says why
  memory is not added, with the action beside the reason.

### In a conversation

- Under a message that received memories, a chip such as **Memory · 3** opens
  to their titles, and each title opens that memory's file.
- When memory found nothing that fits, a quiet line says **Memory: nothing
  relevant**.
