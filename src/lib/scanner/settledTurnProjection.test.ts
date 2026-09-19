/**
 * Issue #1792 — a settled Claude turn must not project a busy authoritative
 * turn.
 *
 * The card (through `turnLeftOpen`) and the files projection both read one
 * predicate, `FileEntry.authoritativeTurn`, built by the production scan below.
 * The composer does NOT: its turn axis is the host ledger's `activeTurnRef`,
 * which the structured delivery controller reads and the send queue parks on.
 * So this is the transcript-derived axis, brought back into agreement with the
 * host one rather than collapsed into it.
 *
 * Claude's CLI writes no top-level `result` record into a session transcript,
 * so the authoritative branch of the turn projection had no terminal evidence
 * at all and every finished Claude turn read `busy` for ever: a send held for
 * the turn to end was held for a turn that had already ended.
 *
 * This runs the PRODUCTION scan (`listFiles`, the same walk `/api/files`
 * serves) over a transcript written the way the CLI writes one, rather than
 * feeding a pre-settled turn to the projection and asserting it stayed settled.
 */

import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-settled-turn-"));
const previousStateDir = process.env.LLV_STATE_DIR;
const previousClaudeHome = process.env.LLV_CLAUDE_HOME;
const previousCodexHome = process.env.LLV_CODEX_HOME;
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
process.env.LLV_CLAUDE_HOME = path.join(sandbox, "claude");
process.env.LLV_CODEX_HOME = path.join(sandbox, "codex");

const {
  SETTLED_TURN_ENDED_AT,
  outstandingToolClaudeTurnRecords,
  runningClaudeTurnRecords,
  settledClaudeTurnRecords,
  transcriptBody,
} = await import("@/lib/accounts/migration/fixtures/claudeSettledTurn");
const { listFiles } = await import("./index");
const { turnLeftOpen } = await import("@/components/turnDuration");
const { shouldCollapseWorker } = await import("@/components/scheme/workerCollapse");
type CollapseContext = Parameters<typeof shouldCollapseWorker>[1];

const projects = path.join(process.env.LLV_CLAUDE_HOME!, "projects", "-workspace-demo");
fs.mkdirSync(projects, { recursive: true });

/** Written an hour ago: the reported conversation had been quiet for 25 minutes
    when the operator wrote to it, so the scan reads it as idle by age. */
function seed(name: string, body: string): string {
  const pathname = path.join(projects, name);
  fs.writeFileSync(pathname, body);
  const when = new Date(Date.now() - 3_600_000);
  fs.utimesSync(pathname, when, when);
  return pathname;
}

const settled = seed("settled.jsonl", transcriptBody(settledClaudeTurnRecords()));
const running = seed("running.jsonl", transcriptBody(runningClaudeTurnRecords()));
const outstanding = seed("outstanding.jsonl", transcriptBody(outstandingToolClaudeTurnRecords()));

afterAll(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  if (previousClaudeHome === undefined) delete process.env.LLV_CLAUDE_HOME;
  else process.env.LLV_CLAUDE_HOME = previousClaudeHome;
  if (previousCodexHome === undefined) delete process.env.LLV_CODEX_HOME;
  else process.env.LLV_CODEX_HOME = previousCodexHome;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("issue 1792: the files projection reports a settled Claude turn as terminal", async () => {
  const entries = await listFiles();
  const entry = entries.find((candidate) => candidate.path === settled);
  if (!entry) throw new Error("the production scan did not discover the seeded transcript");

  /* The activity axis already said the turn was over; the authoritative turn
     the composer reads said the opposite in the same object. */
  expect(entry.activity).toBe("idle");
  expect(entry.activityReason).toBe("jsonl_turn_completed");
  expect(entry.lastTurn?.endedAt).not.toBeNull();
  expect(entry.authoritativeTurn).toEqual({
    state: "terminal",
    source: "lifecycle",
    terminalAt: SETTLED_TURN_ENDED_AT,
  });
  /* The card's own question about the same turn, from the same predicate. */
  expect(turnLeftOpen(entry)).toBe(false);
});

test("issue 1792: an outstanding tool call still projects a busy Claude turn", async () => {
  const entries = await listFiles();
  const entry = entries.find((candidate) => candidate.path === running);
  if (!entry) throw new Error("the production scan did not discover the seeded transcript");

  expect(entry.authoritativeTurn).toEqual({ state: "busy", source: "assistant", terminalAt: null });
  expect(turnLeftOpen(entry)).toBe(true);
});

/* The stop reason alone is not a statement that no tool call is outstanding.
   The CLI splits one API message that asked for several parallel tools into one
   record per content block, each under the same message id with a rising
   `apiBlockIndex`, and each carries the whole message's `end_turn` stop reason
   while its own tool call is still pending — 183 such records sit across 29 of
   1276 local Claude transcripts, every one of them answered within seconds and
   none of them the last record of its file. Reading the stop reason there would
   inject a queued message into the middle of a running turn, which is what a
   turn axis exists to prevent. */
test("issue 1792: an end_turn record still carrying a tool_use block projects a busy turn on both axes", async () => {
  const entries = await listFiles();
  const entry = entries.find((candidate) => candidate.path === outstanding);
  if (!entry) throw new Error("the production scan did not discover the seeded transcript");

  expect(entry.authoritativeTurn).toEqual({ state: "busy", source: "assistant", terminalAt: null });
  expect(turnLeftOpen(entry)).toBe(true);
  /* The activity axis reads the same records through the other branch of the
     same projection, and has to reach the same verdict about this turn. */
  expect(entry.activityReason).toBe("jsonl_turn_stalled");
});

/**
 * The board consequence, asserted rather than described.
 *
 * `conversationSettled` folds a card on `authoritativeTurn.state === "terminal"`
 * and that branch never fired for Claude, so this fix changes what the board
 * shows. It is reached: a scanned session transcript carries `proc: null` — the
 * scanner only ever marks a transcript `running`, and `done` belongs to a
 * claude-tasks output — so neither the `done` short-circuit above the turn
 * branch nor the `running` collapse exemption holds these cards, and the turn is
 * what decides them. Both entries come out of the production scan, so the fold
 * is read off the same evidence the board reads.
 */
test("issue 1792: the settled turn is what folds the card, and a busy one still holds it", async () => {
  const entries = await listFiles();
  /* The board context a conversation outside every lane is projected with:
     no flow, no pipeline stage, nothing pinned. The turn is the only
     evidence left for the fold to key off. */
  const context: CollapseContext = { pinnedPaths: new Set(), flows: [], pipelineStagePaths: new Set() };
  const settledEntry = entries.find((candidate) => candidate.path === settled);
  const runningEntry = entries.find((candidate) => candidate.path === running);
  if (!settledEntry || !runningEntry) throw new Error("the production scan did not discover the seeded transcripts");

  expect(settledEntry.proc).toBeNull();
  expect(runningEntry.proc).toBeNull();
  expect(shouldCollapseWorker(settledEntry, context)).toBe(true);
  expect(shouldCollapseWorker(runningEntry, context)).toBe(false);
});
