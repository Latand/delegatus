# A send to a busy Claude session no longer interrupts it

On 2026-10-15 the operator sent extra instructions to a Claude session hosted
by the structured stream host while it was running a tool. The model received
them after Claude Code's tool-rejection text: "The user doesn't want to proceed
with this tool use. The tool use was rejected (eg. if it was a file edit, the
new_string was NOT written to the file). STOP what you are doing and wait for
the user to tell you how to proceed."

## The path a composer send took

Line numbers are at `011a4fe97`, the base of this change.

1. The composer submits with no policy chosen, so the send carries
   `interrupt-active` (`src/components/TmuxComposer.tsx:3595`, `:4007`;
   `src/hooks/useRuntime.ts:354`). A held delivery without a command gets the
   same default (`src/lib/runtime/structuredMessageDelivery.ts:1129`, `:1878`).
   MCP `send_message` and `send_message_to_orchestrator` send `steer-or-queue`
   (`src/lib/mcp/bindings.ts:1721`, `:4064`) and were not affected.
2. The delivery queue treats every `interrupt-active` send as a replacement
   for the running turn (`src/lib/runtime/structuredDeliveryQueue.ts:1943`).
   For an active turn, or one awaiting a permission answer, that sets
   `shouldInterrupt` (`:1947`) and the queue calls `host.interrupt` before it
   writes the message (`:2089`).
3. The Claude broker answers with a `control_request` of subtype `interrupt`
   on the CLI's stdin (`src/lib/runtime/claudeStreamBrokerHost.ts:1076`,
   `:1088`).
4. Claude Code 2.1.296 aborts the running tool call with the reason
   `interrupt`, which it maps to the same rejection text and denial kind it
   uses for a refused permission. Its turn ends `error_during_execution`. The
   queue then writes the operator's message as the next turn, and the next
   Messages API request carries, in one user message: the rejected
   `tool_result`, `[Request interrupted by user for tool use]`, and the
   operator's text.

## What the CLI supports instead

Probed against the installed Claude Code 2.1.296 with a loopback Messages API
on port 0 (synthetic credential, isolated HOME, config, TMPDIR and state):

- A user frame held by Delegatus until the turn's `result` and written then
  starts the next turn. The tool call finishes and returns its real output.
- A user frame written to stdin while the tool runs is also accepted: the CLI
  lets the tool finish and adds "The user sent a new message while you were
  working" to the next model request in the same turn. Both inputs then end
  with one `result`. This is the combined-input case #2743 contained
  (`docs/verification/claude-queued-send-containment.md`): one result for two
  inputs leaves no per-input boundary for the broker's receipts, so mid-turn
  writes stay disabled until #2742 settles that identity.

## The change

`ClaudeStreamBrokerHost` declares `sendWaitsForRunningTurn`
(`src/lib/runtime/engineHost.ts`). The delivery queue does not treat an
`interrupt-active` send to such a host as a replacement. The send stays
`queued` while the turn runs or awaits an answer. It is written as the next
turn's user message once the host is idle, with no turn fence. The explicit
interrupt control (the composer's Stop, `conversation_action` with
`interrupt`) is a separate operation and still writes the `interrupt` control
request. Codex steering and Copilot's interrupt-and-resend are unchanged:
neither host declares the capability.

An operator send still goes ahead of earlier queued agent follow-ups (#2743).
It now waits for the incumbent's own result.

## Evidence

All runs used explicit isolated HOME, XDG_CONFIG_HOME, TMPDIR and
LLV_STATE_DIR roots, `LLV_VIEWER_CONTROL_URL` on a closed port, and the owned
gate runner. No live session was messaged or interrupted.

- Installed CLI, base: the default operator send during a running `Bash` call
  wrote one `interrupt` control request. The next API request carried the
  rejected `tool_result` with the text above, then the interruption marker,
  then the message.
- Installed CLI, with the change:
  `src/lib/runtime/claudeStreamBrokerHost.nativeQueue.test.ts` "installed
  Claude keeps a running tool call when the operator sends to the busy turn".
  No control request is written. The tool call ends with its own output
  (`is_error: false`), the model request after it does not contain the
  message, the next turn's request does, and neither request contains the
  rejection text or the interruption marker. Both turns end `completed`. On
  the base this test fails on the `interrupt` control request.
- Host boundary with the scripted CLI:
  `src/lib/runtime/claudeStreamBrokerHost.test.ts` "an ordinary operator send
  to a busy Claude turn arrives as the next user message, never an interrupt",
  for a running tool and for a pending permission request. The send stays
  `queued`, nothing reaches stdin until the incumbent's `result`, the first
  user frame after it is the message, and an explicit interrupt operation
  then still writes `{"subtype":"interrupt"}`. Both cases fail on the base.
- The #2743 replacement regression now asserts the operator send reaches past
  deferred follow-ups without an interrupt, for active and permission
  pathways and all predecessor origins. All 12 of its operator cases fail on
  the base.

The native test is opt-in:

```sh
sandbox=$(mktemp -d)
mkdir -p "$sandbox/home" "$sandbox/config" "$sandbox/tmp" "$sandbox/state"
HOME="$sandbox/home" XDG_CONFIG_HOME="$sandbox/config" \
TMPDIR="$sandbox/tmp" LLV_STATE_DIR="$sandbox/state" \
LLV_CLAUDE_BINARY="$(command -v claude)" \
bash scripts/gate-slot.sh bun test src/lib/runtime/claudeStreamBrokerHost.nativeQueue.test.ts
```

## Limits

A message to a busy Claude session reaches the model when the running turn
ends, which can be long after it was sent. Delivering it mid-turn depends on
#2742. A send queued while a permission request is open waits until that
request is answered, expires or the turn is stopped.
