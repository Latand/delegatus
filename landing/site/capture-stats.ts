import type { Env } from "../worker";
import type { StatsClient } from "../stats/store";

export type CaptureEvent = { event: string; agent?: string; lang: string; country: string };

export function createCaptureWorkerEnv(points: CaptureEvent[], assets: Env["ASSETS"]): Env {
  return {
    STATS_ORIGIN: "https://stats.example",
    STATS_RP_ID: "stats.example",
    STATS: createCaptureStatsBinding(points),
    ASSETS: assets,
  };
}

export function createCaptureStatsBinding(points: CaptureEvent[]): Env["STATS"] {
  const client = {
    async recordPing() {
      throw new Error("Install pings do not belong in landing captures");
    },
    async recordEvent(event: { event: string; agent?: string; lang: string }, country: string) {
      points.push({ event: event.event, ...(event.agent ? { agent: event.agent } : {}), lang: event.lang, country });
    },
  } as unknown as StatsClient;
  return {
    idFromName: name => name as unknown as Parameters<Env["STATS"]["get"]>[0],
    get: () => client,
  };
}
