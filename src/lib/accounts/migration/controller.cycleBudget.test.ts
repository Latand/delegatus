import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRegistry } from "@/lib/agent/registry";
import { OperationLease, currentOperationLease } from "@/lib/operationLease";
import { setStructuredDeliveryKick } from "@/lib/runtime/structuredDeliverySignal";
import { reconcileAccountMigrationCycle } from "./controller";
import { noSuccessor } from "./peakLoad.fixture";

test("migration completes while an independently owned delivery wake remains held", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "migration-cycle-budget-"));
  const registry = new AgentRegistry(path.join(directory, "registry.json"));
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let wakeLease: unknown = "not called";
  setStructuredDeliveryKick(() => { wakeLease = currentOperationLease(); return held; });
  const lease = new OperationLease();
  const cycle = lease.run(() => reconcileAccountMigrationCycle(registry, { async tick() {} }, noSuccessor,
    { async deliver() { throw new Error("unexpected dispatch"); } }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([cycle.then(() => "completed"),
      new Promise(resolve => { timer = setTimeout(() => resolve("waiting for queue"), 100); })]);
    expect(result).toBe("completed");
    expect(wakeLease).toBeUndefined();
  } finally {
    if (timer) clearTimeout(timer);
    release(); await cycle;
    setStructuredDeliveryKick(null); registry.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
});
