# Jumping between my own messages in a conversation

Design lane. It delivers four numbered variants as a clickable prototype and
their frames; it ships nothing. The operator answers with a number and the
build follows in a successor lane.

## The ask

A conversation with an orchestrator interleaves three kinds of user-side
records: the operator's own messages, seat-tick wakes, and agent notices. On a
busy evening a handful of own messages sit among dozens of wakes and notices,
each followed by a long reply. The operator wants to move from one own message
to the next or previous one, and to read the replies to their own messages
without the replies to machine-sent turns in the way. A conversation with a
worker has the same need more mildly: the other senders there are an
orchestrator or a pipeline.

## 1. How a record's sender is known today

Two readers answer the question, from the same delivery evidence.

**The feed** (`src/components/feed/parse.ts`, `FeedItem.tsx`
`resolveDeliveredItem`). After resolution a user-side row is one of:

| Row | Who sent it | How it is known |
| --- | --- | --- |
| `user` | the operator | no agent origin on the record |
| `tmsg` with `internal: true` | a machine sender; `peer` is its role | a Codex structured-user marker carrying `origin.kind === "agent"`, the Claude delivery ledger joined by engine message id, or the occurrence join for deliveries with no per-row identity (`messageProvenance.tsx`) |
| `mandate` | the seat's own mandate | the same delivery record |
| `sysmsg`, `compact`, `inbox-image` | nobody: harness rows | parser markers |

The role is stamped at admission by `delegatusMessageOrigin` /
`agentMessageOrigin` (`src/lib/runtime/agentMessageAuthor.ts`): `seat-tick` for
a wake, `pipeline` for a stage launch, `orchestrator` and `reviewer` for relays,
and the finished child's own role plus its conversation id for an "Agent
finished" notice (`src/lib/spawnNotice/production.ts`).

**The MCP read** (`conversation_messages`, `withRecordAuthors` in
`src/lib/mcp/bindings.ts`). A user-role record may carry
`author: { kind: "agent", role, project?, conversationId? }` or
`author: { kind: "member", memberId, name }`.

**The field the build relies on is the agent origin: `author.kind === "agent"`
in a record, which the feed already shows as `tmsg.internal` with the role in
`peer`.** A user-side record is the operator's when it has no agent origin and
is not a harness row. The member author cannot be the test, because it exists
only on an installation with a team; a solo installation's own messages carry
no author at all.

**Not every user-side record has an author.** One page of a real orchestrator
transcript, 56 user-role records: 29 with an agent author (all `seat-tick`),
19 with a member author, 8 with none. The 8 are three kinds:

| Kind without an author | Count | Classification |
| --- | --- | --- |
| attachment row of an own message (same timestamp as the message) | 5 | part of the operator's turn it arrived with; never a turn of its own |
| interruption marker | 2 | part of the turn it interrupted |
| continuation summary after a compaction | 1 | a harness row; opens no turn |

The feed parser already gives each its own row kind (`inbox-image`, `sysmsg`,
`compact`), so none of them reads as an own message. One gap stays: a machine
delivery that left no evidence at all (a paste from before the delivery ledger)
renders as an operator bubble today and would count as an own message. The
build inherits that reading; it does not get worse.

## 2. Packaging, after PR #2467

That lane put a `*.prototype` module beside the surface, mounted it only from
an evidence fixture, added one `describe` block to an existing browser driver,
printed the variant number large in a band above the surface, and kept the PNG
frames out of the repository. This lane does the same with one divergence: the
kanban fixture and the kanban driver are being changed by three open pull
requests, so the prototype mounts from the conversation window's fixture
(`conversationWindowEvidence.fixture.tsx`, `?case=own-messages&variant=N`) and
its frames come from a block in `conversationWindow.browser.test.tsx`. Frames
go to `.artifacts/own-message-navigation/`, which is already ignored.

The prototype draws its own rows with the product's colours, type and shapes.
It imports no live conversation component, and no product file imports it.

## 3. The phone layout it has to fit

The phone conversation is a 52 px bar (back, title, search, `⋯`), the feed
directly under it, and the composer dock. Since #2469 nothing sits under the
bar: the pinned message and background tasks are rows in the `⋯` sheet. So no
variant adds a strip under the bar. Each phone control sits at the bottom of
the feed, above the composer, where the thumb is.

## 4. The variants

The fixture conversation has 9 own messages among 40 machine-sent turns (wakes,
agent notices, pipeline messages). The first 10 turns are older history that is
not loaded: 7 own messages and 32 machine turns are on screen at the start.

`Alt+↑` and `Alt+↓` step to the previous and next own message in every variant.
Going back from the middle of a reply first returns to the message that reply
answers.

### 1 · Arrows with a counter

A small pill at the bottom right of the feed: up, `4 / 7+`, down. The
conversation stays exactly as it is; the reply to an own message gets an accent
rule and the caption "reply to your message".

