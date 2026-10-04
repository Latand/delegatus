import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { ESLint, type Linter } from "eslint";

export interface LintSite extends Linter.LintMessage { file: string }

/** React compiler diagnostics embed locations and source frames in message.
 * Keep the explanation and annotations, excluding moving source locations.
 */
export function diagnosticMessage(message: string): string {
  return message.split("\n")
    .filter(line => !/^.*:\d+:\d+$/.test(line) && !/^\s*>?\s*\d+\s*\|/.test(line))
    .map(line => line.replace(/^\s*\|\s*[\^~]+\s*/, ""))
    .join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function compareErrors(base: readonly LintSite[], head: readonly LintSite[]) {
  const key = (site: LintSite) => JSON.stringify([site.file, site.ruleId, diagnosticMessage(site.message)]);
  const remaining = new Map<string, number>();
  for (const site of base) if (site.severity === 2) remaining.set(key(site), (remaining.get(key(site)) ?? 0) + 1);
  const introduced: LintSite[] = [];
  for (const site of head) {
    if (site.severity !== 2) continue;
    const count = remaining.get(key(site)) ?? 0;
    if (count) remaining.set(key(site), count - 1);
    else introduced.push(site);
  }
  return { introduced, baseErrors: base.filter(site => site.severity === 2).length };
}

/** Only selected, surviving files are linted. Both versions use the installed
 * rules and the same original path/config; no checkout or source write occurs.
 * Tool/config crashes propagate instead of becoming baseline diagnostics.
 */
export async function lintChanges(root: string, base: string, selected: readonly string[]) {
  const files = [...new Set(selected.map(file => {
    const relative = path.relative(root, path.resolve(root, file));
    if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) throw new Error("lint path outside repository");
    return relative;
  }))].filter(file => existsSync(path.join(root, file)) && statSync(path.join(root, file)).isFile());
  if (!files.length) return compareErrors([], []);
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const baseFiles = new Set(git(["ls-tree", "-r", "--name-only", "-z", base, "--", ...files]).split("\0"));
  const eslint = new ESLint({ cwd: root, warnIgnored: false });
  const head = (await eslint.lintFiles(files.map(file => `./${file}`)))
    .flatMap(result => result.messages.map(message => ({ ...message, file: path.relative(root, result.filePath) })));
  const old: LintSite[] = [];
  for (const file of files) {
    if (!baseFiles.has(file)) continue;
    const contents = git(["show", `${base}:${file}`]);
    const results = await eslint.lintText(contents, { filePath: path.join(root, file), warnIgnored: false });
    for (const result of results) for (const message of result.messages) old.push({ ...message, file });
  }
  return compareErrors(old, head);
}

if (import.meta.main) {
  try {
    const [, , flag, base, ...files] = process.argv;
    if (flag !== "--base" || !base || !files.length) throw new Error("usage: eslint-changes.ts --base <merge-base> <files...>");
    const result = await lintChanges(process.cwd(), base, files);
    console.log(`${result.introduced.length} errors introduced by this change`);
    console.log(`${result.baseErrors} errors already on the base in the changed files (not blocking)`);
    for (const site of result.introduced) console.error(`${site.file}:${site.line}:${site.column} ${site.ruleId ?? "parse-error"}: ${diagnosticMessage(site.message)}`);
    if (result.introduced.length) process.exitCode = 1;
  } catch (error) {
    console.error(`eslint: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
