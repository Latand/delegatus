# Naming, round 2: shorter, punchier names

Status: material for the operator's choice (rebrand, round 2). No product code
changes here. The rename plan and the positioning from round 1 still stand;
this round replaces only the candidate list. §5 adds the operator's later
feedback (Delegatus; "board" allowed again) and an updated recommendation.

**Decision (2026-09-23): the operator chose Delegatus.** CLI `delegatus`
(with a short alias), env prefix `DELEGATUS_`, config `~/.config/delegatus`,
npm package `delegatus-cli` (see "Name claims" in §5). The rename follows
round 1 §5.

## The requirement

The pinned outcome for this round, as relayed onto the board task (the
operator's own words were spoken, and are paraphrased here per the
repository's publication rules):

> Operator feedback (2026-09-23, paraphrased): none of round 1's names landed
> (Seatboard, Boardseat, Vataha, Agentseat, Yardmaster, Laneboard). They want
> names that are SHORTER and PUNCHIER.

Refinements relayed by the orchestrator seat on 2026-09-23, which take
priority over the pinned spec:

1. No repetition: no round-1 name, root or pattern. Nothing built on "seat",
   and no "-board" compounds.
2. A website is not required. A free domain is a plus and is reported, but a
   taken `.com` does not disqualify a strong name.
3. Short and punchy is the main criterion.

Source: the operator's messages to the project's orchestrator seat on
2026-09-22 and 2026-09-23, relayed into this lane's task and a follow-up
message. One further wish from the operator was cut off mid-sentence and had
not arrived when this document was written.

Every section below is checked against those two paragraphs: each candidate
has to be short, hit hard when spoken, and share nothing with round 1.

### What carries over from round 1

Round 1 (`docs/brand/naming-study.md`, on the round-1 branch) holds the usage
study, the positioning and the rename plan. None of that is redone here. The
parts this round builds on:

- **Positioning.** A local, agent-first orchestrator: you put work on a kanban
  board, a resident orchestrator agent turns it into pipelines of builders and
  fresh reviewers, and everything it does stays readable, interruptible and
  yours. Brand attributes: in command and calm, durable, transparent,
  agent-native, local and owned.
- **What the operator does.** States outcomes, often by voice, in Ukrainian
  and Russian mixed with English, then approves or corrects. The seat does
  the rest. A name that works as a spoken command in both languages fits how
  the product is used.
- **The neighbours.** Almost every English word for "someone who directs a
  crew" is already an AI-agent tool (round 1 found Conductor, Bosun, Foreman,
  Pitwall, Quarterdeck, Stagehand, Signalbox). This round confirms the same
  for short English verbs and nouns (§3).
- **Check method.** The same checks, extended to `.sh` and `.ai` (§3).

**Prior work.** A transcript search for this round (project-scoped, several
phrasings) found only round 1's own lane and the seat's summary of it; no
other naming work exists.

### Excluded from the start

Every round-1 candidate and every name round 1 dropped: Seatboard, Boardseat,
Agentseat, Laneboard, Agentboard, Orchboard, Helmboard, Yardmaster,
Conductor, Bosun, Foreman, Pitwall, Quarterdeck, Flotilla, Stagehand, Vataha,
Hromada, Toloka, Lanewright, Orkestr, agentyard, taskyard, taskhelm,
signalbox, loopwright, agenthelm, agentry, crewboard, deckboss, switchyard,
taskwright, tutti, wheelhouse, quartermaster, orchestrion, otaman, muster,
drover, valka, robota, downbeat, kish, conveyor, orcha, coxswain, roundhouse,
lanesmith, crewseat, seatrunner, seatlane, yardboss, lanemaster, lanekeeper,
boardwright, taskwarden, brygada, kapella, bandura, hetman.

And their roots: seat, board, lane, yard, helm, deck, crew, task, agent,
orch-/orchestra, -wright, -master, -boss, -keeper. "Crew" appears in the
pinned spec as an example of the style wanted; it is left out here because
round 1 already built two names on it.

---

## 1. What "short and punchy" means here

A name passes when all of these hold:

