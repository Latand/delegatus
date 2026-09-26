import { startClaudeProviderRelay as startRelay } from "../../../bin/claude-provider-relay.mjs";

/** A private per-host relay keeps provider credentials out of Claude's process. */
export const startClaudeProviderRelay: (input: {
  baseUrl: string;
  token: string;
  headers: Record<string, string>;
  sessionId: string;
}) => Promise<{ baseUrl: string; alias: string; close(): void }> = startRelay;
