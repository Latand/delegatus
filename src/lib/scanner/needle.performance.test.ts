import { afterAll, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fileHasNeedle, findNeedle, type NeedleScanBudget } from "./needle";
import { cachePayloadBytes, cacheSizes } from "../cacheTelemetry";
import { globalCache } from "./caches";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-needle-performance-"));
const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;

const realReadSync = fs.readSync;
let observedBytes = 0;

function instrumentReads(): void {
  observedBytes = 0;
  (fs as { readSync: typeof fs.readSync }).readSync = ((...args: Parameters<typeof fs.readSync>) => {
    const read = (realReadSync as (...inner: Parameters<typeof fs.readSync>) => number)(...args);
    observedBytes += read;
    return read;
  }) as typeof fs.readSync;
}

afterEach(() => {
  (fs as { readSync: typeof fs.readSync }).readSync = realReadSync;
});

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

/** A logical 3 GiB append-only transcript: real JSONL rows at the head, a
    sparse hole for the bulk. Reads stay cheap while sizes match production. */
function virtualTranscript(name: string, logicalBytes = 3 * GIB): string {
  const pathname = path.join(SANDBOX, name);
  const fd = fs.openSync(pathname, "w");
  try {
    fs.writeSync(fd, `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } })}\n`);
    fs.ftruncateSync(fd, logicalBytes);
  } finally {
    fs.closeSync(fd);
  }
  return pathname;
}

test("an absent needle in a 3 GiB candidate consumes exactly the generation budget", () => {
  const pathname = virtualTranscript("absent-needle.jsonl");
  const budget: NeedleScanBudget = { remaining: 256 * 1024 };
  instrumentReads();

  expect(fileHasNeedle("toolu_deadbeef", pathname, budget)).toBe(false);

  expect(observedBytes).toBe(256 * 1024);
  expect(budget.remaining).toBe(0);
  // An exhausted budget refuses further reads outright.
  expect(fileHasNeedle("toolu_deadbeef", pathname, budget)).toBe(false);
  expect(observedBytes).toBe(256 * 1024);
});

test("a candidate pass is capped at 1 MiB even under a larger generation budget", () => {
  const pathname = virtualTranscript("pass-capped.jsonl");
  const budget: NeedleScanBudget = { remaining: 8 * MIB };
  instrumentReads();

  expect(fileHasNeedle("toolu_pass_cap", pathname, budget)).toBe(false);

  expect(observedBytes).toBe(MIB);
  expect(budget.remaining).toBe(7 * MIB);
});

test("budgeted scanning resumes deterministically and proves lineage once reached", () => {
  const pathname = virtualTranscript("resumable.jsonl", 4 * MIB);
  const needle = "toolu_resume_proof";
  const fd = fs.openSync(pathname, "r+");
  try {
    const proof = Buffer.from(`{"toolUseId":"${needle}"}\n`);
    fs.writeSync(fd, proof, 0, proof.length, Math.floor(2.5 * MIB));
  } finally {
    fs.closeSync(fd);
  }

  // Generation 1 and 2 exhaust their 1 MiB budgets before the proof offset.
  expect(fileHasNeedle(needle, pathname, { remaining: MIB })).toBe(false);
  expect(fileHasNeedle(needle, pathname, { remaining: MIB })).toBe(false);
  // Generation 3 reaches 2.5 MiB and proves the lineage.
  expect(fileHasNeedle(needle, pathname, { remaining: MIB })).toBe(true);
  // The proven hit is cached: an exhausted budget still answers true.
  expect(fileHasNeedle(needle, pathname, { remaining: 0 })).toBe(true);
});

test("an append between budgeted passes preserves needle scan progress", () => {
  const pathname = path.join(SANDBOX, "append-between-passes.jsonl");
  const needle = "toolu_append_progress";
  const transcript = Buffer.alloc(600 * 1024, 0x78);
  transcript.write(needle, 300 * 1024, "utf8");
  fs.writeFileSync(pathname, transcript);

  expect(fileHasNeedle(needle, pathname, { remaining: 256 * 1024 })).toBe(false);
  fs.appendFileSync(pathname, "\n");
  expect(fileHasNeedle(needle, pathname, { remaining: 256 * 1024 })).toBe(true);
});

test("findNeedle shares one generation budget across candidate files", () => {
  const first = virtualTranscript("shared-a.jsonl", 4 * MIB);
  const second = virtualTranscript("shared-b.jsonl", 4 * MIB);
  const budget: NeedleScanBudget = { remaining: 1.5 * MIB };
  instrumentReads();

  expect(findNeedle("toolu_shared_budget", [first, second], budget)).toBe(null);

  // Both candidates consume an equal share of the generation allowance.
  expect(observedBytes).toBe(1.5 * MIB);
  expect(budget.remaining).toBe(0);
});

test("findNeedle reserves production-budget bytes for a later sibling proof", () => {
  const first = virtualTranscript("fair-production-a.jsonl", MIB);
  const second = path.join(SANDBOX, "fair-production-b.jsonl");
  const needle = "toolu_fair_proof";
  fs.writeFileSync(second, `${needle}\n`);
  const budget: NeedleScanBudget = { remaining: 256 * 1024 };
  instrumentReads();

  expect(findNeedle(needle, [first, second], budget)).toBe(second);
  expect(observedBytes).toBeLessThanOrEqual(256 * 1024);
  expect(budget.remaining).toBeGreaterThanOrEqual(0);
});

