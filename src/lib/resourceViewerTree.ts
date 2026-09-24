import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { stateDir } from "@/lib/configDir";
import { procBackend } from "@/lib/proc";
import type { ProcessMemory } from "@/lib/proc/types";
import { defaultRuntimeHostEndpoint, runtimeHostFencePath } from "@/lib/runtime/localEndpoint";
import { runtimeHostSocket } from "@/lib/runtime/flags";
import { readStructuredHostStamp } from "@/lib/scanner/process";
import { stateOwner } from "@/lib/stateOwnership";

import type { ResourcesViewer, ResourcesViewerProcess, ResourcesViewerUnavailable } from "./types";

/**
 * Delegatus's own process tree (#1817): the web server this code runs in, the
 * runtime host that owns the stable listener, and every worker either of them
 * started. Agent hosts are children of the server too, so each child is
 * checked before it is counted: a listed session root, a process carrying the
 * structured-host stamp, or one whose command line names an agent binary is an
 * agent, and its whole subtree stays out. What remains is memory no kill on
 * the resources surface can free, so the section is marked non-actionable.
 */

const AGENT_BINARIES = new Set(["claude", "claude.exe", "codex", "codex.exe", "copilot", "copilot.exe"]);
const SCRIPT_EXTENSION = /\.(?:[cm]?[jt]s|py)$/;

export type ViewerTreeDependencies = {
  selfPid: number;
  runtimeHostPid: () => number | null;
  children: (pid: number) => number[];
  argv: (pid: number) => string[];
  hostStamp: (pid: number) => string | null;
  memory: (pids: Iterable<number>) => Map<number, ProcessMemory>;
  now: () => number;
};

/** A command line that runs an agent CLI, directly or through a wrapper that
    names it (the `nsenter … setpriv … codex app-server` launch). */
export function agentArgv(argv: string[]): boolean {
  return argv.some((token) => AGENT_BINARIES.has(path.basename(token)));
}

/** The label a worker is listed under: the script it runs, else its executable. */
export function viewerProcessName(argv: string[]): string {
  for (let index = argv.length - 1; index >= 1; index -= 1) {
    const token = argv[index]!;
    if (!token.startsWith("-") && SCRIPT_EXTENSION.test(token)) return path.basename(token).replace(SCRIPT_EXTENSION, "");
  }
  return argv[0] ? path.basename(argv[0]) : "unknown";
}

export function measureViewerTree(
  agentRoots: Iterable<number>,
  dependencies: ViewerTreeDependencies,
): ResourcesViewer | null {
  const agents = new Set(agentRoots);
  const isAgent = (pid: number) => agents.has(pid)
    || dependencies.hostStamp(pid) !== null
    || agentArgv(dependencies.argv(pid));
  const seen = new Set<number>();
  /** `pid` and its descendants, minus every agent subtree below it. */
  const ownTree = (pid: number): number[] => {
    const tree: number[] = [];
    const pending = [pid];
    seen.add(pid);
    while (pending.length > 0) {
      const current = pending.pop()!;
      tree.push(current);
      for (const child of dependencies.children(current)) {
        if (seen.has(child)) continue;
        seen.add(child);
        if (!isAgent(child)) pending.push(child);
      }
    }
    return tree;
  };

  const groups: Array<{ pid: number; role: ResourcesViewerProcess["role"]; tree: number[] }> = [];
  const addRoot = (pid: number, role: "server" | "runtime-host") => {
    if (seen.has(pid)) return;
    seen.add(pid);
    groups.push({ pid, role, tree: [pid] });
    for (const child of dependencies.children(pid)) {
      if (seen.has(child)) continue;
      if (isAgent(child)) {
        seen.add(child);
        continue;
      }
      groups.push({ pid: child, role: "worker", tree: ownTree(child) });
    }
  };
  addRoot(dependencies.selfPid, "server");
  const runtimeHost = dependencies.runtimeHostPid();
  if (runtimeHost !== null) addRoot(runtimeHost, "runtime-host");

  const memory = dependencies.memory(groups.flatMap((group) => group.tree));
  if (!memory.has(dependencies.selfPid)) return null;
  const processes: ResourcesViewerProcess[] = [];
  for (const group of groups) {
    let rssBytes = 0;
    let swapBytes = 0;
    let procCount = 0;
    for (const pid of group.tree) {
      const reading = memory.get(pid);
      if (!reading) continue;
      rssBytes += reading.rssBytes;
      swapBytes += reading.swapBytes;
      procCount += 1;
    }
    /* A worker that exited between the walk and the reading is simply gone. */
    if (procCount === 0) continue;
    processes.push({
      pid: group.pid,
      role: group.role,
      name: viewerProcessName(dependencies.argv(group.pid)),
      rssBytes,
      swapBytes,
      procCount,
    });
  }
  const rank = { server: 0, "runtime-host": 1, worker: 2 } as const;
  processes.sort((a, b) => rank[a.role] - rank[b.role] || b.rssBytes + b.swapBytes - (a.rssBytes + a.swapBytes));
  return {
    actionable: false,
    capturedAt: new Date(dependencies.now()).toISOString(),
    rssBytes: processes.reduce((total, item) => total + item.rssBytes, 0),
    swapBytes: processes.reduce((total, item) => total + item.swapBytes, 0),
    procCount: processes.reduce((total, item) => total + item.procCount, 0),
    processes,
  };
}

