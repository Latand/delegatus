import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileEntry } from "../types";
import { cachePayloadBytes, cacheSizes } from "../cacheTelemetry";
import { globalCache } from "./caches";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-links-performance-test-"));
const REAL_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");

const { linkEntries, primePersistedLineageFacts } = await import("./links");
const { ROOTS } = await import("./roots");

afterAll(() => {
  if (REAL_STATE !== undefined) process.env.LLV_STATE_DIR = REAL_STATE;
  else delete process.env.LLV_STATE_DIR;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

function entry(pathname: string, name: string, mtime: number): FileEntry {
  const stat = fs.statSync(pathname);
  return {
    path: pathname,
    root: "claude-projects",
    name,
    project: "repo",
    title: "session",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime,
    size: stat.size,
    activity: "idle",
    derivationComplete: true,
    proc: null,
    pid: null,
    model: "sonnet-4",
    pendingQuestion: null,
    waitingInput: null,
  };
}

type CommandFixture = { command: string; description: string };
type BackgroundIndexFixture = {
  size: number; mtimeMs: number; offset: number; carry: Buffer; complete: boolean;
  toolUses: Map<string, CommandFixture>; taskToolUses: Map<string, string>; commands: Map<string, CommandFixture>;
};

async function withBackgroundTelemetry(name: string, retained: number, run: (fixture: {
  index: BackgroundIndexFixture;
  source: string;
  scan: (ids?: string[]) => Promise<FileEntry[]>;
  descriptorReads: () => number;
  resetReads: () => void;
  assertCharge: () => void;
}) => Promise<void>) {
  const projectRoot = ROOTS["claude-projects"], taskRoot = ROOTS["claude-tasks"];
  ROOTS["claude-projects"] = path.join(SANDBOX, name, "projects");
  ROOTS["claude-tasks"] = path.join(SANDBOX, name, "tasks");
  const slug = `-repo-${name}`, sid = `session-${name}`;
  const source = path.join(ROOTS["claude-projects"], slug, `${sid}.jsonl`);
  const cache = globalCache<BackgroundIndexFixture>("background-index-v1");
  const tasks = new Set<string>();
  let reads = 0;
  try {
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, `${JSON.stringify({ type: "progress" })}\n`);
    const stat = fs.statSync(source);
    const index: BackgroundIndexFixture = {
      size: stat.size, mtimeMs: stat.mtimeMs, offset: stat.size, carry: Buffer.alloc(0), complete: true,
      toolUses: new Map(), taskToolUses: new Map(), commands: new Map(),
    };
    for (let i = 0; i < retained; i++) {
      const command = new Proxy({ command: `old command ${i}`, description: `old description ${i}` }, {
        getOwnPropertyDescriptor(target, key) { reads++; return Reflect.getOwnPropertyDescriptor(target, key); },
      });
      index.toolUses.set(`old-tool-${i}`, command);
      index.commands.set(`old-task-${i}`, command);
      index.taskToolUses.set(`old-pending-${i}`, `absent-tool-${i}`);
    }
    cache.set(source, index);
    reads = 0;
    await run({
      index, source, descriptorReads: () => reads, resetReads: () => { reads = 0; },
      async scan(ids = ["missing-task"]) {
        const taskEntries = ids.map(id => {
          tasks.add(id);
          const pathname = path.join(ROOTS["claude-tasks"], slug, sid, "tasks", `${id}.output`);
          fs.mkdirSync(path.dirname(pathname), { recursive: true });
          fs.writeFileSync(pathname, "done\n");
          return { ...entry(pathname, `${slug}/${sid}/tasks/${id}.output`, 2), root: "claude-tasks", kind: "task", engine: "shell", fmt: "plain" } as FileEntry;
        });
        const entries = [entry(source, `${slug}/${sid}.jsonl`, 1), ...taskEntries];
        await linkEntries(entries, {
          persist: false, durableHandoffLineage: { provenanceForChild: () => null },
        });
        return entries;
      },
      assertCharge() {
        const expected = [...cache].reduce((bytes, [key, value]) => bytes + cachePayloadBytes([key, value]), 0);
        expect(cacheSizes().caches.find(row => row.name === "background-index-v1")).toMatchObject({
          count: cache.size, bytes: expected, unmeasured: 0,
        });
      },
    });
  } finally {
    cache.delete(source);
    const commands = globalCache("bgcmd");
    for (const id of tasks) commands.delete(id);
    ROOTS["claude-projects"] = projectRoot;
    ROOTS["claude-tasks"] = taskRoot;
  }
}

function backgroundRecords(id: string, tool = "appended-tool", command = "run appended worker") {
  return [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: tool, input: { command, description: "Appended worker" } }] } }),
    JSON.stringify({ type: "user", tool_use_id: tool, message: { content: [{ type: "tool_result", content: `background with ID: ${id}` }] } }),
  ];
}

