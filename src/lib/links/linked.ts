/**
 * Which projects are linked, over which link, and which machine runs a task
 * (docs/design/linked-installs.md M.2, M.4). Read on every task write, so the
 * answer is cached behind the stat of every file it comes from and the
 * `board_links` revision: with nothing shared it costs one stat.
 */
import fs from "node:fs";

import { statePath } from "@/lib/configDir";
import type { BoardTask } from "@/lib/tasks/types";

import { boardLinksRevision, remoteProjects } from "./boardLinks";
import { installPrefix } from "./stamp";
import { linkFile, readGrants, readPeers, sharedProjects } from "./state";

export type LinkedPeer = { key: string; side: "peer" | "grant"; id: string; install: string; prefix: string; label: string; projects: ReadonlySet<string> };
export type LinkedContext = { self: { id: string; prefix: string } | null; all: ReadonlySet<string>; links: readonly LinkedPeer[]; labels: ReadonlyMap<string, string> };

const EMPTY: LinkedContext = { self: null, all: new Set(), links: [], labels: new Map() };
let cached: { signature: string; context: LinkedContext } | null = null;

const stat = (file: string) => {
  try { const value = fs.statSync(file); return `${value.size}:${value.mtimeMs}:${value.ino}`; } catch { return "-"; }
};

function readInstallId(): string | null {
  try {
    const value = JSON.parse(fs.readFileSync(statePath("links/self.json"), "utf8")) as { v?: unknown; installId?: unknown };
    return value.v === 1 && typeof value.installId === "string" && /^[0-9a-f-]{36}$/.test(value.installId) ? value.installId : null;
  } catch { return null; }
}

/** The linked projects of every live link, and this install's identity. */
export function linkedContext(): LinkedContext {
  const shared = stat(linkFile("shared"));
  const selfStat = stat(statePath("links/self.json"));
  // Nothing shared and no identity: no project can be linked, and no row can
  // name another machine this install could know.
  if (shared === "-" && selfStat === "-") return EMPTY;
  const signature = [statePath(), shared, selfStat, stat(linkFile("peers")), stat(linkFile("grants")), stat(statePath("project-remotes.json")), boardLinksRevision()].join("|");
  if (cached?.signature === signature) return cached.context;
  const installId = readInstallId();
  const local = new Set(sharedProjects().map((project) => project.key));
  const links: LinkedPeer[] = [];
  const labels = new Map<string, string>();
  for (const peer of readPeers().peers) {
    labels.set(peer.install, peer.label);
    if (peer.state === "revoked") continue;
    const projects = new Set(remoteProjects(peer.id).map((project) => project.key).filter((key) => local.has(key)));
    links.push({ key: `peer:${peer.id}`, side: "peer", id: peer.id, install: peer.install, prefix: installPrefix(peer.install), label: peer.label, projects });
  }
  for (const grant of readGrants().grants) {
    if (!labels.has(grant.install)) labels.set(grant.install, grant.label);
    const projects = new Set(remoteProjects(grant.id).map((project) => project.key).filter((key) => local.has(key)));
    links.push({ key: `grant:${grant.id}`, side: "grant", id: grant.id, install: grant.install, prefix: installPrefix(grant.install), label: grant.label, projects });
  }
  const all = new Set(links.flatMap((link) => [...link.projects]));
  const context: LinkedContext = { self: installId ? { id: installId, prefix: installPrefix(installId) } : null, all, links, labels };
  cached = { signature, context };
  return context;
}

export function linkedPeer(side: "peer" | "grant", id: string): LinkedPeer | null {
  return linkedContext().links.find((link) => link.side === side && link.id === id) ?? null;
}

/** M.4: absent means this machine. */
export function runsHere(task: Pick<BoardTask, "machine">, context: LinkedContext = linkedContext()): boolean {
  return !task.machine || task.machine === context.self?.id;
}

export function machineLabel(installId: string, context: LinkedContext = linkedContext()): { label: string; linked: boolean } {
  const live = context.links.find((link) => link.install === installId);
  if (live) return { label: live.label, linked: true };
  return { label: context.labels.get(installId) ?? installId.slice(0, 8), linked: false };
}

export const TASK_RUNS_ELSEWHERE = "TASK_RUNS_ELSEWHERE";

export type RunsElsewhereRefusal = { code: typeof TASK_RUNS_ELSEWHERE; error: string; status: 409; taskId: string; machine: string };

/** The one guard at every seam where work starts or reaches an agent. */
export function runsElsewhere(task: Pick<BoardTask, "id" | "text" | "machine">, context: LinkedContext = linkedContext()): RunsElsewhereRefusal | null {
  if (runsHere(task, context)) return null;
  const { label, linked } = machineLabel(task.machine!, context);
  const title = task.text.split("\n", 1)[0]!.slice(0, 80);
  return { code: TASK_RUNS_ELSEWHERE, status: 409, taskId: task.id, machine: label,
    error: linked
      ? `${TASK_RUNS_ELSEWHERE}: "${title}" runs on ${label}; its own orchestrator starts it there. Use Run here to ask for it.`
      : `${TASK_RUNS_ELSEWHERE}: "${title}" runs on ${label} (not linked); no machine launches it until a copy is made here.` };
}

/** The first refusal among tasks a seam resolved, or null. */
export function firstRunsElsewhere(tasks: readonly Pick<BoardTask, "id" | "text" | "machine">[]): RunsElsewhereRefusal | null {
  if (!tasks.some((task) => task.machine)) return null;
  const context = linkedContext();
  for (const task of tasks) {
    const refusal = runsElsewhere(task, context);
    if (refusal) return refusal;
  }
  return null;
}

/** What `list_tasks` and `get_task` answer about ownership (M.4): the machine
    as a label, whether this machine starts it, and a pending handover. Only on
    tasks that were ever in a linked project. */
export function taskOwnership(task: Pick<BoardTask, "machine" | "handover">, context: LinkedContext = linkedContext()): { machine?: string; runsHere?: boolean; handover?: { to: string } } {
  if (!task.machine) return {};
  const here = runsHere(task, context);
  const owner = here ? "this machine" : machineLabel(task.machine, context);
  const label = typeof owner === "string" ? owner : `${owner.label}${owner.linked ? "" : " (not linked)"}`;
  return { machine: label, runsHere: here, ...(task.handover ? { handover: { to: task.handover.to === context.self?.id ? "this machine" : machineLabel(task.handover.to, context).label } } : {}) };
}

/** A task record as an agent reads it: ownership as labels, stamps left out. */
export function withOwnership<T extends Pick<BoardTask, "machine" | "handover"> & { sync?: unknown }>(task: T): T {
  if (!task.machine && task.sync === undefined) return task;
  const { sync: _sync, ...rest } = task;
  return { ...rest, ...taskOwnership(task) } as T;
}
