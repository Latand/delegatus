import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRegistry, type AgentRegistryStorageOptions } from "./registry";

/*
 * Test fixture for rule (c) of docs/design/delivery-progress-and-drain.md: a
 * separate process holds the registry's SQLite write lock (`BEGIN IMMEDIATE`)
 * while the code under test writes, and a 5 ms heartbeat measures how long the
 * test's own event loop was held. Every database is a private temporary file.
 */

export interface RegistryLockHolder {
  /** Takes the lock and keeps it for `ms`; resolves once it is held. */
  hold(ms: number): Promise<void>;
  /** Takes the lock for `holdMs`, gives it up for `gapMs`, again and again,
      so every write made meanwhile has to wait for it. */
  cycle(holdMs: number, gapMs: number): Promise<void>;
  /** Stops cycling; resolves once the lock is free. */
  release(): Promise<void>;
  close(): Promise<void>;
}

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
        if (held) { process.stdout.write("locked\\n"); if (timer) clearTimeout(timer); }
        else take();
        timer = setTimeout(() => { give(); process.stdout.write("free\\n"); }, Number(first));
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
  return {
    async hold(ms) { send(`hold ${ms}`); await waitFor("locked"); },
    async cycle(holdMs, gapMs) { send(`cycle ${holdMs} ${gapMs}`); await waitFor("locked"); },
    async release() { send("release"); await waitFor("free"); lines.length = 0; },
    async close() {
      try { send("exit"); } catch { /* already gone */ }
      await child.exited;
    },
  };
}

/** The longest gap between 5 ms ticks of this process's loop while `operation` runs. */
export async function longestLoopGap<T>(operation: () => Promise<T> | T): Promise<{ value: T; gapMs: number }> {
  let last = performance.now();
  let gapMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    gapMs = Math.max(gapMs, now - last);
    last = now;
  }, 5);
  try {
    const value = await operation();
    await new Promise((resolve) => setTimeout(resolve, 15));
    gapMs = Math.max(gapMs, performance.now() - last);
    return { value, gapMs };
  } finally {
    clearInterval(timer);
  }
}

/** A registry in SQLite mode under a private temporary directory. */
export function sqliteRegistryFixture(
  prefix: string,
  options: AgentRegistryStorageOptions = {},
): { registry: AgentRegistry; root: string; sqliteFilename: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const filename = path.join(root, "registry.json");
  const sqliteFilename = path.join(root, "registry.sqlite");
  const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite", sqliteFilename, ...options });
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
    mutate: (fn: unknown, options?: unknown) => unknown;
  };
  const internals = registry as unknown as Internals;
  const whenWriterHeld = internals.whenWriterHeld;
  const mutate = internals.mutate;
  const unwrapped: string[] = [];
  let inside = 0;
  internals.whenWriterHeld = async function (this: unknown, correlation, operation, correlate) {
    await holder.hold(holdMs);
    return whenWriterHeld.call(registry, correlation, () => {
      inside += 1;
      try { return operation(); } finally { inside -= 1; }
    }, correlate);
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
      internals.mutate = mutate;
    },
  };
}
