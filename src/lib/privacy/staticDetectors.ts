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
  const separator = String.raw`[^\p{L}\p{N}\r\n]{0,8}`;
  const legacySeparator = String.raw`[^\p{L}\p{N}\r\n]{1,8}`;
  // The delimiter can also open a following formatted token; leave it available.
  const splitTokenPrefix = new RegExp(String.raw`(?<![\p{L}\p{N}_$])(_+)?(?:` + [
    `g${separator}i${separator}t${separator}h${separator}u${separator}b${separator}p${separator}a${separator}t`,
    `g${separator}h${separator}[pousr]`,
    `x${legacySeparator}o${legacySeparator}x${legacySeparator}[baprs]`,
    `s${legacySeparator}k`,
  ].join("|") + String.raw`)[^\p{L}\p{N}\r\n]{0,8}?(?=\\?[_-])`, "giu");
  const splitTokenBody = /^[^\p{L}\p{N}\r\n]*[a-z0-9](?:[^\p{L}\p{N}\r\n]*[a-z0-9])*/iu;
  let emphasisClosings: Map<number, number> | undefined;
  let lineStart = 0;
  for (const line of searchableText.split(/\n/)) {
    splitTokenPrefix.lastIndex = 0;
    for (let match = splitTokenPrefix.exec(line); match; match = splitTokenPrefix.exec(line)) {
      let bodyEnd = line.length;
      if (match[1]) {
        // Pair runs once across lines. Nested emphasis can consume an opening
        // run in parts; the first partial closure bounds the token's body.
        if (!emphasisClosings) {
          emphasisClosings = new Map<number, number>();
          const openings: { start: number; remaining: number; firstClosing?: number }[] = [];
          // Consume escape pairs before runs, so a literal underscore cannot
          // steal a closure. Paired backslashes leave the following run active.
          for (const marker of searchableText.matchAll(/\\[\s\S]|_+/g)) {
            if (marker[0][0] === "\\") continue;
            const end = marker.index + marker[0].length;
            const before = searchableText.slice(Math.max(0, marker.index - 2), marker.index);
            const after = searchableText.slice(end, end + 2);
            let remaining = marker[0].length;
            if (before && !/\s$/u.test(before) && !/^[\p{L}\p{N}_$]/u.test(after)) {
              while (remaining && openings.length) {
                const opening = openings[openings.length - 1];
                const consumed = Math.min(remaining, opening.remaining);
                opening.firstClosing ??= marker.index;
                opening.remaining -= consumed;
                remaining -= consumed;
                if (!opening.remaining) {
                  emphasisClosings.set(opening.start, opening.firstClosing);
                  openings.pop();
                }
              }
            }
            if (remaining && after && !/^\s/u.test(after) && !/[\p{L}\p{N}_$]$/u.test(before)) {
              openings.push({ start: end - remaining, remaining });
            }
          }
        }
        const closing = emphasisClosings.get(lineStart + match.index);
        if (closing === undefined) continue;
        // Formatting confined to prefix letters leaves the body outside it.
        if (closing > lineStart + splitTokenPrefix.lastIndex) {
          bodyEnd = Math.min(line.length, closing - lineStart);
        }
      }
      // A non-base62 letter or number ends the candidate body. GitHub bodies
      // need their full base62 length after compaction; longer formats also match.
      const body = splitTokenBody.exec(line.slice(splitTokenPrefix.lastIndex, bodyEnd));
      if (!body) continue;
      const compactTail = compactSensitiveText(match[0] + body[0]);
      if (/^(?:gh[pous][a-z0-9]{36,}|ghr[a-z0-9]{76,}|githubpat[a-z0-9]{81,}|(?:xox[baprs]|sk)[a-z0-9]{12,})$/i.test(compactTail)) {
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
