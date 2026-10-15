/** Telegram errors may echo credentials or destination identities. Scrub
 * before bounding so a cut cannot leave a partial secret in a stored reason. */
const EMAIL = new RegExp([String.raw`[\w.+-]+`, String.raw`[\w-]+(?:\.[\w-]+)+`].join("@"), "g");

export function scrubTelegramDiagnostic(value: string): string {
  const safe = value
    .replace(/\b\d{5,20}:[A-Za-z0-9_-]{30,64}\b/g, "[token]")
    .replace(/(?:https?:\/\/|tg:\/\/)\S+/gi, "[url]")
    .replace(EMAIL, "[email]")
    .replace(/@[A-Za-z0-9_]+/g, "[handle]")
    .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, "[id]")
    .replace(/((?:chat|user|bot|message|topic)(?:[_ ]ids?)?\s*[:=]\s*)-?\d+/gi, "$1[id]")
    .replace(/-?\b\d{5,}\b/g, "[id]")
    .replace(/\s+/g, " ").trim();
  return safe.length > 300 ? `${safe.slice(0, 299)}…` : safe;
}
