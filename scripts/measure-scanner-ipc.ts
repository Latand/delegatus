import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { Session } from "node:inspector";
import { collectFileScanInWorker } from "../src/lib/scanner/fileScanWorker";
import { guardedContext } from "../src/lib/stateOwnership";

// This replay creates data only in the caller's isolated temp root. Run via
// gate-slot: its outer owned-run deadline contains even a stuck sampled VM.
if (!guardedContext() || !process.env.LLV_STATE_DIR || !process.env.TMPDIR) {
  throw new Error("scanner IPC replay requires an isolated home, state and temp root");
}
const directory = await fs.mkdtemp(path.join(process.env.TMPDIR, "scanner-ipc-replay-"));
const rows = Array.from({ length: 30_000 }, (_, i) => ({
  path: `/sessions/${i}.jsonl`, root: "codex-sessions", name: `${i}.jsonl`, project: "repo-fixture",
  title: "fixed populated scanner replay ".repeat(15), firstPrompt: "", engine: "codex", kind: "session", fmt: "codex",
  mtime: 1_780_000_000, size: 100,
}));
const frame = JSON.stringify({ type: "complete", snapshot: { files: [], projectCatalog: [], conversationCatalog: rows, complete: true } }) + "\n";
const session = new Session();
const post = (method: string, params = {}) => new Promise<object | undefined>((resolve, reject) =>
  session.post(method, params, (error, result) => error ? reject(error) : resolve(result)));
try {
  await fs.writeFile(path.join(directory, "frame.json"), frame, { mode: 0o600 });
  const workerPath = path.join(directory, "emitter.mjs");
  await fs.writeFile(workerPath, `
    import fs from "node:fs";
    const body = fs.readFileSync(${JSON.stringify(path.join(directory, "frame.json"))}, "utf8");
    process.stdin.resume();
    process.stdin.on("end", () => {
      let offset = 0;
      function send() {
        if (offset >= body.length) return;
        const chunk = body.slice(offset, offset + 4096); offset += 4096;
        process.stdout.write(chunk); setImmediate(send);
      }
      send();
    });
  `, { mode: 0o600 });
  session.connect();
  await post("Profiler.enable");
  await post("Profiler.setSamplingInterval", { interval: 10_000 });
  for (let run = 0; run < 3; run++) {
    let last = performance.now(), maxGapMs = 0;
    const timer = setInterval(() => { const at = performance.now(); maxGapMs = Math.max(maxGapMs, at - last); last = at; }, 10);
    try {
      await post("Profiler.start");
      const start = performance.now();
      await collectFileScanInWorker({ persist: false, persistIndex: false }, undefined, {
        launch: { executable: process.execPath, workerPath }, transcriptIndexScheduler: () => {},
      });
      const elapsedMs = performance.now() - start;
      maxGapMs = Math.max(maxGapMs, performance.now() - last);
      const { profile } = await post("Profiler.stop") as unknown as { profile: import("node:inspector").Profiler.Profile };
      const counts = new Map<number, number>();
      for (const id of profile.samples ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
      // No source paths, content or raw profile leaves this private process.
      const top = profile.nodes.map(node => ({ name: node.callFrame.functionName, hits: counts.get(node.id) ?? 0 }))
        .sort((a, b) => b.hits - a.hits).slice(0, 5);
      console.log(JSON.stringify({ run, runtime: process.versions.bun, rows: rows.length,
        bytes: Buffer.byteLength(frame), sha256: createHash("sha256").update(frame).digest("hex"), elapsedMs, maxGapMs, top }));
    } finally { clearInterval(timer); }
  }
} finally {
  session.disconnect();
  await fs.rm(directory, { recursive: true, force: true });
}
