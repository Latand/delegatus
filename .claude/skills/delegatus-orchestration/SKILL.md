---
name: delegatus-orchestration
description: Spawn, message, and monitor Claude/Codex agents through Delegatus, the machine's one management surface. Use when launching a worker or reviewer agent, messaging or resuming an existing agent conversation, reading what the operator currently sees on the board, starting an implement→review flow, or working in ~/.agents/tools/live-log-viewer-next.
---

# Delegatus — orchestration

Delegatus (`~/.agents/tools/live-log-viewer-next`) is the user's dashboard for every coding agent on this machine. The prod instance runs at **`http://127.0.0.1:8898`**; its HTTP API is the management surface for agents.

## Hard rules

- **One management surface.** Every agent you start must appear in Delegatus: a Delegatus-owned structured host, plus a transcript the scanner picks up. Detached background-job runtimes (`codex-companion.mjs task`, plugin rescue subagents) create an invisible second control channel — spawn through Delegatus instead.
- **API-first.** While the prod Delegatus is up, all agent interaction — spawn, message, interrupt, kill, flows — goes through its API, which gives the delivery queue, receipts, and idempotency the user watches in the UI. If the probe `curl -sS http://127.0.0.1:8898/api/files >/dev/null` fails, Delegatus is down: there is no fallback transport to reach for. No tmux server runs on this machine — Delegatus spawns engines into the host namespace through `nsenter` — so report the outage to the operator and wait rather than inventing a second control channel.
- **Port 8898 only.** 8899 is a dev/scratch build (`bun dev` default): the user never watches it, and sends to it fail silently the moment it stops. Real spawns, messages, flows, and task actions go to 8898 even when 8899 appears to work.
- **Spawn fresh + empty.** Hand every helper its whole job as the first prompt. Fork (context-inheriting) agents only when the user explicitly asks for a fork this turn — forked agents carry your context and skip the actual task.
- Prompts to agents: English. Codex effort is set at boot (`-c model_reasoning_effort=...`), never mid-conversation.
- **Pipeline boundary.** A session running as a pipeline stage never starts another pipeline or helper. It returns `needs_decision` with the required follow-up. The owning orchestrator materializes that work through the Pipeline API.
- **Prompt = role + scope, nothing else.** Never name the model or reasoning level in the prompt text: effort is a launch parameter that words cannot enable, and the model already knows what it is. Write the role — "You are a fresh-context Reviewer. …" — and pass any runtime override only as a spawn parameter.
- Review fan-out is budget-bound: run at most 1–2 independent review passes; swarms of 5+ reviewers must run as visible pipeline stages.
- **Reviewer isolation (#393).** Reviewer and verifier roles perform every assigned check inside their own single session and have zero child-launch capability: they never launch helpers, workflows, teams, swarms, native subagents, Delegatus children, or MCP children. Multiple review perspectives are always explicit visible pipeline stages, never fan-out from inside a review session.
- **Bounded delegation (#393).** Roles that may delegate (builder, architect, orchestrator) spawn only through Delegatus with lineage recorded (`src`, plus `role`/`reviews` where applicable) and keep the delegation chain within the configured maximum depth — initially two.
- After a worker finishes, keep its session/window: the user inspects and kills it from the UI.
- One orchestrator per file set: while a worker runs, monitor it and review its diff afterwards instead of editing the same files yourself.

## Choosing the agent

An `agent:*` label on a GitHub issue (`Latand/delegatus`) names the owner role; the role registry decides that role's runtime.

The role registry decides the runtime. The seat's mandate ends with its table; a stage or spawn that names no engine, model or effort runs its role's row. Name a runtime only when the operator names one, and set it on the stage, never in the prompt text.

**Review-pass policy (#381).** Run at most **one or two independent review passes** on any change. A review swarm of **five or more reviewers** runs as declared Pipeline API stages the operator sees on the board. Structured Claude hosts deny the native multi-agent tools (`Task`, `Agent`, `Workflow`, `TeamCreate`, `TeamDelete`, `SendMessage`); the owning orchestrator materializes each pipeline helper through the Pipeline API with durable lineage.

**Reviewer isolation and bounded delegation (#393).** An agent spawned as a **reviewer or verifier** does all of its assigned checks itself, inside that one visible session — it must never launch helpers, workflows, teams, swarms, native subagents, Delegatus children, or MCP children. If a review needs more coverage or another perspective, the reviewer reports that in its verdict and the orchestrator adds an explicit pipeline stage the operator can see. Roles that are allowed to delegate (builder, architect, orchestrator) record lineage on every spawn and obey the configured maximum delegation depth, **initially two** (e.g. orchestrator → builder → helper; nothing deeper). Product enforcement of these limits is tracked in #393.

## Spawning

`POST http://127.0.0.1:8898/api/spawn` with `{"title":"<semantic task title>","engine":"codex|claude","model":"<model>","cwd":"<abs dir>","prompt":"<first message>","src":"<your own transcript path>"}` (same-origin: call from localhost without an Origin header).

For generic callers, `src` stays optional. An explicit `src` wins; omission triggers silent caller inference; an unmatched external caller may create a root card. Orchestrators always supply `src` so the intended parent is deterministic and auditable. `src` records lineage in `~/.config/agent-log-viewer/state/handoff-lineage.json`.

### Mandatory pipeline spawn contract

Every implementer, recovery worker, helper, verifier, and reviewer associated with pipeline work runs as a Pipeline API stage. The owning orchestrator creates the pipeline through `POST /api/pipelines`, retries a parked clean stage through `PATCH /api/pipelines/<id>` with `{"action":"retry-stage"}`, or creates an explicit successor pipeline from a committed head when the prior container is terminal. Direct generic `/api/spawn` calls serve work with no pipeline identity.

`retry-stage` resets the worktree to `lastPassedCommit` and cleans untracked files. Require a clean worktree or explicit operator authorization for that rollback. A dead host that leaves a dirty worktree stays `needs_decision`; preserve the diff and use the recovery-stage adoption path tracked in #387 when available.

When creating a pipeline, the orchestrator passes its transcript as `src`. The pipeline controller then reserves a stable `pipeline_<id>_<stage>_<attempt>` identity and writes the parent edge plus pipeline membership before launching the structured host.

A pipeline stage spawn is accepted only after all of these checks pass:

1. `/api/pipelines` exposes the attempt with its `launchId`, `conversationId`, and `agentPath`.
2. `/api/files` exposes that same path with `durableLineage.parentConversationId` equal to the intended parent.
3. The same `/api/files` row carries the expected pipeline `containerId`, `stageId`, `slot`, role, and round membership.
4. `viewer.snapshot` for the operator active project includes the conversation path in the rendered view. Keep the snapshot response together with the matched `/api/files` lineage row as the grouping evidence.

If the operator view is absent, points at another project, or omits the card, the spawn remains unverified. Open the pipeline project and repeat `viewer.snapshot` before reporting the stage as done. Issue #387 tracks structural parent/container fields in the snapshot response itself.

## Messaging an existing agent

```
TOK=$(tr -d '\n' < ~/.config/agent-log-viewer/token)
curl -sS -X POST "http://127.0.0.1:8898/api/conversation-host?k=$TOK" \
  -H 'content-type: application/json' \
  -d '{"path":"<transcript path>","text":"...","clientMessageId":"<stable-id>"}'
```

- `path` is the conversation transcript (Claude `~/.claude/projects/**.jsonl`, Codex `~/.codex/sessions/**.jsonl`); Delegatus resolves it to the conversation's live host, or resumes/respawns one. The same handlers are still mounted at the legacy path `/api/tmux`; that name is historical and no tmux is involved.
- `clientMessageId` makes retries idempotent; give each distinct message its own id — reusing one across different messages fails with `Idempotency key already belongs to another request`.
- Receipt outcomes: `delivered-to-live | queued | delivering | delivered | resumed | held`. Delivery is confirmed when the message appears in the target transcript; replies are readable there too, which makes this endpoint full duplex with any agent.
- Actions on the same endpoint: `{"action":"interrupt"}` (Escape), `{"action":"kill"}`, `{"action":"resume"}`, `{"action":"compact"}`, `{"action":"dialog-key","key":...}`.

**Session ownership.** Delegatus tracks which process controls each session. `no-claim` / `structured resume host claim is unavailable` means a live process outside Delegatus owns the target session — Delegatus correctly refuses to write into it, and the session stays read-only (live tail) until that owner exits. To bring such a session under viewer control, act through the owning process; as a last resort kill it and let Delegatus resume the session as its own structured host, after which structured delivery with receipts works.

## Reading the operator's live view

`GET http://127.0.0.1:8898/api/agent` returns the self-describing capability manifest. The `viewer.snapshot` capability — `POST /api/agent/snapshot` with `{"schemaVersion":1}` — returns what the human is looking at right now: active project and view mode, viewport/camera, focused/selected/visible conversation paths in visual order, each conversation's activity and attention state, and bounded secret-redacted transcript text for the requested `scope` (`focused | selected | visible | focused-selected | paths`).

- Multi-device: default picks the latest-interacted view, alternatives listed; pin with `view.id`. `409 AMBIGUOUS_ACTIVE_VIEW` → pick an alternative and retry.
- `404 NO_ACTIVE_VIEW` = nobody is watching (presence is in-memory; it republishes on the next browser heartbeat).
- Snapshots are inert reads — safe to poll before deciding whom to spawn or message.
- Loopback needs no token; remote callers use `Authorization: Bearer <LLV_TOKEN>`.

## Board maintenance

The operator triggers this capability with “run board maintenance” and natural variants such as
“clean up the board”, “fix the chat names”, “tidy the review cards”, and “reconcile
associations”. Read [references/board-maintenance.md](references/board-maintenance.md) completely,
then follow its scope, evidence, mutation, safety, verification, and reporting contracts.

Board maintenance changes reversible Delegatus metadata only. Preserve every transcript and active
conversation, validate every rename and association, and hide an older review card only after a
newer card is proven to represent the same review lane.

## Implement→review flows

Delegatus runs implement→review cycles itself (spec: `docs/review-loop-ui.md`): long-lived implementer pane + fresh headless reviewer per round, `REVIEW_READY:` marker protocol, verdicts under `~/.config/agent-log-viewer/state/flows/`. API: `GET/POST /api/flows`, `PATCH /api/flows/<id>` (`pause|resume|advance|retry-round|extend|another-round|close`). Pipeline work declares a `review-loop` stage so the controller creates the flow with pipeline membership. Standalone implement→review work may start a flow directly.

## Data roots Delegatus watches

| root | path |
|---|---|
| codex sessions | `~/.codex/sessions` |
| claude sessions | `~/.claude/projects` |
| codex plugin jobs | `~/.claude/plugins/data/codex-openai-codex/state` |
| claude bg tasks | `/tmp/claude-<uid>/<slug>/<sid>/tasks/*.output` |

Interactive `claude`/`codex` processes are auto-matched to their transcripts (fd holders, `--session-id` argv, cwd), so a correctly spawned agent appears in the UI with composer, kill, and interrupt controls.
