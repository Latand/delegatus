import { expect, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SqliteAgentRegistryStore } from "./sqliteRegistryStore";
import { AgentRegistry, type AgentRegistryStorageOptions } from "./registry";

/*
 * Test fixture for rule (c) of docs/design/delivery-progress-and-drain.md: a
 * separate process holds the registry's SQLite write lock (`BEGIN IMMEDIATE`)
 * while the code under test writes. A short timer must progress during the
 * wait, and only the test process releases a successful writer. Every database
 * is a private temporary file.
 */

export interface RegistryLockHolder {
  readonly sqliteFilename: string;
  /** Takes the lock until release(), or for `ms`; resolves once it is held. */
  hold(ms?: number): Promise<void>;
  /** Takes the lock for `holdMs`, gives it up for `gapMs`, again and again,
      so every write made meanwhile has to wait for it. */
  cycle(holdMs: number, gapMs: number): Promise<void>;
  /** Stops cycling; resolves once the lock is free. */
  release(): Promise<void>;
  close(): Promise<void>;
}

type RegistryLockFixtureOptions = AgentRegistryStorageOptions & { writerClock?: () => number };

const HOLDER_SCRIPT = `
  const { Database } = require("bun:sqlite");
  const db = new Database(process.argv[1]);
  db.exec("PRAGMA busy_timeout = 5000");
  let held = false;
  let cycling = null;
  let timer = null;
  const take = () => { db.exec("BEGIN IMMEDIATE"); held = true; process.stdout.write("locked\\n"); };
  const give = () => { if (held) { db.exec("ROLLBACK"); held = false; } };
  const stop = () => { cycling = null; if (timer) clearTimeout(timer); timer = null; give(); process.stdout.write("free\\n"); };
  const loop = () => {
    if (!cycling) return;
    take();
    timer = setTimeout(() => { give(); timer = setTimeout(loop, cycling ? cycling.gap : 0); }, cycling.hold);
  };
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf("\\n")) >= 0) {
      const [command, first, second] = buffer.slice(0, index).trim().split(" ");
      buffer = buffer.slice(index + 1);
      if (command === "hold") {
        /* A hold asked for while one is running extends it. */
        if (held) { process.stdout.write("locked\\n"); }
        else take();
        if (timer) clearTimeout(timer);
        timer = first === undefined ? null : setTimeout(() => { give(); process.stdout.write("free\\n"); }, Number(first));
      }
      if (command === "cycle") { cycling = { hold: Number(first), gap: Number(second) }; loop(); }
      if (command === "release") stop();
      if (command === "exit") { stop(); db.close(); process.exit(0); }
    }
  });
`;

