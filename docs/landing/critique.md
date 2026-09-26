# Landing critique: prototype A (Opus) and prototype B (GPT), from the renders

Read-only stage output. Source: renders under `~/Pictures/delegatus-review/landing/proto-opus/` (A) and `proto-gpt/` (B), 1440 and 390 wide, en and uk. No page was opened; nothing here comes from the code.

## Originating requirement

Operator feedback on A, 2026-09-26, from the pipeline specification (paraphrased there; personal data none):

> 1. The board was forgotten: the kanban board (tasks, pipelines on cards, needs-you) must be shown properly.
> 2. More demo cases of what the interface looks like (board, orchestrator chat with its report log, pipeline graph with build/review stages, a conversation, the phone, accounts/limits, activity).
> 3. The demo must feel native, as if you are really inside the orchestrator, only without the AI: an interactive, scripted walkthrough built from the real product UI (...) which the visitor can click through. Prefer rendering the product's own React components with fixture data over screenshots, so it looks exactly like Delegatus.
> 4. The demo's language follows the language chosen on the landing: interface chrome AND the demo messages switch between English and Ukrainian.
> Keep everything that works in A: the headline, minimal text, the mascot and its poses, the install box, the legacy terminal joke, the dark visual direction.

## Verdict

A wins on look and voice. B wins on structure and on showing the product. The final page is A's skin over B's skeleton: A's type, mascot, install box and joke; B's hero tab pair (Orchestrator / Board), B's full-width review section, B's one-panel-per-tab "open the work" section. The single live demo replaces every static capture in the hero.

## A: keep (ranked)

1. **Headline and type.** "Delegate everything." in the wide cream display face, one sub-line, nothing else. Same for the three section titles. This is the page's identity.
2. **Mascot poses.** Hero bird half on the frame, the giggler peeking over the legacy box, the bird perched on the phone. They carry the humour without a word of copy.
3. **Install box.** Claude Code / Codex tabs, cream "Copy prompt", the prompt itself in mono, "Read the whole prompt". Also the cream footer band that repeats it.
4. **Legacy joke.** "I still use a terminal" + "Hehe. Typing commands yourself? How vintage." + the `bunx delegatus-cli` box. Keep the wording as is.
5. **Hero animation.** Typing the request, the reply, the reports dropping in. That is already the seed of the interactive demo the operator asked for.
6. **Section copy.** Three bullets per section, every bullet a plain fact. No adjectives, no "seamless", no "powerful".

## A: fix (ranked)

1. **The board is missing on desktop.** At 1440 the hero shows only the orchestrator chat; the board exists only as a tab strip under it, and the "Replay" pill covers that strip ("Inbox 1 / Assigned 3" is hidden, "gned 3" shows). On the phone the hero shows the board, but with no way to reach the chat. Show both, as B does, and give the visitor a control that switches.
2. **The demo is a picture that moves, in one language.** Under uk every string inside the frames stays English ("Find a task", "NEEDS YOU 1", the chat, the reports, "2 working"); only "Replay" became "Ще раз". Requirement 4 is unmet in every uk render. A capture cannot fix this; the product's components with the uk dictionary can.
3. **Four surfaces, none of them clickable.** Chat, pipeline, conversation + search + accounts, phone + Telegram. The requirement lists eight cases and asks to click through them. The pipeline graph with build/review stages exists but is a still; the needs-you decision exists only as a card badge on the phone. Activity is absent.
4. **Overlaps.** 1440: the accounts panel covers the tail of the builder's message in "Every conversation, open."; the mascot covers the "Claude" engine chip in the hero header. 390: the accounts panel covers the message body from "answers 409" down, leaving three half lines readable. Panels may stack, they may not hide text.
5. **Header overflow at 390 in uk.** "Документація" pushes the EN/UK toggle off the right edge; the "UK" pill is clipped to one letter. Shorten to "Docs"/"Доки" or drop the star count on the phone.
6. **The Telegram cards are drawn, not real.** Two rounded cards with a time on the right read as a mock, beside a real phone frame. Either render the product's Telegram surface or drop them and let the phone card carry the section.
7. **Bleeds read as crops.** The pipeline frame runs off the right edge and is cut mid-card at the bottom; the builder frame in section 3 is cut on the left. One bleed per page at most; the rest gets a full frame.

## Borrow from B (ranked)

1. **Hero tab pair: Orchestrator / Board.** B's Board tab is exactly what the operator asked for: three columns, cards with the Build → Review → Verify chips, "needs a decision · 1 finding" with "Skip Build" / "Retry Build" buttons, a Blocked card with its reason. Put this pair under A's headline and drive both tabs from the same scripted state.
2. **The review section as a full-width frame.** Graph on top (Build passed, Review running with the fail edge "0 of 3 used", Verify waiting), the three stage columns beneath. B's version is wider, complete and readable; A's is the same capture squeezed to 60% and bled. Keep B's two caption facts: fresh read-only reviewers, failed reviews return within the round budget; auto-merge optional, off by default.
3. **"Open the work" as a tab list with one big panel.** Conversations & search / Accounts / Telegram / Phone on the left, one full-size panel on the right. This is how the demo grows to eight cases without eight sections. It also fixes A's overlap problem by construction.
4. **The install section shows the whole prompt.** B's card states what the prompt does in one line ("Installs Delegatus 1.5.0, connects its MCP server, and starts it locally."), what it leaves to you, then the prompt in full under a toggle, then the OS and runtime requirements. A's box hides everything after two lines. Keep A's skin, take B's content.
5. **Sub-headline as a promise, not a description.** B's "Runs on your machine. Uses your agent accounts." under the CTA is the one line of B copy worth keeping; it answers the first question a visitor has.

## Do not borrow from B

- The generic type and the purple default button. That is the default SaaS look the operator moved away from by choosing A.
- "Demo project with synthetic data; screenshots are in English." A disclaimer that names the defect. The native demo removes the need for it.
- Four "Capture pending" placeholders (agent message, search, Telegram read, Telegram post). Never ship a frame that says a picture is missing.
- "Open full image" under every figure. Six escape hatches on one page say the figures are too small.
- The uk hero: "Делегуй усе." drops below the right column, the two columns no longer share a baseline.

## Anti-slop pass

- B's title "Open the work. Not just the result." is the not-X-but-Y construction. Replace with a plain claim ("Every conversation, open." from A already covers it).
- B's sub-headline "Tell your orchestrator what to ship. It runs Claude Code and Codex through development and checks, then reports back." is A's sentence with more words. Keep A's.
- A's bullet "Claude Code builds, Codex reviews, and they message each other." is good; keep this register for every new case in the demo.
- Demo copy must stay in the product's own voice: report entries with a time and a status word, task titles as work items ("Back off webhook retries"), no marketing sentences inside the frame. Both prototypes already do this; the risk is in the new fixture text.
- Ukrainian copy in A reads naturally ("Скажи одному агенту, що треба зробити."). Reuse it for the demo's uk messages; do not machine-translate the fixture.
- No repeated mascot. One pose per viewport per section, as A's README already decides.

## Deferred — not currently justified

- Activity view as its own demo step. The requirement lists it; the renders show neither prototype has it. Add it only if the product's activity component renders from fixture data without a server; otherwise leave it for the check stage to confirm as a gap.
- Real Telegram look. Only if a product component exists for it; a hand-drawn Telegram is worse than none.
- Light theme. Neither prototype needs one; the dark direction is kept by decision.
