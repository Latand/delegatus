import { statePath } from "@/lib/configDir";
import { githubReadDiagnostic } from "@/lib/forge/githubReadFailure";
import { runGithubCliRead } from "@/lib/forge/githubCli";
import { cachedJsonFile } from "@/lib/state/cachedJsonFile";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { withFileTransactionAttempt } from "@/lib/state/fileTransaction";
import { guardedContext, stateOwner } from "@/lib/stateOwnership";

const HOST = "github.com";
const NOREPLY_HOST = "users.noreply." + HOST;
const REFRESH_MS = 24 * 60 * 60 * 1_000;
const RETRY_MS = 60_000;
const LOGIN = /^[a-z0-9][a-z0-9-]{0,38}$/i;

export const COMMIT_ACCOUNT_REFUSAL = "GitHub commit identity is unavailable. Sign in with gh auth login --hostname github.com and retry.";

interface Account {
  schemaVersion: 1;
  host: typeof HOST;
  id: number;
  login: string;
  resolvedAt: number;
  checkedAt: number;
}

function accountFields(value: unknown): { id: number; login: string } | null {
  if (value === null || typeof value !== "object") return null;
  const { id, login } = value as Partial<Account>;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0 || typeof login !== "string" || !LOGIN.test(login)) return null;
  return { id, login };
}

function decodeAccount(raw: string | null): Account | null {
  try {
    const record = JSON.parse(raw ?? "null") as Partial<Account> | null;
    const account = accountFields(record);
    if (!account || record?.schemaVersion !== 1 || record.host !== HOST
      || typeof record.resolvedAt !== "number" || !Number.isSafeInteger(record.resolvedAt) || record.resolvedAt < 0
      || typeof record.checkedAt !== "number" || !Number.isSafeInteger(record.checkedAt) || record.checkedAt < record.resolvedAt) return null;
    return { schemaVersion: 1, host: HOST, ...account, resolvedAt: record.resolvedAt, checkedAt: record.checkedAt };
  } catch { return null; }
}

const cache = cachedJsonFile(decodeAccount, "git/forgeCommitAccount");
const accountFile = () => statePath("forge-commit-account.json");
let pending: { file: string; result: Promise<Account | null> } | null = null;
let retry: { file: string; after: number } | null = null;

export function ownerNoreplyAddress(account: Pick<Account, "login" | "id">): string {
  return `${account.id}+${account.login}@${NOREPLY_HOST}`;
}

export function isOwnerNoreplyAddress(email: string): boolean {
  const [local, host, extra] = email.split("@");
  const [id, login, suffix] = local.split("+");
  return extra === undefined && suffix === undefined && host === NOREPLY_HOST
    && /^[1-9][0-9]*$/.test(id) && accountFields({ id: Number(id), login }) !== null;
}

async function refresh(file: string, held: Account | null, checkedAt: number,
  run: typeof runGithubCliRead, now: () => number): Promise<Account | null> {
  const env: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_DEBUG: undefined } satisfies NodeJS.ProcessEnv;
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) delete env[key];
  try {
    const body = JSON.parse(await run(["api", "user", "--hostname", HOST, "--jq", "{id,login,type}"],
      { timeout: 5_000, env, maxBuffer: 4096 }));
    const answer = body?.type === "User" && accountFields(body);
    if (!answer) throw new SyntaxError("Invalid GitHub user response");
    return withFileTransactionAttempt(file, "GitHub commit account cache is busy", () => {
      const previous = cache.read(file);
      // Another state owner can finish a later request while this one waits for gh.
      if (previous && previous.checkedAt > checkedAt && previous.checkedAt !== held?.checkedAt) return previous;
      const resolvedAt = previous?.id === answer.id && previous.login === answer.login
        ? Math.min(previous.resolvedAt, checkedAt) : checkedAt;
      const record: Account = { schemaVersion: 1, host: HOST, ...answer, resolvedAt, checkedAt };
      writeJsonDurably(file, record);
      return record;
    });
  } catch (error) {
    retry = { file, after: now() + RETRY_MS };
    const diagnostic = githubReadDiagnostic(error);
    console.warn(`[git commit account] GitHub account refresh failed (${diagnostic.cause})`);
    return cache.read(file);
  }
}

/** First use waits for one bounded lookup. A persisted answer is available
 * immediately while the owner refreshes it in the background. */
export async function resolveForgeCommitAccount({
  run = runGithubCliRead, now = Date.now,
}: { run?: typeof runGithubCliRead; now?: () => number } = {}): Promise<Account | null> {
  const file = accountFile();
  const account = cache.read(file);
  const owner = stateOwner();
  // An injected runner lets tests exercise the resolver without using gh.
  if (!owner || owner === "deploy-adapter" || (guardedContext() && run === runGithubCliRead)) return account;
  const time = now();
  if (account && time >= account.checkedAt && time - account.checkedAt < REFRESH_MS) return account;
  if (retry?.file === file && time < retry.after) return account;
  if (pending && pending.file !== file) return account;
  if (!pending) {
    const result = refresh(file, account, time, run, now).finally(() => { pending = null; });
    pending = { file, result };
  }
  return account ?? pending.result;
}

export type CommitAccountStatus = { state: "resolved"; login: string } | { state: "unresolved"; reason: string };

export function forgeCommitAccountStatus(): CommitAccountStatus {
  const account = cache.read(accountFile());
  return account ? { state: "resolved", login: account.login } : { state: "unresolved", reason: COMMIT_ACCOUNT_REFUSAL };
}
