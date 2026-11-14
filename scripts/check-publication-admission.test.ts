import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createPublicationFixtures } from "./publicationHook.fixture";
import { publicationCheckBinding, readPublicationCheckReceipt } from "../src/lib/git/publicationCheckReceipt";
import { stopFixtureProcess } from "../src/lib/testing/fixtureProcess";

const root = path.resolve(import.meta.dir, "..");
const roots: string[] = [];
afterEach(() => { for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
const { fixture, commitFixtureInputs } = createPublicationFixtures(root, roots);

for (const mode of ["portable", "service"] as const) for (const dirty of [false, true]) test.skipIf(process.platform !== "linux" || mode === "service" && !process.env.LLV_OWNED_TEST_RUN_CGROUP)(`owned ${mode} publication certifies tracked test preloads and consumes its receipt: dirty=${dirty}`, async () => {
  const f = fixture(), source = "export const configured: number = 42; Object.assign(globalThis, { fixturePreload: configured });\n";
  fs.writeFileSync(path.join(f.dir, "setup.ts"), source);
  fs.writeFileSync(path.join(f.dir, "bunfig.toml"), '[define]\n"process.env.FIXTURE_CONFIG" = "\\\"preserved\\\""\n[test]\npreload = ["./setup.ts"]\ntimeout = 12345\n');
  fs.writeFileSync(path.join(f.dir, "example.test.ts"), 'import { test, expect } from "bun:test"; test("configured preload", () => { expect(Reflect.get(globalThis, "fixturePreload")).toBe(42); expect(process.env.FIXTURE_CONFIG).toBe("preserved"); });\n');
  commitFixtureInputs(f);
  if (dirty) fs.appendFileSync(path.join(f.dir, "setup.ts"), "// edited after review\n");
  f.env.XDG_CACHE_HOME = path.join(f.dir, ".git", "cache with spaces");
  fs.mkdirSync(f.env.XDG_CACHE_HOME, { recursive: true });
  const invoke = async (command: string[], transport = false) => {
    const child = spawn(process.execPath, [path.join(root, "scripts/owned-runner.ts"), ...(mode === "portable" ? ["--portable"] : []), ...command], {
      cwd: f.dir, env: { ...f.env, ...(transport ? { PATH: `${f.git("--exec-path").toString().trim()}${path.delimiter}${f.env.PATH}` } : {}) }, stdio: ["pipe", "pipe", "pipe"],
    });
    let output = ""; child.stdout!.on("data", value => output += value); child.stderr!.on("data", value => output += value);
    child.stdin!.end(transport ? `HEAD ${f.head} refs/heads/main ${"0".repeat(40)}\n` : undefined);
    try { return { code: await new Promise<number | null>(resolve => child.once("close", resolve)), output }; }
    finally { await stopFixtureProcess(child); }
  };
  const prepared = await invoke([process.execPath, "scripts/local-gate.ts", "pre-push", "--publication-prepare"]);
  if (dirty) {
    expect(prepared.code, prepared.output).toBe(1);
    expect(prepared.output).toContain("publication inputs cannot be certified: dirty worktree");
    expect(fs.existsSync(f.receipt)).toBe(false);
    expect(f.git("status", "--porcelain").toString()).toContain("setup.ts");
    return;
  }
  expect(prepared.code, prepared.output).toBe(0);
  expect(readPublicationCheckReceipt(f.receipt, publicationCheckBinding(f.env)).inputs).toMatch(/^[a-f0-9]{64}$/);
  const transported = await invoke(["bash", ".githooks/pre-push"], true);
  expect(transported.code, transported.output).toBe(0);
  expect(transported.output).toContain("verified completed checks for this publication; transport admitted");
  const tested = await invoke([process.execPath, "test", "./example.test.ts"]);
  expect(tested.code, tested.output).toBe(0);
  expect(fs.readFileSync(path.join(f.dir, "setup.ts"), "utf8")).toBe(source);
  expect(f.git("status", "--porcelain").toString()).toBe("");
}, 120_000);