| Test | Bar |
| --- | --- |
| Length | 3–7 letters. Most candidates below are 4–5. |
| Syllables | One or two. |
| Sound | At least one hard consonant (k, t, p, z, d, b) or a distinctive cluster. Soft, vowel-heavy names fail. |
| Spoken in English | An English speaker hearing it can spell it, and seeing it can say it. |
| Spoken in Ukrainian | Reads naturally in Cyrillic, carries no rude or grim meaning, and no strong Russian-only association. |
| CLI | Typed as a command it looks like a verb or a tool: `nakaz run`, `kmand up`. |
| Env prefix | `NAME_` reads cleanly and doesn't clash with a common prefix (`GIT_`, `NODE_`, `AWS_`). |
| Config dir | `~/.config/name` is unambiguous. |
| Domain | Preferably one of `.dev`, `.sh`, `.ai` free. A taken `.com` is noted and never disqualifies. |

**Sound traps met while generating and checking** (each is a reason to drop
a name, and worth knowing for the next round):

- *Troop* sounds like «труп» (corpse) to a Ukrainian ear.
- *Gurt/Hurt*: «гурт» (a band, a group) is a good word, but the standard
  transliteration reads as English "hurt".
- *Zapr* reads as a clip of the name of a well-known censorship-bypass tool.
- *Dilo* («діло», the job at hand) is one letter from an English vulgarity.
- *Tabun* («табун», a herd of horses driven together) is also the name of a
  nerve agent in English.
- *Stavka* («ставка», supreme headquarters) carries a strong Soviet echo.
- *Kapo* (a boss) is a term from the Nazi camps.

---

## 2. Forty candidates

Legend for the quick columns (first pass, run on every candidate on
2026-09-23): ✅ free · ❌ taken. `npm` = unscoped package name; `.dev` =
registry RDAP. The full checks on the strongest fifteen are in §3.

### A. Real short words with drive (English)

| # | Name | Idea | EN reading | UK reading | npm | .dev |
|---|---|---|---|---|---|---|
| 1 | Rota | A duty roster: who is on, in what order. | "ROH-ta", a British word for a roster | «рота», a company of soldiers (about a hundred). Same letters, two fitting meanings | ❌ | ❌ |
| 2 | Rally | Rally the agents to a goal. | clear | «Ралі», reads as the motorsport | ❌ | ❌ |
| 3 | Spur | Spur work forward. | clear, one syllable | «Спур», no meaning, easy | ❌ | ❌ |
| 4 | Crank | Crank out the work; also the crank that turns the machine. | clear | «Кренк», fine | ❌ | ❌ |
| 5 | Graft | British slang for hard work; also joining two parts. | clear | «Графт», fine | ❌ | ❌ |
| 6 | Stint | A stretch of work, one shift of it. | clear | «Стінт», fine | ❌ | ❌ |
| 7 | Baton | Passed from stage to stage and from a dead lane to its successor; also the conductor's stick. | clear | «батон» is a loaf of bread, which makes it comic | ❌ | ❌ |
| 8 | Tack | Sailing: change course on command. | clear | «Тек», fine | ❌ | ❌ |
| 9 | Keel | What keeps the whole ship steady. | clear | «кіль», the same word | ❌ | ❌ |
| 10 | Tiller | The handle that steers. | clear | «Тіллер», fine | ❌ | ❌ |
| 11 | Cadre | A small core team that runs a larger force. | ambiguous stress ("KAD-ree" / "KAH-dray") | «кадри», staff, personnel | ❌ | ❌ |
| 12 | Axle | Carries the drive to the wheels. | clear | «Аксл», awkward cluster | ❌ | ✅ |

### B. Kanban and lean lineage

| # | Name | Idea | EN reading | UK reading | npm | .dev |
|---|---|---|---|---|---|---|
| 13 | Takt | Takt time: the pace a lean production line runs at, from the same Toyota system as kanban. | "takt", one hard syllable | «такт», beat, rhythm; the same word | ❌ | ❌ |
| 14 | Andon | The cord a worker pulls to stop the line and call for a decision. | "AN-don" | «Андон», no meaning | ❌ | ❌ |
| 15 | Gemba | "The actual place": where work is seen. | "GEM-ba" | «Гемба», no meaning | ❌ | ❌ |
| 16 | Kanbo | Kanban, clipped. | "KAN-bo" | «Канбо», fine | ✅ | ❌ |

### C. Clipped and blended coinages

