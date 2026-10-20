import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadSessionTitles } from "./titleStore";

let stateDir = "";
const previousState = process.env.LLV_STATE_DIR;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-titles-ipc-"));
  process.env.LLV_STATE_DIR = stateDir;
});

afterEach(() => {
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test("concurrent writers in separate processes never lose an update", async () => {
  const child = path.join(import.meta.dir, "titleStore.lockChild.ts");
  const WRITERS = 4;
  const PER_WRITER = 12;
  const env = { ...process.env, LLV_STATE_DIR: stateDir };

  // Real SQLite writers contend through asynchronous admission; each distinct
  // key must survive, and every reported wait must leave the loop available.
  const children = Array.from({ length: WRITERS }, (_unused, writer) =>
    Bun.spawn({
      cmd: [process.execPath, child, String(writer), String(PER_WRITER)],
      env,
      stdout: "ignore",
      stderr: "pipe",
    }),
  );
  const results = await Promise.all(children.map(async (proc) => ({
    code: await proc.exited,
    stderr: await new Response(proc.stderr).text(),
  })));
  for (const result of results) {
    for (const line of result.stderr.split("\n").filter(Boolean)) {
      expect(line.startsWith("[blocking-wait] ")).toBe(true);
      const wait = JSON.parse(line.slice("[blocking-wait] ".length));
      expect(wait.synchronous).toBe(false);
      expect(wait.stateWait.synchronousSleepMs).toBe(0);
    }
    expect(result.code).toBe(0);
  }

  const records = loadSessionTitles();
  expect(records).toHaveLength(WRITERS * PER_WRITER);
  for (let writer = 0; writer < WRITERS; writer += 1) {
    for (let index = 0; index < PER_WRITER; index += 1) {
      expect(records.some((record) => record.key === `path:/w${writer}/${index}`)).toBe(true);
    }
  }
});
