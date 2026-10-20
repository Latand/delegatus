import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";
import { blockingWaitDiagnostics, resetBlockingWaitsForTests, withWaitCorrelation } from "@/lib/blockingWaits";
import { FileTransactionBusyError, withFileTransaction, withFileTransactionAsync, withFileTransactionSync } from "./fileTransaction";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "file-wait-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
for (const fails of [false, true]) test(`file admission yields and records its origin when the body ${fails ? "throws" : "succeeds"}`, async () => {
  const lines: string[] = [];
  resetBlockingWaitsForTests(line => { lines.push(line); });
  const file = path.join(root, `wait-${fails}.json`);
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let ready!: () => void;
  const admitted = new Promise<void>(resolve => { ready = resolve; });
  const holder = withFileTransaction(file, "held", async () => { ready(); await barrier; });
  await admitted;
  let timerAdvanced = false;
  const timer = setTimeout(() => { timerAdvanced = true; release(); }, 100);
  try {
    const result = withWaitCorrelation({ label: "account-credit-guard.obligations" }, () =>
      withFileTransaction(file, "busy", () => { if (fails) throw new Error("body refused"); return "written"; }));
    if (fails) await expect(result).rejects.toThrow("body refused");
    else expect(await result).toBe("written");
    expect(timerAdvanced).toBe(true);
    expect(blockingWaitDiagnostics().longest).toContainEqual(expect.objectContaining({ site: "file-transaction",
      synchronous: false, label: "account-credit-guard.obligations" }));
    expect(lines.some(line => line.includes("file-transaction") && line.includes("account-credit-guard.obligations"))).toBe(true);
    expect(await withFileTransaction(file, "busy", () => "released")).toBe("released");
  } finally { clearTimeout(timer); release(); await holder; }
});

test("a sync writer in the same process fails fast behind an async owner", async () => {
  const file = path.join(root, "mixed-lock.json");
  let observed!: (error: unknown) => void;
  const attempt = new Promise<unknown>(resolve => { observed = resolve; });
  let syncActionRan = false;
  const asyncWrite = withFileTransactionAsync(file, "async held", () => {
    queueMicrotask(() => {
      try { withFileTransactionSync(file, "sync busy", () => { syncActionRan = true; return "written"; }); }
      catch (error) { observed(error); }
    });
    return "async written";
  });
  expect(await asyncWrite).toBe("async written");
  expect(await attempt).toBeInstanceOf(FileTransactionBusyError);
  expect(syncActionRan).toBeFalse();
  const started = performance.now();
  expect(withFileTransactionSync(file, "sync busy", () => { syncActionRan = true; return "after release"; }))
    .toBe("after release");
  expect(performance.now() - started).toBeLessThan(50);
  expect(syncActionRan).toBeTrue();
});

test("the shared async API releases a synchronous callback before a queued sync writer runs", async () => {
  const file = path.join(root, "mixed-sync-callback.json");
  let observed!: (error: unknown) => void;
  const attempt = new Promise<unknown>(resolve => { observed = resolve; });
  const asyncWrite = withFileTransaction(file, "async held", () => {
    queueMicrotask(() => {
      try { observed(withFileTransactionSync(file, "sync busy", () => "written")); }
      catch (error) { observed(error); }
    });
    return "async written";
  });
  expect(await asyncWrite).toBe("async written");
  expect(await attempt).toBe("written");
});