test("a legacy needle cache entry cannot preserve a stale replacement offset", () => {
  const pathname = path.join(SANDBOX, "legacy-cache-replacement.jsonl");
  const needle = "toolu_legacy_replacement";
  const replacement = Buffer.alloc(2 * MIB, 0x79);
  replacement.write(needle, 32, "utf8");
  fs.writeFileSync(pathname, replacement);
  const cacheStore = globalThis as typeof globalThis & {
    __llvCaches?: Record<string, Map<string, unknown>>;
  };
  cacheStore.__llvCaches ??= {};
  cacheStore.__llvCaches.needle ??= new Map();
  cacheStore.__llvCaches.needle.set(needle, {
    hits: {},
    scanned: { [pathname]: MIB },
  });

  expect(fileHasNeedle(needle, pathname, { remaining: MIB })).toBe(true);
});

test("a truncated candidate restarts its observation instead of skipping content", () => {
  const pathname = path.join(SANDBOX, "truncated.jsonl");
  fs.writeFileSync(pathname, "x".repeat(2 * MIB));
  expect(fileHasNeedle("toolu_truncated", pathname)).toBe(false);

  fs.writeFileSync(pathname, `prefix toolu_truncated suffix\n`);
  expect(fileHasNeedle("toolu_truncated", pathname)).toBe(true);
});

test("a candidate that shrinks above its saved offset rescans replacement head content", () => {
  const pathname = path.join(SANDBOX, "shrunken-above-offset.jsonl");
  const needle = "toolu_replacement_head";
  fs.writeFileSync(pathname, Buffer.alloc(3 * MIB, 0x78));

  expect(fileHasNeedle(needle, pathname, { remaining: MIB })).toBe(false);

  const replacement = Buffer.alloc(2 * MIB, 0x79);
  replacement.write(needle, 32, "utf8");
  fs.writeFileSync(pathname, replacement);
  expect(fs.statSync(pathname).size).toBeGreaterThan(MIB);

  expect(fileHasNeedle(needle, pathname, { remaining: 0 })).toBe(false);
  expect(fileHasNeedle(needle, pathname, { remaining: MIB })).toBe(true);
});

test("a same-size replacement resets a partial needle offset", () => {
  const pathname = path.join(SANDBOX, "same-size-replacement.jsonl");
  const needle = "toolu_same_size_replacement";
  fs.writeFileSync(pathname, Buffer.alloc(2 * MIB, 0x78));
  expect(fileHasNeedle(needle, pathname, { remaining: MIB })).toBe(false);
  const before = fs.statSync(pathname);

  const replacement = Buffer.alloc(2 * MIB, 0x79);
  replacement.write(needle, 32, "utf8");
  fs.writeFileSync(pathname, replacement);
  fs.utimesSync(pathname, before.atime, new Date(before.mtimeMs + 2_000));
  expect(fs.statSync(pathname).ino).toBe(before.ino);

  expect(fileHasNeedle(needle, pathname, { remaining: MIB })).toBe(true);
});

function retainedNeedleFiles(count: number) {
  const entry = {
    hits: {} as Record<string, boolean>,
    scanned: {} as Record<string, number>,
    sizes: {} as Record<string, number>,
    observations: {} as Record<string, { dev: number; ino: number; size: number; mtimeMs: number }>,
    boundaries: {} as Record<string, { offset: number; bytes: number; fingerprint: string }>,
  };
  for (let index = 0; index < count; index++) {
    const key = `retained-${index}`;
    entry.scanned[key] = entry.sizes[key] = 8;
    entry.observations[key] = { dev: 1, ino: index, size: 8, mtimeMs: 1 };
    entry.boundaries[key] = { offset: 0, bytes: 8, fingerprint: "retained-boundary" };
  }
  return entry;
}

test("needle mutation accounting never visits unrelated retained file descriptors", () => {
  const cache = globalCache<ReturnType<typeof retainedNeedleFiles>>("needle-v2");
  cache.clear();
  try {
    for (const retained of [0, 64, 1024]) {
      const needle = "needle";
      const entry = retainedNeedleFiles(retained);
      cache.set(needle, entry);
      let unrelatedDescriptors = 0, enumerations = 0;
      for (const field of ["hits", "scanned", "sizes", "observations", "boundaries"] as const) {
        Reflect.set(entry, field, new Proxy(entry[field], {
          getOwnPropertyDescriptor(target, key) {
            if (typeof key === "string" && key.startsWith("retained-")) unrelatedDescriptors++;
            return Reflect.getOwnPropertyDescriptor(target, key);
          },
          ownKeys(target) { enumerations++; return Reflect.ownKeys(target); },
        }));
      }
      const pathname = path.join(SANDBOX, `accounting-${retained}.jsonl`);
      fs.writeFileSync(pathname, "missing\n");
      expect(fileHasNeedle(needle, pathname, { remaining: 1024 })).toBe(false);
      const paused = path.join(SANDBOX, `paused-${retained}.jsonl`);
      fs.writeFileSync(paused, "missing\n");
      expect(fileHasNeedle(needle, paused, { remaining: 0 })).toBe(false);
      fs.appendFileSync(pathname, "needle\n");
      expect(fileHasNeedle(needle, pathname, { remaining: 1024 })).toBe(true);
      fs.writeFileSync(pathname, "x\n");
      expect(fileHasNeedle(needle, pathname, { remaining: 0 })).toBe(false);
      expect(fileHasNeedle(needle, pathname, { remaining: 1024 })).toBe(false);
      expect({ unrelatedDescriptors, enumerations }).toEqual({ unrelatedDescriptors: 0, enumerations: 0 });
      cache.clear();
    }
  } finally { cache.clear(); }
});

