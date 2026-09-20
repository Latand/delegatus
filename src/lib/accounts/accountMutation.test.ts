import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-account-mutation-"));

afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

test("a real registry spawn sees same-process contention before allocating, while the async path queues", async () => {
  const state = path.join(sandbox, "registry-contention-state");
  const result = path.join(sandbox, "registry-contention-result.json");
  const mutationPath = path.join(import.meta.dir, "accountMutation.ts");
  const registryPath = path.join(import.meta.dir, "..", "agent", "registry.ts");
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", `
      process.env.LLV_STATE_DIR = ${JSON.stringify(state)};
      const fs = await import("node:fs");
      const { withAccountMutationLockAsync } = await import(${JSON.stringify(mutationPath)});
      const { AgentRegistry } = await import(${JSON.stringify(registryPath)});
      const registry = new AgentRegistry(
        ${JSON.stringify(path.join(state, "agent-registry.json"))},
        undefined,
        undefined,
        { sqliteMode: "off" },
      );
      const input = {
        engine: "codex",
        cwd: "/fixture-repo",
        transport: "structured",
        accountId: null,
        clientAttemptId: "registry-contention-attempt",
        launchProfile: { title: "Registry contention fixture" },
      };
      let releaseHolder;
      let markStarted;
      const started = new Promise((resolve) => { markStarted = resolve; });
      const holder = withAccountMutationLockAsync(async () => {
        markStarted();
        await new Promise((resolve) => { releaseHolder = resolve; });
      });
      await started;

      const syncStartedAt = Date.now();
      let syncError = null;
      try { registry.beginSpawnRequest(input); }
      catch (error) { syncError = { name: error?.name ?? "unknown", message: String(error?.message ?? error) }; }
      const syncElapsedMs = Date.now() - syncStartedAt;
      const receiptsBeforeRelease = Object.keys(registry.snapshot().receipts).length;

      const queued = withAccountMutationLockAsync(async () => registry.beginSpawnRequest(input));
      setTimeout(() => releaseHolder(), 25);
      const [, begun] = await Promise.all([holder, queued]);
      const receiptsAfterRelease = Object.values(registry.snapshot().receipts);
      fs.writeFileSync(${JSON.stringify(result)}, JSON.stringify({
        syncError,
        syncElapsedMs,
        receiptsBeforeRelease,
        begunKind: begun.kind,
        receiptsAfterRelease: receiptsAfterRelease.length,
        clientAttemptIds: receiptsAfterRelease.map((receipt) => receipt.clientAttemptId),
      }));
    `],
    stdout: "ignore",
    stderr: "pipe",
  });

  const completed = await Promise.race([
    child.exited.then(() => true),
    Bun.sleep(2_000).then(() => false),
  ]);
  if (!completed) child.kill();
  const error = await new Response(child.stderr).text();

  expect({ completed, error }).toEqual({ completed: true, error: "" });
  expect(JSON.parse(fs.readFileSync(result, "utf8"))).toEqual({
    syncError: {
      name: "AccountMutationBusyError",
      message: expect.stringMatching(/account mutation is busy; held by .+pid/),
    },
    syncElapsedMs: expect.any(Number),
    receiptsBeforeRelease: 0,
    begunKind: "created",
    receiptsAfterRelease: 1,
    clientAttemptIds: ["registry-contention-attempt"],
  });
  expect((JSON.parse(fs.readFileSync(result, "utf8")) as { syncElapsedMs: number }).syncElapsedMs).toBeLessThan(100);
});

test("same-process contenders leave an async transaction holder runnable", async () => {
  const state = path.join(sandbox, "state");
  const result = path.join(sandbox, "result.json");
  const modulePath = path.join(import.meta.dir, "accountMutation.ts");
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", `
      process.env.LLV_STATE_DIR = ${JSON.stringify(state)};
      const fs = await import("node:fs");
      const { withAccountMutationLock, withAccountMutationLockAsync } = await import(${JSON.stringify(modulePath)});
      let releaseHolder;
      let markStarted;
      const started = new Promise((resolve) => { markStarted = resolve; });
      const holder = withAccountMutationLockAsync(async () => {
        markStarted();
        await new Promise((resolve) => { releaseHolder = resolve; });
      });
      await started;

      const syncStartedAt = Date.now();
      let syncFailed = false;
      try { withAccountMutationLock(() => undefined); }
      catch { syncFailed = true; }
      const syncElapsedMs = Date.now() - syncStartedAt;

      let timerFired = false;
      setTimeout(() => { timerFired = true; releaseHolder(); }, 25);
      let waiterRan = false;
      const waiter = withAccountMutationLockAsync(async () => { waiterRan = true; });
      await Promise.all([holder, waiter]);
      fs.writeFileSync(${JSON.stringify(result)}, JSON.stringify({ syncFailed, syncElapsedMs, timerFired, waiterRan }));
    `],
    stdout: "ignore",
    stderr: "pipe",
  });

  const completed = await Promise.race([
    child.exited.then(() => true),
    Bun.sleep(2_000).then(() => false),
  ]);
  if (!completed) child.kill();
  const error = await new Response(child.stderr).text();

  expect({ completed, error }).toEqual({ completed: true, error: "" });
  expect(JSON.parse(fs.readFileSync(result, "utf8"))).toEqual({
    syncFailed: true,
    syncElapsedMs: expect.any(Number),
    timerFired: true,
    waiterRan: true,
  });
  expect((JSON.parse(fs.readFileSync(result, "utf8")) as { syncElapsedMs: number }).syncElapsedMs).toBeLessThan(100);
});

test("a mutation the store refuses advances neither the revision nor the rows", async () => {
  /* Transaction admission used to be a durable write of its own, advanced
     before the callback so a fence that would not write blocked it (#1870
     replaced that with one transaction). The guarantee it bought is now
     stronger and is what this proves: the admission IS the write, so a store
     that refuses leaves the revision exactly where it was and nothing on
     record half-committed. */
  const state = path.join(sandbox, "revision-state");
  const result = path.join(sandbox, "revision-result.json");
  const storePath = path.join(import.meta.dir, "accountsStore.ts");
  const modulePath = path.join(import.meta.dir, "accountMutation.ts");
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", `
      process.env.LLV_STATE_DIR = ${JSON.stringify(state)};
      const fsModule = await import("node:fs");
      const fs = fsModule.default;
      const store = await import(${JSON.stringify(storePath)});
      const { accountMutationRevisionForTests, withAccountMutationLock } = await import(${JSON.stringify(modulePath)});
      const registry = (active) => ({ version: 1, active, accounts: [], retired: [], removals: [] });
      store.writeAccountSource(store.CLAUDE_ACCOUNTS_SOURCE, registry("before"));
      const before = accountMutationRevisionForTests();
      const database = store.accountsDatabasePath();
      for (const suffix of ["", "-wal", "-shm"]) { try { fs.chmodSync(database + suffix, 0o400); } catch {} }
      let callbackRan = false;
      let failed = false;
      try {
        withAccountMutationLock(() => {
          callbackRan = true;
          store.writeAccountSource(store.CLAUDE_ACCOUNTS_SOURCE, registry("after"));
        });
      } catch { failed = true; }
      for (const suffix of ["", "-wal", "-shm"]) { try { fs.chmodSync(database + suffix, 0o600); } catch {} }
      const read = store.readAccountSource(store.CLAUDE_ACCOUNTS_SOURCE);
      fs.writeFileSync(${JSON.stringify(result)}, JSON.stringify({
        callbackRan,
        failed,
        revisionMoved: accountMutationRevisionForTests() !== before,
        active: read.kind === "collection" ? read.body.active : null,
      }));
    `],
    stdout: "ignore",
    stderr: "pipe",
  });

  const exit = await child.exited;
  const error = await new Response(child.stderr).text();
  expect({ exit, error }).toEqual({ exit: 0, error: "" });
  expect(JSON.parse(fs.readFileSync(result, "utf8"))).toEqual({
    callbackRan: true,
    failed: true,
    revisionMoved: false,
    active: "before",
  });
});

test("a sync contender fails quickly while another process owns the file lock", async () => {
  const state = path.join(sandbox, "cross-process-state");
  const modulePath = path.join(import.meta.dir, "accountMutation.ts");
  const ready = path.join(sandbox, "cross-process-ready");
  const release = path.join(sandbox, "cross-process-release");
  const env = { ...process.env, LLV_STATE_DIR: state };
  const holder = Bun.spawn({
    cmd: [process.execPath, "-e", `
      const fs = await import("node:fs");
      const { withAccountMutationLockAsync } = await import(${JSON.stringify(modulePath)});
      await withAccountMutationLockAsync(async () => {
        fs.writeFileSync(${JSON.stringify(ready)}, "ready");
        while (!fs.existsSync(${JSON.stringify(release)})) await Bun.sleep(5);
      });
    `],
    env,
    stdout: "ignore",
    stderr: "pipe",
  });
  for (let attempt = 0; attempt < 100 && !fs.existsSync(ready); attempt += 1) await Bun.sleep(10);
  expect(fs.existsSync(ready)).toBeTrue();

  const contender = Bun.spawn({
    cmd: [process.execPath, "-e", `
      const { withAccountMutationLock } = await import(${JSON.stringify(modulePath)});
      try { withAccountMutationLock(() => undefined); process.exit(2); }
      catch { process.exit(0); }
    `],
    env,
    stdout: "ignore",
    stderr: "pipe",
  });
  const completed = await Promise.race([contender.exited.then(() => true), Bun.sleep(500).then(() => false)]);
  if (!completed) contender.kill();
  fs.writeFileSync(release, "release");
  const [holderExit, contenderError, holderError] = await Promise.all([
    holder.exited,
    new Response(contender.stderr).text(),
    new Response(holder.stderr).text(),
  ]);

  expect({ completed, holderExit, contenderError, holderError }).toEqual({
    completed: true,
    holderExit: 0,
    contenderError: "",
    holderError: "",
  });
});

/* The queue is shared across pid namespaces (viewer container, runtime-host
   container, host workers). A ticket whose pid collides with a live local
   process but was written in another namespace must expire by heartbeat age,
   never survive on the pid match. */
test("a stale foreign-namespace ticket is reaped even when its pid matches a live process", async () => {
  const state = path.join(sandbox, "foreign-ns-state");
  const result = path.join(sandbox, "foreign-ns-result.json");
  const modulePath = path.join(import.meta.dir, "accountMutation.ts");
  const procPath = path.join(import.meta.dir, "..", "proc", "index.ts");
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", `
      process.env.LLV_STATE_DIR = ${JSON.stringify(state)};
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { procBackend } = await import(${JSON.stringify(procPath)});
      const queue = path.join(${JSON.stringify(state)}, "account-selection.lock.queue");
      fs.mkdirSync(queue, { recursive: true, mode: 0o700 });
      const head = path.join(queue, "0000000000000001-99-foreign.json");
      fs.writeFileSync(head, JSON.stringify({
        pid: process.pid,
        startIdentity: procBackend.processIdentity(process.pid),
        ns: "pid:[4099999999]",
        token: "foreign-token",
      }));
      const past = new Date(Date.now() - 60_000);
      fs.utimesSync(head, past, past);
      const { withAccountMutationLock } = await import(${JSON.stringify(modulePath)});
      let ran = false;
      withAccountMutationLock(() => { ran = true; });
      fs.writeFileSync(${JSON.stringify(result)}, JSON.stringify({ ran, headRemoved: !fs.existsSync(head) }));
    `],
    stdout: "ignore",
    stderr: "pipe",
  });
  const exit = await child.exited;
  const error = await new Response(child.stderr).text();
  expect({ exit, error }).toEqual({ exit: 0, error: "" });
  expect(JSON.parse(fs.readFileSync(result, "utf8"))).toEqual({ ran: true, headRemoved: true });
});

test("a fresh foreign-namespace ticket keeps its place in the queue", async () => {
  const state = path.join(sandbox, "foreign-fresh-state");
  const result = path.join(sandbox, "foreign-fresh-result.json");
  const modulePath = path.join(import.meta.dir, "accountMutation.ts");
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", `
      process.env.LLV_STATE_DIR = ${JSON.stringify(state)};
      const fs = await import("node:fs");
      const path = await import("node:path");
      const queue = path.join(${JSON.stringify(state)}, "account-selection.lock.queue");
      fs.mkdirSync(queue, { recursive: true, mode: 0o700 });
      const head = path.join(queue, "0000000000000001-99-foreign.json");
      fs.writeFileSync(head, JSON.stringify({
        pid: 99,
        startIdentity: "99:1",
        ns: "pid:[4099999999]",
        token: "foreign-token",
      }));
      const { withAccountMutationLock } = await import(${JSON.stringify(modulePath)});
      let failed = false;
      try { withAccountMutationLock(() => undefined); }
      catch { failed = true; }
      fs.writeFileSync(${JSON.stringify(result)}, JSON.stringify({ failed, headKept: fs.existsSync(head) }));
    `],
    stdout: "ignore",
    stderr: "pipe",
  });
  const exit = await child.exited;
  const error = await new Response(child.stderr).text();
  expect({ exit, error }).toEqual({ exit: 0, error: "" });
  expect(JSON.parse(fs.readFileSync(result, "utf8"))).toEqual({ failed: true, headKept: true });
});

test("a ticket past the hard age cap is reaped even when its owner looks alive", async () => {
  const state = path.join(sandbox, "hard-cap-state");
  const result = path.join(sandbox, "hard-cap-result.json");
  const modulePath = path.join(import.meta.dir, "accountMutation.ts");
  const procPath = path.join(import.meta.dir, "..", "proc", "index.ts");
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", `
      process.env.LLV_STATE_DIR = ${JSON.stringify(state)};
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { procBackend } = await import(${JSON.stringify(procPath)});
      let ns = null;
      try { ns = fs.readlinkSync("/proc/self/ns/pid"); } catch {}
      const queue = path.join(${JSON.stringify(state)}, "account-selection.lock.queue");
      fs.mkdirSync(queue, { recursive: true, mode: 0o700 });
      const head = path.join(queue, "0000000000000001-99-leaked.json");
      fs.writeFileSync(head, JSON.stringify({
        pid: process.pid,
        startIdentity: procBackend.processIdentity(process.pid),
        ns,
        token: "leaked-token",
      }));
      const past = new Date(Date.now() - 700_000);
      fs.utimesSync(head, past, past);
      const { withAccountMutationLock } = await import(${JSON.stringify(modulePath)});
      let ran = false;
      withAccountMutationLock(() => { ran = true; });
      fs.writeFileSync(${JSON.stringify(result)}, JSON.stringify({ ran, headRemoved: !fs.existsSync(head) }));
    `],
    stdout: "ignore",
    stderr: "pipe",
  });
  const exit = await child.exited;
  const error = await new Response(child.stderr).text();
  expect({ exit, error }).toEqual({ exit: 0, error: "" });
  expect(JSON.parse(fs.readFileSync(result, "utf8"))).toEqual({ ran: true, headRemoved: true });
});

test("a duplicated module copy joins the transaction instead of failing busy", async () => {
  const state = path.join(sandbox, "duplicate-copy-state");
  const result = path.join(sandbox, "duplicate-copy-result.json");
  const modulePath = path.join(import.meta.dir, "accountMutation.ts");
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", `
      process.env.LLV_STATE_DIR = ${JSON.stringify(state)};
      const fs = await import("node:fs");
      const first = await import(${JSON.stringify(modulePath)});
      const second = await import(${JSON.stringify(modulePath)} + "?bundler-duplicate");
      const outcome = await first.withAccountMutationLockAsync(async () => {
        let nestedRan = false;
        let nestedError = null;
        try { second.withAccountMutationLock(() => { nestedRan = true; }); }
        catch (error) { nestedError = String(error); }
        return { nestedRan, nestedError };
      });
      fs.writeFileSync(${JSON.stringify(result)}, JSON.stringify(outcome));
    `],
    stdout: "ignore",
    stderr: "pipe",
  });

  const completed = await Promise.race([
    child.exited.then(() => true),
    Bun.sleep(5_000).then(() => false),
  ]);
  if (!completed) child.kill();
  const error = await new Response(child.stderr).text();

  expect({ completed, error }).toEqual({ completed: true, error: "" });
  expect(JSON.parse(fs.readFileSync(result, "utf8"))).toEqual({ nestedRan: true, nestedError: null });
});


test("async admission has one deadline, names the holder and removes a timed-out local waiter", async () => {
  const previousState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(sandbox, "bounded-wait");
  const { withAccountMutationLockAsync, AccountMutationBusyError } = await import("./accountMutation");
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const holder = withAccountMutationLockAsync(async () => {
    entered();
    await new Promise<void>((resolve) => { release = resolve; });
  }, { holder: "quota commit fixture" });
  await ready;
  const lines: string[] = [];
  const warn = console.warn;
  console.warn = (line) => { lines.push(String(line)); };
  let ran = false;
  const start = performance.now();
  try {
    const error = await withAccountMutationLockAsync(() => { ran = true; }, { caller: "resume", waitMs: 40 })
      .then(() => null, (error: unknown) => error);
    expect(error).toBeInstanceOf(AccountMutationBusyError);
    expect((error as Error).message).toContain("quota commit fixture");
    expect(performance.now() - start).toBeLessThan(250);
    expect(ran).toBeFalse();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: "account-mutation-refused", caller: "resume", holder: "quota commit fixture", holderPid: process.pid, waitMs: expect.any(Number), lockAgeMs: expect.any(Number) });
    expect(JSON.parse(lines[0]!).waitMs).toBeGreaterThanOrEqual(30);
    release();
    await holder;
    await withAccountMutationLockAsync(() => undefined, { waitMs: 100 });
    expect(ran).toBeFalse();
    expect(fs.readdirSync(path.join(process.env.LLV_STATE_DIR!, "account-selection.lock.queue"))).toEqual([]);
  } finally {
    console.warn = warn;
    release();
    await holder;
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
  }
});


test("cross-process admission times out with the file owner's pid and age, then recovers", async () => {
  const previousState = process.env.LLV_STATE_DIR;
  const state = path.join(sandbox, "async-cross-process");
  process.env.LLV_STATE_DIR = state;
  const ready = path.join(sandbox, "async-cross-process-ready");
  const release = path.join(sandbox, "async-cross-process-release");
  const modulePath = path.join(import.meta.dir, "accountMutation.ts");
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", `
      const fs = await import("node:fs");
      const { withAccountMutationLockAsync } = await import(${JSON.stringify(modulePath)});
      await withAccountMutationLockAsync(async () => {
        fs.writeFileSync(${JSON.stringify(ready)}, "ready");
        while (!fs.existsSync(${JSON.stringify(release)})) await Bun.sleep(5);
      }, { holder: "remote mutation fixture" });
    `], env: { ...process.env, LLV_STATE_DIR: state }, stdout: "ignore", stderr: "pipe",
  });
  const { withAccountMutationLockAsync, AccountMutationBusyError } = await import("./accountMutation");
  try {
    for (let attempt = 0; attempt < 100 && !fs.existsSync(ready); attempt += 1) await Bun.sleep(10);
    expect(fs.existsSync(ready)).toBeTrue();
    const error = await withAccountMutationLockAsync(() => undefined, { waitMs: 50 }).then(() => null, (error: unknown) => error);
    expect(error).toBeInstanceOf(AccountMutationBusyError);
    expect((error as InstanceType<typeof AccountMutationBusyError>).owner.ageMs).toBeGreaterThanOrEqual(40);
    expect((error as InstanceType<typeof AccountMutationBusyError>).owner).toMatchObject({ operation: "remote mutation fixture", pid: child.pid, ageMs: expect.any(Number) });
    const waiting = withAccountMutationLockAsync(() => "admitted", { waitMs: 500 });
    fs.writeFileSync(release, "release");
    expect(await waiting).toBe("admitted");
    expect(await child.exited).toBe(0);
  } finally {
    fs.writeFileSync(release, "release");
    const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(1000).then(() => false)]);
    if (!exited) { child.kill(); await child.exited; }
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
  }
});


test("credential fingerprints include Keychain contents without exposing them", async () => {
  const { claudeProbeCredentialIdentity } = await import("./accountMutation");
  const fingerprint = (value: string) => claudeProbeCredentialIdentity("/fixture/home", () => ({ state: "present", source: "keychain", document: { fixture: value } }));
  expect(fingerprint("before")).not.toBe(fingerprint("after"));
  expect(fingerprint("before")).toMatch(/^[a-f0-9]{64}$/);
  expect(claudeProbeCredentialIdentity("/fixture/home", () => ({ state: "unknown" }))).toBeNull();
});
