import fs from "node:fs";
import { redactBounded, redactMonitorText } from "@/lib/monitor/redact";
import { PRIVATE_KEY_BLOCK } from "@/lib/view/compactText";

const PRIVATE_KEY_HEADER = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
/** Bytes of a startup stderr file read for a diagnostic. */
export const STDERR_READ_BYTES = 8192;

/** A key block whose footer was clipped (or never printed) matches no complete-block
 * pattern, so its payload is cut from the header on before redaction sees the text. */
export function withoutUnterminatedSecret(text: string): string {
  const complete = text.replace(PRIVATE_KEY_BLOCK, "[redacted]");
  const header = PRIVATE_KEY_HEADER.exec(complete);
  return header ? `${complete.slice(0, header.index)}[redacted]` : complete;
}

/** Reads the first complete lines of a startup stderr file and redacts them.
 * Cutting a raw tail can expose a suffix of a credential whose header fell
 * outside the retained bytes, so a long file keeps its head. */
export function startupStderrText(fd: number, size: number, limit = 2048): string {
  const bytes = Buffer.alloc(Math.min(size, STDERR_READ_BYTES));
  fs.readSync(fd, bytes, 0, bytes.length, 0);
  let text = bytes.toString("utf8");
  const readClipped = size > bytes.length;
  if (readClipped) text = text.slice(0, Math.max(0, text.lastIndexOf("\n")));
  const redacted = redactMonitorText(withoutUnterminatedSecret(text)).trim();
  if (!readClipped && redacted.length <= limit) return redacted;
  // Reserve the notice after redaction and both caps: a partial drain can
  // exceed the text limit before reaching the read limit.
  const notice = "[stderr clipped]".slice(0, Math.max(0, limit));
  const contentLimit = limit - notice.length - 1;
  const content = contentLimit > 0 ? redactBounded(redacted, contentLimit) : "";
  return content ? `${content}\n${notice}` : notice;
}
