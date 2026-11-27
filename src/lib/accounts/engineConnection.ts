import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { listAntigravityAccounts } from "@/lib/accounts/antigravity";
import { listClaudeAccounts } from "@/lib/accounts/claude";
import { listCodexAccounts } from "@/lib/accounts/codex";
import { allowedAccountIdsForProject } from "@/lib/accounts/projectBindings";
import { resolveAntigravityBinary, resolveBinary, resolveCopilotBinary, resolveHostBinary } from "@/lib/agent/cli";
import { homeDirectory } from "@/lib/platformHome";

/**
 * Whether an engine can run a launch here (#1876, design §4.5): its command
 * resolves on this machine, at least one of its accounts holds credentials and,
 * for a project with an account binding (#1279), at least one such account is
 * inside the project's allowed set. A missing command outranks a present
 * credential: a signed-in engine whose CLI cannot start still starts and dies.
 *
 * `authPresent` proves a credential file, which can still be expired; that case
 * keeps the engine's own health pass. This removes the case a file check can
 * see: an engine with nobody signed in at all. A Claude credential store that
 * could not be read cannot prove absence, so it counts as present.
 */
export type EngineName = "claude" | "codex" | "antigravity";

export type ConnectionAccount = { id: string; authPresent: boolean; credentialState?: string };

export function engineConnectedFrom(accounts: readonly ConnectionAccount[], allowed: readonly string[] | null): boolean {
  return accounts.some((account) =>
    (account.authPresent || account.credentialState === "unknown")
    && (allowed === null || allowed.includes(account.id)));
}

/** Why an engine can or cannot run a launch; `connected` is the only one that can. */
export type EngineReadiness = "connected" | "signed-out" | "cli-missing";

function binaryForEngine(engine: EngineName): string {
  return engine === "antigravity" ? resolveAntigravityBinary() : resolveBinary(engine);
}

export function engineReadiness(engine: EngineName, project: string | null): EngineReadiness {
  if (!cliResolvable(binaryForEngine(engine))) return "cli-missing";
  return engineSignedIn(engine, project) ? "connected" : "signed-out";
}

function engineSignedIn(engine: EngineName, project: string | null): boolean {
  if (engine === "antigravity") {
    const accounts: ConnectionAccount[] = listAntigravityAccounts().map((account) => ({
      id: account.id,
      authPresent: account.auth !== "signed_out",
      credentialState: account.auth === "unknown" ? "unknown" : undefined,
    }));
    return engineConnectedFrom(accounts, null);
  }
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

const ENGINE_LABEL: Record<EngineName, string> = { claude: "Claude", codex: "Codex", antigravity: "Antigravity" };

/** The refusal's details, for an agent that relays the choice to its operator. */
export type EngineNotConnectedDetails = {
  stageId: string | null;
  role: string | null;
  engine: EngineName;
  reason: Exclude<EngineReadiness, "connected">;
  connect: "accounts";
  mapping: "agent-mapping";
};

type RefusalInput = { stageId?: string | null; role?: string | null; engine: EngineName; reason?: Exclude<EngineReadiness, "connected"> };

/** The one sentence every seam answers with (design §4.5). */
export function engineNotConnectedMessage(input: RefusalInput): string {
  const engine = ENGINE_LABEL[input.engine];
  const subject = input.stageId ? `Stage "${input.stageId}" runs on ${engine}` : `This launch runs on ${engine}`;
  const role = input.role ? `point the ${input.role} role at another engine (menu → Agent mapping), or ` : "";
  const target = input.stageId ? "stage" : "launch";
  if (input.reason === "cli-missing") {
    return `${subject}, and the ${input.engine} command was not found on this machine. Install it or start the Viewer from a shell where \`${input.engine}\` runs, or ${role}set engine and model on this ${target}.`;
  }
  return `${subject}, and no ${engine} account is signed in on this machine. Connect ${engine} (menu → Accounts), or ${role}set engine and model on this ${target}.`;
}

export function engineNotConnectedDetails(input: RefusalInput): EngineNotConnectedDetails {
  return { stageId: input.stageId ?? null, role: input.role ?? null, engine: input.engine, reason: input.reason ?? "signed-out", connect: "accounts", mapping: "agent-mapping" };
}

/* ── CLI presence ─────────────────────────────────────────────────────── */

/** The launch seams' synchronous reading of what `probeCli` answers: whether
    the binary `resolveBinary` names is an executable file, directly or on
    PATH. Windows resolves by extension and is left to the probe. */
export function cliResolvable(binary: string, envPath = process.env.PATH ?? ""): boolean {
  if (process.platform === "win32") return true;
  const executable = (candidate: string) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  };
  if (binary.includes("/")) return executable(binary);
  return envPath.split(path.delimiter).some((dir) => dir !== "" && executable(path.join(dir, binary)));
}

export type CliPresence = "found" | "missing";