test.each([64, 1024])("completed background misses never remeasure %i retained commands", async retained => {
  await withBackgroundTelemetry(`completed-${retained}`, retained, async fixture => {
    await fixture.scan(Array.from({ length: 32 }, (_, i) => `missing-${retained}-${i}`));
    expect(fixture.descriptorReads()).toBe(0);
    fixture.assertCharge();
  });
});

test("background append, shared replacement and carry update only changed byte charges", async () => {
  await withBackgroundTelemetry("append-charges", 1024, async fixture => {
    const records = backgroundRecords("appended-task");
    fs.appendFileSync(fixture.source, `${records[0]}\n${records[1].slice(0, 30)}`);
    await fixture.scan();
    expect(fixture.index.carry.length).toBe(30);
    expect(fixture.descriptorReads()).toBe(0);
    fixture.assertCharge(); fixture.resetReads();

    fs.appendFileSync(fixture.source, `${records[1].slice(30)}\n`);
    await fixture.scan();
    expect(fixture.index.carry.length).toBe(0);
    expect(fixture.index.commands.get("appended-task") === fixture.index.toolUses.get("appended-tool")).toBe(true);
    expect(fixture.descriptorReads()).toBe(0);
    fixture.assertCharge(); fixture.resetReads();

    fs.appendFileSync(fixture.source, `${backgroundRecords("appended-task", "appended-tool", "replacement command")[0]}\n`);
    await fixture.scan();
    expect(fixture.index.commands.get("appended-task")?.command).toBe("replacement command");
    expect(fixture.descriptorReads()).toBe(0);
    fixture.assertCharge();
  });
});

test("background map eviction and file reset release exact shared payload charges", async () => {
  await withBackgroundTelemetry("eviction-charges", 20_000, async fixture => {
    fs.appendFileSync(fixture.source, `${backgroundRecords("eviction-task").join("\n")}\n`);
    await fixture.scan();
    expect(fixture.descriptorReads()).toBe(0);
    for (const map of [fixture.index.toolUses, fixture.index.taskToolUses, fixture.index.commands]) expect(map.size).toBe(20_000);
    expect(fixture.index.toolUses.has("old-tool-0")).toBe(false);
    expect(fixture.index.commands.has("old-task-0")).toBe(false);
    expect(fixture.index.taskToolUses.has("old-pending-0")).toBe(false);
    fixture.assertCharge(); fixture.resetReads();

    fs.writeFileSync(fixture.source, "{}\n");
    await fixture.scan();
    expect(fixture.descriptorReads()).toBe(0);
    const cache = globalCache<BackgroundIndexFixture>("background-index-v1");
    expect(cache.get(fixture.source)?.commands.size).toBe(0);
    fixture.assertCharge();
    cache.delete(fixture.source);
    fixture.assertCharge();
  });
});

test("a refused background read keeps charges intact and a later scan recovers", async () => {
  await withBackgroundTelemetry("read-retry-charges", 64, async fixture => {
    fs.appendFileSync(fixture.source, `${backgroundRecords("retry-task").join("\n")}\n`);
    const open = fs.openSync;
    fs.openSync = ((pathname: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      if (String(pathname) === fixture.source) throw new Error("fixture read refused");
      return open(pathname, flags, mode);
    }) as typeof fs.openSync;
    try { await fixture.scan(); } finally { fs.openSync = open; }
    expect(fixture.index.commands.has("retry-task")).toBe(false);
    expect(fixture.descriptorReads()).toBe(0);
    fixture.assertCharge(); fixture.resetReads();
    await fixture.scan();
    expect(fixture.index.commands.get("retry-task")?.command).toBe("run appended worker");
    expect(fixture.descriptorReads()).toBe(0);
    fixture.assertCharge();
  });
});

