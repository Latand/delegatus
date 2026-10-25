import moment from "moment-timezone";

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

// The pinned dependency ships IANA data independently of Bun's Intl snapshot.
// Admit only published names, including aliases and case-insensitive spellings.
const timeZones = new Set(moment.tz.names().map(name => name.toLowerCase()));
function windowZone(timeZone: string) {
  return timeZones.has(timeZone.toLowerCase()) ? moment.tz.zone(timeZone) : null;
}

export function normalizeMaintenanceWindow(value: unknown): MaintenanceWindow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const w = value as MaintenanceWindow;
  if (typeof w.timeZone !== "string" || !w.timeZone || /^[+-]/.test(w.timeZone)
    || !Array.isArray(w.weekdays) || !w.weekdays.length || w.weekdays.length > 7
    || !w.weekdays.every(d => Number.isInteger(d) && d >= 1 && d <= 7)
    || !Number.isInteger(w.startHour) || !Number.isInteger(w.endHour)
    || w.startHour < 0 || w.endHour > 24 || w.startHour >= w.endHour) return null;
  if (!windowZone(w.timeZone)) return null;
  return { timeZone: w.timeZone, weekdays: [...new Set(w.weekdays)].sort((a, b) => a - b), startHour: w.startHour, endHour: w.endHour };
}

function windowPredicate(window: MaintenanceWindow) {
  const zone = windowZone(window.timeZone);
  if (!zone) throw new RangeError("Invalid maintenance time zone");
  return (at: number) => {
    // Zone offsets are minutes west of UTC. Read UTC fields of the shifted
    // instant so the process's own time zone never enters the calculation.
    const local = new Date(at - zone.utcOffset(at) * 60_000);
    const day = local.getUTCDay() || 7;
    const hour = local.getUTCHours();
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