### 2 · "Mine" mode

A switch between the whole conversation and own messages only. In the mode each
unbroken stretch of machine turns folds into one row ("5 wakes · 1 agent
notice · 16:04–17:04") that opens in place. Own messages and their replies are
then next to each other.

### 3 · Rail with ticks

A rail along the right edge of the feed: a long tick per own message, a short
one per machine turn, a window for what is on screen. Pointing at a tick, or
dragging a thumb along the rail, shows the message's first line and the first
line of its reply; releasing lands there. Machine turns are dimmed.

### 4 · Table of contents

A list of own messages: time, first lines of the message, first line of the
reply. A side panel on the desktop, a bottom sheet on the phone. It lists the
whole conversation, including messages outside the loaded window.

### The five questions

| | 1 Arrows | 2 "Mine" mode | 3 Rail | 4 Contents |
| --- | --- | --- | --- | --- |
| Jump: pointer | the pill's arrows | the switch, then an ordinary scroll | a tick | an entry |
| Jump: keyboard | `Alt+↑` `Alt+↓` | `Alt+M`, `Alt+↑` `Alt+↓` | `Alt+↑` `Alt+↓` | `Alt+O`, `Alt+↑` `Alt+↓` |
| Jump: phone | 44 px arrows above the composer | "Mine" chip above the composer, then a scroll | drag along a 44 px rail | "Contents" chip, then a row |
| Replies to own messages | accent rule and caption | the only replies left on screen | full contrast against dimmed ones | first line in the list; the picked one gets the rule |
| Machine turns | left alone | folded to one row per stretch | dimmed | left alone |
| Where it lives, desktop | bottom right of the feed | conversation header | right edge of the feed | header button and a 340 px side panel |
| Where it lives, 390 px | bottom right, above the composer | chip bottom right; a strip above the composer while on | right edge, full height | chip bottom right; sheet over the feed |
| Back to the full conversation | nothing to undo | one press: "Whole conversation", `Esc` | one press: the eye at the foot of the rail | one press: close the panel or the sheet |
| Older history not loaded | counter reads `1 / 7+`; the up arrow turns into "load earlier" and lands on the next older one | count reads `7+`; a row at the top loads earlier pages | a dashed cap on the rail loads them; ticks re-space | unloaded entries are listed and marked; picking one loads up to it |

## 5. What each is best at, and what it costs

1. **Arrows.** Best at the first half of the ask with the least on screen: one
   small control and nothing else changes. It costs the second half: replies to
   wakes still fill the screen between own messages, and the operator sees one
   message at a time with no overview. Cheapest to build.
2. **"Mine" mode.** Best at the second half: it is the only variant where the
   replies to wakes are out of the way. Jumping becomes a short scroll. It
   costs a mode: the conversation looks different while it is on, a folded row
   has to be opened to see what a wake did, and with older history unloaded the
   build has to fetch pages that are mostly machine turns to find the next own
   message.
3. **Rail.** Best at showing where own messages sit in the whole evening at a
   glance, and it is always visible without a mode. It costs 45 px of width on
   the phone for the whole conversation, the dimming lowers the contrast of
   text that is still on screen, and the ticks at the top of the rail are far
   from the thumb. Positions shift when older history loads.
4. **Contents.** Best at finding one particular exchange: the first line of
   each reply is readable before jumping, and it is the only variant that
   reaches messages outside the loaded window by name. It costs the most to
   build (the list needs every own message of the conversation, which means a
   server read of the records' authors and loading history up to a picked
   entry), 340 px of desktop width while open, and two taps on the phone.

## 6. Recommendation

**Variant 2**, keeping the keyboard step it already shares with the others.
The ask has two halves and the second one, "the replies to my messages, not to
the ticker and everything else", is the one only the mode answers. Its cost is
contained: one press returns the whole conversation, and a folded stretch
opens in place. Variant 4 is the natural later addition once the mode exists,
because its list is the same set of messages.

## 7. For the build

- Turn boundaries come from the rows the feed already resolves (§1). No change
  to how messages are stored or attributed.
- Interface text is written in Ukrainian inside the prototype. The build moves
  it to both i18n tables.
- With older history unloaded, any count is a floor and says so with a plus.
- The mode has to survive live updates: a wake arriving while it is on joins
  the last folded stretch rather than opening a new row under the operator's
  thumb.

## 8. Frames

```
LLV_CONVERSATION_BROWSER_TEST=1 bun test src/components/conversation/conversationWindow.browser.test.tsx -t "own-message navigation"
```

writes 18 frames, each variant at 1440 px and at 390 px in the dark theme with
its number in the band above the conversation. They are not committed: the
publication gate admits a raster only when an in-repo generator reproduces it
byte for byte, which a browser capture cannot do.
