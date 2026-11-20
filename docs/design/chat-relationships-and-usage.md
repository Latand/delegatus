# Chat relationships, pull requests, and token usage

## Chat titles and relationships

The desktop **Chats** list groups conversations by recorded parentage. Expand a
parent to see its loaded children and open each conversation independently.
Each page has a fixed row limit. Opening a branch or choosing **Load more**
reveals older rows. Large collapsed branches pause automatic paging when a
page adds no visible rows.

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
