import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { manualInstallRoot, PackageRunner, registryRevision } from "./package";
import { realPorts } from "./steps";
import { spawnSync } from "node:child_process";
import { restorePackageRevision, stampPackageRevision, verifyPackedRevision } from "../../../scripts/package-revision.mjs";
import type { LauncherRecord } from "./launcher";
const root = mkdtempSync("/var/tmp/package-update-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
test("registry metadata pins the published version to its revision", async () => {
  const revision = await registryRevision("latest", (async () => Response.json({ version: "1.0.1", gitHead: "a".repeat(40) })) as unknown as typeof fetch);
  expect(revision).toMatchObject({ version: "1.0.1", sha: "a".repeat(40) });
});

/* What the registry answered for 1.9.0 on 2026-10-04, without its publisher
   fields and its registry signatures. No published version carried `gitHead`:
   the release publishes a tarball, and npm reads that field from a git
   directory. */
const published = readFileSync(join(import.meta.dir, "__fixtures__", "registry-delegatus-cli-1.9.0.json"), "utf8");
test("a version published without a revision is named, with no revision", async () => {
  expect(JSON.parse(published).gitHead).toBeUndefined();
  const asked: string[] = [];
  const revision = await registryRevision("1.9.0", (async (input: RequestInfo | URL) => { asked.push(String(input)); return new Response(published, { headers: { "content-type": "application/json" } }); }) as unknown as typeof fetch);
  expect(asked).toEqual(["https://registry.npmjs.org/delegatus-cli/1.9.0"]);
  expect(revision).toEqual({ version: "1.9.0", sha: "", short: "", date: "" });
  await expect(registryRevision("latest", (async () => Response.json({ gitHead: "a".repeat(40) })) as unknown as typeof fetch)).rejects.toThrow("named no version");
});

test("the release gate refuses a packed manifest without the revision the updater reads", async () => {
  const directory = mkdtempSync(join(root, "packed-")); const manifest = join(directory, "package.json");
  const original = `${JSON.stringify({ name: "delegatus-cli", version: "1.9.1", bin: { delegatus: "bin/cli.mjs" } }, null, 2)}\n`;
  writeFileSync(manifest, original);
  expect(() => verifyPackedRevision(manifest)).toThrow("names no gitHead");
  const gate = (...args: string[]) => spawnSync(process.execPath, [join(import.meta.dir, "../../../scripts/package-revision.mjs"), "--verify", manifest, ...args], { encoding: "utf8" });
  expect(gate("b".repeat(40)).status).toBe(1);
  // Outside a git checkout prepack has no revision to write, and the gate still refuses.
  expect(stampPackageRevision(directory, null)).toBeNull();
  expect(readFileSync(manifest, "utf8")).toBe(original);
  expect(stampPackageRevision(directory, "b".repeat(40))).toBe("b".repeat(40));
  expect(verifyPackedRevision(manifest, "b".repeat(40))).toBe("b".repeat(40));
  expect(gate("b".repeat(40)).status).toBe(0);
  // A manifest packed from another commit is not this release.
  expect(gate("c".repeat(40)).status).toBe(1);
  // The registry serves the packed manifest; the updater reads the same field.
  const packed = readFileSync(manifest, "utf8");
  expect(await registryRevision("1.9.1", (async () => new Response(packed)) as unknown as typeof fetch)).toMatchObject({ version: "1.9.1", sha: "b".repeat(40), short: "bbbbbbb" });
  // A second pack replaces the stamp, and postpack leaves the file as it was.
  expect(stampPackageRevision(directory, "c".repeat(40))).toBe("c".repeat(40));
  expect(readFileSync(manifest, "utf8").match(/gitHead/g)).toHaveLength(1);
  restorePackageRevision(directory);
  expect(readFileSync(manifest, "utf8")).toBe(original);
});

test("this repository's manifest can carry the stamp", () => {
  const directory = mkdtempSync(join(root, "own-manifest-"));
  const own = readFileSync(join(import.meta.dir, "../../../package.json"), "utf8");
  writeFileSync(join(directory, "package.json"), own);
  expect(JSON.parse(own).scripts.postpack).toBe("node scripts/package-revision.mjs --restore");
  expect(stampPackageRevision(directory, "d".repeat(40))).toBe("d".repeat(40));
  expect(JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).gitHead).toBe("d".repeat(40));
  restorePackageRevision(directory);
  expect(readFileSync(join(directory, "package.json"), "utf8")).toBe(own);
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
