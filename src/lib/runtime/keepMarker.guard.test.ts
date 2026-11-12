import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { insideTestTempRoot, KEEP_MARKER, plantedKeepMarkers, plantKeepMarker, removeKeepMarkers } from "./keepMarker.testSupport";

/*
 * Retention holds a `.delegatus-keep` marker for ever, so a marker a test leaves
 * outside its own temp root pins that tree until a person deletes it. These
 * tests hold the writers to the helper in `keepMarker.testSupport.ts`: it
 * writes only inside the test temp root and its owner removes the marker after
 * the test, passed or failed. Production code and the meaning of a real marker
 * are not touched here.
 */

const roots: string[] = [];
const outside: string[] = [];
afterEach(() => {
  removeKeepMarkers();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  for (const root of outside.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const own = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-keep-marker-guard-")); roots.push(root); return root; };

function markerFiles(directory: string, found: string[] = []): string[] {
  if (!fs.existsSync(directory)) return found;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.name === KEEP_MARKER) { found.push(file); continue; }
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) markerFiles(file, found);
  }
  return found;
}

function assertNoMarkersOutsideTemp(sandbox: string, tempRoot: string): void {
  const temp = fs.realpathSync(tempRoot);
  const escaped = markerFiles(sandbox).filter(file => {
    const relative = path.relative(temp, path.resolve(file));
    return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  });
  expect(escaped).toEqual([]);
}

function runChild(file: string, env: NodeJS.ProcessEnv, cwd: string, testName?: string) {
  return Bun.spawnSync([process.execPath, "test", "--timeout=60000", ...(testName ? ["--test-name-pattern", testName] : []), file], {
    cwd, env, stdout: "pipe", stderr: "pipe", timeout: 9 * 60_000,
  });
}

