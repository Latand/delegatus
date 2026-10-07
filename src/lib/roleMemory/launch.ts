import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { MAX_STRUCTURED_TEXT_BYTES } from "@/lib/runtime/structuredContent";

import { insertLearnedRules, LEARNED_RULES_HEADING } from "./render";

/* The learned rules enter a launch message only at dispatch, after the stage
   input composer has run, so no file the composer writes into the checkout
   and no persisted pipeline prompt holds rule text. A block that would push
   the message past the structured envelope is written under the state
   directory, outside every checkout, and the message points at it. */

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

export function withLearnedRules(prompt: string, block: string | null | undefined): string {
  if (!block) return prompt;
  const inline = insertLearnedRules(prompt, block);
  if (Buffer.byteLength(inline, "utf8") <= MAX_STRUCTURED_TEXT_BYTES) return inline;
  const reference = `${LEARNED_RULES_HEADING}: in the file ${learnedRulesFile(block)}. Read the full file before working.`;
  const pointed = insertLearnedRules(prompt, reference);
  return Buffer.byteLength(pointed, "utf8") <= MAX_STRUCTURED_TEXT_BYTES ? pointed : prompt;
}
