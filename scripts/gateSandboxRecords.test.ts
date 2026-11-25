import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hasActiveGateSandbox } from "./gateSandboxRecords";
import { createHookFixture } from "./local-gate.fixture";
import { isolatedEnvironment } from "./local-gate";
import { recordGateSandbox, releaseGateSandbox } from "./gateSandboxRecords";

const root = path.resolve(import.meta.dir, "..");
const roots: string[] = [];
afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

test("cleanup without a journal still requires an allocation identity and refuses replaced symlinks", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "gate-sandbox-identity-")); roots.push(parent);
  const saved = process.env.LLV_GATE_SANDBOX_RECORD; delete process.env.LLV_GATE_SANDBOX_RECORD;
  try {
    const unknown = path.join(parent, "unknown"); fs.mkdirSync(unknown); fs.writeFileSync(unknown + "/keep", "owned");
    expect(() => releaseGateSandbox(unknown)).toThrow("no local allocation record");
    expect(fs.readFileSync(unknown + "/keep", "utf8")).toBe("owned");
    const owned = path.join(parent, "owned"); fs.mkdirSync(owned); recordGateSandbox(owned);
    releaseGateSandbox(owned); expect(fs.existsSync(owned)).toBeFalse();
    const replaced = path.join(parent, "replaced"), retained = path.join(parent, "retained");
    fs.mkdirSync(replaced); recordGateSandbox(replaced); fs.renameSync(replaced, retained); fs.symlinkSync(unknown, replaced);
    expect(() => releaseGateSandbox(replaced)).toThrow("changed identity");
    expect(fs.readFileSync(unknown + "/keep", "utf8")).toBe("owned");
  } finally { if (saved === undefined) delete process.env.LLV_GATE_SANDBOX_RECORD; else process.env.LLV_GATE_SANDBOX_RECORD = saved; }
});

