import fs from "node:fs";
import path from "node:path";

/** Two ordinary five-minute seat checks give a newly launched stdio MCP time
 * to register. A registered launcher must refresh every 30 seconds. */
export const SEAT_MCP_START_GRACE_MS = 10 * 60_000;
export const SEAT_MCP_HEARTBEAT_LIMIT_MS = 2 * 60_000;
/** Consecutive transport or child-pipe failures; ordinary tool refusals reset this count. */
export const SEAT_MCP_TRANSPORT_FAILURE_LIMIT = 3;

export type SeatMcpHealth = { status: "healthy" | "untracked" | "dead"; detail: string };

/** A digest comes only from the registry's current launch receipt. The file
 * contains no capability or token. HTTP MCP has no per-session launcher and is
 * untracked here. */
export function seatMcpHealth(
  receipt: { spawnCapabilityDigest: string; createdAt: string } | null,
  designatedAt: string | null,
  stateDir: string,
  now: number,
  transport: "stdio" | "http" = "stdio",
): SeatMcpHealth {
  if (transport === "http") return { status: "untracked", detail: "shared HTTP MCP transport" };
  const digest = receipt?.spawnCapabilityDigest;
  if (!digest || !/^[0-9a-f]{64}$/.test(digest)) return { status: "untracked", detail: "no current MCP launch capability" };
  const born = Date.parse(designatedAt ?? receipt.createdAt);
  const inGrace = !Number.isFinite(born) || now - born < SEAT_MCP_START_GRACE_MS;
  let record: unknown;
  try {
    record = JSON.parse(fs.readFileSync(path.join(stateDir, "mcp-runtime", "sessions", `${digest}.json`), "utf8"));
  } catch (error) {
    if (inGrace) return { status: "untracked", detail: "MCP startup grace period" };
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "dead", detail: "the session's stdio MCP launcher has no liveness record" };
    return { status: "dead", detail: "the session's stdio MCP liveness record cannot be read" };
  }
  if (!record || typeof record !== "object") return inGrace
    ? { status: "untracked", detail: "MCP startup grace period" }
    : { status: "dead", detail: "the session's stdio MCP liveness record is invalid" };
  const heartbeat = record as { checkedAt?: unknown; ready?: unknown; unreadySince?: unknown; failedCalls?: unknown };
  const checkedAt = typeof heartbeat.checkedAt === "string" ? Date.parse(heartbeat.checkedAt) : Number.NaN;
  const unreadySince = typeof heartbeat.unreadySince === "string" ? Date.parse(heartbeat.unreadySince) : Number.NaN;
  if (!Number.isFinite(checkedAt) || checkedAt > now + 60_000 || now - checkedAt > SEAT_MCP_HEARTBEAT_LIMIT_MS) {
    return inGrace
      ? { status: "untracked", detail: "MCP startup grace period" }
      : { status: "dead", detail: "the session's stdio MCP launcher stopped reporting liveness" };
  }
  if (typeof heartbeat.failedCalls === "number" && heartbeat.failedCalls >= SEAT_MCP_TRANSPORT_FAILURE_LIMIT) {
    return { status: "dead", detail: "the session's Viewer MCP failed three consecutive calls because its transport or child pipe failed" };
  }
  if (Number.isFinite(unreadySince) && now - unreadySince > SEAT_MCP_HEARTBEAT_LIMIT_MS) {
    return inGrace
      ? { status: "untracked", detail: "MCP startup grace period" }
      : { status: "dead", detail: "the session's stdio MCP has not recovered from child or pipe loss" };
  }
  if (heartbeat.ready !== true) return { status: "untracked", detail: "MCP child is starting" };
  return { status: "healthy", detail: "the session's stdio MCP launcher is live" };
}
