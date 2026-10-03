import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { manualInstallRoot, PackageRunner, registryRevision } from "./package";
import { realPorts } from "./steps";
import type { LauncherRecord } from "./launcher";
const root = mkdtempSync("/var/tmp/package-update-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
test("registry metadata pins the published version to its revision", async () => {
  const revision = await registryRevision("latest", (async () => Response.json({ version: "1.0.1", gitHead: "a".repeat(40) })) as unknown as typeof fetch);
  expect(revision).toMatchObject({ version: "1.0.1", sha: "a".repeat(40) });
});
for (const broken of [false, true]) test(`package install verifies runtime artifacts, broken=${broken}`, async () => {
  const directory = mkdtempSync(join(root, "run-")); const base = join(directory, "base"); mkdirSync(base);
  writeFileSync(join(base, "package.json"), JSON.stringify({ version: "1.0.0" }));
  const pointer = join(directory, "release.json");
  const record = { checkout: null, installRoot: base, releasesDir: join(directory, "releases"), releasePointer: pointer } as LauncherRecord;
  const calls: string[][] = [];
  const ports = { ...realPorts(() => {}), run: async (argv: string[], { cwd }: { cwd: string }) => {
    calls.push(argv); const installed = join(cwd, "node_modules", "delegatus-cli");
    mkdirSync(join(installed, "dist", "standalone"), { recursive: true }); mkdirSync(join(installed, "bin"));
    writeFileSync(join(installed, "package.json"), JSON.stringify({ version: "1.0.1" }));
    writeFileSync(join(installed, "dist", "standalone", "server.js"), "");
    writeFileSync(join(installed, "bin", "launcher-relaunch.mjs"), "");
    if (!broken) writeFileSync(join(installed, "dist", "runtime-host.mjs"), "");
    return 0;
  } };
  const runner = new PackageRunner(record, "bun", { LLV_STATE_DIR: join(directory, "state") }, join(directory, "logs"), () => {}, ports,
    async () => ({ sha: "a".repeat(40), short: "aaaaaaa", version: "1.0.1", date: "" }));
  await runner.start("a".repeat(40), { version: "1.0.1" });
  expect(calls).toEqual([["bun", "add", "--exact", "delegatus-cli@1.0.1"]]);
  expect(runner.state.state).toBe(broken ? "failed" : "done");
  if (!broken) expect(JSON.parse(readFileSync(pointer, "utf8"))).toMatchObject({ kind: "package", version: "1.0.1", baseVersion: "1.0.0" });
});


test("manual standalone launch resolves the install carrying its launcher", () => {
  const install = join(root, "manual"); const standalone = join(install, "dist", "standalone");
  mkdirSync(standalone, { recursive: true }); mkdirSync(join(install, "bin"));
  for (const directory of [install, standalone]) writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "delegatus-cli" }));
  writeFileSync(join(install, "bin", "cli.mjs"), "");
  expect(manualInstallRoot(standalone)).toBe(install);
  expect(manualInstallRoot(join(root, "unrelated"))).toBeNull();
});