function linuxChildren(pid: number): number[] {
  const children: number[] = [];
  let tasks: string[];
  try {
    tasks = readdirSync(`/proc/${pid}/task`);
  } catch {
    return children;
  }
  /* A child is listed under the thread that forked it, so every thread's list counts. */
  for (const task of tasks) {
    let listed: string;
    try {
      listed = readFileSync(`/proc/${pid}/task/${task}/children`, "utf8");
    } catch {
      continue;
    }
    for (const raw of listed.trim().split(/\s+/)) {
      const child = Number(raw);
      if (Number.isSafeInteger(child) && child > 0) children.push(child);
    }
  }
  return children;
}

/** The runtime host's pid from its singleton fence, only while the process
    behind it still has the start identity the fence recorded. */
export function runtimeHostPidFromFence(
  fencePath: string,
  identity: (pid: number) => string | null = (pid) => procBackend.processIdentity(pid),
): number | null {
  try {
    const owner = JSON.parse(readFileSync(fencePath, "utf8")) as { pid?: unknown; startIdentity?: unknown };
    if (!Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 1) return null;
    const pid = owner.pid as number;
    const live = identity(pid);
    if (live === null) return null;
    if (typeof owner.startIdentity === "string" && owner.startIdentity !== live) return null;
    return pid;
  } catch {
    return null;
  }
}

function runtimeHostFence(): string {
  const configured = process.env.LLV_RUNTIME_HOST_FENCE?.trim();
  if (configured) return configured;
  const socket = runtimeHostSocket();
  return socket ? runtimeHostFencePath(socket, stateDir()) : defaultRuntimeHostEndpoint(stateDir()).fencePath;
}

export function defaultViewerTreeDependencies(): ViewerTreeDependencies {
  let index: Map<number, number[]> | null = null;
  const childrenFromPpids = (pid: number) => {
    if (!index) {
      index = new Map();
      for (const [child, parent] of procBackend.ppidMap()) {
        if (child === parent) continue;
        const list = index.get(parent);
        if (list) list.push(child);
        else index.set(parent, [child]);
      }
    }
    return index.get(pid) ?? [];
  };
  return {
    selfPid: process.pid,
    runtimeHostPid: () => runtimeHostPidFromFence(runtimeHostFence()),
    children: procBackend.name === "linux" ? linuxChildren : childrenFromPpids,
    argv: (pid) => procBackend.readArgv(pid),
    hostStamp: readStructuredHostStamp,
    memory: (pids) => procBackend.processMemory(pids),
    now: Date.now,
  };
}

export type ViewerTreeRead = { viewer: ResourcesViewer | null; unavailable: ResourcesViewerUnavailable | null };

/** Never throws: a failed measurement leaves the section out and the rest of the payload whole.

    The tree is rooted at this process, so it is measured only where this
    process is the Viewer. The same reader also runs inside a stdio MCP server,
    a Bun child of an agent CLI, where rooting the tree at `process.pid` would
    label that child the web server and leave the real one out; there the
    section is null and says why. */
export function readViewerTree(
  agentRoots: Iterable<number>,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: () => ViewerTreeDependencies = defaultViewerTreeDependencies,
): ViewerTreeRead {
  if (stateOwner(env) !== "viewer") return { viewer: null, unavailable: "not-the-viewer" };
  try {
    const viewer = measureViewerTree(agentRoots, dependencies());
    return viewer ? { viewer, unavailable: null } : { viewer: null, unavailable: "measurement-failed" };
  } catch (error) {
    console.error(`[resources] viewer process tree failed: ${error instanceof Error ? error.message : String(error)}`);
    return { viewer: null, unavailable: "measurement-failed" };
  }
}