for (const hook of ["pre-commit", "pre-push"]) test("a completed " + hook + " retires its allocation before a later path recreation", async () => {
  const fixture = createHookFixture(root, roots);
  fs.writeFileSync(path.join(fixture.dir, "example.ts"), "export const value = 2;\n");
  fixture.git("add", "example.ts");
  const env = isolatedEnvironment(path.join(fixture.dir, "isolated"), fixture.env);
  delete env.LLV_GATE_SANDBOX_RECORD;
  const allocation = path.join(fixture.dir, "allocation.json");
  const saved = path.join(fixture.dir, "retired");
  const preload = path.join(fixture.dir, "recreate.ts");
  fs.writeFileSync(preload, [
    'import fs from "node:fs"; import path from "node:path"; import { mock } from "bun:test";',
    "const allocate = fs.mkdtempSync; let directory; const removals = [];",
    "const patched = { ...fs, mkdtempSync: (prefix, options) => {",
    "  const result = allocate(prefix, options);",
    '  if (path.basename(String(prefix)) === "delegatus-local-gate-") {',
    "    directory = result; fs.writeFileSync(" + JSON.stringify(allocation) + ", JSON.stringify(result));",
    "  } return result;",
    "}, rmSync: (target, options) => { removals.push({ target: String(target), options }); }};",
    'mock.module("node:fs", () => ({ ...patched, default: patched }));',
    'process.once("exit", () => {',
    "  if (!directory) return;",
    '  if (!removals.some(row => row.target === directory && row.options.recursive && row.options.force)) throw Error("fixture never received its cleanup");',
    // The double records only. This fixed fixture action simulates recreation
    // after the hook retired the allocation; it uses the path minted above.
    "  if (fs.realpathSync(path.dirname(directory)) !== " + JSON.stringify(fs.realpathSync(env.LLV_GATE_TEMP_ROOT ?? env.TMPDIR!)) + ') throw Error("fixture allocation escaped its own temp root");',
    "  fs.renameSync(directory, " + JSON.stringify(saved) + ");",
    '  fs.mkdirSync(path.join(directory, "tmpdir"), { recursive: true });',
    '  fs.writeFileSync(path.join(directory, "keep"), "new allocation");',
    "});",
  ].join("\n"));
  const child = Bun.spawn([process.execPath, "--preload", preload, path.join(root, "scripts/local-gate.ts"), hook],
    { cwd: fixture.dir, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (!fs.existsSync(allocation)) throw new Error("hook did not allocate: " + JSON.stringify({ out, error, code }));
  const directory = JSON.parse(fs.readFileSync(allocation, "utf8"));
  roots.push(directory);
  expect({ out, error, code }).toMatchObject({ code: 0 });
  expect(fs.readFileSync(path.join(directory, "keep"), "utf8")).toBe("new allocation");
  expect(fs.statSync(saved).ino).not.toBe(fs.statSync(directory).ino);
}, 30_000);

for (const replacement of ["directory", "symlink", "reregistered"] as const) test("an unretired " + replacement + " swap still refuses cleanup and preserves both trees", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gate-sandbox-swap-"));
  roots.push(directory);
  const env = isolatedEnvironment(directory, process.env);
  delete env.LLV_GATE_SANDBOX_RECORD;
  const allocation = path.join(directory, "allocation.json"), saved = path.join(directory, "saved");
  const script = path.join(directory, "swap.ts");
  fs.writeFileSync(script, [
    'import fs from "node:fs"; import path from "node:path";',
    "import { createGateSandbox } from " + JSON.stringify(path.join(root, "scripts/local-gate.ts")) + ";",
    "import { recordGateSandbox, releaseGateSandbox } from " + JSON.stringify(path.join(root, "scripts/gateSandboxRecords.ts")) + ";",
    "const directory = createGateSandbox();",
    replacement === "reregistered" ? "releaseGateSandbox(directory); fs.mkdirSync(directory); recordGateSandbox(directory);" : "",
    "fs.writeFileSync(" + JSON.stringify(allocation) + ", JSON.stringify(directory));",
    'fs.writeFileSync(path.join(directory, "original"), "original");',
    "fs.renameSync(directory, " + JSON.stringify(saved) + ");",
    replacement === "symlink"
      ? "fs.symlinkSync(" + JSON.stringify(saved) + ', directory, "dir");'
      : 'fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "keep"), "replacement");',
  ].join("\n"));
  const child = Bun.spawn([process.execPath, path.join(root, "scripts/owned-runner.ts"), ...(process.platform === "linux" ? [] : ["--portable"]), process.execPath, script],
    { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const created = JSON.parse(fs.readFileSync(allocation, "utf8"));
  roots.push(created);
  expect({ out, error, code }).toMatchObject({ code: 1 });
  expect(error).toContain("recorded gate sandbox changed identity");
  expect(fs.readFileSync(path.join(saved, "original"), "utf8")).toBe("original");
  if (replacement === "symlink") expect(fs.lstatSync(created).isSymbolicLink()).toBeTrue();
  else expect(fs.readFileSync(path.join(created, "keep"), "utf8")).toBe("replacement");
}, 30_000);

test("an explicitly retained sandbox survives outer owned-runner cleanup", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gate-sandbox-retained-"));
  roots.push(directory);
  const env = isolatedEnvironment(directory, process.env);
  delete env.LLV_GATE_SANDBOX_RECORD;
  const allocation = path.join(directory, "allocation.json"), script = path.join(directory, "retain.ts");
  fs.writeFileSync(script, [
    'import fs from "node:fs";',
    "import { createGateSandbox } from " + JSON.stringify(path.join(root, "scripts/local-gate.ts")) + ";",
    "import { retainGateSandbox } from " + JSON.stringify(path.join(root, "scripts/gateSandboxRecords.ts")) + ";",
    "const sandbox = createGateSandbox(); fs.writeFileSync(" + JSON.stringify(allocation) + ", sandbox);",
    'fs.writeFileSync(sandbox + "/input.txt", "held for an unconfirmed consumer"); retainGateSandbox(sandbox);',
  ].join("\n"));
  const child = Bun.spawn([process.execPath, path.join(root, "scripts/owned-runner.ts"), ...(process.platform === "linux" ? [] : ["--portable"]), process.execPath, script],
    { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`retained sandbox child failed: ${out}\n${error}`);
  const sandbox = fs.readFileSync(allocation, "utf8");
  roots.push(sandbox);
  expect(fs.readFileSync(path.join(sandbox, "input.txt"), "utf8")).toBe("held for an unconfirmed consumer");
}, 30_000);

function activeJournalFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-journal-"));
  roots.push(root);
  const directory = path.join(root, "delegatus-local-gate-private");
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const journal = path.join(root, "sandboxes.ndjson");
  fs.writeFileSync(journal, "", { mode: 0o600 });
  const stat = fs.lstatSync(directory);
  const row = { directory: fs.realpathSync(directory), dev: stat.dev, ino: stat.ino, generation: "generation-a" };
  return { directory, journal, row };
}

test("an active journal entry recognizes its exact private directory allocation", () => {
  const fixture = activeJournalFixture();
  fs.writeFileSync(fixture.journal, JSON.stringify(fixture.row) + "\n");
  expect(hasActiveGateSandbox(fixture.directory, fixture.journal)).toBe(true);
});

test.each([
  ["missing journal", "missing"],
  ["journal without an allocation", "empty"],
  ["released allocation", "released"],
  ["retained allocation", "retained"],
] as const)("does not recognize a private gate-shaped directory with %s", (_name, state) => {
  const fixture = activeJournalFixture();
  if (state !== "missing" && state !== "empty") {
    fs.writeFileSync(fixture.journal, [
      JSON.stringify(fixture.row),
      JSON.stringify({ ...fixture.row, [state]: true }),
    ].join("\n") + "\n");
  }
  const journal = state === "missing" ? path.join(path.dirname(fixture.journal), "absent.ndjson") : fixture.journal;
  expect(hasActiveGateSandbox(fixture.directory, journal)).toBe(false);
});

test("does not recognize a journal entry for an earlier inode at the same path", () => {
  const fixture = activeJournalFixture();
  const old = fixture.directory + ".old";
  fs.renameSync(fixture.directory, old);
  fs.mkdirSync(fixture.directory, { mode: 0o700 });
  fs.chmodSync(fixture.directory, 0o700);
  const replacement = fs.lstatSync(fixture.directory);
  expect(replacement.ino).not.toBe(fixture.row.ino);
  fs.writeFileSync(fixture.journal, JSON.stringify(fixture.row) + "\n");
  expect(hasActiveGateSandbox(fixture.directory, fixture.journal)).toBe(false);
});
