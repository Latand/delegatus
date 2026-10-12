/** This wire detail is also readable in the pipeline API and stage sheet. */
export const CPU_QUEUE_DETAIL_PREFIX = "Waiting for the CPU queue · ";
export function cpuQueueDetail(position: number, remainingMs: number): string {
  return `${CPU_QUEUE_DETAIL_PREFIX}${ordinal(position)} · up to ${Math.ceil(remainingMs / 60_000)} min`;
}
export function ordinal(n: number): string {
  return `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th")}`;
}
export function parseCpuQueueDetail(detail: string | null | undefined): { position: number; minutes: number } | null {
  const match = /^Waiting for the CPU queue · (\d+)(?:st|nd|rd|th) · up to (\d+) min(?:$| · Viewer publication: )/.exec(detail ?? "");
  return match ? { position: Number(match[1]), minutes: Number(match[2]) } : null;
}
