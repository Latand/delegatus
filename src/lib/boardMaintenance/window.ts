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

// IANA 2026b–2026e changes absent from the supported Bun's Intl snapshot.
// Keep pre-transition history in the named zone; Intl supplies the calendar
// fields in the permanent zone afterward.
// Sources: https://data.iana.org/time-zones/tzdb/{africa,northamerica,backward}
const permanentZones = new Map<string, { since: number; timeZone: string }>([
  ["Africa/Casablanca", { since: Date.parse("2026-09-20T01:00:00Z"), timeZone: "UTC" }],
  ["Africa/El_Aaiun", { since: Date.parse("2026-09-20T01:00:00Z"), timeZone: "UTC" }],
  ["America/Vancouver", { since: Date.parse("2026-11-01T09:00:00Z"), timeZone: "Etc/GMT+7" }],
  ["America/Edmonton", { since: Date.parse("2026-11-01T08:00:00Z"), timeZone: "Etc/GMT+6" }],
  ["America/Inuvik", { since: Date.parse("2026-11-01T08:00:00Z"), timeZone: "Etc/GMT+6" }],
  ["America/Winnipeg", { since: Date.parse("2026-11-01T07:00:00Z"), timeZone: "Etc/GMT+5" }],
]);
// Intl may preserve an alias in resolvedOptions().timeZone.
const zoneAliases = new Map([
  ["Canada/Pacific", "America/Vancouver"],
  ["Canada/Mountain", "America/Edmonton"],
  ["America/Yellowknife", "America/Edmonton"],
  ["Canada/Central", "America/Winnipeg"],
  ["America/Rainy_River", "America/Winnipeg"],
]);
function windowFormatter(timeZone: string) {
  // Intl also accepts numeric offsets; the settings contract requires a name.
  if (typeof timeZone !== "string" || !timeZone || /^[+-]/.test(timeZone)) throw new RangeError("Invalid maintenance time zone");
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "numeric", hourCycle: "h23" });
}

export function normalizeMaintenanceWindow(value: unknown): MaintenanceWindow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const w = value as MaintenanceWindow;
  if (typeof w.timeZone !== "string" || !w.timeZone || /^[+-]/.test(w.timeZone)
    || !Array.isArray(w.weekdays) || !w.weekdays.length || w.weekdays.length > 7
    || !w.weekdays.every(d => Number.isInteger(d) && d >= 1 && d <= 7)
    || !Number.isInteger(w.startHour) || !Number.isInteger(w.endHour)
    || w.startHour < 0 || w.endHour > 24 || w.startHour >= w.endHour) return null;
  try { windowFormatter(w.timeZone); }
  catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
  return { timeZone: w.timeZone, weekdays: [...new Set(w.weekdays)].sort((a, b) => a - b), startHour: w.startHour, endHour: w.endHour };
}

function windowPredicate(window: MaintenanceWindow) {
  const named = windowFormatter(window.timeZone);
  const name = named.resolvedOptions().timeZone;
  const permanent = permanentZones.get(zoneAliases.get(name) ?? name);
  const corrected = permanent ? windowFormatter(permanent.timeZone) : named;
  return (at: number) => {
    const parts = (permanent && at >= permanent.since ? corrected : named).formatToParts(at);
    const day = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.find(p => p.type === "weekday")!.value) + 1;
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