| # | Name | Idea | EN reading | UK reading | npm | .dev |
|---|---|---|---|---|---|---|
| 17 | Kmand | "Command" with the vowel cut: what you type is what it does. | one syllable, heard as "command" | «кманд»; echoes «кмітливий» (quick-witted) | ✅ | ✅ |
| 18 | Delgo | Delegate + go. | "DEL-go" | «Делго», fine | ✅ | ✅ |
| 19 | Takto | Takt, made a word. | "TAK-to" | «такто», fine | ✅ | ❌ |
| 20 | Hopto | "Hop to it." | "HOP-to" | «Хопто», fine | ✅ | ❌ |
| 21 | Dryv | Drive, respelled. | "drive" | «Драйв», fine | ✅ | ❌ |
| 22 | Kaptn | Captain, clipped. | "CAP-tn" | «Каптн», awkward | ✅ | ❌ |
| 23 | Vekt | Vector: direction plus force. | "vekt" | «вектор», clipped | ✅ | ❌ |
| 24 | Mandat | The seat holds a mandate and acts on it. | "man-DAT" | «мандат», the same word | ✅ | ❌ |

### D. One-syllable punches

| # | Name | Idea | EN reading | UK reading | npm | .dev |
|---|---|---|---|---|---|---|
| 25 | Jolt | A jolt of work into motion. | clear | «Джолт», fine | ❌ | ❌ |
| 26 | Tork | Torque, respelled: turning force. | "tork" | «торк», fine | ❌ | ❌ |
| 27 | Kolt | A pure sound: hard k, hard t. | "kolt"; the homophone Colt is a firearms brand | «Колт», fine | ✅ | ❌ |
| 28 | Herd | Herding many agents at once. | clear | «Герд», fine | ❌ | ❌ |
| 29 | Surge | A surge of parallel work. | clear | «Сердж», fine | ❌ | ❌ |

### E. Short Ukrainian-rooted

| # | Name | Idea | EN reading | UK reading | npm | .dev |
|---|---|---|---|---|---|---|
| 30 | Nakaz | «наказ»: an order, a command given to be carried out; also a mandate. The operator gives the order, the product carries it out. | "na-KAZ"; hard k and z, easy to spell | «наказ», plain and strong; Polish "nakaz" also means an order | ✅ | ✅ |
| 31 | Hayda | «гайда!»: come on, let's go. | "HIGH-da"; sounds like the name of the Haida people | «гайда», lively, colloquial | ✅ | ✅ |
| 32 | Zapal | «запал»: drive, fervour; also a fuse. | "za-PAL" | «запал», the same word | ✅ | ❌ |
| 33 | Zagin | «загін»: a detachment, a squad sent to do a job. | "ZAG-in", ambiguous for English readers | «загін»; standard transliteration is "zahin" | ✅ | ✅ |
| 34 | Zbir | «збір»: the call to assemble; a gathering. | "zbeer", a hard cluster for English | «збір»; also means a fee or a tax | ✅ | ✅ |
| 35 | Sotnya | «сотня»: a Cossack company of a hundred. | "SOT-nya" | «сотня»; strongly tied to the memorial for those killed in 2014 | ✅ | ✅ |
| 36 | Dozor | «дозор»: a watch, a patrol. | "do-ZOR" | «дозор»; also the title of a well-known Russian novel and film | ✅ | ❌ |
| 37 | Shtab | «штаб»: headquarters. | "shtab", close to "stab" | «штаб» | ✅ | ❌ |
| 38 | Tabun | «табун»: a herd of horses driven together. | "ta-BOON"; also a nerve agent | «табун» | ✅ | ✅ |
| 39 | Rukh | «рух»: movement, motion. | "rook-h", the kh is lost | «рух»; also the name of a political movement | ✅ | ❌ |
| 40 | Razom | «разом»: together. | "RAH-zom" | «разом»; also a large Ukrainian-American nonprofit and a Lviv software agency | ✅ | ✅ |

The first pass also covered about sixty other names that were weaker or
taken: hoist, tug, hitch, cohort, marshal,
sortie, cairn, varta, kosh, hart, chumak, riy, sich, delego, dispo, ordo,
brisk, komanda, tabir, koval, shift, sprava, kadr, impet, dirigo, onit,
pronto, mando, ordr, lado, kiko, ruka, kando, blysk, torq, rivet, smithy,
hurtom, pullr, cmdr, relo, ryze, trakt, zhuk, chota, kurin, drivn, vzvod,
kmdr, gaffer, honcho. None beat the forty above.

