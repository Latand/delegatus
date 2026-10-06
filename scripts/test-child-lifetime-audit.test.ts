import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const audit = read("docs/verification/test-child-lifetime.md").split("## Process-launch audit\n")[1];

test("the child audit includes dynamically imported synchronous Git launches", () => {
  const source = read("src/lib/boardMaintenance/run.test.ts");
  expect(source).toContain('const { execFileSync } = await import("node:child_process")');
  expect(source).toContain('=> execFileSync("git", args,');
  const row = audit.split("\n").find(line => line.startsWith("| `src/lib/boardMaintenance/run.test.ts` |"));
  expect(row).toContain("synchronous");
  expect(row).toContain("runner contains");
});

test("the child audit includes higher-order curl launches and their existing bounds", () => {
  const source = read("src/runtime-host/deploymentProxy.test.ts");
  expect(source.match(/promisify\(execFile\)\("curl"/g)).toHaveLength(3);
  expect(source.match(/"--max-time", "[35]"/g)).toHaveLength(3);
  const row = audit.split("\n").find(line => line.startsWith("| `src/runtime-host/deploymentProxy.test.ts` |"));
  expect(row).toContain("owned");
  expect(row).toContain("3/5-second");
  expect(row).toContain("awaited");
});

test("the child census counts unique files with complete disposition columns", () => {
  const tables = audit.split("Additional launch wiring")[0];
  const [asyncTable, syncTable] = tables.split("| File | Async launch sites | Disposition |")[1]
    .split("| File | Synchronous launch sites | Disposition |");
  const rows = (table: string) => table.split("\n").filter(line => line.startsWith("| `"));
  const asynchronous = rows(asyncTable);
  const synchronous = rows(syncTable);
  const all = [...asynchronous, ...synchronous];
  for (const row of all) expect(row).toMatch(/^\| `[^`]+` \| [^|]+ \| [^|]+ \|$/);
  expect(new Set(all.map(row => row.split("`")[1])).size).toBe(all.length);
  const counts = /census contains (\d+) files: (\d+) with asynchronous primitives and\n(\d+) with only synchronous primitives/.exec(tables);
  expect(counts?.slice(1).map(Number)).toEqual([all.length, asynchronous.length, synchronous.length]);
  expect(asyncTable).toContain("`scripts/verify-viewer-runtime.ts`");
  expect(syncTable).toContain("`scripts/verify-bun-runtime-controls.ts`");
});
