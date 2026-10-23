// Stub-runner runs: privacy refusals and review exports (T15, T19).
// The remote command really runs, under a temporary runner home, through the
// real serve.ts (harness.fixture.ts); every file stays well under the 300 s
// file budget on a loaded runner, so each holds at most three cases.
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { reviewExport } from "../review-export";
import { makeHarness, privateValue, testFile, withoutRunnerLines, type Harness } from "./harness.fixture";

const linux = process.platform === "linux";
/** Several stub runs, each a full checkout, install and owned test run; slow under load. */
const E2E_TIMEOUT = 240_000;
const harnesses: Harness[] = [];
afterEach(() => { for (const h of harnesses.splice(0)) h.cleanup(); });
function harness(options?: Parameters<typeof makeHarness>[0]): Harness { const h = makeHarness(options); harnesses.push(h); return h; }
// Timings and the local CPU queue's waiting lines differ between any two runs.
const normalized = (text: string) => withoutRunnerLines(text).replace(/\[[\d.]+m?s\]/g, "[t]").replace(/^bun test v.*$/m, "").replace(/^gate-slot: Waiting for the CPU queue.*\n/gm, "");
const RUNNING = /^gate-runner: running on the gate runner \(run [0-9a-f]{12}, tree [0-9a-f]{12}\)$/m;

function treeHashes(root: string, skip: (relative: string) => boolean = () => false): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name), relative = path.relative(root, full);
      if (skip(relative)) continue;
      if (entry.isDirectory()) walk(full);
      else out[relative] = entry.isSymbolicLink() ? `link:${fs.readlinkSync(full)}` : createHash("sha1").update(fs.readFileSync(full)).digest("hex");
    }
  };
  walk(root);
  return out;
}

// T15
test.if(linux)("a tree holding a known private value is never uploaded and runs here", () => {
  const h = harness();
  const known = path.join(h.root, "known-values.txt");
  const value = privateValue();
  fs.writeFileSync(known, `${value}\n`);
  fs.writeFileSync(path.join(h.fixture, "leak.txt"), `text with ${value} inside\n`);
  const file = testFile(h, "pass.test.ts", `test("one", () => expect(1).toBe(1));`);
  const result = h.run(["bun", "test", file], { env: h.env({ LLV_PRIVACY_KNOWN_VALUES_FILE: known }) });
  expect(result.code).toBe(0);
  expect(result.stderr).toMatch(/^gate-runner: running here: the privacy scan refused the tree: /m);
  expect(h.calls().filter(call => !call.command.includes("manager=ok"))).toEqual([]);
}, E2E_TIMEOUT);

// T19
test.if(linux)("a review export runs remotely through its record; a copy without one stays here", () => {
  const h = harness();
  const scratchDir = path.join(h.root, "exports");
  fs.mkdirSync(scratchDir);
  const exported = reviewExport(h.fixture, h.head, scratchDir);
  const at = (file: string) => path.join(exported.directory, file);
  const before = treeHashes(path.dirname(exported.directory));
  fs.appendFileSync(at("README.md"), "\nedited in the export\n");
  fs.rmSync(at("LICENSE"));
  fs.mkdirSync(at("gate-runner-fixture"));
  fs.writeFileSync(at("gate-runner-fixture/export.test.ts"), `import { test, expect } from "bun:test";
import fs from "node:fs";
test("export tree", () => {
  expect(fs.readFileSync("README.md", "utf8")).toEndWith("edited in the export\\n");
  expect(fs.existsSync("LICENSE")).toBe(false);
  expect(fs.existsSync(".git")).toBe(false);
  expect(fs.existsSync(".artifacts/form-draft-brief.md")).toBe(true);
});`);
  const edited = treeHashes(path.dirname(exported.directory));
  const result = h.run(["bun", "test", "./gate-runner-fixture/export.test.ts"], { cwd: exported.directory });
  expect(result.stderr).toMatch(RUNNING);
  expect(result.code).toBe(0);
  const local = h.run(["bun", "test", "./gate-runner-fixture/export.test.ts"], { cwd: exported.directory, env: h.env({ LLV_GATE_RUNNER: "off" }) });
  expect(local.code).toBe(0);
  expect(normalized(result.stderr)).toBe(normalized(local.stderr));
  expect(treeHashes(path.dirname(exported.directory))).toEqual(edited);
  expect(Object.keys(before)).toContain("export.json");
  // A copy of the same files without the record never contacts the runner.
  const copy = path.join(h.root, "copy");
  fs.cpSync(exported.directory, copy, { recursive: true, verbatimSymlinks: true });
  const calls = h.calls().length;
  expect(h.run(["bun", "test", "./gate-runner-fixture/export.test.ts"], { cwd: copy }).code).toBe(0);
  expect(h.calls()).toHaveLength(calls);
  expect(fs.readFileSync(path.join(h.cache, "runner-decisions.log"), "utf8")).toContain("\tineligible\ta copy without git metadata or an export record\t");
}, E2E_TIMEOUT);
