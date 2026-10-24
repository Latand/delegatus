/** Local wall-clock hours; ISO weekdays: Monday=1, Sunday=7. */
export interface MaintenanceWindow {
  timeZone: string;
  weekdays: number[];
  startHour: number;
  endHour: number;
}

// A weekly opening can disappear during a clock change. Include the following
// week's opening too, with a day of margin for offset changes.
export const MAINTENANCE_WINDOW_SEARCH_MS = 15 * 86_400_000;

export function normalizeMaintenanceWindow(value: unknown): MaintenanceWindow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const w = value as MaintenanceWindow;
  if (typeof w.timeZone !== "string" || !w.timeZone || /^[+-]/.test(w.timeZone)
    || !Array.isArray(w.weekdays) || !w.weekdays.length || w.weekdays.length > 7
    || !w.weekdays.every(d => Number.isInteger(d) && d >= 1 && d <= 7)
    || !Number.isInteger(w.startHour) || !Number.isInteger(w.endHour)
    || w.startHour < 0 || w.endHour > 24 || w.startHour >= w.endHour) return null;
  try { new Intl.DateTimeFormat("en", { timeZone: w.timeZone }); } catch { return null; }
  return { timeZone: w.timeZone, weekdays: [...new Set(w.weekdays)].sort((a, b) => a - b), startHour: w.startHour, endHour: w.endHour };
}

function windowPredicate(window: MaintenanceWindow) {
  const format = new Intl.DateTimeFormat("en-US", { timeZone: window.timeZone, weekday: "short", hour: "numeric", hourCycle: "h23" });
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return (at: number) => {
    const parts = format.formatToParts(at);
    const day = days.indexOf(parts.find(p => p.type === "weekday")!.value) + 1;
    const hour = Number(parts.find(p => p.type === "hour")!.value);
    return window.weekdays.includes(day) && hour >= window.startHour && hour < window.endHour;
  };
}
export function maintenanceWindowOpen(window: MaintenanceWindow | null | undefined, at: number): boolean {
  return !window || windowPredicate(window)(at);
}

/** Skip closed windows; coalesce all overdue intervals into one current wake.
 * Search real instants, so missing DST hours are skipped and repeated hours
 * are both open. No missed-window queue is persisted or replayed.
 */
export function nextMaintenanceWindowTime(window: MaintenanceWindow | null | undefined, at: number): number | null {
  if (!window) return at;
  const open = windowPredicate(window);
  if (open(at)) return at;
  const start = Math.ceil(at / 60_000) * 60_000;
  for (let t = start; t <= start + MAINTENANCE_WINDOW_SEARCH_MS; t += 60_000) if (open(t)) return t;
  return null;
}
