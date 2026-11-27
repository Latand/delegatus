import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ownFixtureTree, stopFixtureTree } from "@/lib/testing/fixtureProcess";
import { procBackend } from "@/lib/proc";

import { expect, spyOn, test } from "bun:test";

import {
  accountMigrationHostArgv,
  readStructuredHostStamp,
  resourceWritingHolders,
  STRUCTURED_HOST_STAMP_ENV,
  structuredHostEngine,
  structuredHostStamp,
} from "./process";

test("resource transcript holders use the async backend reader", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "resource-holder-reader-"));
  const transcript = path.join(directory, "transcript.jsonl");
  fs.writeFileSync(transcript, "fixture");
  const syncReader = spyOn(procBackend, "scanFdTargetsFor");
  const asyncReader = spyOn(procBackend, "resourceScanFdTargetsFor").mockImplementation(async (_paths, visit) => {
    visit(transcript, 4321, () => true);
  });
  try {
    expect(await resourceWritingHolders([transcript])).toEqual(new Map([[transcript, 4321]]));
    expect(asyncReader).toHaveBeenCalledTimes(1);
    expect(syncReader).not.toHaveBeenCalled();
  } finally {
    syncReader.mockRestore();
    asyncReader.mockRestore();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const CLAUDE_BROKER = [
  "claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json",
  "--verbose", "--include-partial-messages", "--replay-user-messages",
  "--permission-prompt-tool", "stdio", "--permission-mode", "bypassPermissions",
];

const CODEX_APP_SERVER = ["codex", "app-server", "--enable", "realtime_conversation"];

test("the claude broker and the codex app server are the two structured host shapes", () => {
  expect(structuredHostEngine(CLAUDE_BROKER)).toBe("claude");
  expect(structuredHostEngine(CODEX_APP_SERVER)).toBe("codex");
  expect(structuredHostEngine(["/usr/bin/node", "/home/user/.bun/bin/codex", "app-server"])).toBe("codex");
});

test("an operator's own CLI is not a structured host", () => {
  expect(structuredHostEngine(["claude"])).toBeNull();
  expect(structuredHostEngine(["claude", "--continue"])).toBeNull();
  /* `claude -p "summarise this"` is a one-shot print run from a shell, not a
     broker: without the stream-json input channel nothing can address it. */
  expect(structuredHostEngine(["claude", "-p", "summarise this"])).toBeNull();
  expect(structuredHostEngine(["codex", "resume", "--last"])).toBeNull();
  expect(structuredHostEngine(["codex-telegram-mcp", "app-server"])).toBeNull();
  expect(structuredHostEngine(["bash", "-lc", "claude -p --input-format stream-json"])).toBeNull();
});

test("an account-migration successor is recognised so bulk kills leave it alone", () => {
  expect(accountMigrationHostArgv([...CLAUDE_BROKER, "--resume", "/t.jsonl", "--fork-session"])).toBe(true);
  expect(accountMigrationHostArgv(CLAUDE_BROKER)).toBe(false);
  expect(accountMigrationHostArgv(CODEX_APP_SERVER)).toBe(false);
});

test("only the stamp this viewer writes marks a process as its own host", async () => {
  const stamped = ownFixtureTree(spawn("/bin/sh", ["-c", "sleep 30"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, [STRUCTURED_HOST_STAMP_ENV]: structuredHostStamp() },
  }));
  const foreign = ownFixtureTree(spawn("/bin/sh", ["-c", "sleep 30"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, [STRUCTURED_HOST_STAMP_ENV]: "/some/other/viewer/state" },
  }));
  const bareEnvironment = { ...process.env };
  delete bareEnvironment[STRUCTURED_HOST_STAMP_ENV];
  const bare = ownFixtureTree(spawn("/bin/sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore", env: bareEnvironment }));
  const children = [stamped, foreign, bare];
  try {
    /* The environment is written before exec, so it is readable as soon as
       the pid exists; give the spawn a beat regardless. */
    await new Promise((resolve) => setTimeout(resolve, 50));
    const stampOf = (child: typeof stamped) => readStructuredHostStamp(child.pid ?? 0);

    expect(stampOf(stamped)).toBe(structuredHostStamp());
    expect(stampOf(foreign)).not.toBe(structuredHostStamp());
    expect(stampOf(bare)).toBeNull();
  } finally {
    for (const child of children) await stopFixtureTree(child);
  }
});
