/**
 * Issue #1792 — a settled Claude turn must not project a busy authoritative
 * turn.
 *
 * The composer, the card and the files projection all read one predicate,
 * `FileEntry.authoritativeTurn`, built by the production scan below. Claude's
 * CLI writes no top-level `result` record into a session transcript, so the
 * authoritative branch of the turn projection had no terminal evidence at all
 * and every finished Claude turn read `busy` for ever: a send held for the turn
 * to end was held for a turn that had already ended.
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
  runningClaudeTurnRecords,
  settledClaudeTurnRecords,
  transcriptBody,
} = await import("@/lib/accounts/migration/fixtures/claudeSettledTurn");
const { listFiles } = await import("./index");
const { turnLeftOpen } = await import("@/components/turnDuration");

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
