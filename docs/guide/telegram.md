# Telegram and the chat relay

Delegatus connects to Telegram in two ways, and can answer questions from a
relay service's chats. This page covers the bot, your own account, what happens
when Telegram is down, and the external relay.

Delegatus connects to Telegram in two ways, both from the **Telegram** line
in the sidebar's system block.

## The bot

Paste a bot token from @BotFather and choose which chats agents
may post to. Agents post to those chats and read what the bot receives
through the MCP server. An agent can also send one photo or an album of
up to ten (JPEG or PNG, each up to 10 MB) with a caption for each image,
or a report file up to 20 MB (Markdown, text, log, JSON, CSV, HTML, PDF
or an image). Files are sent only from the **Document folders** set in
the panel, `handoff/` in your home by default, and a text file holding a
password or a key is refused. The orchestrator can send its reports to one of these chats.
When the installation's owner replies to a report there, the reply goes to
that project's orchestrator.

## Your own account

Enter your `api_id` and `api_hash` from
my.telegram.org, then scan a QR code with the Telegram app. Delegatus
registers a read-only Telegram MCP server, named `telegram`, for Claude
Code and Codex, so your agents can read your chats and cannot write to
them. The session stays on this machine. The same panel can have an agent
write a daily report on the chats you pick.

## When Telegram is down

Telegram never stops an agent from starting. If the connection is only down,
the start reconnects it, waiting at most twenty seconds. If Telegram was
never set up or you signed out, agents start without the Telegram tool and
nothing asks you. If Telegram needs you, the agent starts without the tool,
and the orchestrator's seat shows one line with what to do; the tool returns
on the next start after you reconnect.

## External relay

A relay service can send this install questions from its own chats.
**Chat relay**, under **Settings** in the sidebar's ⋯ menu (the board's ⋯
menu on a phone), or the **Relay service** step of the setup guide, pairs the
two; **Connect
Celestia** pairs with that service in one click. The install asks
the service for work, so nothing reaches it from outside. Each question is
answered by a one-shot agent on your signed-in Claude or Codex account, with
no shell, no tools and none of your instruction files. A question can come
with who asked it and their rights in the chat, a short memory of the chat
and an index of the service's own tools; when one of those tools fits
better, the agent hands the question back to the service. When the service
offers its tools with a question, the agent can read with them and, for a
requester who is allowed to, perform one action at a time. **Full agent for
the owner**, off by default on each target, runs the relay owner's requests
as ordinary Delegatus agents with full access to this computer. When the
service offers them, the card can create a new clone, and a published
prototype review goes to the paired owner's private chat, where a reply
records the decision. Reading the owner's group history through
`relay_owner_history` stays behind the owner tools switch, off by default.
The card
shows each relay's state and, for each target, the engine, model and effort
it answers with; answers are kept for 30 days. The install picks up new
service features every five minutes, whatever the owner tools switch says,
and acknowledges a question as soon as it takes it.

When the target, the chat or the install is busy, a question waits instead
of failing: it is acknowledged, the service sees the `queued` step if it
shows steps, and it starts once room opens. The wait has a budget of two
minutes from the moment the question was asked, and a question still
waiting ten seconds before the end of that budget is declined as busy.
The budget bounds only the wait: an answer that has started keeps running
under the target's hard cap and may arrive after the two minutes, and a
service that enforces its own deadline can end it there. Member quotas and
accounts with no room answer at once.
The protocol is in [docs/design/relay.md](../design/relay.md).

### Prototype reviews to the relay owner's Telegram

With a relay clone paired, a published review also goes to the owner's
Telegram as carousels, one per variant. A round over Telegram's limits goes
as a compact preview with a link to the full review. A failed or unconfirmed
post stays on the review with its reason and reaches the orchestrator on its
next wake. **Send to Telegram again**, in the review's actions, sends any
round again, older ones included.
