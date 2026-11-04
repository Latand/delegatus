import { expect, fixture, path, readFileSync, test, touchedTests, writeFileSync } from "./local-gate-tests.fixture";

test.each([1, 2])("worker limit %s bounds both head and baseline files", async limit => {
  const f = fixture('import { test } from "bun:test"; test("seed", () => {});');
  const marker = path.join(f.dir, "workers.jsonl");
  const files = Array.from({ length: 4 }, (_, index) => `worker-${index}.test.ts`);
  for (const file of files) writeFileSync(path.join(f.dir, file), `
import { test, expect } from "bun:test";
import { appendFileSync } from "node:fs";
import { basename } from "node:path";
test("steady failure", async () => {
  const side = basename(process.cwd()) === "baseline" ? "base" : "head";
  const event = (delta: number) => appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ side, delta }) + "\\n");
  event(1);
  await Bun.sleep(150);
  event(-1);
  expect(false).toBe(true);
});
`);
  f.git("add", ...files); f.git("commit", "-m", "Concurrency fixture");
  const result = await touchedTests(f.dir, f.git("rev-parse", "HEAD"), files,
    { env: { ...f.env, LLV_GATE_TEST_WORKERS: String(limit) }, log: line => f.logs.push(line) });
  expect(result.introduced).toHaveLength(0);
  expect(result.preexisting).toHaveLength(4);
  const active = { head: 0, base: 0 }, peak = { head: 0, base: 0 }, starts = { head: 0, base: 0 };
  for (const line of readFileSync(marker, "utf8").trim().split("\n")) {
    const { side, delta } = JSON.parse(line) as { side: "head" | "base"; delta: number };
    active[side] += delta;
    if (delta === 1) starts[side]++;
    peak[side] = Math.max(peak[side], active[side]);
  }
  expect(starts).toEqual({ head: 4, base: 4 });
  expect(active).toEqual({ head: 0, base: 0 });
  expect(peak.head).toBeGreaterThan(0);
  expect(peak.head).toBeLessThanOrEqual(limit);
  expect(peak.base).toBeGreaterThan(0);
  expect(peak.base).toBeLessThanOrEqual(limit);
}, 60_000);

test.each(["", "0", "-1", "9", "1.5", "no", "Infinity"])("invalid worker limit %j refuses before executing a file", async value => {
  const f = fixture('import { test } from "bun:test"; test("seed", () => {});');
  await expect(touchedTests(f.dir, f.base, ["./example.test.ts"],
    { env: { ...f.env, LLV_GATE_TEST_WORKERS: value }, log: () => {} }))
    .rejects.toThrow("LLV_GATE_TEST_WORKERS must be an integer from 1 to 8");
});
