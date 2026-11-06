import crypto from "node:crypto";
import { statePath } from "@/lib/configDir";
import { recoverySeatCurrent, recoverySeatSegment } from "@/lib/orchestrator/seats";
import { projectAliasKeys } from "@/lib/projects/aliases";
import { mcpPageCursorStore } from "./pageCursors";
import { recoveryCaller, type ViewerMcpDomainDependencies } from "./bindings";
import { McpToolRefusal, SqliteMcpReceiptStore, type McpToolArgs } from "./server";

interface Position { owner: string; epoch: number; after: number; watermark: number; activatedAt?: string; revokedAt?: string }

export function listUnknownLaunchClaims(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies) {
  const caller = recoveryCaller(dependencies, true, false);
  if (!caller.project || !caller.conversationId || !caller.seatEpoch
    || !recoverySeatCurrent(caller.project, caller.conversationId, caller.seatEpoch)
    || args.project !== undefined && args.project !== caller.project) {
    throw new McpToolRefusal("only the current seat may read its own project's launch claims", { code: "recovery_not_permitted" });
  }
  const pinned = JSON.stringify(caller);
  const projectKeys = projectAliasKeys(caller.project);
  const assert = () => {
    if (JSON.stringify(recoveryCaller(dependencies, true, false)) !== pinned) throw new McpToolRefusal("launch claim caller changed", { code: "caller_unidentified" });
  };
  const scope = crypto.createHash("sha256").update(JSON.stringify(["unknown-launch-claims", caller.kind,
    caller.conversationId, caller.project, projectKeys, caller.authorityStamp, caller.nativeProof, caller.seatEpoch, args.limit ?? 25])).digest("hex");
  const cursors = mcpPageCursorStore();
  const held = args.cursor === undefined ? null : cursors.resolve(args.cursor, scope);
  if (args.cursor !== undefined && held === null) throw new McpToolRefusal("launch claim cursor expired or caller changed; restart without cursor", { code: "cursor_reset", retryable: true });
  const store = new SqliteMcpReceiptStore(statePath("mcp-receipts.sqlite"), { busyTimeoutMs: 0, preparedOnly: true });
  try {
    assert();
    const position: Position = held ? JSON.parse(held) : { owner: caller.conversationId, epoch: caller.seatEpoch, after: 0, watermark: store.launchWatermark() };
    const limit = Math.max(1, Math.min(50, Number(args.limit) || 25));
    const items: Record<string, unknown>[] = [];
    let visits = 0, bytes = 0, complete = false, full = false;
    while (visits < 99 && items.length < limit && !full) {
      assert();
      const requested = Math.min(Math.floor((100 - visits) / 2), limit - items.length);
      const rows = store.launchClaimPage(projectKeys, position.owner, position.after, position.watermark, requested);
      visits += Math.max(1, rows.length);
      for (const row of rows) {
        const previousSequence = position.after;
        position.after = row.sequence;
        if (typeof row.receipt_key !== "string" || !["spawn_agent", "create_pipeline"].includes(row.launch_tool) || !["claimed", "dispatching"].includes(row.stage ?? "")
          || !row.receipt_key.startsWith(`${row.launch_tool}:`)) continue;
        if (!Number.isFinite(row.claimed_at) || row.claimed_at < 0 || row.claimed_at > 8.64e15
          || (row.launch_due !== null && !Number.isFinite(row.launch_due))) continue;
        if (position.owner !== caller.conversationId && (!position.activatedAt || !position.revokedAt
          || row.claimed_at < Date.parse(position.activatedAt) || row.claimed_at > Date.parse(position.revokedAt))) continue;
        visits++;
        if (!store.launchClaimStillOpen(projectKeys, position.owner, row.sequence)) continue;
        const separator = row.receipt_key.indexOf(":");
        const item = { tool: row.launch_tool, clientRequestId: row.receipt_key.slice(separator + 1),
          claimedAt: new Date(row.claimed_at).toISOString(), settleAfter: row.launch_due,
          overdueMs: row.launch_due === null ? null : Math.max(0, Date.now() - row.launch_due),
          stage: row.stage, lastFailure: row.launch_failure_code, evidence: "mcp-claim", nextAction: "original-key-lookup" };
        const size = Buffer.byteLength(JSON.stringify(item));
        if (size > 23_000) continue;
        if (bytes + size > 23_000) { position.after = previousSequence; full = true; break; }
        items.push(item); bytes += size;
      }
      if (full || rows.length === requested) continue;
      if (visits >= 100) break;
      const segment = recoverySeatSegment(caller.project, caller.conversationId, caller.seatEpoch, position.owner, 1, position.epoch);
      visits++;
      if (!segment?.rows.length) { complete = true; break; }
      const previous = segment.rows[0]!;
      Object.assign(position, { owner: previous.conversationId, epoch: previous.seatEpoch, after: 0,
        activatedAt: previous.activatedAt, revokedAt: previous.revokedAt });
    }
    assert();
    return { items, nextCursor: complete ? null : cursors.issue(scope, JSON.stringify(position)),
      scanned: visits, decoded: 0, byteLimit: 24_576 };
  } finally { store.close(); }
}
