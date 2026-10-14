import { expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { setAgentRegistryForTests } from "@/lib/agent/registry";
import { withoutWriterWait, registryLockHolder, sqliteRegistryFixture } from "@/lib/agent/registryLockHolderFixture";
import { blockingWaitDiagnostics, resetBlockingWaitsForTests } from "@/lib/blockingWaits";
import { drainHeldDeliveries } from "./migration/coordinator";
import { emptyLaunchProfile } from "./migration/contracts";
import { recoverManagedAccountRemoval, removeManagedAccountIntoArchive, retireAccountInPlace, retiredAccountArchive, type AccountRemovalJournalEntry } from "./removal";

for (const busy of [false, true]) test(`failed account commit restores immediately or retains a durable retirement for later recovery (${busy})`, async () => {
  const made = sqliteRegistryFixture("llv-retirement-rollback");
  const registry = made.registry;
  setAgentRegistryForTests(registry);
  const accountId = `rollback-${crypto.randomUUID()}`;
  const home = path.join(made.root, "account-home");
  fs.mkdirSync(home);
  const pathname = path.join(home, "session.jsonl");
  fs.writeFileSync(pathname, "history");
  const conversation = registry.ensureConversation("claude", pathname, accountId);
  const observedAt = new Date().toISOString();
  registry.reconcileConversations([{ engine: "claude", path: pathname, accountId, launchProfile: emptyLaunchProfile(),
    turn: { state: "terminal", source: "lifecycle", terminalAt: observedAt }, observedAt }]);
  const held = registry.holdDelivery(conversation.id, "accepted before retirement", "retirement-original-key");
  const go = path.join(made.root, "go");
  const ready = path.join(made.root, "ready");
  const free = path.join(made.root, "free");
  const child = busy ? Bun.spawn([process.execPath, "-e", `
    const { Database } = await import("bun:sqlite");
    const fs = await import("node:fs");
    const db = new Database(process.argv[1]);
    process.stdout.write("started\\n");
    const timer = setInterval(() => {
      if (!fs.existsSync(process.argv[2])) return;
      clearInterval(timer);
      db.exec("BEGIN IMMEDIATE");
      fs.writeFileSync(process.argv[3], "ready");
      const release = setInterval(() => {
        if (!fs.existsSync(process.argv[4])) return;
        clearInterval(release); db.exec("ROLLBACK"); db.close();
      }, 1);
    }, 1);
  `, made.sqliteFilename, go, ready, free], { stdout: "pipe", stderr: "inherit" }) : null;
  let entry: AccountRemovalJournalEntry | null = null;
  try {
    if (child) expect(new TextDecoder().decode((await child.stdout.getReader().read()).value)).toContain("started");
    resetBlockingWaitsForTests(() => {});
    (busy ? (work: () => void) => withoutWriterWait(made.sqliteFilename, work, 2) : (work: () => void) => work())(() => {
      expect(() => removeManagedAccountIntoArchive({ engine: "claude", accountId, home, homeIsSafe: () => true, unsafeHome: () => new Error("unsafe"),
        rewrites: (from, to) => [{ from, to }], registry: {
          journal: (phase, rewrites) => { entry = phase ? { id: accountId, phase, startedAt: Date.now(), rewrites: rewrites ? [...rewrites] : undefined } : null; },
          restore: () => { entry = null; },
          commitRetired: () => {
            if (busy) {
              fs.writeFileSync(go, "go");
              const deadline = performance.now() + 2_000;
              while (!fs.existsSync(ready)) {
                if (performance.now() > deadline) throw new Error("holder did not start");
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
              }
            }
            throw new Error("accounts commit denied");
          },
        } })).toThrow();
    });
    if (!busy) {
      expect(registry.snapshot().heldDeliveries[held.id]?.text).toBe(held.text);
      expect(fs.existsSync(home)).toBe(true);
      expect(entry).toBeNull();
    } else {
      expect(blockingWaitDiagnostics().longest.find(wait => wait.label === "account.retirement-rollback")).toMatchObject({
        operationId: `account-removal:claude:${accountId}`, synchronous: false, refused: true,
      });
      expect(entry).toMatchObject({ phase: "retiring" });
      expect(fs.existsSync(home)).toBe(false);
      expect(registry.snapshot().heldDeliveries[held.id]?.command.operationId).toBe(held.command.operationId);
      fs.writeFileSync(free, "release");
      await child!.exited;
      expect(recoverManagedAccountRemoval({ engine: "claude", accountId, home, entry: entry!, listed: true,
        commitRetired: () => {}, clearJournal: () => { entry = null; } })).toBe("retired");
      expect(entry).toBeNull();
      expect(registry.snapshot().heldDeliveries[held.id]?.state).toBe("failed");
    }
  } finally {
    if (child) { child.kill(); await child.exited; }
    setAgentRegistryForTests(null);
    registry.close();
    made.cleanup();
    fs.rmSync(retiredAccountArchive("claude", accountId), { recursive: true, force: true });
  }
});

for (const retiredInPlace of [false, true]) for (const renamed of [false, true]) test(`archive recovery refuses a busy writer without clearing its path intent, then restores and delivers once (retired in place: ${retiredInPlace}, home already restored: ${renamed})`, async () => {
  const made = sqliteRegistryFixture("llv-archive-recovery");
  const registry = made.registry;
  setAgentRegistryForTests(registry);
  const holder = registryLockHolder(made.sqliteFilename);
  const accountId = `recovery-${crypto.randomUUID()}`;
  const home = path.join(made.root, "restored-home");
  const archive = retiredAccountArchive("claude", accountId);
  fs.mkdirSync(archive, { recursive: true });
  const pathname = path.join(archive, "session.jsonl");
  fs.writeFileSync(pathname, "history");
  const conversation = registry.ensureConversation("claude", pathname, accountId);
  const held = registry.holdDelivery(conversation.id, "accepted before archive recovery", "archive-original-key");
  if (renamed) fs.renameSync(archive, home);
  let cleared = false;
  const recover = () => recoverManagedAccountRemoval({ engine: "claude", accountId, home,
    entry: { id: accountId, phase: "archiving", startedAt: Date.now() }, listed: !retiredInPlace, retiredInPlace,
    commitRetired: () => {}, clearJournal: () => { cleared = true; } });
  try {
    resetBlockingWaitsForTests(() => {});
    await holder.hold();
    const value = withoutWriterWait(made.sqliteFilename, recover);
    expect(value).toBeNull();
    expect(cleared).toBe(false);
    expect(fs.existsSync(home)).toBe(renamed);
    expect(fs.existsSync(archive)).toBe(!renamed);
    expect(registry.conversation(conversation.id)?.generations.at(-1)?.path).toBe(pathname);
    expect(blockingWaitDiagnostics().longest.find(wait => wait.label === "account.archive-recovery")).toMatchObject({
      operationId: `account-removal:claude:${accountId}`, synchronous: false, refused: true,
    });
    expect(registry.snapshot().heldDeliveries[held.id]?.text).toBe(held.text);
    await holder.release();
    expect(recover()).toBe("restored");
    expect(cleared).toBe(true);
    expect(registry.conversation(conversation.id)?.generations.at(-1)?.path).toBe(path.join(home, "session.jsonl"));
    let inputs = 0;
    const port = { async deliver() { inputs += 1; return "delivered" as const; } };
    await drainHeldDeliveries(conversation.id, port, registry);
    await drainHeldDeliveries(conversation.id, port, registry);
    expect(inputs).toBe(1);
  } finally {
    await holder.close();
    setAgentRegistryForTests(null);
    registry.close();
    made.cleanup();
    fs.rmSync(archive, { recursive: true, force: true });
  }
});

/* Task d7759de2: an in-place retirement (a hidden default home) whose
   accounts commit fails puts the agent registry back with one attempt, or
   says the registry was busy without waiting on the loop. */
for (const busy of [false, true]) test(`failed in-place retirement commit restores or refuses without waiting (${busy})`, async () => {
  const made = sqliteRegistryFixture("llv-in-place-rollback");
  const registry = made.registry;
  setAgentRegistryForTests(registry);
  const accountId = `in-place-${crypto.randomUUID()}`;
  registry.setEngineRouting("claude", accountId);
  const go = path.join(made.root, "go");
  const ready = path.join(made.root, "ready");
  const free = path.join(made.root, "free");
  const child = busy ? Bun.spawn([process.execPath, "-e", `
    const { Database } = await import("bun:sqlite");
    const fs = await import("node:fs");
    const db = new Database(process.argv[1]);
    process.stdout.write("started\\n");
    const timer = setInterval(() => {
      if (!fs.existsSync(process.argv[2])) return;
      clearInterval(timer);
      db.exec("BEGIN IMMEDIATE");
      fs.writeFileSync(process.argv[3], "ready");
      const release = setInterval(() => {
        if (!fs.existsSync(process.argv[4])) return;
        clearInterval(release); db.exec("ROLLBACK"); db.close();
      }, 1);
    }, 1);
  `, made.sqliteFilename, go, ready, free], { stdout: "pipe", stderr: "inherit" }) : null;
  try {
    if (child) expect(new TextDecoder().decode((await child.stdout.getReader().read()).value)).toContain("started");
    resetBlockingWaitsForTests(() => {});
    let thrown: unknown = null;
    (busy ? (work: () => void) => withoutWriterWait(made.sqliteFilename, work, 2) : (work: () => void) => work())(() => {
      try {
        retireAccountInPlace({ engine: "claude", accountId, fallbackAccountId: "kept", commit: () => {
          if (busy) {
            fs.writeFileSync(go, "go");
            const deadline = performance.now() + 2_000;
            while (!fs.existsSync(ready)) {
              if (performance.now() > deadline) throw new Error("holder did not start");
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
            }
          }
          throw new Error("accounts commit denied");
        } });
      } catch (error) { thrown = error; }
    });
    if (!busy) {
      expect((thrown as Error).message).toBe("accounts commit denied");
      expect(registry.engineRouting("claude").activeAccountId).toBe(accountId);
    } else {
      expect((thrown as Error).message).toContain("the agent registry is busy");
      expect(blockingWaitDiagnostics().longest.find(wait => wait.label === "account.retirement-rollback")).toMatchObject({
        operationId: `account-removal:claude:${accountId}`, synchronous: false, refused: true,
      });
      expect(registry.engineRouting("claude").activeAccountId).toBe("kept");
    }
  } finally {
    if (child) { child.kill(); await child.exited; }
    setAgentRegistryForTests(null);
    registry.close();
    made.cleanup();
  }
});
