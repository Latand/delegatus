# Weekly swarm pack pass

Swarm rules ship in `src/lib/memory/swarmRules.json` with a release. Receiving
is off by default. Settings → Install ping → Swarm rules enables the public
scope for eligible roles. The same choice will enable anonymous daily
usefulness counts when that feature ships. This release sends no swarm counts
or proposals. The initial pack is empty; no local lesson text was published.

The maintainers run the following pipeline once a week in this repository.
This is a recipe for a future run; installation and release startup never run
it automatically.

1. A builder reads the curator's candidate **ids** and their applied/misled
   counts through the local curation read. Candidates with applied marks join
   the existing list of rules supported by at least two tasks. Keep all local
   lesson text and explanations on their source installation.
2. Write each proposed instruction anew for any operator and project, checking
   its action and conditions against the code at the pipeline's base commit.
   Use only shipped memory-eligible roles, English text of at most 300 code
   points, and no project, person, account, machine, host, path or tool version.
   Before writing public text, verify that it repeats no private lesson under
   the publication gate's normalization. The first nonempty pack may instead
   use text already public in this repository.
3. Set `since` to the release date (`YYYY-MM-DD`). Compute each `id` as `r_`
   plus the first 16 hexadecimal digits of SHA-256 over role, newline, and
   text. A changed text gets a new id; `replaces` may name its predecessor.
   Drop obsolete entries. Frozen attempts keep their original public lines.
4. A reviewer checks every instruction against the code and rejects private
   context, ambiguous readers, contradictions, and wording that weakens an
   existing condition. Run the pack tests, the touched tests by explicit path,
   typecheck, touched-file ESLint, and publication privacy checks in isolation.
   Rendered rule lines must total at most 4 000 code points per role and
   36 000 across the pack. Ids, punctuation, and line separators count.
5. The pipeline drafts a pack pull request, with candidate ids, the reasons
   for each proposed change, and the checks and exit codes. It contains no
   local rule text or explanations. The operator approves the pull request;
   the approved pack ships in the next release. Nothing edits installed packs
   between releases.

The curator archives guidance held by the same role's serving swarm pack as
`in-instructions`, with `swarm:<id>` as `where`, only while receiving is on.
Installations with receiving off retain their local guidance. Shipped text is
public under the publication gate's normalization; a local rule's `why` and
all other local lesson texts remain private. The rules window shows the swarm
scope read only. Unticking hides it, including on resumed attempts; the
existing memory off-switches also stop delivery.

Daily counts and weekly operator-approved public proposals belong to later
slices. The decision about anonymous text upload follows four weeks of counts.
