import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createPublicationFixtures } from "./publicationHook.fixture";
import { publicationHeadroom, publicationMemoryBytes, waitForPublicationMemory } from "./publication-memory";
import { publicationCheckBinding, readPublicationCheckReceipt } from "../src/lib/git/publicationCheckReceipt";

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const roots: string[] = [];
const { fixture, nativeFixture, commitFixtureInputs } = createPublicationFixtures(path.resolve(import.meta.dir, ".."), roots);
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function memoryFixture(root: string) {
  const cgroup = path.join(root, "cgroup"), proc = path.join(root, "proc");
  const leaf = path.join(cgroup, "viewer", "worker");
  fs.mkdirSync(leaf, { recursive: true });
  fs.mkdirSync(path.join(proc, "self"), { recursive: true });
  fs.writeFileSync(path.join(proc, "self/cgroup"), "0::/viewer/worker\n");
  const meminfo = (available: number) => fs.writeFileSync(path.join(proc, "meminfo"),
    `MemTotal: ${32 * GiB / 1024} kB\nMemAvailable: ${available / 1024} kB\n`);
  const control = (group: string, max: number | "max", current: number) => {
    const dir = path.join(cgroup, group);
    fs.writeFileSync(path.join(dir, "memory.max"), String(max));
    fs.writeFileSync(path.join(dir, "memory.current"), String(current));
  };
  meminfo(24 * GiB);
  return { env: { LLV_GATE_PROC_ROOT: proc, LLV_GATE_CGROUP_ROOT: cgroup }, meminfo, control };
}

test("publication memory uses host headroom and every finite cgroup ancestor", () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "publication-memory-"));
  roots.push(root);
  const f = memoryFixture(root);
  f.control("", "max", 10 * GiB);
  f.control("viewer/worker", "max", 2 * GiB);
  expect(publicationHeadroom(f.env)).toEqual({ capacity: 32 * GiB, available: 24 * GiB });
  f.control("viewer", 16 * GiB, 6 * GiB);
  expect(publicationHeadroom(f.env)).toEqual({ capacity: 16 * GiB, available: 10 * GiB });
  f.meminfo(GiB);
  expect(publicationHeadroom(f.env)).toEqual({ capacity: 16 * GiB, available: GiB });
  f.control("viewer/worker", 14 * GiB, 16 * GiB);
  expect(publicationHeadroom(f.env)).toEqual({ capacity: 14 * GiB, available: 0 });
  fs.rmSync(path.join(f.env.LLV_GATE_CGROUP_ROOT, "viewer", "memory.current"));
  expect(publicationHeadroom(f.env)).toBeNull();
});

test("publication memory waits for heap plus 2 GiB and defers at 60 seconds", async () => {
  const required = publicationMemoryBytes("--max-old-space-size=11264");
  expect(required).toBe(13 * GiB);
  expect(publicationMemoryBytes("--max-old-space-size=1024")).toBe(required);
  expect(publicationMemoryBytes('--max_old_space_size "12288"')).toBe(14 * GiB);
  let clock = 0;
  const lines: string[] = [];
  const attempt = (available: () => number) => waitForPublicationMemory(required, line => lines.push(line),
    () => ({ capacity: 16 * GiB, available: available() }), () => clock, async ms => { clock += Number(ms); });
  expect(await attempt(() => clock < 2000 ? required - MiB : required)).toBeTrue();
  expect(clock).toBe(2_000);
  expect(lines).toEqual(["pre-push: waiting for publication memory (13312 MiB required)"]);
  clock = 0;
  expect(await attempt(() => required - MiB)).toBeFalse();
  expect(clock).toBe(60_000);
});

test.skipIf(process.platform !== "linux").each(["types", "Viewer build"] as const)("portable publication memory defers the %s plan, then records its RSS and passes", compiler => {
  const f = compiler === "Viewer build" ? nativeFixture() : fixture();
  const buildLog = f.writablePath(".git/viewer-build");
  if (compiler === "Viewer build") {
    fs.writeFileSync(f.writablePath("package.json"), JSON.stringify({ scripts: { build: '"$HOOK_BUN" scripts/build-fixture.ts' } }));
    fs.writeFileSync(f.writablePath("scripts/build-fixture.ts"), `
      import fs from "node:fs";
      import { fixtureWritePath } from "./fixture-write-path";
      if (process.env.LLV_GATE_FULL_TYPES !== fs.realpathSync(process.cwd())) throw new Error("missing full types binding");
      fs.appendFileSync(fixtureWritePath(${JSON.stringify(f.dir)}, ${JSON.stringify(buildLog)}), "build\\n");
    `);
    fs.mkdirSync(f.writablePath("src/runtime-host"), { recursive: true });
    fs.writeFileSync(f.writablePath("src/runtime-host/main.ts"), "// runtime change\n");
  }
  const fake = memoryFixture(f.writablePath(".git/memory"));
  fake.control("viewer", 12 * GiB, GiB);
  const systemctl = f.writablePath("shims/systemctl");
  fs.writeFileSync(systemctl, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  fs.mkdirSync(f.writablePath("scripts/gate-runner"));
  fs.writeFileSync(f.writablePath("scripts/gate-runner/.keep"), "");
  commitFixtureInputs(f);
  for (const key of ["LLV_GATE_SANDBOX_RECORD", "LLV_OWNED_RUN_COMPLETION_RECEIPT", "LLV_OWNED_RUN_COMPLETION_TOKEN"]) delete f.env[key];
  Object.assign(f.env, fake.env, { LLV_DOCKER_NSENTER_SHIMS: "1", NODE_OPTIONS: "--max-old-space-size=11264" });
  const refused = f.run(true);
  expect(refused.status, refused.stderr).toBe(75);
  expect(refused.stderr).toContain("using the documented portable cleanup fallback");
  expect(refused.stderr).toContain("publication memory admission deferred before checks started");
  expect(fs.existsSync(f.receipt)).toBeFalse();
  expect(fs.existsSync(buildLog)).toBeFalse();
  const calls = () => fs.existsSync(f.env.HOOK_LOG!) ? f.calls().map(call => call.args[0]).sort() : [];
  const checks = () => calls().filter(name => name !== "scripts/privacy-publication-gate.ts" && name !== "native-install");
  expect(checks()).toEqual([]);

  fake.control("viewer", 16 * GiB, GiB);
  const prepared = f.run(true);
  expect(prepared.status, prepared.stderr).toBe(0);
  if (compiler === "Viewer build") {
    expect(fs.readFileSync(buildLog, "utf8")).toBe("build\n");
    for (const check of ["runtime verdict tests", "MCP size budgets", "Viewer runtime", "runtime host", "runtime negative controls"]) {
      expect(prepared.stderr).toContain(`pre-push: ${check}`);
    }
    expect(checks()).toContain("scripts/local-gate-tests.ts");
    expect(checks()).not.toContain("tsc");
  } else {
    expect(checks()).toEqual(["scripts/eslint-changes.ts", "scripts/local-gate-tests.ts", "tsc"]);
  }
  const receipt = readPublicationCheckReceipt(f.receipt, publicationCheckBinding(f.env));
  expect(receipt.peakRssBytes).toBeGreaterThan(0);
  expect(receipt.checksMs).toBeGreaterThan(0);
  const transported = f.run(false);
  expect(transported.status, transported.stderr).toBe(0);
  expect(fs.existsSync(f.receipt)).toBeFalse();
}, 60_000);
