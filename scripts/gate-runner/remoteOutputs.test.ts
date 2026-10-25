// Stub-runner runs: driver outputs and hostile returns (T14).
// The remote command really runs, under a temporary runner home, through the
// real serve.ts (harness.fixture.ts); every file stays well under the 300 s
// file budget on a loaded runner, so each holds at most three cases.
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { git, makeHarness, testFile, type Harness } from "./harness.fixture";
import { ustarEntry } from "./serve";

const linux = process.platform === "linux";
/** Several stub runs, each a full checkout, install and owned test run; slow under load. */
const E2E_TIMEOUT = 240_000;
const harnesses: Harness[] = [];
afterEach(() => { for (const h of harnesses.splice(0)) h.cleanup(); });
function harness(): Harness { const h = makeHarness(); harnesses.push(h); return h; }
const RUNNING = /^gate-runner: running on the gate runner \(run ([0-9a-f]{12}), tree [0-9a-f]{12}\)$/m;

// T14
test.if(linux)("a driver's declared outputs come back; nothing else does, and a hostile return writes nothing", () => {
  const h = harness();
  const outDir = path.join(h.root, "pd-out");
  fs.mkdirSync(outDir);
  fs.writeFileSync(path.join(h.root, "pd-sibling.txt"), "untouched");
  const driver = testFile(h, "outputs.browser.test.tsx", `
import fs from "node:fs";
test("writes outputs", () => {
  fs.mkdirSync("evidence/gate-runner-x", { recursive: true });
  fs.writeFileSync("evidence/gate-runner-x/a.json", "{\\"a\\":1}");
  fs.mkdirSync(".artifacts/gate-runner-y", { recursive: true });
  fs.writeFileSync(".artifacts/gate-runner-y/b.png", "png");
  fs.writeFileSync(".artifacts/gate-runner-y/large.bin", Buffer.alloc(2 * 1024 * 1024, 7));
  fs.writeFileSync(process.env.PD_OUT + "/f.txt", "outside");
  fs.appendFileSync(".githooks/pre-push", "\\necho planted\\n");
  fs.appendFileSync("package.json", " ");
});`);
  const hashes = () => {
    const out: Record<string, string> = {};
    for (const file of git(h.fixture, "ls-files", "-z", "--cached", "--others").split("\0").filter(Boolean)) {
      const full = path.join(h.fixture, file);
      if (fs.lstatSync(full, { throwIfNoEntry: false })?.isFile()) out[file] = createHash("sha1").update(fs.readFileSync(full)).digest("hex");
    }
    for (const name of fs.readdirSync(h.root)) if (name.startsWith("pd-")) out[`root/${name}`] = fs.lstatSync(path.join(h.root, name)).isFile() ? fs.readFileSync(path.join(h.root, name), "utf8") : "dir";
    return out;
  };
  const before = hashes();
  const result = h.run(["bun", "test", driver], { env: h.env({ PD_OUT: outDir }) });
  expect(result.stderr).toMatch(RUNNING);
  expect(result.code).toBe(0);
  const after = hashes();
  expect(fs.readFileSync(path.join(h.fixture, "evidence/gate-runner-x/a.json"), "utf8")).toBe(`{"a":1}`);
  expect(fs.readFileSync(path.join(h.fixture, ".artifacts/gate-runner-y/b.png"), "utf8")).toBe("png");
  expect(fs.readFileSync(path.join(outDir, "f.txt"), "utf8")).toBe("outside");
  const changed = Object.keys({ ...before, ...after }).filter(key => before[key] !== after[key]).sort();
  // Larger than a pipe buffer: the archive must arrive whole.
  expect(fs.readFileSync(path.join(h.fixture, ".artifacts/gate-runner-y/large.bin")).equals(Buffer.alloc(2 * 1024 * 1024, 7))).toBeTrue();
  expect(changed).toEqual([".artifacts/gate-runner-y/b.png", ".artifacts/gate-runner-y/large.bin", "evidence/gate-runner-x/a.json"]);
  expect(fs.readdirSync(path.join(h.root, "pd-out"))).toEqual(["f.txt"]);

  for (const [name, archive] of [
    ["traversal", Buffer.concat([ustarEntry("tree/../escaped", Buffer.from("x")), Buffer.alloc(1024)])],
    ["hook", Buffer.concat([ustarEntry("tree/evidence/ok.json", Buffer.from("ok")), ustarEntry("tree/.githooks/pre-push", Buffer.from("planted")), Buffer.alloc(1024)])],
    ["large", Buffer.concat([ustarEntry("tree/evidence/big.bin", Buffer.alloc(64 * 1024)), Buffer.alloc(1024)])],
  ] as const) {
    const pack = path.join(h.root, `pack-${name}.tar`);
    fs.writeFileSync(pack, archive);
    h.settings({ packFile: pack });
    fs.rmSync(path.join(h.cache, "runner-health.json"), { force: true });
    const snapshot = hashes();
    const hostile = h.run(["bun", "test", driver], { env: h.env({ PD_OUT: outDir, LLV_GATE_RUNNER_RETURN_LIMIT: String(32 * 1024) }) });
    expect(hostile.code).toBe(75);
    expect(hostile.stderr).toMatch(/^gate-runner: no verdict: outputs were not returned \(.+\)$/m);
    expect(hashes()).toEqual(snapshot);
    expect(fs.existsSync(path.join(h.root, "escaped"))).toBeFalse();
    expect(fs.existsSync(path.join(h.fixture, "evidence", "ok.json"))).toBeFalse();
  }
}, E2E_TIMEOUT);
