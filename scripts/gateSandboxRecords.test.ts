import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHookFixture } from "./local-gate.fixture";
import { isolatedEnvironment } from "./local-gate";

const root = path.resolve(import.meta.dir, "..");
const roots: string[] = [];
afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
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
    "const allocate = fs.mkdtempSync, remove = fs.rmSync; let directory;",
    "const patched = { ...fs, mkdtempSync: (prefix, options) => {",
    "  const result = allocate(prefix, options);",
    '  if (path.basename(String(prefix)) === "delegatus-local-gate-") {',
    "    directory = result; fs.writeFileSync(" + JSON.stringify(allocation) + ", JSON.stringify(result));",
    "  } return result;",
    "}, rmSync: (target, options) => {",
    "  if (directory && String(target) === directory) fs.renameSync(directory, " + JSON.stringify(saved) + ");",
    "  else remove(target, options);",
    "}};",
    'mock.module("node:fs", () => ({ ...patched, default: patched }));',
    'process.once("exit", () => {',
    "  if (!directory) return;",
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