---

## 3. Checks on the fifteen strongest

### How the checks were run (2026-09-23)

| Check | Method | Reading |
| --- | --- | --- |
| npm | `GET registry.npmjs.org/<name>` | 404 = free |
| GitHub account | `gh api users/<name>` (answers for users and orgs) | 404 = free; otherwise type and public repo count |
| GitHub repos | `gh api search/repositories?q=<name>+in:name`, sorted by stars | total and the most relevant hit |
| Product collision | web search for the name as software, AI agent or dev tool; the 235-entry `awesome-agent-orchestrators` list grepped for every candidate | named collisions only |
| .dev | Google registry RDAP | 404 = unregistered |
| .com | Verisign RDAP, then an HTTP fetch to see what it serves | 404 = unregistered |
| .sh | `whois.nic.sh` (the registry publishes no RDAP) | "Domain not found" = unregistered |
| .ai | Identity Digital RDAP | 404 = unregistered |
| Trademark registers | **unverified**: USPTO, EUIPO and the Ukrainian register were not queried | — |

The web search tool answers from a US index; results in Ukrainian and Russian
are thin, so a Cyrillic-market collision can be missed. Every `.com` checked
is registered. For Nakaz, Kmand, Hayda, Zagin and Zbir, `get<name>.com` and
`use<name>.com` are all unregistered.

Legend: ✅ free · ❌ taken · ⚠️ taken but empty or unrelated.

| Name | npm | GitHub account | Top repos | Product collision | .dev | .com | .sh | .ai | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| **Nakaz** | ✅ | ❌ a personal account with 99 public repos | 259 hits, top 8★, unrelated | None found | ✅ | registered, an unrelated personal page | ✅ | ✅ | **Top** |
| **Kmand** | ✅ | ⚠️ account exists, 0 repos | 55 hits, top 1★ | None found | ✅ | registered, no content | ✅ | ✅ | **Top** |
| **Hayda** | ✅ | ⚠️ account exists, 0 repos | name search is swamped by a farming game's helpers | None found; sound-alikes Haya AI and Hadaya.AI (consumer apps) | ✅ | parked | ✅ | ✅ | **Top** |
| **Zagin** | ✅ | ⚠️ account exists, 0 repos | 45 hits, top 14★, unrelated | None by name. Zag (zag.dev), which sells AI review agents for pull requests, is one letter shorter and in the same space | ✅ | parked for sale | ✅ | ✅ | **Top** |
| **Zbir** | ✅ | ⚠️ user, 6 repos | 238 hits, top 13★ | None; one personal portfolio site | ✅ | registered, blank | ✅ | ✅ | **Top** |
| **Zapal** | ✅ | ❌ user (16 repos); `zapal-tech` org belongs to the agency below | top 8★ | Zapal, a Kyiv web-development agency (founded 2022) | ❌ | registered, blank | ✅ | ❌ | **Top** |
| **Rota** | ❌ | ⚠️ account exists, 0 repos | tens of thousands of substring hits ("rotation") | No agent tool. The staff-scheduling category is full of Rota names (RotaCloud, Rotageek, Rotaready; rota.com is a scheduling app) | ❌ | in use | ❌ | ❌ | **Top**, on another domain: `getrota.dev` and `rotahq.dev` are free |
| Sotnya | ✅ | ⚠️ account exists, 0 repos | 3 hits, 0★ | None | ✅ | for sale via a broker | ✅ | ✅ | Drop: the memorial association (§2) makes it wrong for a product |
| Tabun | ✅ | ⚠️ account exists, 0 repos | substring noise | None in software | ✅ | registered, blank | ✅ | ✅ | Drop: shares its name with a nerve agent |
| Dozor | ✅ | ⚠️ account exists, 0 repos | 203 hits, top 13★ | DozoR transport-tracking apps (Ukraine); Dozor, an open-source network monitor forked from Zabbix | ❌ | registered, no answer | ✅ | ❌ | Weak |
| Shtab | ✅ | ⚠️ account exists, 0 repos | `tqdm/shtab` 469★ (shell tab completion) | Shtab.app: a Russian task tracker with kanban boards, listed in the Russian software registry. Same field | ❌ | redirects elsewhere | ✅ | ❌ | Reject |
| Kanbo | ✅ | ⚠️ user, 3 repos | Kanboard 9.9k★ sounds the same | KanBo: a work-coordination platform built on task cards. Same field | ❌ | registered | ✅ | ✅ | Reject |
| Baton | ❌ | ❌ user, 11 repos | `cmj0121/baton`: a terminal multiplexer for AI coding agents | Baton (getbaton.dev): a desktop app for running AI coding agents in parallel, with its own MCP server. Direct competitor | ❌ | in use | ❌ | ❌ | Reject |
| Rally | ❌ | ❌ user | `elastic/rally` 2k★ | A Rally CLI that dispatches AI agent teams to issues and PRs through git worktrees; Rally UXR ("agentic research") | ❌ | for sale | ❌ | ❌ | Reject |
| Cadre | ❌ | ❌ org, 17 repos | several `cadre` repos that run companies of AI agents | Multiple AI-agent orchestration projects and Cadre AI | ❌ | in use | ❌ | ❌ | Reject |

