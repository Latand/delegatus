import { repairTelegramConnection } from "@/lib/telegram/launchReadiness";
import { TELEGRAM_CONNECTOR_TOKEN_ENV } from "@/lib/telegram/sessionStore";
import { telegramMcpUrl } from "@/lib/telegram/packaging";

export const TELEGRAM_GRANT_REVOKED_BEFORE_LAUNCH = "telegram MCP grant was revoked before launch";
export const TELEGRAM_SEAT_INACTIVE_BEFORE_LAUNCH = "telegram MCP orchestrator seat is no longer active";
/** The one line a relaunched agent reads when its run starts without the tool. */
export const TELEGRAM_UNAVAILABLE_THIS_RUN_NOTICE = "The Telegram tool is unavailable in this run because the operator's Telegram connection is off; it returns on the next start after Telegram is reconnected.";

/** The definition belongs to this launch; no account configuration is edited. */
export function operatorTelegramClaudeEntry() {
  return {
    type: "http" as const,
    url: telegramMcpUrl(),
    headers: { Authorization: `Bearer \${${TELEGRAM_CONNECTOR_TOKEN_ENV}}` },
  };
}

export function operatorTelegramCodexEntry() {
  return { url: telegramMcpUrl(), bearer_token_env_var: TELEGRAM_CONNECTOR_TOKEN_ENV };
}

export interface TelegramLaunchGrant {
  env: NodeJS.ProcessEnv;
  /** The servers this run materializes. The durable grant is never edited
      here, so a run that went without the tool gets it back on a later start. */
  mcpServers: string[] | undefined;
  /** A granted launch that goes on without the tool; the agent is told. */
  unavailable: boolean;
}

/**
 * Adds the local Telegram connector capability only to a host whose durable
 * MCP grant includes `telegram`. The value always comes from the owner-only
 * session store; caller-provided environment cannot forge or retain it.
 *
 * A revoked grant refuses the launch, and that is the only refusal here. The
 * grant is checked before anything is repaired and again after the repair,
 * because the repair waits and the grant can be withdrawn meanwhile.
 *
 * The connection itself never refuses a launch: the tool is optional and the
 * conversation has to start. A connection the health check can restore is
 * restored first and the host starts with the tool. Where Telegram is not set
 * up, or needs the operator, the host starts without the server and the agent
 * is told in one line.
 */
export async function resolveTelegramLaunchGrant(
  environment: NodeJS.ProcessEnv,
  mcpServers: readonly string[] | undefined,
  options: { validateGrant?: () => void } = {},
): Promise<TelegramLaunchGrant> {
  const env = { ...environment };
  delete env[TELEGRAM_CONNECTOR_TOKEN_ENV];
  const servers = mcpServers ? [...mcpServers] : undefined;
  if (!servers?.includes("telegram")) return { env, mcpServers: servers, unavailable: false };
  options.validateGrant?.();
  const state = await repairTelegramConnection();
  options.validateGrant?.();
  if (state.kind === "ready") {
    env[TELEGRAM_CONNECTOR_TOKEN_ENV] = state.token;
    return { env, mcpServers: servers, unavailable: false };
  }
  return { env, mcpServers: servers.filter((name) => name !== "telegram"), unavailable: true };
}
