import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { releaseRootOf } from "./releaseHold";
import { installStateOwnershipGraph, LATE_RENAME_CONSUMER_SOURCE } from "./stateOwnershipGraph.fixture";

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

test.skipIf(process.platform !== "linux")("loading the real state-ownership module from a release holds its root for the process lifetime", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "llv-release-hold-"))); roots.push(root);
  const release = path.join(root, "releases", "0123456789ab");
  const entry = installStateOwnershipGraph(release);
  const probe = `await import(process.argv[1]); const fs = require("node:fs"); console.log(fs.readdirSync("/proc/self/fd").map(fd => { try { return fs.readlinkSync("/proc/self/fd/" + fd); } catch { return ""; } }).filter(link => link === process.argv[2]).length);`;
  const loaded = spawnSync(process.execPath, ["-e", probe, entry, release], { cwd: root, env: ENV(), encoding: "utf8" });
  expect(loaded.stderr).toBe("");
  expect(loaded.stdout.trim()).toBe("1");
});

test.skipIf(process.platform !== "linux")("a load of the real state-ownership module whose release left its path during the load fails", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "llv-release-hold-"))); roots.push(root);
  const release = path.join(root, "releases", "0123456789ab");
  const entry = installStateOwnershipGraph(release);
  // Every module was read from the release path; it is renamed off that path
  // before any of them runs, as retention's quarantine would.
  const moved = path.join(root, "releases", ".delegatus-trash-0123456789ab-x");
  const refused = spawnSync(process.execPath, ["-e", LATE_RENAME_CONSUMER_SOURCE, release, entry, moved], { cwd: root, env: ENV(), encoding: "utf8" });
  expect(refused.stderr).toContain(`release ${release} is being removed`);
  expect(refused.stdout).toBe("");
  expect(refused.status).toBe(3);
  expect(fs.existsSync(release)).toBeFalse();
  expect(fs.existsSync(path.join(moved, "src/lib/stateOwnership.ts"))).toBeTrue();
});
