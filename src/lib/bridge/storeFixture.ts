import { readStateCollectionRows } from "@/lib/state/sqliteStateStore";

import { bridgeChannelPath, bridgeReportLogPath } from "./store";
import type { BridgeChannelScope } from "./types";

/* Test fixture for the SQLite bridge stores (#1870, slice 4). Tests that used
   to read `bridge.json` or `bridge-reports.json` back to see what a write
   persisted read the stored rows here instead. */

function databaseBeside(legacyPath: string): string {
  return legacyPath.replace(/[^/]+$/, "state.sqlite");
}

/** One channel exactly as stored, or null. */
export function persistedBridgeChannel(scope?: BridgeChannelScope): Record<string, unknown> | null {
  const legacyPath = bridgeChannelPath();
  const key = scope ? `channel:${bridgeChannelPath(scope).match(/([0-9a-f]{32})\.json$/)![1]}` : "manager";
  const rows = (readStateCollectionRows(databaseBeside(legacyPath), "bridge_channels") ?? []) as { k: string; v: Record<string, unknown> }[];
  return rows.find((row) => row.k === key)?.v ?? null;
}

/** Every stored row of the report log, serialized, for "nothing names X" checks. */
export function persistedBridgeReportRowsText(): string {
  return JSON.stringify(readStateCollectionRows(databaseBeside(bridgeReportLogPath()), "bridge_reports") ?? []);
}
