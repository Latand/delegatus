/**
 * The last-write-wins clock of linked boards (docs/design/linked-installs.md
 * M.3): `<ms, 13 digits>.<counter, 3 digits>.<8 hex of installId>`, fixed width,
 * so string order is time order. A new stamp is always above the project's
 * watermark, whatever the wall clock did.
 */

export const STAMP_PATTERN = /^\d{13}\.\d{3}\.[0-9a-f]{8}$/;
export const isStamp = (value: unknown): value is string => typeof value === "string" && STAMP_PATTERN.test(value);
export const installPrefix = (installId: string) => installId.replace(/-/g, "").slice(0, 8);
export const stampMs = (stamp: string) => Number(stamp.slice(0, 13));

const format = (ms: number, counter: number, prefix: string) =>
  `${String(ms).padStart(13, "0")}.${String(counter).padStart(3, "0")}.${prefix}`;

/** The next stamp above `watermark` (a stamp or null). The counter rolls into
    `ms` past 999, so every stamp keeps the declared width. */
export function nextStamp(watermark: string | null, now: number, prefix: string): string {
  const wall = Math.max(0, Math.min(Math.floor(now), 9_999_999_999_999));
  if (!watermark) return format(wall, 0, prefix);
  const markMs = stampMs(watermark);
  const markCounter = Number(watermark.slice(14, 17));
  if (wall > markMs) return format(wall, 0, prefix);
  return markCounter < 999 ? format(markMs, markCounter + 1, prefix) : format(markMs + 1, 0, prefix);
}

/** A stamp for a row that was never stamped: its `updatedAt`, counter 0, this
    install. Deterministic, so the same row always reads the same stamp. */
export function derivedStamp(updatedAt: string, prefix: string): string {
  const ms = Date.parse(updatedAt);
  return format(Number.isFinite(ms) && ms > 0 ? Math.min(ms, 9_999_999_999_999) : 0, 0, prefix);
}

export const maxStamp = (left: string | null, right: string | null): string | null =>
  !left ? right : !right ? left : left > right ? left : right;