### Good names that are taken (reported briefly)

These are strong as words, and each is already used in the AI-agent or
dev-tool space, which a different TLD cannot fix:

- **Takt**: npm `takt` is "workflow control for AI coding agents", and
  `nrslib/takt` (1.4k★) defines how AI agents coordinate.
- **Herd**: `herdr` (40k★) is a runtime that owns coding agents' terminals.
- **Sortie**: `sortie-ai/sortie` turns tracker tickets into agent sessions.
- **Axle**: several AI-agent platforms (an agent builder, an insurance-agent
  YC company, an AI media platform). `axle.dev` is free.
- **Spur**: a YC-backed AI QA-agent company.
- **Rivet**: `rivet-dev` ships agent sandboxes and an "agentos".
- **Tork**: `runabol/tork` (818★) is a workflow engine.
- **Honcho**: `plastic-labs/honcho` (7.3k★) is agent memory.
- **Andon**: a lean quality system for AI-assisted work (`andon`, 164★).
- **Delgo**: a 2008 animated film best known as a box-office flop owns
  `delgo.com`; Delego is a payments company and an AI-agent authorization
  project.

**What the checks say about the space.** Round 1 found that every English
word for a crew leader is an agent tool. The same holds for short English
words with drive: Baton, Rally, Cadre, Spur, Axle, Takt, Herd and Sortie are
all taken by AI-agent products. The free space is in short Ukrainian words
and in clipped coinages. Every GitHub account name tested except one
(`takto`) is registered, so whichever name wins, the GitHub home will be an
org such as `<name>-dev` or `<name>hq` (not checked).

---

## 4. Top 7

Ranked by: short and punchy · says something about giving orders and moving
work · reads well in English and Ukrainian · no agent-tool collision · free
where it matters (npm first, because the product installs with
`bunx <name>`; then a short domain).

1. **Nakaz**. An order given to be carried out: the operator gives it, the
   seat and its agents carry it out. Five letters, two hard consonants, the
   same meaning in Ukrainian and Polish, and easy to spell for English
   speakers. npm, `.dev`, `.sh` and `.ai` are free; the GitHub account
   belongs to a person with 99 public repos. CLI `nakaz`, env `NAKAZ_`, config
   `~/.config/nakaz`.
2. **Kmand**. "Command" with the vowel cut out, so the CLI name says what it
   does (`kmand run`). No meaning in Ukrainian, but it echoes «кмітливий».
   npm, `.dev`, `.sh` and `.ai` free; the GitHub account is empty. The risk:
   people may write it "Kommand" or "Cmand" at first. CLI `kmand`, env
   `KMAND_`, config `~/.config/kmand`.
3. **Hayda**. "Come on, let's go!": the energy of launching work. Free on
   npm, `.dev`, `.sh` and `.ai`; the GitHub account is empty. English
   speakers will say "HIGH-da", which is also how the Haida people's name
   sounds, and the official transliteration of «гайда» is exactly "haida".
   Check that before choosing it. CLI `hayda`, env `HAYDA_`, config
   `~/.config/hayda`.
4. **Zagin**. A detachment sent out to do a job: the agents a pipeline sends.
   npm, `.dev`, `.sh` and `.ai` free; `zagin.com` is for sale. English
   readers won't know where the stress goes, and Zag, an AI review-agent
   product, is a near neighbour. CLI `zagin`, env `ZAGIN_`, config
   `~/.config/zagin`.