export function registryLockHolder(sqliteFilename: string): RegistryLockHolder {
  const child = Bun.spawn([process.execPath, "-e", HOLDER_SCRIPT, sqliteFilename], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  const lines: string[] = [];
  const waitFor = async (line: string): Promise<void> => {
    for (;;) {
      const index = lines.indexOf(line);
      if (index >= 0) { lines.splice(0, index + 1); return; }
      const { value, done } = await reader.read();
      if (done) throw new Error(`the lock holder ended before it said ${line}`);
      pending += decoder.decode(value);
      const parts = pending.split("\n");
      pending = parts.pop() ?? "";
      lines.push(...parts.map((part) => part.trim()).filter(Boolean));
    }
  };
  const send = (command: string) => { child.stdin.write(`${command}\n`); child.stdin.flush(); };
  let commands = Promise.resolve();
  const serial = (operation: () => Promise<void>) => {
    const result = commands.then(operation);
    commands = result.catch(() => {});
    return result;
  };
  return {
    sqliteFilename,
    hold(ms) { return serial(async () => { send(ms === undefined ? "hold" : `hold ${ms}`); await waitFor("locked"); }); },
    cycle(holdMs, gapMs) { return serial(async () => { send(`cycle ${holdMs} ${gapMs}`); await waitFor("locked"); }); },
    release() { return serial(async () => { send("release"); await waitFor("free"); lines.length = 0; }); },
    async close() {
      try { send("exit"); } catch { /* already gone */ }
      await child.exited;
    },
  };
}

/** Synchronous refusal paths must use a single non-waiting SQLite attempt. */
export function withoutWriterWait<T>(filename: string, operation: () => T, attemptCount = 1): T {
  const attempts: number[] = [];
  const exec = Database.prototype.exec;
  const calls = spyOn(Database.prototype, "exec").mockImplementation(function (this: Database, ...args: Parameters<Database["exec"]>) {
    if (this.filename === filename && /BEGIN IMMEDIATE/i.test(args[0])) {
      const timeout = this.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()!.timeout;
      attempts.push(timeout);
    }
    return exec.apply(this, args);
  });
  try { return operation(); }
  finally {
    calls.mockRestore();
    expect(attempts, "each expected writer request must use zero busy timeout").toEqual(Array(attemptCount).fill(0));
  }
}

/** Captures short-timer progress while an operation is pending; lateness is diagnostic. */
export function loopProgressProbe() {
  let finished = false;
  const samples: Array<{ pending: boolean; latenessMs: number }> = [];
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const releases: Promise<void>[] = [];
  return {
    arm(release: () => void | Promise<void> = () => {}) {
      const at = performance.now();
      releases.push(new Promise<void>((resolve, reject) => {
        timers.push(setTimeout(() => {
          samples.push({ pending: !finished, latenessMs: Math.max(0, performance.now() - at - 5) });
          Promise.resolve().then(release).then(resolve, reject);
        }, 5));
      }));
    },
    async run<T>(operation: () => T | Promise<T>, requireSample = true, requirePending = true): Promise<T> {
      // A synchronous mutation must mark completion before the delayed timer.
      let result: PromiseSettledResult<T>;
      try {
        result = { status: "fulfilled", value: await operation() };
      } catch (reason) {
        result = { status: "rejected", reason };
      } finally {
        finished = true;
      }
      try {
        await Promise.all(releases);
        if (requireSample) expect(samples.length, "no contended wait was observed").toBeGreaterThan(0);
        for (const sample of samples) {
          if (!requirePending) continue;
          expect(sample.pending, `wait timer lateness: ${sample.latenessMs.toFixed(1)} ms`).toBe(true);
        }
        if (result.status === "rejected") throw result.reason;
        return result.value;
      } finally {
        for (const timer of timers) clearTimeout(timer);
      }
    },
  };
}

/** Every real writer acquisition must let a short timer run while it waits. */
export async function whileRegistryWriterHeld<T>(
  holder: RegistryLockHolder,
  operation: () => T | Promise<T>,
  { release = true, alreadyHeld = true }: { release?: boolean; alreadyHeld?: boolean } = {},
): Promise<{ value: T }> {
  const hold = holder.hold;
  const withWriter = SqliteAgentRegistryStore.prototype.withWriter;
  let observed = 0;
  const progressFailures: unknown[] = [];
  let active = alreadyHeld;
  // Internal fixture holds remain held until the test explicitly releases them.
  holder.hold = async () => { await hold(); active = true; };
  const writer = spyOn(SqliteAgentRegistryStore.prototype, "withWriter").mockImplementation((async function (
    this: SqliteAgentRegistryStore, ...args: Parameters<SqliteAgentRegistryStore["withWriter"]>
  ) {
    if (this.filename !== holder.sqliteFilename || !active) return withWriter.apply(this, args);
    await hold();
    const probe = loopProgressProbe();
    probe.arm(release ? async () => { await holder.release(); active = false; } : undefined);
    observed++;
    return probe.run(() => withWriter.apply(this, args), true, true).catch(error => {
      if (/wait timer lateness|no contended wait/.test(String(error))) progressFailures.push(error);
      throw error;
    });
  }) as typeof withWriter);
  const tryWriter = SqliteAgentRegistryStore.prototype.tryWriter;
  const probe = loopProgressProbe();
  let armedTry = false;
  const immediate = spyOn(SqliteAgentRegistryStore.prototype, "tryWriter").mockImplementation((function (
    this: SqliteAgentRegistryStore, ...args: Parameters<SqliteAgentRegistryStore["tryWriter"]>
  ) {
    if (active && this.filename === holder.sqliteFilename && !armedTry) {
      armedTry = true;
      observed++;
      probe.arm(release ? async () => { await holder.release(); active = false; } : undefined);
    }
    return tryWriter.apply(this, args);
  }) as typeof tryWriter);
  const timeouts: number[] = [];
  const exec = Database.prototype.exec;
  const attempts = spyOn(Database.prototype, "exec").mockImplementation(function (this: Database, ...args: Parameters<Database["exec"]>) {
    if (active && this.filename === holder.sqliteFilename && /BEGIN IMMEDIATE/i.test(args[0])) {
      timeouts.push(this.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()!.timeout);
    }
    return exec.apply(this, args);
  });
  try { return { value: await probe.run(operation, false, true) }; }
  finally {
    attempts.mockRestore();
    immediate.mockRestore();
    writer.mockRestore();
    holder.hold = hold;
    expect(progressFailures, "writer wait blocked the short timer").toEqual([]);
    expect(observed, "no contended writer acquisition was observed").toBeGreaterThan(0);
    expect(timeouts.every(timeout => timeout === 0), `contended SQLite busy handlers: ${timeouts.join(", ")}`).toBe(true);
  }
}

/** A registry in SQLite mode under a private temporary directory. */
export function sqliteRegistryFixture(
  prefix: string,
  options: RegistryLockFixtureOptions = {},
): { registry: AgentRegistry; root: string; sqliteFilename: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const filename = path.join(root, "registry.json");
  const sqliteFilename = path.join(root, "registry.sqlite");
  let progressClock = 0;
  const registry = new AgentRegistry(filename, undefined, undefined, {
    sqliteMode: "sqlite",
    sqliteFilename,
    ...options,
  });
  if (options.sqliteWriterDeadlineMs !== undefined) {
    const store = (registry as unknown as { sqliteStore: SqliteAgentRegistryStore }).sqliteStore;
    (store as unknown as { writerClock: () => number }).writerClock = options.writerClock ?? (() => (progressClock += 5));
  }
  return { registry, root, sqliteFilename, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/**
 * Makes every off-loop registry write of `registry` meet the lock held by
 * `holder` for `holdMs`, and records every mutation made outside one whose
 * stack passes through one of `modules`: a synchronous write on a path rule (c)
 * covers. Restores the registry on `restore()`.
 */
export function holdBeforeEachWrite(
  registry: AgentRegistry,
  holder: RegistryLockHolder,
  holdMs: number,
  modules: RegExp,
): { unwrapped: string[]; restore: () => void } {
  type Internals = {
    whenWriterHeld: (correlation: unknown, operation: () => unknown, correlate?: unknown) => Promise<unknown>;
    accountMutationWrite: (label: string, operation: () => unknown, guard?: () => void, options?: Parameters<AgentRegistry["accountMutationWrite"]>[3]) => Promise<unknown>;
    mutate: (fn: unknown, options?: unknown) => unknown;
  };
  const internals = registry as unknown as Internals;
  const whenWriterHeld = internals.whenWriterHeld;
  const accountMutationWrite = internals.accountMutationWrite;
  const mutate = internals.mutate;
  const unwrapped: string[] = [];
  let inside = 0;
  const tracked = (operation: () => unknown) => () => {
    inside += 1;
    try { return operation(); } finally { inside -= 1; }
  };
  internals.whenWriterHeld = async function (this: unknown, correlation, operation, correlate) {
    await holder.hold(holdMs);
    return whenWriterHeld.call(registry, correlation, tracked(operation), correlate);
  };
  internals.accountMutationWrite = async function (this: unknown, label, operation, guard, options) {
    await holder.hold(holdMs);
    return accountMutationWrite.call(registry, label, tracked(operation), guard, options);
  };
  internals.mutate = function (this: unknown, fn, options) {
    const stack = new Error().stack ?? "";
    if (inside === 0 && modules.test(stack)) {
      unwrapped.push(stack.split("\n").slice(2, 5).map((line) => line.trim()).join(" < "));
    }
    return mutate.call(registry, fn, options);
  };
  return {
    unwrapped,
    restore: () => {
      internals.whenWriterHeld = whenWriterHeld;
      internals.accountMutationWrite = accountMutationWrite;
      internals.mutate = mutate;
    },
  };
}
