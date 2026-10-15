# The MCP server

The MCP server gives any agent the same board, tasks, pipelines and
conversations you see in the browser. This page covers registering it for your
own sessions, what it exposes, and how to repeat a call safely.

## Register it for your own sessions

Agents that Delegatus starts get it on their own. To use it from a Claude
Code or Codex session you started yourself, register it once. The package
ships `delegatus-mcp`, a local stdio server that works on the same state as
the web app. Install the package with `bun add -g delegatus-cli` and
register the server under the name `viewer`. The name predates the rename,
and keeping it means tool names (`mcp__viewer__*`) and the permission lists
that name them still match.

```bash
# Claude Code
claude mcp add viewer -s user -- delegatus-mcp
```

```toml
# Codex: ~/.codex/config.toml
[mcp_servers.viewer]
command = "delegatus-mcp"
```

From a clone, point the command at `bin/mcp-server.mjs`, or run
`scripts/install-mcp.sh`. The script registers the server in your Claude
Code and Codex configurations and in every account Delegatus manages.

## Large reads run in Delegatus

For agents Delegatus launches, large reads (pipelines, transcripts, prototype
reviews, activity and lifecycle events) run in Delegatus itself, so each
agent's MCP server returns the same answers without keeping its own copy of
the data. These reads need Delegatus running. See
[the memory replay](../investigations/mcp-memory-retention.md).

## The tools

One line per area:

- **Conversations.** Read, search, message and steer agents: `list_conversations`, `get_conversation`, `conversation_messages`, `search_transcripts`, `search_memory`, `send_message`, `message_receipt`, `conversation_deliverability`, `conversation_action`, `spawn_agent`, `suggest_replies`.
- **Board and tasks.** `board_snapshot`, `create_task`, `list_tasks`, `get_task`, `update_task`. `publish_prototype_review`, `read_prototype_review` and `resend_prototype_review_telegram` post numbered variants for you to choose from and read your choice back.
- **Pipelines.** `create_pipeline`, `list_pipelines`, `get_pipeline`, `pipeline_action`, `link_task_to_pipeline`. A stage agent calls `stage_report` for its verdict and `leave_lesson` for the rule it leaves; `curate_rules` is the curator's.
- **Review flows.** `list_flows`, `get_flow`, `flow_action`.
- **The orchestrator seat.** `create_orchestrator`, `get_orchestrator`, `rotate_orchestrator`, `send_message_to_orchestrator`, `seat_tick_settings`, `bridge_report`, `bridge_directive`. See [work across projects](#work-across-projects).
- **Accounts.** `account_limits`, `account_project_binding`, `conversation_migration`.
- **Roles.** `role_presets` reads which engine, model and effort each role runs on. The orchestrator seat and your own session can change them, as **Roles: engine and model** in Settings does.
- **Updates.** `auto_updates` reads the Update dialog's state. The Delegatus project's seat and your own session can turn automatic updates on or off.
- **Bug reports.** `issue_report`. See [bug reports](#bug-reports).
- **Telegram bot.** `telegram_bot_chats`, `telegram_bot_send`, `telegram_bot_send_document`, `telegram_bot_send_media` and `telegram_bot_messages` post to chats you allowed in the Telegram panel and read what the bot received.
- **You and the machine.** `operator_snapshot`, `request_attention`, `dismiss_attention`, `agent_activity`, `agent_fleet`, `lifecycle_events`, `resources`, `deployment_status`, `deploy_exact_sha`, `backfill_worktree_projects`.

### Work across projects

Work for another project goes from seat to seat. A seat's `create_task`,
`create_pipeline` or `spawn_agent` on another project is refused and points
to `send_message_to_orchestrator`, which designates that project's
orchestrator first when it has none. The exception is work you asked for:
the seat quotes your request in `crossProjectRequest`.

A project can be named by its key, display name or repository folder, in any
letter case. A name that fits several projects is refused with the
candidates, and an unknown one with the closest matches.

### Bug reports

When an orchestrator hits a Delegatus failure, it asks you first. An
`issue-reporter` then writes the report and checks its privacy. The
orchestrator shows you the exact title and body in chat, and you decide last,
even when the privacy hints are not clean. You approve by replying in the
conversation itself. Your reply names the whole text it approves, so a reply
for an earlier wording does not carry over, and one preview is filed once.

## Moving your view and clearing a flag

`request_attention` moves your open Delegatus view to a conversation, task
or other target and returns once the browser gets there. It does not wait
for your reply, and a Return button takes you back. On a phone it shows a
notice and moves nothing. `dismiss_attention` clears a card's "needs you"
flag until something new comes up, the same as the card's Dismiss; called
without a target, it reads the project's **Needs you** list.

## Approving an external Claude session

A Claude session started outside Delegatus needs your explicit approval before
attributed mutations and receipt recovery. Its first call creates an association
request in **Waiting for you → Decisions**. Verify the displayed engine,
working directory, process start time and transcript against your terminal,
then approve that exact process and generation. The agent repeats its original
call with the same `clientRequestId`.

Web approval requires signing in through the linked Telegram account of the
installation's paired owner. An authorized explicit answer through that owner's
relay also works. Local access, the Viewer access key, a newly claimed owner
account and a local passkey session cannot approve an association. If paired-owner
authorization is unavailable, the session stays unidentified. Set up the owner
pairing and Telegram sign-in before approving it. Approvals saved before this
authorization requirement need fresh approval.

Approval belongs to that live process and transcript generation. A resumed
session in a new process needs its own approval before recovering an old key.
The approved record stays in the existing **Decisions** column. Press
**Revoke access** there to withdraw access; approved records add no waiting badge.
A sibling session's PID record cannot inherit another session's approval.

Native admission is supported on Linux over stdio. Merge these hooks into your
Claude settings alongside any existing hooks, then restart Claude. Keep them
synchronous; `PreToolUse` adds a fresh session proof automatically and changes
no tool permission decision. Session changes and process exit end the old
approval. Claude documents these lifecycle events and input replacement in its
[hooks reference](https://code.claude.com/docs/en/hooks).

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "delegatus-mcp --native-caller-hook" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "delegatus-mcp --native-caller-hook" }] }],
    "PreToolUse": [{
      "matcher": "mcp__viewer__.*",
      "hooks": [{ "type": "command", "command": "delegatus-mcp --native-caller-hook", "timeout": 30 }]
    }]
  }
}
```

Use the updated Delegatus package for both the stdio server and the hook.
Missing, expired, replayed or mismatched proof is refused with
`session-proof-unavailable`; repeat the original call through the configured
hook, or open the conversation in Delegatus and continue under its host.
Hook input is bounded to 4 MiB. Proof expires after five minutes and is used
once; a fresh proof on a retry retains the original `clientRequestId` and
logical arguments. Never copy a proof into another call.

## Repeating a call

Every call takes a `clientRequestId`. Repeat a call with the same id and
arguments and you get the first result back, with no second action. Calls to
the `viewer` server show in transcripts as cards, and the ids in them link to
the conversation, task or pipeline they name.
