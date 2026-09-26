import { readTelegramConnection, readTelegramSession, TELEGRAM_CONNECTOR_TOKEN_ENV } from "@/lib/telegram/sessionStore";
import { telegramMcpUrl } from "@/lib/telegram/packaging";

export const TELEGRAM_LAUNCH_UNAVAILABLE = "telegram MCP connector is not connected at launch";

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

/**
 * Adds the local Telegram connector capability only to a host whose durable
 * MCP grant includes `telegram`. The value always comes from the owner-only
 * session store; caller-provided environment cannot forge or retain it.
 * A granted launch fails when the connector was disconnected after admission.
 */
export function withTelegramConnectorGrant(
  environment: NodeJS.ProcessEnv,
  mcpServers: readonly string[] | undefined,
): NodeJS.ProcessEnv {
  const bounded = { ...environment };
  delete bounded[TELEGRAM_CONNECTOR_TOKEN_ENV];
  if (!mcpServers?.includes("telegram")) return bounded;
  try {
    const connection = readTelegramConnection();
    const session = readTelegramSession();
    if (connection.status !== "connected" || !session || connection.credentialRef !== session.credentialRef
      || !session.connectorToken) throw new Error(TELEGRAM_LAUNCH_UNAVAILABLE);
    bounded[TELEGRAM_CONNECTOR_TOKEN_ENV] = session.connectorToken;
  } catch {
    throw new Error(TELEGRAM_LAUNCH_UNAVAILABLE);
  }
  return bounded;
}
