import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitPortableTestRunner } from "../src/lib/testing/portableTestAdmission";

for (const platform of ["darwin", "win32"] as const) test(`portable ${platform} admission warns once and permits best-effort execution`, () => {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test" };
  const warnings: string[] = [];
  admitPortableTestRunner(platform, env, warning => warnings.push(warning));
  admitPortableTestRunner(platform, { ...env }, warning => warnings.push(warning));
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("best effort");
  expect(warnings[0]).toContain("a detached descendant can escape between guardian polls");
  expect(env.LLV_PORTABLE_TEST_WARNING_SHOWN).toBe("1");
});

test("Linux portable admission refuses even an inherited warning marker", () => {
  const warnings: string[] = [];
  expect(() => admitPortableTestRunner("linux", { NODE_ENV: "test", LLV_PORTABLE_TEST_WARNING_SHOWN: "1" }, warning => warnings.push(warning)))
    .toThrow("require a reachable user systemd manager");
  expect(warnings).toEqual([]);
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(systemd: boolean) {
  const root = mkdtempSync(join(tmpdir(), "slot-test-")); roots.push(root);
  for (const name of ["mkdir", "flock", "sleep", "dirname"]) symlinkSync(`/usr/bin/${name}`, join(root, name));
  if (systemd) {
    writeFileSync(join(root, "systemctl"), "#!/bin/bash\nexit 0\n"); chmodSync(join(root, "systemctl"), 0o755);
    writeFileSync(join(root, "systemd-run"), '#!/bin/bash\nprintf "%s\\n" "$@" > "$SLOT_LOG"\nwhile [[ "$1" != -- ]]; do shift; done\nshift\nexec "$SLOT_BUN" "$SLOT_SERVICE_STUB" "$4"\n'); chmodSync(join(root, "systemd-run"), 0o755);
    writeFileSync(join(root, "service-stub.ts"), 'import fs from "node:fs"; const cfg = JSON.parse(fs.readFileSync(process.argv[2]!, "utf8")); const result = Bun.spawnSync(cfg.command, { cwd: cfg.cwd, env: cfg.env, stdio: ["inherit", "inherit", "inherit"] }); process.exit(result.exitCode);');
  }
  const env = { ...process.env, PATH: root, LLV_GATE_BUN: process.execPath, SLOT_BUN: process.execPath, SLOT_SERVICE_STUB: join(root, "service-stub.ts"), LLV_GATE_LOCK_DIR: root, LLV_GATE_SLOTS: "1", SLOT_LOG: join(root, "log") };
  const run = (script: string) => spawnSync("/bin/bash", [join(import.meta.dir, "gate-slot.sh"), "/bin/bash", "-c", script], { env, encoding: "utf8", timeout: 10_000 });
  return { root, run, env };
}
test.skipIf(process.platform !== "linux")("a Linux gate without systemd refuses to launch an uncontained command", () => {
  const f = fixture(false); const run = f.run('echo "$NODE_OPTIONS"; exit 37');
  expect(run.status).not.toBe(0); expect(run.stderr).toContain("require a reachable user systemd manager");
});
test("memory service forwards args, status and bounded tree termination", () => {
  const f = fixture(true); expect(f.run("exit 23").status).toBe(23);
  const args = readFileSync(join(f.root, "log"), "utf8");
  expect(args).toContain("MemoryMax=8G"); expect(args).toContain("KillMode=control-group"); expect(args).toContain("TimeoutStopSec=2s");
  expect(f.run('echo "$NODE_OPTIONS"').stdout).toContain("--max-old-space-size=6144");
});
test("another command waits for the same legacy-compatible slot", async () => {
  const f = fixture(true);
  const env = f.env;
  const child = Bun.spawn(["/bin/bash", join(import.meta.dir, "gate-slot.sh"), "/bin/bash", "-c", `echo held > "$LLV_GATE_LOCK_DIR/held"; /bin/sleep 0.3`], { env, stdout: "ignore", stderr: "pipe" });
  for (let i = 0; i < 100 && !Bun.file(join(f.root, "held")).size; i++) await Bun.sleep(10);
  const result = spawnSync("/usr/bin/flock", ["-n", join(f.root, "llv-heavy-gate.slot1.lock"), "/bin/true"]);
  expect(result.status).toBe(1);
  expect(await child.exited).toBe(0);
});
