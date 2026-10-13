import { expect, test } from "bun:test";
import { longestLoopGap, registryLockHolder, sqliteRegistryFixture } from "@/lib/agent/registryLockHolderFixture";
import { withAccountMutationLockAsync } from "./accountMutation";
import { trackAccountLeases } from "./accountMutation.contention.fixture";
import { accountsDatabasePath } from "./accountsStore";
import { createManagedCodexAccount, setActiveCodexAccount, activeCodexAccountId } from "./codex";

test("an account commit refuses a busy state writer without holding the account lease through its wait", async () => {
  const account = createManagedCodexAccount("State writer target");
  const holder = registryLockHolder(accountsDatabasePath());
  const leases = trackAccountLeases();
  try {
    await holder.hold(400);
    let refusal: unknown;
    const { gapMs } = await longestLoopGap(() => {
      try { setActiveCodexAccount(account.id); } catch (error) { refusal = error; }
    });
    expect(refusal).toBeInstanceOf(Error);
    expect(gapMs).toBeLessThan(150);
    expect(Math.max(...leases.holds)).toBeLessThan(150);
    await holder.release();
    setActiveCodexAccount(account.id);
    expect(activeCodexAccountId()).toBe(account.id);
  } finally {
    leases.stop(); await holder.close();
    console.info(JSON.stringify({ measurement: "account state writer", maxHoldMs: Math.max(0, ...leases.holds) }));
  }
});

test("a spawn waiting for the registry writer leaves account mutations runnable", async () => {
  const made = sqliteRegistryFixture("account-admission-writer");
  const holder = registryLockHolder(made.sqliteFilename);
  const leases = trackAccountLeases();
  try {
    await holder.hold(400);
    let otherCommitted = false;
    const { value, gapMs } = await longestLoopGap(async () => {
      const launch = made.registry.beginSpawnRequestAsync({ engine: "codex", cwd: "/fixture", transport: "structured", accountId: "default", launchProfile: { title: "Writer contention" } });
      await new Promise(resolve => setTimeout(resolve, 30));
      await withAccountMutationLockAsync(() => { otherCommitted = true; }, { waitMs: 100 });
      return launch;
    });
    expect(otherCommitted).toBe(true);
    expect(value.kind).toBe("created");
    expect(gapMs).toBeLessThan(150);
    expect(Math.max(...leases.holds)).toBeLessThan(150);
  } finally {
    leases.stop();
    console.info(JSON.stringify({ measurement: "spawn registry writer", maxHoldMs: Math.max(0, ...leases.holds) }));
    await holder.close(); made.registry.close(); made.cleanup();
  }
});

test("writer retry revalidates a racing account change before reserving a spawn", async () => {
  const made = sqliteRegistryFixture("account-writer-race");
  const holder = registryLockHolder(made.sqliteFilename);
  let allowed = true;
  try {
    await holder.hold(400);
    const launch = made.registry.beginSpawnRequestAsync({ engine: "codex", cwd: "/fixture", transport: "structured", accountId: "default", launchProfile: { title: "Writer race" } }, () => {
      if (!allowed) throw new Error("account choice changed");
    }).then(() => null, error => error as Error);
    await new Promise(resolve => setTimeout(resolve, 20));
    await withAccountMutationLockAsync(() => { allowed = false; }, { waitMs: 100 });
    expect((await launch)?.message).toBe("account choice changed");
    expect(Object.keys(made.registry.readOnlySnapshot().receipts)).toHaveLength(0);
  } finally { await holder.close(); made.registry.close(); made.cleanup(); }
});

test("an asynchronous account commit refuses a busy state writer without replaying the callback", async () => {
  const account = createManagedCodexAccount("Async writer target");
  const holder = registryLockHolder(accountsDatabasePath());
  const leases = trackAccountLeases();
  try {
    await holder.hold(400);
    let calls = 0;
    const pending = withAccountMutationLockAsync(() => { calls += 1; setActiveCodexAccount(account.id); });
    await expect(pending).rejects.toThrow();
    expect(calls).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 20));
    let neighbor = false;
    await withAccountMutationLockAsync(() => { neighbor = true; }, { waitMs: 100 });
    expect(neighbor).toBe(true);
    await holder.release();
    await withAccountMutationLockAsync(() => setActiveCodexAccount(account.id));
    expect(activeCodexAccountId()).toBe(account.id);
    expect(Math.max(...leases.holds)).toBeLessThan(150);
  } finally { leases.stop(); await holder.close(); }
});
