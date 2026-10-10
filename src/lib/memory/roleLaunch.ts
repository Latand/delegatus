import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { MAX_STRUCTURED_TEXT_BYTES } from "@/lib/runtime/structuredContent";

import { insertLearnedRules, LEARNED_RULES_HEADING } from "./roleRender";

/* The learned rules enter a launch message only at dispatch, after the stage
   input composer has run, so no file the composer writes into the checkout
   and no persisted pipeline prompt holds rule text. A block that would push
   the message past the structured envelope is written under the state
   directory, outside every checkout, and the message points at it. The
   composer leaves room for that pointer (learnedRulesReserve), so an eligible
   stage never launches without its rules. */

export function learnedRulesFile(block: string): string {
  const directory = statePath("role-memory", "launch");
  const file = path.join(directory, `learned-rules-${crypto.createHash("sha256").update(block).digest("hex")}.md`);
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, block, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return file;
}

function learnedRulesReference(block: string): string {
  return `${LEARNED_RULES_HEADING}: in the file ${learnedRulesFile(block)}. Read the full file before working.`;
}

/** The bytes a stage's composed input leaves free for its learned rules: the
    pointer to the rules file and the blank lines around it. */
export function learnedRulesReserve(block: string | null | undefined): number {
  return block ? Buffer.byteLength(learnedRulesReference(block), "utf8") + 3 : 0;
}

/** The launch message with the learned rules: inline when they fit the
    envelope, else a pointer to their file. A message with no room even for
    the pointer is refused before anything is reserved, never sent without them. */
export function withLearnedRules(prompt: string, block: string | null | undefined): string {
  if (!block) return prompt;
  const inline = insertLearnedRules(prompt, block);
  if (Buffer.byteLength(inline, "utf8") <= MAX_STRUCTURED_TEXT_BYTES) return inline;
  const pointed = insertLearnedRules(prompt, learnedRulesReference(block));
  if (Buffer.byteLength(pointed, "utf8") <= MAX_STRUCTURED_TEXT_BYTES) return pointed;
  throw new Error("the stage input leaves no room for its learned rules; compose it with learnedRulesReserve");
}