test("needle file deltas preserve complete payload charges through resets, errors and removal", () => {
  const cache = globalCache<ReturnType<typeof retainedNeedleFiles>>("needle-v2");
  const needle = "charge-proof";
  const pathname = path.join(SANDBOX, "charge-proof.jsonl");
  const row = () => cacheSizes().caches.find(item => item.owner === "scanner/caches" && item.name === "needle-v2")!;
  const check = () => expect(row()).toMatchObject({ count: 1, unmeasured: 0,
    bytes: cachePayloadBytes([needle, cache.get(needle)]) });
  cache.clear();
  try {
    cache.set(needle, retainedNeedleFiles(64));
    check();
    fs.writeFileSync(pathname, "missing\n");
    expect(fileHasNeedle(needle, pathname, { remaining: 0 })).toBe(false);
    check();
    expect(fileHasNeedle(needle, pathname, { remaining: 1024 })).toBe(false);
    check();
    fs.appendFileSync(pathname, `${needle}\n`);
    expect(fileHasNeedle(needle, pathname, { remaining: 1024 })).toBe(true);
    check();
    const before = fs.statSync(pathname);
    fs.writeFileSync(pathname, "x".repeat(before.size));
    fs.utimesSync(pathname, new Date(0), new Date(before.mtimeMs + 2000));
    expect(fileHasNeedle(needle, pathname, { remaining: 0 })).toBe(false);
    check();
    expect(fileHasNeedle(needle, pathname, { remaining: 1024 })).toBe(false);
    check();
    fs.writeFileSync(pathname, "x");
    expect(fileHasNeedle(needle, pathname, { remaining: 1024 })).toBe(false);
    check();
    fs.unlinkSync(pathname);
    expect(fileHasNeedle(needle, pathname, { remaining: 1024 })).toBe(false);
    check();
    fs.writeFileSync(pathname, "new generation\n");
    const open = fs.openSync;
    fs.openSync = (() => { throw new Error("fixture read refused"); }) as typeof fs.openSync;
    try { expect(fileHasNeedle(needle, pathname, { remaining: 1024 })).toBe(false); }
    finally { fs.openSync = open; }
    check();
    cache.set(needle, retainedNeedleFiles(1));
    check();
    expect(cache.delete(needle)).toBe(true);
    expect(cache.delete(needle)).toBe(false);
    expect(row()).toMatchObject({ count: 0, bytes: 0, unmeasured: 0 });
    // Reusing the same key after clear must start from its new entry's sum.
    expect(fileHasNeedle(needle, pathname, { remaining: 1024 })).toBe(false);
    check();
    cache.clear();
    expect(row()).toMatchObject({ count: 0, bytes: 0, unmeasured: 0 });
    expect(fileHasNeedle(needle, pathname, { remaining: 1024 })).toBe(false);
    check();
  } finally { cache.clear(); }
});

test("an unreadable needle estimate preserves scanning and releases its unknown charge on replacement", () => {
  const cache = globalCache<ReturnType<typeof retainedNeedleFiles>>("needle-v2");
  const needle = "unknown-charge";
  const pathname = path.join(SANDBOX, "unknown-charge.jsonl");
  const row = () => cacheSizes().caches.find(item => item.owner === "scanner/caches" && item.name === "needle-v2")!;
  cache.clear();
  try {
    const entry = retainedNeedleFiles(0);
    cache.set(needle, entry);
    entry.scanned = new Proxy(entry.scanned, {
      getOwnPropertyDescriptor() { throw new Error("fixture estimate refused"); },
      set(target, key, value) { return Reflect.set(target, key, value, target); },
    });
    fs.writeFileSync(pathname, `${needle}\n`);
    expect(fileHasNeedle(needle, pathname, { remaining: 1024 })).toBe(true);
    expect(row()).toMatchObject({ count: 1, bytes: 0, unmeasured: 1 });
    cache.set(needle, retainedNeedleFiles(0));
    expect(row()).toMatchObject({ count: 1, bytes: cachePayloadBytes([needle, cache.get(needle)]), unmeasured: 0 });
    cache.delete(needle);
    expect(row()).toMatchObject({ count: 0, bytes: 0, unmeasured: 0 });
  } finally { cache.clear(); }
});
