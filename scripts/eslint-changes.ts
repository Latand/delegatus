import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ESLint, type Linter } from "eslint";
import { installedFingerprint } from "./gate-cache";

export interface LintSite extends Linter.LintMessage { file: string }

/** React compiler diagnostics embed locations and source frames in message.
 * Keep the explanation and annotations, excluding moving source locations.
 * A frame's gutter is as wide as its largest line number, so the indent of an
 * elided span's `…` line moves at line 1000; annotations are compared trimmed.
 */
export function diagnosticMessage(message: string): string {
  return message.split("\n")
    .filter(line => !/^.*:\d+:\d+$/.test(line) && !/^\s*>?\s*\d+\s*\|/.test(line))
    .map(line => line.replace(/^\s*\|\s*[\^~]+\s*/, "").trim())
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
  // ESLint owns content/config invalidation; dependency inputs also select a
  // separate cache. Base text is always linted afresh with the same rules.
  const fingerprint = createHash("sha256").update(ESLint.version);
  let cacheable = true;
  try { fingerprint.update(installedFingerprint(root)); }
  catch { cacheable = false; }
  for (const file of ["eslint.config.mjs", "package.json", "bun.lock"]) {
    fingerprint.update(file).update(existsSync(path.join(root, file)) ? readFileSync(path.join(root, file)) : "missing");
  }
  const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
  const directory = path.join(common, "delegatus-gate", "eslint");
  const cacheLocation = path.join(directory, `${fingerprint.digest("hex")}.cache`);
  // Keep at most eight dependency/config generations. ESLint owns the single
  // current generation; a removed or corrupt entry simply lints again.
  try {
    if (cacheable) {
      mkdirSync(directory, { recursive: true });
      const generations = readdirSync(directory).filter(file => /^[a-f0-9]{64}\.cache$/.test(file))
        .map(file => ({ file: path.join(directory, file), stat: statSync(path.join(directory, file)) })).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
      let retained = 0;
      for (const generation of generations) {
        if (generation.stat.size > 4 * 1024 * 1024 || generation.file !== cacheLocation && retained++ >= 7) rmSync(generation.file, { force: true });
      }
    }
  } catch { cacheable = false; }
  const eslint = new ESLint({ cwd: root, warnIgnored: false, cache: cacheable, cacheStrategy: "content", cacheLocation });
  console.log(cacheable
    ? "eslint: native content cache enabled; unchanged content, configuration and dependency inputs reuse head diagnostics; base text stays fresh"
    : "eslint: native content cache unavailable; linting fresh");
  const selectedPaths = files.map(file => `./${file}`);
  let results: ESLint.LintResult[];
  try { results = await eslint.lintFiles(selectedPaths); }
  catch (error) {
    if (!cacheable || !["EACCES", "EROFS", "ENOSPC", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    console.log("eslint: native cache I/O failed; repeating head lint without the cache");
    results = await new ESLint({ cwd: root, warnIgnored: false }).lintFiles(selectedPaths);
  }
  const head = results
    .flatMap(result => result.messages.map(message => ({ ...message, file: path.relative(root, result.filePath) })));
  try { if (existsSync(cacheLocation) && statSync(cacheLocation).size > 4 * 1024 * 1024) rmSync(cacheLocation, { force: true }); }
  catch { /* Optional cache cleanup does not change the fresh lint verdict. */ }
  const redFiles = [...new Set(head.filter(site => site.severity === 2).map(site => site.file))];
  console.log(`eslint: base skipped for ${files.length - redFiles.length} file(s) without head errors`);
  if (!redFiles.length) return compareErrors([], head);
  const baseFiles = new Set(git(["ls-tree", "-r", "--name-only", "-z", base, "--", ...redFiles]).split("\0"));
  const old: LintSite[] = [];
  for (const file of redFiles) {
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
    console.log(`${result.baseErrors} errors already on the base in files with head errors (not blocking)`);
    for (const site of result.introduced) console.error(`${site.file}:${site.line}:${site.column} ${site.ruleId ?? "parse-error"}: ${diagnosticMessage(site.message)}`);
    if (result.introduced.length) process.exitCode = 1;
  } catch (error) {
    console.error(`eslint: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
