import type { FileHandle } from "node:fs/promises";

/** Read untrusted HTML only while its actual bytes remain within the request budget. */
export async function readEvidenceHtml(handle: FileHandle, maxBytes: number, signal: AbortSignal, timeBudgetMs: number): Promise<Buffer> {
  const deadline = Date.now() + timeBudgetMs;
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    if (signal.aborted) throw new Error("client aborted");
    if (Date.now() >= deadline) throw new Error("artifact time budget exceeded");
    const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - total));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
    if (signal.aborted) throw new Error("client aborted");
    if (Date.now() >= deadline) throw new Error("artifact time budget exceeded");
    if (bytesRead === 0) return Buffer.concat(chunks, total);
    total += bytesRead;
    if (total > maxBytes) throw new Error("artifact exceeds the configured byte bound");
    chunks.push(buffer.subarray(0, bytesRead));
  }
}
