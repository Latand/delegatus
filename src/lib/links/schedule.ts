/**
 * A's sync schedule (docs/design/linked-installs.md M.5). Every 10 s A reads
 * its own cached task revision; a change in a linked project starts a call at
 * once. The timer wakes when the next call or read is due. Otherwise a call every 15 s while a board of a linked project is open,
 * every 10 s for 2 minutes after a call that moved data, else an interval that
 * doubles from 30 s up to 5 minutes. Failures back off to 5 minutes. One call
 * at a time per link; B never calls.
 */
import { lastSyncMoved, syncPeer } from "./client";
import { boardOpen } from "./boardPresence";
import { linkedContext } from "./linked";
import { taskExchange } from "./taskExchange";
import { readPeers } from "./state";
import { taskFeedSource } from "@/lib/tasks/store";

export const TICK_MS = 10_000;
const BURST_MS = 120_000;
const BURST_INTERVAL_MS = 10_000;
const OPEN_INTERVAL_MS = 15_000;
const IDLE_FIRST_MS = 30_000;
const IDLE_MAX_MS = 300_000;

type Plan = { nextAt: number; idle: number; burstUntil: number; failures: number; running: boolean };

export interface SchedulePorts {
  now(): number;
  /** Live links this install calls (A side), with the projects each links. */
  links(): { id: string; projects: ReadonlySet<string> }[];
  ownRevision(): number;
  hasPush(id: string, projects: ReadonlySet<string>): boolean;
  boardOpen(projects: ReadonlySet<string>): boolean;
  sync(id: string): Promise<{ moved: number }>;
}

export class LinkedBoardSchedule {
  private readonly plans = new Map<string, Plan>();
  private lastRevision: number | null = null;
  private revisionReadAt = -Infinity;

  constructor(private readonly ports: SchedulePorts) {}

  /** One tick; resolves when the calls it started have ended. The own
      revision is read at most every 10 s. */
  async tick(): Promise<void> {
    const now = this.ports.now();
    const links = this.ports.links();
    for (const id of this.plans.keys()) if (!links.some((link) => link.id === id)) this.plans.delete(id);
    let revisionMoved = false;
    if (now - this.revisionReadAt >= TICK_MS) {
      this.revisionReadAt = now;
      const revision = this.ports.ownRevision();
      revisionMoved = revision !== this.lastRevision;
      this.lastRevision = revision;
    }
    const runs: Promise<void>[] = [];
    for (const link of links) {
      let plan = this.plans.get(link.id);
      if (!plan) { plan = { nextAt: now, idle: IDLE_FIRST_MS, burstUntil: 0, failures: 0, running: false }; this.plans.set(link.id, plan); }
      if (plan.running) continue;
      if (revisionMoved && plan.failures === 0 && this.ports.hasPush(link.id, link.projects)) plan.nextAt = Math.min(plan.nextAt, now);
      if (now < plan.nextAt) continue;
      runs.push(this.run(link, plan));
    }
    await Promise.all(runs);
  }

  /** How long until the next call or revision read is due, 1 s to 10 s. */
  nextDelay(): number {
    const now = this.ports.now();
    let due = this.revisionReadAt + TICK_MS;
    for (const plan of this.plans.values()) if (!plan.running) due = Math.min(due, plan.nextAt);
    return Math.min(TICK_MS, Math.max(1_000, due - now));
  }

  private async run(link: { id: string; projects: ReadonlySet<string> }, plan: Plan): Promise<void> {
    plan.running = true;
    try {
      const { moved } = await this.ports.sync(link.id);
      const now = this.ports.now();
      plan.failures = 0;
      if (moved > 0) { plan.burstUntil = now + BURST_MS; plan.idle = IDLE_FIRST_MS; }
      if (this.ports.boardOpen(link.projects)) plan.nextAt = now + OPEN_INTERVAL_MS;
      else if (now < plan.burstUntil) plan.nextAt = now + BURST_INTERVAL_MS;
      else { plan.nextAt = now + plan.idle; plan.idle = Math.min(plan.idle * 2, IDLE_MAX_MS); }
    } catch {
      plan.failures++;
      plan.nextAt = this.ports.now() + Math.min(IDLE_FIRST_MS * 2 ** (plan.failures - 1), IDLE_MAX_MS);
    } finally {
      plan.running = false;
    }
  }
}

export const productionSchedulePorts: SchedulePorts = {
  now: Date.now,
  links: () => {
    const context = linkedContext();
    const live = new Set(readPeers().peers.filter((peer) => peer.state !== "revoked").map((peer) => peer.id));
    return context.links.filter((link) => link.side === "peer" && live.has(link.id)).map((link) => ({ id: link.id, projects: link.projects }));
  },
  ownRevision: () => taskFeedSource()?.revision() ?? 0,
  hasPush: (id, projects) => {
    const context = linkedContext();
    const peer = readPeers().peers.find((row) => row.id === id);
    if (!context.self || !peer) return false;
    return taskExchange({ id, install: peer.install, store: peer.store }, context.self).hasPush(projects);
  },
  boardOpen: (projects) => boardOpen(projects),
  sync: async (id) => { await syncPeer(id); return { moved: lastSyncMoved(id) }; },
};

const host = globalThis as typeof globalThis & { __llvLinkedBoardTimer?: ReturnType<typeof setTimeout> };

/** Started once per process by the release that owns traffic. Each tick is
    armed when the previous one ended, so two never overlap. */
export function startLinkedBoardSync(ports: SchedulePorts = productionSchedulePorts, ownsTraffic: () => Promise<boolean> = async () => {
  const { viewerReleaseOwnsTraffic } = await import("@/lib/viewerInstrumentation");
  return viewerReleaseOwnsTraffic();
}): void {
  if (host.__llvLinkedBoardTimer) return;
  const schedule = new LinkedBoardSchedule(ports);
  const arm = (delay: number) => {
    const timer = setTimeout(() => {
      void (async () => {
        if (!(await ownsTraffic())) { host.__llvLinkedBoardTimer = undefined; return; }
        await schedule.tick();
      })().catch((error) => console.error("[linked boards] sync tick failed", error instanceof Error ? error.message : String(error)))
        .finally(() => { if (host.__llvLinkedBoardTimer === timer) arm(schedule.nextDelay()); });
    }, delay);
    timer.unref?.();
    host.__llvLinkedBoardTimer = timer;
  };
  arm(TICK_MS);
}

export function stopLinkedBoardSync(): void {
  if (host.__llvLinkedBoardTimer) clearTimeout(host.__llvLinkedBoardTimer);
  host.__llvLinkedBoardTimer = undefined;
}