5. **Rota**. The shortest and hardest-hitting name here, with two fitting
   meanings: a duty roster in English and a company of soldiers in
   Ukrainian. It has no agent-tool collision, but npm, `.dev`, `.sh` and
   `.ai` are all taken and scheduling software uses the word everywhere. It
   would need a scoped or suffixed npm package and `getrota.dev` or
   `rotahq.dev` (both free). CLI `rota`, env `ROTA_`, config
   `~/.config/rota`.
6. **Zbir**. The call to assemble: everyone to their posts. Free on npm,
   `.dev`, `.sh` and `.ai`, and the most available name here. The "zb"
   cluster is hard for English speakers, «збір» also means a fee, and in
   Polish "zbir" means a thug. CLI `zbir`, env `ZBIR_`, config
   `~/.config/zbir`.
7. **Zapal**. Drive and fervour, and the fuse that sets something off. npm
   and `.sh` free; `.dev` and `.ai` taken; a Kyiv web agency uses the name
   and holds the GitHub org. CLI `zapal`, env `ZAPAL_`, config
   `~/.config/zapal`.

**Which to pick.** For the strongest meaning with the fewest problems,
**Nakaz**. For the most self-explanatory CLI, **Kmand**. For the most energy,
**Hayda**, after checking the Haida question. Rota is the punchiest of all
if a taken npm name and a longer domain are acceptable.

Rename mechanics (npm shim, config directory, env alias, Docker, skills) are
in round 1 §5 and apply unchanged to whichever name wins.

---

## 5. Addendum: Delegatus, and "board" allowed again

Operator feedback after reading the top 7 (2026-09-23, paraphrased): they
like the sound of *Delegatus*, which also works as a meme. Ukrainian names
are not required, and "board" may be part of the name.

That relaxes two rules above: the 3–7 letter limit (Delegatus is 9 letters,
four syllables) and the ban on "-board" compounds. Round-1 names stay
excluded.

### Delegatus

- **Idea.** Latin for "delegated" or "the one sent with a mandate". That is
  the product in one word: you delegate, and a delegated agent does the
  work. It also sounds like a spell from a wizard school (*Delegatus!*), a
  ready-made meme: cast it and the work gets done.
- **EN reading.** "del-eh-GAH-tus". Obviously Latin, and every English
  speaker recognises "delegate" inside it.
- **UK reading.** «Делегатус»: «делегат» with a Latin ending. Clear, with a
  playful tone.
- **CLI / env / config.** `delegatus`, `DELEGATUS_`, `~/.config/delegatus`.
  Nine letters is long to type all day, so the package can ship a short bin
  alias next to it, for example `dlg`. Whether `dlg` clashes with commands
  already on users' machines was not checked.

| Check | Result |
| --- | --- |
| npm `delegatus` | ✅ free as a name, but npm refused to publish it (see "Name claims" below) |
| GitHub account | ❌ a personal account (5 small unrelated repos). `delegatus-dev`, `delegatushq`, `getdelegatus` and `delegatus-ai` are all free |
| GitHub repos | 8 hits, all 0★ |
| Product collision | None by this name. Nearest neighbours: **Legatus** (legatus.team), an AI-agent platform you delegate work to, which sounds close and makes the same promise; and the Delego AI-agent authorization project (§3) |
| .dev | ✅ free |
| .com | ❌ registered, serves nothing; `getdelegatus.com` and `usedelegatus.com` free |
| .sh | ✅ free |
| .ai | ✅ free |
| Trademark registers | Registers not queried. A web search found two marks in other fields: a Canadian design mark for a Quebec law firm ("Delegatus Collectif d'avocats", legal services) and a US word mark DELEGATA for business consulting. Neither covers software (classes 9 and 42) |

**Verdict.** As available as the best names in §3 (Nakaz, Kmand, Hayda,
Zagin and Zbir also have npm, `.dev`, `.sh` and `.ai` free), with GitHub
org names free as well. It says what the product does more plainly than
any of them, and it has a meme hook none of them have. The cost is length.
Legatus is the one name to watch.

### Name claims (operator decision, 2026-09-23)

- **npm.** npm refused the unscoped name `delegatus` with a 403: too similar
  to the existing package `delegates`. The package is **`delegatus-cli`**,
  claimed with a placeholder release 0.0.0. The commands are unchanged:
  `delegatus`, the short alias `dlg`, and `delegatus-mcp`. Install with
  `npm i -g delegatus-cli` or run once with `bunx delegatus-cli`, then use
  `delegatus`.