function isolatedChild(sandbox: string, extraEnv: Record<string, string | undefined> = {}) {
  const tempRoot = path.join(sandbox, "tmp"), cwd = path.join(sandbox, "work");
  fs.mkdirSync(tempRoot, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const env = { ...process.env, HOME: path.join(sandbox, "home"), XDG_CONFIG_HOME: path.join(sandbox, "config"), TMPDIR: tempRoot,
    LLV_STATE_DIR: path.join(sandbox, "state"), LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1", LLV_GATE_RUNNER: "off", ...extraEnv };
  return { tempRoot, cwd, env };
}

test("a marker is written inside the test temp root with the human-pin text by default", () => {
  const file = plantKeepMarker(path.join(own(), KEEP_MARKER));
  expect(fs.readFileSync(file, "utf8")).toBe("operator pin");
  expect(plantedKeepMarkers()).toEqual([file]);
});

test("a marker outside the test temp root is refused and nothing is written", () => {
  const stranger = fs.mkdtempSync(path.join(path.dirname(fs.realpathSync(os.tmpdir())), "llv-keep-marker-stranger-"));
  outside.push(stranger);
  const escapes = [
    path.join(stranger, KEEP_MARKER),
    path.join(own(), "..", "..", path.basename(stranger), KEEP_MARKER),
    path.join(path.parse(os.tmpdir()).root, KEEP_MARKER),
  ];
  for (const file of escapes) {
    expect(() => plantKeepMarker(file)).toThrow("inside the test temp root");
    expect(fs.existsSync(file)).toBeFalse();
  }
  expect(plantedKeepMarkers()).toEqual([]);
});

test("a symlinked directory cannot carry a marker out of the temp root", () => {
  const stranger = fs.mkdtempSync(path.join(path.dirname(fs.realpathSync(os.tmpdir())), "llv-keep-marker-linked-"));
  outside.push(stranger);
  const link = path.join(own(), "link"); fs.symlinkSync(stranger, link);
  expect(() => plantKeepMarker(path.join(link, KEEP_MARKER))).toThrow("inside the test temp root");
  expect(fs.readdirSync(stranger)).toEqual([]);
});

test("the temp root itself and other file names are refused", () => {
  expect(insideTestTempRoot(os.tmpdir())).toBeFalse();
  expect(() => plantKeepMarker(path.join(own(), "notes.txt"))).toThrow("not a keep marker path");
});

test("the file's afterEach removes a marker whether the test passed or failed", () => {
  const passed = path.join(own(), KEEP_MARKER), failed = path.join(own(), "nested-failure", KEEP_MARKER);
  fs.mkdirSync(path.dirname(failed));
  plantKeepMarker(passed);
  try { plantKeepMarker(failed); throw new Error("fixture assertion failed"); } catch { /* the runner still calls afterEach */ }
  expect(fs.existsSync(passed) && fs.existsSync(failed)).toBeTrue();
  removeKeepMarkers(); // what afterEach runs
  expect(fs.existsSync(passed)).toBeFalse();
  expect(fs.existsSync(failed)).toBeFalse();
  expect(plantedKeepMarkers()).toEqual([]);
});

test("removal tolerates a marker whose tree was moved or already removed", () => {
  const root = own(), tree = path.join(root, "tree"); fs.mkdirSync(tree);
  plantKeepMarker(path.join(tree, KEEP_MARKER));
  fs.renameSync(tree, path.join(root, "trash"));
  expect(() => removeKeepMarkers()).not.toThrow();
  expect(plantedKeepMarkers()).toEqual([]);
});

test("real marker writers leave no markers after their isolated child runs", () => {
  const files = [
    "src/lib/runtime/attemptTempRetention.test.ts",
    "src/lib/runtime/attemptTempProduction.test.ts",
    "src/lib/runtime/attemptTempFilesystem.test.ts",
    "src/lib/tempSweep.test.ts",
  ];
  for (const file of files) {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-keep-marker-child-"));
    const { tempRoot, cwd, env } = isolatedChild(sandbox);
    try {
      const result = runChild(path.resolve(file), env, cwd);
      expect(result.exitCode, `${file}\n${result.stderr.toString()}\n${result.stdout.toString()}`).toBe(0);
      assertNoMarkersOutsideTemp(sandbox, tempRoot);
    } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
  }
}, { timeout: 10 * 60_000 });

test("the isolated child cleanup runs after an actual assertion failure", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-keep-marker-failure-"));
  const { tempRoot, cwd, env } = isolatedChild(sandbox, { LLV_KEEP_MARKER_FAILURE_CONTROL: "1" });
  try {
    const result = runChild(import.meta.path, env, cwd, "intentional keep-marker assertion failure control");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("intentional keep-marker assertion failure control");
    assertNoMarkersOutsideTemp(sandbox, tempRoot);
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
});

test("a marker outside the child temp root makes the leak assertion fail", () => {
  const sandbox = own(), tempRoot = path.join(sandbox, "tmp"); fs.mkdirSync(tempRoot);
  const leaked = path.join(sandbox, KEEP_MARKER); fs.writeFileSync(leaked, "control leak");
  expect(() => assertNoMarkersOutsideTemp(sandbox, tempRoot)).toThrow();
});

test("a multiline cwd marker leak control makes the success leak assertion fail", () => {
  const sandbox = own(), { tempRoot, cwd, env } = isolatedChild(sandbox, { LLV_KEEP_MARKER_SUCCESS_LEAK_CONTROL: "1" });
  const result = runChild(import.meta.path, env, cwd, "intentional cwd keep-marker success leak control");
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(() => assertNoMarkersOutsideTemp(sandbox, tempRoot)).toThrow();
});

test("a multiline cwd marker leak control makes the failure leak assertion fail", () => {
  const sandbox = own(), { tempRoot, cwd, env } = isolatedChild(sandbox, { LLV_KEEP_MARKER_FAILURE_LEAK_CONTROL: "1" });
  const result = runChild(import.meta.path, env, cwd, "intentional cwd keep-marker failure leak control");
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("intentional cwd keep-marker failure leak control");
  expect(() => assertNoMarkersOutsideTemp(sandbox, tempRoot)).toThrow();
});

if (process.env.LLV_KEEP_MARKER_FAILURE_CONTROL === "1") {
  test("intentional keep-marker assertion failure control", () => {
    fs.mkdirSync(path.join(os.tmpdir(), "failure-control"), { recursive: true });
    plantKeepMarker(path.join(os.tmpdir(), "failure-control", KEEP_MARKER));
    expect("intentional keep-marker assertion failure control").toBe("unexpected success");
  });
}

if (process.env.LLV_KEEP_MARKER_SUCCESS_LEAK_CONTROL === "1") {
  test("intentional cwd keep-marker success leak control", () => {
    const outside = path.join(process.cwd(), "review-success-outside");
    fs.mkdirSync(outside, { recursive: true });
    const marker = path.join(outside, KEEP_MARKER);
    fs.writeFileSync(marker, "operator pin");
  });
}

if (process.env.LLV_KEEP_MARKER_FAILURE_LEAK_CONTROL === "1") {
  test("intentional cwd keep-marker failure leak control", () => {
    const outside = path.join(process.cwd(), "review-failure-outside");
    fs.mkdirSync(outside, { recursive: true });
    const marker = path.join(outside, KEEP_MARKER);
    fs.writeFileSync(marker, "operator pin");
    expect("intentional cwd keep-marker failure leak control").toBe("unexpected success");
  });
}

/** Every test file under src and scripts. */
function testFiles(directory: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name.startsWith(".git")) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) testFiles(file, found);
    else if (/\.(?:test|fixture)\.tsx?$/.test(entry.name) || /\.testSupport\.ts$/.test(entry.name)) found.push(file);
  }
  return found;
}

test("no test or fixture writes a keep marker except through the helper, and its users clean up in afterEach", () => {
  const repo = path.resolve(import.meta.dir, "../../..");
  const helper = path.join(import.meta.dir, "keepMarker.testSupport.ts"), self = import.meta.path;
  const direct = /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|symlinkSync|openSync|copyFileSync|linkSync|touch)\b[^\n]*delegatus-keep|delegatus-keep[^\n]*(?:writeFile|appendFile|symlinkSync|openSync)/;
  const offenders: string[] = [], uncleaned: string[] = [];
  for (const root of ["src", "scripts"]) {
    const base = path.join(repo, root);
    if (!fs.existsSync(base)) continue;
    for (const file of testFiles(base)) {
      if (file === helper || file === self) continue;
      const text = fs.readFileSync(file, "utf8");
      if (direct.test(text)) offenders.push(path.relative(repo, file));
      if (text.includes("plantKeepMarker(") && !(text.includes("afterEach(") && text.includes("removeKeepMarkers()"))) uncleaned.push(path.relative(repo, file));
    }
  }
  expect(offenders).toEqual([]);
  expect(uncleaned).toEqual([]);
});
