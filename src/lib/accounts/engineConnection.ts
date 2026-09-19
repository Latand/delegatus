import { execFile } from "node:child_process";

import { listClaudeAccounts } from "@/lib/accounts/claude";
import { listCodexAccounts } from "@/lib/accounts/codex";
import { allowedAccountIdsForProject } from "@/lib/accounts/projectBindings";
import { resolveBinary } from "@/lib/agent/cli";

/**
 * Whether an engine can run a launch here (#1876, design §4.5): at least one of
 * its accounts holds credentials and, for a project with an account binding
 * (#1279), at least one such account is inside the project's allowed set.
 *
 * `authPresent` proves a credential file, which can still be expired; that case
 * keeps the engine's own health pass. This removes the case a file check can
 * see: an engine with nobody signed in at all. A Claude credential store that
 * could not be read cannot prove absence, so it counts as present.
 */
export type EngineName = "claude" | "codex";

export type ConnectionAccount = { id: string; authPresent: boolean; credentialState?: string };

export function engineConnectedFrom(accounts: readonly ConnectionAccount[], allowed: readonly string[] | null): boolean {
  return accounts.some((account) =>
    (account.authPresent || account.credentialState === "unknown")
    && (allowed === null || allowed.includes(account.id)));
}

export function engineConnection(engine: EngineName, project: string | null): boolean {
  const accounts: ConnectionAccount[] = engine === "claude" ? listClaudeAccounts() : listCodexAccounts();
  let allowed: string[] | null = null;
  try {
    allowed = allowedAccountIdsForProject(project, engine);
  } catch {
    /* An unreadable binding record is refused by the account seam itself, with
       its own wording; this check only answers "is anybody signed in". */
    allowed = null;
  }
  return engineConnectedFrom(accounts, allowed);
}

export const ENGINE_NOT_CONNECTED = "ENGINE_NOT_CONNECTED";

const ENGINE_LABEL: Record<EngineName, string> = { claude: "Claude", codex: "Codex" };

/** The refusal's details, for an agent that relays the choice to its operator. */
export type EngineNotConnectedDetails = {
  stageId: string | null;
  role: string | null;
  engine: EngineName;
  connect: "accounts";
  mapping: "agent-mapping";
};

/** The one sentence every seam answers with (design §4.5). */
export function engineNotConnectedMessage(input: { stageId?: string | null; role?: string | null; engine: EngineName }): string {
  const engine = ENGINE_LABEL[input.engine];
  const subject = input.stageId ? `Stage "${input.stageId}" runs on ${engine}` : `This launch runs on ${engine}`;
  const role = input.role ? `point the ${input.role} role at another engine (menu → Agent mapping), or ` : "";
  return `${subject}, and no ${engine} account is signed in on this machine. Connect ${engine} (menu → Accounts), or ${role}set engine and model on this ${input.stageId ? "stage" : "launch"}.`;
}

export function engineNotConnectedDetails(input: { stageId?: string | null; role?: string | null; engine: EngineName }): EngineNotConnectedDetails {
  return { stageId: input.stageId ?? null, role: input.role ?? null, engine: input.engine, connect: "accounts", mapping: "agent-mapping" };
}

/* ── CLI presence ─────────────────────────────────────────────────────── */

export type CliPresence = "found" | "missing";

const CLI_PROBE_TIMEOUT_MS = 3_000;
const CLI_PROBE_TTL_MS = 60_000;
const cliCache = new Map<EngineName, { at: number; value: Promise<CliPresence> }>();

/** Runs `<bin> --version` once, bounded at 3 s. Only a binary the OS cannot
    start counts as missing; a slow or failing one is installed. */
export function probeCli(binary: string, timeoutMs = CLI_PROBE_TIMEOUT_MS): Promise<CliPresence> {
  return new Promise((resolve) => {
    try {
      execFile(binary, ["--version"], { timeout: timeoutMs, windowsHide: true }, (error) => {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        resolve(code === "ENOENT" || code === "EACCES" ? "missing" : "found");
      });
    } catch {
      resolve("missing");
    }
  });
}

/** Cached per engine for a minute; `fresh` is the step's "Check again". */
export function engineCliPresence(engine: EngineName, { fresh = false }: { fresh?: boolean } = {}): Promise<CliPresence> {
  const cached = cliCache.get(engine);
  if (!fresh && cached && Date.now() - cached.at < CLI_PROBE_TTL_MS) return cached.value;
  const value = probeCli(resolveBinary(engine));
  cliCache.set(engine, { at: Date.now(), value });
  return value;
}
