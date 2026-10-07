import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { ForgeAppTokenSource, forgeAppWriter, forgeWriter, mintForgeAppToken, type ForgeAppWriter } from "@/lib/forge/appWrite";
import { githubRepositoryOfRemote } from "@/lib/forge/workLinks";

const execFileAsync = promisify(execFile);
const PUBLISH_TIMEOUT_MS = 60_000;

/** Files one issue and answers its URL. */
export interface IssueReportPublisher {
  (report: { title: string; body: string }, repository: string): Promise<string>;
}

/** The address of an issue that already carries this exact title and body, or
    null when none was found. Not finding one proves nothing. */
export interface IssueReportFinder {
  (report: { title: string; body: string }, repository: string): Promise<string | null>;
}

/** `owner/name` of the repository Delegatus itself is developed in, from the
    remote its own manifest names. Null when that is no GitHub repository. */
export function delegatusIssueRepository(manifestRemote: string, configured = process.env.LLV_VIEWER_CANONICAL_REMOTE): string | null {
  return githubRepositoryOfRemote(configured?.trim() || manifestRemote.trim());
}

/**
 * Files the approved report through the engine's one seam for a GitHub write
 * (#2485). Where this installation declared the repository as an App
 * repository, the issue goes out as the Delegatus GitHub App, on a token asked
 * for `issues: write` alone, and a missing, suspended or ungranted credential
 * refuses the write: nothing falls back to a person. Any other repository gets
 * the same `gh issue create` a person would type.
 */
export function issueReportPublisher(options: { writer?: ForgeAppWriter; source?: NodeJS.ProcessEnv } = {}): IssueReportPublisher {
  const source = options.source ?? process.env;
  const cwd = process.cwd();
  const writer = options.writer ?? forgeWriter(
    async (args) => (await execFileAsync("gh", args, { cwd, timeout: PUBLISH_TIMEOUT_MS, maxBuffer: 1024 * 1024, env: { ...source, GH_PROMPT_DISABLED: "1" } })).stdout,
    forgeAppWriter(cwd, PUBLISH_TIMEOUT_MS, { source, tokens: new ForgeAppTokenSource((repository) => mintForgeAppToken(repository, source, "issues")) }),
  );
  return async (report, repository) => {
    const stdout = await writer(["issue", "create", "--repo", repository, "--title", report.title, "--body", report.body], repository);
    const url = stdout.split(/\s+/).find((part) => /^https:\/\/\S+\/issues\/\d+$/.test(part));
    if (!url) throw new Error("the forge accepted the command and answered no issue URL");
    return url;
  };
}

const sameText = (left: string, right: string) => left.replace(/\r\n/g, "\n").trim() === right.replace(/\r\n/g, "\n").trim();

/**
 * Looks for the issue a publication may have filed before its answer was
 * lost. A read, so it runs as the plain `gh` of this process. An issue counts
 * only when its title and its body are the report's: a similar one is another
 * report.
 */
export function issueReportFinder(options: { run?: (args: string[]) => Promise<string>; source?: NodeJS.ProcessEnv } = {}): IssueReportFinder {
  const source = options.source ?? process.env;
  const cwd = process.cwd();
  const run = options.run ?? (async (args: string[]) =>
    (await execFileAsync("gh", args, { cwd, timeout: PUBLISH_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env: { ...source, GH_PROMPT_DISABLED: "1" } })).stdout);
  return async (report, repository) => {
    const stdout = await run([
      "issue", "list", "--repo", repository, "--state", "all", "--limit", "30",
      "--search", `"${report.title.replace(/"/g, " ")}" in:title`, "--json", "url,title,body",
    ]);
    const rows = JSON.parse(stdout) as unknown;
    if (!Array.isArray(rows)) return null;
    for (const row of rows as { url?: unknown; title?: unknown; body?: unknown }[]) {
      if (typeof row.url === "string" && typeof row.title === "string" && typeof row.body === "string"
        && sameText(row.title, report.title) && sameText(row.body, report.body)) return row.url;
    }
    return null;
  };
}
