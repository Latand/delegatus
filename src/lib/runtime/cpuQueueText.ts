/** This wire detail is also readable in the pipeline API and stage sheet. */
export const CPU_QUEUE_DETAIL_PREFIX = "Waiting for the CPU queue · ";
/** `stalledMs` replaces the bound once the queue's head has outlived its own. */
export function cpuQueueDetail(position: number, remainingMs: number, stalledMs?: number): string {
  return `${CPU_QUEUE_DETAIL_PREFIX}${ordinal(position)} · ${stalledMs ? `stalled for ${Math.max(1, Math.floor(stalledMs / 60_000))}` : `up to ${Math.ceil(remainingMs / 60_000)}`} min`;
}
export function ordinal(n: number): string {
  return `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th")}`;
}
export function parseCpuQueueDetail(detail: string | null | undefined): { position: number; minutes: number; stalled?: true } | null {
  const match = /^Waiting for the CPU queue · (\d+)(?:st|nd|rd|th) · (up to|stalled for) (\d+) min(?:$| · Viewer publication: )/.exec(detail ?? "");
  return match ? { position: Number(match[1]), minutes: Number(match[3]), ...(match[2] === "stalled for" ? { stalled: true as const } : {}) } : null;
}
