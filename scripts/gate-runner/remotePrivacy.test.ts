// ship() and privacy(): the scan reads what was captured, never the live
// checkout or export (T27). No runner is contacted.
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { reviewExport } from "../review-export";
import { privacy, ship, type Tree } from "./client";
import { makeHarness, privateValue, type Harness } from "./harness.fixture";

const linux = process.platform === "linux";
/** Each scan runs the tree's own privacy gate several times; slow under load. */
const TIMEOUT = 240_000;
const harnesses: Harness[] = [];
afterEach(() => { for (const h of harnesses.splice(0)) h.cleanup(); });
function harness(): Harness { const h = makeHarness(); harnesses.push(h); return h; }

// T27
test.if(linux)("an edit after capture neither hides a private value from the scan nor seeds a cached pass, in a checkout and in an export", () => {
  const h = harness();
  const known = path.join(h.root, "known-values.txt");
  const value = privateValue();
  fs.writeFileSync(known, `${value}\n`);
  const env = h.env({ LLV_PRIVACY_KNOWN_VALUES_FILE: known });
  let scratches = 0;
  const scratch = () => { const dir = path.join(h.root, `ship-${scratches++}`); fs.mkdirSync(dir); return dir; };

  const checkout: Tree = { kind: "git", root: h.fixture };
  const leak = path.join(h.fixture, "leak.txt");
  fs.writeFileSync(leak, `text with ${value} inside\n`);
  const captured = ship(checkout, scratch(), h.base);
  fs.rmSync(leak);
  expect(privacy(checkout, captured, env)).toMatchObject({ ok: false });
  // The same private tree captured again is scanned again and refused.
  fs.writeFileSync(leak, `text with ${value} inside\n`);
  const again = ship(checkout, scratch(), h.base);
  expect(again.tree).toBe(captured.tree);
  expect(privacy(checkout, again, env)).toMatchObject({ ok: false });
  fs.rmSync(leak);
  expect(privacy(checkout, ship(checkout, scratch(), h.base), env)).toEqual({ ok: true });

  fs.mkdirSync(path.join(h.root, "exports-dir"));
  const exported = reviewExport(h.fixture, h.head, path.join(h.root, "exports-dir"));
  const exportTree: Tree = { kind: "export", root: exported.directory, record: JSON.parse(fs.readFileSync(path.join(path.dirname(exported.directory), "export.json"), "utf8")) };
  const readme = path.join(exported.directory, "README.md");
  const original = fs.readFileSync(readme, "utf8");
  fs.appendFileSync(readme, `\nnote ${value}\n`);
  const exportCapture = ship(exportTree, scratch(), h.base);
  fs.writeFileSync(readme, original);
  expect(privacy(exportTree, exportCapture, env)).toMatchObject({ ok: false });
  fs.appendFileSync(readme, `\nnote ${value}\n`);
  const exportAgain = ship(exportTree, scratch(), h.base);
  expect(exportAgain.tree).toBe(exportCapture.tree);
  expect(privacy(exportTree, exportAgain, env)).toMatchObject({ ok: false });
}, TIMEOUT);

// T30
test.if(linux)("a scan that runs out of time is no refusal and leaves no cached answer, and the same capture is scanned again", () => {
  const h = harness();
  // The captured tree's own gate is the one that runs, so a gate that holds
  // makes a slow scan. It records its pid and holds while the hold file
  // exists, both in the first ancestor of its directory that has the record,
  // so the tree carries no absolute path.
  const gate = path.join(h.fixture, "scripts", "privacy-publication-gate.ts");
  const original = fs.readFileSync(gate, "utf8");
  const pids = path.join(h.root, "slow-gate.pids"), hold = path.join(h.root, "slow-gate.hold");
  fs.writeFileSync(pids, "");
  fs.writeFileSync(hold, "");
  fs.writeFileSync(gate, `import { appendFileSync as recordPid, existsSync as hasRecord } from "node:fs";
import { dirname as parentOf, join as joinPath } from "node:path";
for (let dir = process.cwd(); dir !== parentOf(dir); dir = parentOf(dir)) if (hasRecord(joinPath(dir, "slow-gate.pids"))) {
  recordPid(joinPath(dir, "slow-gate.pids"), \`\${process.pid}\\n\`);
  // A guard only: the test releases the hold before the second scan.
  const until = Date.now() + 120_000;
  while (hasRecord(joinPath(dir, "slow-gate.hold")) && Date.now() < until) await Bun.sleep(20);
  break;
}
${original}`);
  const checkout: Tree = { kind: "git", root: h.fixture };
  let scratches = 0;
  const scratch = () => { const dir = path.join(h.root, `ship-${scratches++}`); fs.mkdirSync(dir); return dir; };
  const captured = ship(checkout, scratch(), h.base);
  expect(privacy(checkout, captured, h.env({ LLV_GATE_RUNNER_SCAN_TIMEOUT_MS: "10000" }))).toEqual({ ok: false, line: "it did not finish within 10 s", unfinished: true });
  // The gate was stopped at its bound, never waited out: it started, it is
  // still held, and its process is gone.
  const started = fs.readFileSync(pids, "utf8").split("\n").filter(Boolean).map(Number);
  expect(started).toHaveLength(1);
  expect(fs.existsSync(hold)).toBeTrue();
  expect(() => process.kill(started[0]!, 0)).toThrow();
  const cache = path.join(h.cache, "privacy-cache.json");
  const cached = () => fs.existsSync(cache) ? Object.keys(JSON.parse(fs.readFileSync(cache, "utf8"))) : [];
  expect(cached()).toEqual([]);
  // Released, the same capture is scanned again in full.
  fs.rmSync(hold);
  expect(privacy(checkout, captured, h.env())).toEqual({ ok: true });
  expect(cached()).toHaveLength(1);
}, TIMEOUT);
