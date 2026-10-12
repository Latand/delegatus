/** Shared, clock-driven activity of a running, unsettled agent. */
export interface AgentActivityFacts {
  lastRecordAt: number | null;
  turnStartedAt?: number | null;
  openCall?: { name: string; input: Record<string, unknown> } | null;
  recentWait?: { finishedAt: number; command: string | null } | null;
  backgroundVerified?: boolean;
  background?: { id?: string; description: string | null }[];
  workProcesses?: { startedAt: number; command: string }[];
  checking?: boolean;
  check?: string | null;
}
export interface AgentActivity {
  state: "working" | "checking" | "idle";
  check: string | null;
  idleForMs: number | null;
}
export const AGENT_IDLE_AFTER_MS = 10 * 60_000;
export function waitShapedCall(call: NonNullable<AgentActivityFacts["openCall"]>): boolean {
  const name = call.name.split(/__|\./).at(-1) ?? call.name;
  if (name === "sleep" || name === "wait" || name === "Monitor") return true;
  if (name === "write_stdin") return !call.input.chars;
  if (name === "TaskOutput") return call.input.block !== false;
  if (name === "exec" && typeof call.input.code === "string") {
    const code = call.input.code;
    if (/await\s+tools\.(?:clock__sleep|sleep|wait)\s*\(/.test(code)) return true;
    if (/await\s+tools\.write_stdin\s*\(/.test(code)) return !/chars\s*:\s*(?!["']{2})\S/.test(code);
  }
  const command = typeof call.input.command === "string" ? call.input.command : typeof call.input.cmd === "string" ? call.input.cmd : "";
  return /(?:^|[;&|\s])sleep\s+\d|(?:^|[;&|\s])wait(?:$|[;&|\s])|gh\s+(?:pr\s+checks.*--watch|run\s+watch)|tail\s+.*-(?:f|F)/.test(command);
}
/** Names a command without exposing its paths, flags or argument values. */
export function checkCommand(command: string): string | null {
  const embedded = /(?:^|\s)(?:bun|node|python3?)\s+(?:test\s+[^\s;&]+|[^\s;&]+\.(?:[cm]?[jt]sx?|py))/.exec(command);
  const words = (embedded?.[0] ?? command).trim().split(/\s+/);
  const base = (word: string) => word.replace(/^['"]|['"]$/g, "").split(/[\\/]/).at(-1) ?? word;
  const binary = base(words[0] ?? "");
  if (!binary) return null;
  if (["bun", "node", "python", "python3"].includes(binary)) {
    if (words[1] === "test") return `${binary} test${words[2] && !words[2].startsWith("-") ? ` ${base(words[2])}` : ""}`;
    if (words[1] && !words[1].startsWith("-")) return base(words[1]).replace(/\.(?:[cm]?[jt]sx?|py)$/, "");
  }
  return [binary, words[1] && !words[1].startsWith("-") ? base(words[1]) : ""].filter(Boolean).join(" ").slice(0, 40);
}
export function classifyAgentActivity(facts: AgentActivityFacts, nowMs: number, idleAfterMs = AGENT_IDLE_AFTER_MS): AgentActivity {
  const process = facts.workProcesses?.filter(p => facts.turnStartedAt != null && p.startedAt >= facts.turnStartedAt && nowMs - p.startedAt >= 30_000).sort((a,b) => a.startedAt - b.startedAt)[0];
  const waiting = facts.openCall && waitShapedCall(facts.openCall);
  const recent = facts.recentWait && nowMs - facts.recentWait.finishedAt < 180_000;
  if (facts.checking || process || waiting || recent || facts.background?.length) {
    const command = facts.openCall?.input.command ?? facts.openCall?.input.cmd;
    const check = process ? checkCommand(process.command) : facts.background?.[0]?.description ?? facts.check ?? (waiting && typeof command === "string" ? checkCommand(command) : null) ?? (recent ? facts.recentWait?.command : null) ?? null;
    return { state: "checking", check, idleForMs: null };
  }
  const silent = facts.lastRecordAt === null ? null : Math.max(0, nowMs - facts.lastRecordAt);
  return facts.backgroundVerified !== false && silent !== null && silent >= idleAfterMs
    ? { state: "idle", check: null, idleForMs: silent }
    : { state: "working", check: null, idleForMs: null };
}

export function fileAgentActivity(file: { agentActivity?: AgentActivityFacts; mtime: number }, nowMs: number): AgentActivity {
  return classifyAgentActivity(file.agentActivity ?? { lastRecordAt: file.mtime * 1000 }, nowMs);
}
