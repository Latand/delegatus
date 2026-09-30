"use client";

import { useEffect, useState } from "react";

import type { LaneRow } from "@/lib/links/laneFeed";
import type { BoardTask } from "@/lib/tasks/types";

import type { RemoteAgentView } from "./RemoteAgents";

/*
 * What the other linked machines published about one project (or, with no
 * project, every linked project): their agents, and the pipeline lanes of the
 * tasks they own. It is polled, never stored: a restart starts empty and the
 * next call fills it (docs/design/synced-task-card.md §4).
 */

export type RemoteLaneView = LaneRow & { peer: string; install: string; stale: boolean; asOf: number };
export type RemoteHosts = Readonly<Record<string, { label: string; linked: boolean }>>;
export interface RemoteFeed {
  agents: RemoteAgentView[];
  lanes: RemoteLaneView[];
  self: string | null;
  hosts: RemoteHosts;
}

/** A card whose task runs on another machine: who owns it, whether that
    machine is linked now, and the lanes it published for the task. */
export interface RemoteCard {
  install: string;
  host: string;
  linked: boolean;
  lanes: RemoteLaneView[];
}

const NO_HOSTS: RemoteHosts = {};

/** The feed for `project`, or for every linked project when it is `null` (the
    Overview), refreshed every 15 s. Null until the first answer, and when none
    of this install's projects is linked. */
export function useRemoteFeed(project: string | null, enabled = true): RemoteFeed | null {
  const [held, setHeld] = useState<{ project: string | null; feed: RemoteFeed } | null>(null);
  useEffect(() => {
    if (!enabled || (project !== null && !/^repo-[0-9a-f]{32}$/.test(project))) return;
    let live = true;
    const refresh = async () => {
      try {
        const answer = await fetch(project === null ? "/api/links/agents" : `/api/links/agents?project=${encodeURIComponent(project)}`);
        if (!answer.ok) return;
        const payload = await answer.json() as Partial<RemoteFeed>;
        if (live) setHeld({ project, feed: {
          agents: Array.isArray(payload.agents) ? payload.agents : [],
          lanes: Array.isArray(payload.lanes) ? payload.lanes : [],
          self: typeof payload.self === "string" ? payload.self : null,
          hosts: payload.hosts && typeof payload.hosts === "object" ? payload.hosts : NO_HOSTS,
        } });
      } catch { /* Keep the last in-memory rows until the next local read. */ }
    };
    void refresh();
    const timer = window.setInterval(refresh, 15_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [project, enabled]);
  return enabled && held?.project === project ? held.feed : null;
}

/** The remote card for a task, or null for a task that runs here. A task
    draws only the lanes its own machine sent, so a peer can paint lanes on its
    own tasks and on nothing else. */
export function remoteCardFor(task: Pick<BoardTask, "id" | "machine"> | null, feed: RemoteFeed | null): RemoteCard | null {
  if (!task?.machine || !feed) return null;
  /* Without this install's own identity no task can be told from a local one. */
  if (feed.self === null || task.machine === feed.self) return null;
  const host = feed.hosts[task.machine];
  return {
    install: task.machine,
    host: host?.label ?? task.machine.slice(0, 8),
    linked: host?.linked ?? false,
    lanes: feed.lanes.filter((lane) => lane.install === task.machine && lane.tk.includes(task.id)).sort((a, b) => b.at - a.at || a.k.localeCompare(b.k)),
  };
}

/** Every remote card among `tasks`, by task id: one object per task, stable while
    the feed is, so a memoized card does not redraw on an unchanged poll. */
export function remoteCardsFor(tasks: readonly (Pick<BoardTask, "id" | "machine"> | null)[], feed: RemoteFeed | null): ReadonlyMap<string, RemoteCard> {
  const cards = new Map<string, RemoteCard>();
  for (const task of tasks) {
    const card = remoteCardFor(task, feed);
    if (task && card) cards.set(task.id, card);
  }
  return cards;
}
