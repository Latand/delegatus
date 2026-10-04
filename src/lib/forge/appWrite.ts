import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { agentForgeDir } from "@/lib/git/agentForgeCredentials";

import { refusalMessage } from "../../../bin/forge-app-token.mjs";

const execFileAsync = promisify(execFile);

/** A token is asked for again this long before GitHub would stop taking it. */
export const FORGE_APP_TOKEN_MARGIN_MS = 5 * 60_000;
const MINT_TIMEOUT_MS = 60_000;

export interface ForgeAppToken {
  token: string;
  /** ISO time GitHub stops accepting the token, when it said. */
  expiresAt: string | null;
}

/** A forge write as the Delegatus GitHub App: `gh` arguments and the one
    repository the token is minted for. */
export interface ForgeAppWriter {
  (args: string[], repository: string): Promise<string>;
}

/** The write did not happen and no other credential was tried. */
export class ForgeAppWriteRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForgeAppWriteRefused";
  }
}

/**
 * Installation tokens for the engine's own writes, one per repository, held in
 * memory only and replaced before they expire. A token GitHub gave no expiry
 * for is used once.
 */
export class ForgeAppTokenSource {
  private readonly held = new Map<string, ForgeAppToken>();

  constructor(
    private readonly mint: (repository: string) => Promise<ForgeAppToken>,
    private readonly now: () => number = Date.now,
  ) {}

  async token(repository: string): Promise<string> {
    const key = repository.toLowerCase();
    const held = this.held.get(key);
    if (held?.expiresAt && Date.parse(held.expiresAt) - this.now() > FORGE_APP_TOKEN_MARGIN_MS) return held.token;
    this.held.delete(key);
    const issued = await this.mint(repository);
    if (!issued.token) throw new ForgeAppWriteRefused(refusalMessage(repository, "GitHub issued no installation token"));
    if (issued.expiresAt) this.held.set(key, issued);
    return issued.token;
  }

  /** After GitHub refused a token: the next write mints again. */
  forget(repository: string): void {
    this.held.delete(repository.toLowerCase());
  }
}

/** The helper's refusal, as it wrote it; never its stdout, which is the token. */
function refusalFrom(error: unknown, repository: string): ForgeAppWriteRefused {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  const line = typeof stderr === "string" ? stderr.split("\n").map((part) => part.trim()).find((part) => part.startsWith("Delegatus")) : undefined;
  return new ForgeAppWriteRefused(line ?? refusalMessage(repository, "the GitHub App credential helper could not be run"));
}

/**
 * Mints through the helper as a child process, the same file an agent's `gh`
 * shim starts. In a container `bun` enters the host namespace, which is where
 * the credential store lives; the copy under the launching home is the path
 * both sides can read.
 */
export async function mintForgeAppToken(repository: string, source: NodeJS.ProcessEnv = process.env): Promise<ForgeAppToken> {
  let stdout: string;
  try {
    const helper = path.join(agentForgeDir(source), "forge-app-token.mjs");
    ({ stdout } = await execFileAsync("bun", [helper, "token", "--repository", repository, "--json"], { timeout: MINT_TIMEOUT_MS, maxBuffer: 64 * 1024, env: source }));
  } catch (error) {
    throw refusalFrom(error, repository);
  }
  try {
    const issued = JSON.parse(stdout) as { token?: unknown; expiresAt?: unknown };
    if (typeof issued.token === "string" && issued.token) {
      return { token: issued.token, expiresAt: typeof issued.expiresAt === "string" ? issued.expiresAt : null };
    }
  } catch { /* refused below */ }
  throw new ForgeAppWriteRefused(refusalMessage(repository, "the GitHub App credential helper returned no token"));
}

export interface ForgeAppWriterOptions {
  tokens?: ForgeAppTokenSource;
  /** Runs `gh` with the environment given. Tests observe that environment. */
  exec?: (args: string[], env: NodeJS.ProcessEnv) => Promise<string>;
  source?: NodeJS.ProcessEnv;
}

/**
 * The engine's one seam for a GitHub write. `gh` is started only once a token
 * is in hand, with that token as its whole identity: every inherited token
 * variable is dropped and its configuration directory holds no account, so a
 * refused or expired App token ends in GitHub's refusal and never in the
 * credentials of whoever started the Viewer.
 */
export function forgeAppWriter(cwd: string, timeoutMs: number, options: ForgeAppWriterOptions = {}): ForgeAppWriter {
  const source = options.source ?? process.env;
  const tokens = options.tokens ?? new ForgeAppTokenSource((repository) => mintForgeAppToken(repository, source));
  const exec = options.exec ?? (async (args, env) => {
    const { stdout } = await execFileAsync("gh", args, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env });
    return stdout;
  });
  return async (args, repository) => {
    const token = await tokens.token(repository);
    const env: NodeJS.ProcessEnv = { ...source, GH_TOKEN: token, GH_PROMPT_DISABLED: "1", GH_CONFIG_DIR: path.join(agentForgeDir(source), "gh-config") };
    for (const name of ["GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) delete env[name];
    try {
      return await exec(args, env);
    } catch (error) {
      if (/HTTP 401|Bad credentials/i.test(`${(error as { stderr?: unknown })?.stderr ?? ""}`)) tokens.forget(repository);
      throw error;
    }
  };
}
