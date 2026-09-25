import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";

import { claimProcessTempRoot, nestProcessTempUnder, TEST_RUN_TEMP_PREFIX } from "./tempDirs";

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const made: string[] = [];

afterEach(() => {
  for (const directory of made.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function sandbox(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-temp-dirs-test-"));
  made.push(directory);
  return directory;
}

test("a claimed root becomes the process temp dir and goes with its release", () => {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", TMPDIR: sandbox() };
  const parent = env.TMPDIR!;
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = parent;
  try {
    const claimed = claimProcessTempRoot("llv-claim-test-", env);
    expect(path.dirname(claimed.root)).toBe(parent);
    expect(path.basename(claimed.root)).toStartWith("llv-claim-test-");
    expect(env.TMPDIR).toBe(claimed.root);
    fs.mkdirSync(path.join(claimed.root, "left-behind", "deep"), { recursive: true });
    claimed.release();
    expect(fs.existsSync(claimed.root)).toBeFalse();
    expect(env.TMPDIR).toBe(parent);
    claimed.release();
    expect(fs.readdirSync(parent)).toEqual([]);
  } finally {
    process.env.TMPDIR = previous;
  }
});

test("a root outside the owned prefix is refused, so the sweeper always recognizes one left behind", () => {
  expect(() => claimProcessTempRoot("tmp-", { NODE_ENV: "test" })).toThrow("llv-");
});

test("a capture driver's temp dir nests inside its run directory", () => {
  const run = sandbox();
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test" };
  expect(nestProcessTempUnder(run, env)).toBe(path.join(run, "tmp"));
  expect(env.TMPDIR).toBe(path.join(run, "tmp"));
  expect(fs.statSync(path.join(run, "tmp")).isDirectory()).toBeTrue();
});

/* The fixture leaks the way the 5000 test directories did: a named
   `mkdtempSync` import (which no wrapper can intercept), the default import,
   the promise API, a nested tree, and no cleanup at all. */
const LEAKING_TEST = `
import fs, { mkdtempSync } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

test("leaks", async () => {
  const made = [
    mkdtempSync(path.join(os.tmpdir(), "llv-registry-")),
    fs.mkdtempSync(path.join(os.tmpdir(), "pending-producer-")),
    await fsp.mkdtemp(path.join(os.tmpdir(), "rv-export-")),
    process.env.LLV_STATE_DIR,
  ];
  fs.mkdirSync(path.join(made[0], "node_modules", "a"), { recursive: true });
  fs.writeFileSync(path.join(made[0], "node_modules", "a", "index.js"), "x".repeat(4096));
  fs.writeFileSync(process.env.LEAK_REPORT, JSON.stringify(made));
});
`;

test("a test run through the preload leaves nothing in the temp dir it started with", () => {
  const directory = sandbox();
  const temp = path.join(directory, "tmp");
  fs.mkdirSync(temp);
  fs.writeFileSync(path.join(directory, "leak.test.ts"), LEAKING_TEST);
  const report = path.join(directory, "made.json");
  const before = fs.readdirSync(temp);

  /* No LLV_* from this process: a lane's environment carries its host stamp
     and state directory, and the child must build its own. */
  const result = spawnSync(process.execPath, ["test", "--preload", path.join(repoRoot, "test-preload.ts"), "./leak.test.ts"], {
    cwd: directory,
    env: { NODE_ENV: "test", PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: temp, LEAK_REPORT: report },
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(result.status).toBe(0);

  const leaked = JSON.parse(fs.readFileSync(report, "utf8")) as string[];
  expect(leaked).toHaveLength(4);
  for (const entry of leaked) {
    const relative = path.relative(temp, entry).split(path.sep);
    /* Every directory the run made sat inside its one root… */
    expect(relative[0]).toStartWith(TEST_RUN_TEMP_PREFIX);
    expect(relative.length).toBe(2);
  }
  /* …and the root went when the run ended. */
  expect(before).toEqual([]);
  expect(fs.readdirSync(temp)).toEqual([]);
});
