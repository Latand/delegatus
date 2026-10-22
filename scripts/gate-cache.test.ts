import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GateCache, installedFingerprint, workingInputsFingerprint } from "./gate-cache";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const fixture = () => { const root = mkdtempSync(path.join(tmpdir(), "gate-cache-")); roots.push(root); return root; };
const valid = (value: unknown): value is { passed: true } => !!value && typeof value === "object" && "passed" in value && value.passed === true;

test("receipts survive a process restart; corruption, expiry and oversized records are misses", () => {
  const root = fixture(), cacheModule = path.join(import.meta.dir, "gate-cache.ts");
  const run = (source: string) => {
    const result = Bun.spawnSync([process.execPath, "-e", `import { GateCache } from ${JSON.stringify(cacheModule)}; const cache = new GateCache(${JSON.stringify(root)}, value => value?.passed === true); ${source}`]);
    expect(result.exitCode, result.stderr.toString()).toBe(0); return result.stdout.toString().trim();
  };
  run('cache.write("same-input", { passed: true });');
  expect(run('console.log(cache.read("same-input")?.passed);')).toBe("true");
  expect(run('console.log(cache.read("different-input"));')).toBe("undefined");
  const file = path.join(root, readdirSync(root)[0]!);
  const original = readFileSync(file);
  writeFileSync(file, "partial write"); expect(run('console.log(cache.read("same-input"));')).toBe("undefined");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(original.toString()), value: { passed: true, changed: true } }));
  expect(run('console.log(cache.read("same-input"));')).toBe("undefined");
  writeFileSync(file, original); utimesSync(file, new Date(0), new Date(0));
  expect(run('console.log(cache.read("same-input"));')).toBe("undefined");
  writeFileSync(file, "x".repeat(1024 * 1024 + 1));
  expect(run('console.log(cache.read("same-input"));')).toBe("undefined");
});

test("receipt generations are bounded; unavailable storage only loses acceleration", () => {
  const root = fixture(), cache = new GateCache(root, valid);
  for (let index = 0; index < 260; index++) cache.write(String(index), { passed: true });
  expect(readdirSync(root)).toHaveLength(256);
  writeFileSync(path.join(root, "blocked"), "regular file");
  const blocked = new GateCache(path.join(root, "blocked", "child"), valid);
  expect(() => blocked.write("key", { passed: true })).not.toThrow();
  expect(blocked.read("key")).toBeUndefined();
  const largeRoot = fixture(), large = new GateCache(largeRoot, valid);
  const value = { passed: true as const, payload: "x".repeat(900_000) };
  for (let index = 0; index < 40; index++) large.write(String(index), value);
  expect(readdirSync(largeRoot).reduce((bytes, file) => bytes + statSync(path.join(largeRoot, file)).size, 0)).toBeLessThanOrEqual(32 * 1024 * 1024);
});

test("an installed tool edit invalidates the fingerprint without a version or lockfile change", () => {
  const root = fixture(), directory = path.join(root, "node_modules", "compiler"); mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "package.json"), '{"version":"1.0.0"}');
  const script = path.join(directory, "compiler.js"); writeFileSync(script, "export const result = true;");
  const before = installedFingerprint(root);
  writeFileSync(script, "export const result = false;");
  expect(installedFingerprint(root)).not.toBe(before);
});

test("a symlink retarget invalidates working inputs even when its target files have identical bytes", () => {
  const root = fixture();
  for (const [name, value] of [["first", true], ["second", false]] as const) {
    const directory = path.join(root, name); mkdirSync(directory);
    writeFileSync(path.join(directory, "entry.ts"), 'export { default } from "./value";');
    writeFileSync(path.join(directory, "value.ts"), `export default ${value};`);
  }
  const link = path.join(root, "selected.ts");
  symlinkSync(path.join(root, "first/entry.ts"), link);
  const before = workingInputsFingerprint(root);
  rmSync(link); symlinkSync(path.join(root, "second/entry.ts"), link);
  expect(workingInputsFingerprint(root)).not.toBe(before);
});

test("orphaned atomic writes share the receipt storage bound after a restart", () => {
  const root = fixture();
  const interrupted = Bun.spawnSync([process.execPath, "-e", `import { writeFileSync } from "node:fs"; import path from "node:path";
    for (let index = 0; index < 260; index++) {
      const id = [index.toString(16).padStart(8, "0"), "0000", "4000", "8000", "000000000000"].join("-");
      writeFileSync(path.join(${JSON.stringify(root)}, ".write-" + id), "interrupted write");
    }`]);
  expect(interrupted.exitCode).toBe(0);
  const restarted = Bun.spawnSync([process.execPath, "-e", `import { GateCache } from ${JSON.stringify(path.join(import.meta.dir, "gate-cache.ts"))};
    new GateCache(${JSON.stringify(root)}, value => value?.passed === true).write("complete", { passed: true });`]);
  expect(restarted.exitCode, restarted.stderr.toString()).toBe(0);
  expect(readdirSync(root)).toHaveLength(256);
});
