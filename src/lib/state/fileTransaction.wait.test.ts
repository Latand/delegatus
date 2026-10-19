import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";
import { blockingWaitDiagnostics, resetBlockingWaitsForTests, withWaitCorrelation } from "@/lib/blockingWaits";
import { withFileTransaction } from "./fileTransaction";

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
