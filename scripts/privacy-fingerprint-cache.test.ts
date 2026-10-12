import { expect, spyOn, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fingerprintNegativeCache } from "./privacy-fingerprint-cache";

const cacheTest = process.platform === "linux" ? test : test.skip;

async function boundedReader(source: string, mode: "seal" | "slot"): Promise<{ exitCode: number; timedOut: boolean }> {
  const cacheDir = process.env.LLV_PRIVACY_FINGERPRINT_CACHE_DIR!;
  const modulePath = new URL("./privacy-fingerprint-cache.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, "-e", `
    const { fingerprintNegativeCache } = await import(${JSON.stringify(modulePath)});
    const cache = fingerprintNegativeCache(process.argv[1]);
    if (!cache) process.exit(2);
    if (process.argv[2] === "slot") cache.has("${"a".repeat(64)}");
  `, source, mode], { cwd: import.meta.dir, env: { ...process.env, LLV_PRIVACY_FINGERPRINT_CACHE_DIR: cacheDir }, stdout: "ignore", stderr: "ignore" });
  const result = await Promise.race([
    child.exited.then((exitCode) => ({ exitCode, timedOut: false })),
    new Promise<{ exitCode: number; timedOut: boolean }>((resolve) => setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ exitCode: -1, timedOut: true });
    }, 1500)),
  ]);
  if (result.timedOut) await child.exited;
  return result;
}

function makeFifo(path: string): void {
  if (Bun.spawnSync(["mkfifo", "-m", "600", path]).exitCode !== 0) {
    throw new Error("could not create synthetic cache FIFO");
  }
}

async function runGateCli(repository: string, cacheDirectory: string | undefined, ci: boolean) {
  const env: Record<string, string> = { ...process.env as Record<string, string>,
    LLV_PRIVACY_KNOWN_VALUES: "",
    LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: join(import.meta.dir, "privacy-known-value-fingerprints.json"),
    LLV_PRIVACY_OCR_LANGUAGES: "eng+ukr",
  };
  if (cacheDirectory) env.LLV_PRIVACY_FINGERPRINT_CACHE_DIR = cacheDirectory;
  else delete env.LLV_PRIVACY_FINGERPRINT_CACHE_DIR;
  if (ci) env.CI = "true"; else delete env.CI;
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "privacy-publication-gate.ts"),
    "--repository", repository, "--require-known-values", "--paths", "note.txt"],
  { cwd: import.meta.dir, env, stdout: "pipe", stderr: "pipe" });
  const result = await Promise.race([
    Promise.all([child.exited, new Response(child.stdout).arrayBuffer(), new Response(child.stderr).arrayBuffer()])
      .then(([exitCode, stdout, stderr]) => ({ exitCode, report: Buffer.concat([Buffer.from(stdout), Buffer.from(stderr)]), timedOut: false })),
    new Promise<{ exitCode: number; report: Buffer; timedOut: boolean }>((resolve) => setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ exitCode: -1, report: Buffer.alloc(0), timedOut: true });
    }, 2500)),
  ]);
  if (result.timedOut) await child.exited;
  return result;
}

function fixture(run: (root: string, source: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "privacy-fingerprint-cache-"));
  const source = join(root, "scanner.ts");
  writeFileSync(source, "first scanner revision");
  const saved = { directory: process.env.LLV_PRIVACY_FINGERPRINT_CACHE_DIR, ci: process.env.CI };
  delete process.env.CI;
  process.env.LLV_PRIVACY_FINGERPRINT_CACHE_DIR = join(root, "cache");
  try { run(root, source); } finally {
    if (saved.directory === undefined) delete process.env.LLV_PRIVACY_FINGERPRINT_CACHE_DIR;
    else process.env.LLV_PRIVACY_FINGERPRINT_CACHE_DIR = saved.directory;
    if (saved.ci === undefined) delete process.env.CI; else process.env.CI = saved.ci;
    rmSync(root, { recursive: true, force: true });
  }
}

cacheTest("negative records survive a fresh reader and bind source, input and policy", () => fixture((root, source) => {
  const writer = fingerprintNegativeCache(source)!;
  const text = "synthetic publication text";
  const key = writer.key(text, "policy one");
  expect(writer.has(key)).toBe(false);
  writer.add(key);
  const reader = fingerprintNegativeCache(source)!;
  expect(reader.has(reader.key(text, "policy one"))).toBe(true);
  expect(reader.has(reader.key(text + " changed", "policy one"))).toBe(false);
  expect(reader.has(reader.key(text, "policy two"))).toBe(false);
  expect(reader.key("head\ud800tail", "policy one")).not.toBe(reader.key("head\ufffdtail", "policy one"));
  writeFileSync(source, "second scanner revision");
  const revised = fingerprintNegativeCache(source)!;
  expect(revised.has(revised.key(text, "policy one"))).toBe(false);
  const changedAlgorithm = fingerprintNegativeCache(source, "different loaded matcher")!;
  expect(changedAlgorithm.key(text, "policy one")).not.toBe(revised.key(text, "policy one"));
  for (const name of readdirSync(join(root, "cache")).filter((name) => name !== "seal")) {
    expect(readFileSync(join(root, "cache", name), "utf8")).not.toContain(text);
  }
}));

cacheTest("unsigned, malformed and modified records never supply a negative verdict", () => fixture((root, source) => {
  const cache = fingerprintNegativeCache(source)!;
  const key = cache.key("synthetic text", "policy");
  cache.add(key);
  const row = join(root, "cache", readdirSync(join(root, "cache")).find((name) => name.startsWith("slot-"))!);
  const original = readFileSync(row, "utf8");
  for (const data of ["{", "{}", original.replace('"schema":1', '"schema":2'),
    JSON.stringify({ ...JSON.parse(original), created: Date.now() + 1000 }),
    JSON.stringify({ ...JSON.parse(original), mac: "0".repeat(64) }),
    JSON.stringify({ ...JSON.parse(original), extra: "unknown field" })]) {
    writeFileSync(row, data);
    expect(cache.has(key)).toBe(false);
    cache.add(key);
    expect(readFileSync(row, "utf8")).toBe(data);
  }
  writeFileSync(row, original);
  chmodSync(row, 0o644);
  expect(cache.has(key)).toBe(false);
}));

cacheTest("CI, unsafe paths and unprotected seals fall back to scanning", () => fixture((root, source) => {
  process.env.CI = "true";
  expect(fingerprintNegativeCache(source)).toBeUndefined();
  delete process.env.CI;
  const directory = join(root, "cache");
  symlinkSync(root, directory);
  expect(fingerprintNegativeCache(source)).toBeUndefined();
  rmSync(directory);
  expect(fingerprintNegativeCache(source)).toBeDefined();
  chmodSync(join(directory, "seal"), 0o644);
  expect(fingerprintNegativeCache(source)).toBeUndefined();
}));

cacheTest("fixed slots remain bounded and collisions require the full key", () => fixture((root, source) => {
  const cache = fingerprintNegativeCache(source)!;
  for (let index = 0; index < 1200; index += 1) cache.add(cache.key(`synthetic text ${index}`, "policy"));
  expect(readdirSync(join(root, "cache")).length).toBeLessThanOrEqual(1025);
  const key = cache.key("retained text", "policy");
  cache.add(key);
  expect(cache.has(key)).toBe(true);
  const collision = ((Number.parseInt(key.slice(0, 4), 16) + 1024) % 65_536).toString(16).padStart(4, "0") + key.slice(4);
  expect(cache.has(collision)).toBe(false);
  cache.add(collision);
  expect(cache.has(collision)).toBe(true);
  expect(cache.has(key)).toBe(false);
}));

cacheTest("expired and future records require another real scan", () => fixture((_root, source) => {
  const clock = spyOn(Date, "now").mockReturnValue(1000);
  try {
    const cache = fingerprintNegativeCache(source)!;
    const key = cache.key("synthetic text", "policy");
    cache.add(key);
    expect(cache.has(key)).toBe(true);
    clock.mockReturnValue(999);
    expect(cache.has(key)).toBe(false);
    clock.mockReturnValue(1000 + 7 * 24 * 60 * 60 * 1000 + 1);
    expect(cache.has(key)).toBe(false);
    cache.add(key);
    expect(cache.has(key)).toBe(true);
    process.env.CI = "true";
    expect(cache.has(key)).toBe(false);
  } finally { clock.mockRestore(); }
}));

cacheTest("an existing reader refuses a store whose permissions or seal changed", () => fixture((root, source) => {
  const cache = fingerprintNegativeCache(source)!;
  const key = cache.key("synthetic text", "policy");
  cache.add(key);
  const directory = join(root, "cache");
  chmodSync(directory, 0o755);
  expect(cache.has(key)).toBe(false);
  chmodSync(directory, 0o700);
  expect(cache.has(key)).toBe(true);
  chmodSync(join(directory, "seal"), 0o644);
  expect(cache.has(key)).toBe(false);
  chmodSync(join(directory, "seal"), 0o600);
  writeFileSync(join(directory, "seal"), Buffer.alloc(32));
  expect(cache.has(key)).toBe(false);
}));

cacheTest("a FIFO seal falls back promptly and remains untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "privacy-fingerprint-cache-fifo-seal-"));
  const source = join(root, "scanner.ts");
  const cache = join(root, "cache");
  const previousDirectory = process.env.LLV_PRIVACY_FINGERPRINT_CACHE_DIR;
  const previousCi = process.env.CI;
  writeFileSync(source, "synthetic scanner");
  delete process.env.CI;
  process.env.LLV_PRIVACY_FINGERPRINT_CACHE_DIR = cache;
  try {
    mkdirSync(cache, { mode: 0o700 });
    makeFifo(join(cache, "seal"));
    expect(await boundedReader(source, "seal")).toEqual({ exitCode: 2, timedOut: false });
    expect(lstatSync(join(cache, "seal")).isFIFO()).toBe(true);
  } finally {
    if (previousDirectory === undefined) delete process.env.LLV_PRIVACY_FINGERPRINT_CACHE_DIR;
    else process.env.LLV_PRIVACY_FINGERPRINT_CACHE_DIR = previousDirectory;
    if (previousCi === undefined) delete process.env.CI; else process.env.CI = previousCi;
    rmSync(root, { recursive: true, force: true });
  }
});

cacheTest("a FIFO slot misses promptly and remains untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "privacy-fingerprint-cache-fifo-slot-"));
  const source = join(root, "scanner.ts");
  const cache = join(root, "cache");
  const previousDirectory = process.env.LLV_PRIVACY_FINGERPRINT_CACHE_DIR;
  const previousCi = process.env.CI;
  writeFileSync(source, "synthetic scanner");
  delete process.env.CI;
  process.env.LLV_PRIVACY_FINGERPRINT_CACHE_DIR = cache;
  try {
    const writer = fingerprintNegativeCache(source)!;
    const slot = join(cache, `slot-${Number.parseInt("aaaa", 16) % 1024}`);
    makeFifo(slot);
    expect(await boundedReader(source, "slot")).toEqual({ exitCode: 0, timedOut: false });
    expect(lstatSync(slot).isFIFO()).toBe(true);
    expect(writer.has("a".repeat(64))).toBe(false);
  } finally {
    if (previousDirectory === undefined) delete process.env.LLV_PRIVACY_FINGERPRINT_CACHE_DIR;
    else process.env.LLV_PRIVACY_FINGERPRINT_CACHE_DIR = previousDirectory;
    if (previousCi === undefined) delete process.env.CI; else process.env.CI = previousCi;
    rmSync(root, { recursive: true, force: true });
  }
});

cacheTest("a FIFO seal preserves the real CLI verdict and full report", async () => {
  const root = mkdtempSync(join(tmpdir(), "privacy-fingerprint-cli-fifo-"));
  const cache = join(root, "cache");
  const repository = join(root, "repository");
  const previousDirectory = process.env.LLV_PRIVACY_FINGERPRINT_CACHE_DIR;
  const previousCi = process.env.CI;
  mkdirSync(repository, { mode: 0o700 });
  writeFileSync(join(repository, "note.txt"), "Synthetic safe publication note.\n");
  try {
    mkdirSync(cache, { mode: 0o700 });
    makeFifo(join(cache, "seal"));
    const uncached = await runGateCli(repository, undefined, true);
    const invalidCache = await runGateCli(repository, cache, false);
    expect(uncached.timedOut).toBe(false);
    expect(invalidCache.timedOut).toBe(false);
    expect(invalidCache.exitCode).toBe(uncached.exitCode);
    expect(invalidCache.report.equals(uncached.report)).toBe(true);
    expect(invalidCache.report.toString("utf8")).toBe("PRIVACY GATE: PASS\n");
    expect(lstatSync(join(cache, "seal")).isFIFO()).toBe(true);
  } finally {
    if (previousDirectory === undefined) delete process.env.LLV_PRIVACY_FINGERPRINT_CACHE_DIR;
    else process.env.LLV_PRIVACY_FINGERPRINT_CACHE_DIR = previousDirectory;
    if (previousCi === undefined) delete process.env.CI; else process.env.CI = previousCi;
    rmSync(root, { recursive: true, force: true });
  }
});
