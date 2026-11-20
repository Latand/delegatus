/** Formatting many timestamps on a board shares a formatter per locale, zone and option set. */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();
const FORMATTER_CAP = 64;

export function dateTimeFormatter(locale: string, tz: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${tz}|${JSON.stringify(options)}`;
  let found = FORMATTERS.get(key);
  if (!found) {
    if (FORMATTERS.size >= FORMATTER_CAP) FORMATTERS.clear();
    found = new Intl.DateTimeFormat(locale, { ...options, timeZone: tz });
    FORMATTERS.set(key, found);
  }
  return found;
}
