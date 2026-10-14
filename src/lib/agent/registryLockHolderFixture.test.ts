import { expect, spyOn, test } from "bun:test";

import { SqliteAgentRegistryStore } from "./sqliteRegistryStore";
import { loopProgressProbe, registryLockHolder, sqliteRegistryFixture, whileRegistryWriterHeld } from "./registryLockHolderFixture";

test("timer lateness before the observed wait does not refuse loop progress", async () => {
  let release!: () => void;
  const held = new Promise<string>(resolve => { release = () => resolve("released"); });
  const probe = loopProgressProbe();
  probe.arm(release);
  Bun.sleepSync(80);
  expect(await probe.run(() => held)).toBe("released");
});

test("a synchronous wait ending before the short timer refuses loop progress", async () => {
  const probe = loopProgressProbe();
  probe.arm();
  await expect(probe.run(() => { Bun.sleepSync(20); return "blocked"; })).rejects.toThrow("wait timer lateness");
});

test("a held writer is released by loop progress at the real acquisition", async () => {
  const made = sqliteRegistryFixture("writer-progress");
  const holder = registryLockHolder(made.sqliteFilename);
  try {
    await holder.hold();
    const { value } = await whileRegistryWriterHeld(holder, () => made.registry.recordDeliveryOutcomeForOperationOffLoop("conversation_absent", "operation_absent", "delivered"));
    expect(value).toBe(true);
  } finally { await holder.close(); made.registry.close(); made.cleanup(); }
});

test("a caller that catches a blocked writer cannot swallow the probe's refusal", async () => {
  const made = sqliteRegistryFixture("caught-writer-progress");
  const holder = registryLockHolder(made.sqliteFilename);
  const writer = spyOn(SqliteAgentRegistryStore.prototype, "withWriter").mockImplementation(async () => {
    Bun.sleepSync(20);
    return { acquired: false } as const;
  });
  try {
    await holder.hold();
    await expect(whileRegistryWriterHeld(holder, () => made.registry
      .recordDeliveryOutcomeForOperationOffLoop("conversation_absent", "operation_absent", "delivered")
      .catch(() => null))).rejects.toThrow("writer wait blocked the short timer");
  } finally { writer.mockRestore(); await holder.close(); made.registry.close(); made.cleanup(); }
});
