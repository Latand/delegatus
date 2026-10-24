import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectFileScanInWorker } from "./fileScanWorker";

for (const mode of ["release", "cancel", "deadline"] as const) {
  test(`a real scanner waiting on its registry writer: ${mode}`, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scanner-lock-"));
    const env = { ...process.env, HOME: directory, XDG_CONFIG_HOME: path.join(directory, "config"),
      TMPDIR: directory, LLV_STATE_DIR: path.join(directory, "state"), LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:9" };
    const runtime = { env, cwd: process.cwd(), launch: { executable: process.execPath,
      workerPath: path.resolve("src/lib/fileScanner.worker.ts") }, transcriptIndexScheduler: () => {} };
    let db: Database | undefined;
    let restoreLog: (() => void) | undefined;
    try {
      await collectFileScanInWorker({ persist: false }, undefined, runtime);
      db = new Database(path.join(env.LLV_STATE_DIR, "agent-registry.sqlite"));
      db.exec("PRAGMA busy_timeout=0");
      const failures: string[] = [];
      // This process is the proven lock holder. Each attempt starts a new real
      // worker with a cold connection, just as a new scan generation does.
      for (let attempt = 0; attempt < (mode === "release" ? 3 : 1); attempt++) {
        db.exec("BEGIN IMMEDIATE");
        const waiting = Promise.withResolvers<void>();
        const lines: string[] = [];
        const log = spyOn(console, "error").mockImplementation((line) => {
          lines.push(String(line));
          if (String(line).includes("\"callSite\":\"scanner.registry.open\"")
            && String(line).includes("\"outcome\":\"waiting\"")) waiting.resolve();
        });
        restoreLog = () => log.mockRestore();
        const controller = new AbortController();
        const timers: { callback: () => void; active: boolean }[] = [];
        let ticks = 0;
        const pulse = setInterval(() => ticks++, 1);
        const scan = collectFileScanInWorker({ persist: false }, undefined, {
          ...runtime, signal: controller.signal,
          scheduler: {
            setTimeout: callback => { const timer = { callback, active: true }; timers.push(timer); return timer; },
            clearTimeout: timer => { (timer as typeof timers[number]).active = false; },
          },
        });
        const outcome = scan.then(value => ({ value }), error => ({ error }));
        try {
          const first = await Promise.race([waiting.promise.then(() => "waiting"), outcome]);
          if (typeof first !== "string" && "error" in first) {
            failures.push(String(first.error));
            continue;
          }
          expect(first).toBe("waiting");
          expect(ticks).toBeGreaterThan(0);
          const wait = JSON.parse(lines.find(line => line.includes("\"outcome\":\"waiting\""))!.slice("[blocking-wait] ".length));
          expect(wait).toMatchObject({ synchronous: false, subject: "agent-registry",
            stateWait: { callSite: "scanner.registry.open", synchronousSleepMs: 0 } });
          if (mode === "release") db.exec("ROLLBACK");
          else if (mode === "cancel") controller.abort();
          else { timers[0]!.active = false; timers[0]!.callback(); }
          const result = await outcome;
          if (mode === "release") {
            if ("error" in result) throw result.error;
            expect(result.value.complete).toBe(true);
            expect(lines.some(line => line.includes("\"outcome\":\"success\""))).toBe(true);
          } else {
            expect(result).toMatchObject({ error: { name: mode === "cancel" ? "AbortError" : "DeadlineExceededError" } });
            db.exec("ROLLBACK");
          }
          expect(timers.filter(timer => timer.active)).toEqual([]);
        } finally {
          controller.abort();
          await outcome;
          clearInterval(pulse);
          restoreLog();
          restoreLog = undefined;
          if (db.inTransaction) db.exec("ROLLBACK");
        }
      }
      expect(failures).toEqual([]);
    } finally {
      restoreLog?.();
      db?.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
}