test("a fresh scanner process rebuilds background charges from its own retained data", async () => {
  await withBackgroundTelemetry("restart-charges", 64, async fixture => {
    fs.appendFileSync(fixture.source, `${backgroundRecords("restart-task").join("\n")}\n`);
    const entries = await fixture.scan(["restart-task"]);
    const env = { ...process.env };
    const childRoot = path.join(SANDBOX, "restart-child");
    for (const name of ["HOME", "XDG_CONFIG_HOME", "LLV_STATE_DIR", "TMPDIR", "LLV_CLAUDE_HOME", "LLV_CODEX_HOME"]) {
      env[name] = path.join(childRoot, name.toLowerCase());
      fs.mkdirSync(env[name]!, { recursive: true });
    }
    const script = `
      const { linkEntries } = await import(${JSON.stringify(new URL("./links.ts", import.meta.url).href)});
      const { ROOTS } = await import(${JSON.stringify(new URL("./roots.ts", import.meta.url).href)});
      const { globalCache } = await import(${JSON.stringify(new URL("./caches.ts", import.meta.url).href)});
      const { cacheSizes, cachePayloadBytes } = await import(${JSON.stringify(new URL("../cacheTelemetry.ts", import.meta.url).href)});
      Object.assign(ROOTS, ${JSON.stringify(ROOTS)});
      const cache = globalCache("background-index-v1");
      const before = cache.size;
      const entries = ${JSON.stringify(entries)};
      entries[1].cmd = "";
      await linkEntries(entries, { persist: false, durableHandoffLineage: { provenanceForChild: () => null } });
      const row = cacheSizes().caches.find(row => row.name === "background-index-v1");
      console.log(JSON.stringify({ before, count: row.count, bytes: row.bytes, expected: cachePayloadBytes([...cache][0]), command: entries[1].cmd }));
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    const result = JSON.parse(stdout);
    expect(result).toMatchObject({ before: 0, count: 1, command: "run appended worker" });
    expect(result.bytes).toBe(result.expected);
    fixture.assertCharge();
  });
});

test("compaction lineage proof reads a bounded predecessor tail", async () => {
  const slug = "-repo-bounded-compaction";
  const predecessorPath = path.join(SANDBOX, "predecessor.jsonl");
  const successorPath = path.join(SANDBOX, "successor.jsonl");
  const logicalParentUuid = "11111111-2222-0333-0444-555555555555";
  fs.writeFileSync(predecessorPath, Buffer.concat([
    Buffer.from(`${JSON.stringify({ type: "user", uuid: "head" })}\n`),
    Buffer.alloc(8 * 1024 * 1024, 0x20),
    Buffer.from(`\n${JSON.stringify({ type: "assistant", uuid: logicalParentUuid })}\n`),
  ]));
  fs.writeFileSync(successorPath, `${JSON.stringify({
    type: "system",
    subtype: "compact_boundary",
    logicalParentUuid,
  })}\n`);
  const predecessor = entry(predecessorPath, `${slug}/predecessor.jsonl`, 1);
  const successor = entry(successorPath, `${slug}/successor.jsonl`, 2);
  const originalOpen = fs.openSync;
  const originalRead = fs.readSync;
  const originalClose = fs.closeSync;
  const tracked = new Set<number>();
  let bytesRead = 0;
  fs.openSync = ((filename: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    const fd = originalOpen(filename, flags, mode);
    if (path.resolve(String(filename)) === predecessorPath) tracked.add(fd);
    return fd;
  }) as typeof fs.openSync;
  fs.readSync = ((fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: fs.ReadPosition) => {
    const read = originalRead(fd, buffer, offset, length, position);
    if (tracked.has(fd)) bytesRead += read;
    return read;
  }) as typeof fs.readSync;
  fs.closeSync = ((fd: number) => {
    tracked.delete(fd);
    return originalClose(fd);
  }) as typeof fs.closeSync;

  try {
    await linkEntries([predecessor, successor], { persist: false });
  } finally {
    fs.openSync = originalOpen;
    fs.readSync = originalRead;
    fs.closeSync = originalClose;
  }

  expect(predecessor.parent).toBe(successor.path);
  expect(bytesRead).toBeLessThanOrEqual(1024 * 1024);
});

test("many compaction probes share one bounded tail read for a growing candidate", async () => {
  const slug = "-repo-shared-compaction-tail";
  const candidatePath = path.join(SANDBOX, "shared-growing-candidate.jsonl");
  fs.writeFileSync(candidatePath, Buffer.concat([
    Buffer.from(`${JSON.stringify({ type: "user", uuid: "head" })}\n`),
    Buffer.alloc(8 * 1024 * 1024, 0x20),
    Buffer.from(`\n${JSON.stringify({ type: "assistant", uuid: "aaaaaaaa-bbbb-0ccc-0ddd-eeeeeeeeeeee" })}\n`),
  ]));
  const candidate = entry(candidatePath, `${slug}/candidate.jsonl`, 1);
  const successors = Array.from({ length: 32 }, (_, index) => {
    const logicalParentUuid = `11111111-2222-0333-0444-${String(index).padStart(12, "0")}`;
    const successorPath = path.join(SANDBOX, `shared-successor-${index}.jsonl`);
    fs.writeFileSync(successorPath, `${JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      logicalParentUuid,
    })}\n`);
    return entry(successorPath, `${slug}/successor-${index}.jsonl`, index + 2);
  });

  const originalOpen = fs.openSync;
  const originalRead = fs.readSync;
  const originalClose = fs.closeSync;
  const tracked = new Set<number>();
  let bytesRead = 0;
  fs.openSync = ((filename: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    const fd = originalOpen(filename, flags, mode);
    if (path.resolve(String(filename)) === candidatePath) tracked.add(fd);
    return fd;
  }) as typeof fs.openSync;
  fs.readSync = ((fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: fs.ReadPosition) => {
    const read = originalRead(fd, buffer, offset, length, position);
    if (tracked.has(fd)) bytesRead += read;
    return read;
  }) as typeof fs.readSync;
  fs.closeSync = ((fd: number) => {
    tracked.delete(fd);
    return originalClose(fd);
  }) as typeof fs.closeSync;

  try {
    await linkEntries([candidate, ...successors], { persist: false });
  } finally {
    fs.openSync = originalOpen;
    fs.readSync = originalRead;
    fs.closeSync = originalClose;
  }

  /* The candidate also pays the independent 512 KiB compact-marker discovery
     read once. All 32 UUID lineage probes share the remaining 1 MiB tail read. */
  expect(bytesRead).toBeLessThanOrEqual(1536 * 1024);
});

test("background command recovery advances within one bounded read budget", async () => {
  const projectRoot = path.join(SANDBOX, "background-projects");
  const taskRoot = path.join(SANDBOX, "background-tasks");
  const previousProjectRoot = ROOTS["claude-projects"];
  const previousTaskRoot = ROOTS["claude-tasks"];
  ROOTS["claude-projects"] = projectRoot;
  ROOTS["claude-tasks"] = taskRoot;
  const slug = "-repo-bounded-background";
  const sid = "session-bounded-background";
  const tid = "task-bounded-background";
  const toolUseId = "toolu_bounded_background";
  const mainPath = path.join(projectRoot, slug, `${sid}.jsonl`);
  const taskPath = path.join(taskRoot, slug, sid, "tasks", `${tid}.output`);
  fs.mkdirSync(path.dirname(mainPath), { recursive: true });
  fs.mkdirSync(path.dirname(taskPath), { recursive: true });
  const toolUse = JSON.stringify({
    type: "assistant",
    message: {
      content: [{
        type: "tool_use",
        id: toolUseId,
        name: "Bash",
        input: { command: "bun run bounded-worker", description: "Run bounded worker" },
      }],
    },
  });
  const filler = `${JSON.stringify({ type: "progress", payload: "x".repeat(64 * 1024) })}\n`.repeat(128);
  const banner = JSON.stringify({
    type: "user",
    tool_use_id: toolUseId,
    message: {
      content: [{
        type: "tool_result",
        tool_use_id: toolUseId,
        content: `background with ID: ${tid}`,
      }],
    },
  });
  fs.writeFileSync(mainPath, `${toolUse}\n${filler}${banner}\n`);
  fs.writeFileSync(taskPath, "complete\n");
  const main = entry(mainPath, `${slug}/${sid}.jsonl`, 1);
  const task: FileEntry = {
    ...entry(taskPath, `${slug}/${sid}/tasks/${tid}.output`, 2),
    root: "claude-tasks",
    engine: "shell",
    fmt: "plain",
    kind: "task",
  };

  const originalOpen = fs.openSync;
  const originalRead = fs.readSync;
  const originalReadFile = fs.readFileSync;
  const originalClose = fs.closeSync;
  const tracked = new Set<number>();
  let bytesRead = 0;
  try {
    await linkEntries([main], { persist: false });
    fs.openSync = ((filename: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      const fd = originalOpen(filename, flags, mode);
      if (path.resolve(String(filename)) === mainPath) tracked.add(fd);
      return fd;
    }) as typeof fs.openSync;
    fs.readSync = ((fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: fs.ReadPosition) => {
      const read = originalRead(fd, buffer, offset, length, position);
      if (tracked.has(fd)) bytesRead += read;
      return read;
    }) as typeof fs.readSync;
    fs.readFileSync = ((filename: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      const value = Reflect.apply(originalReadFile, fs, [filename, ...args]) as Buffer | string;
      if (typeof filename !== "number" && path.resolve(String(filename)) === mainPath) {
        bytesRead += typeof value === "string" ? Buffer.byteLength(value) : value.byteLength;
      }
      return value;
    }) as typeof fs.readFileSync;
    fs.closeSync = ((fd: number) => {
      tracked.delete(fd);
      return originalClose(fd);
    }) as typeof fs.closeSync;

    const readsByPass: number[] = [];
    for (let attempt = 0; attempt < 40 && task.cmd !== "bun run bounded-worker"; attempt += 1) {
      const before = bytesRead;
      await linkEntries([main, task], { persist: false });
      readsByPass.push(bytesRead - before);
    }

    expect(task).toMatchObject({
      parent: mainPath,
      cmd: "bun run bounded-worker",
      cmdDesc: "Run bounded worker",
      title: "Run bounded worker",
    });
    expect(Math.max(...readsByPass)).toBeLessThanOrEqual(256 * 1024);
  } finally {
    fs.openSync = originalOpen;
    fs.readSync = originalRead;
    fs.readFileSync = originalReadFile;
    fs.closeSync = originalClose;
    ROOTS["claude-projects"] = previousProjectRoot;
    ROOTS["claude-tasks"] = previousTaskRoot;
  }
});

test("background command recovery rescans replacement head after shrink above its offset", async () => {
  const projectRoot = path.join(SANDBOX, "shrunken-background-projects");
  const taskRoot = path.join(SANDBOX, "shrunken-background-tasks");
  const previousProjectRoot = ROOTS["claude-projects"];
  const previousTaskRoot = ROOTS["claude-tasks"];
  ROOTS["claude-projects"] = projectRoot;
  ROOTS["claude-tasks"] = taskRoot;
  const slug = "-repo-shrunken-background";
  const sid = "session-shrunken-background";
  const tid = "task-shrunken-background";
  const toolUseId = "toolu_shrunken_background";
  const mainPath = path.join(projectRoot, slug, `${sid}.jsonl`);
  const taskPath = path.join(taskRoot, slug, sid, "tasks", `${tid}.output`);
  fs.mkdirSync(path.dirname(mainPath), { recursive: true });
  fs.mkdirSync(path.dirname(taskPath), { recursive: true });
  fs.writeFileSync(mainPath, Buffer.alloc(512 * 1024, 0x78));
  fs.writeFileSync(taskPath, "complete\n");
  const main = entry(mainPath, `fixture/${slug}/${sid}.jsonl`, 1);
  const task: FileEntry = {
    ...entry(taskPath, `${slug}/${sid}/tasks/${tid}.output`, 2),
    root: "claude-tasks",
    engine: "shell",
    fmt: "plain",
    kind: "task",
  };

  try {
    await linkEntries([main, task], { persist: false });
    expect(task.cmd).toBe("");

    const proof = [
      JSON.stringify({
        type: "assistant",
        message: { content: [{
          type: "tool_use",
          id: toolUseId,
          name: "Bash",
          input: { command: "bun run replacement-worker", description: "Run replacement worker" },
        }] },
      }),
      JSON.stringify({
        type: "user",
        tool_use_id: toolUseId,
        message: { content: [{
          type: "tool_result",
          tool_use_id: toolUseId,
          content: `background with ID: ${tid}`,
        }] },
      }),
      "",
    ].join("\n");
    const replacement = Buffer.alloc(384 * 1024, 0x20);
    replacement.write(proof, 0, "utf8");
    fs.writeFileSync(mainPath, replacement);
    main.size = replacement.length;
    main.mtime = fs.statSync(mainPath).mtimeMs / 1000;

    await linkEntries([main, task], { persist: false });
    expect(task).toMatchObject({
      parent: mainPath,
      cmd: "bun run replacement-worker",
      cmdDesc: "Run replacement worker",
      title: "Run replacement worker",
    });
  } finally {
    ROOTS["claude-projects"] = previousProjectRoot;
    ROOTS["claude-tasks"] = previousTaskRoot;
  }
});

test("background command recovery reserves a bounded fair share for later candidates", async () => {
  const projectRoot = path.join(SANDBOX, "fair-background-projects");
  const taskRoot = path.join(SANDBOX, "fair-background-tasks");
  const previousProjectRoot = ROOTS["claude-projects"];
  const previousTaskRoot = ROOTS["claude-tasks"];
  ROOTS["claude-projects"] = projectRoot;
  ROOTS["claude-tasks"] = taskRoot;
  const slug = "-repo-fair-background";
  const blockedSid = "session-blocked-background";
  const resolvedSid = "session-resolved-background";
  const blockedTid = "task-blocked-background";
  const resolvedTid = "task-resolved-background";
  const toolUseId = "toolu_resolved_background";
  const blockedMainPath = path.join(projectRoot, slug, `${blockedSid}.jsonl`);
  const resolvedMainPath = path.join(projectRoot, slug, `${resolvedSid}.jsonl`);
  const blockedTaskPath = path.join(taskRoot, slug, blockedSid, "tasks", `${blockedTid}.output`);
  const resolvedTaskPath = path.join(taskRoot, slug, resolvedSid, "tasks", `${resolvedTid}.output`);
  fs.mkdirSync(path.dirname(blockedMainPath), { recursive: true });
  fs.mkdirSync(path.dirname(resolvedMainPath), { recursive: true });
  fs.mkdirSync(path.dirname(blockedTaskPath), { recursive: true });
  fs.mkdirSync(path.dirname(resolvedTaskPath), { recursive: true });
  fs.writeFileSync(blockedMainPath, Buffer.alloc(512 * 1024, 0x78));
  fs.writeFileSync(resolvedMainPath, [
    JSON.stringify({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: toolUseId,
          name: "Bash",
          input: { command: "bun run fair-worker", description: "Run fair worker" },
        }],
      },
    }),
    JSON.stringify({
      type: "user",
      tool_use_id: toolUseId,
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: toolUseId,
          content: `background with ID: ${resolvedTid}`,
        }],
      },
    }),
    "",
  ].join("\n"));
  fs.writeFileSync(blockedTaskPath, "complete\n");
  fs.writeFileSync(resolvedTaskPath, "complete\n");
  /* Fixture names avoid compact-chain probes; this
     regression measures only the background-command generation allowance. */
  const blockedMain = entry(blockedMainPath, `fixture/${slug}/${blockedSid}.jsonl`, 1);
  const resolvedMain = entry(resolvedMainPath, `fixture/${slug}/${resolvedSid}.jsonl`, 2);
  const blockedTask: FileEntry = {
    ...entry(blockedTaskPath, `${slug}/${blockedSid}/tasks/${blockedTid}.output`, 3),
    root: "claude-tasks",
    engine: "shell",
    fmt: "plain",
    kind: "task",
  };
  const resolvedTask: FileEntry = {
    ...entry(resolvedTaskPath, `${slug}/${resolvedSid}/tasks/${resolvedTid}.output`, 4),
    root: "claude-tasks",
    engine: "shell",
    fmt: "plain",
    kind: "task",
  };
  const originalOpen = fs.openSync;
  const originalRead = fs.readSync;
  const originalClose = fs.closeSync;
  const tracked = new Map<number, string>();
  let blockedBytesRead = 0;
  let totalBytesRead = 0;

  try {
    fs.openSync = ((filename: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      const fd = originalOpen(filename, flags, mode);
      const resolved = path.resolve(String(filename));
      if (resolved === blockedMainPath || resolved === resolvedMainPath) tracked.set(fd, resolved);
      return fd;
    }) as typeof fs.openSync;
    fs.readSync = ((fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: fs.ReadPosition) => {
      const read = originalRead(fd, buffer, offset, length, position);
      const source = tracked.get(fd);
      if (source) {
        totalBytesRead += read;
        if (source === blockedMainPath) blockedBytesRead += read;
      }
      return read;
    }) as typeof fs.readSync;
    fs.closeSync = ((fd: number) => {
      tracked.delete(fd);
      return originalClose(fd);
    }) as typeof fs.closeSync;
    await linkEntries([blockedMain, blockedTask, resolvedMain, resolvedTask], { persist: false });

    expect(blockedBytesRead).toBeLessThanOrEqual(128 * 1024);
    expect(totalBytesRead).toBeLessThanOrEqual(256 * 1024);
    expect(resolvedTask).toMatchObject({
      parent: resolvedMainPath,
      cmd: "bun run fair-worker",
      cmdDesc: "Run fair worker",
      title: "Run fair worker",
    });
  } finally {
    fs.openSync = originalOpen;
    fs.readSync = originalRead;
    fs.closeSync = originalClose;
    ROOTS["claude-projects"] = previousProjectRoot;
    ROOTS["claude-tasks"] = previousTaskRoot;
  }
});

test("proven background commands survive restart without source transcript reads", async () => {
  const projectRoot = path.join(SANDBOX, "restart-projects");
  const taskRoot = path.join(SANDBOX, "restart-tasks");
  const previousProjectRoot = ROOTS["claude-projects"];
  const previousTaskRoot = ROOTS["claude-tasks"];
  ROOTS["claude-projects"] = projectRoot;
  ROOTS["claude-tasks"] = taskRoot;
  const slug = "-repo-restart-background";
  const sid = "session-restart-background";
  const tid = "task-restart-background";
  const toolUseId = "toolu_restart_background";
  const mainPath = path.join(projectRoot, slug, `${sid}.jsonl`);
  const taskPath = path.join(taskRoot, slug, sid, "tasks", `${tid}.output`);
  fs.mkdirSync(path.dirname(mainPath), { recursive: true });
  fs.mkdirSync(path.dirname(taskPath), { recursive: true });
  fs.writeFileSync(mainPath, [
    JSON.stringify({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: toolUseId,
          name: "Bash",
          input: { command: "bun run restart-worker", description: "Run restart worker" },
        }],
      },
    }),
    `${JSON.stringify({ type: "progress", payload: "y".repeat(64 * 1024) })}\n`.repeat(32).trimEnd(),
    JSON.stringify({
      type: "user",
      tool_use_id: toolUseId,
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: toolUseId,
          content: `background with ID: ${tid}`,
        }],
      },
    }),
    "",
  ].join("\n"));
  fs.writeFileSync(taskPath, "complete\n");
  const main = entry(mainPath, `${slug}/${sid}.jsonl`, 1);
  const task: FileEntry = {
    ...entry(taskPath, `${slug}/${sid}/tasks/${tid}.output`, 2),
    root: "claude-tasks",
    engine: "shell",
    fmt: "plain",
    kind: "task",
  };
  const cacheStore = globalThis as typeof globalThis & { __llvCaches?: Record<string, Map<string, unknown>> };
  for (const cache of Object.values(cacheStore.__llvCaches ?? {})) cache.clear();

  const originalOpen = fs.openSync;
  const originalRead = fs.readSync;
  const originalReadFile = fs.readFileSync;
  const originalClose = fs.closeSync;
  const tracked = new Set<number>();
  let bytesRead = 0;
  try {
    for (let attempt = 0; attempt < 12 && task.cmd !== "bun run restart-worker"; attempt += 1) {
      await linkEntries([main, task], { persist: true });
    }
    expect(task.cmd).toBe("bun run restart-worker");
    expect(fs.existsSync(path.join(process.env.LLV_STATE_DIR!, "bg-commands.json"))).toBe(true);

    for (const cache of Object.values(cacheStore.__llvCaches ?? {})) cache.clear();
    task.parent = null;
    task.cmd = "";
    task.cmdDesc = "";
    task.title = "Background task after restart";
    await linkEntries([main], { persist: false });

    fs.appendFileSync(mainPath, `${JSON.stringify({ type: "progress", payload: "late growth" })}\n`);
    fs.openSync = ((filename: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      const fd = originalOpen(filename, flags, mode);
      if (path.resolve(String(filename)) === mainPath) tracked.add(fd);
      return fd;
    }) as typeof fs.openSync;
    fs.readSync = ((fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: fs.ReadPosition) => {
      const read = originalRead(fd, buffer, offset, length, position);
      if (tracked.has(fd)) bytesRead += read;
      return read;
    }) as typeof fs.readSync;
    fs.readFileSync = ((filename: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      const value = Reflect.apply(originalReadFile, fs, [filename, ...args]) as Buffer | string;
      if (typeof filename !== "number" && path.resolve(String(filename)) === mainPath) {
        bytesRead += typeof value === "string" ? Buffer.byteLength(value) : value.byteLength;
      }
      return value;
    }) as typeof fs.readFileSync;
    fs.closeSync = ((fd: number) => {
      tracked.delete(fd);
      return originalClose(fd);
    }) as typeof fs.closeSync;

    await linkEntries([main, task], { persist: false });

    expect(task).toMatchObject({
      parent: mainPath,
      cmd: "bun run restart-worker",
      cmdDesc: "Run restart worker",
      title: "Run restart worker",
    });
    expect(bytesRead).toBe(0);
  } finally {
    fs.openSync = originalOpen;
    fs.readSync = originalRead;
    fs.readFileSync = originalReadFile;
    fs.closeSync = originalClose;
    ROOTS["claude-projects"] = previousProjectRoot;
    ROOTS["claude-tasks"] = previousTaskRoot;
  }
});

test("a snapshot heuristic edge cannot outrank a provable compaction predecessor", async () => {
  const slug = "-repo-heuristic-compaction";
  const successorPath = path.join(SANDBOX, "heuristic-successor.jsonl");
  const provenPath = path.join(SANDBOX, "heuristic-proven.jsonl");
  const strayPath = path.join(SANDBOX, "heuristic-stray.jsonl");
  const logicalParentUuid = "bbbbbbbb-cccc-0ddd-0eee-ffffffffffff";
  fs.writeFileSync(successorPath, `${JSON.stringify({
    type: "system",
    subtype: "compact_boundary",
    logicalParentUuid,
  })}\n`);
  fs.writeFileSync(provenPath, `${JSON.stringify({ type: "assistant", uuid: logicalParentUuid })}\n`);
  fs.writeFileSync(strayPath, `${JSON.stringify({ type: "user", uuid: "unrelated" })}\n`);
  const successor = entry(successorPath, `${slug}/heuristic-successor.jsonl`, 3);
  successor.activity = "live";
  const proven = entry(provenPath, `${slug}/heuristic-proven.jsonl`, 2);
  const stray = entry(strayPath, `${slug}/heuristic-stray.jsonl`, 1);

  /* The persisted snapshot carried the nearest-older fallback taken while the
     live successor had no provable predecessor on disk. That edge is a guess,
     not an immutable fact, so a later generation with the true predecessor
     visible must re-prove instead of trusting the primed guess. */
  const snapshotSuccessor = { ...successor };
  const snapshotStray = { ...stray, parent: successor.path };
  primePersistedLineageFacts([snapshotSuccessor, snapshotStray]);

  await linkEntries([successor, proven, stray], { persist: false });

  expect(proven.parent).toBe(successor.path);
  expect(stray.parent).toBeNull();
});

test("proven compaction chains survive restart after predecessor growth", async () => {
  const slug = "-repo-restart-compaction";
  const predecessorPath = path.join(SANDBOX, "restart-predecessor.jsonl");
  const successorPath = path.join(SANDBOX, "restart-successor.jsonl");
  const logicalParentUuid = "66666666-7777-0888-0999-aaaaaaaaaaaa";
  fs.writeFileSync(predecessorPath, Buffer.concat([
    Buffer.alloc(2 * 1024 * 1024, 0x20),
    Buffer.from(`\n${JSON.stringify({ type: "assistant", uuid: logicalParentUuid })}\n`),
  ]));
  fs.writeFileSync(successorPath, `${JSON.stringify({
    type: "system",
    subtype: "compact_boundary",
    logicalParentUuid,
  })}\n`);
  const predecessor = entry(predecessorPath, `${slug}/restart-predecessor.jsonl`, 1);
  const successor = entry(successorPath, `${slug}/restart-successor.jsonl`, 2);
  const cacheStore = globalThis as typeof globalThis & { __llvCaches?: Record<string, Map<string, unknown>> };
  for (const cache of Object.values(cacheStore.__llvCaches ?? {})) cache.clear();

  await linkEntries([predecessor, successor], { persist: true });
  expect(predecessor.parent).toBe(successor.path);
  expect(fs.existsSync(path.join(process.env.LLV_STATE_DIR!, "compact-chains.json"))).toBe(true);

  for (const cache of Object.values(cacheStore.__llvCaches ?? {})) cache.clear();
  predecessor.parent = null;
  fs.appendFileSync(predecessorPath, Buffer.alloc(2 * 1024 * 1024, 0x20));
  predecessor.size = fs.statSync(predecessorPath).size;
  const originalOpen = fs.openSync;
  const originalRead = fs.readSync;
  const originalClose = fs.closeSync;
  const tracked = new Set<number>();
  let bytesRead = 0;
  fs.openSync = ((filename: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    const fd = originalOpen(filename, flags, mode);
    if (path.resolve(String(filename)) === predecessorPath) tracked.add(fd);
    return fd;
  }) as typeof fs.openSync;
  fs.readSync = ((fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: fs.ReadPosition) => {
    const read = originalRead(fd, buffer, offset, length, position);
    if (tracked.has(fd)) bytesRead += read;
    return read;
  }) as typeof fs.readSync;
  fs.closeSync = ((fd: number) => {
    tracked.delete(fd);
    return originalClose(fd);
  }) as typeof fs.closeSync;

  try {
    await linkEntries([predecessor, successor], { persist: false });
  } finally {
    fs.openSync = originalOpen;
    fs.readSync = originalRead;
    fs.closeSync = originalClose;
  }

  expect(predecessor.parent as string | null).toBe(successor.path);
  expect(bytesRead).toBeLessThanOrEqual(512 * 1024);
});

test("runtime callbacks advance while a large lineage projection is linking", async () => {
  const pathname = path.join(SANDBOX, "cooperative-linking.jsonl");
  fs.writeFileSync(pathname, "{}\n");
  let runtimeCallbackAdvanced = false;
  const callback = new Promise<void>((resolve) => {
    setImmediate(() => {
      runtimeCallbackAdvanced = true;
      resolve();
    });
  });
  const entries = Array.from({ length: 96 }, (_, index) => {
    const projected = entry(pathname, `cooperative-${index}`, index);
    Object.defineProperty(projected, "root", {
      configurable: true,
      get() {
        const deadline = performance.now() + 2;
        while (performance.now() < deadline) {
          // Reproduce CPU-heavy synchronous projection work in production scans.
        }
        return "system";
      },
    });
    projected.path = `${pathname}-${index}`;
    return projected;
  });

  await linkEntries(entries, { persist: false });

  expect(runtimeCallbackAdvanced).toBe(true);
  await callback;
});

/* The chain-head window bounds how many bytes of a successor are read looking
   for its compact_boundary marker. A transcript whose head outgrew that window
   must degrade to «parent unknown» — it must never lose its entry, because the
   entry is the conversation's only route onto the board (#950). */
test("a compact marker beyond the chain-head window leaves the parent unknown, never the conversation absent", async () => {
  const slug = "-repo-chain-head-window";
  const predecessorPath = path.join(SANDBOX, "beyond-window-predecessor.jsonl");
  const successorPath = path.join(SANDBOX, "beyond-window-successor.jsonl");
  const logicalParentUuid = "99999999-8888-0777-0666-555555555555";
  fs.writeFileSync(predecessorPath, `${JSON.stringify({ type: "assistant", uuid: logicalParentUuid })}\n`);
  /* CHAIN_HEAD_BYTES is 512 KiB; the marker sits a megabyte in. */
  fs.writeFileSync(successorPath, Buffer.concat([
    Buffer.from(`${JSON.stringify({ type: "user", uuid: "head" })}\n`),
    Buffer.alloc(1024 * 1024, 0x20),
    Buffer.from(`\n${JSON.stringify({ type: "system", subtype: "compact_boundary", logicalParentUuid })}\n`),
  ]));
  const predecessor = entry(predecessorPath, `${slug}/predecessor.jsonl`, 1);
  const successor = entry(successorPath, `${slug}/successor.jsonl`, 2);
  const entries = [predecessor, successor];

  await linkEntries(entries, { persist: false });

  expect(entries).toHaveLength(2);
  expect(entries.map((item) => item.path)).toContain(successorPath);
  expect(predecessor.parent).toBeNull();
});
