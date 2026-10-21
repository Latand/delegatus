import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { releaseRootOf } from "./releaseHold";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

test("a module path names the release that contains it, and nothing outside one", () => {
  expect(releaseRootOf("/cache/self-update/x/releases/0123456789ab/src/lib/stateOwnership.ts")).toBe("/cache/self-update/x/releases/0123456789ab");
  expect(releaseRootOf("/cache/releases/npm-1.2.3-beta.1/node_modules/delegatus-cli/src/a.ts")).toBe("/cache/releases/npm-1.2.3-beta.1");
  expect(releaseRootOf("/work/delegatus/src/lib/stateOwnership.ts")).toBeNull();
  expect(releaseRootOf("/cache/releases/not-a-release/src/a.ts")).toBeNull();
});

const ENV = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, TMPDIR: process.env.TMPDIR,
  LLV_STATE_DIR: process.env.LLV_STATE_DIR, LLV_VIEWER_CONTROL_URL: process.env.LLV_VIEWER_CONTROL_URL, NODE_ENV: "test" as const });

test.skipIf(process.platform !== "linux")("loading a release module holds its root for the process lifetime and refuses a release off its path", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "llv-release-hold-"))); roots.push(root);
  const release = path.join(root, "releases", "0123456789ab");
  fs.mkdirSync(path.join(release, "lib"), { recursive: true });
  const heldModule = path.join(release, "lib/held.js");
  fs.writeFileSync(heldModule, `require(${JSON.stringify(path.join(import.meta.dir, "releaseHold.ts"))}).holdReleaseOf(__filename);\n`);
  const probe = `require(process.argv[1]); console.log(require("node:fs").readdirSync("/proc/self/fd").map(fd => { try { return require("node:fs").readlinkSync("/proc/self/fd/" + fd); } catch { return ""; } }).filter(link => link === process.argv[2]).length);`;
  const loaded = spawnSync(process.execPath, ["-e", probe, heldModule, release], { cwd: root, env: ENV(), encoding: "utf8" });
  expect(loaded.stdout.trim()).toBe("1");
  // Loaded again after its release left the path: the load fails.
  const moved = path.join(root, "releases", ".delegatus-trash-0123456789ab-x");
  fs.mkdirSync(moved); fs.renameSync(release, path.join(moved, "0123456789ab"));
  const source = path.join(root, "copy.js");
  fs.writeFileSync(source, `require(${JSON.stringify(path.join(import.meta.dir, "releaseHold.ts"))}).holdReleaseOf(${JSON.stringify(heldModule)});\n`);
  const refused = spawnSync(process.execPath, [source], { cwd: root, env: ENV(), encoding: "utf8" });
  expect(refused.status).not.toBe(0);
  expect(refused.stderr).toContain("is being removed");
});
