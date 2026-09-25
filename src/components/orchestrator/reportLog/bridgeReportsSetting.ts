"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

/*
 * The project's Bridge reports switch on the client (#2146). The board's ⋯
 * menu, the phone's ⋯ sheet and the report log's off line all draw it, so
 * they share one read per project: a switch flipped in the menu turns the
 * log's off line back into the log at once.
 */

export interface BridgeReportsSettingState {
  /** Null until the first read answers. */
  enabled: boolean | null;
  saving: boolean;
  failed: boolean;
}

const EMPTY: BridgeReportsSettingState = { enabled: null, saving: false, failed: false };
const states = new Map<string, BridgeReportsSettingState>();
const listeners = new Set<() => void>();
const reads = new Map<string, Promise<void>>();

function publish(project: string, next: BridgeReportsSettingState): void {
  states.set(project, next);
  for (const listener of listeners) listener();
}

function stateOf(project: string): BridgeReportsSettingState {
  return states.get(project) ?? EMPTY;
}

/** Record a value some other read already carried (the report log's page). */
export function noteBridgeReportsSetting(project: string, enabled: boolean): void {
  const current = stateOf(project);
  if (current.saving || current.enabled === enabled) return;
  publish(project, { ...current, enabled, failed: false });
}

function readSetting(project: string): Promise<void> {
  const held = reads.get(project);
  if (held) return held;
  const read = (async () => {
    try {
      const response = await fetch(`/api/projects/settings?project=${encodeURIComponent(project)}`, { cache: "no-store" });
      if (!response.ok) return;
      const body = await response.json() as { bridgeReports?: { enabled?: unknown } };
      /* Absent reads as on: a server from before the setting existed. */
      noteBridgeReportsSetting(project, body.bridgeReports?.enabled !== false);
    } catch {
      /* The row stays disabled until a later read answers. */
    } finally {
      reads.delete(project);
    }
  })();
  reads.set(project, read);
  return read;
}

async function writeSetting(project: string, enabled: boolean): Promise<boolean> {
  try {
    const response = await fetch("/api/projects/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project, bridgeReports: enabled }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function useBridgeReportsSetting(project: string, initial?: boolean): BridgeReportsSettingState & { toggle: () => void } {
  if (initial !== undefined && stateOf(project).enabled === null) states.set(project, { ...EMPTY, enabled: initial });
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
  const state = useSyncExternalStore(subscribe, () => stateOf(project), () => stateOf(project));

  useEffect(() => {
    if (initial !== undefined) return;
    void readSetting(project);
  }, [project, initial]);

  const toggle = useCallback(() => {
    const current = stateOf(project);
    if (current.enabled === null || current.saving) return;
    const next = !current.enabled;
    publish(project, { enabled: next, saving: true, failed: false });
    void writeSetting(project, next).then((ok) => {
      publish(project, ok ? { enabled: next, saving: false, failed: false } : { enabled: !next, saving: false, failed: true });
    });
  }, [project]);

  return { ...state, toggle };
}

export function resetBridgeReportsSettingForTests(): void {
  states.clear();
  reads.clear();
}
