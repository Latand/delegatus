/* The publication gate's pattern detectors, as one pure function.
 *
 * `scripts/privacy-publication-gate.ts` runs them over every file a push
 * publishes; the issue reporter's scrubber (`src/lib/issueReports/scrub.ts`)
 * runs the same ones over a report before its preview. They live here because
 * the gate itself spawns git and reads its configuration while it loads, which
 * a server process must not do. This file imports nothing, so both callers
 * load it at no cost, and there is one set of patterns to keep right.
 *
 * The email detector stays in the gate: it reads Markdown structure, package
 * versions and reserved domains through the gate's own text views. */

export type StaticFindingClass =
  | "credential"
  | "home_path"
  | "private_network"
  | "resource_identifier"
  | "transcript_content";

export function compactSensitiveText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replaceAll(/[^\p{L}\p{N}]/gu, "");
}

const credentialInputPattern = new RegExp([
  String.raw`<in`,
  String.raw`put\b(?=[^>]*(?:type\s*=\s*["']?password|name\s*=\s*["']?(?:api[_-]?key|password|secret|token)))`,
  String.raw`(?=[^>]*value\s*=\s*(?:["'][^"']{4,}["']|[^\s"'=<>]{4,}))[^>]*>`,
].join(""), "i");

/** The classes found in text the caller already normalized (NFKC at least;
    the gate also decodes percent, entity and escape forms first). */
export function staticSensitiveClasses(
  searchableText: string,
  onMatch?: (kind: StaticFindingClass, start: number, end: number) => void,
): Set<StaticFindingClass> {
  const findings = new Set<StaticFindingClass>();
  const matched = (kind: StaticFindingClass, pattern: RegExp) => {
    const match = pattern.exec(searchableText);
    if (!match) return false;
    onMatch?.(kind, match.index, match.index + match[0].length);
    return true;
  };
  const unixHomePattern = /(?:^|[\s"'(=:/])\/(?:home|Users)\/([A-Za-z0-9._-]+)(?:\/|$)/gm;
  for (let match = unixHomePattern.exec(searchableText); match; match = unixHomePattern.exec(searchableText)) {
    if (match[1].toLowerCase() === "user") continue;
    onMatch?.("home_path", match.index, match.index + match[0].length);
    findings.add("home_path");
    break;
  }
  const windowsHomePattern = /(?:^|[\s"'(])[A-Za-z]:\\Users\\([A-Za-z0-9._-]+)(?:\\|$)/gim;
  for (let match = windowsHomePattern.exec(searchableText); match; match = windowsHomePattern.exec(searchableText)) {
    if (match[1].toLowerCase() === "user") continue;
    onMatch?.("home_path", match.index, match.index + match[0].length);
    findings.add("home_path");
    break;
  }
  const credentialAssignmentPattern = /(?:api[_-]?(?:key|token)|access[_-]?token|authorization|password|secret)\s*[:=]\s*(?:"[^"\r\n]{12,}"|'[^'\r\n]{12,}'|[^\s"'`]{12,})/i;
  if (matched("credential", credentialAssignmentPattern)) {
    findings.add("credential");
  }
  if (matched("credential", /\b(?:github_pat_|gh[pousr]_|sk-|xox[baprs]-)[A-Za-z0-9_-]{12,}\b/)) {
    findings.add("credential");
  }
  const separator = String.raw`[^a-z0-9\r\n]{1,8}`;
  const splitTokenPrefix = new RegExp([
    `g${separator}i${separator}t${separator}h${separator}u${separator}b${separator}p${separator}a${separator}t`,
    `g${separator}h${separator}[pousr]`,
    `x${separator}o${separator}x${separator}[baprs]`,
    `s${separator}k`,
  ].join("|") + String.raw`[^a-z0-9\r\n]{0,8}?[_-][^a-z0-9\r\n]*`, "gi");
  let lineStart = 0;
  for (const line of searchableText.split(/\n/)) {
    splitTokenPrefix.lastIndex = 0;
    for (let match = splitTokenPrefix.exec(line); match; match = splitTokenPrefix.exec(line)) {
      const compactTail = compactSensitiveText(line.slice(match.index));
      if (/^(?:githubpat|gh[pousr]|xox[baprs]|sk)[a-z0-9]{12,}/i.test(compactTail)) {
        onMatch?.("credential", lineStart + match.index, lineStart + line.length);
        findings.add("credential");
        break;
      }
    }
    if (findings.has("credential")) break;
    lineStart += line.length + 1;
  }
  if (matched("credential", /\bauthorization\s*[:=]\s*(?:basic|bearer)\s+[A-Za-z0-9._~+/=-]{8,}/i)) {
    findings.add("credential");
  }
  if (matched("credential", /https?:\/\/[^\s/@:]+:[^\s/@]+@/i)) {
    findings.add("credential");
  }
  if (matched("credential", credentialInputPattern)) {
    findings.add("credential");
  }
  if (matched("private_network", /\b(?:10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2})\b/)) {
    findings.add("private_network");
  }
  if (matched("resource_identifier", /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i)) {
    findings.add("resource_identifier");
  }
  if (matched("transcript_content", /(?:^|\n)\s*(?:assistant|prompt|transcript|user)\s*:\s*\S/im)) {
    findings.add("transcript_content");
  }
  return findings;
}
