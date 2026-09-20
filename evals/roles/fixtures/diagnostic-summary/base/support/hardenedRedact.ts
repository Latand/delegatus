import { redactSecrets } from "./redactSecrets";
const TOKEN_FAMILY_PATTERN = new RegExp(String.raw`\b(?:` + [
  String.raw`sk-[A-Za-z0-9_-]{12,}`,
  String.raw`sk-ant-[A-Za-z0-9_-]{12,}`,
  String.raw`gh[pousr]_[A-Za-z0-9_]{20,}`,
  String.raw`github_pat_[A-Za-z0-9_]{20,}`,
  String.raw`npm_[A-Za-z0-9]{20,}`,
  String.raw`xox[baprs]-[A-Za-z0-9-]{10,}`,
  String.raw`AKIA[0-9A-Z]{16}`,
  String.raw`ASIA[0-9A-Z]{16}`,
  String.raw`AIza[0-9A-Za-z_-]{35}`,
].join("|") + String.raw`)\b`, "g");

export function hardenedRedact(text: string): string {
  return redactSecrets(text)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted]")
    .replace(/(^|\n)(\s*(?:proxy-)?authorization\s*:\s*)[^\r\n]*/gi, "$1$2[redacted]")
    .replace(/(^|\n)(\s*(?:set-)?cookie\s*:\s*)[^\r\n]*/gi, "$1$2[redacted]")
    .replace(TOKEN_FAMILY_PATTERN, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted]")
    .replace(/(?<=Bearer\s)[A-Za-z0-9._-]{12,}/gi, "[redacted]");
}
