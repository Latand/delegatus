import fs from "node:fs";
import path from "node:path";

import { DEFAULT_WORKDAYS, METHOD_DEFAULTS, validTimeZone } from "./method";

/*
 * `activity/settings.json`: `{ v: 1, tz, billable: [project keys], workdays: [0-6] }`.
 * The zone decides days and clock hours (Europe/Kyiv unless set); billable
 * tags choose which projects the billable figure counts, while the dashboard
 * itself shows every project; workdays are the days a zero is checked for a
 * probable missing source. A missing or unreadable file is the defaults.
 */

export interface ActivitySettings {
  tz: string;
  billable: string[];
  workdays: number[];
}

export function readActivitySettings(dir: string): ActivitySettings {
  const defaults: ActivitySettings = { tz: METHOD_DEFAULTS.tz, billable: [], workdays: [...DEFAULT_WORKDAYS] };
  let parsed: { v?: unknown; tz?: unknown; billable?: unknown; workdays?: unknown };
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
  } catch {
    return defaults;
  }
  if (!parsed || typeof parsed !== "object" || parsed.v !== 1) return defaults;
  const billable = Array.isArray(parsed.billable)
    ? [...new Set(parsed.billable.filter((project): project is string => typeof project === "string" && project.trim().length > 0))]
    : [];
  const workdays = Array.isArray(parsed.workdays)
    ? [...new Set(parsed.workdays.filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6))].sort()
    : defaults.workdays;
  return { tz: validTimeZone(parsed.tz) ?? defaults.tz, billable, workdays };
}
