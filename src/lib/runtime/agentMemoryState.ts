export const GIB = 2 ** 30;
export type AgentMemoryKill = { at: string; limitBytes: number; limit: "agent" | "shared" | "system"; fatal: boolean; process: string | null };
export type HostMemoryState = { mechanism: "scope" | "watchdog"; limitBytes: number; unit: string | null; kills: number; lastKill: AgentMemoryKill | null };

export function normalizeHostMemory(value: unknown): HostMemoryState | null {
  if (!value || typeof value !== "object") return null;
  const state = value as HostMemoryState;
  if ((state.mechanism !== "scope" && state.mechanism !== "watchdog") || !Number.isSafeInteger(state.limitBytes) || state.limitBytes <= 0
    || !Number.isSafeInteger(state.kills) || state.kills < 0 || (state.unit !== null && (typeof state.unit !== "string" || !/^delegatus-agent-[\w.-]+\.scope$/.test(state.unit)))) return null;
  const kill = state.lastKill;
  if (kill !== null && (!kill || typeof kill.at !== "string" || !Number.isFinite(Date.parse(kill.at)) || !Number.isSafeInteger(kill.limitBytes) || kill.limitBytes <= 0
    || !["agent", "shared", "system"].includes(kill.limit) || typeof kill.fatal !== "boolean" || (kill.process !== null && typeof kill.process !== "string"))) return null;
  return { mechanism: state.mechanism, limitBytes: state.limitBytes, unit: state.unit, kills: state.kills,
    lastKill: kill ? { at: kill.at, limitBytes: kill.limitBytes, limit: kill.limit, fatal: kill.fatal, process: kill.process } : null };
}

export function memoryKillText(kill: Pick<AgentMemoryKill, "limitBytes" | "limit">): string {
  const gb = kill.limitBytes / GIB;
  const n = gb < 10 ? String(Number(gb.toFixed(1))) : String(Math.round(gb));
  return kill.limit === "system" ? `killed: out of memory (system memory exhausted, ${n} GB RAM)` : `killed: out of memory (limit ${n} GB)`;
}

/** A host's `memory` field; absent when the scope carries only CPU placement. */
export function memoryField(cell: { memoryState(): HostMemoryState | null } | null | undefined): { memory?: HostMemoryState } {
  const memory = cell?.memoryState();
  return memory ? { memory } : {};
}
