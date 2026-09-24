import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "bun:test";

import { procBackend } from "@/lib/proc";
import type { ProcessMemory } from "@/lib/proc/types";
import { STRUCTURED_HOST_STAMP_ENV } from "@/lib/scanner/process";

import {
  agentArgv,
  defaultViewerTreeDependencies,
  measureViewerTree,
  runtimeHostPidFromFence,
  viewerProcessName,
  type ViewerTreeDependencies,
} from "./resourceViewerTree";

const MIB = 1024 ** 2;

type FakeProcess = { ppid: number; argv: string[]; rss: number; swap?: number; stamp?: string };

/** The production shape on 2026-09-24: the server with its workers and the
    agent hosts it launched, the runtime host in its own container. */
const MACHINE: Record<number, FakeProcess> = {
  100: { ppid: 1, argv: ["bun-container", "--bun", "node_modules/.bin/next", "start"], rss: 1_300 * MIB },
  101: { ppid: 100, argv: ["/usr/local/bin/bun-container", "/app/src/lib/wakatimeSync.worker.ts"], rss: 900 * MIB, swap: 50 * MIB },
  102: { ppid: 100, argv: ["/usr/local/bin/bun-container", "/app/src/lib/accountMigrationController.worker.ts"], rss: 1_000 * MIB },
  103: { ppid: 100, argv: ["/state/telegram/venv/bin/python", "/app/bin/telegram-mcp-server.py"], rss: 50 * MIB },
  /* A structured host behind its nsenter wrapper, listed as a session root. */
  110: { ppid: 100, argv: ["nsenter", "-t", "1", "--", "/bin/sh", "-c", "exec \"$@\"", "sh", "/home/user", "/home/user/.bun/bin/codex", "app-server"], rss: 2 * MIB },
  111: { ppid: 110, argv: ["node", "/home/user/.bun/bin/codex", "app-server"], rss: 300 * MIB },
  112: { ppid: 111, argv: ["bun", "/home/user/mcp-server.mjs"], rss: 700 * MIB },
  /* A host the session table does not list (it failed), found by its stamp. */
  120: { ppid: 100, argv: ["nsenter", "-t", "1", "--", "/usr/bin/setpriv", "--", "sh"], rss: 2 * MIB, stamp: "/state" },
  121: { ppid: 120, argv: ["claude", "-p"], rss: 400 * MIB },
  /* Neither listed nor stamped (the environment is unreadable): its command line names the agent. */
  130: { ppid: 100, argv: ["nsenter", "-t", "1", "--", "sh", "-c", "exec \"$@\"", "sh", "/home/user/.local/bin/copilot", "--acp"], rss: 2 * MIB },
  131: { ppid: 130, argv: ["copilot", "--acp"], rss: 500 * MIB },
  /* A worker's own child is the worker's memory. */
  140: { ppid: 100, argv: ["unshare", "--user", "--pid", "--fork", "/bin/sh", "-c", "…", "llv-resource-worker", "token", "bun", "/app/src/lib/resourceCollector.worker.ts"], rss: 1 * MIB },
  141: { ppid: 140, argv: ["bun", "/app/src/lib/resourceCollector.worker.ts"], rss: 120 * MIB },
  200: { ppid: 1, argv: ["bun-container", "run", "src/runtime-host/main.ts"], rss: 700 * MIB },
};

function fakeDependencies(machine = MACHINE, over: Partial<ViewerTreeDependencies> = {}): ViewerTreeDependencies {
  return {
    selfPid: 100,
    runtimeHostPid: () => 200,
    children: (pid) => Object.entries(machine).filter(([, item]) => item.ppid === pid).map(([child]) => Number(child)),
    argv: (pid) => machine[pid]?.argv ?? [],
    hostStamp: (pid) => machine[pid]?.stamp ?? null,
    memory: (pids) => {
      const readings = new Map<number, ProcessMemory>();
      for (const pid of pids) {
        const item = machine[pid];
        if (item) readings.set(pid, { rssBytes: item.rss, swapBytes: item.swap ?? 0 });
      }
      return readings;
    },
    now: () => Date.parse("2026-09-24T06:30:00.000Z"),
    ...over,
  };
}

