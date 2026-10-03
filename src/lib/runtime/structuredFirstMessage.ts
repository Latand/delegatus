import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { MAX_STRUCTURED_TEXT_BYTES } from "./structuredContent";
import { prepareControllerArtifactDirectory, protectExistingControllerArtifacts } from "@/lib/pipelines/controllerArtifacts";
import { realExec, type ExecPort } from "@/lib/workflows/provision";

const EXCERPT_BYTES = 512;

/** Keep an oversized first message complete and readable while bounding the
 * structured envelope. Call after every scaffold and caller brief are composed,
 * and before spawn admission or durable payload identity is calculated. */
export async function composeStructuredFirstMessage(text: string, worktreeDir: string, exec: ExecPort = realExec): Promise<string> {
  if (Buffer.byteLength(text, "utf8") <= MAX_STRUCTURED_TEXT_BYTES) {
    await protectExistingControllerArtifacts(worktreeDir, exec);
    return text;
  }

  const digest = crypto.createHash("sha256").update(text).digest("hex");
  const directory = await prepareControllerArtifactDirectory(worktreeDir, exec);
  const file = path.join(directory, `structured-first-message-${digest}.md`);
  let matches = false;
  try {
    const existing = fs.lstatSync(file);
    /* A digest in the name does not prove the file still contains the input.
       Avoid following a replaced symlink and repair modified regular files. */
    matches = existing.isFile() && !existing.isSymbolicLink() && fs.readFileSync(file, "utf8") === text;
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (!matches) {
    const temporary = path.join(directory, `.${crypto.randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  const bytes = Buffer.from(text, "utf8");
  let end = Math.min(EXCERPT_BYTES, bytes.byteLength);
  while (end > 0 && end < bytes.byteLength && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return `Full structured first message file: ${file}\nRead the full file before working. Head excerpt:\n${bytes.subarray(0, end).toString("utf8")}\n[Excerpt ends; the file contains the full text.]`;
}
