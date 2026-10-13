import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRegistry, RegistryWriterBusyError } from "@/lib/agent/registry";
import { longestLoopGap, registryLockHolder, sqliteRegistryFixture } from "@/lib/agent/registryLockHolderFixture";
import { withAccountMutationLockAsync } from "./accountMutation";
import { trackAccountLeases } from "./accountMutation.contention.fixture";
import { accountsDatabasePath } from "./accountsStore";
import { createManagedCodexAccount, setActiveCodexAccount, activeCodexAccountId } from "./codex";

for (const mode of ["off", "dual-write"] as const) {
  test.each(["spawn", "resume", "send"] as const)(`${mode} %s waits for the JSON writer outside the account lease`, async operation => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-json-writer-"));
    let busy = true;
    let probes = 0;
    const registry = new AgentRegistry(path.join(root, "registry.json"), owner => {
      if (owner.pid !== 42) return true;
      probes++; return busy;
    }, undefined, { sqliteMode: mode });
    const conversation = registry.ensureConversation("codex", "/fixture/retained.jsonl", "default");
    const lock = `${registry.filename}.write-lock`;
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: 42, startIdentity: "foreign-writer" }));
    const leases = trackAccountLeases();
    try {
      const { value, gapMs } = await longestLoopGap(async () => {
        const admission = operation === "send"
          ? registry.holdDeliveryOffLoop(conversation.id, "Queued message", "json-writer-send")
          : registry.beginSpawnRequestAsync({ engine: "codex", cwd: "/fixture", transport: "structured", accountId: "default",
            ...(operation === "resume" ? { purpose: "resume-successor", conversationId: conversation.id, origin: { kind: "successor" } } as const : {}),
            launchProfile: { title: "JSON writer contention" } });
        const result = admission.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
        await Bun.sleep(30);
        expect(probes).toBeGreaterThan(0);
        let neighbor = false;
        await withAccountMutationLockAsync(() => { neighbor = true; }, { waitMs: 100 });
        expect(neighbor).toBe(true);
        busy = false;
        return result;
      });
      expect(value.error).toBeUndefined();
      expect(value.value).toBeDefined();
      if (operation === "send") expect(Object.keys(registry.readOnlySnapshot().heldDeliveries)).toHaveLength(1);
      else expect(Object.keys(registry.readOnlySnapshot().receipts)).toHaveLength(1);
      expect(gapMs).toBeLessThan(150);
      expect(Math.max(...leases.holds)).toBeLessThan(150);
    } finally {
      leases.stop(); registry.close(); fs.rmSync(root, { recursive: true, force: true });
      console.info(JSON.stringify({ measurement: `${mode} ${operation} JSON writer`, maxHoldMs: Math.max(0, ...leases.holds) }));
    }
  });
}

for (const mode of ["off", "dual-write"] as const) {
  test.each(["guard", "deadline"] as const)(`${mode} JSON writer ${mode === "off" ? "admission" : "admission with parity"} refuses on %s before running a callback`, async refusal => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-json-refusal-"));
    const registry = new AgentRegistry(path.join(root, "registry.json"), () => true, undefined, { sqliteMode: mode, sqliteWriterDeadlineMs: 60 });
    const lock = `${registry.filename}.write-lock`;
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: 42, startIdentity: "foreign-writer" }));
    let allowed = true;
    let calls = 0;
    try {
      const pending = registry.accountMutationWrite("JSON refusal", () => {
        calls++;
        return registry.beginSpawnRequest({ engine: "codex", cwd: "/fixture", transport: "structured", accountId: "default", launchProfile: { title: "Refused admission" } });
      }, () => { if (!allowed) throw new Error("account choice changed"); })
        .then(value => ({ value, error: undefined }), error => ({ value: undefined, error: error as Error }));
      if (refusal === "guard") {
        await Bun.sleep(15);
        await withAccountMutationLockAsync(() => { allowed = false; }, { waitMs: 100 });
      }
      const result = await pending;
      if (refusal === "guard") expect(result.error?.message).toBe("account choice changed");
      else expect(result).toEqual({ value: { acquired: false }, error: undefined });
      expect(calls).toBe(0);
      expect(Object.keys(registry.readOnlySnapshot().receipts)).toHaveLength(0);
      expect(Object.keys(registry.readOnlySnapshot().heldDeliveries)).toHaveLength(0);
    } finally { registry.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  test(`${mode} JSON admission propagates a callback failure after one write`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-json-partial-"));
    const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: mode });
    let calls = 0;
    try {
      await expect(registry.accountMutationWrite("JSON partial callback", () => {
        calls++;
        registry.ensureConversation("codex", "/fixture/partial.jsonl", "default");
        throw new RegistryWriterBusyError("failure after write");
      })).rejects.toThrow("failure after write");
      expect(calls).toBe(1);
      expect(Object.keys(registry.readOnlySnapshot().conversations)).toHaveLength(1);
      expect(registry.deliveryWriteNow({ label: "claim released" }, () => registry.ensureConversation("codex", "/fixture/after.jsonl", "default")).acquired).toBe(true);
      expect(Object.keys(registry.readOnlySnapshot().conversations)).toHaveLength(2);
    } finally { registry.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
}

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

test("a dual-write routing commit refuses SQLite contention and preserves both stores", async () => {
  const made = sqliteRegistryFixture("account-dual-writer", { sqliteMode: "dual-write" });
  const holder = registryLockHolder(made.sqliteFilename);
  const leases = trackAccountLeases();
  try {
    const before = made.registry.engineRouting("codex");
    await holder.hold(400);
    let refusal: unknown;
    const { gapMs } = await longestLoopGap(() => {
      try { made.registry.setEngineRouting("codex", "changed-account"); } catch (error) { refusal = error; }
    });
    expect(refusal).toBeInstanceOf(Error);
    expect(gapMs).toBeLessThan(150);
    expect(Math.max(...leases.holds)).toBeLessThan(150);
    expect(made.registry.engineRouting("codex")).toEqual(before);
    await holder.release();
    await withAccountMutationLockAsync(() => made.registry.setEngineRouting("codex", "changed-account"));
    expect(made.registry.engineRouting("codex").activeAccountId).toBe("changed-account");
  } finally {
    leases.stop(); await holder.close(); made.registry.close(); made.cleanup();
    console.info(JSON.stringify({ measurement: "dual-write registry writer", maxHoldMs: Math.max(0, ...leases.holds) }));
  }
});