test("the server, the runtime host and their workers are attributed; agent trees stay out", () => {
  const viewer = measureViewerTree([110], fakeDependencies())!;

  expect(viewer.actionable).toBe(false);
  expect(viewer.capturedAt).toBe("2026-09-24T06:30:00.000Z");
  expect(viewer.processes.map((item) => [item.role, item.name, item.pid, item.procCount])).toEqual([
    ["server", "bun-container", 100, 1],
    ["runtime-host", "main", 200, 1],
    ["worker", "accountMigrationController.worker", 102, 1],
    ["worker", "wakatimeSync.worker", 101, 1],
    ["worker", "resourceCollector.worker", 140, 2],
    ["worker", "telegram-mcp-server", 103, 1],
  ]);
  expect(viewer.rssBytes).toBe((1_300 + 700 + 1_000 + 900 + 121 + 50) * MIB);
  expect(viewer.swapBytes).toBe(50 * MIB);
  expect(viewer.procCount).toBe(7);
  /* None of the agent pids — listed, stamped, or named — counted anywhere. */
  const counted = new Set(viewer.processes.map((item) => item.pid));
  for (const agent of [110, 111, 112, 120, 121, 130, 131]) expect(counted.has(agent)).toBe(false);
});

test("an agent the session table missed is still excluded by its stamp or command line", () => {
  const viewer = measureViewerTree([], fakeDependencies())!;
  expect(viewer.rssBytes).toBe((1_300 + 700 + 1_000 + 900 + 121 + 50) * MIB);
});

test("no runtime host, or one that is the server itself, is not listed twice", () => {
  expect(measureViewerTree([110], fakeDependencies(MACHINE, { runtimeHostPid: () => null }))!.processes
    .some((item) => item.role === "runtime-host")).toBe(false);
  const sameProcess = measureViewerTree([110], fakeDependencies(MACHINE, { runtimeHostPid: () => 100 }))!;
  expect(sameProcess.processes.filter((item) => item.pid === 100)).toHaveLength(1);
});

test("an unreadable server leaves the section out; a worker gone mid-read is dropped", () => {
  expect(measureViewerTree([], fakeDependencies(MACHINE, { memory: () => new Map() }))).toBeNull();
  const vanished = { ...MACHINE };
  const memory = fakeDependencies().memory;
  const viewer = measureViewerTree([110], fakeDependencies(vanished, {
    memory: (pids) => {
      const readings = memory(pids);
      readings.delete(101);
      return readings;
    },
  }))!;
  expect(viewer.processes.some((item) => item.pid === 101)).toBe(false);
});

test("agent command lines and worker names", () => {
  expect(agentArgv(["/home/user/.bun/bin/codex", "app-server"])).toBe(true);
  expect(agentArgv(["nsenter", "--", "sh", "/home/user/.local/bin/claude", "-p"])).toBe(true);
  expect(agentArgv(["/usr/local/bin/bun-container", "/app/src/lib/filesResponse.worker.ts"])).toBe(false);
  expect(agentArgv(["python", "/home/user/.codex/telegram-mcp.py"])).toBe(false);
  expect(viewerProcessName(["/usr/local/bin/bun-container", "/app/src/lib/filesResponse.worker.ts"])).toBe("filesResponse.worker");
  expect(viewerProcessName(["/usr/bin/sleep", "30"])).toBe("sleep");
});

test("the runtime host is read from its fence only while its start identity still holds", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-viewer-tree-fence-"));
  try {
    const fence = path.join(directory, "runtime-host.sock.lock");
    fs.writeFileSync(fence, JSON.stringify({ pid: 921, startIdentity: "921:1447", acquisitionId: "a".repeat(36) }));
    expect(runtimeHostPidFromFence(fence, () => "921:1447")).toBe(921);
    expect(runtimeHostPidFromFence(fence, () => "921:9999")).toBeNull();
    expect(runtimeHostPidFromFence(fence, () => null)).toBeNull();
    expect(runtimeHostPidFromFence(path.join(directory, "missing.lock"), () => "921:1447")).toBeNull();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
});

test("on this machine: a worker child counts, a child running an agent binary does not", async () => {
  if (procBackend.name !== "linux") return;
  /* This suite may itself run inside an agent host, whose stamp every child
     would inherit and which would rightly mark it an agent. */
  const env = { ...process.env };
  delete env[STRUCTURED_HOST_STAMP_ENV];
  const worker = spawn("sleep", ["30"], { stdio: "ignore", env });
  /* `codex` is only the script's $0 here, so the command line names an agent
     binary while running nothing but a shell. */
  const agent = spawn("bash", ["-c", "sleep 30; true", "codex"], { stdio: "ignore", env });
  children.push(worker, agent);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const viewer = measureViewerTree([], { ...defaultViewerTreeDependencies(), runtimeHostPid: () => null })!;
  const pids = viewer.processes.map((item) => item.pid);
  expect(viewer.processes[0]).toMatchObject({ role: "server", pid: process.pid });
  expect(pids).toContain(worker.pid!);
  expect(viewer.processes.find((item) => item.pid === worker.pid)).toMatchObject({ role: "worker", name: "sleep" });
  expect(pids).not.toContain(agent.pid!);
  expect(viewer.rssBytes).toBeGreaterThan(0);
});
