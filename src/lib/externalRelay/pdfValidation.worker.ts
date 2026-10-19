import fs from "node:fs/promises";
import { parentPort, threadId, workerData } from "node:worker_threads";

type Job = { filename: string; maxBytes: number };
const job = workerData as Job;
parentPort?.postMessage({ type: "started", workerThreadId: threadId });
try {
  const stat = await fs.stat(job.filename);
  if (!stat.isFile() || stat.size > job.maxBytes) throw new Error("PDF size limit exceeded");
  const bytes = await fs.readFile(job.filename);
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = getDocument({ data: Uint8Array.from(bytes), isEvalSupported: false,
    useSystemFonts: false, stopAtErrors: true, verbosity: 0 } as Parameters<typeof getDocument>[0]);
  try {
    const document = await loading.promise;
    if (!Number.isInteger(document.numPages) || document.numPages < 1) throw new Error("PDF has no pages");
    await document.getPage(1);
  } finally { await loading.destroy().catch(() => {}); }
  parentPort?.postMessage({ ok: true, workerThreadId: threadId });
} catch {
  parentPort?.postMessage({ ok: false, workerThreadId: threadId });
}