- **Domain.** No paid domain for now.
- **GitHub.** No new organisation. The repository stays under the owner's
  personal account and is renamed there.
- The npm placeholder was the only claim needed before the first rename
  slices merge (docs/design/rename-delegatus.md §8).

### Board names, rechecked

| Name | Idea | npm | GitHub | .dev | .com | .sh | .ai | Collision | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| **Delboard** | The board you delegate from | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | None found | Everything is free, `.com` included. Risk: developers read `del` as "delete" |
| Boardus | Meme-Latin partner to Delegatus: the board, Latinised | ✅ | ✅ | ✅ | ❌ a French executive-recruitment firm | ✅ | ✅ | That firm only | Works only as a joke beside Delegatus |
| Orderboard | The board of orders | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ | OrderBoard, a London restaurant ordering platform | Weak |
| Taktboard | Takt plus board | ✅ | ✅ | ✅ | ❌ | not checked | not checked | Takt is already an AI-agent workflow tool (§3) | Reject |
| Runboard, Goboard, Shipboard | — | mixed | taken accounts | mixed | ❌ | not checked | not checked | — | Weak or generic |

**Pairing.** The product can be **Delegatus** and its kanban surface can keep
the plain noun "the board", so the name doesn't need "board" inside it.
Delboard is the fallback if a shorter name is wanted and the "delete"
reading is acceptable.

### Updated recommendation

1. **Delegatus**: the operator's favourite, free where it matters, the
   clearest meaning and a meme hook. CLI `delegatus` plus a short alias.
2. **Kmand**: the short alternative if nine letters prove too long in daily
   use.
3. **Delboard**: free on every surface checked, `.com` included. The only
   other name in either round with a free `.com` is Kmandboard, which is too
   long to consider.

The Ukrainian names in §4 stay on record as alternatives.

---

## Deferred: not currently justified

- **Trademark register search** (USPTO, EUIPO, Ukraine; classes 9 and 42).
  Worth running on the one or two names the operator picks, before any
  domain or package is registered.
- **Registering the package, domains and GitHub org.** Registering a name
  publishes it; that waits for the operator's choice.
- **Checking GitHub org variants** (`<name>-dev`, `<name>hq`) and npm scopes.
  Only needed for the chosen name.
- **Native-speaker checks** for the Ukrainian names in Polish and other
  Slavic languages beyond what is noted above.
- **The icon.** Follows the chosen name.

## Sources

Web checks, 2026-09-23:
[awesome-agent-orchestrators](https://github.com/andyrewlee/awesome-agent-orchestrators),
[Baton](https://getbaton.dev/),
[cmj0121/baton](https://github.com/cmj0121/baton),
[Rally UXR](https://rallyuxr.com/),
[Cadre (agent runtime)](https://github.com/ChristopherKahler/cadre),
[Cadre AI](https://www.cadreai.com/),
[Axle (agent platform)](https://github.com/thatcreativetayo/Axle),
[Spur on Y Combinator](https://www.ycombinator.com/companies/spur),
[KanBo](https://kanboapp.com/en/),
[Shtab](https://shtab.app/),
[DozoR apps](https://play.google.com/store/apps/dev?id=7540968259292595003),
[Dozor network monitor](https://www.dozorsystems.org/),
[Zapal](https://clutch.co/profile/zapal),
[Zag](https://www.zag.dev/),
[RotaCloud](https://rotacloud.com/),
[Rotageek](https://www.rotageek.com/solutions/digital-rotas-schedules/),
[Razom Software](https://www.razomsoftware.com/),
[Delego on PitchBook](https://pitchbook.com/profiles/company/58192-03),
[Haya AI](https://apps.apple.com/us/app/haya-ai/id6759229882),
[Hadaya.AI](https://play.google.com/store/apps/details?id=ai.hadaya),
[Legatus](https://legatus.team/),
[Delegatus in the Canadian trademark database](https://ised-isde.canada.ca/cipo/trademark-search/1897465),
[DELEGATA on Justia Trademarks](https://trademarks.justia.com/764/97/delegata-76497819.html),
[OrderBoard](https://www.orderboardtech.com/).
