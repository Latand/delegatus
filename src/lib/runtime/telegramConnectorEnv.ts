import { readTelegramConnection, readTelegramSession, TELEGRAM_CONNECTOR_TOKEN_ENV } from "@/lib/telegram/sessionStore";
import { telegramMcpUrl } from "@/lib/telegram/packaging";

/** Refuses a new launch that asked for the tool; operator-facing, so plain. */
export const TELEGRAM_LAUNCH_UNAVAILABLE = "Telegram is not connected, so an agent that needs the Telegram tool cannot start. Reconnect Telegram, or start the agent without it.";
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
  /** A granted relaunch that goes on without the tool; the agent is told. */
  unavailable: boolean;
}

function connectedTelegramToken(): string | null {
  try {
    const connection = readTelegramConnection();
    const session = readTelegramSession();
    if (connection.status !== "connected" || !session || connection.credentialRef !== session.credentialRef) return null;
    return session.connectorToken || null;
  } catch {
    return null;
  }
}

/**
 * Adds the local Telegram connector capability only to a host whose durable
 * MCP grant includes `telegram`. The value always comes from the owner-only
 * session store; caller-provided environment cannot forge or retain it.
 *
 * A revoked grant refuses every launch. A disconnected connector refuses a new
 * launch that asked for the tool, and only that: a relaunch of a conversation
 * that already holds the grant starts without the server, because the tool is
 * optional and the conversation has to stay reachable.
 */
export function resolveTelegramLaunchGrant(
  environment: NodeJS.ProcessEnv,
  mcpServers: readonly string[] | undefined,
  options: { validateGrant?: () => void; relaunch?: boolean } = {},
): TelegramLaunchGrant {
  const env = { ...environment };
  delete env[TELEGRAM_CONNECTOR_TOKEN_ENV];
  const servers = mcpServers ? [...mcpServers] : undefined;
  if (!servers?.includes("telegram")) return { env, mcpServers: servers, unavailable: false };
  options.validateGrant?.();
  const token = connectedTelegramToken();
  if (token) {
    env[TELEGRAM_CONNECTOR_TOKEN_ENV] = token;
    return { env, mcpServers: servers, unavailable: false };
  }
  if (!options.relaunch) throw new Error(TELEGRAM_LAUNCH_UNAVAILABLE);
  return { env, mcpServers: servers.filter((name) => name !== "telegram"), unavailable: true };
}
