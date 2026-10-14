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
the data; in a replay its peak memory fell from about 380 MB to 110 MB.
These reads need Delegatus running. See
[the memory replay](../investigations/mcp-memory-retention.md).

## The tools

The tools, by area:

- **conversations:** `list_conversations`, `get_conversation`,
  `conversation_messages`, `search_transcripts`, `search_memory`,
  `send_message`,
  `message_receipt`, `conversation_deliverability`, `conversation_action`
  (interrupt, kill, resume, compact), `spawn_agent` (with an optional
  `account`), `suggest_replies`;
- **board and tasks:** `board_snapshot`, `create_task`, `list_tasks`,
  `get_task`, `update_task`, and `publish_prototype_review` and
  `read_prototype_review`, which post numbered variants to a task for you to
  choose from and read back your choice;
  `resend_prototype_review_telegram` sends a round again by `reviewId`, within
  the caller's project. Reusing `clientRequestId` replays the result; use a
  fresh key for an intentional new copy;
- **pipelines:** `create_pipeline`, `list_pipelines`, `get_pipeline`,
  `pipeline_action`, `link_task_to_pipeline`, `stage_report`, which a
  stage agent calls to report its verdict, and `leave_lesson`, which stores
  the rule it leaves for the next agents or rewrites one it was given, and
  `curate_rules`, the curator's own tool;
- **review flows:** `list_flows`, `get_flow`, `flow_action`;
- **the orchestrator seat:** `create_orchestrator`, `get_orchestrator`,
  `rotate_orchestrator`, `send_message_to_orchestrator`,
  `seat_tick_settings`, `bridge_report` (files an entry in the Reports log),
  `bridge_directive`. Work for another project goes from seat to seat: a
  seat's `create_task`, `create_pipeline` or `spawn_agent` on another project
  is refused with a pointer to `send_message_to_orchestrator`, which
  designates that project's orchestrator first when it has none, unless you
  asked for it and the seat quotes your request in `crossProjectRequest`.
  A project can be named by its key, display name or repository folder, in
  any letter case, and is found without waiting for a scan. A name that fits
  several projects is refused with the candidates, and an unknown one with
  the closest matches. A `create_task` given a name stores the project's key;
  optional `project` on `create_pipeline` and `spawn_agent` must agree with
  `repoDir` and `cwd`, respectively;
- **accounts:** `account_limits`, `account_project_binding`,
  `conversation_migration`;
- **roles:** `role_presets` reads which engine, model and effort each role
  runs on and, for the orchestrator seat and your own session, changes them
  (the same patch as **Roles: engine and model** in Settings; a model outside the launch
  catalogue is refused, and every write is logged to `role-presets-audit.jsonl`
  beside `role-presets.json`);
- **updates:** `auto_updates` reads the automatic-update state the Update
  dialog shows and, for the Delegatus project's orchestrator seat and your own
  session, turns automatic updates on or off (the same switch as the dialog;
  each switch is listed in the dialog's history with who made it);
- **bug reports:** `issue_report` takes a Delegatus bug report from preview to
  publication. An orchestrator that hits a Delegatus failure asks you first,
  then an `issue-reporter` writes the report, runs the advisory hint tool and
  re-reads the whole text to make its own privacy judgment. A hint may be a false
  alarm; a clean result proves nothing. The orchestrator shows the exact title
  and body in chat with the agent's judgment and remaining hints as a short list.
  You decide last and may approve text with hints. The approving reply names the
  whole digest of that text. Publication takes the
  preview's digest and reads your reply in the conversation itself: nothing
  the orchestrator says about your answer counts, a reply for an earlier
  wording does not carry over, and one preview is filed once;
- **Telegram bot:** `telegram_bot_chats`, `telegram_bot_send` (posts to a
  chat you allowed in the Telegram panel, signed with the calling
  conversation), `telegram_bot_send_document` (posts a report file from
  a document folder you set in the Telegram panel, `handoff/` in your
  home by default, after a type, size and secret check),
  `telegram_bot_send_media` (a JPEG or PNG photo, or an album, with
  captions, from the same folders), `telegram_bot_messages` (what the bot received, newest first);
- **you and the machine:** `operator_snapshot`, `request_attention`,
  `dismiss_attention`, `agent_activity`, `agent_fleet` (one compact count
  of live agents by engine, model, effort and account), `lifecycle_events`,
  `resources`,
  `deployment_status`, `deploy_exact_sha`, and `backfill_worktree_projects`,
  a read-only preview of how deleted worktrees regroup under their
  repository.

## Moving your view and clearing a flag

`request_attention` moves your open Delegatus view to a conversation, task
or other target and returns once the browser gets there. It does not wait
for your reply, and a Return button takes you back. On a phone it shows a
notice and moves nothing. `dismiss_attention` clears a card's "needs you"
flag until something new comes up, the same as the card's Dismiss; called
without a target, it reads the project's **Needs you** list.

## Repeating a call

Every call takes a `clientRequestId`. Repeat a call with the same id and
arguments and you get the first result back, with no second action. Calls to
the `viewer` server show in transcripts as cards, and the ids in them link to
the conversation, task or pipeline they name.
