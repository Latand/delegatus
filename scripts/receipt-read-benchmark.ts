/** Linux replay of receipt-bearing HTTP call paths. Run once with --seed FILE,
 * then run each revision with --database FILE [--count N] [--repeats N].
 * Input is synthetic; every pass opens a private byte-identical copy. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { receiptReadFixture, closeReceiptReadFixtures, observeReceiptSelections } from "@/lib/agent/receiptRead.fixture";
import { receiptHotCallers, replayReceiptCaller } from "@/lib/agent/receiptHotCallers.fixture";

if (process.platform !== "linux") throw new Error("Receipt byte measurement requires Linux procfs");
const args = process.argv.slice(2);
const option = (name: string) => args[args.indexOf(name) + 1];
const count = args.includes("--count") ? Number(option("--count")) : 32769;
if (args.includes("--seed")) {
  const f = receiptReadFixture(count);
  await f.store.prepareRecoveryIndexes();
  const filename = f.filename;
  f.store.close();
  fs.copyFileSync(filename, option("--seed"));
  console.log(JSON.stringify({ count, bytes: fs.statSync(option("--seed")).size,
    sha256: createHash("sha256").update(fs.readFileSync(option("--seed"))).digest("hex") }));
  closeReceiptReadFixtures();
} else {
  if (!args.includes("--database")) throw new Error("Supply --seed FILE or --database FILE");
  const source = option("--database");
  const repeats = args.includes("--repeats") ? Number(option("--repeats")) : 3;
  const inputSha256 = createHash("sha256").update(fs.readFileSync(source)).digest("hex");
  const passes = [];
  for (let pass = 0; pass < repeats; pass++) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-replay-"));
    try {
      const filename = path.join(root, "registry.sqlite");
      fs.copyFileSync(source, filename);
      const f = receiptReadFixture(count, filename);
      // Startup and index preparation are excluded from request measurements.
      f.store.readOnlySnapshot();
      const observer = observeReceiptSelections(f.store, true);
      const requests = [];
      for (const caller of receiptHotCallers) {
        observer.reset(); f.reset();
        const start = performance.now();
        const result = await replayReceiptCaller(caller, f.store);
        requests.push({ caller, ...observer.metrics(), requestMs: performance.now() - start,
          payloadRows: f.reads(), rows: result.snapshot.conversations.length,
          plans: [...new Set(observer.plans)] });
      }
      passes.push({ pass: pass + 1, requests });
      closeReceiptReadFixtures();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
  console.log(JSON.stringify({ runtime: Bun.version, inputSha256, count, repeats,
    measurement: "receipt selector rchar minus proc-read bytes; synchronous selector wall time; shared consumer paths without HTTP transport", passes }, null, 2));
}