/** Where a program's command was found and the version it names; either is null when the check could not say. */
export type CliInstall = { path: string | null; version: string | null };

/** The programs the Accounts step lists: the three engines and Copilot. */
export type CliProgram = EngineName | "copilot";

const CLI_PROBE_TIMEOUT_MS = 3_000;
const CLI_PROBE_TTL_MS = 60_000;
const cliCache = new Map<CliProgram, { at: number; value: Promise<CliInstall & { presence: CliPresence }> }>();

const VERSION = /\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?/;

/** The version a `--version` answer names: its first dotted triple, as "2.1.4 (Claude Code)" and "codex-cli 0.170.0" carry it. */
export function versionFromOutput(output: string): string | null {
  return VERSION.exec(output.slice(0, 4096))?.[0].slice(0, 40) ?? null;
}

/** Runs `<bin> --version` once, bounded at 3 s. Only a binary the OS cannot
    start counts as missing; a slow or failing one is installed. The version is
    read from a run that ended cleanly, so a crash report is never quoted as one. */
export function probeCliVersion(binary: string, timeoutMs = CLI_PROBE_TIMEOUT_MS): Promise<{ presence: CliPresence; version: string | null }> {
  return new Promise((resolve) => {
    try {
      execFile(binary, ["--version"], { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code === "ENOENT" || code === "EACCES") resolve({ presence: "missing", version: null });
        else resolve({ presence: "found", version: error ? null : versionFromOutput(String(stdout)) ?? versionFromOutput(String(stderr)) });
      });
    } catch {
      resolve({ presence: "missing", version: null });
    }
  });
}

/** Whether the command starts, from the same bounded run. */
export function probeCli(binary: string, timeoutMs = CLI_PROBE_TIMEOUT_MS): Promise<CliPresence> {
  return probeCliVersion(binary, timeoutMs).then((probe) => probe.presence);
}

/** A resolved command as a row names it: under the home it reads `~/…`, so the
    answer carries no user name. A bare name, found through PATH alone, names no place. */
export function cliDisplayPath(binary: string, home: string = homeDirectory()): string | null {
  if (!path.isAbsolute(binary)) return null;
  const inside = path.relative(home, binary);
  return inside && !inside.startsWith("..") && !path.isAbsolute(inside) ? `~${path.sep}${inside}` : binary;
}

const COMMAND: Record<CliProgram, string> = { claude: "claude", codex: "codex", antigravity: "agy", copilot: "copilot" };

function binaryForProgram(program: CliProgram): string {
  return program === "copilot" ? resolveCopilotBinary() : binaryForEngine(program);
}

/** In the container a command runs through a shim that exists only there, so
    the row names the place on the host when the mounted home shows one. */
function shownPath(program: CliProgram, binary: string): string | null {
  const shimmed = process.env.LLV_DOCKER_NSENTER_SHIMS === "1" && binary === `/usr/local/bin/${COMMAND[program]}`;
  return cliDisplayPath(shimmed ? resolveHostBinary(COMMAND[program]) : binary);
}

/** One check of a program's command: whether it starts, where it was found and
    its version, from a single `--version` run. Cached per program for a minute;
    `fresh` is the step's "Check again". */
export function cliReport(program: CliProgram, { fresh = false }: { fresh?: boolean } = {}): Promise<CliInstall & { presence: CliPresence }> {
  const cached = cliCache.get(program);
  if (!fresh && cached && Date.now() - cached.at < CLI_PROBE_TTL_MS) return cached.value;
  const binary = binaryForProgram(program);
  const value = probeCliVersion(binary).then(({ presence, version }) => ({ presence, version, path: presence === "found" ? shownPath(program, binary) : null }));
  cliCache.set(program, { at: Date.now(), value });
  return value;
}

/** Cached per engine for a minute; `fresh` is the step's "Check again". */
export function engineCliPresence(engine: EngineName, options: { fresh?: boolean } = {}): Promise<CliPresence> {
  return cliReport(engine, options).then((report) => report.presence);
}

export const CLI_PROGRAMS: readonly CliProgram[] = ["claude", "codex", "antigravity", "copilot"];

export type CliReports = Record<CliProgram, CliInstall & { presence: CliPresence }>;

/** One check of all four programs, each from its own cached `--version` run. */
export async function cliReports(options: { fresh?: boolean } = {}): Promise<CliReports> {
  const reports = await Promise.all(CLI_PROGRAMS.map((program) => cliReport(program, options)));
  return Object.fromEntries(CLI_PROGRAMS.map((program, index) => [program, reports[index]])) as CliReports;
}

/** What the guide's status popovers read of each program: where it was found and its version. */
export function cliInstalls(reports: CliReports): Record<CliProgram, CliInstall> {
  return Object.fromEntries(CLI_PROGRAMS.map((program) => [program, { path: reports[program].path, version: reports[program].version }])) as Record<CliProgram, CliInstall>;
}
