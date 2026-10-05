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
