# Chat relationships, pull requests, and token usage

## Chat titles and relationships

The desktop **Chats** list pages main chats by recent activity in each family.
The branch badge shows the full count of direct dependent chats in the scoped
catalog. Each expanded branch has its own **Load more dependent chats**
control. The rail uses **Load more main chats** for the top-level list. The
larger Chats menu can also load its next page of main chats as you scroll.
Paging keeps existing rows and counts in place. A folded branch keeps its
loaded pages while the list is open. Each row shows the conversation engine
and opens its own conversation.

The tree uses the same project-scoped lineage for Claude Desktop chats,
native Codex forks and registry-owned conversations. The flat catalog and
conversation search retain their own pagination.

Delegatus reads native session titles when available and preserves explicit
Delegatus renames. An unnamed imported task can display the title of its
originating conversation. Leaving the rename field with the same title leaves
the task and its undo history alone. Undoing a real rename restores the previous
title source and task text. Legacy imported session placeholders can recover
their linked conversation's name on read. A task card can link to its main
chat's task and to dependent tasks in the same project. Moving a card between
columns changes its task status independently of those relationships.

## Pull requests on chat cards and in Chats

The PR badge appears beside each matching chat in **Chats** and in the header
of its task card, including collapsed cards. A card uses its originating chat
or its sole linked conversation. Hover over the badge or focus it and press
Enter. The list opens beside the badge when there is room. Escape closes it.
Each row opens the pull request on GitHub. The newest mention of each pull
request determines its place in the list.

The list reads GitHub PR URLs in up to 384 recent indexed messages per visible
chat, with up to 32 distinct links. A plus sign indicates partial history.
Titles, states, and line counts come from the local forge cache when
available. A referenced PR with no cached state remains a link with an
unknown state. Team members receive cached metadata only for the project's
recorded GitHub repository. The panel works from existing indexes and never
requests a GitHub refresh of its own.

On the board, including **In progress**, a badge appears when the card has an
identifiable conversation and its indexed messages contain a PR link. The
branch count in **Chats** counts dependent conversations. The PR badge counts
links in that specific conversation.

## Token usage on task cards

Processed tokens count uncached input, input read from cache, cache creation,
and output. Repeated reads of the same cached context can account for most of
a long chat's total. Reasoning and cache-duration subcounts are already
included in their respective totals. A task can cover several conversations.
When tasks share a conversation, their totals overlap.

A task's percentage estimates the equivalent share of one weekly allowance
over its measured history. It requires quota history for calibration. The
account's last weekly reading is a separate measurement. With insufficient
history, the card can show processed tokens and an available account reading.

## Orchestrator transcript

The MCP outcome icon sits at the right edge. Timing and actions sit to its left.
Open actions retain their labels and stack when a narrow pane has two actions.
Clipped tool summaries reveal the full label after a short hover. On desktop,
the reply clock aligns with MCP timing, and read aloud and copy stay together.
The prose keeps its reading width. Scrolling back to the latest message restores
the live tail and removes the fade and the Down button.
