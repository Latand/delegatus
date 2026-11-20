# Chat relationships, pull requests, and token usage

## Chat titles and relationships

The desktop **Chats** list pages main chats by recent activity in each family.
The branch badge shows the full count of direct dependent chats in the scoped
catalog. Each expanded branch has its own **Load more dependent chats**
control. Main and dependent chats load 15 rows per page. The rail uses
**Load more main chats** for the top-level list. The larger Chats menu
loads its next page of main chats as you reach the end.
Paging keeps existing rows and counts in place. A folded branch keeps its
loaded pages while the list is open. Each row shows the conversation engine
and opens its own conversation.

The tree uses the same project-scoped lineage for Claude Desktop chats,
native Codex forks and registry-owned conversations. The flat catalog and
conversation search retain their own pagination. A Codex subagent without a
session title or a usable prompt takes the nickname from its own native
header, including when copied parent metadata follows that header. Cached
board rows with generic titles use the same fallback. For unnamed Codex
sessions, a bounded 512 KiB read can recover the first request after launch
context. Saved and manually edited titles take precedence.

The owner's desktop Chats lists nest Codex subagents under their native
parent thread, even when a subagent worked in another project. Opening
the subagent uses its own project and transcript. The Chats list indents
child rows, and a Codex subagent's row identifies it on hover and focus.
Project-restricted views keep their existing access rules.
Resting over a chat for 100 ms or focusing its row shows its title and the last
message first. The creation time appears underneath in quieter text. Both rows
share the same date and time columns. If the message index is missing or behind,
the tooltip labels the transcript's modification time as **Updated**. Creation
falls back to the time recorded in the session header.

Reloading an existing focus entry on desktop starts on its project board
with the open-agent list retained. Pasting a conversation link or traversing
browser history still opens its target.

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

When Claude records pull requests as attachments to a transcript, the badge
and panel show those links in last-recorded order on both surfaces. Otherwise
the panel uses explicit GitHub PR URLs in the indexed messages, most recent
first. It reads up to 384 indexed messages for Claude and 4,096 for Codex.
The panel shows at most 128 distinct PRs, and a plus sign indicates partial
history. The native attachment reader checks up to 128 MiB of the authorized
transcript and caches the links by file identity. The local forge cache
provides initial titles, states and line counts. A known link whose state has
yet to be read shows **state not read yet**. Team members receive cached
metadata for the project's recorded GitHub repository.

On the board, including **In progress**, a badge represents the originating
chat or the card's sole linked conversation. The branch count in **Chats**
counts dependent conversations. The PR badge counts the selected chat's links.
Subagent PR badges use that subagent's own indexed chat history and its
project's access checks.

The conversation PR route's GET reads the local index and forge cache.
Reloading the dashboard uses that path. The owner or local operator can open
the panel to see 12 references immediately and request a status refresh for
that page after a brief hover. **Show more** displays the next 12 and requests
their status. The panel rechecks the selected page every three minutes in a
visible, focused window while any PR on that page can still change. Closing
the panel stops the timer. A window that regains focus requests a refresh
when its current page is due.

The POST selects the page from the same authorized transcript. It sends only
repository names and PR numbers to GitHub. One Viewer process shares a
four-request queue and a bounded cache across tabs, windows and browser
profiles. It checks the cache again before each queued refresh and starts
GitHub reads at least five seconds apart. Confirmed states are fresh for
three minutes. Missing results, failures and unresolved mergeability wait
at least one minute before another read. Known merged states are reused.

The same GitHub read includes mergeability. A confirmed conflict on an open
or draft PR adds a yellow warning to the badge and to that PR's row in the
panel. GitHub can return unresolved mergeability while computing it. That
result carries no conflict mark.

### Code entry points

| Responsibility | Implementation |
| --- | --- |
| Chat rows, relationship disclosures and timestamps | [DesktopConversations](../../src/components/DesktopConversations.tsx) |
| On-screen badge loading and scoped transcript lookup | [useChatPullRequests](../../src/hooks/useChatPullRequests.ts) and [conversation PR route](../../src/app/api/conversations/pull-requests/route.ts) |
| PR refresh cadence, cache and mergeability | [ChatPullRequestBadge](../../src/components/workLinks/ChatPullRequestBadge.tsx) and [chatPullRequestStatus](../../src/lib/forge/chatPullRequestStatus.ts) |
| Rendered chat and board behaviour with synthetic names and PRs | [Kanban browser evidence](../../src/components/kanban/kanbanBoard.browser.test.tsx), case `chat badges open an ordered PR panel by pointer and keyboard` |

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
