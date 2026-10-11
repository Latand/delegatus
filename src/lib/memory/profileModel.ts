import { accountManager } from "@/lib/accounts/manager";
import type { AccountManager } from "@/lib/accounts/contracts";
import { readClaudeCredentials } from "@/lib/accounts/claudeCredentials";
import { MemoryProfileError, OVERALL_SCOPE, profilePrompt, profileSchema, type ProfileInput } from "./profile";
import type { Locale } from "@/lib/i18n/core";

// The approved model is pinned; catalogue absence must never select an older model.
export const MEMORY_PROFILE_MODEL = "claude-haiku-5-5";
export type ProfileCaller = (input: ProfileInput, locale: Locale) => Promise<unknown>;
export type ProfileFetch = (url: string, init: RequestInit) => Promise<Response>;

/** One Messages request, no tools or agent session. Secrets never leave this closure. */
export function directProfileCaller(oauthToken: string, model: string, request: ProfileFetch = fetch): ProfileCaller {
  return async (input, locale) => {
    let response: Response;
    try {
      response = await request("https://api.anthropic.com/v1/messages", {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: { authorization: `Bearer ${oauthToken}`, "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20", "content-type": "application/json" },
        body: JSON.stringify({ model,
          // Haiku 5.5 counts thinking against this ceiling; prose stays bounded by validation.
          max_tokens: model === MEMORY_PROFILE_MODEL ? (input.scope === OVERALL_SCOPE ? 4096 : 2048) : 650,
          // Subscription model admission requires this client identity, even without tools.
          system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }],
          messages: [{ role: "user", content: profilePrompt(input, locale) }],
          output_config: { ...(model === "claude-haiku-5-5" ? { effort: "low" } : {}), format: { type: "json_schema", schema: profileSchema(input.scope === OVERALL_SCOPE) } },
        }),
      });
    } catch (error) {
      throw new MemoryProfileError(error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name) ? "timeout" : "failed");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new MemoryProfileError([401, 403, 429].includes(response.status) ? "account" : "failed");
    }
    try {
      const body = await response.json() as { stop_reason?: string; content?: { type: string; text?: string }[] };
      if (body.stop_reason !== "end_turn" || !Array.isArray(body.content) || body.content.some(part => !["text", "thinking", "redacted_thinking"].includes(part.type))) throw new MemoryProfileError("invalid");
      return JSON.parse(body.content.filter(part => part.type === "text").map(part => part.text ?? "").join(""));
    } catch { throw new MemoryProfileError("invalid"); }
  };
}

type AccountPorts = { manager: Pick<AccountManager, "resolveHeadlessSpawn">; credentials: typeof readClaudeCredentials; model: string };
export async function prepareProfileCaller(project: string, ports: AccountPorts = { manager: accountManager, credentials: readClaudeCredentials, model: MEMORY_PROFILE_MODEL }): Promise<ProfileCaller> {
  const unavailable: string[] = [];
  while (true) {
    const selected = ports.manager.resolveHeadlessSpawn("claude", null, [], project, ports.model, unavailable);
    if (selected.kind !== "available" || unavailable.includes(selected.account.accountId)) throw new MemoryProfileError("account");
    if (!selected.account.claudeProvider) {
      const credentials = ports.credentials(selected.account.home);
      const oauth = credentials.state === "present" ? credentials.document.claudeAiOauth : null;
      if (typeof oauth?.accessToken === "string" && oauth.accessToken && typeof oauth.expiresAt === "number" && oauth.expiresAt > Date.now()) return directProfileCaller(oauth.accessToken, ports.model);
    }
    unavailable.push(selected.account.accountId);
  }
}
