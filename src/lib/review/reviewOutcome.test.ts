import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SPAWN_COMPLETION } from "@/lib/roles/registry";

import { reviewOutcomeFor, spawnVerdictOutcome } from "./reviewOutcome";

/* docs/design/agent-prompt-contract.md §2.2: a spawned role agent ends with
   "Verdict: pass|fail|needs_decision", and the reviewer's verdict chip (#325)
   reads that line; the retired markers still parse, for history. */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-verdict-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function claudeTranscript(name: string, text: string) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify({ type: "assistant", timestamp: "2026-09-28T10:00:00.000Z", message: { content: [{ type: "text", text }] } })}\n`);
  return { path: file, root: "claude-projects" as const, size: fs.statSync(file).size, mtime: 0 };
}

test("the spawn line the prompt teaches is the line the chip reads", () => {
  for (const word of ["pass", "fail", "needs_decision"]) expect(SPAWN_COMPLETION).toContain(`Verdict: ${word}`);
  expect(spawnVerdictOutcome("Checked the fork's change; nothing blocks.\n\nNotes: a flaky test.\n\nVerdict: pass")).toEqual({ verdict: "APPROVE", findingsCount: 0 });
  expect(spawnVerdictOutcome("Findings:\n\n### Finding 1\n- **Severity:** High\n- **File:** src/a.ts\n- **Line:** 3\n- **Title:** Wrong label\n\nVerdict: fail")).toMatchObject({ verdict: "REQUEST_CHANGES" });
  expect(spawnVerdictOutcome("Which of the two rollout paths do you want?\n\n**Verdict: needs_decision**")).toEqual({ verdict: "COMMENT", findingsCount: 0 });
  /* Only as the closing line: prose that mentions the word decides nothing. */
  expect(spawnVerdictOutcome("Verdict: pass\n\nOne more thing to check before I finish.")).toBeNull();
});

test("a spawned reviewer's card shows its verdict, and the retired markers still read", () => {
  expect(reviewOutcomeFor(claudeTranscript("spawn-pass.jsonl", "Reviewed the fork's pull request.\n\nVerdict: pass"))).toMatchObject({ verdict: "APPROVE", findingsCount: 0 });
  const failed = reviewOutcomeFor(claudeTranscript("spawn-fail.jsonl", "### Finding 1\n- **Severity:** High\n- **File:** src/a.ts\n- **Line:** 3\n- **Title:** Wrong label\n- **Explanation:** The label is inverted.\n\nVerdict: fail"));
  expect(failed).toMatchObject({ verdict: "REQUEST_CHANGES" });
  expect(failed!.findingsCount).toBeGreaterThan(0);
  expect(reviewOutcomeFor(claudeTranscript("spawn-decision.jsonl", "Cannot judge the migration without production access.\n\nVerdict: needs_decision"))).toMatchObject({ verdict: "COMMENT" });
  expect(reviewOutcomeFor(claudeTranscript("legacy-approve.jsonl", "VERDICT: APPROVE\nNo findings on this head."))).toMatchObject({ verdict: "APPROVE" });
});
